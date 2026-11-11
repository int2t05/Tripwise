/** 在线加载高德 JS API，并确保安全密钥只留在主进程代理中。 */
import type { AmapMapRuntimeConfig } from '@shared/types'

export interface AMapMapApi {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => AMapMapInstance
  Marker: new (options: Record<string, unknown>) => AMapOverlay
  Polyline: new (options: Record<string, unknown>) => AMapOverlay
  Pixel: new (x: number, y: number) => unknown
}

export interface AMapMapInstance {
  add(overlays: AMapOverlay[]): void
  clearMap(): void
  setFitView(overlays?: AMapOverlay[], immediately?: boolean, padding?: number[], maxZoom?: number): void
  setCenter(position: [number, number]): void
  setZoom(level: number): void
  resize(): void
  destroy(): void
}

export interface AMapOverlay {
  on(event: 'click', callback: () => void): void
}

declare global {
  interface Window {
    AMap?: AMapMapApi
    _AMapSecurityConfig?: { serviceHost: string }
    __tripwiseAmapReady?: () => void
  }
}

let loadingKey: string | null = null
let loadedKey: string | null = null
let loading: Promise<AMapMapApi> | null = null

/** 单次应用进程固定 JS Key；需要更换时由用户重启以重新加载官方脚本。 */
export function loadAmap(config: AmapMapRuntimeConfig): Promise<AMapMapApi> {
  if (!config.jsKey || !config.serviceHost) return Promise.reject(new Error('高德地图配置不完整。'))
  const activeKey = loadedKey ?? loadingKey
  if (activeKey && activeKey !== config.jsKey) {
    return Promise.reject(new Error('高德 JS API Key 已在本次运行中加载；更换密钥后请重启 Tripwise。'))
  }
  if (window.AMap && loadedKey === config.jsKey) return Promise.resolve(window.AMap)
  if (loading) return loading

  loadingKey = config.jsKey
  window._AMapSecurityConfig = { serviceHost: config.serviceHost }
  loading = new Promise<AMapMapApi>((resolve, reject) => {
    const script = document.createElement('script')
    const callbackName = '__tripwiseAmapReady'
    let settled = false
    const timeout = window.setTimeout(() => finish(new Error('高德地图加载超时，请检查网络后重试。')), 25_000)

    /** 统一完成加载、超时和脚本错误路径，避免重复结算。 */
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      script.onerror = null
      window.__tripwiseAmapReady = undefined
      if (error) {
        script.remove()
        loading = null
        loadingKey = null
        reject(error)
        return
      }
      if (!window.AMap) {
        loading = null
        loadingKey = null
        reject(new Error('高德地图脚本已加载，但地图接口不可用。'))
        return
      }
      loadedKey = config.jsKey
      resolve(window.AMap)
    }

    window.__tripwiseAmapReady = () => finish()
    script.async = true
    script.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(config.jsKey) +
      '&callback=' + callbackName
    script.onerror = () => finish(new Error('高德地图脚本加载失败，请检查网络或 JS API Key 配置。'))
    document.head.append(script)
  })
  return loading
}
