/** 验证模型草案在交付前保持行程项与时间块语义一致。 */
import { describe, expect, it } from 'vitest'
import type { ItineraryOption, TripBrief } from '../src/shared/types.js'
import { analyzeDaySchedule, analyzeMealRequirements, routePlanningBufferMinutes } from '../src/shared/itinerary-schedule.js'
import { itineraryDetailFeedback, itineraryProposalDefinitionForBudget, itineraryProposalTool } from '../src/main/connectors/itinerary.js'
import { unchangedItineraryDatesForRequest } from '../src/shared/itinerary-revisions.js'

const brief: TripBrief = {
  departureCity: '', destination: '重庆', startDate: '2026-11-05', endDate: '2026-11-05',
  arrivalFlight: '', arrivalTime: '', leaveTime: '', travelers: '', budget: '', lodgingLocation: '', lodging: '',
  pace: '中等', earlyStart: '', interests: '夜景摄影、街区', transport: '', dietary: '', luggage: '', clothing: '', constraints: ''
}

describe('行程交付结构', () => {
  it('完整多日修订只把用户指定日的酒店休息放到午餐后', async () => {
    const dates = Array.from({ length: 7 }, (_, index) => new Date(Date.UTC(2026, 8, 21 + index)).toISOString().slice(0, 10))
    const request = '第一轮修改：以刚才的最新草案为基线。只把 9/23 调轻松，删除香山和碧云寺，保留颐和园主线；午餐后回酒店休息。9/22、9/24、9/25、9/26、9/27 和抵离时刻都保持不变。请返回一份完整修订草案，不并列方案。'
    const baseline: ItineraryOption = {
      id: 'baseline', title: '北京七日', summary: '', tradeoffs: '',
      days: dates.map((date, index) => ({
        id: `baseline-${date}`, dayNumber: index + 1, date, title: `第${index + 1}天`,
        stops: [{
          id: `baseline-stop-${date}`, name: index === 2 ? '颐和园' : `地点${index + 1}`,
          area: '', time: '09:00–11:00', durationMinutes: 120, category: '景点', notes: '', transitToNext: ''
        }],
        scheduleBlocks: []
      }))
    }
    const unchangedDates = unchangedItineraryDatesForRequest(request, baseline)
    const proposal = { plan: {
      title: '北京七日', summary: '按区域安排。', tradeoffs: '',
      days: dates.map((date, index) => ({
        day_number: index + 1, date, title: `第${index + 1}天`,
        stops: [{
          name: index === 2 ? '颐和园' : `地点${index + 1}`,
          area: '', time: '09:00–11:00', duration_minutes: 120, category: '景点', notes: ''
        }]
      }))
    } }
    const context = {
      amapKey: null, researchCompleted: true, userRequest: request,
      tripBrief: { ...brief, destination: '北京', startDate: dates[0]!, endDate: dates.at(-1)! },
      revisionBaseline: baseline, unchangedItineraryDates: unchangedDates
    }
    const result = await itineraryProposalTool.execute(proposal, context)

    const days = result.itineraryOptions?.[0]?.days ?? []
    const targetDay = days.find((day) => day.date === '2026-09-23')
    expect(unchangedDates).toEqual(dates.filter((date) => date !== '2026-09-23'))
    expect(targetDay?.scheduleBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'rest', title: '午餐后回酒店休息', time: '午餐后', area: '酒店'
      })
    ]))
    expect(days.filter((day) => day.date !== '2026-09-23').every((day) => day.scheduleBlocks.length === 0)).toBe(true)

    // 路线冲突修订可能只开放另一日期；休息要求仍归属于原话点名的日期。
    const routeRepairResult = await itineraryProposalTool.execute(proposal, {
      ...context,
      unchangedItineraryDates: dates.filter((date) => date !== '2026-09-25')
    })
    const routeRepairDays = routeRepairResult.itineraryOptions?.[0]?.days ?? []
    expect(routeRepairDays.find((day) => day.date === '2026-09-23')?.scheduleBlocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'rest', title: '午餐后回酒店休息' })])
    )
    expect(routeRepairDays.find((day) => day.date === '2026-09-25')?.scheduleBlocks).toEqual([])
  })

  it('午餐后酒店休息可保留相对顺序并明确标记待核验', () => {
    const plan: ItineraryOption = {
      id: 'plan', title: '北京一日', summary: '园林游览。', tradeoffs: '',
      days: [{
        id: 'day', dayNumber: 1, date: brief.startDate, title: '颐和园',
        stops: [{
          id: 'attraction', name: '颐和园', area: '海淀区', time: '09:00–11:00',
          durationMinutes: 120, category: '景点', notes: '', transitToNext: ''
        }],
        scheduleBlocks: [{
          id: 'rest', kind: 'rest', title: '午餐后回酒店休息', time: '午餐后',
          durationMinutes: null, area: '酒店', notes: '酒店接驳与休息时长待核验。'
        }]
      }]
    }
    const requirements = {
      detailed: true, openingHours: false, booking: false, contingencies: false
    }

    expect(itineraryDetailFeedback([plan], requirements)).toEqual([])

    plan.days[0]!.scheduleBlocks[0]!.notes = '酒店接驳和休息时间已安排。'
    expect(itineraryDetailFeedback([plan], requirements)).toContainEqual(
      expect.stringContaining('缺少明确开始时刻和时长')
    )
  })

  it('计划摘要保持首屏简短，并在完整句处收口', async () => {
    const longSummary = '重庆老城区与江畔夜景串联，白天以步行为主，晚间留出自由活动时间。'.repeat(4)
    const result = await itineraryProposalTool.execute({ plan: {
      title: '重庆一日', summary: longSummary, tradeoffs: '',
      days: [{ day_number: 1, date: brief.startDate, title: '老城与江畔', stops: [
        { name: '解放碑', area: '渝中区', time: '10:00', category: '景点', notes: '' }
      ] }]
    } }, { amapKey: null, researchCompleted: true, userRequest: '规划重庆一日游。', tripBrief: brief })

    const summary = result.itineraryOptions?.[0]?.summary ?? ''
    expect(summary.length).toBeLessThanOrEqual(120)
    expect(summary.endsWith('。')).toBe(true)
    const planSchema = itineraryProposalTool.definition.function.parameters as {
      properties?: { plan?: { properties?: { summary?: { maxLength?: number } } } }
    }
    expect(planSchema.properties?.plan?.properties?.summary?.maxLength).toBe(120)
  })

  it('模型地点名称超过展示上限时截短并撤销来源背书，不丢弃整份计划', async () => {
    const longName = `解放碑${' · 步行路线说明'.repeat(30)}`
    expect(longName.length).toBeGreaterThan(160)
    const result = await itineraryProposalTool.execute({ plan: {
      title: '重庆一日', summary: '按老城片区安排。', tradeoffs: '',
      days: [{ day_number: 1, date: brief.startDate, title: '老城游览', stops: [
        { name: longName, area: '渝中区', time: '10:00–11:00', category: '景点', notes: '',
          evidence_level: 'sourced', source_ids: ['unverified-source'] }
      ] }]
    } }, { amapKey: null, researchCompleted: true, userRequest: '规划重庆一日游。', tripBrief: brief })

    const stop = result.itineraryOptions?.[0]?.days[0]?.stops[0]
    expect(stop?.name.length).toBeLessThanOrEqual(160)
    expect(stop?.name.startsWith('解放碑')).toBe(true)
    expect(stop?.evidenceLevel).toBe('pending')
    expect(stop?.sourceIds).toEqual([])
    expect(stop?.notes).toContain('地点身份与来源待核验')
  })

  it('将同刻落地语义的非交通停靠点规范为交通锚点', async () => {
    const arrivalBrief = {
      ...brief,
      startDate: '2026-09-21',
      endDate: '2026-09-21',
      arrivalFlight: '用户提供的航班',
      arrivalTime: '2026-09-21 19:30',
      constraints: '9/21 19:30抵达北京。'
    }
    const result = await itineraryProposalTool.execute({ plan: {
      title: '北京抵达日', summary: '按抵达时间衔接。', tradeoffs: '机场接驳待核验。',
      days: [{ day_number: 1, date: arrivalBrief.startDate, title: '抵达北京', stops: [
        { name: '抵达北京', area: '', time: '19:30', category: '其他', notes: '' }
      ] }]
    } }, { amapKey: null, researchCompleted: true, userRequest: '9/21 19:30抵达北京。', tripBrief: arrivalBrief })

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0]).toMatchObject({
      name: '抵达北京', time: '19:30', category: '交通', durationMinutes: null, evidenceLevel: 'pending'
    })
  })

  it('机场接驳误从落地同刻开始时降级为待核验时间并保留先后顺序', async () => {
    const arrivalBrief = {
      ...brief,
      destination: '北京',
      startDate: '2026-09-21',
      endDate: '2026-09-21',
      arrivalFlight: '示例航班，广州白云T2 16:00起飞，北京大兴19:30到达',
      arrivalTime: '2026-09-21 19:30',
      lodgingLocation: '北京西站附近酒店',
      lodging: '北京西站附近酒店',
      constraints: '9/21 抵达北京大兴机场后取行李、乘机场线进城、入住北京西站附近酒店，再安排晚餐。'
    }
    const result = await itineraryProposalTool.execute({ plan: {
      title: '北京抵达日', summary: '落地后进城入住。', tradeoffs: '',
      days: [{ day_number: 1, date: arrivalBrief.startDate, title: '抵达与入住', stops: [
        { name: '北京大兴机场抵达', area: '', time: '19:30', category: '交通', notes: '用户航班落地。' },
        { name: '机场进城接驳', area: '北京大兴机场', time: '19:30–20:45', duration_minutes: 75, category: '交通', notes: '乘机场线前往酒店。' },
        { name: '北京西站附近酒店', area: '北京西站', time: '20:45–21:00', category: '住宿', notes: '办理入住。' },
        { name: '晚餐店', area: '北京西站', time: '21:00–21:45', category: '餐饮', notes: '' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '9/21 19:30 抵达北京大兴机场后取行李、乘机场线进城、入住北京西站附近酒店，再安排晚餐。',
      tripBrief: arrivalBrief
    })

    const stops = result.itineraryOptions?.[0]?.days[0]?.stops ?? []
    const transferIndex = stops.findIndex((stop) => stop.name === '机场进城接驳')
    const lodgingIndex = stops.findIndex((stop) => stop.category === '住宿')
    expect(stops[transferIndex]).toMatchObject({
      time: '落地、离站与取行李后（时段待核验）',
      durationMinutes: 75,
      evidenceLevel: 'pending'
    })
    expect(transferIndex).toBeGreaterThan(stops.findIndex((stop) => /抵达|落地/u.test(stop.name)))
    expect(lodgingIndex).toBeGreaterThan(transferIndex)
  })

  it('将未被用户指定钟点的抵达日晚餐放到落地与入住之后', async () => {
    const arrivalBrief = {
      ...brief,
      destination: '北京',
      startDate: '2026-09-21',
      endDate: '2026-09-21',
      arrivalFlight: '示例航班，广州白云T2 16:00起飞，北京大兴19:30到达',
      arrivalTime: '2026-09-21 19:30',
      lodgingLocation: '北京西站附近酒店',
      lodging: '北京西站附近酒店',
      constraints: '9/21 落地后先下机取行李、进城入住，再晚餐。'
    }
    const result = await itineraryProposalTool.execute({ plan: {
      title: '北京抵达日', summary: '落地后入住并用餐。', tradeoffs: '',
      days: [{ day_number: 1, date: arrivalBrief.startDate, title: '抵达入住', stops: [
        { name: '北京西站附近酒店', area: '北京西站', time: '20:00-20:30', category: '住宿', notes: '办理入住。' },
        { name: '晚餐餐厅', area: '北京西站', time: '17:30-18:15', category: '餐饮', notes: '' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '9/21 落地后先下机取行李、进城入住，再晚餐。',
      tripBrief: arrivalBrief
    })

    const day = result.itineraryOptions?.[0]?.days[0]
    const dinner = day?.stops.find((stop) => stop.category === '餐饮')
    const arrivalIndex = day?.stops.findIndex((stop) => /抵达|到达|落地/u.test(stop.name)) ?? -1
    const lodgingIndex = day?.stops.findIndex((stop) => stop.category === '住宿') ?? -1
    const dinnerIndex = day?.stops.findIndex((stop) => stop.category === '餐饮') ?? -1

    expect(result.itineraryOptions).toHaveLength(1)
    expect(dinner?.time).toBe('落地及接驳后（时段待确认）')
    expect(dinner?.notes).toContain('具体时间按取行李和交通情况确认')
    expect(arrivalIndex).toBeGreaterThanOrEqual(0)
    expect(lodgingIndex, JSON.stringify(day?.stops.map((stop) => ({ name: stop.name, time: stop.time }))))
      .toBeGreaterThan(arrivalIndex)
    expect(dinnerIndex).toBeGreaterThan(lodgingIndex)
  })

  it('抵达日顺延能处理北京完整用例中的多日期参考文本', async () => {
    const arrivalBrief = {
      ...brief,
      destination: '北京',
      startDate: '2026-09-21',
      endDate: '2026-09-21',
      arrivalFlight: '示例航班，广州白云T2 16:00起飞，北京大兴19:30到达',
      arrivalTime: '2026-09-21 19:30',
      lodgingLocation: '北京西站附近酒店',
      lodging: '北京西站附近酒店',
      constraints: '抵离机场/车站时刻为硬约束；按用户参考计划逐日规划。'
    }
    const userRequest = [
      '北京 2026-09-21 至 2026-09-27 五天六晚个人旅行。',
      '出发地广州。9/21 14:00 前到广州白云机场 T2，示例航班 于 16:00 起飞，19:30 抵达北京大兴；当晚住北京西站附近酒店，只安排晚餐。全程住同一酒店。',
      '9/22 必须安排清华、北大、圆明园；9/23 参考颐和园与香山赏秋；9/24 参考天坛、国家博物馆、前门；9/25 参考八达岭长城和鸟巢/水立方；9/26 参考天安门、故宫、景山、北海、什刹海；9/27 只安排雍和宫或一个同等景点，早餐和午餐后回酒店取行李。',
      '参考用户给出的逐日时段骨架：9/21 落地后先下机取行李、进城入住，再晚餐；9/22 08:00 出发，09:00–11:15 清华，11:15–12:00 午餐，12:00–14:00 北大；9/23 08:00–12:15 颐和园，午餐后接驳香山；9/24 08:00–11:15 天坛，午餐后预留安检；9/27 09:00 雍和宫，10:45–12:45 孔庙和国子监，12:45–13:45 午餐。',
      '三餐要有具体店名和门店区域：9/21 仅晚餐，9/22–9/26 每天三餐，9/27 仅早餐和午餐。'
    ].join('\n\n')
    const result = await itineraryProposalTool.execute({ plan: {
      title: '北京抵达日', summary: '航班后入住和用餐。', tradeoffs: '',
      days: [{ day_number: 1, date: arrivalBrief.startDate, title: '抵达入住', stops: [
        { name: '晚餐餐厅', area: '北京西站', time: '17:30–18:15', category: '餐饮', notes: '' },
        { name: '北京西站附近酒店', area: '北京西站', time: '20:00–20:30', category: '住宿', notes: '办理入住。' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest,
      tripBrief: { ...arrivalBrief, constraints: userRequest }
    })

    const dinner = result.itineraryOptions?.[0]?.days[0]?.stops.find((stop) => stop.category === '餐饮')
    expect(dinner?.time).toBe('落地及接驳后（时段待确认）')
  })

  it('系统补齐的抵达日晚餐也排在落地后，且航班锚点保持时序', async () => {
    const arrivalBrief = {
      ...brief,
      destination: '北京',
      startDate: '2026-09-21',
      endDate: '2026-09-21',
      arrivalFlight: '示例航班，广州白云T2 16:00起飞，北京大兴19:30到达',
      arrivalTime: '2026-09-21 19:30',
      lodgingLocation: '北京西站附近酒店',
      lodging: '北京西站附近酒店'
    }
    const userRequest = '9/21 14:00 前到广州白云机场 T2，示例航班 16:00 起飞、19:30 抵达北京大兴；当晚住北京西站附近酒店，只安排晚餐。落地后先取行李、进城入住，再晚餐。'
    const result = await itineraryProposalTool.execute({ plan: {
      title: '北京抵达日', summary: '落地后入住并晚餐。', tradeoffs: '',
      days: [{ day_number: 1, date: arrivalBrief.startDate, title: '抵达入住', stops: [
        { name: '北京西站附近酒店', area: '北京西站', time: '落地接驳后', category: '住宿', notes: '办理入住。' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest,
      tripBrief: { ...arrivalBrief, constraints: userRequest },
      requiredMealSlots: [{ date: arrivalBrief.startDate, slots: ['dinner'], exclusive: true }],
      requireNamedMealStops: true
    })

    const day = result.itineraryOptions?.[0]?.days[0]
    const dinner = day?.scheduleBlocks.find((block) => block.kind === 'meal')
    const departureIndex = day?.stops.findIndex((stop) => /交通/u.test(stop.category) && stop.time.includes('16:00')) ?? -1
    const arrivalIndex = day?.stops.findIndex((stop) => /交通/u.test(stop.category) && stop.time.includes('19:30')) ?? -1

    expect(dinner?.time).toBe('落地及接驳后（时段待确认）')
    expect(departureIndex).toBeGreaterThanOrEqual(0)
    expect(arrivalIndex).toBeGreaterThan(departureIndex)
  })

  it('将落地后但接驳时间未核实的模型餐次改为待确认时段', async () => {
    const arrivalBrief = {
      ...brief,
      destination: '北京',
      startDate: '2026-09-21',
      endDate: '2026-09-21',
      arrivalFlight: '示例航班，广州白云T2 16:00起飞，北京大兴19:30到达',
      arrivalTime: '2026-09-21 19:30',
      lodgingLocation: '北京西站附近酒店',
      lodging: '北京西站附近酒店',
      constraints: '9/21 落地后先下机取行李、进城入住，再晚餐。'
    }
    const result = await itineraryProposalTool.execute({ plan: {
      title: '北京抵达日', summary: '落地后入住并用餐。', tradeoffs: '',
      days: [{ day_number: 1, date: arrivalBrief.startDate, title: '抵达入住', stops: [
        { name: '北京西站附近酒店', area: '北京西站', time: '20:00-20:30', category: '住宿', notes: '办理入住。' },
        { name: '晚餐餐厅', area: '北京西站', time: '２０：００－２１：００', category: '餐饮', notes: '' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '9/21 落地后先下机取行李、进城入住，再晚餐。',
      tripBrief: arrivalBrief
    })

    const day = result.itineraryOptions?.[0]?.days[0]
    const dinner = day?.stops.find((stop) => stop.category === '餐饮')
    const lodgingIndex = day?.stops.findIndex((stop) => stop.category === '住宿') ?? -1
    const dinnerIndex = day?.stops.findIndex((stop) => stop.category === '餐饮') ?? -1

    expect(dinner?.time).toBe('落地及接驳后（时段待确认）')
    expect(dinnerIndex).toBeGreaterThan(lodgingIndex)
  })

  it('抵达日餐次不得把与落地相同的时刻写成活动开始时间', async () => {
    const arrivalBrief = {
      ...brief,
      destination: '北京',
      startDate: '2026-09-21',
      endDate: '2026-09-21',
      arrivalFlight: '示例航班，广州白云T2 16:00起飞，北京大兴19:30到达',
      arrivalTime: '2026-09-21 19:30',
      lodgingLocation: '北京西站附近酒店',
      constraints: '抵离机场时刻为硬约束。'
    }
    const userRequest = [
      '出发地广州。9/21 14:00 前到广州白云机场 T2，示例航班 于 16:00 起飞，19:30 抵达北京大兴；当晚住酒店，只安排晚餐。',
      '9/21 落地后先下机取行李、进城入住，再晚餐。'
    ].join('\n')
    const result = await itineraryProposalTool.execute({ plan: {
      title: '北京抵达日', summary: '落地后入住并晚餐。', tradeoffs: '',
      days: [{ day_number: 1, date: arrivalBrief.startDate, title: '抵达入住', stops: [
        { name: '酒店附近晚餐', area: '北京西站', time: '19:30 后', category: '餐饮' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest,
      tripBrief: arrivalBrief
    })

    const dinner = result.itineraryOptions?.[0]?.days[0]?.stops.find((stop) => stop.category === '餐饮')
    expect(dinner?.time).toBe('落地及接驳后（时段待确认）')
  })

  it('与落地冲突的活动作为 warning 保留，由模型决定是否修订', async () => {
    const arrivalBrief = {
      ...brief,
      destination: '北京',
      startDate: '2026-09-21',
      endDate: '2026-09-21',
      arrivalFlight: '示例航班，广州白云T2 16:00起飞，北京大兴19:30到达',
      arrivalTime: '2026-09-21 19:30'
    }
    const result = await itineraryProposalTool.execute({ plan: {
      title: '北京抵达日', summary: '抵达后安排活动。', tradeoffs: '',
      days: [{ day_number: 1, date: arrivalBrief.startDate, title: '抵达日', stops: [
        { name: '广州白云机场', area: '广州', time: '11:30', category: '交通', notes: '航班起飞前到达机场。' },
        { name: '晚间活动', area: '北京', time: '19:30', category: '其他', notes: '' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '9/21 示例航班 16:00起飞、19:30抵达北京大兴。',
      tripBrief: arrivalBrief
    })

    expect(result.itineraryOptions).toHaveLength(1)
    expect(result.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining('不晚于抵达时间') })
    ]))
    expect(result.feedback?.some((item) => item.message.includes('停靠点顺序错误'))).toBe(false)
  })

  it('从时段文字识别餐次，修复误放在航班途中的晚餐时间', async () => {
    const arrivalBrief = {
      ...brief,
      destination: '北京',
      startDate: '2026-09-21',
      endDate: '2026-09-21',
      arrivalFlight: '示例航班，广州白云T2 16:00起飞，北京大兴19:30到达',
      arrivalTime: '2026-09-21 19:30',
      constraints: '9/21 落地后先下机取行李、进城入住，再晚餐。'
    }
    const result = await itineraryProposalTool.execute({ plan: {
      title: '北京抵达日', summary: '落地后入住并晚餐。', tradeoffs: '',
      days: [{ day_number: 1, date: arrivalBrief.startDate, title: '抵达入住', stops: [
        { name: '项目', area: '北京西站', time: '17:30–18:15 晚餐', category: '其他', duration_minutes: 45 }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '9/21 落地后先下机取行李、进城入住，再晚餐。',
      tripBrief: arrivalBrief
    })

    const dinner = result.itineraryOptions?.[0]?.days[0]?.stops.find((stop) => stop.name === '项目')
    expect(dinner).toMatchObject({
      time: '落地及接驳后（时段待确认）',
      durationMinutes: 45,
      evidenceLevel: 'pending'
    })
  })

  it('完整北京请求中的抵达日餐次按真实航班上下文延后', async () => {
    const arrivalBrief = {
      ...brief,
      destination: '北京',
      startDate: '2026-09-21',
      endDate: '2026-09-21',
      arrivalFlight: '示例航班，广州白云T2 16:00起飞，北京大兴19:30到达',
      arrivalTime: '2026-09-21 19:30',
      lodgingLocation: '北京西站附近酒店',
      lodging: '北京西站附近酒店',
      constraints: '按用户粘贴的参考计划逐日规划；9/21落地后先下机取行李、进城入住，再晚餐；抵离机场/车站时刻为硬约束。预约按能预约到规划，北大按已有内部预约办理，但仍列出核验提醒。'
    }
    const userRequest = [
      '请为我做北京 2026-09-21 至 2026-09-27 的个人旅行，先给一份完整、可审阅的行程草案。',
      '出发地广州。9/21 14:00 前到广州白云机场 T2，示例航班 于 16:00 起飞，19:30 抵达北京大兴；当晚住北京西站附近酒店，只安排晚餐。',
      '参考逐日时段骨架：9/21 落地后先下机取行李、进城入住，再晚餐；9/22 安排清华、北大、圆明园；9/27 只安排一个景点和早餐、午餐，18:30 从酒店区域出发，20:00 乘 示例车次。',
      '三餐要有具体店名；不确定店面时明确写待选。没有成功路线来源时，通勤分钟数标待核验。'
    ].join('\n\n')
    const result = await itineraryProposalTool.execute({ plan: {
      title: '北京抵达日', summary: '落地后入住并晚餐。', tradeoffs: '',
      days: [{ day_number: 1, date: arrivalBrief.startDate, title: '抵达入住', stops: [
        { name: '项目', area: '北京西站', time: '17:30–18:15 晚餐', category: '其他', duration_minutes: 45 }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest,
      tripBrief: arrivalBrief,
      requiredMealSlots: [{ date: arrivalBrief.startDate, slots: ['dinner'], exclusive: true }]
    })

    const dinner = result.itineraryOptions?.[0]?.days.find((day) => day.date === arrivalBrief.startDate)
      ?.stops.find((stop) => stop.name === '项目')
    expect(dinner?.time).toBe('落地及接驳后（时段待确认）')
    expect(result.itineraryOptions?.[0]?.days.find((day) => day.date === arrivalBrief.startDate)
      ?.stops.some((stop) => /抵达|落地/u.test(stop.name))).toBe(true)
  })

  it('保留起飞前用餐，不把出发城市餐次移到目的地', async () => {
    const arrivalBrief = {
      ...brief,
      destination: '北京',
      startDate: '2026-09-21',
      endDate: '2026-09-21',
      arrivalFlight: '示例航班，广州白云T2 16:00起飞，北京大兴19:30到达',
      arrivalTime: '2026-09-21 19:30'
    }
    const result = await itineraryProposalTool.execute({ plan: {
      title: '北京出发日', summary: '机场用餐后乘机。', tradeoffs: '',
      days: [{ day_number: 1, date: arrivalBrief.startDate, title: '机场与抵达', stops: [
        { name: '广州白云机场午餐', area: '广州白云机场', time: '14:30-15:15', category: '餐饮', notes: '候机前用餐。' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '9/21 到广州白云机场后吃午餐，示例航班 16:00 起飞，19:30 抵达北京大兴。',
      tripBrief: arrivalBrief
    })

    const meal = result.itineraryOptions?.[0]?.days[0]?.stops.find((stop) => stop.name.includes('午餐'))
    expect(meal?.time).toBe('14:30-15:15')
  })

  it('用户明确指定的抵达前餐时保留冲突并回传 warning', async () => {
    const arrivalBrief = {
      ...brief,
      destination: '北京',
      startDate: '2026-09-21',
      endDate: '2026-09-21',
      arrivalFlight: '示例航班，广州白云T2 16:00起飞，北京大兴19:30到达',
      arrivalTime: '2026-09-21 19:30'
    }
    const result = await itineraryProposalTool.execute({ plan: {
      title: '北京抵达日', summary: '安排抵达日晚餐。', tradeoffs: '',
      days: [{ day_number: 1, date: arrivalBrief.startDate, title: '抵达日', stops: [
        { name: '晚餐', area: '北京', time: '17:30-18:15', category: '餐饮', notes: '' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '9/21 北京 17:30 晚餐，航班19:30抵达。',
      tripBrief: arrivalBrief
    })

    expect(result.itineraryOptions).toHaveLength(1)
    expect(result.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining('不晚于抵达时间') })
    ]))
  })

  it('未指定钟点的早餐与景点重叠时自动挪入空档', async () => {
    const result = await itineraryProposalTool.execute({ plan: {
      title: '重庆上午行程', summary: '早餐后游览。', tradeoffs: '',
      days: [{ day_number: 1, date: brief.startDate, title: '园区游览', stops: [
        { name: '早餐店', area: '园区外', time: '08:00–08:45', category: '餐饮', notes: '' },
        { name: '公园', area: '重庆', time: '08:00–12:15', category: '景点', notes: '' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '请规划 2026-11-05 的重庆行程，安排早餐后游览公园。',
      tripBrief: brief
    })

    const day = result.itineraryOptions?.[0]?.days[0]
    const breakfast = day?.stops.find((stop) => stop.name === '早餐店')
    expect(result.itineraryOptions).toHaveLength(1)
    expect(breakfast?.time).toBe('07:00–07:45')
    expect(day?.stops[0]?.name).toBe('早餐店')
  })

  it('用户明确指定的餐时与景点冲突时不擅自移动，并作为 warning 返回', async () => {
    const result = await itineraryProposalTool.execute({ plan: {
      title: '重庆上午行程', summary: '安排早餐和公园游览。', tradeoffs: '',
      days: [{ day_number: 1, date: brief.startDate, title: '园区游览', stops: [
        { name: '早餐店', area: '园区外', time: '08:00–08:45', category: '餐饮', notes: '' },
        { name: '公园', area: '重庆', time: '08:00–12:15', category: '景点', notes: '' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '请规划 2026-11-05 的重庆行程，11/5 早餐 08:00，之后游览公园。',
      tripBrief: brief
    })

    expect(result.itineraryOptions).toHaveLength(1)
    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0]?.time).toBe('08:00–08:45')
    expect(result.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining('时间重叠') })
    ]))
  })

  it('返程日的餐饮截止时刻不会被误读成用户指定的午餐时间', async () => {
    const returnBrief = {
      ...brief,
      destination: '北京',
      startDate: '2026-09-27',
      endDate: '2026-09-27',
      constraints: '按用户粘贴的参考计划逐日规划；9/27仅一个景点、早餐和午餐，16:30后不再安排景点或用餐；18:30从酒店区域出发，19:00前抵达北京西站候车，20:00乘示例车次。抵离机场/车站时刻为硬约束。'
    }
    const result = await itineraryProposalTool.execute({ plan: {
      title: '北京返程日', summary: '上午游览并午餐后准备返程。', tradeoffs: '交通耗时待核验。',
      days: [{ day_number: 1, date: returnBrief.startDate, title: '雍和宫与返程', stops: [
        { name: '雍和宫', area: '东城区', time: '09:00–10:30', category: '景点', notes: '' },
        { name: '午餐店', area: '东城区', time: '12:45–13:45 午餐', category: '餐饮', notes: '' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '第一轮修改：以最新草案为基线，只调整9/23；9/22、9/24、9/25、9/26、9/27和抵离时刻都保持不变。',
      tripBrief: returnBrief
    })

    expect(result.itineraryOptions).toHaveLength(1)
    expect(result.itineraryOptions?.[0]?.days[0]?.stops.find((stop) => stop.name === '午餐店')?.time)
      .toBe('12:45–13:45 午餐')
  })

  it('用户明确允许馆内午餐时，将完整落在参观时段内的午餐作为子活动', async () => {
    const palaceBrief = {
      ...brief,
      destination: '北京',
      startDate: '2026-09-26',
      endDate: '2026-09-26',
      constraints: '9/26 故宫（午餐可在馆内）。'
    }
    const result = await itineraryProposalTool.execute({ plan: {
      title: '故宫与市中心', summary: '上午参观故宫并在馆内午餐。', tradeoffs: '',
      days: [{ day_number: 1, date: palaceBrief.startDate, title: '故宫参观', stops: [
        { name: '故宫博物院', area: '北京', time: '08:30–13:30', category: '景点', notes: '' },
        { name: '午餐店', area: '故宫外', time: '12:00–12:45', category: '餐饮', notes: '' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '9/26 故宫（午餐可在馆内）。',
      tripBrief: palaceBrief
    })

    const meal = result.itineraryOptions?.[0]?.days[0]?.stops.find((stop) => stop.name === '午餐店')
    expect(meal?.area).toBe('故宫博物院')
    expect(meal?.notes).toContain('馆内用餐（按用户提供的行程安排）')
  })

  it('返程离站后的活动保留在草案并返回警告供模型判断', async () => {
    const returnBrief = {
      ...brief,
      destination: '北京',
      startDate: '2026-09-27',
      endDate: '2026-09-27',
      leaveTime: '20:00',
      constraints: '9/27 16:30后不再安排景点或用餐；20:00 北京西站乘示例车次返广州。'
    }
    const result = await itineraryProposalTool.execute({ plan: {
      title: '返程日', summary: '上午游览，晚间乘车返程。', tradeoffs: '',
      days: [{ day_number: 1, date: returnBrief.startDate, title: '游览与返程', stops: [
        { name: '雍和宫', area: '东城区', time: '09:00–10:30', category: '景点', notes: '' },
        { name: '午餐店', area: '东城区', time: '12:00–13:00', category: '餐饮', notes: '' },
        { name: '夜间自由活动', area: '北京西站', time: '22:30–23:00', category: '自由活动', notes: '' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: returnBrief.constraints,
      tripBrief: returnBrief
    })

    const stops = result.itineraryOptions?.[0]?.days[0]?.stops ?? []
    expect(stops.some((stop) => stop.name === '夜间自由活动')).toBe(true)
    expect(stops.some((stop) => /交通/u.test(stop.category) && stop.name === '北京西站' && stop.time === '20:00')).toBe(true)
    expect(result.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', code: 'plan_content_needs_review' })
    ]))
  })

  it('单一餐次时刻偏移时按用户指定时间修正，再检查相邻行程', async () => {
    const result = await itineraryProposalTool.execute({ plan: {
      title: '重庆上午行程', summary: '安排早餐和公园游览。', tradeoffs: '',
      days: [{ day_number: 1, date: brief.startDate, title: '园区游览', stops: [
        { name: '早餐店', area: '园区外', time: '07:30–08:15', category: '餐饮', notes: '' },
        { name: '公园', area: '重庆', time: '08:45–10:00', category: '景点', notes: '' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '请规划 2026-11-05 的重庆行程，11/5 08:00–08:45 早餐，之后游览公园。',
      tripBrief: brief
    })

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0]?.time).toBe('08:00–08:45')
  })

  it('餐时自动修正造成冲突时保留候选并回传 warning', async () => {
    const result = await itineraryProposalTool.execute({ plan: {
      title: '重庆上午行程', summary: '安排早餐和公园游览。', tradeoffs: '',
      days: [{ day_number: 1, date: brief.startDate, title: '园区游览', stops: [
        { name: '早餐店', area: '园区外', time: '07:30–08:15', category: '餐饮', notes: '' },
        { name: '公园', area: '重庆', time: '08:30–10:00', category: '景点', notes: '' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '请规划 2026-11-05 的重庆行程，11/5 早餐 08:00，之后游览公园。',
      tripBrief: brief
    })

    expect(result.itineraryOptions).toHaveLength(1)
    expect(result.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining('时间重叠') })
    ]))
  })

  it('景点之间的明确时段冲突保留候选并回传 warning', async () => {
    const result = await itineraryProposalTool.execute({ plan: {
      title: '重庆上午行程', summary: '安排两个景点。', tradeoffs: '',
      days: [{ day_number: 1, date: brief.startDate, title: '园区游览', stops: [
        { name: '公园', area: '重庆', time: '08:00–10:30', category: '景点', notes: '' },
        { name: '博物馆', area: '重庆', time: '10:00–11:00', category: '景点', notes: '' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '请规划 2026-11-05 的重庆行程。',
      tripBrief: brief
    })

    expect(result.itineraryOptions).toHaveLength(1)
    expect(result.feedback).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', message: expect.stringContaining('时间重叠') })
    ]))
  })

  it('单日修订只提交目标日，由主进程合并基线并继续校验完整行程', async () => {
    const tripBrief = { ...brief, destination: '北京', startDate: '2026-09-23', endDate: '2026-09-24' }
    const initial = await itineraryProposalTool.execute({ plan: {
      title: '北京两日计划', summary: '按片区游览。', tradeoffs: '',
      days: [
        { day_number: 1, date: '2026-09-23', title: '颐和园', stops: [
          { name: '颐和园', time: '09:00–12:00', category: '景点' }
        ] },
        { day_number: 2, date: '2026-09-24', title: '天坛', stops: [
          { name: '天坛公园', time: '09:00–11:00', category: '景点' }
        ] }
      ]
    } }, { amapKey: null, researchCompleted: true, tripBrief })
    const baseline = initial.itineraryOptions?.[0]
    expect(baseline).toBeDefined()

    const definition = itineraryProposalDefinitionForBudget({
      budgetRequested: false,
      tripBrief,
      revisionBaseline: baseline,
      unchangedItineraryDates: ['2026-09-24']
    })
    const parameters = definition.function.parameters as {
      properties: { plan: { properties: { days: {
        minItems?: number
        maxItems?: number
        items?: { properties?: { date?: { enum?: string[] } } }
      } } } }
    }
    expect(parameters.properties.plan.properties.days).toMatchObject({ minItems: 1, maxItems: 1 })
    expect(parameters.properties.plan.properties.days.items?.properties?.date?.enum).toEqual(['2026-09-23'])

    const revised = await itineraryProposalTool.execute({ plan: {
      title: '北京轻松两日', summary: '海淀行程放慢节奏。', tradeoffs: '',
      days: [{ day_number: 1, date: '2026-09-23', title: '轻松游颐和园', stops: [
        { name: '颐和园', time: '10:00–12:00', category: '景点' }
      ] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      tripBrief,
      userRequest: '只调整 9/23 的节奏，9/24 保持不变。',
      revisionBaseline: baseline,
      unchangedItineraryDates: ['2026-09-24']
    })

    const days = revised.itineraryOptions?.[0]?.days ?? []
    expect(days).toHaveLength(2)
    expect(days[0]?.title).toBe('轻松游颐和园')
    expect(days[1]).toEqual(baseline?.days[1])
  })

  it('单日修订拒绝错误日期或日序，避免将补丁合并到其他日期', async () => {
    const tripBrief = { ...brief, destination: '北京', startDate: '2026-09-23', endDate: '2026-09-24' }
    const baseline: ItineraryOption = {
      id: 'baseline', title: '北京两日计划', summary: '按片区游览。', tradeoffs: '',
      days: [
        { id: 'day-1', dayNumber: 1, date: '2026-09-23', title: '颐和园', stops: [
          { id: 'stop-1', name: '颐和园', area: '', time: '上午', durationMinutes: null, category: '景点', notes: '', transitToNext: '' }
        ], scheduleBlocks: [] },
        { id: 'day-2', dayNumber: 2, date: '2026-09-24', title: '天坛', stops: [
          { id: 'stop-2', name: '天坛公园', area: '', time: '上午', durationMinutes: null, category: '景点', notes: '', transitToNext: '' }
        ], scheduleBlocks: [] }
      ]
    }

    await expect(itineraryProposalTool.execute({ plan: {
      title: '错误日期', summary: '错误日期。', tradeoffs: '',
      days: [{ day_number: 2, date: '2026-09-24', title: '错误日期', stops: [
        { name: '天坛公园', time: '上午', category: '景点' }
      ] }]
    } }, {
      amapKey: null, researchCompleted: true, tripBrief,
      userRequest: '只修改 9/23。', revisionBaseline: baseline, unchangedItineraryDates: ['2026-09-24']
    })).rejects.toMatchObject({ severity: 'warning', code: 'revision_date_mismatch' })
  })

  it('局部日序可从 1 开始提交，合并后恢复为完整行程中的原日序', async () => {
    const tripBrief = { ...brief, destination: '北京', startDate: '2026-11-05', endDate: '2026-11-07' }
    const baseline: ItineraryOption = {
      id: 'baseline-three-days', title: '北京三日计划', summary: '按片区游览。', tradeoffs: '',
      days: [5, 6, 7].map((day, index) => ({
        id: `day-${day}`, dayNumber: index + 1, date: `2026-11-${String(day).padStart(2, '0')}`, title: `第 ${index + 1} 天`,
        stops: [{
          id: `stop-${day}`, name: `北京景点${day}`, area: '', time: '09:00–11:00',
          durationMinutes: null, category: '景点', notes: '', transitToNext: ''
        }],
        scheduleBlocks: []
      }))
    }

    const revised = await itineraryProposalTool.execute({ plan: {
      title: '北京三日计划', summary: '第三日放慢节奏。', tradeoffs: '',
      days: [{ day_number: 1, date: '2026-11-07', title: '第三日轻松游', stops: [
        { name: '北京景点7', time: '10:00–12:00', category: '景点' }
      ] }]
    } }, {
      amapKey: null, researchCompleted: true, tripBrief,
      userRequest: '只调整 11/07 的节奏，其他日期保持不变。',
      revisionBaseline: baseline,
      unchangedItineraryDates: ['2026-11-05', '2026-11-06']
    })

    const days = revised.itineraryOptions?.[0]?.days ?? []
    expect(days).toHaveLength(3)
    expect(days[0]).toEqual(baseline.days[0])
    expect(days[1]).toEqual(baseline.days[1])
    expect(days[2]).toMatchObject({ dayNumber: 3, date: '2026-11-07', title: '第三日轻松游' })
  })

  it('修订候选仍包含用户明确删除的地点时拒绝交付', async () => {
    const revisionBrief = {
      ...brief, destination: '北京', startDate: '2026-09-23', endDate: '2026-09-24'
    }
    const initial = await itineraryProposalTool.execute({ plan: {
      title: '北京两日计划', summary: '按片区安排。', tradeoffs: '',
      days: [
        { day_number: 1, date: '2026-09-23', title: '颐和园与赏秋', stops: [
          { name: '颐和园', time: '上午', category: '景点' },
          { name: '香山公园', time: '下午', category: '景点' },
          { name: '碧云寺', time: '下午', category: '景点' }
        ] },
        { day_number: 2, date: '2026-09-24', title: '天坛', stops: [
          { name: '天坛公园', time: '上午', category: '景点' }
        ] }
      ]
    } }, { amapKey: null, researchCompleted: true, tripBrief: revisionBrief })
    const baseline = initial.itineraryOptions?.[0]
    expect(baseline).toBeDefined()

    const removedShortName = await itineraryProposalTool.execute({ plan: {
      title: '轻松赏秋', summary: '保留颐和园。', tradeoffs: '',
      days: [
        { day_number: 1, date: '2026-09-23', title: '轻松赏秋', stops: [
          { name: '颐和园', time: '上午', category: '景点' },
          { name: '香山', time: '下午', category: '景点' }
        ] },
        { day_number: 2, date: '2026-09-24', title: '天坛', stops: [
          { name: '天坛公园', time: '上午', category: '景点' }
        ] }
      ]
    } }, {
      amapKey: null,
      researchCompleted: true,
      tripBrief: revisionBrief,
      userRequest: '只把 9/23 调轻松，删除香山和碧云寺，保留颐和园主线。',
      revisionBaseline: baseline,
      unchangedItineraryDates: ['2026-09-24']
    })
    expect(removedShortName.itineraryOptions?.[0]?.days[0]?.stops.map((stop) => stop.name)).toEqual(['颐和园'])

    const removedRouteAlias = await itineraryProposalTool.execute({ plan: {
      title: '只保留颐和园', summary: '移除用户指定的地点。', tradeoffs: '',
      days: [
        { day_number: 1, date: '2026-09-23', title: '轻松赏秋', stops: [
          { name: '颐和园', time: '上午', category: '景点' },
          { name: '碧云寺参观线路', time: '下午', category: '景点' }
        ] },
        { day_number: 2, date: '2026-09-24', title: '天坛', stops: [
          { name: '天坛公园', time: '上午', category: '景点' }
        ] }
      ]
    } }, {
      amapKey: null,
      researchCompleted: true,
      tripBrief: revisionBrief,
      userRequest: '只把 9/23 调轻松，删除香山和碧云寺，保留颐和园主线。',
      revisionBaseline: baseline,
      unchangedItineraryDates: ['2026-09-24']
    })
    expect(removedRouteAlias.itineraryOptions?.[0]?.days[0]?.stops.map((stop) => stop.name)).toEqual(['颐和园'])

    const removedTransferAlias = await itineraryProposalTool.execute({ plan: {
      title: '仅保留颐和园', summary: '其余日期不变。', tradeoffs: '',
      days: [
        { day_number: 1, date: '2026-09-23', title: '轻松游览', stops: [
          { name: '颐和园', time: '上午', category: '景点' },
          { name: '香山东门接驳', time: '下午', category: '交通' }
        ] },
        { day_number: 2, date: '2026-09-24', title: '天坛', stops: [
          { name: '天坛公园', time: '上午', category: '景点' }
        ] }
      ]
    } }, {
      amapKey: null,
      researchCompleted: true,
      tripBrief: revisionBrief,
      userRequest: '只把 9/23 调轻松，删除香山和碧云寺，保留颐和园主线。',
      revisionBaseline: baseline,
      unchangedItineraryDates: ['2026-09-24']
    })
    expect(removedTransferAlias.itineraryOptions?.[0]?.days[0]?.stops.map((stop) => stop.name)).toEqual(['颐和园'])
  })

  it('保留未修改日期的既有餐次问题，并允许修改目标日继续提交草案', async () => {
    const tripBrief = {
      ...brief, destination: '北京', startDate: '2026-09-23', endDate: '2026-09-24'
    }
    const initial = await itineraryProposalTool.execute({ plan: {
      title: '北京两日计划', summary: '按片区安排。', tradeoffs: '',
      days: [
        { day_number: 1, date: '2026-09-23', title: '颐和园', stops: [
          { name: '颐和园', time: '09:00–12:00', duration_minutes: 180, category: '景点' }
        ] },
        { day_number: 2, date: '2026-09-24', title: '天坛', stops: [
          { name: '早餐店甲', time: '07:00–07:30 早餐', duration_minutes: 30, category: '餐饮' },
          { name: '天坛公园', time: '09:00–11:00', duration_minutes: 120, category: '景点' }
        ] }
      ]
    } }, { amapKey: null, researchCompleted: true, tripBrief })
    const baseline = initial.itineraryOptions?.[0]
    expect(baseline).toBeDefined()
    baseline!.days[1]!.stops.push({
      ...baseline!.days[1]!.stops[0]!, id: 'existing-extra-breakfast', name: '早餐店乙',
      time: '07:40–08:10 早餐'
    })
    const protectedDay = structuredClone(baseline!.days[1])

    const revised = await itineraryProposalTool.execute({ plan: {
      title: '北京两日计划修订', summary: '缩短颐和园安排。', tradeoffs: '未修改日沿用上一版。',
      days: [
        { day_number: 1, date: '2026-09-23', title: '轻松颐和园', stops: [
          { name: '颐和园', time: '10:00–12:00', duration_minutes: 120, category: '景点' }
        ] },
        { day_number: 2, date: '2026-09-24', title: '模型重写日期', stops: [
          { name: '早餐店', time: '07:00 早餐', category: '餐饮' },
          { name: '天坛公园', time: '09:00–11:00', duration_minutes: 120, category: '景点' }
        ] }
      ]
    } }, {
      amapKey: null, researchCompleted: true, tripBrief,
      userRequest: '只把 9/23 调轻松，其他日期保持不变。',
      revisionBaseline: baseline,
      unchangedItineraryDates: ['2026-09-24'],
      requiredMealSlots: [{ date: '2026-09-24', slots: ['breakfast'], exclusive: true }]
    })

    expect(revised.itineraryOptions?.[0]?.days[0]?.title).toBe('轻松颐和园')
    expect(revised.itineraryOptions?.[0]?.days[1]).toEqual(protectedDay)
    expect(analyzeMealRequirements(
      revised.itineraryOptions![0]!.days, revised.itineraryOptions![0]!.mealRequirements
    )).toContainEqual(expect.objectContaining({
      code: 'meal-requirement', date: '2026-09-24', message: expect.stringContaining('早餐重复或额外安排')
    }))
  })

  it('用户后续明确收窄餐次时更新约束快照，不沿用旧餐次', async () => {
    const tripBrief = {
      ...brief, destination: '北京', startDate: '2026-09-23', endDate: '2026-09-24'
    }
    const baselineResult = await itineraryProposalTool.execute({ plan: {
      title: '北京两日计划', summary: '按片区安排。', tradeoffs: '',
      days: [
        { day_number: 1, date: '2026-09-23', title: '颐和园', stops: [
          { name: '颐和园', time: '09:00–12:00', duration_minutes: 180, category: '景点' }
        ] },
        { day_number: 2, date: '2026-09-24', title: '天坛', stops: [
          { name: '天坛公园', time: '09:00–11:00', duration_minutes: 120, category: '景点' },
          { name: '晚餐店', time: '18:00 晚餐', category: '餐饮' }
        ] }
      ]
    } }, {
      amapKey: null, researchCompleted: true, tripBrief,
      requiredMealSlots: [{ date: '2026-09-24', slots: ['dinner'], exclusive: true }]
    })
    const baseline = baselineResult.itineraryOptions?.[0]
    expect(baseline).toBeDefined()
    baseline!.mealRequirements = [{
      date: '2026-09-24', slots: ['dinner'], exclusive: true,
      requestedStartTimes: { dinner: ['18:00'] }
    }]

    const revised = await itineraryProposalTool.execute({ plan: {
      title: '北京两日计划修订', summary: '按最新餐次要求调整。', tradeoffs: '',
      days: [
        { day_number: 1, date: '2026-09-23', title: '颐和园', stops: [
          { name: '颐和园', time: '09:00–12:00', duration_minutes: 180, category: '景点' }
        ] },
        { day_number: 2, date: '2026-09-24', title: '早餐和午餐', stops: [
          { name: '早餐店', time: '08:00 早餐', category: '餐饮' },
          { name: '天坛公园', time: '09:00–11:00', duration_minutes: 120, category: '景点' },
          { name: '午餐店', time: '12:00 午餐', category: '餐饮' }
        ] }
      ]
    } }, {
      amapKey: null, researchCompleted: true, tripBrief,
      userRequest: '9/24 只安排早餐和午餐。', revisionBaseline: baseline,
      requiredMealSlots: [{ date: '2026-09-24', slots: ['breakfast', 'lunch'], exclusive: true }]
    })

    const requirement = revised.itineraryOptions?.[0]?.mealRequirements?.find((item) => item.date === '2026-09-24')
    expect(requirement?.slots).toEqual(['breakfast', 'lunch'])
    expect(requirement?.requestedStartTimes?.dinner).toBeUndefined()
    expect(analyzeMealRequirements(revised.itineraryOptions![0]!.days, revised.itineraryOptions![0]!.mealRequirements))
      .toEqual([])
  })

  it('未指定钟点的早餐时间块与景点重叠时自动挪入空档', async () => {
    const result = await itineraryProposalTool.execute({ plan: {
      title: '重庆上午行程', summary: '早餐后游览。', tradeoffs: '',
      days: [{ day_number: 1, date: brief.startDate, title: '园区游览', stops: [
        { name: '公园', area: '重庆', time: '08:00–12:15', category: '景点', notes: '' }
      ], schedule_blocks: [{
        kind: 'meal', title: '早餐', time: '08:00–08:45', duration_minutes: 45, area: '公园附近', notes: ''
      }] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '请规划 2026-11-05 的重庆行程，安排早餐后游览公园。',
      tripBrief: brief
    })

    const breakfast = result.itineraryOptions?.[0]?.days[0]?.scheduleBlocks.find((block) => block.kind === 'meal')
    expect(breakfast?.time).toBe('07:00–07:45')
  })

  it('晚餐与机动缓冲混写时按餐次处理并消除景点时段重叠', async () => {
    const result = await itineraryProposalTool.execute({ plan: {
      title: '重庆夜景行程', summary: '夜景拍摄后用餐。', tradeoffs: '',
      days: [{ day_number: 1, date: brief.startDate, title: '夜景拍摄', stops: [
        { name: '洪崖洞夜景拍摄', area: '渝中区', time: '20:00–21:00', category: '景点', notes: '' }
      ], schedule_blocks: [{
        kind: 'buffer', title: '晚餐与机动缓冲', time: '20:20–20:50', duration_minutes: 30,
        area: '', notes: '用餐后补充热饮和相机电量。'
      }] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '请规划重庆夜景摄影行程，并安排拍摄时段和交通缓冲。',
      tripBrief: brief
    })

    const day = result.itineraryOptions?.[0]?.days[0]
    const dinner = day?.scheduleBlocks.find((block) => block.kind === 'meal')
    expect(dinner?.time).toBe('21:00–21:30')
    expect(analyzeDaySchedule(day!, brief).some((finding) => finding.code === 'schedule-overlap')).toBe(false)
  })

  it('住宿地点待确认不应被标成待选景点', async () => {
    const result = await itineraryProposalTool.execute({ plan: {
      title: '重庆一日安排', summary: '游览后入住。', tradeoffs: '住宿地址待确认。',
      days: [{ day_number: 1, date: brief.startDate, title: '市区游览', stops: [
        {
          name: '洪崖洞', area: '渝中区', time: '14:00–16:00', duration_minutes: 120,
          category: '景点', notes: '', transit_to_next: '', evidence_level: 'pending', source_ids: [], fact_claims: []
        },
        {
          name: '住宿（具体地点待定）', area: '', time: '游览后入住（时段待核验）', duration_minutes: null,
          category: '住宿', notes: '住宿地址尚未提供，接驳信息待核验。', transit_to_next: '',
          evidence_level: 'pending', source_ids: [], fact_claims: []
        }
      ] }]
    } }, { amapKey: null, researchCompleted: true, userRequest: '请规划一天重庆行程。', tripBrief: brief })

    const lodging = result.itineraryOptions?.[0]?.days[0]?.stops.find((stop) => stop.category === '住宿')

    expect(lodging?.name).toBe('住宿（具体地点待定）')
    expect(lodging?.notes).toContain('住宿地址尚未提供')
    expect(lodging?.notes).not.toContain('具体游览点待选')
  })

  it('不把开放资料和多个无关时刻当作行程时段', async () => {
    const result = await itineraryProposalTool.execute({ plan: {
      title: '成都两处景点', summary: '按上午和下午安排。', tradeoffs: '精确时段待核验。',
      days: [{ day_number: 1, date: brief.startDate, title: '市区游览', stops: [
        {
          name: '成都大熊猫繁育研究基地', area: '成都',
          time: '上午(11月开园 8:00 起,需线上实名预约,待核验)', category: '景点',
          duration_minutes: null, notes: '', transit_to_next: '', evidence_level: 'pending', source_ids: [], fact_claims: []
        },
        {
          name: '成都武侯祠博物馆', area: '成都',
          time: '14:00 / 09:00 / 18:00 / 17:00 下午 (官方渠道预约', category: '景点',
          duration_minutes: null, notes: '', transit_to_next: '', evidence_level: 'pending', source_ids: [], fact_claims: []
        }
      ] }]
    } }, { amapKey: null, researchCompleted: true, userRequest: '请规划成都一天行程。', tripBrief: { ...brief, destination: '成都' } })

    const stops = result.itineraryOptions?.[0]?.days[0]?.stops

    expect(stops?.map((stop) => stop.time)).toEqual([
      '上午（具体时段待核验）', '下午（具体时段待核验）'
    ])
  })

  it('无抵达上下文时移除接驳占位，并把错标的交通缓冲归入 buffer', async () => {
    const result = await itineraryProposalTool.execute({ plan: {
      title: '重庆夜景摄影', summary: '按顺序安排街区与夜景。', tradeoffs: '具体开放和交通信息待核验。',
      days: [{ day_number: 1, date: brief.startDate, title: '街区与夜景', stops: [
        {
          name: '进城接驳（地点待确认）', area: '', time: '15:30', duration_minutes: 5,
          category: '交通', notes: '抵达机场或车站未提供；确认后再核对该段接驳。'
        },
        {
          name: '长江索道', area: '渝中区', time: '18:30-19:00', duration_minutes: 60,
          category: '景点', notes: '单程约 5-10 分钟。'
        },
        { name: '龙门浩老街', area: '南岸区', time: '17:00', duration_minutes: 75, category: '景点', notes: '' }
      ], schedule_blocks: [{
        kind: 'meal', title: '交通缓冲', time: '18:45-19:20', duration_minutes: null,
        area: '', notes: '晚餐后至夜景机位的机动时间。'
      }] }]
    } }, {
      amapKey: null,
      researchCompleted: true,
      userRequest: '请规划重庆两日夜景摄影行程，安排拍摄时段和交通缓冲；日落时间、夜间开放和拍摄限制都要核验，不要承诺特定光线效果。',
      tripBrief: brief
    })

    const day = result.itineraryOptions?.[0]?.days[0]
    const cableway = day?.stops.find((stop) => stop.name === '长江索道')

    expect(day?.stops.some((stop) => /^(?:进城接驳|抵达交通)（地点待确认）$/u.test(stop.name))).toBe(false)
    expect(day?.scheduleBlocks).toMatchObject([{ kind: 'buffer', title: '交通缓冲' }])
    expect(cableway?.durationMinutes).toBe(30)
    expect(cableway?.notes).toContain('耗时待核验')
    expect(cableway?.notes).not.toMatch(/5-10/u)
  })

  it('路线估时外保留交通方式对应的机动余量', () => {
    const firstStop: NonNullable<ItineraryOption['days'][number]['stops'][number]> = {
      id: 'first', name: '天安门广场', area: '东城区', time: '09:00–10:00',
      durationMinutes: 60, category: '景点', notes: '', transitToNext: '公共交通到故宫博物院',
      transitEstimate: {
        sourceId: 'route-source', destinationStopId: 'second', mode: 'transit',
        fetchedAt: '2026-09-25T00:00:00.000Z', optionNumber: 1, durationMinutes: 77
      }
    }
    const day: ItineraryOption['days'][number] = {
      id: 'day', dayNumber: 1, date: brief.startDate, title: '中轴线',
      stops: [firstStop, {
        id: 'second', name: '故宫博物院', area: '东城区', time: '11:20–12:00',
        durationMinutes: 40, category: '景点', notes: '', transitToNext: ''
      }],
      scheduleBlocks: []
    }
    const conflict = analyzeDaySchedule(day, brief).find((finding) => finding.code === 'route-buffer')

    expect(routePlanningBufferMinutes('transit')).toBe(10)
    expect(routePlanningBufferMinutes('walking')).toBe(5)
    expect(routePlanningBufferMinutes('driving')).toBe(10)
    expect(conflict?.routeTiming).toMatchObject({
      routeDurationMinutes: 77, bufferMinutes: 10, requiredWindowMinutes: 87,
      availableWindowMinutes: 80, shortfallMinutes: 7
    })
    expect(analyzeDaySchedule({
      ...day,
      stops: [firstStop, { ...day.stops[1]!, time: '11:30–12:00' }]
    }, brief).some((finding) => finding.code === 'route-buffer')).toBe(false)
  })
})
