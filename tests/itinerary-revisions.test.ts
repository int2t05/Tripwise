/** 验证“撤销到上一版”始终选择当前版本之前最近的已保存快照。 */
import { describe, expect, it } from 'vitest'
import type { ItineraryOption, ItineraryRevision, ItineraryScheduleBlock } from '../src/shared/types.js'
import {
  explicitlyExcludedItineraryStopsForRequest,
  explicitlyExcludedStopNameMatches,
  itineraryStopNameMatches,
  preserveLockedStops,
  preserveScopedItineraryEdits,
  previousItineraryRevision,
  preserveUnchangedItineraryDays,
  unchangedItineraryDatesForRequest
} from '../src/shared/itinerary-revisions.js'

function revision(id: string, number: number): ItineraryRevision {
  return { id, number, createdAt: '', summary: '', content: '', sourceIds: [] }
}

function itinerary(): ItineraryOption {
  const dates = ['2026-09-21', '2026-09-22', '2026-09-23']
  return {
    id: 'plan', title: '北京行程', summary: '', tradeoffs: '',
    days: dates.map((date, index) => ({
      id: `day-${index + 1}`, dayNumber: index + 1, date, title: `第${index + 1}天`,
      stops: [{
        id: `stop-${index + 1}`, name: `地点${index + 1}`, area: '', time: '上午',
        durationMinutes: null, category: '景点', notes: '', transitToNext: '', evidenceLevel: 'pending',
        sourceIds: [], factClaims: []
      }], scheduleBlocks: []
    }))
  }
}

