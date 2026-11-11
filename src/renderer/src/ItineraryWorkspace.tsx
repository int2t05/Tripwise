/** 管理已确认行程的时间线、地图联动、版本浏览和本地编辑草稿。 */
import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowUp, Lock, Map as MapIcon, MapPin, PencilLine, Plus, Route, Trash2, Undo2, Unlock } from 'lucide-react'
import type { ItineraryDay, ItineraryOption, ItineraryRevision, ItineraryScheduleBlock, ItineraryScheduleBlockKind, ItineraryStop, RouteEstimateResponse, RouteMode, SourceRecord, TransitEstimate, Trip, TripBrief } from '@shared/types'
import { orderItineraryDaySchedule, routePlanningBufferMinutes } from '@shared/itinerary-schedule'
import { compareItineraries } from '@shared/itinerary-revisions'
import { previousItineraryRevision } from '@shared/itinerary-revisions'
import { restoreItineraryChanges } from '@shared/itinerary-restoration'
import { MAX_ITINERARY_STOPS_PER_DAY } from '@shared/itinerary-limits'
import { recordItineraryDraftUndo, undoItineraryDraft, type ItineraryDraftUndoEntry } from './itinerary-draft-undo'
import { ItineraryHistoryRestorer } from './ItineraryHistoryRestorer'
import { EmptyWorkspace } from './components/EmptyWorkspace'
import { ItineraryMap } from './ItineraryMap'
import { MarkdownContent } from './MarkdownContent'
import { RevisionTextComparison } from './RevisionTextComparison'
import { ItineraryBudgetEstimateCard, ItineraryEvidenceLinks, ItineraryTransportCostSummary, LodgingCommuteTimelineCard, PlanChangePreview, ScheduleBlockTimelineCard, ScheduleFeasibility } from './ItineraryPlans'
import { formatTime } from './ui-format'

