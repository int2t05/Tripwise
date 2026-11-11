/** 用本机已保存模型验证地点、餐休、接驳和跨日移动的细粒度修改。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { TravelAgent } from '../src/main/agent.js'
import { createUserProvidedSource } from '../src/main/connectors/user-import.js'
import { TripStore } from '../src/main/persistence.js'
import { DEFAULT_SETTINGS } from '../src/main/persistence/schema.js'
import { SecretVault } from '../src/main/secrets.js'
import { configureSystemLogger, flushSystemLogs } from '../src/main/system-logger.js'
import type { ItineraryDay, ItineraryOption, ItineraryScheduleBlock, ItineraryStop, TripBrief } from '../src/shared/types.js'
import { defaultTripwiseUserDataDirectory, readTripwiseProfile } from './helpers/manual-profile.js'

const enabled = process.env.TRIPWISE_GRANULARITY_LIVE_EVAL === '1'
const transferEnabled = process.env.TRIPWISE_TRANSFER_LIVE_EVAL === '1'
const crossDayEnabled = process.env.TRIPWISE_CROSS_DAY_LIVE_EVAL === '1'
const scheduleMultiFieldEnabled = process.env.TRIPWISE_SCHEDULE_MULTI_FIELD_LIVE_EVAL === '1'
const userDataDirectory = resolve(process.env.TRIPWISE_USER_DATA_DIR?.trim() || defaultTripwiseUserDataDirectory())

/** 只读取必要的模型设置；凭证由 SecretVault 单独访问。 */
function savedModelSettings(profile: unknown): typeof DEFAULT_SETTINGS.model {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('missing_saved_model_settings')
  const settings = (profile as { settings?: unknown }).settings
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('missing_saved_model_settings')
  const model = (settings as { model?: unknown }).model
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error('missing_saved_model_settings')
  const candidate = model as { baseUrl?: unknown; model?: unknown; temperature?: unknown; maxTokens?: unknown }
  let secureBaseUrl = false
  try {
    secureBaseUrl = typeof candidate.baseUrl === 'string' && new URL(candidate.baseUrl).protocol === 'https:'
  } catch {
    secureBaseUrl = false
  }
  if (!secureBaseUrl || typeof candidate.model !== 'string' || !candidate.model.trim()) {
    throw new Error('invalid_saved_model_settings')
  }
  return candidate as typeof DEFAULT_SETTINGS.model
}

/** 创建用户北京行程中的结构化地点；事实仍待单独核验。 */
function evaluationStop(
  id: string, name: string, area: string, time: string, durationMinutes: number, category = '景点'
): ItineraryStop {
  return {
    id, name, area, time, durationMinutes, category,
    notes: '来自用户提供的行程基线；开放、预约和交通事实待核验。', transitToNext: ''
  }
}

/** 创建评测基线中的独立餐休块。 */
function evaluationMeal(id: string, time: string, area: string, durationMinutes = 45): ItineraryScheduleBlock {
  return { id, kind: 'meal', title: '午餐', time, durationMinutes, area, notes: '用户计划基线。' }
}

/** 创建评测中不应被其他细改牵连的独立休息块。 */
function evaluationRest(id: string, time: string, area: string): ItineraryScheduleBlock {
  return { id, kind: 'rest', title: '午间休息', time, durationMinutes: 15, area, notes: '用户计划基线。' }
}

/** 创建覆盖用户 9/21–9/27 北京行程的七日临时基线；第二天包含本轮修改目标。 */
function seedPlan(): ItineraryOption {
  const tsinghua = evaluationStop('granularity-tsinghua', '清华大学', '清华园', '09:00–11:00', 120, '人文景点')
  tsinghua.transitToNext = '优先公共交通；具体线路和耗时待核验。'
  const days: ItineraryDay[] = [
    {
      id: 'granularity-day-1', dayNumber: 1, date: '2026-09-21', title: '抵达北京', scheduleBlocks: [],
      stops: [
        evaluationStop('granularity-daxing', '北京大兴国际机场', '大兴区', '19:30–20:00', 45, '交通枢纽'),
        evaluationStop('granularity-hotel', '北京西站附近酒店', '西城区', '21:00–21:15', 15, '住宿')
      ]
    },
    {
      id: 'granularity-day-2', dayNumber: 2, date: '2026-09-22', title: '海淀校园与园林',
      stops: [
        tsinghua,
        evaluationStop('granularity-peking', '北京大学', '海淀区', '12:00–13:00', 60, '人文景点'),
        evaluationStop('granularity-yuanmingyuan', '圆明园', '海淀区', '14:00–16:00', 120, '人文景点')
      ],
      scheduleBlocks: [
        evaluationMeal('granularity-day-2-lunch', '13:00–13:45', '五道口/成府路'),
        evaluationRest('granularity-day-2-rest', '13:45–14:00', '海淀区')
      ]
    },
    {
      id: 'granularity-day-3', dayNumber: 3, date: '2026-09-23', title: '颐和园与香山', scheduleBlocks: [],
      stops: [
        evaluationStop('granularity-summer-palace', '颐和园', '海淀区', '08:00–12:15', 255),
        evaluationStop('granularity-xiangshan', '香山公园', '海淀区', '14:15–16:15', 120),
        evaluationStop('granularity-biyunsi', '碧云寺', '海淀区', '16:15–17:15', 60)
      ]
    },
    {
      id: 'granularity-day-4', dayNumber: 4, date: '2026-09-24', title: '天坛、国博与前门',
      stops: [
        evaluationStop('granularity-temple-heaven', '天坛公园', '东城区', '08:00–11:15', 195),
        evaluationStop('granularity-national-museum', '中国国家博物馆', '东城区', '13:30–16:30', 180, '博物馆'),
        evaluationStop('granularity-qianmen', '前门大街', '东城区', '17:00–20:00', 180, '街区')
      ],
      scheduleBlocks: [evaluationMeal('granularity-day-4-lunch', '11:15–12:00', '天坛附近')]
    },
    {
      id: 'granularity-day-5', dayNumber: 5, date: '2026-09-25', title: '八达岭与奥体',
      stops: [
        evaluationStop('granularity-badaling', '八达岭长城', '延庆区', '08:30–13:00', 270),
        evaluationStop('granularity-bird-nest', '国家体育场（鸟巢）', '朝阳区', '16:30–19:30', 165),
        evaluationStop('granularity-water-cube', '国家游泳中心（水立方）', '朝阳区', '19:30–19:45', 30)
      ],
      scheduleBlocks: [evaluationMeal('granularity-day-5-lunch', '13:00–13:45', '八达岭景区/车站')]
    },
    {
      id: 'granularity-day-6', dayNumber: 6, date: '2026-09-26', title: '故宫中轴与什刹海',
      stops: [
        evaluationStop('granularity-tiananmen', '天安门广场', '东城区', '07:00–08:00', 60),
        evaluationStop('granularity-palace', '故宫博物院', '东城区', '08:30–13:30', 300, '博物馆'),
        evaluationStop('granularity-jingshan', '景山公园', '西城区', '14:00–14:45', 45),
        evaluationStop('granularity-beihai', '北海公园', '西城区', '15:15–16:45', 90),
        evaluationStop('granularity-shichahai', '什刹海', '西城区', '17:15–19:30', 135)
      ],
      scheduleBlocks: [evaluationMeal('granularity-day-6-lunch', '13:30–14:00', '故宫/景山附近', 30)]
    },
    {
      id: 'granularity-day-7', dayNumber: 7, date: '2026-09-27', title: '雍和宫与返程',
      stops: [
        evaluationStop('granularity-yonghe', '雍和宫', '东城区', '09:00–10:30', 90),
        evaluationStop('granularity-confucius', '孔庙和国子监博物馆', '东城区', '10:45–12:45', 120, '博物馆'),
        evaluationStop('granularity-wudaoying', '五道营胡同', '东城区', '13:45–15:15', 90, '街区'),
        evaluationStop('granularity-west-station', '北京西站', '丰台区', '18:30–20:00', 113, '交通枢纽')
      ],
      scheduleBlocks: [evaluationMeal('granularity-day-7-lunch', '12:45–13:30', '孔庙/五道营附近')]
    }
  ]
  return {
    id: 'granularity-baseline', title: '北京 9/21–9/27 行程字段修改评测',
    summary: '以用户提供的逐日计划为基线，核对单地点和餐休安排的细粒度修改。',
    tradeoffs: '本评测不核实开放、预约、天气或交通事实；这些内容应保持待核验。', days
  }
}

