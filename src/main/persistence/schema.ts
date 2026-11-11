/** 校验当前旅行数据库结构并提供只读副本工具；不执行文件 I/O。 */
import { PACKING_SECTIONS } from '../../shared/types.js'
import { BUDGET_COST_CATEGORIES } from '../../shared/budget.js'
import type {
  AgentRunProgress, AgentRunTranscriptMessage, AppSettings, ChatMessage, GeoLocation, ItineraryLocation, ItineraryConditionalAlternative, ItineraryDayWeather, ItineraryFactClaim, ItineraryFactType,
  BudgetCostCategory, ItineraryBudgetEstimate, ItineraryBudgetItem, ItineraryMealRequirement, ItineraryMealSlot, ItineraryStop, LodgingCommute, PackingSection, PreparationItem, PreparationLocationContext, PreparationItemUpdate,
  ItineraryOption, ItineraryScheduleBlock, ItineraryRevision, McpServerSettings, SourceRetry, SourceRecord,
  Trip, TripBrief, TripBriefProposal, TripConversation, LegacyTrip
} from '../../shared/types.js'
import { isAbsolute } from 'node:path'
import { placeNamesMatch, routeSummarySupportsMetrics, routeTitleMatchesEndpoints } from '../../shared/preparation.js'
import { isNormalizedSourceProxy, normalizeSourceProxy } from '../network-proxy.js'
import { isSafeMcpRetryArguments } from '../../shared/mcp-retry-safety.js'
import { normalizeRemoteMcpUrl } from '../../shared/mcp-config.js'
import { normalizeTripBriefUnknownFields } from '../../shared/trip-brief.js'
import {
  MAX_AGENT_RUN_SOURCE_IDS, MAX_AGENT_RUN_TRANSCRIPT_MESSAGES, MAX_ITINERARY_ARGUMENT_CHARACTERS,
  MAX_TOOL_ARGUMENT_CHARACTERS, MAX_TOOL_CALLS_PER_MESSAGE
} from '../../shared/agent-limits.js'
import {
  MAX_ITINERARY_FACT_CLAIMS_PER_STOP, MAX_ITINERARY_STOPS_PER_DAY, MAX_ITINERARY_STOP_SOURCE_IDS
} from '../../shared/itinerary-limits.js'
import { isPhysicalItineraryStop, lodgingCommuteBoundaryStop } from '../../shared/itinerary-route-endpoints.js'

export interface Database {
  schemaVersion: 16
  selectedTripId: string | null
  settings: AppSettings
  trips: Trip[]
}

export const DEFAULT_SETTINGS: AppSettings = {
  model: {
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'glm-5.3-flash'
  },
  sourceProxyUrl: '',
  connectors: { webSearch: true, weather: true, places: true, routes: true },
  xiaohongshu: { enabled: false, command: '', args: [] },
  researchBrowserVisualRead: false,
  mcpServers: []
}

export const EMPTY_BRIEF: TripBrief = {
  departureCity: '',
  destination: '',
  startDate: '',
  endDate: '',
  arrivalFlight: '',
  arrivalTime: '',
  leaveTime: '',
  travelers: '',
  budget: '',
  lodgingLocation: '',
  lodging: '',
  pace: '',
  earlyStart: '',
  interests: '',
  transport: '',
  dietary: '',
  luggage: '',
  clothing: '',
  constraints: ''
}

/** 校验结构化方案，避免损坏的嵌套字段进入时间线组件。 */
export function isItineraryOption(value: unknown): value is ItineraryOption {
  return itineraryOptionFailureStage(value) === undefined
}

/** 返回固定结构类别，供路线修复诊断定位 schema 失配，不包含行程字段内容。 */
export function itineraryOptionFailureStage(value: unknown): string | undefined {
  if (!isRecord(value) || !isBoundedString(value.id, 1, 100) || !isBoundedString(value.title, 1, 100) ||
    !isBoundedString(value.summary, 1, 500) || !isBoundedString(value.tradeoffs, 0, 500)) return 'option_header'
  if (value.budgetEstimate !== undefined && !isItineraryBudgetEstimate(value.budgetEstimate)) return 'budget_estimate'
  if (value.mealRequirements !== undefined && (!Array.isArray(value.mealRequirements) ||
    value.mealRequirements.length > 7 || !value.mealRequirements.every(isItineraryMealRequirement))) return 'meal_requirements'
  if (!Array.isArray(value.days) || value.days.length < 1 || value.days.length > 7) return 'day_count'

  for (const day of value.days) {
    if (!isRecord(day) || !isBoundedString(day.id, 1, 100) || !Number.isInteger(day.dayNumber) ||
      Number(day.dayNumber) < 1 || Number(day.dayNumber) > 7 || !isString(day.date) ||
      (day.date !== '' && !isCalendarDate(day.date)) || !isBoundedString(day.title, 1, 100)) return 'day_header'
    if (!Array.isArray(day.scheduleBlocks) || day.scheduleBlocks.length > 8 ||
      !day.scheduleBlocks.every(isItineraryScheduleBlock)) return 'schedule_blocks'
    if (day.weather !== undefined && !isItineraryDayWeather(day.weather)) return 'day_weather'
    if (!Array.isArray(day.stops) || day.stops.length > MAX_ITINERARY_STOPS_PER_DAY) return 'day_stops'

    for (let index = 0; index < day.stops.length; index += 1) {
      const stop = day.stops[index]
      if (!isRecord(stop) || !isBoundedString(stop.id, 1, 100) || !isBoundedString(stop.name, 1, 160) ||
        !isBoundedString(stop.area, 0, 120) || !isBoundedString(stop.time, 0, 40) ||
        !isBoundedString(stop.category, 0, 60) || !isBoundedString(stop.notes, 0, 500) ||
        !isBoundedString(stop.transitToNext, 0, 300)) return 'stop_text'
      if (stop.evidenceLevel !== undefined && !['sourced', 'estimated', 'pending'].includes(String(stop.evidenceLevel))) {
        return 'stop_evidence'
      }
      if (stop.sourceIds !== undefined && (!Array.isArray(stop.sourceIds) ||
        stop.sourceIds.length > MAX_ITINERARY_STOP_SOURCE_IDS || !stop.sourceIds.every(isString) ||
        new Set(stop.sourceIds).size !== stop.sourceIds.length)) return 'stop_sources'
      if (stop.factClaims !== undefined && (!Array.isArray(stop.factClaims) ||
        stop.factClaims.length > MAX_ITINERARY_FACT_CLAIMS_PER_STOP ||
        !stop.factClaims.every(isItineraryFactClaim) ||
        new Set(stop.factClaims.map((claim) => claim.id)).size !== stop.factClaims.length)) return 'stop_facts'
      if (stop.conditionalAlternatives !== undefined && (!Array.isArray(stop.conditionalAlternatives) ||
        stop.conditionalAlternatives.length > 3 || !stop.conditionalAlternatives.every(isItineraryConditionalAlternative))) {
        return 'stop_alternatives'
      }
      if (stop.evidenceLevel === 'sourced' && (!Array.isArray(stop.sourceIds) || stop.sourceIds.length === 0)) {
        return 'stop_evidence_sources'
      }
      if (stop.locked !== undefined && typeof stop.locked !== 'boolean') return 'stop_lock'
      const duration = stop.durationMinutes
      if (duration !== null && !(Number.isInteger(duration) && Number(duration) >= 0 && Number(duration) <= 720)) {
        return 'stop_duration'
      }
      const nextStop = day.stops[index + 1]
      const estimateMatchesNextStop = stop.transitEstimate === undefined ||
        (isRecord(stop.transitEstimate) && isRecord(nextStop) && stop.transitEstimate.destinationStopId === nextStop.id)
      if (stop.transitEstimate !== undefined && (!isTransitEstimate(stop.transitEstimate) ||
        !isBoundedString(stop.transitToNext, 1, 300) || !estimateMatchesNextStop)) return 'stop_route'
      if (stop.location !== undefined && !isItineraryLocation(stop.location)) return 'stop_location'
    }

    const lodgingCommutes = day.lodgingCommutes
    if (lodgingCommutes !== undefined && (!Array.isArray(lodgingCommutes) || lodgingCommutes.length > 2 ||
      !lodgingCommutes.every(isLodgingCommute) ||
      new Set(lodgingCommutes.map((commute) => commute.direction)).size !== lodgingCommutes.length ||
      lodgingCommutes.some((commute) => commute.stopId !==
        lodgingCommuteBoundaryStop(day.stops as ItineraryStop[], commute.direction)?.id))) return 'lodging_commutes'
  }

  const itinerary = value as unknown as ItineraryOption
  if (itinerary.mealRequirements && (
    new Set(itinerary.mealRequirements.map((requirement) => requirement.date)).size !== itinerary.mealRequirements.length ||
    itinerary.mealRequirements.some((requirement) => !itinerary.days.some((day) => day.date === requirement.date))
  )) return 'meal_requirement_dates'
  const ids = [
    itinerary.id,
    ...itinerary.days.flatMap((day) => [
      day.id,
      ...day.scheduleBlocks.map((block) => block.id),
      ...day.stops.flatMap((stop) => [stop.id, ...(stop.factClaims ?? []).map((claim) => claim.id)])
    ]),
    ...(itinerary.budgetEstimate?.items ?? []).map((item) => item.id)
  ]
  return new Set(ids).size === ids.length ? undefined : 'duplicate_ids'
}

