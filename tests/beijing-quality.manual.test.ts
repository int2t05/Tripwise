/** 手动联测北京行程质量、模型修订和地图地理编码诊断。 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { TravelAgent } from '../src/main/agent.js'
import { classifyRejectedToolOutput } from '../src/main/agent-itinerary-policy.js'
import { initialAttractionSearches } from '../src/main/agent-research.js'
import { itineraryDetailFeedback, mealPreferenceFeedback } from '../src/main/connectors/itinerary.js'
import { TripStore } from '../src/main/persistence.js'
import { DEFAULT_SETTINGS } from '../src/main/persistence/schema.js'
import { SecretVault } from '../src/main/secrets.js'
import { configureExternalFetcher } from '../src/main/connectors/http.js'
import { amapRequestScheduler } from '../src/main/connectors/amap-request-scheduler.js'
import { classifyError, configureSystemLogger, flushSystemLogs, isSafeTransportCode } from '../src/main/system-logger.js'
import { requiredMealSlotsForRequest } from '../src/main/agent-tool-policy.js'
import { itineraryPlaceNameAliases } from '../src/shared/itinerary-facts.js'
import type { AgentRunProgress, ItineraryOption, SourceRecord, TripBrief } from '../src/shared/types.js'
import { defaultTripwiseUserDataDirectory } from './helpers/manual-profile.js'

const enabled = process.env.TRIPWISE_BEIJING_LIVE_EVAL === '1'
const revisionEvaluationEnabled = process.env.TRIPWISE_BEIJING_LIVE_REVISION_EVAL === '1'
const geocodeVariantProbeEnabled = process.env.TRIPWISE_BEIJING_GEOCODE_VARIANT_PROBE === '1'
const profileDirectory = resolve(process.env.TRIPWISE_USER_DATA_DIR?.trim() || defaultTripwiseUserDataDirectory())
const statusPrefix = '[beijing-live]'

it('地理编码 30001 变体探针只输出脱敏特征', async () => {
  const address = '测试用北京市海淀区示例地点'
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input))
    const payload = requestUrl.searchParams.get('city') === '北京'
      ? { status: '0', infocode: '30001' }
      : { status: '1', infocode: '10000', geocodes: [{ location: '116.000000,39.000000', level: '兴趣点' }] }
    return new Response(JSON.stringify(payload), { status: 200 })
  })
  try {
    const result = await replayGeocodeVariants([{ address, city: '北京' }], 'unit-test-key')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      probe: 1,
      cityFilterPresent: true,
      addressShape: { startsWithBeijing: false, hasAdministrativeSuffix: false }
    })
    const variants = result[0]?.variants as Array<Record<string, unknown>>
    expect(variants[0]).toMatchObject({ variant: 'original', status: 'provider_error', errorCode: '30001' })
    expect(variants[1]).toMatchObject({ variant: 'without-city', status: 'ok', preciseCount: 1 })
    expect(JSON.stringify(result)).not.toContain(address)
    expect(JSON.stringify(result)).not.toContain('unit-test-key')
  } finally {
    vi.unstubAllGlobals()
  }
})

/** 保留最后一次内存恢复点，供完整规划结束后输出脱敏诊断。 */
class CapturingTripStore extends TripStore {
  latestRunProgress?: AgentRunProgress
  firstValidDraftMs?: number
  draftAndPreparationMs?: number
  private runStartedAt?: number

  /** 记录首份有效草案和准备清单的实际生成耗时。 */
  startRunMeasurement(startedAt: number): void {
    this.runStartedAt = startedAt
  }

  override async updateAgentRunProgress(tripId: string, messageId: string, progress: AgentRunProgress): Promise<void> {
    this.latestRunProgress = structuredClone(progress)
    const elapsedMs = this.runStartedAt === undefined ? undefined : Date.now() - this.runStartedAt
    if (elapsedMs !== undefined) {
      if (this.firstValidDraftMs === undefined && progress.itineraryOptions.length > 0) {
        this.firstValidDraftMs = elapsedMs
      }
      if (this.draftAndPreparationMs === undefined && progress.itineraryOptions.length > 0 &&
          progress.preparationOptions.length > 0) {
        this.draftAndPreparationMs = elapsedMs
      }
    }
    await super.updateAgentRunProgress(tripId, messageId, progress)
  }
}

/** 只输出候选失败类别，不回显旅行文本、网页正文或模型返回内容。 */
function proposalFailureCategories(progress?: AgentRunProgress): Record<string, number> {
  if (!progress) return {}
  const proposalCallIds = new Set(progress.transcript.flatMap((message) => message.role === 'assistant'
    ? (message.tool_calls ?? []).filter((call) => call.function.name === 'propose_itineraries').map((call) => call.id)
    : []))
  const categories: Record<string, number> = {}
  for (const message of progress.transcript) {
    if (message.role !== 'tool' || !message.tool_call_id || !proposalCallIds.has(message.tool_call_id)) continue
    try {
      const result = JSON.parse(message.content ?? '{}') as { result?: unknown }
      if (typeof result.result !== 'string') continue
      const text = result.result.split(/\n修订提示(?:：|:)/u, 1)[0]?.trim() ?? result.result
      const category = classifyRejectedToolOutput('propose_itineraries', text)
      categories[category] = (categories[category] ?? 0) + 1
      if (category === 'requested_detail') {
        const detailTypes = [
          ['stop_time_missing', /缺少可执行的游览时段/u],
          ['schedule_block_time_missing', /缺少明确开始时刻和时长/u],
          ['transit_endpoint_missing', /缺少交通方式或明确终点/u],
          ['opening_fact_missing', /缺少开放\/闭馆事实/u],
          ['booking_fact_missing', /缺少预约事实/u],
          ['contingency_missing', /缺少天气\/人流\/延误变化时的调整或替代安排/u]
        ] as const
        for (const [detailType, pattern] of detailTypes) {
          const count = text.split('\n').filter((line) => pattern.test(line)).length
          if (count) categories[detailType] = (categories[detailType] ?? 0) + count
        }
      }
      if (['schedule_overlap', 'schedule_constraint', 'schedule_order', 'arrival_buffer', 'departure_buffer']
        .includes(category)) {
        const reasons = {
          schedule_overlap: /时间重叠/u.test(text),
          schedule_order: /时段早于|计划时间早于/u.test(text),
          arrival_boundary: /抵达时间|不晚于抵达|抵达后/u.test(text),
          departure_boundary: /离开时间|不早于离开/u.test(text),
          route_buffer: /还需约.{0,12}分钟通勤/u.test(text)
        }
        for (const [reason, matched] of Object.entries(reasons)) {
          if (matched) categories[reason] = (categories[reason] ?? 0) + 1
        }
        const departureTimes = text.match(/计划在\s*((?:[01]\d|2[0-3]):[0-5]\d)\s*结束，不早于离开时间\s*((?:[01]\d|2[0-3]):[0-5]\d)/u)
        if (departureTimes) {
          const key = `departure_end_${departureTimes[1]}_anchor_${departureTimes[2]}`
          categories[key] = (categories[key] ?? 0) + 1
        }
      }
    } catch {
      categories.invalid_tool_result = (categories.invalid_tool_result ?? 0) + 1
    }
  }
  return categories
}

/** 从工具校验反馈提取脱敏短句，定位拒绝原因但不回显地点名。 */
function proposalFailureDetails(progress?: AgentRunProgress): string[] {
  if (!progress) return []
  const proposalCallIds = new Set(progress.transcript.flatMap((message) => message.role === 'assistant'
    ? (message.tool_calls ?? []).filter((call) => call.function.name === 'propose_itineraries').map((call) => call.id)
    : []))
  const details: string[] = []
  for (const message of progress.transcript) {
    if (message.role !== 'tool' || !message.tool_call_id || !proposalCallIds.has(message.tool_call_id)) continue
    try {
      const result = JSON.parse(message.content ?? '{}') as { result?: unknown }
      if (typeof result.result !== 'string') continue
      const summary = result.result.split(/\n修订提示(?:：|:)/u, 1)[0] ?? ''
      const safeLines = summary.split('\n').slice(0, 6).map((line) => line
        .replace(/“[^”]{1,160}”/gu, '“项目”')
        .replace(/https?:\/\/\S+/gu, '[链接]')
        .replace(/\s+/gu, ' ')
        .slice(0, 180))
      details.push(...safeLines.filter(Boolean))
    } catch {
      details.push('invalid_tool_result')
    }
  }
  return details.slice(-12)
}

/** 仅保留日期、冲突类别和时钟时刻，帮助定位日程校验问题且不回显地点名称。 */
function proposalScheduleDiagnostics(progress?: AgentRunProgress): Array<{ date?: string; category: string; times: string[]; itemKinds?: string[] }> {
  if (!progress) return []
  const proposalCallIds = new Set(progress.transcript.flatMap((message) => message.role === 'assistant'
    ? (message.tool_calls ?? []).filter((call) => call.function.name === 'propose_itineraries').map((call) => call.id)
    : []))
  const diagnostics: Array<{ date?: string; category: string; times: string[] }> = []
  for (const message of progress.transcript) {
    if (message.role !== 'tool' || !message.tool_call_id || !proposalCallIds.has(message.tool_call_id)) continue
    try {
      const result = JSON.parse(message.content ?? '{}') as { result?: unknown }
      if (typeof result.result !== 'string') continue
      for (const line of result.result.split('\n')) {
        const category = /时间重叠/u.test(line) ? 'schedule_overlap'
          : /不晚于抵达时间/u.test(line) ? 'arrival_boundary'
            : /不早于离开时间/u.test(line) ? 'departure_boundary'
              : /时段早于|计划时间早于/u.test(line) ? 'time_order' : undefined
        if (!category) continue
        const times = [...line.matchAll(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu)]
          .map((match) => `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`)
        const itemKinds = [...line.matchAll(/“([^”]{1,100})”/gu)].map((match) => {
          const label = match[1]
          if (/早餐|午餐|晚餐|餐|店/u.test(label)) return 'meal'
          if (/酒店|住宿|寄存|退房/u.test(label)) return 'lodging'
          if (/交通|地铁|公交|动车|高铁|车站|机场|接驳|火车|航班/u.test(label)) return 'transit'
          if (/休息|休整|午休/u.test(label)) return 'rest'
          if (/景|园|宫|馆|寺|长城|广场|胡同/u.test(label)) return 'attraction'
          return 'other'
        })
        diagnostics.push({
          ...(line.match(/\d{4}-\d{2}-\d{2}/u)?.[0] ? { date: line.match(/\d{4}-\d{2}-\d{2}/u)![0] } : {}),
          category,
          times,
          ...(itemKinds.length ? { itemKinds } : {})
        })
      }
    } catch {
      continue
    }
  }
  return diagnostics
}

/** 失败时也只统计来源服务名称与数量，避免测试输出旅行正文。 */
function sourceProviderCounts(store: TripStore): Record<string, number> {
  const sources = store.snapshot().trips[0]?.sources ?? []
  return Object.fromEntries([...new Set(sources.map((source) => source.provider))].sort()
    .map((provider) => [provider, sources.filter((source) => source.provider === provider).length]))
}

