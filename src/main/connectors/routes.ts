/** 通过可选的高德 Web 服务估算地点之间的路线和通勤时间。 */
import { randomUUID } from 'node:crypto'
import { createAmapRouteCircuitBreaker, createSource, requireOneOf, requireText, ToolInputError, type ToolContext, type ToolResult, type TravelTool } from './types.js'
import type {
  AmapRouteCircuitBreaker, AmapRouteQuotaErrorCode, RouteRequestDiagnostics, RouteResolutionReason, RouteResolutionStage,
  RouteResolutionStatus, TrustedMapRouteEndpoint
} from './types.js'
import { fetchJson } from './http.js'
import { amapRequestScheduler } from './amap-request-scheduler.js'
import { classifyError, logSystemEvent, safeTransportErrorCode } from '../system-logger.js'
import type { RouteMode, RouteOption, RoutePathSegment } from '../../shared/types.js'
import { userConfirmedTransportHub } from '../../shared/transport-hubs.js'
import { routeTitleMatchesOrderedEndpoints } from '../../shared/preparation.js'

const ROUTE_DOCS = 'https://lbs.amap.com/api/webservice/guide/api/newroute'
const MAX_WALKING_FALLBACK_METERS = 2_500
const AMAP_ROUTE_QUOTA_ERROR_CODES = new Set<AmapRouteQuotaErrorCode>(['10003', '10004', '10010'])

/** 额度熔断会终止当前路线查询，并由工具边界转换为待核验结果。 */
class AmapRouteQuotaLimitError extends Error {
  constructor() {
    super('高德路线服务已触发本轮调用限制。')
    this.name = 'AmapRouteQuotaLimitError'
  }
}

interface AMapGeocode {
  status?: string
  infocode?: string | number
  geocodes?: Array<{ location: string; citycode?: string; formatted_address?: string; level?: string }>
}

interface AMapReverseGeocode {
  status?: string
  infocode?: string | number
  regeocode?: {
    addressComponent?: { province?: string; city?: string | string[]; citycode?: string }
  }
}

interface AMapRoutePoi {
  id?: string
  name?: string
  location?: string
  citycode?: string
  adname?: string
  address?: string
}

interface AMapRoutePoiResponse {
  status?: string
  infocode?: string | number
  pois?: AMapRoutePoi[]
}

interface AMapPath {
  duration?: string
  distance?: string
  cost?: { duration?: string; tolls?: string; transit_fee?: string }
  steps?: Array<{ polyline?: string }>
  polyline?: string
}

interface AMapTransit extends AMapPath {
  segments?: Array<{
    cost?: { transit_fee?: string }
    walking?: { distance?: string }
    bus?: { buslines?: Array<{ name?: string; polyline?: string }>; steps?: Array<{ polyline?: string; buslines?: Array<{ name?: string; polyline?: string }> }> }
    railway?: { polyline?: string; steps?: Array<{ polyline?: string }> }
    taxi?: unknown
    polyline?: string
  }>
}

interface AMapRoute {
  status?: string
  infocode?: string | number
  route?: {
    transits?: AMapTransit[]
    paths?: AMapPath[]
  }
}

/** 区分地点无结果与高德引擎错误，避免把服务异常展示成地点问题。 */
type AMapGeocodeResult =
  | { kind: 'resolved'; location: string; citycode: string; level?: string; poiId?: string }
  | { kind: 'not-found'; reason: RouteResolutionReason }
  | { kind: 'provider-error' }

const routeModes = ['transit', 'walking', 'driving'] as const satisfies readonly RouteMode[]