/** 校验随候选保存的餐次硬约束，避免版本或备份丢失确认门规则。 */
function isItineraryMealRequirement(value: unknown): value is ItineraryMealRequirement {
  const slots: ItineraryMealSlot[] = ['breakfast', 'lunch', 'dinner']
  if (!isRecord(value) || !hasOnlyKeys(value, ['date', 'slots', 'excludedSlots', 'exclusive', 'requestedStartTimes']) ||
    !isString(value.date) || (value.date !== '' && !isCalendarDate(value.date))) return false
  const requestedSlots = value.slots
  if (!Array.isArray(requestedSlots) || requestedSlots.length > slots.length ||
    !requestedSlots.every((slot) => slots.includes(slot as ItineraryMealSlot)) ||
    new Set(requestedSlots).size !== requestedSlots.length ||
    (value.exclusive !== undefined && typeof value.exclusive !== 'boolean')) return false
  const excludedSlots = value.excludedSlots
  if (excludedSlots !== undefined && (!Array.isArray(excludedSlots) ||
    excludedSlots.length > slots.length ||
    !excludedSlots.every((slot) => slots.includes(slot as ItineraryMealSlot)) ||
    new Set(excludedSlots).size !== excludedSlots.length ||
    excludedSlots.some((slot) => requestedSlots.includes(slot)))) return false
  const requestedStarts = value.requestedStartTimes
  if (requestedStarts === undefined) return true
  if (!isRecord(requestedStarts) || !hasOnlyKeys(requestedStarts, slots)) return false
  return Object.entries(requestedStarts).every(([slot, times]) =>
    slots.includes(slot as ItineraryMealSlot) && Array.isArray(times) && times.length > 0 && times.length <= 3 &&
    times.every((time) => typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time)) &&
    new Set(times).size === times.length
  )
}

/** 校验预算分类完整性、单价数量和来源状态所需的持久化字段。 */
export function isItineraryBudgetEstimate(value: unknown): value is ItineraryBudgetEstimate {
  if (!isRecord(value) || !hasOnlyKeys(value, ['currency', 'items', 'notApplicableCategories']) || value.currency !== 'CNY' ||
    !Array.isArray(value.items) || value.items.length > 30 || !value.items.every(isItineraryBudgetItem) ||
    !Array.isArray(value.notApplicableCategories) || value.notApplicableCategories.length > BUDGET_COST_CATEGORIES.length ||
    !value.notApplicableCategories.every(isBudgetCategoryExclusion)) return false
  const excluded = value.notApplicableCategories.map((item) => item.category)
  if (new Set(excluded).size !== excluded.length) return false
  const itemCategories = new Set(value.items.map((item) => item.category))
  if (excluded.some((category) => itemCategories.has(category))) return false
  return BUDGET_COST_CATEGORIES.every((category) => itemCategories.has(category) || excluded.includes(category))
}

/** 单项金额是单价区间；汇总金额由应用按整数分和数量计算。 */
function isItineraryBudgetItem(value: unknown): value is ItineraryBudgetItem {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'category', 'title', 'amountMinFen', 'amountMaxFen', 'quantity', 'unitLabel', 'evidenceLevel', 'sourceIds', 'basis'
  ]) || !isBoundedString(value.id, 1, 100) || !isBudgetCostCategory(value.category) ||
    !isBoundedString(value.title, 1, 120) || !Number.isInteger(value.quantity) || Number(value.quantity) < 1 || Number(value.quantity) > 1_000 ||
    !isBoundedString(value.unitLabel, 1, 24) || !['sourced', 'estimated', 'pending'].includes(String(value.evidenceLevel)) ||
    !Array.isArray(value.sourceIds) || value.sourceIds.length > 5 || !value.sourceIds.every((id) => isBoundedString(id, 1, 100)) ||
    new Set(value.sourceIds).size !== value.sourceIds.length || !isBoundedString(value.basis, 1, 300)) return false
  const hasAmounts = Number.isSafeInteger(value.amountMinFen) && Number.isSafeInteger(value.amountMaxFen) &&
    Number(value.amountMinFen) >= 0 && Number(value.amountMaxFen) >= Number(value.amountMinFen) &&
    Number(value.amountMaxFen) <= 10_000_000_000 &&
    Number(value.amountMaxFen) * Number(value.quantity) <= Number.MAX_SAFE_INTEGER
  if (value.evidenceLevel === 'pending') return value.amountMinFen === null && value.amountMaxFen === null && value.sourceIds.length === 0
  return hasAmounts && (value.evidenceLevel !== 'sourced' || value.sourceIds.length > 0)
}

/** 预算排除项需要写明不适用的原因。 */
function isBudgetCategoryExclusion(value: unknown): value is { category: BudgetCostCategory; reason: string } {
  return isRecord(value) && hasOnlyKeys(value, ['category', 'reason']) &&
    isBudgetCostCategory(value.category) && isBoundedString(value.reason, 1, 200)
}

/** 限定到产品支持的国内旅行预算类别。 */
function isBudgetCostCategory(value: unknown): value is BudgetCostCategory {
  return typeof value === 'string' && BUDGET_COST_CATEGORIES.includes(value as BudgetCostCategory)
}

/** 校验非地点时间块，避免未定义字段被伪装成行程安排。 */
export function isItineraryScheduleBlock(value: unknown): value is ItineraryScheduleBlock {
  return isRecord(value) && isBoundedString(value.id, 1, 100) &&
    ['meal', 'rest', 'buffer'].includes(String(value.kind)) &&
    isBoundedString(value.title, 1, 100) && isBoundedString(value.time, 0, 40) &&
    (value.durationMinutes === null || (Number.isInteger(value.durationMinutes) && Number(value.durationMinutes) >= 1 && Number(value.durationMinutes) <= 720)) &&
    isBoundedString(value.area, 0, 120) && isBoundedString(value.notes, 0, 300)
}

/** 校验住宿路线的字段边界；端点和路线来源在旅行上下文中进一步核实。 */
function isLodgingCommute(value: unknown): value is LodgingCommute {
  if (!isRecord(value) || (value.direction !== 'from-lodging' && value.direction !== 'to-lodging') ||
    !isBoundedString(value.lodgingLocation, 1, 300) || !isBoundedString(value.stopId, 1, 100) ||
    !isBoundedString(value.sourceId, 1, 100) || !['transit', 'walking', 'driving'].includes(String(value.mode)) ||
    !Number.isInteger(value.optionNumber) || Number(value.optionNumber) < 1 || Number(value.optionNumber) > 3 ||
    (value.queryDate !== undefined && (!isString(value.queryDate) || !isCalendarDate(value.queryDate))) ||
    (value.queryTime !== undefined && (!isString(value.queryTime) || !/^(?:[01]?\d|2[0-3])-[0-5]\d$/.test(value.queryTime))) ||
    !(Number.isInteger(value.durationMinutes) && Number(value.durationMinutes) >= 1 && Number(value.durationMinutes) <= 1_440) ||
    !(value.distanceMeters === undefined || value.distanceMeters === null ||
      (Number.isInteger(value.distanceMeters) && Number(value.distanceMeters) >= 1 && Number(value.distanceMeters) <= 1_000_000))) return false
  return true
}