/** 用同一份确认版本展示行程，并提供历史版本恢复。 */
export function ItineraryView({ trip, activeRevision, saving, placesEnabled, routesEnabled, amapKeySaved, amapJsKeySaved, amapSecurityCodeSaved, onSaveEdited, onSearchMapPlaces, onEstimateRoute, onConfigureRoutes, onActivate, onExport, onOpen, onShowSource }: {
  trip: Trip | null
  activeRevision: Trip['revisions'][number] | null
  saving: boolean
  placesEnabled: boolean
  routesEnabled: boolean
  amapKeySaved: boolean
  amapJsKeySaved: boolean
  amapSecurityCodeSaved: boolean
  onSaveEdited: (baseRevisionId: string, itinerary: ItineraryOption) => Promise<boolean>
  onSearchMapPlaces: (city: string, query: string) => Promise<SourceRecord[]>
  onEstimateRoute: (city: string, origin: string, destination: string, mode: RouteMode, date?: string, time?: string) => Promise<RouteEstimateResponse>
  onConfigureRoutes: () => void
  onActivate: (id: string) => void
  onExport: () => void
  onOpen: (url: string) => void
  onShowSource: (source: SourceRecord) => void
}) {
  const [draft, setDraft] = useState<ItineraryOption | null>(null)
  const draftRef = useRef<ItineraryOption | null>(null)
  const [undoEntries, setUndoEntries] = useState<ItineraryDraftUndoEntry<ItineraryOption>[]>([])
  const undoEntriesRef = useRef<ItineraryDraftUndoEntry<ItineraryOption>[]>([])
  const [baseRevision, setBaseRevision] = useState<Trip['revisions'][number] | null>(null)
  const [protectedStopIds, setProtectedStopIds] = useState<string[]>([])
  const [mapDayNumber, setMapDayNumber] = useState(1)
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null)
  useEffect(() => {
    setDraft(null)
    draftRef.current = null
    setUndoEntries([])
    undoEntriesRef.current = []
    setBaseRevision(null)
    setProtectedStopIds([])
  }, [trip?.id])

  /** 切换旅行或行程版本后，让地图选中项落在当前可见日期内。 */
  useEffect(() => {
    const days = activeRevision?.itinerary?.days ?? []
    const currentDay = days.find((day) => day.dayNumber === mapDayNumber)
    if (!currentDay) {
      setMapDayNumber(days[0]?.dayNumber ?? 1)
      setSelectedStopId(days[0]?.stops[0]?.id ?? null)
      return
    }
    if (selectedStopId && !currentDay.stops.some((stop) => stop.id === selectedStopId)) {
      setSelectedStopId(currentDay.stops[0]?.id ?? null)
    }
  }, [trip?.id, activeRevision?.id])

  if (!trip) return <EmptyWorkspace icon={<MapIcon size={21} />} title="还没有旅行" action="先新建一趟旅行，再安排每天的行程。" />
  if (!activeRevision) return <EmptyWorkspace icon={<MapIcon size={21} />} title="还没有行程" action="在规划页生成并保存方案后，行程会显示在这里。" />
  const currentRevision = activeRevision
  const previousRevision = previousItineraryRevision(trip.revisions, currentRevision.id)
  const structuredItinerary = currentRevision.itinerary
  const activeMapDay = structuredItinerary?.days.find((day) => day.dayNumber === mapDayNumber) ?? structuredItinerary?.days[0]
  const isEditing = !!draft && !!baseRevision
  const editable = isEditing ? draft : currentRevision.itinerary ?? null
  const draftError = editable ? itineraryDraftError(editable) : ''
  const hasChanges = !!(isEditing && baseRevision?.itinerary && draft && !compareItineraries(baseRevision.itinerary, draft).unchanged)
  const baseStillActive = !!baseRevision && baseRevision.id === currentRevision.id

  /** 从当前不可变版本建立独立草稿，并记录编辑起点与固定地点。 */
  function startEditing(): void {
    if (!currentRevision.itinerary) return
    const nextDraft = structuredClone(currentRevision.itinerary)
    draftRef.current = nextDraft
    setDraft(nextDraft)
    undoEntriesRef.current = []
    setUndoEntries([])
    setBaseRevision(currentRevision)
    setProtectedStopIds(currentRevision.itinerary.days.flatMap((day) => day.stops.filter((stop) => stop.locked).map((stop) => stop.id)))
  }

  /** 丢弃未保存草稿和撤销记录，保留已确认版本。 */
  function cancelEditing(): void {
    draftRef.current = null
    setDraft(null)
    undoEntriesRef.current = []
    setUndoEntries([])
    setBaseRevision(null)
    setProtectedStopIds([])
  }

  /** 保存每个语义编辑前的快照；同一字段连续输入合并为一项撤销。 */
  function updateDraft(next: ItineraryOption, changeKey: string, label: string): void {
    const current = draftRef.current
    if (!current) return
    const nextHistory = recordItineraryDraftUndo(
      undoEntriesRef.current,
      current,
      changeKey,
      label,
      (previous) => compareItineraries(previous, next).unchanged
    )
    draftRef.current = next
    undoEntriesRef.current = nextHistory
    setDraft(next)
    setUndoEntries(nextHistory)
  }

  /** 撤销最近一项编辑操作，不影响已保存版本或其余草稿修改。 */
  function undoLastDraftChange(): void {
    const result = undoItineraryDraft(undoEntriesRef.current)
    if (!result) return
    draftRef.current = result.snapshot
    undoEntriesRef.current = result.history
    setDraft(result.snapshot)
    setUndoEntries(result.history)
  }

  /** 将选中的历史差异写入当前草稿，沿用同一撤销记录和版本校验。 */
  function restoreHistoricalChanges(revision: ItineraryRevision, changeIds: string[]): void {
    const current = draftRef.current
    if (!current || !revision.itinerary || changeIds.length === 0) return
    const restored = restoreItineraryChanges(current, revision.itinerary, changeIds, protectedStopIds)
    if (compareItineraries(current, restored).unchanged) return
    updateDraft(restored, `restore:${revision.id}:${[...changeIds].sort().join(',')}`, `从第 ${revision.number} 版恢复 ${changeIds.length} 项`)
  }

  /** 仅在草稿有效且编辑起点仍为当前版本时提交修改。 */
  async function saveEditing(): Promise<void> {
    if (!draft || !baseRevision || draftError || !hasChanges || !baseStillActive || saving) return
    if (await onSaveEdited(baseRevision.id, draft)) cancelEditing()
  }

  /** 同步时间线选择到地图并校验地点仍属于当前版本。 */
  function selectMapDay(dayNumber: number): void {
    setMapDayNumber(dayNumber)
    const day = structuredItinerary?.days.find((item) => item.dayNumber === dayNumber)
    setSelectedStopId(day?.stops[0]?.id ?? null)
  }

  /** 同步地图选中地点所属日期与停靠点。 */
  function selectMapStop(dayNumber: number, stopId: string): void {
    setMapDayNumber(dayNumber)
    setSelectedStopId(stopId)
  }

  /** 选择候选坐标会产生新版本，使地图位置与已确认行程保持一致。 */
  async function assignMapLocation(dayNumber: number, stopId: string, location: ItineraryStop['location']): Promise<boolean> {
    if (!currentRevision.itinerary || !location) return false
    const next = structuredClone(currentRevision.itinerary)
    const stop = next.days.find((day) => day.dayNumber === dayNumber)?.stops.find((item) => item.id === stopId)
    if (!stop) return false
    stop.location = location
    return onSaveEdited(currentRevision.id, next)
  }

  /** 只有用户明确采纳路线选项时才写入新版本，并保留估算来源。 */
  async function assignRouteEstimate(dayNumber: number, stopId: string, summary: string, estimate: TransitEstimate): Promise<boolean> {
    if (!currentRevision.itinerary || saving) return false
    const next = structuredClone(currentRevision.itinerary)
    const stop = next.days.find((day) => day.dayNumber === dayNumber)?.stops.find((item) => item.id === stopId)
    if (!stop) return false
    stop.transitToNext = summary
    stop.transitEstimate = estimate
    return onSaveEdited(currentRevision.id, next)
  }

  /** 固定或解除单个预约锚点都另存版本，避免静默改变确认计划。 */
  async function toggleStopLock(dayNumber: number, stopId: string, locked: boolean): Promise<boolean> {
    if (!currentRevision.itinerary || saving) return false
    const next = structuredClone(currentRevision.itinerary)
    const stop = next.days.find((day) => day.dayNumber === dayNumber)?.stops.find((item) => item.id === stopId)
    if (!stop) return false
    stop.locked = locked
    return onSaveEdited(currentRevision.id, next)
  }

  return <div className="itinerary-view">
      <div className="content-page-header"><div><span className="eyebrow">{isEditing ? '修改尚未保存' : '已保存行程'}</span><h2>{editable?.title ?? currentRevision.summary}</h2><p>第 {currentRevision.number} 版 · 保存于 {formatTime(currentRevision.createdAt)}</p></div><div className="itinerary-header-actions"><button className="quiet-button" onClick={onExport}><ArrowDownToLine size={15} /> 导出</button>{!isEditing && currentRevision.itinerary && <button className="quiet-button" onClick={startEditing}><PencilLine size={14} /> 编辑行程</button>}</div></div>
    <div className="revision-strip"><span>历史版本{isEditing ? ' · 编辑期间暂不可切换' : ''}</span>{!isEditing && previousRevision && <button className="revision-undo" disabled={saving} aria-label={`撤销到第 ${previousRevision.number} 版`} title="切回上一条已保存版本；当前版本仍保留，可从历史记录恢复" onClick={() => onActivate(previousRevision.id)}><Undo2 size={14} /> 撤销到第 {previousRevision.number} 版</button>}{trip.revisions.map((revision) => <button key={revision.id} disabled={isEditing || saving} className={revision.id === currentRevision.id ? 'current' : ''} onClick={() => onActivate(revision.id)}>{revision.number}<small>{formatDate(revision.createdAt)}</small></button>)}</div>
    {!isEditing && previousRevision && <RevisionTextComparison current={currentRevision} previous={previousRevision} onOpen={onOpen} />}
    {isEditing && draft
      ? <>
        {baseRevision && <ItineraryHistoryRestorer
          key={`${trip.id}:${baseRevision.id}`}
          itinerary={draft}
          revisions={trip.revisions.filter((revision) => revision.id !== baseRevision.id && !!revision.itinerary)}
          protectedStopIds={protectedStopIds}
          onApply={restoreHistoricalChanges}
        />}
        <ItineraryEditor itinerary={draft} onChange={updateDraft} />
        {baseRevision && <PlanChangePreview baselineRevision={baseRevision} proposed={draft} />}
        <ScheduleFeasibility itinerary={draft} anchors={trip.brief} sources={trip.sources} />
        {!baseStillActive && <p className="editor-conflict" role="alert">当前行程版本已变化。取消这次编辑后，重新从当前版本开始。</p>}
        {draftError && <p className="editor-validation" role="status">{draftError}</p>}
        <div className="itinerary-editor-actions"><button className="secondary-button" disabled={!undoEntries.length || saving} aria-label={undoEntries.length ? `撤销最近修改：${undoEntries.at(-1)?.label}` : '没有可撤销的修改'} title={undoEntries.at(-1)?.label ? `撤销：${undoEntries.at(-1)?.label}` : '没有可撤销的修改'} onClick={undoLastDraftChange}><Undo2 size={14} /> 撤销上一步</button><button className="secondary-button" disabled={saving} onClick={cancelEditing}>取消修改</button><button className="primary-button" disabled={!baseStillActive || !hasChanges || !!draftError || saving} onClick={() => void saveEditing()}>{saving ? '保存中…' : '保存为新版本'}</button></div>
      </>
      : currentRevision.itinerary
        ? <StructuredItinerary itinerary={currentRevision.itinerary} anchors={trip.brief} sources={trip.sources} city={trip.brief.destination} placesEnabled={placesEnabled} routesEnabled={routesEnabled} amapKeySaved={amapKeySaved} amapJsKeySaved={amapJsKeySaved} amapSecurityCodeSaved={amapSecurityCodeSaved} saving={saving} activeDayNumber={activeMapDay?.dayNumber ?? 1} selectedStopId={selectedStopId} onSelectDay={selectMapDay} onSelectStop={selectMapStop} onSearchMapPlaces={onSearchMapPlaces} onEstimateRoute={onEstimateRoute} onAssignLocation={assignMapLocation} onAssignRoute={assignRouteEstimate} onToggleStopLock={toggleStopLock} onConfigureRoutes={onConfigureRoutes} onOpen={onOpen} onShowSource={onShowSource} />
      : <article className="itinerary-paper"><MarkdownContent text={currentRevision.content} onOpen={onOpen} /></article>}
  </div>
}

