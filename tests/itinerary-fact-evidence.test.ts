/** 覆盖详细行程中开放、预约和票价事实的来源缺口反馈。 */
import { describe, expect, it } from 'vitest'
import type { ItineraryFactClaim, ItineraryOption, ItineraryStop } from '../src/shared/types.js'
import { itineraryFactEvidenceFeedback, itineraryProposalDefinitionForBudget, itineraryProposalTool } from '../src/main/connectors/itinerary.js'
import { itineraryFactRepairDefinitionForSourceBindings, itineraryFactRepairTool } from '../src/main/connectors/itinerary-facts.js'
import { sourceDirectlyNamesStop, sourceDirectlySupportsStopFact } from '../src/main/connectors/itinerary-fact-evidence.js'
import { requestedItineraryFactDetails } from '../src/main/agent-tool-policy.js'
import { createSource } from '../src/main/connectors/types.js'
import { EMPTY_BRIEF, isItineraryFactClaim, isItineraryOption, isSource } from '../src/main/persistence/schema.js'
import { hasExplicitBookingRule, itineraryFactTypeLabel, itineraryPlaceNameAliases, itinerarySourceNamesPlace } from '../src/shared/itinerary-facts.js'
import { travelEvidenceExcerpt } from '../src/main/connectors/web-evidence.js'

/** 构造仅包含事实核验所需字段的地点。 */
function stop(name: string, factClaims: ItineraryFactClaim[]): ItineraryStop {
  return {
    id: name, name, area: '北京', time: '09:00–10:00', durationMinutes: 60,
    category: '景点', notes: '', transitToNext: '', evidenceLevel: 'pending', sourceIds: [], factClaims
  }
}

/** 构造单日候选，便于验证事实反馈不受其他行程字段影响。 */
function option(stops: ItineraryStop[], date = '2026-09-22'): ItineraryOption {
  return {
    id: 'plan', title: '北京人文', summary: '', tradeoffs: '',
    days: [{ id: 'day', dayNumber: 1, date, title: '海淀', scheduleBlocks: [], stops }]
  }
}

function claim(id: string, type: ItineraryFactClaim['type'], evidenceLevel: ItineraryFactClaim['evidenceLevel'], sourceId?: string): ItineraryFactClaim {
  return { id, type, value: '访问规则', scope: '2026-09-22', evidenceLevel, ...(sourceId ? { sourceId } : {}) }
}

/** 构造用于验证候选间事实复用的模型输入。 */
function rawPlan(
  title: string,
  date: string,
  facts: Array<Record<string, unknown>>,
  area = '东城',
  notes = '',
  placeName = '故宫'
): Record<string, unknown> {
  return {
    title, summary: '按用户日期安排。', tradeoffs: '具体规则以来源为准。',
    days: [{ day_number: 1, date, title: '故宫', stops: [{
      name: placeName, area, time: '09:00–12:00', duration_minutes: 180, category: '景点', notes,
      transit_to_next: '', evidence_level: 'pending', source_ids: [], fact_claims: facts
    }]}]
  }
}

/** 运行行程工具并为模型引用提供可验证来源。 */
async function runProposal(plans: Record<string, unknown>[], sources: ReturnType<typeof createSource>[], requirements = {
  openingHoursDetailsRequested: true, bookingDetailsRequested: false
}) {
  return itineraryProposalTool.execute({ plans }, {
    amapKey: null, researchCompleted: true,
    sourceIds: sources.map((source) => source.id), availableSources: sources,
    ...requirements
  })
}

