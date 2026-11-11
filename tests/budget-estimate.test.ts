/** 验证预算区间计算、分类覆盖、来源状态和模型候选边界。 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { executeTool } from '../src/main/tools.js'
import { createSource } from '../src/main/connectors/types.js'
import { EMPTY_BRIEF, normalizeEditedItinerary } from '../src/main/persistence/schema.js'
import { compareBudgetPreference, formatBudgetRange, parseBudgetPreference, summarizeBudgetEstimate } from '../src/shared/budget.js'
import { itineraryToMarkdown } from '../src/shared/itinerary.js'
import { ItineraryBudgetEstimateCard, PlanComparison } from '../src/renderer/src/ItineraryPlans.js'
import type { ItineraryBudgetEstimate, ItineraryBudgetItem, SourceRecord } from '../src/shared/types.js'

/** 构造一条人民币单价区间，金额单位为分。 */
function budgetItem(
  id: string,
  category: ItineraryBudgetItem['category'],
  evidenceLevel: ItineraryBudgetItem['evidenceLevel'],
  amountMinFen: number | null,
  amountMaxFen: number | null,
  quantity: number,
  sourceIds: string[] = []
): ItineraryBudgetItem {
  return {
    id, category, title: `${category}费用`, amountMinFen, amountMaxFen, quantity, unitLabel: '人',
    evidenceLevel, sourceIds, basis: '按当前行程和人数估算。'
  }
}

/** 构造覆盖所有类别的预算，其中住宿明确待核验、个人购物不纳入。 */
function completeEstimate(sourceId: string): ItineraryBudgetEstimate {
  return {
    currency: 'CNY',
    items: [
      budgetItem('flight', 'flight', 'sourced', 100_000, 120_000, 2, [sourceId]),
      budgetItem('intercity', 'intercity-transport', 'estimated', 30_000, 50_000, 2),
      budgetItem('lodging', 'lodging', 'pending', null, null, 1),
      budgetItem('local', 'local-transport', 'estimated', 1_000, 3_000, 2),
      budgetItem('tickets', 'tickets', 'estimated', 5_000, 15_000, 2),
      budgetItem('meals', 'meals', 'estimated', 8_000, 15_000, 2)
    ],
    notApplicableCategories: [{ category: 'other', reason: '不含个人购物等自选消费。' }]
  }
}

/** 让各类别有金额，用于验证完整估算的预算边界比较。 */
function fullyPricedEstimate(sourceId: string): ItineraryBudgetEstimate {
  const estimate = completeEstimate(sourceId)
  const lodging = estimate.items.find((item) => item.category === 'lodging')!
  Object.assign(lodging, { evidenceLevel: 'estimated', amountMinFen: 60_000, amountMaxFen: 80_000 })
  return estimate
}

/** 构造完整候选输入，便于测试工具边界。 */
function rawPlan(budgetEstimate?: ItineraryBudgetEstimate) {
  return {
    title: '北京慢游', summary: '以城区人文景点为主。', tradeoffs: '减少跨区移动。',
    ...(budgetEstimate ? {
      budget_estimate: {
        currency: budgetEstimate.currency,
        items: budgetEstimate.items.map((item) => ({
          category: item.category, title: item.title, amount_min_fen: item.amountMinFen,
          amount_max_fen: item.amountMaxFen, quantity: item.quantity, unit_label: item.unitLabel,
          evidence_level: item.evidenceLevel, source_ids: item.sourceIds, basis: item.basis
        })),
        not_applicable_categories: budgetEstimate.notApplicableCategories.map((item) => ({ ...item }))
      }
    } : {}),
    days: [{
      day_number: 1, date: '', title: '城区人文',
      schedule_blocks: [] as Array<{
        kind: 'meal' | 'rest' | 'buffer'; title: string; time: string; duration_minutes: number; area: string; notes: string
      }>,
      stops: [{
        name: '故宫', area: '', time: '上午', duration_minutes: null, category: '人文', notes: '',
        transit_to_next: '', evidence_level: 'pending', source_ids: [], fact_claims: []
      }]
    }]
  }
}

function source(status: SourceRecord['status'] = 'success'): SourceRecord {
  const result = createSource(
    '机票搜索结果', 'https://example.com/flights', '测试服务', 'web', '成人机票 ¥1,000–¥1,200。', status
  )
  if (status === 'success') result.contentLevel = 'page'
  return result
}

