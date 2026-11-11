/** 验证行程地点重新定位后不会沿用旧路线来源。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ItineraryDay, ItineraryLocation, ItineraryOption, ItineraryStop } from '../src/shared/types.js'
import { clearStaleRouteEvidence } from '../src/main/persistence/schema.js'
import { TripStore } from '../src/main/persistence.js'

const temporaryDirectories: string[] = []

/** 给存储集成回归创建隔离目录，结束后删除测试数据。 */
async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tripwise-route-evidence-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** 为路线失效回归构造带有精确地点来源的测试停靠点。 */
function stop(id: string, name: string, sourceId: string, latitude: number): ItineraryStop {
  const location: ItineraryLocation = {
    latitude,
    longitude: 116.3,
    label: name,
    coordinateSystem: 'gcj02',
    sourceId,
    provider: '高德地图',
    fetchedAt: '2026-10-25T00:00:00.000Z'
  }
  return {
    id,
    name,
    area: '海淀区',
    time: '09:00',
    durationMinutes: 60,
    category: '人文',
    notes: '',
    transitToNext: `高德路线来源 ${id}`,
    sourceIds: [sourceId, `route-${id}`],
    transitEstimate: {
      sourceId: `route-${id}`,
      destinationStopId: `${id}-next`,
      mode: 'transit',
      fetchedAt: '2026-10-25T00:00:00.000Z',
      optionNumber: 1,
      queryDate: '2026-09-22',
      queryTime: '9-00',
      durationMinutes: 30
    },
    location
  }
}

/** 构造三站线路及两端住宿路线，覆盖站内和日边界路线。 */
function itinerary(): ItineraryOption {
  const stops = [
    stop('a', '清华大学', 'place-a', 39.999),
    stop('b', '北京大学', 'place-b', 39.986),
    stop('c', '圆明园', 'place-c', 40.008)
  ]
  stops[0]!.transitEstimate!.destinationStopId = 'b'
  stops[1]!.transitEstimate!.destinationStopId = 'c'
  stops[2]!.transitEstimate = undefined
  stops[2]!.transitToNext = ''
  const day: ItineraryDay = {
    id: 'day-1', dayNumber: 1, date: '2026-09-22', title: '海淀校园', stops, scheduleBlocks: [],
    lodgingCommutes: [
      { direction: 'from-lodging', lodgingLocation: '北京西站附近酒店', stopId: 'a', sourceId: 'route-hotel-a', mode: 'transit', optionNumber: 1, durationMinutes: 30 },
      { direction: 'to-lodging', lodgingLocation: '北京西站附近酒店', stopId: 'c', sourceId: 'route-c-hotel', mode: 'transit', optionNumber: 1, durationMinutes: 30 }
    ]
  }
  return { id: 'plan', title: '北京行程', summary: '海淀一日', tradeoffs: '', days: [day] }
}

