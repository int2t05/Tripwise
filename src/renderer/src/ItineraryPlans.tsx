/** 展示候选行程方案、来源依据和可计算的时间核对结果。 */
import { useState } from 'react'
import { Check, FileText, GripVertical, MapPin, PencilLine, Route, X } from 'lucide-react'
import type { ItineraryDay, ItineraryOption, ItineraryScheduleBlock, ItineraryStop, LodgingCommute, SourceRecord, Trip, TripBrief, ChatMessage } from '@shared/types'
import type { BudgetCostCategory, ItineraryBudgetEstimate } from '@shared/types'
import { comparePlanOptions, lodgingCommuteHasValidSource, summarizeItineraryTransportCosts } from '@shared/itinerary'
import { BUDGET_CATEGORY_LABELS, compareBudgetPreference, formatBudgetRange, summarizeBudgetEstimate } from '@shared/budget'
import { groupItineraryFacts, itineraryFactTypeLabel } from '@shared/itinerary-facts'
import { analyzeDaySchedule, analyzeMealRequirements, orderItineraryDaySchedule, plannedStopTimeLabel, routePlanningBufferMinutes, scheduleBlockKindLabel, type ScheduleFinding } from '@shared/itinerary-schedule'
import { compareItineraries, preserveLockedStops, type ItineraryChangeType } from '@shared/itinerary-revisions'
import { itineraryGeographicReview, repeatedLandmarkReviews, repeatedLandmarkRevisionSuggestion } from '@shared/itinerary-geography'
import { sourceTimestampLabel, statusLabel } from './ui-format'
import { sourceFreshnessNotice } from './source-freshness'
import type { ItineraryFactGroup } from '@shared/itinerary-facts'

/** 将地点依据状态和具体来源入口放在对应地点旁边，而非只挂在整轮回答上。 */
export function ItineraryEvidenceLinks({ stop, sources, onOpen, onShowSource, showEvidenceLevel = true }: {
  stop: ItineraryStop
  sources: SourceRecord[]
  onOpen: (url: string) => void
  onShowSource: (source: SourceRecord) => void
  showEvidenceLevel?: boolean
}) {
  const level = stop.evidenceLevel ?? 'pending'
  const linkedSources = (stop.sourceIds ?? []).map((id) => sources.find((source) => source.id === id)).filter((source): source is SourceRecord => !!source)
  const factGroups = groupItineraryFacts(stop.factClaims)
  const factGroupsWithFreshness = factGroups.map((group) => ({
    group,
    freshnessSources: freshnessSourcesForFactGroup(group, sources)
  }))
  const factFreshnessSourceIds = new Set(factGroupsWithFreshness.flatMap(({ freshnessSources }) => freshnessSources.map((source) => source.id)))
  return <div className="itinerary-stop-evidence">
    {showEvidenceLevel && <span className={`evidence-${level}`}>{itineraryEvidenceLabel(level)}</span>}
    {linkedSources.length
      ? linkedSources.map((source) => <span className="itinerary-linked-source" key={source.id}>
        <button className="text-button" onClick={() => source.url ? onOpen(source.url) : onShowSource(source)} title={`${source.title || source.provider} · ${sourceTimestampLabel(source)}`}>
          <FileText size={11} /> {source.title || source.provider} · {sourceTimestampLabel(source)}
        </button>
        {source.status !== 'success' && <small className="evidence-pending">来源{statusLabel(source.status)}，地点依据请复核。</small>}
        {!factFreshnessSourceIds.has(source.id) && <SourceFreshnessStatus source={source} onShowSource={onShowSource} />}
      </span>)
      : <small>{level === 'estimated' ? '按行程估算' : '没有相关来源'}</small>}
    {factGroups.length > 0 && <div className="itinerary-fact-claims" aria-label="逐项来源事实">
      {factGroupsWithFreshness.map(({ group, freshnessSources }) => <section className={group.conflicting ? 'itinerary-fact-group fact-conflict' : 'itinerary-fact-group'} key={`${group.type}-${group.scope}`}>
        <header><strong>{itineraryFactTypeLabel(group.type)}{group.scope ? ` · ${group.scope}` : ''}</strong>
          {group.conflicting && <span role="alert">信息冲突 · 请核对</span>}</header>
        {freshnessSources.map((source) => <SourceFreshnessStatus key={source.id} source={source} onShowSource={onShowSource} />)}
        {group.claims.map((claim) => {
          const source = claim.sourceId ? sources.find((item) => item.id === claim.sourceId) : undefined
          return <div className="itinerary-fact-claim" key={claim.id}>
            <strong>{claim.value}</strong>
            <span className={`evidence-${claim.evidenceLevel}`}>{itineraryEvidenceLabel(claim.evidenceLevel)}</span>
            {source
              ? <>
                <button className="text-button" onClick={() => source.url ? onOpen(source.url) : onShowSource(source)} title={`${source.title || source.provider} · ${sourceTimestampLabel(source)}`}>
                  <FileText size={11} /> {source.title || source.provider} · {sourceTimestampLabel(source)}
                </button>
                {claim.evidenceLevel === 'pending' && <small>参考来源已关联，事实内容仍待核验。</small>}
                {claim.evidenceLevel === 'sourced' && source.status !== 'success' && <small className="evidence-pending">来源{statusLabel(source.status)}，此事实需复核。</small>}
              </>
              : <small className={claim.evidenceLevel === 'sourced' ? 'evidence-pending' : undefined}>
                {claim.evidenceLevel === 'estimated' ? '行程估算' : claim.evidenceLevel === 'sourced' ? '来源已不可用，请重新核对。' : '没有可查看的来源'}
              </small>}
          </div>
        })}
      </section>)}
    </div>}
    {!!stop.conditionalAlternatives?.length && <div className="itinerary-conditional-alternatives" role="group" aria-label="条件备选地点">
      {stop.conditionalAlternatives.map((alternative, index) => {
        const linkedSources = alternative.sourceIds
          .map((id) => sources.find((source) => source.id === id))
          .filter((source): source is SourceRecord => !!source)
        return <div className="itinerary-conditional-alternative" key={`${alternative.name}-${alternative.trigger}-${index}`}>
          <strong>备选：{alternative.name}{alternative.area ? `（${alternative.area}）` : ''}</strong>
          {alternative.environment === 'indoor' && <span>室内活动</span>}
          {alternative.environment === 'outdoor' && <span>室外活动</span>}
          <span>触发：{alternative.trigger}</span>
          <span className={`evidence-${alternative.evidenceLevel}`}>
            {alternative.evidenceLevel === 'sourced' ? '地点有来源' : '地点待核验'}
          </span>
          {linkedSources.length
            ? linkedSources.map((source) => <button className="text-button" key={source.id}
              onClick={() => source.url ? onOpen(source.url) : onShowSource(source)}
              title={`${source.title || source.provider} · ${sourceTimestampLabel(source)}`}>
              <FileText size={11} /> {source.title || source.provider} · {sourceTimestampLabel(source)}
            </button>)
            : <small>没有直接支持此地点的来源</small>}
          {linkedSources.filter((source) => source.status !== 'success').map((source) => <small className="evidence-pending" key={`${source.id}-status`}>
            来源{statusLabel(source.status)}，备选地点需复核。
          </small>)}
        </div>
      })}
    </div>}
  </div>
}

/** 只把动态事实绑定到匹配的天气或路线服务来源，并在同一事实组内去重。 */
function freshnessSourcesForFactGroup(group: ItineraryFactGroup, sources: SourceRecord[]): SourceRecord[] {
  const expectedKind = group.type === 'weather' ? 'weather' : group.type === 'transport-time' ? 'route' : undefined
  if (!expectedKind) return []

  const seenIds = new Set<string>()
  return group.claims.flatMap((claim) => {
    if (!claim.sourceId || seenIds.has(claim.sourceId)) return []
    seenIds.add(claim.sourceId)
    const source = sources.find((item) => item.id === claim.sourceId)
    return source?.kind === expectedKind ? [source] : []
  })
}

/** 在行程本身标出动态来源复核提醒，避免用户只看方案时错过。 */
function SourceFreshnessStatus({ source, onShowSource }: {
  source: SourceRecord
  onShowSource: (source: SourceRecord) => void
}) {
  const notice = sourceFreshnessNotice(source)
  if (!notice) return null
  return <small className="evidence-freshness" role="status">
    <span>{notice.label}：{notice.detail}</span>
    <button className="text-button" onClick={() => onShowSource(source)}>去来源面板重新查询</button>
  </small>
}

/** 汇总会阻止方案确认的时间重叠与已查出的路线时长冲突。 */
function blockingScheduleFindings(itinerary: ItineraryOption, anchors: TripBrief) {
  const scheduleFindings = itinerary.days.flatMap((day) => analyzeDaySchedule(day, anchors)
    .filter((finding) => ['stop-overlap', 'schedule-overlap', 'route-buffer'].includes(finding.code))
    .map((finding) => ({ dayNumber: day.dayNumber, ...finding })))
  return [...scheduleFindings, ...analyzeMealRequirements(itinerary.days, itinerary.mealRequirements)]
}

