/** 使用高德 Web 服务提供统一的地点候选，不跨地图产品回退。 */
import type { GeoLocation, ItineraryOption, ItineraryStop } from '../../shared/types.js'
import { createSource, requireText, ToolInputError, type ToolResult, type TravelTool } from './types.js'
import { fetchJson } from './http.js'

const AMAP_SOURCE_URL = 'https://lbs.amap.com/api/webservice/summary'
const NEARBY_RADIUS_METERS = 5_000

interface AMapPoi {
  name: string
  address?: string
  location?: string
  type?: string
}

interface AMapPlaceResponse {
  status?: string
  pois?: AMapPoi[]
}

interface NearbyAnchor {
  stop: ItineraryStop
  location: GeoLocation
}

/** 仅在高德 Web 服务凭证可用时公开地点查询工具。 */
export const placeSearchTool: TravelTool = {
  definition: {
    type: 'function',
    function: {
      name: 'find_places',
      description: '按城市和关键词查询高德地图地点候选。规划多日路线时优先查询主要景点，使用返回的名称和区域辅助分组排序；用户要求预约失败时替换地点，应查询具体候选并把返回来源 ID 写入 conditional_alternatives[].source_ids。候选名称和区域需核对后才能用于精确路线，坐标直线距离不是通勤距离或耗时。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市名称' },
          query: { type: 'string', description: '景点、餐饮或地点关键词' },
          near_stop_id: {
            type: 'string',
            description: '可选：为就近餐饮或备选活动指定当前确认行程中的高德坐标停靠点；只返回约 5 公里范围内的候选，按直线距离排序，直线距离不是通勤时间。'
          }
        },
        required: ['city', 'query'],
        additionalProperties: false
      }
    }
  },
  provider: '高德地图',
  kind: 'place',
  connector: 'places',
  sourceUrl: AMAP_SOURCE_URL,
  isAvailable: (context) => !!context.amapKey,
  /** 校验查询与可选停靠点，再调用高德返回地点候选。 */
  async execute(args, context, signal) {
    if (Object.keys(args).some((key) => !['city', 'query', 'near_stop_id'].includes(key))) {
      throw new ToolInputError('地点查询包含不支持的参数。')
    }
    const city = requireText(args, 'city', 1, 80)
    const query = requireText(args, 'query', 1, 100)
    const key = context.amapKey
    if (!key) throw new ToolInputError('请先在「连接与隐私」设置中配置高德 Web 服务 Key。')
    const anchor = args.near_stop_id === undefined
      ? undefined
      : findNearbyAnchor(context.itinerary, requireText(args, 'near_stop_id', 1, 100))
    return anchor
      ? searchAmapNearby(query, anchor.stop.name, anchor.location, key, signal)
      : searchAmap(city, query, key, signal)
  }
}

/** 按城市和关键词检索高德 POI，并保留可用于高德底图的 GCJ-02 坐标。 */
async function searchAmap(city: string, query: string, key: string, signal?: AbortSignal): Promise<ToolResult> {
  const params = new URLSearchParams({
    keywords: query,
    city,
    citylimit: 'true',
    output: 'JSON',
    offset: '8',
    page: '1',
    key
  })
  const response = await fetchJson<AMapPlaceResponse>('https://restapi.amap.com/v3/place/text?' + params, signal)
  if (response.status !== '1') throw new Error('高德地点服务暂时不可用。')
  const pois = response.pois ?? []
  const candidates = pois.map((poi) => ({ poi, point: parseCoordinatePair(poi.location) }))
  const sources = candidates.map(({ poi, point }) => createSource(
    candidateTitle(poi.name),
    'https://ditu.amap.com/search?query=' + encodeURIComponent(poi.name),
    '高德地图',
    'place',
    [poi.address, poi.type, point ? '高德坐标 ' + point.longitude + ',' + point.latitude : '']
      .filter(Boolean).join('；'),
    'success',
    point ? amapLocation(point, candidateTitle(poi.name)) : undefined
  ))
  const output = candidates.map(({ poi, point }) =>
    candidateTitle(poi.name) +
    (poi.address ? '｜' + poi.address : '') +
    (poi.type ? '｜' + poi.type : '') +
    (point ? '｜高德坐标 ' + point.longitude + ',' + point.latitude : '')
  )
  return {
    output: output.length
      ? '高德地图找到 ' + output.length + ' 个候选；地点仍需核对名称和区域：\n' + output.join('\n')
      : '高德地图没有找到“' + city + ' ' + query + '”候选。',
    sources
  }
}

/** 使用固定公开地点测试高德 Web 服务 Key，不写入旅行来源。 */
export async function testAmapWebService(apiKey: string, signal?: AbortSignal): Promise<number> {
  const result = await searchAmap('北京', '故宫博物院', apiKey, signal)
  return result.sources.filter((source) => source.status === 'success').length
}

