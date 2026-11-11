/** 在无 Tripwise preload 权限的沙箱页面中加载并渲染高德地图。 */
import type { AmapMapFrameCommand, AmapMapFrameErrorCode, AmapMapFrameState } from '@shared/amap-map-bridge'
import { isAmapMapFrameCommand } from '@shared/amap-map-bridge'
import { loadAmap, type AMapMapApi, type AMapMapInstance, type AMapOverlay } from './amap-loader'
import './amap-map-frame.css'

const mapContainer = document.querySelector<HTMLDivElement>('#map')
let mapApi: AMapMapApi | null = null
let map: AMapMapInstance | null = null
let latestState: AmapMapFrameState | null = null
let overlaySignature = ''
let disposed = false
let resizeObserver: ResizeObserver | null = null

/** 仅向直接父窗口发送不含行程全文的地图状态或简短错误代码。 */
function reply(message: { type: 'tripwise:select-stop'; stopId: string } | { type: 'tripwise:map-error'; code: AmapMapFrameErrorCode }): void {
  window.parent.postMessage(message, '*')
}

/** 从地图配置建立受限 API 实例，并继续渲染最近一次父窗口状态。 */
async function configure(command: AmapMapFrameCommand): Promise<void> {
  latestState = command.state
  try {
    mapApi ??= await loadAmap(command.config)
    if (disposed || !mapContainer) return
    if (!map) {
      map = new mapApi.Map(mapContainer, {
        viewMode: '2D',
        zoom: 12,
        center: [116.397, 39.909],
        resizeEnable: true,
        scrollWheel: false,
        mapStyle: 'amap://styles/normal'
      })
      resizeObserver = new ResizeObserver(() => map?.resize())
      resizeObserver.observe(mapContainer)
    }
    renderLatestState()
  } catch (reason) {
    if (!disposed) reply({ type: 'tripwise:map-error', code: mapErrorCode(reason) })
  }
}

/** 绘制当前日期的有坐标地点、顺序连线和用户请求预览的路线。 */
function renderLatestState(): void {
  if (!map || !mapApi || !latestState) return
  const signature = JSON.stringify({
    dayNumber: latestState.dayNumber,
    stops: latestState.stops,
    routePathSegments: latestState.routePathSegments
  })
  if (signature !== overlaySignature) {
    overlaySignature = signature
    map.clearMap()
    const overlays: AMapOverlay[] = []
    const markerElements = new Map<string, HTMLElement>()

    latestState.stops.forEach((stop, index) => {
      if (stop.longitude === null || stop.latitude === null) return
      const element = document.createElement('span')
      element.className = 'tripwise-map-marker'
      element.textContent = String(index + 1)
      const marker = new mapApi!.Marker({
        position: [stop.longitude, stop.latitude],
        title: stop.name,
        content: element,
        offset: new mapApi!.Pixel(-14, -31),
        zIndex: 100 + index
      })
      marker.on('click', () => reply({ type: 'tripwise:select-stop', stopId: stop.id }))
      markerElements.set(stop.id, element)
      overlays.push(marker)
    })

    for (let index = 0; index < latestState.stops.length - 1; index += 1) {
      const current = latestState.stops[index]
      const next = latestState.stops[index + 1]
      if (current.longitude === null || current.latitude === null || next.longitude === null || next.latitude === null) continue
      overlays.push(new mapApi.Polyline({
        path: [[current.longitude, current.latitude], [next.longitude, next.latitude]],
        strokeColor: '#64866b',
        strokeOpacity: 0.78,
        strokeWeight: 3,
        strokeStyle: 'dashed',
        strokeDasharray: [5, 7],
        showDir: false,
        zIndex: 50
      }))
    }

    latestState.routePathSegments.forEach((path) => overlays.push(new mapApi!.Polyline({
      path,
      strokeColor: '#a95735',
      strokeOpacity: 0.96,
      strokeWeight: 5,
      strokeStyle: 'solid',
      lineJoin: 'round',
      zIndex: 80
    })))
    if (overlays.length) {
      map.add(overlays)
      map.setFitView(overlays, false, [32, 32, 32, 32], 15)
    }
    updateSelectedMarker(markerElements)
  } else {
    updateSelectedMarker(markers)
  }
}

let markers = new Map<string, HTMLElement>()

/** 按主界面当前选中停靠点更新 marker 高亮和地图中心。 */
function updateSelectedMarker(elements: Map<string, HTMLElement>): void {
  markers = elements
  for (const [stopId, element] of markers) {
    element.classList.toggle('map-marker-selected', stopId === latestState?.selectedStopId)
  }
  const selected = latestState?.stops.find((stop) => stop.id === latestState?.selectedStopId)
  if (selected && selected.longitude !== null && selected.latitude !== null && !latestState?.routePathSegments.length) {
    map?.setCenter([selected.longitude, selected.latitude])
  }
}

/** 将 loader 错误压缩为固定代码，避免向主界面传递外部原始内容。 */
function mapErrorCode(reason: unknown): AmapMapFrameErrorCode {
  const message = reason instanceof Error ? reason.message : ''
  if (message.includes('超时')) return 'script-timeout'
  if (message.includes('不可用')) return 'api-unavailable'
  if (message.includes('地图脚本')) return 'script-load'
  return 'map-init'
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || !isAmapMapFrameCommand(event.data)) return
  void configure(event.data)
})

window.addEventListener('pagehide', () => {
  disposed = true
  resizeObserver?.disconnect()
  resizeObserver = null
  map?.destroy()
  map = null
  mapApi = null
}, { once: true })

if (!mapContainer) reply({ type: 'tripwise:map-error', code: 'map-init' })