/** 限定事实字段的类型和长度，避免损坏的持久化内容伪装成可核验声明。 */
export function isItineraryFactClaim(value: unknown): value is ItineraryFactClaim {
  const types: ItineraryFactType[] = ['opening-hours', 'ticket-price', 'booking', 'closure', 'weather', 'transport-time', 'accessibility', 'sunset', 'photography-rules', 'other']
  if (!isRecord(value) || !isBoundedString(value.id, 1, 100) || !types.includes(value.type as ItineraryFactType) ||
    !isBoundedString(value.value, 1, 200) || !isBoundedString(value.scope, 0, 100) ||
    !['sourced', 'estimated', 'pending'].includes(String(value.evidenceLevel))) return false
  return (value.sourceId === undefined || isBoundedString(value.sourceId, 1, 100)) &&
    (value.evidenceLevel !== 'sourced' || isBoundedString(value.sourceId, 1, 100))
}

/** 验证条件备选的位置、触发条件和独立来源引用。 */
function isItineraryConditionalAlternative(value: unknown): value is ItineraryConditionalAlternative {
  if (!isRecord(value) || !hasOnlyKeys(value, ['name', 'area', 'trigger', 'evidenceLevel', 'sourceIds', 'environment']) ||
    !isBoundedString(value.name, 1, 160) || !isBoundedString(value.area, 0, 80) ||
    !isBoundedString(value.trigger, 1, 120) || !['sourced', 'pending'].includes(String(value.evidenceLevel)) ||
    (value.environment !== undefined && !['indoor', 'outdoor', 'unknown'].includes(String(value.environment))) ||
    !Array.isArray(value.sourceIds) || value.sourceIds.length > 3 || value.sourceIds.some((id) => !isBoundedString(id, 1, 100)) ||
    new Set(value.sourceIds).size !== value.sourceIds.length) return false
  return value.evidenceLevel === 'sourced' ? value.sourceIds.length > 0 : value.sourceIds.length === 0
}

/** 验证逐日天气状态及其可选天气来源引用。 */
function isItineraryDayWeather(value: unknown): value is ItineraryDayWeather {
  return isRecord(value) && hasOnlyKeys(value, ['status', 'summary', 'sourceId']) &&
    ['forecast', 'unknown'].includes(String(value.status)) && isBoundedString(value.summary, 1, 300) &&
    (value.sourceId === undefined || isBoundedString(value.sourceId, 1, 100)) &&
    (value.status !== 'forecast' || isBoundedString(value.sourceId, 1, 100))
}

/** 收集整套行程直接关联的来源 ID，供保存、校验和版本归档复用。 */
export function itinerarySourceIds(itinerary: ItineraryOption): string[] {
  return itinerary.days.flatMap((day) => [
    ...(day.weather?.sourceId ? [day.weather.sourceId] : []),
    ...day.stops.flatMap((stop) => [
      ...(stop.sourceIds ?? []),
      ...(stop.factClaims ?? []).flatMap((claim) => claim.sourceId ? [claim.sourceId] : []),
      ...(stop.transitEstimate ? [stop.transitEstimate.sourceId] : []),
      ...(stop.conditionalAlternatives ?? []).flatMap((alternative) => alternative.sourceIds),
      ...(stop.location ? [stop.location.sourceId] : [])
    ]),
    ...(day.lodgingCommutes ?? []).map((commute) => commute.sourceId)
  ]).concat(itinerary.budgetEstimate?.items.flatMap((item) => item.sourceIds) ?? [])
}

/** 验证并清理 renderer 提交的修改版行程，避免把无效数据写入本地快照。 */
export function normalizeEditedItinerary(value: unknown): ItineraryOption {
  if (hasInvalidItineraryCoordinates(value)) throw new Error('地图位置的经纬度无效，请重新定位后再保存。')
  if (!isItineraryOption(value)) throw new Error('修改后的行程字段无效，请检查日期、地点名称和文本长度。')
  const itinerary = clone(value)
  itinerary.title = itinerary.title.trim()
  itinerary.summary = itinerary.summary.trim()
  itinerary.tradeoffs = itinerary.tradeoffs.trim()
  // 任意手动编辑都可能改变住宿、票价或交通总量，必须重新生成预算。
  delete itinerary.budgetEstimate
  for (const day of itinerary.days) {
    day.date = day.date.trim()
    day.title = day.title.trim()
    for (const stop of day.stops) {
      stop.name = stop.name.trim()
      stop.area = stop.area.trim()
      stop.time = stop.time.trim()
      stop.category = stop.category.trim()
      stop.notes = stop.notes.trim()
      stop.transitToNext = stop.transitToNext.trim()
      stop.evidenceLevel ??= 'pending'
      stop.sourceIds ??= []
      stop.factClaims ??= []
      if (stop.location) stop.location.label = stop.location.label.trim()
    }
  }
  return itinerary
}

/** 在整份行程校验前识别坐标越界，给用户明确的修复指引。 */
function hasInvalidItineraryCoordinates(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.days)) return false
  return value.days.some((day) => isRecord(day) && Array.isArray(day.stops) && day.stops.some((stop) => {
    if (!isRecord(stop) || stop.location === undefined) return false
    const location = stop.location
    return !isRecord(location) || typeof location.latitude !== 'number' || !Number.isFinite(location.latitude) ||
      location.latitude < -90 || location.latitude > 90 || typeof location.longitude !== 'number' ||
      !Number.isFinite(location.longitude) || location.longitude < -180 || location.longitude > 180 ||
      (location.coordinateSystem !== 'wgs84' && location.coordinateSystem !== 'gcj02')
  }))
}

/** 检查当前旅行、独立话题、消息、来源和版本的基本类型约束。 */
export function isTrip(value: unknown, requireCompleteBrief: boolean): value is Trip {
  return isTripShape(value, requireCompleteBrief, false)
}

/** 校验尚未迁移的话题数据；只供本地 schema 和旧备份迁移入口使用。 */
export function isLegacyTrip(value: unknown, requireCompleteBrief: boolean): value is LegacyTrip {
  return isTripShape(value, requireCompleteBrief, true)
}

