/** 验证路线修订后的信息保全和草案持久化边界。 */
import { describe, expect, it } from 'vitest'
import type { ItineraryOption, ItineraryStop } from '../src/shared/types.js'
import { choosePersistableItineraryOptions, preserveRouteIndependentEvidence } from '../src/main/agent-itinerary-policy.js'
import { isItineraryOption, itineraryOptionFailureStage } from '../src/main/persistence/schema.js'

/** 构造验证路线来源移除时的两站行程。 */
function option(id: string, from: ItineraryStop, to: ItineraryStop): ItineraryOption {
  return {
    id,
    title: '北京一日行程',
    summary: '游览海淀片区。',
    tradeoffs: '',
    days: [{
      id: `day-${id}`,
      dayNumber: 1,
      date: '2026-09-22',
      title: '海淀',
      scheduleBlocks: [],
      stops: [from, to]
    }]
  }
}

/** 构造字段完整的地点，避免测试依赖模型输出。 */
function stop(id: string, name: string): ItineraryStop {
  return {
    id, name, area: '海淀', time: '09:00–10:00', durationMinutes: 60,
    category: '景点', notes: '', transitToNext: '', evidenceLevel: 'pending', sourceIds: []
  }
}

describe('行程修订的持久化边界', () => {
  it('为无效候选提供不含行程内容的结构类别', () => {
    const first = stop('duplicate-id', '清华大学')
    first.factClaims = [{
      id: first.id, type: 'opening-hours', value: '开放时间待核验', scope: '2026-09-22', evidenceLevel: 'pending'
    }]
    const candidate = option('candidate', first, stop('to-candidate', '北京大学'))

    expect(itineraryOptionFailureStage(candidate)).toBe('duplicate_ids')
    expect(isItineraryOption(candidate)).toBe(false)
  })

  it('移除旧路线来源后，不保留没有地点来源支撑的 sourced 状态', () => {
    const first = stop('from-old', '清华大学')
    first.evidenceLevel = 'sourced'
    first.sourceIds = ['route-source-old']
    first.transitToNext = '公共交通约 10 分钟。'
    first.transitEstimate = {
      sourceId: 'route-source-old', destinationStopId: 'to-old', mode: 'transit',
      fetchedAt: '2026-09-21T08:00:00.000Z', optionNumber: 1, durationMinutes: 10
    }
    const previous = option('old', first, stop('to-old', '北京大学'))
    const replacement = option('new', stop('from-new', '清华大学'), stop('to-new', '北京大学'))

    expect(isItineraryOption(previous)).toBe(true)
    const [revised] = preserveRouteIndependentEvidence([previous], [replacement])

    expect(revised?.days[0]?.stops[0]).toMatchObject({ evidenceLevel: 'pending', sourceIds: [] })
    expect(isItineraryOption(revised)).toBe(true)
  })

  it('紧凑路线修订保留原有备注和非路线待核验事实', () => {
    const previousStop = stop('from-old', '清华大学')
    previousStop.notes = '按预约时段从西门进入。'
    previousStop.factClaims = [{
      id: 'pending-hours', type: 'opening-hours', value: '开放时间待核验', scope: '2026-09-22',
      evidenceLevel: 'pending'
    }, {
      id: 'stale-route-time', type: 'transport-time', value: '旧路线约 10 分钟', scope: '清华大学到北京大学',
      evidenceLevel: 'pending'
    }]
    const previous = option('old', previousStop, stop('to-old', '北京大学'))
    const replacement = option('new', stop('from-new', '清华大学'), stop('to-new', '北京大学'))

    const [revised] = preserveRouteIndependentEvidence([previous], [replacement])

    expect(revised?.days[0]?.stops[0]).toMatchObject({
      notes: '按预约时段从西门进入。',
      factClaims: [{ type: 'opening-hours', value: '开放时间待核验', evidenceLevel: 'pending' }]
    })
    expect(revised?.days[0]?.stops[0]?.factClaims).not.toContainEqual(expect.objectContaining({ type: 'transport-time' }))
    expect(isItineraryOption(revised)).toBe(true)
  })

  it('合并来源事实时修复重复事实 ID，避免路线候选落入 stop_facts 校验失败', () => {
    const previousStop = stop('from-old', '清华大学')
    previousStop.factClaims = [{
      id: 'shared-fact', type: 'opening-hours', value: '开放时间待核验', scope: '2026-09-22', evidenceLevel: 'pending'
    }]
    const incomingStop = stop('from-new', '清华大学')
    incomingStop.factClaims = [{
      id: 'shared-fact', type: 'booking', value: '预约规则待核验', scope: '预约', evidenceLevel: 'pending'
    }]
    const previous = option('old', previousStop, stop('to-old', '北京大学'))
    const replacement = option('new', incomingStop, stop('to-new', '北京大学'))

    const [revised] = preserveRouteIndependentEvidence([previous], [replacement])
    const factClaims = revised?.days[0]?.stops[0]?.factClaims ?? []

    expect(factClaims).toHaveLength(2)
    expect(new Set(factClaims.map((claim) => claim.id)).size).toBe(2)
    expect(isItineraryOption(revised)).toBe(true)
  })

  it('新修订无效时保留上一版可持久化草案', () => {
    const previous = option('previous', stop('from-previous', '清华大学'), stop('to-previous', '北京大学'))
    const invalid = structuredClone(previous)
    invalid.days[0]!.stops[0]!.evidenceLevel = 'sourced'
    invalid.days[0]!.stops[0]!.sourceIds = []

    const result = choosePersistableItineraryOptions([previous], [invalid])

    expect(result.accepted).toBe(false)
    expect(result.options).toEqual([previous])
    expect(isItineraryOption(result.options[0])).toBe(true)
  })
})
