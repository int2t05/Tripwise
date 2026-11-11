/** 以本机在线模型执行固定旅行案例，并只导出脱敏的结构化证据。 */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { classifyError, configureSystemLogger, flushSystemLogs } from '../src/main/system-logger.js'
import { TravelAgent } from '../src/main/agent.js'
import { classifyRejectedToolOutput } from '../src/main/agent-itinerary-policy.js'
import { executeTool } from '../src/main/tools.js'
import { createSource } from '../src/main/connectors/types.js'
import { createUserProvidedSource } from '../src/main/connectors/user-import.js'
import { DEFAULT_SETTINGS } from '../src/main/persistence/schema.js'
import { TripStore } from '../src/main/persistence.js'
import { SecretVault } from '../src/main/secrets.js'
import { redactCredentialText } from '../src/main/llm.js'
import type { AgentRunProgress, AppSettings, ItineraryDay, ItineraryOption, PreparationItem, SourceRecord, TripBrief } from '../src/shared/types.js'
import { defaultTripwiseUserDataDirectory, readTripwiseProfile } from './helpers/manual-profile.js'

interface EvaluationCase {
  id: string
  title: string
  brief: TripBrief
  prompt: string
  expectedPlanCount?: number
  mustPreserve: string[]
  dynamicFactsToVerify: string[]
  failureInjection: string | null
  syntheticEvidence?: Array<{ kind: string; url: string; text: string }>
}

interface EvaluationManifest {
  schemaVersion: number
  cases: EvaluationCase[]
}

const enabled = process.env.TRIPWISE_TRAVEL_LIVE_EVAL === '1'
const revisionEvaluationEnabled = process.env.TRIPWISE_TRAVEL_LIVE_REVISION_EVAL === '1'
const userDataDirectory = resolve(process.env.TRIPWISE_USER_DATA_DIR?.trim() || defaultTripwiseUserDataDirectory())
const manifestPath = new URL('./fixtures/travel-evaluation-cases.json', import.meta.url)
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as EvaluationManifest
const requestedIds = enabled ? parseRequestedIds(process.env.TRIPWISE_TRAVEL_EVAL_CASES) : []
const selectedCases = requestedIds.map((id) => {
  const evaluationCase = manifest.cases.find((item) => item.id === id)
  if (!evaluationCase) throw new Error(`未知旅行评测案例：${id}`)
  return evaluationCase
})

if (enabled && selectedCases.length === 0) {
  throw new Error('请通过 TRIPWISE_TRAVEL_EVAL_CASES 指定案例编号或 all；在线评测不会默认运行全部案例。')
}
if (enabled && revisionEvaluationEnabled && (selectedCases.length !== 1 || selectedCases[0]?.id !== 'TW-02')) {
  throw new Error('跨目的地多轮修改评测仅支持单独选择 TW-02，避免无意中扩大在线模型调用。')
}

/** 保留内存恢复点与首份草案耗时，供单案报告记录。 */
class EvaluationTripStore extends TripStore {
  latestProgress?: AgentRunProgress
  firstDraftElapsedMs?: number
  private startedAt?: number

  /** 从首个有效行程提案时间起算，不统计连接设置和清理。 */
  startMeasurement(startedAt: number): void {
    this.startedAt = startedAt
  }

  override async updateAgentRunProgress(tripId: string, messageId: string, progress: AgentRunProgress): Promise<void> {
    this.latestProgress = structuredClone(progress)
    if (this.startedAt !== undefined && this.firstDraftElapsedMs === undefined && progress.itineraryOptions.length > 0) {
      this.firstDraftElapsedMs = Date.now() - this.startedAt
    }
    await super.updateAgentRunProgress(tripId, messageId, progress)
  }
}

if (!enabled) {
  it.skip('30 案真实运行需显式选择案例并使用本机已保存配置', () => undefined)
} else {
  for (const evaluationCase of selectedCases) {
    it(`${evaluationCase.id} ${evaluationCase.title}（真实运行）`, async () => {
      await runCase(evaluationCase)
    }, 5_400_000)
  }
}

