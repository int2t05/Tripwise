/** 验证草案提交后会定向搜索并增量补充来源直证的景点事实。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TravelAgent } from '../src/main/agent.js'
import { factRepairBrowserSearchCapacity, planFactRepairBrowserSearches } from '../src/main/agent-fact-research.js'
import { factRepairSourceMap } from '../src/main/agent-context.js'
import { itineraryFactEvidenceFeedback, itineraryFactRepairTargets } from '../src/main/connectors/itinerary.js'
import { createSource } from '../src/main/connectors/types.js'
import { executeTool } from '../src/main/tools.js'
import { TripStore } from '../src/main/persistence.js'
import { MAX_ITINERARY_FACT_QUOTE_CHARACTERS } from '../src/shared/itinerary-facts.js'
import type { ItineraryOption } from '../src/shared/types.js'
import type { ResearchBrowserToolController } from '../src/main/connectors/types.js'
import type { SecretVault } from '../src/main/secrets.js'

const temporaryDirectories: string[] = []

/** 从模型收到的逐地点原文映射读取编号，避免测试与候选编号生成顺序耦合。 */
function quoteIdFromFactContext(
  messages: Array<{ content?: string | null }> | undefined,
  type: string
): string {
  const content = messages?.find((message) => message.content?.startsWith('以下 JSON 只列出本轮事实补证目标'))?.content
  if (!content) throw new Error('事实补证上下文缺失。')
  const context = JSON.parse(content.slice(content.indexOf('\n') + 1)) as {
    targets: Array<{ fact_quotes: Array<{ type: string; candidates: Array<{ quote_id: string }> }> }>
  }
  const candidate = context.targets.flatMap((target) => target.fact_quotes)
    .find((quote) => quote.type === type)?.candidates[0]
  if (!candidate) throw new Error(`缺少 ${type} 原文候选。`)
  return candidate.quote_id
}

describe('景点事实补查查询规划', () => {
  it('使用剩余搜索和正文额度覆盖更多未核验地点', () => {
    expect(factRepairBrowserSearchCapacity(12, 9, 8)).toBe(8)
    expect(factRepairBrowserSearchCapacity(12, 5, 10)).toBe(5)
    expect(factRepairBrowserSearchCapacity(4, 9, 8)).toBe(4)
    expect(factRepairBrowserSearchCapacity(12, 0, 8)).toBe(0)
  })

  it('前序搜索耗尽普通预算时仍使用事实补证专用预留', () => {
    expect(factRepairBrowserSearchCapacity(8, 0, 0, 6)).toBe(6)
    expect(factRepairBrowserSearchCapacity(3, 2, 0, 6)).toBe(3)
    expect(factRepairBrowserSearchCapacity(8, 0, 8, 0)).toBe(0)
  })

  it('同一地点合并所有待补事实类别后再定向搜索', () => {
    const targets = [
      { stop_name: '故宫博物院', missing_facts: ['opening-hours'], source_ids: [] },
      { stop_name: '故宫博物院', missing_facts: ['booking'], source_ids: [] },
      { stop_name: '颐和园', missing_facts: ['booking', 'ticket-price'], source_ids: ['page-summer-palace'] }
    ]

    const result = planFactRepairBrowserSearches(targets, '北京', 6)

    expect(result.missingPlaceCount).toBe(1)
    expect(result.searches).toEqual([{
      target: { ...targets[0], missing_facts: ['opening-hours', 'booking'] },
      query: '北京 故宫博物院 官方 开放时间 预约'
    }])
  })

  it('预算不足时从整份行程均匀抽取地点，并遵守预算上限', () => {
    const targets = Array.from({ length: 9 }, (_, index) => ({
      stop_name: `景点${index + 1}`, missing_facts: ['opening-hours'], source_ids: [] as string[]
    }))

    const result = planFactRepairBrowserSearches(targets, '北京', 3)

    expect(result.missingPlaceCount).toBe(9)
    expect(result.searches.map(({ target }) => target.stop_name)).toEqual(['景点1', '景点5', '景点9'])
    expect(planFactRepairBrowserSearches(targets, '北京', 0).searches).toEqual([])
  })

  it('预算不足时先覆盖用户明确点名的景点', () => {
    const targets = [
      { stop_name: '故宫', missing_facts: ['opening-hours'], source_ids: [], preferred: true },
      { stop_name: '颐和园', missing_facts: ['opening-hours'], source_ids: [], preferred: true },
      ...Array.from({ length: 6 }, (_, index) => ({
        stop_name: `其他景点${index + 1}`, missing_facts: ['opening-hours'], source_ids: []
      }))
    ]

    const result = planFactRepairBrowserSearches(targets, '北京', 2)

    expect(result.searches.map(({ target }) => target.stop_name)).toEqual(['故宫', '颐和园'])
  })

  it('从用户兴趣提取优先事实核验地点', () => {
    const option = {
      id: 'plan', title: '北京行程', summary: '', tradeoffs: '',
      days: [{
        id: 'day', dayNumber: 1, date: '2026-09-22', title: '海淀', scheduleBlocks: [],
        stops: ['清华大学', '故宫'].map((name) => ({
          id: name, name, area: '北京', time: '09:00–10:00', durationMinutes: 60,
          category: '景点', notes: '', transitToNext: '', evidenceLevel: 'pending' as const, sourceIds: [], factClaims: []
        }))
      }]
    } satisfies ItineraryOption

    const targets = itineraryFactRepairTargets([option], { openingHours: true, booking: true }, [], ['清华大学'])

    expect(targets[0]?.stop_name).toBe('清华大学')
    expect(targets[0]).toHaveProperty('preferred', true)
  })
})

