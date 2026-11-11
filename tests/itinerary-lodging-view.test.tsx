/** 验证候选与确认行程中的住宿接驳状态清晰且可追溯。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ItineraryOption, LodgingCommute, SourceRecord, TripBrief } from '../src/shared/types.js'
import { LodgingCommuteTimelineCard, ScheduleFeasibility } from '../src/renderer/src/ItineraryPlans'

const hotel = '北京市东城区王府井某酒店'
const day = {
  id: 'day-1', dayNumber: 1, date: '2026-09-27', title: '第一天', scheduleBlocks: [],
  stops: [{ id: 'stop-1', name: '故宫博物院', area: '东城区', time: '09:00', durationMinutes: 120, category: '人文', notes: '', transitToNext: '' }]
}
const commute: LodgingCommute = {
  direction: 'from-lodging', lodgingLocation: hotel, stopId: 'stop-1', sourceId: 'route-1',
  mode: 'walking', optionNumber: 1, durationMinutes: 20, distanceMeters: 1_200
}
const routeSource: SourceRecord = {
  id: 'route-1', title: `${hotel} → 故宫博物院`, url: 'https://ditu.amap.com/search?query=route',
  provider: '高德地图路线规划', kind: 'route', summary: `${hotel} → 故宫博物院，步行估算：\n方案 1：约 20 分钟 · 1.2 km`,
  fetchedAt: '2026-10-18T12:00:00.000Z', status: 'success'
}
const brief: TripBrief = {
  departureCity: '', destination: '北京', startDate: '2026-09-27', endDate: '2026-09-27', arrivalFlight: '', arrivalTime: '', leaveTime: '',
  travelers: '', budget: '', lodgingLocation: hotel, lodging: '', pace: '', earlyStart: '', interests: '', transport: '', dietary: '', luggage: '',
  clothing: '', constraints: ''
}
const itinerary: ItineraryOption = {
  id: 'option-1', title: '故宫慢游', summary: '集中游览故宫。', tradeoffs: '减少跨区移动。',
  days: [{ ...day, lodgingCommutes: [commute] }]
}

describe('住宿接驳行程视图', () => {
  it('明确提示具体住宿已填但某日接驳没有估算', () => {
    const markup = renderToStaticMarkup(<ScheduleFeasibility itinerary={{ ...itinerary, days: [day] }} anchors={brief} sources={[]} />)

    expect(markup).toContain('具体住宿已填写')
    expect(markup).toContain('住宿→首站')
    expect(markup).toContain('如会影响当天安排，请按需查询路线')
  })

  it('展示接驳端点、路线数值与可打开来源，来源失败时提示复核', () => {
    const failedSource = { ...routeSource, status: 'unavailable' as const }
    const markup = renderToStaticMarkup(<LodgingCommuteTimelineCard
      commute={commute} day={day} lodgingLocation={hotel} sources={[failedSource]}
      onOpen={() => undefined} onShowSource={() => undefined}
    />)

    expect(markup).toContain(`${hotel} → 故宫博物院`)
    expect(markup).toContain('步行约 20 分钟')
    expect(markup).toContain('1.2 公里')
    expect(markup).toContain('查看路线来源')
    expect(markup).toContain('来源状态已变化')
  })

  it('来源状态正常时不误报为待复核', () => {
    const markup = renderToStaticMarkup(<LodgingCommuteTimelineCard
      commute={commute} day={day} lodgingLocation={hotel} sources={[routeSource]}
      onOpen={() => undefined} onShowSource={() => undefined}
    />)

    expect(markup).toContain('查看路线来源')
    expect(markup).not.toContain('role="alert"')
  })

  it('候选计划可从住宿接驳卡就地发起修改，确认行程视图不显示该入口', () => {
    const draftMarkup = renderToStaticMarkup(<LodgingCommuteTimelineCard
      commute={commute} day={day} lodgingLocation={hotel} sources={[routeSource]}
      onOpen={() => undefined} onShowSource={() => undefined} onContinueRevision={() => undefined}
    />)
    const savedMarkup = renderToStaticMarkup(<LodgingCommuteTimelineCard
      commute={commute} day={day} lodgingLocation={hotel} sources={[routeSource]}
      onOpen={() => undefined} onShowSource={() => undefined}
    />)

    expect(draftMarkup).toContain('调整这段接驳')
    expect(savedMarkup).not.toContain('调整这段接驳')
  })
})