/** 隔离执行一个案例；旅行数据、日志和运行检查点均写入临时目录。 */
async function runCase(evaluationCase: EvaluationCase): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), `tripwise-${evaluationCase.id.toLowerCase()}-`))
  let startedAt = ''
  let startedClock = 0
  const store = new EvaluationTripStore(temporaryDirectory)
  const vault = new SecretVault(userDataDirectory)
  const toolCalls: string[] = []
  const injectedFailures: Record<string, number> = {}
  const proposalFeedback: Array<{ kind: string; summary: string }> = []
  let configuredRedactions: string[] = []
  let agentErrorKind: string | undefined
  let terminalEvent = 'none'
  let seededPlan: ItineraryOption | undefined
  let savedArtifacts: string[] = []

  try {
    await flushSystemLogs()
    await store.initialize()
    configureSystemLogger(temporaryDirectory)
    const profile = await readTripwiseProfile(userDataDirectory)
    const profileSettings = isRecord(profile) && isRecord(profile.settings) ? profile.settings : undefined
    const model = profileSettings?.model
    if (!isModelSettings(model)) throw new Error('缺少已保存的在线模型配置。')
    const connectors = isConnectorSettings(profileSettings?.connectors)
      ? profileSettings.connectors
      : DEFAULT_SETTINGS.connectors
    await vault.initialize()
    const secretNames = ['modelKey', 'exaKey', 'tavilyKey', 'firecrawlKey', 'amapKey', 'amapJsKey', 'amapSecurityCode'] as const
    const secretValues = await Promise.all(secretNames.map((name) => vault.get(name)))
    configuredRedactions = secretValues.filter((value): value is string => !!value)
    if (!secretValues[0]) throw new Error('缺少已保存的模型凭证。')

    const mcpServers = evaluationCase.failureInjection === 'mcp-tool'
      ? [failedMcpFixture(temporaryDirectory)]
      : []
    await store.updateSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      model,
      connectors,
      xiaohongshu: { enabled: false, command: '', args: [] },
      mcpServers
    })
    await store.createTrip(evaluationCase.brief)
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('临时旅行创建失败。')

    for (const [index, evidence] of (evaluationCase.syntheticEvidence ?? []).entries()) {
      await store.saveSources(trip.id, [createUserProvidedSource({
        title: `合成来源 ${index + 1}`,
        url: evidence.url,
        text: evidence.text
      })])
    }

    if (evaluationCase.id === 'TW-30') {
      seededPlan = seedRevisionPlan(evaluationCase.brief)
      const baselineMessageId = randomUUID()
      await store.appendMessage(trip.id, {
        id: baselineMessageId,
        role: 'assistant',
        content: '固定评测基线。',
        createdAt: new Date().toISOString(),
        sourceIds: [],
        itineraryOptions: [seededPlan]
      })
      await store.saveRevision(trip.id, baselineMessageId, seededPlan.id)
    }

    const initialMessageIds = new Set(store.snapshot().trips[0]?.messages.map((message) => message.id) ?? [])
    startedAt = new Date().toISOString()
    startedClock = Date.now()
    store.startMeasurement(startedClock)
    const failureExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      if (name === evaluationCase.failureInjection && name !== 'mcp-tool') {
        injectedFailures[name] = (injectedFailures[name] ?? 0) + 1
        return injectedToolFailure(name)
      }
      const result = await executeTool(name, rawArguments, context, signal)
      if (name === 'propose_itineraries' && !result.itineraryOptions?.length) {
        proposalFeedback.push({
          kind: classifyRejectedToolOutput(name, result.output),
          summary: redactCredentialText(result.output, configuredRedactions).slice(0, 1_200)
        })
      }
      return result
    }

    try {
      await new TravelAgent(failureExecutor).run(
        store,
        vault,
        trip.id,
        evaluationCase.prompt,
        randomUUID(),
        new AbortController().signal,
        (event) => {
          if (event.type === 'tool' && event.toolName) toolCalls.push(event.toolName)
          if (event.type === 'complete' || event.type === 'error') terminalEvent = event.type
        }
      )
    } catch (error) {
      agentErrorKind = classifyError(error)
    }
    await flushSystemLogs()

    const resultTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const newMessages = resultTrip?.messages.filter((message) => !initialMessageIds.has(message.id)) ?? []
    const proposals = newMessages.flatMap((message) => message.itineraryOptions ?? [])
    const preparations = newMessages.flatMap((message) => message.preparationOptions ?? [])
    const sources = resultTrip?.sources ?? []
    const report = makeCaseReport({
      evaluationCase,
      modelId: model.model,
      startedAt,
      elapsedMs: Date.now() - startedClock,
      firstDraftElapsedMs: store.firstDraftElapsedMs,
      terminalEvent,
      agentErrorKind,
      proposals,
      preparations,
      assistantResponses: newMessages
        .filter((message) => message.role === 'assistant' && message.content.trim())
        .map((message) => message.content),
      sources,
      toolCalls,
      proposalFeedback,
      injectedFailures,
      seededPlan,
      activeRevisionId: resultTrip?.activeRevisionId ?? null,
      savedRevisionCount: resultTrip?.revisions.length ?? 0
    })
    savedArtifacts = await saveReportIfRequested(report, vault)
    process.stdout.write(`[travel-eval-live] ${JSON.stringify({
      caseId: evaluationCase.id,
      title: evaluationCase.title,
      terminalEvent,
      agentErrorKind,
      elapsedSeconds: report.run.elapsedSeconds,
      firstDraftSeconds: report.run.firstDraftSeconds,
      planCount: report.result.planCount,
      dayCounts: report.result.dayCounts,
      stopCounts: report.result.stopCounts,
      preparationCount: report.result.preparationCount,
      sourceCounts: report.result.sourceCounts,
      injectedFailures,
      lockedStopPreserved: report.result.lockedStopPreserved,
      changedNonTargetDayCount: report.result.changedNonTargetDayCount,
      evidenceFiles: savedArtifacts
    })}\n`)
    expect(agentErrorKind, '真实 Agent 运行不应因模型或工具错误中断。').toBeUndefined()
    expect(terminalEvent, '真实 Agent 应发送完成或错误事件。').not.toBe('none')
    if (evaluationCase.expectedPlanCount !== undefined) {
      expect(report.result.planCount, `${evaluationCase.id} 应提交结构化计划。`)
        .toBe(evaluationCase.expectedPlanCount)
    }
    if (revisionEvaluationEnabled) {
      const initialPlan = proposals[0]
      if (!initialPlan) throw new Error('cross_destination_revision_missing_initial_plan')
      await runCrossDestinationRevisionEvaluation(store, vault, trip.id, initialPlan)
    }
  } finally {
    await flushSystemLogs()
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

/** 使用真实成都草案连续修改两次，校验日期、首晚锚点和非目标日稳定。 */
async function runCrossDestinationRevisionEvaluation(
  store: EvaluationTripStore,
  vault: SecretVault,
  tripId: string,
  initialPlan: ItineraryOption
): Promise<void> {
  const revisionRequests = [
    {
      targetDate: '2026-11-06',
      prompt: '第一轮修改：以刚才的最新草案为基线。只调整 11/6，保留成都大熊猫繁育研究基地，删除武侯祠和锦里；首晚和 11/7 原样不动。请只返回一份完整修订草案。'
    },
    {
      targetDate: '2026-11-07',
      prompt: '第二轮修改：以最新修订为基线。只把 11/7 调整为轻松半日游：人民公园作为当天唯一主要景点，午餐安排在人民公园附近，删除当天其他景点；不要推断具体离站时间、车站或接驳分钟数。其他日期原样不动。请只返回一份完整修订草案。'
    }
  ]
  let previousPlan = initialPlan
  expect(isArrivalDayStable(previousPlan)).toBe(true)

  for (const [index, request] of revisionRequests.entries()) {
    let terminalEvent = 'none'
    await new TravelAgent().run(
      store, vault, tripId, request.prompt, randomUUID(), new AbortController().signal,
      (event) => {
        if (event.type === 'complete' || event.type === 'error') terminalEvent = event.type
      }
    )
    await flushSystemLogs()

    const trip = store.snapshot().trips.find((item) => item.id === tripId)
    const latestDraft = trip?.messages.filter((message) => message.role === 'assistant' && message.itineraryOptions?.length)
      .at(-1)?.itineraryOptions
    const revisedPlan = latestDraft?.[0]
    if (!trip || !revisedPlan) throw new Error(`cross_destination_revision_${index + 1}_missing_plan`)

    const previousByDate = new Map(previousPlan.days.map((day) => [day.date, day]))
    const targetBefore = previousByDate.get(request.targetDate)
    const targetAfter = revisedPlan.days.find((day) => day.date === request.targetDate)
    const targetChanged = !!targetBefore && !!targetAfter && JSON.stringify(targetBefore) !== JSON.stringify(targetAfter)
    const targetStopNames = targetAfter?.stops.map((stop) => stop.name) ?? []
    const targetContentChecks = index === 0
      ? {
          pandaPreserved: targetStopNames.some((name) => /成都大熊猫繁育研究基地|熊猫基地/u.test(name)),
          wuhouciRemoved: !targetStopNames.some((name) => /武侯祠/u.test(name)),
          jinliRemoved: !targetStopNames.some((name) => /锦里/u.test(name))
        }
      : {
          peopleParkScheduled: targetStopNames.some((name) => /人民公园/u.test(name)),
          otherAttractionsRemoved: !targetAfter?.stops.some((stop) =>
            !/人民公园|午餐|午饭/u.test(stop.name) && /景点|景区/u.test(stop.category)
          ),
          lunchScheduled: targetAfter?.stops.some((stop) => /午餐|午饭/u.test(`${stop.category} ${stop.name}`)) === true ||
            targetAfter?.scheduleBlocks.some((block) => block.kind === 'meal' && /午餐|午饭/u.test(block.title)) === true
        }
    const targetContentSatisfied = Object.values(targetContentChecks).every(Boolean)
    const changedNonTargetDayCount = revisedPlan.days.filter((day) => day.date !== request.targetDate).filter((day) => {
      const previous = previousByDate.get(day.date)
      return !previous || JSON.stringify(previous) !== JSON.stringify(day)
    }).length
    const datesPreserved = revisedPlan.days.map((day) => day.date).join(',') === previousPlan.days.map((day) => day.date).join(',')
    const firstNightStable = isArrivalDayStable(revisedPlan)
    const saved = trip.activeRevisionId !== null || trip.revisions.length > 0
    const summary = {
      revision: index + 1,
      terminalEvent,
      draftCount: latestDraft.length,
      dayCount: revisedPlan.days.length,
      datesPreserved,
      targetChanged,
      targetContentChecks,
      targetContentSatisfied,
      changedNonTargetDayCount,
      firstNightStable,
      saved
    }
    process.stdout.write(`[travel-eval-live] cross-destination revision ${JSON.stringify(summary)}\n`)
    expect(summary.terminalEvent).toBe('complete')
    expect(summary.draftCount).toBe(1)
    expect(summary.dayCount).toBe(previousPlan.days.length)
    expect(summary.datesPreserved).toBe(true)
    expect(summary.targetChanged).toBe(true)
    expect(summary.targetContentSatisfied).toBe(true)
    expect(summary.changedNonTargetDayCount).toBe(0)
    expect(summary.firstNightStable).toBe(true)
    expect(summary.saved).toBe(false)
    previousPlan = revisedPlan
  }
}

/** 抵达日晚只保留用户时刻与交通/住宿安排，不允许修改轮次加入游览点。 */
function isArrivalDayStable(plan: ItineraryOption): boolean {
  const arrivalDay = plan.days[0]
  if (!arrivalDay) return false
  const anchorPreserved = arrivalDay.stops.some((stop) =>
    stop.time.includes('22:10') || stop.name.includes('22:10')
  )
  const onlyArrivalLogistics = arrivalDay.stops.every((stop) =>
    /交通|接驳|住宿|酒店|入住|抵达|到达|行李|休息|餐/u.test(`${stop.category} ${stop.name}`)
  )
  return anchorPreserved && onlyArrivalLogistics
}

/** 将固定模型工具错误作为来源状态返回，验证 Agent 的单渠道降级行为。 */
function injectedToolFailure(toolName: string) {
  const kinds = { search_web: 'web', get_weather: 'weather', find_places: 'place', estimate_route: 'route' } as const
  const kind = kinds[toolName as keyof typeof kinds]
  if (!kind) return { output: '受控评测故障：目标工具不可用。', sources: [] }
  const summary = `受控评测故障：${toolName} 不可用；请继续使用其他已启用工具，缺少依据的事实标为待核验。`
  const source = createSource(
    `受控故障注入：${toolName}`,
    `https://evaluation.tripwise.invalid/${toolName}`,
    'Tripwise 评测注入',
    kind,
    summary,
    'error'
  )
  return { output: summary, sources: [source] }
}

/** 为单日修改案例创建带锁定预约的三日已确认基线。 */
function seedRevisionPlan(brief: TripBrief): ItineraryOption {
  const dates = dateRange(brief.startDate, brief.endDate)
  const days: ItineraryDay[] = dates.map((date, index) => {
    const locked = index === 1
    return {
      id: `seed-day-${index + 1}`,
      dayNumber: index + 1,
      date,
      title: `基线第 ${index + 1} 天`,
      stops: [{
        id: `seed-stop-${index + 1}`,
        name: locked ? '故宫预约' : `北京片区停留 ${index + 1}`,
        area: '北京',
        time: locked ? '09:00–12:00' : '10:00–11:00',
        durationMinutes: locked ? 180 : 60,
        category: locked ? '预约景点' : '人文',
        notes: locked ? '评测用锁定预约。' : '评测基线安排。',
        transitToNext: '',
        ...(locked ? { locked: true } : {})
      }],
      scheduleBlocks: []
    }
  })
  return { id: 'evaluation-revision-baseline', title: '固定评测基线', summary: '用于验证局部修改和锁定预约。', tradeoffs: '测试数据，不是旅行建议。', days }
}

/** 生成日期范围；输入不完整时不伪造日期。 */
function dateRange(startDate: string, endDate: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return []
  const start = Date.parse(`${startDate}T00:00:00Z`)
  const end = Date.parse(`${endDate}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return []
  const count = Math.floor((end - start) / 86_400_000) + 1
  if (count > 7) throw new Error('TW-30 评测基线日期超过支持范围。')
  return Array.from({ length: count }, (_, index) => new Date(start + index * 86_400_000).toISOString().slice(0, 10))
}

/** 生成只包含结构、状态、来源元数据和评审条目的案例证据。 */
function makeCaseReport(input: {
  evaluationCase: EvaluationCase
  modelId: string
  startedAt: string
  elapsedMs: number
  firstDraftElapsedMs?: number
  terminalEvent: string
  agentErrorKind?: string
  proposals: ItineraryOption[]
  preparations: PreparationItem[]
  assistantResponses: string[]
  sources: SourceRecord[]
  toolCalls: string[]
  proposalFeedback: Array<{ kind: string; summary: string }>
  injectedFailures: Record<string, number>
  seededPlan?: ItineraryOption
  activeRevisionId: string | null
  savedRevisionCount: number
}) {
  const latest = input.proposals.at(-1)
  const targetRevisionDate = input.evaluationCase.id === 'TW-30'
    ? dateRange(input.evaluationCase.brief.startDate, input.evaluationCase.brief.endDate)[1]
    : undefined
  const changedNonTargetDays = input.seededPlan && latest
    ? latest.days.filter((day) => {
      const base = input.seededPlan?.days.find((item) => item.date === day.date)
      return !!base && day.date !== targetRevisionDate && planDaySignature(base) !== planDaySignature(day)
    }).map((day) => day.date)
    : []
  const lockedDay = input.seededPlan?.days.find((day) => day.stops.some((stop) => stop.locked))
  const lockedStopIndex = lockedDay?.stops.findIndex((stop) => stop.locked) ?? -1
  const lockedStop = lockedDay && lockedStopIndex >= 0 ? lockedDay.stops[lockedStopIndex] : undefined
  const lockedStopPreserved = lockedStop && lockedDay && latest
    ? latest.days.find((day) => day.date === lockedDay.date)?.stops[lockedStopIndex]?.name === lockedStop.name &&
      latest.days.find((day) => day.date === lockedDay.date)?.stops[lockedStopIndex]?.time === lockedStop.time &&
      latest.days.find((day) => day.date === lockedDay.date)?.stops[lockedStopIndex]?.locked === true
    : lockedStop ? false : null
  const baselineTargetDay = targetRevisionDate
    ? input.seededPlan?.days.find((day) => day.date === targetRevisionDate)
    : undefined
  const revisedTargetDay = targetRevisionDate ? latest?.days.find((day) => day.date === targetRevisionDate) : undefined
  const targetDayChanged = baselineTargetDay && revisedTargetDay
    ? planDaySignature(baselineTargetDay) !== planDaySignature(revisedTargetDay)
    : targetRevisionDate ? false : null
  const elapsedSeconds = Math.round(input.elapsedMs / 1000)
  const firstDraftSeconds = input.firstDraftElapsedMs === undefined ? null : Math.round(input.firstDraftElapsedMs / 1000)
  return {
    schemaVersion: 1,
    case: {
      id: input.evaluationCase.id,
      title: input.evaluationCase.title,
      mustPreserve: input.evaluationCase.mustPreserve,
      dynamicFactsToVerify: input.evaluationCase.dynamicFactsToVerify,
      failureInjection: input.evaluationCase.failureInjection
    },
    run: {
      modelId: input.modelId,
      platform: process.platform,
      startedAt: input.startedAt,
      completedAt: new Date().toISOString(),
      elapsedSeconds,
      firstDraftSeconds,
      terminalEvent: input.terminalEvent,
      ...(input.agentErrorKind ? { errorKind: input.agentErrorKind } : {}),
      toolCalls: [...input.toolCalls],
      injectedFailures: { ...input.injectedFailures }
    },
    result: {
      planCount: input.proposals.length,
      preparationCount: input.preparations.length,
      dayCounts: input.proposals.map((plan) => plan.days.length),
      dates: input.proposals.map((plan) => plan.days.map((day) => day.date)),
      stopCounts: input.proposals.map((plan) => plan.days.map((day) => day.stops.length)),
      sourceCounts: Object.fromEntries(['web', 'weather', 'place', 'route', 'plugin', 'user'].map((kind) => [
        kind,
        input.sources.filter((source) => source.kind === kind).length
      ])),
      sourceStatuses: Object.fromEntries(['success', 'partial', 'unavailable', 'error'].map((status) => [
        status,
        input.sources.filter((source) => source.status === status).length
      ])),
      lockedStopPreserved,
      targetDayChanged,
      changedNonTargetDates: changedNonTargetDays,
      changedNonTargetDayCount: changedNonTargetDays.length,
      activeRevisionExists: input.activeRevisionId !== null,
      savedRevisionCount: input.savedRevisionCount
    },
    review: {
      constraints: input.evaluationCase.mustPreserve.map((requirement) => ({ requirement, result: 'pending' })),
      dynamicFacts: input.evaluationCase.dynamicFactsToVerify.map((fact) => ({ fact, result: 'pending' }))
    },
    evidence: {
      seedPlan: input.seededPlan,
      assistantResponses: input.assistantResponses,
      proposalFeedback: input.proposalFeedback.slice(-3),
      proposals: input.proposals,
      preparations: input.preparations.map((item) => ({
        id: item.id,
        title: item.title,
        category: item.category,
        ...(item.packingSection ? { packingSection: item.packingSection } : {}),
        detail: item.detail,
        itineraryDate: item.itineraryDate,
        dueDate: item.dueDate,
        evidenceLevel: item.evidenceLevel,
        sourceIds: item.sourceIds,
        ...(item.locationContext ? { locationContext: item.locationContext } : {})
      })),
      sources: input.sources.map((source) => ({
        id: source.id, title: source.title, url: source.url, provider: source.provider,
        kind: source.kind, fetchedAt: source.fetchedAt, status: source.status, sourceNature: source.sourceNature,
        contentLevel: source.contentLevel,
        ...(source.kind === 'weather' && source.sourceNature === 'service'
          ? { structuredSummary: source.summary.slice(0, 5_000) }
          : {})
      }))
    }
  }
}

/** 仅在明确指定路径时保存评审证据；默认只保留运行摘要并删除临时资料。 */
async function saveReportIfRequested(report: ReturnType<typeof makeCaseReport>, vault: SecretVault): Promise<string[]> {
  const requestedDirectory = process.env.TRIPWISE_TRAVEL_EVAL_ARTIFACT_DIR?.trim()
  if (!requestedDirectory) return []
  const directory = resolve(requestedDirectory)
  await mkdir(directory, { recursive: true })
  const reportPath = join(directory, `${report.case.id}.json`)
  const secretNames = ['modelKey', 'exaKey', 'tavilyKey', 'firecrawlKey', 'amapKey', 'amapJsKey', 'amapSecurityCode'] as const
  const secrets = await Promise.all(secretNames
    .map((name) => vault.get(name)))
  const content = redactCredentialText(JSON.stringify(report, null, 2), secrets.filter((value): value is string => !!value))
  await writeFile(reportPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return [reportPath]
}

/** 比较除运行时生成 ID 外的可见日程字段。 */
function planDaySignature(day: ItineraryDay): string {
  return JSON.stringify({
    title: day.title,
    stops: day.stops.map(({ name, area, time, durationMinutes, category, notes, transitToNext, locked }) =>
      ({ name, area, time, durationMinutes, category, notes, transitToNext, locked })),
    scheduleBlocks: day.scheduleBlocks.map(({ kind, title, time, durationMinutes, area, notes }) =>
      ({ kind, title, time, durationMinutes, area, notes }))
  })
}

/** 校验手动评测只从本机读取有效模型设置。 */
function isModelSettings(value: unknown): value is AppSettings['model'] {
  if (!isRecord(value) || typeof value.baseUrl !== 'string' || typeof value.model !== 'string') return false
  try {
    return new URL(value.baseUrl).protocol === 'https:' && value.model.trim().length > 0
  } catch {
    return false
  }
}

/** 仅使用当前产品定义的连接开关，未知设置退回安全默认值。 */
function isConnectorSettings(value: unknown): value is AppSettings['connectors'] {
  return isRecord(value) && ['webSearch', 'weather', 'places', 'routes'].every((key) => typeof value[key] === 'boolean')
}

/** 创建无外网的失败插件配置，验证 MCP 连接中断时 Agent 仍可继续。 */
function failedMcpFixture(directory: string): AppSettings['mcpServers'][number] {
  return {
    id: 'tripwise-eval-failed-mcp',
    name: '评测用不可用插件',
    transport: 'stdio',
    command: join(directory, 'missing-mcp-fixture'),
    args: [],
    envKeys: [],
    enabled: true,
    allowedTools: ['read_only_probe']
  }
}

/** 判断 JSON 数据是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 解析明确指定的案例编号；all 只用于人工确认的完整实跑。 */
function parseRequestedIds(value: string | undefined): string[] {
  const requested = value?.trim()
  if (!requested) return []
  if (requested === 'all') return manifest.cases.map((item) => item.id)
  const ids = requested.split(',').map((id) => id.trim()).filter(Boolean)
  if (new Set(ids).size !== ids.length) throw new Error('旅行评测案例编号不能重复。')
  return ids
}
