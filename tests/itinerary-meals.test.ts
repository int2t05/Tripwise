/** 验证局部餐饮修订只替换指定餐次并保留行程其他部分。 */
import { describe, expect, it } from 'vitest'
import type { ItineraryOption } from '../src/shared/types.js'
import { MAX_ITINERARY_STOPS_PER_DAY } from '../src/shared/itinerary-limits.js'
import { isItineraryOption } from '../src/main/persistence/schema.js'
import {
  itineraryMealRepairMadeProgress,
  itineraryMealRepairTargets,
  itineraryMealSourceFeedback,
  itineraryMealRepairTool
} from '../src/main/connectors/itinerary-meals.js'
import { isPlaceholderRestaurantName, mealPreferenceFeedback } from '../src/main/connectors/itinerary.js'
import { createSource } from '../src/main/connectors/types.js'

function planWithMealStop(): ItineraryOption {
  return {
    id: 'plan-1', title: '北京七日游', summary: '按区域游览。', tradeoffs: '餐馆分店待核验。',
    days: [{
      id: 'day-1', dayNumber: 1, date: '2026-09-22', title: '海淀人文',
      scheduleBlocks: [],
      stops: [
        {
          id: 'stop-campus', name: '清华大学', area: '海淀区', time: '09:00–11:00', durationMinutes: 120,
          category: '景点', notes: '', transitToNext: '地铁前往附近餐馆，约 12 分钟。', evidenceLevel: 'pending', sourceIds: [],
          factClaims: [{ id: 'old-route-fact', type: 'transport-time', value: '约 12 分钟', scope: '旧餐馆路线', evidenceLevel: 'pending' }]
        },
        {
          id: 'stop-lunch', name: '附近餐馆（具体店面待选）', area: '五道口', time: '12:00–13:00 午餐', durationMinutes: 60,
          category: '餐饮', notes: '门店待确认。', transitToNext: '步行前往圆明园，耗时待核验。', evidenceLevel: 'pending', sourceIds: [],
          factClaims: [{ id: 'old-place-fact', type: 'booking', value: '旧地点事实', scope: '旧餐馆', evidenceLevel: 'pending' }],
          location: { longitude: 116.3, latitude: 39.9, label: '旧门店', coordinateSystem: 'gcj02', sourceId: 'old-place', provider: '高德地图', fetchedAt: '2026-10-20T00:00:00.000Z' }
        },
        {
          id: 'stop-park', name: '圆明园', area: '海淀区', time: '14:00–17:00', durationMinutes: 180,
          category: '景点', notes: '', transitToNext: '', evidenceLevel: 'pending', sourceIds: [], factClaims: []
        }
      ]
    }]
  }
}

function mealUpdate(
  restaurantName: string,
  sourceIds: string[],
  evidenceLevel: 'sourced' | 'pending' = 'sourced'
) {
  return { updates: [{
    plan_number: 1, day_number: 1, date: '2026-09-22', meal_slot: 'lunch', restaurant_name: restaurantName,
    area: '五道口', evidence_level: evidenceLevel, source_ids: sourceIds
  }] }
}