/** 失败时只输出方案数、准备事项数和工具计数，不暴露对话或工具参数。 */
function safeRunStateSummary(progress?: AgentRunProgress): Record<string, unknown> {
  if (!progress) return { available: false }
  const transcript = progress.transcript
  const resultIds = new Set(transcript.flatMap((message) => message.role === 'tool' && message.tool_call_id
    ? [message.tool_call_id]
    : []))
  const calls = transcript.flatMap((message) => message.role === 'assistant' ? message.tool_calls ?? [] : [])
  const toolCounts = Object.fromEntries([...new Set(calls.map((call) => call.function.name))].sort()
    .map((name) => [name, calls.filter((call) => call.function.name === name).length]))
  return {
    itineraryCount: progress.itineraryOptions.length,
    preparationCount: progress.preparationOptions.length,
    toolCounts,
    briefProposalFields: Object.keys(progress.briefProposal?.changes ?? {}).sort(),
    recentTools: calls.slice(-6).map((call) => call.function.name),
    pendingTools: calls.filter((call) => !resultIds.has(call.id)).map((call) => call.function.name)
  }
}

/** 只汇总餐次缺口类型，不记录商户名或完整反馈内容。 */
function safeMealGapSummary(gaps: string[]): Record<string, number> {
  return {
    missingSlots: gaps.filter((gap) => /缺少(?:早餐|午餐|晚餐)/u.test(gap)).length,
    cancelledSlots: gaps.filter((gap) => /取消的(?:早餐|午餐|晚餐)/u.test(gap)).length,
    unnamedStoreRequirements: gaps.filter((gap) => gap.includes('具体店面待选')).length
  }
}

/** 只提取餐次修订的数量，不输出店名、参数或工具正文。 */
function safeMealRepairProgress(progress?: AgentRunProgress): Array<{
  accepted: number
  targeted: number
  rejected: number
  rejectionCategories: string[]
}> {
  if (!progress) return []
  const mealCallIds = new Set(progress.transcript.flatMap((message) => message.role === 'assistant'
    ? (message.tool_calls ?? []).filter((call) => call.function.name === 'propose_itinerary_meals').map((call) => call.id)
    : []))
  return progress.transcript.flatMap((message) => {
    if (message.role !== 'tool' || !message.tool_call_id || !mealCallIds.has(message.tool_call_id)) return []
    try {
      const result = JSON.parse(message.content ?? '{}') as { result?: unknown }
      if (typeof result.result !== 'string') return []
      const accepted = result.result.match(/已修订\s*(\d+)\/(\d+)\s*个待补餐次/u)
      if (!accepted) return []
      return [{
        accepted: Number(accepted[1]),
        targeted: Number(accepted[2]),
        rejected: Number(result.result.match(/另有\s*(\d+)\s*项未采纳/u)?.[1] ?? 0),
        rejectionCategories: summarizeMealRepairRejectionCategories(result.result)
      }]
    } catch {
      return []
    }
  })
}

/** 只输出准备清单成功状态、固定拒绝类别和用户要求的类别标签。 */
function safePreparationRepairProgress(progress?: AgentRunProgress): Array<{
  accepted: boolean
  rejectionCategory?: string
  missingCategories?: string[]
}> {
  if (!progress) return []
  const toolCallIds = new Set(progress.transcript.flatMap((message) => message.role === 'assistant'
    ? (message.tool_calls ?? []).filter((call) => call.function.name === 'propose_preparation').map((call) => call.id)
    : []))
  const labelToCategory: Record<string, string> = {
    '预约/购票': 'booking', '行李': 'packing', '穿搭': 'clothing', '餐饮': 'food',
    '备选预案': 'alternative', '交通': 'transport', '其他': 'other'
  }
  return progress.transcript.flatMap((message) => {
    if (message.role !== 'tool' || !message.tool_call_id || !toolCallIds.has(message.tool_call_id)) return []
    try {
      const result = JSON.parse(message.content ?? '{}') as { result?: unknown }
      if (typeof result.result !== 'string') return []
      const missing = result.result.match(/准备清单缺少用户明确要求的\s*([^；。]+)\s*事项/u)?.[1]
        ?.split('、').map((label) => labelToCategory[label]).filter((category): category is string => !!category)
      const accepted = result.result.includes('准备清单有 ')
      const category = accepted ? undefined : classifyRejectedToolOutput('propose_preparation', result.result)
      const specialCategory = category === 'preparation_validation' && /packing_section|装包位置/u.test(result.result)
        ? 'packing_section'
        : category
      return [{ accepted, ...(specialCategory ? { rejectionCategory: specialCategory } : {}), ...(missing?.length ? { missingCategories: missing } : {}) }]
    } catch {
      return [{ accepted: false, rejectionCategory: 'invalid_tool_result' }]
    }
  })
}

/** 只归类工具汇总中的固定拒绝原因，不记录店名、日期或原始参数。 */
function summarizeMealRepairRejectionCategories(output: string): string[] {
  const match = output.match(/另有\s*\d+\s*项未采纳：(.+?)(?:。其余缺口|$)/u)
  if (!match) return []
  const reasons = match[1]?.split('；') ?? []
  return [...new Set(reasons.map((reason) => classifyRejectedToolOutput('propose_itinerary_meals', reason)))]
}

it('餐次修订诊断只记录固定拒绝类别', () => {
  const categories = summarizeMealRepairRejectionCategories(
    '已修订 1/3 个待补餐次。本批另有 2 项未采纳：请提交可识别的餐馆名称，不要使用附近餐馆等泛称；待核验餐馆不能挂接未直接支持名称的来源；请清空 source_ids。其余缺口会在下一轮继续处理。'
  )
  expect(categories).toContain('named_meal_placeholder')
  expect(categories).toContain('named_meal_pending_source_mismatch')
  expect(categories).not.toContain('附近餐馆')
})

it('北京轻松化修改按实际停留点判断删除，不把说明中的旧点位算作行程', () => {
  const plan = {
    days: [{
      date: '2026-09-23',
      stops: [
        { name: '颐和园', area: '', time: '08:00', durationMinutes: 240, category: '景点', notes: '原计划香山与碧云寺已删除。' },
        { name: '午餐', area: '颐和园附近', time: '12:15', durationMinutes: 45, category: '餐饮', notes: '' }
      ],
      scheduleBlocks: [{
        kind: 'rest', title: '酒店休息', time: '13:00', durationMinutes: 60, area: '酒店', notes: '午餐后回酒店休息。'
      }]
    }]
  } as unknown as ItineraryOption

  expect(isBeijingRevisionRequestSatisfied(plan, '2026-09-23', 1)).toBe(true)
})

/** 使用校验器的原始分类短语统计细节缺口，避免分组标签遗漏子类。 */
function safeItineraryDetailGapSummary(gaps: string[]): Record<string, number> {
  const categories = {
    stopTime: '缺少可执行的游览时段',
    blockTime: '缺少明确开始时刻和时长',
    transit: '缺少交通方式或明确终点',
    opening: '缺少开放/闭馆事实',
    booking: '缺少预约事实',
    contingency: '缺少天气/人流/延误变化时的调整或替代安排'
  }
  return Object.fromEntries(Object.entries(categories).map(([key, phrase]) => [
    key, gaps.filter((gap) => gap.includes(phrase)).length
  ]))
}

/** 按简报地点计数定向查询，并记录正文关键词线索；不输出地点或查询文本。 */
function factResearchCoverage(
  progress: AgentRunProgress | undefined,
  sources: SourceRecord[],
  options: ItineraryOption[],
  attractionNames: string[]
): Record<string, unknown> {
  const stops = options.flatMap((option) => option.days.flatMap((day) => day.stops))
  const aliasesByStop = stops.map((stop) => itineraryPlaceNameAliases(stop.name))
  const includesStop = (value: string, aliases: string[]): boolean => {
    const normalized = value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase()
    return aliases.some((alias) => normalized.includes(alias))
  }
  const modelSearchQueries = progress?.transcript.flatMap((message) => message.role === 'assistant'
    ? (message.tool_calls ?? []).flatMap((call) => {
        if (call.function.name !== 'search_web') return []
        try {
          const args = JSON.parse(call.function.arguments) as { query?: unknown }
          return typeof args.query === 'string' ? [args.query] : []
        } catch {
          return []
        }
      })
    : []) ?? []
  const normalizedTargets = attractionNames.map((name) => name.normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase()).filter((name) => name.length >= 2)
  const matchingWebSourcesByStop = aliasesByStop.map((aliases) => sources.filter((source) =>
    source.kind === 'web' && source.status === 'success' &&
    includesStop(`${source.title} ${source.url} ${source.summary}`, aliases)
  ))
  const matchingFactSources = (stopIndex: number, type: string): SourceRecord[] => {
    const terms = factTerms(type)
    return (matchingWebSourcesByStop[stopIndex] ?? []).filter((source) =>
      source.contentLevel === 'page' && terms.test(source.summary)
    )
  }
  const factTerms = (type: string): RegExp => type === 'opening-hours'
    ? /开放|营业|闭馆|闭园|停止入园|停止售票|周一|周末|旺季|淡季|opening|closing/iu
    : /预约|实名|购票|门票|售票|ticket|reservation|booking/iu
  const targetedQueries = modelSearchQueries.filter((query) => {
    const normalized = query.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase()
    return normalizedTargets.some((target) => normalized.includes(target))
  })
  const pageBodySourceCount = sources.filter((source) =>
    source.kind === 'web' && source.status === 'success' && source.contentLevel === 'page'
  ).length
  const stopIndicesWithWebSource = new Set<number>()
  const stopIndicesWithPageBody = new Set<number>()
  let pendingFacts = 0
  let pendingFactsWithMatchingBody = 0
  let pendingFactsWithMatchingBodyLinked = 0
  let openingFacts = 0
  let bookingFacts = 0
  let openingFactsWithMatchingBody = 0
  let bookingFactsWithMatchingBody = 0
  let openingFactsWithMatchingBodyLinked = 0
  let bookingFactsWithMatchingBodyLinked = 0
  let pendingFactsWithVenueTitleMatch = 0
  let pendingFactsWithVenueBodyMatch = 0
  let pendingFactsWithTypeTermBody = 0
  let pendingFactsWithMultipleMatchingBodies = 0
  stops.forEach((stop, index) => {
    const matchingWebSources = matchingWebSourcesByStop[index] ?? []
    if (matchingWebSources.length > 0) stopIndicesWithWebSource.add(index)
    if (matchingWebSources.some((source) => source.contentLevel === 'page')) stopIndicesWithPageBody.add(index)
    for (const fact of stop.factClaims ?? []) {
      if (fact.type === 'opening-hours') openingFacts += 1
      if (fact.type === 'booking') bookingFacts += 1
      if (fact.evidenceLevel !== 'pending' || !['opening-hours', 'booking'].includes(fact.type)) continue
      pendingFacts += 1
      const matchingBodies = matchingFactSources(index, fact.type)
      const venuePages = matchingWebSources.filter((source) => source.contentLevel === 'page')
      if (venuePages.some((source) => includesStop(`${source.title} ${source.url}`, aliasesByStop[index] ?? []))) {
        pendingFactsWithVenueTitleMatch += 1
      }
      if (venuePages.some((source) => includesStop(source.summary, aliasesByStop[index] ?? []))) {
        pendingFactsWithVenueBodyMatch += 1
      }
      if (sources.some((source) => source.kind === 'web' && source.status === 'success' &&
        source.contentLevel === 'page' && factTerms(fact.type).test(source.summary))) {
        pendingFactsWithTypeTermBody += 1
      }
      if (matchingBodies.length > 1) pendingFactsWithMultipleMatchingBodies += 1
      const hasMatchingBody = matchingBodies.length > 0
      if (hasMatchingBody) pendingFactsWithMatchingBody += 1
      if (fact.type === 'opening-hours' && hasMatchingBody) openingFactsWithMatchingBody += 1
      if (fact.type === 'booking' && hasMatchingBody) bookingFactsWithMatchingBody += 1
      const linkedMatchingBody = !!fact.sourceId && matchingBodies.some((source) => source.id === fact.sourceId)
      if (linkedMatchingBody) pendingFactsWithMatchingBodyLinked += 1
      if (fact.type === 'opening-hours' && linkedMatchingBody) openingFactsWithMatchingBodyLinked += 1
      if (fact.type === 'booking' && linkedMatchingBody) bookingFactsWithMatchingBodyLinked += 1
    }
  })
  return {
    modelSearchQueries: { total: modelSearchQueries.length, attractionTargeted: targetedQueries.length },
    sources: {
      stopsWithMatchingWebSource: stopIndicesWithWebSource.size,
      stopsWithPageBody: stopIndicesWithPageBody.size,
      pageBodySourceCount,
      openingFacts,
      bookingFacts,
      pendingFacts,
      pendingFactsWithMatchingBody,
      pendingFactsWithMatchingBodyLinked,
      openingFactsWithMatchingBody,
      bookingFactsWithMatchingBody,
      openingFactsWithMatchingBodyLinked,
      bookingFactsWithMatchingBodyLinked,
      pendingFactsWithVenueTitleMatch,
      pendingFactsWithVenueBodyMatch,
      pendingFactsWithTypeTermBody,
      pendingFactsWithMultipleMatchingBodies
    }
  }
}