/** 先精确匹配 POI；未匹配时尝试地理编码和唯一 POI 回退，并记录不含地点文本的解析类别。 */
async function resolveRoutePoint(
  address: string,
  city: string,
  key: string,
  signal?: AbortSignal,
  hint?: { name: string; area: string; location?: TrustedMapRouteEndpoint },
  diagnostics?: RouteRequestDiagnostics,
  circuitBreaker?: AmapRouteCircuitBreaker
): Promise<AMapGeocodeResult> {
  let providerError = false
  if (hint?.location) {
    let sourcePoint: AMapGeocodeResult
    try {
      sourcePoint = await reverseGeocodeRouteEndpoint(hint.location, city, key, signal,
        diagnostics ? { ...diagnostics, geocodeVariant: 'source-place-coordinate' } : undefined, circuitBreaker)
    } catch (error) {
      if (signal?.aborted) throw error
      if (circuitBreaker?.quotaErrorCode) return { kind: 'provider-error' }
      sourcePoint = { kind: 'provider-error' }
    }
    logRoutePointResolution('source-coordinate', sourcePoint, diagnostics)
    if (sourcePoint.kind === 'resolved') return sourcePoint
    if (sourcePoint.kind === 'provider-error') providerError = true
  }
  if (!hint) {
    let rawInput: AMapGeocodeResult = { kind: 'provider-error' }
    try {
      rawInput = await geocodeAmap(address, city, key, signal,
        diagnostics ? { ...diagnostics, geocodeVariant: 'raw-input' } : undefined, undefined, circuitBreaker)
    } catch (error) {
      if (signal?.aborted) throw error
      if (circuitBreaker?.quotaErrorCode) return { kind: 'provider-error' }
      logRoutePointResolution('raw-input', { kind: 'provider-error' }, diagnostics)
    }
    logRoutePointResolution('raw-input', rawInput, diagnostics)
    if (rawInput.kind === 'resolved') return rawInput

    // 地理编码无精确结果或服务错误时，只接受同城唯一精确 POI，避免随机选点。
    let poi: AMapGeocodeResult
    try {
      poi = await searchExactRoutePoi(city, address, '', key, signal, diagnostics, circuitBreaker)
    } catch (error) {
      if (signal?.aborted) throw error
      if (circuitBreaker?.quotaErrorCode) return { kind: 'provider-error' }
      poi = { kind: 'provider-error' }
    }
    logRoutePointResolution('exact-poi', poi, diagnostics)
    if (poi.kind === 'resolved') return poi
    if (rawInput.kind === 'provider-error' || poi.kind === 'provider-error') return { kind: 'provider-error' }
    return rawInput
  }

  let poi: AMapGeocodeResult
  try {
    poi = await searchExactRoutePoi(city, hint.name, hint.area, key, signal, diagnostics, circuitBreaker)
  } catch (error) {
    if (signal?.aborted) throw error
    if (circuitBreaker?.quotaErrorCode) return { kind: 'provider-error' }
    poi = { kind: 'provider-error' }
  }
  logRoutePointResolution('exact-poi', poi, diagnostics)
  if (poi.kind === 'resolved' && poi.citycode) return poi
  if (poi.kind === 'provider-error') providerError = true

  // 仅在原名没有精确匹配时试有限的地点名别名；城市、片区和唯一坐标规则不变。
  if (hint && poi.kind === 'not-found' && poi.reason === 'no_exact_match') {
    for (const alias of routeEndpointNameAliases(hint.name)) {
      let aliasPoi: AMapGeocodeResult
      try {
        aliasPoi = await searchExactRoutePoi(city, alias, hint.area, key, signal, diagnostics, circuitBreaker)
      } catch (error) {
        if (signal?.aborted) throw error
        if (circuitBreaker?.quotaErrorCode) return { kind: 'provider-error' }
        aliasPoi = { kind: 'provider-error' }
      }
      logRoutePointResolution('exact-poi', aliasPoi, diagnostics)
      if (aliasPoi.kind === 'resolved' && aliasPoi.citycode) return aliasPoi
      if (aliasPoi.kind === 'provider-error') providerError = true
    }
  }

  // 行程首尾可能分属不同城市；仅在城市过滤下无精确名称时，安全检索全国唯一 POI。
  if (poi.kind === 'not-found' && poi.reason === 'no_exact_match') {
    let nationwidePoi: AMapGeocodeResult
    try {
      nationwidePoi = await searchExactRoutePoi(undefined, hint.name, hint.area, key, signal, diagnostics, circuitBreaker)
    } catch (error) {
      if (signal?.aborted) throw error
      if (circuitBreaker?.quotaErrorCode) return { kind: 'provider-error' }
      nationwidePoi = { kind: 'provider-error' }
    }
    logRoutePointResolution('exact-poi-no-city', nationwidePoi, diagnostics)
    if (nationwidePoi.kind === 'resolved' && nationwidePoi.citycode) return nationwidePoi
    if (nationwidePoi.kind === 'provider-error') providerError = true
  }

  const candidates: Array<{ query: string; variant: 'area-address' | 'place-name' }> = []
  if (hint) {
    if (hasExplicitAdministrativeArea(hint.area)) {
      candidates.push({
        query: structuredRouteAddress(city, hint.area, hint.name),
        variant: 'area-address'
      })
    }
    if (hint.name.trim()) {
      candidates.push({
        query: structuredRouteAddress(city, '', hint.name),
        variant: 'place-name'
      })
    }
  } else if (address) {
    candidates.push({ query: address, variant: 'area-address' })
  }
  for (const { query, variant } of candidates) {
    let geocode: AMapGeocodeResult
    try {
      geocode = await geocodeAmap(query, city, key, signal,
        diagnostics ? { ...diagnostics, geocodeVariant: variant } : undefined, undefined, circuitBreaker)
    } catch (error) {
      if (signal?.aborted) throw error
      if (circuitBreaker?.quotaErrorCode) return { kind: 'provider-error' }
      geocode = { kind: 'provider-error' }
    }
    logRoutePointResolution(variant, geocode, diagnostics)
    if (geocode.kind === 'resolved' && geocode.citycode) return geocode
    if (geocode.kind !== 'provider-error') continue

    providerError = true
    // 高德对部分合法地点在 city 过滤下返回通用引擎错误；仅此错误触发无过滤重试。
    const noCityVariant = `${variant}-no-city` as const
    let unfiltered: AMapGeocodeResult
    try {
      unfiltered = await geocodeAmap(query, undefined, key, signal,
        diagnostics ? { ...diagnostics, geocodeVariant: noCityVariant } : undefined, city, circuitBreaker)
    } catch (error) {
      if (signal?.aborted) throw error
      if (circuitBreaker?.quotaErrorCode) return { kind: 'provider-error' }
      unfiltered = { kind: 'provider-error' }
    }
    logRoutePointResolution(noCityVariant, unfiltered, diagnostics)
    if (unfiltered.kind === 'resolved' && unfiltered.citycode && isPreciseRouteGeocode(unfiltered.level)) {
      logSystemEvent('info', 'amap.geocode.fallback_succeeded', {
        ...routeDiagnosticFields(diagnostics ? { ...diagnostics, geocodeVariant: noCityVariant } : undefined)
      })
      return unfiltered
    }
    if (unfiltered.kind === 'provider-error') providerError = true
  }
  return providerError ? { kind: 'provider-error' } : { kind: 'not-found', reason: 'no_precise_match' }
}

/** 记录端点解析阶段和固定结果类别，不写入地点名称或坐标。 */
function logRoutePointResolution(
  stage: RouteResolutionStage,
  result: AMapGeocodeResult,
  diagnostics?: RouteRequestDiagnostics
): void {
  const status: RouteResolutionStatus = result.kind === 'provider-error' ? 'provider_error'
    : result.kind === 'not-found' ? 'not_found' : 'resolved'
  logSystemEvent(status === 'provider_error' ? 'warn' : 'info', 'amap.route.endpoint_resolution', {
    ...routeDiagnosticFields(diagnostics),
    routeResolutionStage: stage,
    routeResolutionStatus: status,
    ...(result.kind === 'not-found' ? { routeResolutionReason: result.reason } : {})
  })
}

/** 仅接受同城精确名称和唯一坐标；明确行政区冲突时拒绝 POI。 */
async function searchExactRoutePoi(
  city: string | undefined,
  name: string,
  area: string,
  key: string,
  signal?: AbortSignal,
  diagnostics?: RouteRequestDiagnostics,
  circuitBreaker?: AmapRouteCircuitBreaker
): Promise<AMapGeocodeResult> {
  const params = new URLSearchParams({ keywords: name, output: 'JSON', offset: '20', page: '1', key })
  if (city) {
    params.set('city', city)
    params.set('citylimit', 'true')
  }
  const response = await requestAmap<AMapRoutePoiResponse>(
    'route_poi_search', 'route:poi_search', `https://restapi.amap.com/v3/place/text?${params}`, signal, diagnostics, circuitBreaker
  )
  if (response.status !== '1') {
    logAmapProviderFailure('route_poi_search', response.infocode, diagnostics)
    return { kind: 'provider-error' }
  }

  const expectedName = normalizeRouteMatch(name)
  const expectedArea = normalizeRouteMatch(area)
  const namedPois = (response.pois ?? []).filter((poi) => {
    if (!routePoiNameMatches(poi.name ?? '', expectedName, city) || !parseCoordinate(poi.location)) return false
    return true
  })
  const areaMatches = expectedArea
    ? namedPois.filter((poi) => [poi.adname, poi.address]
      .some((value) => normalizeRouteMatch(value ?? '').includes(expectedArea)))
    : namedPois
  // 结构化行政区与 POI 明确冲突时拒绝；“西站片区”等规划区域名不强行映射成行政区。
  const matches = areaMatches.length || hasExplicitAdministrativeArea(area)
    ? areaMatches
    : namedPois
  const uniqueLocations = new Map(matches.map((poi) => [poi.location!, poi]))
  if (uniqueLocations.size !== 1) {
    const reason: RouteResolutionReason = namedPois.length === 0
      ? 'no_exact_match'
      : hasExplicitAdministrativeArea(area) && areaMatches.length === 0
        ? 'area_conflict'
        : 'ambiguous_match'
    return { kind: 'not-found', reason }
  }
  const poi = [...uniqueLocations.values()][0]!
  const poiCitycode = poi.citycode?.trim() ?? ''
  if (!/^\d{1,12}$/u.test(poiCitycode)) {
    const cityLookup = await reverseGeocodeLocation(
      poi.location!, city, key, signal,
      diagnostics ? { ...diagnostics, geocodeVariant: 'poi-coordinate-citycode' } : undefined, circuitBreaker
    )
    if (cityLookup.kind !== 'resolved') return cityLookup
    return { ...cityLookup, ...(poi.id ? { poiId: poi.id } : {}) }
  }
  return {
    kind: 'resolved',
    location: poi.location!,
    citycode: poiCitycode,
    ...(poi.id ? { poiId: poi.id } : {})
  }
}