/** 共用旅行关系校验，同时拒绝消息指向不存在话题的损坏记录。 */
function isTripShape(value: unknown, requireCompleteBrief: boolean, legacy: boolean): boolean {
  if (!isRecord(value) || !isString(value.id) || !isString(value.title) || !isString(value.createdAt) || !isString(value.updatedAt)) return false
  const brief = value.brief
  if (!isRecord(brief) || !Array.isArray(value.messages) || !Array.isArray(value.sources) || !Array.isArray(value.revisions)) return false
  if (legacy) {
    if ('conversations' in value || 'activeConversationId' in value || !value.messages.every(isLegacyChatMessage)) return false
  } else {
    if (!Array.isArray(value.conversations) || value.conversations.length === 0 ||
      !value.conversations.every(isTripConversation) || !value.messages.every(isChatMessage) ||
      !Array.isArray(value.briefUnknownFields)) return false
    const conversations = value.conversations as TripConversation[]
    const conversationIds = new Set(conversations.map((conversation) => conversation.id))
    const messageIds = (value.messages as ChatMessage[]).map((message) => message.id)
    if (conversationIds.size !== conversations.length || new Set(messageIds).size !== messageIds.length ||
      !isString(value.activeConversationId) || !conversationIds.has(value.activeConversationId) ||
      (value.messages as ChatMessage[]).some((message) => !conversationIds.has(message.conversationId))) return false
  }
  const briefKeys: Array<keyof TripBrief> = [
    'departureCity', 'destination', 'startDate', 'endDate', 'arrivalFlight', 'arrivalTime', 'leaveTime', 'travelers',
    'budget', 'lodgingLocation', 'lodging', 'pace', 'earlyStart', 'interests', 'transport', 'dietary', 'luggage', 'clothing', 'constraints'
  ]
  const legacyBriefKeys: Array<keyof TripBrief> = ['departureCity', 'destination', 'startDate', 'endDate', 'travelers', 'budget', 'pace', 'interests', 'constraints']
  const checkedKeys = requireCompleteBrief ? briefKeys : legacyBriefKeys
  if (!checkedKeys.every((key) => isString(brief[key]))) return false
  if (Object.values(brief).some((field) => !isString(field))) return false
  if (!legacy && normalizeTripBriefUnknownFields(value.briefUnknownFields, brief as unknown as TripBrief) === null) return false
  if (!value.sources.every(isSource) || !value.revisions.every(isRevision)) return false
  const sourceIds = new Set((value.sources as SourceRecord[]).map((source) => source.id))
  const sources = value.sources as SourceRecord[]
  const preparationItems = [
    ...(value.messages as ChatMessage[]).flatMap((message) => message.preparationOptions ?? []),
    ...(Array.isArray(value.preparationItems) ? value.preparationItems as PreparationItem[] : [])
  ]
  if (preparationItems.some((item) => {
    const location = item.locationContext
    if (!location) return false
    const placeSource = sources.find((source) => source.id === location.placeSourceId)
    if (!item.sourceIds.includes(location.placeSourceId) || !placeSource || placeSource.kind !== 'place' ||
      placeSource.status !== 'success' || !placeNamesMatch(placeSource.title, location.placeName) ||
      !placeNamesMatch(item.title, location.placeName)) return true
    if (!location.routeSourceId) return false
    const routeOptionNumber = location.routeOptionNumber
    if (routeOptionNumber === undefined) return true
    const routeSource = sources.find((source) => source.id === location.routeSourceId)
    return !item.sourceIds.includes(location.routeSourceId) || !routeSource || routeSource.kind !== 'route' ||
      routeSource.status !== 'success' || !routeTitleMatchesEndpoints(routeSource.title, location.stopName, location.placeName) ||
      !routeSummarySupportsMetrics(
        routeSource.summary, routeOptionNumber, location.distanceMeters, location.durationMinutes
      )
  })) return false
  // 历史行程只要求来源记录仍存在；新方案采纳时另行校验来源成功状态。
  const referencedIds = [
    ...(value.messages as ChatMessage[]).flatMap((message) => [
      ...message.sourceIds,
      ...(message.agentRunProgress?.sourceIds ?? []),
      ...(message.preparationOptions ?? []).flatMap((item) => item.sourceIds),
      ...(message.itineraryOptions ?? []).flatMap((option) => itinerarySourceIds(option))
    ]),
    ...(value.revisions as ItineraryRevision[]).flatMap((revision) => [
      ...revision.sourceIds,
      ...(revision.itinerary ? itinerarySourceIds(revision.itinerary) : [])
    ]),
    ...(Array.isArray(value.preparationItems) ? (value.preparationItems as PreparationItem[]).flatMap((item) => item.sourceIds) : [])
  ]
  if (referencedIds.some((id) => !sourceIds.has(id))) return false
  const lodgingRouteIds = [
    ...(value.messages as ChatMessage[]).flatMap((message) => (message.itineraryOptions ?? []).flatMap((option) =>
      option.days.flatMap((day) => (day.lodgingCommutes ?? []).map((commute) => commute.sourceId)))),
    ...(value.revisions as ItineraryRevision[]).flatMap((revision) => revision.itinerary?.days.flatMap((day) =>
      (day.lodgingCommutes ?? []).map((commute) => commute.sourceId)) ?? [])
  ]
  if (lodgingRouteIds.some((id) => !sources.some((source) => source.id === id && source.kind === 'route'))) return false
  const itineraryWeatherSourceIds = [
    ...(value.messages as ChatMessage[]).flatMap((message) => (message.itineraryOptions ?? []).flatMap((option) =>
      option.days.flatMap((day) => day.weather?.sourceId ? [day.weather.sourceId] : []))),
    ...(value.revisions as ItineraryRevision[]).flatMap((revision) => revision.itinerary?.days.flatMap((day) =>
      day.weather?.sourceId ? [day.weather.sourceId] : []) ?? [])
  ]
  if (itineraryWeatherSourceIds.some((id) => !sources.some((source) => source.id === id && source.kind === 'weather'))) return false
  if (!(value.revisions as ItineraryRevision[]).every((revision) =>
    !revision.itinerary || revision.itinerary.days.every((day) => day.stops.every((stop) =>
      (stop.sourceIds ?? []).every((id) => sourceIds.has(id)) &&
      (!stop.location || sourceIds.has(stop.location.sourceId)) &&
      (!stop.transitEstimate || (sourceIds.has(stop.transitEstimate.sourceId) &&
        (value.sources as SourceRecord[]).some((source) => source.id === stop.transitEstimate?.sourceId && source.kind === 'route') &&
        stop.transitEstimate.destinationStopId === day.stops[day.stops.findIndex((item) => item.id === stop.id) + 1]?.id))
    ))
  )) return false
  if (value.preparationItems !== undefined && (!Array.isArray(value.preparationItems) || !value.preparationItems.every(isPreparationItem))) return false
  if (value.activeRevisionId !== null && !isString(value.activeRevisionId)) return false
  return value.revisions.some((revision) => revision.id === value.activeRevisionId) || value.activeRevisionId === null
}

/** 校验话题摘要字段，标题和时间戳必须可安全用于侧栏列表。 */
function isTripConversation(value: unknown): value is TripConversation {
  return isRecord(value) && isBoundedString(value.id, 1, 100) && isBoundedString(value.title, 1, 100) &&
    isString(value.createdAt) && isString(value.updatedAt)
}

/** 旧数据消息还没有 conversationId；先用哨兵字段验证其余契约。 */
function isLegacyChatMessage(value: unknown): boolean {
  return isRecord(value) && value.conversationId === undefined &&
    isChatMessage({ ...value, conversationId: 'legacy-conversation' })
}

/** 校验本地数据的当前结构，未知或损坏格式不能覆盖用户文件。 */
export function isDatabase(value: unknown): value is Database {
  if (!isRecord(value) || value.schemaVersion !== 16 || !Array.isArray(value.trips) || !isSettings(value.settings)) return false
  if (!value.trips.every((trip) => isTrip(trip, true) && Array.isArray(trip.preparationItems))) return false
  const tripIds = value.trips.map((trip) => (trip as Trip).id)
  if (new Set(tripIds).size !== tripIds.length) return false
  const selectedTripId = value.selectedTripId
  return (selectedTripId === null || isString(selectedTripId)) &&
    (selectedTripId === null || value.trips.some((trip) => trip.id === selectedTripId))
}

/** 校验不含凭证的服务商设置。 */
export function isSettings(value: unknown): value is AppSettings {
  return isRecord(value) && isRecord(value.model) &&
    isString(value.model.baseUrl) && isString(value.model.model) &&
    (value.model.provider === undefined || value.model.provider === 'openai-compatible' || value.model.provider === 'codex-cli') &&
    isNormalizedSourceProxy(value.sourceProxyUrl) &&
    isConnectorSettings(value.connectors) &&
    isOpenCliSettings(value.xiaohongshu) &&
    typeof value.researchBrowserVisualRead === 'boolean' &&
    Array.isArray(value.mcpServers) && value.mcpServers.length <= 8 && value.mcpServers.every(isMcpServerSettings) &&
    new Set(value.mcpServers.map((server) => server.id)).size === value.mcpServers.length
}