/** 忽略运行时生成的日程 ID，比较用户可见的当天安排。 */
function daySignature(day: ItineraryDay): string {
  return JSON.stringify({
    title: day.title,
    stops: day.stops.map(({ name, area, time, durationMinutes, category, notes, transitToNext }) =>
      ({ name, area, time, durationMinutes, category, notes, transitToNext })),
    blocks: day.scheduleBlocks.map(({ kind, title, time, durationMinutes, area, notes }) =>
      ({ kind, title, time, durationMinutes, area, notes })),
    weather: day.weather,
    lodgingCommutes: day.lodgingCommutes
  })
}

/** 统计候选计划中未指定日期的增删改，日期缺失也计为变化。 */
function nonTargetChangedDayCount(baseline: ItineraryOption, candidate: ItineraryOption, targetDate: string): number {
  const baselineByDate = new Map(baseline.days.map((day) => [day.date, day]))
  const candidateByDate = new Map(candidate.days.map((day) => [day.date, day]))
  const dates = new Set([...baselineByDate.keys(), ...candidateByDate.keys()])
  return [...dates].filter((date) => {
    if (date === targetDate) return false
    const original = baselineByDate.get(date)
    const revised = candidateByDate.get(date)
    return !original || !revised || daySignature(original) !== daySignature(revised)
  }).length
}

/** 返回当天餐休安排的可见字段，用于确认单地点修改没有牵连餐次。 */
function scheduleBlockCoreSignature(day: ItineraryDay | undefined): string {
  return JSON.stringify(day?.scheduleBlocks.map(({ kind, title, time, durationMinutes, area }) =>
    ({ kind, title, time, durationMinutes, area })) ?? [])
}

/** 只返回变化字段名，诊断餐休块偏移时不输出计划内容。 */
function scheduleBlockChangedFields(before: ItineraryDay | undefined, after: ItineraryDay | undefined): string[] {
  const previous = before?.scheduleBlocks ?? []
  const proposed = after?.scheduleBlocks ?? []
  const changed = new Set<string>()
  if (previous.length !== proposed.length) changed.add('count')
  const fields = [
    ['kind', (left: ItineraryScheduleBlock, right: ItineraryScheduleBlock) => left.kind !== right.kind],
    ['title', (left: ItineraryScheduleBlock, right: ItineraryScheduleBlock) => left.title !== right.title],
    ['time', (left: ItineraryScheduleBlock, right: ItineraryScheduleBlock) => left.time !== right.time],
    ['duration', (left: ItineraryScheduleBlock, right: ItineraryScheduleBlock) => left.durationMinutes !== right.durationMinutes],
    ['area', (left: ItineraryScheduleBlock, right: ItineraryScheduleBlock) => left.area !== right.area],
    ['notes', (left: ItineraryScheduleBlock, right: ItineraryScheduleBlock) => left.notes !== right.notes]
  ] as const
  for (let index = 0; index < Math.min(previous.length, proposed.length); index += 1) {
    for (const [field, differs] of fields) {
      if (differs(previous[index]!, proposed[index]!)) changed.add(field)
    }
  }
  return [...changed].sort()
}

/** 只比较地点可见字段，诊断单接驳编辑是否误改地点内容。 */
function stopChangedFields(before: ItineraryStop | undefined, after: ItineraryStop | undefined): string[] {
  if (!before || !after) return ['count']
  const changed = new Set<string>()
  const fields = ['name', 'area', 'time', 'durationMinutes', 'category', 'notes', 'transitToNext'] as const
  for (const field of fields) if (before[field] !== after[field]) changed.add(field)
  return [...changed].sort()
}

/** 忽略模型可能重建的 ID，比较当天地点的用户可见安排。 */
function stopSignature(day: ItineraryDay | undefined): string {
  return JSON.stringify(day?.stops.map(({ name, area, time, durationMinutes, category, notes, transitToNext }) =>
    ({ name, area, time, durationMinutes, category, notes, transitToNext })) ?? [])
}

