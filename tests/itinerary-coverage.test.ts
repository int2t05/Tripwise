/** 验证单份方案会保留用户给出的参考地点覆盖要求。 */
import { describe, expect, it } from 'vitest'
import type { ItineraryOption, TripBrief } from '../src/shared/types.js'
import { itineraryProposalTool, userReferencedVisits } from '../src/main/connectors/itinerary.js'

const visitNames = ['颐和园', '天坛公园', '中国国家博物馆', '前门大街']
const request = '至少覆盖 3/4 项 9/24 的参考地点：颐和园、天坛、国家博物馆、前门。'

/** 构造按日期排列的地点，避免测试依赖完整旅行数据层。 */
function itinerary(names: string[], title: string): ItineraryOption {
  return {
    id: title, title, summary: '', tradeoffs: '',
    days: [{
      id: `${title}-day`, dayNumber: 1, date: '2026-09-24', title: '北京游览', scheduleBlocks: [],
      stops: names.map((name, index) => ({
        id: `${title}-${index}`, name, area: '北京',
        time: `${String(9 + index).padStart(2, '0')}:00–${String(10 + index).padStart(2, '0')}:00`,
        durationMinutes: 60, category: '景点', notes: '', transitToNext: ''
      }))
    }]
  }
}

/** 转成模型工具接受的 snake_case 结构。 */
function rawPlan(names: string[]) {
  return {
    title: '北京行程', summary: '按日期安排。', tradeoffs: '',
    days: [{
      day_number: 1, date: '2026-09-24', title: '北京游览',
      stops: names.map((name, index) => ({
        name, area: '北京', time: `${String(9 + index).padStart(2, '0')}:00–${String(10 + index).padStart(2, '0')}:00`,
        duration_minutes: 60, category: '景点', notes: '', transit_to_next: ''
      }))
    }]
  }
}

/** 提供最小旅行简报，只测试用户原话中的覆盖约束。 */
function brief(constraints: string): TripBrief {
  return {
    departureCity: '', destination: '北京', startDate: '2026-09-24', endDate: '2026-09-24',
    arrivalFlight: '', arrivalTime: '', leaveTime: '', travelers: '', budget: '',
    lodgingLocation: '', lodging: '', pace: '', earlyStart: '', interests: '',
    transport: '', dietary: '', luggage: '', clothing: '', constraints
  }
}

describe('单份方案参考地点覆盖', () => {
  it('从计划提取用户原话中按日期提到的景点别名', () => {
    const visits = userReferencedVisits(itinerary(visitNames, '完整方案'), request)

    expect(visits.map((visit) => visit.name)).toEqual(visitNames)
  })

  it('用户给出最低覆盖比例时将缺口作为 warning 保留候选', async () => {
    const result = await itineraryProposalTool.execute({ plans: [rawPlan(['颐和园', '国家博物馆'])] }, {
      amapKey: null, researchCompleted: true, userRequest: request, tripBrief: brief(request)
    })

    expect(result.itineraryOptions).toHaveLength(1)
    expect(result.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: 'warning', message: expect.stringContaining('本份方案覆盖 2/4 个用户点名的参考地点')
      })
    ]))
  })

  it('没有达到最低覆盖比例时仍返回结构有效的一份草案', async () => {
    const result = await itineraryProposalTool.execute({ plans: [rawPlan(['颐和园', '国家博物馆'])] }, {
      amapKey: null, researchCompleted: true, userRequest: request, tripBrief: brief(request)
    })

    expect(result.itineraryOptions).toHaveLength(1)
    expect(result.feedback?.every((item) => item.severity !== 'error')).toBe(true)
  })

  it('达到最低覆盖比例时接受单份方案', async () => {
    const result = await itineraryProposalTool.execute({ plans: [rawPlan(['颐和园', '天坛', '前门'])] }, {
      amapKey: null, researchCompleted: true, userRequest: request, tripBrief: brief(request)
    })

    expect(result.itineraryOptions).toHaveLength(1)
  })
})
