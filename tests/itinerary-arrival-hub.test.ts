/** 验证首日交通枢纽必须来自用户提供的信息。 */
import { describe, expect, it } from 'vitest'
import type { TripBrief } from '../src/shared/types.js'
import { itineraryProposalTool } from '../src/main/connectors/itinerary.js'
import { isUnresolvedAttractionName } from '../src/shared/itinerary-placeholders.js'

const brief: TripBrief = {
  departureCity: '广州', destination: '北京', startDate: '2026-11-05', endDate: '2026-11-05',
  arrivalFlight: '', arrivalTime: '', leaveTime: '', travelers: '', budget: '',
  lodgingLocation: '', lodging: '', pace: '', earlyStart: '', interests: '',
  transport: '', dietary: '', luggage: '', clothing: '', constraints: ''
}

function rawPlan(arrivalStop: string) {
  return {
    title: '北京一日游', summary: '按区域安排。', tradeoffs: '',
    days: [{
      day_number: 1, date: brief.startDate, title: '市区游览',
      stops: [
        { name: arrivalStop, area: '北京', time: '上午', category: '交通', notes: '抵达后进城' },
        { name: '故宫博物院', area: '东城', time: '中午', category: '景点', notes: '游览中轴线' }
      ]
    }]
  }
}

async function propose(arrivalStop: string, userRequest: string, tripBrief: TripBrief = brief) {
  const result = await itineraryProposalTool.execute({ plan: rawPlan(arrivalStop) }, {
    amapKey: null, researchCompleted: true, userRequest, tripBrief
  })
  return result.itineraryOptions?.[0]?.days[0]?.stops[0]
}

