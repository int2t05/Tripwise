/** 只为已提交行程补充可由原始来源直证的动态事实。 */
import type { ItineraryFactClaim, ItineraryFactType, ItineraryStop } from '../../shared/types.js'
import { MAX_ITINERARY_FACT_QUOTE_CHARACTERS } from '../../shared/itinerary-facts.js'
import { mergeItineraryStopSourceIds } from '../../shared/itinerary-limits.js'
import { itineraryStopNameMatches } from '../../shared/itinerary-revisions.js'
import { itineraryFactRepairTargets, normalizeItineraryFactClaimForRepair } from './itinerary.js'
import { ToolInputError, type ToolContext, type ToolDefinition, type TravelTool } from './types.js'

const REPAIRABLE_FACTS = ['opening-hours', 'booking', 'ticket-price'] as const
type RepairableFact = typeof REPAIRABLE_FACTS[number]
const MAX_FACT_REPAIR_SCHEMA_QUOTES_PER_TYPE = 2
const MAX_FACT_REPAIR_SCHEMA_SOURCES_PER_TYPE = 2
const MAX_FACT_REPAIR_SCHEMA_CHARACTERS = 50_000

/** 读取停靠点对应的待核验动态事实目标。 */
function currentTargets(context: ToolContext) {
  return itineraryFactRepairTargets(
    context.itineraryOptions ?? [],
    {
      openingHours: !!context.openingHoursDetailsRequested,
      booking: !!context.bookingDetailsRequested,
      ticketPrice: !!context.ticketPriceDetailsRequested
    },
    context.unchangedItineraryDates,
    preferredNames(context.tripBrief?.interests)
  )
}

/** 兴趣字段仅用于优先级排序，不把泛化兴趣当作景点名。 */
function preferredNames(value: string | undefined): string[] {
  return (value ?? '').split(/[、,，;；\n]/u).map((name) => name.trim()).filter((name) => name.length >= 2)
}

