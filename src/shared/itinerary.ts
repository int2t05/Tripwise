/** 比较候选方案并生成带来源说明的行程 Markdown。 */
import type { ItineraryDay, ItineraryLocation, ItineraryOption, ItineraryScheduleBlockKind, LodgingCommute, SourceRecord } from './types.js'
import { BUDGET_CATEGORY_LABELS, formatBudgetRange, summarizeBudgetEstimate } from './budget.js'
import { groupItineraryFacts, itineraryEvidenceLabel, itineraryFactTypeLabel } from './itinerary-facts.js'
import { routePlanningBufferMinutes, scheduleBlockKindLabel } from './itinerary-schedule.js'
import { routeSummarySupportsMetrics, routeTitleMatchesOrderedEndpoints } from './preparation.js'
import { lodgingCommuteBoundaryStop } from './itinerary-route-endpoints.js'

export interface OptionComparisonMetrics {
  optionId: string
  title: string
  dayCount: number
  stopCount: number
  averageStopsPerDay: number
  knownDwellMinutes: number
  stopsWithoutDwell: number
  scheduleBlockCount: number
  scheduledBreakMinutes: number
  scheduleBlockKinds: ItineraryScheduleBlockKind[]
  sharedStopNames: string[]
  areas: string[]
  categories: string[]
  matchedInterests: string[]
  unmatchedInterests: string[]
  interestMatchEvidence: InterestMatchEvidence[]
  sourceLinkedStops: number
  sourcedTicketFacts: number
  sourcedTransportFacts: number
  routeEstimateCount: number
  /** 路线结果中确实包含耗时的段数，避免把缺失值误读为零。 */
  routeEstimateDurationCount: number
  routeEstimateMinutes: number
  walkingDistanceMeters: number | null
}

/** 汇总已采纳路线中明确返回的公交票价与道路收费，不推算全程旅行预算。 */
export interface ItineraryTransportCostSummary {
  publicTransportLegCount: number
  knownPublicTransportFareCount: number
  publicTransportFareFen: number
  drivingLegCount: number
  knownDrivingTollCount: number
  drivingTollFen: number
}

/** 记录方案命中用户兴趣的具体文字依据。 */
export interface InterestMatchEvidence {
  interest: string
  matchedTerms: string[]
  method: 'exact' | 'curated-alias'
}

/** 用少量明确同义表达改善中文兴趣对照，不将自由文本交给模型猜测。 */
const INTEREST_ALIAS_GROUPS = [
  ['红叶', '枫叶', '赏枫', '赏秋', '秋景', '秋色'],
  ['人文', '历史文化', '历史建筑', '古迹', '文化遗产', '博物馆', '博物院', '历史遗址'],
  ['自然风光', '自然景观', '山水风光', '山水', '湖光山色'],
  ['摄影', '拍照', '出片'],
  ['美食', '当地菜', '地方菜', '特色菜', '小吃'],
  ['海滨', '海边', '海岛', '看海'],
  ['亲子', '带娃', '儿童友好', '儿童乐园'],
  ['温泉', '泡汤'],
  ['徒步', '登山', '爬山', '步道']
] as const