/** 构造可明确控制正文层级与价格文本的票价来源。 */
function ticketPriceSource(summary: string, contentLevel: SourceRecord['contentLevel']): SourceRecord {
  const result = createSource('上海博物馆票务', 'https://www.shanghaimuseum.net/ticket', '上海博物馆官网', 'web', summary)
  result.contentLevel = contentLevel
  return result
}

describe('行程预算估算', () => {
  it('保留明确标为待核验的费用和交通说明', async () => {
    const plan = rawPlan()
    plan.summary = '按片区安排历史建筑；未知费用与路线耗时待核验。'
    plan.tradeoffs = '计划保持较高步行强度；门票与交通耗时待核验。'

    const result = await executeTool('propose_itineraries', JSON.stringify({ plan }), {
      amapKey: null, researchCompleted: true
    })
    const option = result.itineraryOptions?.[0]

    expect(option?.summary).toBe(plan.summary)
    expect(option?.tradeoffs).toContain('计划保持较高步行强度；门票与交通耗时待核验。')
  })

  it('不会因附加待核验字样而保留无来源的具体价格断言', async () => {
    const plan = rawPlan()
    plan.summary = '门票免费，价格待核验。'

    const result = await executeTool('propose_itineraries', JSON.stringify({ plan }), {
      amapKey: null, researchCompleted: true
    })

    expect(result.itineraryOptions?.[0]?.summary).not.toContain('门票免费')
  })

  it('不把无来源的免费和低价判断写进摘要', async () => {
    const plan = rawPlan()
    plan.summary = '费用按免费/低价组合估算。'

    const result = await executeTool('propose_itineraries', JSON.stringify({ plan }), {
      amapKey: null, researchCompleted: true
    })

    expect(result.itineraryOptions?.[0]?.summary).not.toContain('免费/低价')
  })

  it('未核验票价不进入方案标题或预算依据', async () => {
    const estimate = completeEstimate('source-not-available')
    const tickets = estimate.items.find((item) => item.category === 'tickets')!
    Object.assign(tickets, {
      evidenceLevel: 'pending', amountMinFen: null, amountMaxFen: null,
      basis: '钟楼鼓楼票价未检索到；外观免费，登楼是否包含待确认。'
    })
    const plan = rawPlan(estimate)
    plan.title = '西安三日：免费双馆＋免预约文博，低预算版'

    const result = await executeTool('propose_itineraries', JSON.stringify({ plan }), {
      amapKey: null, researchCompleted: true, budgetRequested: true
    })
    const option = result.itineraryOptions?.[0]
    const budgetBasis = option?.budgetEstimate?.items.find((item) => item.category === 'tickets')?.basis ?? ''

    expect(option?.title).not.toMatch(/免费|免票/u)
    expect(option?.title).not.toContain('免预约')
    expect(budgetBasis).not.toMatch(/免费|免票|\d+\s*元|[¥￥]/u)
    expect(budgetBasis).toContain('待核验')
  })

  it('不在无来源的时间块备注中保留路线耗时与距离', async () => {
    const plan = rawPlan()
    plan.days[0]!.schedule_blocks = [{
      kind: 'buffer', title: '机动时间', time: '13:30', duration_minutes: 60, area: '市区',
      notes: '约53分钟地铁接驳（含步行2.2km）已含在路线上，此为弹性机动'
    }]

    const result = await executeTool('propose_itineraries', JSON.stringify({ plan }), {
      amapKey: null, researchCompleted: true
    })
    const notes = result.itineraryOptions?.[0]?.days[0]?.scheduleBlocks[0]?.notes ?? ''

    expect(notes).toContain('待核验')
    expect(notes).not.toMatch(/53\s*分钟|2\.2\s*km|已含在路线上/u)
    expect(notes).toContain('弹性机动')
  })

  it('降级未核验的小时区间时清除残留数字、范围符和重复状态', async () => {
    const plan = rawPlan()
    plan.days[0]!.stops[0]!.transit_to_next = '地铁返程，约 1.5–2 小时（待核验）（待核验）'
    plan.days[0]!.stops.push({
      name: '景山公园', area: '北京', time: '下午', duration_minutes: null, category: '景点',
      notes: '', transit_to_next: '', evidence_level: 'pending', source_ids: [], fact_claims: []
    })

    const result = await executeTool('propose_itineraries', JSON.stringify({ plan }), {
      amapKey: null, researchCompleted: true
    })
    const transit = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.transitToNext ?? ''

    expect(transit).toContain('耗时待核验')
    expect(transit).not.toMatch(/1\.5|2\s*小时|[-–—]\s*耗时|待核验.*待核验/u)
  })

  it('高强度多站日缺少休息时自动加入可调整的休息机动时段', async () => {
    const plan = rawPlan()
    const firstStop = plan.days[0]!.stops[0]!
    Object.assign(firstStop, { name: '景点一', time: '09:00', duration_minutes: 60, category: '景点' })
    plan.days[0]!.stops.push(
      { ...firstStop, name: '景点二', time: '12:00' },
      { ...firstStop, name: '景点三', time: '16:00' }
    )

    const result = await executeTool('propose_itineraries', JSON.stringify({ plan }), {
      amapKey: null, researchCompleted: true,
      tripBrief: { ...EMPTY_BRIEF, pace: '暴走', budget: '偏低' }
    })
    const blocks = result.itineraryOptions?.[0]?.days[0]?.scheduleBlocks ?? []

    expect(blocks).toContainEqual(expect.objectContaining({
      kind: 'buffer', title: '休息与机动时间', durationMinutes: 30
    }))
  })

  it('高强度方案的安全取舍摘要保留预算、步行负担与休息安排', async () => {
    const plan = rawPlan(completeEstimate('source-not-available'))
    plan.summary = '费用按免费组合估算。'
    plan.tradeoffs = '免费门票让高密度游览更省钱。'
    const firstStop = plan.days[0]!.stops[0]!
    Object.assign(firstStop, { name: '景点一', time: '09:00', duration_minutes: 60, category: '景点' })
    plan.days[0]!.stops.push(
      { ...firstStop, name: '景点二', time: '12:00' },
      { ...firstStop, name: '景点三', time: '16:00' }
    )

    const result = await executeTool('propose_itineraries', JSON.stringify({ plan }), {
      amapKey: null, researchCompleted: true, budgetRequested: true,
      tripBrief: { ...EMPTY_BRIEF, pace: '暴走', budget: '偏低', constraints: '请标出步行负担和未知费用。' },
      userRequest: '请标出步行负担和未知费用。'
    })
    const option = result.itineraryOptions?.[0]

    expect(option?.summary).not.toContain('免费组合')
    expect(option?.tradeoffs).toContain('未知费用不计入金额小计')
    expect(option?.tradeoffs).toContain('步行负担偏高')
    expect(option?.tradeoffs).toContain('休息/机动时段')
  })

  it('按整数分乘数量汇总，并将待核验住宿排除在已计入小计外', () => {
    const flightSource = source()
    const summary = summarizeBudgetEstimate(completeEstimate(flightSource.id), [flightSource])

    expect(summary).toMatchObject({
      totalMinFen: 288_000,
      totalMaxFen: 406_000,
      sourcedMinFen: 200_000,
      sourcedMaxFen: 240_000,
      estimatedMinFen: 88_000,
      estimatedMaxFen: 166_000,
      pricedItemCount: 5,
      pendingItemCount: 1,
      pendingCategories: ['lodging'],
      missingCategories: [],
      complete: false
    })
    expect(formatBudgetRange(summary.totalMinFen, summary.totalMaxFen)).toBe('¥2880.00–¥4060.00')
  })

  it('来源不可用或类别缺失时不将预算标为完整总额', () => {
    const flightSource = source('error')
    const estimate = completeEstimate(flightSource.id)
    estimate.items = estimate.items.filter((item) => item.category !== 'lodging')
    const summary = summarizeBudgetEstimate(estimate, [flightSource])

    expect(summary.sourceReviewItemCount).toBe(1)
    expect(summary.missingCategories).toEqual(['lodging'])
    expect(summary.complete).toBe(false)
  })

  it('只解析明确标注全程、人均或每日口径的人民币金额', () => {
    expect(parseBudgetPreference('全程总预算上限 5,000 元', '2 人')).toEqual({ kind: 'trip-total', limitFen: 500_000 })
    expect(parseBudgetPreference('CNY 5,000 全程预算', '2 人')).toEqual({ kind: 'trip-total', limitFen: 500_000 })
    expect(parseBudgetPreference('人均预算：¥2,500', '2 人')).toEqual({ kind: 'per-person', limitFen: 250_000, travelers: 2 })
    expect(parseBudgetPreference('每人 2500 元', '1 位成人，带老人')).toEqual({ kind: 'per-person', limitFen: 250_000, travelers: null })
    expect(parseBudgetPreference('每天预算 800 元', '2 人')).toEqual({ kind: 'per-day', limitFen: 80_000 })
    expect(parseBudgetPreference('预算 5000 元', '2 人')).toEqual({ kind: 'ambiguous', limitFen: 500_000 })
    expect(parseBudgetPreference('中等', '2 人')).toEqual({ kind: 'qualitative' })
    expect(parseBudgetPreference('预算 5000 元，其中交通 800', '2 人')).toEqual({ kind: 'qualitative' })
  })

  it('完整估算区分预算内、超预算和范围跨过上限', () => {
    const flightSource = source()
    const estimate = fullyPricedEstimate(flightSource.id)

    expect(compareBudgetPreference(estimate, [flightSource], '全程总预算 5000 元', '2 人').kind).toBe('within')
    expect(compareBudgetPreference(estimate, [flightSource], '旅行总预算 3000 元', '2 人').kind).toBe('over')
    expect(compareBudgetPreference(estimate, [flightSource], '整趟预算上限 4000 元', '2 人').kind).toBe('range-overlaps')
    const perPerson = compareBudgetPreference(estimate, [flightSource], '人均预算 2500 元', '2 人')
    expect(perPerson.kind).toBe('within')
    expect(perPerson.message).toContain('按 2 人平均折算 ¥1740.00–¥2430.00/人')
    expect(compareBudgetPreference(estimate, [flightSource], '每日预算 1000 元', '2 人').message).toContain('整段行程汇总')
  })

  it('不完整估算只陈述已计入金额，不确认符合预算', () => {
    const flightSource = source()
    const estimate = completeEstimate(flightSource.id)

    expect(compareBudgetPreference(estimate, [flightSource], '全程总预算 3000 元', '2 人').kind).toBe('inconclusive')
    expect(compareBudgetPreference(estimate, [flightSource], '全程总预算 2000 元', '2 人')).toMatchObject({
      kind: 'recorded-over', message: expect.stringContaining('已计入最低金额')
    })
    expect(compareBudgetPreference(estimate, [flightSource], '预算 5000 元', '2 人').kind).toBe('unsupported')
    expect(compareBudgetPreference(estimate, [flightSource], '人均预算 2500 元', '1 位成人，带老人').kind).toBe('unsupported')
  })

  it('用户要求费用清单但模型漏交估算时，保留方案并将各项列为待核验', async () => {
    const result = await executeTool('propose_itineraries', JSON.stringify({ plans: [rawPlan()] }), {
      amapKey: null, researchCompleted: true, budgetRequested: true
    })
    const estimate = result.itineraryOptions?.[0]?.budgetEstimate

    expect(result.itineraryOptions).toHaveLength(1)
    expect(estimate?.items).toHaveLength(7)
    expect(estimate?.items.every((item) => item.evidenceLevel === 'pending' &&
      item.amountMinFen === null && item.amountMaxFen === null)).toBe(true)
    expect(result.itineraryOptions?.[0]?.tradeoffs).toContain('费用分项中 7 项金额待核验')
  })

  it('只接受引用当前成功来源的完整预算估算', async () => {
    const flightSource = source()
    const result = await executeTool('propose_itineraries', JSON.stringify({
      plans: [rawPlan(completeEstimate(flightSource.id))]
    }), {
      amapKey: null, researchCompleted: true, budgetRequested: true,
      sourceIds: [flightSource.id], availableSources: [flightSource]
    })
    const option = result.itineraryOptions?.[0]

    expect(option?.budgetEstimate?.items[0]).toMatchObject({
      category: 'flight', evidenceLevel: 'sourced', sourceIds: [flightSource.id], amountMinFen: 100_000
    })
    expect(option?.budgetEstimate?.items[0].id).toBeTruthy()
    expect(option?.budgetEstimate?.items[0].id).not.toBe('flight')
    expect(summarizeBudgetEstimate(option!.budgetEstimate!, [flightSource]).totalMaxFen).toBe(406_000)
    const markdown = itineraryToMarkdown(option!, [flightSource])
    expect(markdown).toContain('预算估算（人民币）')
    expect(markdown).toContain('已计入项目小计：¥2880.00–¥4060.00')
    expect(markdown).toContain('未计入完整总额：住宿')
    expect(normalizeEditedItinerary(option!).budgetEstimate).toBeUndefined()
    const card = renderToStaticMarkup(createElement(ItineraryBudgetEstimateCard, {
      estimate: option!.budgetEstimate!, sources: [flightSource], budget: '全程预算上限 5000 元', travelers: '2 人', onShowSource: () => undefined
    }))
    expect(card).toContain('¥1000.00–¥1200.00/人 × 2 = ¥2000.00–¥2400.00')
    expect(card).toContain('住宿 · lodging费用')
    expect(card).toContain('机票搜索结果')
    expect(card).toContain('仍需打开来源核对金额、人数和适用日期')
    expect(card).toContain('预算比较')
    expect(card).toContain('无法确认是否符合全程预算 ¥5000.00')

    const alternate = structuredClone(option!)
    alternate.id = 'alternate-budget-plan'
    alternate.budgetEstimate!.items[0].amountMinFen = 110_000
    alternate.budgetEstimate!.items[0].amountMaxFen = 130_000
    const comparison = renderToStaticMarkup(createElement(PlanComparison, {
      options: [option!, alternate], brief: { ...EMPTY_BRIEF, budget: '每天 1500 元' }, sources: [flightSource]
    }))
    expect(comparison).toContain('预算估算')
    expect(comparison).toContain('未计：住宿')
    expect(comparison).toContain('每日预算为 ¥1500.00')

    const failedSource = source('error')
    const downgraded = await executeTool('propose_itineraries', JSON.stringify({
      plans: [rawPlan(completeEstimate(failedSource.id))]
    }), {
      amapKey: null, researchCompleted: true, budgetRequested: true,
      sourceIds: [failedSource.id], availableSources: [failedSource]
    })
    expect(downgraded.itineraryOptions?.[0].budgetEstimate?.items[0]).toMatchObject({
      evidenceLevel: 'pending', amountMinFen: null, amountMaxFen: null, sourceIds: []
    })
    expect(downgraded.itineraryOptions?.[0].tradeoffs).toMatch(/费用分项中 \d+ 项金额待核验/u)
  })

  it('仅当直接来源正文包含对应金额时，才保留已核实票价', async () => {
    const ticketSource = ticketPriceSource('上海博物馆成人票 40 元。', 'page')
    const estimate = completeEstimate('unused-flight-source')
    const ticket = estimate.items.find((item) => item.category === 'tickets')!
    Object.assign(ticket, {
      evidenceLevel: 'sourced', amountMinFen: 4_000, amountMaxFen: 4_000,
      sourceIds: [ticketSource.id], basis: '官网成人票价 40 元。'
    })

    const result = await executeTool('propose_itineraries', JSON.stringify({ plans: [rawPlan(estimate)] }), {
      amapKey: null, researchCompleted: true, budgetRequested: true,
      sourceIds: [ticketSource.id], availableSources: [ticketSource]
    })
    const normalized = result.itineraryOptions?.[0]?.budgetEstimate?.items.find((item) => item.category === 'tickets')

    expect(normalized).toMatchObject({
      evidenceLevel: 'sourced', amountMinFen: 4_000, amountMaxFen: 4_000, sourceIds: [ticketSource.id]
    })
  })

  it('用户明确要求预算与省时比较但草案缺项时保留结构完整的草案', async () => {
    const estimate = completeEstimate('unused-source')
    for (const item of estimate.items) {
      Object.assign(item, { evidenceLevel: 'pending', amountMinFen: null, amountMaxFen: null, sourceIds: [] })
    }
    const plan = rawPlan(estimate)
    plan.title = '上海三日：博物馆+街区漫步（预算vs省时对照）'
    plan.tradeoffs = '预算卡分列来源金额、规划估算与待核验项；用户要求在同一方案中比较预算友好与省时做法，本稿尚未列出两种具体选择，待补。'

    const result = await executeTool('propose_itineraries', JSON.stringify({ plans: [plan] }), {
      amapKey: null, researchCompleted: true, budgetRequested: true,
      userRequest: '请在方案取舍中对比预算友好与省时间的做法。',
      tripBrief: { ...EMPTY_BRIEF, destination: '上海', budget: '中等' }
    })

    expect(result.itineraryOptions).toHaveLength(1)
    expect(result.itineraryOptions?.[0]?.tradeoffs).toContain('预算友好与省时做法')
    expect(result.itineraryOptions?.[0]?.tradeoffs).toContain('待补')
  })

  it('明确区分已列出的比较方案与待补内容，不阻断结构完整草案', async () => {
    const estimate = completeEstimate('unused-source')
    for (const item of estimate.items) {
      Object.assign(item, { evidenceLevel: 'pending', amountMinFen: null, amountMaxFen: null, sourceIds: [] })
    }
    const context = {
      amapKey: null, researchCompleted: true, budgetRequested: true,
      userRequest: '请在方案取舍中对比预算友好与省时间的做法。',
      tripBrief: { ...EMPTY_BRIEF, destination: '上海', budget: '中等' }
    }
    const abstractComparison = rawPlan(estimate)
    abstractComparison.tradeoffs = '比较预算友好与省时做法。'
    const abstractResult = await executeTool('propose_itineraries', JSON.stringify({ plans: [abstractComparison] }), context)
    expect(abstractResult.itineraryOptions).toHaveLength(1)
    expect(abstractResult.itineraryOptions?.[0]?.tradeoffs).toContain('预算友好与省时做法')
    expect(abstractResult.itineraryOptions?.[0]?.tradeoffs).toContain('待补')

    const concreteComparison = rawPlan(estimate)
    concreteComparison.tradeoffs = '预算友好方案：乘地铁；省时方案：网约车。'
    const concreteResult = await executeTool('propose_itineraries', JSON.stringify({ plans: [concreteComparison] }), context)
    expect(concreteResult.itineraryOptions?.[0]?.tradeoffs).toContain('预算友好方案：乘地铁；省时方案：网约车。')
    expect(concreteResult.itineraryOptions?.[0]?.tradeoffs).not.toContain('尚未列出两种具体选择')
  })

  it('明确要求预算和时间比较但模型漏写时，从计划路段补充待核验备选', async () => {
    const plan = rawPlan(completeEstimate('unused-source'))
    const firstStop = plan.days[0]!.stops[0]!
    firstStop.name = '上海博物馆'
    firstStop.transit_to_next = '公共交通前往上海豫园；具体线路和耗时待核验。'
    plan.days[0]!.stops.push({ ...firstStop, name: '上海豫园', transit_to_next: '' })

    const result = await executeTool('propose_itineraries', JSON.stringify({ plan }), {
      amapKey: null,
      researchCompleted: true,
      budgetRequested: true,
      userRequest: '请在方案取舍中对比预算友好与省时间的做法。',
      tripBrief: { ...EMPTY_BRIEF, destination: '上海', budget: '中等' }
    })
    const tradeoffs = result.itineraryOptions?.[0]?.tradeoffs ?? ''

    expect(tradeoffs).toContain('预算友好候选：上海博物馆→上海豫园沿用计划中的公共交通')
    expect(tradeoffs).toContain('更省时候选：同段可查出租车/网约车')
    expect(tradeoffs).toContain('是否更快和车费均待核验')
    expect(tradeoffs).toContain('不计入已知小计')
    expect(tradeoffs).not.toContain('本稿尚未列出两种具体选择')
  })

  it('不允许在预算标题里绕过金额证据状态', async () => {
    const estimate = completeEstimate('unused-source')
    for (const item of estimate.items) {
      Object.assign(item, { evidenceLevel: 'pending', amountMinFen: null, amountMaxFen: null, sourceIds: [] })
    }
    const localTransit = estimate.items.find((item) => item.category === 'local-transport')!
    localTransit.title = '上海市内地铁乘车（含1段已查路线¥4/人）'

    const result = await executeTool('propose_itineraries', JSON.stringify({ plans: [rawPlan(estimate)] }), {
      amapKey: null, researchCompleted: true, budgetRequested: true
    })
    const normalized = result.itineraryOptions?.[0]?.budgetEstimate?.items.find((item) => item.category === 'local-transport')

    expect(normalized?.title).toBe('上海市内地铁乘车')
    expect(normalized).toMatchObject({
      evidenceLevel: 'pending', amountMinFen: null, amountMaxFen: null, sourceIds: []
    })
  })

  it.each([
    { label: '搜索摘要中的免费结论', summary: '上海博物馆成人票免费。', contentLevel: 'snippet' as const },
    { label: '没有金额的网页正文', summary: '上海博物馆票价请以现场公告为准。', contentLevel: 'page' as const }
  ])('将缺少直接价格依据的 $label 降为待核验', async ({ summary, contentLevel }) => {
    const ticketSource = ticketPriceSource(summary, contentLevel)
    const estimate = completeEstimate('unused-flight-source')
    const ticket = estimate.items.find((item) => item.category === 'tickets')!
    Object.assign(ticket, {
      evidenceLevel: 'sourced', amountMinFen: 0, amountMaxFen: 0,
      sourceIds: [ticketSource.id], basis: '上海博物馆成人票免费。'
    })

    const result = await executeTool('propose_itineraries', JSON.stringify({ plans: [rawPlan(estimate)] }), {
      amapKey: null, researchCompleted: true, budgetRequested: true,
      sourceIds: [ticketSource.id], availableSources: [ticketSource]
    })
    const normalized = result.itineraryOptions?.[0]?.budgetEstimate?.items.find((item) => item.category === 'tickets')

    expect(normalized).toMatchObject({
      evidenceLevel: 'pending', amountMinFen: null, amountMaxFen: null, sourceIds: []
    })
  })

  it('金额格式异常或缺少类别时保留行程并将预算项目标为待核验', async () => {
    const flightSource = source()
    const plan = rawPlan(completeEstimate(flightSource.id))
    const firstItem = plan.budget_estimate?.items[0]
    if (!firstItem || !plan.budget_estimate) throw new Error('测试预算结构缺失。')
    firstItem.amount_max_fen = '价格待核实' as unknown as number
    plan.budget_estimate.items = plan.budget_estimate.items.filter((item) => item.category !== 'meals')
    plan.budget_estimate.not_applicable_categories = []

    const result = await executeTool('propose_itineraries', JSON.stringify({ plans: [plan] }), {
      amapKey: null, researchCompleted: true, budgetRequested: true,
      sourceIds: [flightSource.id], availableSources: [flightSource]
    })
    const estimate = result.itineraryOptions?.[0]?.budgetEstimate
    const flight = estimate?.items.find((item) => item.category === 'flight')
    const meals = estimate?.items.find((item) => item.category === 'meals')

    expect(result.itineraryOptions).toHaveLength(1)
    expect(flight).toMatchObject({ evidenceLevel: 'pending', amountMinFen: null, amountMaxFen: null, sourceIds: [] })
    expect(meals).toMatchObject({ evidenceLevel: 'pending', amountMinFen: null, amountMaxFen: null })
    expect(estimate?.items).toHaveLength(7)
    expect(result.itineraryOptions?.[0].tradeoffs).toContain('费用分项中')
  })

  it('预算来源数量超限时保留行程并将对应金额降为待核验', async () => {
    const sources = Array.from({ length: 6 }, () => source())
    const estimate = completeEstimate(sources[0].id)
    estimate.items[0].sourceIds = sources.map((item) => item.id)
    const result = await executeTool('propose_itineraries', JSON.stringify({ plans: [rawPlan(estimate)] }), {
      amapKey: null, researchCompleted: true, budgetRequested: true,
      sourceIds: sources.map((item) => item.id), availableSources: sources
    })

    expect(result.itineraryOptions).toHaveLength(1)
    expect(result.itineraryOptions?.[0].budgetEstimate?.items[0]).toMatchObject({
      evidenceLevel: 'pending', amountMinFen: null, amountMaxFen: null, sourceIds: []
    })
    expect(result.itineraryOptions?.[0].tradeoffs).toMatch(/费用分项中 \d+ 项金额待核验/u)
  })
})
