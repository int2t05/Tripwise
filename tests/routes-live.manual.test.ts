/** 仅在显式启用时用本机高德凭证验证公共交通路线接口。 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { routeTool } from '../src/main/connectors/routes.js'
import { amapRequestScheduler } from '../src/main/connectors/amap-request-scheduler.js'
import { configureExternalFetcher } from '../src/main/connectors/http.js'
import { SecretVault } from '../src/main/secrets.js'
import { configureSystemLogger, flushSystemLogs, isSafeTransportCode } from '../src/main/system-logger.js'

const enabled = process.env.TRIPWISE_AMAP_LIVE_TEST === '1'
const poiRouteProbeEnabled = process.env.TRIPWISE_AMAP_POI_ROUTE_TEST === '1'
const profileDirectory = process.env.TRIPWISE_PROFILE_DIRECTORY ?? defaultProfileDirectory()

/** 按常见 Electron userData 目录定位 Tripwise；可用环境变量覆盖。 */
function defaultProfileDirectory(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'tripwise')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'tripwise')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'tripwise')
}

/** 汇总高德诊断日志里的固定接口名和数字错误码，不返回请求参数。 */
async function amapFailureSummary(directory: string): Promise<{
  byOperation: Record<string, number>
  providerCodes: Record<string, number>
  httpStatuses: Record<string, number>
  transportCodes: Record<string, number>
}> {
  const contents = await readFile(join(directory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const byOperation: Record<string, number> = {}
  const providerCodes: Record<string, number> = {}
  const httpStatuses: Record<string, number> = {}
  const transportCodes: Record<string, number> = {}
  for (const line of contents.split('\n')) {
    try {
      const entry = JSON.parse(line) as {
        event?: string; operation?: string; errorCode?: string; httpStatus?: number; transportCode?: unknown
      }
      if (entry.event !== 'amap.request.failed') continue
      const operation = ['route_poi_search', 'geocode', 'route_transit', 'route_walking', 'route_driving'].includes(entry.operation ?? '')
        ? entry.operation!
        : 'other'
      byOperation[operation] = (byOperation[operation] ?? 0) + 1
      if (/^\d{1,12}$/u.test(entry.errorCode ?? '')) {
        const code = entry.errorCode!
        providerCodes[code] = (providerCodes[code] ?? 0) + 1
      }
      if (typeof entry.httpStatus === 'number' && Number.isInteger(entry.httpStatus) && entry.httpStatus >= 100 && entry.httpStatus <= 599) {
        const status = String(entry.httpStatus)
        httpStatuses[status] = (httpStatuses[status] ?? 0) + 1
      }
      if (isSafeTransportCode(entry.transportCode)) {
        transportCodes[entry.transportCode] = (transportCodes[entry.transportCode] ?? 0) + 1
      }
    } catch {
      continue
    }
  }
  return { byOperation, providerCodes, httpStatuses, transportCodes }
}

/** 只输出接口状态和候选数量，不打印地点、坐标或凭证。 */
function summarizeAmapResponse(pathname: string, body: unknown, expectedName: string, expectedArea: string): Record<string, string | number> {
  if (body === null || typeof body !== 'object') return { operation: 'unknown', responseShape: 0 }
  const response = body as {
    status?: unknown
    infocode?: unknown
    geocodes?: Array<{ level?: unknown }>
    pois?: Array<{ name?: unknown; address?: unknown; adname?: unknown; location?: unknown; citycode?: unknown }>
  }
  const infocode = response.infocode === undefined ? '' : String(response.infocode)
  const safeCode = /^\d{1,12}$/u.test(infocode) ? infocode : ''
  if (pathname.endsWith('/place/text')) {
    const normalize = (value: string): string => value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase()
    const pois = response.pois ?? []
    const exact = pois.filter((poi) => typeof poi.name === 'string' && normalize(poi.name) === normalize(expectedName))
    const inArea = exact.filter((poi) => [poi.address, poi.adname]
      .some((value) => typeof value === 'string' && normalize(value).includes(normalize(expectedArea))))
    return {
      operation: 'poi_search', status: response.status === '1' ? 'ok' : 'failed',
      ...(safeCode ? { infocode: safeCode } : {}), poiCount: pois.length, exactNameCount: exact.length,
      exactAreaCount: inArea.length,
      exactUniqueCoordinateCount: new Set(exact.flatMap((poi) => typeof poi.location === 'string' ? [poi.location] : [])).size,
      exactCityCodeCount: exact.filter((poi) => typeof poi.citycode === 'string' && poi.citycode.trim()).length
    }
  }
  if (pathname.endsWith('/geocode/geo')) {
    const preciseLevels = new Set(['兴趣点', '门牌号', '门址', '公交地铁站点'])
    const geocodes = response.geocodes ?? []
    return {
      operation: 'geocode', status: response.status === '1' ? 'ok' : 'failed',
      ...(safeCode ? { infocode: safeCode } : {}), resultCount: geocodes.length,
      preciseCount: geocodes.filter((candidate) => typeof candidate.level === 'string' && preciseLevels.has(candidate.level)).length
    }
  }
  const operation = pathname.endsWith('/geocode/regeo') ? 'reverse_geocode'
    : pathname.endsWith('/direction/transit/integrated') ? 'transit' : 'other'
  return { operation, status: response.status === '1' ? 'ok' : 'failed', ...(safeCode ? { infocode: safeCode } : {}) }
}

describe('高德公共交通实连', () => {
  it.skipIf(!poiRouteProbeEnabled)('路线目的城市为北京时仍按广州端点城市码查询', async () => {
    const vault = new SecretVault(profileDirectory)
    await vault.initialize()
    const amapKey = await vault.getAmapKey()
    if (!amapKey) throw new Error('missing_saved_amap_web_key')

    let routeCityCodes: { city1: string | null; city2: string | null } | undefined
    configureExternalFetcher(async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/direction/transit/integrated')) {
        routeCityCodes = { city1: url.searchParams.get('city1'), city2: url.searchParams.get('city2') }
      }
      return fetch(input, init)
    })

    try {
      const result = await routeTool.execute({
        city: '北京', origin: '广州南站', destination: '广州白云国际机场', mode: 'transit',
        date: '2026-09-21', time: '12-00'
      }, {
        amapKey,
        routeEndpoints: {
          originPoiName: '广州南站', originArea: '番禺区',
          destinationPoiName: '广州白云国际机场', destinationArea: '白云区'
        }
      }, AbortSignal.timeout(40_000))
      const status = result.sources.find((source) => source.kind === 'route')?.status ?? 'missing_source'
      const routeCount = result.routeOptions?.length ?? 0
      process.stdout.write(`[amap-live] cross-city endpoint route ${JSON.stringify({
        status, routeCount, ...(result.routeFailureKind ? { failureKind: result.routeFailureKind } : {}), routeCityCodes
      })}\n`)
      expect(status).toBe('success')
      expect(routeCount).toBeGreaterThan(0)
      expect(routeCityCodes).toEqual({ city1: '020', city2: '020' })
    } finally {
      configureExternalFetcher()
    }
  }, 45_000)

  it.skipIf(!poiRouteProbeEnabled)('串行验证精确 POI 端点解析', async () => {
    const vault = new SecretVault(profileDirectory)
    await vault.initialize()
    const amapKey = await vault.getAmapKey()
    if (!amapKey) throw new Error('missing_saved_amap_web_key')
    const diagnosticsDirectory = await mkdtemp(join(tmpdir(), 'tripwise-amap-poi-routes-'))
    const probes = [
      { id: 'campus_pair', origin: '清华大学', destination: '北京大学', originArea: '海淀', destinationArea: '海淀' },
      { id: 'university_park', origin: '北京大学', destination: '圆明园', originArea: '海淀', destinationArea: '海淀' },
      { id: 'summerpalace_xiangshan', origin: '颐和园东宫门', destination: '香山公园东门', originArea: '海淀', destinationArea: '海淀' },
      { id: 'temple_museum', origin: '天坛公园', destination: '中国国家博物馆', originArea: '东城区', destinationArea: '东城区' },
      { id: 'badaling_olympic', origin: '八达岭长城', destination: '国家体育场', originArea: '北京', destinationArea: '北京' },
      { id: 'beihai_shichahai', origin: '北海公园', destination: '什刹海', originArea: '西城区', destinationArea: '西城区' },
      { id: 'confucian_wudaoying', origin: '孔庙和国子监博物馆', destination: '五道营胡同', originArea: '东城区', destinationArea: '东城区' },
      { id: 'palace_jingshan', origin: '故宫博物院', destination: '景山公园', originArea: '北京', destinationArea: '北京' },
      { id: 'yonghe_guozijian', origin: '雍和宫', destination: '孔庙和国子监博物馆', originArea: '北京', destinationArea: '北京' }
    ]
    // 这两段在高德当前返回同区域重名坐标；没有用户选定的地图来源时应保留待核验。
    const safelyUnresolvedCases = new Set(['beihai_shichahai', 'confucian_wudaoying'])
    const outcomes: Array<{ caseId: string; status: string; routeCount: number; failureKind?: string }> = []
    const responseMetrics: Array<{ caseId: string; responses: Array<Record<string, string | number>> }> = []
    let activeCaseId = ''

    try {
      configureSystemLogger(diagnosticsDirectory)
      configureExternalFetcher(async (input, init) => {
        const response = await fetch(input, init)
        const url = new URL(String(input))
        const probe = probes.find((candidate) => candidate.id === activeCaseId)
        const metrics = summarizeAmapResponse(url.pathname, await response.clone().json().catch(() => null),
          url.searchParams.get('keywords') ?? url.searchParams.get('address') ?? '', probe?.originArea ?? '')
        const existing = responseMetrics.find((candidate) => candidate.caseId === activeCaseId)
        if (existing) existing.responses.push(metrics)
        else responseMetrics.push({ caseId: activeCaseId, responses: [metrics] })
        return response
      })
      for (const probe of probes) {
        activeCaseId = probe.id
        let status = 'provider_error'
        let routeCount = 0
        let failureKind: string | undefined
        try {
          const result = await routeTool.execute({
            city: '北京', origin: probe.origin, destination: probe.destination,
            mode: 'transit', date: '2026-09-23', time: '08-00'
          }, {
            amapKey,
            routeEndpoints: {
              originPoiName: probe.origin, originArea: probe.originArea,
              destinationPoiName: probe.destination, destinationArea: probe.destinationArea
            }
          }, AbortSignal.timeout(30_000))
          routeCount = result.routeOptions?.length ?? 0
          failureKind = result.routeFailureKind
          status = result.sources.find((source) => source.kind === 'route')?.status ?? 'missing_source'
        } catch {
          status = 'provider_error'
        }
        outcomes.push({ caseId: probe.id, status, routeCount, ...(failureKind ? { failureKind } : {}) })
      }
      await flushSystemLogs()
      process.stdout.write(`[amap-live] sanitized POI routes ${JSON.stringify({ outcomes, responseMetrics, failures: await amapFailureSummary(diagnosticsDirectory) })}\n`)
      expect(outcomes).toHaveLength(probes.length)
      const resolved = outcomes.filter((outcome) => !safelyUnresolvedCases.has(outcome.caseId))
      const ambiguous = outcomes.filter((outcome) => safelyUnresolvedCases.has(outcome.caseId))
      expect(resolved.every((outcome) => outcome.status === 'success' && outcome.routeCount > 0)).toBe(true)
      expect(ambiguous.every((outcome) => outcome.status === 'partial' && outcome.failureKind === 'location_unresolved')).toBe(true)
    } finally {
      configureExternalFetcher()
      await flushSystemLogs()
      await rm(diagnosticsDirectory, { recursive: true, force: true })
    }
  }, 150_000)

  it.skipIf(!poiRouteProbeEnabled)('对比重庆夜景计划中带描述的路线端点', async () => {
    const vault = new SecretVault(profileDirectory)
    await vault.initialize()
    const amapKey = await vault.getAmapKey()
    if (!amapKey) throw new Error('missing_saved_amap_web_key')
    const diagnosticsDirectory = await mkdtemp(join(tmpdir(), 'tripwise-amap-chongqing-'))
    const probes = [
      {
        id: 'south-bank-cableway-original', city: '重庆', origin: '龙门浩老街', destination: '长江索道（南站乘单程至北站）',
        date: '2026-11-05', time: '18-00'
      },
      {
        id: 'south-bank-cableway-canonical', city: '重庆', origin: '龙门浩老街', destination: '长江索道南站',
        date: '2026-11-05', time: '18-00'
      },
      {
        id: 'jie-fang-bei-dai-jia-xiang-original', city: '重庆', origin: '解放碑早餐', destination: '戴家巷—山城步道街区拍摄',
        date: '2026-11-06', time: '10-00'
      },
      {
        id: 'jie-fang-bei-dai-jia-xiang-canonical', city: '重庆', origin: '解放碑', destination: '戴家巷',
        date: '2026-11-06', time: '10-00'
      }
    ]
    const outcomes: Array<{
      caseId: string; status: string; routeCount: number; failureKind?: string;
      byOperation: Record<string, number>; providerCodes: Record<string, number>;
      responseMetrics: Array<Record<string, string | number>>
    }> = []
    const responseMetrics = new Map<string, Array<Record<string, string | number>>>()
    let activeCaseId = ''

    try {
      configureExternalFetcher(async (input, init) => {
        const response = await fetch(input, init)
        const url = new URL(String(input))
        const query = url.searchParams.get('keywords') ?? url.searchParams.get('address') ?? ''
        const metrics = summarizeAmapResponse(url.pathname,
          await response.clone().json().catch(() => null), query, '')
        const current = responseMetrics.get(activeCaseId) ?? []
        current.push(metrics)
        responseMetrics.set(activeCaseId, current)
        return response
      })
      for (const probe of probes) {
        activeCaseId = probe.id
        const caseDirectory = join(diagnosticsDirectory, probe.id)
        configureSystemLogger(caseDirectory)
        let status = 'provider_error'
        let routeCount = 0
        let failureKind: string | undefined
        try {
          const result = await routeTool.execute({
            city: probe.city, origin: probe.origin, destination: probe.destination,
            mode: 'transit', date: probe.date, time: probe.time
          }, {
            amapKey,
            routeEndpoints: {
              originPoiName: probe.origin, originArea: '',
              destinationPoiName: probe.destination, destinationArea: ''
            }
          }, AbortSignal.timeout(20_000))
          routeCount = result.routeOptions?.length ?? 0
          failureKind = result.routeFailureKind
          status = result.sources.find((source) => source.kind === 'route')?.status ?? 'missing_source'
        } catch {
          status = 'provider_error'
        }
        await flushSystemLogs()
        const failures = await amapFailureSummary(caseDirectory)
        outcomes.push({ caseId: probe.id, status, routeCount, ...(
          failureKind ? { failureKind } : {}
        ), byOperation: failures.byOperation, providerCodes: failures.providerCodes,
        responseMetrics: responseMetrics.get(probe.id) ?? [] })
      }
      process.stdout.write(`[amap-live] sanitized Chongqing route endpoint comparison ${JSON.stringify(outcomes)}; key and coordinates omitted\n`)
      expect(outcomes).toHaveLength(probes.length)
      const byCase = new Map(outcomes.map((outcome) => [outcome.caseId, outcome]))
      expect(byCase.get('south-bank-cableway-original')).toMatchObject({ status: 'success', routeCount: 1 })
      expect(byCase.get('south-bank-cableway-canonical')).toMatchObject({ status: 'success', routeCount: 1 })
      expect(byCase.get('jie-fang-bei-dai-jia-xiang-original')).toMatchObject({
        status: 'partial', failureKind: 'location_unresolved', routeCount: 0
      })
      expect(byCase.get('jie-fang-bei-dai-jia-xiang-canonical')).toMatchObject({
        status: 'partial', failureKind: 'location_unresolved', routeCount: 0
      })
    } finally {
      configureExternalFetcher()
      await flushSystemLogs()
      await rm(diagnosticsDirectory, { recursive: true, force: true })
    }
  }, 130_000)

  it.skipIf(!enabled)('使用本机已保存凭证查询大兴机场至北京西站', async () => {
    const vault = new SecretVault(profileDirectory)
    await vault.initialize()
    const amapKey = await vault.getAmapKey()
    if (!amapKey) throw new Error('missing_saved_amap_web_key')

    const result = await routeTool.execute({
      city: '北京',
      origin: '北京大兴国际机场',
      destination: '北京西站',
      mode: 'transit',
      date: '2026-09-21',
      time: '20-00'
    }, { amapKey }, AbortSignal.timeout(30_000))

    expect(result.routeOptions?.length).toBeGreaterThan(0)
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: '高德地图路线规划', kind: 'route', status: 'success' })
    ]))
    process.stdout.write(`[amap-live] route options=${result.routeOptions?.length ?? 0}; key omitted\n`)
  }, 40_000)

  /** 只输出固定探针编号和结果计数，不保留地址、URL 或 Key。 */
  it.skipIf(!enabled)('脱敏对比高德地理编码的行政区地址格式', async () => {
    const vault = new SecretVault(profileDirectory)
    await vault.initialize()
    const amapKey = await vault.getAmapKey()
    if (!amapKey) throw new Error('missing_saved_amap_web_key')

    const probes = [
      { id: 'area_and_poi', address: '海淀区 清华大学', city: '北京' },
      { id: 'city_area_and_poi', address: '北京市海淀区清华大学', city: '北京' },
      { id: 'poi_name', address: '清华大学', city: '北京' },
      { id: 'city_area_without_city_filter', address: '北京市海淀区清华大学' }
    ]
    const outcomes: Array<Record<string, string | number>> = []
    for (const probe of probes) {
      const params = new URLSearchParams({ address: probe.address, output: 'JSON', key: amapKey })
      if (probe.city) params.set('city', probe.city)
      let metrics: Record<string, string | number>
      try {
        const signal = AbortSignal.timeout(15_000)
        const response = await amapRequestScheduler.run('geocode', () => fetch(
          `https://restapi.amap.com/v3/geocode/geo?${params}`, { signal }
        ), signal)
        metrics = summarizeAmapResponse('/v3/geocode/geo', await response.json().catch(() => null), '清华大学', '海淀区')
      } catch {
        metrics = { operation: 'geocode', status: 'network_error' }
      }
      outcomes.push({ id: probe.id, ...metrics })
    }
    process.stdout.write(`[amap-live] sanitized geocode address variants ${JSON.stringify(outcomes)}\n`)
    expect(outcomes).toHaveLength(probes.length)
  }, 75_000)

  it.skipIf(!enabled)('对比常见地点输入的地理编码结果并输出脱敏错误码', async () => {
    const vault = new SecretVault(profileDirectory)
    await vault.initialize()
    const amapKey = await vault.getAmapKey()
    if (!amapKey) throw new Error('missing_saved_amap_web_key')
    const diagnosticsDirectory = await mkdtemp(join(tmpdir(), 'tripwise-amap-probe-'))

    const cases = [
      { id: 'airport_station', origin: '北京大兴国际机场', destination: '北京西站' },
      { id: 'combined_area', origin: '海淀区 颐和园东宫门', destination: '海淀区 香山公园东门' },
      { id: 'place_names', origin: '颐和园', destination: '香山公园' },
      { id: 'popular_sites', origin: '天坛公园', destination: '中国国家博物馆' }
    ]
    const outcomes: Array<{ caseId: string; status: string; routeCount: number; errorCodes: Record<string, number> }> = []

    try {
      for (const probe of cases) {
        const caseDirectory = join(diagnosticsDirectory, probe.id)
        configureSystemLogger(caseDirectory)
        let status = 'provider_error'
        let routeCount = 0
        try {
          const result = await routeTool.execute({
            city: '北京', origin: probe.origin, destination: probe.destination,
            mode: 'transit', date: '2026-09-23', time: '08-00'
          }, { amapKey }, AbortSignal.timeout(30_000))
          routeCount = result.routeOptions?.length ?? 0
          status = result.sources.find((source) => source.kind === 'route')?.status ?? 'missing_source'
        } catch {
          status = 'provider_error'
        }
        await flushSystemLogs()
        const failures = await amapFailureSummary(caseDirectory)
        outcomes.push({ caseId: probe.id, status, routeCount, errorCodes: failures.providerCodes })
      }
      process.stdout.write(`[amap-live] sanitized geocode probes ${JSON.stringify(outcomes)}\n`)
    } finally {
      await flushSystemLogs()
      await rm(diagnosticsDirectory, { recursive: true, force: true })
    }
  }, 150_000)

  it.skipIf(!enabled)('以路线规划的三路并发批量查询复现错误码', async () => {
    const vault = new SecretVault(profileDirectory)
    await vault.initialize()
    const amapKey = await vault.getAmapKey()
    if (!amapKey) throw new Error('missing_saved_amap_web_key')
    const diagnosticsDirectory = await mkdtemp(join(tmpdir(), 'tripwise-amap-batch-'))
    const probes = [
      ['airport_station', '北京大兴国际机场', '北京西站', 'transit'],
      ['summerpalace_xiangshan', '海淀区 颐和园东宫门', '海淀区 香山公园东门', 'transit'],
      ['temple_museum', '天坛公园', '中国国家博物馆', 'transit'],
      ['tiananmen_palace', '天安门广场', '故宫博物院', 'transit'],
      ['palace_jingshan', '故宫博物院', '景山公园', 'transit'],
      ['jingshan_beihai', '景山公园', '北海公园', 'transit'],
      ['beihai_shichahai', '北海公园', '什刹海', 'transit'],
      ['lama_confucian', '雍和宫', '孔庙和国子监博物馆', 'transit'],
      ['confucian_wudaoying', '孔庙和国子监博物馆', '五道营胡同', 'transit'],
      ['qinghe_badaling', '清河站', '八达岭长城', 'transit'],
      ['north_badaling', '北京北站', '八达岭长城', 'transit'],
      ['tsinghua_peking', '清华大学', '北京大学', 'transit']
    ] as const
    const outcomes: Array<{
      caseId: string; requestedMode: string; actualMode?: string; status: string; routeCount: number; failureKind?: string
    }> = []
    let cursor = 0

    try {
      configureSystemLogger(diagnosticsDirectory)
      const worker = async (): Promise<void> => {
        while (cursor < probes.length) {
          const index = cursor++
          const [caseId, origin, destination, mode] = probes[index]!
          let status = 'provider_error'
          let routeCount = 0
          try {
            const result = await routeTool.execute({
              city: '北京', origin, destination, mode, date: '2026-09-23', time: '08-00'
            }, { amapKey }, AbortSignal.timeout(30_000))
            routeCount = result.routeOptions?.length ?? 0
            const actualMode = result.routeOptions?.[0]?.mode ?? mode
            status = result.sources.find((source) => source.kind === 'route')?.status ?? 'missing_source'
            outcomes.push({
              caseId, requestedMode: mode, actualMode, status, routeCount,
              ...(result.routeFailureKind ? { failureKind: result.routeFailureKind } : {})
            })
          } catch {
            status = 'provider_error'
            outcomes.push({ caseId, requestedMode: mode, status, routeCount })
          }
        }
      }
      await Promise.all(Array.from({ length: 3 }, () => worker()))
      await flushSystemLogs()
      process.stdout.write(`[amap-live] batch outcomes ${JSON.stringify(outcomes)} failures ${JSON.stringify(await amapFailureSummary(diagnosticsDirectory))}\n`)
    } finally {
      await flushSystemLogs()
      await rm(diagnosticsDirectory, { recursive: true, force: true })
    }
  }, 120_000)
})