/** 汇总各候选行程的强度、兴趣命中和来源覆盖，供用户比较后选择。 */
export function comparePlanOptions(options: ItineraryOption[], interestText: string): OptionComparisonMetrics[] {
  const interests = parseInterestPhrases(interestText)
  return options.map((option, optionIndex) => {
    const stops = option.days.flatMap((day) => day.stops)
    const scheduleBlocks = option.days.flatMap((day) => day.scheduleBlocks ?? [])
    const otherStopNames = new Set(options.flatMap((candidate, candidateIndex) => candidateIndex === optionIndex
      ? []
      : candidate.days.flatMap((day) => day.stops.map((stop) => normalizeLabel(stop.name)).filter(Boolean)))
    )
    const searchableText = stops.map((stop) => normalizeLabel([stop.name, stop.area, stop.category, stop.notes].join(' '))).join('\n')
    const interestMatchEvidence = interests.flatMap((interest) => {
      const evidence = matchInterest(interest, searchableText)
      return evidence ? [evidence] : []
    })
    const matchedInterests = interestMatchEvidence.map((evidence) => evidence.interest)
    const estimates = stops.map((stop) => stop.transitEstimate).filter((estimate) => !!estimate)
    const walkingDistances = estimates.map((estimate) => estimate.walkingDistanceMeters)
      .filter((distance): distance is number => typeof distance === 'number' && Number.isFinite(distance))
    const facts = stops.flatMap((stop) => stop.factClaims ?? [])
    return {
      optionId: option.id,
      title: option.title,
      dayCount: option.days.length,
      stopCount: stops.length,
      averageStopsPerDay: option.days.length ? stops.length / option.days.length : 0,
      knownDwellMinutes: stops.reduce((total, stop) => total + (stop.durationMinutes ?? 0), 0),
      stopsWithoutDwell: stops.filter((stop) => stop.durationMinutes === null).length,
      scheduleBlockCount: scheduleBlocks.length,
      scheduledBreakMinutes: scheduleBlocks.reduce((total, block) => total + (block.durationMinutes ?? 0), 0),
      scheduleBlockKinds: [...new Set(scheduleBlocks.map((block) => block.kind))],
      sharedStopNames: uniqueLabels(stops.map((stop) => stop.name).filter((name) => otherStopNames.has(normalizeLabel(name)))),
      areas: uniqueLabels(stops.map((stop) => stop.area)),
      categories: uniqueLabels(stops.map((stop) => stop.category)),
      matchedInterests,
      unmatchedInterests: interests.filter((interest) => !matchedInterests.includes(interest)),
      interestMatchEvidence,
      sourceLinkedStops: stops.filter((stop) => (stop.sourceIds ?? []).length > 0).length,
      sourcedTicketFacts: facts.filter((claim) => claim.type === 'ticket-price' && claim.evidenceLevel === 'sourced' && !!claim.sourceId).length,
      sourcedTransportFacts: facts.filter((claim) => claim.type === 'transport-time' && claim.evidenceLevel === 'sourced' && !!claim.sourceId).length,
      routeEstimateCount: estimates.length,
      routeEstimateDurationCount: estimates.filter((estimate) => typeof estimate.durationMinutes === 'number' && Number.isFinite(estimate.durationMinutes)).length,
      routeEstimateMinutes: estimates.reduce((total, estimate) => total + (estimate.durationMinutes ?? 0), 0),
      walkingDistanceMeters: walkingDistances.length ? walkingDistances.reduce((total, distance) => total + distance, 0) : null
    }
  })
}

/** 只累计已采纳路线保存的整数分金额，未知金额保持为未计入。 */
export function summarizeItineraryTransportCosts(itinerary: ItineraryOption): ItineraryTransportCostSummary {
  const estimates = itinerary.days.flatMap((day) => day.stops.flatMap((stop) =>
    stop.transitEstimate ? [stop.transitEstimate] : []))
  const publicTransport = estimates.filter((estimate) => estimate.mode === 'transit')
  const driving = estimates.filter((estimate) => estimate.mode === 'driving')
  const knownPublicTransportFares = publicTransport.flatMap((estimate) =>
    isValidFen(estimate.fareFen) ? [estimate.fareFen] : [])
  const knownDrivingTolls = driving.flatMap((estimate) =>
    isValidFen(estimate.tollFen) ? [estimate.tollFen] : [])
  return {
    publicTransportLegCount: publicTransport.length,
    knownPublicTransportFareCount: knownPublicTransportFares.length,
    publicTransportFareFen: knownPublicTransportFares.reduce((total, amount) => total + amount, 0),
    drivingLegCount: driving.length,
    knownDrivingTollCount: knownDrivingTolls.length,
    drivingTollFen: knownDrivingTolls.reduce((total, amount) => total + amount, 0)
  }
}

/** 将每日住宿接驳绑定到当前住宿、边界地点和同一条成功路线来源。 */
export function lodgingCommutesHaveValidSources(
  itinerary: ItineraryOption,
  lodgingLocation: string,
  sources: SourceRecord[],
  requireSuccess = true
): boolean {
  for (const day of itinerary.days) {
    for (const commute of day.lodgingCommutes ?? []) {
      if (!lodgingCommuteHasValidSource(day, commute, lodgingLocation, sources, requireSuccess)) return false
    }
  }
  return true
}