/** 真实验证多轮细粒度修订范围；临时旅行、模型日志和草案在结束后删除。 */
it.skipIf(!enabled)('真实模型逐项修改地点、餐休和接驳字段', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tripwise-granularity-live-'))
  const store = new TripStore(temporaryDirectory)
  const vault = new SecretVault(userDataDirectory)
  const baseline = seedPlan()

  try {
    await store.initialize()
    configureSystemLogger(temporaryDirectory)
    await vault.initialize()
    if (!(await vault.get('modelKey'))) throw new Error('missing_saved_model_credential')
    const model = savedModelSettings(await readTripwiseProfile(userDataDirectory))
    await store.updateSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      model,
      connectors: { webSearch: false, weather: false, places: false, routes: false },
      xiaohongshu: { enabled: false, command: '', args: [] },
      mcpServers: []
    })

    const brief: TripBrief = {
      departureCity: '深圳', destination: '北京', startDate: '2026-09-21', endDate: '2026-09-27',
      arrivalFlight: '晚间航班从深圳抵达北京大兴', arrivalTime: '19:30',
      leaveTime: '9/27 北京西站 20:00 发车，次日 18:20 到深圳', travelers: '1', budget: '中等',
      lodgingLocation: '北京西站附近酒店', lodging: '全程住北京西站附近酒店',
      pace: '中等', earlyStart: '可以早起', interests: '清北、圆明园、北京标志景点、美食、自然和红叶',
      transport: '尽量公共交通', dietary: '', luggage: '', clothing: '昼夜温差大，现有短袖和冲锋衣',
      constraints: '本评测使用合成的北京七日计划结构，只核对指定修改和修改范围，不检索外部资料。开放、预约、天气和交通事实仍待核验。'
    }
    await store.createTrip(brief)
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('temporary_trip_creation_failed')
    const baselineSource = createUserProvidedSource({
      title: '字段修改评测基线说明',
      text: '本评测行程是用于验证字段修改范围的人工基线，不包含景点开放、预约、价格或交通事实。'
    })
    await store.saveSources(trip.id, [baselineSource])
    const baselineMessageId = randomUUID()
    await store.appendMessage(trip.id, {
      id: baselineMessageId, role: 'assistant', content: '临时评测基线。', createdAt: new Date().toISOString(),
      sourceIds: [baselineSource.id], itineraryOptions: [baseline]
    })
    await store.saveRevision(trip.id, baselineMessageId, baseline.id)
    const startingRevisionId = store.snapshot().trips[0]?.activeRevisionId
    const startingRevisionCount = store.snapshot().trips[0]?.revisions.length ?? 0

    const revise = async (label: string, prompt: string): Promise<{ plan: ItineraryOption; draftCount: number }> => {
      process.stderr.write(`[itinerary-edit-live] ${label} started\n`)
      let terminal = 'none'
      await new TravelAgent().run(
        store, vault, trip.id, prompt, randomUUID(), new AbortController().signal,
        (event) => {
          if (event.type === 'complete' || event.type === 'error') terminal = event.type
        }
      )
      await flushSystemLogs()
      const updatedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
      const latestOptions = updatedTrip?.messages
        .filter((message) => message.role === 'assistant' && message.itineraryOptions?.length)
        .at(-1)?.itineraryOptions
      if (terminal !== 'complete' || !latestOptions?.length) throw new Error(`${label}_revision_failed`)
      process.stderr.write(`[itinerary-edit-live] ${label} completed\n`)
      return { plan: latestOptions[0]!, draftCount: latestOptions.length }
    }

    const firstResult = await revise('single_stop_fields',
      '只修改 9/22 的清华大学：时段改为 09:30–11:00，建议停留 90 分钟，片区改为“海淀区”。其他地点、午餐安排和其他六天保持不变。开放、预约、天气及交通事实不做检索，继续标为待核验。请返回一份完整修订草案，不要保存。')
    const firstPlan = firstResult.plan
    const firstTarget = firstPlan.days.find((day) => day.date === '2026-09-22')
    const firstStop = firstTarget?.stops.find((stop) => stop.name.includes('清华大学'))
    const firstNonTargetChanges = nonTargetChangedDayCount(baseline, firstPlan, '2026-09-22')
    const firstBaselineDay = baseline.days.find((day) => day.date === '2026-09-22')
    const firstSummary = {
      singleDraft: firstResult.draftCount === 1,
      timeUpdated: firstStop?.time.includes('09:30') === true && firstStop?.time.includes('11:00') === true,
      durationUpdated: firstStop?.durationMinutes === 90,
      areaUpdated: firstStop?.area === '海淀区',
      targetMealScheduleUnchanged: scheduleBlockCoreSignature(firstTarget) === scheduleBlockCoreSignature(firstBaselineDay),
      changedMealFields: scheduleBlockChangedFields(firstBaselineDay, firstTarget),
      nonTargetChangedDayCount: firstNonTargetChanges
    }
    process.stdout.write(`[itinerary-edit-live] field edit ${JSON.stringify(firstSummary)}\n`)
    expect(firstPlan.days).toHaveLength(baseline.days.length)
    expect(firstSummary.singleDraft).toBe(true)
    expect(firstSummary.timeUpdated).toBe(true)
    expect(firstSummary.durationUpdated).toBe(true)
    expect(firstSummary.areaUpdated).toBe(true)
    expect(firstSummary.targetMealScheduleUnchanged).toBe(true)
    expect(firstSummary.nonTargetChangedDayCount).toBe(0)

    const secondResult = await revise('specified_stop_order',
      '只修改 9/22 的景点顺序为：北京大学、清华大学、圆明园。时段依次为 09:00–10:00、10:30–12:00、14:00–16:00。午餐时间、时长和片区保持原样；其他六天也完整保持原样。开放、预约、天气及交通事实不做检索，继续标为待核验。请返回一份完整修订草案，不要保存。')
    const secondPlan = secondResult.plan
    const secondTarget = secondPlan.days.find((day) => day.date === '2026-09-22')
    const secondTsinghua = secondTarget?.stops.find((stop) => stop.name.includes('清华大学'))
    const orderedNames = secondTarget?.stops.map((stop) => stop.name).filter((name) =>
      /北京大学|清华大学|圆明园/u.test(name)) ?? []
    const secondNonTargetChanges = nonTargetChangedDayCount(baseline, secondPlan, '2026-09-22')
    const secondBaselineDay = baseline.days.find((day) => day.date === '2026-09-22')
    const savedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const secondSummary = {
      singleDraft: secondResult.draftCount === 1,
      specifiedOrderApplied: orderedNames.join(',') === '北京大学,清华大学,圆明园',
      priorAreaPreserved: secondTsinghua?.area === '海淀区',
      priorDurationPreserved: secondTsinghua?.durationMinutes === 90,
      targetTimeUpdated: secondTsinghua?.time.includes('10:30') === true && secondTsinghua?.time.includes('12:00') === true,
      targetMealScheduleUnchanged: scheduleBlockCoreSignature(secondTarget) === scheduleBlockCoreSignature(secondBaselineDay),
      changedMealFields: scheduleBlockChangedFields(secondBaselineDay, secondTarget),
      nonTargetChangedDayCount: secondNonTargetChanges,
      activeRevisionUnchanged: savedTrip?.activeRevisionId === startingRevisionId,
      savedRevisionCountUnchanged: savedTrip?.revisions.length === startingRevisionCount
    }
    process.stdout.write(`[itinerary-edit-live] order edit ${JSON.stringify(secondSummary)}\n`)
    expect(secondSummary.singleDraft).toBe(true)
    expect(secondSummary.specifiedOrderApplied).toBe(true)
    expect(secondSummary.priorAreaPreserved).toBe(true)
    expect(secondSummary.priorDurationPreserved).toBe(true)
    expect(secondSummary.targetTimeUpdated).toBe(true)
    expect(secondSummary.targetMealScheduleUnchanged).toBe(true)
    expect(secondSummary.nonTargetChangedDayCount).toBe(0)
    expect(secondSummary.activeRevisionUnchanged).toBe(true)
    expect(secondSummary.savedRevisionCountUnchanged).toBe(true)

    const thirdResult = await revise('single_stop_rename',
      '只修改 9/22 的清华大学：把这项的名称改为“清华大学校园”，仍指同一处实际地点，不替换景点。保留它当前的时段、90 分钟时长和海淀区片区；北京大学、圆明园的顺序和安排以及午餐原样保持，其他六天也完整保持。开放、预约、天气及交通事实不做检索，继续标为待核验。请返回一份完整修订草案，不要保存。')
    const thirdPlan = thirdResult.plan
    const thirdTarget = thirdPlan.days.find((day) => day.date === '2026-09-22')
    const thirdTsinghua = thirdTarget?.stops.find((stop) => stop.name.includes('清华大学校园'))
    const thirdOtherNames = thirdTarget?.stops.filter((stop) => stop !== thirdTsinghua)
      .map((stop) => stop.name).filter((name) => /北京大学|圆明园/u.test(name)) ?? []
    const thirdNonTargetChanges = nonTargetChangedDayCount(baseline, thirdPlan, '2026-09-22')
    const thirdBaselineDay = baseline.days.find((day) => day.date === '2026-09-22')
    const savedAfterRename = store.snapshot().trips.find((item) => item.id === trip.id)
    const thirdSummary = {
      singleDraft: thirdResult.draftCount === 1,
      nameUpdated: !!thirdTsinghua,
      priorTimePreserved: thirdTsinghua?.time.includes('10:30') === true && thirdTsinghua.time.includes('12:00'),
      priorDurationPreserved: thirdTsinghua?.durationMinutes === 90,
      priorAreaPreserved: thirdTsinghua?.area === '海淀区',
      otherTargetStopsPreserved: thirdOtherNames.join(',') === '北京大学,圆明园',
      targetMealScheduleUnchanged: scheduleBlockCoreSignature(thirdTarget) === scheduleBlockCoreSignature(thirdBaselineDay),
      nonTargetChangedDayCount: thirdNonTargetChanges,
      activeRevisionUnchanged: savedAfterRename?.activeRevisionId === startingRevisionId,
      savedRevisionCountUnchanged: savedAfterRename?.revisions.length === startingRevisionCount
    }
    process.stdout.write(`[itinerary-edit-live] name edit ${JSON.stringify(thirdSummary)}\n`)
    expect(thirdSummary.singleDraft).toBe(true)
    expect(thirdSummary.nameUpdated).toBe(true)
    expect(thirdSummary.priorTimePreserved).toBe(true)
    expect(thirdSummary.priorDurationPreserved).toBe(true)
    expect(thirdSummary.priorAreaPreserved).toBe(true)
    expect(thirdSummary.otherTargetStopsPreserved).toBe(true)
    expect(thirdSummary.targetMealScheduleUnchanged).toBe(true)
    expect(thirdSummary.nonTargetChangedDayCount).toBe(0)
    expect(thirdSummary.activeRevisionUnchanged).toBe(true)
    expect(thirdSummary.savedRevisionCountUnchanged).toBe(true)

    const fourthResult = await revise('single_meal_time',
      '只调整 2026-09-22 的“午餐”时段的开始或结束时间，保留时长和类型，保留其他字段、当天其余安排和所有其他日期，时间改为：12:15–13:00。开放、预约、天气及交通事实不做检索，继续标为待核验。请返回一份完整修订草案，不要保存。')
    const fourthPlan = fourthResult.plan
    const fourthTarget = fourthPlan.days.find((day) => day.date === '2026-09-22')
    const fourthBaselineDay = thirdPlan.days.find((day) => day.date === '2026-09-22')
    const fourthLunch = fourthTarget?.scheduleBlocks.find((block) => block.title === '午餐')
    const fourthRest = fourthTarget?.scheduleBlocks.find((block) => block.title === '午间休息')
    const fourthBaselineLunch = fourthBaselineDay?.scheduleBlocks.find((block) => block.title === '午餐')
    const fourthBaselineRest = fourthBaselineDay?.scheduleBlocks.find((block) => block.title === '午间休息')
    const savedAfterMeal = store.snapshot().trips.find((item) => item.id === trip.id)
    const fourthSummary = {
      singleDraft: fourthResult.draftCount === 1,
      timeUpdated: fourthLunch?.time === '12:15–13:00',
      durationPreserved: fourthLunch?.durationMinutes === fourthBaselineLunch?.durationMinutes,
      onlyRequestedBlockFieldChanged: scheduleBlockChangedFields(fourthBaselineDay, fourthTarget).join(',') === 'time',
      otherBlockPreserved: JSON.stringify(fourthRest) === JSON.stringify(fourthBaselineRest),
      stopsUnchanged: stopSignature(fourthTarget) === stopSignature(fourthBaselineDay),
      nonTargetChangedDayCount: nonTargetChangedDayCount(thirdPlan, fourthPlan, '2026-09-22'),
      activeRevisionUnchanged: savedAfterMeal?.activeRevisionId === startingRevisionId,
      savedRevisionCountUnchanged: savedAfterMeal?.revisions.length === startingRevisionCount
    }
    process.stdout.write(`[itinerary-edit-live] meal edit ${JSON.stringify(fourthSummary)}\n`)
    expect(fourthSummary.singleDraft).toBe(true)
    expect(fourthSummary.timeUpdated).toBe(true)
    expect(fourthSummary.durationPreserved).toBe(true)
    expect(fourthSummary.onlyRequestedBlockFieldChanged).toBe(true)
    expect(fourthSummary.otherBlockPreserved).toBe(true)
    expect(fourthSummary.stopsUnchanged).toBe(true)
    expect(fourthSummary.nonTargetChangedDayCount).toBe(0)
    expect(fourthSummary.activeRevisionUnchanged).toBe(true)
    expect(fourthSummary.savedRevisionCountUnchanged).toBe(true)

    const fifthResult = await revise('single_transfer_mode',
      '只调整 2026-09-22 从“清华大学校园”到“北京大学”的接驳，保留停靠点、时段和其他日期，交通方式改为：步行。开放、预约、天气及交通事实不做检索，继续标为待核验。请返回一份完整修订草案，不要保存。')
    const fifthPlan = fifthResult.plan
    const fifthTarget = fifthPlan.days.find((day) => day.date === '2026-09-22')
    const fifthBaselineDay = fourthPlan.days.find((day) => day.date === '2026-09-22')
    const fifthTsinghua = fifthTarget?.stops.find((stop) => stop.name.includes('清华大学校园'))
    const fifthBaselineTsinghua = fifthBaselineDay?.stops.find((stop) => stop.name.includes('清华大学校园'))
    const fifthOtherStopsUnchanged = JSON.stringify(fifthTarget?.stops
      .filter((stop) => stop.id !== fifthTsinghua?.id)
      .map(({ name, area, time, durationMinutes, category, notes, transitToNext }) =>
        ({ name, area, time, durationMinutes, category, notes, transitToNext }))) === JSON.stringify(fifthBaselineDay?.stops
      .filter((stop) => stop.id !== fifthBaselineTsinghua?.id)
      .map(({ name, area, time, durationMinutes, category, notes, transitToNext }) =>
        ({ name, area, time, durationMinutes, category, notes, transitToNext })))
    const savedAfterTransfer = store.snapshot().trips.find((item) => item.id === trip.id)
    const fifthSummary = {
      singleDraft: fifthResult.draftCount === 1,
      transferUpdated: fifthTsinghua?.transitToNext === '步行',
      onlyTransferFieldChanged: stopChangedFields(fifthBaselineTsinghua, fifthTsinghua).join(',') === 'transitToNext',
      otherTargetStopsUnchanged: fifthOtherStopsUnchanged,
      mealBlocksUnchanged: scheduleBlockCoreSignature(fifthTarget) === scheduleBlockCoreSignature(fifthBaselineDay),
      nonTargetChangedDayCount: nonTargetChangedDayCount(fourthPlan, fifthPlan, '2026-09-22'),
      activeRevisionUnchanged: savedAfterTransfer?.activeRevisionId === startingRevisionId,
      savedRevisionCountUnchanged: savedAfterTransfer?.revisions.length === startingRevisionCount
    }
    process.stdout.write(`[itinerary-edit-live] transfer edit ${JSON.stringify(fifthSummary)}\n`)
    expect(fifthSummary.singleDraft).toBe(true)
    expect(fifthSummary.transferUpdated).toBe(true)
    expect(fifthSummary.onlyTransferFieldChanged).toBe(true)
    expect(fifthSummary.otherTargetStopsUnchanged).toBe(true)
    expect(fifthSummary.mealBlocksUnchanged).toBe(true)
    expect(fifthSummary.nonTargetChangedDayCount).toBe(0)
    expect(fifthSummary.activeRevisionUnchanged).toBe(true)
    expect(fifthSummary.savedRevisionCountUnchanged).toBe(true)
  } finally {
    await flushSystemLogs()
    configureSystemLogger(userDataDirectory)
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}, 5_400_000)