describe('局部餐馆修订工具', () => {
  it('将片区加“就近安排”识别为待选餐饮，而不是具体店名', () => {
    const plan = planWithMealStop()
    const day = plan.days[0]!
    day.date = '2026-09-24'
    day.stops[1] = {
      ...day.stops[1]!,
      name: '前门一带的就近安排', area: '前门', time: '18:00–19:00 晚餐'
    }

    expect(isPlaceholderRestaurantName('前门一带的就近安排')).toBe(true)
    expect(isPlaceholderRestaurantName('四季民福烤鸭店（前门店）')).toBe(false)
    expect(isPlaceholderRestaurantName('午餐：海碗居（具体门店待核验）')).toBe(false)
    expect(isPlaceholderRestaurantName('晚餐：附近餐馆（具体店面待核验）')).toBe(true)
    expect(isPlaceholderRestaurantName('食宝街')).toBe(true)
    expect(isPlaceholderRestaurantName('前门美食街')).toBe(true)
    expect(isPlaceholderRestaurantName('机场内简餐')).toBe(true)
    expect(isPlaceholderRestaurantName('午餐自理')).toBe(true)
    expect(mealPreferenceFeedback([plan], [{ date: '2026-09-24', slots: ['dinner'] }], true))
      .toContainEqual(expect.stringContaining('具体店面待选'))
  })

  it('将裸泛称识别为缺少门店名，并交给餐馆修订流程', () => {
    const plan = planWithMealStop()
    const lunch = plan.days[0]?.stops.find((stop) => stop.category === '餐饮')
    if (!lunch) throw new Error('缺少测试午餐地点')
    lunch.name = '餐厅'

    for (const name of ['餐厅', '饭店', '晚餐安排', '用餐安排', '早中晚餐安排']) {
      expect(isPlaceholderRestaurantName(name), `${name} 应视为泛称`).toBe(true)
    }
    expect(isPlaceholderRestaurantName('全聚德（前门店，分店待核验）')).toBe(false)
    expect(itineraryMealRepairTargets([plan], [{ date: '2026-09-22', slots: ['lunch'] }]))
      .toEqual([expect.objectContaining({ meal_slot: 'lunch', area: '五道口' })])
    expect(itineraryMealRepairTargets([plan], [{ date: '2026-09-22', slots: ['lunch'] }])[0])
      .not.toHaveProperty('current_name')
  })

  it('把美食街区当作缺少具体店面的占位，并允许局部替换', async () => {
    const plan = planWithMealStop()
    const stop = plan.days[0]?.stops[1]
    if (!stop) throw new Error('缺少测试午餐地点')
    stop.name = '食宝街'
    const requirements = [{ date: '2026-09-22', slots: ['lunch' as const] }]
    const targets = itineraryMealRepairTargets([plan], requirements)

    expect(targets).toContainEqual(expect.objectContaining({ meal_slot: 'lunch', area: '五道口' }))
    expect(targets[0]).not.toHaveProperty('current_name')

    const result = await itineraryMealRepairTool.execute(mealUpdate('庆丰包子铺', [], 'pending'), {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: requirements, sourceIds: [], availableSources: []
    })
    expect(result.itineraryOptions?.[0]?.days[0]?.stops[1]).toMatchObject({
      name: '庆丰包子铺', evidenceLevel: 'pending', sourceIds: []
    })
  })

  it('为有名称但没有直接店名来源的餐馆安排一次核验修订', async () => {
    const plan = planWithMealStop()
    const stop = plan.days[0]?.stops[1]
    if (!stop) throw new Error('缺少测试午餐地点')
    stop.name = '海碗居（牡丹园店）'
    const source = createSource(
      '海淀游客午餐记录',
      'https://www.xiaohongshu.com/explore/meal-note',
      'OpenCLI · 小红书笔记',
      'web',
      '海碗居牡丹园店午餐体验。'
    )
    const requirements = [{ date: '2026-09-22', slots: ['lunch' as const] }]

    expect(itineraryMealSourceFeedback([plan], requirements, [source])).toContainEqual(
      expect.stringContaining('店名来源待核验')
    )
    expect(itineraryMealRepairTargets([plan], requirements, [], [source])).toContainEqual(
      expect.objectContaining({ current_name: '海碗居（牡丹园店）', meal_slot: 'lunch' })
    )

    const result = await itineraryMealRepairTool.execute(mealUpdate('海碗居（牡丹园店）', [source.id]), {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: requirements,
      sourceIds: [source.id], availableSources: [source]
    })
    const revised = result.itineraryOptions ?? []

    expect(revised[0]?.days[0]?.stops[1]).toMatchObject({
      name: '海碗居（牡丹园店）', evidenceLevel: 'sourced', sourceIds: [source.id]
    })
    expect(itineraryMealSourceFeedback(revised, requirements, [source])).toEqual([])
  })

  it('不能用只提到景点、不提店名的来源关闭餐馆核验缺口', async () => {
    const plan = planWithMealStop()
    const stop = plan.days[0]?.stops[1]
    if (!stop) throw new Error('缺少测试午餐地点')
    stop.name = '海碗居（牡丹园店）'
    const unrelated = createSource(
      '圆明园开放信息', 'https://example.com/park', '网页搜索', 'web', '圆明园开放时间以公告为准。'
    )
    stop.sourceIds = [unrelated.id]
    stop.evidenceLevel = 'sourced'
    const requirements = [{ date: '2026-09-22', slots: ['lunch' as const] }]

    expect(itineraryMealSourceFeedback([plan], requirements, [unrelated])).toContainEqual(
      expect.stringContaining('店名来源待核验')
    )
  })

  it('超过提示词展示上限时，按实际待修订目标判断部分进展', async () => {
    const mealSlots = [
      { slot: 'breakfast' as const, name: '早餐（具体店面待选）', time: '07:30–08:00 早餐' },
      { slot: 'lunch' as const, name: '午餐（具体店面待选）', time: '12:00–12:30 午餐' },
      { slot: 'dinner' as const, name: '晚餐（具体店面待选）', time: '18:00–18:30 晚餐' }
    ]
    const plan = planWithMealStop()
    plan.days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 9, 27 + index)).toISOString().slice(0, 10)
      return {
        ...structuredClone(plan.days[0]),
        id: `day-${index + 1}`,
        dayNumber: index + 1,
        date,
        stops: mealSlots.map((meal, mealIndex) => ({
          ...structuredClone(plan.days[0].stops[1]),
          id: `meal-${index + 1}-${mealIndex + 1}`,
          name: meal.name,
          time: meal.time,
          category: '餐饮'
        }))
      }
    })
    const requiredMealSlots = plan.days.map((day) => ({ date: day.date, slots: mealSlots.map(({ slot }) => slot) }))
    const before = itineraryMealRepairTargets([plan], requiredMealSlots)
    expect(before).toHaveLength(21)
    expect(mealPreferenceFeedback([plan], requiredMealSlots, true)).toHaveLength(8)
    expect(mealPreferenceFeedback([plan], requiredMealSlots, true, [], 60)).toHaveLength(21)

    const result = await itineraryMealRepairTool.execute({ updates: [{
      plan_number: 1, day_number: 1, date: plan.days[0].date, meal_slot: 'breakfast',
      restaurant_name: '庆丰包子铺', evidence_level: 'pending'
    }] }, {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots, sourceIds: [], availableSources: []
    })
    const remaining = itineraryMealRepairTargets(result.itineraryOptions ?? [], requiredMealSlots)

    expect(remaining).toHaveLength(20)
    expect(mealPreferenceFeedback(result.itineraryOptions ?? [], requiredMealSlots, true)).toHaveLength(8)
    expect(itineraryMealRepairMadeProgress(before, remaining)).toBe(true)
    expect(itineraryMealRepairMadeProgress(before, before)).toBe(false)
  })

  it('具体店名替代占位餐次时，即使仍待来源核验也算取得进度', () => {
    const before = [{
      plan_number: 1, day_number: 1, date: '2026-09-21', meal_slot: 'dinner' as const,
      current_name: '附近餐馆（具体店面待选）'
    }]
    const after = [{ ...before[0], current_name: '庆丰包子铺' }]

    expect(itineraryMealRepairMadeProgress(before, after)).toBe(true)
    expect(itineraryMealRepairMadeProgress(after, [{ ...after[0], current_name: '海碗居' }])).toBe(false)
  })

  it('替换缺店停靠点并清除旧地点的路线、坐标和事实', async () => {
    const plan = planWithMealStop()
    const source = createSource('四季民福烤鸭店（故宫店）', 'https://example.com/restaurant', '网页搜索', 'web', '四季民福烤鸭店可搜索，分店营业信息待核验。')
    const result = await itineraryMealRepairTool.execute(mealUpdate('四季民福烤鸭店（故宫店）', [source.id]), {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: [{ date: '2026-09-22', slots: ['lunch' as const] }],
      sourceIds: [source.id], availableSources: [source]
    })

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[1]).toMatchObject({
      id: 'stop-lunch', name: '四季民福烤鸭店（故宫店）', area: '五道口',
      evidenceLevel: 'sourced', sourceIds: [source.id], location: undefined,
      transitEstimate: undefined, factClaims: []
    })
    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0].transitToNext).toContain('四季民福烤鸭店')
    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0].factClaims).toEqual([])
    expect(plan.days[0].stops[1].name).toContain('附近餐馆')
  })

  it.each([
    { slot: 'breakfast' as const, direction: 'from-lodging' as const, stopId: 'stop-campus', restaurant: '庆丰包子铺', edge: '首站' },
    { slot: 'dinner' as const, direction: 'to-lodging' as const, stopId: 'stop-park', restaurant: '海底捞火锅', edge: '末站' }
  ])('新增具名餐次成为$edge时清除过期住宿接驳并保留有效行程', async ({ slot, direction, stopId, restaurant }) => {
    const plan = planWithMealStop()
    const day = plan.days[0]!
    day.lodgingCommutes = [{
      direction, lodgingLocation: '北京西站附近酒店', stopId,
      sourceId: 'hotel-to-campus', mode: 'transit', optionNumber: 1, durationMinutes: 35
    }]
    const result = await itineraryMealRepairTool.execute({ updates: [{
      plan_number: 1, day_number: 1, date: '2026-09-22', meal_slot: slot,
      restaurant_name: restaurant, evidence_level: 'pending', area: '五道口'
    }] }, {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: [{ date: '2026-09-22', slots: [slot] }],
      sourceIds: [], availableSources: []
    })
    const revised = result.itineraryOptions?.[0]

    expect(revised?.days[0]?.stops.some((stop) => stop.name === restaurant && stop.category === '餐饮')).toBe(true)
    expect(revised?.days[0]?.lodgingCommutes).toBeUndefined()
    expect(isItineraryOption(revised)).toBe(true)
  })

  it('使用网页正文证据摘录中的店名保留餐馆来源', async () => {
    const plan = planWithMealStop()
    const source = createSource('海淀游览建议', 'https://example.com/guide', 'Tripwise 研究浏览器', 'web', '路线与用餐建议。')
    source.factEvidenceExcerpt = '午餐可考虑四季民福烤鸭店（故宫店），门店信息出发前复核。'
    const result = await itineraryMealRepairTool.execute(mealUpdate('四季民福烤鸭店（故宫店）', [source.id]), {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: [{ date: '2026-09-22', slots: ['lunch' as const] }],
      sourceIds: [source.id], availableSources: [source]
    })

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[1]).toMatchObject({
      name: '四季民福烤鸭店（故宫店）', evidenceLevel: 'sourced', sourceIds: [source.id]
    })
  })

  it('分店名称必须由来源直接提及，品牌来源不能证明具体分店', async () => {
    const plan = planWithMealStop()
    const source = createSource('海碗居品牌介绍', 'https://example.com/brand', '网页搜索', 'web', '北京连锁餐馆介绍。')
    source.factEvidenceExcerpt = '海碗居是北京老字号餐饮品牌。'
    const result = await itineraryMealRepairTool.execute(mealUpdate('海碗居（牡丹园店）', [source.id]), {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: [{ date: '2026-09-22', slots: ['lunch' as const] }],
      sourceIds: [source.id], availableSources: [source]
    })

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[1]).toMatchObject({
      name: '海碗居（牡丹园店）', evidenceLevel: 'pending', sourceIds: []
    })
  })

  it('模型漏传 source_ids 时按可用来源中的直接店名证据绑定', async () => {
    const plan = planWithMealStop()
    const source = createSource('海淀游览建议', 'https://example.com/guide', 'Tripwise 研究浏览器', 'web', '路线与用餐建议。')
    source.factEvidenceExcerpt = '午餐可考虑四季民福烤鸭店（故宫店），门店信息出发前复核。'
    const result = await itineraryMealRepairTool.execute({ updates: [{
      plan_number: 1, day_number: 1, date: '2026-09-22', meal_slot: 'lunch',
      restaurant_name: '四季民福烤鸭店（故宫店）', evidence_level: 'pending'
    }] }, {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: [{ date: '2026-09-22', slots: ['lunch' as const] }],
      sourceIds: [source.id], availableSources: [source]
    })

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[1]).toMatchObject({
      name: '四季民福烤鸭店（故宫店）', evidenceLevel: 'sourced', sourceIds: [source.id]
    })
  })

  it('路线来源即使包含店名也不能证明餐馆可用', async () => {
    const plan = planWithMealStop()
    const route = createSource('路线到海碗居', 'https://example.com/route', '高德地图路线规划', 'route', '预计 12 分钟。')
    const result = await itineraryMealRepairTool.execute(mealUpdate('海碗居', [route.id]), {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: [{ date: '2026-09-22', slots: ['lunch' as const] }],
      sourceIds: [route.id], availableSources: [route]
    })

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[1]).toMatchObject({
      name: '海碗居', evidenceLevel: 'pending', sourceIds: []
    })
  })

  it('把待核验用餐时间块转成具体餐馆停靠点，不编造来源或路线时长', async () => {
    const plan = planWithMealStop()
    plan.days[0].stops.splice(1, 1)
    plan.days[0].scheduleBlocks.push({
      id: 'lunch-block', kind: 'meal', title: '午餐（店面待核验）', time: '12:00–13:00',
      durationMinutes: 60, area: '五道口', notes: '用餐地点待确认。'
    })
    const result = await itineraryMealRepairTool.execute(mealUpdate('海碗居', [], 'pending'), {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: [{ date: '2026-09-22', slots: ['lunch' as const] }],
      sourceIds: [], availableSources: []
    })

    expect(result.itineraryOptions?.[0]?.days[0]?.scheduleBlocks).toEqual([])
    expect(result.itineraryOptions?.[0]?.days[0]?.stops[1]).toMatchObject({
      name: '海碗居', category: '餐饮', time: '12:00–13:00 午餐', durationMinutes: 60,
      evidenceLevel: 'pending', sourceIds: [], area: '五道口'
    })
    expect(result.itineraryOptions?.[0]?.days[0]?.stops[1].transitToNext).toContain('地铁前往圆明园')
    expect(result.itineraryOptions?.[0]?.days[0]?.stops[1].transitToNext).toContain('线路和耗时待核验')
    expect(result.itineraryOptions?.[0]?.days[0]?.stops[1].notes).toContain('出发前确认')
  })

  it('未定时的用餐时间块仍提示缺具体店面，并在无冲突窗口内完成修订', async () => {
    const plan = planWithMealStop()
    plan.days[0].stops.splice(1, 1)
    plan.days[0].scheduleBlocks.push({
      id: 'untimed-lunch', kind: 'meal', title: '午餐（店面待核验）', time: '',
      durationMinutes: null, area: '五道口', notes: '具体店面待选。'
    })
    const requirements = [{ date: '2026-09-22', slots: ['lunch' as const] }]

    expect(mealPreferenceFeedback([plan], requirements, true))
      .toContainEqual(expect.stringContaining('具体店面待选'))

    const result = await itineraryMealRepairTool.execute(mealUpdate('海碗居', [], 'pending'), {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: requirements, sourceIds: [], availableSources: []
    })

    expect(result.itineraryOptions?.[0]?.days[0]?.scheduleBlocks).toEqual([])
    expect(result.itineraryOptions?.[0]?.days[0]?.stops).toContainEqual(expect.objectContaining({
      name: '海碗居', category: '餐饮', time: '11:00–11:45 午餐', durationMinutes: 45
    }))
  })

  it('没有安全用餐窗口时拒绝修订并保留未定时的时间块', async () => {
    const plan = planWithMealStop()
    plan.days[0].stops.splice(1, 1)
    plan.days[0].stops[0]!.time = '06:00–22:00'
    plan.days[0].scheduleBlocks.push({
      id: 'untimed-lunch', kind: 'meal', title: '午餐（店面待核验）', time: '',
      durationMinutes: null, area: '五道口', notes: '具体店面待选。'
    })

    expect(itineraryMealRepairTargets([plan], [{ date: '2026-09-22', slots: ['lunch' as const] }])).toEqual([])
    await expect(itineraryMealRepairTool.execute(mealUpdate('海碗居', [], 'pending'), {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: [{ date: '2026-09-22', slots: ['lunch' as const] }],
      sourceIds: [], availableSources: []
    })).rejects.toThrow('当前候选没有待补店名的指定餐次')
    expect(plan.days[0].scheduleBlocks).toEqual([expect.objectContaining({
      id: 'untimed-lunch', time: '', durationMinutes: null
    })])
    expect(plan.days[0].stops.some((stop) => stop.name === '海碗居')).toBe(false)
  })

  it('待核验餐馆可省略来源字段；来源不足或格式错误时安全降级为待核验', async () => {
    const plan = planWithMealStop()
    const context = {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: [{ date: '2026-09-22', slots: ['lunch' as const] }],
      sourceIds: [], availableSources: []
    }
    const pending = await itineraryMealRepairTool.execute({ updates: [{
      plan_number: 1, day_number: 1, date: '2026-09-22', meal_slot: 'lunch',
      restaurant_name: '海碗居', evidence_level: 'pending'
    }] }, context)

    expect(pending.itineraryOptions?.[0]?.days[0]?.stops[1]).toMatchObject({
      name: '海碗居', evidenceLevel: 'pending', sourceIds: []
    })
    const unsupported = await itineraryMealRepairTool.execute({ updates: [{
      plan_number: 1, day_number: 1, date: '2026-09-22', meal_slot: 'lunch',
      restaurant_name: '海碗居', evidence_level: 'sourced'
    }] }, context)
    expect(unsupported.itineraryOptions?.[0]?.days[0]?.stops[1]).toMatchObject({
      name: '海碗居', evidenceLevel: 'pending', sourceIds: []
    })
    expect(unsupported.output).toContain('按待核验建议保留')
    await expect(itineraryMealRepairTool.execute({ updates: [{
      plan_number: 1, day_number: 1, date: '2026-09-22', meal_slot: 'lunch',
      restaurant_name: '海碗居', evidence_level: 'pending', source_ids: null
    }] }, context)).resolves.toMatchObject({ itineraryOptions: expect.any(Array) })
    const parameters = itineraryMealRepairTool.definition.function.parameters as {
      properties: { updates: { items: { required: string[] } } }
    }
    expect(parameters.properties.updates.items.required).not.toContain('source_ids')
    expect(itineraryMealRepairTool.definition.function.description).toContain('pending 建议')
    expect(itineraryMealRepairTool.definition.function.description).toContain('不得推断具体分店、地址或营业信息')
  })

  it('为缺失的指定餐次寻找无冲突窗口并加入可识别餐馆', async () => {
    const plan = planWithMealStop()
    plan.days[0].stops.splice(1, 1)
    const result = await itineraryMealRepairTool.execute(mealUpdate('海碗居', [], 'pending'), {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: [{ date: '2026-09-22', slots: ['lunch' as const] }],
      sourceIds: [], availableSources: []
    })

    const lunch = result.itineraryOptions?.[0]?.days[0]?.stops.find((stop) => stop.name === '海碗居')
    expect(lunch).toMatchObject({
      area: '五道口', time: '11:00–11:45 午餐', durationMinutes: 45,
      category: '餐饮', evidenceLevel: 'pending', sourceIds: []
    })
    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0].transitToNext).toContain('海碗居')
    expect(lunch?.transitToNext).toContain('圆明园')
  })

  it('没有安全用餐窗口时保留待协调餐次，不编造门店或时间', async () => {
    const plan = planWithMealStop()
    plan.days[0].stops.splice(1, 1)
    plan.days[0].stops[0]!.time = '07:00–22:00'
    plan.days[0].stops[0]!.durationMinutes = 900
    const result = await itineraryMealRepairTool.execute(mealUpdate('海碗居', [], 'pending'), {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: [{ date: '2026-09-22', slots: ['lunch' as const] }],
      sourceIds: [], availableSources: []
    })

    expect(result.output).toContain('保留了待协调时间块')
    expect(result.itineraryOptions?.[0]?.days[0]?.stops.some((stop) => stop.name === '海碗居')).toBe(false)
    expect(result.itineraryOptions?.[0]?.days[0]?.scheduleBlocks).toEqual([
      expect.objectContaining({
        kind: 'meal', title: '午餐（具体店面待核验）', time: '', durationMinutes: null,
        notes: expect.stringContaining('没有可确认的空档')
      })
    ])
  })

  it('接受餐次目标子集并保留尚未修订的目标', async () => {
    const plan = planWithMealStop()
    plan.days[0].scheduleBlocks.push({
      id: 'dinner-block', kind: 'meal', title: '晚餐（店面待核验）', time: '18:00–19:00',
      durationMinutes: 60, area: '北京西站', notes: '晚餐地点待确认。'
    })
    const result = await itineraryMealRepairTool.execute(mealUpdate('海碗居', [], 'pending'), {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: [{ date: '2026-09-22', slots: ['lunch' as const, 'dinner' as const] }],
      sourceIds: [], availableSources: []
    })

    expect(result.output).toContain('已修订 1/2')
    expect(result.itineraryOptions?.[0]?.days[0]?.stops[1].name).toBe('海碗居')
    expect(result.itineraryOptions?.[0]?.days[0]?.scheduleBlocks).toEqual(plan.days[0].scheduleBlocks)
  })

  it('局部修订只暴露目标日期的餐次，并拒绝改写受保护日期', async () => {
    const plan = planWithMealStop()
    const protectedDay = structuredClone(plan.days[0])
    const targetDay = structuredClone(plan.days[0])
    targetDay.id = 'day-2'
    targetDay.dayNumber = 2
    targetDay.date = '2026-09-23'
    targetDay.title = '返程前午餐'
    const twoDayPlan = { ...plan, days: [protectedDay, targetDay] }
    const requiredMealSlots = [
      { date: '2026-09-22', slots: ['lunch' as const] },
      { date: '2026-09-23', slots: ['lunch' as const] }
    ]
    const unchangedItineraryDates = ['2026-09-22']
    const repairContext = {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [twoDayPlan],
      requiredMealSlots, unchangedItineraryDates, sourceIds: [], availableSources: []
    }

    expect(itineraryMealRepairTargets([twoDayPlan], requiredMealSlots, unchangedItineraryDates))
      .toEqual([expect.objectContaining({ date: '2026-09-23', day_number: 2, meal_slot: 'lunch' })])

    await expect(itineraryMealRepairTool.execute({ updates: [{
      plan_number: 1, day_number: 1, date: '2026-09-22', meal_slot: 'lunch',
      restaurant_name: '海碗居', evidence_level: 'pending'
    }] }, repairContext)).rejects.toThrow(/餐次目标无效或无需修订/u)

    const result = await itineraryMealRepairTool.execute({ updates: [{
      plan_number: 1, day_number: 2, date: '2026-09-23', meal_slot: 'lunch',
      restaurant_name: '海碗居', evidence_level: 'pending'
    }] }, repairContext)
    expect(result.itineraryOptions?.[0]?.days[0]).toEqual(protectedDay)
    expect(result.itineraryOptions?.[0]?.days[1]?.stops.some((stop) => stop.name === '海碗居')).toBe(true)
  })

  it('同批有效店名照常保存，泛称餐次留待后续修订', async () => {
    const plan = planWithMealStop()
    plan.days[0].scheduleBlocks.push({
      id: 'dinner-block', kind: 'meal', title: '晚餐（店面待核验）', time: '18:00–19:00',
      durationMinutes: 60, area: '北京西站', notes: '晚餐地点待确认。'
    })
    const result = await itineraryMealRepairTool.execute({ updates: [
      {
        plan_number: 1, day_number: 1, date: '2026-09-22', meal_slot: 'lunch',
        restaurant_name: '附近餐馆', evidence_level: 'pending', source_ids: []
      },
      {
        plan_number: 1, day_number: 1, date: '2026-09-22', meal_slot: 'dinner',
        restaurant_name: '庆丰包子铺', evidence_level: 'pending', source_ids: []
      }
    ] }, {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: [{ date: '2026-09-22', slots: ['lunch' as const, 'dinner' as const] }],
      sourceIds: [], availableSources: []
    })

    expect(result.output).toContain('已修订 1/2')
    expect(result.output).toContain('1 项未采纳')
    expect(result.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'warning',
        code: 'meal_updates_rejected',
        message: expect.stringContaining('方案1第1天（2026-09-22）午餐')
      })
    ]))
    expect(result.itineraryOptions?.[0]?.days[0]?.stops.some((stop) => stop.name === '庆丰包子铺')).toBe(true)
    expect(result.itineraryOptions?.[0]?.days[0]?.stops.some((stop) => stop.name === '附近餐馆（具体店面待选）')).toBe(true)
  })

  it('餐次编号无效时返回当前方案中的正确目标编号', async () => {
    const plan = planWithMealStop()
    const result = await itineraryMealRepairTool.execute({ updates: [
      {
        plan_number: 2, day_number: 1, date: '2026-09-22', meal_slot: 'lunch',
        restaurant_name: '海碗居', evidence_level: 'pending'
      },
      {
        plan_number: 1, day_number: 1, date: '2026-09-22', meal_slot: 'dinner',
        restaurant_name: '庆丰包子铺', evidence_level: 'pending'
      }
    ] }, {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: [{ date: '2026-09-22', slots: ['lunch' as const, 'dinner' as const] }],
      sourceIds: [], availableSources: []
    })

    expect(result.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'warning',
        code: 'meal_updates_rejected',
        message: expect.stringContaining('方案1第1天（2026-09-22）午餐')
      })
    ]))
    expect(result.itineraryOptions?.[0]?.days[0]?.stops.some((stop) => stop.name === '庆丰包子铺')).toBe(true)
  })

  it('拒绝缺项和占位店名；未知或不匹配来源不会被挂作证据', async () => {
    const plan = planWithMealStop()
    const source = createSource('北京餐馆攻略', 'https://example.com/guide', '网页搜索', 'web', '列出当地美食片区。')
    const context = {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: [{ date: '2026-09-22', slots: ['lunch' as const] }],
      sourceIds: [source.id], availableSources: [source]
    }

    await expect(itineraryMealRepairTool.execute({ updates: [] }, context)).rejects.toThrow(/至少一项/u)
    await expect(itineraryMealRepairTool.execute(mealUpdate('附近餐馆', [], 'pending'), context))
      .rejects.toThrow(/可识别的餐馆名称/u)
    for (const sourceIds of [['unknown-source'], [source.id]]) {
      const result = await itineraryMealRepairTool.execute(mealUpdate('海碗居', sourceIds), context)
      expect(result.itineraryOptions?.[0]?.days[0]?.stops[1]).toMatchObject({
        name: '海碗居', evidenceLevel: 'pending', sourceIds: []
      })
    }
  })

  it('每日地点达到系统上限时保留用餐时间块并拒绝新增地点', async () => {
    const plan = planWithMealStop()
    plan.days[0].stops.splice(1, 1)
    while (plan.days[0].stops.length < MAX_ITINERARY_STOPS_PER_DAY) {
      const number = plan.days[0].stops.length + 1
      plan.days[0].stops.push({
        id: `stop-${number}`, name: `第${number}站`, area: '海淀区', time: '10:00',
        durationMinutes: 15, category: '景点', notes: '', transitToNext: '',
        evidenceLevel: 'pending', sourceIds: [], factClaims: []
      })
    }
    plan.days[0].scheduleBlocks.push({
      id: 'lunch-block', kind: 'meal', title: '午餐（店面待核验）', time: '12:00–13:00',
      durationMinutes: 60, area: '五道口', notes: '用餐地点待确认。'
    })

    await expect(itineraryMealRepairTool.execute(mealUpdate('海碗居', [], 'pending'), {
      amapKey: null, requireNamedMealStops: true, itineraryOptions: [plan],
      requiredMealSlots: [{ date: '2026-09-22', slots: ['lunch' as const] }],
      sourceIds: [], availableSources: []
    })).rejects.toThrow(`每天最多保留 ${MAX_ITINERARY_STOPS_PER_DAY} 个地点`)
    expect(plan.days[0].scheduleBlocks).toHaveLength(1)
  })
})
