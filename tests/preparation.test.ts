/** 验证准备清单的日期顺序及其与已确认行程日的精确关联。 */
import { describe, expect, it } from 'vitest'
import type { ItineraryDay, ItineraryOption, PreparationItem, TripBrief } from '../src/shared/types.js'
import { groupPreparationItemsByDate } from '../src/shared/preparation.js'
import { preparationProposalTool } from '../src/main/connectors/preparation.js'
import { createSource } from '../src/main/connectors/types.js'
import { isPreparationItem } from '../src/main/persistence/schema.js'

function preparationItem(id: string, dates: { itineraryDate?: string; dueDate?: string; legacyDate?: string } = {}): PreparationItem {
  return {
    id, title: id, category: 'other', detail: '核对事项。', itineraryDate: dates.itineraryDate ?? '', dueDate: dates.dueDate ?? '',
    ...(dates.legacyDate ? { legacyDate: dates.legacyDate } : {}),
    evidenceLevel: 'pending', sourceIds: [], checked: false
  }
}

function itineraryDay(dayNumber: number, date: string, title: string): ItineraryDay {
  return { id: `day-${dayNumber}`, dayNumber, date, title, stops: [], scheduleBlocks: [] }
}

function itineraryWithStop(): ItineraryOption {
  return {
    id: 'plan-1', title: '成都一日游', summary: '市中心路线。', tradeoffs: '节奏适中。',
    days: [{
      id: 'day-1', dayNumber: 1, date: '2026-10-20', title: '市中心',
      scheduleBlocks: [],
      stops: [{
        id: 'stop-1', name: '人民公园', area: '青羊区', time: '10:00', durationMinutes: 60,
        category: '人文', notes: '', transitToNext: '', evidenceLevel: 'pending', sourceIds: [], factClaims: []
      }]
    }]
  }
}

function foodSuggestion(
  itineraryDate = '2026-10-20',
  locationContext?: Record<string, unknown>,
  sourceIds: string[] = [],
  title = '川味小馆',
  evidenceLevel: 'sourced' | 'estimated' | 'pending' = 'sourced'
) {
  return {
    items: [{
      title, category: 'food', detail: '靠近人民公园，口味可按忌口核对。', itinerary_date: itineraryDate, due_date: '',
      ...(locationContext ? { location_context: locationContext } : {}),
      evidence_level: evidenceLevel, source_ids: sourceIds
    }]
  }
}

/** 创建单日穿搭建议，复用工具真实接受的结构。 */
function clothingSuggestion(itineraryDate: string, evidenceLevel: 'sourced' | 'estimated' | 'pending', sourceIds: string[] = []) {
  return {
    items: [{
      title: '分层穿搭', category: 'clothing', detail: '按当日预报范围分层，未确认的衣物不要默认已有。',
      itinerary_date: itineraryDate, due_date: '', evidence_level: evidenceLevel, source_ids: sourceIds
    }]
  }
}

