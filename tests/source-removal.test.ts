/** 验证移除来源会清理所有结构化引用并降级受影响的证据状态。 */
import { describe, expect, it } from 'vitest'
import type { ItineraryOption, PreparationItem, SourceRecord, Trip } from '../src/shared/types.js'
import { removeSourceFromTrip } from '../src/shared/source-removal.js'

const now = '2026-10-18T12:00:00.000Z'

function source(id: string, kind: SourceRecord['kind']): SourceRecord {
  return {
    id, title: id, url: `https://example.com/${id}`, provider: '测试来源', kind,
    summary: '测试摘要', fetchedAt: now, status: 'success'
  }
}

function preparationItem(id: string, sourceIds: string[], locationContext?: PreparationItem['locationContext']): PreparationItem {
  return {
    id, title: '附近餐饮', category: 'food', detail: '测试建议', itineraryDate: '2026-09-27', dueDate: '',
    locationContext, evidenceLevel: 'sourced', sourceIds, checked: false
  }
}

function tripFixture(): Trip {
  const itinerary: ItineraryOption = {
    id: 'option-1', title: '测试方案', summary: '摘要', tradeoffs: '取舍',
    budgetEstimate: {
      currency: 'CNY',
      items: [
        { id: 'budget-flight', category: 'flight', title: '机票', amountMinFen: 100_000, amountMaxFen: 120_000, quantity: 1, unitLabel: '人', evidenceLevel: 'sourced', sourceIds: ['article-1'], basis: '来源记录给出价格范围。' },
        { id: 'budget-intercity', category: 'intercity-transport', title: '城际交通', amountMinFen: null, amountMaxFen: null, quantity: 1, unitLabel: '人', evidenceLevel: 'pending', sourceIds: [], basis: '出发地未确定。' },
        { id: 'budget-lodging', category: 'lodging', title: '住宿', amountMinFen: 30_000, amountMaxFen: 60_000, quantity: 2, unitLabel: '晚', evidenceLevel: 'estimated', sourceIds: ['article-1'], basis: '按普通酒店估算。' },
        { id: 'budget-local', category: 'local-transport', title: '市内交通', amountMinFen: 1_000, amountMaxFen: 3_000, quantity: 1, unitLabel: '人', evidenceLevel: 'estimated', sourceIds: [], basis: '按公共交通估算。' },
        { id: 'budget-tickets', category: 'tickets', title: '门票', amountMinFen: 0, amountMaxFen: 10_000, quantity: 1, unitLabel: '人', evidenceLevel: 'estimated', sourceIds: [], basis: '待按景点开放情况复核。' },
        { id: 'budget-meals', category: 'meals', title: '餐饮', amountMinFen: 10_000, amountMaxFen: 20_000, quantity: 1, unitLabel: '人', evidenceLevel: 'estimated', sourceIds: [], basis: '按普通用餐估算。' }
      ],
      notApplicableCategories: [{ category: 'other', reason: '不含个人购物。' }]
    },
    days: [{
      id: 'day-1', dayNumber: 1, date: '2026-09-27', title: '第一天', scheduleBlocks: [],
      weather: { status: 'forecast', summary: '2026-09-27：晴，12–20°C', sourceId: 'weather-1' },
      lodgingCommutes: [{
        direction: 'from-lodging', lodgingLocation: '王府井某酒店', stopId: 'stop-1', sourceId: 'route-1',
        mode: 'walking', optionNumber: 1, durationMinutes: 20, distanceMeters: 1_200
      }],
      stops: [
        {
          id: 'stop-1', name: '故宫', area: '东城', time: '09:00', durationMinutes: 120, category: '人文',
          notes: '', transitToNext: '路线服务估计地铁 20 分钟', evidenceLevel: 'sourced',
          sourceIds: ['article-1', 'place-1'],
          factClaims: [
            { id: 'claim-1', type: 'opening-hours', value: '09:00 开门', scope: '2026-09-27', evidenceLevel: 'sourced', sourceId: 'article-1' },
            { id: 'claim-2', type: 'ticket-price', value: '60 元', scope: '常规票', evidenceLevel: 'sourced', sourceId: 'place-1' }
          ],
          location: { latitude: 39.9, longitude: 116.4, label: '故宫', coordinateSystem: 'wgs84', sourceId: 'article-1', provider: '测试地图', fetchedAt: now },
          transitEstimate: { sourceId: 'route-1', destinationStopId: 'stop-2', mode: 'transit', optionNumber: 1, fetchedAt: now }
        },
        { id: 'stop-2', name: '景山', area: '东城', time: '12:00', durationMinutes: 60, category: '公园', notes: '', transitToNext: '' }
      ]
    }]
  }
  const sourcedPreparation = preparationItem('food-1', ['article-1'], {
    dayNumber: 1, dayTitle: '第一天', stopId: 'stop-1', stopName: '故宫', area: '东城',
    placeSourceId: 'article-1', placeName: '附近餐饮'
  })
  const routedPreparation = preparationItem('food-2', ['place-1', 'route-1'], {
    dayNumber: 1, dayTitle: '第一天', stopId: 'stop-1', stopName: '故宫', area: '东城',
    placeSourceId: 'place-1', placeName: '附近餐饮', routeOptionNumber: 1,
    distanceMeters: 800, durationMinutes: 15, routeSourceId: 'route-1'
  })
  return {
    id: 'trip-1', title: '测试旅行', createdAt: now, updatedAt: now,
    conversations: [{ id: 'conversation-1', title: '总体规划', createdAt: now, updatedAt: now }],
    activeConversationId: 'conversation-1',
    brief: {
      departureCity: '', destination: '北京', startDate: '2026-09-27', endDate: '2026-09-27', arrivalFlight: '',
      arrivalTime: '', leaveTime: '', travelers: '', budget: '', lodgingLocation: '', lodging: '', pace: '', earlyStart: '',
      interests: '', transport: '', dietary: '', luggage: '', clothing: '', constraints: ''
    },
    briefUnknownFields: [],
    messages: [{
      id: 'message-1', conversationId: 'conversation-1', role: 'assistant', content: '历史回答保留用户已读的文字。', createdAt: now,
      sourceIds: ['article-1', 'place-1'], itineraryOptions: [itinerary], preparationOptions: [sourcedPreparation]
    }],
    sources: [source('article-1', 'web'), source('place-1', 'place'), source('route-1', 'route'), source('weather-1', 'weather')],
    preparationItems: [sourcedPreparation, routedPreparation],
    revisions: [{ id: 'revision-1', number: 1, createdAt: now, summary: '测试方案', content: '原始 Markdown', sourceIds: ['article-1', 'place-1', 'route-1'], itinerary }],
    activeRevisionId: 'revision-1'
  }
}

