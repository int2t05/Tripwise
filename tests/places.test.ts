/** 验证高德地点候选的凭证边界、坐标系和附近筛选。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { placeSearchTool, searchMapPlaces } from '../src/main/connectors/places.js'
import { getToolDefinitions } from '../src/main/tools.js'
import type { ItineraryOption } from '../src/shared/types.js'

const itinerary: ItineraryOption = {
  id: 'plan-1', title: '杭州一日游', summary: '围绕西湖安排。', tradeoffs: '步行适中。',
  days: [{
    id: 'day-1', dayNumber: 1, date: '2026-10-20', title: '西湖周边',
    scheduleBlocks: [],
    stops: [{
      id: 'stop-west-lake', name: '西湖断桥', area: '西湖区', time: '10:00', durationMinutes: 60,
      category: '自然', notes: '', transitToNext: '', sourceIds: [], evidenceLevel: 'pending', factClaims: [],
      location: {
        latitude: 30.25, longitude: 120.15, label: '西湖断桥', coordinateSystem: 'gcj02',
        sourceId: 'map-source', provider: '高德地图', fetchedAt: '2026-10-18T00:00:00.000Z'
      }
    }]
  }]
}

function context(amapKey: string | null, plan = itinerary) {
  return { amapKey, itinerary: plan }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => vi.unstubAllGlobals())

describe('高德地点搜索', () => {
  it('只有配置高德 Web 服务 Key 时才向模型公开地点工具', () => {
    const settings = { webSearch: true, weather: true, places: true, routes: true }
    const withoutKey = getToolDefinitions({ amapKey: null, connectors: settings })
    const withKey = getToolDefinitions({ amapKey: 'fixture-key', connectors: settings })

    expect(withoutKey.some((tool) => tool.function.name === 'find_places')).toBe(false)
    expect(withKey.find((tool) => tool.function.name === 'find_places')?.function.parameters)
      .toMatchObject({ properties: { near_stop_id: { type: 'string' } } })
  })

  it('通过高德查询并返回 GCJ-02 位置供用户确认', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      return jsonResponse({ status: '1', pois: [
        { name: '西湖断桥', address: '杭州西湖', type: '风景名胜', location: '120.150001,30.250001' },
        { name: '没有坐标的候选', address: '杭州', type: '景点' }
      ] })
    })

    const result = await searchMapPlaces('杭州', '断桥', 'fixture-key')

    expect(requested).toHaveLength(1)
    expect(requested[0].hostname).toBe('restapi.amap.com')
    expect(requested[0].pathname).toBe('/v3/place/text')
    expect(requested[0].searchParams.get('key')).toBe('fixture-key')
    expect(result.sources.map((source) => source.title)).toEqual(['西湖断桥', '没有坐标的候选'])
    expect(result.sources[0].location).toMatchObject({
      latitude: 30.250001, longitude: 120.150001, coordinateSystem: 'gcj02'
    })
    expect(result.sources[1].location).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('fixture-key')
  })

  it('用高德坐标直接查询 5 公里范围并按直线距离排序', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      return jsonResponse({ status: '1', pois: [
        { name: '稍远咖啡', address: '杭州', location: '120.160000,30.250000' },
        { name: '近处咖啡', address: '杭州', location: '120.151000,30.250500' },
        { name: '半径外咖啡', address: '杭州', location: '120.220000,30.250000' },
        { name: '无效坐标咖啡', address: '杭州', location: '181,30.25' }
      ] })
    })

    const result = await placeSearchTool.execute({
      city: '杭州', query: '咖啡店', near_stop_id: 'stop-west-lake'
    }, context('fixture-key'))

    expect(requested).toHaveLength(1)
    expect(requested[0].pathname).toBe('/v3/place/around')
    expect(requested[0].searchParams.get('location')).toBe('120.150000,30.250000')
    expect(requested[0].searchParams.get('radius')).toBe('5000')
    expect(requested[0].searchParams.get('sortrule')).toBe('distance')
    expect(result.sources.map((source) => source.title)).toEqual(['近处咖啡', '稍远咖啡'])
    expect(result.sources.every((source) => source.location?.coordinateSystem === 'gcj02')).toBe(true)
    expect(result.output.indexOf('近处咖啡')).toBeLessThan(result.output.indexOf('稍远咖啡'))
    expect(result.output).not.toContain('半径外咖啡')
    expect(result.output).not.toContain('无效坐标咖啡')
    expect(result.output).toContain('直线距离不是步行或驾车通勤时间')
    expect(result.sources[0].summary).toContain('直线距离')
    expect(JSON.stringify(result)).not.toContain('fixture-key')
  })

  it('拒绝把旧 WGS84 坐标当成高德坐标使用', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const oldPlan = structuredClone(itinerary)
    oldPlan.days[0].stops[0].location!.coordinateSystem = 'wgs84'

    await expect(placeSearchTool.execute({
      city: '杭州', query: '咖啡店', near_stop_id: 'stop-west-lake'
    }, context('fixture-key', oldPlan))).rejects.toThrow(/重新定位/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('不在高德失败时回退到其他地图服务', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      requested.push(new URL(String(input)))
      return jsonResponse({ status: '0', info: 'SERVICE_NOT_AVAILABLE' })
    })

    await expect(searchMapPlaces('杭州', '咖啡店', 'fixture-key'))
      .rejects.toThrow(/高德地点服务暂时不可用/)
    expect(requested).toHaveLength(1)
    expect(requested[0].hostname).toBe('restapi.amap.com')
  })
})
