/** 验证行程地理提醒仅指出片区标注中的往返，不改动计划内容。 */
import { describe, expect, it } from 'vitest'
import type { ItineraryDay, ItineraryOption } from '../src/shared/types.js'
import {
  itineraryGeographicReview,
  repeatedLandmarkReviews,
  repeatedLandmarkRevisionSuggestion
} from '../src/shared/itinerary-geography.js'

/** 构造只包含地点区域和类别的行程日，聚焦验证地理顺序推导。 */
function day(stops: Array<{ name: string; area: string; category?: string }>): ItineraryDay {
  return {
    id: 'day-1', dayNumber: 1, date: '2026-11-06', title: '北京一日', scheduleBlocks: [],
    stops: stops.map((stop, index) => ({
      id: `stop-${index}`, name: stop.name, area: stop.area, time: '', durationMinutes: null,
      category: stop.category ?? '景点', notes: '', transitToNext: ''
    }))
  }
}

describe('行程片区顺序提醒', () => {
  it('识别离开片区后再次返回，并保留可读顺序供用户审阅', () => {
    const review = itineraryGeographicReview(day([
      { name: '天安门广场', area: '北京市·东城区·前门' },
      { name: '天坛公园', area: '东城区·天坛' },
      { name: '晚餐', area: '前门大街', category: '餐饮' }
    ]), '北京')

    expect(review).toEqual({
      dayNumber: 1,
      date: '2026-11-06',
      areaSequence: ['前门', '天坛', '前门大街']
    })
  })

  it('相邻同片区停靠点会合并，不把连续游览误判为往返', () => {
    const review = itineraryGeographicReview(day([
      { name: '故宫', area: '东城区·故宫片区' },
      { name: '景山', area: '故宫片区' },
      { name: '北海', area: '西城区·北海' }
    ]), '北京')

    expect(review).toBeUndefined()
  })

  it('忽略没有区域的地点与交通、住宿、休息锚点', () => {
    const review = itineraryGeographicReview(day([
      { name: '故宫', area: '故宫' },
      { name: '乘地铁', area: '天坛', category: '交通接驳' },
      { name: '天坛', area: '天坛' },
      { name: '酒店休息', area: '故宫', category: '住宿' },
      { name: '什刹海', area: '什刹海' }
    ]), '北京')

    expect(review).toBeUndefined()
  })
})

describe('跨日重复景点提醒', () => {
  it('只按规范化后的完整名称识别不同日期的重复景点', () => {
    const option: ItineraryOption = {
      id: 'repeat-check', title: '北京行程', summary: '', tradeoffs: '',
      days: [
        day([{ name: '中国国家博物馆', area: '天安门' }]),
        { ...day([{ name: '中国 国家博物馆', area: '天安门' }]), id: 'day-2', dayNumber: 2, date: '2026-09-25' },
        { ...day([{ name: '首都博物馆', area: '白云路' }]), id: 'day-3', dayNumber: 3, date: '2026-09-26' }
      ]
    }

    expect(repeatedLandmarkReviews(option)).toEqual([{
      name: '中国国家博物馆',
      visits: [
        { dayNumber: 1, date: '2026-11-06' },
        { dayNumber: 2, date: '2026-09-25' }
      ]
    }])
    expect(repeatedLandmarkRevisionSuggestion(repeatedLandmarkReviews(option))).toContain(
      '中国国家博物馆（第 1 天（2026-11-06）、第 2 天（2026-09-25））'
    )
    expect(repeatedLandmarkRevisionSuggestion(repeatedLandmarkReviews(option))).toContain('只调整涉及的日期，其他日期不变')
  })

  it('忽略非景点停靠点，并保留跨日同名景点', () => {
    const option: ItineraryOption = {
      id: 'non-landmark-repeat', title: '北京行程', summary: '', tradeoffs: '',
      days: [
        day([
          { name: '故宫博物院', area: '故宫' },
          { name: '午餐', area: '故宫', category: '餐饮' },
          { name: '北京西站', area: '西站', category: '交通接驳' }
        ]),
        { ...day([
          { name: '故宫博物院', area: '故宫' },
          { name: '午餐', area: '故宫', category: '餐饮' },
          { name: '北京西站', area: '西站', category: '交通接驳' }
        ]), id: 'day-2', dayNumber: 2 }
      ]
    }

    expect(repeatedLandmarkReviews(option)).toEqual([{ name: '故宫博物院', visits: [
      { dayNumber: 1, date: '2026-11-06' }, { dayNumber: 2, date: '2026-11-06' }
    ] }])
  })

  it('不把同一天内的重复名称当作跨日重复', () => {
    const option: ItineraryOption = {
      id: 'same-day-repeat', title: '北京行程', summary: '', tradeoffs: '',
      days: [day([
        { name: '故宫博物院', area: '故宫' },
        { name: '故宫博物院', area: '故宫' }
      ])]
    }

    expect(repeatedLandmarkReviews(option)).toEqual([])
  })
})
