/** 校验模型生成的方案结构，让用户逐套审阅后再保存为确认版本。 */
import { randomUUID } from 'node:crypto'
import { BUDGET_CATEGORY_LABELS, BUDGET_COST_CATEGORIES } from '../../shared/budget.js'
import { MAX_ITINERARY_ARGUMENT_CHARACTERS } from '../../shared/agent-limits.js'
import type { BudgetCostCategory, EvidenceLevel, ItineraryBudgetEstimate, ItineraryBudgetItem, ItineraryConditionalAlternative, ItineraryDay, ItineraryDayWeather, ItineraryFactClaim, ItineraryFactType, ItineraryMealRequirement, ItineraryMealSlot, ItineraryOption, ItineraryScheduleBlock, ItineraryScheduleBlockKind, ItineraryStop, LodgingCommute, RouteMode, SourceRecord, ToolFeedback, ToolFeedbackSeverity, TripBrief } from '../../shared/types.js'
import { ToolInputError, type FactEvidenceRejectionReason, type ItineraryFactEvidenceDiagnostics, type ToolContext, type ToolDefinition, type TravelTool } from './types.js'
import { routeSummarySupportsMetrics, routeTitleMatchesOrderedEndpoints } from '../../shared/preparation.js'
import { analyzeDaySchedule, analyzeMealRequirements, departureClockLabel, scheduleRangeDurationMinutes } from '../../shared/itinerary-schedule.js'
import { findOpenMealStart } from './itinerary-meal-window.js'
import { isUnresolvedAttractionName } from '../../shared/itinerary-placeholders.js'
import { lodgingCommuteBoundaryStop } from '../../shared/itinerary-route-endpoints.js'
import { logSystemEvent } from '../system-logger.js'
import {
  MAX_ITINERARY_FACT_CLAIMS_PER_STOP, MAX_ITINERARY_STOP_SOURCE_IDS,
  MAX_ITINERARY_STOPS_PER_DAY, MAX_PROPOSED_STOPS_PER_DAY, mergeItineraryStopSourceIds
} from '../../shared/itinerary-limits.js'
import { explicitlyExcludedItineraryStopsForRequest, explicitlyExcludedStopNameMatches, itineraryStopNameMatches, preserveLockedStops, preserveScopedItineraryEdits, preserveUnchangedItineraryDays, unchangedItineraryDatesForRequest } from '../../shared/itinerary-revisions.js'
import { mentionsTransportHub, userConfirmedTransportHub } from '../../shared/transport-hubs.js'
import { itineraryFactTypeLabel, itinerarySourceNamesPlace, MAX_ITINERARY_FACT_QUOTE_CHARACTERS } from '../../shared/itinerary-facts.js'
import {
  legacySourceContentLevel,
  pageBodySupportsFactType,
  pendingFactValue,
  requiresDirectFactEvidence,
  requiresVenueFactText,
  sourceCanSupportFact,
  sourceDirectlyNamesStop,
  sourceDirectlySupportsStopFact,
  sourceEvidenceText,
  sourceSupportsStructuredSunsetDate,
  structuredSunsetTimeForDate
} from './itinerary-fact-evidence.js'

/** 抵达日未指定具体时间的餐次先安排在接驳后，由用户按实际进度确认。 */
const deferredArrivalMealTime = '落地及接驳后（时段待确认）'
/** 落地时刻只作航班锚点；接驳须等离站和取行李后再开始。 */
const deferredArrivalTransferTime = '落地、离站与取行李后（时段待核验）'

interface FactEvidenceCorrection {
  placeName: string
  type: ItineraryFactType
  reason: FactEvidenceRejectionReason
}

export interface ItineraryFactRepairTarget {
  plan_number: number
  day_number: number
  date: string
  stop_name: string
  area: string
  missing_facts: Extract<ItineraryFactType, 'opening-hours' | 'booking' | 'ticket-price'>[]
  preferred: boolean
}

const stopProperties = {
  name: { type: 'string', minLength: 1, maxLength: 160, description: '非空的地点或活动名称；休息和机动时段放入 schedule_blocks' },
  area: { type: 'string', maxLength: 80, description: '可选，简短地点所在街区' },
  time: { type: 'string', maxLength: 40, description: '行程建议时段，不代表场馆开放或交通服务时间。用户要求逐时段安排时，优先填写 24 小时制起止时间；无法合理估算时说明待安排。一般计划可用上午、下午等时段。餐饮地点须对应早餐、午餐或晚餐的实际时段。' },
  duration_minutes: { type: ['integer', 'null'], minimum: 0, maximum: 720, description: '可选停留分钟数；用户要求逐时段安排时可填写可调整的计划估算，不代表来源核验的开放或服务时长；无法合理估算时为 null' },
  category: { type: 'string', maxLength: 60, description: '简短类型：景点、餐饮、休息、住宿或交通' },
  notes: { type: 'string', maxLength: 240, description: '可选，仅写影响执行的提醒，如入口、预约或排队；最多 240 字符，不重复其他地点或摘要' },
  transit_to_next: { type: 'string', maxLength: 180, description: '可选，用一行写下一段起终点和交通方式；线路与耗时须有成功路线来源，否则标待核验' },
  evidence_level: { type: 'string', enum: ['sourced', 'estimated', 'pending'], description: '可选，有来源时填写，否则省略' },
  source_ids: { type: 'array', maxItems: 3, items: { type: 'string' }, description: '可选，只引用直接支持此地点的来源，最多 3 个' },
  conditional_alternatives: {
    type: 'array', maxItems: 3,
    description: '可选，仅在用户要求预约失败、天气或客流备选时填写。它们不是实际行程停靠点；每项独立记录触发条件和支持该备选地点的来源。',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 160, description: '条件替代地点名称' },
        area: { type: 'string', maxLength: 80, description: '替代地点所在片区，未知时留空' },
        trigger: { type: 'string', minLength: 1, maxLength: 120, description: '采用此替代地点的明确条件' },
        environment: { type: 'string', enum: ['indoor', 'outdoor', 'unknown'], description: '可选，活动环境；用户明确要求室内替代时填写 indoor' },
        evidence_level: { type: 'string', enum: ['sourced', 'estimated', 'pending'], description: '来源直接支持地点身份时为 sourced；否则为 pending' },
        source_ids: { type: 'array', maxItems: 3, items: { type: 'string' }, description: '直接支持此替代地点名称或位置的本轮来源 ID；无来源时为空数组' }
      },
      required: ['name', 'area', 'trigger', 'evidence_level', 'source_ids'],
      additionalProperties: false
    }
  },
  fact_claims: {
    type: 'array', maxItems: MAX_ITINERARY_FACT_CLAIMS_PER_STOP,
    description: `可选，只列正文或结构化来源直接支持、会影响执行的事实，包括开放、闭馆、票价、预约、无障碍、日出日落和拍摄规定。填写时必须引用支持地点、具体值和适用范围的来源；优先选择 placeNameMatches 含当前地点的正文来源。事实值必须复制对应正文中不超过 ${MAX_ITINERARY_FACT_QUOTE_CHARACTERS} 字的连续原文片段，只可规范空格和全半角标点，不得改写、换词、拼接多句或换算数值；找不到原文时省略，由执行端补成待核验事实。`,
    items: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['opening-hours', 'ticket-price', 'booking', 'closure', 'weather', 'transport-time', 'accessibility', 'sunset', 'photography-rules', 'other'] },
        value: {
          type: 'string', minLength: 1, maxLength: MAX_ITINERARY_FACT_QUOTE_CHARACTERS,
          description: `复制 source_id 对应正文中不超过 ${MAX_ITINERARY_FACT_QUOTE_CHARACTERS} 字的连续原文，只可规范空格与全半角标点；不得改写。无原文时省略此事实。`
        },
        scope: { type: 'string', maxLength: 80, description: '事实适用范围；开放时段标注具体日期、每日规则、季节或星期范围。只有来源原文明确日期或覆盖该日的区间时，才将季节规则标成具体日期。' },
        evidence_level: { type: 'string', enum: ['sourced', 'estimated', 'pending'] },
        source_id: { type: ['string', 'null'], description: 'sourced 时只引用 placeNameMatches 含当前地点且正文直接支持事实类型、值和适用范围的来源；待核验可保留相关来源供用户复核，否则填 null。' }
      },
      required: ['type', 'value', 'scope', 'evidence_level', 'source_id'],
      additionalProperties: false
    }
  }
}

const budgetCategories = BUDGET_COST_CATEGORIES
const budgetItemProperties = {
  category: { type: 'string', enum: budgetCategories, description: '费用类别：航班、城际交通、住宿、市内交通、门票预约、餐饮或其他' },
  title: { type: 'string', minLength: 1, maxLength: 120, description: '费用项名称' },
  amount_min_fen: { type: ['integer', 'null'], minimum: 0, maximum: 10_000_000_000, description: '单价下界，人民币分；未知时为 null' },
  amount_max_fen: { type: ['integer', 'null'], minimum: 0, maximum: 10_000_000_000, description: '单价上界，人民币分；未知时为 null' },
  quantity: { type: 'integer', minimum: 1, maximum: 1_000, description: '费用项数量，例如人数、间夜或趟数' },
  unit_label: { type: 'string', minLength: 1, maxLength: 24, description: '数量单位，例如人、间夜、趟或项' },
  evidence_level: { type: 'string', enum: ['sourced', 'estimated', 'pending'], description: '来源明确的金额用 sourced；规划范围用 estimated；金额未知用 pending' },
  source_ids: { type: 'array', maxItems: 5, items: { type: 'string' }, description: '直接支持金额或规划区间的当前旅行来源 ID' },
  basis: { type: 'string', minLength: 1, maxLength: 300, description: '估算方法、适用假设或待核验原因；不要把规划范围称为报价' }
}

const budgetEstimateSchema = {
  type: 'object',
  properties: {
    currency: { type: 'string', enum: ['CNY'] },
    items: {
      type: 'array', maxItems: 30,
      description: '费用按单价区间和数量记录；金额必须使用人民币分，待核验项的金额上下界都为 null。',
      items: { type: 'object', properties: budgetItemProperties, required: Object.keys(budgetItemProperties), additionalProperties: false }
    },
    not_applicable_categories: {
      type: 'array', maxItems: budgetCategories.length,
      description: '只有明确不适用的类别才列于此；其余未能估价的类别应建立 pending 费用项。',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: budgetCategories },
          reason: { type: 'string', minLength: 1, maxLength: 200 }
        },
        required: ['category', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['currency', 'items', 'not_applicable_categories'],
  additionalProperties: false
}

/** 定义单份行程草案的工具输入与结构校验。 */
export const itineraryProposalTool: TravelTool = {
  definition: {
    type: 'function',
    function: {
      name: 'propose_itineraries',
      description: '提交一份行程计划，使用单数 plan 对象。字段和类型由 schema 限定；业务校验结果由工具执行后返回。',
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'object',
            properties: {
              title: { type: 'string', minLength: 0, maxLength: 100, description: '简短方案名称，不超过 100 个字符；不确定时留空，由 Tripwise 自动命名' },
              summary: { type: 'string', maxLength: 120, description: '用一句话概括实际主题、主要片区和节奏，最多 120 个字符。不要列具体景点或逐日安排，不写天数/地点数量、“顺序见下方”或泛化待核验状态；不要声称计划中没有出现的休息、餐次或交通。开放、闭馆、预约、票价、天气和通勤数值写在对应结构化事实中。' },
              tradeoffs: { type: 'string', maxLength: 300, description: '只有存在真实且会影响用户选择的安排取舍时才简要说明，否则留空；不要写“之后可继续调整”等通用套话，也不重复摘要或每日详情。用户明确要求预算与省时对比时，针对同一条本计划路段分别写预算友好做法和更省时做法，例如“预算友好：该段沿用地铁，票价待核验；更省时：可比较打车，节时和车费待核验”。没有来源的费用或分钟数标待核验，不计入金额小计。动态事实必须在对应地点的 fact_claims 中有直接来源，否则不要写入取舍说明。不要用未列入计划的地点或未经核实的信息解释安排。' },
                budget_estimate: budgetEstimateSchema,
                days: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 7,
                  items: {
                    type: 'object',
                    properties: {
                      day_number: { type: 'integer', minimum: 1, maximum: 7 },
                      date: { type: 'string', description: '已确认出行日期；未知时留空' },
                      title: { type: 'string', maxLength: 100, description: '写成简短每日主题；不要放完整行程摘要' },
                      stops: {
                        type: 'array',
                        minItems: 1,
                        maxItems: MAX_PROPOSED_STOPS_PER_DAY,
                        items: {
                          type: 'object',
                          properties: stopProperties,
                          required: ['name', 'time', 'category'],
                          additionalProperties: false
                        }
                      },
                      schedule_blocks: {
                        type: 'array',
                        maxItems: 5,
                        description: '可选的休息或机动时间。餐馆已作为地点 stop 时，不要再用 meal 块重复记录同一餐；除明确注明同一场馆内且完整包含于参观时段外，不与地点时段重叠。',
                        items: {
                          type: 'object',
                          properties: {
                            kind: { type: 'string', enum: ['meal', 'rest', 'buffer'] },
                            title: { type: 'string', description: '如午餐、午休、机动时间' },
                            time: { type: 'string', description: '建议时刻或时段；不能可靠判断时留空，不伪造精确时间。用户明确要求安排在用餐后的休息时，可写“午餐后”表示先后顺序' },
                            duration_minutes: { type: ['integer', 'null'], description: '建议时长；无法合理估算时使用 null' },
                            area: { type: 'string', maxLength: 80, description: '用短名称填写适用区域；未知时留空' },
                            notes: { type: 'string', maxLength: 160, description: '简要说明规划安排及需用户确认的事项' }
                          },
                          required: ['kind', 'title'],
                          additionalProperties: false
                        }
                      },
                      lodging_commutes: {
                        type: 'array', maxItems: 2,
                        description: '仅在具体住宿位置和成功路线来源都可验证时填写；一天最多包含住宿到首个实体地点和末个实体地点回住宿各一条。',
                        items: {
                          type: 'object',
                          properties: {
                            direction: { type: 'string', enum: ['from-lodging', 'to-lodging'] },
                            source_id: { type: 'string', minLength: 1, maxLength: 100 },
                            mode: { type: 'string', enum: ['transit', 'walking', 'driving'] },
                            option_number: { type: 'integer', minimum: 1, maximum: 3 },
                            query_date: { type: 'string', description: '公共交通路线必须与当天日期一致；步行/驾车通常留空' },
                            query_time: { type: 'string', description: '可选公共交通出发时刻，格式 H-MM 或 HH-MM；步行/驾车留空' },
                            duration_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
                            distance_meters: { type: ['integer', 'null'], minimum: 1, maximum: 1000000 }
                          },
                          required: ['direction', 'source_id', 'mode', 'option_number', 'duration_minutes', 'distance_meters'],
                          additionalProperties: false
                        }
                      }
                    },
                    required: ['day_number', 'date', 'title', 'stops'],
                    additionalProperties: false
                  }
                }
            },
            required: ['title', 'summary', 'tradeoffs', 'days'],
            additionalProperties: false
          }
        },
        required: ['plan'],
        additionalProperties: false
      }
    }
  },
  provider: 'Tripwise 行程整理',
  kind: 'web',
  sourceUrl: '',
  /** 结构化计划可先保存；信息缺口通过 warning 交给模型判断是否继续查询。 */
  async execute(args, context) {
    // 旧恢复点仍可提交 plans 数组；新模型契约始终使用单数 plan。
    const { option, factEvidenceDiagnostics, factEvidenceCorrections, feedback } = normalizePlan(args.plan ?? args.plans, context)
    if (!context.researchCompleted && !context.allowUnresearchedDraft) {
      feedback.push({
        severity: 'warning',
        code: 'research_not_done',
        message: '本轮尚无外部来源；计划已保存，按需要继续检索或将动态信息标为待核验。'
      })
    }
    return {
      output: itineraryProposalOutput(factEvidenceDiagnostics, factEvidenceCorrections),
      sources: [],
      feedback,
      itineraryOptions: [option],
      itineraryFactEvidenceDiagnostics: factEvidenceDiagnostics
    }
  }
}

/** 检查候选遗漏或违反的餐次偏好，供 Agent 发起一次有界修订。 */
export function mealPreferenceFeedback(
  options: ItineraryOption[],
  requirements: Array<{
    date: string
    slots: Array<'breakfast' | 'lunch' | 'dinner'>
    excludedSlots?: Array<'breakfast' | 'lunch' | 'dinner'>
  }>,
  requireNamedMealStops = false,
  unchangedDates: string[] = [],
  namedGapLimit = 8
): string[] {
  const labels = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' }
  const preservedDates = new Set(unchangedDates)
  const boundedNamedGapLimit = Math.max(0, Math.min(60, Math.floor(namedGapLimit)))
  return options.flatMap((option, optionIndex) => {
    const scopedRequirements = requirements.filter((requirement) => !preservedDates.has(requirement.date))
    const slotGaps = scopedRequirements.flatMap((requirement) => {
      const day = option.days.find((candidate) => candidate.date === requirement.date)
      const present = new Set((day?.stops ?? []).flatMap((stop) => {
        if (!/餐/u.test(stop.category)) return []
        const slot = mealSlotForStop(stop)
        return slot ? [slot] : []
      }))
      for (const block of day?.scheduleBlocks ?? []) {
        if (block.kind !== 'meal') continue
        const slot = mealSlotForBlock(block)
        if (slot) present.add(slot)
      }
      const missing = requirement.slots.filter((slot) => !present.has(slot))
      const excluded = (requirement.excludedSlots ?? []).filter((slot) => present.has(slot))
      return [
        ...(missing.length ? [`方案${optionIndex + 1} ${requirement.date} 缺少${missing.map((slot) => labels[slot]).join('、')}`] : []),
        ...(excluded.length ? [`方案${optionIndex + 1} ${requirement.date} 仍安排了用户明确取消的${excluded.map((slot) => labels[slot]).join('、')}`] : [])
      ]
    })
    if (!requireNamedMealStops) return slotGaps

    const requiredSlotsByDate = new Map(scopedRequirements.filter((requirement) => requirement.slots.length > 0)
      .map((requirement) => [requirement.date, new Set(requirement.slots)]))
    const relevantDays = requirements.length
      ? option.days.filter((day) => requiredSlotsByDate.has(day.date))
      : option.days.filter((day) => !preservedDates.has(day.date))
    const unnamedMeals = scopedRequirements.length
      ? scopedRequirements.flatMap((requirement) => {
        const day = option.days.find((candidate) => candidate.date === requirement.date)
        return requirement.slots.flatMap((slot) => {
          const slotStops = (day?.stops ?? []).filter((stop) => /餐/u.test(stop.category) && mealSlotForStop(stop) === slot)
          if (slotStops.some((stop) => !isPlaceholderRestaurantName(stop.name))) return []
          const placeholder = slotStops.find((stop) => isPlaceholderRestaurantName(stop.name))
          const reservedBlock = (day?.scheduleBlocks ?? []).find((block) =>
            block.kind === 'meal' && mealSlotForBlock(block) === slot
          )
          if (reservedBlock && day && !hasActionableTime(reservedBlock.time, reservedBlock.durationMinutes) &&
            findOpenMealStart(day, slot) === undefined) return []
          const date = requirement.date || `第 ${day?.dayNumber ?? 1} 天`
          return [placeholder
            ? `${date} ${placeholder.time || labels[slot]}：${placeholder.name}`
            : `${date} ${labels[slot]}：${reservedBlock ? '时段已预留，' : ''}具体店面待选`]
        })
      })
      : relevantDays.flatMap((day) => {
        const unnamedStops = day.stops.filter((stop) =>
          /餐/u.test(stop.category) && isPlaceholderRestaurantName(stop.name)
        ).map((stop) => `${day.date || `第 ${day.dayNumber} 天`} ${stop.time || '用餐'}：${stop.name}`)
        const unnamedBlocks = day.scheduleBlocks.filter((block) => {
          if (block.kind !== 'meal') return false
          const slot = mealSlotForBlock(block)
          const hasNamedStop = slot && day.stops.some((stop) =>
            /餐/u.test(stop.category) && mealSlotForStop(stop) === slot && !isPlaceholderRestaurantName(stop.name)
          )
          return !hasNamedStop
        }).map((block) => `${day.date || `第 ${day.dayNumber} 天`} ${block.time} ${block.title}：具体店面待选`)
        return [...unnamedStops, ...unnamedBlocks]
      })
    return [
      ...slotGaps,
      ...unnamedMeals.slice(0, boundedNamedGapLimit).map((meal) => `方案${optionIndex + 1} 具体店面待选：${meal}`)
    ]
  })
}

/** 将具名餐次缺口从通用业务建议中单独提级，确保模型能看到补餐工具与待核验规则。 */
function isNamedMealGap(message: string): boolean {
  return message.includes('具体店面待选')
}

/** 检查用户明确要求的逐站时间、交通、游客事实和日内降级安排。 */
export function itineraryDetailFeedback(
  options: ItineraryOption[],
  requirements: { detailed: boolean; routeCoverage?: boolean; openingHours: boolean; booking: boolean; ticketPrice?: boolean; contingencies: boolean }
): string[] {
  if (!requirements.detailed && !requirements.routeCoverage && !requirements.openingHours && !requirements.booking && !requirements.ticketPrice && !requirements.contingencies) return []

  const gaps: string[] = []
  for (const [optionIndex, option] of options.entries()) {
    for (const day of option.days) {
      const dayLabel = day.date || `第 ${day.dayNumber} 天`
      const visitStops = day.stops.filter(isVisitStop)
      if (requirements.detailed) {
        for (const stop of visitStops) {
          if (!hasActionableTime(stop.time, stop.durationMinutes)) {
            gaps.push(`方案${optionIndex + 1} ${dayLabel} ${stop.name}：缺少可执行的游览时段`)
          }
        }
        for (const block of day.scheduleBlocks ?? []) {
          // 午餐后休息只确认先后关系；未知接驳和时长明确待核验时不要求模型编造钟点。
          const pendingPostLunchHotelRest = isPostLunchHotelRestBlock(block) &&
            /待核验/u.test(block.notes)
          if (!hasActionableTime(block.time, block.durationMinutes) && !pendingPostLunchHotelRest) {
            gaps.push(`方案${optionIndex + 1} ${dayLabel} ${block.title}：缺少明确开始时刻和时长`)
          }
        }
        for (const [stopIndex, stop] of day.stops.entries()) {
          const nextStop = day.stops[stopIndex + 1]
          if (!nextStop) continue
          const description = stop.transitToNext
          const hasMode = hasTransitMode(description) || stop.transitEstimate?.destinationStopId === nextStop.id
          const hasDestination = requiredVisitNameMatches(description, nextStop.name) || stop.transitEstimate?.destinationStopId === nextStop.id
          if (!hasMode || !hasDestination) {
            gaps.push(`方案${optionIndex + 1} ${dayLabel} ${stop.name}→${nextStop.name}：缺少交通方式或明确终点`)
          }
        }
      }
      if (requirements.detailed || requirements.routeCoverage) {
        const pendingTransitSegments = day.stops.flatMap((stop, stopIndex) => {
          const nextStop = day.stops[stopIndex + 1]
          return nextStop && routeModeFromDescription(stop.transitToNext) === 'transit' &&
            stop.transitEstimate?.destinationStopId !== nextStop.id
            ? [`${stop.name} → ${nextStop.name}`]
            : []
        })
        if (pendingTransitSegments.length) {
          const examples = pendingTransitSegments.slice(0, 3).join('、')
          const reason = requirements.detailed ? '用户要求具体公共交通安排' : '路线复核发现'
          gaps.push(
            `方案${optionIndex + 1} ${dayLabel}：${reason}，${pendingTransitSegments.length} 段公共交通缺少来源估时（无匹配路线来源）。可调用 estimate_route 核验关键路段；是否补查由你根据行程影响判断。未查或无结果时，明确保留待核验。路段：${examples}。`
          )
        }
      }

      if (requirements.openingHours || requirements.booking || requirements.ticketPrice) {
        for (const stop of visitStops.filter(isAttractionStop)) {
          if (requirements.openingHours && !hasSupportedFact(stop, ['opening-hours', 'closure'])) {
            gaps.push(`方案${optionIndex + 1} ${dayLabel} ${stop.name}：缺少开放/闭馆事实`)
          }
          if (requirements.booking && !hasSupportedFact(stop, ['booking'])) {
            gaps.push(`方案${optionIndex + 1} ${dayLabel} ${stop.name}：缺少预约事实`)
          }
          if (requirements.ticketPrice && !hasSupportedFact(stop, ['ticket-price'])) {
            gaps.push(`方案${optionIndex + 1} ${dayLabel} ${stop.name}：缺少票价事实`)
          }
        }
      }

      if (requirements.contingencies && visitStops.some(isAttractionStop) && !hasDailyContingency(day)) {
        gaps.push(`方案${optionIndex + 1} ${dayLabel}：缺少天气/人流/延误变化时的调整或替代安排`)
      }
    }
  }
  return [...new Set(gaps)].slice(0, 60)
}

/** 将关键通勤估时缺口单独反馈给 Agent，避免被大量逐站细节挤出上下文。 */
export function itineraryRouteCoverageFeedback(options: ItineraryOption[], requested: boolean): string[] {
  if (!requested) return []

  return options.flatMap((option, optionIndex) => {
    const missingSegments = option.days.flatMap((day) => day.stops.flatMap((stop, stopIndex) => {
      const nextStop = day.stops[stopIndex + 1]
      if (!nextStop || routeModeFromDescription(stop.transitToNext) !== 'transit' ||
          stop.transitEstimate?.destinationStopId === nextStop.id) return []
      const departureTime = plannedRouteDepartureTime(stop)
      const timeLabel = departureTime ? `${departureTime} 离开` : '出发时刻待明确'
      return [`${day.date || `第 ${day.dayNumber} 天`} ${stop.name} → ${nextStop.name}（${timeLabel}）`]
    }))
    if (missingSegments.length === 0) return []

    const examples = missingSegments.slice(0, 3).join('；')
    return [
      `方案${optionIndex + 1}：用户要求具体公共交通安排，但${missingSegments.length}段公共交通尚无来源估时。先判断固定预约、机场/车站衔接或跨区移动中影响最大的 1–3 段相邻路段；若 estimate_route 可用且值得查询，使用计划中的原地点名、日期和交通方式调用。若起点有明确结束时刻，路线出发时刻取结束时刻；单一开始时刻且有停留时长时按两者计算结束时刻。只有单一时刻且无停留时长时才用该时刻；“上午/下午”等模糊时段省略，不要推测。无需覆盖全部路段；未查或无结果时保留“待核验”。示例：${examples}。`
    ]
  })
}

/** 让路线缺口只出现在专门反馈中，不重复占用通用细节反馈。 */
function isRouteCoverageGap(message: string): boolean {
  return message.includes('缺少来源估时（无匹配路线来源）')
}

/** 汇总用户要求但仍缺少直接证据的事实，供质量报告记录，不触发行程自动重写。 */
export function itineraryFactEvidenceFeedback(
  options: ItineraryOption[],
  requirements: { openingHours: boolean; booking: boolean; ticketPrice?: boolean }
): string[] {
  if (!requirements.openingHours && !requirements.booking && !requirements.ticketPrice) return []
  const factLabels = ['开放/闭馆', '预约/购票', '票价'] as const
  const groupedGaps = new Map<string, {
    dayLabel: string
    stopName: string
    area: string
    plans: Map<number, Set<typeof factLabels[number]>>
  }>()
  const normalizeTargetPart = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()

  for (const [optionIndex, option] of options.entries()) {
    for (const day of option.days) {
      const dayLabel = day.date || `第 ${day.dayNumber} 天`
      for (const stop of day.stops.filter((item) => isVisitStop(item) && isAttractionStop(item))) {
        const missing: typeof factLabels[number][] = []
        if (requirements.openingHours && !hasSourcedFact(stop, ['opening-hours', 'closure'])) missing.push(factLabels[0])
        if (requirements.booking && !hasSourcedFact(stop, ['booking'])) missing.push(factLabels[1])
        if (requirements.ticketPrice && !hasSourcedFact(stop, ['ticket-price'])) missing.push(factLabels[2])
        if (!missing.length) continue

        const area = stop.area ?? ''
        const key = JSON.stringify([dayLabel, normalizeTargetPart(stop.name), normalizeTargetPart(area)])
        let group = groupedGaps.get(key)
        if (!group) {
          group = { dayLabel, stopName: stop.name.trim(), area: area.trim(), plans: new Map() }
          groupedGaps.set(key, group)
        }
        let planGaps = group.plans.get(optionIndex)
        if (!planGaps) {
          planGaps = new Set()
          group.plans.set(optionIndex, planGaps)
        }
        for (const fact of missing) planGaps.add(fact)
      }
    }
  }

  const groups = [...groupedGaps.values()]
  const nameDateCounts = new Map<string, number>()
  for (const group of groups) {
    const key = JSON.stringify([group.dayLabel, normalizeTargetPart(group.stopName)])
    nameDateCounts.set(key, (nameDateCounts.get(key) ?? 0) + 1)
  }
  return groups.map((group) => {
    const key = JSON.stringify([group.dayLabel, normalizeTargetPart(group.stopName)])
    const stopName = (nameDateCounts.get(key) ?? 0) > 1 && group.area
      ? `${group.stopName}（${group.area}）`
      : group.stopName
    const planGaps = [...group.plans.entries()].sort(([left], [right]) => left - right)
    if (planGaps.length === 1) {
      const [optionIndex, missing] = planGaps[0]
      return `方案${optionIndex + 1} ${group.dayLabel} ${stopName}：${[...missing].join('、')}事实缺少直接来源`
    }
    const signatures = new Set(planGaps.map(([, missing]) => [...missing].join('、')))
    const suffix = '；同日同地点的检索结果可复用于历史草案，但每份须保留独立来源引用'
    if (signatures.size === 1) {
      const plansLabel = planGaps.map(([optionIndex]) => optionIndex + 1).join('、')
      return `方案${plansLabel} ${group.dayLabel} ${stopName}：${[...planGaps[0][1]].join('、')}事实缺少直接来源${suffix}`
    }
    const perPlan = planGaps.map(([optionIndex, missing]) =>
      `方案${optionIndex + 1}缺少${[...missing].join('、')}`
    ).join('；')
    return `${group.dayLabel} ${stopName}：${perPlan}事实来源${suffix}`
  }).slice(0, 24)
}

/** 为已提交草案挑出待补的动态事实；优先处理用户明确提到的地点，并限制单轮规模。 */
export function itineraryFactRepairTargets(
  options: ItineraryOption[],
  requirements: { openingHours: boolean; booking: boolean; ticketPrice?: boolean },
  unchangedDates: string[] = [],
  preferredPlaceNames: string[] = [],
  limit = 16
): ItineraryFactRepairTarget[] {
  if (!requirements.openingHours && !requirements.booking && !requirements.ticketPrice) return []
  const protectedDates = new Set(unchangedDates)
  const preferred = preferredPlaceNames.map((name) => name.trim()).filter((name) => name.length >= 2)
  const targets = options.flatMap((option, optionIndex) => option.days.flatMap((day) => {
    if (protectedDates.has(day.date)) return []
    return day.stops.flatMap((stop) => {
      if (!isVisitStop(stop) || !isAttractionStop(stop)) return []
      const missingFacts: ItineraryFactRepairTarget['missing_facts'] = []
      if (requirements.openingHours && !hasSourcedFact(stop, ['opening-hours', 'closure'])) missingFacts.push('opening-hours')
      if (requirements.booking && !hasSourcedFact(stop, ['booking'])) missingFacts.push('booking')
      if (requirements.ticketPrice && !hasSourcedFact(stop, ['ticket-price'])) missingFacts.push('ticket-price')
      return missingFacts.length ? [{
        plan_number: optionIndex + 1,
        day_number: day.dayNumber,
        date: day.date,
        stop_name: stop.name,
        area: stop.area ?? '',
        missing_facts: missingFacts,
        preferred: preferred.some((name) => itineraryStopNameMatches(name, stop.name) || itineraryStopNameMatches(stop.name, name))
      }] : []
    })
  }))
  return targets
    .sort((left, right) => Number(right.preferred) - Number(left.preferred) ||
      left.plan_number - right.plan_number || left.day_number - right.day_number)
    .slice(0, Math.max(0, Math.min(24, Math.floor(limit))))
    .map((target) => target)
}

/** 对局部事实更新复用整稿相同的正文、地点、值与来源校验。 */
export function normalizeItineraryFactClaimForRepair(
  value: unknown,
  stopName: string,
  allowedSourceIds: string[],
  availableSources: SourceRecord[],
  otherStopNames: string[] = []
): { claim: ItineraryFactClaim; diagnostics: ItineraryFactEvidenceDiagnostics } {
  const diagnostics = emptyFactEvidenceDiagnostics()
  const repairNotes: string[] = []
  const corrections: FactEvidenceCorrection[] = []
  const claims = normalizeFactClaims(
    [value], stopName, allowedSourceIds, availableSources, repairNotes, diagnostics, corrections, otherStopNames
  )
  const claim = claims[0]
  if (!claim) throw new ToolInputError('事实声明未通过结构检查。')
  return { claim, diagnostics }
}

/** 排除住宿和交通锚点，保留需安排时段的景点、餐馆及活动。 */
function isVisitStop(stop: ItineraryStop): boolean {
  if (/交通|接驳|住宿|酒店|航班|机场|车站|火车|高铁|动车|候车|进站|登机|值机/u.test(stop.category)) return false
  if (/餐|用餐|美食|景点|景区|休息|购物/u.test(stop.category)) return true
  return !/交通|接驳|住宿|酒店|航班|机场|车站|火车|高铁|动车|候车|进站|登机|值机/u.test(stop.name)
}

/** 排除餐饮和自由活动，只对需要游客规则的具体游览点检查开放预约事实。 */
function isAttractionStop(stop: ItineraryStop): boolean {
  return !/餐|用餐|美食|休息|购物|自由活动/u.test(`${stop.category} ${stop.name}`)
}

/** 详细日程至少给出起止时刻，或开始时刻加停留分钟数。 */
export function hasActionableTime(time: string, durationMinutes: number | null): boolean {
  const clockTimes = [...time.matchAll(/(?:^|[^\d])(?:[01]?\d|2[0-3]):[0-5]\d(?!\d)/gu)]
  return clockTimes.length >= 2 || (clockTimes.length === 1 && (durationMinutes ?? 0) > 0)
}

/** 游客规则可有可靠来源，也可明确保持待核验；估算不能充当开放或预约事实。 */
function hasSupportedFact(stop: ItineraryStop, types: ItineraryFactType[]): boolean {
  return (stop.factClaims ?? []).some((claim) => types.includes(claim.type) && (
    claim.evidenceLevel === 'pending' || (claim.evidenceLevel === 'sourced' && !!claim.sourceId)
  ))
}

/** 只有有来源 ID 的 sourced 声明才算完成事实核验。 */
function hasSourcedFact(stop: ItineraryStop, types: ItineraryFactType[]): boolean {
  return (stop.factClaims ?? []).some((claim) =>
    types.includes(claim.type) && claim.evidenceLevel === 'sourced' && !!claim.sourceId
  )
}

/** 每个游览日都要说明遇到风险后如何删减、保留或替换安排。 */
function hasDailyContingency(day: ItineraryDay): boolean {
  const notes = [
    ...day.stops.map((stop) => `${stop.notes} ${stop.transitToNext}`),
    ...(day.scheduleBlocks ?? []).map((block) => block.notes)
  ].join(' ')
  const namesRisk = /雨|降水|天气|客流|人流|拥堵|延误|排队|体力|临时闭馆/u.test(notes)
  const offersAction = /缩短|压缩|取消|删除|跳过|替换|改去|改到|转去|转到|优先保留|保留|备选|调整|改为/u.test(notes)
  return namesRisk && offersAction
}

/** 识别计划中明确写出的常见交通方式。 */
function hasTransitMode(value: string): boolean {
  return /地铁|公交|巴士|步行|打车|出租车|网约车|驾车|自驾|骑行|火车|高铁|动车|飞机|航班|轮渡|船|机场线|接驳|公共交通|交通方式待核验/u.test(value)
}

/** 缺少餐馆地点时只预留用餐窗口，并明确要求核验具体门店。 */
function ensureRequiredMealBlocks(
  days: ItineraryDay[],
  requirements: NonNullable<ToolContext['requiredMealSlots']>,
  requireNamedMealStops: boolean,
  repairNotes: string[]
): void {
  if (!requirements.length) return
  const labels = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' }
  for (const requirement of requirements) {
    const day = days.find((candidate) => candidate.date === requirement.date)
    if (!day) continue
    for (const slot of requirement.slots) {
      const restaurant = day.stops.find((stop) => /餐/u.test(stop.category) && mealSlotForStop(stop) === slot)
      if (restaurant) {
        if (!hasActionableTime(restaurant.time, restaurant.durationMinutes)) {
          const start = availableMealWindow(day, slot, restaurant.id, firstClockTimeMinutes(restaurant.time))
          if (start !== undefined) {
            restaurant.time = `${formatPlanningTime(start)}–${formatPlanningTime(start + 45)} ${labels[slot]}`
            restaurant.durationMinutes = 45
            repairNotes.push(`${requirement.date} 已为${labels[slot]}地点补入无冲突的规划时段；到店前核对营业时间。`)
          }
        }
        continue
      }
      let block = day.scheduleBlocks.find((candidate) => candidate.kind === 'meal' && mealSlotForBlock(candidate) === slot)
      if (!block) {
        if (day.scheduleBlocks.length >= 8) continue
        const start = availableMealWindow(day, slot)
        block = {
          id: randomUUID(), kind: 'meal',
          title: `${labels[slot]}${requireNamedMealStops ? '（店面待核验）' : ''}`,
          time: start === undefined ? '' : `${formatPlanningTime(start)}–${formatPlanningTime(start + 45)}`,
          durationMinutes: start === undefined ? null : 45,
          area: closestStopArea(day, start ?? (slot === 'breakfast' ? 7 * 60 + 30 : slot === 'lunch' ? 11 * 60 + 30 : 18 * 60)),
          notes: start === undefined
            ? `当前行程未找到无冲突的${labels[slot]}窗口，需后续调整；${requireNamedMealStops ? '具体店面尚未核验' : '用餐地点待确认'}。`
            : `已预留${labels[slot]}时段；${requireNamedMealStops ? '具体店面尚未核验' : '用餐地点待确认'}，按当日停留片区选择。`
        }
        day.scheduleBlocks.push(block)
        repairNotes.push(start === undefined
          ? `${requirement.date} 的${labels[slot]}时段待协调；请在审阅时调整日程。`
          : `${requirement.date} 已预留${labels[slot]}时段，具体店面待核验。`)
      } else {
        if (!hasActionableTime(block.time, block.durationMinutes)) {
          const start = availableMealWindow(day, slot, block.id, firstClockTimeMinutes(block.time))
          if (start !== undefined) {
            block.time = `${formatPlanningTime(start)}–${formatPlanningTime(start + 45)}`
            block.durationMinutes = 45
            repairNotes.push(`${requirement.date} 已为${labels[slot]}时间块补入无冲突的规划时段。`)
          }
        }
        if (requireNamedMealStops && !/店面待核验/u.test(block.title)) {
          block.title = `${block.title}（店面待核验）`.slice(0, 100)
          block.notes = `${block.notes ? `${block.notes} ` : ''}具体店面尚未核验。`.slice(0, 300)
        }
      }
    }
  }
}

/** 在不覆盖现有停留时段的前提下，找一个适合餐次的 45 分钟窗口。 */
function availableMealWindow(
  day: ItineraryDay,
  slot: 'breakfast' | 'lunch' | 'dinner',
  ignoredItemId?: string,
  preferredStart?: number,
  durationMinutes = 45
): number | undefined {
  const defaultCandidates = slot === 'breakfast' ? [450, 480, 510, 540, 570]
    : slot === 'lunch' ? [690, 720, 750, 780, 810, 840]
      : [1_050, 1_080, 1_110, 1_140, 1_170, 1_200]
  const candidates = preferredStart === undefined
    ? defaultCandidates
    : mealWindowCandidates(slot, preferredStart, defaultCandidates)
  const occupied = [
    ...day.stops.filter((item) => item.id !== ignoredItemId).map((item) => ({ time: item.time, duration: item.durationMinutes })),
    ...day.scheduleBlocks.filter((item) => item.id !== ignoredItemId && item.kind !== 'buffer')
      .map((item) => ({ time: item.time, duration: item.durationMinutes }))
  ].flatMap((item) => {
    const start = firstClockTimeMinutes(item.time)
    if (start === undefined) return []
    const end = lastClockTime(item.time)
    const endMinutes = end ? firstClockTimeMinutes(end) : undefined
    const rangeMinutes = endMinutes !== undefined && endMinutes > start ? endMinutes - start : 0
    return [{ start, end: start + Math.max(item.duration ?? 0, rangeMinutes, 60) }]
  })
  return candidates.find((start) => start + durationMinutes <= 1_440 &&
    occupied.every((item) => start + durationMinutes <= item.start || start >= item.end))
}

/** 有原定餐时而发生冲突时，在常规餐时范围内按距离寻找最近的半小时窗口。 */
function mealWindowCandidates(
  slot: 'breakfast' | 'lunch' | 'dinner',
  preferredStart: number,
  defaults: number[]
): number[] {
  const [minimum, maximum] = slot === 'breakfast' ? [360, 630]
    : slot === 'lunch' ? [660, 930] : [990, 1_290]
  const flexible = Array.from({ length: Math.floor((maximum - minimum) / 30) + 1 }, (_, index) => minimum + index * 30)
  return [...new Set([...flexible, ...defaults])]
    .sort((left, right) => Math.abs(left - preferredStart) - Math.abs(right - preferredStart) || left - right)
}

/** 将缺餐窗口放在当天最接近该时段的停留区域，避免假造店面或坐标。 */
function closestStopArea(day: ItineraryDay, targetMinutes: number): string {
  const closest = day.stops.map((stop) => ({ area: stop.area, minutes: firstClockTimeMinutes(stop.time) }))
    .filter((item): item is { area: string; minutes: number } => !!item.area && item.minutes !== undefined)
    .sort((left, right) => Math.abs(left.minutes - targetMinutes) - Math.abs(right.minutes - targetMinutes))[0]
  return closest?.area ?? day.stops.find((stop) => stop.area)?.area ?? ''
}

/** 把无法核实的景点规则和当日降级方案显示为待核验内容，不补造事实。 */
function ensureRequestedItineraryDetails(
  days: ItineraryDay[],
  requirements: { openingHours: boolean; booking: boolean; ticketPrice: boolean; contingencies: boolean },
  repairNotes: string[]
): void {
  let addedFacts = false
  let addedContingencies = false
  for (const day of days) {
    const attractions = day.stops.filter((stop) => isVisitStop(stop) && isAttractionStop(stop))
    for (const stop of attractions) {
      if (requirements.openingHours && !hasSupportedFact(stop, ['opening-hours', 'closure'])) {
        addPendingItineraryFact(stop, 'opening-hours', '开放与闭馆规则需按访问日期核验', day.date)
        addedFacts = true
      }
      if (requirements.booking && !hasSupportedFact(stop, ['booking'])) {
        addPendingItineraryFact(stop, 'booking', '预约与购票要求需按访问日期核验', day.date)
        addedFacts = true
      }
      if (requirements.ticketPrice && !hasSupportedFact(stop, ['ticket-price'])) {
        addPendingItineraryFact(stop, 'ticket-price', '具体票价需按访问日期核验', day.date)
        addedFacts = true
      }
    }
    if (requirements.contingencies && attractions.length > 0 && !hasDailyContingency(day)) {
      const message = '如遇下雨、客流大、交通延误或体力不足，缩短非核心室外停留，优先保留指定景点和预约；替代点需核验。'
      const target = [...attractions].sort((left, right) => left.notes.length - right.notes.length)[0]
      if (target) {
        const separator = target.notes.trim() ? ' ' : ''
        const retainedNotes = target.notes.slice(0, Math.max(0, 500 - message.length - separator.length)).trimEnd()
        target.notes = `${retainedNotes}${retainedNotes ? ' ' : ''}${message}`
        addedContingencies = true
      }
    }
  }
  if (addedFacts) repairNotes.push('缺少来源的开放/预约规则已逐点标为待核验。')
  if (addedContingencies) repairNotes.push('已补入保守的天气、客流、延误和体力调整顺序；替代点仍需核验。')
}

/** 无障碍是逐地点核验的行程条件；缺少证据时在结果结构中保留未知状态。 */
function ensureAccessibilityFactCoverage(
  days: ItineraryDay[],
  context: Parameters<TravelTool['execute']>[1],
  repairNotes: string[]
): void {
  if (!hasAccessibilityRequirement(context)) return

  let added = false
  for (const day of days) {
    for (const stop of day.stops) {
      if (!isVisitStop(stop)) continue
      added = addPendingAccessibilityFact(stop, '入口与连续轮椅通行', '入口、场内连续通行条件待核验') || added
      added = addPendingAccessibilityFact(stop, '无障碍卫生间', '卫生间位置与轮椅可用情况待核验') || added
      if (stop.transitToNext.trim()) {
        added = addPendingAccessibilityFact(stop, '下一段无障碍接驳', '站点、车辆及换乘的无台阶条件待核验') || added
      }
    }
  }
  if (added) repairNotes.push('已为各地点补入入口、通行、卫生间和相关接驳的无障碍核验状态。')
}

/** 不用单个“无障碍”标签代替入口、连续通行与卫生间等具体条件。 */
function addPendingAccessibilityFact(stop: ItineraryStop, scope: string, value: string): boolean {
  const normalizedScope = scope.normalize('NFKC').trim().toLocaleLowerCase()
  if ((stop.factClaims ?? []).some((claim) => claim.type === 'accessibility' &&
    claim.scope.normalize('NFKC').trim().toLocaleLowerCase() === normalizedScope)) return false
  if ((stop.factClaims?.length ?? 0) >= 8) {
    throw new ToolInputError(`地点“${stop.name}”的事实声明过多，无法同时呈现必须核验的无障碍条件；请减少重复事实后重试。`)
  }
  stop.factClaims ??= []
  stop.factClaims.push({
    id: randomUUID(), type: 'accessibility', value, scope, evidenceLevel: 'pending'
  })
  return true
}

/** 识别对行程有约束力的行动可达要求。 */
function hasAccessibilityRequirement(context: Parameters<TravelTool['execute']>[1]): boolean {
  const mobilityText = [context.tripBrief?.constraints, context.tripBrief?.transport, context.userRequest]
    .filter(Boolean).join('\n').normalize('NFKC')
  return /(?:轮椅|无障碍|行动不便|行动受限|无台阶|坡道|电梯|辅助出行)/u.test(mobilityText)
}

/** 无障碍正向断言必须绑定到能直接说明对应条件的来源。 */
function sanitizeAccessibilityAssertions(
  title: string,
  summary: string,
  tradeoffs: string,
  days: ItineraryDay[],
  context: Parameters<TravelTool['execute']>[1],
  repairNotes: string[]
): { title: string; summary: string; tradeoffs: string } {
  if (!hasAccessibilityRequirement(context)) {
    return { title, summary, tradeoffs }
  }

  let changed = false
  for (const day of days) {
    for (const stop of day.stops) {
      for (const field of ['name', 'area', 'notes'] as const) {
        if (!hasPositiveAccessibilityAssertion(stop[field]) || hasSourcedAccessibilityFact(stop, false)) continue
        const fieldLimit = field === 'name' ? 160 : field === 'area' ? 120 : 500
        stop[field] = replaceAccessibilityAssertions(stop[field]).slice(0, fieldLimit)
        changed = true
      }
      if (hasPositiveAccessibilityAssertion(stop.transitToNext) && !hasSourcedAccessibilityFact(stop, true)) {
        const cleaned = replaceAccessibilityAssertions(stop.transitToNext).replace(/[，,；;。\s]+$/u, '').trim()
        stop.transitToNext = `${cleaned || '交通方式及耗时待核验'}；无障碍接驳待核验。`.slice(0, 300)
        changed = true
      }
    }
  }

  const allStops = days.flatMap((day) => day.stops)
  const sanitizeNarrative = (value: string, limit: number): string => value
    .split(/(?<=[。！？；\n])/u)
    .map((sentence) => {
      if (!hasPositiveAccessibilityAssertion(sentence)) return sentence
      const referencedStops = allStops.filter((stop) => sentence.includes(stop.name))
      if (referencedStops.length && referencedStops.every((stop) => hasSourcedAccessibilityFact(stop, false))) return sentence
      changed = true
      return replaceAccessibilityAssertions(sentence)
    })
    .join('').slice(0, limit)

  for (const day of days) day.title = sanitizeNarrative(day.title, 100)
  const safe = {
    title: sanitizeNarrative(title, 120),
    summary: sanitizeNarrative(summary, 500),
    tradeoffs: sanitizeNarrative(tradeoffs, 500)
  }
  const unresolvedStops = allStops.filter((stop) => isVisitStop(stop) &&
    (stop.factClaims ?? []).some((claim) => claim.type === 'accessibility' && claim.evidenceLevel !== 'sourced'))
  if (unresolvedStops.length && !safe.tradeoffs.includes('无障碍可行性未确认')) {
    const warning = `无障碍可行性未确认：${unresolvedStops.length} 个地点仍有入口、通行、卫生间或接驳待核验；核实前不要将本方案视为轮椅可行路线。`
    safe.tradeoffs = [warning, safe.tradeoffs].filter(Boolean).join(' ').slice(0, 500)
  }
  if (changed) repairNotes.push('已将缺少逐地点直接来源的无障碍结论改为待核验，并在行程事实中保留具体缺项。')
  return safe
}

/** 将无直接来源的正向无障碍断言改成待核验，同时保留其余文案。 */
function replaceAccessibilityAssertions(value: string): string {
  const pattern = /(?:全园(?:均|都)?无障碍|无障碍(?:花园|绿色通道|入口|路线|通道|接驳|公交站|卫生间|厕所|公示|设施清单|服务承诺|行程|旅行|游览|舒行|一日|日游)(?![^。！？；\n]{0,8}(?:待核验|待确认|未核实|未知|需核实))|(?:有|具备|提供|设有)[^。！？；，,\n]{0,10}无障碍证据|无障碍设施(?:完善|齐全|可用|齐备)|无台阶(?:通行|入口|路线|接驳)?(?![^。！？；\n]{0,8}(?:待核验|待确认|未核实|未知|需核实))|平路(?:路线|段|通道)?|(?:轮椅|行动不便者?)(?:可达|可进入|友好|适用)|适合(?:轮椅|行动不便者?)|(?:设有|提供|配有|可使用)[^。！？；\n]{0,12}(?:电梯|坡道|无障碍卫生间|无障碍厕所))/gu
  return value.replace(pattern, '无障碍条件待核验')
}

/** 识别会让用户误以为轮椅条件已确认的表述。 */
function hasPositiveAccessibilityAssertion(value: string): boolean {
  const text = value.normalize('NFKC')
  return replaceAccessibilityAssertions(text) !== text
}

/** 景点设施和无障碍接驳分别核验，普通公共交通路线不算无障碍证据。 */
function hasSourcedAccessibilityFact(stop: ItineraryStop, transit: boolean): boolean {
  const scopePattern = transit
    ? /接驳|站点|车辆|换乘|公交|地铁|路线|交通/u
    : /入口|通行|卫生间|厕所|场内|园内|设施|路线|台阶|坡道|电梯/u
  return (stop.factClaims ?? []).some((claim) => claim.type === 'accessibility' &&
    claim.evidenceLevel === 'sourced' && !!claim.sourceId && scopePattern.test(claim.scope.normalize('NFKC')))
}

/** 来源不足时补一条结构化待核验事实；把估算降级后保留原始描述。 */
function addPendingItineraryFact(
  stop: ItineraryStop,
  type: 'opening-hours' | 'booking' | 'ticket-price',
  value: string,
  date: string
): void {
  const claims = stop.factClaims ?? (stop.factClaims = [])
  const existingEstimate = claims.find((claim) => claim.type === type && claim.evidenceLevel === 'estimated')
  if (existingEstimate) {
    existingEstimate.evidenceLevel = 'pending'
    delete existingEstimate.sourceId
    if (!/待核验/u.test(existingEstimate.value)) existingEstimate.value = `${existingEstimate.value}（待核验）`.slice(0, 200)
    return
  }
  if (claims.length >= 8) return
  claims.push({ id: randomUUID(), type, value, scope: date || '访问日期待确认', evidenceLevel: 'pending' })
}

/** 按本轮可用来源与日期生成机器可校验的计划 schema。 */
export function itineraryProposalDefinitionForBudget(options: Partial<ToolContext>): ToolDefinition {
  const {
    budgetRequested = true,
    tripBrief,
    sourceIds = [],
    availableSources = [],
    revisionBaseline,
    unchangedItineraryDates = []
  } = options
  const definition = structuredClone(itineraryProposalTool.definition)
  definition.function.description = '提交一份结构化行程计划。字段形状由 schema 限定；执行后会返回 error、warning 或 info。error 必须修正，warning 和 info 由你判断是否继续查询、修改或交付。'

  const properties = definition.function.parameters.properties as Record<string, unknown>
  const planProperties = (properties.plan as { properties?: Record<string, unknown> } | undefined)?.properties
  if (!budgetRequested && planProperties) delete planProperties.budget_estimate

  // 来源枚举只保留本轮已保存且可供计划引用的来源 ID。
  const factSourceIds = new Set(sourceIds)
  const eligibleSourceIds = [...new Set(availableSources
    .filter((source) => {
      const level = source.contentLevel ?? legacySourceContentLevel(source)
      return factSourceIds.has(source.id) && source.status === 'success' &&
        (source.kind === 'web' && level === 'page' && source.sourceNature !== 'community-platform' ||
          source.kind === 'user' && level === 'user-provided' ||
          source.kind === 'plugin' && level === 'plugin')
    })
    .map((source) => source.id))].slice(0, 20)
  const daysSchema = planProperties?.days as { minItems?: number; maxItems?: number; items?: { properties?: Record<string, unknown> } } | undefined
  const stopsSchema = daysSchema?.items?.properties?.stops as {
    items?: { properties?: Record<string, unknown> }
  } | undefined
  const factClaimsSchema = stopsSchema?.items?.properties?.fact_claims as {
    items?: { properties?: Record<string, unknown> }
  } | undefined
  const sourceIdSchema = factClaimsSchema?.items?.properties?.source_id as {
    enum?: Array<string | null>
  } | undefined
  if (sourceIdSchema) sourceIdSchema.enum = [...eligibleSourceIds, null]

  let confirmedDates: string[] | undefined
  try {
    confirmedDates = tripBrief ? datesForConfirmedTrip(tripBrief.startDate, tripBrief.endDate) : undefined
  } catch {
    confirmedDates = undefined
  }
  if (confirmedDates && daysSchema) {
    daysSchema.minItems = confirmedDates.length
    daysSchema.maxItems = confirmedDates.length
    const partialDays = scopedRevisionDays(revisionBaseline, unchangedItineraryDates, confirmedDates)
    if (partialDays) {
      daysSchema.minItems = partialDays.length
      daysSchema.maxItems = partialDays.length
      const dayProperties = daysSchema.items?.properties
      const dateProperty = dayProperties?.date as { enum?: string[] } | undefined
      if (dateProperty) dateProperty.enum = partialDays.map((day) => day.date)
      const dayNumberProperty = dayProperties?.day_number as { enum?: number[] } | undefined
      if (dayNumberProperty) {
        dayNumberProperty.enum = [...new Set([
          ...partialDays.map((day) => day.dayNumber),
          ...partialDays.map((_, index) => index + 1)
        ])]
      }
    }
  }
  return definition
}

/** 校验单份草案的地点覆盖、行程结构和事实来源。 */
function normalizePlan(
  value: unknown,
  context: Parameters<TravelTool['execute']>[1]
): { option: ItineraryOption; factEvidenceDiagnostics: ItineraryFactEvidenceDiagnostics; factEvidenceCorrections: FactEvidenceCorrection[]; feedback: ToolFeedback[] } {
  const userRequest = context.userRequest ?? context.tripBrief?.constraints ?? ''
  const candidates = Array.isArray(value) ? value.slice(0, 3) : value && typeof value === 'object' ? [value] : []
  if (candidates.length === 0) {
    throw new ToolInputError('请提交一份完整行程方案；需要调整时，请在下一轮提出修改意见。')
  }

  // 新模型契约只接受单个 plan；数组仅用于兼容旧恢复点，最多检查前三份。
  const failures: Array<{ message: string; code: string; severity: ToolFeedbackSeverity }> = []
  for (const [index, rawPlan] of candidates.entries()) {
    try {
      const normalized = normalizeOption(rawPlan, 0, context)
      const candidate = normalized.option
      const businessWarnings = [...normalized.businessWarnings]
      if (context.bookingAlternativeRequested) {
        const alternativeIssue = bookingAlternativeStructureIssue(candidate)
        if (alternativeIssue) businessWarnings.push(alternativeIssue)
      }
      if (context.dailyIndoorRainAlternativesRequested) {
        const rainAlternativeIssue = dailyIndoorRainAlternativeStructureIssue(candidate)
        if (rainAlternativeIssue) businessWarnings.push(rainAlternativeIssue)
      }
      const coverageIssue = explicitInitialReferenceCoverageIssue(candidate, userRequest)
      if (coverageIssue) businessWarnings.push(coverageIssue)
      const mealGaps = mealPreferenceFeedback(
        [candidate], context.requiredMealSlots ?? [], context.requireNamedMealStops === true,
        context.unchangedItineraryDates ?? [], 60
      )
      const namedMealGaps = mealGaps.filter(isNamedMealGap)
      const otherMealGaps = mealGaps.filter((gap) => !isNamedMealGap(gap))
      if (otherMealGaps.length) businessWarnings.push(...otherMealGaps)
      const routeCoverageWarnings = itineraryRouteCoverageFeedback(
        [candidate], context.detailedItineraryRequested === true || context.routeCoverageRequested === true
      )
      const visibleDetailGaps = normalized.detailGaps.filter((gap) => !isRouteCoverageGap(gap))
      const routeFeedback = unboundCurrentRunRouteFeedback(candidate, context)
      const feedback: ToolFeedback[] = [
        ...(namedMealGaps.length ? [{
          severity: 'warning' as const,
          code: 'requested_named_meals_missing',
          message: `${namedMealGaps.length} 个明确要求的餐次仍缺具体店名。可调用 propose_itinerary_meals；有把握真实存在的商户可作为待核验建议，不要推断分店、地址或营业信息。示例：${namedMealGaps.slice(0, 3).join('；')}。无法可靠推荐时保留待选。`
        }] : []),
        ...routeCoverageWarnings.map((message) => ({
          severity: 'warning' as const,
          code: 'requested_route_coverage_missing',
          message
        })),
        ...businessWarnings.slice(0, 12).map((message) => ({
          severity: 'warning' as const,
          code: 'plan_content_needs_review',
          message
        })),
        ...routeFeedback,
        ...(businessWarnings.length > 12 ? [{
          severity: 'warning' as const,
          code: 'plan_content_summary',
          message: `另有 ${businessWarnings.length - 12} 项内容建议，已省略重复细节。`
        }] : []),
        ...normalized.repairNotes.slice(0, 16).map((message) => ({
          severity: 'warning' as const,
          code: 'candidate_normalized',
          message
        })),
        ...(normalized.repairNotes.length > 16 ? [{
          severity: 'warning' as const,
          code: 'candidate_normalization_summary',
          message: `另有 ${normalized.repairNotes.length - 16} 项已自动修正，已省略重复细节。`
        }] : []),
        ...(visibleDetailGaps.length > 0 ? [{
          severity: 'warning' as const,
          code: 'requested_detail_missing',
          message: visibleDetailGaps.slice(0, 12).join('；')
        }] : []),
        ...(normalized.factEvidenceDiagnostics.rejectedCount > 0 ? [{
          severity: 'warning' as const,
          code: 'fact_evidence_rejected',
          message: `${normalized.factEvidenceDiagnostics.rejectedCount} 条事实依据未通过匹配校验；保留为待核验。`
        }] : [])
      ]
      return { ...normalized, feedback }
    } catch (error) {
      if (!(error instanceof ToolInputError)) throw error
      failures.push({ message: `候选 ${index + 1}：${error.message}`, code: error.code, severity: error.severity })
    }
  }

  const severity = failures.some((failure) => failure.severity === 'error') ? 'error' : 'warning'
  const messages = [...new Set(failures.map((failure) => failure.message))].join('\n').slice(0, 1_200)
  const codes = [...new Set(failures.map((failure) => failure.code))]
  const code = codes.length === 1 ? codes[0]! : 'itinerary_candidate_rejected'
  throw new ToolInputError(messages || '没有可审阅的完整行程方案。', code, severity)
}

/** 将本轮成功但未绑定到方案通勤段的路线结果作为可审阅诊断返回给模型。 */
function unboundCurrentRunRouteFeedback(
  option: ItineraryOption,
  context: Parameters<TravelTool['execute']>[1]
): ToolFeedback[] {
  const currentSourceIds = new Set(context.currentRunSourceIds ?? [])
  const availableRouteSources = (context.availableSources ?? []).filter((source) =>
    source.kind === 'route' && source.status === 'success'
  )
  if (availableRouteSources.length === 0) return []
  const routeSources = availableRouteSources.filter((source) => currentSourceIds.has(source.id))

  const linkedSourceIds = new Set(option.days.flatMap((day) => [
    ...(day.lodgingCommutes ?? []).map((commute) => commute.sourceId),
    ...day.stops.flatMap((stop) => stop.transitEstimate?.sourceId ? [stop.transitEstimate.sourceId] : [])
  ]))
  const unboundSources = routeSources.filter((source) => !linkedSourceIds.has(source.id))

  const routeSegments = option.days.flatMap((day) => day.stops.slice(0, -1).map((origin, index) => ({
      date: day.date,
      origin,
      destination: day.stops[index + 1]!
    })))
  const issueCounts = new Map<RouteBindingIssue, number>()
  const diagnosedSources = unboundSources.map((source) => {
    const matchingSegments = routeSegments.filter(({ origin, destination }) =>
      routeTitleMatchesStops(source.title, origin, destination)
    )
    const issue = routeBindingIssue(source, matchingSegments)
    issueCounts.set(issue, (issueCounts.get(issue) ?? 0) + 1)
    return { source, issue }
  })
  // 只记固定计数，区分来源未进入本轮上下文、已关联和仍待处理，不保存地点或路线文本。
  logSystemEvent(unboundSources.length ? 'warn' : 'info', 'agent.route.binding_diagnostic', {
    ...(context.traceId ? { traceId: context.traceId } : {}),
    status: unboundSources.length ? 'partial' : 'completed',
    routeAvailableCount: availableRouteSources.length,
    routeCurrentRunCount: routeSources.length,
    routeLinkedCount: routeSources.length - unboundSources.length,
    routeUnboundCount: unboundSources.length,
    routeBindingNoAdjacentCount: issueCounts.get('no_adjacent_segment') ?? 0,
    routeBindingModeMismatchCount: issueCounts.get('mode_mismatch') ?? 0,
    routeBindingDateMismatchCount: issueCounts.get('query_date_mismatch') ?? 0,
    routeBindingTimeMismatchCount: issueCounts.get('query_time_mismatch') ?? 0,
    routeBindingSummaryUnreadableCount: issueCounts.get('route_summary_unreadable') ?? 0,
    routeBindingMatchingButUnlinkedCount: issueCounts.get('matching_route_not_bound') ?? 0
  })
  if (unboundSources.length === 0) return []

  const diagnostics = routeBindingIssueLabels.flatMap(([issue, label]) => {
    const count = issueCounts.get(issue) ?? 0
    return count ? [`${label} ${count} 条`] : []
  })
  const issueLabels = new Map(routeBindingIssueLabels)
  const examples = diagnosedSources.slice(0, 2).map(({ source, issue }) => {
    const routeSummary = source.summary.split(/\r?\n/u, 1)[0]?.slice(0, 140) || source.title.slice(0, 100)
    return `${routeSummary}（${issueLabels.get(issue)}）`
  })
  const omitted = unboundSources.length - examples.length
  const sourceSummary = examples.length ? `（${examples.join('；')}${omitted > 0 ? `；另有 ${omitted} 条` : ''}）` : ''
  const missingSegments = routeSegments
    .filter(({ origin }) => !origin.transitEstimate)
    .slice(0, 3)
    .map(({ date, origin, destination }) => {
      const mode = routeModeFromDescription(origin.transitToNext)
      const modeLabel = mode === 'transit' ? '公共交通' : mode === 'walking' ? '步行' : mode === 'driving' ? '驾车' : '交通方式待明确'
      const departureTime = plannedRouteDepartureTime(origin)
      const timeLabel = departureTime ? `${departureTime} 离开` : '出发时刻待明确'
      return `${date || '日期待确认'}：${origin.name} → ${destination.name}（${modeLabel}，${timeLabel}）`
    })
  const missingSegmentSummary = missingSegments.length
    ? `当前计划尚无已绑定估时的路段示例：${missingSegments.join('；')}。`
    : ''
  return [{
    severity: 'warning',
    code: 'route_source_not_bound',
    message: `本轮有 ${unboundSources.length} 条成功路线结果未关联到方案通勤段；匹配诊断：${diagnostics.join('；') || '未发现可关联路段'}。来源示例${sourceSummary}。${missingSegmentSummary}这些路线不能作为当前计划的已核验通勤；可按需选择少量关键路段，用计划中的原停靠点、对应日期和交通方式补查。与当前计划无关的结果忽略，不要强行引用或穷举路线；未补查的时长保留待核验。`
  }]
}

type RouteBindingIssue =
  | 'no_adjacent_segment'
  | 'planned_mode_unclear'
  | 'mode_mismatch'
  | 'trip_date_unknown'
  | 'query_date_mismatch'
  | 'query_time_mismatch'
  | 'route_summary_unreadable'
  | 'matching_route_not_bound'

const routeBindingIssueLabels: Array<[RouteBindingIssue, string]> = [
  ['no_adjacent_segment', '无相邻端点'],
  ['planned_mode_unclear', '计划交通方式未明确'],
  ['mode_mismatch', '交通方式不匹配'],
  ['trip_date_unknown', '计划日期未确认'],
  ['query_date_mismatch', '公交查询日期不匹配'],
  ['query_time_mismatch', '公交查询时刻不匹配'],
  ['route_summary_unreadable', '路线摘要缺少可核对指标'],
  ['matching_route_not_bound', '端点、方式和日期匹配但未关联']
]

/** 说明成功路线未绑定的首要原因，不替模型决定是否改计划或继续查询。 */
function routeBindingIssue(
  source: SourceRecord,
  matchingSegments: Array<{ date: string; origin: ItineraryStop; destination: ItineraryStop }>
): RouteBindingIssue {
  if (matchingSegments.length === 0) return 'no_adjacent_segment'

  const inspections = matchingSegments.map(({ date, origin }) => {
    const mode = routeModeFromDescription(origin.transitToNext)
    if (!mode) return { ok: false as const, reason: 'planned_mode_unclear' as const }
    return inspectSuccessfulRouteSummary(source, date, origin, mode)
  })
  if (inspections.some((inspection) => inspection.ok)) return 'matching_route_not_bound'

  const reasons = new Set(inspections.flatMap((inspection) => inspection.ok ? [] : [inspection.reason]))
  for (const [issue] of routeBindingIssueLabels) {
    if (reasons.has(issue as RouteSummaryFailure)) return issue
  }
  return 'route_summary_unreadable'
}

/** 确保预约失败预案是一项可独立呈现、可继续补证据的结构化地点。 */
function bookingAlternativeStructureIssue(option: ItineraryOption): string | undefined {
  const stops = option.days.flatMap((day) => day.stops)
  const scheduledNames = new Set(stops.map((stop) => normalizeAlternativeText(stop.name)))
  const duplicates = stops.flatMap((stop) => (stop.conditionalAlternatives ?? [])
    .filter((alternative) => {
      const name = normalizeAlternativeText(alternative.name)
      return name !== normalizeAlternativeText(stop.name) && scheduledNames.has(name)
    })
    .map((alternative) => alternative.name))
  if (duplicates.length) {
    return `条件备选已出现在正式行程中：${[...new Set(duplicates)].join('、')}。请改为未列入正式行程的具体候选，或移除重复备选。`
  }
  for (const stop of stops) {
    const alternative = stop.conditionalAlternatives?.find((item) => {
      const name = normalizeAlternativeText(item.name)
      const host = normalizeAlternativeText(stop.name)
      return name !== host && !scheduledNames.has(name) && item.area.trim().length > 0 && item.trigger.trim().length > 0 &&
        !/^(?:备选点|替代点|备选地点|替代地点|待选|待补|附近景点|同区域景点)$/u.test(name)
    })
    if (alternative) return undefined
  }
  return '预约失败预案缺少结构化条件备选。请在一处主停靠点的 conditional_alternatives 中填写不同于主地点和正式行程地点的具体候选、片区和触发条件；无直接来源时可标为 pending。'
}

/** 比较备选与主地点时忽略空格和常见标点。 */
function normalizeAlternativeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, '')
}

/** 用户逐日要求雨天室内备选时，检查每个游览日都有独立结构化替代地点。 */
function dailyIndoorRainAlternativeStructureIssue(option: ItineraryOption): string | undefined {
  const missingDates = option.days.flatMap((day) => {
    const visitStops = day.stops.filter(isVisitStop)
    if (!visitStops.length) return []
    const scheduledNames = new Set(day.stops.map((stop) => normalizeAlternativeText(stop.name)))
    const valid = visitStops.some((stop) => (stop.conditionalAlternatives ?? []).some((alternative) =>
      alternative.environment === 'indoor' && alternative.area.trim().length > 0 &&
      /雨|降水|降雨/u.test(alternative.trigger) && !scheduledNames.has(normalizeAlternativeText(alternative.name)) &&
      !/^(?:备选点|替代点|备选地点|替代地点|待选|待补|附近室内活动)$/u.test(normalizeAlternativeText(alternative.name))
    ))
    return valid ? [] : [day.date || `第 ${day.dayNumber} 天`]
  })
  return missingDates.length
    ? `以下游览日缺少结构化室内雨天替代：${missingDates.join('、')}。请在当天主停靠点的 conditional_alternatives 中补充具体地点、片区、降雨触发条件和 environment=indoor；有直接地点来源时填写来源 ID，无来源时保留 pending；不要把备选排入正式时段。`
    : undefined
}

/** 列出方案中与用户原话相符的游览点，用于核对明确的参考点覆盖要求。 */
export function userReferencedVisits(option: ItineraryOption, userText: string): Array<{ date: string; dayNumber: number; name: string }> {
  const request = normalizeVisitMatch(userText)
  return option.days.flatMap((day) => {
    const names = day.stops
      .filter((stop) => !/餐|早餐|午餐|晚餐|用餐|休息|交通|接驳|住宿|酒店|航班|机场|车站|候车|候机/u.test(`${stop.category} ${stop.name}`))
      .filter((stop) => visitAliases(stop.name).some((alias) => request.includes(normalizeVisitMatch(alias))))
      .map((stop) => stop.name)
    return [...new Set(names)].map((name) => ({ date: day.date, dayNumber: day.dayNumber, name }))
  })
}

/** 单份方案需满足用户明确给出的参考地点最低覆盖比例。 */
function explicitInitialReferenceCoverageIssue(candidate: ItineraryOption, userText: string): string | undefined {
  const requirement = explicitReferenceCoverageRequirement(userText)
  if (!requirement) return undefined
  const present = userReferencedVisits(candidate, userText).length
  return present >= requirement.minimum
    ? undefined
    : `本份方案覆盖 ${present}/${requirement.total} 个用户点名的参考地点，低于至少 ${requirement.minimum} 个的要求；请按日期补齐原始请求中的参考地点。`
}

/** 只采用用户明确写出的“至少 N/M 项”覆盖目标。 */
function explicitReferenceCoverageRequirement(userText: string): { minimum: number; total: number } | undefined {
  const match = userText.match(/(?:至少|不少于|不低于)(?:需要|覆盖|保留)?\s*(\d+)\s*[／/]\s*(\d+)\s*(?:项|处|个(?:参考)?(?:地点|景点)?)/u)
  if (!match) return undefined
  const minimum = Number(match[1])
  const total = Number(match[2])
  return Number.isSafeInteger(minimum) && Number.isSafeInteger(total) && minimum > 0 && total >= minimum
    ? { minimum, total }
    : undefined
}

/** 生成常见地点短名，避免用整句或类别词匹配用户请求。 */
function visitAliases(name: string): string[] {
  const aliases = new Set<string>()
  for (const part of name.split(/[（(]/u)) {
    let alias = part.replace(/[）)]/gu, '').trim()
    if (!alias) continue
    aliases.add(alias)
    alias = alias.replace(/^(?:中国|北京市|北京)/u, '')
    if (alias) aliases.add(alias)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const shorter = alias.replace(/(?:东宫门|北宫门|南门|北门|东门|西门|入口|出口|遗址公园|博物馆|博物院|纪念馆|展览馆|风景区|步行街|大街|公园|景区)$/u, '')
      if (!shorter || shorter === alias) break
      alias = shorter
      aliases.add(alias)
    }
  }
  return [...aliases].filter((alias) => alias.length >= 2 && !/^(?:景点|景区|公园|博物馆|博物院|纪念馆|展览馆|入口|出口)$/u.test(alias))
}

/** 统一标点和空白，以处理日期分隔符及全半角写法。 */
function normalizeVisitMatch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 解析用户明确要求午餐后回酒店休息的目标日期。 */
function requestedPostLunchHotelRestDates(
  days: ItineraryDay[],
  context: ToolContext
): string[] {
  const request = context.userRequest ?? ''
  const requestPattern = /(?:午餐|午饭)(?:结束后|后).{0,32}(?:回|返回|回到|返|到|前往).{0,12}(?:酒店|住宿).{0,12}(?:休息|休整|午休)/u
  const match = requestPattern.exec(request)
  if (!match) return []

  const datePattern = /(?:(20\d{2})\s*(?:年|[-/.])\s*)?(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*(?:日|号)?/gu
  // 路线修订会临时改变可修改日期；优先依据用户原话中最近的明确日期定位休息日。
  const requestBeforeRest = request.slice(Math.max(0, match.index - 120), match.index)
  const precedingDate = [...requestBeforeRest.matchAll(datePattern)].at(-1)
  datePattern.lastIndex = 0
  const followingDate = precedingDate
    ? undefined
    : datePattern.exec(request.slice(match.index + match[0].length, match.index + match[0].length + 32))
  const explicitDate = precedingDate ?? followingDate
  if (explicitDate) {
    const year = explicitDate[1]
    const month = Number(explicitDate[2])
    const date = Number(explicitDate[3])
    const datedTargets = new Set(days.flatMap((day) => {
      if (!day.date) return []
      const sameMonthAndDate = Number(day.date.slice(5, 7)) === month && Number(day.date.slice(8, 10)) === date
      return sameMonthAndDate && (!year || day.date.startsWith(`${year}-`)) ? [day.date] : []
    }))
    if (datedTargets.size === 1) return [...datedTargets]
    return []
  }

  const baseline = context.revisionBaseline
  if (baseline) {
    const protectedDates = new Set(context.unchangedItineraryDates ?? unchangedItineraryDatesForRequest(request, baseline))
    const mutableDates = baseline.days
      .filter((day) => day.date && !protectedDates.has(day.date))
      .map((day) => day.date)
    if (mutableDates.length === 1 && days.some((day) => day.date === mutableDates[0])) return mutableDates
  }
  return []
}

/** 判断时间块是否明确表示午餐后的酒店休息。 */
function isPostLunchHotelRestBlock(block: ItineraryScheduleBlock): boolean {
  if (block.kind !== 'rest' && block.kind !== 'buffer') return false
  const identity = `${block.title} ${block.area} ${block.notes}`
  const sequence = `${block.time} ${block.title} ${block.notes}`
  return /酒店|住宿/u.test(identity) && /休息|休整|午休/u.test(identity) && /午餐后|午饭后|午餐结束后|午饭结束后/u.test(sequence)
}

/** 将明确要求的午餐后酒店休息落入行程结构，未知通勤和时长保持待核验。 */
function ensureRequestedHotelRestAfterLunch(
  days: ItineraryDay[],
  context: ToolContext,
  repairNotes: string[],
  businessWarnings: string[]
): void {
  const targetDates = requestedPostLunchHotelRestDates(days, context)
  for (const date of targetDates) {
    const day = days.find((item) => item.date === date)
    if (!day || day.scheduleBlocks.some((block) => isPostLunchHotelRestBlock(block))) continue

    const lunchItems = [
      ...day.stops.filter((stop) => mealSlotForStop(stop) === 'lunch'),
      ...day.scheduleBlocks.filter((block) => mealSlotForBlock(block) === 'lunch')
    ]
    const lunchEnds = lunchItems.flatMap((item) => {
      const end = 'category' in item
        ? proposedStopEndMinute(item)
        : proposedTimeEndMinute(item.time, item.durationMinutes)
      return end === undefined ? [] : [end]
    })
    const latestLunchEnd = lunchEnds.length > 0 ? Math.max(...lunchEnds) : undefined
    const existingHotelRest = day.scheduleBlocks.find((block) =>
      (block.kind === 'rest' || block.kind === 'buffer') &&
      /酒店|住宿/u.test(`${block.title} ${block.area} ${block.notes}`) &&
      /休息|休整|午休/u.test(`${block.title} ${block.notes}`)
    )
    if (existingHotelRest) {
      const restStart = firstClockTimeMinutes(existingHotelRest.time)
      if (latestLunchEnd !== undefined && restStart !== undefined && restStart >= latestLunchEnd) continue
      // 复用已有酒店休息块，避免保留午餐前休息后再重复新增一块。
      existingHotelRest.kind = 'rest'
      existingHotelRest.title = '午餐后回酒店休息'
      existingHotelRest.time = '午餐后'
      existingHotelRest.area = context.tripBrief?.lodgingLocation || context.tripBrief?.lodging || '酒店'
      existingHotelRest.durationMinutes = null
      existingHotelRest.notes = '按用户要求改到午餐后；酒店接驳与休息时长待核验。'
      repairNotes.push(`${date} 已将酒店休息时间块调整到午餐后；酒店接驳与休息时长待核验。`)
      continue
    }
    if (day.scheduleBlocks.length >= 8) {
      businessWarnings.push(`${date} 已达到时间块上限，尚未安排用户要求的午餐后酒店休息；请判断是否合并其他时间块。`)
      continue
    }
    day.scheduleBlocks.push({
      id: randomUUID(),
      kind: 'rest',
      title: '午餐后回酒店休息',
      time: '午餐后',
      durationMinutes: null,
      area: context.tripBrief?.lodgingLocation || context.tripBrief?.lodging || '酒店',
      notes: '按用户要求安排；酒店接驳与休息时长待核验。'
    })
    repairNotes.push(`${date} 已加入用户明确要求的午餐后酒店休息时间块；酒店接驳与休息时长待核验。`)
  }
}

/** 对单套方案执行完整结构、时间、来源和用户约束校验。 */
function normalizeOption(
  rawOption: unknown,
  optionIndex: number,
  context: Parameters<TravelTool['execute']>[1]
): { option: ItineraryOption; factEvidenceDiagnostics: ItineraryFactEvidenceDiagnostics; factEvidenceCorrections: FactEvidenceCorrection[]; repairNotes: string[]; detailGaps: string[]; businessWarnings: string[] } {
  const option = asObject(rawOption, '方案')
  const repairNotes: string[] = []
  const businessWarnings: string[] = []
  const factEvidenceDiagnostics = emptyFactEvidenceDiagnostics()
  const factEvidenceCorrections: FactEvidenceCorrection[] = []
  const rawTitle = normalizeOptionTitle(option.title, optionIndex, repairNotes)
  const rawSummary = modelTextOrFallback(option.summary, '方案摘要', 500, '', repairNotes)
  const rawTradeoffs = modelTextOrFallback(option.tradeoffs, '方案取舍', 500, '', repairNotes)
  const scopedRevision = scopedRevisionDays(
    context.revisionBaseline,
    context.unchangedItineraryDates ?? [],
    datesForConfirmedTrip(context.tripBrief?.startDate, context.tripBrief?.endDate)
  )
  const budgetEstimate = option.budget_estimate === undefined
    ? context.budgetRequested
      ? scopedRevision && context.revisionBaseline?.budgetEstimate
        ? structuredClone(context.revisionBaseline.budgetEstimate)
        : normalizeBudgetEstimate({ currency: 'CNY', items: [], not_applicable_categories: [] }, context, repairNotes)
      : undefined
    : normalizeBudgetEstimate(option.budget_estimate, context, repairNotes)
  if (context.budgetRequested && option.budget_estimate === undefined) {
    repairNotes.push('模型未提供费用金额；适用费用类别已逐项列为待核验，未计入金额小计。')
  }
  if (!Array.isArray(option.days)) throw new ToolInputError('本份方案的 days 必须是数组。')
  if (option.days.length < 1 || option.days.length > 7) {
    throw new ToolInputError('本份方案必须包含 1–7 天。')
  }
  const expectedDates = context.tripBrief
    ? datesForConfirmedTrip(context.tripBrief.startDate, context.tripBrief.endDate)
    : undefined
  if (expectedDates && option.days.length !== expectedDates.length) {
    businessWarnings.push(`已确认日期范围为 ${expectedDates.length} 天，当前草案有 ${option.days.length} 天；请判断是否补齐或调整日期。`)
  }
  const days = normalizeRevisionDays(
    option.days, context, repairNotes, factEvidenceDiagnostics, factEvidenceCorrections, businessWarnings
  )
  removeExplicitlyExcludedStops(days, context, repairNotes)
  normalizeArrivalMomentStops(days, context.tripBrief, repairNotes)
  removeUnconfirmedArrivalHub(days, context.tripBrief, context.userRequest ?? '', repairNotes)
  const title = normalizePlanTitle(rawTitle, days, context.tripBrief)
  // 局部修改先恢复未选中的日期，避免模型无关改写先触发行程硬校验。
  const unchangedDates = context.unchangedItineraryDates ?? []
  const protectedCandidate = preserveUnchangedItineraryDays(context.revisionBaseline, {
    id: 'validation-candidate', title, summary: rawSummary, tradeoffs: rawTradeoffs, days
  }, unchangedDates)
  days.splice(0, days.length, ...protectedCandidate.days)
  deferUnspecifiedArrivalDayMealTimes(days, context, repairNotes)
  ensureFlightDepartureStop(days, context.tripBrief, repairNotes)
  ensureAirportArrivalDeadlineStop(days, context.tripBrief, repairNotes)
  ensureArrivalTimeAnchor(days, context.tripBrief, repairNotes)
  deferArrivalTransferStartingAtLanding(days, context.tripBrief, repairNotes)
  ensureArrivalLodgingStop(days, context.tripBrief, repairNotes)
  orderDeferredArrivalMealsAfterAnchors(days, context.tripBrief)
  ensureDepartureStop(days, context.tripBrief, repairNotes)
  ensureHotelDepartureStop(days, context.tripBrief, repairNotes, businessWarnings)
  try {
    validateDailyActivityStops(
      days, context.tripBrief, context.userRequest ?? '', context.unchangedItineraryDates ?? []
    )
  } catch (error) {
    if (!(error instanceof ToolInputError)) throw error
    businessWarnings.push(error.message)
  }
  if (days.some((day) => day.stops.length > MAX_ITINERARY_STOPS_PER_DAY)) {
    throw new ToolInputError(`系统补齐后每天最多保留 ${MAX_ITINERARY_STOPS_PER_DAY} 个地点；请合并低优先级安排后重试。`)
  }
  ensureTransitDescriptions(days, context.tripBrief, repairNotes, context.detailedItineraryRequested === true)
  ensureRequiredMealBlocks(days, context.requiredMealSlots ?? [], context.requireNamedMealStops === true, repairNotes)
  // 必需餐次可能刚在上一步补成时间块；抵达日规则需覆盖这些新建项目。
  deferUnspecifiedArrivalDayMealTimes(days, context, repairNotes)
  orderDeferredArrivalMealsAfterAnchors(days, context.tripBrief)
  ensureHighIntensityRestBuffers(days, context, repairNotes)
  ensureRequestedItineraryDetails(days, {
    openingHours: context.openingHoursDetailsRequested === true,
    booking: context.bookingDetailsRequested === true,
    ticketPrice: context.ticketPriceDetailsRequested === true,
    contingencies: context.itineraryContingenciesRequested === true
  }, repairNotes)
  ensureRequestedPhotographyFacts(days, context, repairNotes)
  // 抵离锚点和其他确定性修复完成后，再按时刻稳定排序本轮修改日期。
  const protectedDateSet = new Set(unchangedDates)
  for (const day of days) {
    if (!protectedDateSet.has(day.date)) {
      sortStopsByExplicitTime(day.stops, context.tripBrief?.lodgingLocation ?? '', repairNotes)
    }
  }
  orderArrivalAnchorsBeforeRelativeStops(days, context.tripBrief, unchangedDates)
  // 恢复锚点修复可能触碰的基线日，并在展示前校验最终草案。
  const scopedCandidate = preserveUnchangedItineraryDays(context.revisionBaseline, {
    id: 'validation-candidate', title, summary: rawSummary, tradeoffs: rawTradeoffs, days
  }, unchangedDates)
  days.splice(0, days.length, ...scopedCandidate.days)
  ensureRequestedHotelRestAfterLunch(days, context, repairNotes, businessWarnings)
  const mealRequirements = mealRequirementsWithRequestedTimes(
    days,
    context.revisionBaseline?.mealRequirements ?? [],
    context.requiredMealSlots ?? [],
    `${context.userRequest ?? ''}\n${context.tripBrief?.constraints ?? ''}`
  )
  const excludedStops = context.excludedItineraryStops ?? (context.revisionBaseline
    ? explicitlyExcludedItineraryStopsForRequest(context.userRequest ?? '', context.revisionBaseline, unchangedDates)
    : [])
  try {
    validateExplicitlyExcludedItineraryStops(days, excludedStops)
  } catch (error) {
    if (!(error instanceof ToolInputError)) throw error
    businessWarnings.push(error.message)
  }
  const fieldScopedCandidate = preserveScopedItineraryEdits(
    context.userRequest ?? '', context.revisionBaseline,
    { id: 'validation-candidate', title, summary: rawSummary, tradeoffs: rawTradeoffs, days },
    unchangedDates
  )
  days.splice(0, days.length, ...fieldScopedCandidate.days)
  preserveExistingMealCandidatesForAreaRevision(
    context.userRequest ?? '', context.revisionBaseline, days, unchangedDates,
    context.tripBrief?.destination ?? ''
  )
  alignExplicitMealTimesToRequest(
    days,
    `${context.userRequest ?? ''}\n${context.tripBrief?.constraints ?? ''}`,
    repairNotes,
    new Set(unchangedDates)
  )
  attachUserApprovedInVenueLunches(
    days,
    `${context.userRequest ?? ''}\n${context.tripBrief?.constraints ?? ''}`,
    repairNotes,
    new Set(unchangedDates)
  )
  // 先应用用户明确餐时和馆内用餐许可，再修复剩余的未指定餐时冲突。
  const repairedMealDates = repairUnspecifiedMealOverlaps(days, context, repairNotes, new Set(unchangedDates))
  for (const day of days) {
    if (repairedMealDates.has(day.date)) {
      sortStopsByExplicitTime(day.stops, context.tripBrief?.lodgingLocation ?? '', repairNotes)
    }
  }
  try {
    validateCandidateSchedule(
      days, context.requireNamedMealStops === true, mealRequirements, context.tripBrief,
      repairNotes, new Set(unchangedDates), excludedStops
    )
  } catch (error) {
    if (!(error instanceof ToolInputError)) throw error
    businessWarnings.push(error.message)
  }
  const summary = rawSummary
    ? normalizePlanNarrative(rawSummary, '方案摘要', days, planSummaryFallback(days), repairNotes)
    : planSummaryFallback(days)
  const normalizedTradeoffs = normalizePlanNarrative(rawTradeoffs, '方案取舍', days,
    planTradeoffsFallback(days, budgetEstimate, context), repairNotes)
  const tradeoffs = normalizeBudgetEvidenceSummary(normalizedTradeoffs, budgetEstimate, context, repairNotes)
  const requiredTradeoffNotes = requiredPlanTradeoffNotes(tradeoffs, days, budgetEstimate, context)
  // 校验器修复记录用于内部检查；安排说明只保留用户审阅和决策需要的信息。
  const finalTradeoffs = removeResolvedBudgetComparisonPending(
    [tradeoffs, ...requiredTradeoffNotes].filter(Boolean).join(' ').slice(0, 500)
  )
  const finalTitle = normalizeTitleAgainstTradeoffs(title, finalTradeoffs, repairNotes)
  const candidate: ItineraryOption = {
    id: randomUUID(), title: finalTitle, summary, tradeoffs: finalTradeoffs,
    ...(mealRequirements.length ? { mealRequirements } : {}),
    ...(budgetEstimate ? { budgetEstimate } : {}),
    days
  }
  // 在候选展示前核对已确认的固定安排，避免用户审阅后才发现方案无法采纳。
  const lockedStops = preserveLockedStops(context.itinerary, candidate)
  if (lockedStops.conflicts.length) {
    businessWarnings.push(`新方案与已固定安排冲突：${lockedStops.conflicts.join(' ')}`)
  }
  // 固定地点恢复可能带回旧字段；交付前再次保证每个最终停靠点都有无障碍状态。
  ensureAccessibilityFactCoverage(lockedStops.itinerary.days, context, repairNotes)
  linkUniquePendingFactSources(lockedStops.itinerary.days, context, repairNotes)
  const detailGaps = itineraryDetailFeedback([lockedStops.itinerary], {
    detailed: context.detailedItineraryRequested === true,
    routeCoverage: context.routeCoverageRequested === true,
    openingHours: context.openingHoursDetailsRequested === true,
    booking: context.bookingDetailsRequested === true,
    ticketPrice: context.ticketPriceDetailsRequested === true,
    contingencies: context.itineraryContingenciesRequested === true
  })
  if (detailGaps.length) {
    const categories = [
      ['缺少可执行的游览时段', '逐站时段'],
      ['缺少明确开始时刻和时长', '时间块时段'],
      ['缺少交通方式或明确终点', '逐段交通'],
      ['缺少来源估时', '关键通勤估时'],
      ['缺少开放/闭馆事实', '开放/闭馆事实'],
      ['缺少预约事实', '预约事实'],
      ['缺少票价事实', '票价事实'],
      ['缺少天气/人流/延误变化时的调整或替代安排', '日内备选']
    ] as const
    const summary = [...new Set(categories.flatMap(([needle, label]) =>
      detailGaps.some((gap) => gap.includes(needle)) ? [label] : []
    ))]
    lockedStops.itinerary.tradeoffs = [
      `详细安排待补：${summary.join('、')}。`,
      lockedStops.itinerary.tradeoffs
    ].filter(Boolean).join(' ').slice(0, 500)
  }
  const safeAccessibility = sanitizeAccessibilityAssertions(
    lockedStops.itinerary.title,
    lockedStops.itinerary.summary,
    lockedStops.itinerary.tradeoffs,
    lockedStops.itinerary.days,
    context,
    repairNotes
  )
  lockedStops.itinerary.title = safeAccessibility.title
  lockedStops.itinerary.summary = compactPlanSummary(safeAccessibility.summary)
  lockedStops.itinerary.tradeoffs = safeAccessibility.tradeoffs
  return {
    option: lockedStops.itinerary,
    factEvidenceDiagnostics,
    factEvidenceCorrections,
    repairNotes: [...new Set(repairNotes)],
    detailGaps,
    businessWarnings: [...new Set(businessWarnings)]
  }
}

/** 在草案交付前拦截仍出现在正式行程中的明确删除项。 */
function validateExplicitlyExcludedItineraryStops(
  days: ItineraryDay[],
  excludedStops: NonNullable<ToolContext['excludedItineraryStops']>
): void {
  const conflicts = excludedStops.flatMap((excluded) => {
    const day = days.find((item) => item.date === excluded.date)
    const remainingStop = day?.stops.find((stop) => itineraryStopNameMatches(excluded.stopName, stop.name) ||
      (!/(?:餐|美食|住宿|酒店|航班|机场|车站|候车|进站|购物)/u.test(stop.category) &&
        explicitlyExcludedStopNameMatches(excluded.stopName, stop.name)))
    return remainingStop
      ? [`${excluded.date} 仍包含明确要求移除的地点“${remainingStop.name}”；请将它从该日正式停靠点中删除。`]
      : []
  })
  if (conflicts.length) throw new ToolInputError(`本轮明确删除项未生效：${conflicts.join(' ')}`)
}

/** 把用户明确删除落实为确定性编辑，并让相邻路线失效后重新核验。 */
function removeExplicitlyExcludedStops(
  days: ItineraryDay[],
  context: Parameters<TravelTool['execute']>[1],
  repairNotes: string[]
): void {
  const excludedStops = context.excludedItineraryStops ?? (context.revisionBaseline
    ? explicitlyExcludedItineraryStopsForRequest(
      context.userRequest ?? '', context.revisionBaseline, context.unchangedItineraryDates ?? []
    )
    : [])
  for (const excluded of excludedStops) {
    const day = days.find((item) => item.date === excluded.date)
    if (!day) continue
    const baselineStop = context.revisionBaseline?.days
      .find((item) => item.date === excluded.date)?.stops.find((stop) => stop.id === excluded.stopId)
    if (baselineStop?.locked) continue

    const matchingIndexes = day.stops.flatMap((stop, index) =>
      !stop.locked && (stop.id === excluded.stopId || explicitlyExcludedStopNameMatches(excluded.stopName, stop.name))
        ? [index] : []
    )
    if (matchingIndexes.length === 0) continue

    let removedCount = 0
    for (const index of matchingIndexes.reverse()) {
      const [removed] = day.stops.splice(index, 1)
      if (!removed) continue
      const previousStop = day.stops[index - 1]
      if (previousStop) {
        previousStop.transitToNext = ''
        previousStop.factClaims = (previousStop.factClaims ?? [])
          .filter((claim) => claim.type !== 'transport-time')
        delete previousStop.transitEstimate
      }
      day.lodgingCommutes = day.lodgingCommutes?.filter((commute) => commute.stopId !== removed.id)
      removedCount += 1
    }
    if (removedCount > 0) {
      repairNotes.push(`${excluded.date} 已按本轮明确删除要求移除 ${removedCount} 个停靠点；相邻路线将重新核验。`)
    }
  }
}

/** 将抵达日未指定钟点的航后餐次顺延至接驳后；保留用户明确时刻和起飞前用餐。 */
function deferUnspecifiedArrivalDayMealTimes(
  days: ItineraryDay[],
  context: Parameters<TravelTool['execute']>[1],
  repairNotes: string[]
): void {
  const brief = context.tripBrief
  const arrivalDate = brief?.startDate ?? ''
  const arrivalTime = firstClockText(brief?.arrivalTime ?? '')
  const arrivalMinutes = arrivalTime ? firstClockTimeMinutes(arrivalTime) : undefined
  if (!arrivalDate || arrivalMinutes === undefined) return

  const requestText = `${context.userRequest ?? ''}\n${brief?.constraints ?? ''}`.normalize('NFKC')
  const requestsMealAfterArrival = /(?:落地|抵达|到达|下机)[^。；;\n]{0,100}(?:后|之后)[^。；;\n]{0,100}(?:早餐|早饭|午餐|午饭|晚餐|晚饭|用餐|吃饭)/u.test(requestText) ||
    /(?:早餐|早饭|午餐|午饭|晚餐|晚饭|用餐|吃饭)[^。；;\n]{0,100}(?:落地|抵达|到达|下机)[^。；;\n]{0,30}(?:后|之后)/u.test(requestText)
  const flightDepartureTime = flightDepartureTimeFromBrief(brief)
  const flightDepartureMinutes = flightDepartureTime ? firstClockTimeMinutes(flightDepartureTime) : undefined
  if (!requestsMealAfterArrival && flightDepartureMinutes === undefined) return
  const requestedMealTimes = requestedMealStartTimesForDate(requestText, arrivalDate)

  const arrivalDay = days.find((day) => day.date === arrivalDate)
  if (!arrivalDay) return
  let repaired = false
  for (const stop of arrivalDay.stops) {
    // 模型有时把“晚餐”写在时段尾注里；餐次识别需覆盖完整停靠点文本。
    const mealDescription = `${stop.category} ${stop.name} ${stop.time} ${stop.notes}`
    if (!/餐|用餐|美食|吃饭/u.test(mealDescription)) continue
    if (!mealSlotForStop(stop)) continue
    if (stop.locked) continue
    const start = firstClockTimeMinutes(stop.time)
    if (flightDepartureMinutes !== undefined && start !== undefined && start <= flightDepartureMinutes) continue
    if (/机上|飞机上|航班餐/u.test(`${stop.name} ${stop.area} ${stop.notes}`)) continue
    const mealSlot = mealSlotForStop(stop)
    if (mealSlot && requestedMealTimes.has(mealSlot)) continue

    const mealLabel = mealSlotForStop(stop) === 'breakfast' ? '早餐' : mealSlotForStop(stop) === 'lunch' ? '午餐' : '晚餐'
    stop.time = deferredArrivalMealTime
    stop.notes = [stop.notes, `${mealLabel}安排在落地和进城后；具体时间按取行李和交通情况确认。`]
      .filter(Boolean).join(' ').slice(0, 500)
    repaired = true
  }
  for (const block of arrivalDay.scheduleBlocks) {
    if (block.kind !== 'meal') continue
    const start = firstClockTimeMinutes(block.time)
    if (flightDepartureMinutes !== undefined && start !== undefined && start <= flightDepartureMinutes) continue
    if (/机上|飞机上|航班餐/u.test(`${block.title} ${block.area} ${block.notes}`)) continue
    const mealSlot = mealSlotForBlock(block)
    if (mealSlot && requestedMealTimes.has(mealSlot)) continue

    const mealLabel = mealSlotForBlock(block) === 'breakfast' ? '早餐' : mealSlotForBlock(block) === 'lunch' ? '午餐' : '晚餐'
    block.time = deferredArrivalMealTime
    block.notes = [block.notes, `${mealLabel}安排在落地和进城后；具体时间按取行李和交通情况确认。`]
      .filter(Boolean).join(' ').slice(0, 500)
    repaired = true
  }
  if (repaired && !repairNotes.includes('已把抵达日用餐安排在落地和进城接驳后，具体时段待确认。')) {
    repairNotes.push('已把抵达日用餐安排在落地和进城接驳后，具体时段待确认。')
  }
}

type MealSlot = 'breakfast' | 'lunch' | 'dinner'

/** 只把用户明确绑定到日期和餐次的时间写成可执行窗口。 */
function requestedMealWindowsForDate(
  requestText: string,
  date: string
): Map<MealSlot, Map<string, number | null>> {
  const dateParts = date.match(/^(\d{4})-(\d{2})-(\d{2})$/u)
  if (!dateParts) return new Map()
  const [, yearText, monthText, dayText] = dateParts
  const targetYear = Number(yearText)
  const targetMonth = Number(monthText)
  const targetDay = Number(dayText)
  const normalizedRequest = requestText.normalize('NFKC')
  const datePattern = /(?<!\d)(?:(\d{4})[-/.年]\s*(\d{1,2})(?:[-/.月]\s*(\d{1,2})日?)?|\b(\d{1,2})[/.]\s*(\d{1,2})\b|(\d{1,2})月\s*(\d{1,2})日?)/gu
  const mealPattern = /(早餐|早饭|午餐|午饭|晚餐|晚饭|用餐|吃饭)\s*(?:(?:时间|安排(?:在|于)?|定在|为|是)\s*)?[:：,，]?\s*((?:[01]?\d|2[0-3]):[0-5]\d)(?:\s*[-–—~～至到]\s*((?:[01]?\d|2[0-3]):[0-5]\d))?|((?:[01]?\d|2[0-3]):[0-5]\d)(?:\s*[-–—~～至到]\s*((?:[01]?\d|2[0-3]):[0-5]\d))?\s*(?:安排|吃|用餐|的)?\s*(早餐|早饭|午餐|午饭|晚餐|晚饭|用餐|吃饭)/gu
  const requested = new Map<MealSlot, Map<string, number | null>>()

  for (const segment of normalizedRequest.split(/[。；;\n]/u)) {
    const dateAnchors = [...segment.matchAll(datePattern)].flatMap((match) => {
      const year = match[1] ? Number(match[1]) : undefined
      const month = Number(match[2] ?? match[4] ?? match[6])
      const day = Number(match[3] ?? match[5] ?? match[7])
      return Number.isInteger(month) && Number.isInteger(day)
        ? [{ index: match.index ?? 0, matchesTarget: month === targetMonth && day === targetDay && (year === undefined || year === targetYear) }]
        : []
    })
    if (!dateAnchors.some((anchor) => anchor.matchesTarget)) continue

    for (const match of segment.matchAll(mealPattern)) {
      const mealLabel = match[1] ?? match[6] ?? ''
      const clock = match[2] ?? match[4]
      const rangeEnd = match[3] ?? match[5]
      if (!clock) continue
      // “午餐，16:30后不再安排用餐”里的时刻是截止边界，不是午餐开始时间。
      if (!rangeEnd && /^\s*(?:后|之后|以后|前|之前)/u.test(segment.slice((match.index ?? 0) + match[0].length))) continue
      const mealIndex = match.index ?? 0
      const nearestDate = [...dateAnchors].sort((left, right) =>
        Math.abs(left.index - mealIndex) - Math.abs(right.index - mealIndex)
      )[0]
      if (nearestDate && !nearestDate.matchesTarget) continue
      const slot: MealSlot = /早餐|早饭/u.test(mealLabel) ? 'breakfast'
        : /午餐|午饭/u.test(mealLabel) ? 'lunch' : 'dinner'
      const start = normalizeClockLabel(clock)
      const startMinutes = firstClockTimeMinutes(start)
      const endMinutes = rangeEnd ? firstClockTimeMinutes(rangeEnd) : undefined
      const duration = startMinutes !== undefined && endMinutes !== undefined && endMinutes > startMinutes
        ? endMinutes - startMinutes
        : null
      const windows = requested.get(slot) ?? new Map<string, number | null>()
      const previous = windows.get(start)
      windows.set(start, windows.has(start) && previous !== duration ? null : duration)
      requested.set(slot, windows)
    }
  }
  return requested
}

/** 为兼容餐次约束快照提供用户指定的开始时刻集合。 */
function requestedMealStartTimesForDate(requestText: string, date: string): Map<MealSlot, Set<string>> {
  return new Map([...requestedMealWindowsForDate(requestText, date)].map(([slot, windows]) => [slot, new Set(windows.keys())]))
}

/** 用户明确给出餐时后，修正模型偏移的单一餐次；其余冲突仍由日程校验拒绝。 */
function alignExplicitMealTimesToRequest(
  days: ItineraryDay[],
  requestText: string,
  repairNotes: string[],
  protectedDates: ReadonlySet<string>
): void {
  for (const day of days) {
    if (protectedDates.has(day.date)) continue
    for (const [slot, windows] of requestedMealWindowsForDate(requestText, day.date)) {
      if (windows.size !== 1) continue
      const [requestedStart, requestedDuration] = [...windows.entries()][0] ?? []
      if (!requestedStart) continue

      const meals: Array<
        | { time: string; durationMinutes: number | null; kind: 'stop'; stop: ItineraryStop }
        | { time: string; durationMinutes: number | null; kind: 'block'; block: ItineraryScheduleBlock }
      > = [
        ...day.stops.filter((stop) => /餐|用餐|美食|吃饭/u.test(`${stop.category} ${stop.name} ${stop.notes}`) &&
          mealSlotForStop(stop) === slot).map((stop) => ({
            time: stop.time, durationMinutes: stop.durationMinutes, kind: 'stop' as const, stop
          })),
        ...day.scheduleBlocks.filter((block) => block.kind === 'meal' && mealSlotForBlock(block) === slot).map((block) => ({
          time: block.time, durationMinutes: block.durationMinutes, kind: 'block' as const, block
        }))
      ]
      if (meals.length !== 1) continue

      const meal = meals[0]
      if (!meal) continue
      const currentStart = firstClockTimeMinutes(meal.time)
      const requestedStartMinutes = firstClockTimeMinutes(requestedStart)
      if (requestedStartMinutes === undefined) continue
      const existingDuration = currentStart === undefined
        ? meal.durationMinutes
        : scheduleRangeDurationMinutes(meal.time) ?? meal.durationMinutes
      const duration = requestedDuration ?? existingDuration
      if (duration !== null && (duration < 1 || duration > 720)) continue
      const nextTime = duration
        ? `${formatPlanningTime(requestedStartMinutes)}–${formatPlanningTime(requestedStartMinutes + duration)}`
        : formatPlanningTime(requestedStartMinutes)
      const nextDuration = duration ?? null
      if (meal.time === nextTime && meal.durationMinutes === nextDuration) continue

      if (meal.kind === 'stop') {
        meal.stop.time = nextTime
        meal.stop.durationMinutes = nextDuration
      } else {
        meal.block.time = nextTime
        meal.block.durationMinutes = nextDuration
      }
      repairNotes.push(`${day.date} 已按用户指定时刻修正${slot === 'breakfast' ? '早餐' : slot === 'lunch' ? '午餐' : '晚餐'}；若与其他活动冲突，仍需调整日程。`)
    }
  }
}

/** 仅在用户明确允许且时间完整落入馆内时，将午餐标为参观中的子活动。 */
function attachUserApprovedInVenueLunches(
  days: ItineraryDay[],
  requestText: string,
  repairNotes: string[],
  protectedDates: ReadonlySet<string>
): void {
  const normalizedRequest = requestText.normalize('NFKC')
  const datePattern = /(?<!\d)(?:(\d{4})[-/.年]\s*(\d{1,2})(?:[-/.月]\s*(\d{1,2})日?)?|\b(\d{1,2})[/.]\s*(\d{1,2})\b|(\d{1,2})月\s*(\d{1,2})日?)/gu
  const venuePattern = /([\p{Script=Han}A-Za-z0-9·]{2,24})\s*[（(]\s*(?:午餐|午饭)[^）)]{0,24}(?:可|可以)[^）)]{0,12}馆内[^）)]*[）)]/gu

  for (const day of days) {
    if (protectedDates.has(day.date)) continue
    const dateParts = day.date.match(/^(\d{4})-(\d{2})-(\d{2})$/u)
    if (!dateParts) continue
    const targetYear = Number(dateParts[1])
    const targetMonth = Number(dateParts[2])
    const targetDay = Number(dateParts[3])
    const venueNames = new Set<string>()

    for (const segment of normalizedRequest.split(/[。；;\n]/u)) {
      const dateMatches = [...segment.matchAll(datePattern)].some((match) => {
        const year = match[1] ? Number(match[1]) : undefined
        const month = Number(match[2] ?? match[4] ?? match[6])
        const date = Number(match[3] ?? match[5] ?? match[7])
        return month === targetMonth && date === targetDay && (year === undefined || year === targetYear)
      })
      if (!dateMatches) continue
      for (const match of segment.matchAll(venuePattern)) {
        const name = match[1]?.trim()
        if (name) venueNames.add(name)
      }
    }
    if (!venueNames.size) continue

    const venues = day.stops.filter((stop) => isVisitStop(stop) && isAttractionStop(stop) &&
      [...venueNames].some((name) => itineraryStopNameMatches(name, stop.name)))
    const nestedVenues = new Set<string>()
    for (const venue of venues) {
      const venueStart = firstClockTimeMinutes(venue.time)
      const venueEnd = proposedStopEndMinute(venue)
      if (venueStart === undefined || venueEnd === undefined) continue

      const fullyContained = (time: string, durationMinutes: number | null): boolean => {
        const start = firstClockTimeMinutes(time)
        const end = proposedTimeEndMinute(time, durationMinutes)
        return start !== undefined && end !== undefined && start >= venueStart && end <= venueEnd
      }
      for (const meal of day.stops) {
        if (mealSlotForStop(meal) !== 'lunch' || !/餐/u.test(meal.category) ||
          !fullyContained(meal.time, meal.durationMinutes)) continue
        meal.area = venue.name
        if (!/馆内用餐/u.test(meal.notes)) meal.notes = [meal.notes, '馆内用餐（按用户提供的行程安排）。']
          .filter(Boolean).join(' ').slice(0, 500)
        nestedVenues.add(venue.name)
      }
      for (const block of day.scheduleBlocks) {
        if (block.kind !== 'meal' || mealSlotForBlock(block) !== 'lunch' ||
          !fullyContained(block.time, block.durationMinutes)) continue
        block.area = venue.name
        if (!/馆内用餐/u.test(block.notes)) block.notes = [block.notes, '馆内用餐（按用户提供的行程安排）。']
          .filter(Boolean).join(' ').slice(0, 300)
        nestedVenues.add(venue.name)
      }
    }
    if (nestedVenues.size) repairNotes.push(`${[...nestedVenues].join('、')}的午餐已按用户允许安排为馆内子活动。`)
  }
}

/** 将用户指定餐时写入候选的约束快照，后续修订和保存沿用同一规则。 */
function mealRequirementsWithRequestedTimes(
  days: ItineraryDay[],
  previousRequirements: ItineraryMealRequirement[],
  currentRequirements: ItineraryMealRequirement[],
  requestText: string
): ItineraryMealRequirement[] {
  const byDate = new Map<string, ItineraryMealRequirement>()
  for (const requirement of previousRequirements) {
    byDate.set(requirement.date, structuredClone(requirement))
  }
  for (const requirement of currentRequirements) {
    const previous = byDate.get(requirement.date)
    const preservedTimes = previous?.requestedStartTimes
      ? Object.fromEntries(Object.entries(previous.requestedStartTimes).filter(([slot]) =>
          !requirement.excludedSlots?.includes(slot as ItineraryMealSlot) &&
          (!requirement.exclusive || requirement.slots.includes(slot as ItineraryMealSlot))
        )) as ItineraryMealRequirement['requestedStartTimes']
      : undefined
    byDate.set(requirement.date, {
      ...requirement,
      requestedStartTimes: mergeRequestedMealTimes(preservedTimes, requirement.requestedStartTimes)
    })
  }

  for (const day of days) {
    const requestedStartTimes = Object.fromEntries(
      [...requestedMealStartTimesForDate(requestText, day.date)]
        .map(([slot, starts]) => [slot, [...starts]])
    ) as ItineraryMealRequirement['requestedStartTimes']
    if (!Object.keys(requestedStartTimes ?? {}).length) continue
    const current = byDate.get(day.date) ?? { date: day.date, slots: [] }
    byDate.set(day.date, {
      ...current,
      requestedStartTimes: replaceRequestedMealTimes(current.requestedStartTimes, requestedStartTimes)
    })
  }

  return [...byDate.values()]
}

/** 用户本轮明确改了某个餐时后，替换该餐次的旧时刻。 */
function replaceRequestedMealTimes(
  current: ItineraryMealRequirement['requestedStartTimes'],
  incoming: ItineraryMealRequirement['requestedStartTimes']
): ItineraryMealRequirement['requestedStartTimes'] {
  const merged = { ...current }
  for (const slot of ['breakfast', 'lunch', 'dinner'] as const) {
    const times = incoming?.[slot]
    if (times?.length) merged[slot] = [...new Set(times)]
  }
  return Object.keys(merged).length ? merged : undefined
}

/** 合并来自简报和既有草案的时刻约束。 */
function mergeRequestedMealTimes(
  current: ItineraryMealRequirement['requestedStartTimes'],
  incoming: ItineraryMealRequirement['requestedStartTimes']
): ItineraryMealRequirement['requestedStartTimes'] {
  const merged = Object.fromEntries(
    (['breakfast', 'lunch', 'dinner'] as const).flatMap((slot) => {
      const times = [...new Set([...(current?.[slot] ?? []), ...(incoming?.[slot] ?? [])])]
      return times.length ? [[slot, times]] : []
    })
  ) as ItineraryMealRequirement['requestedStartTimes']
  return Object.keys(merged ?? {}).length ? merged : undefined
}

/** 把未明确指定的餐时移入当天最近的空档，最终仍由严格日程校验兜底。 */
function repairUnspecifiedMealOverlaps(
  days: ItineraryDay[],
  context: ToolContext,
  repairNotes: string[],
  protectedDates: ReadonlySet<string>
): Set<string> {
  const requestText = `${context.userRequest ?? ''}\n${context.tripBrief?.constraints ?? ''}`.normalize('NFKC')
  const anchors = context.tripBrief ?? { startDate: '', endDate: '', arrivalFlight: '', arrivalTime: '', leaveTime: '' }
  const repairedDates = new Set<string>()

  for (const day of days) {
    if (protectedDates.has(day.date)) continue
    const requestedTimes = requestedMealStartTimesForDate(requestText, day.date)
    const itemCount = day.stops.length + day.scheduleBlocks.length
    for (let attempt = 0; attempt < itemCount; attempt += 1) {
      const conflict = analyzeDaySchedule(day, anchors).find((finding) =>
        finding.code === 'stop-overlap' || finding.code === 'schedule-overlap'
      )
      if (!conflict) break

      const mealCandidates: Array<
        | { id: string; slot: 'breakfast' | 'lunch' | 'dinner'; time: string; locked: boolean; kind: 'stop'; stop: ItineraryStop }
        | { id: string; slot: 'breakfast' | 'lunch' | 'dinner'; time: string; locked: false; kind: 'block'; block: ItineraryScheduleBlock }
      > = []
      for (const id of conflict.itemIds) {
        const stop = day.stops.find((item) => item.id === id)
        if (stop) {
          const isMealStop = /餐|用餐|美食|吃饭/u.test(`${stop.category} ${stop.name} ${stop.notes}`)
          const slot = isMealStop ? mealSlotForStop(stop) : undefined
          if (slot) mealCandidates.push({ id, slot, time: stop.time, locked: stop.locked === true, kind: 'stop', stop })
          continue
        }
        const block = day.scheduleBlocks.find((item) => item.id === id)
        if (!block || block.kind !== 'meal') continue
        const slot = mealSlotForBlock(block)
        if (slot) mealCandidates.push({ id, slot, time: block.time, locked: false, kind: 'block', block })
      }

      let repaired = false
      const exactRequestedMeals = mealCandidates.filter((item) =>
        matchesRequestedMealStart(item.time, requestedTimes.get(item.slot))
      )
      const exclusiveRequirement = context.requiredMealSlots?.find((requirement) =>
        requirement.date === day.date && requirement.exclusive === true
      )
      const redundantMeal = exclusiveRequirement && exactRequestedMeals.length === 1
        ? mealCandidates.find((item) => item.id !== exactRequestedMeals[0]?.id &&
          item.slot === exactRequestedMeals[0]?.slot && !item.locked &&
          !matchesRequestedMealStart(item.time, requestedTimes.get(item.slot)) &&
          !isMealItemNamedInRequest(item, requestText))
        : undefined
      if (redundantMeal) {
        removeMealCandidate(day, redundantMeal)
        repairNotes.push(`${day.date} 已保留用户指定时刻的餐次，并移除与其冲突的额外同餐次安排。`)
        repairedDates.add(day.date)
        repaired = true
        break
      }

      for (const item of mealCandidates) {
        if (item.locked || matchesRequestedMealStart(item.time, requestedTimes.get(item.slot))) continue
        const currentStart = firstClockTimeMinutes(item.time)
        if (currentStart === undefined) continue
        const duration = Math.max(1, scheduleRangeDurationMinutes(item.time) ??
          (item.kind === 'stop' ? item.stop.durationMinutes : item.block.durationMinutes) ?? 45)
        const nextStart = availableMealWindow(day, item.slot, item.id, currentStart, duration)
        if (nextStart === undefined || nextStart === currentStart) continue
        const nextTime = `${formatPlanningTime(nextStart)}–${formatPlanningTime(nextStart + duration)}`
        if (item.kind === 'stop') {
          item.stop.time = nextTime
          item.stop.durationMinutes = duration
          item.stop.notes = [item.stop.notes, '餐时已为避开日程重叠调整；店面营业时间仍需核验。']
            .filter(Boolean).join(' ').slice(0, 500)
        } else {
          item.block.time = nextTime
          item.block.durationMinutes = duration
          item.block.notes = [item.block.notes, '餐时已为避开日程重叠调整；具体营业时间仍需核验。']
            .filter(Boolean).join(' ').slice(0, 300)
        }
        repairNotes.push(`${day.date} 未指定的${item.slot === 'breakfast' ? '早餐' : item.slot === 'lunch' ? '午餐' : '晚餐'}已移至 ${nextTime}，以消除明确时段重叠。`)
        repairedDates.add(day.date)
        repaired = true
        break
      }
      if (!repaired) break
    }
  }
  return repairedDates
}

/** 只把开始时刻与用户要求一致的餐次视为固定安排。 */
function matchesRequestedMealStart(time: string, requestedStarts?: ReadonlySet<string>): boolean {
  const start = firstClockTimeMinutes(time)
  return start !== undefined && [...(requestedStarts ?? [])].some((requested) =>
    firstClockTimeMinutes(requested) === start
  )
}

/** 避免自动移除用户点名的餐馆；通用餐次占位不视为点名地点。 */
function isMealItemNamedInRequest(
  item: { kind: 'stop'; stop: ItineraryStop } | { kind: 'block'; block: ItineraryScheduleBlock },
  requestText: string
): boolean {
  const title = (item.kind === 'stop' ? item.stop.name : item.block.title).normalize('NFKC')
  const compactTitle = title.replace(/\s+/gu, '')
  if (!compactTitle || /^(?:早餐|早饭|午餐|午饭|晚餐|晚饭|用餐)(?:\([^)]*\))?$/u.test(compactTitle)) return false
  const compactRequest = requestText.normalize('NFKC').replace(/\s+/gu, '')
  return compactRequest.includes(compactTitle)
}

/** 从候选草案移除已由明确时刻餐次覆盖的冲突重复项。 */
function removeMealCandidate(
  day: ItineraryDay,
  item: { id: string; kind: 'stop' } | { id: string; kind: 'block' }
): void {
  if (item.kind === 'stop') {
    const index = day.stops.findIndex((stop) => stop.id === item.id)
    if (index >= 0) day.stops.splice(index, 1)
    return
  }
  const index = day.scheduleBlocks.findIndex((block) => block.id === item.id)
  if (index >= 0) day.scheduleBlocks.splice(index, 1)
}

/** 将用户明确写出的餐次时刻统一为可比较的两位小时格式。 */
function normalizeClockLabel(value: string): string {
  const [hour, minute] = value.split(':')
  return `${String(Number(hour)).padStart(2, '0')}:${minute}`
}

/** 将改为相对时段的抵达日用餐排在落地与入住锚点之后。 */
function orderDeferredArrivalMealsAfterAnchors(
  days: ItineraryDay[],
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief']
): void {
  const day = days.find((item) => item.date === tripBrief?.startDate)
  const arrivalTime = firstClockText(tripBrief?.arrivalTime ?? '')
  if (!day || !arrivalTime) return
  const deferredMeals = day.stops.filter((stop) =>
    !stop.locked && mealSlotForStop(stop) !== undefined && stop.time === deferredArrivalMealTime
  )
  if (!deferredMeals.length) return

  const remainingStops = day.stops.filter((stop) => !deferredMeals.includes(stop))
  const arrivalAnchorIndexes = remainingStops.flatMap((stop, index) => {
    const isFlightArrival = /交通/u.test(stop.category) &&
      /抵达|到达|落地/u.test(`${stop.name} ${stop.notes}`) && containsClockTime(stop.time, arrivalTime)
    const isLodgingAnchor = /住宿/u.test(stop.category) && /入住|办理入住/u.test(`${stop.name} ${stop.notes}`)
    return isFlightArrival || isLodgingAnchor ? [index] : []
  })
  const lastAnchorIndex = arrivalAnchorIndexes.at(-1)
  if (lastAnchorIndex === undefined) return
  remainingStops.splice(lastAnchorIndex + 1, 0, ...deferredMeals)
  day.stops.splice(0, day.stops.length, ...remainingStops)
}

/** 从候选 JSON 收集全计划地点名，供来源校验识别并列景点信息。 */
function proposedStopNames(days: unknown[]): string[] {
  const names = days.flatMap((rawDay) => {
    if (!rawDay || typeof rawDay !== 'object' || Array.isArray(rawDay)) return []
    const stops = (rawDay as Record<string, unknown>).stops
    if (!Array.isArray(stops)) return []
    return stops.flatMap((rawStop) => {
      if (!rawStop || typeof rawStop !== 'object' || Array.isArray(rawStop)) return []
      const name = (rawStop as Record<string, unknown>).name
      return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 160
        ? [name.trim()]
        : []
    })
  })
  return [...new Set(names)]
}

/** 确保每日序号从第 1 天连续递增，避免地图和版本索引覆盖或错位。 */
function normalizeDays(
  value: unknown[],
  context: Parameters<TravelTool['execute']>[1],
  repairNotes: string[],
  factEvidenceDiagnostics: ItineraryFactEvidenceDiagnostics,
  factEvidenceCorrections: FactEvidenceCorrection[],
  businessWarnings: string[]
): ItineraryDay[] {
  const knownStopNames = proposedStopNames(value)
  const days = value.map((day, index) => normalizeDay(
    day, index, context, repairNotes, factEvidenceDiagnostics, factEvidenceCorrections, businessWarnings, knownStopNames
  ))
  if (days.some((day, index) => day.dayNumber !== index + 1)) {
    throw new ToolInputError('候选行程序号必须从第 1 天起连续递增。')
  }
  const expectedDates = datesForConfirmedTrip(context.tripBrief?.startDate, context.tripBrief?.endDate)
  if (expectedDates) {
    if (days.length !== expectedDates.length) {
      businessWarnings.push(`候选方案有 ${days.length} 天，已确认日期范围有 ${expectedDates.length} 天；请判断是否补齐或调整。`)
    }
    const mismatchedDays = days.flatMap((day, index) =>
      day.date === expectedDates[index] ? [] : [`第 ${index + 1} 天为 ${day.date || '未填写'}，预期 ${expectedDates[index]}`]
    )
    if (mismatchedDays.length) {
      businessWarnings.push(`日期与已确认行程不一致：${mismatchedDays.slice(0, 5).join('；')}${mismatchedDays.length > 5 ? '；其余日期省略' : ''}。`)
    }
  }
  return days
}

/** 单日修订只归一化目标日，再合并到基线，后续仍按完整计划校验。 */
function normalizeRevisionDays(
  value: unknown[],
  context: Parameters<TravelTool['execute']>[1],
  repairNotes: string[],
  factEvidenceDiagnostics: ItineraryFactEvidenceDiagnostics,
  factEvidenceCorrections: FactEvidenceCorrection[],
  businessWarnings: string[]
): ItineraryDay[] {
  const confirmedDates = datesForConfirmedTrip(context.tripBrief?.startDate, context.tripBrief?.endDate)
  const scope = scopedRevisionDays(
    context.revisionBaseline,
    context.unchangedItineraryDates ?? [],
    confirmedDates
  )
  if (!scope || !context.revisionBaseline) {
    return normalizeDays(value, context, repairNotes, factEvidenceDiagnostics, factEvidenceCorrections, businessWarnings)
  }
  // 某些兼容模型仍可能返回全量草案；接受它并照常恢复受保护日期。
  if (value.length === confirmedDates?.length) {
    return normalizeDays(value, context, repairNotes, factEvidenceDiagnostics, factEvidenceCorrections, businessWarnings)
  }
  if (value.length !== scope.length) {
    throw new ToolInputError(`本轮只提交 ${scope.length} 个修改日期；当前提交 ${value.length} 天。`)
  }

  const changedDates = new Set(scope.map(({ date }) => date))
  const knownStopNames = [
    ...context.revisionBaseline.days
      .filter((day) => !changedDates.has(day.date))
      .flatMap((day) => day.stops.map((stop) => stop.name)),
    ...proposedStopNames(value)
  ]
  const changedDays = new Map<string, ItineraryDay>()
  for (const [index, rawDay] of value.entries()) {
    const day = asObject(rawDay, '行程日')
    const expected = scope[index]!
    if (day.date !== expected.date) {
      throw new ToolInputError(
        `本轮第 ${index + 1} 个修改日为 ${String(day.date ?? '未填写')}，目标日期是 ${expected.date}。`,
        'revision_date_mismatch', 'warning'
      )
    }
    const submittedDayNumber = Number(day.day_number)
    if (submittedDayNumber !== expected.dayNumber && submittedDayNumber !== index + 1) {
      throw new ToolInputError(
        `${expected.date} 的日序与修订范围不一致；应为原计划第 ${expected.dayNumber} 天或本轮第 ${index + 1} 项。`,
        'revision_day_scope_mismatch', 'warning'
      )
    }
    changedDays.set(expected.date, normalizeDay(
      { ...day, day_number: expected.dayNumber }, expected.dayNumber - 1, context,
      repairNotes, factEvidenceDiagnostics, factEvidenceCorrections, businessWarnings, knownStopNames
    ))
  }

  return context.revisionBaseline.days.map((day) => changedDays.get(day.date) ?? structuredClone(day))
}

/** 只有基线完整、日期已确认且本轮明确保护部分日期时才启用紧凑修订。 */
function scopedRevisionDays(
  baseline: ItineraryOption | undefined,
  unchangedDates: string[],
  confirmedDates: string[] | undefined
): Array<{ date: string; dayNumber: number }> | undefined {
  if (!baseline || !confirmedDates || unchangedDates.length === 0 || baseline.days.length !== confirmedDates.length) {
    return undefined
  }
  const baselineDates = baseline.days.map((day) => day.date)
  if (baselineDates.some((date, index) => date !== confirmedDates[index] || baseline.days[index]?.dayNumber !== index + 1)) {
    return undefined
  }
  const protectedDates = new Set(unchangedDates)
  if (protectedDates.size !== unchangedDates.length || [...protectedDates].some((date) => !baselineDates.includes(date))) {
    return undefined
  }
  const targetDays = baseline.days.filter((day) => !protectedDates.has(day.date))
  if (targetDays.length === 0 || targetDays.length === baseline.days.length) return undefined
  return targetDays.map((day) => ({ date: day.date, dayNumber: day.dayNumber }))
}

/** 将模型误标类别的落地瞬时点规范为交通锚点，不让它成为抵达后的活动。 */
function normalizeArrivalMomentStops(
  days: ItineraryDay[],
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief'],
  repairNotes: string[]
): void {
  const arrivalTime = firstClockText(tripBrief?.arrivalTime ?? '')
  const arrivalDay = days.find((day) => day.date === tripBrief?.startDate)
  if (!arrivalTime || !arrivalDay) return

  let repaired = false
  for (const stop of arrivalDay.stops) {
    if (stop.locked || /交通/u.test(stop.category) || !/(?:抵达|到达|落地)/u.test(stop.name)) continue
    const clocks = [...stop.time.matchAll(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu)]
    if (clocks.length !== 1 || normalizeClockLabel(`${clocks[0]![1]}:${clocks[0]![2]}`) !== arrivalTime) continue

    stop.category = '交通'
    stop.durationMinutes = null
    stop.evidenceLevel = 'pending'
    stop.sourceIds = []
    stop.factClaims = []
    stop.transitToNext = ''
    stop.notes = appendArrivalNote(stop.notes, '用户提供的落地时刻作为交通锚点；机场确认、离站和接驳待核验。')
    delete stop.transitEstimate
    delete stop.location
    repaired = true
  }
  if (repaired) repairNotes.push('已将抵达时刻同刻的落地项归为交通锚点，避免误判为抵达后的游览或活动。')
}

/** 用户没有确认抵达枢纽时，移除模型猜出的机场/车站名称并保留待确认交通锚点。 */
function removeUnconfirmedArrivalHub(
  days: ItineraryDay[],
  tripBrief: TripBrief | undefined,
  userRequest: string,
  repairNotes: string[]
): void {
  const arrivalDay = days.find((day) => day.date === tripBrief?.startDate) ?? days[0]
  if (!arrivalDay) return

  const userProvidedText = normalizeVisitMatch([
    userRequest,
    tripBrief?.arrivalFlight ?? '',
    tripBrief?.constraints ?? ''
  ].join('\n'))
  const arrivalContext = Boolean(tripBrief?.arrivalFlight.trim() || tripBrief?.arrivalTime.trim()) ||
    /(?:航班|落地|抵达|到达|下机|机场进城|机场到住宿)/u.test(`${userRequest}\n${tripBrief?.constraints ?? ''}`)
  const retainedStops: ItineraryStop[] = []
  for (const stop of arrivalDay.stops) {
    if (!/交通/u.test(stop.category)) {
      retainedStops.push(stop)
      continue
    }
    const genericIngress = /^(?:进城接驳|抵达接驳)（地点待确认）$/u.test(stop.name)
    if (!arrivalContext && !stop.locked && genericIngress && /抵达机场或车站未提供/u.test(stop.notes)) {
      repairNotes.push('已移除没有用户抵达信息支撑的泛化进城接驳。')
      continue
    }
    if (!mentionsTransportHub(stop.name)) {
      retainedStops.push(stop)
      continue
    }
    if (userConfirmedTransportHub(`${stop.name} ${stop.area}`, userProvidedText, tripBrief?.destination ?? '')) {
      retainedStops.push(stop)
      continue
    }

    const originalNotes = stop.notes.replace(/抵达机场或车站未提供[^。；;]*/gu, '')
    const arrivalAnchor = /航班|落地|抵达|到达|下机|取行李/u.test(`${stop.name} ${originalNotes}`)
    if (!arrivalContext && !arrivalAnchor && !stop.locked) {
      const stopContext = `${stop.name} ${stop.area} ${stop.notes} ${stop.transitToNext}`
      const unsupportedAirportIngress = /机场|航站楼|进城|到市区|前往住宿|到酒店/u.test(stopContext)
      if (unsupportedAirportIngress) {
        repairNotes.push('已移除没有用户抵达信息支撑的机场进城交通安排。')
        continue
      }

      // 普通车站也可能是已确认的返程或跨城交通锚点；没有抵达语义时不替用户改写。
      retainedStops.push(stop)
      continue
    }

    stop.name = arrivalAnchor ? '抵达交通（地点待确认）' : '进城接驳（地点待确认）'
    stop.area = ''
    stop.notes = '抵达机场或车站未提供；确认后再核对该段接驳。'
    stop.transitToNext = '抵达地点确认后再查询线路与耗时。'
    stop.evidenceLevel = 'pending'
    stop.sourceIds = []
    stop.factClaims = []
    delete stop.transitEstimate
    delete stop.location
    repairNotes.push('已移除未经用户确认的首日机场/车站推测，抵达接驳待确认。')
    retainedStops.push(stop)
  }

  arrivalDay.stops.splice(0, arrivalDay.stops.length, ...retainedStops)
  const arrivalTime = firstClockText(tripBrief?.arrivalTime ?? '') ?? ''
  const arrivalAirport = flightArrivalAirportFromBrief(tripBrief)
  const confirmedArrivalClocks = new Set(arrivalDay.stops
    .filter((stop) => arrivalTime && /交通/u.test(stop.category) &&
      !/^(?:抵达交通|进城接驳)（地点待确认）$/u.test(stop.name) &&
      clockLabelsMatchArrivalMoment(stop.time, arrivalTime) &&
      (/抵达|到达|落地/u.test(`${stop.name} ${stop.notes}`) || namesArrivalAirport(stop, arrivalAirport)))
    .map((stop) => firstClockText(stop.time)!)
  )
  const seenArrivalAnchors = new Map<string, number>()
  const deduplicatedStops: ItineraryStop[] = []
  for (const stop of arrivalDay.stops) {
    if (!/交通/u.test(stop.category) || stop.locked ||
      !/^(?:抵达交通|进城接驳)（地点待确认）$/u.test(stop.name)) {
      deduplicatedStops.push(stop)
      continue
    }
    const clock = firstClockText(stop.time)
    if (clock && confirmedArrivalClocks.has(clock)) {
      repairNotes.push('已移除与用户确认的抵达地点和时刻重复的待确认交通锚点。')
      continue
    }
    const key = clock ? `clock:${clock}` : `label:${stop.name}:${stop.time}`
    const existingIndex = seenArrivalAnchors.get(key)
    if (existingIndex === undefined) {
      seenArrivalAnchors.set(key, deduplicatedStops.length)
      deduplicatedStops.push(stop)
      continue
    }
    const existing = deduplicatedStops[existingIndex]!
    if (stop.name.startsWith('抵达交通') && !existing.name.startsWith('抵达交通')) {
      deduplicatedStops[existingIndex] = stop
    }
    repairNotes.push('同一落地时刻重复的待确认交通锚点已合并。')
  }
  arrivalDay.stops.splice(0, arrivalDay.stops.length, ...deduplicatedStops)
  normalizeArrivalLodgingTimes(arrivalDay, tripBrief, userRequest, repairNotes)

  for (const block of arrivalDay.scheduleBlocks) {
    const blockText = `${block.title} ${block.area} ${block.notes}`
    if (!mentionsTransportHub(blockText)) continue
    if (userConfirmedTransportHub(blockText, userProvidedText, tripBrief?.destination ?? '')) continue

    block.title = '抵达后离站与行李缓冲'
    block.area = ''
    block.notes = '抵达机场或车站未提供；离站、取行李与前往住宿的时间待核验。'
    repairNotes.push('已移除时间块中未经用户确认的首日机场/车站推测。')
  }
}

/** 接驳耗时未知时不把落地时刻冒充为实际入住时刻；用户明确的入住时间优先。 */
function normalizeArrivalLodgingTimes(
  day: ItineraryDay,
  tripBrief: TripBrief | undefined,
  userRequest: string,
  repairNotes: string[]
): void {
  const arrivalTime = firstClockText(tripBrief?.arrivalTime ?? '')
  const arrivalMinutes = arrivalTime ? firstClockTimeMinutes(arrivalTime) : undefined
  if (!arrivalTime || arrivalMinutes === undefined) return

  const userText = [userRequest, tripBrief?.constraints ?? '', tripBrief?.lodging ?? ''].join('\n')
  const explicitCheckInTime = explicitUserCheckInTime(userText)
  let changed = false
  const requestsAirportToLodging = /(?:机场|落地|抵达)[^。！？；;\n]{0,40}(?:住宿|酒店|宾馆|民宿|住处)/u.test(userText)
  const hasLodgingStop = day.stops.some((stop) => /住宿/u.test(stop.category) || /(?:办理入住|入住)/u.test(stop.name))
  if (requestsAirportToLodging && !hasLodgingStop && !tripBrief?.lodgingLocation.trim()) {
    const arrivalIndex = day.stops.findIndex((stop) => /交通/u.test(stop.category) &&
      containsClockTime(stop.time, arrivalTime) && /(?:抵达|到达|落地)/u.test(`${stop.name} ${stop.notes}`))
    const arrivalStop = day.stops[arrivalIndex]
    if (arrivalStop) {
      day.stops.splice(arrivalIndex + 1, 0, {
        id: randomUUID(), name: '住宿地点待确认', area: '', time: `${arrivalTime} 后入住`, durationMinutes: null,
        category: '住宿', notes: '机场离站与接驳线路/耗时待核验；住宿地址未提供。',
        transitToNext: '', evidenceLevel: 'pending', sourceIds: [], factClaims: []
      })
      arrivalStop.transitToNext = '前往住宿地点待确认；机场离站与接驳线路/耗时待核验。'
      changed = true
    }
  }
  for (const stop of day.stops) {
    if (!/住宿/u.test(stop.category) && !/(?:办理入住|入住)/u.test(stop.name)) continue
    const scheduledTime = firstClockText(stop.time)
    if (explicitCheckInTime) {
      if (scheduledTime !== explicitCheckInTime || stop.time !== explicitCheckInTime) {
        stop.time = explicitCheckInTime
        stop.notes = appendArrivalNote(stop.notes, '用户指定入住时刻已保留；接驳仍需核验。')
        changed = true
      }
      continue
    }

    const scheduledMinutes = scheduledTime ? firstClockTimeMinutes(scheduledTime) : undefined
    if (scheduledMinutes === undefined) continue
    stop.time = '落地、取行李和接驳后（时段待核验）'
    stop.notes = appendArrivalNote(stop.notes, '入住钟点和接驳耗时待核验。')
    changed = true
  }
  if (changed) repairNotes.push('未知接驳时长不再生成精确入住钟点；保留落地后入住锚点并标明待核验。')
}

/** 从用户明确提到入住的语句中读取最近的钟点，避免覆盖用户指定时间。 */
function explicitUserCheckInTime(value: string): string | undefined {
  for (const clause of value.normalize('NFKC').split(/[。！？；;\n]/u)) {
    const timePattern = '(?:[01]?\\d|2[0-3]):[0-5]\\d'
    const afterCheckIn = clause.match(new RegExp(`(?:办理入住|入住)(?:时间|时刻)?\\s*(?:(?:安排)?(?:在|于|为|是)|[:：])?\\s*(${timePattern})`, 'u'))
    const beforeCheckIn = clause.match(new RegExp(`(${timePattern})\\s*(?:后\\s*)?(?:办理入住|入住)`, 'u'))
    const explicitTime = afterCheckIn?.[1] ?? beforeCheckIn?.[1]
    if (explicitTime) return normalizeClockLabel(explicitTime)
  }
  return undefined
}

/** 幂等追加抵达日的入住核验提示，并保持备注长度上限。 */
function appendArrivalNote(existing: string, message: string): string {
  if (existing.includes(message)) return existing
  return [existing.trim(), message].filter(Boolean).join(' ').slice(0, 500)
}

/** 保证普通行程日有可执行活动；抵离日和用户明确指定的休息日可例外。 */
function validateDailyActivityStops(
  days: ItineraryDay[],
  tripBrief: TripBrief | undefined,
  userRequest: string,
  unchangedDates: string[]
): void {
  const requestText = `${userRequest}\n${tripBrief?.constraints ?? ''}`
  if (!requestText.trim()) return
  const preservedDates = new Set(unchangedDates)
  const startDate = tripBrief?.startDate ?? ''
  const endDate = tripBrief?.endDate ?? ''
  const hasArrivalAnchor = Boolean(tripBrief?.arrivalFlight.trim() || tripBrief?.arrivalTime.trim())
  const hasDepartureAnchor = Boolean(tripBrief?.leaveTime.trim() || flightDepartureTimeFromBrief(tripBrief))

  for (const day of days) {
    if (preservedDates.has(day.date)) continue
    const hasActivity = day.stops.some((stop) => {
      if (/^(?:住宿|交通)$/u.test(stop.category)) return false
      if (/^(?:休息|午休|酒店休息|返回酒店休息|回酒店休息)$/u.test(stop.name.trim())) return false
      if (isUnresolvedAttractionName(stop.name)) return false
      return true
    })
    const isAnchoredTravelDay = (day.date === startDate && hasArrivalAnchor) ||
      (day.date === endDate && hasDepartureAnchor)
    if (hasActivity || isAnchoredTravelDay || isExplicitRestDay(day, requestText)) continue
    throw new ToolInputError(
      `第 ${day.dayNumber} 天（${day.date}）未安排实际游览、餐饮或活动；请补入一项可执行安排，或依据用户明确说明保留抵离/休息日。`
    )
  }
}

/** 只接受用户在整趟或具体日期上明确提出的休息安排。 */
function isExplicitRestDay(day: ItineraryDay, requestText: string): boolean {
  if (/(?:全程|每天|每日|每一天)[^。；;\n]{0,24}(?:休息|自由活动|不安排景点|不排景点|不安排活动)/u.test(requestText)) return true
  const month = Number(day.date.slice(5, 7))
  const date = Number(day.date.slice(8, 10))
  const chineseNumbers = ['一', '二', '三', '四', '五', '六', '七']
  const dateLabels = [
    `${month}/${date}`, `${month}月${date}日`, `${month}月${date}号`,
    `第${day.dayNumber}天`, `第${day.dayNumber}日`, `第${chineseNumbers[day.dayNumber - 1]}天`, `第${chineseNumbers[day.dayNumber - 1]}日`
  ]
  for (const label of dateLabels) {
    const index = requestText.indexOf(label)
    if (index < 0) continue
    const nearby = requestText.slice(Math.max(0, index - 32), index + label.length + 64)
    if (/(?:休息|自由活动|自由安排|不安排景点|不排景点|不安排活动|酒店休整)/u.test(nearby)) return true
  }
  return false
}

/** 只在旅行起止日期都明确时生成逐日清单，不替用户推测缺失日期。 */
function datesForConfirmedTrip(startDate = '', endDate = ''): string[] | undefined {
  if (!startDate.trim() || !endDate.trim()) return undefined
  const start = Date.parse(`${startDate}T00:00:00.000Z`)
  const end = Date.parse(`${endDate}T00:00:00.000Z`)
  const dayMilliseconds = 24 * 60 * 60 * 1_000
  const span = end - start
  if (!Number.isFinite(start) || !Number.isFinite(end) || span < 0 || span % dayMilliseconds !== 0) {
    throw new ToolInputError('已确认的旅行日期范围无效，请先检查旅行简报。')
  }
  const dayCount = span / dayMilliseconds + 1
  if (dayCount > 7) throw new ToolInputError('已确认的日期范围超过当前支持的 1–7 天，请调整旅行日期范围。')
  return Array.from({ length: dayCount }, (_, index) => new Date(start + index * dayMilliseconds).toISOString().slice(0, 10))
}

/** 提取简报中的按日必去点，并应用本轮明确删点，保证修订可覆盖旧约束。 */
function requiredDatedVisitsFromBrief(
  tripBrief: NonNullable<ToolContext['tripBrief']>,
  excludedStops: ToolContext['excludedItineraryStops'] = []
): Array<{ date: string; names: string[] }> {
  const startDate = tripBrief.startDate
  const endDate = tripBrief.endDate
  try {
    if (!datesForConfirmedTrip(startDate, endDate)) return []
  } catch {
    return []
  }
  const startYear = Number(startDate.slice(0, 4))
  const startMonth = Number(startDate.slice(5, 7))
  const endDateValue = Date.parse(`${endDate}T00:00:00.000Z`)
  const interests = tripBrief.interests.normalize('NFKC').split(/[、，,;；\n]+/u)
    .flatMap((item) => item
      .replace(/^\s*\d{1,2}(?:月|\/|\.)\s*\d{1,2}(?:日|号)?\s*/u, '')
      .split(/(?:以及|和|与|及)/u))
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 40 &&
      !/^(?:人文|自然|自然风光|美食|拍照|购物|红叶|花期|城市漫步|北京标志性景点|标志性景点)$/u.test(item))
  if (!interests.length) return []

  const text = tripBrief.constraints.normalize('NFKC')
  const datePattern = /(\d{1,2})(?:月|\/|\.)\s*(\d{1,2})(?:日|号)?/gu
  const mentions = [...text.matchAll(datePattern)]
  return mentions.flatMap((match, index) => {
    const month = Number(match[1])
    const day = Number(match[2])
    const year = month < startMonth ? startYear + 1 : startYear
    const parsedDate = new Date(Date.UTC(year, month - 1, day))
    if (parsedDate.getUTCMonth() !== month - 1 || parsedDate.getUTCDate() !== day) return []
    const date = parsedDate.toISOString().slice(0, 10)
    const dateValue = Date.parse(`${date}T00:00:00.000Z`)
    if (dateValue < Date.parse(`${startDate}T00:00:00.000Z`) || dateValue > endDateValue) return []
    const nextIndex = mentions[index + 1]?.index ?? text.length
    const clauseText = text.slice((match.index ?? 0) + match[0].length, nextIndex)
    const clauseEnd = clauseText.search(/[。；;\n]/u)
    const clause = clauseText.slice(0, clauseEnd < 0 ? clauseText.length : clauseEnd)
    // 当前轮删除项只覆盖同一天的对应兴趣，不误删其他日期的同名地点。
    const names = interests.filter((name) => requiredVisitNameMatches(clause, name) &&
      !excludedStops.some((stop) => stop.date === date && explicitlyExcludedStopNameMatches(stop.stopName, name)))
    return names.length ? [{ date, names: [...new Set(names)] }] : []
  })
}

/** 允许常见景点简称与正式名称互相匹配，避免把同一地点误判为遗漏。 */
function requiredVisitNameMatches(candidate: string, expected: string): boolean {
  const aliases = [
    ['北大', '北京大学'],
    ['清华', '清华大学']
  ]
  const group = aliases.find((names) => names.includes(expected)) ?? [expected]
  const normalize = (value: string): string => value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '')
  const normalizedCandidate = normalize(candidate)
  return group.some((name) => normalizedCandidate.includes(normalize(name)))
}

/** 用户明确给出落地时间和酒店入住时，补齐抵达日的酒店停靠点。 */
function ensureArrivalLodgingStop(
  days: ItineraryDay[],
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief'],
  repairNotes: string[]
): void {
  const arrivalTime = firstClockText(tripBrief?.arrivalTime ?? '') ?? ''
  const lodgingLocation = tripBrief?.lodgingLocation.trim() ?? ''
  const constraints = tripBrief?.constraints ?? ''
  if (!arrivalTime || !lodgingLocation || !/(?:入住|办理入住)/u.test(constraints)) return

  const arrivalDay = days.find((day) => day.date === tripBrief?.startDate) ?? days[0]
  if (!arrivalDay) return
  const existingLodging = arrivalDay.stops.find((stop) =>
    stop.category.includes('住宿') || stop.name.includes(lodgingLocation))
  if (existingLodging) {
    if (!existingLodging.category.includes('住宿')) {
      existingLodging.category = '住宿'
      existingLodging.evidenceLevel = 'pending'
      existingLodging.sourceIds = []
      existingLodging.factClaims = []
      existingLodging.notes = `${existingLodging.notes ? `${existingLodging.notes} ` : ''}入住安排来自用户提供的信息；办理时间和接驳细节需确认。`.slice(0, 500)
      repairNotes.push('已将用户指定的酒店停靠点标为住宿，并提示核对入住与接驳细节。')
    }
    return
  }
  if (arrivalDay.stops.length >= MAX_ITINERARY_STOPS_PER_DAY) return
  const flightDepartureTime = flightDepartureTimeFromBrief(tripBrief)
  const arrivalIndex = arrivalDay.stops.findIndex((stop) => {
    if (!/交通/u.test(stop.category) || !containsClockTime(stop.time, arrivalTime)) return false
    const label = `${stop.name} ${stop.notes}`
    return /抵达|到达|落地/u.test(label) ||
      (!!flightDepartureTime && /航班|飞机|乘机|飞/u.test(label) && containsClockTime(stop.time, flightDepartureTime))
  })
  if (arrivalIndex < 0) return

  const arrivalMinutes = firstClockTimeMinutes(arrivalTime) ?? 0
  const transferIndex = arrivalDay.stops.findIndex((stop, index) =>
    index > arrivalIndex && /交通/u.test(stop.category) &&
    (stop.time === deferredArrivalTransferTime || (firstClockTimeMinutes(stop.time) ?? -1) > arrivalMinutes)
  )
  const lodgingIndex = transferIndex >= 0 ? transferIndex + 1 : arrivalIndex + 1
  const transfer = transferIndex >= 0 ? arrivalDay.stops[transferIndex] : undefined
  const transferEndTime = transfer && transfer.time !== deferredArrivalTransferTime
    ? lastClockTime(transfer.time)
    : undefined
  const lodgingTime = transferEndTime ? `${transferEndTime} 后入住` : '落地、取行李和接驳后（时段待核验）'
  arrivalDay.stops.splice(lodgingIndex, 0, {
    id: randomUUID(), name: lodgingLocation.slice(0, 160), area: '', time: lodgingTime, durationMinutes: null,
    category: '住宿', notes: '入住安排来自用户提供的信息；办理时间和接驳细节需按实际抵达情况确认。',
    transitToNext: '', evidenceLevel: 'pending', sourceIds: [], factClaims: []
  })
  repairNotes.push('已按用户提供的落地时间和酒店信息补入入住停靠点；接驳细节仍需核验。')
}

/** 校验费用覆盖、来源引用和单价区间，避免模型金额直接进入旅行数据。 */
function normalizeBudgetEstimate(
  value: unknown,
  context: Parameters<TravelTool['execute']>[1],
  repairNotes: string[]
): ItineraryBudgetEstimate {
  const estimate = asObject(value, '预算估算')
  if (estimate.currency !== 'CNY') throw new ToolInputError('旅行预算仅支持人民币 CNY。')
  if (!Array.isArray(estimate.items) || estimate.items.length > 30) throw new ToolInputError('预算费用项最多包含 30 项。')
  if (!Array.isArray(estimate.not_applicable_categories) || estimate.not_applicable_categories.length > budgetCategories.length) {
    throw new ToolInputError('预算不适用类别数量无效。')
  }
  const availableSources = context.availableSources ?? []
  const allowedSourceIds = context.sourceIds ?? []
  const items: ItineraryBudgetItem[] = estimate.items.map((rawItem) => {
    const item = asObject(rawItem, '预算费用项')
    const category = requireBudgetCostCategory(item.category)
    let evidenceLevel = isEvidenceLevel(item.evidence_level) ? item.evidence_level : 'pending'
    const rawSourceIds = item.source_ids
    const sourceIdsShapeValid = rawSourceIds === undefined || (
      Array.isArray(rawSourceIds) && rawSourceIds.length <= 5 &&
      rawSourceIds.every((id) => typeof id === 'string' && id.trim().length > 0 && id.length <= 100)
    )
    const requestedSourceIds = Array.isArray(rawSourceIds)
      ? rawSourceIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && id.length <= 100)
      : []
    const sourceIds = requestedSourceIds.filter((id) => allowedSourceIds.includes(id) &&
      availableSources.some((source) => source.id === id && budgetSourceCanBeReferenced(category, source)))
    const invalidSources = !sourceIdsShapeValid || sourceIds.length !== requestedSourceIds.length
    const amountMin = parseBudgetAmount(item.amount_min_fen)
    const amountMax = parseBudgetAmount(item.amount_max_fen)
    const validQuantity = Number.isInteger(item.quantity) && Number(item.quantity) >= 1 && Number(item.quantity) <= 1_000
    const quantity = validQuantity ? Number(item.quantity) : 1
    const invalidRange = amountMin.invalid || amountMax.invalid || amountMin.value === null || amountMax.value === null ||
      amountMin.value > amountMax.value || amountMax.value * quantity > Number.MAX_SAFE_INTEGER
    const missingSourcedEvidence = evidenceLevel === 'sourced' && (
      sourceIds.length === 0 || !sourceIds.some((id) => {
        const source = availableSources.find((item) => item.id === id)
        return !!source && budgetSourceSupportsExactAmounts(source, category, amountMin.value, amountMax.value)
      })
    )
    const needsReview = invalidRange || invalidSources || missingSourcedEvidence || !validQuantity ||
      (evidenceLevel === 'pending' && (amountMin.value !== null || amountMax.value !== null || sourceIds.length > 0))
    let amountMinFen: number | null = amountMin.value
    let amountMaxFen: number | null = amountMax.value
    if (needsReview) {
      evidenceLevel = 'pending'
      amountMinFen = null
      amountMaxFen = null
      repairNotes.push('预算中格式无效、依据缺失或数量不明的项目已标为待核验，金额不计入小计。')
    }
    const sourceIdsForItem = evidenceLevel === 'pending' ? [] : sourceIds
    const rawTitle = typeof item.title === 'string' && item.title.trim()
      ? item.title.trim().slice(0, 120)
      : BUDGET_CATEGORY_LABELS[category]
    const title = normalizeBudgetItemTitle(rawTitle, category)
    if (title !== rawTitle) repairNotes.push('费用标题中的金额或免费结论已移除，价格只保留在带证据状态的预算字段。')
    const unitLabel = typeof item.unit_label === 'string' && item.unit_label.trim()
      ? item.unit_label.trim().slice(0, 24)
      : '项'
    let basis = typeof item.basis === 'string' && item.basis.trim()
      ? item.basis.trim().slice(0, 300)
      : '金额、数量或依据不完整，待核验。'
    if (evidenceLevel !== 'sourced' && /(?:免费|免票|不收费)/u.test(basis)) {
      basis = '收费状态待核验。'
      repairNotes.push('预算依据含有未核实的免费或免票结论，已标为待核验。')
    } else if (evidenceLevel === 'pending' && sanitizeUnsupportedTicketPriceNotes(basis) !== basis) {
      basis = '金额或收费范围待核验。'
      repairNotes.push('预算依据含有未核实金额，已简化为待核验。')
    }
    return {
      id: randomUUID(), category,
      title,
      amountMinFen, amountMaxFen,
      quantity,
      unitLabel,
      evidenceLevel,
      sourceIds: sourceIdsForItem,
      basis
    }
  })
  const notApplicableCategories = estimate.not_applicable_categories.map((rawExclusion) => {
    const exclusion = asObject(rawExclusion, '不适用预算类别')
    return {
      category: requireBudgetCostCategory(exclusion.category),
      reason: requireString(exclusion.reason, '不适用原因', 1, 200)
    }
  })
  const excluded = new Set(notApplicableCategories.map((item) => item.category))
  const itemCategories = new Set(items.map((item) => item.category))
  if (excluded.size !== notApplicableCategories.length || [...excluded].some((category) => itemCategories.has(category))) {
    throw new ToolInputError('预算类别不能重复标记为不适用或同时列为费用项。')
  }
  const missingCategories = budgetCategories.filter((category) => !itemCategories.has(category) && !excluded.has(category))
  for (const category of missingCategories) {
    items.push({
      id: randomUUID(), category, title: BUDGET_CATEGORY_LABELS[category],
      amountMinFen: null, amountMaxFen: null, quantity: 1, unitLabel: '项',
      evidenceLevel: 'pending', sourceIds: [], basis: '当前未提供可靠金额，待核验。'
    })
  }
  if (missingCategories.length > 0) {
    repairNotes.push('预算缺少的费用类别已补为待核验项，未计入已知金额小计。')
  }
  return { currency: 'CNY', items, notApplicableCategories }
}

/** 预算来源不能只因请求成功就关联；搜索摘要、地图 POI 和无关服务均不构成价格依据。 */
function budgetSourceCanBeReferenced(category: BudgetCostCategory, source: SourceRecord): boolean {
  if (source.status !== 'success' || source.sourceNature === 'community-platform') return false
  const level = source.contentLevel ?? legacySourceContentLevel(source)
  if (source.kind === 'route') {
    return ['local-transport', 'intercity-transport'].includes(category) && level === 'structured' &&
      source.summary.split(/\r?\n/u).some((line) => /^方案\s+\d+：/u.test(line) && /票价估算/u.test(line))
  }
  return (source.kind === 'web' && level === 'page') ||
    (source.kind === 'user' && level === 'user-provided') ||
    (source.kind === 'plugin' && level === 'plugin')
}

/** 已核实金额必须能在直接来源中找到；路线费用还需匹配同一条结构化路线方案。 */
function budgetSourceSupportsExactAmounts(
  source: SourceRecord,
  category: BudgetCostCategory,
  minimumFen: number | null,
  maximumFen: number | null
): boolean {
  if (minimumFen === null || maximumFen === null || !budgetSourceCanBeReferenced(category, source)) return false
  if (source.kind === 'route') {
    const options = [...source.summary.matchAll(/^方案\s+(\d+)：/gmu)].map((match) => Number(match[1]))
    return options.some((option) => routeSummarySupportsMetrics(source.summary, option, undefined, undefined, minimumFen) &&
      routeSummarySupportsMetrics(source.summary, option, undefined, undefined, maximumFen))
  }
  return sourceMentionsYuanAmount(source.summary, minimumFen) && sourceMentionsYuanAmount(source.summary, maximumFen)
}

/** 将人民币分转换成页面可核对的元金额；零元必须由免费/免票字样直接支持。 */
function sourceMentionsYuanAmount(summary: string, amountFen: number): boolean {
  const normalized = summary.normalize('NFKC').replace(/[\s,，]/gu, '')
  if (amountFen === 0) return /免费|免票|免门票|不收费|(?:¥|￥)0(?:\.0{1,2})?(?:元)?/u.test(normalized)
  const yuan = (amountFen / 100).toFixed(2).replace(/\.0{1,2}$/u, '')
  const escaped = yuan.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`(?:¥|￥)${escaped}(?:元)?|(?<!\\d)${escaped}元`, 'u').test(normalized)
}

/** 费用标题只标识项目；金额、币种和证据状态统一由预算字段承载。 */
function normalizeBudgetItemTitle(value: string, category: BudgetCostCategory): string {
  const price = /(?:(?:¥|￥)\s*\d[\d,]*(?:\.\d{1,2})?(?:元)?|\d[\d,]*(?:\.\d{1,2})?\s*元)(?:\s*[-–—至]\s*(?:(?:¥|￥)\s*)?\d[\d,]*(?:\.\d{1,2})?(?:元)?)?(?:\s*\/\s*(?:人|位|次|趟|晚|间夜))?/gu
  const title = value
    .replace(/[（(][^（）()]*?(?:[¥￥]\s*\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s*元)[^（）()]*[）)]/gu, ' ')
    .replace(price, ' ')
    .replace(/(?:免费|免票|不收费)/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return title.slice(0, 120) || BUDGET_CATEGORY_LABELS[category]
}

/** 固定预算分类名称，拒绝模型自造类别。 */
function requireBudgetCostCategory(value: unknown): BudgetCostCategory {
  if (typeof value !== 'string' || !budgetCategories.includes(value as BudgetCostCategory)) {
    throw new ToolInputError('预算费用类别不受支持。')
  }
  return value as BudgetCostCategory
}

/** 仅保留安全整数分；模型金额格式异常时降为待核验，不丢弃整份行程。 */
function parseBudgetAmount(value: unknown): { value: number | null; invalid: boolean } {
  if (value === null) return { value: null, invalid: false }
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 10_000_000_000) {
    return { value: null, invalid: true }
  }
  return { value: Number(value), invalid: false }
}

/** 只接受预算项支持的三种证据状态。 */
function isEvidenceLevel(value: unknown): value is EvidenceLevel {
  return value === 'sourced' || value === 'estimated' || value === 'pending'
}

/** 校验日期、天序和站点数量，避免任意模型对象进入本地计划。 */
function normalizeDay(
  value: unknown,
  index: number,
  context: Parameters<TravelTool['execute']>[1],
  repairNotes: string[],
  factEvidenceDiagnostics: ItineraryFactEvidenceDiagnostics,
  factEvidenceCorrections: FactEvidenceCorrection[],
  businessWarnings: string[],
  knownStopNames: string[]
): ItineraryDay {
  const day = asObject(value, '行程日')
  const dayNumber = day.day_number
  if (!Number.isInteger(dayNumber) || Number(dayNumber) < 1 || Number(dayNumber) > 7) {
    throw new ToolInputError('行程序号必须为 1–7 的整数。')
  }
  const date = requireString(day.date, '行程日期', 0, 10)
  if (date && !isCalendarDate(date)) throw new ToolInputError('行程日期不是有效的 YYYY-MM-DD 日历日期。')
  const title = modelTextOrFallback(day.title, '每日主题', 100, `第 ${dayNumber} 天行程`, repairNotes)
  if (!Array.isArray(day.stops) || day.stops.length < 1 || day.stops.length > MAX_PROPOSED_STOPS_PER_DAY) {
    throw new ToolInputError(`每天必须包含 1–${MAX_PROPOSED_STOPS_PER_DAY} 个地点或活动。`)
  }
  const rawBlocks = day.schedule_blocks ?? []
  if (!Array.isArray(rawBlocks) || rawBlocks.length > 8) {
    throw new ToolInputError('每天最多可安排 8 个用餐、休息或机动时间块。')
  }
  const stops = day.stops.map((stop) => normalizeStop(
    stop, context.sourceIds ?? [], context.availableSources ?? [], repairNotes, factEvidenceDiagnostics,
    factEvidenceCorrections, knownStopNames
  ))
  const conditionalAlternativeIssue = scheduledConditionalAlternativeIssue(stops, context)
  if (conditionalAlternativeIssue) businessWarnings.push(conditionalAlternativeIssue)
  sortStopsByExplicitTime(stops, context.tripBrief?.lodgingLocation ?? '', repairNotes)
  bindExactRouteEvidence(stops, date, context, repairNotes)
  sanitizeTransitMetricEvidence(stops, context.availableSources ?? [], context.tripBrief?.lodgingLocation ?? '')
  sanitizeUnboundTransitDetails(stops, repairNotes)
  sanitizeUnverifiedStopNotes(stops, date, repairNotes)
  const normalizedBlocks = rawBlocks.map((block) => normalizeScheduleBlock(block, context, repairNotes))
  const requiredMeals = new Set((context.requiredMealSlots ?? [])
    .filter((requirement) => requirement.date === date)
    .flatMap((requirement) => requirement.slots))
  const scheduleBlocks = normalizedBlocks.filter((block) => {
    const mealSlot = mealSlotForBlock(block)
    return hasActionableTime(block.time, block.durationMinutes) ||
      (block.kind === 'meal' && mealSlot !== undefined && requiredMeals.has(mealSlot))
  })
  if (scheduleBlocks.length !== normalizedBlocks.length) repairNotes.push('已移除缺少时段的可选休息或机动时间块。')
  const nonRedundantBlocks = scheduleBlocks.filter((block) => !isRedundantMealBlock(block, stops))
  if (nonRedundantBlocks.length !== scheduleBlocks.length) repairNotes.push('已合并与餐馆地点重复的用餐时段。')
  const lodgingCommutes = normalizeLodgingCommutes(day.lodging_commutes ?? [], date, stops, context, repairNotes)
  const weather = context.dailyWeatherRequested ? dailyWeatherForDate(date, context.availableSources ?? []) : undefined
  return {
    id: randomUUID(),
    dayNumber: Number(dayNumber) || index + 1,
    date,
    title,
    stops,
    scheduleBlocks: nonRedundantBlocks,
    ...(weather ? { weather } : {}),
    ...(lodgingCommutes.length ? { lodgingCommutes } : {})
  }
}

/** 只绑定包含该日期逐日行的结构化天气来源；查不到时保留明确的 unknown 状态。 */
function dailyWeatherForDate(date: string, sources: SourceRecord[]): ItineraryDayWeather {
  const weatherSources = sources.filter((source) => source.kind === 'weather')
  if (date) {
    const forecast = weatherSources.flatMap((source) => {
      if (!['success', 'partial'].includes(source.status) || source.contentLevel !== 'structured') return []
      const row = source.summary.split(/\r?\n/u).map((line) => line.trim())
        .find((line) => line.startsWith(`${date}：`) || line.startsWith(`${date}:`))
      return row ? [{ source, row }] : []
    })[0]
    if (forecast) return { status: 'forecast', summary: forecast.row.slice(0, 300), sourceId: forecast.source.id }

    const unavailable = weatherSources.find((source) =>
      ['unavailable', 'error'].includes(source.status) && source.summary.includes(date)
    ) ?? weatherSources
      .filter((source) => ['unavailable', 'error'].includes(source.status))
      .sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt))[0]
    if (unavailable) {
      return {
        status: 'unknown',
        summary: `天气查询未返回可用预报：${unavailable.summary.slice(0, 220)}；${date} 天气未知。`,
        sourceId: unavailable.id
      }
    }
  }
  return {
    status: 'unknown',
    summary: date ? `未找到覆盖 ${date} 的天气预报；本日天气未知。` : '日期未确认，无法匹配逐日天气预报。'
  }
}

/** 条件替代安排不能占用正式时间线，否则会被误读为同时执行。 */
function scheduledConditionalAlternativeIssue(
  stops: ItineraryStop[],
  context: Parameters<TravelTool['execute']>[1]
): string | undefined {
  if (context.itineraryContingenciesRequested !== true) return undefined
  const alternatives = stops.filter((stop) => /(?:^|[：:（(\s])(?:备选点|替代点|备选地点)|(?:约满时替代|预约失败时替代)/u.test(stop.name))
  if (!alternatives.length) return undefined
  return (
    `条件替代点不能列为实际时段停靠点：${alternatives.map((stop) => stop.name).join('、')}。` +
    '可将其移入对应主停靠点的 conditional_alternatives；当前方案仍保留供审阅。'
  )
}

/** 将同日、同端点、同方式的成功路线来源绑定到相邻停靠点，避免模型漏引用已查结果。 */
function bindExactRouteEvidence(
  stops: ItineraryStop[],
  date: string,
  context: Parameters<TravelTool['execute']>[1],
  repairNotes: string[]
): void {
  const allowedSourceIds = new Set(context.sourceIds ?? [])
  const currentRunSourceIds = new Set(context.currentRunSourceIds ?? [])
  const sources = context.availableSources ?? []

  for (const [index, stop] of stops.entries()) {
    const nextStop = stops[index + 1]
    if (!nextStop || stop.transitEstimate?.destinationStopId === nextStop.id) continue
    const declaredMode = routeModeFromDescription(stop.transitToNext)
    if (!declaredMode) continue
    const matchingRoutes = sources.flatMap((source) => {
      if (!allowedSourceIds.has(source.id) || source.kind !== 'route' || source.status !== 'success' ||
        source.contentLevel !== 'structured' || !routeTitleMatchesStops(source.title, stop, nextStop)) return []
      const parsed = inspectSuccessfulRouteSummary(source, date, stop, declaredMode)
      return parsed.ok ? [{ source, ...parsed.value }] : []
    })
    if (matchingRoutes.length === 0) continue
    // 多轮研究可能留下相同路段的成功来源；优先绑定本轮新查结果，再按获取时间选最新一条。
    const currentMatches = matchingRoutes.filter(({ source }) => currentRunSourceIds.has(source.id))
    const candidates = currentMatches.length > 0 ? currentMatches : matchingRoutes
    candidates.sort((left, right) => right.source.fetchedAt.localeCompare(left.source.fetchedAt) ||
      left.source.id.localeCompare(right.source.id))

    const { source, optionNumber, durationMinutes, distanceMeters, queryDate, queryTime } = candidates[0]!
    const sourceAlreadyLinked = stop.sourceIds?.includes(source.id) === true
    // 路线估时有独立结构字段；通用来源或事实列表已满时也保留这条交通证据。
    const canAddSourceId = sourceAlreadyLinked || (stop.sourceIds?.length ?? 0) < MAX_ITINERARY_STOP_SOURCE_IDS
    const canAddFactClaim = (stop.factClaims?.length ?? 0) < MAX_ITINERARY_FACT_CLAIMS_PER_STOP
    const modeLabel = declaredMode === 'transit' ? '公共交通' : declaredMode === 'walking' ? '步行' : '驾车'
    const verification = declaredMode === 'transit' ? '班次和实时交通出行当天核对' : '现场通行情况出行当天核对'
    stop.transitEstimate = {
      sourceId: source.id,
      destinationStopId: nextStop.id,
      mode: declaredMode,
      fetchedAt: source.fetchedAt,
      optionNumber,
      ...(queryDate ? { queryDate } : {}),
      ...(queryTime ? { queryTime } : {}),
      durationMinutes,
      distanceMeters
    }
    if (canAddSourceId) stop.sourceIds = mergeItineraryStopSourceIds(stop.sourceIds, [source.id])
    if (canAddFactClaim) {
      stop.factClaims = [...(stop.factClaims ?? []), {
        id: randomUUID(),
        type: 'transport-time',
        value: `${source.provider} ${modeLabel}方案 ${optionNumber} 估算约 ${durationMinutes} 分钟`,
        scope: `${stop.name} → ${nextStop.name}`,
        evidenceLevel: 'sourced',
        sourceId: source.id
      }]
    }
    stop.transitToNext = `${modeLabel}前往“${nextStop.name}”，${source.provider}方案 ${optionNumber} 估算约 ${durationMinutes} 分钟；${verification}。`
      .slice(0, 300)
    repairNotes.push(canAddSourceId && canAddFactClaim
      ? '已将端点、交通方式和日期匹配的成功路线来源绑定到对应路段；班次或现场交通仍需当天复核。'
      : '已将路线来源绑定到独立交通字段；地点通用来源或事实列表已满，路线证据仍可在接驳详情查看。')
  }
}

/** 从明确写出的下一段交通方式读取路线类型；混合方式保留待核验。 */
function routeModeFromDescription(value: string): RouteMode | undefined {
  const modes = new Set<RouteMode>()
  if (/步行/u.test(value)) modes.add('walking')
  if (/打车|出租车|网约车|驾车|自驾/u.test(value)) modes.add('driving')
  if (/公共交通|地铁|公交|巴士|机场线|接驳/u.test(value)) modes.add('transit')
  return modes.size === 1 ? [...modes][0] : undefined
}

/** 路线来源端点须与相邻停靠点同名、同向；只忽略名称后的括号备注。 */
function routeTitleMatchesStops(title: string, origin: ItineraryStop, destination: ItineraryStop): boolean {
  const nameVariants = (value: string): string[] => [...new Set([
    value.trim(), value.replace(/[（(][^）)]*[）)]/gu, '').trim()
  ].filter(Boolean))]
  return nameVariants(origin.name).some((from) => nameVariants(destination.name)
    .some((to) => routeTitleMatchesOrderedEndpoints(title, from, to)))
}

type RouteSummaryFailure = Exclude<RouteBindingIssue, 'no_adjacent_segment' | 'planned_mode_unclear' | 'matching_route_not_bound'>

type RouteSummaryInspection =
  | { ok: true; value: { optionNumber: number; durationMinutes: number; distanceMeters: number | null; queryDate?: string; queryTime?: string } }
  | { ok: false; reason: RouteSummaryFailure }

/** 校验成功路线摘要的日期、时刻和方式，并仅提取第一条真实路线选项。 */
function inspectSuccessfulRouteSummary(
  source: SourceRecord,
  dayDate: string,
  origin: ItineraryStop,
  expectedMode: RouteMode
): RouteSummaryInspection {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dayDate)) return { ok: false, reason: 'trip_date_unknown' }

  const [header = '', ...lines] = source.summary.split(/\r?\n/u)
  const headerMatch = header.match(/，(公共交通|步行|驾车)(?:（([^）]*)）)?估算/u)
  const actualMode = headerMatch?.[1] === '公共交通' ? 'transit'
    : headerMatch?.[1] === '步行' ? 'walking'
      : headerMatch?.[1] === '驾车' ? 'driving' : undefined
  if (!actualMode) return { ok: false, reason: 'route_summary_unreadable' }
  if (actualMode !== expectedMode) return { ok: false, reason: 'mode_mismatch' }

  const queryMetadata = headerMatch?.[2] ?? ''
  const queryDate = queryMetadata.match(/\d{4}-\d{2}-\d{2}/u)?.[0]
  const rawQueryTime = queryMetadata.match(/(?:^|\s)([01]?\d|2[0-3]):([0-5]\d)(?:$|\s)/u)
  const queryTime = rawQueryTime ? `${rawQueryTime[1]}-${rawQueryTime[2]}` : undefined
  if (expectedMode === 'transit') {
    if (queryDate !== dayDate) return { ok: false, reason: 'query_date_mismatch' }
    const plannedTime = plannedRouteDepartureTime(origin)
    if (queryTime && plannedTime && queryTime !== plannedTime.replace(':', '-')) {
      return { ok: false, reason: 'query_time_mismatch' }
    }
    if (queryTime && !plannedTime) return { ok: false, reason: 'query_time_mismatch' }
  }

  const optionMatch = lines.find((line) => /^方案\s+1：/u.test(line))
  if (!optionMatch) return { ok: false, reason: 'route_summary_unreadable' }
  const durations = transitDurationMinutes(optionMatch)
  if (durations.length !== 1 || !routeSummarySupportsMetrics(source.summary, 1, undefined, durations[0])) {
    return { ok: false, reason: 'route_summary_unreadable' }
  }
  const distances = transitMetricsIn(optionMatch).distances
  return { ok: true, value: {
    optionNumber: 1,
    durationMinutes: durations[0]!,
    distanceMeters: distances.length === 1 ? distances[0]! : null,
    ...(queryDate ? { queryDate } : {}),
    ...(queryTime ? { queryTime } : {})
  } }
}

/** 从用户已提供的离站时间补齐车站锚点，接驳耗时保持待核验。 */
function ensureDepartureStop(
  days: ItineraryDay[],
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief'],
  repairNotes: string[]
): void {
  const leaveTime = departureClockLabel(tripBrief?.leaveTime ?? '')
  if (!leaveTime) return
  const departureDay = days.find((day) => day.date === tripBrief?.endDate) ?? days.at(-1)
  if (!departureDay) return
  const terminalDeadline = departureStationArrivalDeadlineFromBrief(tripBrief)
  const terminalTime = terminalDeadline?.time
  const nextDayArrival = nextDayArrivalFromBrief(tripBrief?.constraints ?? '', tripBrief?.endDate)
  const location = departureStopNameFromBrief(tripBrief, leaveTime)
  const existingDepartureStop = departureDay.stops.find((stop) =>
    /交通/u.test(stop.category) && /(?:站|机场|码头)/u.test(stop.name) && containsClockTime(stop.time, leaveTime))
  if (existingDepartureStop) {
    if (location && existingDepartureStop.name.includes(location)) {
      removeMealLabelFromDepartureAnchor(existingDepartureStop, location, repairNotes)
    }
    if (terminalTime) {
      existingDepartureStop.time = `${terminalTime}前抵达；${leaveTime}离站`
      repairNotes.push(`已将用户要求的 ${terminalTime} 前抵达站点和 ${leaveTime} 离站时刻合并到返程交通锚点。`)
    } else if (!terminalTime) {
      existingDepartureStop.time = leaveTime
    }
    existingDepartureStop.durationMinutes = null
    const missingArrivalNote = nextDayArrival &&
      (!existingDepartureStop.notes.includes(nextDayArrival.time) || !existingDepartureStop.notes.includes(nextDayArrival.destination))
    if (missingArrivalNote && nextDayArrival) {
      const arrivalNote = `用户提供的次日 ${nextDayArrival.time} 抵达${nextDayArrival.destination}；请以客票核对。`
      existingDepartureStop.notes = `${existingDepartureStop.notes ? `${existingDepartureStop.notes} ` : ''}${arrivalNote}`.slice(0, 500)
      repairNotes.push('已将用户提供的次日抵达时间和地点补入返程交通备注。')
    }
    return
  }

  if (!location) return
  const arrivalNote = nextDayArrival ? `次日 ${nextDayArrival.time} 抵达${nextDayArrival.destination}；` : ''
  const notes = `按用户提供信息，${leaveTime} 出发；${arrivalNote}车次和检票信息待核验。`
  const existingStop = departureDay.stops.find((stop) =>
    /交通/u.test(stop.category) && stop.name.includes(location))
  if (existingStop) {
    removeMealLabelFromDepartureAnchor(existingStop, location, repairNotes)
    existingStop.time = terminalTime
      ? `${terminalTime}前抵达；${leaveTime}离站`
      : leaveTime
    existingStop.durationMinutes = null
    existingStop.category = '交通'
    existingStop.notes = `${existingStop.notes ? `${existingStop.notes} ` : ''}${notes}`.slice(0, 500)
  } else {
    if (departureDay.stops.length >= MAX_ITINERARY_STOPS_PER_DAY) return
    const previousStop = departureDay.stops.at(-1)
    if (previousStop && !previousStop.transitToNext.trim()) {
      previousStop.transitToNext = `公共交通前往${location}，具体线路和耗时待核验。`
    }
    const departureStop: ItineraryStop = {
      id: randomUUID(), name: location, area: '',
      time: terminalTime ? `${terminalTime}前抵达；${leaveTime}离站` : leaveTime, durationMinutes: null,
      category: '交通', notes: terminalTime
        ? `${terminalTime} 前抵达${location}来自用户提供；按 ${leaveTime} 离站安排候车，进站和安检信息仍需核验。${arrivalNote}`.slice(0, 500)
        : notes,
      transitToNext: '', evidenceLevel: 'pending', sourceIds: [], factClaims: []
    }
    const insertionIndex = departureDay.stops.findIndex((stop) => {
      const stopMinutes = firstClockTimeMinutes(stop.time)
      return stopMinutes !== undefined && stopMinutes > Number(leaveTime.slice(0, 2)) * 60 + Number(leaveTime.slice(3))
    })
    departureDay.stops.splice(insertionIndex < 0 ? departureDay.stops.length : insertionIndex, 0, departureStop)
  }
  repairNotes.push(`已按用户提供信息补入 ${location} ${leaveTime} 交通停靠点；接驳线路与耗时待核验。`)
}

/** 保留模型写入候车区的站点锚点，避免误把餐饮标签带入返程截止清理。 */
function removeMealLabelFromDepartureAnchor(stop: ItineraryStop, location: string, repairNotes: string[]): void {
  if (!/餐|用餐|美食|吃饭/u.test(stop.name)) return
  stop.name = location.slice(0, 160)
  stop.category = '交通'
  repairNotes.push(`已从返程交通锚点移除误附的餐饮名称，保留 ${location} 候车安排。`)
}

/** 将明确给出的返程酒店出发时刻作为独立交通锚点保留。 */
function ensureHotelDepartureStop(
  days: ItineraryDay[],
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief'],
  repairNotes: string[],
  businessWarnings: string[]
): void {
  const time = lodgingDepartureTimeFromBrief(tripBrief)
  const location = tripBrief?.lodgingLocation.trim() ?? ''
  if (!time || !location) return
  const departureDay = days.find((day) => day.date === tripBrief?.endDate) ?? days.at(-1)
  if (!departureDay) return
  const existing = departureDay.stops.find((stop) =>
    /交通|住宿/u.test(stop.category) && stop.name.includes(location) && containsClockTime(stop.time, time))
  if (existing) {
    existing.time = time
    existing.durationMinutes = null
    existing.category = '交通'
    const departureNote = `酒店出发时刻 ${time} 来自用户提供；前往车站/机场的线路与耗时待核验。`
    if (!existing.notes.includes(departureNote)) {
      existing.notes = `${existing.notes ? `${existing.notes} ` : ''}${departureNote}`.slice(0, 500)
    }
    repairNotes.push(`已将 ${time} 酒店出发规整为零时长交通锚点。`)
    return
  }
  if (departureDay.stops.length >= MAX_ITINERARY_STOPS_PER_DAY) {
    businessWarnings.push(`返程日已达地点上限，尚未加入 ${time} 酒店出发锚点；请判断是否合并可选安排。`)
    return
  }

  const stop: ItineraryStop = {
    id: randomUUID(), name: location.slice(0, 160), area: '', time, durationMinutes: null,
    category: '交通', notes: `酒店出发时刻 ${time} 来自用户提供；前往车站/机场的线路与耗时待核验。`,
    transitToNext: '', evidenceLevel: 'pending', sourceIds: [], factClaims: []
  }
  const timeMinutes = firstClockTimeMinutes(time) ?? 0
  const insertionIndex = departureDay.stops.findIndex((item) => {
    const minutes = firstClockTimeMinutes(item.time)
    return minutes !== undefined && minutes > timeMinutes
  })
  departureDay.stops.splice(insertionIndex < 0 ? departureDay.stops.length : insertionIndex, 0, stop)
  repairNotes.push(`已按用户提供信息补入 ${time} 酒店出发交通锚点；接驳耗时待核验。`)
}

/** 只读取明确写出的酒店出发时刻，不从返程车票时间推算。 */
function lodgingDepartureTimeFromBrief(
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief']
): string | undefined {
  const text = tripBrief?.constraints ?? ''
  const match = text.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)\s*(?:从|由)\s*(?:酒店区域|酒店|住宿地|住处)[^，,。；;\n]{0,12}(?:出发|离开|前往)/u)
  if (!match) return undefined
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`
}

/** 只采用与返程车票终点相同的用户明确到站截止时刻。 */
function departureStationArrivalDeadlineFromBrief(
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief']
): { time: string; station: string } | undefined {
  const leaveTime = departureClockLabel(tripBrief?.leaveTime ?? '')
  const station = leaveTime ? departureStopNameFromBrief(tripBrief, leaveTime) : undefined
  if (!leaveTime || !station) return undefined
  const normalize = (value: string): string => value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '')
  const arrivalDeadlines = [...(tripBrief?.constraints ?? '').matchAll(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)\s*(?:前|之前)\s*(?:抵达|到达)\s*([\p{Script=Han}A-Za-z0-9·（）()]{2,36}?(?:站|机场|码头))(?=候车|等候|进站|安检|检票|[，,。；;\n]|$)/gu)]
  for (const match of arrivalDeadlines) {
    const candidate = match[3]?.trim()
    if (!candidate || (!normalize(candidate).includes(normalize(station)) && !normalize(station).includes(normalize(candidate)))) continue
    const time = `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`
    if ((firstClockTimeMinutes(time) ?? 1_440) >= (firstClockTimeMinutes(leaveTime) ?? 0)) continue
    return { time, station: candidate }
  }
  return undefined
}

/** 高强度多站日缺少休息时，在相邻时段中补入可调整的机动时间。 */
function ensureHighIntensityRestBuffers(
  days: ItineraryDay[],
  context: Parameters<TravelTool['execute']>[1],
  repairNotes: string[]
): void {
  if (!highIntensityRestRequested(context.tripBrief, context.userRequest)) return

  const protectedDates = new Set(context.unchangedItineraryDates ?? [])
  let added = 0
  for (const day of days) {
    if (protectedDates.has(day.date) || day.scheduleBlocks.some((block) => block.kind === 'rest' || block.kind === 'buffer')) continue
    const visitStops = day.stops.filter(isVisitStop)
    if (visitStops.length < 3 || day.scheduleBlocks.length >= 8) continue

    let best: { start: number; gap: number; area: string } | undefined
    for (let index = 0; index < visitStops.length - 1; index += 1) {
      const current = visitStops[index]
      const next = visitStops[index + 1]
      if (!current || !next) continue
      const start = firstClockTimeMinutes(current.time)
      const nextStart = firstClockTimeMinutes(next.time)
      if (start === undefined || nextStart === undefined) continue

      const stopTimes = [...current.time.matchAll(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu)]
      const explicitEnd = stopTimes.length > 1
        ? firstClockTimeMinutes(stopTimes[1]?.[0] ?? '')
        : undefined
      const occupiedUntil = explicitEnd !== undefined && explicitEnd >= start
        ? explicitEnd
        : current.durationMinutes !== null
          ? start + current.durationMinutes
          : start
      const routeMinutes = current.transitEstimate?.durationMinutes ?? 0
      const gapStart = occupiedUntil + routeMinutes
      const available = nextStart - gapStart
      if (available < 60 || (best && available <= best.gap)) continue
      best = {
        start: gapStart + Math.floor((available - 30) / 2),
        gap: available,
        area: current.area && current.area === next.area ? current.area : ''
      }
    }

    const time = best
      ? `${formatClockMinutes(best.start)}–${formatClockMinutes(best.start + 30)}`
      : '待安排'
    day.scheduleBlocks.push({
      id: randomUUID(), kind: 'buffer', title: '休息与机动时间', time,
      durationMinutes: 30, area: best?.area ?? '',
      notes: '按高强度行程保留的休整余量；可根据开放时间、通勤和体力调整。'
    })
    added += 1
  }

  if (added) repairNotes.push(`已为 ${added} 个高强度多站日补入休息与机动时段；时段可继续调整。`)
}

/** 高体力/高密度偏好默认保留休息，用户明确要求不休息时尊重其选择。 */
function highIntensityRestRequested(
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief'],
  userRequest = ''
): boolean {
  const request = `${tripBrief?.pace ?? ''}\n${tripBrief?.constraints ?? ''}\n${userRequest}`
  const intense = /(?:暴走|高强度|高密度|体力好|体力较好|想多看一些)/u.test(request)
  const declinesRest = /(?:不需要|无需|不用|不要|别|不安排|不想要).{0,8}(?:休息|休整)|(?:休息|休整).{0,8}(?:不需要|无需|不用|不要|别|不安排)/u.test(request)
  return intense && !declinesRest
}

/** 将行程分钟数格式化为 24 小时时刻。 */
function formatClockMinutes(totalMinutes: number): string {
  const minutes = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60)
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** 补齐相邻停靠点的出行方式；缺少路线来源时明确保留待核验状态。 */
function ensureTransitDescriptions(
  days: ItineraryDay[],
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief'],
  repairNotes: string[],
  requireNamedEndpoints = false
): void {
  const preference = tripBrief?.transport.trim() ?? ''
  const prefersTransit = /公共交通|地铁|公交/u.test(preference)
  const prefersWalking = /步行/u.test(preference) && !prefersTransit
  const flightDepartureTime = flightDepartureTimeFromBrief(tripBrief)
  const flightArrivalTime = tripBrief?.arrivalTime ?? ''
  let repaired = false

  for (const day of days) {
    for (const [index, stop] of day.stops.entries()) {
      const nextStop = day.stops[index + 1]
      if (!nextStop) continue
      if (!stop.transitToNext.trim()) {
        const nextLabel = `${nextStop.name} ${nextStop.notes}`
        const isAirportCheckIn = /交通/u.test(stop.category) && /机场/u.test(stop.name) &&
          /航班|飞机|乘机|起飞/u.test(nextLabel)
        const isFlightLeg = !!flightDepartureTime && !!flightArrivalTime &&
          containsClockTime(stop.time, flightDepartureTime) && containsClockTime(nextStop.time, flightArrivalTime) &&
          /航班|飞机|乘机|飞/u.test(`${stop.name} ${nextStop.name}`)
        const sameLandmark = !/交通/u.test(stop.category) && !/交通/u.test(nextStop.category) &&
          ['故宫', '颐和园', '圆明园', '八达岭', '天坛', '北京西站', '清华大学', '北京大学', '前门大街', '国家博物馆', '牛街']
          .some((landmark) => stop.name.includes(landmark) && nextStop.name.includes(landmark))
        const routeLabel = isAirportCheckIn ? '在机场办理值机、安检并候机'
          : isFlightLeg ? `乘坐用户提供的航班前往“${nextStop.name}”`
          : sameLandmark ? `步行至“${nextStop.name}”`
          : prefersTransit ? `优先公共交通前往“${nextStop.name}”`
            : prefersWalking ? `步行前往“${nextStop.name}”` : `“${nextStop.name}”的交通方式待核验`
        const pendingDetails = isAirportCheckIn ? '航班时刻和手续以客票为准。'
          : isFlightLeg ? '飞行时长按客票核验。' : '具体线路和耗时待核验。'
        stop.transitToNext = `${routeLabel}；${pendingDetails}`.slice(0, 300)
        repaired = true
      } else if (stop.transitEstimate?.destinationStopId !== nextStop.id &&
        !/待核验|待复核/u.test(stop.transitToNext)) {
        stop.transitToNext = `${stop.transitToNext}；具体线路和耗时待核验。`.slice(0, 300)
        repaired = true
      }
      if (requireNamedEndpoints) {
        const hasMode = hasTransitMode(stop.transitToNext) || stop.transitEstimate?.destinationStopId === nextStop.id
        const hasDestination = requiredVisitNameMatches(stop.transitToNext, nextStop.name) ||
          stop.transitEstimate?.destinationStopId === nextStop.id
        if (!hasMode || !hasDestination) {
          const mode = transitModeLabel(stop, tripBrief?.transport ?? '', nextStop.name)
          stop.transitToNext = `${mode}前往“${nextStop.name}”；具体线路和耗时待核验。`.slice(0, 300)
          repaired = true
        } else if (stop.transitEstimate?.destinationStopId !== nextStop.id && !/耗时.{0,4}待核验|线路.{0,4}待核验/u.test(stop.transitToNext)) {
          stop.transitToNext = `${stop.transitToNext.slice(0, 245).trimEnd()}；具体线路和耗时待核验。`.slice(0, 300)
          repaired = true
        }
      }
    }
  }
  if (repaired) repairNotes.push('已补齐相邻停靠点的交通说明；没有路线来源的线路与耗时标为待核验。')
}

/** 目标不明确时按用户偏好补路线，避免把站内步行误作景点间交通。 */
function transitModeLabel(stop: ItineraryStop, preference: string, destination: string): string {
  const hasNamedDestination = requiredVisitNameMatches(stop.transitToNext, destination)
  const mode = stop.transitEstimate?.mode
  if (hasNamedDestination || mode) {
    if (mode === 'walking' || /步行/u.test(stop.transitToNext)) return '步行'
    if (mode === 'driving' || /打车|出租车|网约车|驾车|自驾/u.test(stop.transitToNext)) return '打车/驾车'
    if (/火车|高铁|动车/u.test(stop.transitToNext)) return '铁路交通'
    if (/航班|飞机/u.test(stop.transitToNext)) return '航班'
    if (mode === 'transit' || /地铁|公交|巴士|公共交通|机场线|接驳/u.test(stop.transitToNext)) return '优先公共交通'
  }
  if (/公共交通|地铁|公交/u.test(preference)) return '优先公共交通'
  if (/步行/u.test(preference)) return '步行'
  if (/火车|高铁|动车/u.test(stop.transitToNext)) return '铁路交通'
  if (/航班|飞机/u.test(stop.transitToNext)) return '航班'
  if (/打车|出租车|网约车|驾车|自驾/u.test(stop.transitToNext)) return '打车/驾车'
  if (/步行/u.test(stop.transitToNext)) return '步行'
  return '交通方式待核验'
}

/** 用用户已提供的起飞时刻补齐出发日锚点，避免模型漏掉抵达日之前的航班。 */
function ensureFlightDepartureStop(
  days: ItineraryDay[],
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief'],
  repairNotes: string[]
): void {
  const departureTime = flightDepartureTimeFromBrief(tripBrief)
  if (!departureTime) return
  const departureDay = days.find((day) => day.date === tripBrief?.startDate) ?? days[0]
  if (!departureDay || departureDay.stops.some((stop) =>
    /交通/u.test(stop.category) && containsClockTime(stop.time, departureTime))) return
  if (departureDay.stops.length >= MAX_ITINERARY_STOPS_PER_DAY) return

  const flightDetails = `${tripBrief?.constraints ?? ''}\n${tripBrief?.arrivalFlight ?? ''}`
  const timeIndex = flightDetails.indexOf(departureTime)
  const routeContext = timeIndex < 0 ? '' : flightDetails.slice(Math.max(0, timeIndex - 20), timeIndex + departureTime.length + 64)
  const afterTimeContext = timeIndex < 0 ? '' : flightDetails.slice(timeIndex + departureTime.length, timeIndex + departureTime.length + 64)
  const route = routeContext.match(/从\s*([\p{Script=Han}A-Za-z0-9·]{2,30}?)\s*(?:飞|起飞|乘机)/u)
  const afterTimeAirport = afterTimeContext.match(/^\s*([\p{Script=Han}A-Za-z0-9·]{2,30}?机场)(?=\s*(?:起飞|出发|飞|到|→|->))/u)
  const origin = route?.[1]?.trim() ?? afterTimeAirport?.[1]?.trim() ?? airportArrivalDeadlineFromBrief(tripBrief)?.airport ?? ''
  const airportName = origin && !/机场/u.test(origin) ? `${origin}机场` : origin
  const name = airportName ? `${airportName}航班起飞` : '航班起飞（出发机场待核验）'
  const stop: ItineraryStop = {
    id: randomUUID(), name: name.slice(0, 160), area: '', time: departureTime, durationMinutes: null,
    category: '交通', notes: '起飞时刻来自用户提供；实际航班和机场手续以客票为准。',
    transitToNext: '', evidenceLevel: 'pending', sourceIds: [], factClaims: []
  }
  const departureMinutes = firstClockTimeMinutes(departureTime) ?? 0
  const insertionIndex = departureDay.stops.findIndex((item) => {
    const minutes = firstClockTimeMinutes(item.time)
    return minutes !== undefined && minutes > departureMinutes
  })
  departureDay.stops.splice(insertionIndex < 0 ? departureDay.stops.length : insertionIndex, 0, stop)
  repairNotes.push(`已按用户提供信息补入 ${departureTime} 航班起飞时刻；机场与登机细节需按客票核对。`)
}

/** 按用户的最晚到机场时间补一个出发锚点，地面通勤路线仍标待核验。 */
function ensureAirportArrivalDeadlineStop(
  days: ItineraryDay[],
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief'],
  repairNotes: string[]
): void {
  const deadline = airportArrivalDeadlineFromBrief(tripBrief)
  if (!deadline) return
  const arrivalDay = days.find((day) => day.date === tripBrief?.startDate) ?? days[0]
  if (!arrivalDay) return
  const deadlineMinutes = firstClockTimeMinutes(deadline.time)
  if (deadlineMinutes === undefined) return
  const alreadyCovered = arrivalDay.stops.some((stop) => {
    if (!/交通/u.test(stop.category) || !/机场/u.test(stop.name) ||
      (!stop.name.includes(deadline.airport.replace(/机场$/u, '')) && !deadline.airport.includes(stop.name))) return false
    const endTime = lastClockTime(stop.time) ?? stop.time
    const endMinutes = firstClockTimeMinutes(endTime)
    return endMinutes !== undefined && endMinutes <= deadlineMinutes
  })
  if (alreadyCovered) return

  if (arrivalDay.stops.length >= MAX_ITINERARY_STOPS_PER_DAY) {
    // 停靠点已满时，将到场截止并入同机场的航班锚点，避免丢失硬约束。
    const airportStop = arrivalDay.stops.find((stop) =>
      /机场/u.test(stop.name) &&
      (stop.name.includes(deadline.airport.replace(/机场$/u, '')) || deadline.airport.includes(stop.name))
    )
    if (!airportStop) return
    const departureTime = flightDepartureTimeFromBrief(tripBrief)
    airportStop.category = '交通'
    airportStop.durationMinutes = null
    airportStop.time = `${deadline.time}前抵达${departureTime ? `；${departureTime}起飞` : ''}`
    const note = '最晚到机场时间来自用户提供；从出发地到机场的线路和缓冲时间待核验。'
    airportStop.notes = `${airportStop.notes ? `${airportStop.notes} ` : ''}${note}`.slice(0, 500)
    repairNotes.push(`已将 ${deadline.time} 前抵达${deadline.airport}并入现有机场交通锚点，避免重复占用停靠点。`)
    return
  }

  const stop: ItineraryStop = {
    id: randomUUID(), name: deadline.airport.slice(0, 160), area: '',
    time: `${deadline.time} 前抵达`, durationMinutes: null, category: '交通',
    notes: '最晚到机场时间来自用户提供；从出发地到机场的线路和缓冲时间待核验。',
    transitToNext: '', evidenceLevel: 'pending', sourceIds: [], factClaims: []
  }
  const insertionIndex = arrivalDay.stops.findIndex((item) => {
    const minutes = firstClockTimeMinutes(item.time)
    return minutes !== undefined && minutes > deadlineMinutes
  })
  arrivalDay.stops.splice(insertionIndex < 0 ? arrivalDay.stops.length : insertionIndex, 0, stop)
  repairNotes.push(`已按用户提供信息补入 ${deadline.time} 前抵达${deadline.airport}的锚点；出发地面交通待核验。`)
}

/** 只解析用户明确写出的机场截止时刻和机场名，不从城市推测机场。 */
function airportArrivalDeadlineFromBrief(
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief']
): { time: string; airport: string } | undefined {
  const text = tripBrief?.constraints ?? ''
  const match = text.match(/(?:最迟|必须|务必)?\s*(\d{1,2}:[0-5]\d)\s*(?:前|之前)\s*(?:(?:必须|务必|最迟)\s*)?(?:到达|抵达|到)?\s*([\p{Script=Han}A-Za-z0-9·（）()]{2,36}?机场)/u)
  if (!match) return undefined
  const [hour, minute] = match[1].split(':')
  return { time: `${hour.padStart(2, '0')}:${minute}`, airport: match[2].trim() }
}

/** 用户只提供抵达时刻时，也补入独立锚点，避免与取行李和接驳时段合并。 */
function ensureArrivalTimeAnchor(
  days: ItineraryDay[],
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief'],
  repairNotes: string[]
): void {
  const arrivalTime = firstClockText(tripBrief?.arrivalTime ?? '') ?? ''
  const departureTime = flightDepartureTimeFromBrief(tripBrief)
  if (!arrivalTime) return
  const arrivalDay = days.find((day) => day.date === tripBrief?.startDate) ?? days[0]
  if (!arrivalDay) return
  const airport = flightArrivalAirportFromBrief(tripBrief)
  const hasArrivalStop = arrivalDay.stops.some((stop) => {
    if (!/交通/u.test(stop.category)) return false
    const label = `${stop.name} ${stop.notes}`
    const clockLabels = [...stop.time.normalize('NFKC').matchAll(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu)]
      .map((match) => normalizeClockLabel(`${match[1]}:${match[2]}`))
    const exactArrivalMoment = clockLabelsMatchArrivalMoment(stop.time, arrivalTime)
    const matchesAirport = namesArrivalAirport(stop, airport)
    const combinedFlightLeg = departureTime !== undefined && clockLabels.length >= 2 && clockLabels[0] === departureTime &&
      clockLabels.at(-1) === arrivalTime && /航班|飞机|乘机|飞/u.test(label)
    return (exactArrivalMoment && (/抵达|到达|落地/u.test(label) || matchesAirport)) || combinedFlightLeg
  })
  if (hasArrivalStop || arrivalDay.stops.length >= MAX_ITINERARY_STOPS_PER_DAY) return

  const name = airport ? `${airport}航班抵达` : '抵达时刻锚点（地点待核验）'
  const stop: ItineraryStop = {
    id: randomUUID(), name: name.slice(0, 160), area: '', time: arrivalTime, durationMinutes: null,
    category: '交通', notes: '抵达时刻来自用户提供；离站和前往首站的路线待核验。',
    transitToNext: '', evidenceLevel: 'pending', sourceIds: [], factClaims: []
  }
  const arrivalMinutes = firstClockTimeMinutes(arrivalTime) ?? 0
  const timeInsertionIndex = arrivalDay.stops.findIndex((item) => {
    const minutes = firstClockTimeMinutes(item.time)
    const postArrivalLodging = /住宿/u.test(item.category) && /(?:后入住|入住后)/u.test(item.time)
    return minutes !== undefined && (minutes > arrivalMinutes || (minutes === arrivalMinutes && postArrivalLodging))
  })
  const relativeArrivalStopIndex = arrivalDay.stops.findIndex((item) =>
    (/住宿/u.test(item.category) && /(?:落地|接驳)后/u.test(item.time)) ||
    (/交通/u.test(item.category) && item.time === deferredArrivalTransferTime)
  )
  const deferredMealIndex = arrivalDay.stops.findIndex((item) =>
    mealSlotForStop(item) !== undefined && item.time === deferredArrivalMealTime
  )
  const relativeInsertionIndex = [relativeArrivalStopIndex, deferredMealIndex]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0]
  const insertionIndex = timeInsertionIndex >= 0
    ? relativeInsertionIndex === undefined ? timeInsertionIndex : Math.min(timeInsertionIndex, relativeInsertionIndex)
    : relativeInsertionIndex ?? arrivalDay.stops.length
  arrivalDay.stops.splice(insertionIndex, 0, stop)
  repairNotes.push(`已按用户提供信息补入 ${arrivalTime} 抵达时刻锚点；离站和接驳仍待核验。`)
}

/** 修复把落地锚点误当成机场接驳发车时刻的模型输出，不推测缓冲分钟数。 */
function deferArrivalTransferStartingAtLanding(
  days: ItineraryDay[],
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief'],
  repairNotes: string[]
): void {
  const arrivalTime = firstClockText(tripBrief?.arrivalTime ?? '')
  const arrivalMinutes = arrivalTime ? firstClockTimeMinutes(arrivalTime) : undefined
  const arrivalDay = days.find((day) => day.date === tripBrief?.startDate) ?? days[0]
  if (!arrivalTime || arrivalMinutes === undefined || !arrivalDay) return

  const airport = flightArrivalAirportFromBrief(tripBrief)
  const deferredStops: ItineraryStop[] = []
  for (const stop of arrivalDay.stops) {
    if (!/交通/u.test(stop.category) || firstClockTimeMinutes(stop.time) !== arrivalMinutes) continue
    const label = `${stop.name} ${stop.notes}`
    const exactArrivalMoment = clockLabelsMatchArrivalMoment(stop.time, arrivalTime)
    const matchesAirport = namesArrivalAirport(stop, airport)

    // 航班落地点是零时长锚点；保留地点身份，移除模型误加的停留时长。
    if (exactArrivalMoment && (/抵达|到达|落地/u.test(label) || matchesAirport)) {
      stop.time = arrivalTime
      if (stop.durationMinutes !== null) stop.durationMinutes = null
      stop.notes = appendArrivalNote(stop.notes, '用户提供的落地时刻仅作交通锚点；离站、取行李与接驳时间另行核验。')
      continue
    }

    // 交通段不能与落地时刻同刻开始，尤其不能把落地后接驳当作实时路线时刻。
    stop.time = deferredArrivalTransferTime
    stop.evidenceLevel = 'pending'
    stop.notes = appendArrivalNote(stop.notes, '接驳不能从落地时刻开始；离站、取行李后的实际发车时刻待核验。')
    deferredStops.push(stop)
  }
  if (!deferredStops.length) return

  // 将待核验接驳移到落地锚点之后，确保后续酒店和餐次按真实顺序展示。
  const deferredIds = new Set(deferredStops.map((stop) => stop.id))
  const orderedStops = arrivalDay.stops.filter((stop) => !deferredIds.has(stop.id))
  const anchorIndex = orderedStops.findIndex((stop) => /交通/u.test(stop.category) &&
    clockLabelsMatchArrivalMoment(stop.time, arrivalTime) &&
    (/抵达|到达|落地/u.test(`${stop.name} ${stop.notes}`) || namesArrivalAirport(stop, airport)))
  if (anchorIndex >= 0) orderedStops.splice(anchorIndex + 1, 0, ...deferredStops)
  else orderedStops.push(...deferredStops)
  arrivalDay.stops.splice(0, arrivalDay.stops.length, ...orderedStops)
  repairNotes.push('已将从落地同刻开始的接驳改为落地、离站和取行李后的待核验时段。')
}

/** 判断用户指定机场名称是否与航班落地点一致，避免按城市猜测机场。 */
function namesArrivalAirport(stop: ItineraryStop, airport: string | undefined): boolean {
  return Boolean(airport) && normalizeVisitMatch(`${stop.name} ${stop.area}`)
    .includes(normalizeVisitMatch(airport!))
}

/** 检查行程项是否只含单一的用户落地时刻。 */
function clockLabelsMatchArrivalMoment(value: string, arrivalTime: string): boolean {
  const labels = [...value.normalize('NFKC').matchAll(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu)]
  return labels.length === 1 && normalizeClockLabel(`${labels[0]![1]}:${labels[0]![2]}`) === arrivalTime
}

/** 将起飞前交通、落地锚点和落地后的相对入住/用餐恢复为正确顺序。 */
function orderArrivalAnchorsBeforeRelativeStops(
  days: ItineraryDay[],
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief'],
  protectedDates: string[]
): void {
  const arrivalTime = firstClockText(tripBrief?.arrivalTime ?? '')
  const arrivalMinutes = arrivalTime ? firstClockTimeMinutes(arrivalTime) : undefined
  const arrivalDay = days.find((day) => day.date === tripBrief?.startDate)
  if (!arrivalDay || !arrivalTime || arrivalMinutes === undefined || protectedDates.includes(arrivalDay.date)) return

  const departureTime = flightDepartureTimeFromBrief(tripBrief)
  const arrivalIndex = arrivalDay.stops.findIndex((stop) => {
    if (!/交通/u.test(stop.category) || !containsClockTime(stop.time, arrivalTime)) return false
    const label = `${stop.name} ${stop.notes}`
    const combinedFlightLeg = departureTime !== undefined && containsClockTime(stop.time, departureTime) &&
      /航班|飞机|乘机|飞/u.test(label)
    return !combinedFlightLeg && /抵达|到达|落地/u.test(label)
  })
  if (arrivalIndex < 0) return

  const departureMinutes = departureTime ? firstClockTimeMinutes(departureTime) : undefined
  const arrivalStop = arrivalDay.stops[arrivalIndex]
  if (!arrivalStop) return
  const beforeArrivalStops = arrivalDay.stops.filter((stop, index) => {
    if (index === arrivalIndex || !/交通/u.test(stop.category)) return false
    const start = firstClockTimeMinutes(stop.time)
    const originLegText = `${stop.name} ${stop.time} ${stop.notes}`
    const identifiesPreFlightLeg = /航班|飞机|乘机|起飞|值机|候机|登机|前往机场|去机场|出发机场/u.test(originLegText)
    const isArrivalTransfer = /进城|市区|接驳|机场线|落地后|抵达后/u.test(originLegText)
    const explicitOriginFlight = identifiesPreFlightLeg && !isArrivalTransfer
    return explicitOriginFlight || (departureMinutes !== undefined && start !== undefined && start <= departureMinutes)
  })
  const beforeArrivalIds = new Set(beforeArrivalStops.map((stop) => stop.id))
  const remainingStops = arrivalDay.stops.filter((stop) => stop.id !== arrivalStop.id && !beforeArrivalIds.has(stop.id))
  const nextRelativeStopIndex = remainingStops.findIndex((stop) => {
    const relativeLodging = /住宿/u.test(stop.category) && /(?:落地|接驳)后/u.test(stop.time)
    const relativeTransfer = /交通/u.test(stop.category) && stop.time === deferredArrivalTransferTime
    const deferredMeal = mealSlotForStop(stop) !== undefined && stop.time === deferredArrivalMealTime
    const startMinutes = firstClockTimeMinutes(stop.time)
    return relativeLodging || relativeTransfer || deferredMeal ||
      (startMinutes !== undefined && startMinutes >= arrivalMinutes)
  })
  const insertionIndex = nextRelativeStopIndex < 0 ? remainingStops.length : nextRelativeStopIndex
  remainingStops.splice(insertionIndex, 0, ...beforeArrivalStops, arrivalStop)
  arrivalDay.stops.splice(0, arrivalDay.stops.length, ...remainingStops)
}

/** 只从用户写明的航线读取抵达机场名称，不根据城市自行猜测机场。 */
function flightArrivalAirportFromBrief(
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief']
): string | undefined {
  const constraints = `${tripBrief?.constraints ?? ''}\n${tripBrief?.arrivalFlight ?? ''}`
  const departureTime = flightDepartureTimeFromBrief(tripBrief)
  const timeIndex = departureTime ? constraints.indexOf(departureTime) : -1
  if (timeIndex < 0 || !departureTime) return undefined
  const routeContext = constraints.slice(timeIndex + departureTime.length, timeIndex + departureTime.length + 80)
  const destination = routeContext.match(/(?:飞|到|至|→|->)\s*([\p{Script=Han}A-Za-z0-9·]{2,24}?)(?=机场|国际机场|[，,。；;\s\d]|$)/u)?.[1]?.trim()
    ?? routeContext.match(/(?:抵达|到达|落地)\s*([\p{Script=Han}A-Za-z0-9·]{2,24}?)(?=机场|国际机场|[，,。；;\s\d]|$)/u)?.[1]?.trim()
  if (!destination) return undefined
  return /机场/u.test(destination) ? destination : `${destination}机场`
}

/** 只从离站时刻附近的用户文字提取明确车站或机场名称，不猜测地点。 */
function departureStopNameFromBrief(
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief'],
  leaveTime: string
): string | undefined {
  const constraints = `${tripBrief?.leaveTime ?? ''}\n${tripBrief?.constraints ?? ''}`
  const timeIndex = constraints.indexOf(leaveTime)
  if (timeIndex < 0) return undefined
  const matches: Array<{ name: string; index: number }> = []
  const destinationPatterns = [
    /(?:前往|赶(?:到)?|到|至|从)\s*([\p{Script=Han}A-Za-z0-9·]{2,30}?(?:站|机场|码头))(?=$|[\s，,。；;、赶乘出发])/gu,
    /(?:\d{1,2}:\d{2})\s*([\p{Script=Han}A-Za-z0-9·]{2,30}?(?:站|机场|码头))/gu
  ]
  for (const pattern of destinationPatterns) {
    for (const match of constraints.matchAll(pattern)) {
      if (match.index === undefined) continue
      const name = match[1].trim().replace(/^(?:从|到|至|前往|抵达|落地)/u, '')
      if (name) matches.push({ name, index: match.index })
    }
  }
  return matches.sort((left, right) =>
    Math.abs(left.index - timeIndex) - Math.abs(right.index - timeIndex)
  )[0]?.name
}

/** 同时校验时间顺序和餐馆名称，让模型一次看到整份方案的问题。 */
function validateCandidateSchedule(
  days: ItineraryDay[],
  requireNamedMealStops: boolean,
  mealRequirements: ItineraryMealRequirement[],
  tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief'],
  repairNotes: string[],
  protectedDates: ReadonlySet<string>,
  excludedStops: ToolContext['excludedItineraryStops'] = []
): void {
  const issues: string[] = []
  const scheduleConflicts: string[] = []
  const placeholders: string[] = []
  const placeholderAttractions: string[] = []
  const activityCutoff = requestedEndDateActivityCutoff(tripBrief)
  for (const [dayIndex, day] of days.entries()) {
    // 受保护日期会原样继承旧稿；其既有问题留给整份草案的确认门处理。
    if (protectedDates.has(day.date)) continue
    for (const stop of day.stops) {
      if (isUnresolvedAttractionName(stop.name) && isVisitStop(stop) && isAttractionStop(stop)) {
        placeholderAttractions.push(`${day.date || `第 ${dayIndex + 1} 天`}: ${stop.name}`)
        stop.evidenceLevel = 'pending'
        stop.sourceIds = []
        stop.factClaims = []
        stop.notes = [stop.notes, '具体游览点待选；可在后续修改中指定或替换。']
          .filter(Boolean).join(' ').slice(0, 500)
      }
      if (requireNamedMealStops) {
        if (/餐/u.test(stop.category) && isPlaceholderRestaurantName(stop.name)) {
          placeholders.push(`${day.date || `第 ${dayIndex + 1} 天`}: ${stop.name}`)
        }
      }
    }

    let previous: { name: string; time: string; minutes: number } | undefined
    for (const stop of day.stops) {
      const match = stop.time.match(/(?:^|[^\d])(\d{1,2}):([0-5]\d)(?!\d)/u)
      if (!match) continue
      const minutes = Number(match[1]) * 60 + Number(match[2])
      if (previous && minutes < previous.minutes) {
        issues.push(`第 ${dayIndex + 1} 天停靠点顺序错误：“${stop.name}”（${stop.time}）开始时刻早于前一项“${previous.name}”（${previous.time}）；请按开始时刻升序重排 stops 数组，不要改动时段。`)
        break
      }
      previous = { name: stop.name, time: stop.time, minutes }
    }

    const anchors = tripBrief ?? { startDate: '', endDate: '', arrivalFlight: '', arrivalTime: '', leaveTime: '' }
    for (const finding of analyzeDaySchedule(day, anchors)) {
      if (finding.code === 'stop-overlap' || finding.code === 'schedule-overlap' || finding.code === 'route-buffer') {
        scheduleConflicts.push(`${day.date || `第 ${dayIndex + 1} 天`}：${finding.message}`)
      } else if (finding.code === 'before-arrival' || finding.code === 'after-departure') {
        issues.push(`${day.date || `第 ${dayIndex + 1} 天`}：${finding.message}`)
      }
    }
    if (activityCutoff && day.date === tripBrief?.endDate) {
      for (const stop of day.stops) {
        const meal = /餐|用餐|美食/u.test(`${stop.category} ${stop.name}`)
        if (!meal && !(isVisitStop(stop) && isAttractionStop(stop))) continue
        const end = proposedStopEndMinute(stop)
        if (end !== undefined && end > activityCutoff.minutes) {
          issues.push(`${day.date} 明确截止时刻 ${activityCutoff.time} 后仍安排了${meal ? '用餐' : '景点'}“${stop.name}”（${stop.time}）；请提前并在截止时刻前结束，或删除该项。`)
        }
      }
      for (const block of day.scheduleBlocks) {
        if (block.kind !== 'meal' && !/早餐|早饭|午餐|午饭|晚餐|晚饭|用餐|吃饭/u.test(`${block.title} ${block.notes}`)) continue
        const end = proposedTimeEndMinute(block.time, block.durationMinutes)
        if (end !== undefined && end > activityCutoff.minutes) {
          issues.push(`${day.date} 明确截止时刻 ${activityCutoff.time} 后仍安排了用餐时间块“${block.title}”（${block.time}）；请提前并在截止时刻前结束，或删除该项。`)
        }
      }
    }
  }
  for (const finding of analyzeMealRequirements(days, mealRequirements.filter((requirement) =>
    !protectedDates.has(requirement.date)
  ))) issues.push(finding.message)
  for (const requirement of tripBrief ? requiredDatedVisitsFromBrief(tripBrief, excludedStops) : []) {
    if (protectedDates.has(requirement.date)) continue
    const day = days.find((candidate) => candidate.date === requirement.date)
    const missing = requirement.names.filter((name) => !day?.stops.some((stop) => requiredVisitNameMatches(stop.name, name)))
    if (missing.length) issues.push(`${requirement.date} 缺少用户指定的游览点：${missing.join('、')}。`)
  }
  const expectedLeaveTime = departureClockLabel(tripBrief?.leaveTime ?? '')
  if (expectedLeaveTime) {
    const departureDay = days.find((day) => day.date === tripBrief?.endDate) ?? days.at(-1)
    if (departureDay && !protectedDates.has(departureDay.date)) {
      const departureStopExists = departureDay.stops.some((stop) =>
        /交通/u.test(stop.category) && /(?:站|机场|码头)/u.test(stop.name) && containsClockTime(stop.time, expectedLeaveTime)
      )
      if (!departureStopExists) {
        issues.push(`${departureDay.date} 缺少 ${expectedLeaveTime} 对应的车站、机场或码头交通停靠点。`)
      }
    }
  }
  const nextDayArrival = nextDayArrivalFromBrief(tripBrief?.constraints ?? '', tripBrief?.endDate)
  if (nextDayArrival) {
    const lastDay = days.find((day) => day.date === tripBrief?.endDate) ?? days.at(-1)
    if (lastDay && !protectedDates.has(lastDay.date)) {
      const lastDayText = lastDay.stops.map((stop) =>
        `${stop.name} ${stop.time} ${stop.notes} ${stop.transitToNext} ${(stop.factClaims ?? []).map((claim) => claim.value).join(' ')}`
      ).join('\n')
      if (!containsClockTime(lastDayText, nextDayArrival.time) || !lastDayText.includes(nextDayArrival.destination)) {
        issues.push(`${lastDay.date} 的交通停靠点需注明次日 ${nextDayArrival.time} 抵达 ${nextDayArrival.destination}。`)
      }
    }
  }
  const flightDepartureTime = flightDepartureTimeFromBrief(tripBrief)
  if (flightDepartureTime) {
    const arrivalDay = days.find((day) => day.date === tripBrief?.startDate) ?? days[0]
    if (arrivalDay && !protectedDates.has(arrivalDay.date)) {
      const departureTimePreserved = arrivalDay.stops.some((stop) =>
        /交通/u.test(stop.category) && containsClockTime(stop.time, flightDepartureTime)
      )
      if (!departureTimePreserved) {
        issues.push(`${arrivalDay.date} 缺少用户提供的航班起飞时刻 ${flightDepartureTime}；请在交通停靠点的 time 中与落地时间分开列出。`)
      }
    }
  }
  const airportDeadline = airportArrivalDeadlineFromBrief(tripBrief)
  if (airportDeadline) {
    const arrivalDay = days.find((day) => day.date === tripBrief?.startDate) ?? days[0]
    if (arrivalDay && !protectedDates.has(arrivalDay.date)) {
      const deadlineMinutes = firstClockTimeMinutes(airportDeadline.time)
      const airportArrivalExists = arrivalDay.stops.some((stop) =>
        /交通/u.test(stop.category) && /机场/u.test(stop.name) &&
        (stop.name.includes(airportDeadline.airport.replace(/机场$/u, '')) || airportDeadline.airport.includes(stop.name)) &&
        (containsClockTime(stop.time, airportDeadline.time) || (
          deadlineMinutes !== undefined &&
          (proposedStopEndMinute(stop) ?? Infinity) <= deadlineMinutes
        ))
      )
      if (!airportArrivalExists) {
        issues.push(`${arrivalDay.date} 缺少 ${airportDeadline.time} 前抵达${airportDeadline.airport}的交通停靠点。`)
      }
    }
  }
  if (placeholderAttractions.length) {
    repairNotes.push(`部分游览点尚未选定，具体地点待补：${placeholderAttractions.slice(0, 8).join('；')}${placeholderAttractions.length > 8 ? `；另有 ${placeholderAttractions.length - 8} 处待补` : ''}。`)
  }
  if (placeholders.length) {
    const visiblePlaceholders = placeholders.slice(0, 21)
    const remaining = placeholders.length - visiblePlaceholders.length
    const overflow = remaining > 0 ? `；另有 ${remaining} 处需替换` : ''
    repairNotes.push(`部分餐饮仍是类型或片区描述，具体店面待选：${visiblePlaceholders.join('；')}${overflow}。`)
  }
  if (scheduleConflicts.length > 0) {
    // 可计算的时间冲突作为建议返回；由模型决定是否修改候选。
    const visibleConflicts = scheduleConflicts.slice(0, 8)
    const remainingCount = scheduleConflicts.length - visibleConflicts.length
    const remaining = remainingCount > 0 ? `；另有 ${remainingCount} 处冲突也需修正` : ''
    issues.push(`发现 ${scheduleConflicts.length} 处日程时段或接驳冲突，建议修正：${visibleConflicts.join('；')}${remaining}`)
  }
  if (issues.length) throw new ToolInputError(issues.join('\n'))
}

/** 只把用户明确提及返程日期的“某时后不安排景点或用餐”设为硬校验。 */
function requestedEndDateActivityCutoff(tripBrief: TripBrief | undefined): { time: string; minutes: number } | undefined {
  const endDate = tripBrief?.endDate
  if (!endDate) return undefined
  const constraints = tripBrief?.constraints.normalize('NFKC') ?? ''
  const date = endDate.match(/^(\d{4})-(\d{2})-(\d{2})$/u)
  if (!date) return undefined
  const month = Number(date[2])
  const day = Number(date[3])
  const mentionsEndDate = [
    `${month}/${day}`, `${date[2]}/${day}`, `${month}/${date[3]}`, `${month}月${day}日`,
    `${date[2]}月${day}日`, endDate
  ].some((label) => constraints.includes(label))
  if (!mentionsEndDate) return undefined
  const match = constraints.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)\s*(?:后|以后|之后)\s*(?:不再|不安排|不得|不要)[^，,。；;\n]{0,32}(?:景点|游览|用餐|吃饭|餐)/u)
  if (!match) return undefined
  const time = `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`
  return { time, minutes: Number(match[1]) * 60 + Number(match[2]) }
}

/** 取候选停靠点明示时段与停留分钟数中较晚的结束时刻。 */
function proposedStopEndMinute(stop: ItineraryStop): number | undefined {
  return proposedTimeEndMinute(stop.time, stop.durationMinutes)
}

/** 保留跨模糊文字的首个时刻；只使用有效同日时间段或显式停留时长。 */
function proposedTimeEndMinute(time: string, durationMinutes: number | null): number | undefined {
  const start = firstClockTimeMinutes(time)
  if (start === undefined) return undefined
  const range = time.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)\s*[-–—~～至到]\s*([01]?\d|2[0-3]):([0-5]\d)(?!\d)/u)
  const rangeEnd = range ? Number(range[3]) * 60 + Number(range[4]) : start
  const durationEnd = durationMinutes !== null && durationMinutes > 0 ? start + durationMinutes : start
  return Math.max(rangeEnd > start ? rangeEnd : start, durationEnd)
}

/** 让跨抵离日的标题区分日历日期数与完整游览日数。 */
function normalizePlanTitle(title: string, days: ItineraryDay[], tripBrief: Parameters<TravelTool['execute']>[1]['tripBrief']): string {
  if (days.length !== 7 || !/(?:五|5)天(?:六|6)晚/u.test(tripBrief?.constraints ?? '') || !/(?:7|七)(?:个)?(?:天|日)(?:游|行程)?/u.test(title)) {
    return title
  }
  const description = title.replace(/^(?:北京)?\s*(?:7|七)(?:个)?(?:天|日)(?:(?:6|六)晚)?(?:游|行程)?[：:、-]?\s*/u, '').trim()
  return `五个完整游览日（含抵离日）：${description || title}`.slice(0, 100)
}

/** 修复空标题并截短过长标题，不因展示字段格式问题丢弃整套方案。 */
function normalizeOptionTitle(value: unknown, optionIndex: number, repairNotes: string[]): string {
  const original = typeof value === 'string' ? value.trim() : ''
  const truncatedTitle = truncateText(original, 100)
  let title = truncatedTitle
  if (!title) {
    repairNotes.push('缺失的方案标题已自动补齐。')
    return `行程方案 ${optionIndex + 1}`
  }
  const withoutUnverifiedPriceClaim = title.replace(/(?:免费|免票|免预约|无需预约|不需预约|不必预约)/gu, '')
    .replace(/([：:，,、＋+])\s*([：:，,、＋+])/gu, '$1')
    .replace(/^[：:，,、＋+\s]+|[：:，,、＋+\s]+$/gu, '')
  if (withoutUnverifiedPriceClaim !== title) {
    title = withoutUnverifiedPriceClaim || `行程方案 ${optionIndex + 1}`
    repairNotes.push('方案标题中的未核实免费或免预约说法已移除；票价和预约规则以事实栏为准。')
  }
  if (truncatedTitle !== original) repairNotes.push('过长的方案标题已截短。')
  return title
}

/** 标题不应声称包含尚未提供的预算/省时比较。 */
function normalizeTitleAgainstTradeoffs(title: string, tradeoffs: string, repairNotes: string[]): string {
  const pendingComparison = /尚未列出两种具体选择.{0,12}待补/u.test(tradeoffs)
  const claimsComparison = /(?:预算|省时(?:间)?).{0,16}(?:取舍|对比|比较|对照|vs)|(?:取舍|对比|比较|对照|vs).{0,16}(?:预算|省时(?:间)?)/iu.test(title)
  if (!pendingComparison || !claimsComparison) return title

  const normalized = title
    .replace(/[（(][^（）()]{0,60}(?:预算|省时|取舍|对比|比较)[^（）()]{0,60}[）)]/gu, '')
    .replace(/(?:含|包括|涵盖)?预算(?:友好)?[／/、和与及]?\s*省时(?:间)?(?:取舍|对比|比较)/gu, '')
    .replace(/([：:，,、＋+])\s*([：:，,、＋+])/gu, '$1')
    .replace(/[（(]\s*[）)]/gu, '')
    .replace(/^[：:，,、＋+\s]+|[：:，,、＋+\s]+$/gu, '')
    .trim()
  if (normalized && normalized !== title) {
    repairNotes.push('方案标题中未在正文落实的预算/省时比较说法已移除。')
    return normalized
  }
  return title
}

/** 将资料说明从行程时段剥离；混入开放信息或多个无关时刻时降为待核验。 */
function normalizeDisplayTime(value: unknown, repairNotes: string[]): string {
  if (typeof value !== 'string') {
    repairNotes.push('无法识别的地点时段已标为待安排；补齐前不能视为可执行时间。')
    return '待安排'
  }
  const original = value.trim().normalize('NFKC')
  const distinctTimes = [...new Set([...original.matchAll(/(?:^|[^\d])(\d{1,2}:[0-5]\d)(?!\d)/gu)].map((match) => match[1]))]
  const dayPeriod = original.match(/清晨|早晨|上午|中午|午后|下午|傍晚|晚上|夜间|深夜|全天/u)?.[0]
  const openingDetails = /开园|开门|开放|闭园|闭馆|开放时间|开放时段|停止入园|停止入馆|停止售票/u.test(original)

  // 搜索摘要常把营业时刻与预约说明一起塞进时间字段；这些内容不能作为游览时段。
  if (openingDetails || distinctTimes.length >= 3) {
    repairNotes.push('行程时段混入开放资料或多个未关联时刻，已降为待核验。')
    return dayPeriod ? `${dayPeriod}（具体时段待核验）` : '待安排'
  }
  if (original.length <= 40) return original
  const times = [...new Set([...original.matchAll(/(?:^|[^\d])(\d{1,2}:[0-5]\d)(?!\d)/gu)].map((match) => match[1]))].slice(0, 4)
  const anchors = times.join(' / ')
  const context = original.replace(/(?:^|[^\d])\d{1,2}:[0-5]\d(?!\d)/gu, ' ').replace(/\s+/gu, ' ')
    .replace(/^[，,：:；;、\-–—\s]+/u, '').trim()
  const available = anchors ? Math.max(0, 40 - anchors.length - (context ? 1 : 0)) : 40
  const shortened = anchors
    ? `${anchors}${context ? ` ${truncateText(context, available)}` : ''}`
    : truncateText(context, available)
  repairNotes.push('过长的建议时段已缩短，并保留明确时刻。')
  return shortened
}

/** 按 Unicode 字符截短展示文本，避免切断 emoji 等代理对。 */
function truncateText(value: string, maxLength: number): string {
  let result = Array.from(value).slice(0, maxLength).join('').trimEnd()
  while (result.length > maxLength) result = result.slice(0, -1).trimEnd()
  return result
}

/** 只拦截菜品描述、泛称和待定门店；具体店名可附带附近或周边位置说明。 */
export function isPlaceholderRestaurantName(name: string): boolean {
  const baseName = name.split(/[（(]/u, 1)[0]?.trim() ?? name.trim()
  const normalizedBaseName = baseName.replace(/^(?:早餐|午餐|晚餐)[：:]\s*/u, '')
  const areaMealPlaceholder = /(?:商圈|景区内|景区|酒店内|酒店周边|附近|周边|片区|区域).{0,20}(?:简餐|快餐|餐馆|餐厅|饭店|餐饮|食堂|小吃|早点|农家菜|家常菜|特色菜|老字号|商户|店面|店铺)/u
  const vagueAreaMealPlaceholder = /(?:附近|周边|一带|片区|区域|周围).{0,12}(?:就近|用餐|就餐|吃饭|餐饮|餐食|安排|待选|待定|待核验|找店)/u
  // 美食街、商场餐饮区是用餐片区，不代表已选定具体商户。
  const collectiveFoodAreaPlaceholder = /(?:食宝街|(?:美食|小吃|餐饮|食品)(?:街|城|广场)|(?:商场|购物中心)(?:内)?(?:美食区|餐饮区|美食层))/u.test(normalizedBaseName)
  // 自理、机场简餐等只说明用餐方式，不能作为已选餐馆。
  const noVenueMealPlaceholder = /(?:机场内简餐|景区简餐|自理|自行(?:解决)?|自备|自带)/u.test(normalizedBaseName)
  const villageCuisinePlaceholder = /村.{0,12}(?:农家菜|家常菜|特色菜|饭店|餐馆|餐厅|简餐|快餐)/u.test(normalizedBaseName)
  const genericRestaurantName = /^(?:(?:附近|周边|片区|本地)?(?:餐馆|餐厅|饭店|餐饮|美食|早点|小吃|简餐|快餐|食堂|早餐|午餐|晚餐|早中晚餐|用餐|就餐|店面|店铺|门店)(?:安排)?|(?:早餐|午餐|晚餐)店)$/u.test(normalizedBaseName) ||
    areaMealPlaceholder.test(normalizedBaseName) || vagueAreaMealPlaceholder.test(normalizedBaseName) ||
    collectiveFoodAreaPlaceholder || noVenueMealPlaceholder || villageCuisinePlaceholder
  const unverifiedBranch = /(?:分店|门店|店面|店铺).{0,20}(?:待|需|未核实|核验)|(?:具体门店|具体店面).{0,12}(?:待|需|未核实|核验)/u.test(name)
  const namedBrandWithUnverifiedBranch = unverifiedBranch && baseName.length >= 2 && !genericRestaurantName
  if (namedBrandWithUnverifiedBranch) return false
  return genericRestaurantName || /(?:具体店面|具体店铺|具体门店|(?:店名|店面|店铺|门店)(?:待|需)(?:选|选择|核验|核实|确认|确定)|(?:出发前|用地图).{0,8}(?:确定|确认|核实)|店面待|待(?:选|选择|确认|核实|核验|确定)|(?:早餐|午餐|晚餐)[·・/／].*(?:包子|豆腐脑|油条|面茶|早点)|(?:附近|周边|周围|片区)(?:的)?(?:餐馆|餐厅|饭店|店面|店铺|餐饮)|(?:餐馆|餐厅|饭店|店面|店铺|餐饮)(?:待|需|未核实|出发前))/u.test(name)
}

/** 片区修改若仍落在原店附近，就保留可辨识店名及原有来源状态。 */
function preserveExistingMealCandidatesForAreaRevision(
  request: string,
  previous: ItineraryOption | undefined,
  proposedDays: ItineraryDay[],
  unchangedDates: string[],
  destination: string
): void {
  if (!previous || !request.trim()) return
  const protectedDates = new Set(unchangedDates)
  const targetDays = previous.days.filter((day) => day.date && !protectedDates.has(day.date))
  if (!targetDays.length) return

  for (const baselineDay of targetDays) {
    const candidateDay = proposedDays.find((day) => day.date === baselineDay.date)
    if (!candidateDay) continue
    for (const slot of ['breakfast', 'lunch', 'dinner'] as const) {
      const requestClause = mealAreaRevisionClause(request, baselineDay.date, slot, targetDays.length === 1)
      if (!requestClause || explicitlyReplacesMealVenue(requestClause)) continue

      const baselineMeals = baselineDay.stops.filter((stop) => /餐/u.test(stop.category) && mealSlotForStop(stop) === slot)
      const candidateMeals = candidateDay.stops.filter((stop) => /餐/u.test(stop.category) && mealSlotForStop(stop) === slot)
      if (baselineMeals.length !== 1 || candidateMeals.length !== 1) continue

      const baselineStop = baselineMeals[0]!
      const candidateStop = candidateMeals[0]!
      if (isPlaceholderRestaurantName(baselineStop.name) || !isPlaceholderRestaurantName(candidateStop.name) ||
        !mealAreaMatchesRequest(baselineStop, candidateStop, requestClause, destination)) continue

      // 同一片区的既有门店仍是有效候选；恢复名称、身份和来源，不把待核验升级为已核实。
      const restored = structuredClone(baselineStop)
      if (/(?:时段|时间|时刻|提前|延后|缩短|延长|\b\d{1,2}:\d{2}\b)/u.test(requestClause)) {
        restored.time = candidateStop.time
        restored.durationMinutes = candidateStop.durationMinutes
      }
      if (!restored.area) restored.area = candidateStop.area
      candidateDay.stops = candidateDay.stops.map((stop) => stop.id === candidateStop.id ? restored : stop)
    }
  }
}

/** 将修改指令精确关联到日期和餐次，单日上下文才允许省略日期。 */
function mealAreaRevisionClause(request: string, date: string, slot: 'breakfast' | 'lunch' | 'dinner', singleTargetDay: boolean): string | undefined {
  const [year, month, day] = date.split('-').map(Number)
  if (!year || !month || !day) return undefined
  const datePattern = new RegExp(`(?<!\\d)(?:${year}\\s*(?:年|[-/.])\\s*)?0?${month}\\s*(?:月|[-/.])\\s*0?${day}\\s*(?:日|号)?(?!\\d)`, 'u')
  const mealPattern = slot === 'breakfast' ? /早餐|早饭/u : slot === 'lunch' ? /午餐|午饭/u : /晚餐|晚饭/u
  return request.split(/[。！？!?；;\n]+/u).find((clause) => mealPattern.test(clause) &&
    (datePattern.test(clause) || singleTargetDay))
}

/** 只跳过明确要求另换、删除或拒绝原门店的指令。 */
function explicitlyReplacesMealVenue(clause: string): boolean {
  return /换一家|换个(?:店|餐馆|餐厅|饭店)|(?:改|换)成(?:另一家|别家|别的|其他)|另(?:找|选).{0,8}(?:店|餐馆|餐厅|饭店)|重新(?:挑|选|找).{0,8}(?:店|餐馆|餐厅|饭店)|(?:不要|不保留|删除|移除|取消).{0,8}(?:原店|原餐馆|原餐厅|原饭店|已有店|现有店)/u.test(clause)
}

/** 只有旧店、候选片区和用户目标共享具体地名时才保留，避免错留跨区餐馆。 */
function mealAreaMatchesRequest(previous: ItineraryStop, candidate: ItineraryStop, request: string, destination: string): boolean {
  const normalizeArea = (value: string): string => {
    let result = normalizeRestaurantSearchText(value)
    const destinationParts = destination.split(/[，,、/|]+/u).map(normalizeRestaurantSearchText).filter((part) => part.length >= 2)
    for (const part of destinationParts) result = result.replaceAll(part, '')
    return result.replace(/中国|市辖区|自治区|特别行政区|街道|大街|大道|道路|片区|区域|地区|附近|周边|周围|一带|商圈|景区|酒店|市|省|区|县|镇|乡|村/gu, '')
  }
  const genericTerms = ['附近', '周边', '周围', '片区', '区域', '地区', '一带', '商圈', '就近', '安排', '餐馆', '餐厅', '饭店', '餐饮', '早餐', '午餐', '晚餐', '店面', '店铺', '门店', '具体', '待选', '待定', '核验']
  const previousText = normalizeArea(`${previous.area} ${previous.name}`)
  const candidateText = normalizeArea(candidate.area || candidate.name)
  const requestText = normalizeArea(request)
  const characters = [...candidateText]
  for (let length = Math.min(8, characters.length); length >= 2; length -= 1) {
    for (let start = 0; start <= characters.length - length; start += 1) {
      const term = characters.slice(start, start + length).join('')
      if (genericTerms.some((generic) => term.includes(generic))) continue
      if (previousText.includes(term) && requestText.includes(term)) return true
    }
  }
  return false
}

/** 统一餐馆片区比较文本，忽略空白、标点和大小写。 */
function normalizeRestaurantSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 按可识别时刻排序，未知时刻保留原位，并使交通说明跟随新顺序。 */
function sortStopsByExplicitTime(stops: ItineraryStop[], lodgingLocation: string, repairNotes: string[]): void {
  if (stops.length < 2) return
  const timedStops = stops.flatMap((stop, index) => {
    const minutes = firstClockTimeMinutes(stop.time)
    return minutes === undefined ? [] : [{ stop, index, minutes }]
  })
  if (timedStops.length < 2) return
  const sorted = [...timedStops].sort((left, right) => left.minutes - right.minutes || left.index - right.index)
  if (sorted.every((item, index) => item.index === timedStops[index]?.index)) return

  const reorderedStops = [...stops]
  timedStops.forEach((item, index) => {
    reorderedStops[item.index] = sorted[index]!.stop
  })
  for (let index = 0; index < reorderedStops.length; index += 1) {
    const stop = reorderedStops[index]
    const nextStop = reorderedStops[index + 1]
    const transitMatchesNext = nextStop && stop.transitToNext.includes(nextStop.name)
    const transitMatchesLodging = !nextStop && lodgingLocation && stop.transitToNext.includes(lodgingLocation)
    if (nextStop && !transitMatchesNext) {
      const mode = stop.transitToNext.match(/地铁|轨道交通|公交|步行|骑行|出租车|网约车|驾车|公共交通/u)?.[0] ?? '公共交通'
      stop.transitToNext = `${mode}前往${nextStop.name}，线路和耗时待核验。`
      stop.factClaims = (stop.factClaims ?? []).filter((claim) => claim.type !== 'transport-time')
    } else if (!nextStop && stop.transitToNext.trim() && !transitMatchesLodging && !/返回(?:酒店|住宿|住处)|回(?:酒店|住宿|住处)/u.test(stop.transitToNext)) {
      stop.transitToNext = ''
      stop.factClaims = (stop.factClaims ?? []).filter((claim) => claim.type !== 'transport-time')
    }
  }
  stops.splice(0, stops.length, ...reorderedStops)
  repairNotes.push('已按可识别时刻重排停靠点；未标时刻的项目保留原位，交通衔接需按新顺序复核。')
}

/** 提取地点时段中的首个 24 小时时刻。 */
function firstClockTimeMinutes(value: string): number | undefined {
  const match = value.normalize('NFKC').match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/u)
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined
}

/** 将抵离说明中的明确时刻规范成 HH:mm，供确定性锚点补齐复用。 */
function firstClockText(value: string): string | undefined {
  const match = value.normalize('NFKC').match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/u)
  if (!match) return undefined
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`
}

/** 按停靠结束时刻校验下一段路线的公交出发时刻。 */
function plannedRouteDepartureTime(stop: ItineraryStop): string | undefined {
  const normalizedTime = stop.time.normalize('NFKC')
  const explicitRange = normalizedTime.match(
    /(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)\s*(?:-|–|—|~|至|到)\s*([01]?\d|2[0-3]):([0-5]\d)(?!\d)/u
  )
  if (explicitRange) {
    return `${String(Number(explicitRange[3])).padStart(2, '0')}:${explicitRange[4]}`
  }

  const startMinutes = firstClockTimeMinutes(stop.time)
  if (startMinutes === undefined) return undefined
  const duration = stop.durationMinutes
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 0 || duration > 1_440) {
    return firstClockText(stop.time)
  }
  return formatPlanningTime((startMinutes + duration) % 1_440)
}

/** 将规划窗口的分钟数格式化为本地时钟，不代表实时服务时间。 */
function formatPlanningTime(value: number): string {
  const minutes = Math.max(0, Math.min(1_439, Math.round(value)))
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** 从时段末尾读取明确结束时刻，供机场接驳后的酒店顺序使用。 */
function lastClockTime(value: string): string | undefined {
  const matches = [...value.matchAll(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu)]
  const match = matches.at(-1)
  return match ? `${String(Number(match[1])).padStart(2, '0')}:${match[2]}` : undefined
}

/** 按整点边界匹配旅行简报中的离开时间，避免 20:23 误匹配 20:230。 */
function containsClockTime(value: string, expected: string): boolean {
  const [, hour, minute] = expected.match(/^([01]\d|2[0-3]):([0-5]\d)$/u) ?? []
  return !!hour && !!minute && new RegExp(`(?:^|[^0-9])${hour}:${minute}(?![0-9])`).test(value)
}

/** 只从明确“从某地飞/航班起飞”的文字读取航班出发时刻，不误取机场集合时间。 */
function flightDepartureTimeFromBrief(tripBrief: TripBrief | undefined): string | undefined {
  const constraints = tripBrief?.constraints ?? ''
  const flightDetails = tripBrief?.arrivalFlight ?? ''
  const explicit = constraints.match(/(?:起飞时间|航班起飞时间|飞机起飞时间)\s*(?:为|是|：|:|于|在)?\s*([01]?\d|2[0-3]):([0-5]\d)/u)
  const route = constraints.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)\s*从[^，,。；;\n]{1,36}?(?:飞|起飞|乘机)/u)
  const labeledFlight = flightDetails.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?=[^，,。；;\n]{0,45}(?:起飞|从.{1,18}(?:飞|起飞)|飞往|飞至|乘机))/u)
  const airportRoute = /(?:白云|大兴|机场)/u.test(flightDetails)
    ? flightDetails.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?=[^，,。；;\n]{0,45}(?:→|->|到|至)[^，,。；;\n]{2,30})/u)
    : null
  const match = explicit ?? route ?? labeledFlight ?? airportRoute
  if (!match) return undefined
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`
}

/** 从用户确认的旅行约束里读取返程后明确写出的次日抵达时间和地点。 */
function nextDayArrivalFromBrief(constraints: string, departureDate = ''): { time: string; destination: string } | undefined {
  const marker = /(?:次日|第二天|翌日)/u.exec(constraints)
  let afterMarker = ''
  if (marker?.index !== undefined) {
    afterMarker = constraints.slice(marker.index + marker[0].length).split(/[，,。；;\n]/u, 1)[0] ?? ''
  } else {
    const nextDate = nextCalendarDate(departureDate)
    if (!nextDate) return undefined
    const monthDay = new RegExp(`(?:${nextDate.year}年)?${nextDate.month}月${nextDate.day}日`, 'u')
    const explicitDate = monthDay.exec(constraints)
    if (!explicitDate || explicitDate.index === undefined) return undefined
    afterMarker = constraints.slice(explicitDate.index + explicitDate[0].length).split(/[，,。；;\n]/u, 1)[0] ?? ''
  }
  const timeMatch = /(\d{1,2}:[0-5]\d)/u.exec(afterMarker)
  if (!timeMatch || timeMatch.index === undefined) return undefined
  const destinationAfterTime = afterMarker.slice(timeMatch.index + timeMatch[0].length)
    .match(/^\s*(?:(?:到达|到|抵达)\s*)?([\p{Script=Han}A-Za-z0-9·]{2,24})/u)?.[1]
  const beforeMarker = marker?.index === undefined ? ''
    : constraints.slice(Math.max(0, marker.index - 40), marker.index).replace(/[\s，,。；;]+$/u, '')
  const destinationBeforeMarker = beforeMarker.match(/(?:到达|到|抵达)\s*([\p{Script=Han}A-Za-z0-9·]{2,24})\s*$/u)?.[1]
  const destination = destinationAfterTime ?? destinationBeforeMarker
  if (!destination) return undefined
  const [hour, minute] = timeMatch[1].split(':')
  return { time: `${hour.padStart(2, '0')}:${minute}`, destination }
}

/** 按行程末日计算次日日期，统一用 UTC 避免本地时区和夏令时影响。 */
function nextCalendarDate(value: string): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  if (!match) return undefined
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

/** 将餐饮停靠点映射到早餐、午餐、晚餐，验证用户明确列出的逐日餐次。 */
export function mealSlotForStop(stop: ItineraryStop): 'breakfast' | 'lunch' | 'dinner' | undefined {
  const label = `${stop.name} ${stop.category} ${stop.time} ${stop.notes}`
  if (/早餐|早饭|早间|早晨|早上/u.test(label)) return 'breakfast'
  if (/午餐|午饭|中午/u.test(label)) return 'lunch'
  if (/晚餐|晚饭|傍晚|晚间|晚上/u.test(label)) return 'dinner'
  const match = stop.time.match(/(?:^|[^\d])(\d{1,2}):([0-5]\d)(?!\d)/u)
  if (!match) return undefined
  const hour = Number(match[1])
  return hour < 11 ? 'breakfast' : hour < 16 ? 'lunch' : 'dinner'
}

/** 将明确标注早餐、午餐或晚餐的时间块映射为餐次。 */
export function mealSlotForBlock(block: ItineraryScheduleBlock): 'breakfast' | 'lunch' | 'dinner' | undefined {
  const text = `${block.title} ${block.time} ${block.notes}`
  if (/早餐|早饭/u.test(text)) return 'breakfast'
  if (/午餐|午饭/u.test(text)) return 'lunch'
  if (/晚餐|晚饭/u.test(text)) return 'dinner'
  // meal 块本身已说明这是用餐；标题只写“用餐”时按时刻归入餐次。
  const match = block.time.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/u)
  if (!match) return undefined
  const hour = Number(match[1])
  return hour < 11 ? 'breakfast' : hour < 16 ? 'lunch' : 'dinner'
}

/** 餐馆地点已标明同一餐次和开始时刻时，删除重复的时间块。 */
function isRedundantMealBlock(block: ItineraryScheduleBlock, stops: ItineraryStop[]): boolean {
  if (block.kind !== 'meal') return false
  const blockSlot = mealSlotForBlock(block)
  if (!blockSlot) return false
  return stops.some((stop) => /餐/u.test(stop.category) && mealSlotForStop(stop) === blockSlot)
}

/** 交通数字必须绑定端点一致的路线来源；缺证据时只降级数字，不拒绝整份草案。 */
function sanitizeTransitMetricEvidence(stops: ItineraryStop[], sources: SourceRecord[], lodgingLocation: string): void {
  stops.forEach((stop, index) => {
    const transportInNotes = /地铁|公交|步行|公共交通|高铁|火车|动车|乘车|接驳|换乘|线路|往返|单程|车程|运行时间|通勤/u.test(stop.notes)
    const transitMetrics = transitMetricsIn(stop.transitToNext)
    const noteMetrics = transportInNotes ? transitMetricsIn(stop.notes) : emptyTransitMetrics()
    if (!hasTransitMetrics(transitMetrics) && !hasTransitMetrics(noteMetrics)) return
    const destination = stops[index + 1]?.name || lodgingLocation
    const citedRouteSources = sources.filter((source) =>
      (stop.sourceIds ?? []).includes(source.id) || (stop.factClaims ?? []).some((claim) => claim.sourceId === source.id)
    ).filter((source) => !!destination && source.kind === 'route' && source.status === 'success' &&
      (index + 1 < stops.length
        ? routeTitleMatchesStops(source.title, stop, stops[index + 1]!)
        : routeTitleMatchesOrderedEndpoints(source.title, stop.name, destination)))
    const durationSupported = !!destination && (stop.factClaims ?? []).some((claim) => {
      if (claim.type !== 'transport-time' || claim.evidenceLevel !== 'sourced' || !claim.sourceId) return false
      const source = citedRouteSources.find((candidate) => candidate.id === claim.sourceId)
      if (!source || source.kind !== 'route' || source.status !== 'success' ||
        !routeTitleMatchesOrderedEndpoints(source.title, stop.name, destination)) return false
      const claimDurations = transitDurationMinutes(claim.value)
      const routeDurations = source.summary.split(/\r?\n/u)
        .filter((line) => /^方案\s+\d+：/u.test(line))
        .flatMap(transitDurationMinutes)
      const allDurations = [...transitMetrics.durations, ...noteMetrics.durations]
      return allDurations.every((duration) => claimDurations.includes(duration) && routeDurations.includes(duration))
    })
    const supportsMetric = (metric: Omit<TransitMetric, 'type'>): boolean => citedRouteSources.some((source) => {
      const optionNumbers = [...source.summary.matchAll(/^方案\s+(\d+)：/gmu)]
        .map((match) => Number(match[1]))
      return optionNumbers.some((optionNumber) => routeSummarySupportsMetrics(
        source.summary,
        optionNumber,
        metric.distanceMeters,
        undefined,
        metric.fareFen,
        metric.tollFen
      ))
    })
    if (transitMetrics.durations.length > 0 && !durationSupported) {
      stop.transitToNext = replaceTransitDurationsWithPending(stop.transitToNext)
    }
    if (noteMetrics.durations.length > 0 && !durationSupported) {
      stop.notes = replaceTransitDurationsWithPending(stop.notes).slice(0, 500)
    }
    if (transitMetrics.distances.some((distanceMeters) => !supportsMetric({ distanceMeters }))) {
      stop.transitToNext = replaceTransitDistancesWithPending(stop.transitToNext)
    }
    if (noteMetrics.distances.some((distanceMeters) => !supportsMetric({ distanceMeters }))) {
      stop.notes = replaceTransitDistancesWithPending(stop.notes).slice(0, 500)
    }
    if (transitMetrics.fares.some((fareFen) => !supportsMetric({ fareFen }))) {
      stop.transitToNext = replaceTransitAmountsWithPending(stop.transitToNext)
    }
    if (noteMetrics.fares.some((fareFen) => !supportsMetric({ fareFen }))) {
      stop.notes = replaceTransitAmountsWithPending(stop.notes).slice(0, 500)
    }
    if (transitMetrics.tolls.some((tollFen) => !supportsMetric({ tollFen }))) {
      stop.transitToNext = replaceTransitAmountsWithPending(stop.transitToNext)
    }
    if (noteMetrics.tolls.some((tollFen) => !supportsMetric({ tollFen }))) {
      stop.notes = replaceTransitAmountsWithPending(stop.notes).slice(0, 500)
    }
    if (!durationSupported) {
      stop.factClaims = (stop.factClaims ?? []).filter((claim) => claim.type !== 'transport-time')
    }
  })
}

/** 无端点一致的成功路线时，移除具体线路号和伪造的路线服务归属。 */
function sanitizeUnboundTransitDetails(stops: ItineraryStop[], repairNotes: string[]): void {
  stops.forEach((stop, index) => {
    const nextStop = stops[index + 1]
    if (!nextStop || stop.transitEstimate?.destinationStopId === nextStop.id) return
    if (!/(?:地铁|轨道交通)\s*[\dA-Z一二三四五六七八九十百]+\s*号线|公交(?:车)?\s*[\dA-Z一二三四五六七八九十百]+\s*(?:路|线)|(?:高德|百度)(?:地图)?(?:路线|地图)?(?:估算|规划)|待核验(?:\s*[,，;；、/]\s*待核验)+/iu.test(stop.transitToNext)) return

    const mode = routeModeFromDescription(stop.transitToNext)
    const label = mode === 'walking' ? '步行' : mode === 'driving' ? '驾车' : '公共交通'
    stop.transitToNext = `${label}前往“${nextStop.name}”；具体线路和耗时待核验。`
    stop.factClaims = (stop.factClaims ?? []).filter((claim) => claim.type !== 'transport-time')
    repairNotes.push('未绑定到相邻端点的路线细节已移除；交通方式可保留，线路与耗时待核验。')
  })
}

/** 动态事实缺少直接来源时，将备注中的断言降为待核验并同步结构化事实。 */
function sanitizeUnverifiedStopNotes(stops: ItineraryStop[], date: string, repairNotes: string[]): void {
  for (const stop of stops) {
    const openingClaim = (stop.factClaims ?? []).find((claim) => claim.type === 'opening-hours' || claim.type === 'closure')
    const action = '(?:停止(?:检票|售票|入园|入场|入馆|入内|登城)|闭园|闭馆|闭城|闭门|开园|开放|营业|开门|关门|入园|入场|入馆|入内|延长(?:开放|营业)?(?:至|到)|(?:开放|营业)(?:至|到)|亮灯|开灯|关灯|灯饰)'
    const clock = '(?:[01]?\\d|2[0-3]):[0-5]\\d'
    const clockRange = `${clock}(?:\\s*(?:[-–—至到])\\s*${clock})?`
    const before = new RegExp(`(${clockRange})\\s*(${action})`, 'gu')
    const after = new RegExp(`(${action})(?:时间(?:为|是|约)?\\s*)?(${clockRange})`, 'gu')
    const openingTimePattern = new RegExp(`${clockRange}\\s*${action}|${action}(?:时间(?:为|是|约)?\\s*)?${clockRange}`, 'gu')
    const openingTimes = [...stop.notes.matchAll(openingTimePattern)]
      .flatMap((match) => match[0].match(new RegExp(clock, 'gu')) ?? [])
    const sourcedOpeningTimes = openingClaim?.evidenceLevel === 'sourced'
      ? [...openingClaim.value.matchAll(new RegExp(clock, 'gu'))].map((match) => match[0])
      : []
    const unsupportedOpeningTime = openingTimes.some((time) => !sourcedOpeningTimes.includes(time))
    if (openingTimes.length && unsupportedOpeningTime) {
      stop.notes = stop.notes.replace(before, '$2时间待核验').replace(after, '$1时间待核验')
        .replace(/(?:可|预计|建议)?(?:延长(?:开放|营业)?(?:至|到)|(?:开放|营业)(?:至|到))时间待核验/gu, '开放时段待核验')
        .replace(/(?:亮灯|开灯|关灯|灯饰)参考?(?:时间)?(?:约|大约)?/gu, '景观照明时间待核验 ')
        .slice(0, 500)
      if (!openingClaim) appendPendingFactClaim(stop, 'opening-hours', date)
      repairNotes.push('开放时间缺少匹配的直接来源，备注中的具体开闭园时刻已改为待核验。')
    }
    if (openingClaim?.evidenceLevel !== 'sourced') {
      const sanitizedOpeningStatus = sanitizeUnverifiedOpeningStatus(stop.notes)
      if (sanitizedOpeningStatus !== stop.notes) {
        stop.notes = sanitizedOpeningStatus
        if (!openingClaim) appendPendingFactClaim(stop, 'opening-hours', date)
        repairNotes.push('开放或闭馆状态缺少直接来源，备注中的确定性说法已改为待核验。')
      }
    }
    const lightingClaim = (stop.factClaims ?? []).find((claim) => claim.type === 'opening-hours')
    const lightingSchedule = /(?:亮灯|开灯|关灯|灯饰)[^，,；;。！？\n]{0,12}(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*(?:-|–|—|至|到)\s*(?:[01]?\d|2[0-3]):[0-5]\d)?/u
    if (lightingSchedule.test(stop.notes) && lightingClaim?.evidenceLevel !== 'sourced') {
      stop.notes = stop.notes.replace(lightingSchedule, '景观照明时间待核验').slice(0, 500)
      if (!lightingClaim) appendPendingFactClaim(stop, 'opening-hours', date)
      repairNotes.push('景观照明时刻缺少直接来源，已改为待核验。')
    }

    const ticketPriceClaim = (stop.factClaims ?? []).find((claim) => claim.type === 'ticket-price')
    if (ticketPriceClaim?.evidenceLevel !== 'sourced') {
      const hasUnverifiedCrowdClaim = /(?:游客较少|游客更少|人流较少|人流量低|人少|清静|清净)/u.test(stop.notes)
      const sanitized = removeUnverifiedFeeNoteClauses(stop.notes)
      if (sanitized !== stop.notes) {
        stop.notes = [sanitized, ...(hasUnverifiedCrowdClaim ? ['客流待核验'] : [])].filter(Boolean).join('；')
        if (!ticketPriceClaim) appendPendingFactClaim(stop, 'ticket-price', date)
        repairNotes.push('票价或费用缺少直接来源，备注中的相关句子已移除并保留结构化待核验状态。')
      }
    }

    const bookingClaim = (stop.factClaims ?? []).find((claim) => claim.type === 'booking')
    const bookingNeedsVerification = bookingClaim?.evidenceLevel !== 'sourced'
    if (bookingNeedsVerification) {
      const before = stop.notes
      stop.notes = sanitizeUnverifiedBookingCapacity(stop.notes)
      stop.notes = stop.notes
        .replace(/(?:入园|入场)?时段以(?:实际)?预约为准/gu, '入园时段待核验')
        .replace(/(?:务必|建议|请)?(?:提前)?(?:在[^，,。；;：:]{0,16})?(?:抢票|抢约|抢购)/gu, '预约方式待核验')
        .replace(/(?:票紧张|一票难求|名额.{0,4}(?:有限|紧张)|限流)/gu, '预约与客流待核验')
        .replace(/(?:同样|也)?(?:需要|须|需|必须|建议|务必|请|无需|不需要|免)?(?:提前)?预约(?:购票|入园|入场|时段)?(?![^，,；;。！？：:]{0,10}待核验)/gu, '预约规则待核验')
        .slice(0, 500)
      if (stop.notes !== before) {
        if (!bookingClaim) appendPendingFactClaim(stop, 'booking', date)
        repairNotes.push('预约或购票规则缺少直接来源，备注中的具体说法已改为待核验。')
      }
    }

    const sunsetClaim = (stop.factClaims ?? []).find((claim) => claim.type === 'sunset')
    const sunsetPattern = /(?:\d{1,2}月(?:上旬|中旬|下旬)?\s*)?(?:约|大约)?\s*(?:(?:日出|日落|太阳升起|太阳落山|蓝调时段|黄金时段)[^，,；;。！？\n]{0,24}(?:(?:约|大约|在)?\s*(?:[01]?\d|2[0-3]):[0-5]\d|时间|时刻)|(?:[01]?\d|2[0-3]):[0-5]\d\s*(?:后)?(?:日出|日落|入夜|天黑))/u
    if (sunsetPattern.test(stop.notes) && sunsetClaim?.evidenceLevel !== 'sourced') {
      stop.notes = stop.notes.replace(sunsetPattern, '日出日落时间待核验').slice(0, 500)
        .replace(/(?:\d{1,2}月(?:上旬|中旬|下旬)?\s*)?(?:约|大约)?\s*日出日落时间待核验/gu, '日出日落时间待核验')
        .replace(/\s*[（(](?:气象|天气)来源[）)]/gu, '')
      if (!sunsetClaim) appendPendingFactClaim(stop, 'sunset', date)
      repairNotes.push('日出日落时间缺少直接来源，已移入结构化待核验事实。')
    }

    const photographyClaim = (stop.factClaims ?? []).find((claim) => claim.type === 'photography-rules')
    const photographyRulePattern = /(?:拍摄|摄影|录像|航拍)[^，,；;。！？\n]{0,18}(?:禁止|不允许|允许|不得|须|必须|可使用|规则|限制|闪光灯|三脚架|无人机)|(?:禁止|不允许|允许|不得|须|必须)[^，,；;。！？\n]{0,18}(?:拍摄|摄影|录像|航拍|闪光灯|三脚架|无人机)/u
    if (photographyRulePattern.test(stop.notes) && photographyClaim?.evidenceLevel !== 'sourced') {
      stop.notes = stop.notes.replace(photographyRulePattern, '拍摄规定待核验').slice(0, 500)
      if (!photographyClaim) appendPendingFactClaim(stop, 'photography-rules', date)
      repairNotes.push('拍摄规定缺少直接来源，备注中的限制已改为待核验。')
    }

    const crowdNote = stop.notes.replace(/(?:游客较少|游客更少|人流较少|人流量低|人少|清静|清净)/gu, '客流待核验')
    if (crowdNote !== stop.notes) {
      stop.notes = crowdNote.slice(0, 500)
      repairNotes.push('客流情况缺少当日依据，备注中的确定性描述已改为待核验。')
    }
  }
}

/** 开放或闭馆的确定说法也需要直接证据，不能只校验具体钟点。 */
function sanitizeUnverifiedOpeningStatus(value: string): string {
  const status = /(?:(?:每周|周[一二三四五六日天])[^，,；;。！？\n]{0,12})?(?:正常开放|照常开放|全天开放|正常营业|常规开放|常规营业|开放|营业|闭园|闭馆|休馆|不开放|闭馆日)/gu
  const pending = /待核验|待确认|未查询|未核实|未知|暂无(?:可靠)?来源|需复核/u
  const parts = value.split(/([，,；;。])/u)
  let changed = false
  for (let index = 0; index < parts.length; index += 2) {
    let clause = parts[index] ?? ''
    const matches = [...clause.matchAll(status)]
    for (const match of matches.reverse()) {
      const matchIndex = match.index ?? -1
      const nearbyClaim = clause.slice(matchIndex, matchIndex + match[0].length + 10)
      if (matchIndex < 0 || pending.test(nearbyClaim)) continue
      clause = `${clause.slice(0, matchIndex)}开放与闭馆规则待核验${clause.slice(matchIndex + match[0].length)}`
      changed = true
    }
    parts[index] = clause
  }
  return changed ? parts.join('').slice(0, 500) : value
}

/** 预约、客流承载量缺少直接来源时，移除备注中的精确人数。 */
function sanitizeUnverifiedBookingCapacity(value: string): string {
  const capacity = /(?:(?:每日|每天|日均|单日|最大|最多|限流|容量|接待量|预约人数|可预约|预约上限|预约名额|名额)[^，,；;。！？\n]{0,20}\d[\d,]*(?:\.\d+)?\s*(?:万人|人|个名额)|\d[\d,]*(?:\.\d+)?\s*(?:万人|人|个名额)[^，,；;。！？\n]{0,20}(?:限流|容量|接待量|预约人数|可预约|预约上限|预约名额|名额))/gu
  return value.replace(capacity, '预约与客流待核验').slice(0, 500)
}

/** 缺少直接票价来源时，保留行程取舍并移除金额、免费状态和价格比较。 */
function sanitizeUnsupportedTicketPriceNotes(value: string): string {
  let changed = false
  let notes = value.replace(/((?:门票|票价|全票|成人票|学生票)\s*)?(?:约|大约)?(?:[¥￥]\s*)?\d+(?:\.\d{1,2})?\s*元(?:\/[^，,；;。！？：:]*)?/gu,
    (_amount, ticketLabel: string | undefined, offset: number) => {
      changed = true
      const context = value.slice(Math.max(0, offset - 12), offset)
      return ticketLabel || /门票|票价|全票|成人票|学生票|登楼/u.test(context)
        ? '门票价格待核验'
        : /租车|骑行|自行车/u.test(context) ? '出行费用待核验' : '费用待核验'
    })
  notes = notes.replace(/[¥￥]\s*\d+(?:\.\d{1,2})?/gu, () => {
    changed = true
    return '费用待核验'
  })
  notes = notes.replace(/(?:免费开放|免门票|免票|免费|不收费)/gu, () => {
    changed = true
    return '费用状态待核验'
  })
  notes = notes.replace(/(?:为|是)?(?:本行程|本次行程)?(?:票价|价格|费用)(?:最高|最低|最贵|最便宜|较高|较低)(?:一项|的一项)?/gu, () => {
    changed = true
    return ''
  })
  notes = notes.replace(/([，,；;：:])\s*([，,；;：:])/gu, '$1').replace(/\s+/gu, ' ').trim()
  return changed ? notes.slice(0, 500) : value
}

/** 移除缺少来源的费用句，避免把结构化待核验状态拼进自由文本后留下残句。 */
function removeUnverifiedFeeNoteClauses(value: string): string {
  const clauses = value.split(/[，,；;。！？\n]+/u).map((clause) => clause.trim()).filter(Boolean)
  const unverifiedFeeClaim = /(?:免费|免门票|免票|不收费|零成本|无门票成本|(?:无|零|0)(?:门票|票价|费用|成本)|[¥￥]\s*\d|\d+(?:\.\d{1,2})?\s*元|(?:门票|票价|价格|费用)[^，,；;。！？]{0,40}(?:待核验|待确认|未知|暂无来源|未.{0,8}查到)|(?:票价|价格)(?:最高|最低|最贵|最便宜|较高|较低))/u
  const remaining = clauses.filter((clause) => !unverifiedFeeClaim.test(clause))
  const ending = value.match(/[。！？]$/u)?.[0] ?? ''
  return `${remaining.join('；')}${ending}`.slice(0, 500)
}

/** 备注暴露未核实动态事实时补入结构化 pending 项，方便来源面板统一展示。 */
function appendPendingFactClaim(stop: ItineraryStop, type: ItineraryFactClaim['type'], scope: string): void {
  const claims = stop.factClaims ?? (stop.factClaims = [])
  if (claims.length >= 8) return
  claims.push({ id: randomUUID(), type, value: pendingFactValue(type), scope, evidenceLevel: 'pending' })
}

/** 仅给待核验事实关联唯一的同地点正文来源，不据此提升证据状态。 */
function linkUniquePendingFactSources(
  days: ItineraryDay[],
  context: Parameters<TravelTool['execute']>[1],
  repairNotes: string[]
): void {
  const allowedSourceIds = new Set(context.sourceIds ?? [])
  const pageSources = (context.availableSources ?? []).filter((source) =>
    allowedSourceIds.has(source.id) && source.kind === 'web' && source.status === 'success' &&
    (source.contentLevel ?? legacySourceContentLevel(source)) === 'page' &&
    source.sourceNature !== 'community-platform'
  )
  let linkedCount = 0

  for (const day of days) {
    for (const stop of day.stops) {
      for (const claim of stop.factClaims ?? []) {
        if (claim.evidenceLevel !== 'pending' || claim.sourceId) continue
        const matchingSources = pageSources.filter((source) => {
          const body = sourceEvidenceText(source)
          return itinerarySourceNamesPlace(body, stop.name) &&
            pageBodySupportsFactType(claim.type, body)
        })
        if (matchingSources.length !== 1) continue
        claim.sourceId = matchingSources[0]!.id
        linkedCount += 1
      }
    }
  }

  if (linkedCount) {
    repairNotes.push(`已为 ${linkedCount} 条待核验事实关联唯一的同地点网页正文；内容仍需核对。`)
  }
}

/** 用户明确要求核对摄影条件时，保证相关地点有可追踪的来源或待核验事实。 */
function ensureRequestedPhotographyFacts(
  days: ItineraryDay[],
  context: Parameters<TravelTool['execute']>[1],
  repairNotes: string[]
): void {
  const request = [context.userRequest, context.tripBrief?.interests, context.tripBrief?.constraints]
    .filter(Boolean).join('\n')
  const requestsSunset = /(?:日出|日落|太阳升起|太阳落山|蓝调时段|黄金时段).{0,12}(?:时间|时刻|时段|安排|核验|窗口)?|(?:核验|查).{0,8}(?:日出|日落)/u.test(request)
  const requestsPhotographyRules = /(?:拍摄|摄影|照相|航拍).{0,14}(?:限制|规定|规则|能否|可否|是否|允许|禁止)|(?:限制|规定|规则|能否|可否|是否|允许|禁止).{0,14}(?:拍摄|摄影|照相|航拍)/u.test(request)
  if (!requestsSunset && !requestsPhotographyRules) return

  for (const day of days) {
    const attractions = day.stops.filter((stop) => isVisitStop(stop) && isAttractionStop(stop))
    if (!attractions.length) continue
    const photographyStops = attractions.filter((stop) =>
      /观景|夜景|摄影|拍摄|索道|大桥|日落|日出|夕阳/u.test(`${stop.name} ${stop.notes}`)
    )

    if (requestsSunset) {
      const lateStops = attractions.filter((stop) => {
        const match = stop.time.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/u)
        return match ? Number(match[1]) * 60 + Number(match[2]) >= 15 * 60 : false
      })
      const target = lateStops.find((stop) => photographyStops.includes(stop)) ?? lateStops.at(-1)
      if (target) {
        let claim = target.factClaims?.find((item) => item.type === 'sunset')
        const weatherSource = context.availableSources?.find((source) =>
          sourceSupportsStructuredSunsetDate(source, day.date)
        )
        const weatherRow = weatherSource?.summary.split(/\r?\n/u).map((line) => line.trim())
          .find((line) => line.startsWith(`${day.date}：`) || line.startsWith(`${day.date}:`))
        const sunsetTime = weatherRow?.match(/日落\s*((?:[01]?\d|2[0-3]):[0-5]\d)/u)?.[1]
        if (sunsetTime && weatherSource) {
          if (claim && claim.evidenceLevel !== 'sourced') {
            claim.value = `日落 ${sunsetTime}`
            claim.scope = day.date
            claim.evidenceLevel = 'sourced'
            claim.sourceId = weatherSource.id
          } else if (!claim && (target.factClaims?.length ?? 0) < MAX_ITINERARY_FACT_CLAIMS_PER_STOP) {
            const sourcedClaim: ItineraryFactClaim = {
              id: randomUUID(), type: 'sunset', value: `日落 ${sunsetTime}`, scope: day.date,
              evidenceLevel: 'sourced', sourceId: weatherSource.id
            }
            target.factClaims = [...(target.factClaims ?? []), sourcedClaim]
          }
          repairNotes.push(`${day.date} 的日落时刻已关联同日期的结构化天气来源。`)
        } else if (!claim) {
          appendPendingFactClaim(target, 'sunset', day.date || '出行日期待确认')
          repairNotes.push(`${day.date || '出行日'} 的日出日落时间保留为逐地点待核验事实。`)
        }
      }
    }

    if (requestsPhotographyRules) {
      const targets = photographyStops.length ? photographyStops : [attractions[0]!]
      let pendingAdded = false
      for (const target of targets) {
        if (target.factClaims?.some((claim) => claim.type === 'photography-rules' && claim.evidenceLevel === 'sourced')) continue
        if (target.factClaims?.some((claim) => claim.type === 'photography-rules')) continue
        const countBefore = target.factClaims?.length ?? 0
        appendPendingFactClaim(target, 'photography-rules', day.date || '出行日期待确认')
        pendingAdded ||= (target.factClaims?.length ?? 0) > countBefore
      }
      if (pendingAdded) repairNotes.push(`${day.date || '出行日'} 的拍摄规定保留为逐地点待核验事实。`)
    }
  }
}

interface TransitMetric {
  type: 'distance' | 'fare' | 'toll'
  distanceMeters?: number
  fareFen?: number
  tollFen?: number
}

interface TransitMetrics {
  durations: number[]
  distances: number[]
  fares: number[]
  tolls: number[]
}

/** 提取交通文本中的数值距离和费用，统一换算为米、人民币分。 */
function transitMetricsIn(value: string): TransitMetrics {
  const metrics = emptyTransitMetrics()
  metrics.durations = transitDurationMinutes(value)
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)\s*(km|公里|千米|m|米)/giu)) {
    const amount = Number(match[1])
    const unit = (match[2] ?? '').toLocaleLowerCase()
    const meters = unit === 'km' || unit === '公里' || unit === '千米' ? Math.round(amount * 1_000) : Math.round(amount)
    if (meters > 0) metrics.distances.push(meters)
  }
  for (const match of value.matchAll(/(道路收费|过路费|通行费|票价|车费)(?:估算|估计)?\s*[:：]?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*元?/giu)) {
    const amountFen = yuanToFen(match[2] ?? '')
    if (amountFen === undefined) continue
    if (/道路收费|过路费|通行费/u.test(match[1] ?? '')) metrics.tolls.push(amountFen)
    else metrics.fares.push(amountFen)
  }
  return {
    ...metrics,
    durations: [...new Set(metrics.durations)],
    distances: [...new Set(metrics.distances)],
    fares: [...new Set(metrics.fares)],
    tolls: [...new Set(metrics.tolls)]
  }
}

/** 生成空交通指标集合，供无交通说明的普通文本复用。 */
function emptyTransitMetrics(): TransitMetrics {
  return { durations: [], distances: [], fares: [], tolls: [] }
}

/** 判断一段文本是否包含需要来源核对的数字交通指标。 */
function hasTransitMetrics(metrics: TransitMetrics): boolean {
  return metrics.durations.length + metrics.distances.length + metrics.fares.length + metrics.tolls.length > 0
}

/** 将人民币元数值转换为整数分。 */
function yuanToFen(value: string): number | undefined {
  const match = value.match(/^(\d+)(?:\.(\d{1,2}))?$/u)
  if (!match) return undefined
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
}

/** 移除未验证的数字时长，保留交通方式、站名和路线说明。 */
function replaceTransitDurationsWithPending(value: string): string {
  return value
    .replace(/(?:约|大约)?\s*\d+(?:\.\d+)?\s*(?:[–—~至-]\s*\d+(?:\.\d+)?)?\s*小时(?:\s*\d+\s*分钟?)?/giu, '耗时待核验')
    .replace(/(?:约|大约)?\s*\d+(?:\.\d+)?(?:\s*[–—~至-]\s*\d+(?:\.\d+)?)?\s*(?:分钟|分|min(?:utes?)?)/giu, '耗时待核验')
    .replace(/(?:约|大约)?\s*\d+(?:\.\d+)?\s*[–—~-]\s*耗时待核验/giu, '耗时待核验')
    .replace(/[（(]\s*待核验\s*[）)]/gu, '待核验')
    .replace(/(耗时待核验)(?:\s*[,，;；、]?\s*待核验)+/gu, '$1')
    .replace(/耗时待核验\s*以内/gu, '耗时待核验')
    .replace(/(?:约|大约)\s*(?=耗时待核验)/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** 未核验距离降级显示，避免保留看似精准的公里/米数。 */
function replaceTransitDistancesWithPending(value: string): string {
  return value
    .replace(/\d+(?:\.\d+)?\s*(?:km|公里|千米|m|米)/giu, '距离待核验')
    .replace(/距离待核验(?:[\s，,；;、]*距离待核验)+/gu, '距离待核验')
    .replace(/(?:约|大约)\s*(?=距离待核验)/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** 未核验交通费用保留费用类别，但不显示无来源金额。 */
function replaceTransitAmountsWithPending(value: string): string {
  return value
    .replace(/((?:道路收费|过路费|通行费|票价|车费)(?:估算|估计)?\s*[:：]?\s*)(?:[¥￥]\s*)?\d+(?:\.\d{1,2})?\s*元?/giu, '$1待核验')
    .replace(/[¥￥]\s*\d+(?:\.\d{1,2})?/gu, '金额待核验')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** 解析中文和英文时长，并把小时统一换算成分钟供来源比对。 */
function transitDurationMinutes(value: string): number[] {
  const durations = new Set<number>()
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)\s*小时(?:\s*(\d+)\s*分钟?)?/gu)) {
    durations.add(Math.round(Number(match[1]) * 60) + Number(match[2] ?? 0))
  }
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)(?:\s*[–—~至-]\s*(\d+(?:\.\d+)?))?\s*(?:分钟|分|min(?:utes?)?)/giu)) {
    durations.add(Math.round(Number(match[1])))
    if (match[2]) durations.add(Math.round(Number(match[2])))
  }
  return [...durations]
}

/** 只采纳与当前住宿、日边界地点及成功路线事实完全对应的接驳估算。 */
function normalizeLodgingCommutes(
  value: unknown,
  dayDate: string,
  stops: ItineraryStop[],
  context: Parameters<TravelTool['execute']>[1],
  repairNotes: string[]
): LodgingCommute[] {
  if (!Array.isArray(value) || value.length > 2) throw new ToolInputError('每日住宿接驳最多包含去首个实体地点和末个实体地点返住宿两条路线。')
  if (value.length === 0) return []
  const lodgingLocation = context.tripBrief?.lodgingLocation.trim() ?? ''
  if (!lodgingLocation) {
    repairNotes.push('未提供具体住宿地点，住宿接驳已省略，耗时待核验。')
    return []
  }
  const directions = new Set<string>()
  return value.flatMap((raw): LodgingCommute[] => {
    const commute = asObject(raw, '住宿接驳')
    const direction = commute.direction
    if (direction !== 'from-lodging' && direction !== 'to-lodging') {
      repairNotes.push('无效住宿接驳已省略，耗时待核验。')
      return []
    }
    if (directions.has(direction)) {
      repairNotes.push('重复住宿接驳已省略，耗时待核验。')
      return []
    }
    const stop = lodgingCommuteBoundaryStop(stops, direction)
    if (!stop) {
      repairNotes.push('住宿接驳缺少对应的实体地点，已省略，耗时待核验。')
      return []
    }
    const sourceId = typeof commute.source_id === 'string' ? commute.source_id.trim() : ''
    const source = context.availableSources?.find((item) => item.id === sourceId)
    if (!sourceId || !(context.sourceIds ?? []).includes(sourceId) || !source || source.kind !== 'route' || source.status !== 'success' ||
      !routeTitleMatchesOrderedEndpoints(source.title,
        direction === 'from-lodging' ? lodgingLocation : stop.name,
        direction === 'from-lodging' ? stop.name : lodgingLocation)) {
      repairNotes.push('住宿接驳没有匹配的成功路线来源，已省略，耗时待核验。')
      return []
    }
    try {
      const mode = requireRouteMode(commute.mode)
      const optionNumber = requireInteger(commute.option_number, '路线方案序号', 1, 3)
      const durationMinutes = requireInteger(commute.duration_minutes, '路线耗时', 1, 1_440)
      const distanceMeters = nullableInteger(commute.distance_meters, '路线距离', 1, 1_000_000)
      const queryDate = optionalItineraryDate(commute.query_date, '路线查询日期')
      const queryTime = optionalItineraryTime(commute.query_time)
      const header = source.summary.split(/\r?\n/, 1)[0] ?? ''
      const modeLabel = mode === 'transit' ? '公共交通' : mode === 'walking' ? '步行' : '驾车'
      if (!header.includes(`，${modeLabel}`) ||
        (mode === 'transit' && dayDate && queryDate !== dayDate) ||
        (queryDate !== undefined && !header.includes(queryDate)) ||
        (queryTime !== undefined && !header.includes(queryTime.replace('-', ':'))) ||
        !routeSummarySupportsMetrics(source.summary, optionNumber, distanceMeters ?? undefined, durationMinutes)) {
        repairNotes.push('住宿接驳的路线信息与来源不一致，已省略，耗时待核验。')
        return []
      }
      directions.add(direction)
      return [{
        direction,
        lodgingLocation,
        stopId: stop.id,
        sourceId,
        mode,
        optionNumber,
        ...(queryDate ? { queryDate } : {}),
        ...(queryTime ? { queryTime } : {}),
        durationMinutes,
        ...(distanceMeters === null ? {} : { distanceMeters })
      }]
    } catch (error) {
      if (!(error instanceof ToolInputError)) throw error
      repairNotes.push('住宿接驳字段无效，已省略，耗时待核验。')
      return []
    }
  })
}

/** 将错误分钟数降为未知，避免单个估算值废弃结构有效的候选。 */
function normalizeOptionalDuration(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
  repairNotes: string[]
): number | null {
  if (value === null || value === undefined) return null
  const numeric = typeof value === 'number' || (typeof value === 'string' && value.trim())
    ? Number(value)
    : Number.NaN
  if (Number.isInteger(numeric) && numeric >= minimum && numeric <= maximum) return numeric
  repairNotes.push(`${label}格式或范围无效，已清除时长值；仍按明确时段校验。`)
  return null
}

/** 当结构化时长与明确起止时段冲突时，以展示给用户的时段为准统一分钟数。 */
function alignDurationToExplicitRange(
  time: string,
  durationMinutes: number | null,
  label: string,
  repairNotes: string[]
): number | null {
  const rangeMinutes = scheduleRangeDurationMinutes(time)
  if (rangeMinutes === null || durationMinutes === null || rangeMinutes === durationMinutes) return durationMinutes
  repairNotes.push(`${label}与明确起止时段不一致，已按起止时段修正为 ${rangeMinutes} 分钟。`)
  return rangeMinutes
}

/** 限定非地点时段字段；时间块不接收坐标或交通来源，避免误导地图。 */
function normalizeScheduleBlock(
  value: unknown,
  context: Parameters<TravelTool['execute']>[1],
  repairNotes: string[]
): ItineraryScheduleBlock {
  const block = asObject(value, '用餐或休息时段')
  const inputKind = requireScheduleBlockKind(block.kind)
  const inputDuration = normalizeOptionalDuration(block.duration_minutes, 1, 720, '用餐、休息或机动时长', repairNotes)
  const rawArea = requireString(block.area ?? '', '时段区域', 0, 80_000)
  const rawNotes = requireString(block.notes ?? '', '时段说明', 0, 300)
  const title = modelTextOrFallback(block.title ?? '', '时段标题', 100,
    inputKind === 'meal' ? '用餐' : inputKind === 'rest' ? '休息' : '机动时间', repairNotes)
  const kind = normalizeScheduleBlockKind(inputKind, title, rawNotes, repairNotes)
  const time = requireString(block.time ?? '', '时段时间', 0, 40)
  return {
    id: randomUUID(),
    kind,
    title,
    time,
    durationMinutes: alignDurationToExplicitRange(time, inputDuration, '时间块时长', repairNotes),
    area: rawArea.slice(0, 120),
    notes: normalizeScheduleBlockNotes(rawNotes, context, repairNotes)
  }
}

/** 以时间块名称校正用餐/休息类型，避免界面和导出显示错类。 */
function normalizeScheduleBlockKind(
  inputKind: ItineraryScheduleBlockKind,
  title: string,
  notes: string,
  repairNotes: string[]
): ItineraryScheduleBlockKind {
  const titleNamesMeal = /早餐|早饭|午餐|午饭|晚餐|晚饭|用餐|吃饭/u.test(title)
  const titleNamesRest = /午休|休息|休整|小憩|午睡/u.test(title)
  const titleNamesBuffer = /缓冲|机动时间|通勤预留|接驳预留|候车缓冲|进站缓冲|安检缓冲/u.test(title)
  const notesNamesMeal = /早餐|早饭|午餐|午饭|晚餐|晚饭|用餐|吃饭/u.test(notes)
  const notesNamesRest = /午休|休息|休整|小憩|午睡/u.test(notes)
  const notesNamesBuffer = /缓冲|机动时间|通勤预留|接驳预留|候车缓冲|进站缓冲|安检缓冲/u.test(notes)
  // 标题决定时间块本身；备注中提到餐前餐后，不把通勤缓冲误判成用餐。
  const kind = titleNamesMeal && !titleNamesRest ? 'meal'
    : titleNamesRest && !titleNamesMeal ? 'rest'
      : titleNamesBuffer ? 'buffer'
        : notesNamesMeal && !notesNamesRest ? 'meal'
          : notesNamesRest && !notesNamesMeal ? 'rest'
            : notesNamesBuffer ? 'buffer' : inputKind
  if (kind !== inputKind) {
    const label = kind === 'meal' ? '用餐' : kind === 'rest' ? '休息' : '交通/机动缓冲'
    repairNotes.push(`时间块已按${label}语义归类。`)
  }
  return kind
}

/** 时间块不绑定路线来源；未知预订状态和路线数字必须显式降级。 */
function normalizeScheduleBlockNotes(
  value: string,
  context: Parameters<TravelTool['execute']>[1],
  repairNotes: string[]
): string {
  let notes = value
  const userText = `${context.userRequest ?? ''}\n${context.tripBrief?.constraints ?? ''}`
  const userConfirmedBooking = /(?:我|我们)(?:已经|早已|已)(?:成功|完成)?(?:预订|预约|订购|订好|订了|订)|(?:我|我们)(?:订了|订好|预订了|预约成功)/u.test(userText)
  if (!userConfirmedBooking) {
    const confirmedBooking = /(?:已|已经|早已)(?:成功|完成)?(?:预订|预约|订购|订好|订了|订)[^，,。；;]{0,24}|(?:预订|预约)(?:已)?成功/gu
    const sanitized = notes.replace(confirmedBooking, (claim) =>
      /待(?:核验|确认)|尚未|未(?:预约|预订)/u.test(claim) ? claim : '预订状态待确认')
    if (sanitized !== notes) {
      notes = sanitized
      repairNotes.push('时间块中的预订状态没有用户确认，已改为待确认。')
    }
  }

  if (!hasTransitMetrics(transitMetricsIn(notes))) return notes
  const remainingNotes = notes.split(/[，,；;。]/u)
    .map((part) => part.trim())
    .filter((part) => part && !/(?:路线|线路|交通|通勤|地铁|公交|接驳|步行|\d|已含)/u.test(part))
  repairNotes.push('时间块中的未核验路线数字已改为待核验。')
  return ['交通信息待核验。', ...remainingNotes].join(' ').slice(0, 300)
}

/** 只接受界面和导出均可解释的时间块类型。 */
function requireScheduleBlockKind(value: unknown): ItineraryScheduleBlockKind {
  if (value !== 'meal' && value !== 'rest' && value !== 'buffer') throw new ToolInputError('用餐或休息时段类型不受支持。')
  return value
}

/** 限定地点字段长度和停留分钟数，不把模型猜测伪装成精确测量。 */
function normalizeStop(
  value: unknown,
  allowedSourceIds: string[],
  availableSources: SourceRecord[],
  repairNotes: string[],
  factEvidenceDiagnostics: ItineraryFactEvidenceDiagnostics,
  factEvidenceCorrections: FactEvidenceCorrection[],
  otherStopNames: string[]
): ItineraryStop {
  const stop = asObject(value, '行程地点')
  const rawName = normalizePlaceName(stop.name, '地点名称', 160, repairNotes)
  const name = normalizeStopName(rawName.value, repairNotes)
  const rawNotes = requireString(stop.notes ?? '', '地点说明', 0, 500)
  const category = normalizeStopCategory(stop.category, name, rawNotes, repairNotes)
  const inputDuration = normalizeOptionalDuration(stop.duration_minutes, 0, 720, '建议停留时间', repairNotes)
  const sourceIds = rawName.truncated
    ? []
    : normalizeAvailableSourceIds(stop.source_ids, allowedSourceIds, availableSources, repairNotes)
  const normalizedFactClaims = rawName.truncated
    ? []
    : normalizeFactClaims(
      stop.fact_claims ?? [], name, allowedSourceIds, availableSources,
      repairNotes, factEvidenceDiagnostics, factEvidenceCorrections, otherStopNames
    )
  // 门票事实只适用于可售票的地点；餐饮、住宿和休息项不显示票价占位。
  const factClaims = isTicketPriceInapplicableStop(category, name)
    ? normalizedFactClaims.filter((claim) => claim.type !== 'ticket-price')
    : normalizedFactClaims
  const conditionalAlternatives = normalizeConditionalAlternatives(
    stop.conditional_alternatives, allowedSourceIds, availableSources, repairNotes
  )
  const requestedEvidenceLevel = rawName.truncated ? 'pending' : isEvidenceLevel(stop.evidence_level)
    ? stop.evidence_level
    : sourceIds.length || factClaims.some((claim) => claim.evidenceLevel === 'sourced') ? 'sourced' : 'pending'
  if (stop.evidence_level !== undefined && !isEvidenceLevel(stop.evidence_level)) {
    repairNotes.push('无法识别的地点依据状态已降级为待核验。')
  }
  const evidenceLevel = requestedEvidenceLevel === 'sourced' && sourceIds.length === 0
    ? 'pending'
    : requestedEvidenceLevel
  const rawArea = requireString(stop.area ?? '', '地点区域', 0, 80_000)
  if (rawArea.length > 120) repairNotes.push('过长的地点区域说明已截短为可读长度。')
  const time = normalizeDisplayTime(stop.time, repairNotes)
  const nameWarning = '地点名称过长，已截短；地点身份与来源待核验。'
  return {
    id: randomUUID(),
    name,
    area: rawArea.slice(0, 120),
    time,
    durationMinutes: alignDurationToExplicitRange(time, inputDuration, '停留时长', repairNotes),
    category,
    notes: rawName.truncated
      ? [nameWarning, truncateText(rawNotes, 500 - nameWarning.length)].filter(Boolean).join(' ')
      : rawNotes,
    transitToNext: requireString(stop.transit_to_next ?? '', '下一段交通', 0, 300),
    evidenceLevel,
    sourceIds,
    factClaims,
    ...(conditionalAlternatives?.length ? { conditionalAlternatives } : {})
  }
}

/** 识别不适用景点门票事实的餐饮、住宿和休息停靠点。 */
function isTicketPriceInapplicableStop(category: string, name: string): boolean {
  return /餐饮|餐厅|餐馆|早餐|早饭|午餐|午饭|晚餐|晚饭|美食|住宿|酒店|宾馆|客栈|民宿|入住|休息/u.test(`${category} ${name}`)
}

/** 将模型返回的超长地点名安全截短，并让对应地点与来源重新待核验。 */
function normalizePlaceName(
  value: unknown,
  label: string,
  maximum: number,
  repairNotes: string[]
): { value: string; truncated: boolean } {
  if (typeof value !== 'string') throw new ToolInputError(`${label}必须是非空文本；休息和机动时段请放入 schedule_blocks。`)
  const raw = value.replace(/\s+/gu, ' ').trim()
  if (!raw) throw new ToolInputError(`${label}不能为空；地点或餐馆填写名称，休息和机动时段请放入 schedule_blocks。`)
  if (raw.length > 10_000) throw new ToolInputError(`${label}长度不能超过 10000 个字符。`)
  if (raw.length <= maximum) return { value: raw, truncated: false }
  repairNotes.push(`${label}过长，已截短；地点身份及来源需重新核验。`)
  return { value: truncateText(raw, maximum), truncated: true }
}

/** 地点名称只标识场所，不承载未结构化的票价或免费状态。 */
function normalizeStopName(value: string, repairNotes: string[]): string {
  const sanitized = sanitizeUnsupportedTicketPriceNotes(value)
    .replace(/(?:门票价格|票价|费用状态|出行费用|费用)待核验/gu, '')
    .replace(/[（(]\s*[，,；;、]*\s*[）)]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (sanitized !== value) repairNotes.push('地点名称中的未核实金额或免费结论已移除。')
  return requireString(sanitized || value, '地点名称', 1, 160)
}

/** 将条件备选独立绑定地点来源；来源缺失或不提及候选时保留待核验状态。 */
function normalizeConditionalAlternatives(
  value: unknown,
  allowedSourceIds: string[],
  availableSources: SourceRecord[],
  repairNotes: string[]
): ItineraryConditionalAlternative[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 3) throw new ToolInputError('每个停靠点最多可提供 3 个条件备选地点。')
  return value.map((entry) => {
    const alternative = asObject(entry, '条件备选地点')
    const normalizedName = normalizePlaceName(alternative.name, '条件备选地点名称', 160, repairNotes)
    const name = normalizedName.value
    const area = requireString(alternative.area ?? '', '条件备选地点区域', 0, 80).trim()
    const trigger = requireString(alternative.trigger, '条件备选触发条件', 1, 120).trim()
    const environment = alternative.environment === 'indoor' || alternative.environment === 'outdoor' || alternative.environment === 'unknown'
      ? alternative.environment
      : undefined
    if (alternative.environment !== undefined && environment === undefined) {
      repairNotes.push(`条件备选“${name}”的室内外类型无效，已标为未知。`)
    }
    if (alternative.evidence_level !== undefined && alternative.evidence_level !== 'sourced' && alternative.evidence_level !== 'pending') {
      repairNotes.push(`条件备选“${name}”的来源状态无效，已按实际来源重新判定。`)
    }
    const rawSourceIds = alternative.source_ids
    if (rawSourceIds !== undefined && (!Array.isArray(rawSourceIds) || rawSourceIds.length > 3 || rawSourceIds.some((id) =>
      typeof id !== 'string' || !id.trim() || id.length > 100
    ))) {
      repairNotes.push(`条件备选“${name}”的来源格式无效，已降为待核验。`)
    }
    const requestedIds = Array.isArray(rawSourceIds) && rawSourceIds.length <= 3
      ? [...new Set(rawSourceIds.filter((id): id is string => typeof id === 'string' && !!id.trim() && id.length <= 100))]
      : []
    const matchingRequestedIds = normalizedName.truncated ? [] : requestedIds.filter((id) => {
      if (!isAvailableSourceId(id, allowedSourceIds, availableSources)) return false
      const source = availableSources.find((item) => item.id === id)
      return source ? sourceDirectlyNamesAlternative(source, name) : false
    })
    const directlyMatchingSourceIds = normalizedName.truncated ? [] : availableSources.filter((source) =>
      allowedSourceIds.includes(source.id) && source.status === 'success' && sourceDirectlyNamesAlternative(source, name)
    ).map((source) => source.id)
    const matchingSourceIds = [...new Set([...matchingRequestedIds, ...directlyMatchingSourceIds])].slice(0, 3)
    if (matchingRequestedIds.length !== requestedIds.length && matchingSourceIds.length === 0) {
      repairNotes.push(`条件备选“${name}”没有直接支持地点名称的有效来源，已标为待核验。`)
    } else if (matchingRequestedIds.length !== requestedIds.length) {
      repairNotes.push(`条件备选“${name}”的无效来源已剔除，并按地点名称匹配当前成功来源。`)
    }
    return {
      name,
      area,
      trigger,
      evidenceLevel: matchingSourceIds.length ? 'sourced' : 'pending',
      sourceIds: matchingSourceIds,
      ...(environment ? { environment } : {})
    }
  })
}

/** 只接受标题、摘要或结构化地图地点明确提到候选名称的来源。 */
function sourceDirectlyNamesAlternative(source: SourceRecord, alternativeName: string): boolean {
  const normalize = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]/gu, '')
  const normalizedName = normalize(alternativeName).replace(/^(?:中华人民共和国|中国)?(?:北京市|北京|天津市|天津|上海市|上海|重庆市|重庆)/u, '')
  if (normalizedName.length < 3) return false
  const sourceText = normalize(`${source.title} ${source.summary} ${source.location?.label ?? ''}`)
  if (sourceText.includes(normalizedName)) return true
  const cityFreeTitle = normalize(source.title).replace(/^(?:中华人民共和国|中国)?(?:北京市|北京|天津市|天津|上海市|上海|重庆市|重庆)/u, '')
  return cityFreeTitle.length >= 4 && normalizedName.includes(cityFreeTitle)
}

/** 归一化模型给出的地点类别，避免展示字段冗长或格式异常丢弃整套有效行程。 */
function normalizeStopCategory(value: unknown, nameValue: unknown, notesValue: unknown, repairNotes: string[]): string {
  const rawCategory = typeof value === 'string' ? value.trim() : ''
  if (rawCategory && rawCategory.length <= 60) return rawCategory

  const name = typeof nameValue === 'string' ? nameValue : ''
  const notes = typeof notesValue === 'string' ? notesValue : ''
  const text = `${rawCategory} ${name} ${notes}`.normalize('NFKC')
  const inferred = [
    { category: '住宿', pattern: /酒店|宾馆|民宿|住宿|入住|退房/ },
    { category: '餐饮', pattern: /餐饮|早餐|午餐|晚餐|用餐|餐厅|饭店|美食|小吃|咖啡/ },
    { category: '交通', pattern: /交通|机场|航班|火车|动车|高铁|地铁|公交|车站|站|打车|换乘|步行|候车/ },
    { category: '休息', pattern: /休息|午休|休闲|放松/ },
    { category: '景点', pattern: /景点|景区|公园|博物馆|故宫|长城|寺|胡同|广场|园林|游览/ }
  ].find((item) => item.pattern.test(text))?.category
  repairNotes.push(rawCategory ? '过长的地点类型已归一化为简短类别。' : '地点类型缺失或格式无效，已根据地点信息补齐。')
  return inferred ?? (rawCategory ? truncateText(rawCategory, 60) : '其他')
}

/** 校验逐事实声明、适用范围和单条来源，不把多个来源压成一个值。 */
function normalizeFactClaims(
  value: unknown,
  stopName: string,
  allowedSourceIds: string[],
  availableSources: SourceRecord[],
  repairNotes: string[],
  diagnostics: ItineraryFactEvidenceDiagnostics,
  factEvidenceCorrections: FactEvidenceCorrection[],
  otherStopNames: string[] = []
): ItineraryFactClaim[] {
  if (!Array.isArray(value) || value.length > MAX_ITINERARY_FACT_CLAIMS_PER_STOP) {
    throw new ToolInputError(`每个地点必须提供 0–${MAX_ITINERARY_FACT_CLAIMS_PER_STOP} 条结构化事实声明。`)
  }
  const claims = value.map((raw): ItineraryFactClaim | undefined => {
    const claim = asObject(raw, '地点事实')
    const type = requireFactType(claim.type)
    const scope = requireString(claim.scope, '事实适用范围', 0, 100)
    const rawFactValue = requireString(claim.value, '事实内容', 1, MAX_ITINERARY_ARGUMENT_CHARACTERS)
    // 超长原文只丢弃这条证据；必需事实稍后会由执行端补成待核验项。
    if (rawFactValue.length > MAX_ITINERARY_FACT_QUOTE_CHARACTERS) {
      repairNotes.push('事实原文超过长度上限，已省略并留待核验；行程安排保留。')
      return undefined
    }
    let evidenceLevel = isEvidenceLevel(claim.evidence_level) ? claim.evidence_level : 'pending'
    const requestedEvidenceLevel = evidenceLevel
    if (!isEvidenceLevel(claim.evidence_level)) repairNotes.push('无法识别的地点事实依据状态已降级为待核验。')
    const rawSourceId = claim.source_id
    let sourceId = rawSourceId === null || rawSourceId === undefined || rawSourceId === ''
      ? undefined
      : requireString(rawSourceId, '事实来源 ID', 1, 100)
    if (sourceId && !isAvailableSourceId(sourceId, allowedSourceIds, availableSources)) {
      sourceId = undefined
      evidenceLevel = 'pending'
    }
    let source = sourceId ? availableSources.find((item) => item.id === sourceId) : undefined
    let factValue = rawFactValue
    const sourceCanSupport = !!source && sourceCanSupportFact(type, source, scope)
    let sourceSupportsValue = sourceCanSupport
    let rejectionReason: FactEvidenceRejectionReason | undefined
    if (!source) {
      rejectionReason = 'source-unavailable'
    } else if (!sourceCanSupport) {
      rejectionReason = 'source-ineligible'
    } else if (requiresVenueFactText(type, source)) {
      if (!sourceDirectlyNamesStop(source, stopName)) {
        sourceSupportsValue = false
        rejectionReason = 'place-mismatch'
      } else if (!sourceDirectlySupportsStopFact(type, source, stopName, factValue, otherStopNames, scope)) {
        sourceSupportsValue = false
        rejectionReason = factEvidenceFailureReason(type, source, stopName, factValue, otherStopNames, scope)
      }
    }
    if (requestedEvidenceLevel === 'sourced' && !sourceSupportsValue &&
      ['opening-hours', 'ticket-price', 'booking', 'closure', 'accessibility', 'sunset', 'photography-rules', 'other'].includes(type)) {
      const exactSources = availableSources.filter((candidate) =>
        isAvailableSourceId(candidate.id, allowedSourceIds, availableSources) &&
        sourceCanSupportFact(type, candidate, scope) && requiresVenueFactText(type, candidate) &&
        sourceDirectlyNamesStop(candidate, stopName) &&
        sourceDirectlySupportsStopFact(type, candidate, stopName, factValue, otherStopNames, scope)
      )
      if (exactSources.length === 1) {
        source = exactSources[0]
        sourceId = source.id
        evidenceLevel = 'sourced'
        sourceSupportsValue = true
        rejectionReason = undefined
        diagnostics.autoBoundCount = Math.min(999, diagnostics.autoBoundCount + 1)
      }
    }
    if (requestedEvidenceLevel === 'sourced' && type === 'sunset' && source?.kind === 'weather') {
      const sourcedSunset = structuredSunsetTimeForDate(source, scope)
      sourceSupportsValue = !!sourcedSunset && factValue.includes(sourcedSunset)
      if (sourceSupportsValue && sourcedSunset) factValue = `日落 ${sourcedSunset}`
    }
    if (requestedEvidenceLevel === 'sourced') {
      diagnostics.requestedCount = Math.min(999, diagnostics.requestedCount + 1)
    }
    if (requestedEvidenceLevel === 'sourced' && (!source || !sourceSupportsValue)) {
      evidenceLevel = 'pending'
      factValue = pendingFactValue(type)
      const reason = rejectionReason ?? 'value-mismatch'
      // 地点不符的页面不能作为待核验项的来源入口。
      if (reason === 'place-mismatch') sourceId = undefined
      recordFactEvidenceRejection(diagnostics, type, reason)
      if (factEvidenceCorrections.length < 8) factEvidenceCorrections.push({ placeName: stopName, type, reason })
      repairNotes.push('缺少可匹配的直接来源时，景点动态事实已隐藏并标为待核验。')
    }
    if (requiresDirectFactEvidence(type) && evidenceLevel !== 'sourced') {
      evidenceLevel = 'pending'
      factValue = pendingFactValue(type)
    }
    if (evidenceLevel === 'pending' && (type === 'weather' || type === 'transport-time')) {
      factValue = pendingFactValue(type)
    }
    if (evidenceLevel === 'sourced' && !sourceId) evidenceLevel = 'pending'
    return {
      id: randomUUID(),
      type,
      value: factValue,
      scope,
      evidenceLevel,
      ...(sourceId ? { sourceId } : {})
    }
  }).filter((claim): claim is ItineraryFactClaim => claim !== undefined)
  const deduplicated = new Map<string, ItineraryFactClaim>()
  for (const claim of claims) {
    const key = [claim.type, claim.scope.normalize('NFKC').trim().toLocaleLowerCase(), claim.value.normalize('NFKC').trim().toLocaleLowerCase(), claim.sourceId ?? ''].join('\u0000')
    if (!deduplicated.has(key)) deduplicated.set(key, claim)
  }
  return [...deduplicated.values()]
}

/** 初始化固定维度的事实校验计数；避免日志携带地点或来源正文。 */
function emptyFactEvidenceDiagnostics(): ItineraryFactEvidenceDiagnostics {
  return {
    requestedCount: 0,
    autoBoundCount: 0,
    rejectedCount: 0,
    sourceUnavailableCount: 0,
    sourceIneligibleCount: 0,
    placeMismatchCount: 0,
    scopeMismatchCount: 0,
    valueMismatchCount: 0,
    rejectedByType: {}
  }
}

/** 仅统计模型要求标为 sourced、但未通过直接证据校验的声明。 */
function recordFactEvidenceRejection(
  diagnostics: ItineraryFactEvidenceDiagnostics,
  type: ItineraryFactType,
  reason: FactEvidenceRejectionReason
): void {
  diagnostics.rejectedCount = Math.min(999, diagnostics.rejectedCount + 1)
  diagnostics.rejectedByType[type] = Math.min(999, (diagnostics.rejectedByType[type] ?? 0) + 1)
  const countByReason = {
    'source-unavailable': 'sourceUnavailableCount',
    'source-ineligible': 'sourceIneligibleCount',
    'place-mismatch': 'placeMismatchCount',
    'scope-mismatch': 'scopeMismatchCount',
    'value-mismatch': 'valueMismatchCount'
  } as const
  const field = countByReason[reason]
  diagnostics[field] = Math.min(999, diagnostics[field] + 1)
}

/** 仅把来源拒绝位置与原因回传模型，不附事实值或网页正文。 */
function itineraryProposalOutput(
  diagnostics: ItineraryFactEvidenceDiagnostics,
  corrections: FactEvidenceCorrection[]
): string {
  const summary = '本次提交 1 份行程草案。'
  if (diagnostics.rejectedCount === 0) return summary

  const reasonLabels: Record<FactEvidenceRejectionReason, string> = {
    'source-unavailable': '来源不可用',
    'source-ineligible': '来源类型不支持此事实',
    'place-mismatch': '正文未直接提到该地点',
    'scope-mismatch': '原文未证明该开放时段适用于所填日期',
    'value-mismatch': '正文未支持所填事实值'
  }
  const uniqueCorrections = [...new Map(corrections.map((correction) => [
    `${correction.placeName}\u0000${correction.type}\u0000${correction.reason}`,
    correction
  ])).values()]
  const details = uniqueCorrections.map(({ placeName, type, reason }) =>
    `${placeName.slice(0, 80)}·${itineraryFactTypeLabel(type)}：${reasonLabels[reason]}`
  )
  const omittedCount = Math.max(0, diagnostics.rejectedCount - details.length)
  const omitted = omittedCount ? `；另有 ${omittedCount} 条未逐项列出` : ''
  const exactQuoteHint = diagnostics.valueMismatchCount > 0
    ? '事实值必须复制对应 source_id 正文中的连续原文片段；无法复制时省略该条。'
    : ''
  const scopeHint = diagnostics.scopeMismatchCount > 0
    ? '原文未证明该开放时段适用于所填日期；只提交正文明确覆盖的日期或季节范围，无法确认时保留待核验。'
    : ''
  return `${summary} 来源正文校验后，${diagnostics.rejectedCount} 条事实已降为待核验：${details.join('；')}${omitted}。后续只在正文直接支持相同地点、适用范围和值时重提；否则保留待核验。${exactQuoteHint}${scopeHint}`
}

/** 区分开放时间原文不符和原文未覆盖计划日期，避免给模型错误的改写提示。 */
function factEvidenceFailureReason(
  type: ItineraryFactType,
  source: SourceRecord,
  stopName: string,
  value: string,
  otherStopNames: string[],
  scope: string
): FactEvidenceRejectionReason {
  const dateScope = /^\d{4}-\d{2}-\d{2}$/u.test(scope)
  const valueSupportedWithoutDateScope = type === 'opening-hours' && dateScope &&
    sourceDirectlySupportsStopFact(type, source, stopName, value, otherStopNames)
  return valueSupportedWithoutDateScope ? 'scope-mismatch' : 'value-mismatch'
}

/** 事实类型受限于行程审阅界面可解释的类别。 */
function requireFactType(value: unknown): ItineraryFactType {
  const types: ItineraryFactType[] = ['opening-hours', 'ticket-price', 'booking', 'closure', 'weather', 'transport-time', 'accessibility', 'sunset', 'photography-rules', 'other']
  if (typeof value !== 'string' || !types.includes(value as ItineraryFactType)) throw new ToolInputError('地点事实类型不受支持。')
  return value as ItineraryFactType
}

/** 忽略模型提供的未知或失败来源 ID，并让对应内容保持待核验状态。 */
function normalizeAvailableSourceIds(
  value: unknown,
  allowedSourceIds: string[],
  availableSources: SourceRecord[],
  repairNotes: string[]
): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 6 || value.some((item) =>
    typeof item !== 'string' || !item.trim() || item.length > 100
  )) {
    repairNotes.push('地点来源引用格式无效，已清除并将该地点标为待核验。')
    return []
  }
  // 重复引用不增加证据价值；去重后保留有效来源，避免无害重复阻断整套行程。
  const ids = [...new Set(value as string[])]
  const available = ids.filter((id) => isAvailableSourceId(id, allowedSourceIds, availableSources))
  if (available.length !== ids.length) repairNotes.push('地点来源引用不属于本次旅行或已不可用，已移除并将相关事实标为待核验。')
  return available
}

/** 只认当前旅行中允许引用且成功保存的来源。 */
function isAvailableSourceId(sourceId: string, allowedSourceIds: string[], availableSources: SourceRecord[]): boolean {
  return allowedSourceIds.includes(sourceId) && availableSources.some((source) => source.id === sourceId && source.status === 'success')
}

/** 住宿接驳仅接受路线工具支持的三种交通方式。 */
function requireRouteMode(value: unknown): RouteMode {
  if (value !== 'transit' && value !== 'walking' && value !== 'driving') throw new ToolInputError('住宿接驳交通方式无效。')
  return value
}

/** 校验路线方案序号的整数边界。 */
function requireInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new ToolInputError(`${label}必须为 ${min}–${max} 的整数。`)
  }
  return Number(value)
}

/** 路线服务缺少指标时保留 null，不把未知误当作零。 */
function nullableInteger(value: unknown, label: string, min: number, max: number): number | null {
  return value === null ? null : requireInteger(value, label, min, max)
}

/** 只接受真实日历日期；空值用于未确认的非公共交通查询。 */
function optionalItineraryDate(value: unknown, label: string): string | undefined {
  if (value === undefined || value === '') return undefined
  const date = requireString(value, label, 10, 10)
  if (!isCalendarDate(date)) throw new ToolInputError(`${label}不是有效的 YYYY-MM-DD 日期。`)
  return date
}

/** 校验与高德路线工具一致的公共交通出发时刻格式。 */
function optionalItineraryTime(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  const time = requireString(value, '公共交通出发时刻', 3, 5)
  if (!/^(?:[01]?\d|2[0-3])-[0-5]\d$/.test(time)) throw new ToolInputError('公共交通出发时刻需使用 H-MM 或 HH-MM。')
  return time
}

/** 拒绝数组和空对象，确保结构化字段来自受校验的 JSON 对象。 */
function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolInputError(`${label}必须是 JSON 对象。`)
  }
  return value as Record<string, unknown>
}

/** 统一校验文字字段长度，不接受自动转换的数字或对象。 */
function requireString(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new ToolInputError(`${label}长度应为 ${min}–${max} 个字符。`)
  }
  return value.trim()
}

/** 补齐缺失的展示性摘要，并截短超长文本，避免文案长度丢弃可用行程。 */
function modelTextOrFallback(value: unknown, label: string, max: number, fallback: string, repairNotes: string[]): string {
  if (typeof value !== 'string') {
    repairNotes.push(`${label}格式无效，已使用简洁默认说明。`)
    return fallback
  }
  const text = value.trim()
  if (!text) return fallback
  return text.length > max ? `${truncateText(text, max - 1)}…` : text
}

/** 从结构化日程生成不依赖模型自由文本的简洁摘要。 */
function planSummaryFallback(days: ItineraryDay[]): string {
  const areas = [...new Set(days.flatMap((day) => day.stops.map((stop) => stop.area.trim()).filter(Boolean)))].slice(0, 2)
  return areas.length
    ? `围绕${areas.join('和')}安排主要活动，按片区分日游览。`
    : '按每日主题安排地点和活动，逐日呈现。'
}

/** 事实说明失效时，仍保留预算、体力与休息等用户关心的取舍。 */
function planTradeoffsFallback(
  days: ItineraryDay[],
  budgetEstimate: ItineraryBudgetEstimate | undefined,
  context: Parameters<TravelTool['execute']>[1]
): string {
  const brief = context.tripBrief
  const request = `${brief?.constraints ?? ''}\n${context.userRequest ?? ''}`
  const parts: string[] = []
  if (context.budgetRequested && budgetEstimate) {
    const budgetLabel = brief?.budget.trim()
    const paceLabel = brief?.pace.trim()
    const intensity = highIntensityRestRequested(brief, context.userRequest)
    if (intensity) {
      const pendingCount = budgetEstimate.items.filter((item) =>
        item.evidenceLevel === 'pending' || item.amountMinFen === null || item.amountMaxFen === null
      ).length
      parts.push(`${budgetLabel ? `按${budgetLabel}预算偏好和` : ''}${paceLabel || '高强度'}节奏编排；${pendingCount} 项未知费用不计入金额小计，实际步行负担偏高。`)
    } else {
      parts.push(budgetEvidenceSummary(budgetEstimate))
    }
  }
  if (highIntensityRestRequested(brief, context.userRequest) && days.some((day) =>
    day.scheduleBlocks.some((block) => block.kind === 'rest' || block.kind === 'buffer')
  )) {
    parts.push('多站日期已列出休息/机动时段，可按现场通勤和体力调整。')
  }
  if (/(?:步行负担|步行量|走路负担|走路强度)/u.test(request) && !parts.some((part) => part.includes('步行负担'))) {
    parts.push('步行强度按停靠密度作定性说明；无路线来源的距离和耗时仍待核验。')
  }
  return parts.join(' ')
}

/** 按执行端实际保留的预算证据生成取舍摘要，避免把未知误写成来源价或估算。 */
function budgetEvidenceSummary(estimate: ItineraryBudgetEstimate): string {
  const counts = {
    sourced: estimate.items.filter((item) => item.evidenceLevel === 'sourced').length,
    estimated: estimate.items.filter((item) => item.evidenceLevel === 'estimated').length,
    pending: estimate.items.filter((item) =>
      item.evidenceLevel === 'pending' || item.amountMinFen === null || item.amountMaxFen === null
    ).length
  }
  const labels = [
    counts.sourced ? `${counts.sourced} 项有来源金额` : '',
    counts.estimated ? `${counts.estimated} 项为规划估算` : '',
    counts.pending ? `${counts.pending} 项金额待核验` : ''
  ].filter(Boolean)
  const summary = labels.length ? `预算分项：${labels.join('、')}` : '预算分项尚无可用金额'
  return counts.pending ? `${summary}；待核验金额不计入已知金额小计。` : `${summary}。`
}

/** 移除与预算分项状态冲突的自由文本，以结构化预算项目重新说明。 */
function normalizeBudgetEvidenceSummary(
  tradeoffs: string,
  estimate: ItineraryBudgetEstimate | undefined,
  context: Parameters<TravelTool['execute']>[1],
  repairNotes: string[]
): string {
  if (!context.budgetRequested || !estimate) return tradeoffs
  const claims = /(?:预算卡|预算分项|费用分项|来源金额|来源价格|已核实金额|规划估算|估算金额|未知费用|金额小计)/u
  const counts = {
    sourced: estimate.items.filter((item) => item.evidenceLevel === 'sourced').length,
    estimated: estimate.items.filter((item) => item.evidenceLevel === 'estimated').length,
    pending: estimate.items.filter((item) =>
      item.evidenceLevel === 'pending' || item.amountMinFen === null || item.amountMaxFen === null
    ).length
  }
  const unsupportedClaims = [
    ...(counts.sourced ? [] : [/来源金额|来源价格|已核实金额/u]),
    ...(counts.estimated ? [] : [/规划估算|估算金额/u]),
    ...(counts.pending ? [] : [/未知费用|待核验项|待核验费用/u])
  ]
  const clauses = tradeoffs.split(/(?<=[。；;])/u)
  const hasUnsupportedSummary = clauses.some((clause) =>
    claims.test(clause) && unsupportedClaims.some((pattern) => pattern.test(clause))
  )
  const cleanedClauses = hasUnsupportedSummary
    ? clauses.filter((clause) => !claims.test(clause))
    : clauses
  let cleaned = cleanedClauses.join('').trim()
  cleaned = cleaned.replace(/用户要求[^。；;]{0,100}(?:尚未列出|待补|待完善|未提供)[^。；;]*(?:[。；;]|$)/gu, '').trim()
  if (cleanedClauses.length !== clauses.length || cleaned !== tradeoffs.trim()) {
    repairNotes.push('取舍说明中的预算来源状态与预算分项不一致，已按实际证据重写。')
    const budgetSummary = hasUnsupportedSummary ? budgetEvidenceSummary(estimate) : ''
    return [cleaned, budgetSummary].filter(Boolean).join(' ').slice(0, 500)
  }
  return tradeoffs
}

/** 从计划已有的公共交通接驳生成待核验的同段备选，不推断价格或快慢。 */
function budgetTimeComparisonFallback(days: ItineraryDay[]): string | undefined {
  for (const day of days) {
    for (let index = 0; index < day.stops.length - 1; index += 1) {
      const from = day.stops[index]!
      const to = day.stops[index + 1]!
      const transitText = from.transitToNext
      const mode = transitText.match(/地铁|公交|公共交通/u)?.[0]
      if (!mode || !from.name.trim() || !to.name.trim()) continue
      const segment = `${from.name.trim().slice(0, 55)}→${to.name.trim().slice(0, 55)}`
      return `预算友好候选：${segment}沿用计划中的${mode}，票价待核验；更省时候选：同段可查出租车/网约车，是否更快和车费均待核验，不计入已知小计。`
    }
  }
  return undefined
}

/** 用户明确要求的步行负担、休息与费用缺项不能因摘要校验而消失。 */
function requiredPlanTradeoffNotes(
  tradeoffs: string,
  days: ItineraryDay[],
  budgetEstimate: ItineraryBudgetEstimate | undefined,
  context: Parameters<TravelTool['execute']>[1]
): string[] {
  const notes: string[] = []
  const request = `${context.tripBrief?.constraints ?? ''}\n${context.userRequest ?? ''}`
  const budgetTimeComparisonRequested = requestsBudgetTimeComparison(request)
  const comparisonHasChoices = hasCompleteBudgetTimeComparison(tradeoffs)
  if (context.budgetRequested && budgetTimeComparisonRequested && !comparisonHasChoices) {
    const notesText = days.flatMap((day) => day.stops.map((stop) => stop.notes)).join('\n')
    const budgetChoice = labeledTradeoffChoice(tradeoffs, /预算友好/u) ?? labeledTradeoffChoice(notesText, /预算友好/u)
    const timeChoice = labeledTradeoffChoice(tradeoffs, /省时(?:间)?/u) ?? labeledTradeoffChoice(notesText, /省时(?:间)?/u)
    if (budgetChoice && timeChoice && normalizeTradeoffChoice(budgetChoice) !== normalizeTradeoffChoice(timeChoice)) {
      const missingChoices = [
        !labeledTradeoffChoice(tradeoffs, /预算友好/u) ? `预算友好：${budgetChoice}` : '',
        !labeledTradeoffChoice(tradeoffs, /省时(?:间)?/u) ? `省时：${timeChoice}` : ''
      ].filter(Boolean)
      notes.push(`${missingChoices.join('；')}。实际票价和排队时间以当天信息为准。`)
    } else {
      notes.push(budgetTimeComparisonFallback(days) ??
        '用户要求在同一方案中比较预算友好与省时做法；本稿尚未列出两种具体选择，待补。')
    }
  }
  if (context.budgetRequested && budgetEstimate && !/(?:不计入|未计入|未知费用.{0,12}待核验|待核验.{0,12}费用)/u.test(tradeoffs)) {
    const pendingCount = budgetEstimate.items.filter((item) =>
      item.evidenceLevel === 'pending' || item.amountMinFen === null || item.amountMaxFen === null
    ).length
    if (pendingCount) notes.push(`费用分项中 ${pendingCount} 项金额待核验，不计入已知金额小计。`)
  }
  const walkingRequested = /(?:步行负担|步行量|走路负担|走路强度)/u.test(request)
  if (walkingRequested && !/(?:步行负担|步行强度|行走负担|走路负担|徒步强度)/u.test(tradeoffs)) {
    const burden = highIntensityRestRequested(context.tripBrief, context.userRequest)
      ? '按高强度偏好标注为步行负担偏高'
      : '按每日停靠密度标注步行负担'
    notes.push(`${burden}；实际距离与耗时仍以已核验路线为准。`)
  }
  const hasRest = days.some((day) => day.scheduleBlocks.some((block) => block.kind === 'rest' || block.kind === 'buffer'))
  if (hasRest && highIntensityRestRequested(context.tripBrief, context.userRequest) && !/休息|休整|机动/u.test(tradeoffs)) {
    notes.push('高强度多站日已列出可调整的休息/机动时段。')
  }
  return notes
}

/** 将“预算/省时”标签后的第一个具体做法提取出来，忽略缺项描述。 */
function labeledTradeoffChoice(value: string, label: RegExp): string | undefined {
  const matcher = new RegExp(label.source, 'gu')
  for (const match of value.matchAll(matcher)) {
    const index = (match.index ?? 0) + match[0].length
    const tail = value.slice(index).split(/[，,；;。！？\n]/u, 1)[0] ?? ''
    const choice = tail.replace(/^\s*(?:(?:方案|做法|方式|选择)\s*)?(?:(?:是|为|可选|选用|选择|建议|优先|可以|可)\s*)?[:：]?\s*/u, '').trim()
    if (choice.length > 1 && !/^(?:与|和|及|比较|做法|方式|方案|选择|取舍|待补|待选|待核验|未知)/u.test(choice)) {
      return choice
    }
  }
  return undefined
}

/** 判断两种标注是否给出了不同且可审阅的做法。 */
function hasCompleteBudgetTimeComparison(value: string): boolean {
  const budgetChoice = labeledTradeoffChoice(value, /预算友好/u)
  const timeChoice = labeledTradeoffChoice(value, /省时(?:间)?/u)
  return Boolean(budgetChoice && timeChoice && normalizeTradeoffChoice(budgetChoice) !== normalizeTradeoffChoice(timeChoice))
}

/** 识别用户是否明确要求在同一方案里比较预算与时间取舍。 */
function requestsBudgetTimeComparison(value: string): boolean {
  return /(?:预算.{0,24}(?:省时|省时间|节省时间)|(?:省时|省时间|节省时间).{0,24}预算)/u.test(value)
}

/** 规范化选项文字，避免同一做法只换标签后被视为比较。 */
function normalizeTradeoffChoice(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 两种具体做法已经补齐时，移除模型留下的相反缺项提示。 */
function removeResolvedBudgetComparisonPending(value: string): string {
  if (!hasCompleteBudgetTimeComparison(value)) return value
  return value.split(/(?<=[。；;])/u)
    .filter((clause) => !/尚未列出两种具体选择|尚未提供两种具体选择/u.test(clause))
    .join('').replace(/\s{2,}/gu, ' ').trim()
}

/** 允许明确标待核验的缺项说明，拒绝无来源的动态事实断言。 */
function normalizePlanNarrative(
  value: string,
  label: string,
  days: ItineraryDay[],
  fallback: string,
  repairNotes: string[]
): string {
  const dynamicFact = /(?:开放(?:时间|时段|规则)|闭馆|营业时间|票价|门票(?:价格|规则|信息)?|余票|预约|天气|气温|温度|降雨|降水|毛毛雨|小雨|中雨|大雨|雨天|晴天|阴天|多云|风力|风速|客流|人流|路况|免费|免票|低价|便宜|折扣|优惠|(?:路线|交通|通勤).{0,8}(?:已核实|已查|耗时|分钟|小时|公里|票价)|\d+\s*(?:分钟|小时|公里|元)|已查到.{0,8}官方来源|官方(?:网页|渠道|来源).{0,8}(?:确认|支持|发布))/u
  const structuredOnlyFact = /(?:日出|日落|太阳升起|太阳落山|蓝调时段|黄金时段)[^，,；;。！？\n]{0,24}(?:(?:约|大约|在)?\s*(?:[01]?\d|2[0-3]):[0-5]\d|时间|时刻)|(?:拍摄|摄影|照相|航拍)[^，,；;。！？\n]{0,18}(?:禁止|不允许|允许|不得|须|必须|可使用|规则|限制|闪光灯|三脚架|无人机)|(?:禁止|不允许|允许|不得|须|必须)[^，,；;。！？\n]{0,18}(?:拍摄|摄影|照相|航拍|闪光灯|三脚架|无人机)/u
  const pendingMarker = /待核验|待确认|待复核|未查询|未核实|未知|不确定|暂无(?:可靠)?来源|需复核/u
  const exactClaim = /\d+\s*(?:%|％|分钟|小时|公里|元)|免费|免票|低价|便宜|折扣|优惠|无需预约|不需预约|预约成功|可预约|有余票|余票充足|票紧张|抢票|抢约|一票难求|名额有限|限流|(?:人少|游客较少|客流较少)|开放至|票价.{0,4}(?:为|是)|门票价格.{0,4}(?:为|是)/u
  const containsUnstructuredFact = value.split(/[。；;\n]+/u).some((clause) => {
    if (structuredOnlyFact.test(clause)) return true
    if (!dynamicFact.test(clause)) return false
    return !pendingMarker.test(clause) || exactClaim.test(clause)
  })
  const mentionsRest = /休息|午休|休整|机动|缓冲/u.test(value)
  const claimsRestDaily = /(?:每天|每日|逐日|各天|每天下午|每日午后|[零〇一二三四五六七八九十两\d]+天都)/u.test(value) && mentionsRest
  const hasRestBlock = (day: ItineraryDay): boolean => day.scheduleBlocks.some((block) => block.kind === 'rest' || block.kind === 'buffer')
  const restMismatch = mentionsRest && (claimsRestDaily
    ? days.some((day) => !hasRestBlock(day))
    : !days.some(hasRestBlock))

  if (!containsUnstructuredFact && !restMismatch) return value
  repairNotes.push(`${label}含有结构化行程未支持的事实或安排，已改为准确说明。`)
  return fallback
}

/** 将行程卡摘要压到 120 字符内，优先在完整句或分句处收口。 */
function compactPlanSummary(value: string): string {
  const summary = value.trim()
  if (summary.length <= 120) return summary

  const prefix = summary.slice(0, 120)
  const sentenceEnd = Math.max(...['。', '！', '？', '\n'].map((mark) => prefix.lastIndexOf(mark)))
  if (sentenceEnd >= 0) return prefix.slice(0, sentenceEnd + 1).trimEnd()

  const clauseEnd = Math.max(...['；', ';', '，', ','].map((mark) => prefix.lastIndexOf(mark)))
  if (clauseEnd >= 48) return `${prefix.slice(0, clauseEnd).trimEnd()}…`
  return `${prefix.slice(0, 119).trimEnd()}…`
}

/** 对模型返回的日期执行严格日历校验。 */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}
