/** 验证模型决定检索步骤，工具回执按统一协议返回并共享渠道状态。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TravelAgent } from '../src/main/agent.js'
import { createSource } from '../src/main/connectors/types.js'
import { executeTool } from '../src/main/tools.js'
import { TripStore } from '../src/main/persistence.js'
import type { SecretVault } from '../src/main/secrets.js'

const temporaryDirectories: string[] = []

/** 为 Agent 集成测试创建隔离资料目录。 */
async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'tripwise-agent-loop-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Agent 模型驱动检索循环', () => {
  it('模型逐轮选择检索并在读取警告后决定继续', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({
      destination: '北京', interests: '故宫、景山', startDate: '2026-11-10', endDate: '2026-11-10'
    })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    await store.updateSettings({
      ...store.snapshot().settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
      connectors: { ...store.snapshot().settings.connectors, webSearch: true }
    })

    type CapturedRequest = {
      tool_choice?: 'auto' | 'required' | { type: 'function'; function: { name: string } }
      tools?: Array<{ function?: { name?: string } }>
      messages?: Array<{ role: string; content?: string | null }>
      searchCallsBeforeRequest: number
    }
    const requests: CapturedRequest[] = []
    let searchCallCount = 0
    let itinerarySubmissionCount = 0
    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      if (name === 'propose_itineraries') {
        itinerarySubmissionCount += 1
        const result = await executeTool(name, rawArguments, context, signal)
        return {
          ...result,
          feedback: itinerarySubmissionCount === 1
            ? [{ severity: 'error', code: 'fixture_hard_error', message: '结构需要修正。' }]
            : [{ severity: 'warning', code: 'fixture_advisory', message: '预约事实仍待核验。' }]
        }
      }
      if (name !== 'search_web') return executeTool(name, rawArguments, context, signal)
      searchCallCount += 1
      return {
        output: '检索到北京景点资料，具体事实以原始页面为准。',
        sources: [createSource(
          `北京检索结果 ${searchCallCount}`,
          `https://search.example/result-${searchCallCount}`,
          '测试搜索结果', 'web', '景点资料摘要。'
        )]
      }
    }
    const plan = { plan: {
      title: '北京中轴线一日游', summary: '先游故宫，再到景山。', tradeoffs: '开放与预约以来源复核。',
      days: [{ day_number: 1, date: '2026-11-10', title: '故宫与景山', stops: [
        { name: '故宫博物院', area: '东城区', time: '09:00–12:00', duration_minutes: 180,
          category: '人文', notes: '', transit_to_next: '步行前往景山', evidence_level: 'pending', source_ids: [], fact_claims: [] },
        { name: '景山公园', area: '西城区', time: '13:00–14:30', duration_minutes: 90,
          category: '人文', notes: '', transit_to_next: '', evidence_level: 'pending', source_ids: [], fact_claims: [] }
      ] }]
    } }
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as Omit<CapturedRequest, 'searchCallsBeforeRequest'>
      requests.push({ ...requestBody, searchCallsBeforeRequest: searchCallCount })
      const index = requests.length
      const toolCall = index <= 2
        ? { name: 'search_web', arguments: { query: `北京景点资料 ${index}` } }
        : index === 3 || index === 4
          ? { name: 'propose_itineraries', arguments: plan }
          : undefined
      if (index === 4) {
        const lastToolResult = [...(requestBody.messages ?? [])].reverse().find((message) => message.role === 'tool')
        const payload = JSON.parse(lastToolResult?.content ?? '{}') as {
          status?: string
          feedback?: Array<{ severity?: string; code?: string }>
        }
        expect(payload.status).toBe('error')
        expect(payload.feedback?.some((item) => item.code === 'fixture_hard_error')).toBe(true)
        const progress = store.snapshot().trips.find((item) => item.id === trip.id)?.messages.at(-1)?.agentRunProgress
        expect(progress?.itineraryOptions).toHaveLength(0)
      }
      if (index === 5) {
        const lastToolResult = [...(requestBody.messages ?? [])].reverse().find((message) => message.role === 'tool')
        const payload = JSON.parse(lastToolResult?.content ?? '{}') as {
          status?: string
          feedback?: Array<{ severity?: string; code?: string }>
        }
        expect(payload.status).toBe('warning')
        expect(payload.feedback?.some((item) => item.code === 'fixture_advisory')).toBe(true)
        const progress = store.snapshot().trips.find((item) => item.id === trip.id)?.messages.at(-1)?.agentRunProgress
        expect(progress?.itineraryOptions).toHaveLength(1)
      }
      return new Response(JSON.stringify({ choices: [{ message: toolCall
        ? { role: 'assistant', tool_calls: [{
            id: `call-round-${index}`, type: 'function',
            function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) }
          }] }
        : { role: 'assistant', content: '计划已整理完成。' }
      }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const vault = { get: async (name: string) => ({
      modelKey: 'fixture-model-key', exaKey: 'fixture-exa-key', tavilyKey: 'fixture-tavily-key'
    }[name] ?? null) } as unknown as SecretVault

    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id,
      '请规划北京2026-11-10一日游，按时段安排故宫和景山，并核对开放时间与预约。',
      'model-directed-research', new AbortController().signal, () => undefined
    )

    expect(requests).toHaveLength(5)
    expect(requests.map((request) => request.searchCallsBeforeRequest)).toEqual([0, 1, 2, 2, 2])
    expect(requests.slice(0, 3).every((request) =>
      request.tools?.some((tool) => tool.function?.name === 'search_web')
    )).toBe(true)
    expect(requests[2]?.tools?.some((tool) => tool.function?.name === 'propose_itineraries')).toBe(true)
    expect(requests[4]?.tools?.some((tool) => tool.function?.name === 'propose_itinerary_facts')).toBe(true)
    expect(requests[4]?.tool_choice).toBe('auto')
    expect(searchCallCount).toBe(2)
    expect(itinerarySubmissionCount).toBe(2)
    expect(store.snapshot().trips.find((item) => item.id === trip.id)?.messages
      .some((message) => message.role === 'assistant' && message.itineraryOptions?.length === 1)).toBe(true)
  })

  it('模型额度耗尽后保留已保存来源与恢复点，重试不重复写入用户消息', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({ destination: '北京', startDate: '2026-11-10', endDate: '2026-11-10' })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    await store.updateSettings({
      ...store.snapshot().settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
      connectors: { ...store.snapshot().settings.connectors, webSearch: true }
    })

    let requestCount = 0
    vi.stubGlobal('fetch', async () => {
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
          id: 'call-search-before-quota', type: 'function',
          function: { name: 'search_web', arguments: JSON.stringify({ query: '故宫开放时间' }) }
        }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (requestCount === 2) {
        return new Response(JSON.stringify({ error: { code: 'insufficient_quota', message: 'private billing detail' } }), {
          status: 429, headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '已保留检索资料，稍后可继续。' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    })
    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      if (name === 'search_web') return {
        output: '故宫开放信息待核验。',
        sources: [createSource('故宫参观信息', 'https://museum.example/visit', '测试搜索', 'web', '开放信息摘要。')]
      }
      return executeTool(name, rawArguments, context, signal)
    }
    const vault = { get: async (name: string) => name === 'modelKey' ? 'fixture-model-key' : null } as unknown as SecretVault
    const agent = new TravelAgent(toolExecutor)
    const content = '请查找北京故宫开放时间。'

    await expect(agent.run(
      store, vault, trip.id, content, 'quota-recovery-first', new AbortController().signal, () => undefined
    )).rejects.toThrow('账户额度或余额不足')

    const afterFailure = store.snapshot().trips.find((item) => item.id === trip.id)
    const interruptedMessage = afterFailure?.messages.at(-1)
    expect(interruptedMessage).toMatchObject({ role: 'user', content })
    expect(interruptedMessage?.agentRunProgress?.transcript).toHaveLength(2)
    expect(interruptedMessage?.agentRunProgress?.sourceIds).toHaveLength(1)
    expect(afterFailure?.sources).toHaveLength(1)

    await agent.run(
      store, vault, trip.id, content, 'quota-recovery-retry', new AbortController().signal, () => undefined,
      interruptedMessage?.id, interruptedMessage?.conversationId
    )

    const afterRetry = store.snapshot().trips.find((item) => item.id === trip.id)
    expect(afterRetry?.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    expect(afterRetry?.sources).toHaveLength(1)
    expect(afterRetry?.messages.at(-1)).toMatchObject({ role: 'assistant', content: '已保留检索资料，稍后可继续。' })
    expect(requestCount).toBe(3)
  })

  it('业务 warning 不强制重交行程，模型仍可选择先补查', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({ destination: '北京', startDate: '2026-11-10', endDate: '2026-11-10' })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    await store.updateSettings({
      ...store.snapshot().settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
      connectors: { ...store.snapshot().settings.connectors, webSearch: true }
    })

    const requests: Array<{ tool_choice?: string | { type: 'function'; function: { name: string } }; tools?: Array<{ function?: { name?: string } }> }> = []
    let itinerarySubmissionCount = 0
    const plan = { plan: {
      title: '北京一日', summary: '故宫与景山。', tradeoffs: '',
      days: [{ day_number: 1, date: '2026-11-10', title: '中轴线', stops: [
        { name: '故宫博物院', area: '东城区', time: '09:00–12:00', category: '人文' },
        { name: '景山公园', area: '西城区', time: '13:00–14:30', category: '人文' }
      ] }]
    } }
    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      if (name === 'propose_itineraries' && ++itinerarySubmissionCount === 1) {
        return {
          output: '返程时间尚未确认。', sources: [],
          feedback: [{ severity: 'warning', code: 'trip_time_unconfirmed', message: '返程时段待核验。' }]
        }
      }
      if (name === 'search_web') {
        return {
          output: '检索到开放时间资料。',
          sources: [createSource('故宫开放时间', 'https://museum.example/open', '测试来源', 'web', '开放信息待复核。')]
        }
      }
      return executeTool(name, rawArguments, context, signal)
    }
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as typeof requests[number]
      requests.push(request)
      const index = requests.length
      const call = index === 1 ? { name: 'propose_itineraries', arguments: plan }
        : index === 2 ? { name: 'search_web', arguments: { query: '故宫开放时间' } }
          : index === 3 ? { name: 'propose_itineraries', arguments: plan }
            : undefined
      return new Response(JSON.stringify({ choices: [{ message: call
        ? { role: 'assistant', tool_calls: [{
            id: `call-warning-choice-${index}`, type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) }
          }] }
        : { role: 'assistant', content: '计划已整理完成。' }
      }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const vault = { get: async (name: string) => name === 'modelKey' ? 'fixture-model-key' : null } as unknown as SecretVault

    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id,
      '请规划北京一日游，并核对故宫开放时间。',
      'warning-choice-loop', new AbortController().signal, () => undefined
    )

    expect(requests).toHaveLength(4)
    expect(requests[1]?.tool_choice).toBe('required')
    expect(requests[1]?.tools?.length).toBeGreaterThan(1)
    expect(requests[1]?.tools?.some((tool) => tool.function?.name === 'search_web')).toBe(true)
    expect(requests[3]?.tool_choice).toBe('auto')
    expect(itinerarySubmissionCount).toBe(2)
  })

  it('把兼容网关的 null 工具调用视为空结果并继续请求结构化草案', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({ destination: '北京', interests: '故宫', startDate: '2026-11-03', endDate: '2026-11-03' })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    await store.saveSources(trip.id, [createSource(
      '故宫参观信息', 'https://museum.example/visit', '测试来源', 'web', '故宫参观信息摘要。'
    )])
    const settings = store.snapshot().settings
    await store.updateSettings({
      ...settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
      connectors: { ...settings.connectors, webSearch: false }
    })

    let requestCount = 0
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: {
          role: 'assistant', content: '资料整理完成。', tool_calls: null
        } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const request = JSON.parse(String(init?.body)) as { tools?: Array<{ function?: { name?: string } }> }
      const proposalTool = request.tools?.find((tool) => tool.function?.name === 'propose_itineraries')
      if (!proposalTool) throw new Error('itinerary_tool_not_offered')
      if (requestCount === 3) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '计划已整理完成。' } }] }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
        id: 'call_initial_draft', type: 'function',
        function: { name: 'propose_itineraries', arguments: JSON.stringify({ plans: [{
          title: '北京一日', summary: '参观故宫。', tradeoffs: '',
          days: [{ day_number: 1, date: '2026-11-03', title: '故宫', stops: [{
            name: '故宫博物院', area: '东城区', time: '09:00–12:00', duration_minutes: 180,
            category: '景点', notes: '', transit_to_next: '', evidence_level: 'pending', source_ids: []
          }] }]
        }] }) }
      }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const vault = { get: async (name: string) => name === 'modelKey' ? 'fixture-model-key' : null } as unknown as SecretVault
    await new TravelAgent().run(
      store, vault, trip.id, '请规划北京一日游，安排故宫。',
      'null-tool-calls', new AbortController().signal, () => undefined
    )

    const assistant = store.snapshot().trips.find((item) => item.id === trip.id)?.messages
      .find((message) => message.role === 'assistant')
    expect(requestCount).toBe(3)
    expect(assistant?.itineraryOptions).toHaveLength(1)
  })

  it('执行模型显式发起的工具批次并共享搜索服务状态', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({
      destination: '北京', interests: '故宫', startDate: '2026-11-03', endDate: '2026-11-03'
    })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    const settings = store.snapshot().settings
    await store.updateSettings({
      ...settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
      connectors: { ...settings.connectors, webSearch: true }
    })

    let activeSearches = 0
    let peakSearches = 0
    let searchCallCount = 0
    let modelRequestCount = 0
    const breakerReferences = new Set<object>()
    const disabledStates: string[][] = []
    const toolExecutor: typeof executeTool = async (name, _rawArguments, context) => {
      if (name !== 'search_web') return executeTool(name, _rawArguments, context)
      const breaker = context.searchProviderCircuitBreaker
      if (!breaker) throw new Error('missing_search_provider_circuit_breaker')
      breakerReferences.add(breaker)
      const callIndex = searchCallCount++
      if (callIndex === 0) breaker.disabled.add('Tavily')
      disabledStates.push([...breaker.disabled])
      activeSearches += 1
      peakSearches = Math.max(peakSearches, activeSearches)
      await new Promise((resolve) => setTimeout(resolve, 5))
      activeSearches -= 1
      return {
        output: '搜索已完成，详情以原始来源为准。',
        sources: [createSource(
          `北京资料 ${callIndex + 1}`,
          `https://search.example/result-${callIndex + 1}`,
          'Exa 搜索结果', 'web', '官方信息摘要。'
        )]
      }
    }

    const plan = { plan: {
      title: '北京人文一日游', summary: '围绕故宫安排一日游。', tradeoffs: '现场按客流调整。',
      days: [{ day_number: 1, date: '2026-11-03', title: '故宫人文', stops: [{
        name: '故宫博物院', area: '东城区', time: '09:00–12:00', duration_minutes: 180,
        category: '景点', notes: '', transit_to_next: '', evidence_level: 'pending', source_ids: []
      }] }]
    } }
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      modelRequestCount += 1
      if (modelRequestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: Array.from({ length: 5 }, (_, index) => ({
          id: `search-${index + 1}`, type: 'function',
          function: { name: 'search_web', arguments: JSON.stringify({ query: `北京故宫资料 ${index + 1}` }) }
        })) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (modelRequestCount === 2) {
        const request = JSON.parse(String(init?.body)) as { tools?: Array<{ function?: { name?: string } }> }
        if (!request.tools?.some((tool) => tool.function?.name === 'propose_itineraries')) {
          throw new Error('itinerary_tool_not_offered')
        }
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
          id: 'call_initial_draft', type: 'function',
          function: { name: 'propose_itineraries', arguments: JSON.stringify(plan) }
        }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '计划已完成。' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    })

    const vault = {
      get: async (name: string) => name === 'modelKey' ? 'fixture-model-key'
        : name === 'exaKey' ? 'fixture-exa-key'
          : name === 'tavilyKey' ? 'fixture-tavily-key' : null
    } as unknown as SecretVault
    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id,
      '请规划北京一日游，安排故宫并查询相关资料。',
      'model-selected-tool-batch', new AbortController().signal, () => undefined
    )

    const assistant = store.snapshot().trips.find((item) => item.id === trip.id)?.messages
      .find((message) => message.role === 'assistant')
    expect(modelRequestCount).toBe(3)
    expect(searchCallCount).toBe(5)
    expect(peakSearches).toBeLessThanOrEqual(4)
    expect(breakerReferences).toHaveProperty('size', 1)
    expect(disabledStates.slice(1).every((state) => state.includes('Tavily'))).toBe(true)
    expect(assistant?.itineraryOptions).toHaveLength(1)
  })

})