/** 对比最终通过候选的原始事实状态与保存结果，分辨模型谨慎降级和来源 ID 失效。 */
function proposalFactEvidenceBehavior(
  progress: AgentRunProgress | undefined,
  sources: SourceRecord[],
  options: ItineraryOption[]
): Record<string, unknown> {
  const resultByCall = new Map<string, string>()
  for (const message of progress?.transcript ?? []) {
    if (message.role !== 'tool' || !message.tool_call_id) continue
    try {
      const value = JSON.parse(message.content ?? '{}') as { result?: unknown }
      if (typeof value.result === 'string') resultByCall.set(message.tool_call_id, value.result)
    } catch {
      continue
    }
  }
  const acceptedCalls = (progress?.transcript ?? []).flatMap((message) => message.role === 'assistant'
    ? (message.tool_calls ?? []).filter((call) => call.function.name === 'propose_itineraries' &&
      resultByCall.get(call.id)?.startsWith('已生成 1 份待审阅草案')).map((call) => call.function.arguments)
    : [])
  const sourceIds = new Set(sources.filter((source) => source.status === 'success').map((source) => source.id))
  const submitted: Record<string, number> = {}
  const sourceBindingByType: Record<string, {
    sourcedAvailable: number
    sourcedUnavailable: number
    sourcedWithoutSource: number
    pendingAvailable: number
    pendingUnavailable: number
    pendingWithoutSource: number
  }> = {}
  let submittedSourcedWithAvailableSource = 0
  let submittedSourcedWithUnavailableSource = 0
  let submittedPendingWithSource = 0
  for (const rawArguments of acceptedCalls.slice(-1)) {
    try {
      const value = JSON.parse(rawArguments) as {
        plan?: {
          days?: Array<{
            stops?: Array<{
              fact_claims?: Array<{
                type?: unknown
                evidence_level?: unknown
                source_id?: unknown
              }>
            }>
          }>
        }
      }
      for (const day of value.plan?.days ?? []) {
        for (const stop of day.stops ?? []) {
          for (const fact of stop.fact_claims ?? []) {
            const type = typeof fact.type === 'string' ? fact.type : 'unknown'
            const level = fact.evidence_level === 'sourced' ? 'sourced' : 'pending'
            const key = `${type}:${level}`
            submitted[key] = (submitted[key] ?? 0) + 1
            const hasSourceId = typeof fact.source_id === 'string' && fact.source_id.length > 0
            const sourceAvailable = hasSourceId && sourceIds.has(fact.source_id as string)
            const binding = sourceBindingByType[type] ?? (sourceBindingByType[type] = {
              sourcedAvailable: 0, sourcedUnavailable: 0, sourcedWithoutSource: 0,
              pendingAvailable: 0, pendingUnavailable: 0, pendingWithoutSource: 0
            })
            if (level === 'sourced') {
              if (!hasSourceId) binding.sourcedWithoutSource += 1
              else if (sourceAvailable) {
                binding.sourcedAvailable += 1
                submittedSourcedWithAvailableSource += 1
              } else {
                binding.sourcedUnavailable += 1
                submittedSourcedWithUnavailableSource += 1
              }
            } else if (!hasSourceId) {
              binding.pendingWithoutSource += 1
            } else if (sourceAvailable) {
              binding.pendingAvailable += 1
            } else {
              binding.pendingUnavailable += 1
            }
            if (level === 'pending' && hasSourceId) submittedPendingWithSource += 1
          }
        }
      }
    } catch {
      submitted.invalid_arguments = (submitted.invalid_arguments ?? 0) + 1
    }
  }
  const saved = options.flatMap((option) => option.days.flatMap((day) => day.stops.flatMap((stop) => stop.factClaims ?? [])))
  return {
    acceptedProposalCount: acceptedCalls.length,
    submitted,
    sourceBindingByType,
    submittedSourcedWithAvailableSource,
    submittedSourcedWithUnavailableSource,
    submittedPendingWithSource,
    saved: Object.fromEntries(['opening-hours', 'booking'].map((type) => [type, {
      sourced: saved.filter((fact) => fact.type === type && fact.evidenceLevel === 'sourced').length,
      pending: saved.filter((fact) => fact.type === type && fact.evidenceLevel === 'pending').length
    }]))
  }
}

it('事实证据诊断区分待核验、有效来源与无效来源且只输出计数', () => {
  const argumentsText = JSON.stringify({ plan: { days: [{ stops: [{ fact_claims: [
    { type: 'opening-hours', evidence_level: 'sourced', source_id: 'source-valid' },
    { type: 'booking', evidence_level: 'sourced', source_id: 'source-missing' },
    { type: 'booking', evidence_level: 'pending', source_id: 'source-valid' }
  ] }] }] } })
  const progress = {
    transcript: [
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'proposal-1', type: 'function', function: {
          name: 'propose_itineraries', arguments: argumentsText
        } }]
      },
      {
        role: 'tool', tool_call_id: 'proposal-1',
        content: JSON.stringify({ result: '已生成 1 份待审阅草案。' })
      }
    ]
  } as unknown as AgentRunProgress
  const sources = [{
    id: 'source-valid', title: '测试来源', url: 'https://example.com', provider: '测试',
    kind: 'web', summary: '', fetchedAt: '2026-10-23T00:00:00.000Z', status: 'success'
  }] as SourceRecord[]
  const options = [{ days: [{ stops: [{ factClaims: [
    { type: 'opening-hours', evidenceLevel: 'pending' },
    { type: 'booking', evidenceLevel: 'pending' }
  ] }] }] }] as unknown as ItineraryOption[]

  const result = proposalFactEvidenceBehavior(progress, sources, options)

  expect(result).toMatchObject({
    acceptedProposalCount: 1,
    submitted: { 'opening-hours:sourced': 1, 'booking:sourced': 1, 'booking:pending': 1 },
    sourceBindingByType: {
      'opening-hours': { sourcedAvailable: 1, sourcedUnavailable: 0, sourcedWithoutSource: 0 },
      booking: { sourcedAvailable: 0, sourcedUnavailable: 1, sourcedWithoutSource: 0, pendingAvailable: 1 }
    },
    submittedSourcedWithAvailableSource: 1,
    submittedSourcedWithUnavailableSource: 1,
    submittedPendingWithSource: 1,
    saved: {
      'opening-hours': { sourced: 0, pending: 1 },
      booking: { sourced: 0, pending: 1 }
    }
  })
  expect(JSON.stringify(result)).not.toContain('source-valid')
  expect(JSON.stringify(result)).not.toContain('source-missing')
})

it('事实检索诊断只输出计数并识别景点定向正文', () => {
  const progress = {
    transcript: [{
      role: 'assistant', content: '',
      tool_calls: [{
        id: 'search-1', type: 'function',
        function: { name: 'search_web', arguments: JSON.stringify({ query: '北京故宫博物院官方预约开放时间' }) }
      }]
    }]
  } as unknown as AgentRunProgress
  const firecrawlSource: SourceRecord = {
    id: 'source-1', title: '故宫博物院参观须知', url: 'https://example.com/visit',
    provider: 'Firecrawl 网页正文', kind: 'web', summary: '故宫博物院开放时间与预约方式。',
    fetchedAt: '2026-10-23T00:00:00.000Z', status: 'success', contentLevel: 'page'
  }
  const exaSource: SourceRecord = {
    ...firecrawlSource, id: 'source-2', provider: 'Exa 网页正文', contentLevel: 'page'
  }
  const searchSnippet: SourceRecord = {
    ...firecrawlSource, id: 'source-3', provider: 'Exa 搜索', contentLevel: 'snippet'
  }
  const failedPage: SourceRecord = {
    ...firecrawlSource, id: 'source-4', provider: 'Firecrawl', contentLevel: 'status', status: 'error'
  }
  const option = {
    id: 'plan-1', title: '北京行程', summary: '', tradeoffs: '',
    days: [{
      id: 'day-1', dayNumber: 1, date: '2026-10-23', title: '故宫', scheduleBlocks: [],
      stops: [{
        id: 'stop-1', name: '故宫博物院', area: '北京', time: '09:00–12:00', durationMinutes: 180,
        category: '景点', notes: '', transitToNext: '',
        factClaims: [
          { id: 'fact-1', type: 'opening-hours', value: '开放时段', scope: '2026-10-23', evidenceLevel: 'pending', sourceId: 'source-1' },
          { id: 'fact-2', type: 'booking', value: '预约方式', scope: '2026-10-23', evidenceLevel: 'pending' }
        ]
      }]
    }]
  } as unknown as ItineraryOption

  const result = factResearchCoverage(progress, [firecrawlSource, exaSource, searchSnippet, failedPage], [option], ['故宫博物院'])

  expect(result).toMatchObject({
    modelSearchQueries: { total: 1, attractionTargeted: 1 },
    sources: {
      stopsWithMatchingWebSource: 1,
      stopsWithPageBody: 1,
      pageBodySourceCount: 2,
      pendingFacts: 2,
      pendingFactsWithMatchingBody: 2,
      pendingFactsWithMatchingBodyLinked: 1,
      openingFactsWithMatchingBody: 1,
      bookingFactsWithMatchingBody: 1,
      openingFactsWithMatchingBodyLinked: 1,
      bookingFactsWithMatchingBodyLinked: 0,
      pendingFactsWithVenueTitleMatch: 2,
      pendingFactsWithVenueBodyMatch: 2,
      pendingFactsWithTypeTermBody: 2,
      pendingFactsWithMultipleMatchingBodies: 2
    }
  })
  expect(JSON.stringify(result)).not.toContain('故宫')
})