/** 判断用户提供的区域是否是可与高德行政区直接比较的名称。 */
function hasExplicitAdministrativeArea(area: string): boolean {
  const normalized = normalizeRouteMatch(area)
  if (!normalized || /(?:片区|景区|园区|校区|街区|商圈)$/u.test(normalized)) return false
  return /(?:省|自治区|自治州|市|州|地区|盟|区|县|旗)$/u.test(normalized)
}

/** 只把行政区组合为结构化地址，避免把规划片区拼成无法地理编码的地址。 */
function structuredRouteAddress(city: string, area: string, name: string): string {
  const cleanCity = city.trim()
  const cleanArea = area.trim()
  const normalizedCity = normalizeRouteMatch(cleanCity)
  const cityAlreadyIncluded = !!normalizedCity && (
    normalizeRouteMatch(cleanArea).startsWith(normalizedCity) ||
    (!cleanArea && normalizeRouteMatch(name).startsWith(normalizedCity))
  )
  return [
    ...(cleanCity && !cityAlreadyIncluded ? [cleanCity] : []),
    cleanArea,
    name.trim()
  ].filter(Boolean).join(' ').slice(0, 120)
}

/** 统一名称比较规则，去除空白和标点但不把近似名称当作同一地点。 */
function normalizeRouteMatch(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase()
}

/** 去掉地点名中的拍摄说明，或从索道乘车说明提取明确的上车站点。 */
function routeEndpointNameAliases(name: string): string[] {
  const aliases = new Set<string>()
  let coreName = name.trim()
  const terminalNote = name.match(/^(.+?)[（(]([^（）()]*)[）)]$/u)
  if (terminalNote) {
    const placeName = terminalNote[1]!.trim()
    const note = terminalNote[2]!.trim()
    const station = note.match(/([东南西北]站)/u)?.[1]
    if (station && /索道|缆车/u.test(placeName) && /乘|上车|登/u.test(note)) {
      aliases.add(`${placeName}${station}`)
      coreName = placeName
    } else if (/拍摄|摄影|观景|日落|蓝调|夜景|俯拍|打卡/u.test(note)) {
      aliases.add(placeName)
      coreName = placeName
    }
  }

  // 复合停靠点包含多个地点，不能猜哪个地点才是路线端点。
  if (!/[—–/、]/u.test(name)) {
    const withoutActivity = coreName.replace(/(?:夜景)?(?:拍摄|摄影|俯拍|打卡)$/u, '').trim()
    if (withoutActivity && withoutActivity !== coreName) aliases.add(withoutActivity)
    if (withoutActivity.includes('高空观景台')) {
      aliases.add(withoutActivity.replace('高空观景台', '观景台'))
    }
  }

  return [...aliases].filter((alias) => alias && alias !== name)
}

/** 城市过滤已生效时，允许 POI 名称额外带上同城前缀；其余名称仍须完全相同。 */
function routePoiNameMatches(candidate: string, expectedName: string, city: string | undefined): boolean {
  const normalizedCandidate = normalizeRouteMatch(candidate)
  if (normalizedCandidate === expectedName) return true
  const normalizedCity = normalizeRouteMatch(city ?? '')
  if (!normalizedCity) return false
  const cityRoot = normalizedCity.replace(/市$/u, '')
  const prefixes = new Set([normalizedCity, cityRoot, `${cityRoot}市`].filter(Boolean))
  return [...prefixes].some((prefix) => normalizedCandidate.startsWith(prefix) &&
    normalizedCandidate.slice(prefix.length) === expectedName)
}

/** 无城市过滤可能命中区县中心；只接受可作为具体路线端点的高精度匹配级别。 */
function isPreciseRouteGeocode(level: string | undefined): boolean {
  return ['兴趣点', '门牌号', '门址', '公交地铁站点'].includes(level ?? '')
}

/** 校验 POI 坐标，拒绝缺项、非数字和地理范围外的值。 */
function parseCoordinate(value: string | undefined): boolean {
  return parseCoordinatePair(value) !== null
}

/** 解析有效的经纬度对，拒绝多余字段和越界值。 */
function parseCoordinatePair(value: string | undefined): [number, number] | null {
  if (!value) return null
  const [longitudeText, latitudeText, ...extra] = value.split(',')
  const longitude = Number(longitudeText)
  const latitude = Number(latitudeText)
  return extra.length === 0 && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 &&
    Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    ? [longitude, latitude]
    : null
}

