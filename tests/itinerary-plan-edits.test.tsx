/** 验证计划卡提供准确范围的修改入口，并保留固定地点规则。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ItineraryDay, ItineraryOption, ItineraryScheduleBlock, ItineraryStop, LodgingCommute, SourceRecord } from '../src/shared/types.js'
import { plannedStopTimeLabel } from '../src/shared/itinerary-schedule.js'
import {
  PlanDayDisclosure,
  PlanDaySchedulePreview,
  PlanChangePreview,
  dayRevisionSuggestion,
  lodgingCommuteRevisionSuggestion,
  scheduleBlockRevisionSuggestion,
  stopOrderRevisionSuggestion,
  stopRevisionSuggestion
} from '../src/renderer/src/ItineraryPlans'

const firstStop: ItineraryStop = {
  id: 'stop-1', name: '故宫博物院', area: '东城区', time: '09:00', durationMinutes: 180,
  category: '景点', notes: '从午门入场', transitToNext: '故宫博物院 → 景山：步行，约 20 分钟。'
}

const secondStop: ItineraryStop = {
  id: 'stop-2', name: '景山公园', area: '东城区', time: '15:00', durationMinutes: 60,
  category: '景点', notes: '', transitToNext: ''
}

const lunchBlock: ItineraryScheduleBlock = {
  id: 'block-1', kind: 'meal', title: '午餐', time: '12:00', durationMinutes: 60,
  area: '故宫附近', notes: '店面待选'
}

const itineraryDay: ItineraryDay = {
  id: 'day-3', dayNumber: 3, date: '2026-09-26', title: '故宫与中轴线',
  stops: [firstStop, secondStop], scheduleBlocks: [lunchBlock]
}

const lodgingCommute: LodgingCommute = {
  direction: 'from-lodging', lodgingLocation: '北京西站北广场酒店', stopId: firstStop.id, sourceId: 'route-hotel-first',
  mode: 'transit', optionNumber: 1, queryDate: '2026-09-26', queryTime: '07-00', durationMinutes: 45
}

describe('计划卡细粒度修改', () => {
  it('用停留时长补足建议结束时间，但不改写已有时段或宽泛安排', () => {
    expect(plannedStopTimeLabel('09:00', 180)).toBe('09:00–12:00')
    expect(plannedStopTimeLabel('上午 9:00 建议', 90)).toBe('上午 09:00–10:30 建议')
    expect(plannedStopTimeLabel('09:00–11:00', 120)).toBe('09:00–11:00')
    expect(plannedStopTimeLabel('上午', 120)).toBe('上午')
    expect(plannedStopTimeLabel('23:30', 90)).toBe('23:30')
  })

  it('首稿不重复显示无内容的版本对比卡', () => {
    const option: ItineraryOption = {
      id: 'first-draft', title: '北京一日', summary: '故宫与中轴线。', tradeoffs: '', days: [itineraryDay]
    }
    const markup = renderToStaticMarkup(<PlanChangePreview
      baselineRevision={null}
      proposed={option}
    />)

    expect(markup).toBe('')
  })

  it('按日、地点、相邻接驳和时间块提供分层修改入口', () => {
    const markup = renderToStaticMarkup(<PlanDayDisclosure
      day={itineraryDay}
      index={2}
      lodgingLocation=""
      sources={[]}
      onOpen={() => undefined}
      onShowSource={() => undefined}
      onContinueRevision={() => undefined}
    />)

    expect(markup).toContain('修改当天')
    expect(markup).toContain('改日期')
    expect(markup).toContain('改主题')
    expect(markup).toContain('调整节奏')
    expect(markup).toContain('增加地点')
    expect(markup).toContain('调整顺序')
    expect(markup).toContain('指定地点顺序')
    expect(markup).toContain('修改地点：故宫博物院')
    expect(markup).toContain('class="plan-stop-edit-trigger"')
    expect(markup).toContain('<strong>常用修改</strong>')
    expect(markup).toContain('<details class="plan-stop-advanced-edit"><summary>更多字段与操作</summary>')
    expect(markup).toContain('<strong>地点信息</strong>')
    expect(markup).toContain('<strong>插入与移动</strong>')
    expect(markup.indexOf('<strong>常用修改</strong>')).toBeLessThan(markup.indexOf('<details class="plan-stop-advanced-edit">'))
    expect(markup.indexOf('<details class="plan-stop-advanced-edit">')).toBeLessThan(markup.indexOf('>改名称</button>'))
    expect(markup).toContain('class="plan-option-stop-time">09:00–12:00</span>')
    expect(markup).toContain('class="plan-option-stop-title">故宫博物院</span>')
    expect(markup).toContain('class="plan-stop-context"')
    expect(markup).toContain('<summary>详情</summary>')
    expect(markup).toContain('改时段')
    expect(markup).toContain('改停留时长')
    expect(markup).toContain('改片区')
    expect(markup).toContain('换地点')
    expect(markup).toContain('改说明')
    expect(markup).toContain('移除此项')
    expect(markup).toContain('在前面加地点')
    expect(markup).toContain('在后面加地点')
    expect(markup).toContain('调整位置')
    expect(markup).toContain('移到另一天')
    expect(markup).toContain('改接驳')
    expect(markup).toContain('改这段')
    expect(markup).toContain('核对预约与门票')
    expect(markup).toContain('选具体餐馆')
    expect(markup).toContain('2 个地点 · 1 餐')
    expect(markup).toContain('拖到另一地点上方或下方，调整当天顺序')
    expect(markup).toContain('修改时段：午餐')
    expect(markup).toContain('<details class="plan-schedule-notes"><summary>安排说明</summary><p>店面待选</p></details>')
    expect(markup).toContain('改时间')
    expect(markup).toContain('改时长')
    expect(markup).toContain('改类型')
    expect(markup).toContain('改标题')
    expect(markup).toContain('改片区')
    expect(markup).toContain('改说明')
    expect(markup).toContain('前面加时段')
    expect(markup).toContain('后面加时段')
    expect(markup).toContain('移除此时段')
    expect(markup).toContain('更多字段与操作')
  })

  it('用排版承载类别和区域，并将成功来源状态收进详情', () => {
    const source: SourceRecord = {
      id: 'palace-source', title: '故宫开放公告', url: 'https://example.com/palace', provider: '官方网页',
      kind: 'web', summary: '参观须知', fetchedAt: '2026-10-18T10:00:00.000Z', status: 'success'
    }
    const day: ItineraryDay = {
      ...itineraryDay,
      stops: [{ ...firstStop, evidenceLevel: 'sourced', sourceIds: [source.id] }]
    }
    const markup = renderToStaticMarkup(<PlanDayDisclosure
      day={day}
      index={0}
      lodgingLocation=""
      sources={[source]}
      onOpen={() => undefined}
      onShowSource={() => undefined}
      onContinueRevision={() => undefined}
    />)

    expect(markup).toContain('景点 · 东城区')
    expect(markup).not.toContain('片区 · 东城区')
    expect(markup).not.toContain('class="plan-stop-evidence evidence-sourced"')
    expect(markup).toContain('<summary>详情</summary>')
    expect(markup.match(/已关联来源/g)).toHaveLength(1)
    expect(markup).toContain('<p class="plan-option-stop-note">从午门入场</p>')
    expect(markup).not.toContain('<strong>安排说明</strong>')
  })

  it('允许历史草案折叠，仅将当前方案的首日作为默认展开项', () => {
    const renderDay = (openByDefault: boolean) => renderToStaticMarkup(<PlanDayDisclosure
      day={itineraryDay}
      index={0}
      lodgingLocation=""
      sources={[]}
      onOpen={() => undefined}
      onShowSource={() => undefined}
      openByDefault={openByDefault}
    />)

    expect(renderDay(true)).toContain('<details class="plan-day-disclosure" open="">')
    expect(renderDay(false)).toContain('<details class="plan-day-disclosure">')
  })

  it('将地点和餐休时段对齐显示，并明确标出缺少时间的项目', () => {
    const incompleteDay = {
      ...itineraryDay,
      stops: [{ ...firstStop, time: '' }],
      scheduleBlocks: [{ ...lunchBlock, time: '' }]
    }
    const markup = renderToStaticMarkup(<PlanDaySchedulePreview
      day={incompleteDay}
      lodgingLocation=""
      sources={[]}
      onOpen={() => undefined}
      onShowSource={() => undefined}
    />)

    expect(markup).toContain('class="plan-option-stop-time is-pending">时段待补</span>')
    expect(markup).toContain('class="plan-option-stop-title">故宫博物院</span>')
    expect(markup).toContain('class="plan-option-schedule-time is-pending">时段待补</span>')
  })

  it('固定地点仍允许在后面加地点，但不提供更改自身字段的入口', () => {
    const lockedDay = {
      ...itineraryDay,
      stops: [{ ...firstStop, locked: true }]
    }
    const markup = renderToStaticMarkup(<PlanDaySchedulePreview
      day={lockedDay}
      lodgingLocation=""
      sources={[]}
      onOpen={() => undefined}
      onShowSource={() => undefined}
      onContinueRevision={() => undefined}
    />)

    expect(markup).toContain('固定地点不能直接更名、删除或调整时段')
    expect(markup).toContain('在后面加地点')
    expect(markup).not.toContain('换地点</button>')
    expect(markup).not.toContain('>改时段</button>')
    expect(markup).not.toContain('改停留时长')
    expect(markup).not.toContain('改名称</button>')
    expect(markup).not.toContain('移除此项</button>')
    expect(markup).not.toContain('在前面加地点')
    expect(markup).not.toContain('调整位置')
    expect(markup).not.toContain('移到另一天')
  })

  it('餐馆与条件备选分别提供精确修改入口', () => {
    const mealStop: ItineraryStop = {
      ...firstStop, id: 'meal-1', name: '护国寺小吃（北京西站店）', category: '餐饮',
      conditionalAlternatives: [{ name: '附近室内餐馆', area: '西站', trigger: '下雨', evidenceLevel: 'pending', sourceIds: [] }]
    }
    const day = { ...itineraryDay, stops: [mealStop], scheduleBlocks: [] }
    const markup = renderToStaticMarkup(<PlanDaySchedulePreview
      day={day} lodgingLocation="" sources={[]} onOpen={() => undefined} onShowSource={() => undefined}
      onContinueRevision={() => undefined}
    />)
    expect(markup).toContain('换餐馆')
    expect(markup).toContain('改备选地点')
    expect(markup).toContain('核对预约与门票')
    expect(stopRevisionSuggestion(day, mealStop, 'restaurant')).toContain('保留餐次与原定用餐时段')
    expect(stopRevisionSuggestion(day, mealStop, 'alternative')).toContain('保留正式行程与其他日期')
    expect(scheduleBlockRevisionSuggestion(itineraryDay, lunchBlock, 'restaurant')).toContain('不重复保留同一餐的时间块')
  })

  it('每种修改提示都写明目标范围和需要用户补充的字段', () => {
    expect(dayRevisionSuggestion(itineraryDay, 'date')).toBe('只调整2026-09-26（第 3 天），其他日期和已固定安排保持不变。保留当天主题、地点和顺序，只把这一天改到指定日期。请重新核对目标日期的开放、预约、天气和交通时段。目标日期：')
    expect(dayRevisionSuggestion(itineraryDay, 'pace')).toContain('只调整2026-09-26（第 3 天）')
    expect(dayRevisionSuggestion(itineraryDay, 'theme')).toContain('只修改当天主题')
    expect(dayRevisionSuggestion(itineraryDay, 'add-stop')).toContain('在合适时段加入地点')
    expect(dayRevisionSuggestion(itineraryDay, 'order')).toContain('保留已固定地点顺序')
    expect(dayRevisionSuggestion(itineraryDay, 'sequence')).toContain('按下面列出的先后顺序安排地点')
    expect(stopRevisionSuggestion(itineraryDay, firstStop, 'duration')).toContain('只调整2026-09-26“故宫博物院”的建议停留时长')
    expect(stopRevisionSuggestion(itineraryDay, firstStop, 'area')).toContain('不替换地点，也不改其他安排')
    expect(stopRevisionSuggestion(itineraryDay, firstStop, 'notes')).toContain('只修改2026-09-26“故宫博物院”的安排说明')
    expect(stopRevisionSuggestion(itineraryDay, firstStop, 'add-before')).toContain('在2026-09-26“故宫博物院”之前加入一个地点')
    expect(stopRevisionSuggestion(itineraryDay, firstStop, 'add-after')).toContain('在2026-09-26“故宫博物院”之后加入一个地点')
    expect(stopRevisionSuggestion(itineraryDay, firstStop, 'move')).toContain('不新增或删除地点')
    expect(stopRevisionSuggestion(itineraryDay, firstStop, 'move-day')).toContain('移到指定日期')
    expect(stopRevisionSuggestion(itineraryDay, firstStop, 'move-day')).toContain('受影响两天')
    expect(stopRevisionSuggestion(itineraryDay, firstStop, 'transit')).toContain('从“故宫博物院”到“景山公园”')
    expect(scheduleBlockRevisionSuggestion(itineraryDay, lunchBlock, 'time')).toBe('只调整2026-09-26的“午餐”时段的开始或结束时间，保留时长和类型，保留其他字段、当天其余安排和所有其他日期，时间改为：')
    expect(scheduleBlockRevisionSuggestion(itineraryDay, lunchBlock, 'duration')).toContain('只调整2026-09-26的“午餐”时段的时长')
    expect(scheduleBlockRevisionSuggestion(itineraryDay, lunchBlock, 'kind')).toContain('类型改为：')
    expect(scheduleBlockRevisionSuggestion(itineraryDay, lunchBlock, 'title')).toContain('只修改2026-09-26的“午餐”时段的标题')
    expect(scheduleBlockRevisionSuggestion(itineraryDay, lunchBlock, 'area')).toContain('只修改2026-09-26的“午餐”时段的适用片区')
    expect(scheduleBlockRevisionSuggestion(itineraryDay, lunchBlock, 'notes')).toContain('只修改2026-09-26的“午餐”时段的说明')
    expect(scheduleBlockRevisionSuggestion(itineraryDay, lunchBlock, 'add-before')).toContain('在2026-09-26的“午餐”时段之前加入')
    expect(scheduleBlockRevisionSuggestion(itineraryDay, lunchBlock, 'add-after')).toContain('在2026-09-26的“午餐”时段之后加入')
    expect(scheduleBlockRevisionSuggestion(itineraryDay, lunchBlock, 'remove')).toContain('只从2026-09-26移除“午餐”时段')
  })

  it('住宿接驳修改精确到首末站，并保留其余计划', () => {
    const outbound = lodgingCommuteRevisionSuggestion(itineraryDay, lodgingCommute)
    expect(outbound).toContain('只调整2026-09-26（第 3 天）住宿接驳“北京西站北广场酒店 → 故宫博物院”')
    expect(outbound).toContain('当前公共交通约 45 分钟，查询时刻 07:00')
    expect(outbound).toContain('保留当天地点顺序、其他日期、预约和固定安排')
    expect(outbound).toContain('只调整受影响的时间并复核冲突')

    const returnTrip = lodgingCommuteRevisionSuggestion(itineraryDay, { ...lodgingCommute, direction: 'to-lodging', stopId: secondStop.id })
    expect(returnTrip).toContain('“景山公园 → 北京西站北广场酒店”')
    expect(returnTrip).toContain('接驳要求：')
  })

  it('拖动地点只生成限于当天的 AI 修改意见，并保留固定安排', () => {
    const suggestion = stopOrderRevisionSuggestion(itineraryDay, firstStop.id, secondStop.id, 'after')
    expect(suggestion).toContain('只调整2026-09-26（第 3 天）的地点顺序')
    expect(suggestion).toContain('将“故宫博物院”移到“景山公园”之后')
    expect(suggestion).toContain('重排受影响的时段和相邻交通')
    expect(suggestion).toContain('保留其他地点、固定安排和其他日期')

    const lockedDay = { ...itineraryDay, stops: [firstStop, { ...secondStop, locked: true }] }
    expect(stopOrderRevisionSuggestion(lockedDay, firstStop.id, secondStop.id, 'before')).toBeUndefined()
    expect(stopOrderRevisionSuggestion(itineraryDay, firstStop.id, firstStop.id, 'before')).toBeUndefined()
  })

  it('没有继续修改权限时不显示修改操作', () => {
    const markup = renderToStaticMarkup(<PlanDaySchedulePreview
      day={itineraryDay}
      lodgingLocation=""
      sources={[]}
      onOpen={() => undefined}
      onShowSource={() => undefined}
    />)

    expect(markup).not.toContain('修改当天')
    expect(markup).not.toContain('修改地点')
    expect(markup).not.toContain('修改时段')
  })
})