/** 验证单条住宿接驳确实绑定当前住宿、日边界地点和同一条路线方案。 */
export function lodgingCommuteHasValidSource(
  day: ItineraryDay,
  commute: LodgingCommute,
  lodgingLocation: string,
  sources: SourceRecord[],
  requireSuccess = true
): boolean {
  const source = sources.find((item) => item.id === commute.sourceId)
  const stop = lodgingCommuteBoundaryStop(day.stops, commute.direction)
  const boundStop = day.stops.find((item) => item.id === commute.stopId)
  const modeLabel = commute.mode === 'transit' ? '公共交通' : commute.mode === 'walking' ? '步行' : '驾车'
  const header = source?.summary.split(/\r?\n/, 1)[0] ?? ''
  const origin = commute.direction === 'from-lodging' ? commute.lodgingLocation : stop?.name ?? ''
  const destination = commute.direction === 'from-lodging' ? stop?.name ?? '' : commute.lodgingLocation
  return commute.lodgingLocation === lodgingLocation.trim() && !!stop && boundStop?.id === stop.id && !!source && source.kind === 'route' &&
    (!requireSuccess || source.status === 'success') && routeTitleMatchesOrderedEndpoints(source.title, origin, destination) &&
    header.includes(`，${modeLabel}`) &&
    !(commute.mode === 'transit' && day.date !== '' && commute.queryDate !== day.date) &&
    !(commute.queryDate !== undefined && !header.includes(commute.queryDate)) &&
    !(commute.queryTime !== undefined && !header.includes(commute.queryTime.replace('-', ':'))) &&
    routeSummarySupportsMetrics(source.summary, commute.optionNumber, commute.distanceMeters ?? undefined, commute.durationMinutes)
}

