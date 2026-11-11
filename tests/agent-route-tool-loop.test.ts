/** 验证路线由模型按需选择，成功结果和 warning 都回到模型决策。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TravelAgent } from '../src/main/agent.js'
import { createSource } from '../src/main/connectors/types.js'
import { executeTool } from '../src/main/tools.js'
import { TripStore } from '../src/main/persistence.js'
import type { SecretVault } from '../src/main/secrets.js'
import type { AgentEvent } from '../src/shared/types.js'

const temporaryDirectories: string[] = []

/** 创建隔离旅行与已启用高德的模型设置。 */
async function createPlanningContext(endDate = '2026-11-03') {
  const directory = await mkdtemp(join(tmpdir(), 'tripwise-route-tool-loop-'))
  temporaryDirectories.push(directory)
  const store = new TripStore(directory)
  await store.initialize()
  await store.createTrip({
    destination: '北京', interests: '清华大学、北京大学', transport: '公共交通',
    startDate: '2026-11-03', endDate
  })
  const trip = store.snapshot().trips[0]
  if (!trip) throw new Error('旅行资料未创建。')
  await store.updateSettings({
    ...store.snapshot().settings,
    model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
    connectors: { ...store.snapshot().settings.connectors, routes: true, webSearch: false, weather: false, places: false }
  })
  const vault = {
    get: async (name: string) => name === 'modelKey' ? 'fixture-model-key' : name === 'amapKey' ? 'fixture-amap-key' : null
  } as unknown as SecretVault
  return { store, trip, vault }
}

/** 构造结构有效的海淀一日行程。 */
function itineraryCall() {
  return { plan: {
    title: '海淀一日游', summary: '按校园片区游览。', tradeoffs: '路线时长按来源估算。',
    days: [{ day_number: 1, date: '2026-11-03', title: '海淀校园', stops: [
      {
        name: '清华大学', area: '海淀区', time: '09:00–10:00', duration_minutes: 60,
        category: '人文景点', notes: '', transit_to_next: '公共交通前往北京大学。',
        evidence_level: 'pending', source_ids: [], fact_claims: []
      },
      {
        name: '北京大学', area: '海淀区', time: '10:30–11:30', duration_minutes: 60,
        category: '人文景点', notes: '', transit_to_next: '',
        evidence_level: 'pending', source_ids: [], fact_claims: []
      }
    ] }]
  } }
}

/** 构造会产生大量时段缺口的七日计划，验证交通 warning 不被数量上限挤掉。 */
function detailedWeekItineraryCall(firstStopTime = '上午') {
  const dates = Array.from({ length: 7 }, (_, index) =>
    new Date(Date.UTC(2026, 10, 3 + index)).toISOString().slice(0, 10)
  )
  return { plan: {
    title: '北京七日游', summary: '按片区串联。', tradeoffs: '',
    days: dates.map((date, index) => {
      const names = index === 0
        ? ['清华大学', '北京大学', '圆明园']
        : [`第${index + 1}天地点一`, `第${index + 1}天地点二`, `第${index + 1}天地点三`]
      return {
        day_number: index + 1, date, title: `第${index + 1}天`,
        stops: names.map((name, stopIndex) => ({
          name, area: '北京', time: index === 0 && stopIndex === 0 ? firstStopTime : stopIndex === 0 ? '上午' : stopIndex === 1 ? '下午' : '晚上',
          duration_minutes: null, category: '景点', notes: '',
          transit_to_next: stopIndex < 2 ? `公共交通前往${names[stopIndex + 1]}。` : '',
          evidence_level: 'pending', source_ids: [], fact_claims: []
        }))
      }
    })
  } }
}

type ModelStep = { name: string; arguments: Record<string, unknown> } | { content: string }
type CapturedRequest = {
  messages?: Array<{ role: string; content?: string | null; tool_call_id?: string }>
  tools?: Array<{ function?: { name?: string; description?: string } }>
  executionCount: number
  toolNames: string[]
}