describe('景点事实原文候选', () => {
  it('长逗号句中的动态事实拆成可引用短原文', () => {
    const source = createSource(
      '故宫博物院参观须知', 'https://palace.example/visit', 'Firecrawl 网页正文', 'web', ''
    )
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = [
      '故宫博物院旺季开放时间为08:30至17:00，故宫博物院实行实名预约且需提前7天预约，成人门票为60元，',
      '其他参观说明，'.repeat(24)
    ].join('')

    const result = factRepairSourceMap([source], [{
      plan_number: 1, day_number: 1, date: '2026-11-03', stop_name: '故宫博物院', area: '东城区',
      missing_facts: ['opening-hours', 'booking', 'ticket-price']
    }], '请核对故宫博物院开放时间、预约和票价。')
    const target = result.targets[0]

    expect(result.uncoveredTargets).toEqual([])
    expect(target?.fact_quotes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'opening-hours', candidates: expect.arrayContaining([expect.objectContaining({ value: '故宫博物院旺季开放时间为08:30至17:00' })]) }),
      expect.objectContaining({ type: 'booking', candidates: expect.arrayContaining([expect.objectContaining({ value: '故宫博物院实行实名预约且需提前7天预约' })]) }),
      expect.objectContaining({ type: 'ticket-price', candidates: expect.arrayContaining([expect.objectContaining({ value: '成人门票为60元' })]) })
    ]))
    expect(target?.fact_quotes?.flatMap(({ candidates }) => candidates.map(({ value }) => value)).every((value) =>
      value.length <= MAX_ITINERARY_FACT_QUOTE_CHARACTERS
    )).toBe(true)
  })
})

