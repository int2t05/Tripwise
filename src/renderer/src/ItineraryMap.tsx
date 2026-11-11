/** 将一日行程与可确认的地图位置联动，并在用户选择后写入新版本。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ExternalLink, LoaderCircle, Map as MapIcon, MapPin, Route, Search } from 'lucide-react'
import { isAmapMapFrameCommand, isAmapMapFrameReply, type AmapMapFrameErrorCode, type AmapMapFrameState } from '@shared/amap-map-bridge'
import type { ItineraryDay, ItineraryLocation, RouteEstimateResponse, RouteMode, RouteOption, RoutePathSegment, SourceRecord, TransitEstimate } from '@shared/types'
import { errorMessage as formatErrorMessage } from './ui-format'

interface ItineraryMapProps {
  days: ItineraryDay[]
  sources: SourceRecord[]
  city: string
  routesEnabled: boolean
  amapKeySaved: boolean
  amapJsKeySaved: boolean
  amapSecurityCodeSaved: boolean
  saving: boolean
  activeDayNumber: number
  selectedStopId: string | null
  placesEnabled: boolean
  onSelectDay(dayNumber: number): void
  onSelectStop(dayNumber: number, stopId: string): void
  onSearch(city: string, query: string): Promise<SourceRecord[]>
  onEstimateRoute(city: string, origin: string, destination: string, mode: RouteMode, date?: string, time?: string): Promise<RouteEstimateResponse>
  onAssignLocation(dayNumber: number, stopId: string, location: ItineraryLocation): Promise<boolean>
  onAssignRoute(dayNumber: number, stopId: string, summary: string, estimate: TransitEstimate): Promise<boolean>
  onConfigureRoutes(): void
  onOpen(url: string): void
}

/** 展示当前日的地点与路线；真实路线折线只在用户请求后临时预览。 */
export function ItineraryMap({
  days, sources, city, routesEnabled, amapKeySaved, amapJsKeySaved, amapSecurityCodeSaved, saving, activeDayNumber, selectedStopId, placesEnabled, onSelectDay, onSelectStop,
  onSearch, onEstimateRoute, onAssignLocation, onAssignRoute, onConfigureRoutes, onOpen
}: ItineraryMapProps) {
  const [candidatesByStop, setCandidatesByStop] = useState<Record<string, SourceRecord[]>>({})
  const [pendingStopId, setPendingStopId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [routeMode, setRouteMode] = useState<RouteMode>('transit')
  const [routeResults, setRouteResults] = useState<Record<string, RouteEstimateResponse>>({})
  const [routePreview, setRoutePreview] = useState<{ key: string; optionNumber: number; fromStopId: string; toStopId: string } | null>(null)
  const [pendingRouteKey, setPendingRouteKey] = useState<string | null>(null)
  const [routeError, setRouteError] = useState('')
  const [routeErrorKey, setRouteErrorKey] = useState<string | null>(null)
  const [savedRouteKey, setSavedRouteKey] = useState<string | null>(null)
  const activeDay = days.find((day) => day.dayNumber === activeDayNumber) ?? days[0]
  const stops = activeDay?.stops ?? []
  const locatedCount = stops.filter((stop) => stop.location?.coordinateSystem === 'gcj02').length
  const legacyLocationCount = stops.filter((stop) => stop.location && stop.location.coordinateSystem !== 'gcj02').length
  const routesAvailable = routesEnabled && amapKeySaved
  const daySignature = `${city}|${days.map((day) => `${day.dayNumber}:${day.date}:${day.stops.map((stop) => `${stop.id}:${stop.name}:${stop.area}:${stop.time}`).join(',')}`).join('|')}`
  const mapRoutePreview = useMemo(() => {
    if (!routePreview) return null
    const option = routeResults[routePreview.key]?.options.find((item) => item.optionNumber === routePreview.optionNumber)
    if (!option?.pathSegments?.length) return null
    return { fromStopId: routePreview.fromStopId, toStopId: routePreview.toStopId, pathSegments: option.pathSegments }
  }, [routePreview, routeResults])

  useEffect(() => {
    setRouteResults({})
    setSavedRouteKey(null)
    setRoutePreview(null)
  }, [daySignature])

  useEffect(() => { setRoutePreview(null) }, [activeDayNumber, routeMode])

  /** 只在用户点击单个地点时检索候选，避免静默批量查询或自动确定坐标。 */
  async function locateStop(stopId: string): Promise<void> {
    const stop = stops.find((item) => item.id === stopId)
    if (!stop || !city.trim() || !placesEnabled || pendingStopId) return
    setPendingStopId(stopId)
    setError('')
    setCandidatesByStop((current) => ({ ...current, [stopId]: [] }))
    try {
      const candidates = await onSearch(city, [stop.name, stop.area].filter(Boolean).join(' '))
      const located = candidates.filter((candidate) => candidate.location).slice(0, 5)
      if (!located.length) setError(`没有找到“${stop.name}”的可用地图位置；可调整地点名称或稍后重试。`)
      else setCandidatesByStop((current) => ({ ...current, [stopId]: located }))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setPendingStopId(null)
    }
  }

  /** 每个坐标必须由用户从来源候选中选择，再存成行程的新版本。 */
  async function chooseLocation(stopId: string, source: SourceRecord): Promise<void> {
    if (!source.location || !activeDay) return
    setError('')
    const location: ItineraryLocation = {
      ...source.location,
      sourceId: source.id,
      provider: source.provider,
      fetchedAt: source.fetchedAt
    }
    if (await onAssignLocation(activeDay.dayNumber, stopId, location)) {
      setCandidatesByStop((current) => ({ ...current, [stopId]: [] }))
    } else {
      setError('地图位置未能保存，请检查行程是否已切换到其他版本。')
    }
  }

  /** 用户逐段请求高德估算；不自动批量调用外部路线服务。 */
  async function estimateSegment(from: ItineraryDay['stops'][number], to: ItineraryDay['stops'][number]): Promise<void> {
    if (!activeDay || !routesAvailable || pendingRouteKey || saving) return
    const queryDate = routeMode === 'transit' ? activeDay.date : ''
    const departureTime = routeMode === 'transit' ? routeDepartureTime(from.time) : undefined
    const key = routeKey(city, from, to, routeMode, queryDate, departureTime)
    setPendingRouteKey(key)
    setRouteError('')
    setRouteErrorKey(key)
    setSavedRouteKey(null)
    setRoutePreview((current) => current?.key === key ? null : current)
    try {
      const result = await onEstimateRoute(
        city,
        [from.name, from.area].filter(Boolean).join(' '),
        [to.name, to.area].filter(Boolean).join(' '),
        routeMode,
        queryDate || undefined,
        routeDepartureTime(from.time)
      )
      setRouteResults((current) => ({ ...current, [key]: result }))
      if (!result.options.length) setRouteError(result.output)
    } catch (reason) {
      setRouteError(errorMessage(reason))
    } finally {
      setPendingRouteKey(null)
    }
  }

  /** 采用一个可选路线结果，将文本、交通方式和来源绑定到新行程版本。 */
  async function chooseRoute(
    fromStopId: string,
    destinationStopId: string,
    mode: RouteMode,
    result: RouteEstimateResponse,
    option: RouteOption,
    segmentKey: string,
    queryDate: string,
    queryTime?: string
  ): Promise<void> {
    if (!activeDay || !result.source || saving) return
    const actualMode = option.mode ?? mode
    const summary = `高德地图${routeModeLabel(actualMode)}估算：${option.summary}`
    const estimate: TransitEstimate = {
      sourceId: result.source.id,
      destinationStopId,
      mode: actualMode,
      fetchedAt: result.source.fetchedAt,
      optionNumber: option.optionNumber,
      ...(actualMode === 'transit' && queryDate ? { queryDate } : {}),
      ...(actualMode === 'transit' && queryTime ? { queryTime } : {}),
      durationMinutes: option.durationMinutes,
      distanceMeters: option.distanceMeters,
      walkingDistanceMeters: option.walkingDistanceMeters,
      ...(actualMode === 'transit' ? { fareFen: option.fareFen ?? null } : {}),
      ...(actualMode === 'driving' ? { tollFen: option.tollFen ?? null } : {}),
      transitLines: [...option.transitLines]
    }
    const key = `${activeDay.dayNumber}:${fromStopId}`
    if (await onAssignRoute(activeDay.dayNumber, fromStopId, summary, estimate)) {
      setSavedRouteKey(key)
      setRouteError('')
    } else {
      setRouteError('路线估算未保存。请确认行程未切换后重试。')
      setRouteErrorKey(segmentKey)
    }
  }

  return <section className="itinerary-map-panel" aria-label="行程地图">
    <header className="itinerary-map-header">
      <div><span className="map-panel-icon"><MapPin size={15} /></span><div><strong>地图</strong><small>第 {activeDay?.dayNumber ?? '—'} 天 · {locatedCount}/{stops.length} 个地点已定位</small></div></div>
      <div className="itinerary-map-header-controls">
        <label className="map-route-mode"><Route size={12} /><span className="sr-only">路线交通方式</span><select value={routeMode} onChange={(event) => setRouteMode(event.target.value as RouteMode)}>
          <option value="transit">公共交通</option><option value="walking">步行</option><option value="driving">驾车</option>
        </select></label>
        <div className="map-day-tabs" role="group" aria-label="选择地图日期">
          {days.map((day) => <button key={day.id} type="button" aria-pressed={day.dayNumber === activeDay?.dayNumber}
            className={day.dayNumber === activeDay?.dayNumber ? 'active' : ''}
            onClick={() => {
              onSelectDay(day.dayNumber)
              if (day.stops[0]) onSelectStop(day.dayNumber, day.stops[0].id)
            }}>第 {day.dayNumber} 天</button>)}
        </div>
      </div>
    </header>

    <div className="itinerary-map-body">
      <div className="itinerary-map-stage">
        {locatedCount || mapRoutePreview
          ? <MapCanvas dayNumber={activeDay?.dayNumber ?? 1} stops={stops} selectedStopId={selectedStopId}
              routePreview={mapRoutePreview} credentialsConfigured={amapJsKeySaved && amapSecurityCodeSaved}
              onSelectStop={onSelectStop} onConfigure={onConfigureRoutes} />
          : <div className="itinerary-map-empty"><span><MapPin size={20} /></span><strong>{legacyLocationCount ? '需更新旧坐标' : '先定位今天的地点'}</strong><small>{legacyLocationCount ? '旧坐标不能用于高德地图，请逐项更新。' : '地点定位后会同步显示在地图和时间线。'}</small></div>}
        {(locatedCount > 0 || mapRoutePreview) && <div className="map-attribution"><span>© 高德地图</span></div>}
      </div>

      <div className="itinerary-map-stops" role="group" aria-label="当天地点位置">
        {stops.length ? stops.map((stop, index) => {
          const nextStop = stops[index + 1]
          const queryDate = routeMode === 'transit' ? activeDay?.date ?? '' : ''
          const departureTime = routeMode === 'transit' ? routeDepartureTime(stop.time) : undefined
          const key = nextStop ? routeKey(city, stop, nextStop, routeMode, queryDate, departureTime) : ''
          const result = key ? routeResults[key] : undefined
          const savedEstimate = stop.transitEstimate
          const savedSource = savedEstimate ? sources.find((source) => source.id === savedEstimate.sourceId) : undefined
          const segmentId = `${activeDay?.dayNumber}:${stop.id}`
          const locateActionLabel = pendingStopId === stop.id ? '搜索中' : stop.location ? '更新' : '定位'
          return <div className="map-stop-sequence" key={stop.id}>
            <article className={`map-stop-row ${stop.id === selectedStopId ? 'selected' : ''}`}>
              <button className="map-stop-select" onClick={() => onSelectStop(activeDay?.dayNumber ?? 1, stop.id)}>
                <span className={`map-stop-number ${stop.location ? 'located' : ''}`}>{index + 1}</span>
                <span className="map-stop-copy"><strong>{stop.name}</strong><small>{stop.location?.coordinateSystem === 'gcj02' ? stop.location.label : stop.location ? '旧地图坐标 · 请重新定位' : [stop.area, '尚未定位'].filter(Boolean).join(' · ')}</small></span>
              </button>
              <button className="map-locate-button" disabled={!placesEnabled || !city.trim() || pendingStopId !== null}
                aria-label={`${locateActionLabel}：${stop.name}`}
                title={!placesEnabled ? '地点连接器已关闭' : undefined}
                onClick={() => void locateStop(stop.id)}>
                {pendingStopId === stop.id ? <LoaderCircle size={14} className="spin-icon" /> : stop.location ? <MapPin size={13} /> : <Search size={13} />}
                <span>{pendingStopId === stop.id ? '搜索中' : stop.location ? '更新' : '定位'}</span>
              </button>
              {!!candidatesByStop[stop.id]?.length && <div className="map-candidate-list">
                <small>选择正确位置后保存到行程版本</small>
                {candidatesByStop[stop.id].map((candidate) => <button key={candidate.id} onClick={() => void chooseLocation(stop.id, candidate)}>
                  <span><strong>{candidate.title}</strong><small>{candidate.summary}</small></span><ArrowRight size={13} />
                </button>)}
              </div>}
            </article>
            {nextStop && <section className="map-route-segment" aria-label={`${stop.name}到${nextStop.name}的路线`}>
              <div className="map-route-segment-heading"><span><Route size={12} /> 前往下一站</span><small>{nextStop.name}</small></div>
              {savedEstimate && <div className="map-route-saved">
                <span>{stop.transitToNext}</span>
                <small>已采纳 · {routeModeLabel(savedEstimate.mode)}{savedEstimate.queryDate ? ` · ${savedEstimate.queryDate}${savedEstimate.queryTime ? ` ${savedEstimate.queryTime.replace('-', ':')}` : ''}` : ''} · 方案 {savedEstimate.optionNumber} · {formatFetchedAt(savedEstimate.fetchedAt)}</small>
                {savedSource && <button className="map-source-link" onClick={() => onOpen(savedSource.url)} disabled={!savedSource.url}>
                  {savedSource.provider} · 查看依据 <ExternalLink size={10} />
                </button>}
              </div>}
              {routesAvailable
                ? <button className="map-estimate-button" disabled={!!pendingRouteKey || saving}
                    onClick={() => void estimateSegment(stop, nextStop)}>
                    {pendingRouteKey === key ? <LoaderCircle size={12} className="spin-icon" /> : <Route size={12} />}
                    {pendingRouteKey === key ? '正在估算' : result ? '重新估算' : `估算${routeModeLabel(routeMode)}`}
                  </button>
                : <div className="map-route-unavailable"><span>{!routesEnabled ? '路线连接器已关闭' : '尚未配置高德 Web 服务 Key'}</span>
                    <button onClick={onConfigureRoutes}>去设置</button></div>}
              {result && <div className="map-route-results">
                {result.options.some((option) => option.mode && option.mode !== routeMode) &&
                  <p className="map-route-fallback-note">{result.output}</p>}
                {result.options.length
                  ? result.options.map((option) => <article className="map-route-option" key={`${key}:${option.optionNumber}`}>
                      <span><strong>方案 {option.optionNumber}{option.mode && option.mode !== routeMode ? ` · ${routeModeLabel(option.mode)}备选` : ''}</strong><small>{option.summary}</small></span>
                      <div className="map-route-option-actions">
                        {option.pathSegments?.length
                          ? <button type="button" aria-pressed={routePreview?.key === key && routePreview.optionNumber === option.optionNumber}
                              onClick={() => setRoutePreview((current) => current?.key === key && current.optionNumber === option.optionNumber
                                ? null
                                : { key, optionNumber: option.optionNumber, fromStopId: stop.id, toStopId: nextStop.id })}>
                              <MapIcon size={11} />{routePreview?.key === key && routePreview.optionNumber === option.optionNumber ? '退出预览' : '地图预览'}
                            </button>
                          : <small className="map-route-no-geometry">高德未返回路径</small>}
                        <button type="button" disabled={!result.source || saving} onClick={() => void chooseRoute(stop.id, nextStop.id, routeMode, result, option, key, queryDate, departureTime)}>采用</button>
                      </div>
                    </article>)
                  : <p>{result.output}</p>}
                {result.source && <button className="map-source-link" disabled={!result.source.url} onClick={() => onOpen(result.source!.url)}>
                  {result.source.provider} · {formatFetchedAt(result.source.fetchedAt)} · 查看来源 <ExternalLink size={10} />
                </button>}
              </div>}
              {savedRouteKey === segmentId && <span className="map-route-confirmation" role="status">路线已保存到行程。</span>}
              {!!routeError && routeErrorKey === key && pendingRouteKey === null && <span className="map-error" role="status">{routeError}</span>}
            </section>}
          </div>
        }) : <p className="map-no-stops">当天没有安排地点。</p>}
      </div>
    </div>

    <footer className="itinerary-map-footnote">
      <p>定位地点或估算路线时会向高德发送请求。确认的位置和采用的路线会保存到行程。实线仅作预览，不会保存或导出；虚线表示地点顺序。</p>
      {!placesEnabled && <span>地点搜索已关闭。可在设置中启用后定位新地点。</span>}
      {error && <span className="map-error" role="status">{error}</span>}
    </footer>
  </section>
}

/** 通过无 Tripwise API 权限的沙箱 iframe 展示当日高德地图。 */
function MapCanvas({ dayNumber, stops, selectedStopId, routePreview, credentialsConfigured, onSelectStop, onConfigure }: {
  dayNumber: number
  stops: ItineraryDay['stops']
  selectedStopId: string | null
  routePreview: { fromStopId: string; toStopId: string; pathSegments: RoutePathSegment[] } | null
  credentialsConfigured: boolean
  onSelectStop(dayNumber: number, stopId: string): void
  onConfigure(): void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const onSelect = useRef(onSelectStop)
  const currentStopIds = useRef(new Set(stops.map((stop) => stop.id)))
  const [mapError, setMapError] = useState('')
  const [retryCount, setRetryCount] = useState(0)
  const [frameWindow, setFrameWindow] = useState<Window | null>(null)
  const [mapFrameUrl, setMapFrameUrl] = useState('')
  const [mapConfig, setMapConfig] = useState<Awaited<ReturnType<typeof window.tripwise.getAmapMapConfig>> | null>(null)
  onSelect.current = onSelectStop
  currentStopIds.current = new Set(stops.map((stop) => stop.id))

  const frameState = useMemo<AmapMapFrameState>(() => ({
    dayNumber,
    selectedStopId,
    stops: stops.map((stop) => {
      const location = stop.location?.coordinateSystem === 'gcj02' ? stop.location : null
      return {
        id: stop.id,
        name: stop.name,
        longitude: location?.longitude ?? null,
        latitude: location?.latitude ?? null
      }
    }),
    routePathSegments: routePreview?.pathSegments.map((segment) => segment.points) ?? []
  }), [dayNumber, routePreview, selectedStopId, stops])

  useEffect(() => {
    let disposed = false
    void window.tripwise.getAmapMapFrameUrl().then((url) => {
      if (!disposed) setMapFrameUrl(url)
    }).catch((reason: unknown) => {
      if (!disposed) setMapError(errorMessage(reason))
    })
    return () => { disposed = true }
  }, [retryCount])

  useEffect(() => {
    if (!credentialsConfigured) {
      setMapConfig(null)
      setMapError('请先配置高德 Web JS API Key 和安全密钥。')
      return
    }
    let disposed = false
    setMapConfig(null)
    setMapError('')
    void window.tripwise.getAmapMapConfig().then((config) => {
      if (!disposed) setMapConfig(config)
    }).catch((reason: unknown) => {
      if (!disposed) setMapError(errorMessage(reason))
    })
    return () => { disposed = true }
  }, [credentialsConfigured, retryCount])

  useEffect(() => {
    const target = frameWindow
    const iframeWindow = frame.current?.contentWindow
    if (!target || !iframeWindow || target !== iframeWindow || !mapConfig) return
    const command = { type: 'tripwise:configure-map' as const, config: mapConfig, state: frameState }
    if (!isAmapMapFrameCommand(command)) {
      setMapError('行程地图数据超出当前地图支持范围，请减少当日地点或路线折线后重试。')
      return
    }
    target.postMessage(command, '*')
    setMapError('')
  }, [frameState, frameWindow, mapConfig])

  useEffect(() => {
    /** 只接收当前不透明源地图 iframe 发出的合法回复。 */
    function handleFrameMessage(event: MessageEvent<unknown>): void {
      const iframeWindow = frame.current?.contentWindow
      if (!iframeWindow || event.source !== iframeWindow || event.origin !== 'null' || !isAmapMapFrameReply(event.data)) return
      if (event.data.type === 'tripwise:select-stop') {
        if (currentStopIds.current.has(event.data.stopId)) onSelect.current(dayNumber, event.data.stopId)
        return
      }
      setMapError(mapFrameErrorMessage(event.data.code))
    }
    window.addEventListener('message', handleFrameMessage)
    return () => window.removeEventListener('message', handleFrameMessage)
  }, [dayNumber])

  /** 仅在当前 iframe 完成导航后记录它的 WindowProxy，供消息源校验。 */
  function handleFrameLoad(event: React.SyntheticEvent<HTMLIFrameElement>): void {
    const loadedWindow = event.currentTarget.contentWindow
    if (loadedWindow) {
      setFrameWindow(loadedWindow)
    }
  }

  return <div className="amap-map-shell">
    <iframe
      key={retryCount}
      ref={frame}
      className="amap-map-frame"
      title={'第 ' + dayNumber + ' 天高德地图'}
      src={mapFrameUrl || 'about:blank'}
      sandbox="allow-scripts"
      onLoad={handleFrameLoad}
    />
    {mapError && <div className="map-load-error" role="status">
      <strong>地图暂不可用</strong><span>{mapError}</span>
      {!credentialsConfigured
        ? <button onClick={onConfigure}>打开地图设置</button>
        : <button onClick={() => setRetryCount((count) => count + 1)}>重试</button>}
    </div>}
  </div>
}

/** 将地图页错误代码转换成简洁的本地操作提示。 */
function mapFrameErrorMessage(code: AmapMapFrameErrorCode): string {
  if (code === 'script-timeout') return '高德地图加载超时，请检查网络后重试。'
  if (code === 'api-unavailable') return '高德地图脚本已加载，但地图接口不可用。'
  if (code === 'script-load') return '高德地图脚本加载失败，请检查网络或 JS API Key 配置。'
  return '高德地图初始化失败，请稍后重试。'
}

/** 统一清除 IPC 包装，同时保留地点定位场景的兜底文案。 */
function errorMessage(reason: unknown): string {
  return formatErrorMessage(reason, '地点定位暂时不可用，请稍后重试。')
}

/** 用路线两端和交通方式区分缓存结果，避免把旧方案展示到其他地点段。 */
function routeKey(city: string, from: ItineraryDay['stops'][number], to: ItineraryDay['stops'][number], mode: RouteMode, date: string, time?: string): string {
  return [city, from.id, from.name, from.area, to.id, to.name, to.area, mode, date, time ?? ''].join('|')
}

/** 统一界面和来源记录中的交通方式名称。 */
function routeModeLabel(mode: RouteMode): string {
  return mode === 'transit' ? '公共交通' : mode === 'walking' ? '步行' : '驾车'
}

/** 用本地时间简洁呈现路线服务的查询时间。 */
function formatFetchedAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** 仅将明确写成时:分的出发锚点传给公共交通服务，不猜测“上午”等模糊时间。 */
function routeDepartureTime(value: string): string | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour <= 23 && minute <= 59 ? `${hour}-${String(minute).padStart(2, '0')}` : undefined
}