/** 只在提供高德 Key 时向模型开放路线估算工具。 */
export const routeTool: TravelTool = {
  definition: {
    type: 'function',
    function: {
      name: 'estimate_route',
      description: '使用高德估算公共交通、步行或驾车路线，结果不代表实时班次。规划任务先单独提交候选，等待保存回执后再查询该日相邻停靠点；不要在同一轮同时提交计划和路线查询。候选未提交或端点不相邻时返回 warning，不请求高德。公共交通填写计划日期。起点活动有明确结束时刻时，出发时刻取结束时刻；单一开始时刻且有停留时长时按两者计算结束时刻。仅有单一时刻时使用该时刻；“上午/下午”等模糊时段省略，不要推测。成功结果会在下一次计划提交时自动绑定；占位地点或用户未确认的机场、车站不得查询。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' },
          origin: { type: 'string', description: '起点地址或地点名称' },
          destination: { type: 'string', description: '终点地址或地点名称' },
          mode: { type: 'string', enum: routeModes },
          date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: '公共交通查询日期；详细行程中必填，必须对应这段路线所在日期，格式 YYYY-MM-DD' },
          time: { type: 'string', pattern: '^(?:[01]?\\d|2[0-3])-[0-5]\\d$', description: '可选公共交通出发时刻，格式 H-MM 或 HH-MM；仅当计划起点时段明确到具体钟点时填写，模糊时段必须省略' }
        },
        required: ['city', 'origin', 'destination', 'mode'],
        additionalProperties: false
      }
    }
  },
  provider: '高德地图路线规划',
  kind: 'route',
  connector: 'routes',
  sourceUrl: ROUTE_DOCS,
  isAvailable: (context) => !!context.amapKey && !context.amapRouteCircuitBreaker?.quotaErrorCode,
  /** 校验城市、起终点和交通方式后查询高德路线。 */
  async execute(args, context, signal) {
    const city = requireText(args, 'city', 1, 80)
    const origin = requireText(args, 'origin', 1, 120)
    const destination = requireText(args, 'destination', 1, 120)
    const mode = requireOneOf(args, 'mode', routeModes)
    const date = optionalRouteDate(args.date)
    const time = optionalRouteTime(args.time)
    if ((context.detailedItineraryRequested || context.routeCoverageRequested) && mode === 'transit' && !date) {
      throw new ToolInputError(
        '详细行程中的公共交通路线必须填写对应行程日的日期。', 'route_date_required'
      )
    }
    if ([origin, destination].some(isUnresolvedRouteEndpoint)) {
      throw new ToolInputError(
        '路线起点或终点尚未确定；该段交通应保留为待核验。', 'route_endpoint_unconfirmed', 'warning'
      )
    }
    const destinationCity = context.tripBrief?.destination ?? city
    const userProvidedText = [
      context.userRequest,
      ...Object.values(context.tripBrief ?? {}).filter((value) => value !== destinationCity)
    ].filter((value): value is string => typeof value === 'string').join('\n')
    if (context.userRequest?.trim() &&
        [origin, destination].some((endpoint) => !userConfirmedTransportHub(endpoint, userProvidedText, destinationCity))) {
      throw new ToolInputError(
        '路线包含用户尚未确认的机场或车站；该段交通应保留为待核验。', 'route_hub_unconfirmed', 'warning'
      )
    }
    const planFeedback = plannedRouteSegmentFeedback(context, origin, destination, mode, date)
    if (planFeedback) return planFeedback
    if (!context.amapKey) return { output: '没有配置路线服务；请把交通时长标记为待核验。', sources: [] }
    const circuitBreaker = context.amapRouteCircuitBreaker ?? createAmapRouteCircuitBreaker()
    const diagnostics = context.routeDiagnostics ?? createRouteDiagnostics(context, date)
    const startedAt = Date.now()
    try {
      const result = await estimateRoute(
        city, origin, destination, mode, context.amapKey, date, time, signal, context.routeEndpoints, diagnostics,
        circuitBreaker
      )
      logRouteLookup(result, diagnostics, Date.now() - startedAt)
      return result
    } catch (error) {
      if (signal?.aborted) throw error
      logRouteLookupFailure(diagnostics, Date.now() - startedAt, circuitBreaker.quotaErrorCode ? 'tool_unavailable' : 'provider_error')
      throw error
    }
  }
}

/** 规划复核只查询候选中的同日相邻路段，避免生成无法绑定的路线来源。 */
function plannedRouteSegmentFeedback(
  context: ToolContext,
  origin: string,
  destination: string,
  mode: RouteMode,
  date?: string
): ToolResult | undefined {
  if (!context.routeCoverageRequested) return undefined
  const plan = context.itineraryOptions?.at(-1)
  if (!plan) {
    const message = '本轮还没有已提交的行程候选，无法将路线结果绑定到实际接驳；此次未请求高德。请先提交 propose_itineraries，再按候选查询路线。'
    return routePlanningWarning('route_plan_not_submitted', message)
  }

  const matchingDay = plan.days.find((day) => !date || day.date === date)
  const matchingSegment = matchingDay?.stops.flatMap((stop, index) => {
    const nextStop = matchingDay.stops[index + 1]
    if (!nextStop || !routeTitleMatchesOrderedEndpoints(`${origin} → ${destination}`, stop.name, nextStop.name)) return []
    return [{ stop, nextStop }]
  })[0]
  if (matchingSegment) {
    const plannedMode = routeModeFromPlanText(matchingSegment.stop.transitToNext)
    if (!plannedMode || plannedMode === mode) return undefined
    const message = `${date ? `${date} ` : ''}“${origin} → ${destination}”在候选中安排为${modeLabelForFeedback(plannedMode)}，当前查询选择${modeLabelForFeedback(mode)}；此次未请求高德。请按计划方式查询，或先修订候选。`
    return routePlanningWarning('route_mode_mismatch', message)
  }

  const alternatives = (matchingDay?.stops ?? []).slice(0, -1).flatMap((stop, index) => {
    const nextStop = matchingDay?.stops[index + 1]
    if (!nextStop || stop.transitEstimate?.destinationStopId === nextStop.id) return []
    return [`${stop.name} → ${nextStop.name}`]
  }).slice(0, 3)
  const plannedExamples = alternatives.length ? `候选中的待估路段：${alternatives.join('；')}。` : ''
  const dayLabel = date ? `${date} ` : ''
  const message = `${dayLabel}“${origin} → ${destination}”不是候选计划中的同日相邻接驳${modeLabelForFeedback(mode)}；此次未请求高德。请使用候选中的相邻地点、对应日期和计划交通方式查询，或先修订计划。${plannedExamples}`
  return routePlanningWarning('route_segment_not_planned', message)
}

/** 将路线规划前置条件作为非阻断 warning 返回给 Agent。 */
function routePlanningWarning(code: string, message: string): ToolResult {
  return { output: message, sources: [], feedback: [{ severity: 'warning', code, message }] }
}

/** 只从计划文字中读取唯一交通方式；混合接驳不推断成单一模式。 */
function routeModeFromPlanText(value: string): RouteMode | undefined {
  const modes = new Set<RouteMode>()
  if (/步行/u.test(value)) modes.add('walking')
  if (/打车|出租车|网约车|驾车|自驾/u.test(value)) modes.add('driving')
  if (/公共交通|地铁|公交|巴士|机场线|接驳/u.test(value)) modes.add('transit')
  return modes.size === 1 ? [...modes][0] : undefined
}

/** 用稳定短标签解释路线方式不匹配，不复述供应商响应。 */
function modeLabelForFeedback(mode: RouteMode): string {
  return mode === 'transit' ? '（公共交通）' : mode === 'walking' ? '（步行）' : '（驾车）'
}