/** 将地点、时段和交通说明写回同一份本地编辑草稿。 */
function ItineraryEditor({ itinerary, onChange }: {
  itinerary: ItineraryOption
  onChange: (next: ItineraryOption, changeKey: string, label: string) => void
}) {
  const [lockedAtEditStart] = useState(() => new Set(
    itinerary.days.flatMap((day) => day.stops.filter((stop) => stop.locked).map((stop) => stop.id))
  ))

  /** 解除固定先单独落一个版本，再允许移动、改时段或删除，避免误操作。 */
  function isProtected(stop: ItineraryStop): boolean {
    return !!stop.locked || lockedAtEditStart.has(stop.id)
  }

  /** 修改方案级文字并写入可撤销的草稿操作。 */
  function updateTop(patch: Partial<Pick<ItineraryOption, 'title' | 'summary' | 'tradeoffs'>>): void {
    const field = Object.keys(patch)[0] as 'title' | 'summary' | 'tradeoffs'
    const fieldLabel = ({ title: '方案名称', summary: '方案摘要', tradeoffs: '安排取舍' })[field]
    onChange({ ...itinerary, ...patch }, `plan:${field}`, `修改${fieldLabel}`)
  }

  /** 更新单日日期或主题并记录撤销标签。 */
  function updateDay(dayId: string, patch: Partial<Pick<ItineraryDay, 'date' | 'title'>>): void {
    const field = Object.keys(patch)[0] as 'date' | 'title'
    const day = itinerary.days.find((item) => item.id === dayId)
    const fieldLabel = field === 'date' ? '日期' : '当日主题'
    onChange({ ...itinerary, days: itinerary.days.map((item) => {
      if (item.id !== dayId) return item
      const updated = { ...item, ...patch }
      if (patch.date !== undefined && patch.date !== item.date) delete updated.weather
      return updated
    }) },
      `day:${dayId}:${field}`, `修改第 ${day?.dayNumber ?? ''} 天${fieldLabel}`)
  }

  /** 更新地点字段并通过统一草稿入口处理证据和撤销记录。 */
  function updateStop(dayId: string, stopId: string, patch: Partial<ItineraryStop>): void {
    const field = Object.keys(patch)[0] as keyof ItineraryStop
    const stop = itinerary.days.find((day) => day.id === dayId)?.stops.find((item) => item.id === stopId)
    const fieldLabels: Partial<Record<keyof ItineraryStop, string>> = {
      name: '名称', area: '区域', time: '时段', durationMinutes: '停留时长', category: '类型',
      transitToNext: '前往下一站说明', notes: '补充说明', locked: '固定状态'
    }
    const fieldLabel = fieldLabels[field] ?? '地点信息'
    onChange({ ...itinerary, days: itinerary.days.map((day) => day.id === dayId
      ? { ...day, stops: day.stops.map((stop) => stop.id === stopId ? { ...stop, ...patch } : stop) }
      : day) }, `stop:${stopId}:${String(field)}`, `修改“${stop?.name || '新地点'}”的${fieldLabel}`)
  }

  /** 更新非地点时段，不触碰地图停靠点和路线证据。 */
  function updateScheduleBlock(dayId: string, blockId: string, patch: Partial<ItineraryScheduleBlock>): void {
    const field = Object.keys(patch)[0] as keyof ItineraryScheduleBlock
    const block = itinerary.days.find((day) => day.id === dayId)?.scheduleBlocks.find((item) => item.id === blockId)
    const fieldLabels: Partial<Record<keyof ItineraryScheduleBlock, string>> = {
      kind: '类型', title: '安排名称', time: '开始时刻', durationMinutes: '时长', area: '适用区域', notes: '说明'
    }
    onChange({ ...itinerary, days: itinerary.days.map((day) => day.id === dayId
      ? { ...day, scheduleBlocks: day.scheduleBlocks.map((block) => block.id === blockId ? { ...block, ...patch } : block) }
      : day) }, `schedule:${blockId}:${String(field)}`, `修改时段“${block?.title || '新时段'}”的${fieldLabels[field] ?? '信息'}`)
  }

  /** 增加独立的用餐或休息时段；具体地点由停靠点维护。 */
  function addScheduleBlock(dayId: string): void {
    const block: ItineraryScheduleBlock = {
      id: crypto.randomUUID(), kind: 'meal', title: '午餐', time: '', durationMinutes: 60, area: '', notes: ''
    }
    onChange({ ...itinerary, days: itinerary.days.map((day) => day.id === dayId
      ? { ...day, scheduleBlocks: [...day.scheduleBlocks, block] }
      : day) }, `add-schedule:${block.id}`, '添加用餐、休息或机动时段')
  }

  /** 删除时段只修改当前草稿，保存前不会写入旅行版本。 */
  function removeScheduleBlock(dayId: string, blockId: string): void {
    const block = itinerary.days.find((day) => day.id === dayId)?.scheduleBlocks.find((item) => item.id === blockId)
    onChange({ ...itinerary, days: itinerary.days.map((day) => day.id === dayId
      ? { ...day, scheduleBlocks: day.scheduleBlocks.filter((item) => item.id !== blockId) }
      : day) }, `remove-schedule:${blockId}`, `删除时段“${block?.title || '新时段'}”`)
  }

  /** 只在同一天内调整未固定地点的顺序。 */
  function moveStop(dayId: string, stopIndex: number, direction: -1 | 1): void {
    onChange({ ...itinerary, days: itinerary.days.map((day) => {
      if (day.id !== dayId) return day
      const nextIndex = stopIndex + direction
      if (nextIndex < 0 || nextIndex >= day.stops.length) return day
      const stops = [...day.stops]
      ;[stops[stopIndex], stops[nextIndex]] = [stops[nextIndex], stops[stopIndex]]
      return { ...day, stops }
    }) }, `move-stop:${itinerary.days.find((day) => day.id === dayId)?.stops[stopIndex]?.id ?? stopIndex}`, '调整地点顺序')
  }

  /** 为指定日期添加空白地点，由用户补充后再保存。 */
  function addStop(dayId: string): void {
    const stop: ItineraryStop = {
      id: crypto.randomUUID(), name: '', area: '', time: '', durationMinutes: null,
      category: '', notes: '', transitToNext: ''
    }
    onChange({ ...itinerary, days: itinerary.days.map((day) => day.id === dayId ? { ...day, stops: [...day.stops, stop] } : day) }, `add-stop:${stop.id}`, '添加地点')
  }

  /** 从草稿移除未固定地点，保存前不改动确认版本。 */
  function removeStop(dayId: string, stopId: string): void {
    const stop = itinerary.days.find((day) => day.id === dayId)?.stops.find((item) => item.id === stopId)
    onChange({ ...itinerary, days: itinerary.days.map((day) => day.id === dayId
      ? { ...day, stops: day.stops.filter((item) => item.id !== stopId) }
      : day) }, `remove-stop:${stopId}`, `删除地点“${stop?.name || '新地点'}”`)
  }

  return <section className="itinerary-editor" aria-label="编辑行程">
    <div className="itinerary-editor-plan-fields">
      <label className="editor-field"><span>方案名称</span><input value={itinerary.title} maxLength={100} onChange={(event) => updateTop({ title: event.target.value })} /></label>
      <label className="editor-field"><span>方案摘要</span><textarea value={itinerary.summary} maxLength={500} rows={2} onChange={(event) => updateTop({ summary: event.target.value })} /></label>
      <label className="editor-field"><span>安排取舍（可选）</span><textarea value={itinerary.tradeoffs} maxLength={500} rows={2} onChange={(event) => updateTop({ tradeoffs: event.target.value })} /></label>
    </div>
    {itinerary.days.map((day) => <section className="itinerary-editor-day" key={day.id}>
      <header><strong>第 {day.dayNumber} 天</strong><label className="editor-field"><span>日期{day.stops.some(isProtected) ? ' · 含固定安排' : ''}</span><input type="date" value={day.date} disabled={day.stops.some(isProtected)} onChange={(event) => updateDay(day.id, { date: event.target.value })} /></label><label className="editor-field editor-day-title"><span>当日主题</span><input value={day.title} maxLength={100} onChange={(event) => updateDay(day.id, { title: event.target.value })} /></label></header>
      {day.stops.length === 0 && <p className="editor-empty-day">这天暂未安排地点，可以作为休息日，或添加一个地点。</p>}
      {day.stops.map((stop, index) => <article className="itinerary-editor-stop" key={stop.id}>
        <div className="editor-stop-actions"><span>{stop.locked ? '固定安排' : `地点 ${index + 1}`}</span><button className={`icon-button ${stop.locked ? 'active' : ''}`} aria-label={stop.locked ? `解除固定：${stop.name}` : `固定安排：${stop.name}`} title={stop.locked ? '解除固定' : '固定地点、日期和时段'} onClick={() => updateStop(day.id, stop.id, { locked: !stop.locked })}>{stop.locked ? <Lock size={14} /> : <Unlock size={14} />}</button><button className="icon-button" aria-label={`上移${stop.name || '新地点'}`} disabled={isProtected(stop) || index === 0} onClick={() => moveStop(day.id, index, -1)}><ArrowUp size={14} /></button><button className="icon-button" aria-label={`下移${stop.name || '新地点'}`} disabled={isProtected(stop) || index === day.stops.length - 1} onClick={() => moveStop(day.id, index, 1)}><ArrowDown size={14} /></button><button className="icon-button danger-link" aria-label={`删除${stop.name || '新地点'}`} disabled={isProtected(stop)} onClick={() => removeStop(day.id, stop.id)}><Trash2 size={14} /></button></div>
        {lockedAtEditStart.has(stop.id) && !stop.locked && <p className="anchor-unlock-note">先保存解除固定，再修改时段、移动或删除此项。</p>}
        <div className="editor-stop-fields">
          <label className="editor-field editor-stop-name"><span>地点名称 *</span><input value={stop.name} maxLength={160} disabled={isProtected(stop)} onChange={(event) => updateStop(day.id, stop.id, { name: event.target.value })} placeholder="输入地点名称" /></label>
          <label className="editor-field"><span>区域</span><input value={stop.area} maxLength={120} onChange={(event) => updateStop(day.id, stop.id, { area: event.target.value })} /></label>
          <label className="editor-field"><span>时段{isProtected(stop) ? ' · 固定' : ''}</span><input value={stop.time} maxLength={40} disabled={isProtected(stop)} onChange={(event) => updateStop(day.id, stop.id, { time: event.target.value })} placeholder="如：上午" /></label>
          <label className="editor-field"><span>停留分钟</span><input type="number" min={0} max={720} step={15} value={stop.durationMinutes ?? ''} onChange={(event) => updateStop(day.id, stop.id, { durationMinutes: event.target.value === '' ? null : Number(event.target.value) })} /></label>
          <label className="editor-field"><span>类型</span><input value={stop.category} maxLength={60} onChange={(event) => updateStop(day.id, stop.id, { category: event.target.value })} placeholder="人文、美食、休息…" /></label>
          <label className="editor-field editor-stop-wide"><span>前往下一站</span><input value={stop.transitToNext} maxLength={300} onChange={(event) => updateStop(day.id, stop.id, { transitToNext: event.target.value })} /></label>
          <label className="editor-field editor-stop-wide"><span>补充说明</span><textarea value={stop.notes} maxLength={500} rows={2} onChange={(event) => updateStop(day.id, stop.id, { notes: event.target.value })} /></label>
        </div>
      </article>)}
      <section className="itinerary-editor-blocks" aria-label={`第 ${day.dayNumber} 天的用餐、休息与机动时段`}>
        <header><div><strong>用餐、休息与机动时段</strong><small>单独安排时间；具体餐馆或地点请添加到地点列表。</small></div>
          <button className="text-button" disabled={day.scheduleBlocks.length >= 8} onClick={() => addScheduleBlock(day.id)}><Plus size={14} /> 添加时段</button>
        </header>
        {day.scheduleBlocks.map((block, index) => <article className="itinerary-editor-block" key={block.id}>
          <div className="editor-stop-actions"><span>时段 {index + 1}</span><button className="icon-button danger-link" aria-label={`删除${block.title}`} onClick={() => removeScheduleBlock(day.id, block.id)}><Trash2 size={14} /></button></div>
          <div className="editor-block-fields">
            <label className="editor-field"><span>类型</span><select value={block.kind} onChange={(event) => updateScheduleBlock(day.id, block.id, { kind: event.target.value as ItineraryScheduleBlockKind })}>
              <option value="meal">用餐</option><option value="rest">休息</option><option value="buffer">机动时间</option>
            </select></label>
            <label className="editor-field"><span>安排名称 *</span><input value={block.title} maxLength={100} onChange={(event) => updateScheduleBlock(day.id, block.id, { title: event.target.value })} placeholder="午餐、午休、自由缓冲" /></label>
            <label className="editor-field"><span>开始时刻或时段</span><input value={block.time} maxLength={40} onChange={(event) => updateScheduleBlock(day.id, block.id, { time: event.target.value })} placeholder="12:00 或 午间" /></label>
            <label className="editor-field"><span>时长（分钟）</span><input type="number" min={1} max={720} step={15} value={block.durationMinutes ?? ''} onChange={(event) => updateScheduleBlock(day.id, block.id, { durationMinutes: event.target.value === '' ? null : Number(event.target.value) })} /></label>
            <label className="editor-field"><span>适用区域</span><input value={block.area} maxLength={120} onChange={(event) => updateScheduleBlock(day.id, block.id, { area: event.target.value })} placeholder="可留空" /></label>
            <label className="editor-field editor-stop-wide"><span>说明</span><textarea value={block.notes} maxLength={300} rows={2} onChange={(event) => updateScheduleBlock(day.id, block.id, { notes: event.target.value })} /></label>
          </div>
        </article>)}
      </section>
      <button className="text-button itinerary-add-stop" onClick={() => addStop(day.id)}><Plus size={14} /> 添加地点</button>
    </section>)}
  </section>
}