/** 展示可计算的日程冲突；存在冲突时提示先修改再确认。 */
export function ScheduleFeasibility({ itinerary, anchors, sources, onContinueRevision }: {
  itinerary: ItineraryOption
  anchors: TripBrief
  sources: SourceRecord[]
  onContinueRevision?: (suggestion: string) => void
}) {
  const availableSourceIds = new Set(sources.filter((source) => source.status === 'success').map((source) => source.id))
  const blockingFindings = blockingScheduleFindings(itinerary, anchors)
  const hasMealBlockers = blockingFindings.some((finding) => finding.code === 'meal-requirement')
  const hasTimeBlockers = blockingFindings.some((finding) => finding.code !== 'meal-requirement')
  const scheduleFindings = itinerary.days.flatMap((day) => analyzeDaySchedule(day, anchors, availableSourceIds).map((finding) => ({
    dayNumber: day.dayNumber,
    key: `${finding.code}-${finding.itemIds.join('-')}`,
    message: finding.message,
    revisionActionLabel: finding.code === 'route-buffer' ? '调整这段通勤' : '调整冲突时段',
    revisionSuggestion: scheduleFindingRevisionSuggestion(day, finding, sources)
  })))
  const mealFindings = analyzeMealRequirements(itinerary.days, itinerary.mealRequirements).map((finding) => ({
    dayNumber: finding.dayNumber,
    key: `${finding.code}-${finding.date}`,
    message: finding.message,
    revisionActionLabel: undefined,
    revisionSuggestion: undefined
  }))
  const lodgingFindings = anchors.lodgingLocation.trim() ? itinerary.days.flatMap((day) => {
    if (!day.stops.length) return []
    const commutes = day.lodgingCommutes ?? []
    const invalidDirections = commutes.filter((commute) =>
      !lodgingCommuteHasValidSource(day, commute, anchors.lodgingLocation, sources)
    ).map((commute) => commute.direction === 'from-lodging' ? '住宿→首站' : '末站→住宿')
    const missingDirections = (['from-lodging', 'to-lodging'] as const).filter((direction) =>
      !commutes.some((commute) => commute.direction === direction)
    ).map((direction) => direction === 'from-lodging' ? '住宿→首站' : '末站→住宿')
    if (!invalidDirections.length && !missingDirections.length) return []
    const details = [
      invalidDirections.length ? `已有路线需复核：${[...new Set(invalidDirections)].join('、')}` : '',
      missingDirections.length ? `未附估算：${missingDirections.join('、')}` : ''
    ].filter(Boolean).join('；')
    return [{ dayNumber: day.dayNumber, key: `lodging-${day.id}`, message: `具体住宿已填写，${details}。如会影响当天安排，请按需查询路线。`, revisionActionLabel: undefined, revisionSuggestion: undefined }]
  }) : []
  const findings = [...scheduleFindings, ...mealFindings, ...lodgingFindings]
  const hasExactTime = itinerary.days.some((day) =>
    day.stops.some((stop) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(stop.time.trim())) ||
    day.scheduleBlocks.some((block) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(block.time.trim())))
  const hasUnspecifiedTime = itinerary.days.some((day) =>
    [...day.stops.map((stop) => stop.time), ...day.scheduleBlocks.map((block) => block.time)]
      .some((time) => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time.trim())))
  const hasMatchingAnchor = itinerary.days.some((day) => day.date && (
    (day.date === anchors.startDate && anchors.arrivalTime) || (day.date === anchors.endDate && anchors.leaveTime)
  ))
  if (!findings.length && !hasExactTime && !hasMatchingAnchor) return null
  const summary = findings.length
    ? `时间核对 · ${findings.length} 项需核对`
    : hasUnspecifiedTime ? '时间核对 · 部分时段待补' : '时间核对 · 未发现已知冲突'
  return <details className={`schedule-feasibility${blockingFindings.length ? ' is-blocking' : ''}`}
    aria-label="行程时间核对" open={blockingFindings.length > 0}>
    <summary className="schedule-feasibility-summary">
      <strong>{summary}</strong>
      <span>{blockingFindings.length ? '先处理再保存' : findings.length || hasUnspecifiedTime ? '查看详情' : '查看范围'}</span>
    </summary>
    <div className="schedule-feasibility-detail">
      {findings.length
        ? <ul>{findings.map(({ dayNumber, message, key, revisionActionLabel, revisionSuggestion }, index) => <li key={`${key}-${index}`}>
          <span>第 {dayNumber} 天</span><p>{message}</p>
          {onContinueRevision && revisionSuggestion && <button type="button" className="text-button schedule-revision-action"
            onClick={() => onContinueRevision(revisionSuggestion)}>{revisionActionLabel}</button>}
        </li>)}</ul>
        : <p className="schedule-feasibility-empty">{hasUnspecifiedTime
          ? '部分时段待补 · 未发现已知冲突'
          : '未发现已知冲突 · 开放、预约和交通仍需复核'}</p>}
      {blockingFindings.length > 0 && <p className="schedule-feasibility-blocker" role="alert">
        {hasMealBlockers && hasTimeBlockers
          ? '先修正以上时间冲突并调整餐次要求，才能确认并保存这份方案。'
          : hasMealBlockers
            ? '先调整以上餐次安排，才能确认并保存这份方案。'
            : '先修正以上时间冲突，才能确认并保存这份方案。'}
      </p>}
      <details className="schedule-feasibility-scope">
        <summary>核对范围</summary>
        <p>{hasUnspecifiedTime && '部分地点或时段没有具体时刻，无法完整核对。'}这里只检查当前来源里明确写出的开放时段和闭馆信息。节假日变化、预约、排队、未查询路线和机场接驳仍需另行核对。</p>
      </details>
    </div>
  </details>
}

/** 为路线或日程重叠生成带目标日期和对象的修改请求，不自动更改计划。 */
export function scheduleFindingRevisionSuggestion(
  day: ItineraryDay,
  finding: ScheduleFinding,
  sources: SourceRecord[] = []
): string | undefined {
  if (finding.code !== 'route-buffer' && finding.code !== 'stop-overlap' && finding.code !== 'schedule-overlap') return undefined
  const scope = day.date ? `${day.date}（第 ${day.dayNumber} 天）` : `第 ${day.dayNumber} 天`
  const firstId = finding.itemIds[0]
  const secondId = finding.itemIds[1]
  const firstStop = day.stops.find((stop) => stop.id === firstId)
  const secondStop = day.stops.find((stop) => stop.id === secondId)

  if (finding.code === 'route-buffer') {
    if (!firstStop || !secondStop) return undefined
    const estimate = firstStop.transitEstimate?.destinationStopId === secondStop.id
      ? firstStop.transitEstimate
      : undefined
    const source = estimate && sources.find((item) => item.id === estimate.sourceId && item.status === 'success')
    const modeLabel = estimate?.mode === 'walking' ? '步行' : estimate?.mode === 'driving' ? '驾车' : '公共交通'
    const routeLabel = estimate?.durationMinutes
      ? `${source?.provider ?? '路线服务'}${modeLabel}估算约 ${estimate.durationMinutes} 分钟，另留 ${routePlanningBufferMinutes(estimate.mode)} 分钟机动余量`
      : '当前路线查询显示通勤时间不足'
    return `只调整${scope}从“${firstStop.name}”到“${secondStop.name}”的通勤和受影响时段。${routeLabel}；请按估时加机动余量安排，并调整未固定活动。保留两处地点、其他日期、固定预约和抵离时刻；不要缩短成功来源中的路线耗时来消除冲突。`
  }

  const itemLabel = (id: string | undefined): string | undefined => {
    if (!id) return undefined
    const stop = day.stops.find((item) => item.id === id)
    if (stop) return stop.name
    return day.scheduleBlocks.find((item) => item.id === id)?.title
  }
  const itemNames = [itemLabel(firstId), itemLabel(secondId)].filter((name): name is string => !!name)
  if (itemNames.length !== 2) return undefined
  return `只修正${scope}“${itemNames[0]}”和“${itemNames[1]}”的时间重叠，保留地点、其他日期、固定预约和抵离时刻；调整未固定项目的时段后重新检查当天安排。`
}

/** 展示已采纳路线中服务明确返回的费用，不把小计说成全程预算。 */
export function ItineraryTransportCostSummary({ itinerary }: { itinerary: ItineraryOption }) {
  const summary = summarizeItineraryTransportCosts(itinerary)
  const routeCount = summary.publicTransportLegCount + summary.drivingLegCount
  return <section className="itinerary-cost-summary" aria-label="路线费用估算">
    <header><strong>路线费用估算</strong><span>仅统计已采纳路线中的服务返回金额</span></header>
    {routeCount === 0
      ? <p>尚无已采纳的路线费用估算。</p>
      : <div className="itinerary-cost-rows">
        {summary.publicTransportLegCount > 0 && <div>
          <strong>公共交通票价小计</strong>
          <span>{summary.knownPublicTransportFareCount
            ? `${summary.knownPublicTransportFareCount < summary.publicTransportLegCount ? '已知小计' : '合计'} ${formatYuanFen(summary.publicTransportFareFen)}`
            : '未返回金额'}</span>
          <small>{summary.knownPublicTransportFareCount}/{summary.publicTransportLegCount} 段已返回金额；未知段未计入</small>
        </div>}
        {summary.drivingLegCount > 0 && <div>
          <strong>驾车道路收费小计</strong>
          <span>{summary.knownDrivingTollCount
            ? `${summary.knownDrivingTollCount < summary.drivingLegCount ? '已知小计' : '合计'} ${formatYuanFen(summary.drivingTollFen)}`
            : '未返回金额'}</span>
          <small>{summary.knownDrivingTollCount}/{summary.drivingLegCount} 段已返回金额；未知段未计入</small>
        </div>}
      </div>}
    <small>金额未乘出行人数；不含住宿、门票、餐饮、航班和打车费用，也不含未查询路线。驾车仅展示道路收费，不是完整驾车成本。</small>
  </section>
}