describe('首日抵达地点来源约束', () => {
  it('没有抵达信息时把模型猜出的机场降级为通用待确认锚点', async () => {
    const stop = await propose('北京首都国际机场', '规划广州到北京的行程。')

    expect(stop).toMatchObject({
      name: '抵达交通（地点待确认）',
      category: '交通',
      evidenceLevel: 'pending'
    })
    expect(stop?.transitToNext).not.toContain('首都机场')
    expect(stop?.notes).toContain('抵达机场或车站未提供')
  })

  it('用户明确提供机场时保留该地点', async () => {
    const stop = await propose('北京首都国际机场', '抵达点是北京首都机场，请从那里安排进城。')

    expect(stop?.name).toBe('北京首都国际机场')
  })

  it('目的地城市本身不算用户确认了同名机场', async () => {
    const stop = await propose('成都机场', '我去成都旅行。', { ...brief, destination: '成都' })

    expect(stop?.name).toBe('抵达交通（地点待确认）')
    expect(stop?.notes).toContain('抵达机场或车站未提供')
  })

  it('用户未提供机场时清除首日时间块中的机场猜测', async () => {
    const arrivalBrief = { ...brief, arrivalFlight: '用户提供航班', arrivalTime: '22:10' }
    const result = await itineraryProposalTool.execute({ plan: {
      ...rawPlan('成都天府国际机场'),
      days: [{
        ...rawPlan('成都天府国际机场').days[0],
        schedule_blocks: [{
          kind: 'buffer', title: '成都天府国际机场取行李', time: '22:10-23:00',
          duration_minutes: 50, area: '成都天府国际机场', notes: '机场下机、取行李后进城。'
        }]
      }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '我 22:10 落地，第一晚不安排景点。',
      tripBrief: arrivalBrief
    })
    const block = result.itineraryOptions?.[0]?.days[0]?.scheduleBlocks[0]

    expect(block).toMatchObject({
      title: '抵达后离站与行李缓冲',
      area: '',
      notes: '抵达机场或车站未提供；离站、取行李与前往住宿的时间待核验。'
    })
  })

  it('缺少机场和住宿位置时，不把模型估算的入住钟点当成确定安排', async () => {
    const arrivalBrief = {
      ...brief,
      endDate: '2026-11-06',
      destination: '成都',
      arrivalFlight: '用户提供航班',
      arrivalTime: '22:10',
      constraints: '第一晚抵达后办理入住，接驳信息待核验。'
    }
    const result = await itineraryProposalTool.execute({ plan: {
      title: '成都两日行程', summary: '按抵达日期安排。', tradeoffs: '',
      days: [
        { day_number: 1, date: arrivalBrief.startDate, title: '抵达入住', stops: [
          { name: '抵达交通（地点待确认）', area: '', time: '22:10', category: '交通', notes: '抵达时间来自用户提供；机场和路线待核验。' },
          { name: '入住酒店', area: '成都', time: '23:30 前后（视接驳耗时）', category: '住宿', notes: '前往酒店后办理入住。' }
        ] },
        { day_number: 2, date: arrivalBrief.endDate, title: '市区游览', stops: [
          { name: '成都博物馆', area: '市中心', time: '上午', category: '景点', notes: '开放时间待核验。' }
        ] }
      ]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '我 22:10 才落地，第一晚只入住休息，机场和酒店位置待核验。',
      tripBrief: arrivalBrief
    })
    const lodging = result.itineraryOptions?.[0]?.days[0]?.stops.find((stop) => stop.category === '住宿')

    expect(lodging?.time).toBe('落地、取行李和接驳后（时段待核验）')
    expect(lodging?.time).not.toContain('23:30')
    expect(lodging?.notes).toContain('接驳耗时待核验')
  })

  it('保留用户明确提供的入住时刻', async () => {
    const arrivalBrief = { ...brief, destination: '成都', arrivalFlight: '用户提供航班', arrivalTime: '22:10' }
    const plan = rawPlan('抵达交通（地点待确认）') as unknown as {
      days: Array<{ stops: Array<Record<string, unknown>> }>
    }
    plan.days[0]!.stops = [
      { name: '抵达交通（地点待确认）', area: '', time: '22:10', category: '交通', notes: '抵达机场或车站未提供；落地时刻来自用户提供。' },
      { name: '入住酒店', area: '', time: '23:30 前后', category: '住宿', notes: '入住时段待核验。' }
    ]
    const result = await itineraryProposalTool.execute({ plan }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '我22:10落地，酒店23:00办理入住，机场和住宿接驳待核验。',
      tripBrief: arrivalBrief
    })
    const lodging = result.itineraryOptions?.[0]?.days[0]?.stops.find((stop) => stop.category === '住宿')

    expect(lodging?.time).toBe('23:00')
    expect(lodging?.notes).toContain('用户指定入住时刻已保留')
  })

  it('明确要求机场到住宿方案但未提供住宿时，保留待确认的住宿端点', async () => {
    const arrivalBrief = { ...brief, destination: '成都', arrivalFlight: '用户提供航班', arrivalTime: '22:10' }
    const result = await itineraryProposalTool.execute({ plan: {
      title: '成都抵达日', summary: '机场接驳待核验。', tradeoffs: '',
      days: [{ day_number: 1, date: arrivalBrief.startDate, title: '抵达入住', stops: [
        { name: '抵达交通（地点待确认）', area: '', time: '22:10', category: '交通', notes: '抵达机场或车站未提供；抵达时刻来自用户提供。' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '我22:10落地，第一晚不要安排景点，给我机场到住宿的待核验交通方案。',
      tripBrief: arrivalBrief
    })
    const stops = result.itineraryOptions?.[0]?.days[0]?.stops ?? []
    const lodging = stops.find((stop) => stop.category === '住宿')
    const arrival = stops.find((stop) => stop.category === '交通')

    expect(lodging).toMatchObject({
      name: '住宿地点待确认', time: '落地、取行李和接驳后（时段待核验）', evidenceLevel: 'pending'
    })
    expect(lodging?.notes).toContain('机场离站与接驳线路/耗时待核验')
    expect(arrival?.transitToNext).toContain('住宿地点待确认')
    expect(stops.filter((stop) => /景点/u.test(stop.category))).toHaveLength(0)
  })

  it('清除标了待确认但仍列出具体机场的抵达锚点与接驳路线', async () => {
    const arrivalBrief = { ...brief, destination: '成都' }
    const inputPlan = rawPlan('航班落地（抵达锚点：天府或双流机场，待确认）') as unknown as {
      days: Array<{ stops: Array<Record<string, unknown>> }>
    }
    inputPlan.days[0]!.stops[0] = {
      ...inputPlan.days[0]!.stops[0]!,
      transit_to_next: '若为天府机场乘机场专线；若为双流机场乘夜间 1 路公交。'
    }
    const result = await itineraryProposalTool.execute({ plan: inputPlan }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '抵达机场待确认，第一晚不安排景点。',
      tripBrief: arrivalBrief
    })
    const stop = result.itineraryOptions?.[0]?.days[0]?.stops[0]

    expect(stop?.name).toBe('抵达交通（地点待确认）')
    expect(stop?.transitToNext).toContain('抵达地点确认后再查询线路与耗时。')
    expect(stop?.transitToNext).not.toMatch(/天府|双流|机场专线|夜间/u)
  })

  it('没有抵达要求时移除模型臆造的泛化进城接驳', async () => {
    const inputPlan = rawPlan('进城接驳（地点待确认）') as unknown as {
      days: Array<{ stops: Array<Record<string, unknown>> }>
    }
    inputPlan.days[0]!.stops[0] = {
      ...inputPlan.days[0]!.stops[0]!,
      notes: '抵达机场或车站未提供；确认后再核对该段接驳。'
    }
    const result = await itineraryProposalTool.execute({ plan: inputPlan }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '规划重庆两日夜景摄影行程，并安排拍摄时段和交通缓冲。',
      tripBrief: { ...brief, destination: '重庆' }
    })
    const stops = result.itineraryOptions?.[0]?.days[0]?.stops ?? []

    expect(stops.some((stop) => /进城接驳|抵达交通/u.test(stop.name))).toBe(false)
  })

  it('没有抵达要求时移除模型臆造的具体机场接驳', async () => {
    const arrivalBrief = { ...brief, destination: '重庆' }
    const inputPlan = rawPlan('重庆江北国际机场进城接驳') as unknown as {
      days: Array<{ stops: Array<Record<string, unknown>> }>
    }
    inputPlan.days[0]!.stops[0] = {
      name: '重庆江北国际机场进城接驳', area: '江北区', time: '19:30–19:50',
      duration_minutes: 20, category: '交通', notes: '机场进城线路和耗时待核验。'
    }
    inputPlan.days[0]!.stops[1] = {
      name: '洪崖洞', area: '渝中区', time: '20:00–22:00',
      duration_minutes: 120, category: '景点', notes: '夜景游览。'
    }
    const result = await itineraryProposalTool.execute({ plan: inputPlan }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '请规划重庆两日夜景摄影行程，并安排拍摄时段和交通缓冲。',
      tripBrief: arrivalBrief
    })
    const stops = result.itineraryOptions?.[0]?.days[0]?.stops ?? []

    expect(stops.map((stop) => stop.name)).toEqual(['洪崖洞'])
  })

  it('合并同一落地时刻重复的待确认交通锚点', async () => {
    const arrivalBrief = { ...brief, arrivalFlight: '用户提供航班', arrivalTime: '22:10' }
    const inputPlan = rawPlan('抵达交通（地点待确认）') as unknown as {
      days: Array<{ stops: Array<Record<string, unknown>> }>
    }
    inputPlan.days[0]!.stops = [
      {
        name: '抵达交通（地点待确认）', area: '', time: '22:10', category: '交通',
        notes: '抵达机场或车站未提供；确认后再核对该段接驳。'
      },
      {
        name: '进城接驳（地点待确认）', area: '', time: '22:10 之后', category: '交通',
        notes: '抵达机场或车站未提供；确认后再核对该段接驳。'
      },
      { name: '故宫博物院', area: '东城', time: '23:30', category: '景点', notes: '游览中轴线' }
    ]
    const result = await itineraryProposalTool.execute({ plan: inputPlan }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '我 22:10 落地，抵达后接驳待核验。',
      tripBrief: arrivalBrief
    })
    const stops = result.itineraryOptions?.[0]?.days[0]?.stops ?? []
    const arrivalAnchors = stops.filter((stop) => /^(?:抵达交通|进城接驳)（地点待确认）$/u.test(stop.name))

    expect(arrivalAnchors).toHaveLength(1)
    expect(arrivalAnchors[0]?.time).toContain('22:10')
  })

  it('普通行程日只有酒店锚点时保留候选并返回内容 warning', async () => {
    const plan = {
      title: '北京一日游', summary: '按区域安排。', tradeoffs: '',
      days: [{ day_number: 1, date: brief.startDate, title: '抵达', stops: [
        { name: '酒店入住', area: '', time: '晚上', category: '住宿' }
      ] }]
    }

    const result = await itineraryProposalTool.execute({ plan }, {
      amapKey: null, researchCompleted: true, userRequest: '规划广州到北京的三天行程。', tripBrief: brief
    })

    expect(result.itineraryOptions).toHaveLength(1)
    expect(result.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining('未安排实际游览、餐饮或活动') })
    ]))
  })

  it('用户明确指定的休息日允许没有游览点', async () => {
    const restBrief = { ...brief, constraints: '11月5日全天休息，不安排景点。' }
    const plan = {
      title: '北京一日游', summary: '按区域安排。', tradeoffs: '',
      days: [{ day_number: 1, date: restBrief.startDate, title: '休息', stops: [
        { name: '酒店入住', area: '', time: '全天', category: '住宿' }
      ] }]
    }

    const result = await itineraryProposalTool.execute({ plan }, {
      amapKey: null, researchCompleted: true, userRequest: restBrief.constraints, tripBrief: restBrief
    })

    expect(result.itineraryOptions).toHaveLength(1)
  })
})

describe('未选定景点占位识别', () => {
  it.each(['游览点待定', '待选游览点', '游览点', '地点待确认', '景区待补'])('识别“%s”不是实际景点', (name) => {
    expect(isUnresolvedAttractionName(name)).toBe(true)
  })

  it('把“游览点待定”作为内容 warning 返回给模型判断', async () => {
    const plan = {
      title: '北京一日游', summary: '按区域安排。', tradeoffs: '',
      days: [{ day_number: 1, date: brief.startDate, title: '市区游览', stops: [
        { name: '游览点待定', area: '', time: '待定', category: '景点', notes: '' }
      ] }]
    }

    const result = await itineraryProposalTool.execute({ plan }, {
      amapKey: null, researchCompleted: true, userRequest: '规划广州到北京的一日游。', tripBrief: brief
    })

    expect(result.itineraryOptions).toHaveLength(1)
    expect(result.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining('未安排实际游览、餐饮或活动') })
    ]))
  })
})
