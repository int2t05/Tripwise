/** 限定沙箱地图 iframe 与主界面之间可交换的数据，不暴露 Tripwise IPC。 */
import type { AmapMapRuntimeConfig } from './types'

/** 只传递地图绘制所需的停靠点标识、显示名和可选坐标。 */
export interface AmapMapFrameStop {
  id: string
  name: string
  longitude: number | null
  latitude: number | null
}

/** 限定为当前地图日期与可见路线，不包含行程简报或来源详情。 */
export interface AmapMapFrameState {
  dayNumber: number
  selectedStopId: string | null
  stops: AmapMapFrameStop[]
  routePathSegments: Array<Array<[longitude: number, latitude: number]>>
}

/** 主工作区发给地图 iframe 的唯一消息类型。 */
export type AmapMapFrameCommand = {
  type: 'tripwise:configure-map'
  config: AmapMapRuntimeConfig
  state: AmapMapFrameState
}

/** 地图 iframe 可回传的地点选择或固定错误代码。 */
export type AmapMapFrameReply =
  | { type: 'tripwise:select-stop'; stopId: string }
  | { type: 'tripwise:map-error'; code: AmapMapFrameErrorCode }

export type AmapMapFrameErrorCode = 'script-load' | 'script-timeout' | 'api-unavailable' | 'map-init'

/** 只接受边界明确、长度受限的地图 iframe 回传消息。 */
export function isAmapMapFrameReply(value: unknown): value is AmapMapFrameReply {
  if (!isRecord(value)) return false
  if (value.type === 'tripwise:select-stop') {
    return typeof value.stopId === 'string' && value.stopId.length > 0 && value.stopId.length <= 200
  }
  return value.type === 'tripwise:map-error' &&
    (value.code === 'script-load' || value.code === 'script-timeout' || value.code === 'api-unavailable' || value.code === 'map-init')
}

/** 地图 iframe 只接收本机代理地址、JS Key 和渲染当日地图所需的有界数据。 */
export function isAmapMapFrameCommand(value: unknown): value is AmapMapFrameCommand {
  if (!isRecord(value) || value.type !== 'tripwise:configure-map' || !isMapConfig(value.config) || !isMapState(value.state)) return false
  return true
}

/** 校验地图页只能调用本机随机令牌代理，不接受任意远程服务地址。 */
function isMapConfig(value: unknown): value is AmapMapRuntimeConfig {
  if (!isRecord(value) || typeof value.jsKey !== 'string' || value.jsKey.length < 1 || value.jsKey.length > 512 ||
    typeof value.serviceHost !== 'string' || value.serviceHost.length > 512) return false
  try {
    const url = new URL(value.serviceHost)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
      !!url.port && !url.username && !url.password &&
      /^\/tripwise-amap\/[a-f0-9]{64}\/_AMapService$/.test(url.pathname) && !url.search && !url.hash
  } catch {
    return false
  }
}

/** 校验地图消息的坐标、对象数量和折线长度上限。 */
function isMapState(value: unknown): value is AmapMapFrameState {
  if (!isRecord(value) || !Number.isInteger(value.dayNumber) || Number(value.dayNumber) < 1 || Number(value.dayNumber) > 1000 ||
    !(value.selectedStopId === null || (typeof value.selectedStopId === 'string' && value.selectedStopId.length <= 200)) ||
    !Array.isArray(value.stops) || value.stops.length > 120 || !Array.isArray(value.routePathSegments) || value.routePathSegments.length > 32) return false
  const stopIds = new Set<string>()
  if (!value.stops.every((stop) => {
    if (!isRecord(stop) || typeof stop.id !== 'string' || stop.id.length < 1 || stop.id.length > 200 ||
      typeof stop.name !== 'string' || stop.name.length > 300) return false
    if (stopIds.has(stop.id)) return false
    stopIds.add(stop.id)
    if (stop.longitude === null && stop.latitude === null) return true
    return isCoordinate(stop.longitude, -180, 180) && isCoordinate(stop.latitude, -90, 90)
  })) return false
  if (value.selectedStopId !== null && !stopIds.has(value.selectedStopId)) return false
  let pointCount = 0
  return value.routePathSegments.every((segment) => {
    if (!Array.isArray(segment) || segment.length < 2) return false
    pointCount += segment.length
    return pointCount <= 600 && segment.every((point) => Array.isArray(point) && point.length === 2 &&
      isCoordinate(point[0], -180, 180) && isCoordinate(point[1], -90, 90))
  })
}

/** 检查有限经纬度处于对应坐标轴的合法范围。 */
function isCoordinate(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
}

/** 将未知消息限制为普通对象后再读取字段。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