/** 单独验证三日短上下文中的定向接驳和值保真。 */
it.skipIf(!transferEnabled)('真实模型只改有向接驳字段并保留用户指定方式', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tripwise-transfer-live-'))
  const store = new TripStore(temporaryDirectory)
  const vault = new SecretVault(userDataDirectory)
  const baseline = seedPlan()
  baseline.title = '北京三日接驳字段评测'
  baseline.summary = '仅用于验证地点间接驳方式的定向修改。'
  baseline.days = baseline.days.slice(0, 3)

  try {
    await store.initialize()
    configureSystemLogger(temporaryDirectory)
    await vault.initialize()
    if (!(await vault.get('modelKey'))) throw new Error('missing_saved_model_credential')
    const savedModel = savedModelSettings(await readTripwiseProfile(userDataDirectory))
    await store.updateSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      model: savedModel,
      connectors: { webSearch: false, weather: false, places: false, routes: false },
      xiaohongshu: { enabled: false, command: '', args: [] },
      mcpServers: []
    })

    const tripBrief: TripBrief = {
      departureCity: '广州', destination: '北京', startDate: '2026-09-21', endDate: '2026-09-23',
      arrivalFlight: '', arrivalTime: '', leaveTime: '', travelers: '1', budget: '中等',
      lodgingLocation: '', lodging: '', pace: '中等', earlyStart: '', interests: '校园、人文、园林',
      transport: '公共交通与步行均可', dietary: '', luggage: '', clothing: '',
      constraints: '仅验证行程修改范围，不检索开放、预约、天气或交通事实。'
    }
    await store.createTrip(tripBrief)
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('temporary_trip_creation_failed')
    const source = createUserProvidedSource({
      title: '接驳字段评测基线',
      text: '人工构造的三日北京行程基线，不含已核验的路线事实。'
    })
    await store.saveSources(trip.id, [source])
    const baselineMessageId = randomUUID()
    await store.appendMessage(trip.id, {
      id: baselineMessageId, role: 'assistant', content: '临时评测基线。', createdAt: new Date().toISOString(),
      sourceIds: [source.id], itineraryOptions: [baseline]
    })
    await store.saveRevision(trip.id, baselineMessageId, baseline.id)
    const initialTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const activeRevisionId = initialTrip?.activeRevisionId
    const revisionCount = initialTrip?.revisions.length ?? 0
    const baselineDay = baseline.days.find((day) => day.date === '2026-09-22')

    let terminal = 'none'
    await new TravelAgent().run(
      store, vault, trip.id,
      '只调整 2026-09-22 从“清华大学”到“北京大学”的接驳，保留停靠点、时段和其他日期，交通方式改为：步行。9/21 和 9/23 完全保持原样。开放、预约、天气及交通事实不做检索，继续标为待核验。请返回一份完整修订草案，不要保存。',
      randomUUID(), new AbortController().signal,
      (event) => { if (event.type === 'complete' || event.type === 'error') terminal = event.type }
    )
    await flushSystemLogs()

    const updatedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const updatedPlan = updatedTrip?.messages.filter((message) =>
      message.role === 'assistant' && message.itineraryOptions?.length).at(-1)?.itineraryOptions?.[0]
    const updatedDay = updatedPlan?.days.find((day) => day.date === '2026-09-22')
    const priorTsinghua = baselineDay?.stops.find((stop) => stop.name === '清华大学')
    const updatedTsinghua = updatedDay?.stops.find((stop) => stop.name === '清华大学')
    const result = {
      complete: terminal === 'complete' && !!updatedPlan,
      requestedModeApplied: updatedTsinghua?.transitToNext === '步行',
      onlyTransferFieldChanged: stopChangedFields(priorTsinghua, updatedTsinghua).join(',') === 'transitToNext',
      otherTargetStopsUnchanged: JSON.stringify(updatedDay?.stops.filter((stop) => stop.name !== '清华大学')) ===
        JSON.stringify(baselineDay?.stops.filter((stop) => stop.name !== '清华大学')),
      mealBlocksUnchanged: scheduleBlockCoreSignature(updatedDay) === scheduleBlockCoreSignature(baselineDay),
      nonTargetChangedDayCount: updatedPlan ? nonTargetChangedDayCount(baseline, updatedPlan, '2026-09-22') : -1,
      activeRevisionUnchanged: updatedTrip?.activeRevisionId === activeRevisionId,
      savedRevisionCountUnchanged: updatedTrip?.revisions.length === revisionCount
    }
    process.stdout.write(`[itinerary-transfer-live] ${JSON.stringify(result)}\n`)
    expect(result.complete).toBe(true)
    expect(result.requestedModeApplied).toBe(true)
    expect(result.onlyTransferFieldChanged).toBe(true)
    expect(result.otherTargetStopsUnchanged).toBe(true)
    expect(result.mealBlocksUnchanged).toBe(true)
    expect(result.nonTargetChangedDayCount).toBe(0)
    expect(result.activeRevisionUnchanged).toBe(true)
    expect(result.savedRevisionCountUnchanged).toBe(true)
  } finally {
    await flushSystemLogs()
    configureSystemLogger(userDataDirectory)
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}, 5_400_000)