/** 校验旧版或当前模型设置，并补齐未保存过的连接器选项。 */
export function normalizeSettings(value: unknown): AppSettings | null {
  if (!isRecord(value) || !isRecord(value.model) || !isString(value.model.baseUrl) || !isString(value.model.model)) return null
  if (value.sourceProxyUrl !== undefined && typeof value.sourceProxyUrl !== 'string') return null
  let sourceProxyUrl: string
  try {
    sourceProxyUrl = normalizeSourceProxy(value.sourceProxyUrl ?? '')
  } catch {
    return null
  }
  if (value.connectors !== undefined && !isConnectorSettings(value.connectors)) return null
  if (value.xiaohongshu !== undefined && !isOpenCliSettings(value.xiaohongshu)) return null
  if (value.researchBrowserVisualRead !== undefined && typeof value.researchBrowserVisualRead !== 'boolean') return null
  if (value.mcpServers !== undefined && (!Array.isArray(value.mcpServers) || value.mcpServers.length > 8 ||
    !value.mcpServers.every(isMcpServerSettings) ||
    new Set(value.mcpServers.map((server) => server.id)).size !== value.mcpServers.length)) return null
  const provider = value.model.provider ?? 'openai-compatible'
  if (provider !== 'openai-compatible' && provider !== 'codex-cli') return null
  return {
    model: { provider, baseUrl: value.model.baseUrl, model: value.model.model },
    sourceProxyUrl,
    connectors: value.connectors === undefined
      ? { webSearch: true, weather: true, places: true, routes: true }
      : clone(value.connectors),
    xiaohongshu: value.xiaohongshu === undefined
      ? { enabled: false, command: '', args: [] }
      : clone(value.xiaohongshu),
    researchBrowserVisualRead: value.researchBrowserVisualRead === true,
    mcpServers: value.mcpServers === undefined ? [] : clone(value.mcpServers)
  }
}

/** 校验 OpenCLI 命令和参数前缀；不能把命令行文本拼成 shell 脚本。 */
function isOpenCliSettings(value: unknown): value is AppSettings['xiaohongshu'] {
  return isRecord(value) && hasOnlyKeys(value, ['enabled', 'command', 'args']) &&
    typeof value.enabled === 'boolean' && isBoundedString(value.command, 0, 1_024) && !value.command.includes('\0') &&
    (value.command.trim() === '' || isAbsolute(value.command.trim())) && (!value.enabled || value.command.trim() !== '') &&
    Array.isArray(value.args) && value.args.length <= 16 &&
    value.args.every((arg) => isBoundedString(arg, 0, 1_024) && !arg.includes('\0'))
}

/** 校验 MCP 进程参数和逐工具授权，拒绝不受支持的设置字段。 */
function isMcpServerSettings(value: unknown): value is McpServerSettings {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'name', 'transport', 'command', 'args', 'url', 'auth', 'envKeys', 'enabled', 'allowedTools'
  ]) || !isBoundedString(value.id, 1, 80) || !/^[a-zA-Z0-9_-]+$/.test(value.id) ||
    !isBoundedString(value.name, 1, 80) || !Array.isArray(value.args) || value.args.length > 40 ||
    !value.args.every((arg) => isBoundedString(arg, 0, 1_000) && !arg.includes('\0')) ||
    !Array.isArray(value.envKeys) || value.envKeys.length > 20 || !value.envKeys.every((key) =>
      isBoundedString(key, 1, 100) && /^[A-Z_][A-Z0-9_]*$/.test(key)) || new Set(value.envKeys).size !== value.envKeys.length ||
    typeof value.enabled !== 'boolean' || !Array.isArray(value.allowedTools) || value.allowedTools.length > 50 ||
    !value.allowedTools.every((tool) => isBoundedString(tool, 1, 128)) || new Set(value.allowedTools).size !== value.allowedTools.length) return false

  const transport = value.transport ?? 'stdio'
  if (transport === 'stdio') {
    return isBoundedString(value.command, 1, 512) && !value.command.includes('\0') &&
      value.url === undefined && value.auth === undefined
  }
  if (transport !== 'streamable-http' && transport !== 'sse') return false
  if (value.command !== '' || value.args.length > 0 || typeof value.url !== 'string') return false
  try {
    if (normalizeRemoteMcpUrl(value.url) !== value.url) return false
  } catch {
    return false
  }
  return isMcpServerAuth(value.auth, value.envKeys, value.url)
}

/** 校验远程认证只保存凭证引用，不允许普通设置携带认证值。 */
function isMcpServerAuth(value: unknown, envKeys: string[], remoteUrl: string): boolean {
  if (!isRecord(value)) return false
  if (value.type === 'none') return hasOnlyKeys(value, ['type'])
  if (value.type === 'query' && value.credential === 'amapKey') {
    return hasOnlyKeys(value, ['type', 'name', 'credential']) && value.name === 'key' &&
      new URL(remoteUrl).hostname === 'mcp.amap.com' && !new URL(remoteUrl).searchParams.has('key')
  }
  if ((value.type !== 'header' && value.type !== 'query') ||
    !hasOnlyKeys(value, ['type', 'name', 'envKey']) || typeof value.name !== 'string' ||
    typeof value.envKey !== 'string' || !envKeys.includes(value.envKey)) return false
  return value.type === 'header'
    ? /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(value.name) &&
      !/^(?:host|content-length|connection|transfer-encoding|cookie|origin|mcp-session-id|mcp-protocol-version)$/i.test(value.name)
    : /^[A-Za-z0-9_.~-]{1,100}$/.test(value.name) && !new URL(remoteUrl).searchParams.has(value.name)
}

/** 明确限制外部配置对象的字段，防止持久化未定义设置。 */
export function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

/** 连接器配置只允许四个已内置能力的布尔开关。 */
function isConnectorSettings(value: unknown): value is AppSettings['connectors'] {
  return isRecord(value) && ['webSearch', 'weather', 'places', 'routes'].every((key) => typeof value[key] === 'boolean')
}

/** 校验持久化准备项，避免未知分类或来源引用进入清单界面。 */
export function isPreparationItem(value: unknown): value is PreparationItem {
  const validPackingSection = isRecord(value) && (value.packingSection === undefined ||
    (value.category === 'packing' && typeof value.packingSection === 'string' && PACKING_SECTIONS.includes(value.packingSection as PackingSection)))
  const validLocationContext = isRecord(value) && (value.locationContext === undefined ||
    (['food', 'alternative'].includes(String(value.category)) && isPreparationLocationContext(value.locationContext)))
  /** 适用日与截止日仅接受空值或有效日历日期。 */
  const validDate = (date: unknown): boolean => isString(date) && (date === '' || isCalendarDate(date))
  const validLegacyDate = !isRecord(value) || value.legacyDate === undefined || isString(value.legacyDate)
  return isRecord(value) && isString(value.id) && isString(value.title) && isString(value.detail) && validPackingSection &&
    validLocationContext &&
    validDate(value.itineraryDate) && validDate(value.dueDate) && validLegacyDate && typeof value.checked === 'boolean' && Array.isArray(value.sourceIds) &&
    value.sourceIds.every(isString) &&
    ['booking', 'packing', 'clothing', 'food', 'alternative', 'transport', 'other'].includes(String(value.category)) &&
    ['sourced', 'estimated', 'pending'].includes(String(value.evidenceLevel))
}

/** 验证餐饮/备选关联快照及可追溯的路线指标。 */
export function isPreparationLocationContext(value: unknown): value is PreparationLocationContext {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'dayNumber', 'dayTitle', 'stopId', 'stopName', 'area', 'placeSourceId', 'placeName',
    'routeOptionNumber', 'distanceMeters', 'durationMinutes', 'routeSourceId'
  ]) || !Number.isInteger(value.dayNumber) || Number(value.dayNumber) < 1 || Number(value.dayNumber) > 7 ||
    !isBoundedString(value.dayTitle, 1, 100) || !isBoundedString(value.stopId, 1, 100) ||
    !isBoundedString(value.placeSourceId, 1, 100) || !isBoundedString(value.placeName, 1, 160) ||
    !isBoundedString(value.stopName, 1, 160) || !isBoundedString(value.area, 0, 120)) return false
  const validDistance = value.distanceMeters === undefined ||
    (Number.isInteger(value.distanceMeters) && Number(value.distanceMeters) >= 1 && Number(value.distanceMeters) <= 1_000_000)
  const validDuration = value.durationMinutes === undefined ||
    (Number.isInteger(value.durationMinutes) && Number(value.durationMinutes) >= 1 && Number(value.durationMinutes) <= 1_440)
  const hasRouteMetric = value.distanceMeters !== undefined || value.durationMinutes !== undefined
  return validDistance && validDuration &&
    (hasRouteMetric
      ? isBoundedString(value.routeSourceId, 1, 100) && Number.isInteger(value.routeOptionNumber) && Number(value.routeOptionNumber) >= 1 && Number(value.routeOptionNumber) <= 3
      : value.routeSourceId === undefined && value.routeOptionNumber === undefined)
}