/** 声明一项只更新事实字段的局部行程修订工具。 */
export const itineraryFactRepairTool: TravelTool = {
  definition: {
    type: 'function',
    function: {
      name: 'propose_itinerary_facts',
      description: '只为已保存草案中的指定景点补充开放/闭馆、预约和票价事实；不得改动其他行程。只能选择提供的 quote_id 并填写适用范围；应用会按编号恢复来源类别和原文。没有适用的原文候选时不提交该条，保留待核验。',
      parameters: {
        type: 'object',
        properties: {
          updates: {
            type: 'array', minItems: 0, maxItems: 24,
            items: {
              type: 'object',
              properties: {
                plan_number: { type: 'integer', minimum: 1, maximum: 3 },
                day_number: { type: 'integer', minimum: 1, maximum: 7 },
                date: { type: 'string', minLength: 1, maxLength: 10 },
                stop_name: { type: 'string', minLength: 1, maxLength: 160 },
                area: { type: 'string', maxLength: 80 },
                claims: {
                  type: 'array', minItems: 1, maxItems: 3,
                  items: {
                    type: 'object',
                    properties: {
                      quote_id: { type: 'string', minLength: 2, maxLength: 12, pattern: '^q[1-9][0-9]*$' },
                      scope: { type: 'string', minLength: 1, maxLength: 100, description: '事实适用范围；若只证实旺季或冬季规则就保留季节范围。写成具体游览日期时，来源原文必须明确该日或覆盖该日的区间。' },
                      evidence_level: { type: 'string', enum: ['sourced'] },
                    },
                    required: ['quote_id', 'scope', 'evidence_level'],
                    additionalProperties: false
                  }
                }
              },
              required: ['plan_number', 'day_number', 'date', 'stop_name', 'area', 'claims'],
              additionalProperties: false
            }
          }
        },
        required: ['updates'],
        additionalProperties: false
      }
    }
  },
  provider: 'Tripwise 行程事实修订',
  kind: 'web',
  sourceUrl: '',
  isAvailable: (context) => currentTargets(context).length > 0,
  /** 校验目标与来源后，只替换对应停靠点中同类型的待核验声明。 */
  async execute(args, context) {
    const options = context.itineraryOptions
    if (!options?.length) throw new ToolInputError('当前没有可修改的行程。', 'itinerary_fact_plan_missing', 'warning')
    const targets = currentTargets(context)
    if (!targets.length) throw new ToolInputError('当前草案没有待核验的指定景点事实。', 'itinerary_fact_targets_missing', 'warning')
    if (!Array.isArray(args.updates) || args.updates.length > targets.length) {
      throw new ToolInputError(`本轮最多可更新 ${targets.length} 个事实目标。`)
    }

    const updated = structuredClone(options)
    const allStopNames = options.flatMap((option) => option.days.flatMap((day) =>
      day.stops.map((stop) => stop.name)
    ))
    const seen = new Set<string>()
    let acceptedCount = 0
    let rejectedCount = 0
    const diagnostics = {
      requestedCount: 0, autoBoundCount: 0, rejectedCount: 0,
      sourceUnavailableCount: 0, sourceIneligibleCount: 0,
      placeMismatchCount: 0, scopeMismatchCount: 0, valueMismatchCount: 0,
      rejectedByType: {} as Partial<Record<ItineraryFactType, number>>
    }
    for (const raw of args.updates as unknown[]) {
      const update = asRecord(raw)
      if (!update) { rejectedCount += 1; continue }
      const target = targets.find((candidate) =>
        candidate.plan_number === update.plan_number && candidate.day_number === update.day_number &&
        candidate.date === update.date && namesMatch(candidate.stop_name, update.stop_name) &&
        normalized(candidate.area) === normalized(update.area)
      )
      if (!target) { rejectedCount += 1; continue }
      const key = `${target.plan_number}\u0000${target.day_number}\u0000${target.date}\u0000${normalized(target.stop_name)}`
      if (seen.has(key) || !Array.isArray(update.claims) || update.claims.length < 1 || update.claims.length > 3) {
        rejectedCount += 1
        continue
      }
      const option = updated[target.plan_number - 1]
      const day = option?.days.find((item) => item.dayNumber === target.day_number && item.date === target.date)
      const stop = day?.stops.find((item) => namesMatch(item.name, target.stop_name) && normalized(item.area ?? '') === normalized(target.area))
      if (!stop) { rejectedCount += 1; continue }

      const sourceBinding = context.factRepairSourceBindings?.find((candidate) =>
        candidate.plan_number === target.plan_number && candidate.day_number === target.day_number &&
        candidate.date === target.date && candidate.stop_name === target.stop_name && candidate.area === target.area
      )
      const allowedSourceIds = context.factRepairSourceBindings
        ? sourceBinding?.source_ids ?? []
        : context.sourceIds ?? []
      let acceptedForTarget = 0
      for (const rawClaim of update.claims) {
        const claimInput = asRecord(rawClaim)
        const quoteId = typeof claimInput?.quote_id === 'string' ? claimInput.quote_id : ''
        // 不采信模型回传的值、类别或来源；只允许从当前目标白名单恢复候选。
        const quote = sourceBinding?.fact_quotes?.flatMap((item) => item.candidates.map((candidate) => ({
          ...candidate, source_id: item.source_id, type: item.type
        }))).find((candidate) => candidate.quote_id === quoteId &&
          REPAIRABLE_FACTS.includes(candidate.type as RepairableFact) &&
          target.missing_facts.includes(candidate.type as RepairableFact) &&
          allowedSourceIds.includes(candidate.source_id))
        if (!claimInput || claimInput.evidence_level !== 'sourced' || !quote) {
          rejectedCount += 1
          diagnostics.rejectedCount = Math.min(999, diagnostics.rejectedCount + 1)
          continue
        }
        try {
          const normalizedClaim = normalizeItineraryFactClaimForRepair(
            {
              type: quote.type,
              value: quote.value,
              scope: claimInput.scope,
              evidence_level: 'sourced',
              source_id: quote.source_id
            }, stop.name, allowedSourceIds, context.availableSources ?? [], allStopNames
          )
          Object.assign(diagnostics, addDiagnostics(diagnostics, normalizedClaim.diagnostics))
          const claim = normalizedClaim.claim
          if (claim.evidenceLevel !== 'sourced' || !claim.sourceId) {
            rejectedCount += 1
            continue
          }
          const result = mergeFact(stop, claim)
          if (result === 'rejected') { rejectedCount += 1; continue }
          if (result === 'added') acceptedCount += 1
          acceptedForTarget += 1
        } catch {
          rejectedCount += 1
          diagnostics.rejectedCount = Math.min(999, diagnostics.rejectedCount + 1)
        }
      }
      if (acceptedForTarget > 0) seen.add(key)
    }

    const exactQuoteHint = diagnostics.valueMismatchCount > 0
      ? '事实值必须复制对应正文中的连续原文；无法复制时省略该条。'
      : ''
    const scopeHint = diagnostics.scopeMismatchCount > 0
      ? '原文未证明该开放时段适用于所填日期；只提交正文明确覆盖的日期或季节范围，无法确认时保留待核验。'
      : ''
    const remainingTargetCount = currentTargets({ ...context, itineraryOptions: updated }).length
    return {
      output: acceptedCount > 0
        ? `已补充 ${acceptedCount} 条有来源直证的景点事实。${rejectedCount ? `${rejectedCount} 项证据不足；` : ''}其余内容仍待核验。${exactQuoteHint}${scopeHint}`
        : `没有找到能直接证明的景点事实；原草案保留，缺项仍待核验。${rejectedCount ? `${rejectedCount} 项未采纳。` : ''}${exactQuoteHint}${scopeHint}`,
      sources: [],
      feedback: [
        ...(rejectedCount ? [{
          severity: 'warning' as const,
          code: 'itinerary_fact_evidence_rejected',
          message: `${rejectedCount} 条事实声明未通过来源、地点或范围核对。${exactQuoteHint}${scopeHint}`
        }] : []),
        ...(remainingTargetCount ? [{
          severity: 'warning' as const,
          code: 'itinerary_facts_pending',
          message: `${remainingTargetCount} 个景点仍有开放时间、预约或票价信息待核验。`
        }] : [])
      ],
      itineraryOptions: updated,
      itineraryFactEvidenceDiagnostics: diagnostics
    }
  }
}