describe('地图重新定位后的路线证据', () => {
  it('同名地点坐标变化时清除相邻路线和对应来源引用', () => {
    const previous = itinerary()
    const edited = structuredClone(previous)
    const middleStop = edited.days[0]!.stops[1]!
    middleStop.location = { ...middleStop.location!, latitude: 39.975, sourceId: 'place-b-branch' }

    const result = clearStaleRouteEvidence(edited, previous, '北京西站附近酒店') as ItineraryOption
    const [first, relocated] = result.days[0]!.stops

    expect(first!.transitEstimate).toBeUndefined()
    expect(first!.transitToNext).toBe('')
    expect(first!.sourceIds).not.toContain('route-a')
    expect(relocated!.transitEstimate).toBeUndefined()
    expect(relocated!.transitToNext).toBe('')
    expect(relocated!.sourceIds).not.toContain('route-b')
    expect(relocated!.location).toMatchObject({ latitude: 39.975, sourceId: 'place-b-branch' })
    expect(result.days[0]!.lodgingCommutes).toHaveLength(2)
  })

  it('首站位置变化时清除绑定到旧首站的住宿接驳', () => {
    const previous = itinerary()
    const edited = structuredClone(previous)
    edited.days[0]!.stops[0]!.location = {
      ...edited.days[0]!.stops[0]!.location!, latitude: 40.02, sourceId: 'place-a-new'
    }

    const result = clearStaleRouteEvidence(edited, previous, '北京西站附近酒店') as ItineraryOption

    expect(result.days[0]!.lodgingCommutes).toBeUndefined()
  })

  it('加入早餐和休息项时保留绑定在首末实体地点的住宿接驳', () => {
    const previous = itinerary()
    const edited = structuredClone(previous)
    const day = edited.days[0]!
    day.stops = [
      { id: 'breakfast', name: '早餐', area: '海淀区', time: '08:00', durationMinutes: 30, category: '早餐', notes: '', transitToNext: '' },
      ...day.stops,
      { id: 'rest', name: '午休', area: '海淀区', time: '13:00', durationMinutes: 60, category: '休息', notes: '', transitToNext: '' }
    ]

    const result = clearStaleRouteEvidence(edited, previous, '北京西站附近酒店') as ItineraryOption

    expect(result.days[0]!.lodgingCommutes).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: 'from-lodging', stopId: 'a' }),
      expect.objectContaining({ direction: 'to-lodging', stopId: 'c' })
    ]))
  })

  it('同一 POI 仅刷新显示标签和获取时间时保留有效路线', () => {
    const previous = itinerary()
    const edited = structuredClone(previous)
    edited.days[0]!.stops[1]!.location = {
      ...edited.days[0]!.stops[1]!.location!,
      label: '北京大学（更新的显示名称）',
      fetchedAt: '2026-09-21T00:00:00.000Z'
    }

    const result = clearStaleRouteEvidence(edited, previous, '北京西站附近酒店') as ItineraryOption

    expect(result.days[0]!.stops[0]!.transitEstimate?.sourceId).toBe('route-a')
    expect(result.days[0]!.stops[1]!.transitEstimate?.sourceId).toBe('route-b')
    expect(result.days[0]!.lodgingCommutes).toHaveLength(2)
  })

  it('只改坐标并保存时撤下旧地点事实和旧路线，不影响原版本', async () => {
    const store = new TripStore(await createTemporaryDirectory())
    await store.initialize()
    await store.createTrip({ destination: '北京', startDate: '2026-09-22', endDate: '2026-09-22' })
    const trip = store.snapshot().trips[0]!
    const fetchedAt = '2026-10-25T00:00:00.000Z'
    await store.saveSources(trip.id, [
      ...[
        ['place-a', '清华大学', 39.999],
        ['place-b', '北京大学', 39.986],
        ['place-b-new', '北京大学', 39.975]
      ].map(([id, title, latitude]) => ({
        id: String(id), title: String(title), url: `https://ditu.amap.com/search?query=${String(id)}`, provider: '高德地图',
        kind: 'place' as const, summary: String(title), fetchedAt, status: 'success' as const, contentLevel: 'structured' as const,
        location: { latitude: Number(latitude), longitude: 116.3, label: String(title), coordinateSystem: 'gcj02' as const }
      })),
      {
        id: 'route-ab', title: '清华大学 → 北京大学', url: 'https://ditu.amap.com/direction', provider: '高德地图路线规划',
        kind: 'route', summary: '公共交通，方案 1，估算约 30 分钟', fetchedAt, status: 'success'
      }
    ])
    const first = stop('a', '清华大学', 'place-a', 39.999)
    first.time = '08:00'
    first.transitToNext = '公共交通约 30 分钟'
    first.sourceIds = ['place-a', 'route-ab']
    first.transitEstimate = {
      sourceId: 'route-ab', destinationStopId: 'b', mode: 'transit', fetchedAt,
      optionNumber: 1, queryDate: '2026-09-22', queryTime: '9-00', durationMinutes: 30
    }
    const second = stop('b', '北京大学', 'place-b', 39.986)
    second.time = '10:00'
    second.transitToNext = ''
    delete second.transitEstimate
    second.sourceIds = ['place-b']
    second.factClaims = [{
      id: 'old-opening', type: 'opening-hours', value: '08:00–17:00', scope: '', evidenceLevel: 'sourced', sourceId: 'place-b'
    }]
    const option: ItineraryOption = {
      id: 'relocation-plan', title: '海淀一日', summary: '清华与北大', tradeoffs: '',
      days: [{ id: 'relocation-day', dayNumber: 1, date: '2026-09-22', title: '海淀校园', stops: [first, second], scheduleBlocks: [] }]
    }
    await store.appendMessage(trip.id, {
      id: 'relocation-proposal', role: 'assistant', content: '海淀一日', createdAt: fetchedAt,
      sourceIds: ['place-a', 'place-b', 'route-ab'], itineraryOptions: [option]
    })
    await store.saveRevision(trip.id, 'relocation-proposal', option.id)
    const originalRevision = store.snapshot().trips[0]!.revisions[0]!
    const edited = structuredClone(originalRevision.itinerary!)
    edited.days[0]!.stops[1]!.location = {
      ...edited.days[0]!.stops[1]!.location!, latitude: 39.975, sourceId: 'place-b-new'
    }

    await store.saveEditedRevision(trip.id, originalRevision.id, edited)

    const saved = store.snapshot().trips[0]!
    expect(saved.revisions).toHaveLength(2)
    expect(saved.revisions[0]!.itinerary!.days[0]!.stops[0]!.transitEstimate?.sourceId).toBe('route-ab')
    expect(saved.revisions[1]!.itinerary!.days[0]!.stops[0]!.transitToNext).toBe('')
    expect(saved.revisions[1]!.itinerary!.days[0]!.stops[0]!.sourceIds).not.toContain('route-ab')
    expect(saved.revisions[1]!.itinerary!.days[0]!.stops[0]!.transitEstimate).toBeUndefined()
    expect(saved.revisions[1]!.itinerary!.days[0]!.stops[1]).toMatchObject({
      evidenceLevel: 'pending', sourceIds: [], factClaims: [], location: { sourceId: 'place-b-new', latitude: 39.975 }
    })
  })
})
