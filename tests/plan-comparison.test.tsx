/** 验证方案对比会解释受控兴趣别名，并显示未命中的偏好。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ItineraryOption, SourceRecord, TripBrief } from '../src/shared/types.js'
import { PlanComparison, PlanOptionCard } from '../src/renderer/src/ItineraryPlans'

const brief: TripBrief = {
  departureCity: '', destination: '', startDate: '', endDate: '', arrivalFlight: '', arrivalTime: '', leaveTime: '',
  travelers: '', budget: '', lodgingLocation: '', lodging: '', pace: '', earlyStart: '', interests: '我想看枫叶和美食', transport: '',
  dietary: '', luggage: '', clothing: '', constraints: ''
}

/** 构造只用于验证方案兴趣对照的最小候选。 */
function makeOption(id: string, name: string, notes: string): ItineraryOption {
  return {
    id, title: name, summary: '', tradeoffs: '',
    days: [{
      id: `${id}-day`, dayNumber: 1, date: '', title: '第一天', scheduleBlocks: [],
      stops: [{
        id: `${id}-stop`, name, area: '', time: '', durationMinutes: null, category: '', notes, transitToNext: ''
      }]
    }]
  }
}

describe('方案比较中的兴趣依据', () => {
  it('展示别名命中词，并明确列出未命中的兴趣', () => {
    const markup = renderToStaticMarkup(<PlanComparison
      options={[makeOption('red-leaves', '香山', '秋季红叶景观'), makeOption('history', '故宫', '历史建筑')]}
      brief={brief}
      sources={[]}
    />)

    expect(markup).toContain('兴趣匹配（含常见别名）')
    expect(markup).toContain('枫叶（匹配到红叶）')
    expect(markup).toContain('未命中：美食')
    expect(markup).not.toContain('项直接匹配')
  })

  it('区分来源关联与当前可用状态，避免失败来源看起来像已核验依据', () => {
    const sourced = makeOption('sourced', '来源方案', '香山')
    sourced.days[0].stops[0].sourceIds = ['source-success']
    const unavailable = makeOption('unavailable', '待复核方案', '故宫')
    unavailable.days[0].stops[0].sourceIds = ['source-failed']
    const sources: SourceRecord[] = [
      {
        id: 'source-success', title: '可用来源', url: 'https://example.com/ok', provider: '网页搜索', kind: 'web',
        summary: '', fetchedAt: '2026-10-18T00:00:00.000Z', status: 'success'
      },
      {
        id: 'source-failed', title: '失败来源', url: 'https://example.com/fail', provider: '网页搜索', kind: 'web',
        summary: '', fetchedAt: '2026-10-18T00:00:00.000Z', status: 'error'
      }
    ]
    const markup = renderToStaticMarkup(<PlanComparison
      options={[sourced, unavailable]}
      brief={brief}
      sources={sources}
    />)

    expect(markup).toContain('来源引用')
    expect(markup).toContain('至少有一条成功来源')
    expect(markup).toContain('关联来源均需复核')
    expect(markup).toContain('成功返回不等于事实已核验')
  })
})