/** 验证真实模型连续跨日移动时保留抵离锚点和未涉及日期。 */
it.skipIf(!crossDayEnabled)('真实模型连续跨日移动保留抵离锚点和其他日期边界', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tripwise-cross-day-live-'))
  const store = new TripStore(temporaryDirectory)
  const vault = new SecretVault(userDataDirectory)
  const baseline = seedPlan()
  baseline.title = '北京连续跨日移动评测'
  baseline.summary = '仅用于验证连续跨日移动和抵离锚点。'
  baseline.days = baseline.days.slice(0, 5)
  baseline.days[0]!.stops = [evaluationStop('arrival-anchor', '北京大兴国际机场', '大兴区', '19:30–20:00', 45, '交通枢纽')]
  baseline.days[0]!.stops[0]!.locked = true
  baseline.days[0]!.scheduleBlocks = []
  baseline.days[1]!.stops = [
    evaluationStop('move-tsinghua', '清华大学', '海淀区', '09:00–11:00', 120, '人文景点'),
    evaluationStop('keep-peking', '北京大学', '海淀区', '11:30–13:00', 90, '人文景点')
  ]
  baseline.days[1]!.scheduleBlocks = [evaluationMeal('source-lunch', '13:00–13:45', '海淀区')]
  baseline.days[2]!.stops = [evaluationStop('keep-yuanmingyuan', '圆明园', '海淀区', '09:00–12:00', 180, '人文景点')]
  baseline.days[2]!.scheduleBlocks = []
  baseline.days[3]!.stops = [
    evaluationStop('move-xiangshan', '香山公园', '海淀区', '09:00–11:00', 120, '自然景点'),
    evaluationStop('keep-temple-heaven', '天坛公园', '东城区', '13:00–15:00', 120, '人文景点')
  ]
  baseline.days[3]!.scheduleBlocks = [evaluationMeal('second-source-lunch', '11:15–12:00', '海淀区')]
  baseline.days[4]!.stops = [evaluationStop('departure-anchor', '北京西站', '丰台区', '19:00前抵达；20:00离站', 0, '交通枢纽')]
  baseline.days[4]!.stops[0]!.locked = true
  baseline.days[4]!.scheduleBlocks = []
  const firstStopName = '清华大学'
  const secondStopName = '香山公园'
  const firstSourceDate = '2026-09-22'
  const firstTargetDate = '2026-09-23'
  const secondSourceDate = '2026-09-24'
  const secondTargetDate = '2026-09-25'

  try {
    await store.initialize()
    configureSystemLogger(temporaryDirectory)
    await vault.initialize()
    if (!(await vault.get('modelKey'))) throw new Error('missing_saved_model_credential')
    const savedModel = savedModelSettings(await readTripwiseProfile(userDataDirectory))
    await store.updateSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      model: savedModel,
      connectors: { webSearch: false, weather: false, places: false, routes: false },
      xiaohongshu: { enabled: false, command: '', args: [] },
      mcpServers: []
    })

    const tripBrief: TripBrief = {
      departureCity: '深圳', destination: '北京', startDate: '2026-09-21', endDate: '2026-09-25',
      arrivalFlight: '', arrivalTime: '19:30', leaveTime: '2026-09-25 20:00 北京西站', travelers: '1', budget: '中等',
      lodgingLocation: '', lodging: '', pace: '中等', earlyStart: '', interests: '校园、人文、园林',
      transport: '公共交通与步行均可', dietary: '', luggage: '', clothing: '',
      constraints: '首日晚间抵达北京大兴国际机场；末日19:00前抵达北京西站候车，20:00从北京西站发车。两个抵离停靠点已固定；请保留时间和地点。仅验证计划结构，不检索开放、预约、天气或交通事实。'
    }
    await store.createTrip(tripBrief)
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('temporary_trip_creation_failed')
    const source = createUserProvidedSource({
      title: '连续跨日移动评测基线',
      text: '人工构造的五日北京行程基线，不含已核验的路线事实。抵达和返程停靠点已固定。'
    })
    await store.saveSources(trip.id, [source])
    const baselineMessageId = randomUUID()
    await store.appendMessage(trip.id, {
      id: baselineMessageId, role: 'assistant', content: '临时评测基线。', createdAt: new Date().toISOString(),
      sourceIds: [source.id], itineraryOptions: [baseline]
    })
    await store.saveRevision(trip.id, baselineMessageId, baseline.id)
    const initialTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const activeRevisionId = initialTrip?.activeRevisionId
    const revisionCount = initialTrip?.revisions.length ?? 0

    let terminal = 'none'
    await new TravelAgent().run(
      store, vault, trip.id,
      '把 2026-09-22 的清华大学移到 2026-09-23；随后把 2026-09-24 的香山公园移到 2026-09-25。保留其余地点、餐休和已保存版本；保留首日晚间到达北京大兴，以及返程日19:00前到达北京西站、20:00发车的固定锚点，返程日游览须安排在发车前。只重排这四个受影响日期。交通耗时、开放、预约和天气事实不做检索，继续标为待核验。请返回一份完整修订草案，不要保存。',
      randomUUID(), new AbortController().signal,
      (event) => { if (event.type === 'complete' || event.type === 'error') terminal = event.type }
    )
    await flushSystemLogs()

    const updatedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const updatedPlan = updatedTrip?.messages.filter((message) =>
      message.role === 'assistant' && message.itineraryOptions?.length).at(-1)?.itineraryOptions?.[0]
    const firstSourceDay = updatedPlan?.days.find((day) => day.date === firstSourceDate)
    const firstTargetDay = updatedPlan?.days.find((day) => day.date === firstTargetDate)
    const secondSourceDay = updatedPlan?.days.find((day) => day.date === secondSourceDate)
    const secondTargetDay = updatedPlan?.days.find((day) => day.date === secondTargetDate)
    const originalFirstSourceDay = baseline.days.find((day) => day.date === firstSourceDate)
    const originalFirstTargetDay = baseline.days.find((day) => day.date === firstTargetDate)
    const originalSecondSourceDay = baseline.days.find((day) => day.date === secondSourceDate)
    const originalSecondTargetDay = baseline.days.find((day) => day.date === secondTargetDate)
    const movedStopCount = (updatedPlan?.days.reduce((count, day) => count +
      day.stops.filter((stop) => stop.name === firstStopName || stop.name === secondStopName).length, 0)) ?? 0
    const firstMoveCount = updatedPlan?.days.reduce((count, day) => count +
      day.stops.filter((stop) => stop.name === firstStopName).length, 0) ?? 0
    const secondMoveCount = updatedPlan?.days.reduce((count, day) => count +
      day.stops.filter((stop) => stop.name === secondStopName).length, 0) ?? 0
    const unaffectedDay = updatedPlan?.days.find((day) => day.date === '2026-09-21')
    const originalUnaffectedDay = baseline.days.find((day) => day.date === '2026-09-21')
    const unaffectedDayUnchanged = !!unaffectedDay && !!originalUnaffectedDay &&
      daySignature(unaffectedDay) === daySignature(originalUnaffectedDay)
    const arrivalAnchor = unaffectedDay?.stops.find((stop) => stop.name === '北京大兴国际机场')
    const departureAnchor = secondTargetDay?.stops.find((stop) => stop.name === '北京西站')
    const remainingNames = (day: ItineraryDay | undefined, excludedName?: string) =>
      (day?.stops ?? []).filter((stop) => stop.name !== excludedName).map((stop) => stop.name).sort()
    const result = {
      complete: terminal === 'complete' && !!updatedPlan,
      movedStopCount,
      firstMoveCount,
      secondMoveCount,
      firstSourceStopRemoved: !firstSourceDay?.stops.some((stop) => stop.name === firstStopName),
      firstDestinationStopAdded: firstTargetDay?.stops.some((stop) => stop.name === firstStopName) === true,
      secondSourceStopRemoved: !secondSourceDay?.stops.some((stop) => stop.name === secondStopName),
      secondDestinationStopAdded: secondTargetDay?.stops.some((stop) => stop.name === secondStopName) === true,
      firstSourceOtherStopsPreserved: JSON.stringify(remainingNames(firstSourceDay, firstStopName)) ===
        JSON.stringify(remainingNames(originalFirstSourceDay, firstStopName)),
      firstDestinationOtherStopsPreserved: JSON.stringify(remainingNames(firstTargetDay, firstStopName)) ===
        JSON.stringify(remainingNames(originalFirstTargetDay)),
      secondSourceOtherStopsPreserved: JSON.stringify(remainingNames(secondSourceDay, secondStopName)) ===
        JSON.stringify(remainingNames(originalSecondSourceDay, secondStopName)),
      secondDestinationOtherStopsPreserved: JSON.stringify(remainingNames(secondTargetDay, secondStopName)) ===
        JSON.stringify(remainingNames(originalSecondTargetDay)),
      unaffectedDayUnchanged,
      arrivalAnchorPreserved: arrivalAnchor?.time === '19:30–20:00' && arrivalAnchor.locked === true,
      departureAnchorPreserved: departureAnchor?.time === '19:00前抵达；20:00离站' && departureAnchor.locked === true,
      activeRevisionUnchanged: updatedTrip?.activeRevisionId === activeRevisionId,
      savedRevisionCountUnchanged: updatedTrip?.revisions.length === revisionCount
    }
    process.stdout.write(`[itinerary-cross-day-live] ${JSON.stringify(result)}\n`)
    expect(result.complete).toBe(true)
    expect(result.movedStopCount).toBe(2)
    expect(result.firstMoveCount).toBe(1)
    expect(result.secondMoveCount).toBe(1)
    expect(result.firstSourceStopRemoved).toBe(true)
    expect(result.firstDestinationStopAdded).toBe(true)
    expect(result.secondSourceStopRemoved).toBe(true)
    expect(result.secondDestinationStopAdded).toBe(true)
    expect(result.firstSourceOtherStopsPreserved).toBe(true)
    expect(result.firstDestinationOtherStopsPreserved).toBe(true)
    expect(result.secondSourceOtherStopsPreserved).toBe(true)
    expect(result.secondDestinationOtherStopsPreserved).toBe(true)
    expect(result.unaffectedDayUnchanged).toBe(true)
    expect(result.arrivalAnchorPreserved).toBe(true)
    expect(result.departureAnchorPreserved).toBe(true)
    expect(result.activeRevisionUnchanged).toBe(true)
    expect(result.savedRevisionCountUnchanged).toBe(true)
  } finally {
    await flushSystemLogs()
    configureSystemLogger(userDataDirectory)
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}, 5_400_000)