/** 记录每次请求前已执行的工具，并按脚本返回模型选择。 */
function stubModel(steps: ModelStep[], executedTools: string[], requests: CapturedRequest[]) {
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Omit<CapturedRequest, 'executionCount' | 'toolNames'>
    requests.push({
      ...body,
      executionCount: executedTools.length,
      toolNames: body.tools?.flatMap((tool) => tool.function?.name ? [tool.function.name] : []) ?? []
    })
    const step = steps[requests.length - 1]
    if (!step) throw new Error('测试脚本缺少模型响应。')
    const message = 'content' in step
      ? { role: 'assistant', content: step.content }
      : { role: 'assistant', tool_calls: [{
          id: `call-${requests.length}`, type: 'function',
          function: { name: step.name, arguments: JSON.stringify(step.arguments) }
        }] }
    return new Response(JSON.stringify({ choices: [{ message }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('模型驱动的路线工具循环', () => {
  it('详细计划先提交地点顺序，再开放路线工具供模型选择并绑定结果', async () => {
    const { store, trip, vault } = await createPlanningContext()
    const executedTools: string[] = []
    const requests: CapturedRequest[] = []
    const routeSource = createSource(
      '清华大学 → 北京大学', 'https://ditu.amap.com/', '高德地图路线规划', 'route',
      '清华大学 → 北京大学，公共交通（2026-11-03 10:00）估算：\n方案 1：公共交通全程约 20 分钟，1,200 米', 'success'
    )
    routeSource.contentLevel = 'structured'
    const modelRouteCall = {
      city: '北京', origin: '清华大学', destination: '北京大学', mode: 'transit',
      date: '2026-11-03', time: '10-00'
    }
    stubModel([
      { name: 'propose_itineraries', arguments: itineraryCall() },
      { name: 'estimate_route', arguments: modelRouteCall },
      { name: 'propose_itineraries', arguments: itineraryCall() },
      { content: '路线来源已并入计划，行程草案可审阅。' }
    ], executedTools, requests)

    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      executedTools.push(name)
      if (name === 'estimate_route') {
        expect(JSON.parse(rawArguments)).toEqual(modelRouteCall)
        expect(context.itineraryOptions).toHaveLength(1)
        return {
          output: routeSource.summary,
          sources: [routeSource],
          routeOptions: [{
            optionNumber: 1, mode: 'transit', durationMinutes: 20, distanceMeters: 1_200,
            walkingDistanceMeters: 250, transitLines: ['地铁4号线'], summary: '公共交通约20分钟'
          }]
        }
      }
      return executeTool(name, rawArguments, context, signal)
    }
    const events: AgentEvent[] = []

    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id, '请规划北京一日游，行程详细到交通接驳，清华大学到北京大学尽量乘公共交通。',
      'model-selects-route', new AbortController().signal, (event) => events.push(event)
    )

    const routeReceipt = requests[2]?.messages?.filter((message) => message.role === 'tool').at(-1)
    const savedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const plan = savedTrip?.messages.flatMap((message) => message.itineraryOptions ?? []).at(-1)
    const firstStop = plan?.days[0]?.stops[0]
    expect(requests.map((request) => request.executionCount)).toEqual([0, 1, 2, 3])
    expect(requests[0]?.toolNames).toContain('propose_itineraries')
    expect(requests[0]?.toolNames).not.toContain('estimate_route')
    expect(requests[1]?.toolNames).toContain('estimate_route')
    expect(requests[1]?.tools?.find((tool) => tool.function?.name === 'estimate_route')?.function?.description)
      .toContain('“上午/下午”等模糊时段省略，不要推测')
    expect(routeReceipt?.content).toContain(routeSource.id)
    expect(requests[2]?.messages?.at(-1)?.content).toContain('路线工具已返回可用来源')
    expect(requests[2]?.messages?.at(-1)?.content).toContain('重新提交当前方案绑定来源')
    expect(executedTools).toEqual(['propose_itineraries', 'estimate_route', 'propose_itineraries'])
    expect(firstStop?.transitEstimate).toMatchObject({
      sourceId: routeSource.id, destinationStopId: plan?.days[0]?.stops[1]?.id, durationMinutes: 20
    })
    expect(events.filter((event) => event.type === 'tool').map((event) => event.toolName))
      .toEqual(['propose_itineraries', 'estimate_route', 'propose_itineraries'])
    expect(events.filter((event) => event.type === 'tool_result').map((event) => event.toolName))
      .toEqual(['propose_itineraries', 'estimate_route', 'propose_itineraries'])
  })

  it('无效来源在工具回执阶段报 error，模型修正后仍能保存方案', async () => {
    const { store, trip, vault } = await createPlanningContext()
    const unavailableSource = createSource(
      '故宫开放信息', 'https://museum.example/visit', '测试来源', 'web', '页面暂不可用。', 'unavailable'
    )
    const [sourceId] = await store.saveSources(trip.id, [unavailableSource])
    if (!sourceId) throw new Error('测试来源未保存。')

    const requests: CapturedRequest[] = []
    const executedTools: string[] = []
    const rejectedPlan = itineraryCall()
    stubModel([
      { name: 'propose_itineraries', arguments: rejectedPlan },
      { name: 'propose_itineraries', arguments: itineraryCall() },
      { content: '已移除失效来源并完成行程草案。' }
    ], executedTools, requests)

    let proposalCount = 0
    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      executedTools.push(name)
      const result = await executeTool(name, rawArguments, context, signal)
      if (name !== 'propose_itineraries' || proposalCount++ > 0) return result
      const candidate = result.itineraryOptions?.[0]
      if (!candidate) throw new Error('测试行程未能生成。')
      const invalidCandidate = structuredClone(candidate)
      invalidCandidate.days[0]!.stops[0]!.sourceIds = [sourceId]
      invalidCandidate.days[0]!.stops[0]!.evidenceLevel = 'sourced'
      return { ...result, itineraryOptions: [invalidCandidate], feedback: [] }
    }

    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id, '请规划北京一日游，核对故宫开放信息。',
      'invalid-evidence-source-loop', new AbortController().signal, () => undefined
    )

    const retryReceipt = requests[1]?.messages?.filter((message) => message.role === 'tool').at(-1)
    const receipt = JSON.parse(retryReceipt?.content ?? '{}') as {
      status?: string
      proposal_saved?: boolean
      feedback?: Array<{ severity?: string; code?: string }>
    }
    const savedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const finalPlan = savedTrip?.messages.flatMap((message) => message.itineraryOptions ?? []).at(-1)

    expect(receipt).toMatchObject({ status: 'error', proposal_saved: false })
    expect(receipt.feedback).toContainEqual(expect.objectContaining({
      severity: 'error', code: 'itinerary_source_invalid'
    }))
    expect(executedTools).toEqual(['propose_itineraries', 'propose_itineraries'])
    expect(finalPlan?.days[0]?.stops[0]?.sourceIds).toEqual([])
    expect(store.snapshot().trips.find((item) => item.id === trip.id)?.sources
      .find((source) => source.id === sourceId)?.status).toBe('unavailable')
  })

  it('路线回执指出端点不匹配后，模型可只补查计划路段并绑定新结果', async () => {
    const { store, trip, vault } = await createPlanningContext()
    const executedTools: string[] = []
    const requests: CapturedRequest[] = []
    const plannedRouteCall = {
      city: '北京', origin: '清华大学', destination: '北京大学', mode: 'transit',
      date: '2026-11-03', time: '10-00'
    }
    stubModel([
      { name: 'estimate_route', arguments: {
        city: '北京', origin: '北京西站', destination: '香山公园', mode: 'transit',
        date: '2026-11-03', time: '09-00'
      } },
      { name: 'propose_itineraries', arguments: itineraryCall() },
      { name: 'estimate_route', arguments: plannedRouteCall },
      { name: 'propose_itineraries', arguments: itineraryCall() },
      { content: '已采用与当前计划端点匹配的路线结果。' }
    ], executedTools, requests)
    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      executedTools.push(name)
      if (name === 'estimate_route') {
        const args = JSON.parse(rawArguments) as typeof plannedRouteCall
        const title = `${args.origin} → ${args.destination}`
        const summary = `${title}，公共交通（${args.date} ${args.time?.replace('-', ':') ?? ''}）估算：\n方案 1：公共交通约 20 分钟 · 1,200 米\n路线估算结果，出行当天核对。`
        const url = `https://ditu.amap.com/search?query=${encodeURIComponent(`${args.origin} 到 ${args.destination}`)}`
        const source = createSource(title, url, '高德地图路线规划', 'route', summary)
        source.contentLevel = 'structured'
        return {
          output: summary,
          sources: [source],
          routeOptions: [{
            optionNumber: 1, mode: 'transit', durationMinutes: 20, distanceMeters: 1_200,
            walkingDistanceMeters: 250, transitLines: ['地铁4号线'], summary: '公共交通约20分钟'
          }]
        }
      }
      return executeTool(name, rawArguments, context, signal)
    }

    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id, '请规划北京一日游，清华大学到北京大学尽量乘公共交通。',
      'model-corrects-route-after-feedback', new AbortController().signal, () => undefined
    )

    const firstProposal = (requests[2]?.messages ?? [])
      .filter((message) => message.role === 'tool')
      .map((message) => JSON.parse(message.content ?? '{}') as {
        feedback?: Array<{ severity: string; code: string; message: string }>
      })
      .find((receipt) => receipt.feedback?.some((item) => item.code === 'route_source_not_bound'))
    const savedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const finalPlan = savedTrip?.messages.flatMap((message) => message.itineraryOptions ?? []).at(-1)
    expect(firstProposal?.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'warning',
        code: 'route_source_not_bound',
        message: expect.stringContaining('北京西站 → 香山公园')
      })
    ]))
    expect(executedTools).toEqual(['estimate_route', 'propose_itineraries', 'estimate_route', 'propose_itineraries'])
    expect(finalPlan?.days[0]?.stops[0]?.transitEstimate).toMatchObject({
      mode: 'transit', durationMinutes: 20,
      destinationStopId: finalPlan?.days[0]?.stops[1]?.id
    })
  })

  it('路线 warning 回到模型后由模型决定保留待核验计划，不自动重查', async () => {
    const { store, trip, vault } = await createPlanningContext()
    const executedTools: string[] = []
    const requests: CapturedRequest[] = []
    stubModel([
      { name: 'estimate_route', arguments: {
        city: '北京', origin: '清华大学', destination: '北京大学', mode: 'transit', date: '2026-11-03'
      } },
      { name: 'propose_itineraries', arguments: itineraryCall() },
      { content: '路线来源暂缺，交通保留待核验。' }
    ], executedTools, requests)
    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      executedTools.push(name)
      if (name === 'estimate_route') return {
        output: '路线服务没有返回可用结果，通勤时长待核验。', sources: [],
        routeFailureKind: 'route_data_missing',
        feedback: [{ severity: 'warning', code: 'route_data_missing', message: '路线时长待核验。' }]
      }
      return executeTool(name, rawArguments, context, signal)
    }
    const events: AgentEvent[] = []

    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id, '请规划北京一日游，清华大学到北京大学尽量乘公共交通。',
      'model-keeps-route-pending', new AbortController().signal, (event) => events.push(event)
    )

    const routeReceipt = requests[1]?.messages?.find((message) => message.role === 'tool')
    const receipt = JSON.parse(routeReceipt?.content ?? '{}') as {
      feedback?: Array<{ severity: string; code: string }>
    }
    const savedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const plan = savedTrip?.messages.flatMap((message) => message.itineraryOptions ?? []).at(-1)
    expect(receipt.feedback).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'route_data_missing' }))
    expect(executedTools).toEqual(['estimate_route', 'propose_itineraries'])
    expect(plan).toBeDefined()
    expect(plan?.days[0]?.stops[0]?.transitEstimate).toBeUndefined()
    expect(events.find((event) => event.type === 'tool_result' && event.toolName === 'estimate_route'))
      .toMatchObject({ toolFeedback: [{ severity: 'warning', code: 'route_data_missing' }] })
  })

  it('路线工具指出端点与候选不匹配时，提示模型按回执修正后自行判断是否重查', async () => {
    const { store, trip, vault } = await createPlanningContext()
    const executedTools: string[] = []
    const requests: CapturedRequest[] = []
    stubModel([
      { name: 'propose_itineraries', arguments: itineraryCall() },
      { name: 'estimate_route', arguments: {
        city: '北京', origin: '西单', destination: '香山公园', mode: 'transit', date: '2026-11-03'
      } },
      { name: 'propose_itineraries', arguments: itineraryCall() },
      { content: '路线时长待核验，计划已保存。' }
    ], executedTools, requests)
    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      executedTools.push(name)
      return executeTool(name, rawArguments, context, signal)
    }

    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id,
      '请规划北京一日游，给出每段公共交通方式和耗时，清华大学到北京大学尽量乘公共交通。',
      'route-plan-missing-review', new AbortController().signal, () => undefined
    )

    const routeReceipt = JSON.parse(
      requests[2]?.messages?.filter((message) => message.role === 'tool').at(-1)?.content ?? '{}'
    ) as { feedback?: Array<{ code: string; severity: string }> }
    const reviewPrompt = requests[2]?.messages?.at(-1)?.content ?? ''
    expect(routeReceipt.feedback).toContainEqual(expect.objectContaining({
      severity: 'warning', code: 'route_segment_not_planned'
    }))
    expect(reviewPrompt).toContain('路线工具返回 warning。')
    expect(reviewPrompt).toContain('端点不是计划中的同日相邻路段')
    expect(reviewPrompt).toContain('先读回执列出的候选路段')
    expect(executedTools).toEqual(['propose_itineraries', 'estimate_route', 'propose_itineraries'])
  })

  it('详细公共交通计划未查询路线时返回明确缺口 warning，但不强制重查', async () => {
    const { store, trip, vault } = await createPlanningContext()
    const executedTools: string[] = []
    const requests: CapturedRequest[] = []
    stubModel([
      { name: 'propose_itineraries', arguments: itineraryCall() },
      { content: '路线估时待核验，计划可继续审阅。' }
    ], executedTools, requests)
    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      executedTools.push(name)
      return executeTool(name, rawArguments, context, signal)
    }

    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id,
      '请规划北京一日游，具体到每段公共交通方式和耗时，并按时段安排景点。',
      'model-skips-route-research', new AbortController().signal, () => undefined
    )

    const receipt = JSON.parse(
      requests[1]?.messages?.find((message) => message.role === 'tool')?.content ?? '{}'
    ) as { feedback?: Array<{ severity: string; code: string; message: string }> }
    expect(receipt.feedback).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'requested_route_coverage_missing',
      message: expect.stringContaining('1段公共交通尚无来源估时'),
    }))
    expect(receipt.feedback).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'requested_route_coverage_missing',
      message: expect.stringContaining('estimate_route'),
    }))
    expect(receipt.feedback).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'requested_route_coverage_missing',
      message: expect.stringContaining('先判断固定预约、机场/车站衔接或跨区移动中影响最大的 1–3 段相邻路段')
    }))
    expect(receipt.feedback).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'requested_route_coverage_missing',
      message: expect.stringContaining('清华大学 → 北京大学')
    }))
    expect(requests[1]?.messages?.at(-1)).toMatchObject({
      role: 'user', content: expect.stringContaining('计划已保存。')
    })
    expect(requests[1]?.messages?.at(-1)?.content).toContain('若 estimate_route 可用且值得查询')
    expect(executedTools).toEqual(['propose_itineraries'])
  })

  it('模型可根据候选 warning 补查路线并再次提交绑定来源的计划', async () => {
    const { store, trip, vault } = await createPlanningContext()
    const executedTools: string[] = []
    const requests: CapturedRequest[] = []
    const routeSource = createSource(
      '清华大学 → 北京大学', 'https://ditu.amap.com/', '高德地图路线规划', 'route',
      '清华大学 → 北京大学，公共交通（2026-11-03 10:00）估算：\n方案 1：公共交通全程约 20 分钟，1,200 米', 'success'
    )
    routeSource.contentLevel = 'structured'
    const routeCall = {
      city: '北京', origin: '清华大学', destination: '北京大学', mode: 'transit',
      date: '2026-11-03', time: '10-00'
    }
    stubModel([
      { name: 'propose_itineraries', arguments: itineraryCall() },
      { name: 'estimate_route', arguments: routeCall },
      { name: 'propose_itineraries', arguments: itineraryCall() },
      { content: '已补充路线来源，交通时长仍以现场核对为准。' }
    ], executedTools, requests)

    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      executedTools.push(name)
      if (name === 'estimate_route') {
        expect(JSON.parse(rawArguments)).toEqual(routeCall)
        expect(context.itineraryOptions?.length).toBeGreaterThan(0)
        return {
          output: routeSource.summary,
          sources: [routeSource],
          routeOptions: [{
            optionNumber: 1, mode: 'transit', durationMinutes: 20, distanceMeters: 1_200,
            walkingDistanceMeters: 250, transitLines: ['地铁4号线'], summary: '公共交通约20分钟'
          }]
        }
      }
      return executeTool(name, rawArguments, context, signal)
    }

    // 验证首稿 warning 进入下一轮上下文，且 Agent 不代替模型自动调用路线工具。
    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id,
      '请规划北京一日游，具体到每段公共交通方式和耗时，并按时段安排景点。',
      'model-revises-route-after-feedback', new AbortController().signal, () => undefined
    )

    const proposalReceipt = JSON.parse(
      requests[1]?.messages?.find((message) => message.role === 'tool')?.content ?? '{}'
    ) as { feedback?: Array<{ code: string; message: string }> }
    expect(requests[1]?.messages?.at(-1)).toMatchObject({
      role: 'user', content: expect.stringContaining('用户要求具体交通安排')
    })
    const routeReceipt = requests[2]?.messages?.filter((message) => message.role === 'tool').at(-1)
    const savedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const plan = savedTrip?.messages.flatMap((message) => message.itineraryOptions ?? []).at(-1)
    expect(proposalReceipt.feedback).toContainEqual(expect.objectContaining({
      code: 'requested_route_coverage_missing', message: expect.stringContaining('清华大学 → 北京大学')
    }))
    expect(routeReceipt?.content).toContain(routeSource.id)
    expect(executedTools).toEqual(['propose_itineraries', 'estimate_route', 'propose_itineraries'])
    expect(requests.map((request) => request.executionCount)).toEqual([0, 1, 2, 3])
    expect(plan?.days[0]?.stops[0]?.transitEstimate).toMatchObject({
      sourceId: routeSource.id, destinationStopId: plan?.days[0]?.stops[1]?.id, durationMinutes: 20
    })
  })

  it('七日计划收到路线 warning 后，模型补齐查询时刻并绑定来源', async () => {
    const { store, trip, vault } = await createPlanningContext('2026-11-09')
    const executedTools: string[] = []
    const requests: CapturedRequest[] = []
    const weekPlan = detailedWeekItineraryCall()
    const revisedWeekPlan = detailedWeekItineraryCall('09:00–10:00')
    stubModel([
      { name: 'propose_itineraries', arguments: weekPlan },
      { name: 'estimate_route', arguments: {
        city: '北京', origin: '清华大学', destination: '北京大学', mode: 'transit',
        date: '2026-11-03', time: '10-00'
      } },
      { name: 'propose_itineraries', arguments: revisedWeekPlan },
      { content: '路线估时已补入；未覆盖的时段仍标记待核验。' }
    ], executedTools, requests)

    const routeSource = createSource(
      '清华大学 → 北京大学', 'https://ditu.amap.com/', '高德地图路线规划', 'route',
      '清华大学 → 北京大学，公共交通（2026-11-03 10:00）估算：\n方案 1：公共交通全程约 20 分钟，1,200 米', 'success'
    )
    routeSource.contentLevel = 'structured'
    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      executedTools.push(name)
      if (name === 'estimate_route') return {
        output: routeSource.summary,
        sources: [routeSource],
        routeOptions: [{
          optionNumber: 1, mode: 'transit', durationMinutes: 20, distanceMeters: 1_200,
          walkingDistanceMeters: 250, transitLines: ['地铁4号线'], summary: '公共交通约20分钟'
        }]
      }
      return executeTool(name, rawArguments, context, signal)
    }

    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id,
      '请规划北京七日详细行程，按时段安排景点并给出每段公共交通方式和耗时。',
      'route-warning-priority-week-plan', new AbortController().signal, () => undefined
    )

    const proposalReceipt = JSON.parse(
      requests[1]?.messages?.find((message) => message.role === 'tool')?.content ?? '{}'
    ) as { feedback?: Array<{ code: string; message: string }> }
    const detailWarning = proposalReceipt.feedback?.find((item) => item.code === 'requested_route_coverage_missing')
    const genericDetailWarning = proposalReceipt.feedback?.find((item) => item.code === 'requested_detail_missing')
    const reviewPrompt = requests[1]?.messages?.find((message) =>
      message.role === 'user' && message.content?.includes('计划已保存。')
    )?.content
    const savedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const finalPlan = savedTrip?.messages.flatMap((message) => message.itineraryOptions ?? []).at(-1)
    const routeReceipt = requests[2]?.messages?.filter((message) => message.role === 'tool').at(-1)
    expect(proposalReceipt.feedback?.[0]?.code).toBe('requested_route_coverage_missing')
    expect(proposalReceipt.feedback?.filter((item) => item.code === 'requested_route_coverage_missing')).toHaveLength(1)
    expect(detailWarning?.message).toContain('estimate_route')
    expect(detailWarning?.message).toContain('清华大学 → 北京大学')
    expect(detailWarning?.message).toContain('14段公共交通尚无来源估时')
    expect(detailWarning?.message).toContain('1–3 段相邻路段')
    expect(genericDetailWarning?.message).toBeDefined()
    expect(genericDetailWarning?.message).not.toContain('estimate_route')
    expect(reviewPrompt).toContain('用户要求具体交通安排')
    expect(reviewPrompt).toContain('使用计划中的原地点名、对应日期和交通方式')
    expect(reviewPrompt).toContain('单一开始时刻加停留时长')
    expect(reviewPrompt).toContain('模糊时段省略，不要推测')
    expect(reviewPrompt).toContain('无需覆盖全部路段')
    expect(routeReceipt?.content).toContain(routeSource.id)
    expect(executedTools).toEqual(['propose_itineraries', 'estimate_route', 'propose_itineraries'])
    expect(finalPlan?.days).toHaveLength(7)
    expect(finalPlan?.days[0]?.stops[0]?.transitEstimate).toMatchObject({
      sourceId: routeSource.id, durationMinutes: 20
    })
  })
})