/** 展示逐类费用范围、数量、来源状态和可解释的预算上限比较。 */
export function ItineraryBudgetEstimateCard({ estimate, sources, budget, travelers, onShowSource, compact = false }: {
  estimate: ItineraryBudgetEstimate
  sources: SourceRecord[]
  budget?: string
  travelers?: string
  onShowSource: (source: SourceRecord) => void
  compact?: boolean
}) {
  const summary = summarizeBudgetEstimate(estimate, sources)
  const comparison = budget?.trim()
    ? compareBudgetPreference(estimate, sources, budget, travelers ?? '')
    : null
  const sourceById = new Map(sources.map((source) => [source.id, source]))
  const unresolved = [...new Set([...summary.pendingCategories, ...summary.missingCategories])]
  return <section className={`itinerary-budget-card${compact ? ' is-compact' : ''}`} aria-label="预算估算">
    {!compact && <header><strong>预算估算</strong><span>人民币 · 单价范围 × 数量</span></header>}
    <ul className="itinerary-budget-items">{estimate.items.map((item) => {
      const amountText = item.evidenceLevel === 'pending' || item.amountMinFen === null || item.amountMaxFen === null
        ? '待核验'
        : `${formatBudgetRange(item.amountMinFen, item.amountMaxFen)}/${item.unitLabel} × ${item.quantity} = ${formatBudgetRange(item.amountMinFen * item.quantity, item.amountMaxFen * item.quantity)}`
      const evidenceLabel = item.evidenceLevel === 'sourced' ? '有来源' : item.evidenceLevel === 'estimated' ? '规划估算' : '待核验'
      return <li key={item.id}>
        <div className="itinerary-budget-item-heading"><strong>{BUDGET_CATEGORY_LABELS[item.category]} · {item.title}</strong><span>{amountText}</span></div>
        <p>{evidenceLabel} · {item.basis}</p>
        {item.sourceIds.length > 0 && <div className="itinerary-budget-sources">{item.sourceIds.map((id) => {
          const source = sourceById.get(id)
          return source
            ? <button type="button" className="text-button" key={id} onClick={() => onShowSource(source)}>{source.title || source.provider}{source.status === 'success' ? '' : ' · 需复核'}</button>
            : <span key={id}>预算来源缺失，需复核</span>
        })}</div>}
      </li>
    })}</ul>
    {estimate.notApplicableCategories.length > 0 && <ul className="itinerary-budget-exclusions" aria-label="不适用费用类别">
      {estimate.notApplicableCategories.map((item) => <li key={item.category}>{BUDGET_CATEGORY_LABELS[item.category]}：不适用（{item.reason}）</li>)}
    </ul>}
    {summary.pricedItemCount > 0
      ? <div className="itinerary-budget-total"><strong>{summary.complete ? '费用估算总额' : '已计入项目小计'}</strong><span>{formatBudgetRange(summary.totalMinFen, summary.totalMaxFen)}</span></div>
      : <p className="itinerary-budget-total">尚无可计算的费用金额。</p>}
    {unresolved.length > 0 && <small>未计入完整总额：{unresolved.map((category: BudgetCostCategory) => BUDGET_CATEGORY_LABELS[category]).join('、')}。未知费用没有按零元计算。</small>}
    {summary.sourceReviewItemCount > 0 && <small>有 {summary.sourceReviewItemCount} 项费用来源缺失或当前不可用，请复核。</small>}
    {comparison && <p className={`itinerary-budget-comparison budget-comparison-${comparison.kind}`}>
      <strong>预算比较</strong><span>{comparison.message}</span>
    </p>}
    <small>“有来源”只表示关联了当前成功来源；仍需打开来源核对金额、人数和适用日期。</small>
    <small>金额为规划范围，不是报价或支付记录；是否符合预算偏好需结合未计入项目一起判断。</small>
  </section>
}

/** 将可选的逐项预算详情收起，只在计划卡上保留范围与缺项提示。 */
function PlanBudgetDisclosure({ estimate, sources, budget, travelers, onShowSource }: {
  estimate: ItineraryBudgetEstimate
  sources: SourceRecord[]
  budget?: string
  travelers?: string
  onShowSource: (source: SourceRecord) => void
}) {
  const summary = summarizeBudgetEstimate(estimate, sources)
  const amountLabel = summary.pricedItemCount
    ? `${summary.complete ? '估算' : '已估小计'} ${formatBudgetRange(summary.totalMinFen, summary.totalMaxFen)}`
    : '金额待核验'
  const pendingCount = summary.pendingItemCount + summary.missingCategories.length + summary.sourceReviewItemCount
  const completenessLabel = summary.complete ? '类别齐全' : `${pendingCount} 项待补或复核`

  return <details className="plan-budget-disclosure">
    <summary><strong>预算估算</strong><span>{amountLabel} · {completenessLabel}</span></summary>
    <ItineraryBudgetEstimateCard estimate={estimate} sources={sources} budget={budget} travelers={travelers}
      onShowSource={onShowSource} compact />
  </details>
}

/** 按整数分显示人民币，避免浮点数格式化误差。 */
function formatYuanFen(fen: number): string {
  return `¥${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, '0')}`
}

/** 并排显示可由结构化候选直接计算的差异，不用模型分数替用户排序。 */
export function PlanComparison({ options, brief, sources = [] }: {
  options: ItineraryOption[]
  brief: TripBrief
  sources: SourceRecord[]
}) {
  if (options.length < 2) return null
  const metrics = comparePlanOptions(options, brief.interests)
  const sourceCoverage = options.map((option) => summarizePlanSourceCoverage(option, sources))
  const rows: Array<{ label: string; value: (index: number) => string }> = [
    { label: '行程规模', value: (index) => `${metrics[index].dayCount} 天 · ${metrics[index].stopCount} 个地点` },
    { label: '用餐、休息与机动', value: (index) => {
      const item = metrics[index]
      return item.scheduleBlockCount
        ? `${item.scheduleBlockCount} 个时段 · ${item.scheduledBreakMinutes ? `已填时长合计 ${formatPlanDwell(item.scheduledBreakMinutes)}` : '时长待核验'} · ${item.scheduleBlockKinds.map(scheduleBlockKindLabel).join('、')}`
        : '未单独安排时段'
    } },
    { label: '每日节奏', value: (index) => {
      const item = metrics[index]
      const dwell = item.knownDwellMinutes ? formatPlanDwell(item.knownDwellMinutes) : '停留时间未提供'
      return `${item.averageStopsPerDay.toFixed(1)} 站/天 · ${dwell}${item.stopsWithoutDwell ? ` · ${item.stopsWithoutDwell} 站待估` : ''}`
    } },
    { label: '区域 / 类型', value: (index) => {
      const item = metrics[index]
      return `${item.areas.join('、') || '区域待补充'} / ${item.categories.join('、') || '类型待补充'}`
    } },
    { label: '兴趣匹配（含常见别名）', value: (index) => {
      const item = metrics[index]
      if (!brief.interests.trim()) return '未填写兴趣偏好'
      const total = item.matchedInterests.length + item.unmatchedInterests.length
      const matched = item.interestMatchEvidence.map((evidence) => evidence.method === 'curated-alias'
        ? `${evidence.interest}（匹配到${evidence.matchedTerms.join('、')}）`
        : evidence.interest)
      return `${item.matchedInterests.length}/${total} 项匹配${matched.length ? `：${matched.join('、')}` : ''}${item.unmatchedInterests.length ? ` · 未命中：${item.unmatchedInterests.join('、')}` : ''}`
    } },
    { label: '地点来源状态', value: (index) => {
      const item = sourceCoverage[index]
      return `${item.referencedStops}/${item.stopCount} 个地点有来源引用 · ${item.successfulStops} 个至少有一条成功来源 · ${item.unlinkedStops} 个未关联 · ${item.reviewStops} 个关联来源均需复核`
    } },
    { label: '与其他方案共有地点', value: (index) => metrics[index].sharedStopNames.join('、') || '没有重复地点名称' },
    { label: '票价依据', value: (index) => `${metrics[index].sourcedTicketFacts} 条有来源事实` },
    { label: '预算估算', value: (index) => {
      const estimate = options[index].budgetEstimate
      if (!estimate) return '未提供预算估算'
      const summary = summarizeBudgetEstimate(estimate, sources)
      const amount = summary.pricedItemCount > 0
        ? `${summary.complete ? '估算总额' : '已计入项目小计'} ${formatBudgetRange(summary.totalMinFen, summary.totalMaxFen)}`
        : '尚无可计算金额'
      const pending = [...new Set([...summary.pendingCategories, ...summary.missingCategories])]
      const comparison = brief.budget.trim()
        ? compareBudgetPreference(estimate, sources, brief.budget, brief.travelers)
        : null
      return `${amount}${pending.length ? ` · 未计：${pending.map((category) => BUDGET_CATEGORY_LABELS[category]).join('、')}` : ''}${summary.sourceReviewItemCount ? ` · ${summary.sourceReviewItemCount} 项来源需复核` : ''}${comparison ? ` · ${comparison.message}` : ''}`
    } },
    { label: '通勤依据', value: (index) => {
      const item = metrics[index]
      const route = item.routeEstimateCount
        ? `${item.routeEstimateCount} 段已查询 · ${item.routeEstimateDurationCount} 段有估时 · 已知估时合计 ${item.routeEstimateDurationCount ? formatPlanDwell(item.routeEstimateMinutes) : '未提供'}`
        : '未主动估算路线'
      return `${route} · ${item.sourcedTransportFacts} 条来源交通事实`
    } },
    { label: '路线步行段', value: (index) => {
      const distance = metrics[index].walkingDistanceMeters
      return distance === null ? '没有已查询路线的步行数据' : `已查询路线含 ${formatPlanDistance(distance)} 步行段`
    } }
  ]

  return <section className="plan-comparison" aria-label="候选方案结构化对照">
    <header><div><strong>方案对照</strong><span>按当前行程与来源资料统计</span></div><small>预算偏好：{brief.budget.trim() || '未填写'}</small></header>
    <div className="plan-comparison-scroll"><table>
      <thead><tr><th scope="col">对照项</th>{options.map((option) => <th scope="col" key={option.id}>{option.title}</th>)}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row.label}><th scope="row">{row.label}</th>{options.map((option, index) => <td key={option.id}>{row.value(index)}</td>)}</tr>)}</tbody>
    </table></div>
    <p>费用估算由结构化金额范围和数量计算；待核验或未覆盖类别不会按零计入。来源成功返回不等于事实已核验；失败或缺失来源不会算作成功。地点重合按名称直接匹配，未合并别名；步行总量不计算。兴趣只按地点文字直接匹配，不推断同义词；未查询路线不代表路线相同。</p>
  </section>
}