/** 汇总主进程允许记录的工具状态字段，不读取模型或网页正文。 */
async function toolOutcomeCounts(directory: string): Promise<Record<string, number>> {
  const contents = await readFile(join(directory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const counts: Record<string, number> = {}
  for (const line of contents.split('\n')) {
    if (!line) continue
    try {
      const entry = JSON.parse(line) as { event?: string; toolName?: string; status?: string; errorKind?: string; reason?: string }
      if (entry.event !== 'agent.tool.returned' && entry.event !== 'agent.tool.failed' &&
          !(entry.event === 'agent.tool.blocked' && entry.reason === 'not_offered')) continue
      const key = [entry.event === 'agent.tool.blocked' ? 'tool_call' : entry.toolName ?? 'unknown',
        entry.status ?? 'unknown', entry.errorKind, entry.reason].filter(Boolean).join(':')
      counts[key] = (counts[key] ?? 0) + 1
    } catch {
      counts.invalid_log_lines = (counts.invalid_log_lines ?? 0) + 1
    }
  }
  return counts
}

/** 汇总每种工具的调用次数和耗时，不保留查询、来源正文或地点信息。 */
async function toolTimingSummary(directory: string): Promise<Record<string, { count: number; totalMs: number; maxMs: number }>> {
  const contents = await readFile(join(directory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const totals: Record<string, { count: number; totalMs: number; maxMs: number }> = {}
  for (const line of contents.split('\n')) {
    if (!line) continue
    try {
      const entry = JSON.parse(line) as { event?: string; toolName?: string; durationMs?: number }
      if (entry.event !== 'agent.tool.returned' || typeof entry.durationMs !== 'number') continue
      const name = entry.toolName ?? 'unknown'
      const summary = totals[name] ?? { count: 0, totalMs: 0, maxMs: 0 }
      summary.count += 1
      summary.totalMs += entry.durationMs
      summary.maxMs = Math.max(summary.maxMs, entry.durationMs)
      totals[name] = summary
    } catch {
      continue
    }
  }
  return totals
}

/** 只汇总 Agent 实际调用路线工具的次数、结果和耗时。 */
async function routeLookupSummary(directory: string): Promise<Record<string, unknown> | null> {
  const contents = await readFile(join(directory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const outcomeCounts: Record<string, number> = {}
  const attemptsByDay: Record<string, number> = {}
  const allowedStatuses = new Set([
    'success', 'location_unresolved', 'route_unavailable', 'route_data_missing',
    'provider_error', 'input_error', 'tool_unavailable', 'connector_error'
  ])
  let lookupCount = 0
  let routeOptionCount = 0
  let durationMs = 0
  for (const line of contents.split('\n')) {
    if (!line) continue
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (entry.event !== 'agent.route.lookup.completed') continue
      lookupCount += 1
      const status = allowedStatuses.has(String(entry.status)) ? String(entry.status) : 'other'
      outcomeCounts[status] = (outcomeCounts[status] ?? 0) + 1
      if (typeof entry.routeDayNumber === 'number' && Number.isInteger(entry.routeDayNumber) &&
          entry.routeDayNumber >= 1 && entry.routeDayNumber <= 31) {
        const day = String(entry.routeDayNumber)
        attemptsByDay[day] = (attemptsByDay[day] ?? 0) + 1
      }
      if (typeof entry.routeOptionCount === 'number' && Number.isInteger(entry.routeOptionCount) &&
          entry.routeOptionCount >= 0 && entry.routeOptionCount <= 3) routeOptionCount += entry.routeOptionCount
      if (typeof entry.durationMs === 'number' && Number.isInteger(entry.durationMs) &&
          entry.durationMs >= 0 && entry.durationMs <= 5_400_000) durationMs += entry.durationMs
    } catch {
      continue
    }
  }
  return lookupCount ? { lookupCount, outcomeCounts, attemptsByDay, routeOptionCount, durationMs } : null
}

/** 只读取日期保护范围计数，不输出日期、行程内容或用户原话。 */
async function itineraryRevisionScopeSummary(directory: string): Promise<{
  scope?: Record<string, boolean | number>
  finalized?: Record<string, boolean | number>
}> {
  const contents = await readFile(join(directory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const scopeEvents: Array<Record<string, unknown>> = []
  const finalizedEvents: Array<Record<string, unknown>> = []
  for (const line of contents.split('\n')) {
    if (!line) continue
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (entry.event === 'agent.itinerary_revision.scope') scopeEvents.push(entry)
      if (entry.event === 'agent.itinerary_revision.finalized') finalizedEvents.push(entry)
    } catch {
      continue
    }
  }
  const safeFields = (entry: Record<string, unknown> | undefined, fields: string[]) => {
    if (!entry) return undefined
    const safe = Object.fromEntries(fields.flatMap((field) =>
      typeof entry[field] === 'boolean' || (typeof entry[field] === 'number' && Number.isFinite(entry[field]))
        ? [[field, entry[field] as boolean | number]]
        : []
    ))
    return Object.keys(safe).length ? safe : undefined
  }
  const scope = safeFields(scopeEvents.at(-1), [
    'baselineAvailable', 'baselineDayCount', 'protectedDayCount', 'excludedStopCount', 'targetDayCount'
  ])
  const finalized = safeFields(finalizedEvents.at(-1), [
    'baselineAvailable', 'protectedDayCount', 'restoredProtectedDayCount'
  ])
  return {
    ...(scope ? { scope } : {}),
    ...(finalized ? { finalized } : {})
  }
}

/** 按行程日关联路线结果与接口错误；不输出地点、请求地址、凭证或随机关联号。 */
async function amapFailureSummary(directory: string): Promise<Record<string, unknown>> {
  const contents = await readFile(join(directory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const byOperation: Record<string, number> = {}
  const providerCodes: Record<string, number> = {}
  const httpStatuses: Record<string, number> = {}
  const transportCodes: Record<string, number> = {}
  let citylessFallbackSuccessCount = 0
  const routeAttempts = new Map<string, {
    dayNumber: number
    outcome?: string
    operations: Record<string, number>
    failureShapes: Record<string, number>
    endpointResolutions: Record<string, number>
    providerCodes: Record<string, number>
    httpStatuses: Record<string, number>
    transportCodes: Record<string, number>
    citylessFallbackSuccessCount: number
  }>()
  const allowedOperations = new Set(['route_poi_search', 'geocode', 'route_transit', 'route_walking', 'route_driving'])
  const routeAttemptFor = (entry: Record<string, unknown>) => {
    const attemptId = typeof entry.routeAttemptId === 'string' && /^[a-f0-9-]{36}$/iu.test(entry.routeAttemptId)
      ? entry.routeAttemptId : undefined
    const dayNumber = typeof entry.routeDayNumber === 'number' && Number.isInteger(entry.routeDayNumber)
      ? entry.routeDayNumber : undefined
    if (!attemptId || !dayNumber) return undefined
    const existing = routeAttempts.get(attemptId) ?? {
      dayNumber, operations: {}, failureShapes: {}, endpointResolutions: {},
      providerCodes: {}, httpStatuses: {}, transportCodes: {}, citylessFallbackSuccessCount: 0
    }
    if (existing.dayNumber !== dayNumber) return undefined
    if (entry.event === 'agent.route.lookup.completed' && typeof entry.status === 'string') {
      existing.outcome = entry.status
    }
    routeAttempts.set(attemptId, existing)
    return existing
  }
  for (const line of contents.split('\n')) {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      const attempt = routeAttemptFor(entry)
      if (entry.event === 'agent.route.lookup.completed') continue
      if (entry.event === 'amap.geocode.fallback_succeeded') {
        citylessFallbackSuccessCount += 1
        if (attempt) attempt.citylessFallbackSuccessCount += 1
        continue
      }
      if (entry.event === 'amap.route.endpoint_resolution') {
        const stages = new Set([
          'source-coordinate', 'exact-poi', 'exact-poi-no-city', 'raw-input', 'area-address', 'place-name',
          'area-address-no-city', 'place-name-no-city'
        ])
        const statuses = new Set(['resolved', 'not_found', 'provider_error'])
        const reasons = new Set([
          'invalid_coordinate', 'no_exact_match', 'ambiguous_match', 'area_conflict', 'city_conflict', 'no_precise_match'
        ])
        const role = entry.routePointRole === 'origin' || entry.routePointRole === 'destination'
          ? entry.routePointRole : 'unknown-point'
        const stage = stages.has(String(entry.routeResolutionStage)) ? String(entry.routeResolutionStage) : 'unknown-stage'
        const status = statuses.has(String(entry.routeResolutionStatus)) ? String(entry.routeResolutionStatus) : 'unknown-status'
        const reason = reasons.has(String(entry.routeResolutionReason)) ? String(entry.routeResolutionReason) : 'none'
        const shape = `${role}:${stage}:${status}:${reason}`
        if (attempt) attempt.endpointResolutions[shape] = (attempt.endpointResolutions[shape] ?? 0) + 1
        continue
      }
      if (entry.event !== 'amap.request.failed') continue
      const operation = typeof entry.operation === 'string' && allowedOperations.has(entry.operation)
        ? entry.operation : 'other'
      byOperation[operation] = (byOperation[operation] ?? 0) + 1
      if (attempt) attempt.operations[operation] = (attempt.operations[operation] ?? 0) + 1
      const pointRole = entry.routePointRole === 'origin' || entry.routePointRole === 'destination'
        ? entry.routePointRole : 'unknown-point'
      const geocodeVariant = [
        'raw-input', 'area-address', 'place-name', 'area-address-no-city', 'place-name-no-city',
        'source-place-coordinate', 'poi-coordinate-citycode'
      ].includes(String(entry.routeGeocodeVariant))
        ? String(entry.routeGeocodeVariant) : 'not-applicable'
      if (attempt) {
        const shape = `${operation}:${pointRole}:${geocodeVariant}`
        attempt.failureShapes[shape] = (attempt.failureShapes[shape] ?? 0) + 1
      }
      if (entry.status === 'provider_error' && typeof entry.errorCode === 'string' && /^\d{1,12}$/u.test(entry.errorCode)) {
        providerCodes[entry.errorCode] = (providerCodes[entry.errorCode] ?? 0) + 1
        if (attempt) attempt.providerCodes[entry.errorCode] = (attempt.providerCodes[entry.errorCode] ?? 0) + 1
      }
      if (entry.status === 'request_failed' && typeof entry.httpStatus === 'number' &&
          Number.isInteger(entry.httpStatus) && entry.httpStatus >= 100 && entry.httpStatus <= 599) {
        const status = String(entry.httpStatus)
        httpStatuses[status] = (httpStatuses[status] ?? 0) + 1
        if (attempt) attempt.httpStatuses[status] = (attempt.httpStatuses[status] ?? 0) + 1
      }
      if (isSafeTransportCode(entry.transportCode)) {
        transportCodes[entry.transportCode] = (transportCodes[entry.transportCode] ?? 0) + 1
        if (attempt) attempt.transportCodes[entry.transportCode] = (attempt.transportCodes[entry.transportCode] ?? 0) + 1
      }
    } catch {
      continue
    }
  }
  const routeAttemptsByDay = [...routeAttempts.values()]
    .sort((left, right) => left.dayNumber - right.dayNumber)
    .map(({ dayNumber, outcome, operations, failureShapes, endpointResolutions,
      providerCodes: codes, httpStatuses: statuses, transportCodes: networkCodes, citylessFallbackSuccessCount: fallbacks }) => ({
      dayNumber, ...(outcome ? { outcome } : {}), operations, failureShapes, endpointResolutions,
      providerCodes: codes, httpStatuses: statuses, transportCodes: networkCodes, citylessFallbackSuccessCount: fallbacks
    }))
  return { byOperation, providerCodes, httpStatuses, transportCodes, citylessFallbackSuccessCount, routeAttemptsByDay }
}

interface GeocodeProbeTarget {
  address: string
  city?: string
}

/** 仅把地址特征压缩为类别，避免诊断输出包含模型生成的地点文本。 */
function geocodeAddressShape(address: string): Record<string, string | boolean> {
  const length = [...address].length
  return {
    length: length < 20 ? 'under-20' : length < 40 ? '20-to-39' : length < 80 ? '40-to-79' : '80-plus',
    hasWhitespace: /\s/u.test(address),
    hasAdministrativeSuffix: /(?:区|县|旗|市)$/u.test(address),
    startsWithBeijing: /^北京市?/u.test(address),
    hasParentheses: /[()（）]/u.test(address)
  }
}

/** 重放少量 30001 请求的城市参数变体；仅输出响应码和精确结果数量。 */
async function replayGeocodeVariants(
  targets: GeocodeProbeTarget[], key: string
): Promise<Array<Record<string, unknown>>> {
  const outcomes: Array<Record<string, unknown>> = []
  const preciseLevels = new Set(['兴趣点', '门牌号', '门址', '公交地铁站点'])
  const variantsFor = (target: GeocodeProbeTarget) => {
    const variants = [
      { id: 'original', city: target.city },
      { id: 'without-city', city: undefined },
      { id: 'city-code', city: '010' },
      { id: 'administrative-code', city: '110000' },
      { id: 'full-city-name', city: '北京市' }
    ]
    const seen = new Set<string>()
    return variants.filter((variant) => {
      const identity = variant.city ?? ''
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
  }

  for (const [targetIndex, target] of targets.slice(0, 3).entries()) {
    const variants: Array<Record<string, string | number>> = []
    for (const variant of variantsFor(target)) {
      const params = new URLSearchParams({ address: target.address, output: 'JSON', key })
      if (variant.city) params.set('city', variant.city)
      const signal = AbortSignal.timeout(12_000)
      try {
        const response = await amapRequestScheduler.run('geocode', () => fetch(
          `https://restapi.amap.com/v3/geocode/geo?${params}`, { signal }
        ), signal)
        const payload = await response.json().catch(() => null) as {
          status?: unknown
          infocode?: unknown
          geocodes?: Array<{ location?: unknown; level?: unknown }>
        } | null
        const infocode = payload?.infocode === undefined ? '' : String(payload.infocode)
        variants.push({
          variant: variant.id,
          status: response.ok && payload?.status === '1' ? 'ok' : 'provider_error',
          ...( /^\d{1,12}$/u.test(infocode) ? { errorCode: infocode } : {}),
          resultCount: payload?.geocodes?.length ?? 0,
          preciseCount: (payload?.geocodes ?? []).filter((item) =>
            typeof item.location === 'string' && typeof item.level === 'string' && preciseLevels.has(item.level)
          ).length
        })
      } catch {
        variants.push({ variant: variant.id, status: 'request_failed' })
      }
    }
    outcomes.push({
      probe: targetIndex + 1,
      addressShape: geocodeAddressShape(target.address),
      cityFilterPresent: Boolean(target.city),
      variants
    })
  }
  return outcomes
}

/** 只保留餐次修订决策的计数和状态，定位修订未触发的条件。 */
async function mealRepairDecisionSummary(directory: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(join(directory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const fields = [
    'status', 'mealGapCount', 'detailGapCount', 'itineraryCount',
    'factResearchStage', 'mealRepairPending', 'mealRepairAttempts', 'mealRepairFailures', 'mealRepairUsed',
    'mealRepairRetryAfterPlanRepair', 'rejectedCandidatePending'
  ]
  return contents.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (entry.event !== 'agent.meal_repair.evaluated') return []
      return [Object.fromEntries(fields.flatMap((field) =>
        entry[field] === undefined ? [] : [[field, entry[field]]]
      ))]
    } catch {
      return []
    }
  })
}

/** 将缺项按方案编号统计，帮助判断修订是否只影响其中一套方案。 */
function safeGapCountsByPlan(gaps: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const gap of gaps) {
    const planNumber = gap.match(/^方案\s*(\d+)/u)?.[1]
    if (planNumber) counts[`plan${planNumber}`] = (counts[`plan${planNumber}`] ?? 0) + 1
  }
  return counts
}

/** 汇总模型调用的计数、耗时与请求规模，避免长测失败输出大量逐次日志。 */
async function modelEventSummary(directory: string): Promise<Record<string, unknown>> {
  const contents = await readFile(join(directory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const allEntries = contents.split('\n').flatMap((line) => {
    if (!line) return []
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (typeof parsed.event !== 'string') return []
      return [parsed]
    } catch {
      return []
    }
  })
  const entries = allEntries.filter((entry) => String(entry.event).startsWith('llm.'))
  const requestEvents = entries.filter((entry) => entry.event === 'llm.request.completed' || entry.event === 'llm.request.failed')
  const requestDurations = requestEvents.flatMap((entry) => typeof entry.durationMs === 'number' ? [entry.durationMs] : [])
  const requestAttempts = entries.filter((entry) => entry.event === 'llm.request.attempt.started')
  const streamEvents = entries.filter((entry) => entry.event === 'llm.stream.completed')
  const streamFailureEvents = entries.filter((entry) => entry.event === 'llm.stream.failed')
  const streamRetryEvents = entries.filter((entry) => entry.event === 'llm.stream.retry')
  const transportRetryEvents = entries.filter((entry) => entry.event === 'llm.request.transport.retry')
  const transportDiagnosticEvents = entries.filter((entry) =>
    ['llm.request.transport.retry', 'llm.request.transport.failed', 'llm.stream.failed'].includes(String(entry.event)) &&
    isSafeTransportCode(entry.transportCode)
  )
  const requestFailureEvents = entries.filter((entry) => entry.event === 'llm.request.failed')
  const responseEvents = entries.filter((entry) => entry.event === 'llm.response.completed')
  const headerEvents = entries.filter((entry) => entry.event === 'llm.response.headers.received' || entry.event === 'llm.response.http_failed')
  const phaseEvents = allEntries.filter((entry) => entry.event === 'agent.request.prepared')
  const sumField = (events: Array<Record<string, unknown>>, field: string): number => events.reduce(
    (total, entry) => total + (typeof entry[field] === 'number' ? entry[field] as number : 0), 0
  )
  const maxField = (events: Array<Record<string, unknown>>, field: string): number => Math.max(
    0, ...events.flatMap((entry) => typeof entry[field] === 'number' ? [entry[field] as number] : [])
  )
  const countField = (events: Array<Record<string, unknown>>, field: string): Record<string, number> => {
    const counts: Record<string, number> = {}
    for (const entry of events) {
      const value = typeof entry[field] === 'string' ? entry[field] as string : 'unknown'
      counts[value] = (counts[value] ?? 0) + 1
    }
    return counts
  }
  const httpFailureStatuses: Record<string, number> = {}
  for (const entry of entries.filter((item) => item.event === 'llm.response.http_failed')) {
    const status = typeof entry.httpStatus === 'number' ? String(entry.httpStatus) : 'unknown'
    httpFailureStatuses[status] = (httpFailureStatuses[status] ?? 0) + 1
  }
  return {
    requestCount: requestEvents.length,
    completedCount: requestEvents.filter((entry) => entry.event === 'llm.request.completed').length,
    failedCount: requestEvents.filter((entry) => entry.event === 'llm.request.failed').length,
    requestFailureKinds: countField(requestFailureEvents, 'errorKind'),
    streamFailureKinds: countField(streamFailureEvents, 'errorKind'),
    streamRetryReasons: countField(streamRetryEvents, 'reason'),
    transportRetryReasons: countField(transportRetryEvents, 'reason'),
    transportErrorCodes: countField(transportDiagnosticEvents, 'transportCode'),
    attemptCount: requestAttempts.length,
    toolChoiceCounts: countField(requestAttempts, 'toolChoice'),
    maxToolCount: maxField(requestAttempts, 'toolCount'),
    retryCount: entries.filter((entry) => /\.retry$|\.length_retry$/u.test(String(entry.event))).length,
    totalDurationMs: requestDurations.reduce((total, duration) => total + duration, 0),
    maxDurationMs: Math.max(0, ...requestDurations),
    totalRequestBytes: sumField(requestAttempts, 'requestBytes'),
    maxRequestBytes: maxField(requestAttempts, 'requestBytes'),
    totalResponseBytes: sumField(responseEvents, 'responseBytes'),
    maxResponseBytes: maxField(responseEvents, 'responseBytes'),
    maxResponseHeadersMs: maxField(headerEvents, 'responseHeadersMs'),
    maxStreamDurationMs: maxField(streamEvents, 'streamDurationMs'),
    httpFailureStatuses,
    maxRequestTokens: maxField(requestAttempts, 'maxTokens'),
    maxSystemMessageCharacters: maxField(requestAttempts, 'systemMessageCharacters'),
    maxUserMessageCharacters: maxField(requestAttempts, 'userMessageCharacters'),
    maxToolMessageCharacters: maxField(requestAttempts, 'toolMessageCharacters'),
    maxToolCallArgumentCharacters: maxField(requestAttempts, 'toolCallArgumentCharacters'),
    maxToolSchemaCharacters: maxField(requestAttempts, 'toolSchemaCharacters'),
    maxFirstContentMs: maxField(streamEvents, 'firstContentMs'),
    maxFirstToolCallMs: maxField(streamEvents, 'firstToolCallMs'),
    maxReasoningBytes: maxField(streamEvents, 'reasoningBytes'),
    maxVisibleContentBytes: maxField(streamEvents, 'contentBytes'),
    maxToolCallArgumentBytes: maxField(streamEvents, 'toolCallArgumentBytes'),
    maxFirstChunkMs: maxField(streamEvents, 'firstChunkMs'),
    requestPhaseCounts: countField(phaseEvents, 'phase'),
    maxToolCallsPerRequest: maxField(requestEvents, 'toolCallCount')
  }
}

/** 只保留 Agent 请求阶段和工具数量，定位预检后的提前退出。 */
async function agentRequestSummary(directory: string): Promise<Record<string, unknown>> {
  const contents = await readFile(join(directory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const prepared: Array<{ phase?: string; toolCount?: number }> = []
  for (const line of contents.split('\n')) {
    if (!line) continue
    try {
      const entry = JSON.parse(line) as { event?: string; phase?: string; toolCount?: number }
      if (entry.event !== 'agent.request.prepared') continue
      prepared.push({ phase: entry.phase, toolCount: entry.toolCount })
    } catch {
      // 无效日志只影响诊断，不影响产品行为。
    }
  }
  return {
    preparedRequestCount: prepared.length,
    preparedPhases: Object.fromEntries([...new Set(prepared.map((entry) => entry.phase).filter(Boolean))]
      .map((phase) => [phase, prepared.filter((entry) => entry.phase === phase).length])),
    lastPreparedToolCount: prepared.at(-1)?.toolCount ?? 0
  }
}

/** 只在本机凭证已保存时运行真实北京用例；默认跳过，避免意外产生外部调用。 */
// 与 Agent 整轮 90 分钟上限对齐，容纳北京长规划中的多次模型调用。
it.skipIf(!enabled)('运行真实北京逐时段旅行规划并输出脱敏质量指标', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tripwise-beijing-live-'))
  const requestId = randomUUID()
  const request = [
    '请为我做北京 2026-09-21 至 2026-09-27 的 5 天 6 晚个人旅行，先给一份完整、可审阅的行程草案。本轮不要并列生成备选方案；我会根据每轮差异继续提出修改意见。尽量按以下线路安排，并保留硬约束。',
    '出发地深圳。9/21 下午到深圳机场，17:00 航班起飞，19:00 抵达北京大兴；当晚住北京西站周边，只安排晚餐。全程住同一住宿区域。',
    '9/22 必须安排清华、北大、圆明园；9/23 参考颐和园与香山赏秋；9/24 参考天坛、国家博物馆、前门；9/25 参考八达岭长城和鸟巢/水立方；9/26 参考天安门、故宫、景山、北海、什刹海；9/27 只安排雍和宫或一个同等景点，早餐和午餐后回住宿区域取行李，16:30 后不再安排景点或用餐；18:15 从住宿区域出发，19:00 前抵达北京西站候车，20:00 乘车返程，次日傍晚抵达深圳。',
    '参考合成的逐日时段框架，遇到开放、预约或通勤冲突可调整，但固定时刻必须无冲突：9/21 落地后先取行李、进城入住，再晚餐；9/22 08:00 出发，09:00–11:15 清华，11:15–12:00 午餐，12:00–14:00 北大，14:30–18:00 圆明园；9/23 08:00–12:15 颐和园，午餐后接驳香山，14:15–16:15 低强度游园、16:15–17:15 碧云寺；9/24 08:00–11:15 天坛，午餐后预留安检，13:30–16:30 国家博物馆，之后前门；9/25 早班车去八达岭、游览至约13:00，返城后看鸟巢/水立方，体力不足时删减夜游；9/26 07:00–08:00 天安门广场，08:30–13:30 故宫（午餐可在馆内），随后景山、北海、什刹海；9/27 09:00 雍和宫，10:45–12:45 孔庙和国子监，12:45–13:45 午餐，之后五道营、回住宿区域取行李，16:30 后只安排返程准备，18:15 住宿区域出发、19:00 前抵达北京西站、20:00 发车。路线时长仍以来源为准；本案例为合成输入，不代表已预约或已购票。',
    '单人、中等预算、中等体力；关注清北人文、北京地标、秋景和美食。尽量公共交通。要考虑景区预约、开放时间、周一闭馆、跨区通勤、入口和出口；别把尚未购票或未完成的预约写成已确认。预约按可预约假设规划，但要给核验提醒。',
    '必须逐日按早晨/上午/午间/下午/晚间等时段编排；每个具体景点有开始时刻和建议停留时间；每段接驳写明交通方式和明确目的地。没有成功路线来源时，通勤分钟数标待核验，不能装成实时导航。每天说明遇到下雨、客流、延误或体力下降时具体删减/替换什么。三餐要有具体店名和门店所在区域：9/21 仅晚餐，9/22–9/26 每天三餐，9/27 仅早餐和午餐。不要用“附近找餐馆”代替店名；找不到可靠店名时明确写待选。',
    '另给逐日穿搭、结合天气的温差提示、行李清单并区分托运/随身（托运行李 20kg，随身电子设备，按秋季温差分层）、预约/购票清单及雨天/延误总预案。事实需附来源；不确定时标待核验。按以上合成信息先给可审核方案。'
  ].join('\n\n')
  const brief: TripBrief = {
    departureCity: '深圳',
    destination: '北京',
    startDate: '2026-09-21',
    endDate: '2026-09-27',
    arrivalFlight: '示例航班，深圳机场17:00起飞，北京大兴19:00到达',
    arrivalTime: '2026-09-21 19:00',
    leaveTime: '2026-09-27 20:00 北京西站示例车次；2026-09-28 18:20抵达深圳',
    travelers: '1人',
    budget: '中等',
    lodgingLocation: '北京西站周边住宿',
    lodging: '北京西站周边住宿',
    pace: '中等体力',
    earlyStart: '可以早起，按预约与车次安排',
    interests: '清华、北大、圆明园；红叶、北京标志景点、人文、美食',
    transport: '尽量公共交通，含地铁、公交和步行；城际交通按已购车票',
    dietary: '无特殊忌口',
    luggage: '20kg托运行李额度；随身电子设备',
    clothing: '按每日天气和秋季温差分层',
    constraints: '按合成参考计划逐日规划；9/27仅一个景点、早餐和午餐，16:30后不再安排景点或用餐；18:15从住宿区域出发，19:00前抵达北京西站候车，20:00乘车返程。抵离时刻为硬约束。预约按可预约假设规划，但仍列出核验提醒。'
  }
  const store = new CapturingTripStore(temporaryDirectory)
  const vault = new SecretVault(profileDirectory)
  let startedAt = 0
  let failedQualityGate: string | undefined
  let revisionRunErrorKind: string | undefined
  const geocodeProbeTargets = new Map<string, GeocodeProbeTarget>()
  let geocodeVariantProbe: Array<Record<string, unknown>> | undefined
  let captureGeocodeFailures = false

  try {
    await store.initialize()
    configureSystemLogger(temporaryDirectory)
    const liveProfile = JSON.parse(await readFile(join(profileDirectory, 'tripwise-data.json'), 'utf8')) as {
      settings?: { model?: { baseUrl?: string; model?: string }; connectors?: typeof DEFAULT_SETTINGS.connectors }
    }
    if (!liveProfile.settings?.model?.baseUrl || !liveProfile.settings.model.model) {
      throw new Error('missing_model_configuration')
    }
    await store.updateSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      model: liveProfile.settings.model as typeof DEFAULT_SETTINGS.model,
      connectors: liveProfile.settings.connectors ?? DEFAULT_SETTINGS.connectors,
      xiaohongshu: { enabled: false, command: '', args: [] },
      mcpServers: []
    })
    await vault.initialize()
    if (!(await vault.get('modelKey'))) throw new Error('missing_saved_model_credential')
    if (!(await vault.get('exaKey')) || !(await vault.get('tavilyKey')) || !(await vault.get('firecrawlKey'))) {
      throw new Error('missing_saved_research_credentials')
    }
    const amapKey = await vault.getAmapKey()
    if (geocodeVariantProbeEnabled && amapKey) {
      captureGeocodeFailures = true
      configureExternalFetcher(async (input, init) => {
        const response = await fetch(input, init)
        if (!captureGeocodeFailures || geocodeProbeTargets.size >= 3) return response
        try {
          const requestUrl = input instanceof Request ? new URL(input.url)
            : new URL(input instanceof URL ? input.toString() : input)
          if (requestUrl.hostname !== 'restapi.amap.com' || requestUrl.pathname !== '/v3/geocode/geo') return response
          const payload = await response.clone().json().catch(() => null) as { infocode?: unknown } | null
          if (String(payload?.infocode ?? '') !== '30001') return response
          const address = requestUrl.searchParams.get('address')
          if (!address) return response
          const city = requestUrl.searchParams.get('city') ?? undefined
          const identity = `${address}\u0000${city ?? ''}`
          if (!geocodeProbeTargets.has(identity)) geocodeProbeTargets.set(identity, { address, ...(city ? { city } : {}) })
        } catch {
          // 探针采集不能影响真实路线请求。
        }
        return response
      })
    }
    await store.createTrip(brief)
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('temporary_trip_creation_failed')
    const events: Array<{ type: string; toolName?: string }> = []
    startedAt = Date.now()
    store.startRunMeasurement(startedAt)
    process.stderr.write(`${statusPrefix} started\n`)

    let agentRunError: unknown
    try {
      await new TravelAgent().run(
        store,
        vault,
        trip.id,
        request,
        requestId,
        new AbortController().signal,
        (event) => {
          events.push({ type: event.type, ...(event.toolName ? { toolName: event.toolName } : {}) })
          if (event.type === 'tool') process.stderr.write(`${statusPrefix} tool ${event.toolName ?? 'unknown'}\n`)
          if (event.type === 'complete' || event.type === 'error') process.stderr.write(`${statusPrefix} ${event.type}\n`)
        }
      )
    } catch (error) {
      // Agent 提前失败时仍汇总已保存的行程、来源和缺口，避免丢失评测证据。
      agentRunError = error
    }
    captureGeocodeFailures = false
    await flushSystemLogs()
    if (geocodeVariantProbeEnabled && amapKey && geocodeProbeTargets.size > 0) {
      geocodeVariantProbe = await replayGeocodeVariants([...geocodeProbeTargets.values()], amapKey)
    }

    const resultTrip = store.snapshot().trips[0]
    const assistantMessages = resultTrip?.messages.filter((message) => message.role === 'assistant') ?? []
    const options = store.latestRunProgress?.itineraryOptions ??
      assistantMessages.flatMap((message) => message.itineraryOptions ?? [])
    const mealRequirements = requiredMealSlotsForRequest(request, brief.startDate, brief.endDate) ?? []
    const detailGaps = itineraryDetailFeedback(options, {
      detailed: true, openingHours: true, booking: true, contingencies: true
    })
    const mealGaps = mealPreferenceFeedback(options, mealRequirements, true)
    const sources = resultTrip?.sources ?? []
    const stops = options.flatMap((option) => option.days.flatMap((day) => day.stops))
    const factCounts: Record<string, number> = {}
    const factEvidenceCounts: Record<string, number> = {}
    for (const stop of stops) {
      for (const fact of stop.factClaims ?? []) {
        factCounts[fact.type] = (factCounts[fact.type] ?? 0) + 1
        const evidenceKey = `${fact.type}:${fact.evidenceLevel}`
        factEvidenceCounts[evidenceKey] = (factEvidenceCounts[evidenceKey] ?? 0) + 1
      }
    }
    const providerCounts = Object.fromEntries([...new Set(sources.map((source) => source.provider))].sort()
      .map((provider) => [provider, sources.filter((source) => source.provider === provider).length]))
    const referencePlacesByDate: Array<{ date: string; alternatives: string[][] }> = [
      { date: '2026-09-23', alternatives: [['颐和园'], ['香山']] },
      { date: '2026-09-24', alternatives: [['天坛'], ['国家博物馆'], ['前门']] },
      { date: '2026-09-25', alternatives: [['八达岭'], ['鸟巢'], ['水立方']] },
      { date: '2026-09-26', alternatives: [['天安门'], ['故宫'], ['景山'], ['北海'], ['什刹海']] }
    ]
    const mustVisitRequirements: Array<{ date: string; alternatives: string[][] }> = [
      { date: '2026-09-22', alternatives: [['清华'], ['北京大学', '北大'], ['圆明园']] }
    ]
    const referencePlaceCoverage = options.map((option, index) => {
      const byDate = referencePlacesByDate.map(({ date, alternatives }) => {
        const day = option.days.find((candidate) => candidate.date === date)
        const present = alternatives.filter((names) => names.some((name) => day?.stops.some((stop) => stop.name.includes(name)))).length
        return { date, required: alternatives.length, present }
      })
      const present = byDate.reduce((sum, item) => sum + item.present, 0)
      // 单份草案至少覆盖 13 项参考地点中的 12 项。
      return { plan: index + 1, required: 13, present, minimum: index === 0 ? 12 : 10, byDate }
    })
    const mustVisitCoverage = options.map((option, index) => {
      const required = mustVisitRequirements.flatMap(({ date, alternatives }) => {
        const day = option.days.find((candidate) => candidate.date === date)
        return alternatives.map((names) => ({
          date,
          present: names.some((name) => day?.stops.some((stop) => stop.name.includes(name)))
        }))
      })
      const departureDay = option.days.find((day) => day.date === '2026-09-27')
      const majorAttraction = departureDay?.stops.some((stop) => {
        const identity = `${stop.category} ${stop.name}`
        return /景点|景区|人文|文化|历史|博物馆|公园|寺|庙|宫|园|胡同/u.test(identity) &&
          !/餐|用餐|美食|休息|购物|自由活动|交通|接驳|住宿|酒店|航班|机场|车站|候车|进站/u.test(identity) &&
          !/^(?:地点|景点|景区)(?:待选|待定|待核验)?$/u.test(stop.name.trim())
      }) ?? false
      return {
        plan: index + 1,
        required: 4,
        present: required.filter((item) => item.present).length + Number(majorAttraction),
        byDate: [
          { date: '2026-09-22', required: 3, present: required.filter((item) => item.present).length },
          { date: '2026-09-27', required: 1, present: Number(majorAttraction) }
        ]
      }
    })
    const preparation = store.latestRunProgress?.preparationOptions ??
      resultTrip?.messages.flatMap((message) => message.preparationOptions ?? []) ?? []
    const preparationCategories = Object.fromEntries(['booking', 'packing', 'clothing', 'food', 'alternative', 'transport', 'other']
      .map((category) => [category, preparation.filter((item) => item.category === category).length]))
    const routeProviderConfigured = Boolean(await vault.get('amapKey'))
    const successfulRouteSourceCount = sources.filter((source) => source.kind === 'route' && source.status === 'success').length
    const routeEvidenceByPlan = options.map((option, index) => {
      const routeSourceIds = new Set(sources.filter((source) => source.kind === 'route' && source.status === 'success').map((source) => source.id))
      let boundSegments = 0
      let daysWithBoundRoute = 0
      for (const day of option.days) {
        const dayHasRoute = day.stops.some((stop, stopIndex) => {
          const nextStop = day.stops[stopIndex + 1]
          const estimate = stop.transitEstimate
          const bound = !!nextStop && !!estimate && estimate.destinationStopId === nextStop.id &&
            routeSourceIds.has(estimate.sourceId) && stop.sourceIds?.includes(estimate.sourceId)
          if (bound) boundSegments += 1
          return bound
        })
        if (dayHasRoute) daysWithBoundRoute += 1
      }
      return { plan: index + 1, boundSegments, daysWithBoundRoute }
    })
    const report = {
      durationSeconds: Math.round((Date.now() - startedAt) / 1000),
      firstValidDraftSeconds: toElapsedSeconds(store.firstValidDraftMs),
      draftAndPreparationSeconds: toElapsedSeconds(store.draftAndPreparationMs),
      agentRunErrorKind: agentRunError ? classifyError(agentRunError) : undefined,
      agentRunErrorOrigin: agentRunError ? safeFailureOrigin(agentRunError) : undefined,
      agentRunErrorType: agentRunError instanceof Error
        ? agentRunError.name === 'ToolInputError' ? 'tool_input_error'
          : agentRunError.name === 'TimeoutError' ? 'timeout_error' : 'error'
        : undefined,
      agentRequests: await agentRequestSummary(temporaryDirectory),
      planCount: options.length,
      daysPerPlan: options.map((option) => option.days.length),
      stopCountPerPlan: options.map((option) => option.days.reduce((sum, day) => sum + day.stops.length, 0)),
      sourceCount: sources.length,
      sourceKinds: Object.fromEntries([...new Set(sources.map((source) => source.kind))].sort()
        .map((kind) => [kind, sources.filter((source) => source.kind === kind).length])),
      providers: providerCounts,
      routeProviderConfigured,
      routeSourceCount: successfulRouteSourceCount,
      routeEvidenceByPlan,
      routeLookups: await routeLookupSummary(temporaryDirectory),
      amapFailures: await amapFailureSummary(temporaryDirectory),
      ...(geocodeVariantProbe ? { geocodeVariantProbe } : {}),
      mustVisitCoverage,
      referencePlaceCoverage,
      mealRequirements: mealRequirements.reduce((sum, requirement) => sum + requirement.slots.length, 0),
      mealGapCount: mealGaps.length,
      mealGapCategories: safeMealGapSummary(mealGaps),
      mealRepairDecisions: await mealRepairDecisionSummary(temporaryDirectory),
      mealRepairProgress: safeMealRepairProgress(store.latestRunProgress),
      mealGapsByPlan: safeGapCountsByPlan(mealGaps),
      mealSlotGapCount: mealGaps.filter((gap) => /缺少(?:早餐|午餐|晚餐)|取消的(?:早餐|午餐|晚餐)/u.test(gap)).length,
      namedMealGapCount: mealGaps.filter((gap) => gap.includes('具体店面待选')).length,
      itineraryDetailGapCount: detailGaps.length,
      itineraryDetailGapCategories: safeItineraryDetailGapSummary(detailGaps),
      itineraryDetailGapsByPlan: safeGapCountsByPlan(detailGaps),
      factCounts,
      factEvidenceCounts,
      factResearchCoverage: factResearchCoverage(
        store.latestRunProgress, sources, options,
        initialAttractionSearches(brief.destination, brief.interests, brief.startDate, brief.endDate, request).map(({ name }) => name)
      ),
      proposalFactEvidenceBehavior: proposalFactEvidenceBehavior(store.latestRunProgress, sources, options),
      candidateFailureCategories: proposalFailureCategories(store.latestRunProgress),
      candidateFailureDetails: proposalFailureDetails(store.latestRunProgress),
      preparationItems: preparation.length,
      preparationCategories,
      modelEvents: await modelEventSummary(temporaryDirectory),
      toolOutcomes: await toolOutcomeCounts(temporaryDirectory),
      toolTimings: await toolTimingSummary(temporaryDirectory),
      tools: Object.fromEntries([...new Set(events.filter((event) => event.toolName).map((event) => event.toolName!))].sort()
        .map((tool) => [tool, events.filter((event) => event.toolName === tool).length])),
      terminalEvent: events.at(-1)?.type ?? 'none'
    }
    process.stdout.write(`${statusPrefix} metrics ${JSON.stringify(report)}\n`)
    // 这次评测严格检查运行和方案结构；内容覆盖、路线来源与准备类别只记录，交由人工审阅。
    const mealSlotGapCount = mealGaps.filter((gap) => /缺少(?:早餐|午餐|晚餐)|取消的(?:早餐|午餐|晚餐)/u.test(gap)).length
    const qualityGateFailures = [
      ...(options.length !== 1 ? ['single_draft_count'] : []),
      ...(!options.every((option) => option.days.length === 7) ? ['day_coverage'] : []),
      ...(!mustVisitCoverage.every((item) => item.present === item.required) ? ['must_visit_places'] : []),
      ...(mealSlotGapCount > 0 ? ['meal_slots'] : []),
      ...(agentRunError ? ['agent_run_failure'] : []),
    ]
    failedQualityGate = qualityGateFailures[0]
    expect(qualityGateFailures).toEqual([])

    if (revisionEvaluationEnabled) {
      failedQualityGate = 'live_revision'
      const revisionRequests = [
        '第一轮修改：以刚才的最新草案为基线。只把 9/23 调轻松，删除香山和碧云寺，保留颐和园主线；午餐后回酒店休息。9/22、9/24、9/25、9/26、9/27 和抵离时刻都保持不变。请返回一份完整修订草案，不并列方案。',
        '第二轮修改：以刚才最新的修订为基线。只把 9/24 晚餐改成前门一带的就近安排；若已有来源不能支持具体店名就保留待选。其他日期、刚调整的 9/23、每天餐次范围和抵离时刻都保持不变。请返回一份完整修订草案，不并列方案。'
      ]
      const mealRequirementsForRevision = requiredMealSlotsForRequest(request, brief.startDate, brief.endDate) ?? []
      let previousPlan = options[0]
      if (!previousPlan) throw new Error('live_revision_missing_base_draft')

      for (const [index, revisionRequest] of revisionRequests.entries()) {
        const revisionNumber = index + 1
        const revisionEvents: string[] = []
        process.stderr.write(`${statusPrefix} revision ${revisionNumber} started\n`)
        try {
          await new TravelAgent().run(
            store, vault, trip.id, revisionRequest, randomUUID(), new AbortController().signal,
            (event) => {
              if (event.type === 'tool') {
                process.stderr.write(`${statusPrefix} revision ${revisionNumber} tool ${event.toolName ?? 'unknown'}\n`)
              }
              if (event.type === 'complete' || event.type === 'error') revisionEvents.push(event.type)
            }
          )
        } catch (error) {
          // 只输出归类后的失败类型，避免联测日志泄露提示词、来源正文或凭证。
          revisionRunErrorKind = classifyError(error)
          throw error
        }
        await flushSystemLogs()

        const updatedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
        const latestDraftMessage = updatedTrip?.messages
          .filter((message) => message.role === 'assistant' && message.itineraryOptions?.length)
          .at(-1)
        const revisedPlan = latestDraftMessage?.itineraryOptions?.[0]
        if (!updatedTrip || !latestDraftMessage || !revisedPlan) throw new Error('live_revision_missing_draft')

        const dates = revisedPlan.days.map((day) => day.date)
        const exactDateCoverage = dates.join(',') === [
          '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'
        ].join(',')
        const anchoredPlaces = [
          ['2026-09-22', ['清华大学', '清华']],
          ['2026-09-22', ['北京大学', '北大']],
          ['2026-09-22', ['圆明园']],
          ['2026-09-25', ['八达岭']],
          ['2026-09-26', ['故宫']]
        ] as const
        const preservedPlaceCount = anchoredPlaces.filter(([date, names]) =>
          names.some((name) => revisedPlan.days.find((day) => day.date === date)
            ?.stops.some((stop) => stop.name.includes(name)))
        ).length
        const mealGapsForRevision = mealPreferenceFeedback([revisedPlan], mealRequirementsForRevision, true)
        const mealSlotGapCountForRevision = mealGapsForRevision.filter((gap) =>
          /缺少(?:早餐|午餐|晚餐)|取消的(?:早餐|午餐|晚餐)/u.test(gap)
        ).length
        const targetDate = revisionNumber === 1 ? '2026-09-23' : '2026-09-24'
        const beforeTargetDay = previousPlan.days.find((day) => day.date === targetDate)
        const afterTargetDay = revisedPlan.days.find((day) => day.date === targetDate)
        const targetDayChanged = !!beforeTargetDay && !!afterTargetDay &&
          planDayRevisionSignature(beforeTargetDay) !== planDayRevisionSignature(afterTargetDay)
        const targetRequestChecks = beijingRevisionChecks(revisedPlan, targetDate, revisionNumber)
        const targetRequestSatisfied = Object.values(targetRequestChecks).every(Boolean)
        const revisionScope = await itineraryRevisionScopeSummary(temporaryDirectory)
        const changedNonTargetDates = revisedPlan.days.filter((day) => day.date !== targetDate).filter((day) => {
          const previousDay = previousPlan.days.find((item) => item.date === day.date)
          return !previousDay || planDayRevisionSignature(previousDay) !== planDayRevisionSignature(day)
        }).map((day) => day.date)
        const stopCount = revisedPlan.days.reduce((sum, day) => sum + day.stops.length, 0)
        const summary = {
          revision: revisionNumber,
          terminalEvent: revisionEvents.at(-1) ?? 'none',
          draftCount: latestDraftMessage.itineraryOptions?.length ?? 0,
          dayCount: revisedPlan.days.length,
          exactDateCoverage,
          preservedPlaceCount,
          mealSlotGapCount: mealSlotGapCountForRevision,
          targetDayChanged,
          targetRequestSatisfied,
          targetRequestChecks,
          revisionScope,
          nonTargetChangedDayCount: changedNonTargetDates.length,
          changedNonTargetDates,
          stopCount,
          savedRevision: updatedTrip.activeRevisionId !== null
        }
        process.stdout.write(`${statusPrefix} revision metrics ${JSON.stringify(summary)}\n`)
        expect(summary.terminalEvent).toBe('complete')
        expect(summary.draftCount).toBe(1)
        expect(summary.dayCount).toBe(7)
        expect(summary.exactDateCoverage).toBe(true)
        expect(summary.preservedPlaceCount).toBe(5)
        expect(summary.mealSlotGapCount).toBe(0)
        expect(summary.targetRequestSatisfied).toBe(true)
        expect(summary.revisionScope.scope?.baselineAvailable).toBe(true)
        expect(summary.revisionScope.scope?.targetDayCount).toBe(1)
        expect(summary.revisionScope.scope?.protectedDayCount).toBe(6)
        expect(summary.nonTargetChangedDayCount).toBe(0)
        expect(summary.savedRevision).toBe(false)
        previousPlan = revisedPlan
      }
      failedQualityGate = undefined
    }
  } catch (error) {
    await flushSystemLogs()
    const errorKind = failedQualityGate ?? (error instanceof Error && /行程方案连续/u.test(error.message)
      ? 'candidate_validation'
      : classifyError(error))
    process.stderr.write(`${statusPrefix} failed ${errorKind}\n`)
    process.stderr.write(`${statusPrefix} failure origin ${safeFailureOrigin(error)}\n`)
    if (revisionRunErrorKind) process.stderr.write(`${statusPrefix} revision run error ${revisionRunErrorKind}\n`)
    process.stderr.write(statusPrefix + ' candidate failure categories ' + JSON.stringify(proposalFailureCategories(store.latestRunProgress)) + '\n')
    process.stderr.write(statusPrefix + ' candidate rejection details ' + JSON.stringify(proposalFailureDetails(store.latestRunProgress)) + '\n')
    process.stderr.write(statusPrefix + ' schedule diagnostics ' + JSON.stringify(proposalScheduleDiagnostics(store.latestRunProgress)) + '\n')
    process.stderr.write(statusPrefix + ' source providers ' + JSON.stringify(sourceProviderCounts(store)) + '\n')
    process.stderr.write(statusPrefix + ' route lookups ' + JSON.stringify(await routeLookupSummary(temporaryDirectory)) + '\n')
    process.stderr.write(statusPrefix + ' amap failures ' + JSON.stringify(await amapFailureSummary(temporaryDirectory)) + '\n')
    process.stderr.write(statusPrefix + ' run state ' + JSON.stringify(safeRunStateSummary(store.latestRunProgress)) + '\n')
    process.stderr.write(statusPrefix + ' meal repair progress ' + JSON.stringify(safeMealRepairProgress(store.latestRunProgress)) + '\n')
    process.stderr.write(statusPrefix + ' meal repair decisions ' + JSON.stringify(await mealRepairDecisionSummary(temporaryDirectory)) + '\n')
    process.stderr.write(statusPrefix + ' preparation progress ' + JSON.stringify(safePreparationRepairProgress(store.latestRunProgress)) + '\n')
    process.stderr.write(statusPrefix + ' tool outcomes ' + JSON.stringify(await toolOutcomeCounts(temporaryDirectory)) + '\n')
    process.stderr.write(statusPrefix + ' tool timings ' + JSON.stringify(await toolTimingSummary(temporaryDirectory)) + '\n')
    process.stderr.write(statusPrefix + ' model events ' + JSON.stringify(await modelEventSummary(temporaryDirectory)) + '\n')
    process.stderr.write(statusPrefix + ' agent requests ' + JSON.stringify(await agentRequestSummary(temporaryDirectory)) + '\n')
    throw new Error(errorKind)
  } finally {
    configureExternalFetcher()
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}, 5_400_000)

/** 失败时只输出首个本机源码函数与行列号，不回显异常正文或路径。 */
function safeFailureOrigin(error: unknown): string {
  if (!(error instanceof Error) || !error.stack) return 'unknown'
  const frame = error.stack.split('\n').slice(1).map((line) => line.trim())
    .find((line) => /\d+:\d+\)?$/u.test(line))
  if (!frame) return 'unknown'
  const match = frame.match(/^at (?:(.*?) \()?[^()]*\/([^/]+):(\d+):(\d+)\)?$/u)
  return match ? `${(match[1] || 'anonymous').slice(0, 80)} ${match[2]}:${match[3]}:${match[4]}` : 'unknown'
}

/** 将可选毫秒值转为秒数；没有完整结果时保留 null，避免误报为零秒。 */
function toElapsedSeconds(value: number | undefined): number | null {
  return value === undefined ? null : Math.round(value / 1000)
}

/** 生成不含内部 ID 和来源标识的日程比较签名，供真实修订评测判断目标日是否变化。 */
function planDayRevisionSignature(day: ItineraryOption['days'][number]): string {
  return JSON.stringify({
    title: day.title,
    stops: day.stops.map(({ name, area, time, durationMinutes, category, notes, transitToNext }) => ({
      name, area, time, durationMinutes, category, notes, transitToNext
    })),
    scheduleBlocks: day.scheduleBlocks.map(({ kind, title, time, durationMinutes, area, notes }) => ({
      kind, title, time, durationMinutes, area, notes
    }))
  })
}

/** 只校验北京修订回合的明确目标，不对整份行程设置内容模板。 */
function isBeijingRevisionRequestSatisfied(plan: ItineraryOption, date: string, revision: number): boolean {
  return Object.values(beijingRevisionChecks(plan, date, revision)).every(Boolean)
}

/** 按结构化停留点、时段和修改目标判断，不把说明中提及的历史地点当作实际安排。 */
function beijingRevisionChecks(plan: ItineraryOption, date: string, revision: number): Record<string, boolean> {
  const day = plan.days.find((item) => item.date === date)
  if (!day) return { targetDayExists: false }

  if (revision === 1) {
    const stopNames = day.stops.map((stop) => stop.name).join('\n')
    const hasHotelRest = day.scheduleBlocks.some((block) =>
      (block.kind === 'rest' || block.kind === 'buffer') &&
      /酒店/u.test(`${block.title} ${block.area} ${block.notes}`) &&
      /休息|休整|午休/u.test(`${block.title} ${block.notes}`)
    ) || day.stops.some((stop) => /休息/u.test(stop.category) &&
      /酒店/u.test(`${stop.name} ${stop.area} ${stop.notes}`))
    return {
      summerPalaceRetained: /颐和园/u.test(stopNames),
      removedAttractionsAbsent: !/香山|碧云寺/u.test(stopNames),
      hotelRestAfterLunch: hasRestAfterLunch(day, hasHotelRest)
    }
  }

  const mealText = [
    ...day.stops.filter((stop) => /餐|食/u.test(stop.category) || /晚餐|用餐/u.test(`${stop.name} ${stop.notes}`))
      .map((stop) => `${stop.name} ${stop.area} ${stop.notes}`),
    ...day.scheduleBlocks.filter((block) => block.kind === 'meal' || /晚餐/u.test(block.title))
      .map((block) => `${block.title} ${block.area} ${block.notes}`)
  ].join('\n')
  return { mealMovedToQianmen: /前门|大栅栏|鲜鱼口|北京坊/u.test(mealText) }
}

/** 检查酒店休息时段是否排在午餐之后；未知时刻不作为已满足。 */
function hasRestAfterLunch(
  day: ItineraryOption['days'][number],
  hasHotelRest: boolean
): boolean {
  if (!hasHotelRest) return false
  const minuteAt = (value: string): number | undefined => {
    const match = value.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)/u)
    return match ? Number(match[1]) * 60 + Number(match[2]) : undefined
  }
  const lunchItems = [
    ...day.stops.filter((stop) => /餐/u.test(stop.category) && /午餐|午饭/u.test(`${stop.name} ${stop.notes}`)),
    ...day.scheduleBlocks.filter((block) => block.kind === 'meal' && /午餐|午饭/u.test(`${block.title} ${block.notes}`))
  ]
  const restItems = [
    ...day.scheduleBlocks.filter((block) => (block.kind === 'rest' || block.kind === 'buffer') &&
      /酒店/u.test(`${block.title} ${block.area} ${block.notes}`)),
    ...day.stops.filter((stop) => /休息/u.test(stop.category) && /酒店/u.test(`${stop.name} ${stop.area} ${stop.notes}`))
  ]
  const postLunchLabel = restItems.some((item) =>
    /午餐后|午饭后|午餐结束后|午饭结束后/u.test(`${item.time} ${'name' in item ? item.name : item.title} ${item.notes}`)
  )
  if (postLunchLabel) return true
  const lunchEnds = lunchItems.map((item) => {
    const start = minuteAt(item.time)
    return start === undefined ? undefined : start + (item.durationMinutes ?? 0)
  }).filter((value): value is number => value !== undefined)
  if (lunchEnds.length === 0) return false
  const lunchEnd = Math.max(...lunchEnds)
  return restItems.some((item) => {
    const restStart = minuteAt(item.time)
    return restStart !== undefined && restStart >= lunchEnd
  })
}