/** 使用已确认停靠点的高德坐标查询附近 POI，不转换或混用其他坐标系。 */
async function searchAmapNearby(
  query: string,
  stopName: string,
  location: GeoLocation,
  key: string,
  signal?: AbortSignal
): Promise<ToolResult> {
  const center = { longitude: location.longitude, latitude: location.latitude }
  const params = new URLSearchParams({
    keywords: query,
    location: center.longitude.toFixed(6) + ',' + center.latitude.toFixed(6),
    radius: String(NEARBY_RADIUS_METERS),
    sortrule: 'distance',
    output: 'JSON',
    offset: '8',
    page: '1',
    key
  })
  const response = await fetchJson<AMapPlaceResponse>('https://restapi.amap.com/v3/place/around?' + params, signal)
  if (response.status !== '1') throw new Error('高德周边地点服务暂时不可用。')
  const candidates = (response.pois ?? []).flatMap((poi) => {
    const point = parseCoordinatePair(poi.location)
    if (!point) return []
    const distanceMeters = calculateDistanceMeters(center, point)
    return distanceMeters <= NEARBY_RADIUS_METERS ? [{ poi, point, distanceMeters }] : []
  }).sort((left, right) => left.distanceMeters - right.distanceMeters)
  const sources = candidates.map(({ poi, point, distanceMeters }) => createSource(
    candidateTitle(poi.name),
    'https://ditu.amap.com/search?query=' + encodeURIComponent(poi.name),
    '高德地图',
    'place',
    [poi.address, poi.type, '距' + stopName + '约 ' + formatDistance(distanceMeters) + ' 直线距离',
      '高德坐标 ' + point.longitude + ',' + point.latitude].filter(Boolean).join('；'),
    'success',
    amapLocation(point, candidateTitle(poi.name))
  ))
  return {
    output: candidates.length
      ? '高德地图在“' + stopName + '”周边 ' + (NEARBY_RADIUS_METERS / 1_000) +
        ' 公里内找到 ' + candidates.length + ' 个候选，按直线距离由近到远排列。直线距离不是步行或驾车通勤时间，地点类别和口味仍需核实：\n' +
        candidates.map(({ poi, distanceMeters }) =>
          candidateTitle(poi.name) + '｜直线约 ' + formatDistance(distanceMeters) +
          (poi.address ? '｜' + poi.address : '') + (poi.type ? '｜' + poi.type : '')
        ).join('\n')
      : '高德地图在“' + stopName + '”周边 ' + (NEARBY_RADIUS_METERS / 1_000) +
        ' 公里内没有返回带有效坐标的“' + query + '”候选。',
    sources
  }
}

/** 手动定位也只查询高德，并把服务返回坐标标记为 GCJ-02。 */
export async function searchMapPlaces(city: string, query: string, key: string, signal?: AbortSignal): Promise<ToolResult> {
  const checkedCity = requireText({ city }, 'city', 1, 80)
  const checkedQuery = requireText({ query }, 'query', 1, 180)
  if (!key.trim()) throw new Error('请先在「连接与隐私」设置中配置高德 Web 服务 Key。')
  return searchAmap(checkedCity, checkedQuery, key.trim(), signal)
}

/** 仅在当前确认行程中找到唯一且已使用高德坐标的停靠点时提供附近查询。 */
function findNearbyAnchor(itinerary: ItineraryOption | undefined, stopId: string): NearbyAnchor {
  const matches = itinerary?.days.flatMap((day) => day.stops.filter((stop) => stop.id === stopId)) ?? []
  if (matches.length !== 1) throw new ToolInputError('就近搜索必须引用当前确认行程中唯一存在的停靠点。')
  const stop = matches[0]
  if (!stop.location || stop.location.coordinateSystem !== 'gcj02') {
    throw new ToolInputError('该停靠点没有可用于高德地图的坐标；请先在地图中重新定位，或改用区域描述搜索。')
  }
  return { stop, location: stop.location }
}

/** 严格解析高德经纬度，忽略空值、非数字和越界坐标。 */
function parseCoordinatePair(value: string | undefined): { longitude: number; latitude: number } | undefined {
  if (!value) return undefined
  const [longitudeText, latitudeText, ...extra] = value.split(',')
  const longitude = Number(longitudeText)
  const latitude = Number(latitudeText)
  if (extra.length || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
    !Number.isFinite(latitude) || latitude < -90 || latitude > 90) return undefined
  return { longitude, latitude }
}

/** 为地图坐标明确标注高德使用的 GCJ-02 坐标系。 */
function amapLocation(point: { longitude: number; latitude: number }, label: string): GeoLocation {
  return { latitude: point.latitude, longitude: point.longitude, label, coordinateSystem: 'gcj02' }
}

/** 限制候选标题长度，完整地址仍保留在来源摘要中。 */
function candidateTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** 用 Haversine 计算地表直线距离；只用于候选排序，不代表道路或通勤距离。 */
function calculateDistanceMeters(
  left: Pick<GeoLocation, 'latitude' | 'longitude'>,
  right: Pick<GeoLocation, 'latitude' | 'longitude'>
): number {
  const radians = Math.PI / 180
  const latitudeDelta = (right.latitude - left.latitude) * radians
  const longitudeDelta = (right.longitude - left.longitude) * radians
  const latitudeLeft = left.latitude * radians
  const latitudeRight = right.latitude * radians
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeLeft) * Math.cos(latitudeRight) * Math.sin(longitudeDelta / 2) ** 2
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine)))
}

/** 给候选来源使用短距离格式，避免把直线距离误读为路线耗时。 */
function formatDistance(meters: number): string {
  return meters >= 1_000 ? (meters / 1_000).toFixed(1) + ' 公里' : meters + ' 米'
}