/** 仅把非负安全整数视为人民币分金额。 */
function isValidFen(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 从自由输入中提取已整理的兴趣词；没有命中词库时保留整段原词。 */
function parseInterestPhrases(value: string): string[] {
  const segments = value.split(/[、，,;；/|\s]+/).map(normalizeLabel).filter(Boolean)
  const extracted = segments.flatMap((segment) => {
    const aliases = INTEREST_ALIAS_GROUPS.flatMap((terms) => {
      const matches = terms.filter((term) => segment.includes(normalizeLabel(term)))
      if (!matches.length) return []
      const preferred = matches.sort((left, right) =>
        segment.indexOf(normalizeLabel(left)) - segment.indexOf(normalizeLabel(right)) ||
        normalizeLabel(right).length - normalizeLabel(left).length)[0]
      return preferred ? [{ term: preferred, index: segment.indexOf(normalizeLabel(preferred)) }] : []
    })
    return aliases.length
      ? aliases.sort((left, right) => left.index - right.index).map(({ term }) => term)
      : [segment]
  })
  return uniqueLabels(extracted)
}

/** 先找原词，再找用户词和行程词都命中的受控别名组。 */
function matchInterest(interest: string, searchableText: string): InterestMatchEvidence | null {
  if (searchableText.includes(interest)) return { interest, matchedTerms: [interest], method: 'exact' }
  const requestedGroups = INTEREST_ALIAS_GROUPS.filter((terms) => terms.some((term) => interest.includes(normalizeLabel(term))))
  if (!requestedGroups.length) return null
  const matchedTerms = requestedGroups.flatMap((terms) => terms
    .filter((term) => searchableText.includes(normalizeLabel(term))))
  const matchedGroupCount = requestedGroups.filter((terms) =>
    terms.some((term) => matchedTerms.includes(term))).length
  if (matchedGroupCount !== requestedGroups.length) return null
  return { interest, matchedTerms: uniqueLabels(matchedTerms), method: 'curated-alias' }
}

/** 统一比较标签的空白与字符形式，不扩展同义词或推断兴趣类别。 */
function normalizeLabel(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase()
}

/** 清理、去重并按用户看到的原始文字排序。 */
function uniqueLabels(values: string[]): string[] {
  const labels = new Map<string, string>()
  for (const value of values) {
    const normalized = normalizeLabel(value)
    if (normalized && !labels.has(normalized)) labels.set(normalized, value.trim())
  }
  return [...labels.values()]
}

/** 按地点原始坐标系生成高德官方 URI，避免把高德地点链接到其他地图。 */
function amapMarkerUrl(location: ItineraryLocation): string {
  const query = new URLSearchParams({
    position: `${location.longitude},${location.latitude}`,
    name: location.label,
    src: 'Tripwise',
    coordinate: location.coordinateSystem === 'gcj02' ? 'gaode' : 'wgs84'
  })
  return `https://uri.amap.com/marker?${query.toString()}`
}

/** 保留每日地点顺序、时段、停留与交通提示的纯文本版本。 */
export function itineraryToMarkdown(itinerary: ItineraryOption, sources: SourceRecord[] = []): string {
  const lines = [
    `## ${itinerary.title}`,
    '',
    itinerary.summary,
    '',
    `**方案取舍：** ${itinerary.tradeoffs}`,
    '来源关联表示地点建议相关资料，不代表开放时间、价格等每项事实都已核实。',
    ''
  ]
  if (itinerary.budgetEstimate) lines.push('', ...budgetEstimateMarkdown(itinerary.budgetEstimate, sources), '')
  for (const day of itinerary.days) {
    lines.push(`### 第 ${day.dayNumber} 天${day.date ? ` · ${day.date}` : ''}：${day.title}`, '')
    if (day.weather) {
      const source = day.weather.sourceId ? sources.find((item) => item.id === day.weather?.sourceId) : undefined
      const weatherLabel = day.weather.status === 'forecast' ? '天气预报' : '天气未知'
      const sourceText = source
        ? `；来源：${source.title || source.provider}（${source.url || '无原文链接'}；获取于 ${source.fetchedAt}）`
        : '；没有匹配该日期的天气来源'
      lines.push(`- ${weatherLabel}：${day.weather.summary}${sourceText}`, '')
    }
    if (day.scheduleBlocks?.length) {
      lines.push('**用餐与休息时段**')
      for (const block of day.scheduleBlocks) {
        const time = block.time ? `${block.time}｜` : '时段待补充｜'
        const duration = block.durationMinutes ? `｜约 ${block.durationMinutes} 分钟` : '｜时长待核验'
        const area = block.area ? `｜${block.area}` : ''
        lines.push(`- ${time}${scheduleBlockKindLabel(block.kind)}：${block.title}${duration}${area}`)
        if (block.notes) lines.push(`  - 说明：${block.notes}`)
      }
      lines.push('')
    }
    const inboundLodgingCommute = day.lodgingCommutes?.find((commute) => commute.direction === 'from-lodging')
    if (inboundLodgingCommute) lines.push(lodgingCommuteMarkdown(inboundLodgingCommute, lodgingCommuteBoundaryStop(day.stops, 'from-lodging')?.name ?? '', sources))
    for (const stop of day.stops) {
      const time = stop.time ? `${stop.time}｜` : ''
      const area = stop.area ? `（${stop.area}）` : ''
      const duration = stop.durationMinutes ? `｜建议停留 ${stop.durationMinutes} 分钟` : ''
      const category = stop.category ? `｜${stop.category}` : ''
      const locked = stop.locked ? '【固定安排】' : ''
      lines.push(`- ${time}**${stop.name}**${locked}${area}${category}${duration}`)
      if (stop.location) {
        const mapUrl = amapMarkerUrl(stop.location)
        lines.push(`  - 地图定位：${stop.location.label}（${stop.location.provider}） ${mapUrl}`)
      }
      const evidenceLevel = stop.evidenceLevel
      if (evidenceLevel) lines.push(`  - 依据状态：${itineraryEvidenceLabel(evidenceLevel)}`)
      const evidenceSources = (stop.sourceIds ?? []).map((id) => sources.find((source) => source.id === id)).filter((source): source is SourceRecord => !!source)
      if (evidenceSources.length) {
        lines.push(`  - 相关来源：${evidenceSources.map((source) => `${source.title || source.provider}（${source.url || '无原文链接'}；${source.fetchedAt}）`).join('；')}`)
      }
      const factGroups = groupItineraryFacts(stop.factClaims)
      for (const group of factGroups) {
        if (group.conflicting) lines.push(`  - **信息冲突：${itineraryFactTypeLabel(group.type)}${group.scope ? `（${group.scope}）` : ''}，请核对**`)
        for (const claim of group.claims) {
          const source = claim.sourceId ? sources.find((item) => item.id === claim.sourceId) : undefined
          const evidence = itineraryEvidenceLabel(claim.evidenceLevel)
          const sourceText = source
            ? `；来源：${source.title || source.provider}（${source.url || '无原文链接'}；获取于 ${source.fetchedAt}）`
            : ''
          lines.push(`  - 事实：${itineraryFactTypeLabel(claim.type)}${claim.scope ? `（${claim.scope}）` : ''}：${claim.value}；${evidence}${sourceText}`)
        }
      }
      if (stop.notes) lines.push(`  - 提醒：${stop.notes}`)
      for (const alternative of stop.conditionalAlternatives ?? []) {
        const evidence = alternative.evidenceLevel === 'sourced' ? '地点有来源' : '地点待核验'
        const area = alternative.area ? `（${alternative.area}）` : ''
        const environment = alternative.environment === 'indoor' ? '；室内活动' : alternative.environment === 'outdoor' ? '；室外活动' : ''
        lines.push(`  - 条件备选：${alternative.name}${area}；触发条件：${alternative.trigger}${environment}；${evidence}`)
        for (const sourceId of alternative.sourceIds) {
          const source = sources.find((item) => item.id === sourceId)
          if (!source) continue
          const title = source.title || source.provider
          const link = source.url ? `[${title}](${source.url})` : title
          const sourceStatus = source.status === 'success' ? '当前可用来源' : `上次来源${source.status}`
          lines.push(`    - 来源：${link}；${sourceStatus}；获取于 ${source.fetchedAt}`)
        }
      }
      if (stop.transitToNext) lines.push(`  - 前往下一站：${stop.transitToNext}`)
      if (stop.transitEstimate) {
        const mode = routeModeLabel(stop.transitEstimate.mode)
        const departure = stop.transitEstimate.queryDate
          ? `，查询日期 ${stop.transitEstimate.queryDate}${stop.transitEstimate.queryTime ? ` ${stop.transitEstimate.queryTime.replace('-', ':')}` : ''}`
          : ''
        const fareFen = stop.transitEstimate.fareFen
        const tollFen = stop.transitEstimate.tollFen
        const cost = stop.transitEstimate.mode === 'transit' && Object.hasOwn(stop.transitEstimate, 'fareFen')
          ? typeof fareFen === 'number' ? `，票价估算 ${formatYuanFen(fareFen)}` : '，未返回明确票价'
          : stop.transitEstimate.mode === 'driving' && Object.hasOwn(stop.transitEstimate, 'tollFen')
            ? typeof tollFen === 'number' ? `，道路收费估算 ${formatYuanFen(tollFen)}` : '，未返回道路收费'
            : ''
        const routeDuration = typeof stop.transitEstimate.durationMinutes === 'number'
          ? `，路线估时约 ${stop.transitEstimate.durationMinutes} 分钟`
          : '，路线耗时未提供'
        const routeBuffer = `，另留 ${routePlanningBufferMinutes(stop.transitEstimate.mode)} 分钟机动余量`
        lines.push(`  - 路线依据：高德地图${mode}估算，方案 ${stop.transitEstimate.optionNumber}${routeDuration}${routeBuffer}${departure}${cost}（${stop.transitEstimate.fetchedAt}，来源见下方）`)
      }
    }
    const outboundLodgingCommute = day.lodgingCommutes?.find((commute) => commute.direction === 'to-lodging')
    if (outboundLodgingCommute) lines.push(lodgingCommuteMarkdown(outboundLodgingCommute, lodgingCommuteBoundaryStop(day.stops, 'to-lodging')?.name ?? '', sources))
    lines.push('')
  }
  return lines.join('\n').trim()
}

/** 导出费用单价、数量、依据、来源和有明确缺项的预算范围。 */
function budgetEstimateMarkdown(estimate: NonNullable<ItineraryOption['budgetEstimate']>, sources: SourceRecord[]): string[] {
  const summary = summarizeBudgetEstimate(estimate, sources)
  const lines = [
    '## 预算估算（人民币）', '',
    '金额为规划范围，不是报价或支付记录；“有来源”只表示关联当前成功来源，仍需核对来源正文、人数和适用日期。'
  ]
  for (const item of estimate.items) {
    const evidence = item.evidenceLevel === 'sourced' ? '有来源' : item.evidenceLevel === 'estimated' ? '规划估算' : '待核验'
    if (item.evidenceLevel === 'pending' || item.amountMinFen === null || item.amountMaxFen === null) {
      lines.push(`- ${BUDGET_CATEGORY_LABELS[item.category]}｜${item.title}：待核验（${item.basis}）`)
    } else {
      const unitRange = formatBudgetRange(item.amountMinFen, item.amountMaxFen)
      const totalRange = formatBudgetRange(item.amountMinFen * item.quantity, item.amountMaxFen * item.quantity)
      const linkedSources = item.sourceIds.map((id) => sources.find((source) => source.id === id)).filter((source): source is SourceRecord => !!source)
      const sourceText = linkedSources.length
        ? `；来源：${linkedSources.map((source) => `${source.title || source.provider}（${source.url || '无原文链接'}；${source.fetchedAt}${source.status === 'success' ? '' : '；当前来源需复核'}）`).join('；')}`
        : ''
      lines.push(`- ${BUDGET_CATEGORY_LABELS[item.category]}｜${item.title}：${unitRange}/${item.unitLabel} × ${item.quantity} = ${totalRange}；${evidence}；${item.basis}${sourceText}`)
    }
  }
  for (const item of estimate.notApplicableCategories) {
    lines.push(`- ${BUDGET_CATEGORY_LABELS[item.category]}：不适用（${item.reason}）`)
  }
  const unresolved = [...summary.pendingCategories, ...summary.missingCategories]
  if (summary.pricedItemCount > 0) {
    lines.push('', `**${summary.complete ? '费用估算总额' : '已计入项目小计'}：${formatBudgetRange(summary.totalMinFen, summary.totalMaxFen)}**`)
  } else {
    lines.push('', '**尚无可计算的费用金额。**')
  }
  if (unresolved.length) lines.push(`未计入完整总额：${[...new Set(unresolved)].map((category) => BUDGET_CATEGORY_LABELS[category]).join('、')}。`)
  if (unresolved.length) lines.push('待核验费用未按零元计算。')
  if (summary.sourceReviewItemCount) lines.push(`有 ${summary.sourceReviewItemCount} 项金额的来源缺失或当前不可用，请复核后再使用。`)
  return [...lines, '']
}

/** 导出住宿接驳方向、估算值和原路线来源，避免与景点间路线混淆。 */
function lodgingCommuteMarkdown(commute: LodgingCommute, stopName: string, sources: SourceRecord[]): string {
  const origin = commute.direction === 'from-lodging' ? commute.lodgingLocation : stopName
  const destination = commute.direction === 'from-lodging' ? stopName : commute.lodgingLocation
  const source = sources.find((item) => item.id === commute.sourceId)
  const distance = commute.distanceMeters ? `，${formatDistance(commute.distanceMeters)}` : ''
  const schedule = commute.queryDate ? `，查询 ${commute.queryDate}${commute.queryTime ? ` ${commute.queryTime.replace('-', ':')}` : ''}` : ''
  const sourceLink = source ? `；来源：${source.title || source.provider}（${source.url || '无原文链接'}；${source.fetchedAt}${source.status === 'success' ? '' : '；当前来源需复核'}）` : '；路线来源缺失，需复核'
  return `- 住宿接驳：${origin} → ${destination}，${routeModeLabel(commute.mode)}约 ${commute.durationMinutes} 分钟${distance}，方案 ${commute.optionNumber}${schedule}${sourceLink}`
}

/** 用米或千米呈现来源直接返回的距离。 */
function formatDistance(meters: number): string {
  return meters >= 1_000 ? `${(meters / 1_000).toFixed(1)} km` : `${Math.round(meters)} m`
}

/** 按整数分显示人民币，避免导出金额产生浮点误差。 */
function formatYuanFen(fen: number): string {
  return `¥${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, '0')}`
}

/** 以中文标注路线服务请求的交通方式。 */
function routeModeLabel(mode: 'transit' | 'walking' | 'driving'): string {
  return mode === 'transit' ? '公共交通' : mode === 'walking' ? '步行' : '驾车'
}
