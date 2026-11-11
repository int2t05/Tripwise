/** 验证高德失败日志只记录接口类别、错误码和 HTTP 状态。 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/system-logger.js', () => ({
  classifyError: vi.fn(() => 'network_error'),
  safeTransportErrorCode: vi.fn(() => undefined),
  logSystemEvent: vi.fn()
}))

import { logSystemEvent } from '../src/main/system-logger.js'
import { executeTool } from '../src/main/tools.js'
import { routeTool } from '../src/main/connectors/routes.js'
import { createAmapRouteCircuitBreaker } from '../src/main/connectors/types.js'
import type { ItineraryOption, TripBrief } from '../src/shared/types.js'

/** 构造一段明确的同日相邻公共交通计划，用于验证路线工具前置条件。 */
function plannedCampusRoute(): ItineraryOption {
  return {
    id: 'plan-campus-route', title: '海淀校园', summary: '', tradeoffs: '',
    days: [{
      id: 'day-campus-route', dayNumber: 1, date: '2026-11-03', title: '校园', scheduleBlocks: [],
      stops: [
        {
          id: 'stop-tsinghua', name: '清华大学', area: '海淀区', time: '09:00', durationMinutes: 30,
          category: '景点', notes: '', transitToNext: '公共交通前往北京大学；耗时待核验。',
          evidenceLevel: 'pending', sourceIds: [], factClaims: []
        },
        {
          id: 'stop-peking', name: '北京大学', area: '海淀区', time: '10:00', durationMinutes: 30,
          category: '景点', notes: '', transitToNext: '', evidenceLevel: 'pending', sourceIds: [], factClaims: []
        }
      ]
    }]
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.mocked(logSystemEvent).mockClear()
})