describe('按日期组织出行准备', () => {
  it('把适用日、截止日和旧版歧义日期分开，不将截止日关联到行程日', () => {
    const items = [
      preparationItem('day-three', { itineraryDate: '2026-10-22' }),
      preparationItem('undated'),
      preparationItem('before-trip-deadline', { dueDate: '2026-10-19' }),
      preparationItem('old-date', { legacyDate: '2026-10-18' }),
      preparationItem('day-one', { itineraryDate: '2026-10-20' }),
      preparationItem('day-one-extra', { itineraryDate: '2026-10-20', dueDate: '2026-10-17' })
    ]
    const days = [
      itineraryDay(3, '2026-10-22', '城北与公园'),
      itineraryDay(1, '2026-10-20', '抵达与市中心'),
      itineraryDay(2, '2026-10-21', '博物馆')
    ]

    const groups = groupPreparationItemsByDate(items, days)

    expect(groups.map(({ kind, date }) => [kind, date])).toEqual([
      ['itinerary', '2026-10-20'], ['itinerary', '2026-10-22'], ['deadline', '2026-10-19'],
      ['legacy', '2026-10-18'], ['undated', '']
    ])
    expect(groups[0].itineraryDays.map((day) => day.dayNumber)).toEqual([1])
    expect(groups[0].items.map((item) => item.id)).toEqual(['day-one', 'day-one-extra'])
    expect(groups[1].itineraryDays.map((day) => day.dayNumber)).toEqual([3])
    expect(groups[2].itineraryDays).toEqual([])
    expect(groups[3].itineraryDays).toEqual([])
  })

  it('没有准备事项时返回空分组', () => {
    expect(groupPreparationItemsByDate([], [itineraryDay(1, '2026-10-20', '行程日')])).toEqual([])
  })

  it('提案分别保存适用行程日和完成截止日', async () => {
    const result = await preparationProposalTool.execute({ items: [{
      title: '预约故宫门票', category: 'booking', detail: '在开放预约时及时购票。',
      itinerary_date: '2026-10-20', due_date: '2026-10-10', evidence_level: 'pending', source_ids: []
    }] }, { amapKey: null, researchCompleted: true, sourceIds: [] })

    expect(result.preparationOptions?.[0]).toMatchObject({
      itineraryDate: '2026-10-20', dueDate: '2026-10-10'
    })
  })

  it('模型省略证据等级时按待核验保存，不丢弃整份准备清单', async () => {
    const result = await preparationProposalTool.execute({ items: [{
      title: '整理随身行李', category: 'packing', packing_section: 'unclassified', detail: '电脑和相机放入背包。',
      source_ids: []
    }] }, { amapKey: null, researchCompleted: true, sourceIds: [] })

    expect(result.preparationOptions?.[0]).toMatchObject({ category: 'packing', evidenceLevel: 'pending', itineraryDate: '', dueDate: '' })
  })

  it('没有来源时允许省略 source_ids，并按待核验保存', async () => {
    const result = await preparationProposalTool.execute({ items: [{
      title: '出发前核对交通', category: 'transport', detail: '当天复核公共交通首末班和进站时间。',
      itinerary_date: '', due_date: ''
    }] }, { amapKey: null, researchCompleted: true, sourceIds: [] })

    expect(result.preparationOptions?.[0]).toMatchObject({ category: 'transport', evidenceLevel: 'pending', sourceIds: [] })
  })

  it('模型缺少来源时将 sourced 降级为待核验，并拒绝错误的来源字段类型', async () => {
    const base = {
      title: '预约景点门票', category: 'booking', detail: '按官方渠道核对预约规则。', itinerary_date: '', due_date: ''
    }

    const result = await preparationProposalTool.execute({ items: [{ ...base, evidence_level: 'sourced' }] }, {
      amapKey: null, researchCompleted: true, sourceIds: []
    })
    expect(result.preparationOptions?.[0]).toMatchObject({ evidenceLevel: 'pending', sourceIds: [] })
    expect(result.feedback).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'preparation_evidence_downgraded' }))
    await expect(preparationProposalTool.execute({ items: [{ ...base, source_ids: null }] }, {
      amapKey: null, researchCompleted: true, sourceIds: []
    })).rejects.toThrow(/来源 ID 必须是最多 5 项的字符串列表/u)
  })

  it('搜索摘要不能支撑精确行李重量和尺寸，且不会保留为依据链接', async () => {
    const snippet = createSource('旅客行李规则', 'https://example.com/baggage', '网页搜索', 'web',
      '搜索摘要：随身行李规则以承运人客票为准。')
    const result = await preparationProposalTool.execute({ items: [{
      title: '随身行李限额 5kg、20×40×55厘米', category: 'transport',
      detail: '随身行李限重 5kg，尺寸为 20×40×55厘米。', itinerary_date: '', due_date: '',
      evidence_level: 'sourced', source_ids: [snippet.id]
    }] }, {
      amapKey: null, researchCompleted: true, sourceIds: [snippet.id], availableSources: [snippet]
    })

    expect(result.preparationOptions?.[0]).toMatchObject({ evidenceLevel: 'pending', sourceIds: [] })
    expect(result.feedback).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'preparation_evidence_downgraded' }))
  })

  it('用户明确要求未核实前不写具体限额时，删除搜索摘要中的电池数值', async () => {
    const snippet = createSource('充电宝规则摘要', 'https://example.com/power-bank', '网页搜索', 'web',
      '额定能量不超过 100Wh 时可随身携带。')
    const result = await preparationProposalTool.execute({ items: [{
      title: '充电宝额定能量不超过 100Wh', category: 'packing', packing_section: 'carry-on',
      detail: '未核实航司锂电池规则前，充电宝额定能量不超过 100Wh。',
      itinerary_date: '', due_date: '', evidence_level: 'sourced', source_ids: [snippet.id]
    }, {
      title: '充电宝（规则待核验）', category: 'packing', packing_section: 'unclassified',
      detail: '具体 mAh/Wh 数值待按现行规定核对。', itinerary_date: '', due_date: '',
      evidence_level: 'pending', source_ids: []
    }] }, {
      amapKey: null, researchCompleted: true, sourceIds: [snippet.id], availableSources: [snippet],
      userRequest: '未核实航司随身尺寸、锂电池规则前不要写具体限额。'
    })

    const item = result.preparationOptions?.[0]
    expect(item).toMatchObject({
      title: '充电宝（规则待核验）', evidenceLevel: 'pending', sourceIds: []
    })
    expect(result.preparationOptions).toHaveLength(1)
    expect(`${item?.title} ${item?.detail}`).not.toContain('100Wh')
  })

  it('网页正文逐字包含具体行李数值时才允许标为有来源', async () => {
    const page = createSource('承运人行李规则', 'https://example.com/baggage', '承运人', 'web',
      '随身行李每人限重 5kg，单件尺寸不超过 20×40×55厘米。')
    page.contentLevel = 'page'
    const result = await preparationProposalTool.execute({ items: [{
      title: '随身行李限额 5kg、20×40×55厘米', category: 'transport',
      detail: '随身行李每人限重 5kg，单件尺寸不超过 20×40×55厘米。',
      itinerary_date: '', due_date: '', evidence_level: 'sourced', source_ids: [page.id]
    }] }, {
      amapKey: null, researchCompleted: true, sourceIds: [page.id], availableSources: [page]
    })

    expect(result.preparationOptions?.[0]).toMatchObject({ evidenceLevel: 'sourced', sourceIds: [page.id] })
  })

  it('正文来源与具体数值不一致时降级并移除不支持的引用', async () => {
    const page = createSource('承运人行李规则', 'https://example.com/baggage', '承运人', 'web',
      '随身行李每人限重 5kg，单件尺寸不超过 20×40×55厘米。')
    page.contentLevel = 'page'
    const result = await preparationProposalTool.execute({ items: [{
      title: '随身行李限重 8kg', category: 'transport', detail: '随身行李限重 8kg。',
      itinerary_date: '', due_date: '', evidence_level: 'sourced', source_ids: [page.id]
    }] }, {
      amapKey: null, researchCompleted: true, sourceIds: [page.id], availableSources: [page]
    })

    expect(result.preparationOptions?.[0]).toMatchObject({ evidenceLevel: 'pending', sourceIds: [] })
  })

  it('用户提供的托运行李额度保留原意，不伪装为随身限额或网页核验', async () => {
    const page = createSource('通用行李规则', 'https://example.com/baggage', '网页正文', 'web',
      '随身行李重量和尺寸应以实际客票为准。')
    page.contentLevel = 'page'
    const brief = { luggage: '托运行李 20kg；背包带电脑和相机' } as TripBrief
    const result = await preparationProposalTool.execute({ items: [{
      title: '核对客票托运行李额并确认 20kg 托运额（用户提供）', category: 'transport',
      detail: '已确认额度：托运行李 20kg（用户提供）。注意这是随身限额，请对照您实际客票的免费托运行李额。',
      itinerary_date: '', due_date: '', evidence_level: 'sourced', source_ids: [page.id]
    }, {
      title: '清点托运行李 20kg 额度', category: 'packing', packing_section: 'unclassified',
      detail: '托运行李 20kg，用户已提供。', itinerary_date: '', due_date: '', evidence_level: 'pending', source_ids: []
    }] }, {
      amapKey: null, researchCompleted: true, sourceIds: [page.id], availableSources: [page], tripBrief: brief
    })

    expect(result.preparationOptions?.[0]).toMatchObject({
      title: '托运行李额度（用户提供）',
      detail: '用户提供的行李信息：托运行李 20kg；背包带电脑和相机。该信息未与实际客票核对；随身行李、备用电池和托运规则需分别确认。',
      evidenceLevel: 'pending', sourceIds: []
    })
    expect(result.preparationOptions?.filter((item) => item.title === '托运行李额度（用户提供）')).toHaveLength(1)
  })

  it('模型漏掉用户行李信息时由本机校验补回，不要求模型编造分类或航司规则', async () => {
    const brief = { luggage: '托运行李 20kg；背包带电脑和相机' } as TripBrief
    const result = await preparationProposalTool.execute({ items: [{
      title: '核对随身行李规则', category: 'transport', detail: '随身行李和电池要求待核验。',
      itinerary_date: '', due_date: '', evidence_level: 'pending', source_ids: []
    }] }, { amapKey: null, researchCompleted: true, sourceIds: [], tripBrief: brief })

    expect(result.preparationOptions).toContainEqual(expect.objectContaining({
      title: '行李信息（用户提供）', category: 'other',
      detail: '用户提供的行李信息：托运行李 20kg；背包带电脑和相机。该信息未与实际客票核对；随身行李、备用电池和托运规则需分别确认。',
      evidenceLevel: 'pending', sourceIds: []
    }))
    expect(result.preparationOptions?.every(isPreparationItem)).toBe(true)
  })

  it('用户明确要求的准备类别必须逐类出现', async () => {
    const context = {
      amapKey: null, researchCompleted: true, sourceIds: [],
      requiredPreparationCategories: ['packing', 'alternative'] as Array<'packing' | 'alternative'>
    }
    const packing = {
      title: '整理随身行李', category: 'packing', packing_section: 'personal-item',
      detail: '电脑和相机放进背包。', itinerary_date: '', due_date: '', source_ids: []
    }
    const alternative = {
      title: '雨天缩短路线', category: 'alternative',
      detail: '下雨时缩短室外停留并优先保留已预约场馆。', itinerary_date: '2026-10-20', due_date: '', source_ids: []
    }

    const incomplete = await preparationProposalTool.execute({ items: [packing] }, context)
    expect(incomplete.preparationOptions?.map((item) => item.category)).toEqual(['packing'])
    expect(incomplete.feedback).toContainEqual(expect.objectContaining({
      severity: 'warning', code: 'preparation_categories_missing'
    }))

    const result = await preparationProposalTool.execute({ items: [packing, alternative] }, context)
    expect(result.preparationOptions?.map((item) => item.category)).toEqual(['packing', 'alternative'])
  })

  it('公共交通准备可以在没有路线来源时以待核验事项提交', async () => {
    const context = {
      amapKey: null, researchCompleted: true, sourceIds: [],
      requiredPreparationCategories: ['transport'] as Array<'transport'>
    }
    const transport = {
      title: '出发前核对公共交通', category: 'transport',
      detail: '按出行当日复核地铁/公交运营时间、换乘和进站缓冲；本计划没有路线服务数据。',
      itinerary_date: '', due_date: '', evidence_level: 'pending', source_ids: []
    }
    const packing = {
      title: '整理行李', category: 'packing', packing_section: 'unclassified',
      detail: '按用户提供的行李限制收纳。', itinerary_date: '', due_date: '', source_ids: []
    }

    const incomplete = await preparationProposalTool.execute({ items: [packing] }, context)
    expect(incomplete.preparationOptions?.[0]?.category).toBe('packing')
    expect(incomplete.feedback).toContainEqual(expect.objectContaining({
      severity: 'warning', code: 'preparation_categories_missing', message: expect.stringContaining('交通')
    }))
    const result = await preparationProposalTool.execute({ items: [transport] }, context)
    expect(result.preparationOptions?.[0]).toMatchObject({
      category: 'transport', evidenceLevel: 'pending', sourceIds: [], itineraryDate: ''
    })
  })

  it('有确认行程时逐日穿搭必须关联真实行程日期', async () => {
    const context = { amapKey: null, researchCompleted: true, sourceIds: [], itinerary: itineraryWithStop() }
    await expect(preparationProposalTool.execute(clothingSuggestion('', 'pending'), context))
      .rejects.toMatchObject({ severity: 'warning', code: 'clothing_date_unmatched' })
    await expect(preparationProposalTool.execute(clothingSuggestion('2026-10-21', 'pending'), context))
      .rejects.toMatchObject({ severity: 'warning', code: 'clothing_date_unmatched' })

    const result = await preparationProposalTool.execute(clothingSuggestion('2026-10-20', 'pending'), context)
    expect(result.preparationOptions?.[0]).toMatchObject({ category: 'clothing', itineraryDate: '2026-10-20', evidenceLevel: 'pending' })
  })

  it('逐日穿搭没有匹配日期的天气来源时降级为待核验', async () => {
    const dailyForecast = '北京；逐日天气预报如下。\n2026-10-20：多云，12–20°C，降水概率 10%，最大风速 12 km/h'
    const weatherSource = createSource('逐日天气：北京', 'https://open-meteo.com/en/docs', 'Open-Meteo', 'weather', dailyForecast)
    const context = {
      amapKey: null, researchCompleted: true, sourceIds: [weatherSource.id], availableSources: [weatherSource], itinerary: itineraryWithStop()
    }
    const result = await preparationProposalTool.execute(clothingSuggestion('2026-10-20', 'sourced', [weatherSource.id]), context)
    expect(result.preparationOptions?.[0].sourceIds).toEqual([weatherSource.id])

    const webSource = createSource('北京天气网页', 'https://example.com/weather', '网页', 'web', dailyForecast)
    const unsupportedKind = await preparationProposalTool.execute(clothingSuggestion('2026-10-20', 'sourced', [webSource.id]), {
      ...context, sourceIds: [webSource.id], availableSources: [webSource]
    })
    expect(unsupportedKind.preparationOptions?.[0]).toMatchObject({ evidenceLevel: 'pending', sourceIds: [] })

    const otherDaySource = createSource('逐日天气：北京', 'https://open-meteo.com/en/docs', 'Open-Meteo', 'weather',
      '北京；逐日天气预报如下。\n2026-10-21：晴，12–20°C，降水概率 0%，最大风速 8 km/h')
    const wrongDate = await preparationProposalTool.execute(clothingSuggestion('2026-10-20', 'sourced', [otherDaySource.id]), {
      ...context, sourceIds: [otherDaySource.id], availableSources: [otherDaySource]
    })
    expect(wrongDate.preparationOptions?.[0]).toMatchObject({ evidenceLevel: 'pending', sourceIds: [] })
    expect(wrongDate.feedback).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'preparation_evidence_downgraded' }))
  })

  it('天气来源部分成功但包含对应行程日时仍可支持该日穿搭', async () => {
    const weatherSource = createSource('逐日天气：北京', 'https://open-meteo.com/en/docs', 'Open-Meteo', 'weather',
      '北京；预报范围有限。\n2026-10-20：多云，12–20°C，降水概率 10%，最大风速 12 km/h', 'partial')
    const result = await preparationProposalTool.execute(clothingSuggestion('2026-10-20', 'sourced', [weatherSource.id]), {
      amapKey: null, researchCompleted: true, sourceIds: [weatherSource.id], availableSources: [weatherSource], itinerary: itineraryWithStop()
    })

    expect(result.preparationOptions?.[0].evidenceLevel).toBe('sourced')
  })

  it('将餐饮建议绑定到真实行程停靠点并自动保存地点快照', async () => {
    const placeSource = createSource('川味小馆', 'https://ditu.amap.com/search?query=川味小馆', '高德地图', 'place', '人民公园附近。')
    const result = await preparationProposalTool.execute(foodSuggestion('2026-10-20', {
      stop_id: 'stop-1', place_source_id: placeSource.id
    }, [placeSource.id]), {
      amapKey: null, researchCompleted: true, sourceIds: [placeSource.id], availableSources: [placeSource], itinerary: itineraryWithStop()
    })

    expect(result.preparationOptions?.[0].locationContext).toMatchObject({
      dayNumber: 1, dayTitle: '市中心', stopId: 'stop-1', stopName: '人民公园', area: '青羊区',
      placeSourceId: placeSource.id, placeName: '川味小馆'
    })
    await expect(preparationProposalTool.execute(foodSuggestion('2026-10-20', {
      stop_id: 'stop-1', place_source_id: placeSource.id
    }, [placeSource.id], '川味饭馆'), {
      amapKey: null, researchCompleted: true, sourceIds: [placeSource.id], availableSources: [placeSource], itinerary: itineraryWithStop()
    })).rejects.toMatchObject({ severity: 'warning', code: 'preparation_place_unverified' })
  })

  it('要求日期与停靠点行程日一致，且路线指标必须引用成功路线来源', async () => {
    const placeSource = createSource('川味小馆', 'https://ditu.amap.com/search?query=川味小馆', '高德地图', 'place', '人民公园附近。')
    const routeSource = createSource('人民公园 → 川味小馆', 'https://ditu.amap.com/search?query=route', '高德路线规划', 'route', '方案 1：约 8 分钟 · 500 m')
    const context = {
      amapKey: null, researchCompleted: true,
      sourceIds: [placeSource.id, routeSource.id], availableSources: [placeSource, routeSource], itinerary: itineraryWithStop()
    }
    await expect(preparationProposalTool.execute(foodSuggestion('2026-10-21', {
      stop_id: 'stop-1', place_source_id: placeSource.id
    }, [placeSource.id]), context))
      .rejects.toMatchObject({ severity: 'warning', code: 'preparation_location_date_mismatch' })
    await expect(preparationProposalTool.execute(foodSuggestion('2026-10-20', {
      stop_id: 'stop-1', place_source_id: placeSource.id, route_option_number: 1,
      distance_meters: 500, duration_minutes: 8, route_source_id: routeSource.id
    }, [placeSource.id]), context)).rejects.toMatchObject({ severity: 'warning', code: 'preparation_route_unverified' })
    const result = await preparationProposalTool.execute(foodSuggestion('2026-10-20', {
      stop_id: 'stop-1', place_source_id: placeSource.id, route_option_number: 1,
      distance_meters: 500, duration_minutes: 8, route_source_id: routeSource.id
    }, [placeSource.id, routeSource.id]), context)

    expect(result.preparationOptions?.[0].locationContext).toMatchObject({
      routeOptionNumber: 1, distanceMeters: 500, durationMinutes: 8, routeSourceId: routeSource.id
    })
    await expect(preparationProposalTool.execute(foodSuggestion('2026-10-20', {
      stop_id: 'stop-1', place_source_id: placeSource.id, route_option_number: 1,
      distance_meters: 501, duration_minutes: 8, route_source_id: routeSource.id
    }, [placeSource.id, routeSource.id]), context)).rejects.toThrow(/成功路线来源/)

    const unrelatedRoute = createSource('人民公园 → 博物馆', 'https://ditu.amap.com/search?query=route', '高德路线规划', 'route', '方案 1：约 8 分钟 · 500 m')
    await expect(preparationProposalTool.execute(foodSuggestion('2026-10-20', {
      stop_id: 'stop-1', place_source_id: placeSource.id, route_option_number: 1,
      distance_meters: 500, duration_minutes: 8, route_source_id: unrelatedRoute.id
    }, [placeSource.id, unrelatedRoute.id]), {
      ...context, sourceIds: [placeSource.id, unrelatedRoute.id], availableSources: [placeSource, unrelatedRoute]
    })).rejects.toThrow(/成功路线来源/)
  })

  it('地图候选缺失时仍接受待核验餐饮建议，不强制绑定停靠点', async () => {
    const result = await preparationProposalTool.execute(
      foodSuggestion('2026-10-20', undefined, [], '人民公园附近川菜', 'pending'),
      { amapKey: null, researchCompleted: false, sourceIds: [], itinerary: itineraryWithStop() }
    )

    expect(result.preparationOptions?.[0]).toMatchObject({
      title: '人民公园附近川菜', evidenceLevel: 'pending', sourceIds: []
    })
    expect(result.preparationOptions?.[0].locationContext).toBeUndefined()
  })

  it('只有行程草案时丢弃无法确认的地点关联并保留餐饮建议', async () => {
    const placeSource = createSource('川味小馆', 'https://ditu.amap.com/search?query=川味小馆', '高德地图', 'place', '人民公园附近。')
    const result = await preparationProposalTool.execute(foodSuggestion('2026-10-20', {
      stop_id: 'draft-stop-1', place_source_id: placeSource.id
    }, [placeSource.id]), {
      amapKey: null, researchCompleted: true,
      sourceIds: [placeSource.id], availableSources: [placeSource]
    })

    expect(result.preparationOptions?.[0]).toMatchObject({
      title: '川味小馆', evidenceLevel: 'sourced', sourceIds: [placeSource.id]
    })
    expect(result.preparationOptions?.[0]?.locationContext).toBeUndefined()
    expect(result.feedback).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'preparation_locations_unbound' }))
  })

  it('拒绝没有成功地图来源的地点候选', async () => {
    const placeSource = createSource('川味小馆', 'https://ditu.amap.com/search?query=川味小馆', '高德地图', 'place', '人民公园附近。', 'partial')
    await expect(preparationProposalTool.execute(foodSuggestion('2026-10-20', {
      stop_id: 'stop-1', place_source_id: placeSource.id
    }, [placeSource.id]), {
      amapKey: null, researchCompleted: true, sourceIds: [placeSource.id], availableSources: [placeSource], itinerary: itineraryWithStop()
    })).rejects.toMatchObject({ severity: 'warning', code: 'preparation_place_unverified' })
  })
})