/** 事实修订的来源 ID 按目标地点收窄，避免模型跨景点引用。 */
export function itineraryFactRepairDefinitionForSourceBindings(
  bindings: NonNullable<ToolContext['factRepairSourceBindings']>
): ToolDefinition {
  const buildDefinition = (maxQuotesPerType: number, maxSourcesPerType: number): ToolDefinition => {
    const definition = structuredClone(itineraryFactRepairTool.definition)
    const updates = (definition.function.parameters.properties as Record<string, Record<string, unknown>>).updates
    const baseItem = updates.items as Record<string, unknown>
    const baseProperties = baseItem.properties as Record<string, unknown>
    const baseClaims = baseProperties.claims as Record<string, unknown>
    const baseClaimItem = baseClaims.items as Record<string, unknown>
    const baseClaimProperties = baseClaimItem.properties as Record<string, unknown>
    const branches = bindings.flatMap((binding) => {
      if (binding.source_ids.length === 0) return []
      const selectedQuoteIds: string[] = []
      const seenQuoteIds = new Set<string>()
      const valuesByType = new Map<RepairableFact, Set<string>>()
      const sourcesByType = new Map<RepairableFact, Set<string>>()
      if (maxQuotesPerType > 0 && maxSourcesPerType > 0) {
        for (const quote of binding.fact_quotes ?? []) {
          const factType = quote.type as RepairableFact
          if (!binding.source_ids.includes(quote.source_id) || !REPAIRABLE_FACTS.includes(factType)) continue
          const values = valuesByType.get(factType) ?? new Set<string>()
          const sources = sourcesByType.get(factType) ?? new Set<string>()
          for (const candidate of quote.candidates) {
            if (!candidate.quote_id || candidate.quote_id.length > 12 ||
                candidate.value.length === 0 || candidate.value.length > MAX_ITINERARY_FACT_QUOTE_CHARACTERS ||
                seenQuoteIds.has(candidate.quote_id)) continue
            const newSource = !sources.has(quote.source_id)
            if (newSource && sources.size >= maxSourcesPerType) continue
            const newValue = !values.has(candidate.value)
            if (newValue && values.size >= maxQuotesPerType) continue
            selectedQuoteIds.push(candidate.quote_id)
            seenQuoteIds.add(candidate.quote_id)
            values.add(candidate.value)
            sources.add(quote.source_id)
          }
          valuesByType.set(factType, values)
          sourcesByType.set(factType, sources)
        }
      }
      if (!selectedQuoteIds.length) return []
      const claimProperties = {
        quote_id: { ...(baseClaimProperties.quote_id as Record<string, unknown>), enum: selectedQuoteIds },
        scope: baseClaimProperties.scope,
        evidence_level: baseClaimProperties.evidence_level
      }
      return [{
        type: 'object',
        properties: {
          plan_number: { type: 'integer', enum: [binding.plan_number] },
          day_number: { type: 'integer', enum: [binding.day_number] },
          date: { type: 'string', enum: [binding.date] },
          stop_name: { type: 'string', enum: [binding.stop_name] },
          area: { type: 'string', enum: [binding.area] },
          claims: {
            type: 'array', minItems: 1, maxItems: 3,
            items: {
              type: 'object', properties: claimProperties,
              required: baseClaimItem.required, additionalProperties: false
            }
          }
        },
        required: baseItem.required,
        additionalProperties: false
      }]
    })
    updates.maxItems = branches.length
    updates.items = branches.length ? { oneOf: branches } : { type: 'object' }
    return definition
  }

  // 大行程先缩减可选编号；即使 schema 超限也不允许模型提交自由文本事实值。
  for (const [quoteLimit, sourceLimit] of [
    [MAX_FACT_REPAIR_SCHEMA_QUOTES_PER_TYPE, MAX_FACT_REPAIR_SCHEMA_SOURCES_PER_TYPE],
    [1, 1],
    [0, 0]
  ]) {
    const definition = buildDefinition(quoteLimit, sourceLimit)
    if (JSON.stringify(definition).length <= MAX_FACT_REPAIR_SCHEMA_CHARACTERS) return definition
  }
  return buildDefinition(0, 0)
}