/** 为模型选择的每次路线工具调用建立可跨服务请求关联的脱敏编号。 */
function createRouteDiagnostics(context: ToolContext, date?: string): RouteRequestDiagnostics {
  const startMs = context.tripBrief?.startDate
    ? Date.parse(`${context.tripBrief.startDate}T00:00:00.000Z`)
    : Number.NaN
  const visitMs = date ? Date.parse(`${date}T00:00:00.000Z`) : Number.NaN
  const dayNumber = Number.isFinite(startMs) && Number.isFinite(visitMs)
    ? Math.round((visitMs - startMs) / 86_400_000) + 1
    : undefined
  return {
    ...(context.traceId ? { traceId: context.traceId } : {}),
    attemptId: randomUUID(),
    ...(dayNumber && dayNumber > 0 && dayNumber <= 31 ? { dayNumber } : {})
  }
}

/** 汇总模型选择的路线查询结果，不写入端点文本或供应商响应原文。 */
function logRouteLookup(result: ToolResult, diagnostics: RouteRequestDiagnostics, durationMs: number): void {
  const failureKind = result.routeFailureKind ?? (result.routeOptions?.length ? undefined : 'route_data_missing')
  logSystemEvent(failureKind ? 'warn' : 'info', 'agent.route.lookup.completed', {
    ...routeDiagnosticFields(diagnostics),
    status: failureKind ?? 'success',
    ...(failureKind ? { routeFailureKind: failureKind } : {}),
    routeOptionCount: result.routeOptions?.length ?? 0,
    durationMs
  })
}

/** 记录工具异常的固定类别，供 Agent 判断是否继续尝试其他地点表达。 */
function logRouteLookupFailure(
  diagnostics: RouteRequestDiagnostics,
  durationMs: number,
  failureKind: 'provider_error' | 'tool_unavailable'
): void {
  logSystemEvent('warn', 'agent.route.lookup.completed', {
    ...routeDiagnosticFields(diagnostics),
    status: failureKind,
    routeFailureKind: failureKind,
    routeOptionCount: 0,
    durationMs
  })
}

/** 未确定占位不能作为路线查询参数。 */
function isUnresolvedRouteEndpoint(value: string): boolean {
  return /(?:待确认|待提供|待核验|待选择|待选|待定|待规划|待补|未提供)/u.test(value)
}

/** 先解析起终点坐标，再查询对应路线并生成保守的时间估算。 */
async function estimateRoute(
  city: string,
  origin: string,
  destination: string,
  mode: typeof routeModes[number],
  key: string,
  date?: string,
  time?: string,
  signal?: AbortSignal,
  routeEndpoints?: NonNullable<ToolContext['routeEndpoints']>,
  diagnostics?: RouteRequestDiagnostics,
  circuitBreaker?: AmapRouteCircuitBreaker
): Promise<ToolResult> {
  const [from, to] = await Promise.all([
    resolveRoutePoint(origin, city, key, signal, routeEndpoints && {
      name: routeEndpoints.originPoiName, area: routeEndpoints.originArea,
      ...(routeEndpoints.originLocation ? { location: routeEndpoints.originLocation } : {})
    }, diagnostics && { ...diagnostics, pointRole: 'origin' }, circuitBreaker),
    resolveRoutePoint(destination, city, key, signal, routeEndpoints && {
      name: routeEndpoints.destinationPoiName, area: routeEndpoints.destinationArea,
      ...(routeEndpoints.destinationLocation ? { location: routeEndpoints.destinationLocation } : {})
    }, diagnostics && { ...diagnostics, pointRole: 'destination' }, circuitBreaker)
  ])
  if (circuitBreaker?.quotaErrorCode) return routeQuotaLimitResult(origin, destination)
  if (from.kind === 'provider-error' || to.kind === 'provider-error') {
    const output = routeEndpoints
      ? '高德地点解析服务返回错误；请在高德地图核对对应停靠点后重试。'
      : '高德地址解析服务暂不可用；可改用更简短的地点名重试，若仍失败请在高德地图核对。'
    return {
      output,
      routeFailureKind: 'provider_error',
      sources: [createSource(`${origin} → ${destination}`, ROUTE_DOCS, '高德地图路线规划', 'route', output, 'error')]
    }
  }
  if (from.kind === 'not-found' || to.kind === 'not-found') {
    const output = routeEndpoints
      ? '高德未能精确匹配行程中的起点或终点；请在地图中确认地点后再估算路线。'
      : '高德未能解析起点或终点；请补充街区、景点全名或城市信息。'
    return {
      output,
      routeFailureKind: 'location_unresolved',
      sources: [createSource(`${origin} → ${destination}`, ROUTE_DOCS, '高德地图路线规划', 'route', output, 'partial')]
    }
  }

  const params = new URLSearchParams({ origin: from.location, destination: to.location, output: 'JSON', show_fields: 'cost,polyline', key })
  let endpoint: string
  if (mode === 'transit') {
    if (!from.citycode || !to.citycode) {
      const output = '高德未返回路线所需的城市编码；请补充更具体的地点或在高德地图核对路线。'
      return {
        output,
        routeFailureKind: 'location_unresolved',
        sources: [createSource(`${origin} → ${destination}`, ROUTE_DOCS, '高德地图路线规划', 'route', output, 'partial')]
      }
    }
    endpoint = 'https://restapi.amap.com/v5/direction/transit/integrated'
    params.set('city1', from.citycode)
    params.set('city2', to.citycode)
    if (from.poiId && to.poiId) {
      params.set('originpoi', from.poiId)
      params.set('destinationpoi', to.poiId)
    }
    params.set('AlternativeRoute', '3')
    if (date) params.set('date', date)
    if (time) params.set('time', time)
  } else {
    endpoint = `https://restapi.amap.com/v5/direction/${mode}`
    if (mode === 'walking') params.set('alternative_route', '3')
    if (from.poiId && to.poiId) {
      params.set('origin_id', from.poiId)
      params.set('destination_id', to.poiId)
    }
  }
  const result = await requestAmap<AMapRoute>(
    `route_${mode}`, `route:${mode}`, `${endpoint}?${params}`, signal, diagnostics, circuitBreaker
  )
  if (result.status !== '1') {
    logAmapProviderFailure(`route_${mode}`, result.infocode, diagnostics)
    throw new Error('高德路线服务暂时不可用。')
  }
  const options = mode === 'transit' ? result.route?.transits ?? [] : result.route?.paths ?? []
  const routeOptions = options.slice(0, 3).map((option, index) => routeOption(option, index, mode))
  const routes = routeOptions.map((option) => `方案 ${option.optionNumber}：${option.summary}`)
  const title = `${origin} → ${destination}`
  const routeUrl = `https://ditu.amap.com/search?query=${encodeURIComponent(`${origin} 到 ${destination}`)}`
  if (routes.length === 0) {
    if (mode === 'transit' && isNearRoute(from.location, to.location)) {
      const walkingOptions = await nearbyWalkingOptions(from, to, key, signal, diagnostics, circuitBreaker)
      if (walkingOptions.length > 0) {
        const walkingRoutes = walkingOptions.map((option) => `方案 ${option.optionNumber}：${option.summary}`)
        const summary = `${title}，公共交通未返回可用方案；附近路段步行估算：\n${walkingRoutes.join('\n')}\n这是路线服务的估算结果；步行入口和现场通行情况需出行当天核对。`
        return {
          output: summary,
          sources: [createSource(title, routeUrl, '高德地图路线规划', 'route', summary)],
          routeOptions: walkingOptions.map((option) => ({ ...option, mode: 'walking' }))
        }
      }
    }
    const output = '路线服务未找到可用方案；请核对地点和旅行当天的公共交通运营情况。'
    return {
      output,
      routeFailureKind: 'route_unavailable',
      sources: [createSource(title, routeUrl, '高德地图路线规划', 'route', output, 'unavailable')]
    }
  }
  const modeLabel = mode === 'transit' ? '公共交通' : mode === 'walking' ? '步行' : '驾车'
  const schedule = mode === 'transit' && date
    ? `（${date}${time ? ` ${time.replace('-', ':')}` : ''}）`
    : ''
  const summary = `${title}，${modeLabel}${schedule}估算：\n${routes.join('\n')}\n这是路线服务的估算结果；班次、施工和实时交通需在出行当日核对。`
  return {
    output: summary,
    sources: [createSource(title, routeUrl, '高德地图路线规划', 'route', summary)],
    routeOptions
  }
}

