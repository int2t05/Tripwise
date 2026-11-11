/** 验证候选变更预览展示受影响日期，并优先保留交通变化。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ItineraryBudgetEstimate, ItineraryDay, ItineraryOption, ItineraryRevision, ItineraryStop, SourceRecord, TripBrief } from '../src/shared/types.js'
import { PlanChangePreview, PlanDayDisclosure, PlanDaySchedulePreview, PlanOptionCard, ScheduleFeasibility, scheduleFindingRevisionSuggestion, stopRevisionSuggestion } from '../src/renderer/src/ItineraryPlans'

/** 构造行程跨度和地点数固定的候选，用于检查较长差异列表中的关键影响。 */
function makeOption(date: string, updated: boolean): ItineraryOption {
  return {
    id: updated ? 'proposed' : 'baseline', title: '测试行程', summary: '行程摘要', tradeoffs: '路线取舍',
    days: [{
      id: 'day-1', dayNumber: 1, date, title: '第一天', scheduleBlocks: [],
      stops: Array.from({ length: 10 }, (_, index) => ({
        id: `stop-${index}`, name: `景点 ${index + 1}`, area: '', time: '', durationMinutes: null,
        category: '', notes: updated ? '安排说明已调整' : '', transitToNext: '',
        ...(index === 9 ? {
          transitEstimate: {
            sourceId: 'route-source', destinationStopId: 'end-stop', mode: 'transit' as const,
            fetchedAt: '2026-10-18T00:00:00.000Z', optionNumber: 1, durationMinutes: updated ? 45 : 25,
            distanceMeters: 2_000, walkingDistanceMeters: 500, transitLines: ['地铁 1 号线']
          }
        } : {})
      }))
    }]
  }
}

/** 构造费用变化，用于确认候选差异会呈现预算影响。 */
function budgetEstimate(minimum: number, maximum: number): ItineraryBudgetEstimate {
  return {
    currency: 'CNY',
    items: [{
      id: `flight-${minimum}`, category: 'flight', title: '往返机票', amountMinFen: minimum,
      amountMaxFen: maximum, quantity: 1, unitLabel: '人', evidenceLevel: 'estimated', sourceIds: [], basis: '按近期常见价格估算。'
    }],
    notApplicableCategories: [
      { category: 'intercity-transport', reason: '没有额外城际段。' },
      { category: 'lodging', reason: '不在本方案中计算住宿。' },
      { category: 'local-transport', reason: '本轮未计算市内交通。' },
      { category: 'tickets', reason: '本方案不涉及门票。' },
      { category: 'meals', reason: '本方案不计算餐饮。' },
      { category: 'other', reason: '不计算个人消费。' }
    ]
  }
}