/** 验证真实模型一次提交同一餐休块的多个字段时不改写同日其他安排。 */
it.skipIf(!scheduleMultiFieldEnabled)('真实模型一次修改餐休块六个字段并保留其他安排', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tripwise-schedule-multifield-live-'))
  const store = new TripStore(temporaryDirectory)
  const vault = new SecretVault(userDataDirectory)
  const baseline = seedPlan()
  baseline.title = '北京三日餐休多字段评测'
  baseline.summary = '仅用于验证一次修改餐休块多个字段的范围。'
  baseline.days = baseline.days.slice(0, 3)
  const targetDate = '2026-09-22'

  try {
    await store.initialize()
    configureSystemLogger(temporaryDirectory)
    await vault.initialize()
    if (!(await vault.get('modelKey'))) throw new Error('missing_saved_model_credential')
    const savedModel = savedModelSettings(await readTripwiseProfile(userDataDirectory))
    await store.updateSettings({
      ...structuredClone(DEFAULT_SETTINGS),
      model: savedModel,
      connectors: { webSearch: false, weather: false, places: false, routes: false },
      xiaohongshu: { enabled: false, command: '', args: [] },
      mcpServers: []
    })

    const tripBrief: TripBrief = {
      departureCity: '广州', destination: '北京', startDate: '2026-09-21', endDate: '2026-09-23',
      arrivalFlight: '', arrivalTime: '', leaveTime: '', travelers: '1', budget: '中等',
      lodgingLocation: '', lodging: '', pace: '中等', earlyStart: '', interests: '校园、人文、园林',
      transport: '公共交通与步行均可', dietary: '', luggage: '', clothing: '',
      constraints: '仅验证餐休块字段修改范围，不检索开放、预约、天气或交通事实。'
    }
    await store.createTrip(tripBrief)
    const trip = store.snapshot().trips[0]
    if (!trip) throw new Error('temporary_trip_creation_failed')
    const source = createUserProvidedSource({
      title: '餐休多字段评测基线',
      text: '人工构造的三日北京行程基线，不含已核验的路线事实。'
    })
    await store.saveSources(trip.id, [source])
    const baselineMessageId = randomUUID()
    await store.appendMessage(trip.id, {
      id: baselineMessageId, role: 'assistant', content: '临时评测基线。', createdAt: new Date().toISOString(),
      sourceIds: [source.id], itineraryOptions: [baseline]
    })
    await store.saveRevision(trip.id, baselineMessageId, baseline.id)
    const initialTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const activeRevisionId = initialTrip?.activeRevisionId
    const revisionCount = initialTrip?.revisions.length ?? 0
    const baselineDay = baseline.days.find((day) => day.date === targetDate)
    const baselineLunch = baselineDay?.scheduleBlocks.find((block) => block.id === 'granularity-day-2-lunch')
    const baselineRest = baselineDay?.scheduleBlocks.find((block) => block.id === 'granularity-day-2-rest')

    let terminal = 'none'
    await new TravelAgent().run(
      store, vault, trip.id,
      '只修改 2026-09-22 的“午餐”时段：时段改为 13:15–13:45，时长改为 30 分钟，类型改为休息，标题改为“校内休息”，片区改为“清华园”，说明改为“短暂用餐”。保留午间休息块、当天地点和 9/21、9/23 两天，其他事实继续标为待核验。请返回一份完整修订草案，不要保存。',
      randomUUID(), new AbortController().signal,
      (event) => { if (event.type === 'complete' || event.type === 'error') terminal = event.type }
    )
    await flushSystemLogs()

    const updatedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const updatedPlan = updatedTrip?.messages.filter((message) =>
      message.role === 'assistant' && message.itineraryOptions?.length).at(-1)?.itineraryOptions?.[0]
    const updatedDay = updatedPlan?.days.find((day) => day.date === targetDate)
    const updatedLunch = updatedDay?.scheduleBlocks.find((block) => block.id === 'granularity-day-2-lunch')
    const updatedRest = updatedDay?.scheduleBlocks.find((block) => block.id === 'granularity-day-2-rest')
    const result = {
      complete: terminal === 'complete' && !!updatedPlan,
      allRequestedFieldsApplied: updatedLunch?.kind === 'rest' && updatedLunch.title === '校内休息' &&
        updatedLunch.time === '13:15–13:45' && updatedLunch.durationMinutes === 30 &&
        updatedLunch.area === '清华园' && updatedLunch.notes === '短暂用餐',
      requestedFieldChecks: {
        kind: updatedLunch?.kind === 'rest',
        title: updatedLunch?.title === '校内休息',
        time: updatedLunch?.time === '13:15–13:45',
        duration: updatedLunch?.durationMinutes === 30,
        area: updatedLunch?.area === '清华园',
        notes: updatedLunch?.notes === '短暂用餐'
      },
      changedStopFieldSets: (baselineDay?.stops ?? []).flatMap((stop) => {
        const revisedStop = updatedDay?.stops.find((candidate) => candidate.id === stop.id || candidate.name === stop.name)
        const fields = stopChangedFields(stop, revisedStop)
        return fields.length ? [fields] : []
      }),
      candidateBlockLabels: updatedDay?.scheduleBlocks.map(({ kind, title }) => `${kind}:${title}`) ?? [],
      otherScheduleBlockUnchanged: JSON.stringify(updatedRest) === JSON.stringify(baselineRest),
      targetDayStopsUnchanged: stopSignature(updatedDay) === stopSignature(baselineDay),
      nonTargetChangedDayCount: updatedPlan ? nonTargetChangedDayCount(baseline, updatedPlan, targetDate) : -1,
      activeRevisionUnchanged: updatedTrip?.activeRevisionId === activeRevisionId,
      savedRevisionCountUnchanged: updatedTrip?.revisions.length === revisionCount,
      baselineTargetExists: !!baselineLunch
    }
    process.stdout.write(`[itinerary-schedule-multifield-live] ${JSON.stringify(result)}\n`)
    expect(result.complete).toBe(true)
    expect(result.allRequestedFieldsApplied).toBe(true)
    expect(result.otherScheduleBlockUnchanged).toBe(true)
    expect(result.targetDayStopsUnchanged).toBe(true)
    expect(result.nonTargetChangedDayCount).toBe(0)
    expect(result.activeRevisionUnchanged).toBe(true)
    expect(result.savedRevisionCountUnchanged).toBe(true)
    expect(result.baselineTargetExists).toBe(true)
  } finally {
    await flushSystemLogs()
    configureSystemLogger(userDataDirectory)
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}, 5_400_000)