describe('候选行程执行细节', () => {
  it('旧日期餐次冲突持续显示为阻断项，但使用餐次说明', () => {
    const option = makeOption('meal-conflict', '北京早餐安排', '')
    option.days[0]!.date = '2026-09-22'
    option.days[0]!.stops = [
      { id: 'breakfast-1', name: '早餐店甲', area: '', time: '07:00 早餐', durationMinutes: null, category: '餐饮', notes: '', transitToNext: '' },
      { id: 'breakfast-2', name: '早餐店乙', area: '', time: '07:30 早餐', durationMinutes: null, category: '餐饮', notes: '', transitToNext: '' }
    ]
    option.mealRequirements = [{ date: '2026-09-22', slots: ['breakfast'], exclusive: true }]
    const markup = renderToStaticMarkup(<PlanOptionCard
      option={option} index={0} sources={[]} tripBrief={{ ...brief, startDate: '2026-09-22', endDate: '2026-09-22' }}
      baselineRevision={null} rejected={false} onSave={() => undefined} onReject={() => undefined}
      onOpen={() => undefined} onShowSource={() => undefined}
    />)

    expect(markup).toContain('先调整以上餐次安排，才能确认并保存这份方案')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*确认并保存/s)
  })

  it('路线估时挤出时间窗时展示来源、标出冲突并禁用确认', () => {
    const option = makeOption('route-conflict', '海淀校园行程', '')
    option.days[0]!.date = '2026-09-22'
    option.days[0]!.stops = [
      {
        id: 'tsinghua', name: '清华大学', area: '海淀', time: '09:00—10:00', durationMinutes: 60,
        category: '景点', notes: '', transitToNext: '公共交通前往北京大学，高德估算约 47 分钟；路线与当前时段冲突，调整后再确认。',
        sourceIds: ['route-conflict-source'], transitEstimate: {
          sourceId: 'route-conflict-source', destinationStopId: 'peking', mode: 'transit',
          fetchedAt: '2026-10-25T00:00:00.000Z', optionNumber: 1, queryDate: '2026-09-22',
          queryTime: '09-00', durationMinutes: 47, distanceMeters: 4_200
        }
      },
      { id: 'peking', name: '北京大学', area: '海淀', time: '10:30—12:00', durationMinutes: 90, category: '景点', notes: '', transitToNext: '' }
    ]
    const source: SourceRecord = {
      id: 'route-conflict-source', title: '清华大学 → 北京大学', url: 'https://ditu.amap.com/search?query=route',
      provider: '高德地图路线规划', kind: 'route', summary: '方案 1：约 47 分钟',
      fetchedAt: '2026-10-25T00:00:00.000Z', status: 'success', contentLevel: 'structured'
    }
    const markup = renderToStaticMarkup(<PlanOptionCard
      option={option} tripBrief={{ ...brief, startDate: '2026-09-22', endDate: '2026-09-22' }}
      index={0} sources={[source]} baselineRevision={null} rejected={false}
      onSave={() => undefined} onReject={() => undefined} onOpen={() => undefined} onShowSource={() => undefined}
    />)

    expect(markup).toContain('“清华大学”停留后还需约 47 分钟通勤')
    expect(markup).toContain('路线与当前时段冲突')
    expect(markup).toContain('先修正以上时间冲突，才能确认并保存这份方案')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*确认并保存/s)
  })

  it('在保存前展示地点执行提醒和下一段交通说明', () => {
    const option = makeOption('detail', '中轴线步行方案', '步行连接故宫与景山。')
    option.days[0].date = '2026-09-26'
    option.days[0].stops = [
      {
        id: 'forbidden-city', name: '故宫博物院', area: '东城区', time: '08:30—13:30', durationMinutes: 300,
        category: '景点', notes: '预约首场，午门入、神武门出；入场截止时间需按预约页核对。',
        transitToNext: '故宫博物院 → 景山公园：步行，路线耗时待核验。', evidenceLevel: 'pending', sourceIds: [], factClaims: []
      },
      {
        id: 'jingshan', name: '景山公园', area: '西城区', time: '14:00—14:45', durationMinutes: 45,
        category: '景点', notes: '', transitToNext: '', evidenceLevel: 'pending', sourceIds: [], factClaims: []
      }
    ]
    const markup = renderToStaticMarkup(<PlanOptionCard
      option={option}
      tripBrief={brief}
      index={0}
      sources={[]}
      baselineRevision={null}
      rejected={false}
      onSave={() => undefined}
      onReject={() => undefined}
      onOpen={() => undefined}
      onShowSource={() => undefined}
    />)

    expect(markup).toContain('预约首场，午门入、神武门出')
    expect(markup).toContain('故宫博物院 → 景山公园：步行，路线耗时待核验。')
    const routePreview = markup.match(/<div class="plan-option-transit">([\s\S]*?)<\/div>/u)?.[1] ?? ''
    expect(routePreview).toContain('<strong>景山公园</strong>')
    expect(routePreview).toContain('<small>步行 · 耗时待核验</small>')
    expect(routePreview).not.toContain('故宫博物院 → 景山公园：')
    expect(markup).toContain('首稿')
    expect(markup).toContain('待审阅')
    expect(markup).not.toContain('草案已生成')
    expect(markup).toContain('确认并保存')
  })

  it('连续修改时与上一份草案比较，并把确认作为单独动作', () => {
    const baseline = makeOption('draft-1', '北京初稿', '保留故宫。')
    const proposed = makeOption('draft-2', '北京轻松游', '压缩下午安排。')
    const markup = renderToStaticMarkup(<PlanOptionCard
      option={proposed}
      tripBrief={brief}
      index={0}
      sources={[]}
      baselineRevision={null}
      baselineOption={baseline}
      baselineLabel="与上一份草案对比"
      proposalNumber={2}
      canContinueRevision
      onContinueRevision={() => undefined}
      rejected={false}
      onSave={() => undefined}
      onReject={() => undefined}
      onOpen={() => undefined}
      onShowSource={() => undefined}
    />)

    expect(markup).toContain('第 1 轮修改')
    expect(markup).toContain('与上一份草案对比')
    expect(markup).toContain('待审阅')
    expect(markup).not.toContain('修改差异已列出')
    expect(markup).toContain('继续修改')
    expect(markup).toContain('确认并保存')
  })

  it('已有更新草案时禁用旧方案确认', () => {
    const option = makeOption('stale-draft', '较早草案', '这份方案已被新草案取代。')
    const markup = renderToStaticMarkup(<PlanOptionCard
      option={option}
      tripBrief={brief}
      index={0}
      sources={[]}
      baselineRevision={null}
      isLatestProposal={false}
      rejected={false}
      onSave={() => undefined}
      onReject={() => undefined}
      onOpen={() => undefined}
      onShowSource={() => undefined}
    />)

    expect(markup).toContain('已有新草案')
    expect(markup).toContain('旧方案已不可确认')
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*确认并保存/s)
  })

  it('显示地点片区和可能的往返，并提供单日修改入口', () => {
    const option = makeOption('geography', '上海慢行路线', '')
    option.days[0].stops = [
      { id: 'bund', name: '外滩', area: '外滩', time: '09:00–10:00', durationMinutes: 60, category: '景点', notes: '', transitToNext: '' },
      { id: 'yu-garden', name: '豫园', area: '豫园', time: '11:00–12:00', durationMinutes: 60, category: '景点', notes: '', transitToNext: '' },
      { id: 'lunch', name: '午餐', area: '外滩', time: '13:00–14:00', durationMinutes: 60, category: '餐饮', notes: '', transitToNext: '' }
    ]
    const markup = renderToStaticMarkup(<PlanOptionCard
      option={option} tripBrief={brief} index={0} sources={[]} baselineRevision={null} canContinueRevision
      rejected={false} onContinueRevision={() => undefined} onSave={() => undefined} onReject={() => undefined}
      onOpen={() => undefined} onShowSource={() => undefined}
    />)

    expect(markup).toContain('景点 · 外滩')
    expect(markup).toContain('片区顺序可复核')
    expect(markup).toContain('外滩 → 豫园 → 外滩')
    expect(markup).toContain('可能需要跨区返回')
    expect(markup).toContain('按片区调整这一天')
    expect(markup).toContain('确认并保存')
    expect(markup).not.toContain('aria-disabled="true"')
  })

  it('显示跨日同名景点并提供非阻断的复核入口', () => {
    const option = makeOption('repeated-landmark', '北京六日行程', '')
    option.days = [
      {
        ...option.days[0], dayNumber: 1, date: '2026-09-22', title: '海淀',
        stops: [{ id: 'museum-day-1', name: '中国国家博物馆', area: '天安门', time: '', durationMinutes: null, category: '景点', notes: '', transitToNext: '' }]
      },
      {
        ...option.days[0], id: 'day-2', dayNumber: 2, date: '2026-09-24', title: '市区',
        stops: [{ id: 'museum-day-2', name: '中国 国家博物馆', area: '天安门', time: '', durationMinutes: null, category: '景点', notes: '', transitToNext: '' }]
      }
    ]
    const markup = renderToStaticMarkup(<PlanOptionCard
      option={option} tripBrief={brief} index={0} sources={[]} baselineRevision={null} canContinueRevision
      rejected={false} onContinueRevision={() => undefined} onSave={() => undefined} onReject={() => undefined}
      onOpen={() => undefined} onShowSource={() => undefined}
    />)

    expect(markup).toContain('跨日重复景点')
    expect(markup).toContain('中国国家博物馆')
    expect(markup).toContain('第 1 天（2026-09-22）')
    expect(markup).toContain('第 2 天（2026-09-24）')
    expect(markup).toContain('同名地点可能是有意重访或不同展览')
    expect(markup).toContain('核对重复地点')
    expect(markup).toContain('确认并保存')
    expect(markup).not.toContain('aria-disabled="true"')
  })
})