/** 将局部事实更新绑定到唯一的计划日期和停靠点，避免更改其他日程。 */
function mergeFact(stop: ItineraryStop, incoming: ItineraryFactClaim): 'added' | 'duplicate' | 'rejected' {
  const claims = [...(stop.factClaims ?? [])]
  if (claims.some((claim) => claim.type === incoming.type && claim.scope === incoming.scope &&
      claim.value === incoming.value && claim.sourceId === incoming.sourceId && claim.evidenceLevel === 'sourced')) {
    return 'duplicate'
  }
  const replaceIndex = claims.findIndex((claim) => claim.type === incoming.type &&
    claim.evidenceLevel === 'pending' && claim.scope === incoming.scope)
  const fallbackIndex = replaceIndex >= 0 ? replaceIndex : claims.findIndex((claim) =>
    claim.type === incoming.type && claim.evidenceLevel === 'pending'
  )
  if (fallbackIndex >= 0) claims.splice(fallbackIndex, 1, incoming)
  else if (claims.length < 8) claims.push(incoming)
  else return 'rejected'
  stop.factClaims = claims
  stop.sourceIds = mergeItineraryStopSourceIds(stop.sourceIds, [incoming.sourceId!])
  if (stop.evidenceLevel === 'pending') stop.evidenceLevel = 'sourced'
  return 'added'
}

/** 合并同一声明的证据诊断计数。 */
function addDiagnostics<T extends {
  requestedCount: number; autoBoundCount: number; rejectedCount: number;
  sourceUnavailableCount: number; sourceIneligibleCount: number;
  placeMismatchCount: number; scopeMismatchCount: number; valueMismatchCount: number;
  rejectedByType: Partial<Record<ItineraryFactType, number>>
}>(current: T, incoming: T): T {
  const rejectedByType = { ...current.rejectedByType }
  for (const [type, count] of Object.entries(incoming.rejectedByType) as Array<[ItineraryFactType, number]>) {
    rejectedByType[type] = (rejectedByType[type] ?? 0) + count
  }
  return {
    ...current,
    requestedCount: current.requestedCount + incoming.requestedCount,
    autoBoundCount: current.autoBoundCount + incoming.autoBoundCount,
    rejectedCount: current.rejectedCount + incoming.rejectedCount,
    sourceUnavailableCount: current.sourceUnavailableCount + incoming.sourceUnavailableCount,
    sourceIneligibleCount: current.sourceIneligibleCount + incoming.sourceIneligibleCount,
    placeMismatchCount: current.placeMismatchCount + incoming.placeMismatchCount,
    scopeMismatchCount: current.scopeMismatchCount + incoming.scopeMismatchCount,
    valueMismatchCount: current.valueMismatchCount + incoming.valueMismatchCount,
    rejectedByType
  }
}

/** 安全读取模型输入对象，拒绝数组和空值。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** 允许常见简称匹配，但要求更新仍落在同一天的同一地点。 */
function namesMatch(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && typeof right === 'string' && itineraryStopNameMatches(left, right)
}

/** 统一地点区域格式，防止空白差异造成目标误判。 */
function normalized(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() : ''
}
