/** 为隔离桌面验收返回高德 Web 服务兼容响应，不将模拟值用于真实行程。 */

interface AmapMockResult {
  operation: string
  response: Response
}

/** 只接管高德域名；其他网络请求和未知高德接口均不会被伪造成功。 */
export function amapE2eMockResponse(input: RequestInfo | URL): AmapMockResult | null {
  const value = input instanceof URL ? input.toString()
    : typeof input === 'string' ? input : input.url
  const url = new URL(value)
  if (url.hostname !== 'restapi.amap.com') return null

  const name = url.searchParams.get('keywords') || url.searchParams.get('address') || '北京地点'
  if (url.pathname === '/v3/place/text' || url.pathname === '/v3/place/around') {
    return result('route_poi_search', {
      status: '1', infocode: '10000', count: '1', pois: [{
        id: `E2E-${stableHash(name)}`, name, location: mockCoordinate(name), citycode: '010',
        adname: '北京市', address: '北京市（模拟地点）'
      }]
    })
  }
  if (url.pathname === '/v3/geocode/geo') {
    return result('geocode', {
      status: '1', infocode: '10000', geocodes: [{
        location: mockCoordinate(name), citycode: '010', formatted_address: '北京市（模拟地址）', level: '兴趣点'
      }]
    })
  }
  if (url.pathname === '/v3/geocode/regeo') {
    return result('reverse_geocode', {
      status: '1', infocode: '10000', regeocode: { addressComponent: {
        province: '北京市', city: '北京市', citycode: '010'
      } }
    })
  }
  if (url.pathname === '/v5/direction/transit/integrated') {
    return result('route_transit', {
      status: '1', infocode: '10000', route: { transits: [{
        cost: { duration: '1800', transit_fee: '4' }, distance: '4200',
        segments: [{ walking: { distance: '350' }, bus: { buslines: [{ name: '地铁 4 号线（模拟）' }] } }]
      }] }
    })
  }
  if (url.pathname === '/v5/direction/walking') {
    return result('route_walking', {
      status: '1', infocode: '10000', route: { paths: [{
        cost: { duration: '1200' }, distance: '1500'
      }] }
    })
  }
  if (url.pathname === '/v5/direction/driving') {
    return result('route_driving', {
      status: '1', infocode: '10000', route: { paths: [{
        cost: { duration: '1200', tolls: '0' }, distance: '1500'
      }] }
    })
  }
  return result('unsupported_mock_endpoint', { status: '0', infocode: '10001' })
}

/** 按地点名生成稳定坐标，仅用于字段与路线绑定测试。 */
function mockCoordinate(name: string): string {
  const hash = stableHash(name)
  const longitude = 116.2 + (hash % 3000) / 10_000
  const latitude = 39.8 + ((hash >>> 8) % 3000) / 10_000
  return `${longitude.toFixed(6)},${latitude.toFixed(6)}`
}

/** 生成稳定的 32 位测试哈希。 */
function stableHash(value: string): number {
  return [...value].reduce((result, character) => (result * 31 + character.charCodeAt(0)) >>> 0, 7)
}

/** 构造高德 Web 服务使用的 JSON 响应外壳。 */
function result(operation: string, payload: unknown): AmapMockResult {
  return {
    operation,
    response: new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
  }
}
