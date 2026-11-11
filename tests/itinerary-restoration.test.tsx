/** 验证历史版本恢复只修改用户选中的草稿内容并保持结构约束。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  itineraryRestorationSelectionError,
  listItineraryRestorableChanges,
  listItineraryRestorableFields,
  restoreItineraryChanges,
  restoreItineraryFields
} from '../src/shared/itinerary-restoration.js'
import type { ItineraryOption, ItineraryRevision } from '../src/shared/types.js'
import { ItineraryHistoryRestorer } from '../src/renderer/src/ItineraryHistoryRestorer'

/** 创建带地点、来源和独立时段的测试行程。 */
function makeItinerary(values: { suffix: string; stopId?: string; name?: string; locked?: boolean }): ItineraryOption {
  return {
    id: `plan-${values.suffix}`, title: `方案 ${values.suffix}`, summary: `摘要 ${values.suffix}`, tradeoffs: `取舍 ${values.suffix}`,
    days: [{
      id: `day-${values.suffix}`, dayNumber: 1, date: `2026-10-${values.suffix === 'old' ? '18' : '19'}`,
      title: `主题 ${values.suffix}`, scheduleBlocks: [{
        id: `block-${values.suffix}`, kind: 'meal', title: '午餐', time: values.suffix === 'old' ? '12:00' : '12:30',
        durationMinutes: 60, area: '東城', notes: `时段说明 ${values.suffix}`
      }],
      stops: [{
        id: values.stopId ?? `stop-${values.suffix}`, name: values.name ?? '故宫', area: values.suffix === 'old' ? '东城区' : '东城',
        time: values.suffix === 'old' ? '上午' : '09:00', durationMinutes: 60, category: '人文',
        notes: `地点说明 ${values.suffix}`, transitToNext: `交通 ${values.suffix}`,
        sourceIds: [`source-${values.suffix}`], evidenceLevel: 'sourced',
        location: {
          latitude: 39.9163, longitude: 116.3972, coordinateSystem: 'gcj02', label: '故宫',
          sourceId: `place-${values.suffix}`, provider: 'amap', fetchedAt: '2026-10-19T00:00:00.000Z'
        },
        ...(values.locked ? { locked: true } : {})
      }]
    }]
  }
}