/** 校验编辑草稿的用户输入，在 IPC 拒绝前给出行内反馈。 */
function itineraryDraftError(itinerary: ItineraryOption): string {
  if (!itinerary.title.trim() || itinerary.title.length > 100) return '请填写方案名称（最多 100 个字符）。'
  if (!itinerary.summary.trim() || itinerary.summary.length > 500) return '请填写方案摘要（最多 500 个字符）。'
  if (itinerary.tradeoffs.length > 500) return '安排取舍最多 500 个字符。'
  if (itinerary.days.length < 1 || itinerary.days.length > 7) return '行程天数需为 1–7 天。'
  for (const day of itinerary.days) {
    if (!day.title.trim() || day.title.length > 100) return `第 ${day.dayNumber} 天需要填写主题。`
    if (day.date && !isCalendarDateText(day.date)) return `第 ${day.dayNumber} 天的日期无效。`
    if (day.stops.length > MAX_ITINERARY_STOPS_PER_DAY) return `第 ${day.dayNumber} 天最多可安排 ${MAX_ITINERARY_STOPS_PER_DAY} 个地点。`
    if (day.scheduleBlocks.length > 8) return `第 ${day.dayNumber} 天最多可安排 8 个用餐或休息时段。`
    for (const stop of day.stops) {
      if (!stop.name.trim() || stop.name.length > 160) return '新地点需要填写名称（最多 160 个字符）。'
      if (stop.durationMinutes !== null && (!Number.isInteger(stop.durationMinutes) || stop.durationMinutes < 0 || stop.durationMinutes > 720)) return `“${stop.name}”的停留分钟数需为 0–720。`
    }
    for (const block of day.scheduleBlocks) {
      if (!block.title.trim() || block.title.length > 100) return '用餐或休息安排需要填写名称（最多 100 个字符）。'
      if (block.time.length > 40 || block.area.length > 120 || block.notes.length > 300) return '用餐或休息安排字段超出长度限制。'
      if (block.durationMinutes !== null && (!Number.isInteger(block.durationMinutes) || block.durationMinutes < 1 || block.durationMinutes > 720)) return `“${block.title}”的时长需为 1–720 分钟。`
    }
  }
  return ''
}