describe('单条旅行来源移除', () => {
  it('清理所有结构化引用、使受影响证据待核验，并保留无关来源和历史文字', () => {
    const original = tripFixture()
    const updated = removeSourceFromTrip(original, 'article-1')
    const optionStop = updated.messages[0].itineraryOptions![0].days[0].stops[0]
    const revisionStop = updated.revisions[0].itinerary!.days[0].stops[0]

    expect(updated.sources.map((item) => item.id)).toEqual(['place-1', 'route-1', 'weather-1'])
    expect(updated.messages[0].sourceIds).toEqual(['place-1'])
    expect(optionStop.sourceIds).toEqual(['place-1'])
    expect(optionStop.evidenceLevel).toBe('pending')
    expect(optionStop.location).toBeUndefined()
    expect(updated.messages[0].itineraryOptions?.[0].budgetEstimate?.items[0]).toMatchObject({
      evidenceLevel: 'pending', amountMinFen: null, amountMaxFen: null, sourceIds: []
    })
    expect(updated.revisions[0].itinerary?.budgetEstimate?.items[2]).toMatchObject({
      evidenceLevel: 'estimated', amountMinFen: 30_000, amountMaxFen: 60_000, sourceIds: []
    })
    expect(updated.revisions[0].itinerary?.budgetEstimate?.items[2].basis).toContain('来源已移除，需复核')
    expect(optionStop.factClaims?.[0]).toMatchObject({ value: '09:00 开门', evidenceLevel: 'pending', sourceId: undefined })
    expect(optionStop.factClaims?.[1]).toMatchObject({ value: '60 元', evidenceLevel: 'sourced', sourceId: 'place-1' })
    expect(revisionStop.location).toBeUndefined()

    expect(updated.messages[0].preparationOptions?.[0]).toMatchObject({ sourceIds: [], evidenceLevel: 'pending', locationContext: undefined })
    expect(updated.preparationItems[0]).toMatchObject({ sourceIds: [], evidenceLevel: 'pending', locationContext: undefined })
    expect(updated.preparationItems[1]).toMatchObject({
      sourceIds: ['place-1', 'route-1'], evidenceLevel: 'sourced',
      locationContext: { placeSourceId: 'place-1', routeSourceId: 'route-1', durationMinutes: 15 }
    })
    expect(updated.messages[0].content).toBe('历史回答保留用户已读的文字。')
    expect(original.sources).toHaveLength(4)
    expect(original.messages[0].sourceIds).toContain('article-1')

    const routeRemoved = removeSourceFromTrip(original, 'route-1')
    const routeStop = routeRemoved.revisions[0].itinerary!.days[0].stops[0]
    expect(routeStop.transitEstimate).toBeUndefined()
    expect(routeStop.transitToNext).toBe('')
    expect(routeRemoved.preparationItems[1]).toMatchObject({
      sourceIds: ['place-1'], evidenceLevel: 'pending',
      locationContext: { placeSourceId: 'place-1' }
    })
    expect(routeRemoved.preparationItems[1].locationContext).not.toHaveProperty('routeOptionNumber')
    expect(routeRemoved.preparationItems[1].locationContext).not.toHaveProperty('routeSourceId')
    expect(routeRemoved.revisions[0].itinerary?.days[0].lodgingCommutes).toEqual([])
  })

  it('拒绝移除不存在的来源', () => {
    expect(() => removeSourceFromTrip(tripFixture(), 'missing-source')).toThrow('找不到要移除的旅行来源')
  })

  it('移除逐日天气来源时保留明确的未知状态，不留下失效引用', () => {
    const updated = removeSourceFromTrip(tripFixture(), 'weather-1')
    const optionWeather = updated.messages[0].itineraryOptions![0].days[0].weather
    const revisionWeather = updated.revisions[0].itinerary!.days[0].weather

    expect(optionWeather).toEqual({ status: 'unknown', summary: '天气来源已移除，本日天气待核验。' })
    expect(revisionWeather).toEqual(optionWeather)
    expect(updated.sources.map((item) => item.id)).not.toContain('weather-1')
  })
})