describe('行程版本撤销目标', () => {
  it('按版本号找出当前活动版本之前最近的快照，不依赖数组顺序', () => {
    const revisions = [revision('v1', 1), revision('v4', 4), revision('v2', 2), revision('v3', 3)]

    expect(previousItineraryRevision(revisions, 'v4')?.id).toBe('v3')
  })

  it('首次版本、空旅行和未知活动版本没有撤销目标', () => {
    const revisions = [revision('v1', 1)]

    expect(previousItineraryRevision(revisions, 'v1')).toBeNull()
    expect(previousItineraryRevision([], null)).toBeNull()
    expect(previousItineraryRevision(revisions, 'missing')).toBeNull()
  })

  it('识别单日局部修改，并保留明确未修改的其他日期', () => {
    const previous = itinerary()
    const request = '只把 9/23 调轻松，删除一个景点。9/21、9/22 都保持不变。'
    const unchangedDates = unchangedItineraryDatesForRequest(request, previous)
    const proposed: ItineraryOption = {
      ...previous,
      days: previous.days.map((day) => ({ ...day, title: `模型改写${day.title}` }))
    }

    expect(unchangedDates).toEqual(['2026-09-21', '2026-09-22'])
    const result = preserveUnchangedItineraryDays(previous, proposed, unchangedDates)
    expect(result.days.map((day) => day.title)).toEqual(['第1天', '第2天', '模型改写第3天'])

    result.days[0]!.stops[0]!.name = '校验器临时修改'
    expect(previous.days[0]!.stops[0]!.name).toBe('地点1')
  })

  it('支持带年份与餐次的单日修改；开放式全程重规划不设局部保护', () => {
    const previous = itinerary()

    expect(unchangedItineraryDatesForRequest('只把 2026-09-22 晚餐改成别家，其他安排不变。', previous))
      .toEqual(['2026-09-21', '2026-09-23'])
    expect(unchangedItineraryDatesForRequest('把 9/22 到 9/23 的行程整体重排。', previous)).toEqual([])
  })

  it('跨日移动同时解锁来源日和目标日，只保护其他日期', () => {
    const previous = itinerary()
    previous.days[1]!.stops[0]!.name = '清华大学'
    const request = '只把2026-09-22“清华大学”移到指定日期；保留这个地点和其他日期的安排，只调整受影响两天的时段与相邻通勤，并重新核对预约、抵离约束和时间冲突。目标日期：2026-09-23。'
    const unchangedDates = unchangedItineraryDatesForRequest(request, previous)

    expect(unchangedDates).toEqual(['2026-09-21'])
    expect(unchangedItineraryDatesForRequest('只把 9/22 的清华大学移到 9/23，其他日期保持原样。', previous))
      .toEqual(['2026-09-21'])

    const proposed = structuredClone(previous)
    const movedStop = proposed.days[1]!.stops.splice(0, 1)[0]!
    proposed.days[2]!.stops.unshift({ ...movedStop, time: '09:00–10:30' })
    proposed.days[0]!.title = '模型误改受保护日期'
    const result = preserveUnchangedItineraryDays(previous, proposed, unchangedDates)

    expect(result.days[0]).toEqual(previous.days[0])
    expect(result.days[1]!.stops.some((stop) => stop.name === '清华大学')).toBe(false)
    expect(result.days[2]!.stops[0]).toMatchObject({ name: '清华大学', time: '09:00–10:30' })
  })

  it('连续跨日移动解锁每个来源日，并保留抵达日、返程锚点和未涉及日期', () => {
    const previous = itinerary()
    const sampleStop = previous.days[0]!.stops[0]!
    previous.days[0]!.stops[0] = {
      ...sampleStop, id: 'arrival-anchor', name: '北京大兴机场', time: '19:30', category: '交通', locked: true
    }
    previous.days[1]!.stops[0]!.name = '清华大学'
    previous.days[2]!.stops[0]!.name = '圆明园'
    previous.days.push(
      {
        ...structuredClone(previous.days[0]!), id: 'day-4', dayNumber: 4, date: '2026-09-24', title: '第4天',
        stops: [{ ...sampleStop, id: 'xiangshan', name: '香山公园' }]
      },
      {
        ...structuredClone(previous.days[0]!), id: 'day-5', dayNumber: 5, date: '2026-09-25', title: '返程日',
        stops: [{ ...sampleStop, id: 'departure-anchor', name: '北京西站', time: '19:00前抵达；20:00离站', category: '交通', locked: true }]
      },
      {
        ...structuredClone(previous.days[0]!), id: 'day-6', dayNumber: 6, date: '2026-09-26', title: '第6天',
        stops: [{ ...sampleStop, id: 'unaffected-stop', name: '未涉及地点' }]
      }
    )
    const request = '把 2026-09-22 的清华大学移到 2026-09-23，随后把 2026-09-24 的香山公园移到 2026-09-25。'
    const unchangedDates = unchangedItineraryDatesForRequest(request, previous)

    expect(unchangedDates).toEqual(['2026-09-21', '2026-09-26'])

    const proposed = structuredClone(previous)
    const firstMove = proposed.days[1]!.stops.splice(0, 1)[0]!
    const secondMove = proposed.days[3]!.stops.splice(0, 1)[0]!
    proposed.days[2]!.stops.push(firstMove)
    proposed.days[4]!.stops.push(secondMove)
    proposed.days[0]!.stops[0]!.time = '20:00'
    proposed.days[5]!.title = '模型误改的未涉及日期'

    const result = preserveUnchangedItineraryDays(previous, proposed, unchangedDates)
    const lockCheck = preserveLockedStops(previous, result)
    expect(lockCheck.conflicts).toEqual([])
    expect(lockCheck.itinerary.days[0]).toEqual(previous.days[0])
    expect(lockCheck.itinerary.days[4]!.stops[0]).toMatchObject({
      name: '北京西站', time: '19:00前抵达；20:00离站', locked: true
    })
    expect(lockCheck.itinerary.days[2]!.stops.map((stop) => stop.name)).toContain('清华大学')
    expect(lockCheck.itinerary.days[3]!.stops.some((stop) => stop.name === '香山公园')).toBe(false)
    expect(lockCheck.itinerary.days[4]!.stops.map((stop) => stop.name)).toContain('香山公园')
    expect(lockCheck.itinerary.days[5]).toEqual(previous.days[5])

    const alteredAnchors = structuredClone(lockCheck.itinerary)
    alteredAnchors.days[0]!.stops[0]!.time = '20:00'
    alteredAnchors.days[4]!.stops[0]!.time = '18:00'
    expect(preserveLockedStops(lockCheck.itinerary, alteredAnchors).conflicts).toEqual([
      '固定地点“北京大兴机场”的时段从“19:30”改为“20:00”。',
      '固定地点“北京西站”的时段从“19:00前抵达；20:00离站”改为“18:00”。'
    ])
  })

  it('只修改连写列出的多个日期时保留其余日期', () => {
    const previous = itinerary()

    expect(unchangedItineraryDatesForRequest('只调整 9/21 和 9/23，其余安排保持不变。', previous))
      .toEqual(['2026-09-22'])
  })

  it('只改一个地点名称时保留同一地点原有的时段、时长和片区', () => {
    const previous = itinerary()
    const target = previous.days[1]!.stops[0]!
    Object.assign(target, {
      name: '清华大学', area: '海淀区', time: '10:30–12:00', durationMinutes: 90,
      category: '人文景点', notes: '基线说明', transitToNext: '步行至下一站'
    })
    previous.days[1]!.stops.push({ ...target, id: 'stop-pku', name: '北京大学' })
    const request = '只修改 9/22 的清华大学：把这项的名称改为“清华大学校园”，仍指同一处实际地点，不替换景点。保留它当前的时段、90 分钟时长和海淀区片区；其他安排保持原样。'
    const unchangedDates = unchangedItineraryDatesForRequest(request, previous)
    const proposed = structuredClone(previous)
    Object.assign(proposed.days[1]!.stops[0]!, {
      name: '清华大学校园', area: '', time: '上午', durationMinutes: null,
      category: '景点', notes: '模型改写的说明', transitToNext: '前往圆明园'
    })

    const result = preserveScopedItineraryEdits(request, previous, proposed, unchangedDates)
    const updated = result.days[1]!.stops[0]!
    expect(updated.name).toBe('清华大学校园')
    expect(updated.area).toBe('海淀区')
    expect(updated.time).toBe('10:30–12:00')
    expect(updated.durationMinutes).toBe(90)
    expect(updated.category).toBe('人文景点')
    expect(updated.notes).toBe('基线说明')
    expect(updated.transitToNext).toBe('步行至下一站')
  })

  it('单地点时段、时长和片区赋值可改，其余地点字段沿用基线', () => {
    const previous = itinerary()
    const target = previous.days[1]!.stops[0]!
    Object.assign(target, {
      name: '清华大学', area: '清华园', time: '09:00–11:00', durationMinutes: 120,
      notes: '基线说明', transitToNext: '步行至下一站'
    })
    previous.days[1]!.stops.push({ ...target, id: 'stop-pku', name: '北京大学' })
    const request = '只修改 9/22 的清华大学：时段改为 09:30–11:00，建议停留 90 分钟，片区改为“海淀区”。其他安排保持原样。'
    const unchangedDates = unchangedItineraryDatesForRequest(request, previous)
    const proposed = structuredClone(previous)
    Object.assign(proposed.days[1]!.stops[0]!, {
      area: '海淀区', time: '09:30–11:00', durationMinutes: 90,
      notes: '模型改写说明', transitToNext: '改写接驳'
    })

    const result = preserveScopedItineraryEdits(request, previous, proposed, unchangedDates)
    const updated = result.days[1]!.stops[0]!
    expect(updated.area).toBe('海淀区')
    expect(updated.time).toBe('09:30–11:00')
    expect(updated.durationMinutes).toBe(90)
    expect(updated.notes).toBe('基线说明')
    expect(updated.transitToNext).toBe('步行至下一站')
  })

  it('预约事实只更新目标地点，保留当天其他地点与固定时段', () => {
    const previous = itinerary()
    const day = previous.days[1]!
    day.stops[0] = { ...day.stops[0]!, name: '清华大学', time: '09:00', notes: '从东门进入', locked: true,
      factClaims: [{ id: 'booking-old', type: 'booking', value: '预约待核验', scope: day.date, evidenceLevel: 'pending' }] }
    day.stops.push({ ...day.stops[0]!, id: 'stop-pku', name: '北京大学', notes: '保留北大' })
    const request = '只核对2026-09-22“清华大学”的预约、开放和门票信息，保留地点与固定时段；有来源才更新事实。需要调整：预约时间。'
    const proposed = structuredClone(previous)
    proposed.days[1]!.title = '模型改写主题'
    proposed.days[1]!.stops[0]!.notes = '模型改写入园说明'
    proposed.days[1]!.stops[0]!.time = '10:00'
    proposed.days[1]!.stops[0]!.factClaims = [{ id: 'booking-new', type: 'booking', value: '预约时间待核验', scope: day.date, evidenceLevel: 'pending' }]
    proposed.days[1]!.stops[1]!.notes = '模型改写北大'

    const unchangedDates = unchangedItineraryDatesForRequest(request, previous)
    expect(unchangedDates).toEqual(['2026-09-21', '2026-09-23'])
    const result = preserveScopedItineraryEdits(request, previous, proposed, unchangedDates)
    expect(result.days[1]!.title).toBe(day.title)
    expect(result.days[1]!.stops[0]!.time).toBe('09:00')
    expect(result.days[1]!.stops[0]!.notes).toBe('从东门进入')
    expect(result.days[1]!.stops[0]!.factClaims?.[0]?.id).toBe('booking-new')
    expect(result.days[1]!.stops[1]!.notes).toBe('保留北大')
  })

  it('条件备选只更新目标地点，餐馆替换也识别为单日请求', () => {
    const previous = itinerary()
    const day = previous.days[1]!
    day.stops[0] = { ...day.stops[0]!, name: '清华大学', notes: '保留主线',
      conditionalAlternatives: [{ name: '室内展厅', area: '海淀区', trigger: '下雨', evidenceLevel: 'pending', sourceIds: [] }] }
    day.stops.push({ ...day.stops[0]!, id: 'stop-pku', name: '北京大学', notes: '保留北大' })
    const request = '只调整2026-09-22“清华大学”的条件备选，保留正式行程与其他日期；写清触发条件和替代地点。改为：室内展览。'
    const proposed = structuredClone(previous)
    proposed.days[1]!.stops[0]!.notes = '模型改写主线'
    proposed.days[1]!.stops[0]!.conditionalAlternatives = [{ name: '海淀室内展览', area: '海淀区', trigger: '下雨', evidenceLevel: 'pending', sourceIds: [] }]
    proposed.days[1]!.stops[1]!.notes = '模型改写北大'

    const unchangedDates = unchangedItineraryDatesForRequest(request, previous)
    const result = preserveScopedItineraryEdits(request, previous, proposed, unchangedDates)
    expect(result.days[1]!.stops[0]!.notes).toBe('保留主线')
    expect(result.days[1]!.stops[0]!.conditionalAlternatives?.[0]?.name).toBe('海淀室内展览')
    expect(result.days[1]!.stops[1]!.notes).toBe('保留北大')
    expect(unchangedItineraryDatesForRequest('只替换2026-09-22的餐馆“午餐”，保留餐次与原定用餐时段。', previous))
      .toEqual(['2026-09-21', '2026-09-23'])
  })

  it('只改景点顺序和逐站时段时保留餐休与地点说明', () => {
    const previous = itinerary()
    const day = previous.days[1]!
    day.title = '海淀校园与园林'
    day.stops = [
      { ...day.stops[0]!, id: 'stop-tsinghua', name: '清华大学', area: '海淀区', time: '09:00–11:00', durationMinutes: 120, notes: '清华说明' },
      { ...day.stops[0]!, id: 'stop-pku', name: '北京大学', area: '海淀区', time: '11:30–13:00', durationMinutes: 90, notes: '北大说明' },
      { ...day.stops[0]!, id: 'stop-yuanmingyuan', name: '圆明园', area: '海淀区', time: '14:00–16:00', durationMinutes: 120, notes: '圆明园说明' }
    ]
    day.scheduleBlocks = [{
      id: 'lunch', kind: 'meal', title: '午餐', time: '13:00–13:45',
      durationMinutes: 45, area: '五道口', notes: '原有餐休说明'
    }]
    const request = '只修改 9/22 的景点顺序为：北京大学、清华大学、圆明园。时段依次为 09:00–10:00、10:30–12:00、14:00–16:00。午餐时间、时长和片区保持原样；其他六天也完整保持原样。'
    const unchangedDates = unchangedItineraryDatesForRequest(request, previous)
    const proposed = structuredClone(previous)
    const proposedDay = proposed.days[1]!
    proposedDay.title = '模型改写的日主题'
    proposedDay.stops = [
      { ...day.stops[1]!, id: 'new-pku', time: '09:00–10:00', notes: '模型改写北大说明' },
      { ...day.stops[0]!, id: 'new-tsinghua', time: '10:30–12:00', notes: '模型改写清华说明' },
      { ...day.stops[2]!, id: 'new-yuanmingyuan', time: '14:00–16:00', notes: '模型改写圆明园说明' }
    ]
    proposedDay.scheduleBlocks[0]!.notes = '模型改写餐休说明'

    const result = preserveScopedItineraryEdits(request, previous, proposed, unchangedDates)
    const updatedDay = result.days[1]!
    expect(updatedDay.stops.map((stop) => stop.name)).toEqual(['北京大学', '清华大学', '圆明园'])
    expect(updatedDay.stops.map((stop) => stop.time)).toEqual(['09:00–10:00', '10:30–12:00', '14:00–16:00'])
    expect(updatedDay.stops.map((stop) => stop.notes)).toEqual(['北大说明', '清华说明', '圆明园说明'])
    expect(updatedDay.scheduleBlocks).toEqual(day.scheduleBlocks)
    expect(updatedDay.title).toBe(day.title)
  })

  it('只改午餐时间和时长时保留当天景点及其他时间块', () => {
    const previous = itinerary()
    const day = previous.days[1]!
    day.title = '海淀校园与园林'
    day.stops = [
      { ...day.stops[0]!, id: 'stop-tsinghua', name: '清华大学', time: '09:00–11:00', notes: '清华说明' },
      { ...day.stops[0]!, id: 'stop-pku', name: '北京大学', time: '12:00–13:00', notes: '北大说明' }
    ]
    day.scheduleBlocks = [
      { id: 'lunch', kind: 'meal', title: '午餐', time: '13:00–13:45', durationMinutes: 45, area: '五道口', notes: '午餐说明' },
      { id: 'rest', kind: 'rest', title: '午间休息', time: '13:45–14:00', durationMinutes: 15, area: '海淀区', notes: '休息说明' }
    ]
    const request = '只修改 9/22 午餐：时段改为 13:00–13:30，时长改为 30 分钟；其他字段、景点和日期保持原样。'
    const proposed = structuredClone(previous)
    const proposedDay = proposed.days[1]!
    proposedDay.title = '模型新标题'
    proposedDay.stops[0]!.notes = '模型改写景点说明'
    proposedDay.scheduleBlocks[0] = {
      ...proposedDay.scheduleBlocks[0]!, time: '13:00–13:30', durationMinutes: 30,
      area: '模型改写片区', notes: '模型改写餐次说明'
    }
    proposedDay.scheduleBlocks[1]!.time = '14:00–14:30'

    const unchangedDates = unchangedItineraryDatesForRequest(request, previous)
    const result = preserveScopedItineraryEdits(request, previous, proposed, unchangedDates)
    const updatedDay = result.days[1]!
    expect(updatedDay.title).toBe(day.title)
    expect(updatedDay.stops).toEqual(day.stops)
    expect(updatedDay.scheduleBlocks).toEqual([
      { ...day.scheduleBlocks[0]!, time: '13:00–13:30', durationMinutes: 30 },
      day.scheduleBlocks[1]
    ])
  })

  it.each([
    ['类型', 'kind', 'rest', '只修改 9/22 午餐：类型改为休息，其他字段和安排保持原样。'],
    ['标题', 'title', '学校食堂', '只修改 9/22 午餐：标题改为“学校食堂”，其他字段和安排保持原样。'],
    ['片区', 'area', '清华园', '只修改 9/22 午餐：片区改为“清华园”，其他字段和安排保持原样。'],
    ['说明', 'notes', '选择校内清淡简餐', '只修改 9/22 午餐：说明改为“选择校内清淡简餐”，其他字段和安排保持原样。']
  ] as const)('单独修改餐休块%s时只提交目标字段', (_label, field, value, request) => {
    const previous = itinerary()
    const day = previous.days[1]!
    const lunch: ItineraryScheduleBlock = {
      id: 'lunch', kind: 'meal', title: '午餐', time: '12:00–12:45',
      durationMinutes: 45, area: '五道口', notes: '原午餐说明'
    }
    const rest: ItineraryScheduleBlock = {
      id: 'rest', kind: 'rest', title: '午间休息', time: '13:00–13:30',
      durationMinutes: 30, area: '海淀区', notes: '原休息说明'
    }
    day.title = '海淀日程'
    day.scheduleBlocks = [lunch, rest]

    const proposed = structuredClone(previous)
    const proposedDay = proposed.days[1]!
    proposedDay.title = '模型改写日主题'
    proposedDay.stops[0]!.notes = '模型改写地点说明'
    proposedDay.scheduleBlocks = [
      {
        ...lunch, kind: 'buffer', title: '模型改写标题', time: '14:00–15:51',
        durationMinutes: 111, area: '模型改写片区', notes: '模型改写时段说明'
      },
      { ...rest, time: '16:00–17:00', notes: '模型改写休息说明' }
    ]
    Object.assign(proposedDay.scheduleBlocks[0]!, { [field]: value })

    const unchangedDates = unchangedItineraryDatesForRequest(request, previous)
    expect(unchangedDates).toEqual(['2026-09-21', '2026-09-23'])
    const result = preserveScopedItineraryEdits(request, previous, proposed, unchangedDates)
    const updatedDay = result.days[1]!
    const expectedLunch = { ...lunch, [field]: value }

    expect(updatedDay.title).toBe(day.title)
    expect(updatedDay.stops).toEqual(day.stops)
    expect(updatedDay.scheduleBlocks).toEqual([expectedLunch, rest])
  })

  it('一次修改餐休块多个字段时只更新同一目标块', () => {
    const previous = itinerary()
    const day = previous.days[1]!
    const lunch: ItineraryScheduleBlock = {
      id: 'lunch', kind: 'meal', title: '午餐', time: '12:00–12:45',
      durationMinutes: 45, area: '五道口', notes: '原午餐说明'
    }
    const rest: ItineraryScheduleBlock = {
      id: 'rest', kind: 'rest', title: '午间休息', time: '13:00–13:30',
      durationMinutes: 30, area: '海淀区', notes: '原休息说明'
    }
    day.title = '海淀日程'
    day.stops = [
      { ...day.stops[0]!, id: 'tsinghua', name: '清华大学', area: '清华园', notes: '原地点说明' },
      { ...day.stops[0]!, id: 'peking', name: '北京大学', area: '海淀区', notes: '原校园说明' }
    ]
    day.scheduleBlocks = [lunch, rest]
    const request = '只修改 9/22 的“午餐”时段：时段改为 13:15–13:45，时长改为 30 分钟，类型改为休息，标题改为“校内休息”，片区改为“清华园”，说明改为“短暂用餐”。保留当天地点和其他安排。'
    const proposed = structuredClone(previous)
    const proposedDay = proposed.days[1]!
    proposedDay.title = '模型改写日主题'
    proposedDay.stops[0]!.notes = '模型改写地点说明'
    proposedDay.scheduleBlocks = [
      {
        ...lunch, id: 'model-lunch'
      },
      { ...rest, time: '13:00–14:00', notes: '模型改写其他休息说明' }
    ]

    const unchangedDates = unchangedItineraryDatesForRequest(request, previous)
    const result = preserveScopedItineraryEdits(request, previous, proposed, unchangedDates)

    expect(result.days[1]!.title).toBe(day.title)
    expect(result.days[1]!.stops).toEqual(day.stops)
    expect(result.days[1]!.scheduleBlocks).toEqual([
      { ...lunch, kind: 'rest', title: '校内休息', time: '13:15–13:45', durationMinutes: 30, area: '清华园', notes: '短暂用餐' },
      rest
    ])
  })

  it('只改单个地点的下一段接驳时保留其他地点字段和餐休', () => {
    const previous = itinerary()
    const day = previous.days[1]!
    day.title = '海淀校园与园林'
    day.stops = [
      { ...day.stops[0]!, id: 'stop-tsinghua', name: '清华大学', area: '清华园', time: '09:00–11:00', durationMinutes: 120, notes: '清华说明', transitToNext: '优先公共交通，线路待核验' },
      { ...day.stops[0]!, id: 'stop-pku', name: '北京大学', area: '海淀区', time: '12:00–13:00', notes: '北大说明' }
    ]
    day.stops[0]!.transitEstimate = {
      sourceId: 'old-route', destinationStopId: 'stop-pku', mode: 'transit',
      fetchedAt: '2026-09-21T00:00:00.000Z', optionNumber: 1, durationMinutes: 30
    }
    day.stops[0]!.factClaims = [
      { id: 'old-route-fact', type: 'transport-time', value: '30 分钟', scope: '相邻地点', evidenceLevel: 'sourced', sourceId: 'old-route' },
      { id: 'opening-fact', type: 'opening-hours', value: '09:00–17:00', scope: '全天', evidenceLevel: 'sourced', sourceId: 'opening-source' }
    ]
    day.scheduleBlocks = [{ id: 'lunch', kind: 'meal', title: '午餐', time: '13:00–13:45', durationMinutes: 45, area: '五道口', notes: '午餐说明' }]
    const request = '只调整 9/22 从“清华大学”到“北京大学”的接驳，保留停靠点、时段和其他日期，交通方式改为：步行。'
    const proposed = structuredClone(previous)
    const proposedDay = proposed.days[1]!
    proposedDay.stops[0] = {
      ...proposedDay.stops[0]!, area: '模型片区', time: '上午', durationMinutes: null,
      notes: '模型改写说明', transitToNext: '骑行前往北京大学'
    }
    proposedDay.stops[1]!.name = '模型改写北大'
    proposedDay.scheduleBlocks[0]!.notes = '模型改写午餐'

    const unchangedDates = unchangedItineraryDatesForRequest(request, previous)
    const result = preserveScopedItineraryEdits(request, previous, proposed, unchangedDates)
    const updatedDay = result.days[1]!
    expect(updatedDay.stops[0]).toMatchObject({
      id: 'stop-tsinghua', name: '清华大学', area: '清华园', time: '09:00–11:00', durationMinutes: 120,
      notes: '清华说明', transitToNext: '步行'
    })
    expect(updatedDay.stops[0]!.transitEstimate).toBeUndefined()
    expect(updatedDay.stops[0]!.factClaims?.map((claim) => claim.type)).toEqual(['opening-hours'])
    expect(updatedDay.stops[1]).toEqual(day.stops[1])
    expect(updatedDay.scheduleBlocks).toEqual(day.scheduleBlocks)
    expect(updatedDay.title).toBe(day.title)
  })

  it('北京逐日局部修改保留用户明确列出的所有非目标日期', () => {
    const previous = itinerary()
    const dates = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']
    previous.days = dates.map((date, index) => ({
      ...previous.days[0]!, id: `day-${index + 1}`, dayNumber: index + 1, date
    }))
    const request = '第一轮修改：以刚才的最新草案为基线。只把 9/23 调轻松，删除香山和碧云寺，保留颐和园主线；午餐后回酒店休息。9/22、9/24、9/25、9/26、9/27 和抵离时刻都保持不变。请返回一份完整修订草案，不并列方案。'

    expect(unchangedItineraryDatesForRequest(request, previous)).toEqual([
      '2026-09-21', '2026-09-22', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'
    ])
  })

  it('只提取目标日期里明确要求删除的地点，不把保留点混入删除项', () => {
    const previous = itinerary()
    previous.days[2]!.stops = ['颐和园', '香山公园', '碧云寺'].map((name, index) => ({
      ...previous.days[2]!.stops[0]!, id: `day-3-stop-${index}`, name
    }))
    const request = '只把 9/23 调轻松，删除香山和碧云寺，保留颐和园主线；午餐后回酒店休息。'
    const unchangedDates = unchangedItineraryDatesForRequest(request, previous)

    expect(explicitlyExcludedItineraryStopsForRequest(request, previous, unchangedDates)).toEqual([
      { date: '2026-09-23', stopId: 'day-3-stop-1', stopName: '香山公园' },
      { date: '2026-09-23', stopId: 'day-3-stop-2', stopName: '碧云寺' }
    ])
  })

  it('北京真实逐时段修改可从行程描述中识别删除点简称', () => {
    const previous = itinerary()
    previous.days[2]!.stops = ['香山低强度赏秋路线', '碧云寺参观线路', '颐和园主线'].map((name, index) => ({
      ...previous.days[2]!.stops[0]!, id: `day-3-live-${index}`, name
    }))
    const request = '第一轮修改：以刚才的最新草案为基线。只把 9/23 调轻松，删除香山和碧云寺，保留颐和园主线；午餐后回酒店休息。9/22、9/24、9/25、9/26、9/27 和抵离时刻都保持不变。'
    const unchangedDates = unchangedItineraryDatesForRequest(request, previous)

    expect(explicitlyExcludedItineraryStopsForRequest(request, previous, unchangedDates)).toEqual([
      { date: '2026-09-23', stopId: 'day-3-live-0', stopName: '香山低强度赏秋路线' },
      { date: '2026-09-23', stopId: 'day-3-live-1', stopName: '碧云寺参观线路' }
    ])
  })

  it('保留或否定删除的表述不会误判成明确删除', () => {
    const previous = itinerary()
    previous.days[2]!.stops[0]!.name = '香山公园'

    expect(explicitlyExcludedItineraryStopsForRequest('不要删除香山，也保留它。', previous)).toEqual([])
    expect(explicitlyExcludedItineraryStopsForRequest('保留香山公园，移除碧云寺。', previous)).toEqual([])
  })

  it('候选地点与删除地点的常见城市前缀和场馆后缀可匹配', () => {
    expect(itineraryStopNameMatches('香山公园', '北京香山')).toBe(true)
    expect(itineraryStopNameMatches('碧云寺', '北京市碧云寺')).toBe(true)
    expect(itineraryStopNameMatches('香山公园', '景山公园')).toBe(false)
  })

  it('删除校验识别模型给旧地点改写的行程描述，不扩展普通名称匹配', () => {
    expect(explicitlyExcludedStopNameMatches('香山公园', '北京香山低强度赏秋路线')).toBe(true)
    expect(explicitlyExcludedStopNameMatches('碧云寺', '碧云寺参观线路')).toBe(true)
    expect(explicitlyExcludedStopNameMatches('北京大学', '北京大学校园参观路线')).toBe(true)
    expect(explicitlyExcludedStopNameMatches('北京大学', '北京香山红叶路线')).toBe(false)
    expect(explicitlyExcludedStopNameMatches('香山公园', '景山公园')).toBe(false)
    expect(itineraryStopNameMatches('香山公园', '北京香山低强度赏秋路线')).toBe(false)
  })

  it('按“第二天”等自然日期序号锁定未请求修改的行程日', () => {
    const previous = itinerary()
    previous.days[0]!.date = '2026-11-05'
    previous.days[1]!.date = '2026-11-06'
    previous.days[2]!.date = '2026-11-07'
    const request = '第二天改轻松一些，但保留已锁定的预约和第一、三天安排；先展示差异。'

    expect(unchangedItineraryDatesForRequest(request, previous))
      .toEqual(['2026-11-05', '2026-11-07'])
  })

  it('按中文序数分组保护用户同时指定调整的日期', () => {
    const previous = itinerary()

    expect(unchangedItineraryDatesForRequest('只调整第一天和第三天的餐次。', previous))
      .toEqual(['2026-09-22'])
  })

  it('模型误改未请求日期时仍按原日序恢复整日内容', () => {
    const previous = itinerary()
    const unchangedDates = unchangedItineraryDatesForRequest('把第二天改轻松一点。', previous)
    const proposed: ItineraryOption = {
      ...previous,
      days: previous.days.map((day, index) => ({
        ...day,
        date: index === 0 ? '2026-09-24' : day.date,
        title: `模型改写${day.title}`
      }))
    }

    const result = preserveUnchangedItineraryDays(previous, proposed, unchangedDates)

    expect(result.days.map((day) => day.date)).toEqual(['2026-09-21', '2026-09-22', '2026-09-23'])
    expect(result.days.map((day) => day.title)).toEqual(['第1天', '模型改写第2天', '第3天'])
  })

  it('局部晚餐修改中提到但未要求更改的其他日期仍保持锁定', () => {
    const previous = itinerary()
    const template = previous.days[0]!
    previous.days.push({ ...template, id: 'day-4', dayNumber: 4, date: '2026-09-24' })
    const request = '第二轮修改：以刚才最新的修订为基线。只把 9/24 晚餐改成前门一带的就近安排；若已有来源不能支持具体店名就保留待选。其他日期、刚调整的 9/23、每天餐次范围和抵离时刻都保持不变。请返回一份完整修订草案，不并列方案。'

    expect(unchangedItineraryDatesForRequest(request, previous))
      .toEqual(['2026-09-21', '2026-09-22', '2026-09-23'])
  })
})