/** 将来源是否关联与来源当前运行状态分别统计，不把失败记录当成成功依据。 */
function summarizePlanSourceCoverage(option: ItineraryOption, sources: SourceRecord[]) {
  const sourceById = new Map(sources.map((source) => [source.id, source]))
  const stops = option.days.flatMap((day) => day.stops)
  const referencedStops = stops.filter((stop) => (stop.sourceIds ?? []).length > 0)
  const successfulStops = stops.filter((stop) =>
    (stop.sourceIds ?? []).some((sourceId) => sourceById.get(sourceId)?.status === 'success'))
  const unlinkedStops = stops.length - referencedStops.length
  return {
    stopCount: stops.length,
    referencedStops: referencedStops.length,
    successfulStops: successfulStops.length,
    unlinkedStops,
    reviewStops: referencedStops.length - successfulStops.length
  }
}

/** 将分钟数显示为易比较的小时和分钟。 */
function formatPlanDwell(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分` : ''].filter(Boolean).join('') || '0 分'
}

/** 格式化可见路线返回的步行距离；不把它当作整日步数。 */
function formatPlanDistance(meters: number): string {
  return meters >= 1_000 ? `${(meters / 1_000).toFixed(1)} 公里` : `${Math.round(meters)} 米`
}

/** 餐馆是行程地点，和只占用时间的用餐块分别显示与修改。 */
function isMealStop(stop: ItineraryStop): boolean {
  return /餐|美食|小吃/u.test(stop.category) || /^(早餐|午餐|晚餐)[·：:]/u.test(stop.name)
}

/** 在候选方案中按精确时刻穿插非地点时段，并为宽泛时段保留原文。 */
export function PlanDaySchedulePreview({ day, lodgingLocation, sources, onOpen, onShowSource, onContinueRevision }: {
  day: ItineraryDay
  lodgingLocation: string
  sources: SourceRecord[]
  onOpen: (url: string) => void
  onShowSource: (source: SourceRecord) => void
  onContinueRevision?: (suggestion: string) => void
}) {
  const [draggedStopId, setDraggedStopId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ stopId: string; placement: StopDropPlacement } | null>(null)
  const weatherSource = day.weather?.sourceId
    ? sources.find((source) => source.id === day.weather?.sourceId)
    : undefined
  const entries = orderItineraryDaySchedule(day)
  return <div className="plan-option-stop-list" role="group" aria-label={`第 ${day.dayNumber} 天日程顺序`}>
    {day.weather && <div className="plan-option-day-weather" role="group" aria-label={`第 ${day.dayNumber} 天天气状态`}>
      <strong>{day.weather.status === 'forecast' ? '天气预报' : '天气未知'}</strong>
      <span>{day.weather.summary}</span>
      {weatherSource
        ? <>
          <button className="text-button" onClick={() => weatherSource.url ? onOpen(weatherSource.url) : onShowSource(weatherSource)}
            title={`${weatherSource.title || weatherSource.provider} · ${sourceTimestampLabel(weatherSource)}`}>
            <FileText size={11} /> {weatherSource.title || weatherSource.provider} · {sourceTimestampLabel(weatherSource)}
          </button>
          {weatherSource.status !== 'success' && <small className="evidence-pending">天气来源{statusLabel(weatherSource.status)}，请复核。</small>}
          <SourceFreshnessStatus source={weatherSource} onShowSource={onShowSource} />
        </>
        : <small>没有覆盖这一天的天气来源</small>}
    </div>}
    {day.lodgingCommutes?.filter((commute) => commute.direction === 'from-lodging').map((commute) =>
      <LodgingCommuteTimelineCard key={`${commute.direction}-${commute.sourceId}`} commute={commute} day={day} lodgingLocation={lodgingLocation} sources={sources} onOpen={onOpen} onShowSource={onShowSource} onContinueRevision={onContinueRevision} />
    )}
    {entries.map((entry, entryIndex) => entry.kind === 'stop'
      ? <div key={entry.stop.id}
        className={`plan-option-stop${draggedStopId === entry.stop.id ? ' is-dragging' : ''}${dropTarget?.stopId === entry.stop.id ? ` drop-${dropTarget.placement}` : ''}`}
        onDragOver={onContinueRevision && draggedStopId && !entry.stop.locked && entry.stop.id !== draggedStopId
          ? (event) => {
            event.preventDefault()
            const bounds = event.currentTarget.getBoundingClientRect()
            const placement = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
            setDropTarget({ stopId: entry.stop.id, placement })
            event.dataTransfer.dropEffect = 'move'
          }
          : undefined}
        onDrop={onContinueRevision ? (event) => {
          event.preventDefault()
          const fromStopId = event.dataTransfer.getData('text/plain') || draggedStopId
          const bounds = event.currentTarget.getBoundingClientRect()
          const placement = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
          if (fromStopId) {
            const suggestion = stopOrderRevisionSuggestion(day, fromStopId, entry.stop.id, placement)
            if (suggestion) onContinueRevision(suggestion)
          }
          setDraggedStopId(null)
          setDropTarget(null)
        } : undefined}
      >
        <div className="plan-option-stop-heading">
          <span className={`plan-option-stop-time${entry.stop.time.trim() ? '' : ' is-pending'}`}>
            {plannedStopTimeLabel(entry.stop.time, entry.stop.durationMinutes) || '时段待补'}
          </span>
          <div className="plan-option-stop-title-row">
            <span className="plan-option-stop-title">{entry.stop.name}{entry.stop.locked ? '（固定）' : ''}</span>
            {onContinueRevision && !entry.stop.locked && <span className="plan-stop-drag-handle"
              draggable
              aria-hidden="true"
              title="拖到另一地点上方或下方，调整当天顺序"
              onDragStart={(event) => {
                event.stopPropagation()
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', entry.stop.id)
                setDraggedStopId(entry.stop.id)
              }}
              onDragEnd={() => {
                setDraggedStopId(null)
                setDropTarget(null)
              }}>
              <GripVertical size={14} aria-hidden="true" />
            </span>}
          </div>
          {(entry.stop.category || entry.stop.area) && <small className="plan-option-stop-area">
            {[entry.stop.category, entry.stop.area].filter(Boolean).join(' · ')}
          </small>}
        </div>
        <div className="plan-option-stop-meta">
          {showPlanStopEvidenceStatus(entry.stop) && <span className={`plan-stop-evidence evidence-${entry.stop.evidenceLevel ?? 'pending'}`}>
            {itineraryEvidenceLabel(entry.stop.evidenceLevel ?? 'pending')}
          </span>}
          {planStopContextCount(entry.stop) > 0 && <details className="plan-stop-context">
            <summary>详情</summary>
            <div className="plan-stop-context-body">
              {entry.stop.transitToNext && <p className="plan-option-stop-note"><strong>接驳</strong>{entry.stop.transitToNext}</p>}
              {entry.stop.notes && <p className="plan-option-stop-note">{entry.stop.notes}</p>}
              <ItineraryEvidenceLinks stop={entry.stop} sources={sources} onOpen={onOpen} onShowSource={onShowSource}
                showEvidenceLevel={!showPlanStopEvidenceStatus(entry.stop)} />
            </div>
          </details>}
          {onContinueRevision && <details className="plan-stop-edit-menu" aria-label={`修改地点：${entry.stop.name}`}>
            <summary className="plan-stop-edit-trigger"><PencilLine size={13} aria-hidden="true" /> 修改</summary>
            <div className="plan-stop-edit-panel" onClick={(event) => {
              // 选择操作后收起菜单，让用户回到已预填修改意见的输入框。
              if (event.target instanceof HTMLButtonElement) event.currentTarget.closest('details')?.removeAttribute('open')
            }}>
              {!entry.stop.locked && <>
                <section className="plan-stop-edit-group">
                  <strong>常用修改</strong>
                  <div className="plan-local-edit-actions">
                    <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'time'))}>改时段</button>
                    <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'duration'))}>改停留时长</button>
                    <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, isMealStop(entry.stop) ? 'restaurant' : 'replace'))}>{isMealStop(entry.stop) ? '换餐馆' : '换地点'}</button>
                    {entries.slice(entryIndex + 1).some((next) => next.kind === 'stop') &&
                      <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'transit'))}>改接驳</button>}
                    <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'remove'))}>移除此项</button>
                  </div>
                </section>
                <details className="plan-stop-advanced-edit">
                  <summary>更多字段与操作</summary>
                  <section className="plan-stop-edit-group">
                    <strong>地点信息</strong>
                    <div className="plan-local-edit-actions">
                      <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'rename'))}>改名称</button>
                      <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'area'))}>改片区</button>
                      <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'notes'))}>改说明</button>
                      <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'booking'))}>核对预约与门票</button>
                      {entry.stop.conditionalAlternatives?.length ? <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'alternative'))}>改备选地点</button> : null}
                    </div>
                  </section>
                  <section className="plan-stop-edit-group">
                    <strong>插入与移动</strong>
                    <div className="plan-local-edit-actions">
                      <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'add-before'))}>在前面加地点</button>
                      <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'add-after'))}>在后面加地点</button>
                      <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'move'))}>调整位置</button>
                      <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'move-day'))}>移到另一天</button>
                    </div>
                  </section>
                </details>
              </>}
              {entry.stop.locked && <p className="plan-stop-edit-locked">固定地点不能直接更名、删除或调整时段。</p>}
              {entry.stop.locked && <section className="plan-stop-edit-group">
                <strong>相邻安排</strong>
                <div className="plan-local-edit-actions">
                  <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'booking'))}>核对预约与门票</button>
                  <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'add-after'))}>在后面加地点</button>
                  {entries.slice(entryIndex + 1).some((next) => next.kind === 'stop') &&
                    <button type="button" onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'transit'))}>改接驳</button>}
                </div>
              </section>}
            </div>
          </details>}
        </div>
        {entry.stop.transitToNext && (() => {
          const nextEntry = entries.slice(entryIndex + 1).find((next) => next.kind === 'stop')
          const nextStop = nextEntry?.kind === 'stop' ? nextEntry.stop : undefined
          const estimate = nextStop && entry.stop.transitEstimate?.destinationStopId === nextStop.id
            ? entry.stop.transitEstimate : undefined
          return <div className="plan-option-transit">
            <Route size={12} aria-hidden="true" />
            <span>
              <strong>{nextStop?.name ?? '下一地点'}</strong>
              <small>{planTransitSummary(entry.stop, estimate)}</small>
            </span>
            {onContinueRevision && nextStop && <button type="button" className="text-button"
              onClick={() => onContinueRevision(stopRevisionSuggestion(day, entry.stop, 'transit'))}>改这段</button>}
          </div>
        })()}
      </div>
      : <div key={entry.block.id} className="plan-option-schedule-item">
        <span className={`plan-option-schedule-time${entry.block.time.trim() ? '' : ' is-pending'}`}>
          {entry.block.time || '时段待补'}
        </span>
        <div className="plan-option-schedule-copy">
          <strong>{scheduleBlockKindLabel(entry.block.kind)} · {entry.block.title}</strong>
          <small>{[entry.block.durationMinutes ? `时长 ${entry.block.durationMinutes} 分钟` : '时长待核验', entry.block.area].filter(Boolean).join(' · ')}</small>
          {/* 备注默认收起，时间线先呈现时间、时长和片区。 */}
          {entry.block.notes && <details className="plan-schedule-notes">
            <summary>安排说明</summary>
            <p>{entry.block.notes}</p>
          </details>}
        </div>
        {onContinueRevision && <details className="plan-block-edit-menu" aria-label={`修改时段：${entry.block.title}`}>
          <summary>修改时段</summary>
          <div className="plan-stop-edit-panel" onClick={(event) => {
            // 选择细项后收起菜单，继续在聊天框中补充内容。
            if (event.target instanceof HTMLButtonElement) event.currentTarget.closest('details')?.removeAttribute('open')
          }}>
            <section className="plan-stop-edit-group">
              <strong>常用修改</strong>
              <div className="plan-local-edit-actions">
                <button type="button" onClick={() => onContinueRevision(scheduleBlockRevisionSuggestion(day, entry.block, 'time'))}>改时间</button>
                <button type="button" onClick={() => onContinueRevision(scheduleBlockRevisionSuggestion(day, entry.block, 'duration'))}>改时长</button>
                <button type="button" onClick={() => onContinueRevision(scheduleBlockRevisionSuggestion(day, entry.block, 'kind'))}>改类型</button>
                {entry.block.kind === 'meal' && <button type="button" onClick={() => onContinueRevision(scheduleBlockRevisionSuggestion(day, entry.block, 'restaurant'))}>选具体餐馆</button>}
              </div>
            </section>
            <details className="plan-stop-advanced-edit">
              <summary>更多字段与操作</summary>
              <section className="plan-stop-edit-group">
                <strong>时段信息</strong>
                <div className="plan-local-edit-actions">
                  <button type="button" onClick={() => onContinueRevision(scheduleBlockRevisionSuggestion(day, entry.block, 'title'))}>改标题</button>
                  <button type="button" onClick={() => onContinueRevision(scheduleBlockRevisionSuggestion(day, entry.block, 'area'))}>改片区</button>
                  <button type="button" onClick={() => onContinueRevision(scheduleBlockRevisionSuggestion(day, entry.block, 'notes'))}>改说明</button>
                </div>
              </section>
              <section className="plan-stop-edit-group">
                <strong>插入与移除</strong>
                <div className="plan-local-edit-actions">
                  <button type="button" onClick={() => onContinueRevision(scheduleBlockRevisionSuggestion(day, entry.block, 'add-before'))}>前面加时段</button>
                  <button type="button" onClick={() => onContinueRevision(scheduleBlockRevisionSuggestion(day, entry.block, 'add-after'))}>后面加时段</button>
                  <button type="button" onClick={() => onContinueRevision(scheduleBlockRevisionSuggestion(day, entry.block, 'remove'))}>移除此时段</button>
                </div>
              </section>
            </details>
          </div>
        </details>}
      </div>)}
    {day.lodgingCommutes?.filter((commute) => commute.direction === 'to-lodging').map((commute) =>
      <LodgingCommuteTimelineCard key={`${commute.direction}-${commute.sourceId}`} commute={commute} day={day} lodgingLocation={lodgingLocation} sources={sources} onOpen={onOpen} onShowSource={onShowSource} onContinueRevision={onContinueRevision} />
    )}
  </div>
}

/** 将每日计划折叠为摘要行，减少长行程首屏长度并保留逐日展开审阅。 */
export function PlanDayDisclosure({ day, index, lodgingLocation, sources, onOpen, onShowSource, onContinueRevision, openByDefault = index === 0 }: {
  day: ItineraryDay
  index: number
  lodgingLocation: string
  sources: SourceRecord[]
  onOpen: (url: string) => void
  onShowSource: (source: SourceRecord) => void
  onContinueRevision?: (suggestion?: string) => void
  openByDefault?: boolean
}) {
  const mealCount = day.stops.filter(isMealStop).length + day.scheduleBlocks.filter((block) => block.kind === 'meal').length
  const placeCount = day.stops.filter((stop) => !isMealStop(stop)).length
  const placeSummary = placeCount ? `${placeCount} 个地点` : day.stops.length ? '无游览地点' : '地点待补'
  const summary = [placeSummary, mealCount ? `${mealCount} 餐` : ''].join(' · ')
  const stopsInOrder = orderedDayStops(day)
  const routePreview = stopsInOrder.length
    ? [...stopsInOrder.slice(0, 3).map((stop) => stop.name), ...(stopsInOrder.length > 3 ? [`+${stopsInOrder.length - 3}`] : [])].join(' → ')
    : '地点待补'
  return <div className="plan-day-disclosure-wrap">
    <details className="plan-day-disclosure" open={openByDefault}>
      <summary className="plan-day-disclosure-summary">
        <span className="plan-day-summary-copy">
          <strong>第 {day.dayNumber} 天{day.date ? ` · ${day.date}` : ''} · {day.title}</strong>
          <small className="plan-day-route-preview">{routePreview}</small>
        </span>
        <span className="plan-day-summary-count">{summary}</span>
      </summary>
      <div className="plan-day-disclosure-content">
        <PlanDaySchedulePreview day={day} lodgingLocation={lodgingLocation} sources={sources} onOpen={onOpen} onShowSource={onShowSource}
          onContinueRevision={onContinueRevision} />
      </div>
    </details>
    {onContinueRevision && <details className="plan-day-edit-menu">
      <summary>修改当天</summary>
      <div className="plan-local-edit-actions" aria-label={`修改第 ${day.dayNumber} 天`}>
        <button type="button" onClick={() => onContinueRevision(dayRevisionSuggestion(day, 'date'))}>改日期</button>
        <button type="button" onClick={() => onContinueRevision(dayRevisionSuggestion(day, 'theme'))}>改主题</button>
        <button type="button" onClick={() => onContinueRevision(dayRevisionSuggestion(day, 'pace'))}>调整节奏</button>
        <button type="button" onClick={() => onContinueRevision(dayRevisionSuggestion(day, 'add-stop'))}>增加地点</button>
        <button type="button" onClick={() => onContinueRevision(dayRevisionSuggestion(day, 'order'))}>调整顺序</button>
        <button type="button" onClick={() => onContinueRevision(dayRevisionSuggestion(day, 'sequence'))}>指定地点顺序</button>
        <button type="button" onClick={() => onContinueRevision(dayRevisionSuggestion(day, 'other'))}>其他修改</button>
      </div>
    </details>}
  </div>
}

/** 按界面时间线顺序提取停靠点，让摘要和局部接驳修改指向一致。 */
function orderedDayStops(day: ItineraryDay): ItineraryStop[] {
  return orderItineraryDaySchedule(day).flatMap((entry) => entry.kind === 'stop' ? [entry.stop] : [])
}

type StopDropPlacement = 'before' | 'after'

/** 把拖动顺序转换为精确的单日修改意见，交由 Agent 重排时段和交通。 */
export function stopOrderRevisionSuggestion(
  day: ItineraryDay,
  fromStopId: string,
  targetStopId: string,
  placement: StopDropPlacement
): string | undefined {
  const fromIndex = day.stops.findIndex((stop) => stop.id === fromStopId)
  const targetIndex = day.stops.findIndex((stop) => stop.id === targetStopId)
  if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) return undefined

  const fromStop = day.stops[fromIndex]
  const targetStop = day.stops[targetIndex]
  const crossesLockedStop = day.stops.slice(Math.min(fromIndex, targetIndex), Math.max(fromIndex, targetIndex) + 1)
    .some((stop) => stop.locked)
  if (fromStop.locked || targetStop.locked || crossesLockedStop) return undefined

  const scope = day.date ? `${day.date}（第 ${day.dayNumber} 天）` : `第 ${day.dayNumber} 天`
  const relation = placement === 'before' ? '之前' : '之后'
  return `只调整${scope}的地点顺序：将“${fromStop.name}”移到“${targetStop.name}”${relation}。发送后请由 Agent 重排受影响的时段和相邻交通，并展示修订差异；保留其他地点、固定安排和其他日期。若新顺序与预约或已核实路线冲突，说明冲突，不移动固定安排。`
}

/** 计算地点旁需要展开的说明数量；没有额外信息时不显示空详情入口。 */
function planStopContextCount(stop: ItineraryStop): number {
  return Number(!!stop.notes.trim()) + Number(!!stop.transitToNext.trim()) + (stop.sourceIds?.length ?? 0) +
    (stop.factClaims?.length ?? 0) + (stop.conditionalAlternatives?.length ?? 0)
}

/** 将接驳详情压缩为目的地、方式和估时状态；完整说明保留在地点详情中。 */
function planTransitSummary(stop: ItineraryStop, estimate?: ItineraryStop['transitEstimate']): string {
  const modeLabel = estimate?.mode === 'walking' ? '步行'
    : estimate?.mode === 'driving' ? '驾车'
      : estimate?.mode === 'transit' ? '公共交通' : plannedTransitModeLabel(stop.transitToNext)
  if (estimate && typeof estimate.durationMinutes === 'number') {
    return `${modeLabel} · 估算约 ${estimate.durationMinutes} 分钟 · 另留 ${routePlanningBufferMinutes(estimate.mode)} 分钟机动余量`
  }
  return `${modeLabel} · 耗时待核验`
}

/** 仅当说明明确指出单一交通方式时显示该方式；混合方式不猜具体线路。 */
function plannedTransitModeLabel(description: string): string {
  const modes = new Set<string>()
  if (/步行/u.test(description)) modes.add('步行')
  if (/公共交通|地铁|公交|巴士|机场线/u.test(description)) modes.add('公共交通')
  if (/打车|出租车|网约车|驾车|自驾/u.test(description)) modes.add('驾车')
  return modes.size === 1 ? [...modes][0]! : modes.size > 1 ? '多段接驳' : '交通方式待核验'
}

/** 待核验和估算直接可见；已有来源的状态放进详情，避免与详情入口重复。 */
function showPlanStopEvidenceStatus(stop: ItineraryStop): boolean {
  const hasLinkedEvidence = (stop.sourceIds?.length ?? 0) > 0 || (stop.factClaims?.length ?? 0) > 0
  return stop.evidenceLevel !== 'sourced' || !hasLinkedEvidence
}

/** 为日期、地点和日程块生成带范围的修改起点，未指定值留给用户补充。 */
export function dayRevisionSuggestion(day: ItineraryDay, action: 'date' | 'theme' | 'pace' | 'add-stop' | 'order' | 'sequence' | 'other' = 'other'): string {
  const scope = day.date ? `${day.date}（第 ${day.dayNumber} 天）` : `第 ${day.dayNumber} 天`
  const prefix = `只调整${scope}，其他日期和已固定安排保持不变。`
  if (action === 'date') return `${prefix}保留当天主题、地点和顺序，只把这一天改到指定日期。请重新核对目标日期的开放、预约、天气和交通时段。目标日期：`
  if (action === 'theme') return `${prefix}只修改当天主题，不更改停靠点、时段或交通。主题改为：`
  if (action === 'pace') return `${prefix}当天节奏调整为：`
  if (action === 'add-stop') return `${prefix}在合适时段加入地点：`
  if (action === 'order') return `${prefix}按地理顺序重排当天未固定的地点，保留已固定地点顺序。`
  if (action === 'sequence') return `${prefix}按下面列出的先后顺序安排地点；没有列出的地点保持原顺序：`
  return `${prefix}请说明希望怎样修改：`
}

/** 生成针对单个停靠点或相邻交通段的自然语言修改请求。 */
export function stopRevisionSuggestion(day: ItineraryDay, stop: ItineraryStop, action: 'rename' | 'time' | 'duration' | 'area' | 'replace' | 'restaurant' | 'booking' | 'alternative' | 'remove' | 'transit' | 'notes' | 'add-before' | 'add-after' | 'move' | 'move-day'): string {
  const scope = day.date || `第 ${day.dayNumber} 天`
  const place = `“${stop.name}”`
  if (action === 'rename') return `只修改${scope}${place}在行程中的名称，不替换实际地点，也不改时段和其他安排，名称改为：`
  if (action === 'time') return `只调整${scope}的${place}时段，其他停靠点与日期保持不变，时段改为：`
  if (action === 'duration') return `只调整${scope}${place}的建议停留时长，保留开始时刻、地点和其他安排，时长改为：`
  if (action === 'area') return `只调整${scope}${place}的所属片区或区域标注，不替换地点，也不改其他安排，片区改为：`
  if (action === 'replace') return `只替换${scope}的${place}，其他停靠点与日期保持不变。换成：`
  if (action === 'restaurant') return `只替换${scope}的餐馆${place}，保留餐次与原定用餐时段，其他日期不变；核对新店分店、营业与相邻接驳。换成：`
  if (action === 'booking') return `只核对${scope}${place}的预约、开放和门票信息，保留地点与固定时段；有直接依据才标已核实，其余标待核验。需要调整：`
  if (action === 'alternative') return `只调整${scope}${place}的条件备选，保留正式行程与其他日期；写清触发条件和替代地点。改为：`
  if (action === 'remove') return `只从${scope}移除${place}，保留当天其他安排和所有其他日期。`
  if (action === 'notes') return `只修改${scope}${place}的安排说明，不改地点、时段和其他日期，说明改为：`
  if (action === 'add-before') return `在${scope}${place}之前加入一个地点，其他停靠点与日期保持不变。要加入：`
  if (action === 'add-after') return `在${scope}${place}之后加入一个地点，其他停靠点与日期保持不变。要加入：`
  if (action === 'move') return `只调整${scope}${place}在行程中的位置，不新增或删除地点。请将它放在：`
  if (action === 'move-day') return `只把${scope}${place}移到指定日期；保留这个地点和其他日期的安排，只调整受影响两天的时段与相邻通勤，并重新核对预约、抵离约束和时间冲突。目标日期：`
  const stops = orderedDayStops(day)
  const stopIndex = stops.findIndex((item) => item.id === stop.id)
  const nextStop = stopIndex >= 0 ? stops[stopIndex + 1] : undefined
  return `只调整${scope}从${place}到${nextStop ? `“${nextStop.name}”` : '下一站'}的接驳，保留停靠点、时段和其他日期，交通方式改为：`
}

/** 生成针对单个用餐、休息或机动时间块的修改请求。 */
export function scheduleBlockRevisionSuggestion(
  day: ItineraryDay,
  block: ItineraryScheduleBlock,
  action: 'time' | 'duration' | 'kind' | 'title' | 'area' | 'notes' | 'restaurant' | 'remove' | 'add-before' | 'add-after' = 'time'
): string {
  const scope = day.date || `第 ${day.dayNumber} 天`
  const target = `${scope}的“${block.title}”时段`
  const preserve = '保留其他字段、当天其余安排和所有其他日期'
  if (action === 'time') return `只调整${target}的开始或结束时间，保留时长和类型，${preserve}，时间改为：`
  if (action === 'duration') return `只调整${target}的时长，保留开始时间和类型，${preserve}，时长改为：`
  if (action === 'kind') return `只调整${target}的类型，可改为用餐、休息或机动，${preserve}，类型改为：`
  if (action === 'title') return `只修改${target}的标题，不改类型、时间和时长，${preserve}，标题改为：`
  if (action === 'area') return `只修改${target}的适用片区，不改标题和时间，${preserve}，片区改为：`
  if (action === 'notes') return `只修改${target}的说明，不改标题、类型和时间，${preserve}，说明改为：`
  if (action === 'restaurant') return `只为${target}选择具体餐馆并作为地点加入当天，保留原餐次与用餐时段，不重复保留同一餐的时间块；核对分店、营业和相邻接驳。餐馆偏好：`
  if (action === 'add-before') return `在${target}之前加入一个用餐、休息或机动时段，保留原时段及其他日期。要加入：`
  if (action === 'add-after') return `在${target}之后加入一个用餐、休息或机动时段，保留原时段及其他日期。要加入：`
  return `只从${scope}移除“${block.title}”时段，保留当天其他安排和所有其他日期。`
}

/** 为住宿到首站或末站返住宿生成只作用于该段路线的修改请求。 */
export function lodgingCommuteRevisionSuggestion(day: ItineraryDay, commute: LodgingCommute): string {
  const scope = day.date ? `${day.date}（第 ${day.dayNumber} 天）` : `第 ${day.dayNumber} 天`
  const endpoint = commute.direction === 'from-lodging' ? day.stops[0] : day.stops.at(-1)
  const origin = commute.direction === 'from-lodging' ? commute.lodgingLocation : endpoint?.name ?? '当天末站'
  const destination = commute.direction === 'from-lodging' ? endpoint?.name ?? '当天首站' : commute.lodgingLocation
  const mode = commute.mode === 'transit' ? '公共交通' : commute.mode === 'walking' ? '步行' : '驾车'
  const current = `${mode}${commute.durationMinutes > 0 ? `约 ${commute.durationMinutes} 分钟` : '耗时待核验'}${commute.queryTime ? `，查询时刻 ${commute.queryTime.replace('-', ':')}` : ''}`
  return `只调整${scope}住宿接驳“${origin} → ${destination}”（当前${current}），保留当天地点顺序、其他日期、预约和固定安排；按我补充的要求查询并调整这段路线。若接驳变化影响未固定时段，只调整受影响的时间并复核冲突；不要替换地点。接驳要求：`
}

/** 仅提示区域文字中可见的往返，并给用户一个可编辑的单日修改起点。 */
function GeographicSequenceReview({ day, destination, onContinueRevision }: {
  day: ItineraryDay
  destination: string
  onContinueRevision?: (suggestion?: string) => void
}) {
  const review = itineraryGeographicReview(day, destination)
  if (!review) return null
  const date = review.date ? `${review.date}（第 ${review.dayNumber} 天）` : `第 ${review.dayNumber} 天`
  const sequence = review.areaSequence.join(' → ')
  const suggestion = `请复核${date}的片区顺序“${sequence}”，根据地图地点和通勤信息尽量减少不必要的折返；保留已锁定地点、预约和固定时段，只改这一天，其他日期不变。若有合理原因需要往返，请在安排说明中写明。`
  return <details className="geographic-sequence-review" aria-label={`${date}片区顺序核对`}>
    <summary><strong><Route size={13} aria-hidden="true" /> 片区顺序可复核</strong><span>{date}</span></summary>
    <div className="geographic-sequence-review-detail">
      <p>按计划标注的区域顺序：<strong>{sequence}</strong>。可能需要跨区返回；这是文本区域提醒，不代表已核实通勤路线，也不会阻止审阅或保存。</p>
      {onContinueRevision && <button className="text-button" type="button" onClick={() => onContinueRevision(suggestion)}>
        按片区调整这一天
      </button>}
    </div>
  </details>
}

/** 只在至少一天存在片区往返线索时显示复核区域。 */
function GeographicSequenceReviews({ days, destination, onContinueRevision }: {
  days: ItineraryDay[]
  destination: string
  onContinueRevision?: (suggestion?: string) => void
}) {
  const reviewDays = days.filter((day) => itineraryGeographicReview(day, destination))
  if (!reviewDays.length) return null
  return <div className="geographic-sequence-reviews">
    {reviewDays.map((day) => <GeographicSequenceReview
      key={day.id}
      day={day}
      destination={destination}
      onContinueRevision={onContinueRevision}
    />)}
  </div>
}

/** 提示同一具名景点出现在多日，并预填可编辑的复核意见。 */
function RepeatedLandmarkReviews({ option, onContinueRevision }: {
  option: ItineraryOption
  onContinueRevision?: (suggestion?: string) => void
}) {
  const reviews = repeatedLandmarkReviews(option)
  if (!reviews.length) return null
  const visibleReviews = reviews.slice(0, 5)
  const remainingCount = reviews.length - visibleReviews.length

  return <section className="repeated-landmark-review" aria-label="跨日重复景点核对">
    <header><strong><MapPin size={13} aria-hidden="true" /> 跨日重复景点</strong><span>{reviews.length} 项待核对</span></header>
    <ul>{visibleReviews.map((review) => <li key={review.name}>
      <strong>{review.name}</strong><span>{review.visits.map((visit) => visit.date
        ? `第 ${visit.dayNumber} 天（${visit.date}）`
        : `第 ${visit.dayNumber} 天`).join('、')}</span>
    </li>)}</ul>
    {remainingCount > 0 && <small>还有 {remainingCount} 项，修改时可一并核对。</small>}
    <p>同名地点可能是有意重访或不同展览；请核对后决定是否调整。</p>
    {onContinueRevision && <button className="text-button" type="button" onClick={() => onContinueRevision(repeatedLandmarkRevisionSuggestion(reviews))}>
      核对重复地点
    </button>}
  </section>
}

/** 在每日首尾分别显示住宿接驳及其可打开的来源。 */
export function LodgingCommuteTimelineCard({ commute, day, lodgingLocation, sources, onOpen, onShowSource, onContinueRevision }: {
  commute: LodgingCommute
  day: ItineraryDay
  lodgingLocation: string
  sources: SourceRecord[]
  onOpen: (url: string) => void
  onShowSource: (source: SourceRecord) => void
  onContinueRevision?: (suggestion: string) => void
}) {
  const stop = commute.direction === 'from-lodging' ? day.stops[0] : day.stops.at(-1)
  const source = sources.find((item) => item.id === commute.sourceId)
  const valid = lodgingCommuteHasValidSource(day, commute, lodgingLocation, sources)
  const origin = commute.direction === 'from-lodging' ? commute.lodgingLocation : stop?.name ?? '末站'
  const destination = commute.direction === 'from-lodging' ? stop?.name ?? '首站' : commute.lodgingLocation
  const mode = commute.mode === 'transit' ? '公共交通' : commute.mode === 'walking' ? '步行' : '驾车'
  const schedule = commute.queryDate ? ` · ${commute.queryDate}${commute.queryTime ? ` ${commute.queryTime.replace('-', ':')}` : ''}` : ''
  const distance = commute.distanceMeters ? ` · ${formatPlanDistance(commute.distanceMeters)}` : ''
  return <div className={`itinerary-lodging-commute${valid ? '' : ' itinerary-lodging-commute-stale'}`}>
    <strong><Route size={13} /> {origin} → {destination}</strong>
    <span>{mode}约 {commute.durationMinutes} 分钟{distance} · 方案 {commute.optionNumber}{schedule}</span>
    {source
      ? <button className="text-button" onClick={() => source.url ? onOpen(source.url) : onShowSource(source)}>查看路线来源 · {sourceTimestampLabel(source)}</button>
      : <small role="alert">路线来源记录缺失，接驳估算需重新核对。</small>}
    {onContinueRevision && <button className="text-button lodging-commute-revision" type="button"
      onClick={() => onContinueRevision(lodgingCommuteRevisionSuggestion(day, commute))}>
      <Route size={12} aria-hidden="true" /> 调整这段接驳
    </button>}
    {source && <SourceFreshnessStatus source={source} onShowSource={onShowSource} />}
    {!valid && source && <small role="alert">住宿、路线端点、路线数值或来源状态已变化，请重新核对。</small>}
  </div>
}

/** 展示非地点时段内容；不提供地点选择或路线操作。 */
export function ScheduleBlockTimelineCard({ block }: { block: ItineraryScheduleBlock }) {
  return <div className="itinerary-schedule-card">
    <strong>{scheduleBlockKindLabel(block.kind)} · {block.title}</strong>
    <span>{[block.durationMinutes ? `时长 ${block.durationMinutes} 分钟` : '时长待核验', block.area].filter(Boolean).join(' · ')}</span>
    {block.notes && <p>{block.notes}</p>}
  </div>
}

/** 展示一份草案的轮次、差异和用户可执行的下一步。 */
export function PlanOptionCard({ option, tripBrief, index, sources, baselineRevision, baselineOption, baselineLabel, proposalNumber = 1, isLatestProposal = true, canContinueRevision = false, onContinueRevision, optionCount = 1, rejected, savedRevisionNumber, onSave, onReject, onOpen, onShowSource }: {
  option: NonNullable<ChatMessage['itineraryOptions']>[number]
  tripBrief: TripBrief
  index: number
  sources: SourceRecord[]
  baselineRevision: Trip['revisions'][number] | null
  baselineOption?: ItineraryOption | null
  baselineLabel?: string
  proposalNumber?: number
  isLatestProposal?: boolean
  canContinueRevision?: boolean
  onContinueRevision?: (suggestion?: string) => void
  optionCount?: number
  rejected: boolean
  savedRevisionNumber?: number
  onSave: () => void
  onReject: (rejected: boolean) => void
  onOpen: (url: string) => void
  onShowSource: (source: SourceRecord) => void
}) {
  const baselineItinerary = baselineOption ?? baselineRevision?.itinerary
  const revisionRound = proposalNumber > 1 ? proposalNumber - 1 : baselineItinerary || baselineRevision ? 1 : 0
  const planLabel = optionCount > 1 ? `历史方案 ${index + 1}` : revisionRound ? `第 ${revisionRound} 轮修改` : '首稿'
  const canConfirm = isLatestProposal
  if (savedRevisionNumber !== undefined) return <article className="plan-option-card plan-option-saved">
    <header><span>{planLabel}</span><h3>{option.title}</h3></header>
    <ProposalStatusBadge state="saved" label={`已保存 · 第 ${savedRevisionNumber} 版`} />
    {baselineItinerary && <PlanChangePreview baselineRevision={baselineRevision} baselineItinerary={baselineOption ?? undefined} baselineLabel={baselineLabel} proposed={option} />}
    <div className="plan-option-days">{option.days.map((day, index) => <PlanDayDisclosure key={day.id} day={day} index={index}
      lodgingLocation={tripBrief.lodgingLocation} sources={sources} onOpen={onOpen} onShowSource={onShowSource}
      openByDefault={index === 0}
      onContinueRevision={canContinueRevision ? onContinueRevision : undefined} />)}</div>
    {option.budgetEstimate && <PlanBudgetDisclosure estimate={option.budgetEstimate} sources={sources} budget={tripBrief.budget} travelers={tripBrief.travelers} onShowSource={onShowSource} />}
    <GeographicSequenceReviews
      days={option.days}
      destination={tripBrief.destination}
      onContinueRevision={canContinueRevision ? onContinueRevision : undefined}
    />
    <RepeatedLandmarkReviews
      option={option}
      onContinueRevision={canContinueRevision ? onContinueRevision : undefined}
    />
    {canContinueRevision && <div className="plan-option-footer"><button className="secondary-button" onClick={() => onContinueRevision?.()}>继续修改</button></div>}
  </article>

  if (rejected) return <article className="plan-option-card plan-option-rejected">
    <header><span>{planLabel}</span><h3>{option.title}</h3></header>
    <ProposalStatusBadge state="skipped" label="已跳过" />
    <button className="secondary-button" onClick={() => onReject(false)}>恢复方案</button>
  </article>

  const preservation = baselineItinerary
    ? preserveLockedStops(baselineItinerary, option)
    : { itinerary: option, conflicts: [] }
  const scheduleBlockers = blockingScheduleFindings(preservation.itinerary, tripBrief)
  const proposalStatus = isLatestProposal ? '待审阅' : '已有新草案'
  const confirmationTitle = !canConfirm
    ? '旧方案已不可确认，请在最新草案上继续。'
    : preservation.conflicts.length > 0
      ? '先解决已固定安排冲突再保存'
      : scheduleBlockers.length > 0 ? '先处理行程结构或时间约束再保存' : undefined
  return <article className="plan-option-card">
    <header><span>{planLabel}</span><h3>{option.title}</h3></header>
    <ProposalStatusBadge state={canConfirm ? 'review' : 'updated'} label={proposalStatus} />
    {!canConfirm && <p className="itinerary-stale-note" role="status">旧方案已不可确认。你仍可查看差异或继续使用最新草案。</p>}
    <p>{option.summary}</p>
    <PlanChangePreview
      baselineRevision={baselineRevision}
      baselineItinerary={baselineOption ?? undefined}
      baselineLabel={baselineLabel}
      proposed={preservation.itinerary}
    />
    <div className="plan-option-days">{preservation.itinerary.days.map((day, index) => <PlanDayDisclosure key={day.id} day={day} index={index}
      lodgingLocation={tripBrief.lodgingLocation} sources={sources} onOpen={onOpen} onShowSource={onShowSource}
      openByDefault={canConfirm && index === 0}
      onContinueRevision={canContinueRevision ? onContinueRevision : undefined} />)}</div>
    <ScheduleFeasibility itinerary={preservation.itinerary} anchors={tripBrief} sources={sources}
      onContinueRevision={canContinueRevision ? onContinueRevision : undefined} />
    {preservation.itinerary.budgetEstimate
      ? <PlanBudgetDisclosure estimate={preservation.itinerary.budgetEstimate} sources={sources} budget={tripBrief.budget} travelers={tripBrief.travelers} onShowSource={onShowSource} />
      : option.budgetEstimate && <p className="itinerary-budget-stale-note">固定安排并入当前行程后，费用估算需重新核对。</p>}
    <GeographicSequenceReviews
      days={option.days}
      destination={tripBrief.destination}
      onContinueRevision={canContinueRevision ? onContinueRevision : undefined}
    />
    <RepeatedLandmarkReviews
      option={option}
      onContinueRevision={canContinueRevision ? onContinueRevision : undefined}
    />
    {preservation.conflicts.length > 0 && <p className="anchor-conflict-message" role="alert">{preservation.conflicts.join(' ')}</p>}
    {option.tradeoffs.trim() && <details className="plan-tradeoffs">
      <summary>安排取舍</summary>
      <p>{option.tradeoffs}</p>
    </details>}
  <div className="plan-option-footer">
      <div className="plan-option-secondary-actions">
        <button className="text-button" onClick={() => {
          const firstStop = option.days[0]?.stops[0]
          if (firstStop) onOpen(`https://ditu.amap.com/search?query=${encodeURIComponent(firstStop.name)}`)
        }}><MapPin size={13} /> 查看首站地图</button>
        {canContinueRevision && <button className="secondary-button" onClick={() => onContinueRevision?.()}>继续修改</button>}
        <button className="text-button plan-reject-button" onClick={() => onReject(true)}><X size={13} /> 不采用</button>
      </div>
      <button className="primary-button" disabled={!canConfirm || preservation.conflicts.length > 0 || scheduleBlockers.length > 0}
        title={confirmationTitle}
        onClick={onSave}><Check size={14} /> {optionCount > 1 ? '保存此方案' : '确认并保存'}</button>
    </div>
  </article>
}