/** 仅用坐标直线距离筛选近距离回退；实际步行时间仍取自路线服务。 */
function isNearRoute(origin: string, destination: string): boolean {
  const directDistance = directDistanceMeters(origin, destination)
  return directDistance !== null && directDistance > 0 && directDistance <= MAX_WALKING_FALLBACK_METERS
}

/** 读取高德返回的步行方案；失败时保留原本“无公交方案”的结果。 */
async function nearbyWalkingOptions(
  origin: Extract<AMapGeocodeResult, { kind: 'resolved' }>,
  destination: Extract<AMapGeocodeResult, { kind: 'resolved' }>,
  key: string,
  signal?: AbortSignal,
  diagnostics?: RouteRequestDiagnostics,
  circuitBreaker?: AmapRouteCircuitBreaker
): Promise<RouteOption[]> {
  const params = new URLSearchParams({
    origin: origin.location,
    destination: destination.location,
    output: 'JSON',
    show_fields: 'cost,polyline',
    alternative_route: '3',
    key
  })
  if (origin.poiId && destination.poiId) {
    params.set('origin_id', origin.poiId)
    params.set('destination_id', destination.poiId)
  }
  const result = await requestAmap<AMapRoute>(
    'route_walking', 'route:walking', `https://restapi.amap.com/v5/direction/walking?${params}`, signal, diagnostics, circuitBreaker
  )
  if (result.status !== '1') {
    logAmapProviderFailure('route_walking', result.infocode, diagnostics)
    return []
  }
  return (result.route?.paths ?? []).slice(0, 3).map((option, index) => routeOption(option, index, 'walking'))
}

/** 只解析坐标并计算距离，用于限制备用步行路线的适用范围。 */
function directDistanceMeters(origin: string, destination: string): number | null {
  const from = parseCoordinatePair(origin)
  const to = parseCoordinatePair(destination)
  if (!from || !to) return null
  const radians = Math.PI / 180
  const latitudeDelta = (to[1] - from[1]) * radians
  const longitudeDelta = (to[0] - from[0]) * radians
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(from[1] * radians) * Math.cos(to[1] * radians) * Math.sin(longitudeDelta / 2) ** 2
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}

/** 解析地址坐标，路线服务只接收高德坐标系中的起终点。 */
async function geocodeAmap(
  address: string,
  city: string | undefined,
  key: string,
  signal?: AbortSignal,
  diagnostics?: RouteRequestDiagnostics,
  requiredCity?: string,
  circuitBreaker?: AmapRouteCircuitBreaker
): Promise<AMapGeocodeResult> {
  const params = new URLSearchParams({ address, output: 'JSON', key })
  if (city) params.set('city', city)
  const response = await requestAmap<AMapGeocode>(
    'geocode', 'geocode', `https://restapi.amap.com/v3/geocode/geo?${params}`, signal, diagnostics, circuitBreaker
  )
  if (response.status !== '1') {
    logAmapProviderFailure('geocode', response.infocode, diagnostics)
    // 高德 3xxxx 是服务引擎错误，不等同于地址无结果；仅提供有界短名称回退信号。
    if (/^3\d{4}$/u.test(String(response.infocode ?? ''))) return { kind: 'provider-error' }
    throw new Error('高德地址解析服务暂时不可用。')
  }
  const cityConstraint = normalizeRouteMatch(requiredCity ?? city ?? '')
  let geocode: NonNullable<AMapGeocode['geocodes']>[number] | undefined
  let missingReason: RouteResolutionReason = 'no_precise_match'
  if (cityConstraint) {
    const preciseCandidates = (response.geocodes ?? []).filter((candidate) => candidate.location &&
      isPreciseRouteGeocode(candidate.level))
    const preciseMatches = (response.geocodes ?? []).filter((candidate) => candidate.location &&
      normalizeRouteMatch(candidate.formatted_address ?? '').includes(cityConstraint) &&
      isPreciseRouteGeocode(candidate.level))
    const uniqueLocations = new Map(preciseMatches.map((candidate) => [candidate.location, candidate]))
    // 城市过滤只是查询提示；最终仍按地址城市和精度校验，避免把异地结果用于路线。
    if (uniqueLocations.size === 1) geocode = [...uniqueLocations.values()][0]
    else if (uniqueLocations.size > 1) missingReason = 'ambiguous_match'
    else if (preciseCandidates.length > 0 && preciseCandidates.every((candidate) =>
      !!candidate.formatted_address && !normalizeRouteMatch(candidate.formatted_address).includes(cityConstraint))) {
      missingReason = 'city_conflict'
    }
  } else {
    const preciseMatches = (response.geocodes ?? []).filter((candidate) => candidate.location && isPreciseRouteGeocode(candidate.level))
    const uniqueLocations = new Map(preciseMatches.map((candidate) => [candidate.location, candidate]))
    if (uniqueLocations.size === 1) geocode = [...uniqueLocations.values()][0]
    else if (uniqueLocations.size > 1) missingReason = 'ambiguous_match'
  }
  return geocode?.location
    ? { kind: 'resolved', location: geocode.location, citycode: geocode.citycode ?? '', level: geocode.level }
    : { kind: 'not-found', reason: missingReason }
}