/** 校验用户修改的标题、说明和日期，不接受字段外的数据。 */
export function normalizePreparationItemUpdate(value: unknown): PreparationItemUpdate {
  /** 更新日期仅允许留空或符合日历格式。 */
  const validDate = (date: unknown): date is string => isString(date) && date.length <= 10 && (date === '' || isCalendarDate(date))
  /** 旧版歧义日期必须被明确归类或清除。 */
  const validLegacyDateAction = (action: unknown): action is NonNullable<PreparationItemUpdate['legacyDateAction']> =>
    action === 'itinerary' || action === 'deadline' || action === 'clear'
  if (!isRecord(value) || !isBoundedString(value.title, 1, 120) || !isBoundedString(value.detail, 1, 600) ||
    !validDate(value.itineraryDate) || !validDate(value.dueDate) ||
    (value.legacyDateAction !== undefined && !validLegacyDateAction(value.legacyDateAction)) ||
    (value.packingSection !== undefined && !PACKING_SECTIONS.includes(value.packingSection as PackingSection)) ||
    Object.keys(value).some((key) => !['title', 'detail', 'itineraryDate', 'dueDate', 'legacyDateAction', 'packingSection'].includes(key))) {
    throw new Error('准备事项修改无效；标题、说明、适用日期和截止日期请检查后重试。')
  }
  return {
    title: value.title.trim(), detail: value.detail.trim(),
    itineraryDate: value.itineraryDate.trim(), dueDate: value.dueDate.trim(),
    ...(value.legacyDateAction === undefined ? {} : { legacyDateAction: value.legacyDateAction as PreparationItemUpdate['legacyDateAction'] }),
    ...(value.packingSection === undefined ? {} : { packingSection: value.packingSection as PackingSection })
  }
}

/** 只接受普通对象，拒绝数组和 null 作为数据库记录。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 检查持久化字符串字段。 */
export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** 校验用户编辑字段长度，避免无界文本进入本地文档和模型上下文。 */
function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max
}

/** 校验非空旅行日期是真实日历日期，而不是外观相似的错误值。 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

/** 校验用户消息和助手消息中的可选方案。 */
export function isChatMessage(value: unknown): value is ChatMessage {
  const itineraryOptions = isRecord(value) && Array.isArray(value.itineraryOptions) ? value.itineraryOptions : []
  const rejectedIds = isRecord(value) ? value.rejectedItineraryOptionIds : undefined
  return isRecord(value) && isString(value.id) && isBoundedString(value.conversationId, 1, 100) &&
    (value.role === 'user' || value.role === 'assistant') &&
    isString(value.content) && isString(value.createdAt) && Array.isArray(value.sourceIds) &&
    value.sourceIds.every(isString) &&
    (value.itineraryOptions === undefined || (Array.isArray(value.itineraryOptions) && value.itineraryOptions.every(isItineraryOption))) &&
    (rejectedIds === undefined || (value.role === 'assistant' && Array.isArray(rejectedIds) &&
      rejectedIds.every(isString) && new Set(rejectedIds).size === rejectedIds.length &&
      rejectedIds.every((id) => itineraryOptions.some((option) => isRecord(option) && option.id === id)))) &&
    (value.preparationOptions === undefined || (Array.isArray(value.preparationOptions) && value.preparationOptions.every(isPreparationItem))) &&
    (value.briefProposal === undefined || isTripBriefProposal(value.briefProposal)) &&
    (value.agentRunProgress === undefined || (value.role === 'user' && isAgentRunProgress(value.agentRunProgress))) &&
    (value.briefProposalAppliedAt === undefined || isString(value.briefProposalAppliedAt))
}

/** 校验本地恢复点，限制工具轮次体积并拒绝无法对应的工具结果。 */
export function isAgentRunProgress(value: unknown): value is AgentRunProgress {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'transcript', 'sourceIds', 'itineraryOptions', 'preparationOptions', 'briefProposal', 'updatedAt'
  ]) || !Array.isArray(value.transcript) || value.transcript.length > MAX_AGENT_RUN_TRANSCRIPT_MESSAGES ||
    !Array.isArray(value.sourceIds) || value.sourceIds.length > MAX_AGENT_RUN_SOURCE_IDS ||
    !value.sourceIds.every((id) => isBoundedString(id, 1, 100)) || new Set(value.sourceIds).size !== value.sourceIds.length ||
    !Array.isArray(value.itineraryOptions) || value.itineraryOptions.length > 3 || !value.itineraryOptions.every(isItineraryOption) ||
    !Array.isArray(value.preparationOptions) || value.preparationOptions.length > 30 || !value.preparationOptions.every(isPreparationItem) ||
    !isString(value.updatedAt) ||
    (value.briefProposal !== undefined && !isTripBriefProposal(value.briefProposal))) return false

  let totalTextLength = 0
  const pendingCallIds = new Set<string>()
  for (const rawMessage of value.transcript) {
    if (!isAgentRunTranscriptMessage(rawMessage)) return false
    totalTextLength += rawMessage.content?.length ?? 0
    if (rawMessage.role === 'assistant') {
      totalTextLength += rawMessage.allowedToolNames?.reduce((length, name) => length + name.length, 0) ?? 0
      if (pendingCallIds.size > 0) return false
      for (const call of rawMessage.tool_calls ?? []) {
        if (pendingCallIds.has(call.id)) return false
        pendingCallIds.add(call.id)
        totalTextLength += call.function.name.length + call.function.arguments.length
      }
    } else if (rawMessage.role === 'tool') {
      if (!pendingCallIds.has(rawMessage.tool_call_id!)) return false
      pendingCallIds.delete(rawMessage.tool_call_id!)
    } else if (pendingCallIds.size > 0) {
      return false
    }
    if (totalTextLength > 2_000_000) return false
  }
  return true
}

/** 只持久化模型工具轮次、格式修正往返和内部指令，不含系统提示词。 */
function isAgentRunTranscriptMessage(value: unknown): value is AgentRunTranscriptMessage {
  if (!isRecord(value) || !['assistant', 'tool', 'user'].includes(String(value.role)) ||
    !hasOnlyKeys(value, ['role', 'content', 'tool_call_id', 'tool_calls', 'allowedToolNames', 'researchOnly']) ||
    (value.content !== undefined && value.content !== null && !isString(value.content))) return false
  if (value.role === 'user') {
    return isString(value.content) && value.tool_call_id === undefined &&
      value.tool_calls === undefined && value.allowedToolNames === undefined && value.researchOnly === undefined
  }
  if (value.role === 'tool') {
    return isBoundedString(value.tool_call_id, 1, 100) && isString(value.content) &&
      value.tool_calls === undefined && value.allowedToolNames === undefined && value.researchOnly === undefined
  }
  if (value.tool_call_id !== undefined || (value.researchOnly !== undefined && value.researchOnly !== true)) return false
  // 模型格式错误时保留普通 assistant 回合和修正提示，支持中断后继续自我修正。
  if (value.tool_calls === undefined) {
    return isString(value.content) && value.allowedToolNames === undefined && value.researchOnly === undefined
  }
  if (!Array.isArray(value.tool_calls) || value.tool_calls.length < 1 || value.tool_calls.length > MAX_TOOL_CALLS_PER_MESSAGE ||
    (value.allowedToolNames !== undefined && (!Array.isArray(value.allowedToolNames) || value.allowedToolNames.length > 256 ||
      !value.allowedToolNames.every((name) => isBoundedString(name, 1, 160)) ||
      new Set(value.allowedToolNames).size !== value.allowedToolNames.length))) return false
  return value.tool_calls.every((rawCall) => isRecord(rawCall) &&
    hasOnlyKeys(rawCall, ['id', 'type', 'function']) && isBoundedString(rawCall.id, 1, 100) && rawCall.type === 'function' &&
    isRecord(rawCall.function) && hasOnlyKeys(rawCall.function, ['name', 'arguments']) &&
    isBoundedString(rawCall.function.name, 1, 160) &&
    isBoundedString(rawCall.function.arguments, 0, rawCall.function.name === 'propose_itineraries'
      ? MAX_ITINERARY_ARGUMENT_CHARACTERS
      : MAX_TOOL_ARGUMENT_CHARACTERS))
}