describe('高德路线失败诊断', () => {
  it('行程路线复核在提交候选前返回 warning，不请求地图服务', async () => {
    let requestCount = 0
    vi.stubGlobal('fetch', async () => {
      requestCount += 1
      throw new Error('unexpected route request')
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '清华大学', destination: '北京大学', mode: 'transit', date: '2026-11-03'
    }), { amapKey: 'fixture-key', detailedItineraryRequested: true, routeCoverageRequested: true })

    expect(requestCount).toBe(0)
    expect(result.feedback).toContainEqual(expect.objectContaining({
      severity: 'warning', code: 'route_plan_not_submitted'
    }))
  })

  it('候选计划没有该相邻路段时返回 warning，不请求地图服务', async () => {
    let requestCount = 0
    vi.stubGlobal('fetch', async () => {
      requestCount += 1
      throw new Error('unexpected route request')
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '清华大学', destination: '圆明园', mode: 'transit', date: '2026-11-03'
    }), {
      amapKey: 'fixture-key', routeCoverageRequested: true, itineraryOptions: [plannedCampusRoute()]
    })

    expect(requestCount).toBe(0)
    expect(result.feedback).toContainEqual(expect.objectContaining({
      severity: 'warning', code: 'route_segment_not_planned',
      message: expect.stringContaining('清华大学 → 北京大学')
    }))
  })

  it('区分路线工具参数拒绝与高德服务错误', async () => {
    const result = await executeTool('estimate_route', '{}', { amapKey: 'fixture-key' })

    expect(result.routeFailureKind).toBe('input_error')
    expect(result.sources).toEqual([])
  })

  it('未配置高德凭证时将路线请求标为工具不可用', async () => {
    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '清华大学', destination: '北京大学', mode: 'transit'
    }), { amapKey: null })

    expect(result.routeFailureKind).toBe('tool_unavailable')
    expect(result.sources).toEqual([])
  })

  it('区分连接器异常与高德返回的明确服务错误', async () => {
    vi.spyOn(routeTool, 'execute').mockRejectedValue(new Error('private connector failure'))

    const traceId = '550e8400-e29b-41d4-a716-446655440000'
    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '清华大学', destination: '北京大学', mode: 'transit'
    }), { amapKey: 'fixture-key', traceId })

    expect(result.routeFailureKind).toBe('connector_error')
    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'error' })
  })

  it('原始地点地理编码无精确结果时回退到同城唯一精确 POI', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname.endsWith('/geocode/geo')) {
        return new Response(JSON.stringify({ status: '1', geocodes: [] }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      if (url.pathname === '/v3/place/text') {
        const isDestination = url.searchParams.get('keywords') === '北京大学'
        return new Response(JSON.stringify({ status: '1', pois: [{
          id: isDestination ? 'poi-peking' : 'poi-tsinghua',
          name: isDestination ? '北京大学' : '清华大学',
          location: isDestination ? '116.310,39.992' : '116.326,40.003',
          citycode: '010', adname: '海淀区'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '4200', cost: { duration: '1200' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '清华大学', destination: '北京大学', mode: 'transit', date: '2026-11-03'
    }), {
      amapKey: 'fixture-key', routeCoverageRequested: true, itineraryOptions: [plannedCampusRoute()]
    })

    expect(result.feedback ?? []).toEqual([])
    const routeRequest = requested.find((url) => url.pathname.endsWith('/direction/transit/integrated'))
    expect(requested.filter((url) => url.pathname.endsWith('/geocode/geo'))).toHaveLength(2)
    expect(requested.filter((url) => url.pathname === '/v3/place/text')).toHaveLength(2)
    expect(routeRequest?.searchParams.get('origin')).toBe('116.326,40.003')
    expect(routeRequest?.searchParams.get('destination')).toBe('116.310,39.992')
    expect(routeRequest?.searchParams.get('originpoi')).toBe('poi-tsinghua')
    expect(routeRequest?.searchParams.get('destinationpoi')).toBe('poi-peking')
    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'success' })
    expect(vi.mocked(logSystemEvent).mock.calls).toContainEqual([
      'info', 'agent.route.lookup.completed', expect.objectContaining({
        routeAttemptId: expect.stringMatching(/^[a-f0-9-]{36}$/iu),
        routeExecutionStage: 'model-tool', status: 'success', routeOptionCount: 1
      })
    ])
    expect(JSON.stringify(vi.mocked(logSystemEvent).mock.calls)).not.toContain('清华大学')
  })

  it('地理编码引擎错误时仍尝试同城精确 POI，成功后继续查询路线', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname.endsWith('/geocode/geo')) {
        return new Response(JSON.stringify({ status: '0', infocode: '30001' }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      if (url.pathname === '/v3/place/text') {
        const isDestination = url.searchParams.get('keywords') === '北京大学'
        return new Response(JSON.stringify({ status: '1', pois: [{
          id: isDestination ? 'poi-peking' : 'poi-tsinghua',
          name: isDestination ? '北京大学' : '清华大学',
          location: isDestination ? '116.310,39.992' : '116.326,40.003',
          citycode: '010', adname: '海淀区'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '4200', cost: { duration: '1200' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '清华大学', destination: '北京大学', mode: 'transit'
    }), { amapKey: 'fixture-key' })

    expect(requested.filter((url) => url.pathname.endsWith('/geocode/geo'))).toHaveLength(2)
    expect(requested.filter((url) => url.pathname === '/v3/place/text')).toHaveLength(2)
    const routeRequest = requested.find((url) => url.pathname.endsWith('/direction/transit/integrated'))
    expect(routeRequest?.searchParams.get('origin')).toBe('116.326,40.003')
    expect(routeRequest?.searchParams.get('destination')).toBe('116.310,39.992')
    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'success' })
  })

  it('原始地点回退遇到同名多坐标时拒绝随机选点', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname.endsWith('/geocode/geo')) {
        return new Response(JSON.stringify({ status: '1', geocodes: [] }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      if (url.pathname === '/v3/place/text') {
        const name = url.searchParams.get('keywords')
        const pois = name === '同名公园' ? [
          { name, location: '116.410,39.910', citycode: '010' },
          { name, location: '116.310,39.910', citycode: '010' }
        ] : [{ name, location: '116.326,40.003', citycode: '010' }]
        return new Response(JSON.stringify({ status: '1', pois }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '4200', cost: { duration: '1200' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '同名公园', destination: '清华大学', mode: 'transit'
    }), { amapKey: 'fixture-key' })

    expect(result.routeFailureKind).toBe('location_unresolved')
    expect(requested.some((url) => url.pathname.includes('/direction/'))).toBe(false)
  })

  it('城市过滤仍返回异地地理编码时拒绝规划路线', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname.endsWith('/geocode/geo')) {
        return new Response(JSON.stringify({ status: '1', geocodes: [{
          location: '106.6,30.5', citycode: '511600', formatted_address: '四川省广安市某地点', level: '兴趣点'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        cost: { duration: '32400' }, distance: '150000', segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '重庆', origin: '鹅岭贰厂文创公园', destination: '山城巷步道及十八梯街区', mode: 'transit'
    }), { amapKey: 'fixture-key' })

    expect(result.routeFailureKind).toBe('location_unresolved')
    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'partial' })
    expect(requested.some((url) => url.pathname.includes('/direction/'))).toBe(false)
  })

  it('行程端点跨城市时按全国唯一精确 POI 的真实城市码规划', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname === '/v3/place/text') {
        if (url.searchParams.get('citylimit') === 'true') {
          return new Response(JSON.stringify({ status: '1', pois: [] }), {
            status: 200, headers: { 'content-type': 'application/json' }
          })
        }
        const isAirport = url.searchParams.get('keywords') === '广州白云国际机场'
        return new Response(JSON.stringify({ status: '1', pois: [{
          id: isAirport ? 'poi-guangzhou-airport' : 'poi-guangzhou-south',
          name: isAirport ? '广州白云国际机场' : '广州南站',
          location: isAirport ? '113.298,23.392' : '113.270,23.117',
          adname: isAirport ? '白云区' : '番禺区',
          address: isAirport ? '广东省广州市白云区机场大道' : '广东省广州市番禺区广州南站'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.pathname === '/v3/geocode/regeo') {
        return new Response(JSON.stringify({ status: '1', regeocode: {
          addressComponent: { province: '广东省', city: '广州市', citycode: '020' }
        } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '38000', cost: { duration: '3600', transit_fee: '8' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '广州南站', destination: '广州白云国际机场', mode: 'transit'
    }), {
      amapKey: 'fixture-key',
      routeEndpoints: {
        originPoiName: '广州南站', originArea: '番禺区',
        destinationPoiName: '广州白云国际机场', destinationArea: '白云区'
      }
    })

    const nationwideQueries = requested.filter((url) =>
      url.pathname === '/v3/place/text' && !url.searchParams.has('city'))
    const routeRequest = requested.find((url) => url.pathname.endsWith('/direction/transit/integrated'))
    expect(nationwideQueries).toHaveLength(2)
    expect(nationwideQueries.every((url) => !url.searchParams.has('citylimit'))).toBe(true)
    expect(routeRequest?.searchParams.get('city1')).toBe('020')
    expect(routeRequest?.searchParams.get('city2')).toBe('020')
    expect(routeRequest?.searchParams.get('originpoi')).toBe('poi-guangzhou-south')
    expect(routeRequest?.searchParams.get('destinationpoi')).toBe('poi-guangzhou-airport')
    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'success' })
    expect(logSystemEvent).toHaveBeenCalledWith('info', 'amap.route.endpoint_resolution', expect.objectContaining({
      routeResolutionStage: 'exact-poi-no-city', routeResolutionStatus: 'resolved'
    }))
  })

  it('全国精确 POI 有多个坐标时继续要求用户核对', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname === '/v3/place/text') {
        const name = url.searchParams.get('keywords') ?? ''
        const isSameName = name === '同名景点'
        const pois = url.searchParams.get('citylimit') === 'true' ? [] : isSameName ? [
          { name, location: '113.200,23.100', citycode: '020', adname: '甲区' },
          { name, location: '116.200,39.900', citycode: '010', adname: '乙区' }
        ] : [{ name, location: '116.310,39.992', citycode: '010', adname: '海淀区' }]
        return new Response(JSON.stringify({ status: '1', pois }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      if (url.pathname.endsWith('/geocode/geo')) {
        return new Response(JSON.stringify({ status: '1', geocodes: [] }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '4200', cost: { duration: '1200' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '同名景点', destination: '北京大学', mode: 'transit'
    }), {
      amapKey: 'fixture-key',
      routeEndpoints: {
        originPoiName: '同名景点', originArea: '城区片区',
        destinationPoiName: '北京大学', destinationArea: '海淀片区'
      }
    })

    expect(result.routeFailureKind).toBe('location_unresolved')
    expect(requested.some((url) => url.pathname.includes('/direction/'))).toBe(false)
  })

  it('路线起终点含未确认占位时不发起网络请求', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      requested.push(String(input))
      return new Response('{}', { status: 200 })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '成都', origin: '抵达交通（地点待确认）', destination: '住宿地点（待提供）', mode: 'transit'
    }), { amapKey: 'fixture-key' })

    expect(result.output).toContain('起点或终点尚未确定')
    expect(result.sources).toEqual([])
    expect(requested).toEqual([])
  })

  it('Agent 未获用户确认时不为猜测的目的地机场发起路线请求', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      requested.push(String(input))
      return new Response('{}', { status: 200 })
    })

    const tripBrief: TripBrief = {
      departureCity: '', destination: '成都', startDate: '2026-11-05', endDate: '2026-11-07',
      arrivalFlight: '用户提供航班', arrivalTime: '22:10', leaveTime: '', travelers: '', budget: '',
      lodgingLocation: '', lodging: '', pace: '轻松', earlyStart: '', interests: '', transport: '',
      dietary: '', luggage: '', clothing: '', constraints: ''
    }
    const result = await executeTool('estimate_route', JSON.stringify({
      city: '成都', origin: '成都天府国际机场', destination: '宽窄巷子景区', mode: 'transit'
    }), {
      amapKey: 'fixture-key',
      userRequest: '我 22:10 才落地，第一晚不要安排景点；机场到住宿交通待核验。',
      tripBrief
    })

    expect(result.output).toContain('尚未确认的机场或车站')
    expect(result.sources).toEqual([])
    expect(requested).toEqual([])
  })

  it('行程路线严格匹配同城 POI 后使用坐标和成对 POI ID 规划', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname === '/v3/place/text') {
        const isOrigin = url.searchParams.get('keywords') === '清华大学'
        return new Response(JSON.stringify({ status: '1', pois: [{
          id: isOrigin ? 'poi-tsinghua' : 'poi-peking',
          name: isOrigin ? '清华大学' : '北京大学',
          location: isOrigin ? '116.326,40.003' : '116.310,39.992',
          citycode: '010', adname: '海淀区'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '4200', cost: { duration: '1200', transit_fee: '2' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '海淀 清华大学', destination: '海淀 北京大学', mode: 'transit'
    }), {
      amapKey: 'fixture-key',
      routeEndpoints: {
        originPoiName: '清华大学', originArea: '海淀片区',
        destinationPoiName: '北京大学', destinationArea: '海淀片区'
      }
    })

    const routeRequest = requested.find((url) => url.pathname.endsWith('/direction/transit/integrated'))
    expect(routeRequest?.searchParams.get('origin')).toBe('116.326,40.003')
    expect(routeRequest?.searchParams.get('destination')).toBe('116.310,39.992')
    expect(routeRequest?.searchParams.get('originpoi')).toBe('poi-tsinghua')
    expect(routeRequest?.searchParams.get('destinationpoi')).toBe('poi-peking')
    expect(routeRequest?.searchParams.get('city1')).toBe('010')
    expect(routeRequest?.searchParams.get('city2')).toBe('010')
    expect(requested.some((url) => url.pathname.endsWith('/geocode/geo'))).toBe(false)
    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'success' })
    expect(result.routeOptions?.[0]?.durationMinutes).toBe(20)
  })

  it('同城 POI 名含城市前缀时仍匹配唯一地点并规划路线', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname === '/v3/place/text') {
        const isOrigin = url.searchParams.get('keywords') === '清华大学'
        return new Response(JSON.stringify({ status: '1', pois: [{
          id: isOrigin ? 'poi-tsinghua' : 'poi-peking',
          name: isOrigin ? '北京市清华大学' : '北京市北京大学',
          location: isOrigin ? '116.326,40.003' : '116.310,39.992',
          citycode: '010', adname: '海淀区', address: '北京市海淀区'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '4200', cost: { duration: '1200' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '清华大学', destination: '北京大学', mode: 'transit'
    }), {
      amapKey: 'fixture-key',
      routeEndpoints: {
        originPoiName: '清华大学', originArea: '海淀区',
        destinationPoiName: '北京大学', destinationArea: '海淀区'
      }
    })

    const routeRequest = requested.find((url) => url.pathname.endsWith('/direction/transit/integrated'))
    expect(routeRequest?.searchParams.get('origin')).toBe('116.326,40.003')
    expect(routeRequest?.searchParams.get('destination')).toBe('116.310,39.992')
    expect(routeRequest?.searchParams.get('originpoi')).toBe('poi-tsinghua')
    expect(routeRequest?.searchParams.get('destinationpoi')).toBe('poi-peking')
    expect(routeRequest?.searchParams.get('city1')).toBe('010')
    expect(routeRequest?.searchParams.get('city2')).toBe('010')
    expect(requested.some((url) => url.pathname.endsWith('/geocode/geo'))).toBe(false)
    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'success' })
    expect(result.routeOptions?.[0]?.durationMinutes).toBe(20)
  })

  it('路线端点将拍摄注释和索道乘车说明解析为可核实 POI 名', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname === '/v3/place/text') {
        const query = url.searchParams.get('keywords') ?? ''
        const poi = query === '龙门浩老街'
          ? { id: 'poi-longmenhao', name: '重庆龙门浩老街', location: '106.589,29.539' }
          : query === '长江索道南站'
            ? { id: 'poi-cableway-south', name: '重庆长江索道南站', location: '106.591,29.542' }
            : undefined
        return new Response(JSON.stringify({ status: '1', pois: poi ? [{
          ...poi, citycode: '023', adname: '南岸区', address: '重庆市南岸区'
        }] : [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '1800', cost: { duration: '900' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '重庆', origin: '龙门浩老街（蓝调时段拍摄）', destination: '长江索道（南站乘单程至北站）', mode: 'transit'
    }), {
      amapKey: 'fixture-key',
      routeEndpoints: {
        originPoiName: '龙门浩老街（蓝调时段拍摄）', originArea: '南岸区',
        destinationPoiName: '长江索道（南站乘单程至北站）', destinationArea: '南岸区'
      }
    })

    const routeRequest = requested.find((url) => url.pathname.endsWith('/direction/transit/integrated'))
    expect(requested.filter((url) => url.pathname === '/v3/place/text')
      .map((url) => url.searchParams.get('keywords')).sort()).toEqual([
      '龙门浩老街（蓝调时段拍摄）', '龙门浩老街',
      '长江索道（南站乘单程至北站）', '长江索道南站'
    ].sort())
    expect(requested.some((url) => url.pathname.endsWith('/geocode/geo'))).toBe(false)
    expect(routeRequest?.searchParams.get('origin')).toBe('106.589,29.539')
    expect(routeRequest?.searchParams.get('destination')).toBe('106.591,29.542')
    expect(routeRequest?.searchParams.get('originpoi')).toBe('poi-longmenhao')
    expect(routeRequest?.searchParams.get('destinationpoi')).toBe('poi-cableway-south')
    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'success' })
  })

  it('复用来源引用的高德坐标并以逆地理编码校验公交城市', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname.endsWith('/geocode/regeo')) {
        return new Response(JSON.stringify({ status: '1', regeocode: {
          addressComponent: { province: '北京市', city: [], citycode: '010' }
        } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '4200', cost: { duration: '1080' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '海淀 清华大学', destination: '海淀 北京大学', mode: 'transit', date: '2026-09-22'
    }), {
      amapKey: 'fixture-key',
      routeEndpoints: {
        originPoiName: '清华大学', originArea: '海淀', destinationPoiName: '北京大学', destinationArea: '海淀',
        originLocation: {
          sourceId: 'place-tsinghua', provider: '高德地图',
          location: { latitude: 40.003, longitude: 116.326, label: '清华大学', coordinateSystem: 'gcj02' }
        },
        destinationLocation: {
          sourceId: 'place-peking', provider: '高德地图',
          location: { latitude: 39.992, longitude: 116.310, label: '北京大学', coordinateSystem: 'gcj02' }
        }
      }
    })

    expect(requested.map((url) => url.pathname)).toEqual([
      '/v3/geocode/regeo', '/v3/geocode/regeo', '/v5/direction/transit/integrated'
    ])
    const routeRequest = requested[2]!
    expect(routeRequest.searchParams.get('origin')).toBe('116.326000,40.003000')
    expect(routeRequest.searchParams.get('destination')).toBe('116.310000,39.992000')
    expect(routeRequest.searchParams.get('city1')).toBe('010')
    expect(routeRequest.searchParams.get('city2')).toBe('010')
    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'success' })
  })

  it('逆地理编码不属于目的城市时不把来源坐标发送给路线接口', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname.endsWith('/geocode/regeo')) {
        return new Response(JSON.stringify({ status: '1', regeocode: {
          addressComponent: { province: '天津市', city: [], citycode: '022' }
        } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.pathname.endsWith('/place/text')) {
        return new Response(JSON.stringify({ status: '1', pois: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', geocodes: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '海淀 清华大学', destination: '海淀 北京大学', mode: 'transit'
    }), {
      amapKey: 'fixture-key',
      routeEndpoints: {
        originPoiName: '清华大学', originArea: '海淀', destinationPoiName: '北京大学', destinationArea: '海淀',
        originLocation: {
          sourceId: 'place-tsinghua', provider: '高德地图',
          location: { latitude: 40.003, longitude: 116.326, label: '清华大学', coordinateSystem: 'gcj02' }
        },
        destinationLocation: {
          sourceId: 'place-peking', provider: '高德地图',
          location: { latitude: 39.992, longitude: 116.310, label: '北京大学', coordinateSystem: 'gcj02' }
        }
      }
    })

    expect(result.routeFailureKind).toBe('location_unresolved')
    expect(requested.some((url) => url.pathname.includes('/direction/'))).toBe(false)
  })

  it('拒绝名称相似或区域不符的 POI 坐标，转用地址解析', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname === '/v3/place/text') {
        const isDestination = url.searchParams.get('keywords') === '北京大学'
        return new Response(JSON.stringify({ status: '1', pois: [{
          id: isDestination ? 'poi-peking' : 'poi-wrong',
          name: isDestination ? '北京大学' : '清华大学附属中学',
          location: isDestination ? '116.31,39.99' : '116.4,39.9',
          citycode: '010', adname: '海淀区'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.pathname.endsWith('/geocode/geo')) {
        return new Response(JSON.stringify({ status: '1', geocodes: [{
          location: url.searchParams.get('address')?.includes('北京大学') ? '116.31,39.99' : '116.32,40.00',
          citycode: '010', formatted_address: '北京市海淀区具体地点', level: '兴趣点'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '4200', cost: { duration: '1200' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '海淀 清华大学', destination: '海淀 北京大学', mode: 'transit'
    }), {
      amapKey: 'fixture-key',
      routeEndpoints: {
        originPoiName: '清华大学', originArea: '海淀区',
        destinationPoiName: '北京大学', destinationArea: '海淀区'
      }
    })

    const routeRequest = requested.find((url) => url.pathname.endsWith('/direction/transit/integrated'))
    expect(requested.filter((url) => url.pathname.endsWith('/geocode/geo'))).toHaveLength(1)
    expect(routeRequest?.searchParams.get('origin')).toBe('116.32,40.00')
    expect(routeRequest?.searchParams.has('originpoi')).toBe(false)
    expect(routeRequest?.searchParams.has('destinationpoi')).toBe(false)
    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'success' })
  })

  it('拒绝名称完全相同但行政区域不符的 POI', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname === '/v3/place/text') {
        const isDestination = url.searchParams.get('keywords') === '北京大学'
        return new Response(JSON.stringify({ status: '1', pois: [{
          id: isDestination ? 'poi-peking' : 'poi-tsinghua-wrong-area',
          name: isDestination ? '北京大学' : '清华大学',
          location: isDestination ? '116.31,39.99' : '116.45,39.92',
          citycode: '010', adname: isDestination ? '海淀区' : '朝阳区',
          address: isDestination ? '北京市海淀区' : '北京市朝阳区'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.pathname.endsWith('/geocode/geo')) {
        return new Response(JSON.stringify({ status: '1', geocodes: [{
          location: '116.326,40.003', citycode: '010', formatted_address: '北京市海淀区清华大学', level: '兴趣点'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '4200', cost: { duration: '1200' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '海淀 清华大学', destination: '海淀 北京大学', mode: 'transit'
    }), {
      amapKey: 'fixture-key',
      routeEndpoints: {
        originPoiName: '清华大学', originArea: '海淀区',
        destinationPoiName: '北京大学', destinationArea: '海淀区'
      }
    })

    const routeRequest = requested.find((url) => url.pathname.endsWith('/direction/transit/integrated'))
    expect(requested.filter((url) => url.pathname.endsWith('/geocode/geo'))).toHaveLength(1)
    expect(routeRequest?.searchParams.get('origin')).toBe('116.326,40.003')
    expect(routeRequest?.searchParams.get('destination')).toBe('116.31,39.99')
    expect(routeRequest?.searchParams.has('originpoi')).toBe(false)
    expect(routeRequest?.searchParams.has('destinationpoi')).toBe(false)
    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'success' })
  })

  it('同名 POI 有多个位置且区域不能消歧时改用地理编码', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname === '/v3/place/text') {
        const isDestination = url.searchParams.get('keywords') === '北京大学'
        return new Response(JSON.stringify({ status: '1', pois: isDestination ? [{
          id: 'poi-peking', name: '北京大学', location: '116.31,39.99', citycode: '010', adname: '海淀区'
        }] : [
          { id: 'poi-same-east', name: '同名公园', location: '116.41,39.91', citycode: '010', adname: '东城区' },
          { id: 'poi-same-west', name: '同名公园', location: '116.31,39.91', citycode: '010', adname: '西城区' }
        ] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.pathname.endsWith('/geocode/geo')) {
        return new Response(JSON.stringify({ status: '1', geocodes: [{
          location: '116.35,39.91', citycode: '010', formatted_address: '北京市东城区同名公园', level: '兴趣点'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '4200', cost: { duration: '1200' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '市区 同名公园', destination: '海淀 北京大学', mode: 'transit'
    }), {
      amapKey: 'fixture-key',
      routeEndpoints: {
        originPoiName: '同名公园', originArea: '市区片区',
        destinationPoiName: '北京大学', destinationArea: '海淀'
      }
    })

    const routeRequest = requested.find((url) => url.pathname.endsWith('/direction/transit/integrated'))
    expect(requested.filter((url) => url.pathname.endsWith('/geocode/geo'))).toHaveLength(1)
    expect(routeRequest?.searchParams.get('origin')).toBe('116.35,39.91')
    expect(routeRequest?.searchParams.has('originpoi')).toBe(false)
    expect(routeRequest?.searchParams.has('destinationpoi')).toBe(false)
    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'success' })
  })

  it('POI 查询服务错误按服务故障记录，不伪装成地点未找到', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ status: '0', infocode: '30001' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    }))

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '海淀 清华大学', destination: '海淀 北京大学', mode: 'transit'
    }), {
      amapKey: 'fixture-key',
      routeDiagnostics: {
        traceId: '550e8400-e29b-41d4-a716-446655440000',
        attemptId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', dayNumber: 2
      },
      routeEndpoints: {
        originPoiName: '清华大学', originArea: '海淀',
        destinationPoiName: '北京大学', destinationArea: '海淀'
      }
    })

    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'error' })
    expect(result.routeFailureKind).toBe('provider_error')
    expect(result.output).toContain('地点解析服务返回错误')
    expect(vi.mocked(logSystemEvent).mock.calls).toContainEqual([
      'warn', 'amap.request.failed', expect.objectContaining({
        operation: 'route_poi_search', status: 'provider_error', errorCode: '30001',
        traceId: '550e8400-e29b-41d4-a716-446655440000',
        routeAttemptId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        routeDayNumber: 2, routeExecutionStage: 'model-tool', routePointRole: 'origin'
      })
    ])
    expect(vi.mocked(logSystemEvent).mock.calls).toContainEqual([
      'warn', 'amap.route.endpoint_resolution', expect.objectContaining({
        routeResolutionStage: 'exact-poi', routeResolutionStatus: 'provider_error',
        routeAttemptId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        routeDayNumber: 2, routeExecutionStage: 'model-tool', routePointRole: 'origin'
      })
    ])
    expect(JSON.stringify(vi.mocked(logSystemEvent).mock.calls)).not.toContain('清华大学')
    expect(JSON.stringify(vi.mocked(logSystemEvent).mock.calls)).not.toContain('fixture-key')
  })

  it('地理编码引擎错误保留服务错误类型并把短名重试交给模型', async () => {
    const requestedPaths: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requestedPaths.push(url.pathname)
      if (url.searchParams.get('address') === '海淀区 清华大学') {
        return new Response(JSON.stringify({ status: '0', infocode: '30001' }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({ status: '1', geocodes: [{
        location: '116.3,39.9', citycode: '010', formatted_address: '北京市海淀区地点', level: '兴趣点'
      }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '海淀区 清华大学', destination: '海淀区 北京大学', mode: 'transit'
    }), { amapKey: 'fixture-secret' })

    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'error' })
    expect(result.routeFailureKind).toBe('provider_error')
    expect(result.output).toContain('可改用更简短的地点名重试')
    expect(result.output).not.toContain('未能解析')
    expect(requestedPaths.filter((path) => path.endsWith('/geocode/geo'))).toHaveLength(2)
    expect(requestedPaths.filter((path) => path === '/v3/place/text')).toHaveLength(1)
    expect(vi.mocked(logSystemEvent).mock.calls).toContainEqual([
      'warn', 'amap.request.failed', expect.objectContaining({
        operation: 'geocode', status: 'provider_error', errorCode: '30001'
      })
    ])
    expect(JSON.stringify(vi.mocked(logSystemEvent).mock.calls)).not.toContain('清华大学')
    expect(JSON.stringify(vi.mocked(logSystemEvent).mock.calls)).not.toContain('fixture-secret')
  })

  it('城市过滤触发引擎错误后重试，但拒绝无过滤的跨城结果', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname === '/v3/place/text') {
        return new Response(JSON.stringify({ status: '1', pois: [] }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      if (url.pathname.endsWith('/geocode/geo')) {
        if (url.searchParams.has('city')) {
          return new Response(JSON.stringify({ status: '0', infocode: '30001' }), {
            status: 200, headers: { 'content-type': 'application/json' }
          })
        }
        const wrongCity = url.searchParams.get('address')?.includes('私有终点')
        return new Response(JSON.stringify({ status: '1', geocodes: [{
          location: wrongCity ? '121.4,31.2' : '116.3,39.9', citycode: wrongCity ? '021' : '010',
          formatted_address: wrongCity ? '上海市私有地点' : '北京市私有地点', level: '兴趣点'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '4200', cost: { duration: '1200' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '私有片区 私有起点', destination: '私有片区 私有终点', mode: 'transit'
    }), {
      amapKey: 'fixture-secret',
      routeDiagnostics: {
        traceId: '550e8400-e29b-41d4-a716-446655440000',
        attemptId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', dayNumber: 2
      },
      routeEndpoints: {
        originPoiName: '私有起点', originArea: '私有片区',
        destinationPoiName: '私有终点', destinationArea: '私有片区'
      }
    })

    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'error' })
    expect(result.routeFailureKind).toBe('provider_error')
    const geocodeRequests = requested.filter((url) => url.pathname.endsWith('/geocode/geo'))
    expect(geocodeRequests).toHaveLength(4)
    expect(geocodeRequests.filter((url) => url.searchParams.has('city'))).toHaveLength(2)
    expect(geocodeRequests.filter((url) => !url.searchParams.has('city'))).toHaveLength(2)
    const failures = vi.mocked(logSystemEvent).mock.calls.filter(([, event]) => event === 'amap.request.failed')
    expect(failures.map(([, , fields]) => ({ role: fields?.routePointRole, variant: fields?.routeGeocodeVariant }))).toEqual(
      expect.arrayContaining([
        { role: 'origin', variant: 'place-name' },
        { role: 'destination', variant: 'place-name' }
      ])
    )
    expect(requested.some((url) => url.pathname.includes('/direction/'))).toBe(false)
    const serializedFailures = JSON.stringify(failures)
    expect(serializedFailures).not.toContain('私有')
    expect(serializedFailures).not.toContain('fixture-secret')
  })

  it('无城市过滤返回目标城市地址时继续查询路线', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname === '/v3/place/text') {
        return new Response(JSON.stringify({ status: '1', pois: [] }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      if (url.pathname.endsWith('/geocode/geo')) {
        if (url.searchParams.has('city')) {
          return new Response(JSON.stringify({ status: '0', infocode: '30001' }), {
            status: 200, headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({ status: '1', geocodes: [{
          location: url.searchParams.get('address')?.includes('私有起点') ? '116.3,39.9' : '116.4,39.9',
          citycode: '010', formatted_address: '北京市私有地点', level: '兴趣点'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '4200', cost: { duration: '1200' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '私有片区 私有起点', destination: '私有片区 私有终点', mode: 'transit'
    }), {
      amapKey: 'fixture-secret',
      routeDiagnostics: {
        traceId: '550e8400-e29b-41d4-a716-446655440000',
        attemptId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', dayNumber: 2
      },
      routeEndpoints: {
        originPoiName: '私有起点', originArea: '私有片区',
        destinationPoiName: '私有终点', destinationArea: '私有片区'
      }
    })

    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'success' })
    expect(requested.filter((url) => url.pathname.endsWith('/geocode/geo') && !url.searchParams.has('city'))).toHaveLength(2)
    expect(requested.some((url) => url.pathname.endsWith('/direction/transit/integrated'))).toBe(true)
    expect(vi.mocked(logSystemEvent).mock.calls).toContainEqual([
      'info', 'amap.geocode.fallback_succeeded', expect.objectContaining({
        routePointRole: 'origin', routeGeocodeVariant: 'place-name-no-city'
      })
    ])
  })

  it('无城市过滤只解析到区县时不绑定粗略路线', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname === '/v3/place/text') {
        return new Response(JSON.stringify({ status: '1', pois: [] }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      if (url.pathname.endsWith('/geocode/geo')) {
        if (url.searchParams.has('city')) {
          return new Response(JSON.stringify({ status: '0', infocode: '30001' }), {
            status: 200, headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({ status: '1', geocodes: [{
          location: '116.3,39.9', citycode: '010', formatted_address: '北京市海淀区', level: '区县'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '4200', cost: { duration: '1200' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '私有片区 私有起点', destination: '私有片区 私有终点', mode: 'transit'
    }), {
      amapKey: 'fixture-secret',
      routeEndpoints: {
        originPoiName: '私有起点', originArea: '私有片区',
        destinationPoiName: '私有终点', destinationArea: '私有片区'
      }
    })

    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'error' })
    expect(requested.some((url) => url.pathname.includes('/direction/'))).toBe(false)
    expect(vi.mocked(logSystemEvent).mock.calls).not.toContainEqual([
      'info', 'amap.geocode.fallback_succeeded', expect.anything()
    ])
  })

  it('无城市过滤返回多个同城精确点时不随机选择', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname === '/v3/place/text') {
        return new Response(JSON.stringify({ status: '1', pois: [] }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      if (url.pathname.endsWith('/geocode/geo')) {
        if (url.searchParams.has('city')) {
          return new Response(JSON.stringify({ status: '0', infocode: '30001' }), {
            status: 200, headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({ status: '1', geocodes: [
          { location: '116.3,39.9', citycode: '010', formatted_address: '北京市地点甲', level: '兴趣点' },
          { location: '116.4,39.9', citycode: '010', formatted_address: '北京市地点乙', level: '兴趣点' }
        ] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '4200', cost: { duration: '1200' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '私有片区 私有起点', destination: '私有片区 私有终点', mode: 'transit'
    }), {
      amapKey: 'fixture-secret',
      routeEndpoints: {
        originPoiName: '私有起点', originArea: '私有片区',
        destinationPoiName: '私有终点', destinationArea: '私有片区'
      }
    })

    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'error' })
    expect(requested.some((url) => url.pathname.includes('/direction/'))).toBe(false)
    expect(vi.mocked(logSystemEvent).mock.calls).not.toContainEqual([
      'info', 'amap.geocode.fallback_succeeded', expect.anything()
    ])
  })

  it('安全区分起终点及详细地址和地点名地理编码失败', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname === '/v3/place/text') {
        return new Response(JSON.stringify({ status: '1', pois: [] }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      if (url.pathname.endsWith('/geocode/geo')) {
        const address = url.searchParams.get('address') ?? ''
        if (address.includes('私有区')) {
          return new Response(JSON.stringify({ status: '0', infocode: '30001' }), {
            status: 200, headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({ status: '1', geocodes: [{
          location: address.includes('私有起点') ? '116.3,39.9' : '116.4,39.9', citycode: '010',
          formatted_address: address.includes('私有起点') ? '北京市私有起点' : '北京市私有终点', level: '兴趣点'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '4200', cost: { duration: '1200' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '私有区 私有起点', destination: '私有区 私有终点', mode: 'transit'
    }), {
      amapKey: 'fixture-secret',
      routeDiagnostics: {
        traceId: '550e8400-e29b-41d4-a716-446655440000',
        attemptId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', dayNumber: 2
      },
      routeEndpoints: {
        originPoiName: '私有起点', originArea: '私有区',
        destinationPoiName: '私有终点', destinationArea: '私有区'
      }
    })

    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'success' })
    const cityFilteredAddresses = requested
      .filter((url) => url.pathname.endsWith('/geocode/geo') && url.searchParams.has('city'))
      .map((url) => url.searchParams.get('address'))
    expect(cityFilteredAddresses).toHaveLength(4)
    expect(cityFilteredAddresses).toEqual(expect.arrayContaining([
      '北京 私有区 私有起点', '北京 私有区 私有终点', '北京 私有起点', '北京 私有终点'
    ]))
    const failures = vi.mocked(logSystemEvent).mock.calls.filter(([, event]) => event === 'amap.request.failed')
    expect(failures).toHaveLength(4)
    expect(failures.map(([, , fields]) => ({
      operation: fields?.operation,
      role: fields?.routePointRole,
      variant: fields?.routeGeocodeVariant,
      errorCode: fields?.errorCode
    }))).toEqual(expect.arrayContaining([
      { operation: 'geocode', role: 'origin', variant: 'area-address', errorCode: '30001' },
      { operation: 'geocode', role: 'destination', variant: 'area-address', errorCode: '30001' },
      { operation: 'geocode', role: 'origin', variant: 'area-address-no-city', errorCode: '30001' },
      { operation: 'geocode', role: 'destination', variant: 'area-address-no-city', errorCode: '30001' }
    ]))
    const serializedFailures = JSON.stringify(failures)
    expect(serializedFailures).not.toContain('私有')
    expect(serializedFailures).not.toContain('fixture-secret')
  })

  it('规划片区只用于 POI 消歧，不拼入地理编码地址', async () => {
    const requested: URL[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      requested.push(url)
      if (url.pathname === '/v3/place/text') {
        return new Response(JSON.stringify({ status: '1', pois: [] }), {
          status: 200, headers: { 'content-type': 'application/json' }
        })
      }
      if (url.pathname.endsWith('/geocode/geo')) {
        const address = url.searchParams.get('address') ?? ''
        if (address.includes('片区')) {
          return new Response(JSON.stringify({ status: '0', infocode: '30001' }), {
            status: 200, headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({ status: '1', geocodes: [{
          location: address.includes('私有起点') ? '116.3,39.9' : '116.4,39.9',
          citycode: '010', formatted_address: `北京市${address}`, level: '兴趣点'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '1', route: { transits: [{
        distance: '4200', cost: { duration: '1200' }, segments: []
      }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '私有片区 私有起点', destination: '私有片区 私有终点', mode: 'transit'
    }), {
      amapKey: 'fixture-secret',
      routeEndpoints: {
        originPoiName: '私有起点', originArea: '私有片区',
        destinationPoiName: '私有终点', destinationArea: '私有片区'
      }
    })

    const geocodes = requested.filter((url) => url.pathname.endsWith('/geocode/geo'))
    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'success' })
    expect(geocodes.map((url) => url.searchParams.get('address'))).toEqual(['北京 私有起点', '北京 私有终点'])
    expect(geocodes.every((url) => url.searchParams.get('city') === '北京')).toBe(true)
    expect(vi.mocked(logSystemEvent).mock.calls).not.toContainEqual([
      'warn', 'amap.request.failed', expect.anything()
    ])
  })

  it('记录地理编码错误码，但不记录地点或凭证', async () => {
    let fetchCount = 0
    let resolveSecondFetch!: () => void
    const secondFetch = new Promise<void>((resolve) => { resolveSecondFetch = resolve })
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      fetchCount += 1
      const response = url.searchParams.get('address') === '私有起点'
        ? new Response(JSON.stringify({ status: '0', infocode: '30001' }), {
            status: 200, headers: { 'content-type': 'application/json' }
          })
        : new Response(JSON.stringify({ status: '1', geocodes: [{
            location: '116.4,39.9', citycode: '010', formatted_address: '北京市私有终点', level: '兴趣点'
          }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (fetchCount === 2) resolveSecondFetch()
      return response
    })

    const result = await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '私有起点', destination: '私有终点', mode: 'transit'
    }), { amapKey: 'fixture-secret' })
    await secondFetch

    expect(result.sources[0]).toMatchObject({ kind: 'route', status: 'error' })
    const failures = vi.mocked(logSystemEvent).mock.calls.filter(([, event]) => event === 'amap.request.failed')
    expect(failures).toHaveLength(1)
    expect(failures.every(([, , fields]) => fields?.operation === 'geocode' &&
      fields.status === 'provider_error' && fields.errorCode === '30001')).toBe(true)
    expect(JSON.stringify(failures)).not.toContain('私有起点')
    expect(JSON.stringify(failures)).not.toContain('fixture-secret')
  })

  it('高德额度触顶后停止本轮后续请求并保留待核验状态', async () => {
    let fetchCount = 0
    vi.stubGlobal('fetch', async () => {
      fetchCount += 1
      return new Response(JSON.stringify({ status: '0', infocode: '10003' }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    })
    const circuitBreaker = createAmapRouteCircuitBreaker()
    const args = JSON.stringify({ city: '北京', origin: '私有起点', destination: '私有终点', mode: 'transit' })
    const context = { amapKey: 'fixture-secret', amapRouteCircuitBreaker: circuitBreaker }

    const limited = await executeTool('estimate_route', args, context)
    const repeated = await executeTool('estimate_route', args, context)

    expect(circuitBreaker.quotaErrorCode).toBe('10003')
    expect(fetchCount).toBe(1)
    expect(limited.routeFailureKind).toBe('tool_unavailable')
    expect(limited.routeQuotaLimited).toBe(true)
    expect(limited.output).toContain('本轮调用限制')
    expect(repeated.routeFailureKind).toBe('tool_unavailable')
    expect(repeated.output).toContain('待核验')
    expect(vi.mocked(logSystemEvent).mock.calls).toContainEqual([
      'warn', 'amap.route.quota_limit_reached', expect.objectContaining({ errorCode: '10003' })
    ])
    expect(JSON.stringify(vi.mocked(logSystemEvent).mock.calls)).not.toContain('fixture-secret')
  })

  it('区分路线接口错误与 HTTP 错误', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/geocode/geo')) {
        return new Response(JSON.stringify({ status: '1', geocodes: [{
          location: '116.4,39.9', citycode: '010', formatted_address: '北京市景点', level: '兴趣点'
        }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ status: '0', infocode: '10021' }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    })

    await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '故宫博物院', destination: '景山公园', mode: 'transit'
    }), { amapKey: 'fixture-secret' })

    expect(vi.mocked(logSystemEvent).mock.calls).toContainEqual([
      'warn', 'amap.request.failed', expect.objectContaining({
        operation: 'route_transit', status: 'provider_error', errorCode: '10021'
      })
    ])

    vi.mocked(logSystemEvent).mockClear()
    let httpFetchCount = 0
    let resolveHttpFetches!: () => void
    const httpFetches = new Promise<void>((resolve) => { resolveHttpFetches = resolve })
    vi.stubGlobal('fetch', async () => {
      httpFetchCount += 1
      const response = new Response('', { status: 403 })
      if (httpFetchCount === 2) resolveHttpFetches()
      return response
    })
    await executeTool('estimate_route', JSON.stringify({
      city: '北京', origin: '故宫博物院', destination: '景山公园', mode: 'transit'
    }), { amapKey: 'fixture-secret' })
    await httpFetches

    expect(vi.mocked(logSystemEvent).mock.calls).toContainEqual([
      'warn', 'amap.request.failed', expect.objectContaining({
        operation: 'geocode', status: 'request_failed', httpStatus: 403
      })
    ])
    expect(JSON.stringify(vi.mocked(logSystemEvent).mock.calls)).not.toContain('fixture-secret')
  })
})
