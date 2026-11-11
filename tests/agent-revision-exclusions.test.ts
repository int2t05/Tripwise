/** 验证明确删点编辑与模型驱动的修订回合。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ItineraryOption } from '../src/shared/types.js'
import { TravelAgent } from '../src/main/agent.js'
import { TripStore } from '../src/main/persistence.js'
import type { SecretVault } from '../src/main/secrets.js'
import { executeTool } from '../src/main/tools.js'

const temporaryDirectories: string[] = []

/** 为 Agent 回归创建隔离资料目录。 */
async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'tripwise-revision-exclusions-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Agent 行程修订约束', () => {
  it('模型漏删地点时按明确指令删除，并保留正确的修订计划', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({
      destination: '北京', interests: '颐和园、香山、碧云寺',
      startDate: '2026-09-23', endDate: '2026-09-23',
      constraints: '9/23 游览颐和园、香山和碧云寺。'
    })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    await store.updateSettings({
      ...store.snapshot().settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' }
    })

    const baseline: ItineraryOption = {
      id: 'baseline-plan', title: '北京赏秋', summary: '颐和园和香山。', tradeoffs: '',
      days: [{
        id: 'baseline-day', dayNumber: 1, date: '2026-09-23', title: '皇家园林', scheduleBlocks: [],
        stops: ['颐和园', '香山公园', '碧云寺'].map((name, index) => ({
          id: `baseline-stop-${index}`, name, area: '北京', time: `${9 + index}:00—10:00`,
          durationMinutes: 60, category: '景点', notes: '', transitToNext: ''
        }))
      }]
    }
    await store.appendMessage(trip.id, {
      id: 'baseline-message', role: 'assistant', content: '初始草案',
      createdAt: new Date().toISOString(), sourceIds: [], itineraryOptions: [baseline]
    })

    const makePlan = (stops: string[]) => ({
      plan: {
        title: '颐和园轻松游', summary: '只保留颐和园。', tradeoffs: '',
        days: [{
          day_number: 1, date: '2026-09-23', title: '颐和园',
          stops: stops.map((name, index) => ({
            name, area: '北京', time: `${9 + index}:00–${10 + index}:00`, duration_minutes: 60,
            category: '景点', notes: '', transit_to_next: '', evidence_level: 'pending', source_ids: []
          }))
        }]
      }
    })
    const requests: Array<{
      messages?: Array<{ role?: string; content?: string | null }>
      tools?: Array<{ function?: { name?: string; description?: string } }>
    }> = []
    let requestIndex = 0
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string; content?: string | null }>
        tools?: Array<{ function?: { name?: string; description?: string } }>
      }
      requests.push(body)
      const response = requestIndex === 0
        ? { role: 'assistant', tool_calls: [{
            id: 'call_invalid_exclusion', type: 'function',
            function: { name: 'propose_itineraries', arguments: JSON.stringify(makePlan(['颐和园', '香山赏秋线路', '碧云寺参观'])) }
          }] }
        : requestIndex === 1
          ? { role: 'assistant', tool_calls: [{
              id: 'call_corrected_exclusion', type: 'function',
              function: { name: 'propose_itineraries', arguments: JSON.stringify(makePlan(['颐和园'])) }
            }] }
          : { role: 'assistant', content: '修订草案已整理。' }
      requestIndex += 1
      return new Response(JSON.stringify({ choices: [{ message: response }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    })

    const vault = { get: async (name: string) => name === 'modelKey' ? 'fixture-model-key' : null } as unknown as SecretVault
    await new TravelAgent().run(
      store, vault, trip.id,
      '只把 9/23 调轻松，删除香山和碧云寺，保留颐和园主线；这次先不要使用任何外部检索。',
      'revision-exclusion-regression', new AbortController().signal, () => undefined
    )

    const revisedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const latestDraft = revisedTrip?.messages.filter((message) =>
      message.role === 'assistant' && message.itineraryOptions?.length
    ).at(-1)
    const stops = latestDraft?.itineraryOptions?.[0]?.days[0]?.stops.map((stop) => stop.name)
    const toolFeedback = requests[1]?.messages?.filter((message) => message.role === 'tool')
      .map((message) => message.content ?? '').join('\n') ?? ''
    const proposalDescription = requests.flatMap((request) => request.tools ?? []).find((tool) =>
      tool.function?.name === 'propose_itineraries'
    )?.function?.description ?? ''

    expect(toolFeedback).not.toContain('本轮明确删除项未生效')
    expect(stops).toEqual(['颐和园'])
    expect(proposalDescription).toContain('error、warning 或 info')
    expect(proposalDescription).not.toContain('用户按日期指定的游览点必须保留：2026-09-23：颐和园、香山、碧云寺')
  })

  it('草案看似满足餐次片区修改时仍由模型提交计划并决定结束', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({ destination: '北京', startDate: '2026-09-24', endDate: '2026-09-24' })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    await store.updateSettings({
      ...store.snapshot().settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' }
    })
    const baseline: ItineraryOption = {
      id: 'baseline-plan', title: '北京行程', summary: '前门片区晚餐。', tradeoffs: '',
      days: [{
        id: 'day-1', dayNumber: 1, date: '2026-09-24', title: '前门', scheduleBlocks: [],
        stops: [{
          id: 'dinner', name: '晚餐待选', area: '前门片区', time: '18:00',
          durationMinutes: 60, category: '餐饮', notes: '', transitToNext: ''
        }]
      }]
    }
    await store.appendMessage(trip.id, {
      id: 'baseline-message', role: 'assistant', content: '当前草案。',
      createdAt: new Date().toISOString(), sourceIds: [], itineraryOptions: [baseline]
    })

    let modelRequestCount = 0
    const fetchMock = vi.fn(async () => {
      modelRequestCount += 1
      const message = modelRequestCount === 1
        ? { role: 'assistant', tool_calls: [{
            id: 'call_noop_revision_plan', type: 'function',
            function: { name: 'propose_itineraries', arguments: JSON.stringify({ plan: {
              title: '北京行程', summary: '晚餐安排在前门片区。', tradeoffs: '',
              days: [{ day_number: 1, date: '2026-09-24', title: '前门', stops: [{
                name: '前门一带的就近安排', area: '前门片区', time: '18:00–19:00 晚餐',
                duration_minutes: 60, category: '餐饮'
              }] }]
            } }) }
          }] }
        : { role: 'assistant', content: '已提交一份修订草案供你审阅。' }
      return new Response(JSON.stringify({ choices: [{ message }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    let toolCalls = 0
    const vault = {
      get: async (name: string) => name === 'modelKey' ? 'fixture-model-key' : null,
      getMcpEnvironment: async () => ({})
    } as unknown as SecretVault
    const events: Array<{ type: string; message: string }> = []

    await new TravelAgent(async (name, rawArguments, context, signal) => {
      if (name === 'propose_itineraries') {
        return executeTool(name, rawArguments, context, signal)
      }
      toolCalls += 1
      return { output: '本轮未查询外部资料。', sources: [] }
    }).run(
      store, vault, trip.id,
      '第二轮修改：以刚才最新的修订为基线。只把 9/24 晚餐改成前门一带的就近安排。其他日期、刚调整的9/23、每天餐次范围和抵离时刻都保持不变。请返回一份完整修订草案，不并列方案。',
      'satisfied-meal-area-noop', new AbortController().signal,
      (event) => events.push({ type: event.type, message: event.message })
    )

    const updatedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const finalAssistant = updatedTrip?.messages.filter((message) => message.role === 'assistant').at(-1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(toolCalls).toBe(0)
    expect(events.at(-1)?.type).toBe('complete')
    expect(finalAssistant?.content).toBe('已提交一份修订草案供你审阅。')
    expect(finalAssistant?.itineraryOptions).toHaveLength(1)
    expect(updatedTrip?.messages.filter((message) => message.role === 'assistant' && message.itineraryOptions?.length))
      .toHaveLength(2)
    expect(updatedTrip?.revisions).toHaveLength(0)
  })

  it('具名店面缺少直接来源时，不按已满足片区跳过来源核验', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({
      destination: '北京', startDate: '2026-09-24', endDate: '2026-09-24',
      constraints: '9/24 晚餐需要具体店名。'
    })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    await store.updateSettings({
      ...store.snapshot().settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
      connectors: { ...store.snapshot().settings.connectors, webSearch: true }
    })

    const baseline: ItineraryOption = {
      id: 'baseline-plan', title: '北京行程', summary: '前门片区晚餐。', tradeoffs: '',
      days: [{
        id: 'day-1', dayNumber: 1, date: '2026-09-24', title: '前门', scheduleBlocks: [],
        stops: [{
          id: 'dinner', name: '同和居（前门店）', area: '前门片区', time: '18:00–19:00 晚餐',
          durationMinutes: 60, category: '餐饮', notes: '来源待核验。', transitToNext: '', sourceIds: []
        }]
      }]
    }
    await store.appendMessage(trip.id, {
      id: 'baseline-message', role: 'assistant', content: '当前草案。',
      createdAt: new Date().toISOString(), sourceIds: [], itineraryOptions: [baseline]
    })

    const proposal = {
      plan: {
        title: '北京行程', summary: '晚餐保留在前门。', tradeoffs: '店名来源待核验。',
        days: [{
          day_number: 1, date: '2026-09-24', title: '前门', stops: [{
            name: '同和居（前门店）', area: '前门片区', time: '18:00–19:00 晚餐', duration_minutes: 60,
            category: '餐饮', notes: '来源待核验。', transit_to_next: '', evidence_level: 'pending', source_ids: []
          }]
        }]
      }
    }
    const requests: Array<{ tools?: Array<{ function?: { name?: string } }> }> = []
    let requestIndex = 0
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as { tools?: Array<{ function?: { name?: string } }> })
      const message = requestIndex === 0
        ? { role: 'assistant', tool_calls: [{
            id: 'call_pending_source_proposal', type: 'function',
            function: { name: 'propose_itineraries', arguments: JSON.stringify(proposal) }
          }] }
        : { role: 'assistant', content: '店名仍待核验，已保留候选。' }
      requestIndex += 1
      return new Response(JSON.stringify({ choices: [{ message }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    })

    const vault = {
      get: async (name: string) => name === 'modelKey' ? 'fixture-model-key' : null,
      getMcpEnvironment: async () => ({})
    } as unknown as SecretVault
    await new TravelAgent().run(
      store, vault, trip.id,
      '只把 9/24 晚餐改成前门一带的就近安排；其他日期保持不变。',
      'meal-area-source-gap-regression', new AbortController().signal, () => undefined
    )

    const updatedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const latestDraft = updatedTrip?.messages.filter((message) =>
      message.role === 'assistant' && message.itineraryOptions?.length
    ).at(-1)
    expect(requests.length).toBeGreaterThan(0)
    expect(requests[0]?.tools?.flatMap((tool) => tool.function?.name ?? [])).toContain('propose_itineraries')
    expect(latestDraft?.itineraryOptions?.[0]?.days[0]?.stops[0]).toMatchObject({
      name: '同和居（前门店）', evidenceLevel: 'pending', sourceIds: []
    })
  })

  it('餐次片区已满足但只有泛称时，不跳过具名餐馆要求', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({
      destination: '北京', startDate: '2026-09-24', endDate: '2026-09-24',
      constraints: '9/24 晚餐需要具体店名。'
    })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    await store.updateSettings({
      ...store.snapshot().settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
      connectors: { ...store.snapshot().settings.connectors, webSearch: false }
    })
    const baseline: ItineraryOption = {
      id: 'baseline-plan', title: '北京行程', summary: '前门片区晚餐。', tradeoffs: '',
      days: [{
        id: 'day-1', dayNumber: 1, date: '2026-09-24', title: '前门', scheduleBlocks: [],
        stops: [{
          id: 'dinner', name: '前门一带的就近安排', area: '前门片区', time: '18:00–19:00 晚餐',
          durationMinutes: 60, category: '餐饮', notes: '', transitToNext: ''
        }]
      }]
    }
    await store.appendMessage(trip.id, {
      id: 'baseline-message', role: 'assistant', content: '当前草案。',
      createdAt: new Date().toISOString(), sourceIds: [], itineraryOptions: [baseline]
    })

    let modelRequestCount = 0
    const fetchMock = vi.fn(async () => {
      modelRequestCount += 1
      const message = modelRequestCount === 1
        ? { role: 'assistant', tool_calls: [{
            id: 'call_named_meal_revision', type: 'function',
            function: { name: 'propose_itineraries', arguments: JSON.stringify({ plan: {
              title: '北京行程', summary: '晚餐安排在前门。', tradeoffs: '门店仍待来源核验。',
              days: [{ day_number: 1, date: '2026-09-24', title: '前门', stops: [{
                name: '同和居（前门店）', area: '前门片区', time: '18:00–19:00 晚餐',
                duration_minutes: 60, category: '餐饮', notes: '门店和营业状态待来源核验。',
                transit_to_next: '', evidence_level: 'pending', source_ids: []
              }] }]
            } }) }
          }] }
        : { role: 'assistant', content: '已保留待核验的晚餐候选。' }
      return new Response(JSON.stringify({ choices: [{ message }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const vault = {
      get: async (name: string) => name === 'modelKey' ? 'fixture-model-key' : null,
      getMcpEnvironment: async () => ({})
    } as unknown as SecretVault

    await new TravelAgent().run(
      store, vault, trip.id,
      '只把 9/24 晚餐改成前门一带的就近安排；若已有来源不能支持具体店名就保留待选。本轮不调用搜索、天气或地图。',
      'named-meal-revision', new AbortController().signal, () => undefined
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const updatedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const finalAssistant = updatedTrip?.messages.filter((message) => message.role === 'assistant').at(-1)
    expect(finalAssistant?.content).not.toBe('当前草案已满足这项修改，行程未变。')
    expect(finalAssistant?.itineraryOptions?.[0]?.days[0]?.stops[0]?.name).toBe('同和居（前门店）')
  })
})