/** 验证提案变更及其基准字段一一对应，避免任意对象进入旅行资料。 */
function isTripBriefProposal(value: unknown): value is TripBriefProposal {
  if (!isRecord(value) || !isRecord(value.base) || !isRecord(value.changes)) return false
  const base = value.base
  const changes = value.changes
  const fields: Array<keyof TripBrief> = [
    'departureCity', 'destination', 'startDate', 'endDate', 'arrivalFlight', 'arrivalTime', 'leaveTime', 'travelers',
    'budget', 'lodgingLocation', 'lodging', 'pace', 'earlyStart', 'interests', 'transport', 'dietary', 'luggage', 'clothing', 'constraints'
  ]
  const baseKeys = Object.keys(base)
  const changeKeys = Object.keys(changes)
  return changeKeys.length > 0 && baseKeys.length === changeKeys.length &&
    changeKeys.every((key) => fields.includes(key as keyof TripBrief) && isString(base[key]) && isString(changes[key])) &&
    baseKeys.every((key) => changeKeys.includes(key))
}

/** 把并发冲突中的字段名转换成旅行信息表单标签。 */
export function briefFieldLabel(key: string): string {
  const labels: Partial<Record<keyof TripBrief, string>> = {
    departureCity: '出发地', destination: '目的地', startDate: '出发日期', endDate: '返程日期', arrivalFlight: '抵达航班',
    arrivalTime: '抵达时间', leaveTime: '离开时间', travelers: '同行人', budget: '预算', lodgingLocation: '具体住宿地点', lodging: '住宿区域与偏好',
    pace: '体力节奏', earlyStart: '是否早起', interests: '兴趣点', transport: '交通偏好', dietary: '忌口与饮食',
    luggage: '行李限制', clothing: '穿搭与已有衣物', constraints: '其他约束'
  }
  return labels[key as keyof TripBrief] ?? key
}

/** 校验来源记录的状态、类型和展示字段。 */
export function isSource(value: unknown): value is SourceRecord {
  return isRecord(value) && isString(value.id) && isString(value.title) && isString(value.url) &&
    isString(value.provider) && ['web', 'weather', 'place', 'route', 'user', 'plugin'].includes(String(value.kind)) &&
    isString(value.summary) && isString(value.fetchedAt) && ['success', 'partial', 'unavailable', 'error'].includes(String(value.status)) &&
    (value.sourceNature === undefined || ['government-domain', 'community-platform', 'service', 'user-provided', 'unclassified'].includes(String(value.sourceNature))) &&
    (value.contentLevel === undefined || ['snippet', 'page', 'visual-clue', 'structured', 'user-provided', 'plugin', 'status'].includes(String(value.contentLevel))) &&
    (value.factEvidenceExcerpt === undefined || isBoundedString(value.factEvidenceExcerpt, 1, 2_400)) &&
    (value.declaredAuthor === undefined || isBoundedString(value.declaredAuthor, 1, 120)) &&
    (value.declaredPublishedAt === undefined || isBoundedString(value.declaredPublishedAt, 1, 100)) &&
    (value.connectorId === undefined || isBoundedString(value.connectorId, 1, 100)) &&
    (value.location === undefined || isGeoLocation(value.location)) &&
    (value.retry === undefined || (value.status !== 'success' && isSourceRetry(value.retry) && isRetryForSource(value.retry, value))) &&
    (value.retrySkippedAt === undefined || (value.status !== 'success' && value.retry === undefined && isString(value.retrySkippedAt)))
}

/** MCP 重试只能附着在匹配同一服务 ID 的插件来源上，防止备份伪装来源类型。 */
function isRetryForSource(retry: SourceRetry, source: Record<string, unknown>): boolean {
  return !('kind' in retry) || (source.kind === 'plugin' && source.connectorId === retry.serverId)
}

/** MCP 多工具常用空链接；按服务、工具标题和链接去重，保留各工具结果。 */
export function sameSourceIdentity(left: SourceRecord, right: SourceRecord): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'user' && (!left.url || !right.url)) return false
  if (left.kind !== 'plugin') return left.url === right.url && left.provider === right.provider
  const sameConnector = !left.connectorId || !right.connectorId || left.connectorId === right.connectorId
  return sameConnector && left.title === right.title && left.url === right.url && left.provider === right.provider
}

/** 更新来源渠道与页面自报元数据；缺省值表示本次没有可保留的声明。 */
export function updateSourceMetadata(target: SourceRecord, source: SourceRecord): void {
  if (source.sourceNature) target.sourceNature = source.sourceNature
  else delete target.sourceNature
  if (source.contentLevel) target.contentLevel = source.contentLevel
  else delete target.contentLevel
  if (source.factEvidenceExcerpt) target.factEvidenceExcerpt = source.factEvidenceExcerpt
  else delete target.factEvidenceExcerpt
  if (source.declaredAuthor) target.declaredAuthor = source.declaredAuthor
  else delete target.declaredAuthor
  if (source.declaredPublishedAt) target.declaredPublishedAt = source.declaredPublishedAt
  else delete target.declaredPublishedAt
  if (source.connectorId) target.connectorId = source.connectorId
  else delete target.connectorId
}