describe('历史行程恢复', () => {
  it('只把选择的字段写入草稿，并保留其他改动与证据引用', () => {
    const current = makeItinerary({ suffix: 'new' })
    const historical = makeItinerary({ suffix: 'old' })
    const fields = listItineraryRestorableFields(current, historical)
    const selected = ['plan:summary', 'day:1:title', 'stop:stop-new:notes']
    const restored = restoreItineraryFields(current, historical, selected)

    expect(restored.summary).toBe('摘要 old')
    expect(restored.title).toBe('方案 new')
    expect(restored.days[0].title).toBe('主题 old')
    expect(restored.days[0].date).toBe('2026-10-19')
    expect(restored.days[0].stops[0].notes).toBe('地点说明 old')
    expect(restored.days[0].stops[0].area).toBe('东城')
    expect(restored.days[0].stops[0].sourceIds).toEqual(['source-new'])
    expect(restored.days[0].stops[0].location?.sourceId).toBe('place-new')
    expect(current.summary).toBe('摘要 new')
    expect(fields).toContainEqual(expect.objectContaining({
      id: 'stop:stop-new:notes', currentValue: '地点说明 new', historicalValue: '地点说明 old'
    }))
  })

  it('按规范化地点名称匹配不同版本生成的临时 ID，并支持恢复时段字段', () => {
    const current = makeItinerary({ suffix: 'new', stopId: 'generated-new' })
    const historical = makeItinerary({ suffix: 'old', stopId: 'generated-old' })
    const fields = listItineraryRestorableFields(current, historical)
    const area = fields.find((field) => field.label.includes('· 区域'))
    const blockTime = fields.find((field) => field.id === 'schedule:block-new:time')

    expect(area?.restoreValue).toBe('东城区')
    expect(blockTime?.historicalValue).toBe('12:00')
    const restored = restoreItineraryFields(current, historical, [area!.id, blockTime!.id])
    expect(restored.days[0].stops[0].area).toBe('东城区')
    expect(restored.days[0].scheduleBlocks[0].time).toBe('12:00')
  })

  it('不允许通过历史恢复绕过已固定地点的名称、时段和日期限制', () => {
    const current = makeItinerary({ suffix: 'new', stopId: 'locked-stop', locked: true })
    const historical = makeItinerary({ suffix: 'old', stopId: 'locked-stop', name: '故宫博物院' })
    const fields = listItineraryRestorableFields(current, historical, ['locked-stop'])
    const name = fields.find((field) => field.id === 'stop:locked-stop:name')
    const stopTime = fields.find((field) => field.id === 'stop:locked-stop:time')
    const date = fields.find((field) => field.id === 'day:1:date')
    const restored = restoreItineraryFields(current, historical, [name!.id, stopTime!.id, date!.id], ['locked-stop'])

    expect(name?.disabledReason).toContain('固定安排')
    expect(stopTime?.disabledReason).toContain('固定安排')
    expect(date?.disabledReason).toContain('固定安排')
    expect(restored.days[0].date).toBe(current.days[0].date)
    expect(restored.days[0].stops[0].name).toBe('故宫')
    expect(restored.days[0].stops[0].time).toBe('09:00')
  })

  it('在草稿中显示历史版本选择、字段前后值和不保存说明', () => {
    const current = makeItinerary({ suffix: 'new' })
    const historical = makeItinerary({ suffix: 'old' })
    const revision: ItineraryRevision = {
      id: 'revision-old', number: 1, createdAt: '2026-10-18T00:00:00.000Z', summary: '方案 old',
      content: '', sourceIds: [], itinerary: historical
    }
    const markup = renderToStaticMarkup(<ItineraryHistoryRestorer itinerary={current} revisions={[revision]} protectedStopIds={[]} onApply={() => undefined} />)

    expect(markup).toContain('从历史版本恢复行程')
    expect(markup).toContain('当前：摘要 new')
    expect(markup).toContain('历史：摘要 old')
    expect(markup).toContain('旧地点恢复后会重新核对来源、事实和定位')
    expect(markup).toContain('交通说明只恢复文字')
    expect(markup).toContain('应用所选')
  })

  it('按项恢复已删除地点并移除本次新增地点，同时清除旧地点证据和定位', () => {
    const current = makeItinerary({ suffix: 'new', name: '天坛' })
    const historical = makeItinerary({ suffix: 'old', name: '故宫' })
    current.days[0]!.stops[0]!.factClaims = [{
      id: 'claim-current', type: 'opening-hours', value: '08:30–17:00', scope: '每日', evidenceLevel: 'sourced', sourceId: 'source-new'
    }]
    historical.days[0]!.stops[0]!.factClaims = [{
      id: 'claim-old', type: 'opening-hours', value: '08:30–17:00', scope: '每日', evidenceLevel: 'sourced', sourceId: 'source-old'
    }]
    const changes = listItineraryRestorableChanges(current, historical)
    const remove = changes.find((change) => change.id === 'stop:remove:stop-new')
    const add = changes.find((change) => change.id === 'stop:add:stop-old')

    expect(remove?.label).toContain('移除本次新增地点')
    expect(add?.label).toBe('恢复地点：故宫')
    const restored = restoreItineraryChanges(current, historical, [remove!.id, add!.id], [], () => 'restored-stop')

    expect(restored.days[0]!.stops).toHaveLength(1)
    expect(restored.days[0]!.stops[0]).toMatchObject({
      id: 'restored-stop', name: '故宫', evidenceLevel: 'pending', sourceIds: [], factClaims: [], transitToNext: '交通 old'
    })
    expect(restored.days[0]!.stops[0]!.location).toBeUndefined()
    expect(restored.days[0]!.stops[0]!.transitEstimate).toBeUndefined()
    expect(current.days[0]!.stops[0]!.name).toBe('天坛')
  })

  it('只恢复选中地点的顺序并清除目的地已变化的路线估算', () => {
    const current = makeItinerary({ suffix: 'new', name: '景山' })
    const stopA = current.days[0]!.stops[0]!
    const stopB = { ...structuredClone(stopA), id: 'stop-b', name: '故宫', sourceIds: ['source-new'] }
    stopA.transitToNext = '步行 10 分钟'
    stopA.transitEstimate = {
      sourceId: 'route-current', destinationStopId: stopB.id, mode: 'walking', fetchedAt: '2026-10-19T00:00:00.000Z',
      optionNumber: 1, durationMinutes: 10, distanceMeters: 800
    }
    current.days[0]!.stops = [stopA, stopB]
    const historical = structuredClone(current)
    historical.days[0]!.stops = [structuredClone(stopB), structuredClone(stopA)]
    const changes = listItineraryRestorableChanges(current, historical)
    const positionChanges = changes.filter((change) =>
      change.changeType === 'structure' && change.path.kind === 'stop-position')

    expect(positionChanges).toHaveLength(1)
    const restored = restoreItineraryChanges(current, historical, [positionChanges[0]!.id], [], () => 'unused')
    expect(restored.days[0]!.stops.map((stop) => stop.name)).toEqual(['故宫', '景山'])
    expect(restored.days[0]!.stops[1]!.transitToNext).toBe('')
    expect(restored.days[0]!.stops[1]!.transitEstimate).toBeUndefined()
  })

  it('按项恢复历史用餐时段并移除本次新增时段', () => {
    const current = makeItinerary({ suffix: 'new' })
    current.days[0]!.scheduleBlocks[0]!.title = '晚餐'
    const historical = makeItinerary({ suffix: 'old' })
    const changes = listItineraryRestorableChanges(current, historical)
    const remove = changes.find((change) => change.id === 'schedule:remove:block-new')
    const add = changes.find((change) => change.id === 'schedule:add:block-old')

    expect(remove?.label).toBe('移除本次新增时段：晚餐')
    expect(add?.label).toBe('恢复时段：午餐')
    const restored = restoreItineraryChanges(current, historical, [remove!.id, add!.id], [], () => 'restored-block')
    expect(restored.days[0]!.scheduleBlocks).toEqual([{
      id: 'restored-block', kind: 'meal', title: '午餐', time: '12:00',
      durationMinutes: 60, area: '東城', notes: '时段说明 old'
    }])
  })

  it('恢复早餐和休息地点时保留首末实体地点的住宿接驳', () => {
    const current = makeItinerary({ suffix: 'new' })
    const day = current.days[0]!
    day.lodgingCommutes = [
      { direction: 'from-lodging', lodgingLocation: '王府井酒店', stopId: 'stop-new', sourceId: 'route-in', mode: 'walking', optionNumber: 1, durationMinutes: 20 },
      { direction: 'to-lodging', lodgingLocation: '王府井酒店', stopId: 'stop-new', sourceId: 'route-out', mode: 'walking', optionNumber: 1, durationMinutes: 20 }
    ]
    const historical = structuredClone(current)
    historical.days[0]!.stops.unshift({
      ...structuredClone(day.stops[0]!), id: 'breakfast-old', name: '早餐', category: '早餐'
    })
    historical.days[0]!.stops.push({
      ...structuredClone(day.stops[0]!), id: 'rest-old', name: '午休', category: '休息'
    })
    const changes = listItineraryRestorableChanges(current, historical)
    const breakfast = changes.find((change) => change.id === 'stop:add:breakfast-old')
    const rest = changes.find((change) => change.id === 'stop:add:rest-old')

    let nextId = 0
    const restored = restoreItineraryChanges(current, historical, [breakfast!.id, rest!.id], [], () => `restored-stop-${++nextId}`)

    expect(restored.days[0]!.lodgingCommutes).toEqual(day.lodgingCommutes)
  })

  it('恢复跨日移动时要求同时恢复缺失目标日，并将旧地点依据降为待核验', () => {
    const current = makeItinerary({ suffix: 'new', stopId: 'moved-stop', name: '故宫' })
    const historical = structuredClone(current)
    historical.days[0]!.stops = []
    historical.days.push({
      id: 'day-old-2', dayNumber: 2, date: '2026-10-20', title: '景山与北海',
      stops: [structuredClone(current.days[0]!.stops[0]!)], scheduleBlocks: []
    })
    const changes = listItineraryRestorableChanges(current, historical)
    const dayAdd = changes.find((change) => change.id === 'day:add:2')
    const move = changes.find((change) =>
      change.changeType === 'structure' && change.path.kind === 'stop-position' && change.path.stopId === 'moved-stop')

    expect(itineraryRestorationSelectionError(current, changes, [move!.id])).toContain('恢复第 2 天')
    const restored = restoreItineraryChanges(current, historical, [dayAdd!.id, move!.id], [], () => 'restored-day')
    expect(restored.days.map((day) => day.dayNumber)).toEqual([1, 2])
    expect(restored.days[1]).toMatchObject({ id: 'restored-day', date: '2026-10-20', title: '景山与北海' })
    expect(restored.days[1]!.stops[0]).toMatchObject({ id: 'moved-stop', name: '故宫', evidenceLevel: 'pending', sourceIds: [], factClaims: [] })
    expect(restored.days[0]!.stops).toHaveLength(0)
  })

  it('固定地点所在日期不能整体移除，重复名称也不会被猜测匹配', () => {
    const current = makeItinerary({ suffix: 'new', locked: true })
    current.days.push({
      id: 'day-current-2', dayNumber: 2, date: '2026-10-20', title: '重复到访',
      stops: [{ ...structuredClone(current.days[0]!.stops[0]!), id: 'duplicate-current', locked: true }],
      scheduleBlocks: []
    })
    const historical = makeItinerary({ suffix: 'old', locked: true })
    const changes = listItineraryRestorableChanges(current, historical, ['locked-stop', 'duplicate-current'])
    const removeDay = changes.find((change) => change.id === 'day:remove:2')
    expect(removeDay?.disabledReason).toContain('固定地点')

    const duplicateCurrent = makeItinerary({ suffix: 'new', stopId: 'current-1', name: '故宫' })
    duplicateCurrent.days[0]!.stops.push({ ...structuredClone(duplicateCurrent.days[0]!.stops[0]!), id: 'current-2' })
    const duplicateHistory = structuredClone(duplicateCurrent)
    duplicateHistory.days[0]!.stops[0]!.id = 'historical-1'
    duplicateHistory.days[0]!.stops[1]!.id = 'historical-2'
    const duplicateChanges = listItineraryRestorableChanges(duplicateCurrent, duplicateHistory)
    const ambiguous = duplicateChanges.find((change) =>
      change.changeType === 'structure' && change.path.kind === 'ambiguous' && change.path.itemType === 'stop')
    expect(ambiguous?.disabledReason).toContain('无法安全判断')
    expect(duplicateChanges.some((change) => change.id === 'stop:add:duplicate-history')).toBe(false)
  })

  it('超过系统补齐后的每日地点数量上限时阻止恢复选择', () => {
    const current = makeItinerary({ suffix: 'new' })
    const historical = structuredClone(current)
    current.days[0]!.stops = Array.from({ length: 17 }, (_, index) => ({
      ...structuredClone(current.days[0]!.stops[0]!), id: 'current-' + index, name: '当前地点 ' + index
    }))
    historical.days[0]!.stops = [{ ...structuredClone(current.days[0]!.stops[0]!), id: 'historical-only', name: '历史地点' }]
    const changes = listItineraryRestorableChanges(current, historical)
    const add = changes.find((change) => change.id === 'stop:add:historical-only')

    expect(itineraryRestorationSelectionError(current, changes, [add!.id])).toContain('超过 17 个地点')
  })
})