/** 仅显示当前状态；草案和修改差异由相邻内容直接呈现。 */
function ProposalStatusBadge({ state, label }: { state: 'review' | 'updated' | 'saved' | 'skipped'; label: string }) {
  return <p className={`proposal-status is-${state}`} role="status">{label}</p>
}

/** 在保存候选前对比当前确认版本，突出地点、时段和顺序变化。 */
export function PlanChangePreview({ baselineRevision, baselineItinerary, baselineLabel, proposed }: {
  baselineRevision: Trip['revisions'][number] | null
  baselineItinerary?: ItineraryOption
  baselineLabel?: string
  proposed: NonNullable<ChatMessage['itineraryOptions']>[number]
}) {
  const previousPlan = baselineItinerary ?? baselineRevision?.itinerary
  if (!previousPlan) {
    if (!baselineRevision) return null
    return <div className="plan-change-preview unavailable">
      <strong>行程版本对比</strong>
      <p>第 {baselineRevision.number} 版是文本方案，无法逐地点比较。</p>
    </div>
  }

  const comparison = compareItineraries(previousPlan, proposed)
  const counts = comparison.changes.reduce((result, change) => {
    result[change.type]++
    return result
  }, { added: 0, removed: 0, moved: 0, updated: 0 })
  const visibleChanges = [
    ...comparison.changes.filter((change) => change.impact === 'transport'),
    ...comparison.changes.filter((change) => change.impact !== 'transport')
  ].slice(0, 8)
  return <section className="plan-change-preview" aria-label="行程版本差异">
    <header><strong>{baselineLabel ?? `与第 ${baselineRevision?.number} 版对比`}</strong><span>{comparison.unchanged
      ? '地点、日期、日程字段与交通路线未变化'
      : [`新增 ${counts.added}`, `移除 ${counts.removed}`, `移动 ${counts.moved}`, `调整 ${counts.updated}`].filter((item) => !item.endsWith(' 0')).join(' · ')}</span></header>
    {comparison.unchanged
      ? <p>未检测到地点、日期、时段、站间路线或住宿接驳变化；请核对上方路线摘要与取舍后再保存。</p>
      : <>
        <ul>{visibleChanges.map((change, index) => {
          const scope = itineraryChangeScope(change, previousPlan, proposed)
          return <li key={`${change.type}-${change.title}-${index}`}>
            <span className={`plan-change-tag change-${change.type}`}>{itineraryChangeLabel(change.type)}</span>
            <div><strong>{change.title}</strong><small>{change.detail}</small>
              {scope && <small className="plan-change-scope">{scope}</small>}
            </div>
          </li>
        })}</ul>
        {comparison.changes.length > visibleChanges.length && <small className="plan-change-more">另有 {comparison.changes.length - visibleChanges.length} 项变化</small>}
      </>}
  </section>
}