describe('候选行程变更预览', () => {
  it('计划卡默认突出摘要和逐日结构，安排取舍收起展示', () => {
    const option: ItineraryOption = {
      id: 'compact-plan', title: '北京一日', summary: '故宫与中轴线。', tradeoffs: '上午游览故宫，下午按体力选择景山。',
      days: [{ id: 'day-1', dayNumber: 1, date: '2026-09-22', title: '故宫与中轴线', scheduleBlocks: [], stops: [{
        id: 'palace', name: '故宫', area: '东城', time: '09:00', durationMinutes: 120,
        category: '人文', notes: '', transitToNext: ''
      }] }]
    }
    const tripBrief: TripBrief = {
      departureCity: '', destination: '北京', startDate: '2026-09-22', endDate: '2026-09-22',
      arrivalFlight: '', arrivalTime: '', leaveTime: '', travelers: '', budget: '', lodgingLocation: '', lodging: '',
      pace: '', earlyStart: '', interests: '', transport: '', dietary: '', luggage: '', clothing: '', constraints: ''
    }
    const markup = renderToStaticMarkup(<PlanOptionCard
      option={option} tripBrief={tripBrief} index={0} sources={[]} baselineRevision={null} rejected={false}
      onSave={() => undefined} onReject={() => undefined} onOpen={() => undefined} onShowSource={() => undefined}
    />)

    expect(markup).toContain('故宫与中轴线。')
    expect(markup).toContain('<details class="plan-tradeoffs"><summary>安排取舍</summary><p>上午游览故宫，下午按体力选择景山。</p></details>')
    expect(markup.indexOf('class="plan-option-days"')).toBeLessThan(markup.indexOf('class="schedule-feasibility"'))
  })

  it('在计划卡上保留预算区间，并默认收起逐项金额', () => {
    const option: ItineraryOption = {
      id: 'budget-plan', title: '北京一日', summary: '故宫与中轴线。', tradeoffs: '',
      days: [{ id: 'day-1', dayNumber: 1, date: '2026-09-22', title: '故宫与中轴线', stops: [], scheduleBlocks: [] }],
      budgetEstimate: budgetEstimate(10_000, 20_000)
    }
    const tripBrief: TripBrief = {
      departureCity: '', destination: '北京', startDate: '2026-09-22', endDate: '2026-09-22',
      arrivalFlight: '', arrivalTime: '', leaveTime: '', travelers: '', budget: '', lodgingLocation: '', lodging: '',
      pace: '', earlyStart: '', interests: '', transport: '', dietary: '', luggage: '', clothing: '', constraints: ''
    }
    const markup = renderToStaticMarkup(<PlanOptionCard
      option={option} tripBrief={tripBrief} index={0} sources={[]} baselineRevision={null}
      savedRevisionNumber={1} rejected={false}
      onSave={() => undefined} onReject={() => undefined} onOpen={() => undefined} onShowSource={() => undefined}
    />)

    expect(markup).toContain('<details class="plan-budget-disclosure">')
    expect(markup).toContain('预算估算')
    expect(markup).toContain('¥100.00–¥200.00')
    expect(markup).toContain('class="itinerary-budget-card is-compact"')
  })

  it('按日展示紧凑摘要并默认只展开第一天', () => {
    const day: ItineraryDay = {
      id: 'day-1', dayNumber: 1, date: '2026-09-22', title: '海淀校园', stops: [],
      scheduleBlocks: [{ id: 'lunch', kind: 'meal', title: '午餐', time: '12:00', durationMinutes: 60, area: '五道口', notes: '' }]
    }
    const first = renderToStaticMarkup(<PlanDayDisclosure day={day} index={0} lodgingLocation="" sources={[]} onOpen={() => undefined} onShowSource={() => undefined} />)
    const later = renderToStaticMarkup(<PlanDayDisclosure day={{ ...day, id: 'day-2', dayNumber: 2 }} index={1} lodgingLocation="" sources={[]} onOpen={() => undefined} onShowSource={() => undefined} />)

    expect(first).toContain('open=""')
    expect(first).toContain('地点待补 · 1 餐')
    expect(later).not.toContain('open=""')
  })

  it('历史候选草案默认折叠每日内容，最新草案保持可直接审阅', () => {
    const option = makeOption('2026-09-22', false)
    const tripBrief: TripBrief = {
      departureCity: '', destination: '北京', startDate: '2026-09-22', endDate: '2026-09-22',
      arrivalFlight: '', arrivalTime: '', leaveTime: '', travelers: '', budget: '', lodgingLocation: '', lodging: '',
      pace: '', earlyStart: '', interests: '', transport: '', dietary: '', luggage: '', clothing: '', constraints: ''
    }
    const renderPlan = (isLatestProposal: boolean) => renderToStaticMarkup(<PlanOptionCard
      option={option} tripBrief={tripBrief} index={0} sources={[]} baselineRevision={null}
      isLatestProposal={isLatestProposal} rejected={false}
      onSave={() => undefined} onReject={() => undefined} onOpen={() => undefined} onShowSource={() => undefined}
    />)

    expect(renderPlan(true)).toContain('<details class="plan-day-disclosure" open="">')
    expect(renderPlan(false)).not.toContain('<details class="plan-day-disclosure" open="">')
  })

  it('收起日期仍显示停靠顺序，并可从日期栏直接发起局部修改', () => {
    const stops: ItineraryStop[] = ['清华大学', '北京大学', '圆明园', '颐和园'].map((name, index) => ({
      id: `stop-${index}`, name, area: '海淀', time: '', durationMinutes: null,
      category: '', notes: '', transitToNext: ''
    }))
    const day: ItineraryDay = {
      id: 'day-2', dayNumber: 2, date: '2026-09-22', title: '校园与园林', stops, scheduleBlocks: []
    }
    const markup = renderToStaticMarkup(<PlanDayDisclosure
      day={day} index={1} lodgingLocation="" sources={[]} onOpen={() => undefined} onShowSource={() => undefined}
      onContinueRevision={() => undefined}
    />)

    expect(markup).toContain('清华大学 → 北京大学 → 圆明园 → +1')
    expect(markup).toContain('修改当天')
    expect(markup).toContain('调整节奏')
    expect(markup).not.toContain('class="plan-day-disclosure" open=""')
  })

  it('提供限定到单个地点的改名入口', () => {
    const stop: ItineraryStop = {
      id: 'qinghua', name: '清华大学', area: '海淀', time: '09:00', durationMinutes: 120,
      category: '人文', notes: '', transitToNext: ''
    }
    const day: ItineraryDay = {
      id: 'day-1', dayNumber: 1, date: '2026-09-22', title: '海淀校园', stops: [stop, {
        ...stop, id: 'yuanmingyuan', name: '圆明园'
      }], scheduleBlocks: []
    }
    const suggestion = stopRevisionSuggestion(day, stop, 'rename')
    const markup = renderToStaticMarkup(<PlanDaySchedulePreview
      day={day}
      lodgingLocation=""
      sources={[]}
      onOpen={() => undefined}
      onShowSource={() => undefined}
      onContinueRevision={() => undefined}
    />)

    expect(suggestion).toBe('只修改2026-09-22“清华大学”在行程中的名称，不替换实际地点，也不改时段和其他安排，名称改为：')
    expect(stopRevisionSuggestion(day, stop, 'transit')).toContain('从“清华大学”到“圆明园”的接驳，保留停靠点、时段和其他日期，交通方式改为：')
    expect(markup).toContain('>改时段</button>')
    expect(markup).toContain('>换地点</button>')
    expect(markup).toContain('>改接驳</button>')
    expect(markup).toContain('class="plan-stop-edit-trigger"')
    expect(markup).toContain('<strong>常用修改</strong>')
    expect(markup).toContain('<details class="plan-stop-advanced-edit"><summary>更多字段与操作</summary>')
    expect(markup).toContain('<strong>地点信息</strong>')
    expect(markup).toContain('<strong>插入与移动</strong>')
    expect(markup).toContain('>改名称</button>')
  })

  it('为路线耗时冲突提供定位到该日期和路段的修改入口', () => {
    const from: ItineraryStop = {
      id: 'from', name: '清华大学', area: '海淀', time: '09:00', durationMinutes: 60,
      category: '人文', notes: '', transitToNext: '',
      transitEstimate: {
        sourceId: 'route-source', destinationStopId: 'to', mode: 'transit',
        fetchedAt: '2026-10-25T00:00:00.000Z', optionNumber: 1, durationMinutes: 60
      }
    }
    const to: ItineraryStop = {
      id: 'to', name: '北京大学', area: '海淀', time: '10:30', durationMinutes: 90,
      category: '人文', notes: '', transitToNext: ''
    }
    const day: ItineraryDay = {
      id: 'day-1', dayNumber: 1, date: '2026-09-22', title: '海淀校园', stops: [from, to], scheduleBlocks: []
    }
    const itinerary: ItineraryOption = {
      id: 'plan', title: '北京行程', summary: '行程摘要', tradeoffs: '安排说明', days: [day]
    }
    const anchors: TripBrief = {
      departureCity: '', destination: '北京', startDate: day.date, endDate: day.date,
      arrivalFlight: '', arrivalTime: '', leaveTime: '', travelers: '', budget: '',
      lodgingLocation: '', lodging: '', pace: '', earlyStart: '', interests: '', transport: '公共交通',
      dietary: '', luggage: '', clothing: '', constraints: ''
    }
    const routeSource: SourceRecord = {
      id: 'route-source', title: '清华大学 → 北京大学', url: 'https://ditu.amap.com/',
      provider: '高德地图路线规划', kind: 'route', summary: '公共交通估算约 60 分钟',
      fetchedAt: '2026-10-25T00:00:00.000Z', status: 'success'
    }
    const suggestion = scheduleFindingRevisionSuggestion(day, {
      code: 'route-buffer', itemIds: ['from', 'to'],
      message: '清华大学停留后还需约 60 分钟通勤。'
    }, [routeSource])
    const markup = renderToStaticMarkup(<ScheduleFeasibility
      itinerary={itinerary} anchors={anchors} sources={[routeSource]} onContinueRevision={() => undefined}
    />)

    expect(suggestion).toContain('只调整2026-09-22（第 1 天）从“清华大学”到“北京大学”')
    expect(suggestion).toContain('高德地图路线规划公共交通估算约 60 分钟')
    expect(suggestion).toContain('保留两处地点、其他日期、固定预约和抵离时刻')
    expect(markup).toContain('调整这段通勤</button>')
  })

  it('时间核对区分具体时刻与宽泛时段，不显示互相矛盾的提示', () => {
    const day: ItineraryDay = {
      id: 'day-1', dayNumber: 1, date: '2026-09-22', title: '海淀校园',
      stops: [{ id: 'stop', name: '清华大学', area: '', time: '上午', durationMinutes: null, category: '', notes: '', transitToNext: '' }],
      scheduleBlocks: []
    }
    const itinerary: ItineraryOption = {
      id: 'plan', title: '北京行程', summary: '行程摘要', tradeoffs: '', days: [day]
    }
    const anchors: TripBrief = {
      departureCity: '', destination: '北京', startDate: day.date, endDate: day.date,
      arrivalFlight: '', arrivalTime: '08:00', leaveTime: '', travelers: '', budget: '',
      lodgingLocation: '', lodging: '', pace: '', earlyStart: '', interests: '', transport: '',
      dietary: '', luggage: '', clothing: '', constraints: ''
    }
    const markup = renderToStaticMarkup(<ScheduleFeasibility itinerary={itinerary} anchors={anchors} sources={[]} />)

    expect(markup).toContain('时间核对 · 部分时段待补')
    expect(markup).toContain('<details class="schedule-feasibility" aria-label="行程时间核对">')
    expect(markup).toContain('部分地点或时段没有具体时刻，无法完整核对。')
    expect(markup).toContain('<details class="schedule-feasibility-scope">')
    expect(markup).not.toContain('<details class="schedule-feasibility-scope" open="">')
    expect(markup).not.toContain('暂未发现时间冲突。像“上午”这样的时段没有具体时间')
  })

  it('时间冲突默认展开并明确阻止保存', () => {
    const itinerary: ItineraryOption = {
      id: 'overlap-plan', title: '北京行程', summary: '故宫慢游。', tradeoffs: '',
      days: [{
        id: 'day-1', dayNumber: 1, date: '2026-09-22', title: '故宫', scheduleBlocks: [],
        stops: [
          { id: 'stop-1', name: '景点一', area: '', time: '09:00', durationMinutes: 120, category: '', notes: '', transitToNext: '' },
          { id: 'stop-2', name: '景点二', area: '', time: '10:30', durationMinutes: 60, category: '', notes: '', transitToNext: '' }
        ]
      }]
    }
    const anchors: TripBrief = {
      departureCity: '', destination: '北京', startDate: '2026-09-22', endDate: '2026-09-22',
      arrivalFlight: '', arrivalTime: '', leaveTime: '', travelers: '', budget: '', lodgingLocation: '', lodging: '',
      pace: '', earlyStart: '', interests: '', transport: '', dietary: '', luggage: '', clothing: '', constraints: ''
    }
    const markup = renderToStaticMarkup(<ScheduleFeasibility itinerary={itinerary} anchors={anchors} sources={[]} />)

    expect(markup).toContain('<details class="schedule-feasibility is-blocking" aria-label="行程时间核对" open="">')
    expect(markup).toContain('先修正以上时间冲突，才能确认并保存这份方案。')
  })

  it('显示日期影响范围，并在较长差异中优先展示路线估算变化', () => {
    const baseline = makeOption('2026-10-20', false)
    const proposed = makeOption('2026-10-21', true)
    const revision: ItineraryRevision = {
      id: 'revision-1', number: 1, createdAt: '', summary: '', content: '', sourceIds: [], itinerary: baseline
    }
    const markup = renderToStaticMarkup(<PlanChangePreview baselineRevision={revision} proposed={proposed} />)

    expect(markup).toContain('影响范围：第 1 天 · 2026-10-20 → 第 1 天 · 2026-10-21')
    expect(markup).toContain('公共交通约 25 分钟')
    expect(markup).toContain('公共交通约 45 分钟')
  })

  it('在候选差异中显示预算范围变化', () => {
    const baseline = makeOption('2026-10-20', false)
    baseline.days[0].stops = baseline.days[0].stops.slice(0, 1)
    baseline.budgetEstimate = budgetEstimate(10_000, 20_000)
    const proposed = makeOption('2026-10-20', false)
    proposed.days[0].stops = proposed.days[0].stops.slice(0, 1)
    proposed.budgetEstimate = budgetEstimate(15_000, 25_000)
    const revision: ItineraryRevision = {
      id: 'revision-budget', number: 1, createdAt: '', summary: '', content: '', sourceIds: [], itinerary: baseline
    }
    const markup = renderToStaticMarkup(<PlanChangePreview baselineRevision={revision} proposed={proposed} />)

    expect(markup).toContain('预算估算')
    expect(markup).toContain('¥100.00–¥200.00 → ¥150.00–¥250.00')
  })
})