/** 复用明确引用的高德 GCJ-02 地点坐标，并通过逆地理编码校验城市编码。 */
async function reverseGeocodeRouteEndpoint(
  endpoint: TrustedMapRouteEndpoint,
  requiredCity: string,
  key: string,
  signal?: AbortSignal,
  diagnostics?: RouteRequestDiagnostics,
  circuitBreaker?: AmapRouteCircuitBreaker
): Promise<AMapGeocodeResult> {
  const { location } = endpoint
  if (endpoint.provider !== '高德地图' || !endpoint.sourceId || location.coordinateSystem !== 'gcj02' ||
    !Number.isFinite(location.longitude) || !Number.isFinite(location.latitude)) {
    return { kind: 'not-found', reason: 'invalid_coordinate' }
  }
  return reverseGeocodeLocation(
    `${location.longitude.toFixed(6)},${location.latitude.toFixed(6)}`, requiredCity, key, signal, diagnostics, circuitBreaker
  )
}

/** 用高德逆地理编码补齐 POI 缺少的城市编码，并验证坐标仍在目标城市。 */
async function reverseGeocodeLocation(
  location: string,
  requiredCity: string | undefined,
  key: string,
  signal?: AbortSignal,
  diagnostics?: RouteRequestDiagnostics,
  circuitBreaker?: AmapRouteCircuitBreaker
): Promise<AMapGeocodeResult> {
  const coordinate = parseCoordinatePair(location)
  if (!coordinate) return { kind: 'not-found', reason: 'invalid_coordinate' }
  const params = new URLSearchParams({
    location: `${coordinate[0].toFixed(6)},${coordinate[1].toFixed(6)}`,
    output: 'JSON', key
  })
  const response = await requestAmap<AMapReverseGeocode>(
    'reverse_geocode', 'geocode', `https://restapi.amap.com/v3/geocode/regeo?${params}`, signal, diagnostics, circuitBreaker
  )
  if (response.status !== '1') {
    logAmapProviderFailure('reverse_geocode', response.infocode, diagnostics)
    return { kind: 'provider-error' }
  }
  const addressComponent = response.regeocode?.addressComponent
  const citycode = addressComponent?.citycode?.trim() ?? ''
  const cityValues = Array.isArray(addressComponent?.city) ? addressComponent.city : [addressComponent?.city ?? '']
  const resolvedRegion = normalizeRouteMatch([addressComponent?.province ?? '', ...cityValues].join(''))
  const cityConstraint = normalizeRouteMatch(requiredCity ?? '')
  if (!/^\d{1,12}$/u.test(citycode) || (cityConstraint && !resolvedRegion.includes(cityConstraint))) {
    return { kind: 'not-found', reason: 'city_conflict' }
  }
  return {
    kind: 'resolved', location: `${coordinate[0].toFixed(6)},${coordinate[1].toFixed(6)}`,
    citycode
  }
}

/** 记录请求类别和供应商错误码，不写地点、请求地址或凭证。 */
async function requestAmap<T>(
  operation: string,
  schedulerKey: string,
  url: string,
  signal?: AbortSignal,
  diagnostics?: RouteRequestDiagnostics,
  circuitBreaker?: AmapRouteCircuitBreaker
): Promise<T> {
  try {
    if (circuitBreaker?.quotaErrorCode) throw new AmapRouteQuotaLimitError()
    return await amapRequestScheduler.run(schedulerKey, async () => {
      // 熔断也在排队结束后检查，防止额度触顶后已排队的请求继续发出。
      if (circuitBreaker?.quotaErrorCode) throw new AmapRouteQuotaLimitError()
      const response = await fetchJson<T>(url, signal)
      const payload = response as { status?: unknown; infocode?: unknown } | null
      const errorCode = String(payload?.infocode ?? '')
      if (payload?.status === '0' && AMAP_ROUTE_QUOTA_ERROR_CODES.has(errorCode as AmapRouteQuotaErrorCode)) {
        circuitBreaker && (circuitBreaker.quotaErrorCode = errorCode as AmapRouteQuotaErrorCode)
        logSystemEvent('warn', 'amap.route.quota_limit_reached', {
          operation,
          status: 'circuit_open',
          errorCode,
          ...routeDiagnosticFields(diagnostics)
        })
        throw new AmapRouteQuotaLimitError()
      }
      return response
    }, signal)
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof AmapRouteQuotaLimitError) throw error
    const message = error instanceof Error ? error.message : ''
    const httpStatus = Number(message.match(/\bHTTP (\d{3})\b/u)?.[1])
    logSystemEvent('warn', 'amap.request.failed', {
      operation,
      status: 'request_failed',
      errorKind: classifyError(error),
      transportCode: safeTransportErrorCode(error),
      ...routeDiagnosticFields(diagnostics),
      ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {})
    })
    throw error
  }
}

/** 将本轮已触发额度限制的路段保留为待核验，不把失败伪装成路线结果。 */
function routeQuotaLimitResult(origin: string, destination: string): ToolResult {
  return {
    output: `${origin} → ${destination}：高德路线服务已达到本轮调用限制，路线和耗时待核验。`,
    routeFailureKind: 'tool_unavailable',
    routeQuotaLimited: true,
    sources: []
  }
}

/** 供应商响应码只接受数字，防止错误文本进入诊断日志。 */
function logAmapProviderFailure(
  operation: string,
  infocode?: string | number,
  diagnostics?: RouteRequestDiagnostics
): void {
  const candidate = infocode === undefined ? '' : String(infocode)
  const errorCode = /^\d{1,12}$/u.test(candidate) ? candidate : undefined
  logSystemEvent('warn', 'amap.request.failed', {
    operation,
    status: 'provider_error',
    ...routeDiagnosticFields(diagnostics),
    ...(errorCode ? { errorCode } : {})
  })
}

/** 只记录随机关联号、行程日序号和解析阶段，不写路线端点。 */
function routeDiagnosticFields(diagnostics?: RouteRequestDiagnostics): Record<string, string | number> {
  if (!diagnostics) return {}
  return {
    ...(diagnostics.traceId ? { traceId: diagnostics.traceId } : {}),
    routeAttemptId: diagnostics.attemptId,
    ...(diagnostics.dayNumber ? { routeDayNumber: diagnostics.dayNumber } : {}),
    routeExecutionStage: 'model-tool',
    ...(diagnostics.pointRole ? { routePointRole: diagnostics.pointRole } : {}),
    ...(diagnostics.geocodeVariant ? { routeGeocodeVariant: diagnostics.geocodeVariant } : {})
  }
}