/** 严格检查浏览器日期输入，避免把无效日历日期保存到新版本。 */
function isCalendarDateText(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

/** 将确认行程、交互地图和时间线选择绑定到同一份结构化版本。 */
function StructuredItinerary({ itinerary, anchors, sources, city, placesEnabled, routesEnabled, amapKeySaved, amapJsKeySaved, amapSecurityCodeSaved, saving, activeDayNumber, selectedStopId, onSelectDay, onSelectStop, onSearchMapPlaces, onEstimateRoute, onAssignLocation, onAssignRoute, onToggleStopLock, onConfigureRoutes, onOpen, onShowSource }: {
  itinerary: NonNullable<Trip['revisions'][number]['itinerary']>
  anchors: TripBrief
  sources: SourceRecord[]
  city: string
  placesEnabled: boolean
  routesEnabled: boolean
  amapKeySaved: boolean
  amapJsKeySaved: boolean
  amapSecurityCodeSaved: boolean
  saving: boolean
  activeDayNumber: number
  selectedStopId: string | null
  onSelectDay: (dayNumber: number) => void
  onSelectStop: (dayNumber: number, stopId: string) => void
  onSearchMapPlaces: (city: string, query: string) => Promise<SourceRecord[]>
  onEstimateRoute: (city: string, origin: string, destination: string, mode: RouteMode, date?: string, time?: string) => Promise<RouteEstimateResponse>
  onAssignLocation: (dayNumber: number, stopId: string, location: NonNullable<ItineraryStop['location']>) => Promise<boolean>
  onAssignRoute: (dayNumber: number, stopId: string, summary: string, estimate: TransitEstimate) => Promise<boolean>
  onToggleStopLock: (dayNumber: number, stopId: string, locked: boolean) => Promise<boolean>
  onConfigureRoutes: () => void
  onOpen: (url: string) => void
  onShowSource: (source: SourceRecord) => void
}) {
  return <div className="structured-itinerary">
    <div className="itinerary-summary"><p>{itinerary.summary}</p>{itinerary.tradeoffs.trim() && <span><strong>安排取舍</strong>{itinerary.tradeoffs}</span>}</div>
    {itinerary.budgetEstimate
      ? <ItineraryBudgetEstimateCard estimate={itinerary.budgetEstimate} sources={sources} budget={anchors.budget} travelers={anchors.travelers} onShowSource={onShowSource} />
      : <ItineraryTransportCostSummary itinerary={itinerary} />}
    <ScheduleFeasibility itinerary={itinerary} anchors={anchors} sources={sources} />
    <ItineraryMap days={itinerary.days} sources={sources} city={city} routesEnabled={routesEnabled} amapKeySaved={amapKeySaved} amapJsKeySaved={amapJsKeySaved} amapSecurityCodeSaved={amapSecurityCodeSaved} saving={saving} activeDayNumber={activeDayNumber} selectedStopId={selectedStopId}
      placesEnabled={placesEnabled} onSelectDay={onSelectDay} onSelectStop={onSelectStop}
      onSearch={onSearchMapPlaces} onEstimateRoute={onEstimateRoute} onAssignLocation={onAssignLocation}
      onAssignRoute={onAssignRoute} onConfigureRoutes={onConfigureRoutes} onOpen={onOpen} />
    {itinerary.days.map((day) => <section className={`itinerary-day ${day.dayNumber === activeDayNumber ? 'itinerary-day-active' : ''}`} key={day.id}>
      <header><span>第 {day.dayNumber} 天{day.date ? ` · ${day.date}` : ''}</span><h3>{day.title}</h3></header>
      {!day.stops.length && <p className="itinerary-rest-day">当天没有安排地点，适合作为休息或自由活动日。</p>}
      {day.lodgingCommutes?.filter((commute) => commute.direction === 'from-lodging').map((commute) =>
        <LodgingCommuteTimelineCard key={`${commute.direction}-${commute.sourceId}`} commute={commute} day={day} lodgingLocation={anchors.lodgingLocation} sources={sources} onOpen={onOpen} onShowSource={onShowSource} />
      )}
      <ol>{orderItineraryDaySchedule(day).map((entry) => {
        if (entry.kind === 'block') return <li className="itinerary-schedule-list-item" key={entry.block.id}>
          <div className="stop-rail"><span>{entry.block.time || '时段待补充'}</span><i /></div>
          <ScheduleBlockTimelineCard block={entry.block} />
        </li>
        const stop = entry.stop
        const index = day.stops.indexOf(stop)
        return <li key={stop.id}>
        <div className="stop-rail"><span>{stop.time || String(index + 1).padStart(2, '0')}</span><i /></div>
        <div className={`stop-card ${stop.id === selectedStopId ? 'stop-card-selected' : ''}`}>
          <div className="stop-title-row"><button className="stop-selection-button" aria-pressed={stop.id === selectedStopId} onClick={() => onSelectStop(day.dayNumber, stop.id)}><h4>{stop.name}{stop.locked && <span className="locked-stop-badge"><Lock size={11} /> 固定安排</span>}</h4><span>{[stop.area, stop.category, stop.durationMinutes ? `约 ${stop.durationMinutes} 分钟` : '停留时间待核验'].filter(Boolean).join(' · ')}</span></button>
            <div className="stop-card-actions"><button className="icon-button stop-lock-toggle" disabled={saving} aria-label={stop.locked ? `解除固定：${stop.name}` : `固定安排：${stop.name}`} title={stop.locked ? '解除固定地点' : '固定地点、日期和时段'} onClick={() => void onToggleStopLock(day.dayNumber, stop.id, !stop.locked)}>{stop.locked ? <Lock size={14} /> : <Unlock size={14} />}</button><button className="text-button" onClick={() => onOpen(`https://ditu.amap.com/search?query=${encodeURIComponent(stop.name)}`)}><MapPin size={13} /> 地图</button></div>
          </div>
          {stop.notes && <p>{stop.notes}</p>}
          <ItineraryEvidenceLinks stop={stop} sources={sources} onOpen={onOpen} onShowSource={onShowSource} />
          {stop.transitToNext && <div className="stop-transit"><Route size={13} /><div><span>{stop.transitToNext}</span>
            {stop.transitEstimate && (() => {
              const source = sources.find((item) => item.id === stop.transitEstimate?.sourceId)
              const mode = stop.transitEstimate.mode === 'transit' ? '公共交通' : stop.transitEstimate.mode === 'walking' ? '步行' : '驾车'
              const departure = stop.transitEstimate.queryDate
                ? ` · ${stop.transitEstimate.queryDate}${stop.transitEstimate.queryTime ? ` ${stop.transitEstimate.queryTime.replace('-', ':')}` : ''}`
                : ''
              const routeDuration = typeof stop.transitEstimate.durationMinutes === 'number'
                ? `路线估时约 ${stop.transitEstimate.durationMinutes} 分钟 · ` : ''
              return <small className="stop-transit-provenance">高德地图{mode}方案 {stop.transitEstimate.optionNumber}{departure} · {routeDuration}建议另留 {routePlanningBufferMinutes(stop.transitEstimate.mode)} 分钟机动余量 · {formatTime(stop.transitEstimate.fetchedAt)}
                {source && <button className="text-button" disabled={!source.url} onClick={() => onOpen(source.url)}>查看路线来源</button>}
              </small>
            })()}
          </div></div>}
        </div>
      </li>
      })}</ol>
      {day.lodgingCommutes?.filter((commute) => commute.direction === 'to-lodging').map((commute) =>
        <LodgingCommuteTimelineCard key={`${commute.direction}-${commute.sourceId}`} commute={commute} day={day} lodgingLocation={anchors.lodgingLocation} sources={sources} onOpen={onOpen} onShowSource={onShowSource} />
      )}
      {day.scheduleBlocks.some((block) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(block.time.trim())) &&
        <small className="itinerary-schedule-order-note">宽泛或未填写时段显示在列表末尾；系统不会猜测具体时间。</small>}
    </section>)}
  </div>
}

/** 格式化版本历史日期。 */
function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '未知' : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date)
}
