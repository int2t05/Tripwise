/** 规划会话编排：仅调用白名单工具，结果带来源后再交给模型整理。 */
import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentRunProgress, AgentRunTranscriptMessage, ChatMessage, ItineraryOption, SourceRecord, ToolFeedback, Trip, TripBrief } from '../shared/types.js'
import { executeTool, getToolDefinitions, type ToolResult } from './tools.js'
import { MAX_ITINERARY_ARGUMENT_CHARACTERS, MAX_TOOL_ARGUMENT_CHARACTERS, MAX_TOOL_CALLS_PER_MESSAGE } from '../shared/agent-limits.js'
import { areSearchProvidersExhausted, createAmapRouteCircuitBreaker, createSearchProviderCircuitBreaker, ToolInputError, type ResearchBrowserToolController } from './connectors/types.js'
import { briefProposalTool } from './connectors/brief.js'
import { itineraryFactRepairTargets } from './connectors/itinerary.js'
import { OpenAiCompatibleClient, redactCredentialText, type ApiMessage, type CodexModelContext, type ModelReasoningEffort, type ModelRequestMessage, type ModelToolChoice } from './llm.js'
import type { CodexAppServer } from './codex-app-server.js'
import { createResearchBrowserVisualReader } from './research-browser-vision.js'
import { itineraryEvidenceIdsRequiringSuccess, TripStore } from './persistence.js'
import { isAgentRunProgress, isItineraryOption, itinerarySourceIds } from './persistence/schema.js'
import { SecretVault } from './secrets.js'
import { McpToolSession } from './mcp/runtime.js'
import { conversationMessages, findConversation } from '../shared/conversations.js'
import { resolveResearchBrowserInput } from '../shared/research-browser-input.js'
import { explicitlyExcludedItineraryStopsForRequest, preserveUnchangedItineraryDays, unchangedItineraryDatesForRequest } from '../shared/itinerary-revisions.js'
import { canExecuteWithoutDestination, canExecuteWithoutExternalResearch, dailyIndoorRainAlternativesRequestedForConversation, dailyWeatherRequestedForConversation, hasExplicitDestinationMention, hasPlanningDestination, namedMealStopsRequestedForConversation, requiredMealSlotsForConversation, requiredPreparationCategoriesForRequest, requestedItineraryFactDetails, requestsBookingAlternative, requestsDetailedItinerary, requestsItineraryContingencies, requestsTripBriefUpdate, requiresDestinationClarification, requiresItineraryOutput, shouldEnrichItineraryRoutes, shouldRequestBudgetEstimate, toolsForPlanningDestination, userDeclinedExternalResearch } from './agent-tool-policy.js'
import { buildAgentSystemPrompt, buildFactRepairContextMessage, buildTripContextMessage, factRepairSourceMap, initialItineraryOutputPrompt, shouldCompactInitialItinerarySchema } from './agent-context.js'
import { sourcesForAgentContext } from './agent-source-context.js'
import { agentHistory } from './agent-history.js'
import { firecrawlReadStopReason, isRetryableBrowserNetworkFailure, MAX_BROWSER_NETWORK_FAILURES_PER_HOST, MAX_BROWSER_NETWORK_FAILURE_STREAK, researchBrowserTargetHost } from './agent-research.js'
import { appendItineraryOptions, choosePersistableItineraryOptions, classifyRejectedToolOutput, dailyIndoorRainSourceGuidance, itineraryCandidateRepairPrompt, itineraryFailureMessage, proposalToolRoundBudget, remapItinerarySourceIds, replaceItineraryOptions, shouldRequestItineraryFinalization } from './agent-itinerary-policy.js'
import { modelSafeResearchUrl, sanitizeResearchUrl } from './research-url.js'
import { classifyError, classifyPersistenceFailure, logSystemEvent, safeRouteFeedbackCodes } from './system-logger.js'
import { toolLabel, toolResultProgress } from './agent-progress.js'
import { reasoningEffortForProvider } from './agent-model-policy.js'
import { withModelRequestProgress } from './model-request-progress.js'

const MAX_TOOL_ROUNDS = 12
/** 长行程允许更多模型工具交互，仍受统一轮数上限约束。 */
const MAX_DETAILED_TOOL_ROUNDS = 40
/** 畸形工具调用只允许有限格式重交，避免协议错误无限循环。 */
const MAX_TOOL_CALL_FORMAT_RETRIES = 3
/** 工具 schema 连续返回 error 时有限修正，避免无效调用耗尽整轮预算。 */
const MAX_TOOL_RESULT_ERRORS = 3
/** 计划回执含业务反馈时，最多提醒模型复盘的次数；不代替模型选择工具。 */
const MAX_ITINERARY_REVIEW_PROMPTS = 3
const MAX_WEB_SEARCH_CALLS_PER_RUN = 12
/** 逐时段长行程逐点核对时，增加搜索预算覆盖用户点名地点。 */
const MAX_DETAILED_WEB_SEARCH_CALLS_PER_RUN = 24
/** 单轮最多补证的景点数；剩余地点保持待核验，计划仍可审阅。 */
const MAX_ITINERARY_FACT_REPAIR_TARGETS = 18
/** 模型漏掉行程工具调用时最多追加两次提交提醒，防止文字回复被误认为计划。 */
const MAX_MISSING_ITINERARY_TOOL_RECOVERIES = 2
const LOCAL_PROPOSAL_TOOLS = new Set(['propose_trip_brief', 'propose_itineraries', 'propose_itinerary_facts', 'propose_itinerary_meals', 'propose_preparation'])
type ApiToolCall = NonNullable<ApiMessage['tool_calls']>[number]

/** 工具回执的级别；只有 error 阻止候选保存，其他级别交给模型判断。 */
type AgentToolResultStatus = 'ok' | 'info' | 'warning' | 'error'

/** 传回模型的来源摘要只包含判断计划所需的信息。 */
interface AgentToolSource {
  id: string
  title: string
  url: string
  provider: string
  kind: SourceRecord['kind']
  sourceNature: SourceRecord['sourceNature']
  status: SourceRecord['status']
  fetchedAt?: string
  declaredAuthor?: string
  declaredPublishedAt?: string
  summary: string
}

/** AgentLoop 和工具之间稳定、可审计的结果协议。 */
interface AgentToolResultEnvelope {
  status: AgentToolResultStatus
  proposal_saved: boolean
  result: string
  feedback: ToolFeedback[]
  sources: AgentToolSource[]
  proposal?: {
    itineraryOptions?: ItineraryOption[]
    preparationOptions?: NonNullable<ChatMessage['preparationOptions']>
    briefProposal?: ChatMessage['briefProposal']
  }
}

/** 将工具反馈折叠成稳定状态，保留 info 级别供模型判断是否继续。 */
function toolResultStatus(feedback: ToolFeedback[] | undefined): AgentToolResultStatus {
  if (feedback?.some((item) => item.severity === 'error')) return 'error'
  if (feedback?.some((item) => item.severity === 'warning')) return 'warning'
  if (feedback?.some((item) => item.severity === 'info')) return 'info'
  return 'ok'
}

/** 将稳定反馈码转成聚焦的复核提示，不把 warning 升级成强制任务。 */
function itineraryReviewPrompt(feedbackCodes: ReadonlySet<string>): string {
  const routeSegmentMismatch = feedbackCodes.has('route_segment_not_planned')
  const routeModeMismatch = feedbackCodes.has('route_mode_mismatch')
  const routeResultAvailable = feedbackCodes.has('route_result_available')
  const routeRecoveryGuidance = routeResultAvailable
    ? '路线工具已返回可用来源。对照候选确认相邻地点、日期、交通方式和计划离开时刻；若时刻不一致，按起点停留结束时刻重查。若结果匹配，重新提交当前方案绑定来源。不要重复查询已匹配路段；其余保留待核验。'
    : routeSegmentMismatch
      ? '路线工具回执说明端点不是计划中的同日相邻路段。先读回执列出的候选路段，再决定是否用其中的原始地点名、日期和交通方式重查。'
      : routeModeMismatch
        ? '路线工具回执说明查询方式与计划不一致。按计划中的交通方式查询，或先修改候选计划。'
        : ''
  const routeGuidance = feedbackCodes.has('requested_route_coverage_missing')
    ? '用户要求具体交通安排，但部分公共交通路段仍无来源估时。先判断预约衔接、跨区移动或车站/机场接驳中影响最大的 1–3 段相邻路段；若 estimate_route 可用且值得查询，使用计划中的原地点名、对应日期和交通方式调用，再提交计划以绑定来源。出发时刻按起点活动结束时间计算：范围取结束时刻，单一开始时刻加停留时长；只有单一时刻且无停留时长时才直接使用。模糊时段省略，不要推测。无需覆盖全部路段；未查或无结果时标为待核验。'
    : ''
  const reviewGuidance = '其他缺口由你判断；无法可靠补足时保留待核验，若无需调整即可交付。不要为清零反馈机械调用工具。'
  const heading = routeRecoveryGuidance && !routeGuidance ? '路线工具返回 warning。' : '计划已保存。'
  return [heading, routeRecoveryGuidance, routeGuidance, reviewGuidance].filter(Boolean).join(' ')
}

/** 为不同连接器补齐统一反馈字段，避免模型依赖自然语言猜测成功状态。 */
function normalizeToolFeedback(name: string, result: ToolResult): ToolResult {
  if (result.feedback) return result
  if (result.routeFailureKind === 'input_error') {
    return { ...result, feedback: [{ severity: 'error', code: 'invalid_input', message: result.output }] }
  }
  if (result.routeFailureKind) {
    return { ...result, feedback: [{ severity: 'warning', code: result.routeFailureKind, message: result.output }] }
  }
  const rejectedStructuredResult = (name === 'propose_itineraries' && !result.itineraryOptions?.length) ||
    (name === 'propose_itinerary_facts' && !result.itineraryOptions?.length) ||
    (name === 'propose_itinerary_meals' && !result.itineraryOptions?.length) ||
    (name === 'propose_preparation' && !result.preparationOptions?.length) ||
    (name === 'propose_trip_brief' && !result.briefProposal)
  if (rejectedStructuredResult) {
    return {
      ...result,
      feedback: [{ severity: 'error', code: 'structured_result_not_saved', message: result.output || '结构化结果未保存。' }]
    }
  }
  const unavailableSources = result.sources.filter((source) => source.status === 'error' || source.status === 'unavailable').length
  return {
    ...result,
    feedback: unavailableSources > 0
      ? [{ severity: 'warning', code: 'source_unavailable', message: `${unavailableSources} 个来源不可用；判断是否需要其他来源。` }]
      : []
  }
}