/** 为 Agent 联测创建隔离的旅行数据目录。 */
async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'tripwise-fact-repair-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Agent 景点事实补证', () => {
  it('超长事实摘录会省略该证据并保留行程草案', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({ destination: '北京', interests: '故宫', startDate: '2026-11-03', endDate: '2026-11-03' })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    const source = createSource(
      '故宫博物院参观须知', 'https://palace.example/visit', 'Exa 网页正文', 'web',
      '故宫博物院每日开放时间为08:30至17:00；参观故宫博物院需提前预约。'
    )
    source.id = 'source-palace-official'
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = source.summary
    const result = await executeTool('propose_itineraries', JSON.stringify({
      plan: {
        title: '北京人文一日游', summary: '按海淀片区安排。', tradeoffs: '',
        days: [{ day_number: 1, date: '2026-11-03', title: '故宫', stops: [{
          name: '故宫博物院', area: '东城区', time: '09:00–12:00', duration_minutes: 180,
          category: '景点', notes: '', transit_to_next: '', evidence_level: 'pending', source_ids: [],
          fact_claims: [{
            type: 'opening-hours', value: '故宫开放安排'.repeat(30), scope: '2026-11-03',
            evidence_level: 'sourced', source_id: source.id
          }]
        }] }]
      }
    }), {
      amapKey: null, userRequest: '请规划北京一日游，包含故宫并核对开放时间。',
      researchCompleted: true, sourceIds: [source.id], availableSources: [source], tripBrief: trip.brief,
      openingHoursDetailsRequested: true
    })
    const stop = result.itineraryOptions?.[0]?.days[0]?.stops[0]

    expect(result.itineraryOptions).toHaveLength(1)
    expect(stop?.factClaims?.every((claim) => claim.value.length <= MAX_ITINERARY_FACT_QUOTE_CHARACTERS)).toBe(true)
    expect(stop?.factClaims?.some((claim) => claim.type === 'opening-hours' && claim.evidenceLevel === 'pending')).toBe(true)
    expect(result.output).toContain('本次提交 1 份行程草案')
  })

  it('搜索来源正文后只更新目标景点事实，保留完整草案', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({ destination: '北京', interests: '故宫', startDate: '2026-11-03', endDate: '2026-11-03' })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    await store.updateSettings({
      ...store.snapshot().settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
      connectors: { ...store.snapshot().settings.connectors, webSearch: true }
    })

    const source = createSource(
      '故宫博物院参观须知', 'https://palace.example/visit', 'Exa 网页正文', 'web',
      '故宫博物院每日开放时间为08:30至17:00；参观故宫博物院需提前预约。'
    )
    source.id = 'source-palace-official'
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = source.summary
    const unrelatedSource = createSource(
      '颐和园参观须知', 'https://garden.example/visit', 'Exa 网页正文', 'web',
      '颐和园每日开放时间为06:00至20:00。'
    )
    unrelatedSource.id = 'source-unrelated-garden'
    unrelatedSource.contentLevel = 'page'
    unrelatedSource.factEvidenceExcerpt = unrelatedSource.summary
    const searchQueries: string[] = []
    let factRepairBindings: Array<{
      plan_number: number; day_number: number; date: string; stop_name: string; area: string; source_ids: string[]
      fact_quotes?: Array<{ source_id: string; type: string; candidates: Array<{ quote_id: string; value: string }> }>
    }> = []
    let factRepairResult: Awaited<ReturnType<typeof executeTool>> | undefined
    const capturedModelRequests: Array<{
      tools?: Array<{ function?: { name?: string; description?: string; parameters?: unknown } }>
      messages?: Array<{ role?: string; content?: string }>
    }> = []
    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      if (name === 'search_web') {
        searchQueries.push((JSON.parse(rawArguments) as { query: string }).query)
        return { output: '已找到官方参观须知，当前记录含页面正文。', sources: [source, unrelatedSource] }
      }
      if (name === 'propose_itinerary_facts') {
        factRepairBindings = context.factRepairSourceBindings ?? []
        factRepairResult = await executeTool(name, rawArguments, context, signal)
        return factRepairResult
      }
      return executeTool(name, rawArguments, context, signal)
    }

    let modelRequestCount = 0
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      modelRequestCount += 1
      const request = JSON.parse(String(init?.body)) as {
      tools?: Array<{ function?: { name?: string; description?: string; parameters?: unknown } }>
        messages?: Array<{ role?: string; content?: string }>
      }
      capturedModelRequests.push(request)
      if (modelRequestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
          id: 'call_initial_draft', type: 'function',
          function: { name: 'propose_itineraries', arguments: JSON.stringify({ plans: [{
            title: '北京人文一日游', summary: '按日期和片区安排。', tradeoffs: '开放和预约安排以来源为准。',
            days: [{ day_number: 1, date: '2026-11-03', title: '故宫', stops: [{
              name: '故宫博物院', area: '东城区', time: '09:00–12:00', duration_minutes: 180,
              category: '景点', notes: '', transit_to_next: '', evidence_level: 'pending', source_ids: []
            }] }]
          }] }) }
        }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (modelRequestCount === 2) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
          id: 'call_search_palace', type: 'function',
          function: { name: 'search_web', arguments: JSON.stringify({ query: '故宫博物院 官方 开放时间 预约须知' }) }
        }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (modelRequestCount === 3) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
          id: 'call_repair_palace_facts', type: 'function',
          function: { name: 'propose_itinerary_facts', arguments: JSON.stringify({ updates: [{
            plan_number: 1, day_number: 1, date: '2026-11-03', stop_name: '故宫博物院', area: '东城区',
            claims: [
              { quote_id: quoteIdFromFactContext(request.messages, 'opening-hours'), scope: '2026-11-03', evidence_level: 'sourced', value: '故宫开放时间改为09:00至23:00', type: 'booking', source_id: unrelatedSource.id },
              { quote_id: quoteIdFromFactContext(request.messages, 'booking'), scope: '2026-11-03', evidence_level: 'sourced', value: '不需要提前预约', type: 'opening-hours', source_id: unrelatedSource.id }
            ]
          }] }) }
        }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (modelRequestCount === 4) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '开放与预约事实已按来源补充。' } }] }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      throw new Error('测试脚本收到多余的模型请求。')
    })

    const vault = {
      get: async (name: string) => name === 'modelKey' ? 'fixture-model-key' : name === 'exaKey' ? 'fixture-exa-key' : null
    } as unknown as SecretVault
    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id,
      '只生成一套北京一日详细行程，说明故宫开放时间和是否需要预约。',
      'fact-repair', new AbortController().signal, () => undefined
    )

    const proposalTool = capturedModelRequests[0]?.tools?.find(
      (tool) => tool.function?.name === 'propose_itineraries'
    )?.function
    const proposalDefinition = JSON.stringify(proposalTool)
    expect(proposalTool).toBeDefined()
    expect(proposalDefinition).not.toContain('逐景点事实补证')
    expect(proposalDefinition).toContain(`"maxLength":${MAX_ITINERARY_FACT_QUOTE_CHARACTERS}`)
    expect(proposalDefinition).toContain('"fact_claims"')
    expect(capturedModelRequests[1]?.tools?.some((tool) => tool.function?.name === 'search_web')).toBe(true)
    const factTool = capturedModelRequests[2]?.tools?.find(
      (tool) => tool.function?.name === 'propose_itinerary_facts'
    )?.function
    type SchemaProperty = {
      enum?: string[]
      items?: SchemaProperty
      properties?: Record<string, SchemaProperty>
      oneOf?: Array<{ properties?: Record<string, SchemaProperty> }>
    }
    const factSchema = factTool?.parameters as { properties?: Record<string, SchemaProperty> } | undefined
    const claimProperties = factSchema?.properties?.updates?.items?.oneOf?.[0]?.properties?.claims?.items?.properties
    expect(claimProperties?.quote_id?.enum).toEqual(['q1', 'q2'])
    expect(claimProperties).not.toHaveProperty('value')
    expect(claimProperties).not.toHaveProperty('source_id')
    expect(capturedModelRequests[2]?.messages?.some((message) =>
      message.content?.includes('应用会按编号恢复对应事实类别、来源和原文'))).toBe(true)
    const repairContext = capturedModelRequests[2]?.messages?.find((message) =>
      message.content?.startsWith('以下 JSON 只列出本轮事实补证目标')
    )?.content ?? ''
    expect(repairContext).toContain(source.id)
    expect(repairContext).toContain(source.factEvidenceExcerpt!)
    expect(repairContext).toContain('"quote_id":"q1"')
    expect(repairContext).not.toContain(unrelatedSource.id)
    expect(repairContext).not.toContain(unrelatedSource.factEvidenceExcerpt!)

    const completedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const assistant = completedTrip?.messages.find((message) => message.role === 'assistant')
    const options = assistant?.itineraryOptions ?? []
    const target = options[0]?.days[0]?.stops[0]
    const facts = target?.factClaims ?? []

    expect(modelRequestCount).toBe(4)
    expect(searchQueries.some((query) => query.includes('故宫') && query.includes('开放时间'))).toBe(true)
    expect(options).toHaveLength(1)
    expect(target).toMatchObject({ name: '故宫博物院', area: '东城区', time: '09:00–12:00' })
    expect(facts.every((fact) => fact.value.length <= MAX_ITINERARY_FACT_QUOTE_CHARACTERS)).toBe(true)
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'opening-hours', value: '故宫博物院每日开放时间为08:30至17:00', evidenceLevel: 'sourced', sourceId: source.id }),
      expect.objectContaining({ type: 'booking', value: '参观故宫博物院需提前预约', evidenceLevel: 'sourced', sourceId: source.id })
    ]))
    expect(factRepairBindings).toEqual([expect.objectContaining({
      plan_number: 1, day_number: 1, date: '2026-11-03', stop_name: '故宫博物院', source_ids: [source.id]
    })])
    expect(factRepairResult?.itineraryFactEvidenceDiagnostics).toMatchObject({
      requestedCount: 2, autoBoundCount: 0, rejectedCount: 0
    })
    expect(itineraryFactEvidenceFeedback(options, { openingHours: true, booking: true })).toEqual([])
  })

  it('搜索失败后保留待核验事实，不自动切换到浏览器', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({ destination: '北京', startDate: '2026-11-03', endDate: '2026-11-03' })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    await store.updateSettings({
      ...store.snapshot().settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
      connectors: { ...store.snapshot().settings.connectors, webSearch: true }
    })

    const placeName = '圆明园西洋楼遗址'
    const officialUrl = 'https://www.beijing.gov.cn/visit'
    const backgroundPage = createSource(
      `${placeName}景区介绍`, 'https://yuanmingyuan.example/about', 'Exa 网页正文', 'web',
      `${placeName}的历史与园区背景介绍。该页面不含开放时间和预约说明。`
    )
    backgroundPage.contentLevel = 'page'
    backgroundPage.factEvidenceExcerpt = backgroundPage.summary
    await store.saveSources(trip.id, [backgroundPage])
    let currentBrowserUrl = ''
    const browser: ResearchBrowserToolController = {
      isAvailable: () => true,
      navigate: vi.fn(async (url) => {
        currentBrowserUrl = String(url)
        return { url: currentBrowserUrl, title: 'Bing 搜索结果' }
      }),
      openSnapshotLink: vi.fn(async (targetId) => {
        expect(targetId).toBe('l1')
        currentBrowserUrl = officialUrl
        return { url: officialUrl, title: '北京景区开放时间与预约须知' }
      }),
      readSnapshot: vi.fn(async () => currentBrowserUrl.includes('bing.com/search') ? ({
        url: currentBrowserUrl,
        title: 'Bing 搜索结果',
        text: `${placeName}官方开放时间与预约须知。`,
        links: [{ targetId: 'l1', text: '北京景区开放时间与预约须知', url: officialUrl }]
      }) : ({
        url: officialUrl,
        title: '北京景区开放时间与预约须知',
        text: `${placeName}适用2026年11月3日开放时间为09:00至17:00。参观${placeName}需要提前预约。`,
        links: []
      })),
      scroll: vi.fn(async () => undefined),
      interact: vi.fn(async () => ({ action: 'expand' as const }))
    }
    const searchQueries: string[] = []
    let factRepairBindings: Array<{
      stop_name: string; source_ids: string[]
      fact_quotes?: Array<{ type: string; candidates: Array<{ quote_id: string; value: string }> }>
    }> = []
    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      if (name === 'search_web') {
        const query = (JSON.parse(rawArguments) as { query: string }).query
        searchQueries.push(query)
        if (!query.includes(placeName)) {
          return {
            output: '目的地概览线索。',
            sources: [createSource('北京出行概览', 'https://overview.example/travel', '测试搜索', 'web', '北京行程概览。')]
          }
        }
        return {
          output: '搜索服务暂不可用。',
          sources: [createSource('搜索服务状态', 'https://example.com/', 'Exa 搜索结果', 'web', 'HTTP 402：额度不足。', 'error')]
        }
      }
      if (name === 'propose_itinerary_facts') {
        factRepairBindings = context.factRepairSourceBindings ?? []
      }
      return executeTool(name, rawArguments, context, signal)
    }

    let modelRequestCount = 0
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        messages?: Array<{ content?: string | null }>
        tools?: Array<{ function?: { name?: string } }>
      }
      modelRequestCount += 1
      if (modelRequestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
          id: 'call_plan_with_generated_landmark', type: 'function',
          function: { name: 'propose_itineraries', arguments: JSON.stringify({ plans: [{
            title: '北京园林一日游', summary: '按日期和片区安排。', tradeoffs: '',
            days: [{ day_number: 1, date: '2026-11-03', title: '园林', stops: [{
              name: placeName, area: '海淀区', time: '09:00–12:00', duration_minutes: 180,
              category: '景点', notes: '', transit_to_next: ''
            }] }]
          }] }) }
        }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (modelRequestCount === 2) {
        expect(request.tools?.some((tool) => tool.function?.name === 'search_web')).toBe(true)
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
          id: 'call_search_generated_landmark', type: 'function',
          function: { name: 'search_web', arguments: JSON.stringify({ query: `北京 ${placeName} 官方开放时间 预约` }) }
        }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (modelRequestCount === 3) {
        expect(request.messages?.some((message) => message.content?.includes('HTTP 402'))).toBe(true)
        return new Response(JSON.stringify({ choices: [{ message: {
          role: 'assistant', content: '搜索额度不足；开放时间和预约规则保留待核验。'
        } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error('测试脚本收到多余的模型请求。')
    })

    const vault = {
      get: async (name: string) => name === 'modelKey' ? 'fixture-model-key' : null
    } as unknown as SecretVault
    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id,
      '请规划北京一日游并核对景点开放时间与预约规则。',
      'fact-repair-browser-fallback', new AbortController().signal,
      () => undefined, undefined, undefined, browser
    )

    const completedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const savedStop = completedTrip?.messages.find((message) => message.role === 'assistant')?.itineraryOptions?.[0]
      ?.days[0]?.stops[0]
    const officialPage = completedTrip?.sources.find((source) => source.url === officialUrl)
    expect(searchQueries.some((query) => query.includes(placeName))).toBe(true)
    expect(browser.navigate).not.toHaveBeenCalled()
    expect(browser.openSnapshotLink).not.toHaveBeenCalled()
    expect(officialPage).toBeUndefined()
    expect(factRepairBindings).toEqual([])
    expect(savedStop?.factClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'opening-hours', evidenceLevel: 'pending' }),
      expect.objectContaining({ type: 'booking', evidenceLevel: 'pending' })
    ]))
    expect(modelRequestCount).toBe(3)
  })

  it('已有部分事实时由模型显式选择浏览器补充缺失类别', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({ destination: '北京', startDate: '2026-11-03', endDate: '2026-11-03' })
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('旅行资料未创建。')
    await store.updateSettings({
      ...store.snapshot().settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
      connectors: { ...store.snapshot().settings.connectors, webSearch: true }
    })

    const placeName = '圆明园西洋楼遗址'
    const officialUrl = 'https://www.yuanmingyuanpark.cn/visit'
    const partialPage = createSource(
      `${placeName}开放时间`, 'https://www.yuanmingyuanpark.cn/hours', 'Exa 网页正文', 'web',
      `${placeName}开放时间为08:30至17:00。`
    )
    partialPage.contentLevel = 'page'
    partialPage.factEvidenceExcerpt = partialPage.summary
    await store.saveSources(trip.id, [partialPage])
    let currentBrowserUrl = ''
    const browser: ResearchBrowserToolController = {
      isAvailable: () => true,
      navigate: vi.fn(async (url) => {
        currentBrowserUrl = String(url)
        return { url: currentBrowserUrl, title: 'Bing 搜索结果' }
      }),
      openSnapshotLink: vi.fn(async (targetId) => {
        expect(targetId).toBe('l1')
        currentBrowserUrl = officialUrl
        return { url: officialUrl, title: `${placeName}官方开放时间与预约须知` }
      }),
      readSnapshot: vi.fn(async () => currentBrowserUrl.includes('bing.com/search') ? ({
        url: currentBrowserUrl,
        title: 'Bing 搜索结果',
        text: `${placeName}官方开放时间与预约须知。`,
        links: [{ targetId: 'l1', text: `${placeName}官方网站开放时间与预约须知`, url: officialUrl }]
      }) : ({
        url: officialUrl,
        title: `${placeName}官方开放时间与预约须知`,
        text: `${placeName}适用2026年11月3日开放时间为09:00至17:00。参观需要提前预约。`,
        links: []
      })),
      scroll: vi.fn(async () => undefined),
      interact: vi.fn(async () => ({ action: 'expand' as const }))
    }
    const searchQueries: string[] = []
    const executedTools: string[] = []
    const requestedTools: string[][] = []
    let factRepairBindings: Array<{ stop_name: string; source_ids: string[] }> = []
    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      executedTools.push(name)
      if (name === 'search_web') {
        const query = (JSON.parse(rawArguments) as { query: string }).query
        searchQueries.push(query)
        return {
          output: '北京城市概览线索。',
          sources: [createSource('北京出行概览', 'https://overview.example/travel', '测试搜索', 'web', '北京城市概览。')]
        }
      }
      if (name === 'propose_itinerary_facts') factRepairBindings = context.factRepairSourceBindings ?? []
      return executeTool(name, rawArguments, context, signal)
    }

    let modelRequestCount = 0
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        messages?: Array<{ content?: string | null }>
        tools?: Array<{ function?: { name?: string } }>
      }
      requestedTools.push((request.tools ?? []).map((tool) => tool.function?.name ?? ''))
      modelRequestCount += 1
      if (modelRequestCount === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
          id: 'call_plan_without_source', type: 'function',
          function: { name: 'propose_itineraries', arguments: JSON.stringify({ plans: [{
            title: '北京园林一日游', summary: '按日期和片区安排。', tradeoffs: '',
            days: [{ day_number: 1, date: '2026-11-03', title: '园林', stops: [{
              name: placeName, area: '海淀区', time: '09:00–12:00', duration_minutes: 180,
              category: '景点', notes: '', transit_to_next: ''
            }] }]
          }] }) }
        }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (modelRequestCount === 2) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
          id: 'call_read_missing_booking_fact', type: 'function',
          function: { name: 'research_browser_navigate', arguments: JSON.stringify({ url: officialUrl }) }
        }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (modelRequestCount === 3) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', tool_calls: [{
          id: 'call_save_automatically_researched_facts', type: 'function',
          function: { name: 'propose_itinerary_facts', arguments: JSON.stringify({ updates: [{
            plan_number: 1, day_number: 1, date: '2026-11-03', stop_name: placeName, area: '海淀区',
            claims: [
              { quote_id: quoteIdFromFactContext(request.messages, 'opening-hours'), scope: '2026-11-03', evidence_level: 'sourced' },
              { quote_id: quoteIdFromFactContext(request.messages, 'booking'), scope: '2026-11-03', evidence_level: 'sourced' }
            ]
          }] }) }
        }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (modelRequestCount === 4) {
        return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '缺失事实已按网页正文补充。' } }] }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      throw new Error('测试脚本收到多余的模型请求。')
    })

    const vault = { get: async (name: string) => name === 'modelKey' ? 'fixture-model-key' : null } as unknown as SecretVault
    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id,
      '请规划北京一日游并核对景点开放时间与预约规则。',
      'fact-repair-explicit-browser-search', new AbortController().signal,
      () => undefined, undefined, undefined, browser
    )

    const completedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const savedStop = completedTrip?.messages.find((message) => message.role === 'assistant')?.itineraryOptions?.[0]
      ?.days[0]?.stops[0]
    const officialPage = completedTrip?.sources.find((source) => source.url === officialUrl)
    expect(searchQueries).toEqual([])
    expect(requestedTools[1]).toContain('research_browser_navigate')
    expect(requestedTools[2]).toContain('propose_itinerary_facts')
    expect(executedTools).toEqual(['propose_itineraries', 'research_browser_navigate', 'propose_itinerary_facts'])
    expect(requestedTools.length).toBe(4)
    expect(browser.navigate).toHaveBeenCalledOnce()
    expect(browser.openSnapshotLink).not.toHaveBeenCalled()
    expect(officialPage?.contentLevel).toBe('page')
    expect(factRepairBindings).toEqual([expect.objectContaining({
      stop_name: placeName, source_ids: expect.arrayContaining([partialPage.id, officialPage?.id])
    })])
    expect(savedStop?.factClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'opening-hours', value: `${placeName}适用2026年11月3日开放时间为09:00至17:00`, evidenceLevel: 'sourced', sourceId: officialPage?.id }),
      expect.objectContaining({ type: 'booking', value: '参观需要提前预约', evidenceLevel: 'sourced', sourceId: officialPage?.id })
    ]))
    expect(modelRequestCount).toBe(4)
  })
})