describe('行程事实来源反馈', () => {
  it('只把明确的预约条件或办理方式识别为预约规则', () => {
    expect(hasExplicitBookingRule('参观故宫需要提前预约。')).toBe(true)
    expect(hasExplicitBookingRule('可通过官方小程序预约。')).toBe(true)
    expect(hasExplicitBookingRule('无需预约。')).toBe(true)
    expect(hasExplicitBookingRule('开放时间和预约要求以参观须知为准。')).toBe(false)
    expect(hasExplicitBookingRule('预约须知。')).toBe(false)
  })

  it('计划 schema 公开全部事实类型，业务缺口交给工具反馈', () => {
    const definition = itineraryProposalDefinitionForBudget({
      budgetRequested: false,
      openingHoursDetailsRequested: true,
      bookingDetailsRequested: true,
      ticketPriceDetailsRequested: true
    })
    const root = definition.function.parameters.properties as Record<string, unknown>
    const plan = root.plan as { properties: Record<string, unknown> }
    const days = plan.properties.days as { items: { properties: Record<string, unknown> } }
    const stops = days.items.properties.stops as { items: { properties: Record<string, unknown> } }
    const claims = stops.items.properties.fact_claims as {
      items: { properties: { type: { enum: string[] } } }
    }
    const factTypes = claims.items.properties.type.enum

    expect(factTypes).toContain('opening-hours')
    expect(factTypes).toContain('closure')
    expect(factTypes).toContain('booking')
    expect(factTypes).toContain('ticket-price')
    expect(factTypes).toContain('sunset')
    expect(definition.function.description).toContain('error、warning 或 info')
    expect(definition.function.description).not.toContain('首稿')
  })

  it('事实补证工具按目标地点限定可引用来源 ID', () => {
    const definition = itineraryFactRepairDefinitionForSourceBindings([
      {
        plan_number: 1, day_number: 1, date: '2026-09-22', stop_name: '故宫博物院',
        area: '东城', source_ids: ['palace-source'], fact_quotes: [
          { source_id: 'palace-source', type: 'opening-hours', candidates: [{ quote_id: 'q1', value: '故宫每日开放时间为08:30至17:00。' }] },
          { source_id: 'palace-source', type: 'booking', candidates: [{ quote_id: 'q2', value: '参观需提前预约。' }] }
        ]
      },
      {
        plan_number: 1, day_number: 2, date: '2026-09-23', stop_name: '颐和园',
        area: '海淀', source_ids: ['summer-palace-source']
      },
      {
        plan_number: 1, day_number: 3, date: '2026-09-24', stop_name: '天坛',
        area: '东城', source_ids: []
      }
    ])
    type SchemaNode = {
      enum?: string[]
      properties?: Record<string, SchemaNode>
      items?: SchemaNode
      oneOf?: SchemaNode[]
    }
    const parameters = definition.function.parameters as unknown as {
      properties: { updates: { maxItems: number; items: SchemaNode } }
    }
    const branches = parameters.properties.updates.items.oneOf ?? []

    expect(parameters.properties.updates.maxItems).toBe(1)
    expect(branches).toHaveLength(1)
    expect(branches[0]?.properties?.stop_name?.enum).toEqual(['故宫博物院'])
    const claimProperties = branches[0]?.properties?.claims?.items?.properties
    expect(claimProperties?.quote_id?.enum).toEqual(['q1', 'q2'])
    expect(claimProperties).not.toHaveProperty('value')
    expect(claimProperties).not.toHaveProperty('source_id')
    expect(JSON.stringify(definition)).not.toContain('故宫每日开放时间')
    expect(JSON.stringify(definition)).not.toContain('天坛')
  })

  it('每个原文候选有唯一编号，原文与来源映射留在执行端', () => {
    const definition = itineraryFactRepairDefinitionForSourceBindings([{
      plan_number: 1, day_number: 1, date: '2026-09-22', stop_name: '故宫博物院', area: '东城',
      source_ids: ['palace-source-a', 'palace-source-b'], fact_quotes: [
        { source_id: 'palace-source-a', type: 'opening-hours', candidates: [{ quote_id: 'q1', value: '故宫开放时间为08:30至17:00' }] },
        { source_id: 'palace-source-b', type: 'opening-hours', candidates: [{ quote_id: 'q2', value: '故宫开放时间为09:00至16:30' }] }
      ]
    }])
    type SchemaNode = {
      enum?: string[]
      properties?: Record<string, SchemaNode>
      items?: SchemaNode
      oneOf?: SchemaNode[]
    }
    const parameters = definition.function.parameters as unknown as { properties: { updates: { items: SchemaNode } } }
    const quoteIds = parameters.properties.updates.items.oneOf?.[0]
      ?.properties?.claims?.items?.properties?.quote_id?.enum

    expect(quoteIds).toEqual(['q1', 'q2'])
    expect(JSON.stringify(definition)).not.toContain('故宫开放时间')
    expect(JSON.stringify(definition)).not.toContain('palace-source-a')
  })

  it('每类事实的原文候选最多两条', () => {
    const definition = itineraryFactRepairDefinitionForSourceBindings([{
      plan_number: 1, day_number: 1, date: '2026-09-22', stop_name: '故宫博物院', area: '东城',
      source_ids: ['palace-source'], fact_quotes: [{
        source_id: 'palace-source', type: 'opening-hours', candidates: [
          { quote_id: 'q1', value: '开放时间为08:30至17:00' },
          { quote_id: 'q2', value: '开放时间为09:00至16:30' },
          { quote_id: 'q3', value: '开放时间为08:00至18:00' }
        ]
      }]
    }])
    type SchemaNode = {
      enum?: string[]
      properties?: Record<string, SchemaNode>
      items?: SchemaNode
      oneOf?: SchemaNode[]
    }
    const parameters = definition.function.parameters as unknown as { properties: { updates: { items: SchemaNode } } }
    const quoteIds = parameters.properties.updates.items.oneOf?.[0]
      ?.properties?.claims?.items?.properties?.quote_id?.enum

    expect(quoteIds).toEqual(['q1', 'q2'])
  })

  it('大行程工具 schema 超预算时仍为各事实保留精确引文选项', () => {
    const repairableFacts = ['opening-hours', 'booking', 'ticket-price'] as const
    const bindings = Array.from({ length: 18 }, (_, targetIndex) => {
      const sourceIds = [`official-${targetIndex}-a`, `official-${targetIndex}-b`]
      const fact_quotes = repairableFacts.map((type, index) => ({
        source_id: sourceIds[0]!,
        type,
        candidates: [{
          quote_id: `q${index + 1}`,
          value: type === 'opening-hours' ? '开放时间 8:00 至 17:00' :
            type === 'booking' ? '预约规则 1' : '门票价格 30 元'
        }]
      }))
      return {
        plan_number: 1, day_number: targetIndex % 7 + 1,
        date: `2026-11-${String(targetIndex + 1).padStart(2, '0')}`,
        stop_name: `北京景点${targetIndex + 1}`, area: `北京区域${targetIndex + 1}`,
        source_ids: sourceIds, fact_quotes
      }
    })
    const definition = itineraryFactRepairDefinitionForSourceBindings(bindings)
    const serialized = JSON.stringify(definition)
    type SchemaNode = {
      enum?: string[]
      properties?: Record<string, SchemaNode>
      items?: SchemaNode
      oneOf?: SchemaNode[]
    }
    const parameters = definition.function.parameters as unknown as { properties: { updates: { items: SchemaNode } } }
    const targetBranches = parameters.properties.updates.items.oneOf ?? []
    const quoteIds = targetBranches.flatMap((target) =>
      target.properties?.claims?.items?.properties?.quote_id?.enum ?? []
    )

    expect(serialized.length).toBeLessThan(50_000)
    expect(targetBranches).toHaveLength(18)
    expect(quoteIds).toContain('q1')
    expect(quoteIds).toContain('q2')
    expect(quoteIds).toContain('q3')
    expect(quoteIds).toHaveLength(18 * repairableFacts.length)
    expect(serialized).not.toContain('开放时间 8:00 至 17:00')
  })

  it('多景点候选超过预算时缩减枚举但保留逐字引文', () => {
    const repairableFacts = ['opening-hours', 'booking', 'ticket-price'] as const
    const bindings = Array.from({ length: 18 }, (_, targetIndex) => {
      const sourceIds = Array.from({ length: 20 }, (_, sourceIndex) => `source-${targetIndex}-${sourceIndex}`)
      let quoteNumber = 0
      const fact_quotes = sourceIds.flatMap((source_id) => repairableFacts.map((type) => ({
        source_id,
        type,
        candidates: Array.from({ length: 3 }, (_, quoteIndex) => ({
          quote_id: `q${++quoteNumber}`,
          value: `${'x'.repeat(180)}-${targetIndex}-${quoteIndex}`
        }))
      })))
      return {
        plan_number: 1, day_number: targetIndex + 1, date: `2026-11-${String(targetIndex + 1).padStart(2, '0')}`,
        stop_name: `景点${targetIndex + 1}`, area: '北京', source_ids: sourceIds, fact_quotes
      }
    })
    const definition = itineraryFactRepairDefinitionForSourceBindings(bindings)
    const serialized = JSON.stringify(definition)
    type SchemaNode = {
      enum?: string[]
      properties?: Record<string, SchemaNode>
      items?: SchemaNode
      oneOf?: SchemaNode[]
    }
    const parameters = definition.function.parameters as unknown as { properties: { updates: { items: SchemaNode } } }
    const ids = parameters.properties.updates.items.oneOf?.flatMap((target) =>
      target.properties?.claims?.items?.properties?.quote_id?.enum ?? []
    ) ?? []

    expect(serialized.length).toBeLessThan(50_000)
    expect(ids).toHaveLength(18 * repairableFacts.length * 4)
    expect(ids.every((id) => /^q\d+$/u.test(id))).toBe(true)
    expect(serialized).not.toContain('x'.repeat(180))
  })

  it('没有匹配来源时事实补证工具只允许空更新', () => {
    const definition = itineraryFactRepairDefinitionForSourceBindings([])
    const updates = (definition.function.parameters as {
      properties: { updates: { maxItems: number; items: unknown } }
    }).properties.updates

    expect(updates.maxItems).toBe(0)
    expect(updates.items).toEqual({ type: 'object' })
  })

  it('目标没有原文候选时不能借用其他地点的可用来源', async () => {
    const source = createSource(
      '故宫博物院参观须知', 'https://palace.example/visit', '官方网页正文', 'web',
      '故宫博物院开放时间为08:30至17:00。'
    )
    source.id = 'source-palace-official'
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = source.summary
    const plan = option([stop('故宫博物院', [claim('pending-opening', 'opening-hours', 'pending')])])
    const result = await itineraryFactRepairTool.execute({ updates: [{
      plan_number: 1, day_number: 1, date: '2026-09-22', stop_name: '故宫博物院', area: '北京',
      claims: [{
        quote_id: 'q1', scope: '2026-09-22', evidence_level: 'sourced'
      }]
    }] }, {
      amapKey: null,
      itineraryOptions: [plan],
      openingHoursDetailsRequested: true,
      sourceIds: [source.id],
      availableSources: [source],
      factRepairSourceBindings: [{
        plan_number: 1, day_number: 1, date: '2026-09-22', stop_name: '故宫博物院', area: '北京', source_ids: []
      }]
    })
    const repaired = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims ?? []

    expect(repaired).toEqual([expect.objectContaining({ type: 'opening-hours', evidenceLevel: 'pending' })])
    expect(repaired[0]).not.toHaveProperty('sourceId')
    expect(result.itineraryFactEvidenceDiagnostics).toMatchObject({
      requestedCount: 0, rejectedCount: 1
    })
  })

  it('事实补证也拒绝从并列景点页面借用其他地点的事实值', async () => {
    const source = createSource(
      '北京景点开放时间：故宫博物院与颐和园', 'https://example.com/beijing-hours', '官方网页正文', 'web',
      '故宫博物院开放时间为08:30至17:00。\n颐和园开放时间为06:00至20:00。'
    )
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = source.summary
    const plan = option([
      stop('故宫博物院', [{
        id: 'pending-opening', type: 'opening-hours', value: '具体开放时段待核验',
        scope: '2026-09-22', evidenceLevel: 'pending'
      }]),
      stop('颐和园', [])
    ])
    const result = await itineraryFactRepairTool.execute({ updates: [{
      plan_number: 1, day_number: 1, date: '2026-09-22', stop_name: '故宫博物院', area: '北京',
      claims: [{
        quote_id: 'q1', scope: '2026-09-22', evidence_level: 'sourced'
      }]
    }] }, {
      amapKey: null,
      itineraryOptions: [plan],
      openingHoursDetailsRequested: true,
      sourceIds: [source.id],
      availableSources: [source],
      factRepairSourceBindings: [{
        plan_number: 1, day_number: 1, date: '2026-09-22', stop_name: '故宫博物院', area: '北京',
        source_ids: [source.id], fact_quotes: [{
          source_id: source.id, type: 'opening-hours', candidates: [
            { quote_id: 'q1', value: '颐和园开放时间为06:00至20:00' }
          ]
        }]
      }]
    })
    const repaired = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims ?? []

    expect(repaired).toEqual([expect.objectContaining({
      type: 'opening-hours', evidenceLevel: 'pending', value: '具体开放时段待核验'
    })])
    expect(result.itineraryFactEvidenceDiagnostics).toMatchObject({
      requestedCount: 1, valueMismatchCount: 1, rejectedCount: 1
    })
  })

  it('绑定表缺少目标时不回退到本轮全局来源', async () => {
    const source = createSource(
      '故宫博物院参观须知', 'https://palace.example/visit', '官方网页正文', 'web',
      '故宫博物院开放时间为08:30至17:00。'
    )
    source.id = 'source-palace-official'
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = source.summary
    const result = await itineraryFactRepairTool.execute({ updates: [{
      plan_number: 1, day_number: 1, date: '2026-09-22', stop_name: '故宫博物院', area: '北京',
      claims: [{
        quote_id: 'q1', scope: '2026-09-22', evidence_level: 'sourced'
      }]
    }] }, {
      amapKey: null,
      itineraryOptions: [option([stop('故宫博物院', [claim('pending-opening', 'opening-hours', 'pending')])])],
      openingHoursDetailsRequested: true,
      sourceIds: [source.id],
      availableSources: [source],
      factRepairSourceBindings: []
    })

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims).toEqual([
      expect.objectContaining({ type: 'opening-hours', evidenceLevel: 'pending' })
    ])
    expect(result.itineraryFactEvidenceDiagnostics).toMatchObject({
      requestedCount: 0, rejectedCount: 1
    })
  })

  it('移除餐饮和住宿上的无关门票占位，同时保留景点票价状态', async () => {
    const pendingTicketPrice = {
      type: 'ticket-price', value: '具体票价待核验', scope: '2026-09-22', evidence_level: 'pending'
    }
    const result = await runProposal([{
      title: '北京行程', summary: '按用户日期安排。', tradeoffs: '',
      days: [{
        day_number: 1, date: '2026-09-22', title: '市区',
        stops: [
          { name: '酒店入住', area: '北京', time: '08:00–09:00', duration_minutes: 60, category: '住宿', notes: '', transit_to_next: '', fact_claims: [pendingTicketPrice] },
          { name: '午餐', area: '北京', time: '12:00–13:00', duration_minutes: 60, category: '餐饮', notes: '', transit_to_next: '', fact_claims: [pendingTicketPrice] },
          { name: '故宫', area: '北京', time: '14:00–16:00', duration_minutes: 120, category: '景点', notes: '', transit_to_next: '', fact_claims: [pendingTicketPrice] }
        ]
      }]
    }], [])
    const stops = result.itineraryOptions?.[0]?.days[0]?.stops ?? []

    expect(stops).toHaveLength(3)
    expect(stops[0]?.factClaims).toEqual([])
    expect(stops[1]?.factClaims).toEqual([])
    expect(stops[2]?.factClaims).toContainEqual(expect.objectContaining({
      type: 'ticket-price', evidenceLevel: 'pending'
    }))
  })

  it('改轻松时为保留的景点延续基线开放和预约状态', async () => {
    const baseline = option([stop('颐和园', [
      claim('hours', 'opening-hours', 'pending'),
      claim('booking', 'booking', 'pending')
    ])])
    const request = '只把 9/22 调轻松，保留颐和园。'
    const facts = requestedItineraryFactDetails(request, baseline)
    const result = await itineraryProposalTool.execute({
      plan: rawPlan('北京行程', '2026-09-22', [], '海淀', '', '颐和园')
    }, {
      amapKey: null,
      researchCompleted: true,
      revisionBaseline: baseline,
      userRequest: request,
      sourceIds: [], availableSources: [],
      openingHoursDetailsRequested: facts.openingHours,
      bookingDetailsRequested: facts.booking
    })
    const claims = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims ?? []

    expect(claims.map((item) => `${item.type}:${item.evidenceLevel}`).sort()).toEqual([
      'booking:pending', 'opening-hours:pending'
    ])
  })

  it('按明确的中英文常见简称匹配地点来源，不混淆不同场馆', () => {
    const aliases: Array<[string, string]> = [
      ['鸟巢', '国家体育场'],
      ['水立方', '国家游泳中心'],
      ['天安门广场', '天安门地区'],
      ['北京大学', '北大'],
      ['北京大学', '燕园'],
      ['清华大学', '清华园'],
      ['故宫博物院', '紫禁城'],
      ['颐和园', '清漪园'],
      ['中国国家博物馆', '国博'],
      ['北京孔庙和国子监博物馆', '国子监']
    ]

    for (const [placeName, sourceName] of aliases) {
      expect(itinerarySourceNamesPlace(`${sourceName}开放时间与预约须知`, placeName)).toBe(true)
      expect(itineraryPlaceNameAliases(placeName)).toContain(sourceName.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase())
    }
    expect(itinerarySourceNamesPlace('国家游泳中心开放时间', '国家体育场')).toBe(false)
  })

  it('地点简称匹配唯一正文时只关联来源，不提升待核验状态', async () => {
    const source = createSource('国家体育场参观须知', 'https://example.com/stadium', 'Firecrawl 网页正文', 'web', '国家体育场开放时间为 06:00 至 22:00。')
    source.contentLevel = 'page'
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '具体开放时段待核验', scope: '2026-09-22', evidence_level: 'pending'
    }], '朝阳区', '', '鸟巢')], [source])
    const factClaim = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]

    expect(factClaim).toMatchObject({
      type: 'opening-hours', evidenceLevel: 'pending', sourceId: source.id, value: '具体开放时段待核验'
    })
  })

  it('URL 中的景点 slug 只用于发现链接，不能证明正文属于该景点', () => {
    const source = createSource(
      '参观须知',
      'https://travel.example/%E6%95%85%E5%AE%AB%E5%8D%9A%E7%89%A9%E9%99%A2/visit',
      'Tripwise 研究浏览器',
      'web',
      '开放时间为 08:30 至 17:00。'
    )
    source.contentLevel = 'page'

    expect(sourceDirectlyNamesStop(source, '故宫博物院')).toBe(false)
    expect(sourceDirectlySupportsStopFact('opening-hours', source, '故宫博物院', '08:30 至 17:00')).toBe(false)
  })

  it('拒绝跨景点绑定开放时段，并接受同句或表格行直接支持的值', async () => {
    const source = createSource(
      '北京市景区参观公告', 'https://example.com/beijing-hours', 'Firecrawl 网页正文', 'web',
      '故宫博物院开放时间为 08:30 至 17:00。\n颐和园开放时间为 06:00 至 20:00。'
    )
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = source.summary
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '06:00 至 20:00', scope: '旺季', evidence_level: 'sourced', source_id: source.id
    }])], [source])
    const factClaim = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]

    expect(factClaim).toMatchObject({
      type: 'opening-hours', evidenceLevel: 'pending', value: '具体开放时段待核验'
    })
    expect(result.itineraryFactEvidenceDiagnostics).toMatchObject({
      requestedCount: 1, rejectedCount: 1, valueMismatchCount: 1
    })

    const directSource = createSource(
      '北京市景区参观公告', 'https://example.com/palace-hours', 'Firecrawl 网页正文', 'web',
      '故宫博物院开放时间为 08:30 至 17:00。'
    )
    directSource.contentLevel = 'page'
    directSource.factEvidenceExcerpt = directSource.summary
    const directResult = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '08:30 至 17:00', scope: '2026-09-22', evidence_level: 'sourced', source_id: directSource.id
    }])], [directSource])

    expect(directResult.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]).toMatchObject({
      type: 'opening-hours', evidenceLevel: 'sourced', value: '08:30 至 17:00', sourceId: directSource.id
    })
  })

  it('来源标题同时提到多个景点时，不把其他景点的事实绑定到当前地点', async () => {
    const source = createSource(
      '北京景点开放时间：故宫博物院与颐和园', 'https://example.com/beijing-hours', 'Firecrawl 网页正文', 'web',
      '故宫博物院开放时间为 08:30 至 17:00。\n颐和园开放时间为 06:00 至 20:00。'
    )
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = source.summary
    const plan = rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '06:00 至 20:00', scope: '2026-09-22', evidence_level: 'sourced', source_id: source.id
    }])
    const day = (plan.days as Array<Record<string, unknown>>)[0]!
    const stops = day.stops as Array<Record<string, unknown>>
    stops.push({
      name: '颐和园', area: '海淀', time: '13:00–16:00', duration_minutes: 180, category: '景点', notes: '',
      transit_to_next: '', evidence_level: 'pending', source_ids: [], fact_claims: []
    })

    const result = await runProposal([plan], [source])
    const factClaim = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]

    expect(factClaim).toMatchObject({
      type: 'opening-hours', evidenceLevel: 'pending', value: '具体开放时段待核验'
    })
  })

  it('地点不匹配的来源不会挂在待核验事实上', async () => {
    const source = createSource(
      '颐和园开放时间', 'https://example.com/summer-palace-hours', '官方网页正文', 'web',
      '颐和园开放时间为06:00至20:00。'
    )
    source.contentLevel = 'page'
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '06:00至20:00', scope: '2026-09-22',
      evidence_level: 'sourced', source_id: source.id
    }])], [source])
    const factClaim = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]

    expect(factClaim).toMatchObject({ evidenceLevel: 'pending', value: '具体开放时段待核验' })
    expect(factClaim?.sourceId).toBeUndefined()
  })

  it('用 800 字摘要以外的正文摘录关联待核验事实', async () => {
    const source = createSource(
      '景区参观须知', 'https://example.com/palace-rules', 'Firecrawl 网页正文', 'web', '一般参观提示。'.repeat(100)
    )
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = '故宫博物院开放时间为 08:30 至 17:00，参观需要提前预约。'
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '具体开放时段待核验', scope: '2026-09-22', evidence_level: 'pending'
    }])], [source])
    const factClaim = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]

    expect(factClaim).toMatchObject({
      type: 'opening-hours', evidenceLevel: 'pending', sourceId: source.id, value: '具体开放时段待核验'
    })
  })

  it('长网页摘录保留场馆标题后可绑定同节原文事实', async () => {
    const pageText = [
      '# 官方参观指南',
      '## 故宫博物院',
      '本段说明场馆区域和参观路线，但不包含具体开放信息。',
      '更多参观介绍与现场服务说明。',
      '开放时间：08:30–17:00。',
      ...Array.from({ length: 12 }, (_, index) =>
        `参观须知补充说明 ${index}：${'本段介绍场馆历史、建筑和参观背景。'.repeat(18)}`
      )
    ].join('\n\n')
    const excerpt = travelEvidenceExcerpt(pageText)
    const source = createSource('北京景点参观须知', 'https://example.com/visitor-guide', 'Firecrawl 网页正文', 'web', excerpt)
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = excerpt
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '开放时间：08:30–17:00', scope: '2026-09-22',
      evidence_level: 'sourced', source_id: source.id
    }], '东城', '', '故宫博物院')], [source])

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]).toMatchObject({
      type: 'opening-hours', evidenceLevel: 'sourced', sourceId: source.id
    })
  })

  it('模型来源 ID 不正确时仅在存在唯一直接支持正文时自动绑定', async () => {
    const source = createSource('故宫博物院开放时间', 'https://example.com/palace-hours', '官方网页正文', 'web', '故宫博物院开放时间为 08:30 至 17:00。')
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = '故宫博物院开放时间为 08:30 至 17:00。'
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '08:30 至 17:00', scope: '2026-09-22', evidence_level: 'sourced', source_id: 'unknown-source'
    }])], [source])
    const factClaim = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]

    expect(factClaim).toMatchObject({
      type: 'opening-hours', value: '08:30 至 17:00', evidenceLevel: 'sourced', sourceId: source.id
    })
    expect(result.itineraryFactEvidenceDiagnostics).toMatchObject({ requestedCount: 1, autoBoundCount: 1, rejectedCount: 0 })
  })

  it('存在多个直接支持正文时不猜测来源归属', async () => {
    const sources = ['one', 'two'].map((suffix) => {
      const source = createSource(`故宫博物院开放时间 ${suffix}`, `https://example.com/${suffix}`, '官方网页正文', 'web', '故宫博物院开放时间为 08:30 至 17:00。')
      source.contentLevel = 'page'
      source.factEvidenceExcerpt = '故宫博物院开放时间为 08:30 至 17:00。'
      return source
    })
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '08:30 至 17:00', scope: '2026-09-22', evidence_level: 'sourced', source_id: 'unknown-source'
    }])], sources)
    const factClaim = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]

    expect(factClaim).toMatchObject({ evidenceLevel: 'pending', value: '具体开放时段待核验' })
    expect(factClaim?.sourceId).toBeUndefined()
    expect(result.itineraryFactEvidenceDiagnostics).toMatchObject({ requestedCount: 1, autoBoundCount: 0, rejectedCount: 1 })
  })

  it('无障碍事实可以持久化并使用明确的界面标签', () => {
    expect(isItineraryFactClaim({
      id: 'accessibility', type: 'accessibility', value: '卫生间位置待核验', scope: '无障碍卫生间', evidenceLevel: 'pending'
    })).toBe(true)
    expect(itineraryFactTypeLabel('accessibility')).toBe('无障碍条件')
    expect(isItineraryFactClaim({
      id: 'sunset', type: 'sunset', value: '日落时间待核验', scope: '2026-09-22', evidenceLevel: 'pending'
    })).toBe(true)
    expect(itineraryFactTypeLabel('photography-rules')).toBe('拍摄规定')
  })

  it('行程草案保留固定结构并限制重复说明体积', () => {
    const definition = itineraryProposalDefinitionForBudget({ budgetRequested: false, detailedItineraryRequested: true })
    const properties = definition.function.parameters.properties as Record<string, unknown>
    const plan = properties.plan as { type?: string; properties?: Record<string, unknown> }
    const planProperties = plan.properties ?? {}
    const days = planProperties.days as { maxItems?: number; items?: { properties?: Record<string, unknown> } }
    const dayProperties = days.items?.properties ?? {}
    const stops = dayProperties.stops as {
      items?: { required?: string[]; properties?: Record<string, unknown> }
    }
    const stopProperties = stops.items?.properties ?? {}
    const scheduleBlocks = dayProperties.schedule_blocks as { maxItems?: number }

    expect(plan.type).toBe('object')
    expect(properties).not.toHaveProperty('plans')
    expect(days.maxItems).toBe(7)
    expect(stops.items?.required).toEqual(['name', 'time', 'category'])
    expect((stopProperties.notes as { maxLength?: number }).maxLength).toBe(240)
    expect((stopProperties.transit_to_next as { maxLength?: number }).maxLength).toBe(180)
    expect((stopProperties.source_ids as { maxItems?: number }).maxItems).toBe(3)
    expect((stopProperties.fact_claims as { maxItems?: number }).maxItems).toBe(8)
    expect(scheduleBlocks.maxItems).toBe(5)
  })

  it('体力细节不写入 schema；执行端调整后以 warning 回传', async () => {
    const definition = itineraryProposalDefinitionForBudget({
      budgetRequested: false,
      tripBrief: { ...EMPTY_BRIEF, pace: '暴走' }
    })

    expect(definition.function.description).not.toContain('暴走')
    const result = await itineraryProposalTool.execute({ plan: {
      title: '北京三处游览', summary: '按顺序游览。', tradeoffs: '',
      days: [{ day_number: 1, date: '2026-09-22', title: '北京', stops: [
        { name: '地点一', area: '北京', time: '09:00–10:00', duration_minutes: 60, category: '景点' },
        { name: '地点二', area: '北京', time: '11:00–12:00', duration_minutes: 60, category: '景点' },
        { name: '地点三', area: '北京', time: '14:00–15:00', duration_minutes: 60, category: '景点' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      tripBrief: { ...EMPTY_BRIEF, destination: '北京', startDate: '2026-09-22', endDate: '2026-09-22', pace: '暴走' }
    })
    expect(result.itineraryOptions?.[0]?.days[0]?.scheduleBlocks.some((block) => block.kind === 'buffer')).toBe(true)
    expect(result.feedback?.some((item) => item.severity === 'warning' && item.code === 'candidate_normalized')).toBe(true)
  })

  it('用户要求核验事实时只提交有来源的声明，pending 由执行端补齐', () => {
    const definition = itineraryProposalDefinitionForBudget({
      budgetRequested: false,
      detailedItineraryRequested: true,
      openingHoursDetailsRequested: true,
      bookingDetailsRequested: true
    })
    const root = definition.function.parameters.properties as Record<string, unknown>
    const plan = root.plan as { properties?: Record<string, unknown> }
    const planProperties = plan.properties ?? {}
    const days = planProperties.days as { items?: { properties?: Record<string, unknown> } }
    const dayProperties = days.items?.properties ?? {}
    const stops = dayProperties.stops as { items?: { required?: string[]; properties?: Record<string, unknown> } }
    const factClaims = stops.items?.properties?.fact_claims as { description?: string; minItems?: number }

    expect(stops.items?.required).not.toContain('fact_claims')
    expect(factClaims.minItems).toBeUndefined()
    expect(factClaims.description).not.toContain('首稿不要提交这些类型')
    expect(definition.function.description).toContain('error、warning 或 info')
  })

  it('模型省略无证据声明时仍为要求核验的景点补入结构化 pending', async () => {
    const plan = rawPlan('北京人文行程', '2026-09-22', [], '北京', '', '故宫博物院')
    const day = (plan.days as Array<{ stops: Array<Record<string, unknown>> }>)[0]!
    delete day.stops[0]!.fact_claims

    const result = await itineraryProposalTool.execute({ plan }, {
      amapKey: null,
      researchCompleted: true,
      tripBrief: { ...EMPTY_BRIEF, destination: '北京', startDate: '2026-09-22', endDate: '2026-09-22' },
      openingHoursDetailsRequested: true,
      bookingDetailsRequested: true,
      ticketPriceDetailsRequested: true,
      sourceIds: [], availableSources: []
    })
    const claims = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims ?? []

    expect(claims.map((item) => `${item.type}:${item.evidenceLevel}`).sort()).toEqual([
      'booking:pending', 'opening-hours:pending', 'ticket-price:pending'
    ])
  })

  it('用户单独要求票价时 schema 仍允许提交事实，缺口由工具反馈指出', () => {
    const definition = itineraryProposalDefinitionForBudget({
      budgetRequested: false,
      detailedItineraryRequested: true,
      ticketPriceDetailsRequested: true
    })
    expect(definition.function.description).toContain('error、warning 或 info')
    const root = definition.function.parameters.properties as Record<string, unknown>
    const plan = root.plan as { properties: Record<string, unknown> }
    const days = plan.properties.days as { items: { properties: Record<string, unknown> } }
    const stops = days.items.properties.stops as { items: { properties: Record<string, unknown> } }
    const claims = stops.items.properties.fact_claims as {
      items: { properties: { type: { enum: string[] } } }
    }
    expect(claims.items.properties.type.enum).toContain('ticket-price')
  })

  it('未要求开放或预约核对时不增加事实字段硬门槛', () => {
    const definition = itineraryProposalDefinitionForBudget({ budgetRequested: false, detailedItineraryRequested: true })
    const root = definition.function.parameters.properties as Record<string, unknown>
    const plan = root.plan as { properties?: Record<string, unknown> }
    const planProperties = plan.properties ?? {}
    const days = planProperties.days as { items?: { properties?: Record<string, unknown> } }
    const dayProperties = days.items?.properties ?? {}
    const stops = dayProperties.stops as { items?: { required?: string[] } }

    expect(stops.items?.required).not.toContain('fact_claims')
  })

  it('要求开放和预约信息时，指出无直接来源的景点事实', () => {
    const plan = option([stop('故宫', [
      claim('hours', 'opening-hours', 'pending'),
      claim('booking', 'booking', 'pending')
    ])])

    expect(itineraryFactEvidenceFeedback([plan], { openingHours: true, booking: true })).toEqual([
      '方案1 2026-09-22 故宫：开放/闭馆、预约/购票事实缺少直接来源'
    ])
  })

  it('单独要求票价时，指出缺少直接来源的票价事实', () => {
    const plan = option([stop('故宫', [claim('price', 'ticket-price', 'pending')])])

    expect(itineraryFactEvidenceFeedback([plan], { openingHours: false, booking: false, ticketPrice: true })).toEqual([
      '方案1 2026-09-22 故宫：票价事实缺少直接来源'
    ])
  })

  it('只把带来源 ID 的 sourced 声明视为已核实', () => {
    const plan = option([stop('故宫', [
      claim('hours', 'opening-hours', 'sourced', 'source-hours'),
      claim('booking', 'booking', 'sourced')
    ])])

    expect(itineraryFactEvidenceFeedback([plan], { openingHours: true, booking: true })).toEqual([
      '方案1 2026-09-22 故宫：预约/购票事实缺少直接来源'
    ])
  })

  it('单份方案中不同日期的同名地点分别核验', () => {
    const first = option([stop('故宫', [claim('hours', 'opening-hours', 'pending')])], '2026-09-22')
    const second = option([stop('故宫', [claim('hours', 'opening-hours', 'pending')])], '2026-09-23')
    const plan = { ...first, days: [first.days[0]!, { ...second.days[0]!, dayNumber: 2 }] }

    expect(itineraryFactEvidenceFeedback([plan], { openingHours: true, booking: false })).toEqual([
      '方案1 2026-09-22 故宫：开放/闭馆事实缺少直接来源',
      '方案1 2026-09-23 故宫：开放/闭馆事实缺少直接来源'
    ])
  })

  it('不把搜索摘要当作景点事实原文', async () => {
    const source = createSource('故宫开放公告', 'https://example.com/palace-hours', 'Exa 搜索结果', 'web', '故宫于指定日期开放。')
    const fact = (evidence: 'sourced' | 'pending', sourceId: string | null) => ({
      type: 'opening-hours', value: '08:30 至 17:00', scope: '2026-09-22', evidence_level: evidence, source_id: sourceId
    })
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [fact('sourced', source.id)])], [source])
    const factClaim = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]
    expect(factClaim).toMatchObject({ evidenceLevel: 'pending', sourceId: source.id, value: '具体开放时段待核验' })
    expect(result.itineraryOptions?.[0]?.tradeoffs).toBe('具体规则以来源为准。')
  })

  it('唯一匹配的网页正文只关联到待核验事实，不自动提升证据状态', async () => {
    const source = createSource(
      '故宫开放与预约须知', 'https://example.com/palace-rules', 'Firecrawl 网页正文', 'web',
      '故宫通常营业时间为08:30至17:00。参观需要提前预约。'
    )
    source.contentLevel = 'page'
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [
      { type: 'opening-hours', value: '具体开放时段待核验', scope: '2026-09-22', evidence_level: 'pending', source_id: null },
      { type: 'booking', value: '预约规则待核验', scope: '2026-09-22', evidence_level: 'pending', source_id: null }
    ])], [source])
    const facts = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims ?? []

    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'opening-hours', evidenceLevel: 'pending', sourceId: source.id, value: '具体开放时段待核验' }),
      expect.objectContaining({ type: 'booking', evidenceLevel: 'pending', sourceId: source.id, value: '预约规则待核验' })
    ]))
  })

  it('把预约要求转交其他须知的原文不能作为预约规则直证', async () => {
    const source = createSource(
      '故宫博物院参观须知', 'https://example.com/palace-rules', '官方网页正文', 'web',
      '故宫博物院开放时间和预约要求以参观须知为准。'
    )
    source.contentLevel = 'page'
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'booking', value: '预约要求以参观须知为准', scope: '2026-09-22',
      evidence_level: 'sourced', source_id: source.id
    }], '东城', '', '故宫博物院')], [source])
    const claim = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.find((item) => item.type === 'booking')

    expect(claim).toMatchObject({
      evidenceLevel: 'pending', value: '预约规则待核验', sourceId: source.id
    })
  })

  it('正文候选不唯一时不自动选来源', async () => {
    const sources = [
      createSource('故宫参观指南', 'https://example.com/palace-a', 'Firecrawl 网页正文', 'web', '故宫开放时间为08:30至17:00。'),
      createSource('故宫开放公告', 'https://example.com/palace-b', 'Firecrawl 网页正文', 'web', '故宫开放时间为09:00至16:00。')
    ]
    for (const source of sources) source.contentLevel = 'page'
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [
      { type: 'opening-hours', value: '具体开放时段待核验', scope: '2026-09-22', evidence_level: 'pending', source_id: null }
    ])], sources)
    const fact = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.find((item) => item.type === 'opening-hours')

    expect(fact).toMatchObject({ evidenceLevel: 'pending', value: '具体开放时段待核验' })
    expect(fact?.sourceId).toBeUndefined()
  })

  it('搜索摘要与社区正文不作为动态事实的自动关联来源', async () => {
    const snippet = createSource('故宫开放时间', 'https://example.com/palace-snippet', '搜索结果', 'web', '故宫开放时间每日不同。')
    const community = createSource('故宫游览笔记', 'https://example.com/palace-community', 'Firecrawl 网页正文', 'web', '故宫开放时间与预约信息。')
    community.contentLevel = 'page'
    community.sourceNature = 'community-platform'
    const visualClue = createSource('图像线索 · 故宫游览笔记', 'https://example.com/palace-visual', 'Tripwise 视觉读取', 'web', '模型识别出故宫开放时间与预约信息。')
    visualClue.contentLevel = 'visual-clue'
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [
      { type: 'opening-hours', value: '具体开放时段待核验', scope: '2026-09-22', evidence_level: 'pending', source_id: null }
    ])], [snippet, community, visualClue])
    const fact = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.find((item) => item.type === 'opening-hours')

    expect(fact).toMatchObject({ evidenceLevel: 'pending', value: '具体开放时段待核验' })
    expect(fact?.sourceId).toBeUndefined()
    expect(isSource(visualClue)).toBe(true)

    const directClaim = await runProposal([rawPlan('北京行程', '2026-09-22', [
      { type: 'opening-hours', value: '08:30 至 17:00', scope: '2026-09-22', evidence_level: 'sourced', source_id: visualClue.id }
    ])], [visualClue])
    expect(directClaim.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0])
      .toMatchObject({ evidenceLevel: 'pending', value: '具体开放时段待核验' })
  })

  it('用户要求核验摄影时段与拍摄限制时，将其保留为逐地点结构化事实', async () => {
    const plan = rawPlan('重庆夜景行程', '2026-11-05', [], '渝中', '日落约18:03；观景台禁止使用三脚架。')
    plan.summary = '日落时间约18:03，观景台禁止使用三脚架。'
    const day = (plan.days as Array<{ stops: Array<Record<string, unknown>> }>)[0]!
    day.stops[0]!.time = '18:00'
    const result = await itineraryProposalTool.execute({ plan }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '请安排日落时段摄影，日落时间和拍摄限制都要核验。'
    })
    const stop = result.itineraryOptions?.[0]?.days[0]?.stops[0]
    const facts = stop?.factClaims ?? []

    expect(result.itineraryOptions?.[0]?.summary).not.toContain('18:03')
    expect(result.itineraryOptions?.[0]?.summary).not.toContain('禁止使用三脚架')
    expect(stop?.notes).not.toContain('18:03')
    expect(stop?.notes).toContain('日出日落时间待核验')
    expect(facts.filter((fact) => fact.type === 'sunset')).toHaveLength(1)
    expect(facts.filter((fact) => fact.type === 'photography-rules')).toHaveLength(1)
    expect(facts.every((fact) => fact.evidenceLevel === 'pending')).toBe(true)
  })

  it('景观照明时刻缺少正文来源时不保留具体时间', async () => {
    const result = await itineraryProposalTool.execute({ plan: rawPlan(
      '重庆夜景行程', '2026-11-05', [], '渝中', '洪崖洞景观灯饰参考18:30-23:00。'
    ) }, { amapKey: null, researchCompleted: true })
    const stop = result.itineraryOptions?.[0]?.days[0]?.stops[0]

    expect(stop?.notes).toContain('景观照明时间待核验')
    expect(stop?.notes).not.toMatch(/18:30|23:00/u)
    expect(stop?.factClaims).toContainEqual(expect.objectContaining({ type: 'opening-hours', evidenceLevel: 'pending' }))
  })

  it.each([
    '展览可延长至20:30（停止入馆时间待核验）。',
    '场馆开放至20:30。',
    '展厅营业至20:30。'
  ])('开放规则待核验时，移除“%s”中的具体时刻', async (note) => {
    const result = await itineraryProposalTool.execute({ plan: rawPlan(
      '成都行程', '2026-11-06', [], '市中心', `周五下午到馆可错峰；${note}`
    ) }, { amapKey: null, researchCompleted: true })
    const stop = result.itineraryOptions?.[0]?.days[0]?.stops[0]

    expect(stop?.notes).toContain('开放时段待核验')
    expect(stop?.notes).not.toContain('20:30')
    expect(stop?.factClaims).toContainEqual(expect.objectContaining({ type: 'opening-hours', evidenceLevel: 'pending' }))
  })

  it('日落与拍摄规定只有关联正文来源后才可标为已核实', async () => {
    const source = createSource(
      '重庆观景台日落与拍摄须知', 'https://example.com/chongqing-viewing-rules', 'Firecrawl 网页正文', 'web',
      '2026-11-05 重庆日落时间为 18:03。观景台允许手持摄影，禁止使用三脚架。'
    )
    source.contentLevel = 'page'
    const facts = [
      { type: 'sunset', value: '重庆日落时间为 18:03', scope: '2026-11-05', evidence_level: 'sourced', source_id: source.id },
      { type: 'photography-rules', value: '允许手持摄影，禁止使用三脚架', scope: '观景台规则', evidence_level: 'sourced', source_id: source.id }
    ]
    const result = await runProposal([rawPlan('重庆夜景行程', '2026-11-05', facts, '渝中', '', '重庆观景台')], [source], {
      openingHoursDetailsRequested: false, bookingDetailsRequested: false
    })
    const claims = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims ?? []

    expect(claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'sunset', evidenceLevel: 'sourced', sourceId: source.id }),
      expect.objectContaining({ type: 'photography-rules', evidenceLevel: 'sourced', sourceId: source.id })
    ]))
  })

  it('结构化天气事实采用来源中的精确日落时刻，不保留附加模型结论', async () => {
    const weather = createSource(
      '逐日天气：上海', 'https://open-meteo.com/en/docs', 'Open-Meteo', 'weather',
      '上海逐日预报：\n2026-11-05：多云，日出 06:12，日落 17:02'
    )
    weather.contentLevel = 'structured'
    const sourcedPlan = rawPlan('上海夜景行程', '2026-11-05', [{
      type: 'sunset', value: '日落 17:02；建议 15:30 就位并可看亮灯夜景。', scope: '2026-11-05',
      evidence_level: 'sourced', source_id: weather.id
    }], '上海')
    const sourcedResult = await runProposal([sourcedPlan], [weather], {
      openingHoursDetailsRequested: false, bookingDetailsRequested: false
    })
    const sourcedFact = sourcedResult.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.find((fact) => fact.type === 'sunset')

    expect(sourcedFact).toMatchObject({
      value: '日落 17:02', evidenceLevel: 'sourced', sourceId: weather.id
    })

    const mismatchedPlan = rawPlan('上海夜景行程', '2026-11-05', [{
      type: 'sunset', value: '日落 17:03', scope: '2026-11-05',
      evidence_level: 'sourced', source_id: weather.id
    }], '上海')
    const mismatchedResult = await runProposal([mismatchedPlan], [weather], {
      openingHoursDetailsRequested: false, bookingDetailsRequested: false
    })
    const mismatchedFact = mismatchedResult.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.find((fact) => fact.type === 'sunset')

    expect(mismatchedFact).toMatchObject({ value: '日出日落时间待核验', evidenceLevel: 'pending' })
    expect(mismatchedFact?.sourceId).toBe(weather.id)
  })

  it('明确要求预算与省时对比时，将两个可执行做法汇总到方案取舍', async () => {
    const plan = rawPlan('上海三日行程', '2026-11-05', [], '上海',
      '预算友好选二球基础票；省时可提前线上购票减少现场排队。')
    plan.tradeoffs = '按用户偏好安排。'
    const result = await itineraryProposalTool.execute({ plan }, {
      amapKey: null,
      researchCompleted: true,
      budgetRequested: true,
      userRequest: '请在同一份方案中对比预算友好与省时间的做法。'
    })
    const tradeoffs = result.itineraryOptions?.[0]?.tradeoffs ?? ''

    expect(tradeoffs).toContain('预算友好：选二球基础票')
    expect(tradeoffs).toContain('省时：提前线上购票')
    expect(tradeoffs).toContain('实际票价和排队时间以当天信息为准')
  })

  it('取舍没有结构化天气依据时移除降水概率，不补通用套话', async () => {
    const plan = rawPlan('重庆夜景行程', '2026-11-06', [], '重庆')
    plan.tradeoffs = '次日预报毛毛雨且降水概率约54%，夜景能见度存在不确定性。'

    const result = await runProposal([plan], [], {
      openingHoursDetailsRequested: false, bookingDetailsRequested: false
    })

    expect(result.itineraryOptions?.[0]?.tradeoffs).toBe('')
    expect(isItineraryOption(result.itineraryOptions?.[0])).toBe(true)
  })

  it('模型没有提供摘要时按主要片区生成简短兜底', async () => {
    const plan = rawPlan('北京人文行程', '2026-09-22', [], '海淀区')
    plan.summary = ''

    const result = await runProposal([plan], [], {
      openingHoursDetailsRequested: false, bookingDetailsRequested: false
    })
    const summary = result.itineraryOptions?.[0]?.summary ?? ''

    expect(summary).toContain('海淀区')
    expect(summary).not.toMatch(/\d+\s*天|\d+\s*个停靠点|顺序见下方/u)
  })

  it('轮椅行程逐地点保留入口、卫生间和接驳的无障碍核验状态', async () => {
    const plan = rawPlan('南京行程', '2026-11-05', [], '南京')
    const firstStop = ((plan.days as Array<{ stops: Array<Record<string, unknown>> }>)[0]!).stops[0]!
    firstStop.transit_to_next = '乘无台阶公交前往下一地点，具体线路待核验。'
    const day = (plan.days as Array<{ stops: Array<Record<string, unknown>> }>)[0]!
    day.stops.push({ ...firstStop, name: '午餐（店面待核验）', category: '餐饮', time: '12:00–13:00', transit_to_next: '' })
    const result = await itineraryProposalTool.execute({ plan }, {
      amapKey: null,
      researchCompleted: true,
      tripBrief: { ...EMPTY_BRIEF, constraints: '其中一人使用轮椅，需要无台阶和可用卫生间' },
      userRequest: '请安排轮椅友好的行程，入口、路线和卫生间没查到就标待核验。'
    })
    const facts = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims ?? []

    expect(facts.filter((fact) => fact.type === 'accessibility').map(({ scope, evidenceLevel }) => ({ scope, evidenceLevel }))).toEqual([
      { scope: '入口与连续轮椅通行', evidenceLevel: 'pending' },
      { scope: '无障碍卫生间', evidenceLevel: 'pending' },
      { scope: '下一段无障碍接驳', evidenceLevel: 'pending' }
    ])
    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0]?.transitToNext).not.toContain('无台阶公交')
    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0]?.transitToNext).toContain('无障碍接驳待核验')
    expect(result.itineraryOptions?.[0]?.days[0]?.stops[1]?.factClaims?.filter((fact) => fact.type === 'accessibility'))
      .toHaveLength(2)
    expect(result.itineraryOptions?.[0]?.tradeoffs).toContain('核实前不要将本方案视为轮椅可行路线')
  })

  it('将没有逐地点来源支持的无障碍名称和摘要断言改为待核验', async () => {
    const context = {
      amapKey: null,
      researchCompleted: true,
      tripBrief: { ...EMPTY_BRIEF, constraints: '其中一人使用轮椅，需要无台阶和可用卫生间' },
      userRequest: '请为轮椅使用者规划行程。'
    }
    const namedClaim = rawPlan('南京行程', '2026-11-05', [])
    namedClaim.title = '南京三日无障碍舒行'
    ;((namedClaim.days as Array<{ stops: Array<Record<string, unknown>> }>)[0]!).stops[0]!.name = '玄武湖（全园无障碍）'

    const namedResult = await itineraryProposalTool.execute({ plan: namedClaim }, context)
    expect(namedResult.itineraryOptions?.[0]?.days[0]?.stops[0]?.name).toContain('无障碍条件待核验')
    expect(namedResult.itineraryOptions?.[0]?.days[0]?.stops[0]?.name).not.toContain('全园无障碍')
    expect(namedResult.itineraryOptions?.[0]?.title).not.toContain('无障碍舒行')
    expect(namedResult.itineraryOptions?.[0]?.tradeoffs).toContain('核实前不要将本方案视为轮椅可行路线')

    const summaryClaim = rawPlan('南京行程', '2026-11-05', [])
    summaryClaim.summary = '玄武湖全园无障碍，路线适合轮椅。'
    const summaryResult = await itineraryProposalTool.execute({ plan: summaryClaim }, context)
    expect(summaryResult.itineraryOptions?.[0]?.summary).toContain('无障碍条件待核验')
    expect(summaryResult.itineraryOptions?.[0]?.summary).not.toContain('路线适合轮椅')
  })

  it('不把网页摘要或高德路线当作无障碍设施证据', async () => {
    const snippet = createSource('无障碍信息', 'https://example.com/accessibility', 'Exa 搜索结果', 'web', '场馆配有无障碍入口与卫生间。')
    const route = createSource('公共交通路线', 'https://example.com/route', '高德路线', 'route', '乘地铁约 20 分钟。')
    route.contentLevel = 'structured'
    const fact = (sourceId: string) => ({
      type: 'accessibility', value: '有无障碍入口和卫生间', scope: '入口与连续轮椅通行',
      evidence_level: 'sourced', source_id: sourceId
    })
    const plan = rawPlan('苏州行程', '2026-11-05', [fact(snippet.id)])
    const day = (plan.days as Array<{ stops: Array<Record<string, unknown>> }>)[0]!
    day.stops.push({ ...day.stops[0], name: '寒山寺', time: '13:00–14:00', duration_minutes: 60, fact_claims: [fact(route.id)] })
    const result = await runProposal([plan], [snippet, route])
    const claims = result.itineraryOptions?.[0]?.days.flatMap((day) => day.stops.flatMap((stop) => stop.factClaims ?? [])) ?? []

    expect(claims.filter((claim) => claim.type === 'accessibility')).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceLevel: 'pending', sourceId: snippet.id, value: '无障碍条件待核验' }),
      expect.objectContaining({ evidenceLevel: 'pending', sourceId: route.id, value: '无障碍条件待核验' })
    ]))
  })

  it('保留带正文内容等级的事实来源', async () => {
    const source = createSource('故宫开放公告', 'https://example.com/palace-hours', 'Firecrawl 网页正文', 'web', '故宫博物院 2026-09-22 开放时间为 08:30 至 17:00。')
    source.contentLevel = 'page'
    const fact = (evidence: 'sourced' | 'pending', sourceId: string | null) => ({
      type: 'opening-hours', value: '08:30 至 17:00', scope: '2026-09-22', evidence_level: evidence, source_id: sourceId
    })
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [fact('sourced', source.id)])], [source])
    const factClaim = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]
    expect(factClaim).toMatchObject({ evidenceLevel: 'sourced', sourceId: source.id })
  })

  it('使用明确的场馆标题和事实小节核验分行的网页内容', async () => {
    const source = createSource(
      '北京景点开放信息', 'https://example.com/beijing-hours', 'Firecrawl 网页正文', 'web',
      '## 颐和园\n## 旺季开放时间\n06:00 至 20:00\n\n## 故宫\n## 开放时间\n08:30 至 17:00'
    )
    source.contentLevel = 'page'
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '06:00 至 20:00', scope: '旺季', evidence_level: 'sourced', source_id: source.id
    }], '海淀', '', '颐和园')], [source])
    const factClaim = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]

    expect(factClaim).toMatchObject({ evidenceLevel: 'sourced', sourceId: source.id, value: '06:00 至 20:00' })
  })

  it('季节性开放时段没有日期映射时不能标成具体游览日期已核验', async () => {
    const source = createSource(
      '颐和园开放时间', 'https://example.com/summer-palace', 'Firecrawl 网页正文', 'web',
      '颐和园旺季开放时间为 06:00 至 20:00。'
    )
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = source.summary

    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '颐和园旺季开放时间为 06:00 至 20:00。',
      scope: '2026-09-22', evidence_level: 'sourced', source_id: source.id
    }], '海淀', '', '颐和园')], [source])

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]).toMatchObject({
      evidenceLevel: 'pending', value: '具体开放时段待核验', scope: '2026-09-22'
    })
  })

  it('来源标题中的发布日期不能证明开放时段适用于该日期', async () => {
    const source = createSource(
      '故宫开放公告（2026-09-22发布）', 'https://example.com/palace-hours', 'Firecrawl 网页正文', 'web',
      '故宫博物院开放时间为 08:30 至 17:00。'
    )
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = source.summary

    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '08:30 至 17:00',
      scope: '2026-09-22', evidence_level: 'sourced', source_id: source.id
    }])], [source])

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]).toMatchObject({
      evidenceLevel: 'pending', value: '具体开放时段待核验', scope: '2026-09-22'
    })
  })

  it('季节开放时段的原文区间覆盖游览日期时允许绑定该日期', async () => {
    const source = createSource(
      '颐和园开放时间', 'https://example.com/summer-palace', 'Firecrawl 网页正文', 'web',
      '颐和园旺季（4月1日至9月26日）开放时间为 06:00 至 20:00。'
    )
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = source.summary

    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '颐和园旺季（4月1日至9月26日）开放时间为 06:00 至 20:00。',
      scope: '2026-09-22', evidence_level: 'sourced', source_id: source.id
    }], '海淀', '', '颐和园')], [source])

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]).toMatchObject({
      evidenceLevel: 'sourced', sourceId: source.id, scope: '2026-09-22'
    })
  })

  it('季节开放时段支持完整数字日期区间', async () => {
    const source = createSource(
      '颐和园开放时间', 'https://example.com/summer-palace', 'Firecrawl 网页正文', 'web',
      '颐和园旺季开放时间（2026-04-01 至 2026-09-26）为 06:00 至 20:00。'
    )
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = source.summary

    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '颐和园旺季开放时间（2026-04-01 至 2026-09-26）为 06:00 至 20:00。',
      scope: '2026-09-22', evidence_level: 'sourced', source_id: source.id
    }], '海淀', '', '颐和园')], [source])

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]).toMatchObject({
      evidenceLevel: 'sourced', sourceId: source.id, scope: '2026-09-22'
    })
  })

  it('季节开放时段的原文区间不覆盖游览日期时降为待核验', async () => {
    const source = createSource(
      '颐和园开放时间', 'https://example.com/summer-palace', 'Firecrawl 网页正文', 'web',
      '颐和园旺季（4月1日至9月26日）开放时间为 06:00 至 20:00。'
    )
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = source.summary

    const result = await runProposal([rawPlan('北京行程', '2026-11-03', [{
      type: 'opening-hours', value: '颐和园旺季（4月1日至9月26日）开放时间为 06:00 至 20:00。',
      scope: '2026-11-03', evidence_level: 'sourced', source_id: source.id
    }], '海淀', '', '颐和园')], [source])

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]).toMatchObject({
      evidenceLevel: 'pending', value: '具体开放时段待核验', scope: '2026-11-03'
    })
  })

  it('售票信息标题下的票价原文可按景点小节核验', () => {
    const source = createSource(
      '北京景点参观指南', 'https://example.com/beijing-tickets', 'Firecrawl 网页正文', 'web',
      '## 故宫博物院\n### 售票信息\n成人票：60 元。'
    )
    source.contentLevel = 'page'

    expect(sourceDirectlySupportsStopFact('ticket-price', source, '故宫博物院', '成人票：60 元。')).toBe(true)
  })

  it('切换到其他场馆标题后不继承前一地点的事实上下文', async () => {
    const source = createSource(
      '北京景点开放信息', 'https://example.com/beijing-hours', 'Firecrawl 网页正文', 'web', '## 颐和园\n## 旺季开放时间\n06:00 至 20:00\n\n## 故宫\n## 开放时间\n08:30 至 17:00'
    )
    source.contentLevel = 'page'
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '08:30 至 17:00', scope: '2026-09-22', evidence_level: 'sourced', source_id: source.id
    }], '海淀', '', '颐和园')], [source])
    const factClaim = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]

    expect(factClaim).toMatchObject({ evidenceLevel: 'pending', sourceId: source.id, value: '具体开放时段待核验' })
  })

  it('不把其他景点的正文绑定为当前地点的事实来源', async () => {
    const source = createSource('颐和园开放时间', 'https://example.com/summer-palace', 'Firecrawl 网页正文', 'web', '颐和园旺季开放时间为 06:00 至 20:00。')
    source.contentLevel = 'page'
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '08:30 至 17:00', scope: '2026-09-22', evidence_level: 'sourced', source_id: source.id
    }])], [source])
    const factClaim = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]

    expect(factClaim).toMatchObject({
      type: 'opening-hours', evidenceLevel: 'pending', value: '具体开放时段待核验'
    })
    expect(factClaim?.sourceId).toBeUndefined()
  })

  it('来源提到同一地点但时间值不符时降级为待核验', async () => {
    const source = createSource('故宫开放公告', 'https://example.com/palace-hours', 'Firecrawl 网页正文', 'web', '故宫博物院开放时间为 08:30 至 17:00。')
    source.contentLevel = 'page'
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [{
      type: 'opening-hours', value: '09:00 至 18:00', scope: '2026-09-22', evidence_level: 'sourced', source_id: source.id
    }])], [source])
    const factClaim = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]

    expect(factClaim).toMatchObject({
      type: 'opening-hours', evidenceLevel: 'pending', sourceId: source.id, value: '具体开放时段待核验'
    })
  })

  it('只记录事实来源拒绝计数，并区分地点不匹配与事实值不匹配', async () => {
    const source = createSource(
      '故宫博物院开放公告', 'https://example.com/palace-hours', '网页正文', 'web',
      '故宫博物院 2026 年 10 月 27 日开放时间为 08:30 至 17:00。'
    )
    source.contentLevel = 'page'
    const firstFact = {
      type: 'opening-hours', value: '09:00 至 18:00', scope: '2026-09-22',
      evidence_level: 'sourced', source_id: source.id
    }
    const secondFact = { ...firstFact, value: '08:30 至 17:00' }
    const plan = rawPlan('北京行程', '2026-09-22', [firstFact], '东城', '', '故宫博物院')
    const day = (plan.days as Array<{ stops: Array<Record<string, unknown>> }>)[0]!
    day.stops.push({
      ...day.stops[0]!, name: '颐和园', time: '13:00–15:00', duration_minutes: 120,
      fact_claims: [secondFact]
    })

    const result = await runProposal([plan], [source])
    const diagnostics = result.itineraryFactEvidenceDiagnostics

    expect(diagnostics).toEqual({
      requestedCount: 2, autoBoundCount: 0, rejectedCount: 2,
      sourceUnavailableCount: 0, sourceIneligibleCount: 0,
      placeMismatchCount: 1, scopeMismatchCount: 0, valueMismatchCount: 1,
      rejectedByType: { 'opening-hours': 2 }
    })
    expect(JSON.stringify(diagnostics)).not.toMatch(/故宫|颐和园|08:30|09:00/u)
    expect(result.output).toContain('故宫博物院·营业时间：正文未支持所填事实值')
    expect(result.output).toContain('事实值必须复制对应 source_id 正文中的连续原文片段')
    expect(result.output).toContain('颐和园·营业时间：正文未直接提到该地点')
    expect(result.output).not.toMatch(/08:30|09:00/u)
    expect(result.itineraryOptions?.[0]?.days[0]?.stops.map((stop) => stop.factClaims?.[0]?.evidenceLevel))
      .toEqual(['pending', 'pending'])
  })

  it('开放时间待核验时清除备注中的具体停止入场时刻', async () => {
    const source = createSource('艺圃开放信息', 'https://example.com/yipu', 'Exa 搜索结果', 'web', '艺圃开放时间信息摘要。')
    const result = await runProposal([rawPlan('苏州行程', '2026-11-05', [{
      type: 'opening-hours', value: '16:30停止入场', scope: '2026-11-05', evidence_level: 'sourced', source_id: source.id
    }], '苏州', '务必在16:30停止入场前入园。')], [source])
    const stop = result.itineraryOptions?.[0]?.days[0]?.stops[0]

    expect(stop?.factClaims?.[0]).toMatchObject({ evidenceLevel: 'pending', value: '具体开放时段待核验' })
    expect(stop?.notes).toContain('停止入场时间待核验')
    expect(stop?.notes).not.toContain('16:30')
  })

  it('无直接来源时将正常开放与每周闭园断言改为待核验', async () => {
    const result = await runProposal([rawPlan(
      '上海行程', '2026-11-05', [], '上海', '开放时间待核验，但当日正常开放；每周一闭园，法定节假日除外。'
    )], [])
    const stop = result.itineraryOptions?.[0]?.days[0]?.stops[0]

    expect(stop?.notes).toContain('开放时间待核验')
    expect(stop?.notes).not.toContain('正常开放')
    expect(stop?.notes).not.toContain('每周一闭园')
    expect(stop?.notes).toContain('开放与闭馆规则待核验')
    expect(stop?.factClaims).toContainEqual(expect.objectContaining({
      type: 'opening-hours', value: '具体开放时段待核验', evidenceLevel: 'pending'
    }))
  })

  it('地点名称不夹带未核实的免费状态或票价', async () => {
    const result = await runProposal([rawPlan(
      '上海行程', '2026-11-05', [], '上海', '', '外滩观景平台（免费¥0）'
    )], [])

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0]?.name).toBe('外滩观景平台')
  })

  it('预约规则无直接来源时将备注断言改为待核验并生成结构化事实', async () => {
    const result = await runProposal([rawPlan(
      '苏州行程', '2026-11-05', [], '苏州', '同样需预约购票，入园时段以实际预约为准。'
    )], [])
    const stop = result.itineraryOptions?.[0]?.days[0]?.stops[0]

    expect(stop?.notes).toContain('预约规则待核验')
    expect(stop?.notes).toContain('入园时段待核验')
    expect(stop?.notes).not.toContain('需预约购票')
    expect(stop?.factClaims).toContainEqual(expect.objectContaining({
      type: 'booking', value: '预约规则待核验', evidenceLevel: 'pending'
    }))
  })

  it('开放时段范围、入馆钟点和未经核实的预约容量数字不能留在备注', async () => {
    const result = await runProposal([rawPlan(
      '成都行程', '2026-11-05', [
        { type: 'booking', value: '预约规则待核验', scope: '2026-11-05', evidence_level: 'pending' }
      ], '成都', '上午票 8:00-12:00入园；9:00-18:00开放，17:00停止入馆；每日预约与客流待核验 20000 人。', '成都博物馆'
    )], [], { openingHoursDetailsRequested: false, bookingDetailsRequested: false })
    const stop = result.itineraryOptions?.[0]?.days[0]?.stops[0]

    expect(stop?.notes).not.toMatch(/8:00|12:00|9:00|18:00|17:00|20000/u)
    expect(stop?.notes).toContain('入园时间待核验')
    expect(stop?.notes).toContain('开放时间待核验')
    expect(stop?.notes).toContain('入馆时间待核验')
    expect(stop?.notes).toContain('预约与客流待核验')
    expect(stop?.factClaims).toContainEqual(expect.objectContaining({
      type: 'opening-hours', evidenceLevel: 'pending'
    }))
  })

  it('票价、免费/客流、抢约和闭城时间缺少直接证据时不留在地点备注', async () => {
    const source = createSource('西安景点票务信息', 'https://example.com/xian-tickets', 'Exa 搜索结果', 'web', '景点票务信息摘要，详情以官方发布为准。')
    const result = await runProposal([{
      title: '西安预算行程', summary: '按三日安排。', tradeoffs: '费用待核验。',
      days: [{ day_number: 1, date: '2026-11-05', title: '西安人文', stops: [
        {
          name: '西安碑林博物馆', area: '书院门', time: '09:00', duration_minutes: 120, category: '景点',
          notes: '未知费用提示：全票85元，为本行程票价最高一项；若预算紧张可在馆外参观取舍。',
          fact_claims: [{ type: 'ticket-price', value: '全票85元', scope: '现行', evidence_level: 'sourced', source_id: source.id }]
        },
        {
          name: '西安城墙', area: '永宁门', time: '12:00', duration_minutes: 120, category: '景点',
          notes: '登城门票30元；11月约20:00闭城。',
          fact_claims: [{ type: 'ticket-price', value: '门票30元', scope: '现行', evidence_level: 'pending' }]
        },
        {
          name: '陕西历史博物馆', area: '小寨', time: '15:00', duration_minutes: 120, category: '景点',
          notes: '免费但票紧张，务必提前在微信公众号抢约，预约规则待核验。',
          fact_claims: [{ type: 'ticket-price', value: '免费', scope: '现行', evidence_level: 'pending' }, { type: 'booking', value: '预约规则待核验', scope: '现行', evidence_level: 'pending' }]
        },
        {
          name: '大兴善寺', area: '小寨', time: '18:00', duration_minutes: 60, category: '景点',
          notes: '免费且人少，与陕历博同片区顺路。',
          fact_claims: [{ type: 'ticket-price', value: '具体票价待核验', scope: '现行', evidence_level: 'pending' }]
        }
      ]}]
    }], [source], { openingHoursDetailsRequested: false, bookingDetailsRequested: false })
    const stops = result.itineraryOptions?.[0]?.days[0]?.stops ?? []
    const notes = stops.map((stop) => stop.notes).join('\n')

    expect(notes).not.toMatch(/85元|30元|票价最高|免费|票紧张|抢约|20:00|人少/u)
    expect(notes).toContain('预约规则待核验')
    expect(notes).toContain('客流待核验')
    expect(stops[0]?.notes).toContain('若预算紧张可在馆外参观取舍')
    expect(stops[1]?.notes).toContain('闭城时间待核验')
    expect(stops[0]?.factClaims).toContainEqual(expect.objectContaining({ type: 'ticket-price', evidenceLevel: 'pending' }))
    expect(stops[1]?.factClaims).toContainEqual(expect.objectContaining({ type: 'opening-hours', evidenceLevel: 'pending' }))
  })

  it('移除未核实费用句时保留独立建议，不拼接出残句', async () => {
    const result = await runProposal([rawPlan(
      '上海行程', '2026-11-05', [], '黄浦区', '免费开放的沿岸，正常开放，票价未在本次官方来源查到；11月上旬约17:01日落（气象来源），适合散步。', '外滩'
    )], [])
    const stop = result.itineraryOptions?.[0]?.days[0]?.stops[0]

    expect(stop?.notes).toBe('开放与闭馆规则待核验；日出日落时间待核验；适合散步。')
    expect(stop?.notes).not.toMatch(/免费|费用状态|待核验岸线|17:01|票价未在|气象来源/u)
    expect(stop?.factClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'ticket-price', evidenceLevel: 'pending' }),
      expect.objectContaining({ type: 'opening-hours', evidenceLevel: 'pending' }),
      expect.objectContaining({ type: 'sunset', evidenceLevel: 'pending' })
    ]))
  })

  it('保留正文来源支持的具体票价', async () => {
    const source = createSource('西安碑林票务公告', 'https://example.com/beilin-ticket', 'Firecrawl 网页正文', 'web', '西安碑林博物馆成人票 85 元。')
    source.contentLevel = 'page'
    const result = await runProposal([rawPlan('西安行程', '2026-11-05', [{
      type: 'ticket-price', value: '成人票85元', scope: '现行票价', evidence_level: 'sourced', source_id: source.id
    }], '西安', '成人门票85元；具体以官方页面为准。', '西安碑林博物馆')], [source], {
      openingHoursDetailsRequested: false, bookingDetailsRequested: false
    })
    const stop = result.itineraryOptions?.[0]?.days[0]?.stops[0]

    expect(stop?.notes).toContain('85元')
    expect(stop?.factClaims?.[0]).toMatchObject({ type: 'ticket-price', evidenceLevel: 'sourced', sourceId: source.id })
  })

  it('使用独立的限长正文摘录核验摘要 800 字以后的事实', async () => {
    const pageText = `${'访客须知，请按现场安排参观。'.repeat(100)}故宫博物院 2026-09-22 开放时间为 08:30 至 17:00。`
    const source = createSource('故宫博物院参观须知', 'https://example.com/palace-hours', 'Firecrawl 网页正文', 'web', pageText)
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = pageText
    const fact = {
      type: 'opening-hours', value: '08:30 至 17:00', scope: '2026-09-22', evidence_level: 'sourced', source_id: source.id
    }
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [fact])], [source])
    const stored = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]

    expect(source.summary).not.toContain('08:30')
    expect(source.factEvidenceExcerpt).toContain('08:30 至 17:00')
    expect(stored).toMatchObject({ type: 'opening-hours', evidenceLevel: 'sourced', sourceId: source.id })
    expect(isSource(source)).toBe(true)
    expect(isSource({ ...source, factEvidenceExcerpt: '正文'.repeat(1_201) })).toBe(false)
  })

  it('按相邻端点、交通方式和当天查询时刻绑定已成功查询的路线', async () => {
    const source = createSource(
      '南普陀寺（思明南路515号） → 厦门大学（思明校区）（思明南路422号）',
      'https://ditu.amap.com/search?query=route',
      '高德地图路线规划',
      'route',
      '南普陀寺 → 厦门大学（思明校区），公共交通（2026-09-22 10:00）估算：\n方案 1：约 12 分钟 · 850 m\n方案 2：约 15 分钟 · 1.1 km'
    )
    const plan = {
      title: '厦门行程', summary: '按日期安排。', tradeoffs: '交通按来源估算。',
      days: [{
        day_number: 1, date: '2026-09-22', title: '南普陀与厦大',
        stops: [
          {
            name: '南普陀寺', area: '思明区', time: '09:00–10:00', duration_minutes: 60,
            category: '景点', notes: '', transit_to_next: '公共交通前往厦门大学（思明校区），耗时待核验。',
            source_ids: [], fact_claims: []
          },
          {
            name: '厦门大学（思明校区）', area: '思明区', time: '10:30–12:00', duration_minutes: 90,
            category: '景点', notes: '', transit_to_next: '', source_ids: [], fact_claims: []
          }
        ]
      }]
    }

    const result = await itineraryProposalTool.execute({ plan }, {
      amapKey: null, researchCompleted: true, sourceIds: [source.id], availableSources: [source]
    })
    const from = result.itineraryOptions?.[0]?.days[0]?.stops[0]

    expect(from?.transitEstimate).toMatchObject({
      sourceId: source.id, destinationStopId: result.itineraryOptions?.[0]?.days[0]?.stops[1]?.id,
      mode: 'transit', optionNumber: 1, queryDate: '2026-09-22', queryTime: '10-00',
      durationMinutes: 12, distanceMeters: 850
    })
    expect(from?.sourceIds).toContain(source.id)
    expect(from?.factClaims).toContainEqual(expect.objectContaining({
      type: 'transport-time', value: expect.stringContaining('12 分钟'), evidenceLevel: 'sourced', sourceId: source.id
    }))
    expect(from?.transitToNext).toContain('估算约 12 分钟')
    expect(from?.transitToNext).toContain('当天核对')
  })

  it('以 warning 回传成功路线耗时冲突并保留可审阅候选', async () => {
    const route = createSource(
      '重庆十八梯传统风貌区 → 长江索道北站',
      'https://ditu.amap.com/search?query=route',
      '高德地图路线规划',
      'route',
      '重庆十八梯传统风貌区 → 长江索道北站，公共交通（2026-11-06 12:00）估算：\n方案 1：约 67 分钟 · 8.7 公里'
    )
    route.contentLevel = 'structured'
    const plan = {
      title: '重庆行程', summary: '按日期安排。', tradeoffs: '路线按来源估算。',
      days: [{
        day_number: 1, date: '2026-11-06', title: '十八梯与索道', stops: [
          { name: '重庆十八梯传统风貌区', area: '渝中', time: '10:00–12:00', duration_minutes: 120, category: '景点', transit_to_next: '公共交通前往长江索道北站，耗时待核验。' },
          { name: '长江索道北站', area: '渝中', time: '12:40–13:40', duration_minutes: 60, category: '景点', transit_to_next: '' }
        ]
      }]
    }

    const result = await itineraryProposalTool.execute({ plan }, {
      amapKey: null, researchCompleted: true, sourceIds: [route.id], availableSources: [route],
      tripBrief: { ...EMPTY_BRIEF, startDate: '2026-11-06', endDate: '2026-11-06' }
    })
    expect(result.itineraryOptions).toHaveLength(1)
    expect(result.feedback).toContainEqual(expect.objectContaining({
      severity: 'warning', code: 'plan_content_needs_review', message: expect.stringMatching(/还需约 67 分钟通勤.*只留了 40 分钟/u)
    }))
  })

  it('不把查询日期不匹配的路线结果绑定到当日行程', async () => {
    const source = createSource(
      '南普陀寺 → 厦门大学',
      'https://ditu.amap.com/search?query=route',
      '高德地图路线规划',
      'route',
      '南普陀寺 → 厦门大学，公共交通（2026-09-21 09:00）估算：\n方案 1：约 12 分钟 · 850 m'
    )
    const plan = {
      title: '厦门行程', summary: '按日期安排。', tradeoffs: '交通待核验。',
      days: [{
        day_number: 1, date: '2026-09-22', title: '南普陀与厦大',
        stops: [
          { name: '南普陀寺', area: '思明区', time: '09:00–10:00', category: '景点', transit_to_next: '公共交通前往厦门大学，耗时待核验。' },
          { name: '厦门大学', area: '思明区', time: '10:30–12:00', category: '景点', transit_to_next: '' }
        ]
      }]
    }

    const result = await itineraryProposalTool.execute({ plan }, {
      amapKey: null, researchCompleted: true, sourceIds: [source.id], availableSources: [source]
    })
    const from = result.itineraryOptions?.[0]?.days[0]?.stops[0]

    expect(from?.transitEstimate).toBeUndefined()
    expect(from?.sourceIds).not.toContain(source.id)
    expect(from?.transitToNext).toContain('待核验')
  })

  it('不接受结构化天气来源作为景点开放时间依据', async () => {
    const source = createSource('逐日天气：北京', 'https://example.com/weather', '测试天气', 'weather', '晴，最高 20℃。')
    const fact = {
      type: 'opening-hours', value: '每日 08:30 至 17:00', scope: '每日', evidence_level: 'sourced', source_id: source.id
    }
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [fact])], [source])
    const factClaim = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]
    expect(factClaim).toMatchObject({ evidenceLevel: 'pending', sourceId: source.id, value: '具体开放时段待核验' })
  })

  it('社区页面不能作为开放、预约或票价的唯一依据', async () => {
    const source = createSource('故宫游客攻略', 'https://example.com/palace-note', 'Firecrawl 网页正文', 'web', '故宫游客攻略正文。')
    source.contentLevel = 'page'
    source.sourceNature = 'community-platform'
    const fact = {
      type: 'opening-hours', value: '每日 08:30 至 17:00', scope: '每日', evidence_level: 'sourced', source_id: source.id
    }
    const result = await runProposal([rawPlan('北京行程', '2026-09-22', [fact])], [source])
    const factClaim = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.[0]
    expect(factClaim).toMatchObject({ evidenceLevel: 'pending', sourceId: source.id, value: '具体开放时段待核验' })
  })

  it('不检查用户未要求的事实，也不把餐饮当作景点', () => {
    const plan = option([stop('午餐店', [])])

    expect(itineraryFactEvidenceFeedback([plan], { openingHours: false, booking: false })).toEqual([])
  })
})