/** 失败保存时只汇总非成功来源的类型和状态，不记录来源 ID 或页面内容。 */
function failedItineraryEvidenceSourceSummary(
  itineraryOptions: ItineraryOption[],
  sources: SourceRecord[]
): { count: number; summary: string } {
  const sourceById = new Map(sources.map((source) => [source.id, source]))
  const referencedIds = new Set(itineraryOptions.flatMap(itinerarySourceIds))
  const requiredSuccessIds = new Set(itineraryOptions.flatMap(itineraryEvidenceIdsRequiringSuccess))
  const counts = new Map<string, number>()
  for (const id of referencedIds) {
    const source = sourceById.get(id)
    if (!source) {
      counts.set('missing:unknown', (counts.get('missing:unknown') ?? 0) + 1)
      continue
    }
    if (!requiredSuccessIds.has(id) || source.status === 'success') continue
    const key = `${source.kind}:${source.status}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return {
    count: [...counts.values()].reduce((total, count) => total + count, 0),
    summary: counts.size > 0
      ? [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => `${key}=${count}`).join(',')
      : 'none'
  }
}

/** 将用户对话和旅行约束交给在线模型，逐项保存工具来源和最终回复。 */
export class TravelAgent {
  private readonly client: OpenAiCompatibleClient

  /** 允许受控评测替换工具执行边界；桌面应用默认使用正式连接器。 */
  constructor(
    private readonly toolExecutor: typeof executeTool = executeTool,
    private readonly codexAppServer?: CodexAppServer
  ) {
    this.client = new OpenAiCompatibleClient(codexAppServer)
  }

  /** 清理已删除话题在 Codex 中对应的持久线程。 */
  async deleteCodexConversationThread(tripId: string, conversationId: string): Promise<void> {
    await this.codexAppServer?.deleteConversation(`${tripId}:${conversationId}`)
  }

  /** 应用启动时移除旅行数据中已不存在的话题线程。 */
  async reconcileCodexThreads(trips: Trip[]): Promise<void> {
    const keys = new Set(trips.flatMap((trip) => trip.conversations.map((conversation) => `${trip.id}:${conversation.id}`)))
    await this.codexAppServer?.reconcile(keys)
  }

  /** 应用退出时停止常驻 App Server 子进程。 */
  async close(): Promise<void> {
    await this.codexAppServer?.close()
  }

  /** 保存用户输入、执行有限工具循环并返回会话 ID。 */
  async run(
    store: TripStore,
    vault: SecretVault,
    tripId: string,
    content: string,
    requestId: string,
    signal: AbortSignal,
    emit: (event: AgentEvent) => void,
    resumeMessageId?: string,
    conversationId?: string,
    researchBrowser?: ResearchBrowserToolController
  ): Promise<void> {
    const inputText = content.trim()
    if (!inputText || inputText.length > 12_000) throw new Error('输入需为 1–12,000 个字符。')
    const traceId = randomUUID()
    const runStartedAt = Date.now()
    const preRunSnapshot = store.snapshot()
    const tripBeforeRun = this.requireTrip(preRunSnapshot.trips, tripId)
    const targetConversationId = conversationId ?? tripBeforeRun.activeConversationId
    if (!findConversation(tripBeforeRun, targetConversationId)) throw new Error('找不到这趟旅行中的对话话题。')
    const apiKey = await vault.get('modelKey')
    const codexCliModel = preRunSnapshot.settings.model.provider === 'codex-cli'
    const modelAvailable = codexCliModel || !!apiKey
    const amapKey = await vault.get('amapKey')
    const amapJsKey = await vault.get('amapJsKey')
    const amapSecurityCode = await vault.get('amapSecurityCode')
    const exaKey = await vault.get('exaKey')
    const tavilyKey = await vault.get('tavilyKey')
    const firecrawlKey = await vault.get('firecrawlKey')
    const mcpEnvironments = await Promise.all(preRunSnapshot.settings.mcpServers
      .filter((server) => server.enabled)
      .map((server) => vault.getMcpEnvironment(server.id, server.envKeys)))
    const configuredRedactions = [
      apiKey, amapKey, amapJsKey, amapSecurityCode, exaKey, tavilyKey, firecrawlKey,
      ...mcpEnvironments.flatMap((environment) => Object.values(environment))
    ]
      .filter((value): value is string => !!value)
    // 已配置凭证和常见标注格式先在本机清理，避免误贴内容进入旅行记录。
    const text = redactCredentialText(inputText, configuredRedactions)
    const previousMessages = conversationMessages(tripBeforeRun, targetConversationId)
    let userMessageId: string
    if (resumeMessageId !== undefined) {
      const latestMessage = previousMessages.at(-1)
      if (latestMessage?.id !== resumeMessageId || latestMessage.role !== 'user' || latestMessage.content !== text) {
        throw new Error('只能重新处理这趟旅行中最后一条尚未收到回复的原始消息。')
      }
      userMessageId = latestMessage.id
    } else {
      const userMessage: ChatMessage = {
        id: randomUUID(), conversationId: targetConversationId, role: 'user', content: text,
        createdAt: new Date().toISOString(), sourceIds: []
      }
      await store.appendMessage(tripId, userMessage, targetConversationId)
      userMessageId = userMessage.id
    }
    this.emit(emit, requestId, tripId, targetConversationId, 'status', '正在整理旅行上下文…')

    const snapshot = store.snapshot()
    const currentTrip = this.requireTrip(snapshot.trips, tripId)
    const currentMessages = conversationMessages(currentTrip, targetConversationId)
    const userMessages = currentMessages.filter((message) => message.role === 'user').map((message) => message.content)
    const userAuthoredContext = userMessages.join('\n')
    const latestUserText = userMessages.at(-1) ?? ''
    const codexConversationKey = `${tripId}:${targetConversationId}`
    const codexSelected = snapshot.settings.model.provider === 'codex-cli'
    let codexRunStarted = false
    let codexPendingMessages: ModelRequestMessage[] = []
    /** 把本轮尚未发送的工具回执或纠错消息增量交给同一 Codex thread。 */
    const codexContext = (phase: 'continue' | 'finalize' = 'continue'): CodexModelContext | undefined =>
      codexSelected ? {
        conversationKey: codexConversationKey,
        userText: latestUserText,
        phase: codexRunStarted ? phase : 'run-start',
        ...(codexPendingMessages.length ? { continuationMessages: codexPendingMessages } : {})
      } : undefined
    /** 仅在模型成功返回后清空回执，失败时保留供显式恢复。 */
    const markCodexTurnCompleted = (): void => {
      if (!codexSelected) return
      codexRunStarted = true
      codexPendingMessages = []
    }
    // 局部修订以最近的未拒绝草案为基线，避免误用已确认旧版本或已拒绝方案。
    const priorDraftMessage = [...currentMessages].reverse().find((message) => message.role === 'assistant' &&
      (message.itineraryOptions ?? []).some((option) => !message.rejectedItineraryOptionIds?.includes(option.id)))
    const revisionBaseline = priorDraftMessage?.itineraryOptions?.slice().reverse().find((option) =>
      !priorDraftMessage.rejectedItineraryOptionIds?.includes(option.id)
    ) ?? currentTrip.revisions.find((revision) => revision.id === currentTrip.activeRevisionId)?.itinerary
    const unchangedItineraryDates = revisionBaseline
      ? unchangedItineraryDatesForRequest(latestUserText, revisionBaseline)
      : []
    const excludedItineraryStops = revisionBaseline
      ? explicitlyExcludedItineraryStopsForRequest(latestUserText, revisionBaseline, unchangedItineraryDates)
      : []
    const protectedDateSet = new Set(unchangedItineraryDates)
    logSystemEvent('info', 'agent.itinerary_revision.scope', {
      traceId,
      baselineAvailable: revisionBaseline !== undefined,
      baselineDayCount: revisionBaseline?.days.length ?? 0,
      protectedDayCount: unchangedItineraryDates.length,
      excludedStopCount: excludedItineraryStops.length,
      targetDayCount: revisionBaseline
        ? revisionBaseline.days.filter((day) => day.date && !protectedDateSet.has(day.date)).length
        : 0
    })
    const budgetRequested = shouldRequestBudgetEstimate(currentTrip.brief.budget, userMessages)
    const externalResearchDisabled = userDeclinedExternalResearch(latestUserText)
    const detailedItineraryRequested = requiresItineraryOutput(latestUserText) && requestsDetailedItinerary(latestUserText)
    const routeCoverageRequested = shouldEnrichItineraryRoutes(latestUserText, revisionBaseline !== undefined)
    const inheritedFactDetails = requestedItineraryFactDetails(latestUserText, revisionBaseline)
    const openingHoursDetailsRequested = inheritedFactDetails.openingHours
    const bookingDetailsRequested = inheritedFactDetails.booking
    const ticketPriceDetailsRequested = inheritedFactDetails.ticketPrice
    const itineraryContingenciesRequested = requiresItineraryOutput(latestUserText) && requestsItineraryContingencies(latestUserText)
    const bookingAlternativeRequested = requiresItineraryOutput(latestUserText) && requestsBookingAlternative(latestUserText)
    const dailyWeatherRequested = dailyWeatherRequestedForConversation(userMessages)
    const dailyIndoorRainAlternativesRequested = dailyIndoorRainAlternativesRequestedForConversation(userMessages)
    const savedProgress = currentMessages.at(-1)?.id === userMessageId ? currentMessages.at(-1)?.agentRunProgress : undefined
    const transcript: AgentRunTranscriptMessage[] = savedProgress?.transcript.map((message) => ({
      ...message,
      ...(message.allowedToolNames ? { allowedToolNames: [...message.allowedToolNames] } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call) => ({ ...call, function: { ...call.function } })) } : {})
    })) ?? []
    if (codexSelected) {
      // 恢复中断轮次时，最近一次模型回复之后的消息尚未进入持久 thread。
      let lastAssistantIndex = -1
      transcript.forEach((message, index) => {
        if (message.role === 'assistant') lastAssistantIndex = index
      })
      codexPendingMessages = transcript.slice(lastAssistantIndex + 1)
        .filter((message) => message.role !== 'assistant')
        .map((message) => ({ ...message }))
    }
    let itineraryOptions: ItineraryOption[] = savedProgress?.itineraryOptions.map((option) => option) ?? []
    let preparationOptions: NonNullable<ChatMessage['preparationOptions']> = savedProgress?.preparationOptions.map((item) => item) ?? []
    const factRepairTargetsFor = (options: ItineraryOption[]) => itineraryFactRepairTargets(options, {
      openingHours: openingHoursDetailsRequested,
      booking: bookingDetailsRequested,
      ticketPrice: ticketPriceDetailsRequested
    }, unchangedItineraryDates, currentTrip.brief.interests ? [currentTrip.brief.interests] : [], MAX_ITINERARY_FACT_REPAIR_TARGETS)
    const factDetailsRequested = openingHoursDetailsRequested || bookingDetailsRequested || ticketPriceDetailsRequested
    const deferredProposalCallIds = new Set<string>()
    const requiredPreparationCategories = requiredPreparationCategoriesForRequest(latestUserText)
    let briefProposal: ChatMessage['briefProposal'] = savedProgress?.briefProposal
    let invalidItinerarySubmissions = 0
    let invalidItineraryArgumentSubmissions = 0
    let toolCallFormatRetries = transcript.filter((message) =>
      message.role === 'user' && message.content?.startsWith('工具调用格式校验失败（')
    ).length
    let lastItineraryFailure = agentHistory.latestRejectedItineraryProposal(transcript)
    let webSearchCallsUsed = transcript.reduce((count, message) =>
      count + (message.role === 'assistant' ? message.tool_calls?.filter((call) => call.function.name === 'search_web').length ?? 0 : 0), 0)
    let searchBudgetExhaustionLogged = false
    let firecrawlReadStopped: 'quota' | 'rate-limit' | undefined
    let browserNetworkFailureStreak = 0
    let browserCircuitOpen = false
    const browserNetworkFailuresByHost = new Map<string, number>()
    const browserUnavailableHosts = new Set<string>()
    const searchProviderCircuitBreaker = createSearchProviderCircuitBreaker({ exaKey, tavilyKey, firecrawlKey })
    const amapRouteCircuitBreaker = createAmapRouteCircuitBreaker()
    const firecrawlDisabledForRun = (): boolean =>
      !!firecrawlReadStopped || searchProviderCircuitBreaker.disabled.has('Firecrawl')
    const exaPageAvailable = (): boolean => !!exaKey && !searchProviderCircuitBreaker.disabled.has('Exa')
    const webPageProviderAvailable = (): boolean =>
      (!!firecrawlKey && !firecrawlDisabledForRun()) || exaPageAvailable()
    const connectors = snapshot.settings.connectors
    const researchBrowserVisualReadEnabled = snapshot.settings.researchBrowserVisualRead
    const analyzeResearchScreenshot = researchBrowserVisualReadEnabled && modelAvailable
      ? createResearchBrowserVisualReader(
        (messages: ModelRequestMessage[], imageSignal?: AbortSignal) => this.client.complete(
          snapshot.settings.model, apiKey ?? '', messages, undefined, imageSignal,
          configuredRedactions, traceId, 'compact', 'auto', 'low'
        ),
        configuredRedactions
      )
      : undefined
    const sourceIds = new Set(savedProgress?.sourceIds ?? [])
    let forceItinerarySubmission = false
    let forcedItinerarySubmissionAttempts = 0
    let toolResultErrorStreak = 0
    let itineraryReviewPromptPending = false
    let itineraryReviewPromptCount = 0
    const itineraryReviewFeedbackCodes = new Set<string>()
    const logRunCompleted = (): void => logSystemEvent('info', 'agent.run.completed', {
      traceId,
      durationMs: Date.now() - runStartedAt,
      status: 'completed',
      sourceCount: sourceIds.size,
      itineraryCount: itineraryOptions.length,
      preparationCount: preparationOptions.length
    })
    const xiaohongshu = snapshot.settings.xiaohongshu
    const mealRequirements = requiredMealSlotsForConversation(
      userMessages, currentTrip.brief.startDate, currentTrip.brief.endDate, currentTrip.brief.constraints
    )
    const namedMealPreference = namedMealStopsRequestedForConversation(userMessages, currentTrip.brief.constraints)
    const namedMealStopsRequired = namedMealPreference &&
      (!mealRequirements || mealRequirements.some((requirement) => requirement.slots.length > 0))
    const webSearchCallLimit = detailedItineraryRequested
      ? MAX_DETAILED_WEB_SEARCH_CALLS_PER_RUN
      : MAX_WEB_SEARCH_CALLS_PER_RUN
    const toolDefinitionsForBrief = (
      brief: Trip['brief'], includePlanningRequirements: boolean, availableSources: SourceRecord[] = []
    ) => getToolDefinitions({
      amapKey,
      amapRouteCircuitBreaker,
      exaKey,
      tavilyKey,
      firecrawlKey,
      searchProviderCircuitBreaker,
      connectors,
      xiaohongshu,
      budgetRequested,
      researchBrowser,
      researchBrowserVisualReadEnabled,
      analyzeResearchScreenshot,
      sourceIds: [...new Set([...sourceIds, ...availableSources.map((source) => source.id)])],
      availableSources,
      tripBrief: brief,
      revisionBaseline,
      unchangedItineraryDates,
      excludedItineraryStops,
      ...(includePlanningRequirements ? {
        itineraryOptions,
        requireNamedMealStops: namedMealStopsRequired,
        factRepairSourceBindings: factRepairSourceMap(
          availableSources, factRepairTargetsFor(itineraryOptions), latestUserText
        ).targets,
        requiredMealSlots: requiredMealSlotsForConversation(userMessages, brief.startDate, brief.endDate, brief.constraints),
        detailedItineraryRequested,
        routeCoverageRequested,
        openingHoursDetailsRequested,
        bookingDetailsRequested,
        ticketPriceDetailsRequested,
        itineraryContingenciesRequested,
        bookingAlternativeRequested,
        dailyWeatherRequested,
        dailyIndoorRainAlternativesRequested
      } : {})
    })
    let mcp: McpToolSession | undefined
    let openingMcp: Promise<McpToolSession> | undefined
    let runStage: 'setup' | 'tool_recovery' | 'tool_loop' | 'model_request' | 'model_response' |
      'tool_execution' | 'finalization' | 'result_persistence' | 'completion_checks' = 'setup'

    /** 有明确目的地后才启动用户配置的插件，并立即保存连接诊断。 */
    const ensureMcpSession = async (): Promise<McpToolSession> => {
      if (openingMcp) return openingMcp
      if (mcp) return mcp
      if (!openingMcp) {
        this.emit(emit, requestId, tripId, targetConversationId, 'status', '正在连接已启用的旅行插件…')
        openingMcp = McpToolSession.open(snapshot.settings.mcpServers, vault, signal).then(async (session) => {
          mcp = session
          if (session.diagnostics.length) {
            const diagnosticIds = await store.saveSources(tripId, session.diagnostics)
            diagnosticIds.forEach((id) => sourceIds.add(id))
          }
          if (session.unavailable.length) {
            this.emit(emit, requestId, tripId, targetConversationId, 'status', `${session.unavailable.length} 项插件服务暂不可用，继续使用已连接的工具。`)
          }
          return session
        })
      }
      return openingMcp
    }

    logSystemEvent('info', 'agent.run.started', { traceId })
    try {
      if (!modelAvailable) throw new Error(await missingModelKeyMessage(vault))
      if (!externalResearchDisabled && hasPlanningDestination(currentTrip.brief, briefProposal, userAuthoredContext, latestUserText)) await ensureMcpSession()
      runStage = 'model_request'
      let contextTrip = currentTrip
      /** 连续网络失败时熔断，避免 Agent 重复导航不可达网页。 */
      const recordBrowserNavigationResult = (result: ToolResult, host: string): void => {
        const failed = result.sources.some((source) => source.status !== 'success')
        if (!failed) {
          browserNetworkFailuresByHost.delete(host)
          browserUnavailableHosts.delete(host)
          browserNetworkFailureStreak = 0
          return
        }

        const failureKind = result.browserNavigationFailureKind
        if (!isRetryableBrowserNetworkFailure(failureKind)) {
          browserNetworkFailuresByHost.delete(host)
          browserNetworkFailureStreak = 0
          return
        }

        const hostFailureCount = (browserNetworkFailuresByHost.get(host) ?? 0) + 1
        browserNetworkFailuresByHost.set(host, hostFailureCount)
        if (hostFailureCount >= MAX_BROWSER_NETWORK_FAILURES_PER_HOST && !browserUnavailableHosts.has(host)) {
          browserUnavailableHosts.add(host)
          logSystemEvent('warn', 'agent.research.browser_host_circuit_opened', {
            traceId, status: 'degraded', reason: 'repeated_host_network_failure', sourceCount: sourceIds.size,
            browserNavigationFailureKind: failureKind,
            browserCircuitFailureCount: hostFailureCount
          })
          this.emit(emit, requestId, tripId, targetConversationId, 'status',
            '该网页来源连续连接失败，已停止重复导航；仍可尝试其他来源。')
        }

        browserNetworkFailureStreak += 1
        if (!browserCircuitOpen && browserNetworkFailureStreak >= MAX_BROWSER_NETWORK_FAILURE_STREAK) {
          browserCircuitOpen = true
          logSystemEvent('warn', 'agent.research.browser_circuit_opened', {
            traceId, status: 'degraded', reason: 'repeated_network_failure', sourceCount: sourceIds.size,
            browserNavigationFailureKind: failureKind,
            browserCircuitFailureCount: browserNetworkFailureStreak
          })
          this.emit(emit, requestId, tripId, targetConversationId, 'status',
            '研究网页连续遇到网络错误，已暂停本轮重复导航。')
        }
      }
      const messages: ApiMessage[] = [
        { role: 'system', content: `${buildAgentSystemPrompt(!!amapKey && connectors.routes, budgetRequested, detailedItineraryRequested, webPageProviderAvailable() && connectors.webSearch, !!amapKey && connectors.places)}${mcp?.unavailable.length ? '\n\n部分 MCP 插件暂不可用；本轮只使用成功连接的工具。' : ''}` },
        buildTripContextMessage(contextTrip, currentMessages, {
          unchangedItineraryDates, currentSourceIds: sourceIds
        }),
        ...agentHistory.boundedHistory(currentMessages).map((item) => ({ role: item.role, content: item.content } as ApiMessage)),
        ...transcript
      ]

      /** 保存可恢复的本轮工具进度，不写入界面快照或显式旅行备份。 */
      const persistProgress = async (): Promise<void> => {
        const progress: AgentRunProgress = {
          transcript,
          sourceIds: [...sourceIds],
          itineraryOptions,
          preparationOptions,
          ...(briefProposal ? { briefProposal } : {}),
          updatedAt: new Date().toISOString()
        }
        try {
          await store.updateAgentRunProgress(tripId, userMessageId, progress)
        } catch (error) {
          // 只记录固定失败类别，区分行程结构与其他恢复点问题，不写候选正文。
          const progressValue: unknown = progress
          const reason = !isAgentRunProgress(progressValue)
            ? progress.itineraryOptions.some((option) => !isItineraryOption(option))
              ? 'itinerary_schema'
              : 'progress_schema'
            : 'store_rejected'
          logSystemEvent('error', 'agent.run.progress_save_failed', { traceId, reason })
          throw error
        }
      }

      /** 重跑未完成的工具调用，并逐项保存已完成结果供显式恢复。 */
      const runPendingToolCalls = async (): Promise<unknown> => {
        const calls = agentHistory.findUnresolvedToolCalls(transcript)
        if (calls.length === 0) return undefined
        const availableTrip = this.requireTrip(store.snapshot().trips, tripId)
        const availableSourceIds = [...new Set([...sourceIds, ...availableTrip.sources.map((source) => source.id)])]
        const availableItinerary = availableTrip.revisions.find((revision) => revision.id === availableTrip.activeRevisionId)?.itinerary
        const allowedToolCalls = new Map<string, boolean>()
        for (const message of transcript) {
          if (message.role !== 'assistant' || message.allowedToolNames === undefined) continue
          const allowedNames = new Set(message.allowedToolNames)
          for (const call of message.tool_calls ?? []) {
            allowedToolCalls.set(call.id, allowedNames.has(call.function.name))
          }
        }
        const isToolAllowed = (call: ApiToolCall): boolean => allowedToolCalls.get(call.id) ?? true
        let rejectedToolCall: unknown
        let progressSaveError: unknown
        let progressSaveFailed = false
        let saveQueue = Promise.resolve()

        /** 每个工具返回即进入串行保存队列，保证慢工具不会延迟已完成结果的检查点。 */
        const saveCompletedToolCall = (
          call: ApiToolCall,
          result: ToolResult,
          replaceItineraries = false,
          maxOutputCharacters?: number
        ): Promise<ToolResult> => {
          let savedResult = normalizeToolFeedback(call.function.name, result)
          const save = saveQueue.then(async () => {
            const blockedByFeedback = savedResult.feedback?.some((item) => item.severity === 'error') ?? false
          const itineraryBeforeToolResult = itineraryOptions
            toolResultErrorStreak = blockedByFeedback ? toolResultErrorStreak + 1 : 0
            if (blockedByFeedback) {
              // error 是候选保存的硬门槛；warning/info 仍交给模型判断，不在主循环里自动修订。
              savedResult = {
                ...savedResult,
                itineraryOptions: undefined,
                preparationOptions: undefined,
                briefProposal: undefined,
                output: '工具返回 error，候选未保存；上一版草案已保留。'
              }
            } else if (result.itineraryOptions?.length) {
              try {
                const proposedOptions = replaceItineraries
                  ? replaceItineraryOptions(result.itineraryOptions)
                  : appendItineraryOptions(itineraryOptions, result.itineraryOptions)
                const accepted = choosePersistableItineraryOptions(itineraryOptions, proposedOptions)
                if (!accepted.accepted) {
                  logSystemEvent('warn', 'agent.itinerary.submission_rejected', {
                    traceId, status: 'rejected', reason: 'invalid_option_schema'
                  })
                  savedResult = {
                    output: '候选方案未通过本地结构校验；上一版草案已保留。',
                    sources: result.sources,
                    feedback: [{
                      severity: 'error',
                      code: 'candidate_schema_invalid',
                      message: '行程修订未通过本地结构校验。'
                    }]
                  }
                } else {
                  itineraryOptions = accepted.options
                  savedResult = {
                    ...savedResult,
                    itineraryOptions,
                    output: ['propose_itinerary_meals', 'propose_itinerary_facts'].includes(call.function.name)
                      ? result.output
                      : '已生成 1 份待审阅草案。用户可以继续提出修改；确认后保存为当前行程。'
                  }
                }
              } catch (error) {
                savedResult = {
                  output: '行程草案未能保存；上一版草案已保留。',
                  sources: result.sources,
                  feedback: [{
                    severity: 'error',
                    code: 'candidate_save_failed',
                    message: redactCredentialText(error instanceof Error ? error.message : '行程草案未能保存。', configuredRedactions).slice(0, 1_200)
                  }]
                }
              }
            }
            if (savedResult.preparationOptions?.length) preparationOptions = savedResult.preparationOptions
            if (savedResult.briefProposal) {
              briefProposal = briefProposal
                ? {
                    base: { ...briefProposal.base, ...savedResult.briefProposal.base },
                    changes: { ...briefProposal.changes, ...savedResult.briefProposal.changes }
                  }
                : savedResult.briefProposal
            }
            const savedIds = await store.saveSources(tripId, savedResult.sources)
            const persistedSourceIds = new Map(savedResult.sources.map((source, index) => [source.id, savedIds[index] ?? source.id]))
            if (persistedSourceIds.size) {
              savedResult = {
                ...savedResult,
                ...(savedResult.itineraryOptions
                  ? { itineraryOptions: remapItinerarySourceIds(savedResult.itineraryOptions, persistedSourceIds) }
                  : {})
              }
              itineraryOptions = remapItinerarySourceIds(itineraryOptions, persistedSourceIds)
            }
            if (savedResult.itineraryOptions?.length) {
              const currentSources = this.requireTrip(store.snapshot().trips, tripId).sources
              const invalidSources = failedItineraryEvidenceSourceSummary(savedResult.itineraryOptions, currentSources)
              if (invalidSources.count > 0) {
                const previousSources = failedItineraryEvidenceSourceSummary(itineraryBeforeToolResult, currentSources)
                itineraryOptions = previousSources.count > 0 ? [] : itineraryBeforeToolResult
                toolResultErrorStreak = 1
                savedResult = {
                  ...savedResult,
                  itineraryOptions: undefined,
                  output: '候选引用了不可用来源，未保存；请重新检索或移除失效引用后再提交。',
                  feedback: [
                    ...(savedResult.feedback ?? []).filter((item) => item.severity !== 'error'),
                    {
                      severity: 'error',
                      code: 'itinerary_source_invalid',
                      message: `${invalidSources.count} 项行程依据不存在或来源状态不可用；请改用已成功的来源，或移除对应引用。`
                    }
                  ]
                }
              }
            }
            savedIds.forEach((id) => sourceIds.add(id))
            const sourceIndex = new Map(this.requireTrip(store.snapshot().trips, tripId).sources.map((source) => [source.id, source]))
            const modelSources: AgentToolSource[] = savedIds.flatMap((id) => {
              const source = sourceIndex.get(id)
              return source ? [{
                id: source.id,
                title: source.title.slice(0, 200),
                url: modelSafeResearchUrl(source.url).slice(0, 500),
                provider: source.provider.slice(0, 100),
                kind: source.kind,
                sourceNature: source.sourceNature,
                status: source.status,
                fetchedAt: source.fetchedAt,
                declaredAuthor: source.declaredAuthor,
                declaredPublishedAt: source.declaredPublishedAt,
                summary: source.summary.slice(0, 240)
              }] : []
            })
            // 只把已保存计划的非硬性反馈交回模型复盘，不在主进程自动修订业务内容。
            if (
              savedResult.itineraryOptions?.length &&
              ['propose_itineraries', 'propose_itinerary_meals', 'propose_itinerary_facts'].includes(call.function.name) &&
              savedResult.feedback?.some((item) => item.severity === 'warning' || item.severity === 'info')
            ) {
              itineraryReviewPromptPending = true
              for (const item of savedResult.feedback ?? []) {
                if (item.severity === 'warning' || item.severity === 'info') {
                  itineraryReviewFeedbackCodes.add(item.code)
                }
              }
            }
            if (call.function.name === 'estimate_route') {
              for (const item of savedResult.feedback ?? []) {
                if (['route_segment_not_planned', 'route_mode_mismatch'].includes(item.code)) {
                  itineraryReviewPromptPending = true
                  itineraryReviewFeedbackCodes.add(item.code)
                }
              }
              // 成功路线需由后续计划提案绑定；提醒模型复核，不在运行层自动改写计划。
              if (routeCoverageRequested && itineraryOptions.length > 0 &&
                (savedResult.routeOptions?.length || savedResult.sources.some((source) =>
                  source.kind === 'route' && source.status === 'success'
                ))) {
                itineraryReviewPromptPending = true
                itineraryReviewFeedbackCodes.add('route_result_available')
              }
            }
            const resultEnvelope: AgentToolResultEnvelope = {
              status: toolResultStatus(savedResult.feedback),
              // 候选是否保存由运行层给出，不能让模型从结果文字猜测。
              proposal_saved: ['propose_itineraries', 'propose_itinerary_facts', 'propose_itinerary_meals'].includes(call.function.name) &&
                (savedResult.itineraryOptions?.length ?? 0) > 0 &&
                !savedResult.feedback?.some((item) => item.severity === 'error'),
              result: maxOutputCharacters === undefined
                ? compactToolOutput(call.function.name, savedResult.output)
                : limitToolOutputCharacters(compactToolOutput(call.function.name, savedResult.output), maxOutputCharacters),
              feedback: savedResult.feedback ?? [],
              sources: modelSources,
              ...((savedResult.itineraryOptions?.length || savedResult.preparationOptions?.length || savedResult.briefProposal)
                ? { proposal: {
                    ...(savedResult.itineraryOptions?.length ? { itineraryOptions: savedResult.itineraryOptions } : {}),
                    ...(savedResult.preparationOptions?.length ? { preparationOptions: savedResult.preparationOptions } : {}),
                    ...(savedResult.briefProposal ? { briefProposal: savedResult.briefProposal } : {})
                  } }
                : {})
            }
            const toolMessage: AgentRunTranscriptMessage = {
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(resultEnvelope)
            }
            messages.push(toolMessage)
            transcript.push(toolMessage)
            if (codexSelected) codexPendingMessages.push(toolMessage)
            logSystemEvent('info', 'agent.tool.result.saved', {
              traceId,
              toolName: call.function.name,
              status: 'returned',
              feedbackSeverity: toolResultStatus(savedResult.feedback),
              routeFeedbackCodes: ['estimate_route', 'propose_itineraries'].includes(call.function.name)
                ? safeRouteFeedbackCodes(savedResult.feedback?.map((item) => item.code) ?? []).join(',')
                : undefined,
              toolOutputCharacters: typeof toolMessage.content === 'string' ? toolMessage.content.length : 0,
              sourceCount: savedResult.sources.length,
              itineraryCount: savedResult.itineraryOptions?.length ?? 0
            })
            await persistProgress()
            const progress = toolResultProgress(call.function.name, savedResult)
            this.emit(emit, requestId, tripId, targetConversationId, 'tool_result', progress.message, call.function.name, call.id, progress.outcome, progress.feedback)
            return savedResult
          })
          saveQueue = save.then(() => undefined, (error: unknown) => {
            if (!progressSaveFailed) progressSaveError = error
            progressSaveFailed = true
          })
          return save
        }

        /** 先核对用户原话中的目的地，再决定是否运行地点相关的外部查询。 */
        const runCalls = async (batch: ApiToolCall[]): Promise<void> => {
          // 在并行执行前按模型返回顺序预留检索额度，避免并发调用越过上限。
          const allowedSearchCalls = new Set<string>()
          let itinerarySubmittedInBatch = false
          for (const call of batch) {
            if (call.function.name !== 'search_web') continue
            if (!isToolAllowed(call) || externalResearchDisabled) continue
            const liveTrip = this.requireTrip(store.snapshot().trips, tripId)
            if (!hasPlanningDestination(liveTrip.brief, briefProposal, userAuthoredContext, latestUserText) &&
                !canExecuteWithoutDestination(call.function.name)) continue
            if (webSearchCallsUsed < webSearchCallLimit) {
              allowedSearchCalls.add(call.id)
              webSearchCallsUsed += 1
            }
          }
          const executeCall = async (call: ApiToolCall): Promise<void> => {
            if (signal.aborted) throw new Error('本次规划已取消。')
            const name = call.function.name
            if (name === 'propose_itineraries') {
              if (itinerarySubmittedInBatch) {
                await saveCompletedToolCall(call, {
                  output: '同一批次已保留第一份行程草案；后续完整提案未保存。',
                  sources: [],
                  feedback: [{
                    severity: 'error',
                    code: 'multiple_itinerary_proposals',
                    message: '每轮只允许提交一份完整行程草案；请保留首份并基于回执继续修订或结束。'
                  }]
                })
                return
              }
              itinerarySubmittedInBatch = true
            }
            const liveTrip = this.requireTrip(store.snapshot().trips, tripId)
            const destinationReady = hasPlanningDestination(liveTrip.brief, briefProposal, userAuthoredContext, latestUserText)
            const effectiveBrief = briefForCurrentRun(liveTrip.brief, briefProposal, latestUserText)
            if (externalResearchDisabled && !canExecuteWithoutExternalResearch(name)) {
              logSystemEvent('info', 'agent.tool.blocked', { traceId, toolName: name, status: 'blocked', reason: 'external_research_disabled' })
              await saveCompletedToolCall(call, {
                output: '已遵守本轮不进行外部检索的要求；请基于现有旅行资料继续，缺少依据的内容标为待核验。',
                sources: [],
                feedback: [{ severity: 'info', code: 'external_research_skipped', message: '按用户要求跳过外部检索。' }]
              })
              return
            }
            if (!destinationReady && !canExecuteWithoutDestination(name)) {
              logSystemEvent('info', 'agent.tool.blocked', { traceId, toolName: name, status: 'blocked', reason: 'destination_required' })
              const blockReason = requiresDestinationClarification(latestUserText)
                ? '用户明确要求先确认目的地城市或具体景区；请先询问一个澄清问题，不要开始旅行检索或方案生成。'
                : '当前目的地未明确；请先向用户确认城市或地区，再继续旅行检索或方案生成。'
              await saveCompletedToolCall(call, {
                output: `尚未运行旅行检索或方案生成：${blockReason}`,
                sources: [],
                feedback: [{ severity: 'warning', code: 'destination_required', message: blockReason }]
              })
              return
            }
            // 行程和准备清单分阶段提交；模型即使并行请求，也不能跳过行程校验。
            if (name === 'propose_preparation' && requiresItineraryOutput(latestUserText) && itineraryOptions.length === 0) {
              logSystemEvent('info', 'agent.tool.blocked', { traceId, toolName: name, status: 'blocked', reason: 'itinerary_required' })
              await saveCompletedToolCall(call, {
                output: '请先提交通过校验的行程候选，再根据该行程整理准备清单。',
                sources: [],
                feedback: [{ severity: 'warning', code: 'itinerary_required', message: '准备清单缺少可关联的行程草案；先补计划或改为只整理独立准备事项。' }]
              })
              return
            }

            if (!isToolAllowed(call)) {
              logSystemEvent('warn', 'agent.tool.blocked', { traceId, toolName: name, status: 'blocked', reason: 'not_offered' })
              await saveCompletedToolCall(call, {
                output: `本轮没有开放「${name}」工具，因此未执行。请只使用本轮提供的工具继续。`,
                sources: [],
                feedback: [{ severity: 'error', code: 'tool_not_offered', message: '该工具未在本轮授权列表中。' }]
              })
              return
            }
            if (name === 'research_browser_navigate') {
              let targetHost = ''
              try {
                const args = JSON.parse(call.function.arguments) as { url?: unknown }
                if (typeof args.url === 'string') targetHost = researchBrowserTargetHost(args.url)
              } catch {
                // 参数格式错误交给浏览器工具统一返回，不从中推断目标主机。
              }
              const blockedByGlobalCircuit = browserCircuitOpen
              const blockedByHostCircuit = !!targetHost && browserUnavailableHosts.has(targetHost)
              if (blockedByGlobalCircuit || blockedByHostCircuit) {
                logSystemEvent('warn', 'agent.tool.blocked', {
                  traceId, toolName: name, status: 'blocked',
                  reason: blockedByGlobalCircuit ? 'browser_network_circuit_open' : 'browser_host_circuit_open'
                })
                await saveCompletedToolCall(call, {
                  output: blockedByGlobalCircuit
                    ? '本轮研究网页遇到连续网络错误，已暂停重复导航；请使用其他可用来源，缺少依据的内容标为待核验。'
                    : '该网页来源在本轮连续连接失败，已停止重复导航；请尝试其他来源，或将缺少依据的事实标为待核验。',
                  sources: [],
                  feedback: [{ severity: 'warning', code: 'browser_network_circuit_open', message: '浏览器已停止对持续失败的网络目标重复导航。' }]
                })
                return
              }
            }
            if (name === 'search_web' && !allowedSearchCalls.has(call.id)) {
              const searchLimit = webSearchCallLimit
              logSystemEvent('warn', 'agent.tool.blocked', { traceId, toolName: name, status: 'blocked', reason: 'search_limit' })
              await saveCompletedToolCall(call, {
                output: `本轮网页检索已达到 ${searchLimit} 次上限；请根据已有来源和其他可用工具决定下一步，缺少依据的事实标为待核验。`,
                sources: [],
                feedback: [{ severity: 'warning', code: 'search_budget_exhausted', message: '本轮检索额度已用完，请使用现有来源继续。' }]
              })
              return
            }
            if (name === 'search_web' && areSearchProvidersExhausted(searchProviderCircuitBreaker)) {
              logSystemEvent('info', 'agent.tool.blocked', {
                traceId, toolName: name, status: 'blocked', reason: 'search_providers_exhausted'
              })
              await saveCompletedToolCall(call, {
                output: '本轮网页搜索渠道均已熔断；请根据已有来源和其他可用工具决定下一步。',
                sources: [],
                feedback: [{ severity: 'warning', code: 'search_providers_exhausted', message: '所有网页搜索渠道均已不可用。' }]
              })
              return
            }
            if (deferredProposalCallIds.delete(call.id)) {
              const output = name === 'propose_itineraries'
                ? '本轮先完成了外部检索，来源已保存。请先阅读本轮来源，再提交完整行程候选。'
                : name === 'propose_itinerary_facts'
                  ? '本轮先完成了外部检索，来源已保存。请先阅读来源，再提交只更新事实字段的修订。'
                  : '本轮先完成了外部检索。请在行程候选提交后再整理出行准备清单。'
              await saveCompletedToolCall(call, {
                output,
                sources: [],
                feedback: [{ severity: 'info', code: 'proposal_deferred', message: '本轮搜索结果已先保存，尚未执行计划提案。' }]
              })
              return
            }
            if (name === 'read_webpage' && !webPageProviderAvailable()) {
              logSystemEvent('info', 'agent.tool.blocked', {
                traceId, toolName: name, status: 'blocked', reason: 'page_provider_unavailable'
              })
              await saveCompletedToolCall(call, {
                output: '本轮网页正文服务不可用；请使用已保存来源或右侧研究浏览器核对原始页面。',
                sources: [],
                feedback: [{ severity: 'warning', code: 'page_reader_unavailable', message: '网页正文工具当前不可用。' }]
              })
              return
            }

            const activeMcp = name.startsWith('mcp_') ? await ensureMcpSession() : mcp
            this.emit(emit, requestId, tripId, targetConversationId, 'tool', activeMcp?.label(name) ?? toolLabel(name, call.function.arguments), name, call.id)
            let result: ToolResult
            try {
              result = name.startsWith('mcp_') && activeMcp
                ? await withToolLogging(name, () => activeMcp.execute(name, call.function.arguments, signal), traceId)
                : await withToolLogging(name, () => this.toolExecutor(name, call.function.arguments, {
                    amapKey,
                    amapRouteCircuitBreaker,
                    traceId,
                    userRequest: latestUserText,
                    exaKey,
                    tavilyKey,
                    searchProviderCircuitBreaker,
                    firecrawlKey,
                    firecrawlDisabled: firecrawlDisabledForRun(),
                    connectors,
                    xiaohongshu,
                    researchCompleted: sourceIds.size > 0 || currentTrip.sources.length > 0,
                    allowUnresearchedDraft: externalResearchDisabled,
                    sourceIds: availableSourceIds,
                    currentRunSourceIds: [...sourceIds],
                    availableSources: availableTrip.sources,
                    itinerary: availableItinerary,
                    itineraryOptions,
                    revisionBaseline,
                    unchangedItineraryDates,
                    excludedItineraryStops,
                    tripBrief: effectiveBrief,
                    budgetRequested,
                    requireNamedMealStops: namedMealStopsRequired,
                    factRepairSourceBindings: factRepairSourceMap(
                      availableTrip.sources, factRepairTargetsFor(itineraryOptions), latestUserText
                    ).targets,
                    requiredPreparationCategories,
                    requiredMealSlots: requiredMealSlotsForConversation(
                      userMessages, effectiveBrief.startDate, effectiveBrief.endDate, effectiveBrief.constraints
                    ),
                    detailedItineraryRequested,
                    routeCoverageRequested,
                    openingHoursDetailsRequested,
                    bookingDetailsRequested,
                    ticketPriceDetailsRequested,
                    itineraryContingenciesRequested,
                    bookingAlternativeRequested,
                    dailyWeatherRequested,
                    dailyIndoorRainAlternativesRequested,
                    researchBrowser,
                    researchBrowserVisualReadEnabled,
                    analyzeResearchScreenshot
                  }, signal), traceId)
            } catch (error) {
              if (signal.aborted) throw error
              const validationError = error instanceof ToolInputError
              const message = validationError
                ? redactCredentialText(error.message, configuredRedactions).slice(0, 1_200)
                : '工具暂不可用；已完成的来源仍会保存，可继续使用其他信息。'
              result = {
                output: message,
                sources: [],
                feedback: [{
                  severity: validationError ? error.severity : 'warning',
                  code: validationError ? error.code : 'tool_execution_failed',
                  message
                }]
              }
            }
            if (name === 'research_browser_navigate') {
              try {
                const args = JSON.parse(call.function.arguments) as { url?: unknown }
                if (typeof args.url === 'string') {
                  recordBrowserNavigationResult(result, researchBrowserTargetHost(args.url))
                }
              } catch {
                // 保留工具的原始参数校验结果。
              }
            }
            if (result.itineraryFactEvidenceDiagnostics) {
              const diagnostics = result.itineraryFactEvidenceDiagnostics
              logSystemEvent('info', 'agent.itinerary.fact_evidence', {
                traceId,
                toolName: name,
                factEvidenceRequestedCount: diagnostics.requestedCount,
                factEvidenceAutoBoundCount: diagnostics.autoBoundCount,
                factEvidenceRejectedCount: diagnostics.rejectedCount,
                factEvidenceSourceUnavailableCount: diagnostics.sourceUnavailableCount,
                factEvidenceSourceIneligibleCount: diagnostics.sourceIneligibleCount,
                factEvidencePlaceMismatchCount: diagnostics.placeMismatchCount,
                factEvidenceScopeMismatchCount: diagnostics.scopeMismatchCount,
                factEvidenceValueMismatchCount: diagnostics.valueMismatchCount,
                factEvidenceOpeningHoursRejectedCount: diagnostics.rejectedByType['opening-hours'] ?? 0,
                factEvidenceTicketPriceRejectedCount: diagnostics.rejectedByType['ticket-price'] ?? 0,
                factEvidenceBookingRejectedCount: diagnostics.rejectedByType.booking ?? 0,
                factEvidenceClosureRejectedCount: diagnostics.rejectedByType.closure ?? 0,
                factEvidenceWeatherRejectedCount: diagnostics.rejectedByType.weather ?? 0,
                factEvidenceTransportTimeRejectedCount: diagnostics.rejectedByType['transport-time'] ?? 0,
                factEvidenceAccessibilityRejectedCount: diagnostics.rejectedByType.accessibility ?? 0,
                factEvidenceSunsetRejectedCount: diagnostics.rejectedByType.sunset ?? 0,
                factEvidencePhotographyRulesRejectedCount: diagnostics.rejectedByType['photography-rules'] ?? 0,
                factEvidenceOtherRejectedCount: diagnostics.rejectedByType.other ?? 0
              })
            }
            if (name === briefProposalTool.definition.function.name) {
              result = discardUnmentionedDestination(result, userAuthoredContext)
            }
            const savedResult = await saveCompletedToolCall(
              call, result, ['propose_itineraries', 'propose_itinerary_meals', 'propose_itinerary_facts'].includes(name)
            )
            if (name === 'search_web') {
              firecrawlReadStopped ??= firecrawlReadStopReason(savedResult.sources)
            }
            if (name === 'read_webpage') {
              const stopReason = firecrawlReadStopReason(savedResult.sources)
              if (stopReason) {
                firecrawlReadStopped ??= stopReason
                logSystemEvent('warn', 'agent.research.firecrawl_stopped', {
                  traceId,
                  status: 'degraded',
                  reason: stopReason === 'quota' ? 'quota_exhausted' : 'rate_limited',
                  sourceCount: sourceIds.size
                })
                const exaPageRead = savedResult.sources.some((source) =>
                  source.provider === 'Exa 网页正文' && source.status === 'success' && source.contentLevel === 'page'
                )
                this.emit(emit, requestId, tripId, targetConversationId, 'status', exaPageRead
                  ? 'Firecrawl 本轮已停用，Exa 正文读取正常。'
                  : stopReason === 'quota'
                    ? 'Firecrawl 可用额度不足，后续读取由模型选择其他可用工具。'
                    : 'Firecrawl 正在限流，后续读取由模型选择其他可用工具。')
              }
            }
            if (name === 'propose_itineraries') {
              if (savedResult.itineraryOptions?.length) {
                // 强制补交行程成功后恢复普通工具路由，避免继续屏蔽准备清单工具。
                if (forceItinerarySubmission) {
                  forceItinerarySubmission = false
                  logSystemEvent('info', 'agent.itinerary.forced_submission.completed', {
                    traceId,
                    status: 'completed',
                    itineraryCount: itineraryOptions.length
                  })
                }
                invalidItinerarySubmissions = 0
                invalidItineraryArgumentSubmissions = 0
                lastItineraryFailure = ''
              } else {
                const failureKind = classifyRejectedToolOutput(name, savedResult.output)
                const failureSummary = agentHistory.summarizeItineraryFailure(savedResult.output, configuredRedactions)
                const structuralError = savedResult.feedback?.some((item) => item.severity === 'error') ?? false
                logSystemEvent('warn', 'agent.itinerary.submission_rejected', {
                  traceId, status: 'rejected', reason: failureKind,
                  feedbackSeverity: structuralError ? 'error' : 'warning',
                  attempt: structuralError ? invalidItinerarySubmissions + invalidItineraryArgumentSubmissions + 1 : undefined,
                })
                if (!structuralError) {
                  // warning 不启动强制重交；模型可补查、重提计划或基于反馈决定后续。
                } else if (failureKind === 'invalid_arguments') {
                  // 结构错误保留在统一 error feedback 中；全局工具轮次负责限制持续重试。
                  invalidItineraryArgumentSubmissions += 1
                  lastItineraryFailure ||= failureSummary
                } else {
                  invalidItinerarySubmissions += 1
                  lastItineraryFailure = failureSummary
                }
              }
            }
          }
          // 结构化修订工具都会返回完整计划快照，按模型顺序执行以避免并发覆盖。
          let proposalMutationQueue = Promise.resolve()
          let webpageReadQueue = Promise.resolve()
          let webSearchQueue = Promise.resolve()
          const scheduledCalls = batch.map((call) => {
            if (call.function.name === 'read_webpage') {
              const queuedCall = webpageReadQueue.then(() => executeCall(call))
              webpageReadQueue = queuedCall.then(() => undefined, () => undefined)
              return queuedCall
            }
            if (call.function.name === 'search_web') {
              const queuedCall = webSearchQueue.then(() => executeCall(call))
              webSearchQueue = queuedCall.then(() => undefined, () => undefined)
              return queuedCall
            }
            if (!LOCAL_PROPOSAL_TOOLS.has(call.function.name)) return executeCall(call)
            const queuedCall = proposalMutationQueue.then(() => executeCall(call))
            proposalMutationQueue = queuedCall.then(() => undefined, () => undefined)
            return queuedCall
          })
          const results = await Promise.allSettled(scheduledCalls)
          await saveQueue
          if (progressSaveFailed) return
          for (const result of results) {
            if (result.status === 'rejected') rejectedToolCall ??= result.reason
          }
          // 每次模型调用仅执行模型明确选出的工具；结果已逐项保存并回传。
        }

        const briefCalls = calls.filter((call) => call.function.name === 'propose_trip_brief')
        const otherCalls = calls.filter((call) => call.function.name !== 'propose_trip_brief')
        const researchCalls = otherCalls.filter((call) => !LOCAL_PROPOSAL_TOOLS.has(call.function.name))
        const proposalCalls = otherCalls.filter((call) => LOCAL_PROPOSAL_TOOLS.has(call.function.name))
        await runCalls(briefCalls)
        if (!progressSaveFailed) await runCalls(researchCalls)
        if (!progressSaveFailed && researchCalls.length > 0) {
          // 搜索结果必须先进入上下文，避免模型用同一轮旧信息同时生成方案。
          for (const call of proposalCalls) deferredProposalCallIds.add(call.id)
        }
        if (!progressSaveFailed) await runCalls(proposalCalls)
        if (progressSaveFailed) return progressSaveError ?? new Error('无法保存已完成的旅行工具结果。')
        if (itineraryReviewPromptPending && itineraryReviewPromptCount < MAX_ITINERARY_REVIEW_PROMPTS) {
          itineraryReviewPromptPending = false
          itineraryReviewPromptCount += 1
          const reviewPrompt: AgentRunTranscriptMessage = {
            role: 'user',
            content: itineraryReviewPrompt(itineraryReviewFeedbackCodes)
          }
          itineraryReviewFeedbackCodes.clear()
          messages.push(reviewPrompt)
          transcript.push(reviewPrompt)
          if (codexSelected) codexPendingMessages.push(reviewPrompt as ModelRequestMessage)
          this.emit(emit, requestId, tripId, targetConversationId, 'status', '正在复核计划反馈…')
          logSystemEvent('info', 'agent.itinerary.review_prompted', {
            traceId,
            status: 'reviewing',
            attempt: itineraryReviewPromptCount,
            limit: MAX_ITINERARY_REVIEW_PROMPTS
          })
          await persistProgress()
        }
        return rejectedToolCall
      }

      /** 最终写入前再次恢复受保护日期，覆盖所有可能跳过结构化收尾的退出路径。 */
      const restoreProtectedRevisionDays = (): void => {
        if (!revisionBaseline || unchangedItineraryDates.length === 0 || itineraryOptions.length === 0) return
        let restoredProtectedDayCount = 0
        itineraryOptions = itineraryOptions.map((option) => {
          const currentDays = new Map(option.days.map((day) => [day.date, day]))
          for (const baselineDay of revisionBaseline.days) {
            if (!protectedDateSet.has(baselineDay.date)) continue
            const currentDay = currentDays.get(baselineDay.date)
            if (currentDay && JSON.stringify(currentDay) !== JSON.stringify(baselineDay)) {
              restoredProtectedDayCount += 1
            }
          }
          return preserveUnchangedItineraryDays(revisionBaseline, option, unchangedItineraryDates)
        })
        logSystemEvent(restoredProtectedDayCount > 0 ? 'warn' : 'info', 'agent.itinerary_revision.finalized', {
          traceId,
          baselineAvailable: true,
          protectedDayCount: unchangedItineraryDates.length,
          restoredProtectedDayCount
        })
      }

      await persistProgress()
      runStage = 'tool_recovery'
      if (agentHistory.findUnresolvedToolCalls(transcript).length > 0) {
        this.emit(emit, requestId, tripId, targetConversationId, 'status', '正在恢复中断前尚未完成的工具步骤…')
        const rejectedToolCall = await runPendingToolCalls()
        if (signal.aborted) throw new Error('本次规划已取消。')
        if (rejectedToolCall !== undefined) {
          throw rejectedToolCall instanceof Error ? rejectedToolCall : new Error('旅行工具调用未能完成。')
        }
      }

      const completedToolRounds = agentHistory.countPlanningToolRounds(transcript)
      const planningToolRoundLimit = detailedItineraryRequested ? MAX_DETAILED_TOOL_ROUNDS : MAX_TOOL_ROUNDS
      const roundBudget = proposalToolRoundBudget(
        planningToolRoundLimit,
        requiredPreparationCategories.length > 0,
        namedMealStopsRequired,
        requiresItineraryOutput(latestUserText)
      )
      const toolRoundLimit = roundBudget.totalRounds
      runStage = 'tool_loop'
      for (let round = completedToolRounds; round < toolRoundLimit; round += 1) {
        if (signal.aborted) throw new Error('本次规划已取消。')
        const latestTrip = this.requireTrip(store.snapshot().trips, tripId)
        contextTrip = latestTrip
        const destinationReady = hasPlanningDestination(latestTrip.brief, briefProposal, userAuthoredContext, latestUserText)
        const researchRounds = transcript.filter((message) =>
          message.role === 'assistant' && message.researchOnly !== true &&
          message.tool_calls?.some((call) => !LOCAL_PROPOSAL_TOOLS.has(call.function.name))
        ).length
        const itineraryMissing = requiresItineraryOutput(latestUserText) &&
          itineraryOptions.length === 0
        const submissionReserveStart = roundBudget.itinerarySubmissionReserveStart
        if (shouldRequestItineraryFinalization({
          round,
          destinationReady,
          itineraryMissing,
          reserveStart: submissionReserveStart,
          alreadyRequested: forceItinerarySubmission
        })) {
          forceItinerarySubmission = true
          const guidance: AgentRunTranscriptMessage = {
            role: 'user',
            content: '本轮检索轮数已用完。请根据已获得资料直接提交一份完整计划；没有来源的动态事实、餐馆和交通信息保留为待核验。提交后可根据回执使用剩余轮次修订，不要继续扩展普通检索。'
          }
          messages.push(guidance)
          transcript.push(guidance)
          if (codexSelected) codexPendingMessages.push(guidance as ModelRequestMessage)
          logSystemEvent('warn', 'agent.itinerary.research_round_limit', {
            traceId,
            status: 'finalization_requested',
            completedResearchRounds: submissionReserveStart
          })
        }
        const itinerarySubmissionRecoveryPending = invalidItinerarySubmissions > 0 ||
          invalidItineraryArgumentSubmissions > 0
        const itinerarySubmissionFailureCount = invalidItinerarySubmissions + invalidItineraryArgumentSubmissions
        if (toolResultErrorStreak >= MAX_TOOL_RESULT_ERRORS) {
          logSystemEvent('warn', 'agent.tool.error_retry_exhausted', {
            traceId,
            status: 'failed',
            attempt: toolResultErrorStreak
          })
          throw new Error('工具连续三次未通过 error 校验，本轮已停止；请检查工具参数或结构。')
        }
        const searchBudgetExhausted = webSearchCallsUsed >= webSearchCallLimit
        if (searchBudgetExhausted && !searchBudgetExhaustionLogged) {
          searchBudgetExhaustionLogged = true
          logSystemEvent('info', 'agent.research.budget_exhausted', {
            traceId,
            status: 'completed',
            reason: 'search_limit',
            sourceCount: sourceIds.size
          })
        }
        const proposalOnly = itinerarySubmissionRecoveryPending || forceItinerarySubmission ||
          (externalResearchDisabled && itineraryMissing)
        const status = itinerarySubmissionRecoveryPending ? `正在修订行程方案（第 ${itinerarySubmissionFailureCount + 1} 次）…`
          : proposalOnly ? '正在整理完整行程方案…'
          : researchRounds === 0 ? '正在分析需求并规划检索…' : '正在核对资料…'
        this.emit(emit, requestId, tripId, targetConversationId, 'status', status)
        const effectiveBrief = briefForCurrentRun(latestTrip.brief, briefProposal, latestUserText)
        if (messages[1]?.role === 'user') {
          // 每轮都更新已保存来源，后续请求可用来源记录替代重复网页工具回声。
          messages[1] = buildTripContextMessage(latestTrip, currentMessages, {
            unchangedItineraryDates,
            currentSourceIds: sourceIds
          })
        }
        const proposalSources = sourcesForAgentContext(latestTrip.sources, latestUserText)
        const builtInTools = toolDefinitionsForBrief(effectiveBrief, destinationReady, proposalSources)
          .filter((tool) => tool.function.name !== 'read_webpage' || webPageProviderAvailable())
        const tools = destinationReady
          ? [...builtInTools, ...(!externalResearchDisabled ? (await ensureMcpSession()).definitions() : [])]
          : builtInTools
        const intentTools = toolsForPlanningDestination(tools, destinationReady)
        const scopedIntentTools = destinationReady && !requestsTripBriefUpdate(latestUserText)
          ? intentTools.filter((tool) => tool.function.name !== 'propose_trip_brief')
          : intentTools
        const expectedSubmissionTool = forceItinerarySubmission || itinerarySubmissionRecoveryPending
          ? 'propose_itineraries' : undefined
        const requestTools = scopedIntentTools.filter((tool) => {
          if (searchBudgetExhausted && tool.function.name === 'search_web') return false
          if (expectedSubmissionTool && tool.function.name !== expectedSubmissionTool) return false
          if (proposalOnly && !LOCAL_PROPOSAL_TOOLS.has(tool.function.name)) return false
          return true
        })
        if (expectedSubmissionTool && !requestTools.some((tool) => tool.function.name === expectedSubmissionTool)) {
          const availableTool = tools.find((tool) => tool.function.name === expectedSubmissionTool)
          if (!availableTool) {
            throw new Error('当前无法生成结构化行程方案；请稍后重试。')
          }
          requestTools.push(availableTool)
          logSystemEvent('warn', 'agent.request.required_tool_restored', {
            traceId,
            toolName: expectedSubmissionTool,
            reason: 'required_submission_tool_missing_from_request',
            toolCount: requestTools.length
          })
        }
        const proposalContext = agentHistory.compactProposalContext(messages, {
          omitItineraryProposals: false
        })
        // 只压缩模型请求副本；完整检索记录仍留在持久化 transcript，供中断恢复和审计使用。
        const researchHistoryCompaction = agentHistory.compactCompletedResearchHistory(
          proposalContext,
          messages[1] ?? { role: 'user', content: '' },
          latestTrip.sources,
          {
            preserveRecentCallCount: proposalOnly ? 0 : 1,
            preserveCurrentBrowserSnapshot: requestTools.some((tool) =>
              tool.function.name.startsWith('research_browser_'))
          }
        )
        const researchContextMessage = researchHistoryCompaction.messages[1] ?? messages[1] ?? {
          role: 'user' as const, content: ''
        }
        // 来源上下文已更新；保留当前浏览器快照和最近两页，移除已安全复用的旧网页正文。
        const pageHistoryCompaction = agentHistory.compactResearchPageContext(
          researchHistoryCompaction.messages,
          researchContextMessage,
          new Map(latestTrip.sources.flatMap((source) => source.factEvidenceExcerpt
            ? [[source.id, source.factEvidenceExcerpt] as const]
            : [])),
          {
            preserveCurrentBrowserSnapshot: requestTools.some((tool) =>
              tool.function.name.startsWith('research_browser_')),
            preserveRecentPageCallCount: 2
          }
        )
        const searchHistoryCompaction = agentHistory.compactResearchSearchContext(
          pageHistoryCompaction.messages,
          researchContextMessage
        )
        const compactedMessages = searchHistoryCompaction.messages
        const compactedResearchCalls = researchHistoryCompaction.compactedCallCount +
          pageHistoryCompaction.removedCallCount + searchHistoryCompaction.compactedCallCount
        const savedResearchCharacters = researchHistoryCompaction.savedCharacters +
          pageHistoryCompaction.savedCharacters + searchHistoryCompaction.savedCharacters
        if (compactedResearchCalls > 0) {
          logSystemEvent('info', 'agent.context.compacted', {
            traceId,
            status: 'completed',
            reason: 'saved_sources_replace_redundant_research_history',
            foldedCallCount: researchHistoryCompaction.compactedCallCount,
            removedCallCount: pageHistoryCompaction.removedCallCount,
            compactedCallCount: searchHistoryCompaction.compactedCallCount,
            contextCharactersSaved: savedResearchCharacters
          })
        }
        const indoorRainSourceGuide = dailyIndoorRainAlternativesRequested
          ? dailyIndoorRainSourceGuidance(sourceIds, contextTrip.sources)
          : ''
        let requestMessages = proposalOnly
            ? [
              {
                ...compactedMessages[0],
                content: `${compactedMessages[0]?.content ?? ''}\n\n${externalResearchDisabled
                    ? '用户已跳过外部查询，现在必须提交适用的结构化行程候选；停止普通文字说明。'
                    : `本轮已完成 ${researchRounds} 轮外部资料查询。请根据工具回执和用户要求，直接调用适用的结构化计划工具；业务警告由你判断是否需要补查或修订，未核实内容保留待核验。停止搜索。`}`
              },
              ...compactedMessages.slice(1),
              ...(indoorRainSourceGuide ? [{ role: 'user' as const, content: indoorRainSourceGuide }] : [])
            ]
            : compactedMessages
        if (itinerarySubmissionRecoveryPending && itineraryOptions.length === 0) {
          requestMessages.push({
            role: 'user',
            content: itineraryCandidateRepairPrompt(
              lastItineraryFailure,
              effectiveBrief,
              invalidItineraryArgumentSubmissions > 0
            )
          })
        }
        // 长行程靠近检索轮数上限时预留长输出，避免先截断后重复生成整份候选。
        const detailedCandidateReady = detailedItineraryRequested && itineraryMissing
        const requireItineraryTool = expectedSubmissionTool === 'propose_itineraries' || forceItinerarySubmission || (
          requestTools.length === 1 && requestTools[0]?.function.name === 'propose_itineraries' &&
          (proposalOnly || itinerarySubmissionRecoveryPending)
        )
        const requirePlanningActionTool = requiresItineraryOutput(latestUserText) && itineraryMissing && requestTools.length > 0
        const candidateRequest = proposalOnly && itineraryMissing && requestTools.some((tool) =>
          tool.function.name === 'propose_itineraries'
        )
        // 多轮检索后上下文已充分；最终草案转低推理，非详细计划用标准预算，降低整次等待。
        const researchHeavyCandidateRequest = candidateRequest && !externalResearchDisabled && researchRounds >= 3
        const standardCandidateRequest = researchHeavyCandidateRequest && !detailedItineraryRequested
        const outputBudget = proposalOnly
          ? standardCandidateRequest ? 'standard' as const : 'extended' as const
          : detailedCandidateReady ? 'extended' as const : 'compact' as const
        /** 当前 GLM 网关实测拒绝 medium；有基线且明确保护未改日期的细改也用 low。 */
        const scopedRevision = revisionBaseline !== undefined && unchangedItineraryDates.length > 0
        const repairRequest = itinerarySubmissionRecoveryPending || forceItinerarySubmission || researchHeavyCandidateRequest
        const reasoningEffort: ModelReasoningEffort = repairRequest || scopedRevision ? 'low'
          : detailedItineraryRequested ? 'low' : 'high'
        const phase = forceItinerarySubmission ? 'forced_itinerary'
          : candidateRequest ? 'itinerary_candidate' : 'research'
        /** 仅结构化行程提交失败时指定修复工具；常规工具选择交给模型。 */
        const forcedToolName = requireItineraryTool
          ? requestTools.find((tool) => tool.function.name === 'propose_itineraries')?.function.name
          : requirePlanningActionTool && requestTools.length === 1 ? requestTools[0]?.function.name : undefined
        const toolChoice: ModelToolChoice = forcedToolName
          ? { type: 'function', function: { name: forcedToolName } }
          : requirePlanningActionTool ? 'required' : 'auto'
        const requestReasoningEffort = reasoningEffortForProvider(
          snapshot.settings.model.provider, reasoningEffort
        )
        const hasReadableWebPage = contextTrip.sources.some((source) =>
          sourceIds.has(source.id) && source.kind === 'web' && source.status === 'success' && source.contentLevel === 'page'
        )
        const glmFlashModel = /^glm-5\.3-flash(?:$|[-.])/i.test(snapshot.settings.model.model.trim())
        const conciseInitialItineraryOutput = candidateRequest && !revisionBaseline && glmFlashModel
        const compactInitialItineraryOutput = shouldCompactInitialItinerarySchema({
          candidateRequest,
          hasRevisionBaseline: revisionBaseline !== undefined,
          glmFlashModel,
          hasReadableWebPage,
          factRepairRequested: factDetailsRequested
        })
        // 依据当前候选与模型能力选择结构化输出大小，避免过长 schema 造成截断。
        const compactItineraryOutput = compactInitialItineraryOutput
        if (conciseInitialItineraryOutput) {
          requestMessages.push({
            role: 'user',
            content: initialItineraryOutputPrompt(hasReadableWebPage, factDetailsRequested)
          })
        }
        if (itineraryOptions.length && requestTools.some((tool) => tool.function.name === 'propose_itinerary_facts')) {
          const factTargets = factRepairTargetsFor(itineraryOptions)
          if (factTargets.length) {
            // quote_id 只在本轮有效；同时提供原文映射，避免模型猜测编号对应的事实。
            requestMessages.push(buildFactRepairContextMessage(contextTrip, factTargets, latestUserText))
          }
        }
        const browserContextCompaction = agentHistory.compactStaleResearchBrowserSnapshots(requestMessages, {
          browserToolsAvailable: requestTools.some((tool) => tool.function.name.startsWith('research_browser_'))
        })
        requestMessages = browserContextCompaction.messages
        if (browserContextCompaction.compactedSnapshotCount > 0) {
          logSystemEvent('info', 'agent.context.compacted', {
            traceId,
            status: 'completed',
            reason: 'stale_browser_snapshot_targets_or_final_search_context',
            compactedSnapshotCount: browserContextCompaction.compactedSnapshotCount,
            contextCharactersSaved: browserContextCompaction.savedCharacters
          })
        }
        logSystemEvent('info', 'agent.request.prepared', {
          traceId,
          phase,
          toolCount: requestTools.length,
          toolChoice: typeof toolChoice === 'string' ? toolChoice : 'function',
          routeToolOffered: requestTools.some((tool) => tool.function.name === 'estimate_route'),
          ...(forcedToolName ? { toolName: forcedToolName } : {}),
          conciseItineraryOutput: conciseInitialItineraryOutput,
          compactItineraryOutput,
          reasoningEffort: requestReasoningEffort,
          itineraryCount: itineraryOptions.length,
          preparationCount: preparationOptions.length
        })
        let reply: Awaited<ReturnType<OpenAiCompatibleClient['complete']>>
        runStage = 'model_request'
        try {
          reply = await withModelRequestProgress(
            this.client.complete(
              snapshot.settings.model,
              apiKey ?? '',
              requestMessages,
              requestTools,
              signal,
              [...configuredRedactions, ...(mcp?.redactionValues() ?? [])],
              traceId,
              outputBudget,
              toolChoice,
              requestReasoningEffort,
              compactItineraryOutput,
              codexContext()
            ),
            (elapsedMs) => {
              const elapsedMinutes = Math.ceil(elapsedMs / 60_000)
              const progressLabel = status.replace(/[.…]+$/u, '')
              this.emit(emit, requestId, tripId, targetConversationId, 'status', `${progressLabel} · 已等待 ${elapsedMinutes} 分钟`)
            }
          )
          markCodexTurnCompleted()
        } catch (error) {
          if (signal.aborted) throw error
          throw error
        }
        runStage = 'model_response'
        const normalizedCalls = normalizeToolCalls(reply.tool_calls)
        if (normalizedCalls.error) {
          const { code, message } = normalizedCalls.error
          toolCallFormatRetries += 1
          const feedback: ToolFeedback[] = [{ severity: 'error', code, message }]
          const toolName = 'validate_model_tool_call'
          const toolCallId = `format-${randomUUID()}`
          const correction = `工具调用格式校验失败（${code}）：${message} 请按本轮工具 schema 重新提交，不要改变用户需求。`
          const assistantMessage: AgentRunTranscriptMessage = {
            role: 'assistant', content: typeof reply.content === 'string' ? reply.content : ''
          }
          const userMessage: AgentRunTranscriptMessage = { role: 'user', content: correction }

          this.emit(emit, requestId, tripId, targetConversationId, 'tool',
            toolLabel(toolName), toolName, toolCallId)
          this.emit(emit, requestId, tripId, targetConversationId, 'tool_result',
            '工具调用格式未通过校验；已将错误交回模型修正。', toolName, toolCallId, 'rejected', feedback)
          logSystemEvent('warn', 'agent.model.tool_call_rejected', {
            traceId, status: 'rejected', reason: code
          })
          messages.push(assistantMessage, userMessage)
          transcript.push(assistantMessage, userMessage)
          if (codexSelected) codexPendingMessages.push(userMessage)
          await persistProgress()

          if (round + 1 >= toolRoundLimit || toolCallFormatRetries > MAX_TOOL_CALL_FORMAT_RETRIES) {
            throw new Error('模型工具调用格式错误已达到重交上限；本轮未保存行程，请稍后重试。')
          }
          continue
        }
        const calls = normalizedCalls.calls
        const allowedToolNames = new Set(requestTools.map((tool) => tool.function.name))
        if (!destinationReady && calls.some((call) => call.function.name === 'propose_trip_brief')) {
          const destinationUnlockTools = toolsForPlanningDestination(builtInTools, false)
            .map((tool) => tool.function.name)
            .filter((name) => !name.startsWith('mcp_') && !LOCAL_PROPOSAL_TOOLS.has(name))
          destinationUnlockTools.forEach((name) => allowedToolNames.add(name))
        }
        if (calls.length === 0) {
          if (destinationReady && requiresItineraryOutput(latestUserText) && itineraryOptions.length === 0) {
            if (forcedItinerarySubmissionAttempts < MAX_MISSING_ITINERARY_TOOL_RECOVERIES &&
                round + 1 < toolRoundLimit) {
              forcedItinerarySubmissionAttempts += 1
              forceItinerarySubmission = true
              logSystemEvent('warn', 'agent.itinerary.tool_call_missing', {
                traceId,
                reason: 'required_structured_tool_not_called',
                retryUsed: true,
                attempt: forcedItinerarySubmissionAttempts
              })
              messages.push({ role: 'assistant', content: (typeof reply.content === 'string' ? reply.content : '').slice(0, 6_000) })
              messages.push({
                role: 'user',
                content: '上一条没有调用 propose_itineraries。请根据已有旅行资料和本轮要求直接提交完整行程；停止普通文字说明，下一条只调用 propose_itineraries。'
              })
              if (codexSelected) codexPendingMessages.push(messages[messages.length - 1] as ModelRequestMessage)
              continue
            }
            logSystemEvent('warn', 'agent.itinerary.tool_call_missing', {
              traceId,
              reason: 'required_structured_tool_not_called',
              retryUsed: forcedItinerarySubmissionAttempts > 0 || forceItinerarySubmission,
              attempt: forcedItinerarySubmissionAttempts,
              status: 'exhausted'
            })
            throw new Error(itineraryFailureMessage(lastItineraryFailure))
          }
          restoreProtectedRevisionDays()
          const assistantMessage: ChatMessage = {
            id: randomUUID(),
            conversationId: targetConversationId,
            role: 'assistant',
            content: typeof reply.content === 'string' ? reply.content : '模型没有返回可显示的文字。',
            createdAt: new Date().toISOString(),
            sourceIds: [...new Set([...sourceIds, ...preparationOptions.flatMap((item) => item.sourceIds)])],
            ...(itineraryOptions.length ? { itineraryOptions } : {}),
            ...(preparationOptions.length ? { preparationOptions } : {}),
            ...(briefProposal ? { briefProposal } : {})
          }
          runStage = 'result_persistence'
          await store.appendMessage(tripId, assistantMessage, targetConversationId)
          logRunCompleted()
          this.emit(emit, requestId, tripId, targetConversationId, 'complete', '方案已生成。')
          return
        }

        const assistantToolMessage: AgentRunTranscriptMessage = {
          role: 'assistant', content: reply.content ?? '', tool_calls: calls,
          allowedToolNames: [...allowedToolNames]
        }
        messages.push(assistantToolMessage)
        transcript.push(assistantToolMessage)
        await persistProgress()
        runStage = 'tool_execution'
        const rejectedToolCall = await runPendingToolCalls()
        if (signal.aborted) throw new Error('本次规划已取消。')
        if (rejectedToolCall !== undefined) {
          throw rejectedToolCall instanceof Error ? rejectedToolCall : new Error('旅行工具调用未能完成。')
        }
      }

      const finalTrip = this.requireTrip(store.snapshot().trips, tripId)
      runStage = 'completion_checks'
      const destinationReady = hasPlanningDestination(finalTrip.brief, briefProposal, userAuthoredContext, latestUserText)
      if (destinationReady && requiresItineraryOutput(latestUserText) && itineraryOptions.length === 0) {
        throw new Error(itineraryFailureMessage(lastItineraryFailure))
      }
      messages.push({ role: 'user', content: '请使用已经获得的信息，停止调用工具，先给出可核验的回答；未知内容标记待核验。' })
      if (codexSelected) codexPendingMessages.push(messages[messages.length - 1] as ModelRequestMessage)
      runStage = 'model_request'
      const final = await withModelRequestProgress(
        this.client.complete(
          snapshot.settings.model,
          apiKey ?? '',
          agentHistory.compactProposalContext(messages),
          undefined,
          signal,
          [...configuredRedactions, ...(mcp?.redactionValues() ?? [])],
          traceId,
          'standard',
          'auto',
          'high',
          false,
          codexContext('finalize')
        ),
        (elapsedMs) => this.emit(
          emit, requestId, tripId, targetConversationId, 'status',
          `正在校验最终回复 · 已等待 ${Math.ceil(elapsedMs / 60_000)} 分钟`
        )
      )
      markCodexTurnCompleted()
      restoreProtectedRevisionDays()
      runStage = 'result_persistence'
      const assistantMessage: ChatMessage = {
        id: randomUUID(), conversationId: targetConversationId, role: 'assistant',
        content: final.content || '本轮检索已完成，但模型没有返回文字。',
        createdAt: new Date().toISOString(),
        sourceIds: [...new Set([...sourceIds, ...preparationOptions.flatMap((item) => item.sourceIds)])],
        ...(itineraryOptions.length ? { itineraryOptions } : {}),
        ...(preparationOptions.length ? { preparationOptions } : {}),
        ...(briefProposal ? { briefProposal } : {})
      }
      await store.appendMessage(tripId, assistantMessage, targetConversationId)
      logRunCompleted()
      this.emit(emit, requestId, tripId, targetConversationId, 'complete', '方案已生成。')
    } catch (error) {
      const failedStage: string = runStage
      const persistenceFailureKind = failedStage === 'result_persistence'
        ? classifyPersistenceFailure(error) : undefined
      const sourceFailureSummary = persistenceFailureKind === 'source_not_successful'
        ? failedItineraryEvidenceSourceSummary(
          itineraryOptions, store.snapshot().trips.find((trip) => trip.id === tripId)?.sources ?? []
        ) : undefined
      logSystemEvent(signal.aborted ? 'info' : 'warn', signal.aborted ? 'agent.run.cancelled' : 'agent.run.failed', {
        traceId,
        durationMs: Date.now() - runStartedAt,
        status: signal.aborted ? 'cancelled' : 'failed',
        stage: failedStage,
        ...(persistenceFailureKind ? { persistenceFailureKind } : {}),
        ...(sourceFailureSummary ? {
          invalidEvidenceSourceCount: sourceFailureSummary.count,
          invalidEvidenceSourceSummary: sourceFailureSummary.summary
        } : {}),
        errorKind: classifyError(error)
      })
      throw error
    } finally {
      await mcp?.close()
    }
  }

  /** 检查模型地址、密钥和 Tripwise 实际使用的结构化工具调用能力。 */
  async testConnection(vault: SecretVault, store: TripStore, signal?: AbortSignal): Promise<{ ok: boolean; message: string }> {
    const apiKey = await vault.get('modelKey')
    const model = store.snapshot().settings.model
    if (!apiKey && model.provider !== 'codex-cli') return { ok: false, message: await missingModelKeyMessage(vault) }
    try {
      const response = await this.client.complete(
        model,
        apiKey ?? '',
        [
          { role: 'system', content: '这是连接测试。只需调用 propose_trip_brief 工具，提取用户明确说出的目的地；不要返回其他内容。' },
          { role: 'user', content: '我这次想去北京。' }
        ],
        [briefProposalTool.definition],
        signal,
        [],
        undefined,
        'compact'
      )
      const toolCall = response.tool_calls?.find((item) => item.function.name === briefProposalTool.definition.function.name)
      if (!toolCall) {
        return { ok: false, message: '服务已连接，但模型没有调用行程工具。请确认模型支持 OpenAI 兼容的工具调用。' }
      }
      const argumentsValue: unknown = JSON.parse(toolCall.function.arguments)
      if (!isRecord(argumentsValue) || !isValidBriefProbe(argumentsValue)) {
        return { ok: false, message: '模型调用了行程工具，但返回内容无法识别。' }
      }
      return { ok: true, message: '连接成功，可以开始规划行程。' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '模型连接失败，请检查设置。' }
    }
  }

  /** 统一携带请求 ID 发送任务进度事件。 */
  private emit(
    emit: (event: AgentEvent) => void,
    requestId: string,
    tripId: string,
    conversationId: string,
    type: AgentEvent['type'],
    message: string,
    toolName?: string,
    toolCallId?: string,
    toolOutcome?: AgentEvent['toolOutcome'],
    toolFeedback?: AgentEvent['toolFeedback']
  ): void {
    emit({
      requestId, tripId, conversationId, type, message,
      ...(toolName ? { toolName } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolOutcome ? { toolOutcome } : {}),
      ...(toolFeedback?.length ? { toolFeedback } : {})
    })
  }

  /** 通过主进程快照校验目标旅行仍存在。 */
  private requireTrip(trips: Trip[], tripId: string): Trip {
    const trip = trips.find((item) => item.id === tripId)
    if (!trip) throw new Error('找不到这趟旅行。')
    return trip
  }
}

/** 区分尚未配置模型 Key 与本机凭证文件需要修复。 */
async function missingModelKeyMessage(vault: SecretVault): Promise<string> {
  const status = await vault.status()
  if (status.credentialFileRecoveryRequired) return '本机凭证文件无法读取。修复文件后，在连接设置中重新载入。'
  return '尚未配置模型 API Key。请在连接设置中填写并保存。'
}

/** 记录工具生命周期和结果规模；工具参数、返回正文、URL 与用户资料不落日志。 */
async function withToolLogging(name: string, execute: () => Promise<ToolResult>, traceId: string): Promise<ToolResult> {
  const startedAt = Date.now()
  logSystemEvent('info', 'agent.tool.started', { traceId, toolName: name })
  try {
    const result = await execute()
    const rejected = (name === 'propose_itineraries' && !result.itineraryOptions?.length) ||
      (name === 'propose_itinerary_meals' && !result.itineraryOptions?.length) ||
      (name === 'propose_preparation' && !result.preparationOptions?.length) ||
      (name === 'propose_trip_brief' && !result.briefProposal)
    const partialCandidate = name === 'propose_itineraries' && result.output.startsWith('部分候选未通过校验：')
    const partial = partialCandidate || result.sources.some((source) => source.status === 'error' || source.status === 'unavailable')
    logSystemEvent(rejected || partial ? 'warn' : 'info', 'agent.tool.returned', {
      traceId,
      toolName: name,
      durationMs: Date.now() - startedAt,
      status: rejected ? 'rejected' : partial ? 'partial' : 'completed',
      ...(rejected ? { reason: classifyRejectedToolOutput(name, result.output) } : {}),
      ...(partialCandidate ? { reason: 'some_candidates_rejected' } : {}),
      ...(result.browserNavigationFailureKind ? { browserNavigationFailureKind: result.browserNavigationFailureKind } : {}),
      ...(result.browserLinkFailureKind ? { browserLinkFailureKind: result.browserLinkFailureKind } : {}),
      ...(result.browserLinkFailureStage ? { browserLinkFailureStage: result.browserLinkFailureStage } : {}),
      ...(result.progressCode ? { browserProgressCode: result.progressCode } : {}),
      sourceCount: result.sources.length,
      itineraryCount: result.itineraryOptions?.length ?? 0,
      preparationCount: result.preparationOptions?.length ?? 0,
      toolOutputCharacters: result.output.length + result.sources.reduce((total, source) => total + source.title.length + source.summary.length, 0)
    })
    return result
  } catch (error) {
    logSystemEvent('warn', 'agent.tool.failed', {
      traceId,
      toolName: name,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      errorKind: classifyError(error)
    })
    throw error
  }
}

/** 搜索摘要已随来源记录传给模型，工具消息只保留状态以减少重复上下文。 */
function compactToolOutput(name: string, output: string): string {
  if (name !== 'search_web') return output
  const summaryLine = output.split('\n').find((line) => line.startsWith('网页搜索结果'))
  if (summaryLine) {
    const queryLine = output.split('\n').find((line) => line.startsWith('查询词：'))
    return `${summaryLine}；来源编号见本轮结果，详细资料见旅行来源上下文。${queryLine ? ` ${queryLine}` : ''}`
  }
  return output.slice(0, 360)
}

/** 限制自动浏览器预读进入模型上下文的正文；来源只保留独立限长摘录。 */
function limitToolOutputCharacters(output: string, maximum: number): string {
  if (output.length <= maximum) return output
  const marker = '\n[网页摘录已截断；来源卡保留短摘要，可打开原始链接查看。]'
  if (maximum <= marker.length) return output.slice(0, maximum)
  return `${output.slice(0, Math.max(0, maximum - marker.length))}${marker}`
}

/** 校验 OpenAI-compatible 模型返回的工具调用，避免畸形结构进入持久化恢复点。 */
function normalizeToolCalls(value: unknown): { calls: ApiToolCall[]; error?: { code: string; message: string } } {
  // 兼容部分 OpenAI 协议网关用 null 表示“本轮没有工具调用”。
  if (value === undefined || value === null) return { calls: [] }
  if (!Array.isArray(value) || value.length > MAX_TOOL_CALLS_PER_MESSAGE) {
    return { calls: [], error: { code: 'invalid_tool_call_count', message: '工具调用数量不符合本轮上限。' } }
  }
  const ids = new Set<string>()
  const calls: ApiToolCall[] = []
  for (const rawCall of value) {
    if (!isRecord(rawCall) || !isRecord(rawCall.function) || rawCall.type !== 'function' ||
      typeof rawCall.id !== 'string' || rawCall.id.trim().length === 0 || rawCall.id.length > 100 ||
      typeof rawCall.function.name !== 'string' || rawCall.function.name.trim().length === 0 || rawCall.function.name.length > 160 ||
      typeof rawCall.function.arguments !== 'string') {
      return { calls: [], error: { code: 'invalid_tool_call_structure', message: '工具调用必须包含有效的 id、function.name 和字符串形式的 function.arguments。' } }
    }
    if (ids.has(rawCall.id)) {
      return { calls: [], error: { code: 'duplicate_tool_call_id', message: '同一批工具调用的 id 不能重复。' } }
    }
    const maxArgumentCharacters = rawCall.function.name === 'propose_itineraries'
      ? MAX_ITINERARY_ARGUMENT_CHARACTERS
      : MAX_TOOL_ARGUMENT_CHARACTERS
    if (rawCall.function.arguments.length > maxArgumentCharacters) {
      return {
        calls: [],
        error: {
          code: 'tool_arguments_too_long',
          message: `${rawCall.function.name} 的 arguments 超过 ${maxArgumentCharacters.toLocaleString('zh-CN')} 字符上限。`
        }
      }
    }
    ids.add(rawCall.id)
    calls.push({
      id: rawCall.id,
      type: 'function',
      function: {
        name: rawCall.function.name,
        arguments: sanitizeSensitiveBrowserArguments(rawCall.function.name, rawCall.function.arguments)
      }
    })
  }
  return { calls }
}

/** 在恢复点保存工具调用前规范搜索词并清除浏览器链接凭证。 */
function sanitizeSensitiveBrowserArguments(name: string, rawArguments: string): string {
  if (name !== 'research_browser_navigate') return rawArguments
  try {
    const parsed: unknown = JSON.parse(rawArguments)
    if (!isRecord(parsed) || typeof parsed.url !== 'string') return JSON.stringify({})
    return JSON.stringify({ ...parsed, url: sanitizeResearchUrl(resolveResearchBrowserInput(parsed.url).url) })
  } catch {
    // 无效或私有网址不能继续执行，也不能把原始参数留在持久化恢复点。
    return JSON.stringify({})
  }
}

/** 将当前用户原话并入执行约束，避免未确认的模型提案覆盖硬时限。 */
function briefForCurrentRun(
  savedBrief: TripBrief,
  proposal: ChatMessage['briefProposal'],
  latestUserText: string
): TripBrief {
  const brief = { ...savedBrief, ...(proposal?.changes ?? {}) }
  brief.constraints = [...new Set([savedBrief.constraints, latestUserText]
    .map((value) => value.trim())
    .filter(Boolean))].join('\n')
  return brief
}

/** 只接受连接测试中可解析的对象参数，不将模型返回值写入旅行数据。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 确认探测调用包含可用目的地，且所有字段都符合简报工具的字符串契约。 */
function isValidBriefProbe(value: Record<string, unknown>): boolean {
  const rawProperties = briefProposalTool.definition.function.parameters.properties
  if (!isRecord(rawProperties)) return false

  const destination = value.destination
  const entries = Object.entries(value)
  return typeof destination === 'string' && destination.trim().length > 0 &&
    entries.every(([key, field]) => Object.hasOwn(rawProperties, key) && typeof field === 'string')
}

/** 丢弃未出现在用户原话中的模型目的地，避免提案本身解锁外部检索。 */
function discardUnmentionedDestination(result: ToolResult, userText: string): ToolResult {
  const proposal = result.briefProposal
  if (!proposal) return result
  const destination = proposal.changes.destination
  if (typeof destination !== 'string' || !destination.trim() || hasExplicitDestinationMention(userText, destination)) return result

  const changes = { ...proposal.changes }
  const base = { ...proposal.base }
  delete changes.destination
  delete base.destination
  const withoutProposal = { ...result }
  delete withoutProposal.briefProposal
  const output = `${result.output} 用户原话未明确提及目的地，已忽略该字段；先向用户确认城市或地区，不要开始地点检索。`
  return Object.keys(changes).length
    ? { ...withoutProposal, output, briefProposal: { base, changes } }
    : { ...withoutProposal, output }
}