/** 依据差异中的日期编号显示改动影响的旧日期和新日期。 */
function itineraryChangeScope(
  change: ReturnType<typeof compareItineraries>['changes'][number],
  previous: ItineraryOption,
  proposed: ItineraryOption
): string | null {
  const previousDay = change.fromDay === undefined
    ? undefined
    : previous.days.find((day) => day.dayNumber === change.fromDay)
  const proposedDay = change.toDay === undefined
    ? undefined
    : proposed.days.find((day) => day.dayNumber === change.toDay)
  const previousLabel = previousDay ? itineraryDayScopeLabel(previousDay) : ''
  const proposedLabel = proposedDay ? itineraryDayScopeLabel(proposedDay) : ''
  if (previousLabel && proposedLabel) {
    return `影响范围：${previousLabel}${previousLabel === proposedLabel ? '' : ` → ${proposedLabel}`}`
  }
  if (previousLabel || proposedLabel) return `影响范围：${previousLabel || proposedLabel}`
  return null
}

/** 日期存在时随天数一同展示，避免“第几天”变化掩盖实际日历范围。 */
function itineraryDayScopeLabel(day: ItineraryDay): string {
  return `第 ${day.dayNumber} 天${day.date ? ` · ${day.date}` : ''}`
}

/** 明确显示每个行程地点的依据状态，不把来源链接等同于事实核验。 */
function itineraryEvidenceLabel(level: NonNullable<ItineraryStop['evidenceLevel']>): string {
  return ({ sourced: '已关联来源', estimated: '规划估算', pending: '待核验' })[level]
}

/** 用明确词语标记地点变化，不只依赖颜色区分新增、移除和调整。 */
function itineraryChangeLabel(type: ItineraryChangeType): string {
  return ({ added: '新增', removed: '移除', moved: '移动', updated: '调整' })[type]
}
