/** 验证餐次搜索按片区合并，并保留可用于来源核验的商户名称。 */
import { describe, expect, it } from 'vitest'
import type { ItineraryMealRepairTarget } from '../src/main/connectors/itinerary-meals.js'
import type { ItineraryOption } from '../src/shared/types.js'
import { mealQueryNeedsBrowserFollowup, namedMealResearchQueries, selectMealResearchQueries } from '../src/main/agent-meal-research.js'

function target(
  dayNumber: number, date: string, mealSlot: ItineraryMealRepairTarget['meal_slot'],
  currentName: string, area: string
): ItineraryMealRepairTarget {
  return {
    plan_number: 1, day_number: dayNumber, date, meal_slot: mealSlot,
    current_name: currentName, area, time: mealSlot === 'lunch' ? '12:00–13:00' : '18:00–19:00'
  }
}

const plan: ItineraryOption = {
  id: 'plan-1', title: '北京两日游', summary: '', tradeoffs: '',
  days: [
    {
      id: 'day-1', dayNumber: 1, date: '2026-11-03', title: '前门', scheduleBlocks: [], stops: [
        { id: 'palace', name: '故宫博物院', area: '前门', time: '10:00–11:30', durationMinutes: 90,
          category: '景点', notes: '', transitToNext: '' },
        { id: 'lunch', name: '海碗居（前门店）', area: '前门片区', time: '12:00–13:00 午餐', durationMinutes: 60,
          category: '餐饮', notes: '', transitToNext: '' },
        { id: 'qianmen', name: '前门大街', area: '前门', time: '14:00–17:00', durationMinutes: 180,
          category: '街区', notes: '', transitToNext: '' },
        { id: 'dinner', name: '都一处', area: '前门', time: '18:00–19:00 晚餐', durationMinutes: 60,
          category: '餐饮', notes: '', transitToNext: '' }
      ]
    },
    {
      id: 'day-2', dayNumber: 2, date: '2026-11-04', title: '海淀', scheduleBlocks: [], stops: [
        { id: 'campus', name: '清华大学', area: '海淀区', time: '09:00–11:30', durationMinutes: 150,
          category: '校园', notes: '', transitToNext: '' },
        { id: 'wudaokou-meal', name: '五道口附近餐馆', area: '五道口', time: '12:00–13:00 午餐', durationMinutes: 60,
          category: '餐饮', notes: '', transitToNext: '' }
      ]
    }
  ]
}

describe('餐次定向搜索', () => {
  it('合并相邻片区的餐次，并将不同片区保留为独立查询', () => {
    const queries = namedMealResearchQueries([plan], [
      target(1, '2026-11-03', 'lunch', '海碗居（前门店）', '前门片区'),
      target(1, '2026-11-03', 'dinner', '都一处', '前门'),
      target(2, '2026-11-04', 'lunch', '', '五道口')
    ], '北京')

    expect(queries).toHaveLength(2)
    const verification = queries.filter((item) => item.purpose === 'source-verification').map((item) => item.query)
    const discovery = queries.filter((item) => item.purpose === 'name-discovery').map((item) => item.query)
    expect(verification).toHaveLength(1)
    expect(verification[0]).toContain('海碗居（前门店）')
    expect(verification[0]).toContain('都一处')
    expect(verification[0]).toContain('前门')
    expect(discovery).toHaveLength(1)
    expect(discovery[0]).toContain('五道口')
    expect(discovery[0]).toContain('具体店名')
  })

  it('同一片区名称过多时按两家一组，查询长度符合搜索接口限制', () => {
    const queries = namedMealResearchQueries([plan], [
      target(1, '2026-11-03', 'lunch', '海碗居（前门店）', '前门'),
      target(1, '2026-11-03', 'dinner', '都一处', '前门'),
      target(1, '2026-11-03', 'lunch', '庆丰包子铺', '前门'),
      target(1, '2026-11-03', 'dinner', '全聚德前门店', '前门')
    ], '北京')

    expect(queries).toHaveLength(2)
    expect(queries.every((item) => item.query.length <= 180)).toBe(true)
    expect(queries.map((item) => item.query).join('\n')).toContain('全聚德前门店')
  })

  it('将缺少店名的餐次与已有店名核验分成不同查询', () => {
    const queries = namedMealResearchQueries([plan], [
      target(1, '2026-11-03', 'lunch', '海碗居（前门店）', '前门'),
      target(1, '2026-11-03', 'dinner', '', '前门')
    ], '北京')

    expect(queries).toHaveLength(2)
    expect(queries[0]?.purpose).toBe('name-discovery')
    expect(queries[0]?.query).toContain('餐馆推荐')
    expect(queries[0]?.query).not.toContain('海碗居')
    expect(queries[1]?.purpose).toBe('source-verification')
    expect(queries[1]?.query).toContain('海碗居（前门店）')
    expect(queries[1]?.query).toContain('门店地址')
  })

  it('预算优先用于为缺少店名的餐次发现候选，余量再核验已有店名', () => {
    const selected = selectMealResearchQueries([
      { purpose: 'source-verification', query: '北京 前门 海碗居 午餐 门店地址' },
      { purpose: 'name-discovery', query: '北京 前门 午餐 餐馆推荐 具体店名' },
      { purpose: 'name-discovery', query: '北京 五道口 晚餐 餐馆推荐 具体店名' }
    ], 2)

    expect(selected).toHaveLength(2)
    expect(selected.every((item) => item.purpose === 'name-discovery')).toBe(true)
    expect(selectMealResearchQueries([
      { purpose: 'name-discovery', query: '北京 前门 午餐 餐馆推荐 具体店名' },
      { purpose: 'source-verification', query: '北京 前门 海碗居 午餐 门店地址' }
    ], 2)).toEqual([
      { purpose: 'name-discovery', query: '北京 前门 午餐 餐馆推荐 具体店名' },
      { purpose: 'source-verification', query: '北京 前门 海碗居 午餐 门店地址' }
    ])
  })

  it('搜索摘要没有直接支持目标门店时继续跟进网页，门店名已直证时停止', () => {
    const targetMeal = target(1, '2026-11-03', 'lunch', '四季民福烤鸭店（故宫店）', '东城区')
    const query = '北京 东城区 四季民福烤鸭店（故宫店） 午餐 餐馆 门店地址'
    const source = {
      id: 'restaurant-page', title: '四季民福烤鸭店故宫店门店信息',
      url: 'https://example.com/restaurant', provider: '测试搜索结果', kind: 'web' as const,
      summary: '北京餐饮门店信息。', fetchedAt: '2026-09-27T00:00:00.000Z',
      status: 'success' as const, contentLevel: 'page' as const
    }

    expect(mealQueryNeedsBrowserFollowup(query, [targetMeal], [source])).toBe(false)
    expect(mealQueryNeedsBrowserFollowup(query, [targetMeal], [{
      ...source, id: 'generic-snippet', title: '北京餐饮门店信息', contentLevel: 'snippet'
    }])).toBe(true)
    expect(mealQueryNeedsBrowserFollowup('北京 五道口 午餐 餐馆推荐', [
      target(2, '2026-11-04', 'lunch', '', '五道口')
    ], [source])).toBe(true)
  })
})
