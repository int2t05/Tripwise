/** 验证具名餐馆缺少直接来源时会定向补查并绑定可用来源。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TravelAgent } from '../src/main/agent.js'
import { createSource } from '../src/main/connectors/types.js'
import { mealAreaRequestAlreadySatisfied } from '../src/main/agent-tool-policy.js'
import { executeTool } from '../src/main/tools.js'
import { TripStore } from '../src/main/persistence.js'
import type { SecretVault } from '../src/main/secrets.js'
import type { ItineraryOption } from '../src/shared/types.js'

const temporaryDirectories: string[] = []

/** 创建隔离旅行资料，避免联测接触用户数据。 */
async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'tripwise-meal-evidence-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Agent 餐馆来源补查', () => {
  it('用餐馆候选名称发起定向搜索，并把直接提名来源绑定回停靠点', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({ destination: '北京', interests: '故宫、前门', startDate: '2026-11-03', endDate: '2026-11-03' })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    await store.updateSettings({
      ...store.snapshot().settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
      connectors: { ...store.snapshot().settings.connectors, webSearch: true }
    })

    const searchQueries: string[] = []
    const restaurantSource = createSource(
      '海碗居牡丹园店游客记录', 'https://guide.example/ha-wan-ju', 'Exa 搜索结果', 'web',
      '海碗居（牡丹园店）午餐体验，门店与营业情况仍需确认。'
    )
    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      if (name !== 'search_web') return executeTool(name, rawArguments, context, signal)
      const query = (JSON.parse(rawArguments) as { query: string }).query
      searchQueries.push(query)
      const targeted = query.includes('海碗居')
      return {
        output: '搜索结果摘要仅用于发现来源。',
        sources: [targeted ? restaurantSource : createSource(
          '北京餐饮搜索结果', 'https://guide.example/beijing-food', 'Exa 搜索结果', 'web', '北京餐饮候选，门店信息需确认。'
        )]
      }
    }

    let modelRequestCount = 0
    const capturedRequests: Array<{
      messages?: Array<{ role?: string; content?: string | null }>
      tools?: Array<{ function?: { name?: string } }>
    }> = []
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      modelRequestCount += 1
      const request = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string | null }>
        tools?: Array<{ function?: { name?: string } }>
      }
      capturedRequests.push(request)
      if (modelRequestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
          id: 'call_beijing_draft', type: 'function',
          function: { name: 'propose_itineraries', arguments: JSON.stringify({ plan: {
            title: '北京一日游', summary: '按前门片区安排。', tradeoffs: '',
            days: [{ day_number: 1, date: '2026-11-03', title: '故宫与前门', stops: [
              { name: '故宫博物院', area: '东城区', time: '09:00–12:00', duration_minutes: 180,
                category: '景点', notes: '', transit_to_next: '', evidence_level: 'pending', source_ids: [] },
              { name: '海碗居（牡丹园店）', area: '前门', time: '12:30–13:30 午餐', duration_minutes: 60,
                category: '餐饮', notes: '', transit_to_next: '', evidence_level: 'pending', source_ids: [] }
            ] }]
          } }) }
        }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (modelRequestCount === 2) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
          id: 'call_search_ha_wan_ju', type: 'function',
          function: { name: 'search_web', arguments: JSON.stringify({ query: '海碗居牡丹园店 营业时间 游客评价' }) }
        }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (modelRequestCount === 3) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
          id: 'call_bind_meal_source', type: 'function',
          function: { name: 'propose_itinerary_meals', arguments: JSON.stringify({ updates: [{
            plan_number: 1, day_number: 1, date: '2026-11-03', meal_slot: 'lunch',
            restaurant_name: '海碗居（牡丹园店）', evidence_level: 'sourced', source_ids: [restaurantSource.id]
          }] }) }
        }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '餐馆来源已核对，计划可继续审阅。' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    })

    const vault = {
      get: async (name: string) => name === 'modelKey' ? 'fixture-model-key'
        : name === 'exaKey' ? 'fixture-exa-key' : null
    } as unknown as SecretVault
    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id, '请安排北京一日游，2026年11月3日午餐要有具体餐馆店面。',
      'meal-source-verification', new AbortController().signal, () => undefined
    )

    const completedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const drafts = completedTrip?.messages.flatMap((message) => message.itineraryOptions ?? []) ?? []
    const lunch = drafts.at(-1)?.days[0]?.stops.find((stop) => stop.category === '餐饮')

    expect(searchQueries.some((query) => query.includes('海碗居'))).toBe(true)
    expect(searchQueries.filter((query) => query.includes('海碗居'))).toHaveLength(1)
    expect(modelRequestCount).toBe(4)
    expect(capturedRequests[0]?.tools?.some((tool) => tool.function?.name === 'propose_itineraries')).toBe(true)
    expect(capturedRequests[1]?.tools?.some((tool) => tool.function?.name === 'search_web')).toBe(true)
    expect(capturedRequests[2]?.tools?.some((tool) => tool.function?.name === 'propose_itinerary_meals')).toBe(true)
    expect(JSON.stringify(capturedRequests[2]?.messages)).toContain(restaurantSource.id)
    expect(lunch).toMatchObject({ name: '海碗居（牡丹园店）', evidenceLevel: 'sourced' })
    expect(lunch?.sourceIds).toHaveLength(1)
    expect(completedTrip?.sources.some((source) => lunch?.sourceIds?.includes(source.id))).toBe(true)
  })

  it('一次餐次修订未覆盖全部目标时会继续修订剩余餐次', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({ destination: '北京', startDate: '2026-11-03', endDate: '2026-11-03' })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    await store.saveSources(trip.id, [createSource(
      '北京故宫官方参观信息', 'https://example.org/palace', '测试来源', 'web', '故宫参观信息占位测试来源。'
    )])
    await store.updateSettings({
      ...store.snapshot().settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
      connectors: { ...store.snapshot().settings.connectors, webSearch: false }
    })

    let modelRequestCount = 0
    const requestedTools: string[][] = []
    let initialProposalFeedback: Array<{ code?: string; message?: string }> = []
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      modelRequestCount += 1
      const request = JSON.parse(String(init?.body)) as {
        tools?: Array<{ function?: { name?: string } }>
        messages?: Array<{ role?: string; content?: string | null }>
      }
      requestedTools.push((request.tools ?? []).map((tool) => tool.function?.name ?? ''))
      if (modelRequestCount === 2) {
        const receipt = request.messages?.find((message) => message.role === 'tool')
        const result = JSON.parse(receipt?.content ?? '{}') as { feedback?: Array<{ code?: string; message?: string }> }
        initialProposalFeedback = result.feedback ?? []
      }
      if (modelRequestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
          id: 'call_two_meal_draft', type: 'function',
          function: { name: 'propose_itineraries', arguments: JSON.stringify({ plan: {
            title: '北京一日游', summary: '按时间安排故宫和两餐。', tradeoffs: '',
            days: [{ day_number: 1, date: '2026-11-03', title: '故宫', stops: [
              { name: '故宫博物院', area: '东城区', time: '09:00–12:00', duration_minutes: 180,
                category: '景点', notes: '', transit_to_next: '', evidence_level: 'pending', source_ids: [] },
              { name: '附近餐馆（具体店面待选）', area: '故宫附近', time: '12:00–13:00 午餐', duration_minutes: 60,
                category: '餐饮', notes: '', transit_to_next: '', evidence_level: 'pending', source_ids: [] },
              { name: '附近餐馆（具体店面待选）', area: '前门', time: '18:00–19:00 晚餐', duration_minutes: 60,
                category: '餐饮', notes: '', transit_to_next: '', evidence_level: 'pending', source_ids: [] }
            ], schedule_blocks: [] }]
          } }) }
        }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }

      if (modelRequestCount > 3 || !request.tools?.some((tool) => tool.function?.name === 'propose_itinerary_meals')) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '行程已完成。' } }] }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      const mealUpdate = modelRequestCount === 2
        ? { meal_slot: 'lunch', restaurant_name: '海碗居' }
        : { meal_slot: 'dinner', restaurant_name: '局气' }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
        id: `call_meal_repair_${modelRequestCount}`, type: 'function',
        function: { name: 'propose_itinerary_meals', arguments: JSON.stringify({ updates: [{
          plan_number: 1, day_number: 1, date: '2026-11-03',
          ...mealUpdate, evidence_level: 'pending'
        }] }) }
      }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const vault = { get: async (name: string) => name === 'modelKey' ? 'fixture-model-key' : null } as unknown as SecretVault
    await new TravelAgent().run(
      store, vault, trip.id,
      '请安排北京一日游，2026年11月3日午餐和晚餐各安排一家具体餐馆店面。',
      'meal-repair-all-targets', new AbortController().signal, () => undefined
    )

    const completedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const draft = completedTrip?.messages.flatMap((message) => message.itineraryOptions ?? []).at(-1)
    const meals = draft?.days[0]?.stops.filter((stop) => stop.category === '餐饮') ?? []

    expect(modelRequestCount).toBe(4)
    expect(requestedTools.map((tools) => tools.includes('propose_itinerary_meals'))).toEqual([false, true, true, true])
    expect(initialProposalFeedback).toContainEqual(expect.objectContaining({
      code: 'requested_named_meals_missing',
      message: expect.stringContaining('2 个明确要求的餐次仍缺具体店名')
    }))
    expect(initialProposalFeedback[0]?.code).toBe('requested_named_meals_missing')
    expect(meals.map((stop) => stop.name)).toEqual(['海碗居', '局气'])
  })

  it('局部修订只反馈目标日期缺少的店名', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({ destination: '北京', startDate: '2026-09-23', endDate: '2026-09-24' })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    await store.updateSettings({
      ...store.snapshot().settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
      connectors: { ...store.snapshot().settings.connectors, webSearch: false }
    })

    /** 为回归场景生成待选择门店的晚餐地点。 */
    const placeholderDinner = (date: string) => ({
      id: `dinner-${date}`, name: '附近餐馆（具体店面待选）', area: '北京',
      time: '18:00–19:00 晚餐', durationMinutes: 60, category: '餐饮', notes: '',
      transitToNext: '', evidenceLevel: 'pending' as const, sourceIds: [],
      factClaims: []
    })
    const baseline: ItineraryOption = {
      id: 'two-day-meal-plan', title: '北京两日计划', summary: '按日期分区。', tradeoffs: '',
      days: ['2026-09-23', '2026-09-24'].map((date, index) => ({
        id: `day-${date}`, dayNumber: index + 1, date, title: date,
        stops: [placeholderDinner(date)], scheduleBlocks: []
      }))
    }
    await store.appendMessage(trip.id, {
      id: 'named-meals-request', role: 'user', content: '9/23 和 9/24 晚餐都安排具体餐馆店面。',
      createdAt: '2026-10-24T00:00:00.000Z', sourceIds: []
    }, trip.activeConversationId)
    await store.appendMessage(trip.id, {
      id: 'named-meals-draft', role: 'assistant', content: '北京行程草案。',
      createdAt: '2026-10-25T00:00:00.000Z', sourceIds: [], itineraryOptions: [baseline]
    }, trip.activeConversationId)

    let proposalFeedback: Array<{ code?: string; message?: string }> = []
    let requestCount = 0
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestCount += 1
      const request = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string | null }>
      }
      if (requestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
          id: 'revise-target-dinner', type: 'function',
          function: { name: 'propose_itineraries', arguments: JSON.stringify({ plan: {
            title: '北京两日计划', summary: '只调整 9/24 晚餐时段。', tradeoffs: '',
            days: [
              { day_number: 1, date: '2026-09-23', title: '9/23', stops: [{
                name: '附近餐馆（具体店面待选）', area: '北京', time: '18:00–19:00 晚餐',
                duration_minutes: 60, category: '餐饮', notes: '', transit_to_next: '',
                evidence_level: 'pending', source_ids: []
              }] },
              { day_number: 2, date: '2026-09-24', title: '9/24', stops: [{
                name: '附近餐馆（具体店面待选）', area: '北京', time: '19:00–20:00 晚餐',
                duration_minutes: 60, category: '餐饮', notes: '', transit_to_next: '',
                evidence_level: 'pending', source_ids: []
              }] }
            ]
          } }) }
        }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }

      const receipt = request.messages?.find((message) => message.role === 'tool')
      const result = JSON.parse(receipt?.content ?? '{}') as { feedback?: Array<{ code?: string; message?: string }> }
      proposalFeedback = result.feedback ?? []
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '修订草案已提交。' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    })

    const vault = { get: async () => 'fixture-model-key' } as unknown as SecretVault
    await new TravelAgent().run(
      store, vault, trip.id, '只把 9/24 晚餐时段改为 19:00–20:00，其他日期保持不变。',
      'meal-feedback-date-scope', new AbortController().signal, () => undefined
    )

    const warning = proposalFeedback.find((item) => item.code === 'requested_named_meals_missing')
    expect(requestCount).toBe(2)
    expect(warning?.message).toContain('1 个明确要求的餐次仍缺具体店名')
    expect(warning?.message).toContain('2026-09-24')
    expect(warning?.message).not.toContain('2026-09-23')
  })

  it.each([
    {
      title: '区域已满足时保留原店名和证据状态',
      request: '第二轮修改：只把 9/24 晚餐改成前门一带的就近安排；若已有来源不能支持具体店名就保留待选。其他日期和餐次保持不变。',
      candidateName: '前门附近餐馆（具体店面待选）',
      alreadySatisfied: true,
      expectedName: '海碗居（前门店）',
      expectedReply: '当前草案已满足这项修改，行程未变。'
    },
    {
      title: '用户明确要求换店时接受模型的新候选',
      request: '第二轮修改：只把 9/24 晚餐换成另一家前门附近的餐馆，其他日期和餐次保持不变。',
      candidateName: '便宜坊（前门店）',
      alreadySatisfied: false,
      expectedName: '便宜坊（前门店）',
      expectedReply: '已将晚餐换为新的候选店面，来源仍待核验。'
    }
  ])('$title', async ({ request, candidateName, alreadySatisfied, expectedName, expectedReply }) => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({ destination: '北京', startDate: '2026-09-24', endDate: '2026-09-24' })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    await store.updateSettings({
      ...store.snapshot().settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
      connectors: { ...store.snapshot().settings.connectors, webSearch: true }
    })

    const draft: ItineraryOption = {
      id: 'draft-1', title: '北京计划', summary: '按地理片区安排。', tradeoffs: '',
      days: [{
        id: 'day-1', dayNumber: 1, date: '2026-09-24', title: '前门',
        stops: [{
          id: 'dinner', name: '海碗居（前门店）', area: '前门片区', time: '18:00–19:00 晚餐',
          durationMinutes: 60, category: '餐饮', notes: '店名来源待核验。', transitToNext: '', evidenceLevel: 'pending'
        }],
        scheduleBlocks: []
      }]
    }
    await store.appendMessage(trip.id, {
      id: 'initial-meal-request', role: 'user',
      content: '9/24 晚餐安排具体餐馆店面。',
      createdAt: '2026-10-24T00:00:00.000Z', sourceIds: []
    }, trip.activeConversationId)
    await store.appendMessage(trip.id, {
      id: 'draft-message', role: 'assistant', content: '北京行程草案。',
      createdAt: '2026-10-25T00:00:00.000Z', sourceIds: [], itineraryOptions: [draft]
    }, trip.activeConversationId)
    expect(mealAreaRequestAlreadySatisfied(request, draft)).toBe(alreadySatisfied)

    let modelRequestCount = 0
    const fetchSpy = vi.fn(async () => {
      modelRequestCount += 1
      const message = modelRequestCount === 1
        ? { role: 'assistant', tool_calls: [{
            id: 'call_keep_existing_meal_plan', type: 'function',
            function: { name: 'propose_itineraries', arguments: JSON.stringify({ plan: {
              title: '北京计划', summary: '安排前门晚餐。', tradeoffs: '',
              days: [{ day_number: 1, date: '2026-09-24', title: '前门', stops: [{
                name: candidateName, area: '前门片区', time: '18:00–19:00 晚餐',
                duration_minutes: 60, category: '餐饮', notes: '具体店面待选。', transit_to_next: '',
                evidence_level: 'pending', source_ids: []
              }] }]
            } }) }
          }] }
        : { role: 'assistant', content: expectedReply }
      return new Response(JSON.stringify({ choices: [{ message }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    })
    vi.stubGlobal('fetch', fetchSpy)
    const vault = { get: async () => 'fixture-model-key' } as unknown as SecretVault
    await new TravelAgent().run(
      store, vault, trip.id,
      request,
      'meal-area-already-satisfied', new AbortController().signal, () => undefined
    )

    const completedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const updatedDraft = completedTrip?.messages.flatMap((message) => message.itineraryOptions ?? []).at(-1)
    const dinner = updatedDraft?.days[0]?.stops[0]
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(completedTrip?.messages.at(-1)?.content).toBe(expectedReply)
    expect(dinner).toMatchObject({ name: expectedName, evidenceLevel: 'pending', area: '前门片区' })
  })
})