/** 只展示有效的时长/距离和必要的公交线路，不将异常值误报为精确路线。 */
function routeOption(option: AMapPath | AMapTransit, index: number, mode: RouteMode): RouteOption {
  const durationSeconds = positiveNumber(option.cost?.duration ?? option.duration)
  const distanceMeters = positiveNumber(option.distance)
  const walkingDistanceMeters = 'segments' in option ? walkingDistanceFor(option.segments) : null
  const transitLines = mode === 'transit' && 'segments' in option ? transitLinesFor(option.segments) : []
  const minutes = durationSeconds === null ? null : Math.round(durationSeconds / 60)
  const fareFen = mode === 'transit' ? transitFareFen(option as AMapTransit) : undefined
  const tollFen = mode === 'driving' ? yuanToFen(option.cost?.tolls) : undefined
  const pathSegments = routePathSegments(option)
  const summary = [
    minutes === null ? '耗时未知' : `约 ${minutes} 分钟`,
    distanceMeters === null ? '' : formatDistance(distanceMeters),
    walkingDistanceMeters === null || mode !== 'transit' ? '' : `步行 ${formatDistance(walkingDistanceMeters)}`,
    fareFen === null || fareFen === undefined ? '' : `票价估算 ${formatYuanFen(fareFen)}`,
    tollFen === null || tollFen === undefined ? '' : `道路收费估算 ${formatYuanFen(tollFen)}`,
    ...transitLines
  ].filter(Boolean).join(' · ')
  return {
    optionNumber: index + 1,
    durationMinutes: minutes,
    distanceMeters,
    walkingDistanceMeters: mode === 'transit' ? walkingDistanceMeters : null,
    ...(mode === 'transit' ? { fareFen: fareFen ?? null } : {}),
    ...(mode === 'driving' ? { tollFen: tollFen ?? null } : {}),
    transitLines,
    summary,
    ...(pathSegments ? { pathSegments } : {})
  }
}

/** 只提取高德明确返回的有限折线路径；异常或超大路径不影响其余估算数据。 */
function routePathSegments(option: AMapPath | AMapTransit): RoutePathSegment[] | undefined {
  const polylines = typeof option.polyline === 'string' && option.polyline
    ? [option.polyline]
    : collectPolylineStrings(option)
  if (!polylines.length || polylines.reduce((total, value) => total + value.length, 0) > 48_000) return undefined
  const paths: RoutePathSegment[] = []
  let pointCount = 0
  for (const polyline of polylines) {
    for (const part of polyline.split('|')) {
      const tokens = part.split(/[;,]/).map((token) => token.trim())
      if (tokens.length < 4 || tokens.length % 2 !== 0) continue
      const points: Array<[number, number]> = []
      for (let index = 0; index < tokens.length; index += 2) {
        const longitude = coordinate(tokens[index])
        const latitude = coordinate(tokens[index + 1])
        if (longitude === null || latitude === null || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
          points.length = 0
          break
        }
        points.push([longitude, latitude])
      }
      if (points.length < 2) continue
      pointCount += points.length
      if (paths.length >= 32 || pointCount > 600) return undefined
      paths.push({ points })
    }
  }
  return paths.length ? paths : undefined
}

/** 在受限深度内读取路线响应中名称明确的 polyline 字段，不复制整份原始响应。 */
function collectPolylineStrings(value: unknown, depth = 0, output: string[] = []): string[] {
  if (depth > 7 || output.length >= 40 || !value || typeof value !== 'object') return output
  if (Array.isArray(value)) {
    for (const item of value) collectPolylineStrings(item, depth + 1, output)
    return output
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'polyline' && typeof item === 'string') output.push(item)
    else collectPolylineStrings(item, depth + 1, output)
    if (output.length >= 40) break
  }
  return output
}

/** 只接受十进制坐标，拒绝空值、指数值和非有限数。 */
function coordinate(value: string): number | null {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** 只采纳接口明确返回的单个方案票价；多段金额结构存在歧义时保留未知。 */
function transitFareFen(option: AMapTransit): number | null {
  const planFare = yuanToFen(option.cost?.transit_fee)
  if (planFare !== null) return planFare
  const segmentFees = option.segments?.flatMap((segment) =>
    segment.cost?.transit_fee === undefined ? [] : [segment.cost.transit_fee]) ?? []
  return segmentFees.length === 1 ? yuanToFen(segmentFees[0]) : null
}

/** 将高德返回的精确元数转换为分；非标准精度或异常值不作金额估算。 */
function yuanToFen(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const match = String(value).match(/^(\d{1,9})(?:\.(\d{1,6}))?$/)
  if (!match) return null
  const fraction = match[2] ?? ''
  if (fraction.slice(2).replace(/0/g, '').length > 0) return null
  const fen = Number(match[1]) * 100 + Number(fraction.slice(0, 2).padEnd(2, '0'))
  return Number.isSafeInteger(fen) && fen <= 1_000_000_000 ? fen : null
}

/** 以人民币元显示高德返回的分值，不经过浮点格式化。 */
function formatYuanFen(fen: number): string {
  return `¥${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, '0')}`
}

/** 将高德的公交线路段缩减成简短可读的线路名。 */
function transitLinesFor(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names = value.flatMap((segment) => {
    if (!segment || typeof segment !== 'object') return []
    const bus = (segment as { bus?: { buslines?: Array<{ name?: string }>; steps?: Array<{ buslines?: Array<{ name?: string }> }> } }).bus
    const lines = [...(bus?.buslines ?? []), ...(bus?.steps ?? []).flatMap((step) => step.buslines ?? [])]
    return lines.map((line) => line.name).filter((name): name is string => !!name)
  })
  return [...new Set(names)].slice(0, 5)
}

/** 汇总公交方案各步行段距离；缺字段时明确保留未知值。 */
function walkingDistanceFor(value: unknown): number | null {
  if (!Array.isArray(value)) return null
  const distances = value.flatMap((segment) => {
    if (!segment || typeof segment !== 'object') return []
    const walking = (segment as { walking?: { distance?: unknown } }).walking
    const distance = positiveNumber(walking?.distance)
    return distance === null ? [] : [distance]
  })
  return distances.length ? distances.reduce((total, distance) => total + distance, 0) : null
}

/** 仅接受正数路线指标，忽略空值、负数和异常响应。 */
function positiveNumber(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** 校验可选公共交通查询日期，拒绝不存在的日历日期。 */
function optionalRouteDate(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ToolInputError('路线查询日期需使用 YYYY-MM-DD。', 'route_date_invalid')
  }
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new ToolInputError('路线查询日期不是有效的日历日期。', 'route_date_invalid')
  }
  return value
}

/** 只接受高德公共交通服务支持的 H-MM / HH-MM 时刻格式。 */
function optionalRouteTime(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^(?:[01]?\d|2[0-3])-[0-5]\d$/.test(value)) {
    throw new ToolInputError('公共交通出发时刻需使用 H-MM 或 HH-MM。', 'route_time_invalid')
  }
  return value
}

/** 以千米或米显示路线距离，保持较短小数。 */
function formatDistance(meters: number): string {
  return meters >= 1_000 ? `${(meters / 1_000).toFixed(1)} km` : `${Math.round(meters)} m`
}