/** 校验来源重试白名单，只允许保存不含凭证的查询参数。 */
function isSourceRetry(value: unknown): value is SourceRetry {
  if (!isRecord(value)) return false
  if (value.kind === 'mcp-connect') {
    return hasOnlyKeys(value, ['kind', 'serverId']) && isBoundedString(value.serverId, 1, 100)
  }
  if (value.kind === 'mcp-tool') {
    return hasOnlyKeys(value, ['kind', 'serverId', 'toolName', 'arguments']) &&
      isBoundedString(value.serverId, 1, 100) && isBoundedString(value.toolName, 1, 128) &&
      /^[a-zA-Z0-9_.-]+$/.test(value.toolName) && isSafeMcpRetryArguments(value.arguments)
  }
  if (!hasOnlyKeys(value, ['toolName', 'arguments']) || !isRecord(value.arguments)) return false
  const args = value.arguments
  /** 限制每种重试工具只接收白名单内的参数名。 */
  const hasOnly = (allowed: string[]): boolean => Object.keys(args).every((key) => allowed.includes(key))
  /** 校验白名单文本参数的必填状态和最大长度。 */
  const bounded = (key: string, max: number, required = true): boolean => {
    const field = args[key]
    return required ? isBoundedString(field, 1, max) : field === undefined || isBoundedString(field, 0, max)
  }
  if (value.toolName === 'search_web') return hasOnly(['query']) && bounded('query', 180)
  if (value.toolName === 'read_webpage') return hasOnly(['url']) && bounded('url', 4_000)
  if (value.toolName === 'search_xiaohongshu') {
    const limit = args.limit
    return hasOnly(['query', 'limit']) && bounded('query', 100) &&
      (limit === undefined || (Number.isInteger(limit) && Number(limit) >= 1 && Number(limit) <= 5))
  }
  if (value.toolName === 'read_xiaohongshu_note') {
    if (!hasOnly(['url']) || !bounded('url', 2_000)) return false
    try {
      const url = new URL(String(args.url))
      return url.protocol === 'https:' && ['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname.toLowerCase()) &&
        /^\/(?:search_result|explore|note)\/[0-9a-f]{24}\/?$/i.test(url.pathname)
    } catch {
      return false
    }
  }
  if (value.toolName === 'find_places') {
    return hasOnly(['city', 'query', 'near_stop_id']) && bounded('city', 80) && bounded('query', 100) &&
      bounded('near_stop_id', 100, false)
  }
  if (value.toolName === 'get_weather') {
    return hasOnly(['city', 'start_date', 'end_date']) && bounded('city', 80) && bounded('start_date', 10, false) && bounded('end_date', 10, false)
  }
  return false
}

/** MCP 工具参数只允许有限深度与体积的 JSON 数据，不接受函数、凭证字段或任意对象。 */
/** 校验可供地图使用的经纬度，并显式保留供应商坐标系。 */
export function isGeoLocation(value: unknown): value is GeoLocation {
  return isRecord(value) && typeof value.latitude === 'number' && Number.isFinite(value.latitude) && value.latitude >= -90 && value.latitude <= 90 &&
    typeof value.longitude === 'number' && Number.isFinite(value.longitude) && value.longitude >= -180 && value.longitude <= 180 &&
    isBoundedString(value.label, 1, 300) && (value.coordinateSystem === 'wgs84' || value.coordinateSystem === 'gcj02')
}

/** 行程定位还必须记录来源、提供方和查询时间。 */
export function isItineraryLocation(value: unknown): value is ItineraryLocation {
  return isRecord(value) && isGeoLocation(value) && isBoundedString(value.sourceId, 1, 100) &&
    isBoundedString(value.provider, 1, 100) && isString(value.fetchedAt)
}

/** 校验被用户采纳的路线估算及其来源标识。 */
export function isTransitEstimate(value: unknown): value is NonNullable<ItineraryStop['transitEstimate']> {
  if (!isRecord(value)) return false
  /** 路线距离与时长必须是非负有限数，指定项为整数。 */
  const validMetric = (key: string, integer = false): boolean => {
    if (!(key in value) || value[key] === null) return true
    const metric = value[key]
    return typeof metric === 'number' && Number.isFinite(metric) && metric >= 0 && (!integer || Number.isInteger(metric))
  }
  /** 金额以安全整数分保存，并拒绝超出上限的结果。 */
  const validMoney = (key: string): boolean =>
    !(key in value) || value[key] === null ||
    (Number.isSafeInteger(value[key]) && Number(value[key]) >= 0 && Number(value[key]) <= 1_000_000_000)
  const mode = value.mode
  return isBoundedString(value.sourceId, 1, 100) && isBoundedString(value.destinationStopId, 1, 100) &&
    ['transit', 'walking', 'driving'].includes(String(mode)) && isString(value.fetchedAt) &&
    Number.isInteger(value.optionNumber) && Number(value.optionNumber) >= 1 && Number(value.optionNumber) <= 3 &&
    (value.queryDate === undefined || (isString(value.queryDate) && isCalendarDate(value.queryDate))) &&
    (value.queryTime === undefined || (isString(value.queryTime) && /^(?:[01]?\d|2[0-3])-[0-5]\d$/.test(value.queryTime))) &&
    validMetric('durationMinutes', true) && validMetric('distanceMeters') && validMetric('walkingDistanceMeters') &&
    validMoney('fareFen') && validMoney('tollFen') &&
    (value.fareFen === undefined || mode === 'transit') && (value.tollFen === undefined || mode === 'driving') &&
    (value.transitLines === undefined || (Array.isArray(value.transitLines) && value.transitLines.length <= 10 && value.transitLines.every((line) => isBoundedString(line, 1, 120))))
}

/** 清除地点身份、顺序或公交时刻变化后不再匹配的路线估算。 */
export function clearStaleRouteEvidence(
  input: unknown,
  previous: ItineraryOption | undefined,
  lodgingLocation?: string
): unknown {
  if (!isRecord(input) || !Array.isArray(input.days)) return input
  const edited = clone(input)
  if (!isRecord(edited) || !Array.isArray(edited.days)) return input
  const priorStops = new Map((previous?.days.flatMap((day) => day.stops) ?? []).map((stop) => [stop.id, stop]))
  const priorDays = new Map((previous?.days ?? []).map((day) => [day.id, day]))
  const priorNextStopIds = new Map((previous?.days ?? []).flatMap((day) =>
    day.stops.map((stop, index) => [stop.id, day.stops[index + 1]?.id ?? null] as const)
  ))
  for (const day of edited.days) {
    if (!isRecord(day) || !Array.isArray(day.stops)) continue
    const previousDay = priorDays.get(String(day.id))
    const previousFirstStop = previousDay && lodgingCommuteBoundaryStop(previousDay.stops, 'from-lodging')
    const previousLastStop = previousDay && lodgingCommuteBoundaryStop(previousDay.stops, 'to-lodging')
    const firstStop = physicalBoundaryFromUnknownStops(day.stops, 'from-lodging')
    const lastStop = physicalBoundaryFromUnknownStops(day.stops, 'to-lodging')
    const changedLodgingRouteEndpoint = !previousDay || previousDay.date !== day.date ||
      !isRecord(firstStop) || !isRecord(lastStop) ||
      routeEndpointChanged(previousFirstStop, firstStop) || routeEndpointChanged(previousLastStop, lastStop)
    const lodgingTransfers = day.lodgingCommutes
    if (Array.isArray(lodgingTransfers) && lodgingTransfers.some((transfer) =>
      !isRecord(transfer) || changedLodgingRouteEndpoint ||
      (lodgingLocation !== undefined && transfer.lodgingLocation !== lodgingLocation.trim()))) {
      delete day.lodgingCommutes
    }
    for (const [index, value] of day.stops.entries()) {
      if (!isRecord(value)) continue
      const estimate = value.transitEstimate
      if (!isRecord(estimate)) continue
      const stop = value
      const prior = priorStops.get(String(stop.id))
      const next = day.stops[index + 1]
      const nextStop = isRecord(next) ? next : undefined
      const priorNext = prior?.transitEstimate ? priorStops.get(priorNextStopIds.get(prior.id) ?? '') : undefined
      const endpointChanged = prior?.transitEstimate && (
        estimate.destinationStopId !== nextStop?.id || routeEndpointChanged(prior, stop) ||
        routeEndpointChanged(priorNext, nextStop)
      )
      const transitScheduleChanged = estimate.mode === 'transit' && (
        estimate.queryDate !== (typeof day.date === 'string' && day.date ? day.date : undefined) ||
        estimate.queryTime !== transitQueryTime(typeof stop.time === 'string' ? stop.time : '')
      )
      if (endpointChanged || transitScheduleChanged) {
        if (typeof estimate.sourceId === 'string' && Array.isArray(stop.sourceIds)) {
          stop.sourceIds = stop.sourceIds.filter((sourceId) => sourceId !== estimate.sourceId)
        }
        delete stop.transitEstimate
        stop.transitToNext = ''
      }
    }
  }
  return edited
}

/** 从未校验输入中读取住宿接驳的实体边界，不信任缺字段的停靠点。 */
function physicalBoundaryFromUnknownStops(
  stops: unknown[],
  direction: 'from-lodging' | 'to-lodging'
): unknown {
  const physicalStops = stops.filter((stop): stop is Record<string, unknown> =>
    isRecord(stop) && typeof stop.id === 'string' && typeof stop.name === 'string' &&
    typeof stop.area === 'string' && typeof stop.category === 'string' &&
    isPhysicalItineraryStop(stop as Pick<ItineraryStop, 'name' | 'area' | 'category'>)
  )
  return direction === 'from-lodging' ? physicalStops[0] : physicalStops.at(-1)
}

/** 只比较地点身份字段，来源刷新时间或显示标签变化不应造成路线失效。 */
export function sameItineraryLocationIdentity(left: unknown, right: unknown): boolean {
  if (left === undefined || left === null || right === undefined || right === null) return left === right
  if (!isRecord(left) || !isRecord(right)) return false
  return left.sourceId === right.sourceId && left.latitude === right.latitude &&
    left.longitude === right.longitude && left.coordinateSystem === right.coordinateSystem
}

/** 地点身份、名称或片区变化后，旧路线端点已不再可靠。 */
function routeEndpointChanged(previous: unknown, next: unknown): boolean {
  if (!isRecord(previous) || !isRecord(next)) return previous !== next
  return previous.id !== next.id || previous.name !== next.name || previous.area !== next.area ||
    !sameItineraryLocationIdentity(previous.location, next.location)
}

/** 从明确的 HH:MM 出发时刻生成高德公共交通接口格式，不猜测模糊时间。 */
function transitQueryTime(value: string): string | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour <= 23 && minute <= 59 ? `${hour}-${String(minute).padStart(2, '0')}` : undefined
}

/** 校验版本内容和可选结构化行程。 */
export function isRevision(value: unknown): value is ItineraryRevision {
  return isRecord(value) && isString(value.id) && Number.isInteger(value.number) && isString(value.createdAt) &&
    isString(value.summary) && isString(value.content) && Array.isArray(value.sourceIds) && value.sourceIds.every(isString) &&
    (value.itinerary === undefined || isItineraryOption(value.itinerary))
}

/** 复制值后再交给界面，避免 renderer 直接改变主进程状态。 */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
