/** 出行准备清单、事项编辑和准备建议卡复用的展示组件。 */
import { useState, type FormEvent } from 'react'
import {
  ArrowRight, ClipboardCheck, Compass, ExternalLink, FileText, Luggage, Map as MapIcon,
  PencilLine, Sun, Trash2, Utensils
} from 'lucide-react'
import type {
  ChatMessage, ItineraryOption, PackingSection, PreparationItem, PreparationItemUpdate,
  PreparationLocationContext, SourceRecord, Trip
} from '@shared/types'
import { groupPreparationItemsByDate } from '../../shared/preparation'
import { EmptyWorkspace } from './components/EmptyWorkspace'

/** 编辑单条准备事项，同时保留原来源并在主进程标记用户修改为待核验。 */
function PreparationChecklistItem({ item, sources, activeItinerary, onToggle, onUpdate, onDelete, onOpen }: {
  item: PreparationItem
  sources: SourceRecord[]
  activeItinerary?: ItineraryOption
  onToggle: (itemId: string, checked: boolean) => void
  onUpdate: (itemId: string, update: PreparationItemUpdate) => Promise<boolean>
  onDelete: (itemId: string) => Promise<boolean>
  onOpen: (url: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState(item.title)
  const [detail, setDetail] = useState(item.detail)
  const [itineraryDate, setItineraryDate] = useState(item.itineraryDate)
  const [dueDate, setDueDate] = useState(item.dueDate)
  const [legacyDateAction, setLegacyDateAction] = useState<PreparationItemUpdate['legacyDateAction'] | ''>('')
  const [packingSection, setPackingSection] = useState<PackingSection>(item.packingSection ?? 'unclassified')
  const hasChanges = title.trim() !== item.title || detail.trim() !== item.detail || itineraryDate !== item.itineraryDate || dueDate !== item.dueDate ||
    (!!item.legacyDate && !!legacyDateAction) ||
    (item.category === 'packing' && packingSection !== (item.packingSection ?? 'unclassified'))

  /** 把当前准备事项载入编辑状态，等待用户修改。 */
  function startEditing(): void {
    setTitle(item.title)
    setDetail(item.detail)
    setItineraryDate(item.itineraryDate)
    setDueDate(item.dueDate)
    setLegacyDateAction('')
    setPackingSection(item.packingSection ?? 'unclassified')
    setConfirmDelete(false)
    setEditing(true)
  }

  /** 放弃当前输入并恢复已保存事项内容。 */
  function cancelEditing(): void {
    setTitle(item.title)
    setDetail(item.detail)
    setItineraryDate(item.itineraryDate)
    setDueDate(item.dueDate)
    setLegacyDateAction('')
    setPackingSection(item.packingSection ?? 'unclassified')
    setEditing(false)
  }

  /** 保存已校验的字段，并将手工修改标为待核验。 */
  async function saveEditing(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    try {
      if (await onUpdate(item.id, {
        title, detail, itineraryDate, dueDate,
        ...(item.legacyDate ? { legacyDateAction: legacyDateAction || undefined } : {}),
        ...(item.category === 'packing' ? { packingSection } : {})
      })) setEditing(false)
    } finally {
      setBusy(false)
    }
  }

  /** 执行已确认的单项删除并反馈失败原因。 */
  async function confirmRemoval(): Promise<void> {
    setBusy(true)
    try {
      if (await onDelete(item.id)) setConfirmDelete(false)
    } finally {
      setBusy(false)
    }
  }

  return <article className={`preparation-item ${item.checked ? 'preparation-item-done' : ''}`}>
    <div className="preparation-item-lead">
      <label><input type="checkbox" checked={item.checked} disabled={busy} onChange={(event) => onToggle(item.id, event.target.checked)} /><span>{item.title}</span></label>
      <div className="preparation-item-actions">
        {!editing && <button className="icon-button" aria-label={`编辑：${item.title}`} title="编辑事项" onClick={startEditing}><PencilLine size={13} /></button>}
        {!editing && !confirmDelete && <button className="icon-button danger-link" aria-label={`删除：${item.title}`} title="移除事项" onClick={() => setConfirmDelete(true)}><Trash2 size={13} /></button>}
        {confirmDelete && <div className="preparation-item-delete-confirm"><span>移除这项？</span><button className="text-button danger-link" disabled={busy} onClick={() => void confirmRemoval()}>{busy ? '删除中…' : '确认'}</button><button className="text-button" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button></div>}
      </div>
    </div>
    <div className="preparation-item-detail">
      {editing
        ? <form className="preparation-item-edit" onSubmit={(event) => void saveEditing(event)}>
          <label className="editor-field"><span>事项标题</span><input value={title} maxLength={120} required onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="editor-field"><span>说明</span><textarea value={detail} maxLength={600} rows={3} required onChange={(event) => setDetail(event.target.value)} /></label>
          {item.legacyDate && <label className="editor-field"><span>旧版日期：{item.legacyDate}（含义未记录）</span><select required value={legacyDateAction} onChange={(event) => {
            const action = event.target.value as PreparationItemUpdate['legacyDateAction'] | ''
            setLegacyDateAction(action)
            if (action === 'itinerary') setItineraryDate(item.legacyDate ?? '')
            if (action === 'deadline') setDueDate(item.legacyDate ?? '')
            if (action === 'clear') {
              setItineraryDate('')
              setDueDate('')
            }
          }}>
            <option value="">请确认旧日期的含义</option><option value="itinerary">作为适用行程日</option><option value="deadline">作为完成截止日</option><option value="clear">不再保留这个日期</option>
          </select></label>}
          <label className="editor-field"><span>适用行程日</span><input type="date" value={itineraryDate} onChange={(event) => setItineraryDate(event.target.value)} /></label>
          <label className="editor-field"><span>完成截止日</span><input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} /></label>
          {item.category === 'packing' && <label className="editor-field"><span>装包位置</span><select value={packingSection} onChange={(event) => setPackingSection(event.target.value as PackingSection)}>
            <option value="carry-on">随身行李</option><option value="checked">托运行李</option><option value="personal-item">个人随身物品</option><option value="unclassified">待分类</option>
          </select></label>}
          <p className="preparation-edit-note">保存后会标为“待核验”；若关联地点或路线估算已失效，会一并清除，来源链接仍可查看。</p>
          <div className="preparation-item-edit-actions"><button type="button" className="secondary-button" disabled={busy} onClick={cancelEditing}>取消</button><button type="submit" className="primary-button" disabled={busy || !hasChanges || (!!item.legacyDate && (!legacyDateAction || (legacyDateAction === 'itinerary' && !itineraryDate) || (legacyDateAction === 'deadline' && !dueDate))) || !title.trim() || !detail.trim()}>{busy ? '保存中…' : '保存修改'}</button></div>
        </form>
        : <p>{item.detail}</p>}
      {item.locationContext && <PreparationLocationSummary context={item.locationContext} itineraryDate={item.itineraryDate} itinerary={activeItinerary} />}
      <div className="preparation-item-meta"><span>{preparationCategoryLabel(item.category)}</span>{item.category === 'packing' && <span>{packingSectionLabel(item.packingSection ?? 'unclassified')}</span>}<span className={`evidence-${item.evidenceLevel}`}>{evidenceLevelLabel(item.evidenceLevel)}</span>{item.itineraryDate && <span>适用日 {preparationDateLabel(item.itineraryDate)}</span>}{item.dueDate && <span>截止 {preparationDateLabel(item.dueDate)}</span>}{item.legacyDate && <span className="preparation-location-stale">旧版日期待确认：{item.legacyDate}</span>}{sources.filter((source) => !!source.url).map((source) => <button className="text-button" key={source.id} onClick={() => onOpen(source.url)}>{source.kind === 'place' ? '打开地图候选' : source.kind === 'route' ? `查看路线方案 ${item.locationContext?.routeOptionNumber ?? ''}`.trim() : '查看依据'} <ExternalLink size={11} /></button>)}</div>
    </div>
  </article>
}

/** 展示建议绑定的具体行程停靠点，并把路线指标标为服务估算。 */
export function PreparationLocationSummary({ context, itineraryDate, itinerary }: {
  context: PreparationLocationContext
  itineraryDate?: string
  itinerary?: ItineraryOption
}) {
  const routeMetrics = [
    context.distanceMeters === undefined ? '' : preparationDistanceLabel(context.distanceMeters),
    context.durationMinutes === undefined ? '' : `约 ${context.durationMinutes} 分钟`
  ].filter(Boolean)
  const currentDay = itinerary?.days.find((day) => day.stops.some((stop) => stop.id === context.stopId))
  const currentStop = currentDay?.stops.find((stop) => stop.id === context.stopId)
  const isOutdated = !!itinerary && (!currentDay || !currentStop || currentDay.date !== itineraryDate ||
    currentDay.dayNumber !== context.dayNumber || currentDay.title !== context.dayTitle ||
    currentStop.name !== context.stopName || currentStop.area !== context.area)
  return <div className="preparation-location-summary">
    <span>对应行程：第 {context.dayNumber} 天 · {context.stopName}{context.area ? `（${context.area}）` : ''}</span>
    {routeMetrics.length > 0 && <span>路线估算方案 {context.routeOptionNumber}：{routeMetrics.join(' · ')}</span>}
    {isOutdated && <span className="preparation-location-stale">行程已变更，请重新核对关联地点</span>}
  </div>
}

/** 用图标和短标题呈现准备入口，详细要求放入可编辑的对话草稿。 */
export function PreparationView({ trip, activeRevision, onSwitchToChat, onToggleItem, onUpdateItem, onDeleteItem, onOpen }: {
  trip: Trip | null
  activeRevision: Trip['revisions'][number] | null
  onSwitchToChat: (prompt?: string) => void
  onToggleItem: (itemId: string, checked: boolean) => void
  onUpdateItem: (itemId: string, update: PreparationItemUpdate) => Promise<boolean>
  onDeleteItem: (itemId: string) => Promise<boolean>
  onOpen: (url: string) => void
}) {
  if (!trip) return <EmptyWorkspace icon={<Luggage size={21} />} title="还没有旅行" action="新建旅行后即可整理准备事项。" />
  const prompts = [
    { icon: <Sun size={18} />, title: '每天穿什么', prompt: '结合这几天的天气和我带的衣服，安排每天穿什么。预报还不可靠的日期，请提醒我何时复查。' },
    { icon: <FileText size={18} />, title: '门票与预约', prompt: '查一下哪些景点需要预约或购票，附上官方入口、开放时间和闭馆日。暂时查不到的请标出来。' },
    { icon: <Luggage size={18} />, title: '行李清单', prompt: '按随身行李、托运行李和个人物品列一份清单，考虑我的行李额度、电脑和相机。航司规则不确定的地方请标出来。' },
    { icon: <Utensils size={18} />, title: '沿途餐馆', prompt: '按每天的安排和我的口味推荐附近餐馆，避开忌口，附上店名、地址和来源。没有查到路线时，不要估算距离和时间。' },
    { icon: <Compass size={18} />, title: '雨天备选', prompt: '给每天找一个下雨或想少走路时能替换的安排，写明日期、地点和来源。' }
  ]
  return <div className="preparation-view">
    <div className="content-page-header"><div><h2>出行准备</h2></div></div>
    {!activeRevision && <div className="preparation-callout"><MapIcon size={18} /><span>保存行程后，准备事项会按天整理。</span><button className="text-button" onClick={() => onSwitchToChat()}>前往规划</button></div>}
    {activeRevision && <section className="preparation-checklist" aria-label="准备清单">
      <header className="preparation-checklist-header"><p>已完成 {trip.preparationItems.filter((item) => item.checked).length} / {trip.preparationItems.length}</p></header>
      {trip.preparationItems.length
        ? <div className="preparation-date-groups">{groupPreparationItemsByDate(trip.preparationItems, activeRevision.itinerary?.days ?? []).map((group) => {
          const dayLabels = group.itineraryDays.map((day) => `第 ${day.dayNumber} 天 · ${day.title}`)
          const areas = [...new Set(group.itineraryDays.flatMap((day) => day.stops.map((stop) => stop.area.trim()).filter(Boolean)))]
          return <section className="preparation-date-group" key={`${group.kind}:${group.date || 'undated'}`}>
            <header className="preparation-date-group-header">
              <div className="preparation-date-group-heading"><h4>{group.kind === 'itinerary' ? preparationDateLabel(group.date) : group.kind === 'deadline' ? `截止 ${preparationDateLabel(group.date)}` : group.kind === 'legacy' ? `旧版日期待确认：${group.date}` : '未指定日期'}</h4><span>{group.items.length} 项</span></div>
              {dayLabels.length > 0 && <p>对应行程：{dayLabels.join('；')}</p>}
              {areas.length > 0 && <p>当天经过：{areas.join('、')}</p>}
            </header>
            <div className="preparation-item-list">{group.items.map((item) => {
              const sources = item.sourceIds.map((id) => trip.sources.find((candidate) => candidate.id === id)).filter((source): source is SourceRecord => !!source)
              return <PreparationChecklistItem key={item.id} item={item} sources={sources} activeItinerary={activeRevision.itinerary} onToggle={onToggleItem} onUpdate={onUpdateItem} onDelete={onDeleteItem} onOpen={onOpen} />
            })}</div>
          </section>
        })}</div>
        : <div className="preparation-empty"><ClipboardCheck size={17} /><span>还没有准备事项</span></div>}
    </section>}
    <div className="prep-grid">{prompts.map((item) => <button className="prep-card" key={item.title} disabled={!activeRevision} onClick={() => onSwitchToChat(item.prompt)}><span className="prep-card-icon" aria-hidden="true">{item.icon}</span><span className="prep-card-copy"><strong>{item.title}</strong></span><ArrowRight size={16} aria-hidden="true" /></button>)}</div>
  </div>
}

/** 用中文名称展示准备事项分类。 */
export function preparationCategoryLabel(category: NonNullable<ChatMessage['preparationOptions']>[number]['category']): string {
  return ({ booking: '预约', packing: '行李', clothing: '穿搭', food: '餐饮', alternative: '备选活动', transport: '交通', other: '其他' })[category]
}

/** 以本地日期显示适用日；保留年份便于跨年旅行区分。 */
export function preparationDateLabel(value: string): string {
  const date = new Date(`${value}T12:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' }).format(date)
}

/** 以米或千米显示由路线服务返回的距离。 */
function preparationDistanceLabel(meters: number): string {
  return meters >= 1_000 ? `${(meters / 1_000).toFixed(1)} km` : `${meters} m`
}

/** 将机器可校验的装包分类转换为用户可编辑的中文标签。 */
export function packingSectionLabel(section: PackingSection): string {
  return ({ 'carry-on': '随身行李', checked: '托运行李', 'personal-item': '个人随身物品', unclassified: '待分类' })[section]
}

/** 说明准备建议的证据强度，避免把估算或未知写成确定事实。 */
export function evidenceLevelLabel(level: NonNullable<ChatMessage['preparationOptions']>[number]['evidenceLevel']): string {
  return ({ sourced: '有来源', estimated: '估算', pending: '待核验' })[level]
}
