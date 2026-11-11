/** 在隔离 Electron 资料中运行真实北京规划，验证 Agent 使用桌面研究浏览器。 */
import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { _electron as electron } from 'playwright-core'
import { browserToolOutcomeSummary, modelFailureSummary, routeConflictRepairSummary, routeLookupSummary, routeToolVisibilitySummary, runFailureSummary, searchProviderOutcomeSummary } from './beijing-case-metrics.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const runArguments = new Set(process.argv.slice(2))
const liveFlag = runArguments.has('--live')
const weatherSmoke = runArguments.has('--weather-smoke')
const withoutMapServices = runArguments.has('--without-map-services')
const mockMapServices = runArguments.has('--mock-map-services')
const codexCli = runArguments.has('--codex-cli')
const skipBrowserSmoke = runArguments.has('--skip-browser-smoke') || weatherSmoke
const browserSmokeOnly = runArguments.has('--browser-smoke-only')
const allowedArguments = new Set([
  '--live', '--weather-smoke', '--without-map-services', '--mock-map-services',
  '--skip-browser-smoke', '--browser-smoke-only', '--codex-cli'
])
const validArguments = runArguments.size === 0 ||
  (liveFlag && !(withoutMapServices && mockMapServices) &&
    !(skipBrowserSmoke && browserSmokeOnly) &&
    (!weatherSmoke || [...runArguments].every((argument) => ['--live', '--weather-smoke', '--codex-cli'].includes(argument))) &&
    [...runArguments].every((argument) => allowedArguments.has(argument)))

if (!validArguments) {
  process.stderr.write('用法：npm run evaluate:beijing:desktop-live -- --live [--codex-cli] [--weather-smoke | --without-map-services | --mock-map-services] [--skip-browser-smoke | --browser-smoke-only]\n')
  process.exit(2)
}
if (!liveFlag) {
  process.stdout.write('这是会调用已保存模型并访问公开网页的长时间实跑。确认需要执行后添加 --live。\n')
  process.exit(0)
}

const runTimeoutMs = weatherSmoke ? 40 * 60 * 1000 : 90 * 60 * 1000
const weatherSmokeDates = weatherSmoke ? upcomingBeijingForecastDates() : []
const sourceDirectory = localUserDataDirectory()
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tripwise-beijing-desktop-live-'))
let application
let stage = 'profile_validation'
let finalExitCode = 0
let credentials = {}
let credentialsWritten = false
let credentialAuditCompleted = false
// 可后续对话补全的内容缺口只记录提示；结构、流程和凭证边界仍由断言把关。
const qualityWarnings = []

try {
  if (process.platform !== 'win32') await chmod(temporaryDirectory, 0o700)
  const modelConfiguration = await readLocalModelConfiguration(sourceDirectory, { codexCli })
  credentials = await readLocalBuiltinCredentials(sourceDirectory, {
    includeModelKey: modelConfiguration.model.provider !== 'codex-cli'
  })
  if (withoutMapServices) delete credentials.amapKey
  if (mockMapServices) credentials.amapKey = 'test-only-amap-response-mock'
  await writeFile(join(temporaryDirectory, 'tripwise-credentials.json'), JSON.stringify({
    format: 'tripwise-credentials',
    schemaVersion: 1,
    secrets: credentials
  }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  credentialsWritten = true

  stage = 'electron_startup'
  const launchEnvironment = {
    ...process.env,
    TRIPWISE_E2E_HEADLESS: '1',
    TRIPWISE_E2E_USER_DATA_DIR: temporaryDirectory
  }
  if (mockMapServices) {
    launchEnvironment.TRIPWISE_E2E_AMAP_MOCK = '1'
  }
  application = await electron.launch({
    args: ['--disable-gpu', projectRoot],
    env: launchEnvironment,
    timeout: 30_000
  })
  const page = await application.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByLabel('旅行对话输入框').waitFor({ state: 'visible', timeout: 30_000 })

  stage = 'settings_update'
  const settingsResult = await page.evaluate(async ({ model, sourceProxyUrl, connectors }) => {
    const api = window.tripwise
    const initial = await api.getSnapshot()
    try {
      await api.updateSettings({
        ...structuredClone(initial.settings),
        model,
        sourceProxyUrl,
        connectors,
        xiaohongshu: { enabled: false, command: '', args: [] },
        mcpServers: []
      })
    } catch (error) {
      const message = String(error?.message ?? '')
      const errorKind = /小红书连接器/u.test(message) ? 'xiaohongshu_config'
        : /连接器启用设置/u.test(message) ? 'connector_config'
          : /代理/u.test(message) ? 'proxy_config'
            : /模型/u.test(message) ? 'model_config' : 'ipc_rejected'
      return { setupError: 'settings_update', errorKind }
    }
    return { setupStage: 'settings_updated' }
  }, {
    model: modelConfiguration.model,
    sourceProxyUrl: modelConfiguration.sourceProxyUrl,
    connectors: weatherSmoke
      ? { webSearch: false, weather: true, places: false, routes: false }
      : withoutMapServices
        ? { ...modelConfiguration.connectors, places: false, routes: false }
        : mockMapServices
          ? { ...modelConfiguration.connectors, places: false, routes: true }
          : modelConfiguration.connectors
  })
  if (settingsResult.setupError) throw new Error(settingsResult.setupError + '_' + settingsResult.errorKind)

  stage = 'trip_creation'
  const tripSession = await page.evaluate(async (dates) => {
    const api = window.tripwise
    const created = await api.createTrip({
      departureCity: dates.length ? '广州' : '深圳',
      destination: '北京',
      startDate: dates[0] ?? '2026-09-21',
      endDate: dates.at(-1) ?? '2026-09-27',
      arrivalFlight: dates.length ? '' : '晚间航班，深圳出发后抵达北京大兴',
      arrivalTime: dates.length ? '' : '19:00',
      leaveTime: dates.length ? '' : '20:00',
      travelers: '1人',
      budget: '中等',
      lodgingLocation: dates.length ? '' : '北京西站周边酒店',
      lodging: dates.length ? '' : '北京西站周边酒店',
      pace: dates.length ? '轻松' : '中等体力',
      earlyStart: dates.length ? '不必早起' : '可以早起，按预约与车次安排',
      interests: dates.length ? '北京城市漫步、人文与每日天气' : '清华、北大、圆明园；红叶、北京标志景点、人文、美食',
      transport: '尽量公共交通，含地铁、公交和步行；城际交通按已购车票',
      dietary: '无特殊忌口',
      luggage: '20kg托运行李额度；随身背包带电脑和相机',
      clothing: dates.length ? '按每一天的天气资料分别给穿搭建议' : '现有短袖和冲锋衣；按每日天气补齐保暖层',
      constraints: dates.length
        ? '行程日期以简报为准。需要天气查询、逐日天气摘要和对应日期的穿搭建议；穿搭来源必须绑定当天的天气来源。只生成一份两日计划，不补写未查询到的天气。'
        : '旅行首日19:00抵达北京大兴。末日20:00从北京西站乘车返程，次日傍晚抵达出发城市。末日只安排一个景点、早餐和午餐；16:30后不再安排景点或用餐；18:15从住宿区域出发，19:00前抵达北京西站候车。预约按能预约到规划，校园入场按已有预约办理，但须列出核验提醒。'
    })
    const trip = created.trips.find((item) => item.id === created.selectedTripId)
    if (!trip) return { setupError: 'trip_creation' }
    return {
      tripId: trip.id,
      conversationId: trip.activeConversationId,
      modelKeySaved: created.secrets.modelKeySaved
    }
  }, weatherSmokeDates)
  if (tripSession.setupError) throw new Error('trip_creation_failed')
  const session = tripSession
  assert.equal(session.modelKeySaved, modelConfiguration.model.provider !== 'codex-cli',
    '隔离配置应只加载当前模型来源需要的凭证。')
  const modelModeLabel = modelConfiguration.model.provider === 'codex-cli'
    ? 'Codex App Server（GPT-6 Luna / max）'
    : 'OpenAI-compatible'
  process.stdout.write('[beijing-desktop-live] 模型 ' + modelModeLabel + '\n')
  const mapModeLabel = weatherSmoke ? '天气短实跑（搜索与地图工具关闭）'
    : withoutMapServices ? '已禁用（路线待核验）'
    : mockMapServices ? '高德响应结构本地模拟（数据仅用于验收，不代表真实路线）'
      : '使用已保存配置'
  process.stdout.write('[beijing-desktop-live] 地图服务 ' + mapModeLabel + '\n')

  await installEventCapture(page)
  if (weatherSmoke) {
    stage = 'weather_smoke'
    const [startDate, endDate] = weatherSmokeDates
    const result = await runAgentMessage(page, session, weatherSmokePrompt(startDate, endDate), 'weather_smoke', runTimeoutMs,
      { expectedDates: weatherSmokeDates })
    const weatherSummary = {
      terminal: result.terminal,
      durationSeconds: result.durationSeconds,
      dates: weatherSmokeDates,
      weatherToolCalls: result.toolOutcomeCounts['get_weather:completed'] ?? 0,
      successfulWeatherSources: result.successfulWeatherSourceCount,
      dailyForecastCoverage: result.dailyForecastCoverage,
      clothingSourceCoverage: result.clothingSourceCoverage,
      proposedClothingItems: result.proposedClothingItemCount,
      modelRequests: result.routeDiagnostics.modelDiagnostics?.requestCount ?? 0,
      modelSeconds: result.routeDiagnostics.modelDiagnostics?.totalDurationSeconds ?? 0
    }
    process.stdout.write('[beijing-desktop-live] 天气短实跑 ' + JSON.stringify(weatherSummary) + '\n')
    assert.equal(result.terminal, 'complete', '天气短实跑应由 Agent 完成。')
    assert.equal(result.planCount, 1, '天气短实跑应生成一份计划。')
    assert.equal(result.dayCount, weatherSmokeDates.length, '计划应覆盖两个未来日期。')
    assert.ok(result.toolOutcomeCounts['get_weather:completed'] > 0, 'Agent 应成功调用天气工具。')
    assert.equal(result.dailyForecastCoverage, weatherSmokeDates.length,
      '计划每天都应绑定到对应日期的成功天气来源。')
    assert.equal(result.clothingSourceCoverage, weatherSmokeDates.length,
      '每天至少一条穿搭建议应绑定当天的天气来源。')
    stage = 'credential_leak_audit'
    const leakAudit = await auditTemporaryProfile(temporaryDirectory, Object.values(credentials))
    credentialAuditCompleted = true
    process.stdout.write('[beijing-desktop-live] 隔离资料审计 ' + JSON.stringify(leakAudit) + '\n')
    assert.equal(leakAudit.credentialInLogs, false, '模型或连接器凭证不得写入日志。')
    assert.equal(leakAudit.credentialInTripData, false, '模型或连接器凭证不得写入旅行数据。')
    stage = 'weather_smoke_complete'
  } else {
  if (skipBrowserSmoke) {
    process.stdout.write('[beijing-desktop-live] 浏览器联测 已跳过（桌面浏览器交互由独立 E2E 覆盖）\n')
  } else {
    stage = 'browser_smoke'
    const browserSmoke = await runAgentMessage(page, session, [
      '请先用右侧研究浏览器实际搜索“故宫博物院 官方 参观须知 开放时间 预约”，从结果中打开故宫博物院官网并读取页面正文。',
      '只用一两句话说明是否成功读到官方页面，以及页面是否含开放时间或预约提示。必须实际打开页面，不要只依据搜索摘要。'
    ].join('\n'), 'browser_smoke', runTimeoutMs)
    process.stdout.write('[beijing-desktop-live] 浏览器联测 ' + JSON.stringify(summarizeRunMetrics(browserSmoke)) + '\n')
    assert.equal(browserSmoke.terminal, 'complete', '真实模型的浏览器联测应完成。')
    assert.ok(browserSmoke.browserNavigateCalls > 0, '模型应实际调用研究浏览器导航。')
    assert.ok(browserSmoke.pageSourceCount > 0, '浏览器联测应实际保存至少一条正文来源。')
    assert.ok(browserSmoke.dpmPageSourceCount > 0, '浏览器联测应实际读取故宫博物院官网正文。')
  }

  if (browserSmokeOnly) {
    stage = 'browser_smoke_complete'
    process.stdout.write('[beijing-desktop-live] 已完成浏览器联测，仅运行烟测并跳过行程生成。\n')
  } else {
  stage = 'initial_plan'
  const initial = await runAgentMessage(page, session, beijingPlanningPrompt(), 'initial_plan', runTimeoutMs)
  process.stdout.write('[beijing-desktop-live] 北京初稿 ' + JSON.stringify(summarizeRunMetrics(initial)) + '\n')
  assert.equal(initial.terminal, 'complete', '北京初稿应由 Agent 完成。')
  assert.equal(initial.planCount, 1, '北京用例应只产出一份可审阅计划。')
  const initialRouteBoundCount = Number(initial.boundRouteDays) || 0
  assert.equal(initial.dayCount, 7, '北京计划应覆盖七个日历日。')
  assert.equal(initial.exactDateCoverage, true, '北京计划应覆盖抵达日至返程日的全部日期。')
  if (initial.mustVisitCoverage < 4) qualityWarnings.push('initial_plan:requested_places_incomplete')
  if (initial.mealSlotsMissing > 0) qualityWarnings.push('initial_plan:meal_slots_incomplete')
  if ((initial.mealEvidence?.pendingNameSlots ?? 0) > 0) qualityWarnings.push('initial_plan:meal_names_need_review')
  if ((initial.mealEvidence?.directNameEvidenceSlots ?? 0) < (initial.mealEvidence?.namedCandidateSlots ?? 0)) {
    qualityWarnings.push('initial_plan:meal_names_need_sources')
  }
  if (withoutMapServices) {
    assert.equal(initial.routeDiagnostics.modelRouteToolCallCount, 0, '地图服务关闭时不应调用路线工具。')
    assert.equal(initial.boundRouteDays, 0, '地图服务关闭时路线须保持待核验。')
  }
  if (mockMapServices) {
    const mockDiagnostics = await readMockAmapDiagnostics(temporaryDirectory)
    process.stdout.write('[beijing-desktop-live] 高德响应 mock ' + JSON.stringify(mockDiagnostics) + '\n')
    if (mockDiagnostics.requestCount === 0) qualityWarnings.push('initial_plan:no_valid_map_request')
    const routeProviderErrorCount = initial.routeDiagnostics.outcomeCounts?.provider_error
    if (routeProviderErrorCount !== undefined) {
      assert.equal(routeProviderErrorCount, 0, 'mock 路线不应产生供应商请求错误。')
    }
  }

  const revisionRequests = [
    '第一轮修改：以刚才的最新草案为基线。只把 9/23 调轻松，删除香山和碧云寺，保留颐和园主线；午餐后回酒店休息。9/22、9/24、9/25、9/26、9/27 和抵离时刻都保持不变。请返回一份完整修订草案，不并列方案。',
    '第二轮修改：以刚才最新的修订为基线。只把 9/24 晚餐改成前门一带的就近安排；若已有来源不能支持具体店名就保留待选。其他日期、刚调整的 9/23、每天餐次范围和抵离时刻都保持不变。请返回一份完整修订草案，不并列方案。'
  ]
  let priorSignatures = initial.daySignatures
  let priorSuccessfulRouteSourceCount = Number(
    initial.sourceCountsByProviderStatusLevel?.['route:success:structured']
  ) || 0
  for (const [index, request] of revisionRequests.entries()) {
    stage = 'revision_' + (index + 1)
    const revision = await runAgentMessage(page, session, request, 'revision_' + (index + 1), runTimeoutMs)
    const targetDate = index === 0 ? '2026-09-23' : '2026-09-24'
    const changedDates = revision.daySignatures
      .filter((day) => priorSignatures.find((item) => item.date === day.date)?.signature !== day.signature)
      .map((day) => day.date)
    const priorRoutes = new Map(priorSignatures.map((day) => [day.date, day]))
    const changedRouteDates = revision.daySignatures
      .filter((day) => priorRoutes.get(day.date)?.routeSignature !== day.routeSignature)
      .map((day) => day.date)
    const protectedRouteChangedDates = changedRouteDates.filter((date) => date !== targetDate)
    const routeCountFor = (signatures) => signatures.reduce((sum, day) => sum + day.boundRouteCount, 0)
    const priorTargetRouteCount = priorRoutes.get(targetDate)?.boundRouteCount ?? 0
    const currentTargetRouteCount = revision.daySignatures.find((day) => day.date === targetDate)?.boundRouteCount ?? 0
    const successfulRouteSourceCount = Number(
      revision.sourceCountsByProviderStatusLevel?.['route:success:structured']
    ) || 0
    const newSuccessfulRouteSourceCount = successfulRouteSourceCount - priorSuccessfulRouteSourceCount
    const revisionReport = {
      ...summarizeRunMetrics(revision),
      targetDate,
      targetDateChanged: changedDates.includes(targetDate),
      ...(index === 1 ? {
        targetAreaAlreadySatisfiedBefore: initial.frontGateDinnerOnSep24,
        targetDinnerNameAlreadyPresentBefore: initial.mealVenuesWithNamedCandidateByDate?.['2026-09-24']?.dinner === true,
        targetDinnerSourceVerificationEnabled: initial.mealSourceVerificationEnabled,
        targetDinnerNameSourceVerifiedBefore:
          initial.mealVenueEvidenceByDate?.['2026-09-24']?.dinner?.directNameEvidence === true
      } : {}),
      changedDateCount: changedDates.length,
      changedDates,
      nonTargetChangeCount: changedDates.filter((date) => date !== targetDate).length,
      routeCoverageBefore: routeCountFor(priorSignatures),
      routeCoverageAfter: routeCountFor(revision.daySignatures),
      targetRouteCoverageBefore: priorTargetRouteCount,
      targetRouteCoverageAfter: currentTargetRouteCount,
      newSuccessfulRouteSourceCount,
      protectedRouteChangedDates
    }
    process.stdout.write('[beijing-desktop-live] 北京局部修订 ' + JSON.stringify(revisionReport) + '\n')
    assert.equal(revision.terminal, 'complete', '北京局部修订应由 Agent 完成。')
    const expectNoOp = revision.noOpGate?.status === 'eligible'
    assert.equal(revision.noOp, expectNoOp,
      'Agent 终态应与日志记录的无变化门槛一致。')
    assert.equal(revision.planCount, expectNoOp ? 0 : 1, '只在行程发生修改时生成完整修订草案。')
    assert.equal(revision.dayCount, 7, '修订应保留全部日期。')
  if (revision.mealSlotsMissing > 0) qualityWarnings.push(`${targetDate}:meal_slots_incomplete`)
    assert.equal(revision.savedRevision, false, '用户未确认时，候选修订不得自动保存。')
    assert.ok(
      revisionReport.targetDateChanged || expectNoOp,
      '指定日期应体现修改；只有目标片区和具名餐次都已满足时才可保持无差异。'
    )
    assert.equal(revisionReport.nonTargetChangeCount, 0, '未指定日期应保持不变。')
    assert.equal(protectedRouteChangedDates.length, 0, '未指定日期的已核对路线应保持不变。')
    if (expectNoOp) {
      assert.equal(revisionReport.changedDateCount, 0, '已满足的修改不应改变任何一天。')
      assert.equal(revision.routeDiagnostics.modelRouteToolCallCount, 0, '无变化终态不应调用路线工具。')
      assert.equal(Object.values(revision.routeDiagnostics.attemptsByDay ?? {}).reduce((sum, count) => sum + count, 0), 0,
        '无变化终态不应发起路线查询。')
    }
    if (mockMapServices && !expectNoOp) {
      if (!(revision.routeDiagnostics.modelRouteToolCallCount > 0 && newSuccessfulRouteSourceCount > 0)) {
        qualityWarnings.push(`${targetDate}:target_route_source_missing`)
      }
    }
    if (index === 0) {
      if (revision.targetRevisionChecks?.retainedSummerPalace !== true) qualityWarnings.push(`${targetDate}:requested_attraction_needs_review`)
      if (revision.targetRevisionChecks?.removedXiangshanAndBiyunsi !== true) qualityWarnings.push(`${targetDate}:requested_exclusions_need_review`)
      if (revision.targetRevisionChecks?.postLunchHotelRest !== true) qualityWarnings.push(`${targetDate}:requested_rest_needs_review`)
    } else {
      if (revision.targetRevisionChecks?.frontGateDinner !== true) qualityWarnings.push(`${targetDate}:requested_dinner_area_needs_review`)
      if (revision.targetRevisionChecks?.frontGateNamedDinner !== true) qualityWarnings.push(`${targetDate}:requested_dinner_name_needs_review`)
    }
    if (withoutMapServices) {
      assert.equal(revision.routeDiagnostics.modelRouteToolCallCount, 0, '地图服务关闭时修订不应调用路线工具。')
      assert.equal(revision.boundRouteDays, 0, '地图服务关闭时修订路线须保持待核验。')
    }
    priorSignatures = revision.daySignatures
    priorSuccessfulRouteSourceCount = successfulRouteSourceCount
  }

  stage = 'credential_leak_audit'
  const leakAudit = await auditTemporaryProfile(temporaryDirectory, Object.values(credentials))
  credentialAuditCompleted = true
  process.stdout.write('[beijing-desktop-live] 隔离资料审计 ' + JSON.stringify(leakAudit) + '\n')
  assert.equal(leakAudit.credentialInLogs, false, '模型或连接器凭证不得写入日志。')
  assert.equal(leakAudit.credentialInTripData, false, '模型或连接器凭证不得写入旅行数据。')
  if (mockMapServices) {
    stage = 'quality_assertions'
    if (initialRouteBoundCount === 0) qualityWarnings.push('initial_plan:route_sources_need_review')
  }
  if (qualityWarnings.length > 0) {
    process.stdout.write('[beijing-desktop-live] 内容待继续完善 ' + JSON.stringify([...new Set(qualityWarnings)]) + '\n')
  }
  }
  }
} catch (error) {
  finalExitCode = 1
  process.stderr.write('[beijing-desktop-live] 失败阶段 ' + stage + '；错误类别 ' + safeErrorKind(error) + '\n')
} finally {
  if (application) {
    await application.close().catch(() => undefined)
  }
  // 即使内容断言提前失败，也在删除隔离资料前完成凭证泄漏检查。
  if (credentialsWritten && !credentialAuditCompleted) {
    try {
      const leakAudit = await auditTemporaryProfile(temporaryDirectory, Object.values(credentials))
      credentialAuditCompleted = true
      process.stdout.write('[beijing-desktop-live] 隔离资料审计 ' + JSON.stringify(leakAudit) + '\n')
      if (leakAudit.credentialInLogs || leakAudit.credentialInTripData) {
        finalExitCode = 1
        process.stderr.write('[beijing-desktop-live] 凭证审计失败\n')
      }
    } catch {
      finalExitCode = 1
      process.stderr.write('[beijing-desktop-live] 凭证审计失败\n')
    }
  }
  await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {
    finalExitCode = 1
    process.stderr.write('[beijing-desktop-live] 隔离资料清理失败\n')
  })
}
if (finalExitCode !== 0) process.exitCode = finalExitCode
process.stdout.write(`[beijing-desktop-live] 最终退出状态 ${finalExitCode}；结束阶段 ${stage}\n`)

/** 按 Electron 默认位置或显式环境变量找到本机配置目录。 */
function localUserDataDirectory() {
  const override = process.env.TRIPWISE_USER_DATA_DIR?.trim()
  if (override) return resolve(override)
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'tripwise')
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'tripwise')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'tripwise')
}

/** 读取不含密钥的模型设置；拒绝把带认证信息的 URL 带入临时设置。 */
async function readLocalModelConfiguration(directory, { codexCli = false } = {}) {
  const path = join(directory, 'tripwise-data.json')
  const stat = await lstat(path).catch(() => null)
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('profile_settings_unavailable')
  const profile = JSON.parse(await readFile(path, 'utf8'))
  const settings = profile?.settings
  const model = settings?.model
  if (typeof model?.baseUrl !== 'string' || typeof model?.model !== 'string' ||
      !model.model.trim() || !settings.connectors || typeof settings.connectors !== 'object') {
    throw new Error('model_configuration_unavailable')
  }
  const endpoint = new URL(model.baseUrl)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('model_endpoint_invalid')
  }
  const sourceProxyUrl = typeof settings.sourceProxyUrl === 'string' ? settings.sourceProxyUrl : ''
  if (sourceProxyUrl) {
    const proxy = new URL(sourceProxyUrl)
    if (proxy.username || proxy.password || proxy.search || proxy.hash) throw new Error('source_proxy_invalid')
  }
  const provider = codexCli || model.provider === 'codex-cli' ? 'codex-cli' : 'openai-compatible'
  return {
    model: { provider, baseUrl: model.baseUrl, model: provider === 'codex-cli' ? 'gpt-6-luna' : model.model },
    sourceProxyUrl,
    connectors: {
      webSearch: settings.connectors.webSearch === true,
      weather: settings.connectors.weather === true,
      places: settings.connectors.places === true,
      routes: settings.connectors.routes === true
    }
  }
}

/** 只读取真实评测需要的内置凭证，不读取或复制 MCP 插件环境变量。 */
async function readLocalBuiltinCredentials(directory, { includeModelKey = true } = {}) {
  const path = join(directory, 'tripwise-credentials.json')
  const stat = await lstat(path).catch(() => null)
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('credential_file_unavailable')
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('credential_file_permissions_invalid')
  const file = JSON.parse(await readFile(path, 'utf8'))
  if (file?.format !== 'tripwise-credentials' || file?.schemaVersion !== 1 || !file.secrets ||
      typeof file.secrets !== 'object' || Array.isArray(file.secrets)) throw new Error('credential_file_invalid')
  const allowedNames = [
    ...(includeModelKey ? ['modelKey'] : []),
    'amapKey', 'exaKey', 'tavilyKey', 'firecrawlKey'
  ]
  const secrets = Object.fromEntries(allowedNames.flatMap((name) => {
    const value = file.secrets[name]
    return typeof value === 'string' && value.trim() ? [[name, value]] : []
  }))
  if (includeModelKey && !secrets.modelKey) throw new Error('model_credential_unavailable')
  return secrets
}

/** 安装仅记录工具名与事件类型的进度观察器，不保留模型正文或工具参数。 */
async function installEventCapture(page) {
  await page.evaluate(() => {
    window.__beijingDesktopLive = { current: null }
    window.tripwise.onAgentEvent((event) => {
      const current = window.__beijingDesktopLive?.current
      if (!current || current.requestId !== event.requestId) return
      if (event.type === 'tool') current.toolNames.push(event.toolName || 'unknown')
      if (event.type === 'tool_result') {
        current.toolOutcomes.push({ toolName: event.toolName || 'unknown', outcome: event.toolOutcome || 'unknown' })
      }
      if (event.type === 'complete' || event.type === 'error') {
        current.terminal = event.type
        current.errorKind = event.type === 'error'
          ? (/超时/u.test(event.message || '') ? 'timeout' : /取消/u.test(event.message || '') ? 'cancelled' : 'agent_error')
          : ''
      }
    })
  })
}

/** 经真实 Electron IPC 发送消息，并等待 Agent 的完成/错误事件。 */
async function runAgentMessage(page, session, content, label, timeoutMs, metricOptions = {}) {
  const requestId = 'beijing-live-' + randomUUID()
  const startedAt = Date.now()
  await page.evaluate(({ requestId, tripId, conversationId, content }) => {
    const current = { requestId, toolNames: [], toolOutcomes: [], terminal: '', errorKind: '' }
    window.__beijingDesktopLive.current = current
    window.tripwise.sendMessage(requestId, tripId, conversationId, content)
      .catch(() => {
        current.terminal = 'error'
        current.errorKind = 'ipc_error'
      })
  }, { requestId, tripId: session.tripId, conversationId: session.conversationId, content })

  let lastProgressAt = startedAt
  let reportedToolCount = 0
  while (Date.now() - startedAt < timeoutMs) {
    const current = await page.evaluate(() => {
      const state = window.__beijingDesktopLive?.current
      return state ? {
        terminal: state.terminal,
        errorKind: state.errorKind,
        toolNames: [...state.toolNames],
        toolOutcomes: [...state.toolOutcomes]
      } : { terminal: 'missing', errorKind: 'event_listener_missing', toolNames: [], toolOutcomes: [] }
    })
    if (current.toolNames.length > reportedToolCount) {
      const added = current.toolNames.slice(reportedToolCount)
      reportedToolCount = current.toolNames.length
      process.stdout.write('[beijing-desktop-live] ' + label + ' 工具 ' + added.join(', ') + '\n')
    }
    if (current.terminal) {
      process.stdout.write('[beijing-desktop-live] ' + label + ' 终态 ' + JSON.stringify({
        terminal: current.terminal,
        errorKind: current.errorKind
      }) + '\n')
      const readEvidence = async (phase, read) => {
        try { return await read() } catch (error) {
          const metricPhase = phase === 'trip_snapshot'
            ? await page.evaluate(() => window.__beijingDesktopLive?.metricPhase ?? 'unavailable').catch(() => 'context_unavailable')
            : undefined
          throw new Error(`evidence_${phase}_${metricPhase ? metricPhase + '_' : ''}${safeEvidenceFailureKind(error)}`)
        }
      }
      const metrics = await readEvidence('trip_snapshot', () => label === 'weather_smoke'
        ? readWeatherSmokeMetrics(page, session, metricOptions.expectedDates)
        : readRunMetrics(page, session, label))
      const routeDiagnostics = await readEvidence('route_log', () => readRouteRunDiagnostics(temporaryDirectory, startedAt))
      const noOpGate = await readEvidence('noop_log', () => readNoOpGateDiagnostics(temporaryDirectory, startedAt))
      const browserDiagnostics = await readEvidence('browser_log', () => readBrowserRunDiagnostics(temporaryDirectory, startedAt))
      const factEvidenceDiagnostics = await readEvidence('fact_log', () => readFactEvidenceRunDiagnostics(temporaryDirectory, startedAt))
      const mealRepairDiagnostics = await readEvidence('meal_log', () => readMealRepairRunDiagnostics(temporaryDirectory, startedAt))
      routeDiagnostics.modelRouteToolCallCount = current.toolNames.filter((name) => name === 'estimate_route').length
      const toolOutcomeCounts = {}
      for (const item of current.toolOutcomes) {
        const key = `${item.toolName}:${item.outcome}`
        toolOutcomeCounts[key] = (toolOutcomeCounts[key] ?? 0) + 1
      }
      return {
        ...current,
        toolOutcomeCounts,
        ...metrics,
        routeDiagnostics,
        noOpGate,
        browserDiagnostics,
        factEvidenceDiagnostics,
        mealRepairDiagnostics,
        browserNavigateCalls: current.toolNames.filter((name) => name === 'research_browser_navigate').length,
        browserOpenLinkCalls: current.toolNames.filter((name) => name === 'research_browser_open_link').length,
        browserSnapshotCalls: current.toolNames.filter((name) => name === 'research_browser_snapshot').length,
        pageSourceCount: metrics.browserPageSourceCount,
        durationSeconds: Math.round((Date.now() - startedAt) / 1000)
      }
    }
    if (Date.now() - lastProgressAt >= 30_000) {
      process.stdout.write('[beijing-desktop-live] ' + label + ' 运行中 ' +
        Math.round((Date.now() - startedAt) / 1000) + ' 秒\n')
      lastProgressAt = Date.now()
    }
    await page.waitForTimeout(2_000)
  }
  await page.evaluate((requestId) => window.tripwise.cancelAgent(requestId), requestId).catch(() => undefined)
  throw new Error('agent_timeout')
}

/** 只汇总天气来源与日程/穿搭的日期绑定，不读取或输出天气正文。 */
async function readWeatherSmokeMetrics(page, session, expectedDates) {
  return page.evaluate(async ({ tripId, expectedDates }) => {
    const snapshot = await window.tripwise.getSnapshot()
    const trip = snapshot.trips.find((item) => item.id === tripId)
    if (!trip) throw new Error('trip_missing')
    const assistantMessages = trip.messages.filter((message) => message.role === 'assistant')
    const latestPlanMessage = assistantMessages.filter((message) =>
      Array.isArray(message.itineraryOptions) && message.itineraryOptions.length > 0).at(-1)
    const plan = latestPlanMessage?.itineraryOptions?.[0]
    const weatherSources = (trip.sources ?? []).filter((source) => source.kind === 'weather')
    const matchingWeatherSource = (sourceId, date) => {
      const source = weatherSources.find((item) => item.id === sourceId)
      if (!source || source.status !== 'success' || source.contentLevel !== 'structured') return false
      return source.summary.split(/\r?\n/u).some((row) => row.startsWith(`${date}：`) || row.startsWith(`${date}:`))
    }
    const days = expectedDates.map((date) => {
      const day = plan?.days?.find((item) => item.date === date)
      return {
        date,
        forecastBound: day?.weather?.status === 'forecast' && matchingWeatherSource(day.weather.sourceId, date)
      }
    })
    const preparationItems = assistantMessages.flatMap((message) => message.preparationOptions ?? [])
    const clothing = expectedDates.map((date) => ({
      date,
      sourceBound: preparationItems.some((item) => item.category === 'clothing' && item.itineraryDate === date &&
        item.sourceIds?.some((sourceId) => matchingWeatherSource(sourceId, date)))
    }))
    return {
      planCount: plan ? 1 : 0,
      dayCount: plan?.days?.length ?? 0,
      weatherSourceCount: weatherSources.length,
      successfulWeatherSourceCount: weatherSources.filter((source) => source.status === 'success').length,
      dailyForecastCoverage: days.filter((day) => day.forecastBound).length,
      dailyForecasts: days,
      clothingSourceCoverage: clothing.filter((item) => item.sourceBound).length,
      clothingBindings: clothing,
      proposedClothingItemCount: preparationItems.filter((item) => item.category === 'clothing').length
    }
  }, { tripId: session.tripId, expectedDates })
}

/** 只记录本轮浏览器回退的阶段状态，不读取网址、页面文字或错误原文。 */
async function readBrowserRunDiagnostics(userDataDirectory, startedAt) {
  const contents = await readFile(join(userDataDirectory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const entries = contents.split('\n').flatMap((line) => {
    if (!line) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const run = entries.filter((entry) => entry.event === 'agent.run.started' &&
    Date.parse(entry.timestamp) >= startedAt).at(-1)
  if (typeof run?.traceId !== 'string') return { runTraceFound: false }
  const searchProviderOutcomes = searchProviderOutcomeSummary(entries, run.traceId)
  const browserToolOutcomes = browserToolOutcomeSummary(entries, run.traceId)
  const fallbacks = entries.filter((entry) => entry.traceId === run.traceId &&
    entry.event === 'agent.research.browser_fallback')
  const communityFallbackCount = fallbacks.filter((entry) => entry.browserSearchIntent === 'community').length
  const linkSelectionCounts = fallbacks.reduce((counts, entry) => {
    const selection = entry.browserLinkSelection
    if (typeof selection === 'string') counts[selection] = (counts[selection] ?? 0) + 1
    return counts
  }, {})
  const linkSelectionByIntent = fallbacks.reduce((counts, entry) => {
    const intent = entry.browserSearchIntent
    const selection = entry.browserLinkSelection
    if (!['general', 'meal', 'community', 'transit', 'attraction'].includes(intent) ||
        typeof selection !== 'string') return counts
    counts[intent] ??= {}
    counts[intent][selection] = (counts[intent][selection] ?? 0) + 1
    return counts
  }, {})
  const allowedSelectionReasons = new Set([
    'not_attempted', 'selected', 'no_actionable_links', 'no_public_links', 'attraction_name_missing',
    'attraction_name_not_found', 'attraction_information_hint_missing', 'government_fact_query_not_matched',
    'meal_result_not_found', 'no_community_link',
    'community_query_not_matched', 'government_transit_link_not_found',
    'general_relevance_below_threshold', 'intent_policy_no_match'
  ])
  const linkSelectionReasonCountsByIntent = fallbacks.reduce((counts, entry) => {
    const intent = entry.browserSearchIntent
    const reason = entry.browserLinkSelectionReason
    if (!['general', 'meal', 'community', 'transit', 'attraction'].includes(intent) ||
        !allowedSelectionReasons.has(reason)) return counts
    counts[intent] ??= {}
    counts[intent][reason] = (counts[intent][reason] ?? 0) + 1
    return counts
  }, {})
  const linkOpenStatusCounts = fallbacks.reduce((counts, entry) => {
    const status = entry.browserLinkOpenStatus
    if (typeof status === 'string') counts[status] = (counts[status] ?? 0) + 1
    return counts
  }, {})
  const linkFailureKindCounts = fallbacks.reduce((counts, entry) => {
    const kind = entry.browserLinkFailureKind
    if (typeof kind === 'string') counts[kind] = (counts[kind] ?? 0) + 1
    return counts
  }, {})
  const retryProgressCodes = new Set([
    'browser_navigation_read_completed', 'browser_navigation_read_partial', 'browser_search_results_read',
    'browser_navigation_read_blocked', 'browser_navigation_read_unavailable'
  ])
  const linkRetryProgressCodeCounts = fallbacks.reduce((counts, entry) => {
    const code = entry.browserLinkRetryProgressCode
    if (retryProgressCodes.has(code)) counts[code] = (counts[code] ?? 0) + 1
    return counts
  }, {})
  const navigationFailureStageCounts = fallbacks.reduce((counts, entry) => {
    const stage = entry.browserNavigationFailureStage
    if (['requested', 'started', 'redirected', 'committed'].includes(stage)) {
      counts[stage] = (counts[stage] ?? 0) + 1
    }
    return counts
  }, {})
  const linkFailureStageCounts = fallbacks.reduce((counts, entry) => {
    const stage = entry.browserLinkFailureStage
    if ([
      'snapshot_page_changed', 'target_not_in_snapshot', 'snapshot_registry_missing',
      'snapshot_registry_page_changed', 'snapshot_target_missing', 'snapshot_target_url_missing',
      'target_not_found_after_rerender', 'target_ambiguous_after_rerender',
      'target_not_rendered', 'target_detached_during_scroll', 'target_scroll_unstable',
      'target_scroll_did_not_move', 'target_scroll_incomplete', 'cursor_action_failed', 'cursor_script_execution'
    ].includes(stage)) {
      counts[stage] = (counts[stage] ?? 0) + 1
    }
    return counts
  }, {})
  const linkCountSamples = fallbacks.flatMap((entry) =>
    Number.isInteger(entry.browserVisibleLinkCount) ? [entry.browserVisibleLinkCount] : [])
  const visibleLinkCounts = {
    observedSnapshots: linkCountSamples.length,
    emptySnapshots: linkCountSamples.filter((count) => count === 0).length,
    nonEmptySnapshots: linkCountSamples.filter((count) => count > 0).length,
    totalVisibleLinks: linkCountSamples.reduce((sum, count) => sum + count, 0),
    maximumPerSnapshot: Math.max(0, ...linkCountSamples)
  }
  const circuitOpened = entries.find((entry) => entry.traceId === run.traceId &&
    entry.event === 'agent.research.browser_circuit_opened')
  const hostCircuitOpenedCount = entries.filter((entry) => entry.traceId === run.traceId &&
    entry.event === 'agent.research.browser_host_circuit_opened').length
  const skippedCount = fallbacks.filter((entry) => entry.status === 'skipped').length
  if (fallbacks.length === 0) {
    return {
      attempted: false, communityFallbackCount, linkSelectionCounts, linkSelectionByIntent,
      linkSelectionReasonCountsByIntent, linkOpenStatusCounts, linkFailureKindCounts,
      linkRetryProgressCodeCounts,
      navigationFailureStageCounts,
      linkFailureStageCounts, visibleLinkCounts, searchProviderOutcomes, browserToolOutcomes,
      skippedCount, circuitOpened: !!circuitOpened, hostCircuitOpenedCount
    }
  }
  const pageReadCount = fallbacks.filter((entry) => entry.browserContentLevel === 'page' && entry.status === 'completed').length
  const snippetReadCount = fallbacks.filter((entry) => entry.browserContentLevel === 'snippet' && entry.status === 'partial').length
  const failedNavigationCount = fallbacks.filter((entry) => entry.browserNavigationStatus === 'failed').length
  const navigationFailureKinds = fallbacks.reduce((counts, entry) => {
    const kind = entry.browserNavigationFailureKind
    if (typeof kind === 'string') counts[kind] = (counts[kind] ?? 0) + 1
    return counts
  }, {})
  const attemptedCount = fallbacks.filter((entry) => entry.status !== 'skipped').length
  return {
    attempted: attemptedCount > 0,
    communityFallbackCount,
    status: pageReadCount > 0 && failedNavigationCount === 0 ? 'completed' : pageReadCount > 0 ? 'partial' : 'degraded',
    navigation: failedNavigationCount > 0 ? 'partial' : attemptedCount > 0 ? 'opened' : 'unavailable',
    snapshot: pageReadCount + snippetReadCount > 0 ? 'read' : 'unavailable',
    contentLevel: pageReadCount > 0 ? 'page' : snippetReadCount > 0 ? 'snippet' : 'none',
    attemptedCount,
    linkSelectionCounts,
    linkSelectionByIntent,
    linkSelectionReasonCountsByIntent,
    linkOpenStatusCounts,
    linkFailureKindCounts,
    linkRetryProgressCodeCounts,
    navigationFailureStageCounts,
    linkFailureStageCounts,
    visibleLinkCounts,
    searchProviderOutcomes,
    browserToolOutcomes,
    pageReadCount,
    snippetReadCount,
    failedNavigationCount,
    navigationFailureKinds,
    circuitOpened: !!circuitOpened,
    skippedCount,
    hostCircuitOpenedCount,
    ...(Number.isInteger(circuitOpened?.browserCircuitFailureCount)
      ? { circuitFailureCount: circuitOpened.browserCircuitFailureCount }
      : {})
  }
}

/** 汇总具名餐次补修状态，只输出缺口计数和固定状态，不保留店名或查询内容。 */
async function readMealRepairRunDiagnostics(userDataDirectory, startedAt) {
  const contents = await readFile(join(userDataDirectory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const entries = contents.split('\n').flatMap((line) => {
    if (!line) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const run = entries.filter((entry) => entry.event === 'agent.run.started' &&
    Date.parse(entry.timestamp) >= startedAt).at(-1)
  if (typeof run?.traceId !== 'string') return { runTraceFound: false }
  const runEntries = entries.filter((entry) => entry.traceId === run.traceId)
  const evaluations = runEntries.filter((entry) => entry.event === 'agent.meal_repair.evaluated')
  const rounds = runEntries.filter((entry) => entry.event === 'agent.meal_repair.round_completed')
  const missingToolCalls = runEntries.filter((entry) => entry.event === 'agent.meal_repair.tool_call_missing')
  const last = rounds.at(-1)
  return {
    runTraceFound: true,
    evaluationCount: evaluations.length,
    eligibleCount: evaluations.filter((entry) => entry.status === 'ready').length,
    repairRoundCount: rounds.length,
    missingToolCallCount: missingToolCalls.length,
    statusCounts: Object.fromEntries([...new Set(rounds.map((entry) => entry.status))].map((status) => [
      status, rounds.filter((entry) => entry.status === status).length
    ])),
    ...(last ? {
      finalStatus: last.status,
      finalAttempt: Number(last.attempt) || 0,
      remainingTargetCount: Number(last.targetCountAfter) || 0,
      remainingMealGapCount: Number(last.mealGapCount) || 0,
      remainingSourceGapCount: Number(last.sourceGapCount) || 0,
      finalRepairPending: last.mealRepairPending === true
    } : {})
  }
}

/** 只读取 mock 的固定接口名，不输出查询参数、地点或凭证。 */
async function readMockAmapDiagnostics(userDataDirectory) {
  const contents = await readFile(join(userDataDirectory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const operations = contents.split('\n').flatMap((line) => {
    if (!line) return []
    try {
      const record = JSON.parse(line)
      return record.event === 'e2e.amap.mock_response' && typeof record.operation === 'string'
        ? [record.operation]
        : []
    } catch {
      return []
    }
  })
  return {
    requestCount: operations.length,
    transitRouteCount: operations.filter((operation) => operation === 'route_transit').length,
    endpointCounts: Object.fromEntries([...new Set(operations)].map((operation) => [
      operation, operations.filter((item) => item === operation).length
    ]))
  }
}

/** 只输出精简的事实证据计数，区分地点错配与事实值不匹配。 */
async function readFactEvidenceRunDiagnostics(userDataDirectory, startedAt) {
  const contents = await readFile(join(userDataDirectory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const entries = contents.split('\n').flatMap((line) => {
    if (!line) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const run = entries.filter((entry) => entry.event === 'agent.run.started' &&
    Date.parse(entry.timestamp) >= startedAt).at(-1)
  if (typeof run?.traceId !== 'string') return { runTraceFound: false }
  const events = entries.filter((entry) => entry.traceId === run.traceId &&
    entry.event === 'agent.itinerary.fact_evidence')
  const sourceSearchEvents = entries.filter((entry) => entry.traceId === run.traceId &&
    entry.event === 'agent.itinerary.fact_repair.source_search')
  const sum = (field, entries = events) => entries.reduce((total, entry) =>
    total + (Number.isInteger(entry[field]) ? entry[field] : 0), 0)
  const byTool = Object.fromEntries(['propose_itineraries', 'propose_itinerary_facts'].map((toolName) => {
    const toolEvents = events.filter((entry) => entry.toolName === toolName)
    return [toolName, {
      eventCount: toolEvents.length,
      requested: sum('factEvidenceRequestedCount', toolEvents),
      autoBound: sum('factEvidenceAutoBoundCount', toolEvents),
      rejected: sum('factEvidenceRejectedCount', toolEvents),
      placeMismatch: sum('factEvidencePlaceMismatchCount', toolEvents),
      scopeMismatch: sum('factEvidenceScopeMismatchCount', toolEvents),
      valueMismatch: sum('factEvidenceValueMismatchCount', toolEvents)
    }]
  }))
  const rejectedByType = {
    'opening-hours': sum('factEvidenceOpeningHoursRejectedCount'),
    'ticket-price': sum('factEvidenceTicketPriceRejectedCount'),
    booking: sum('factEvidenceBookingRejectedCount'),
    closure: sum('factEvidenceClosureRejectedCount'),
    weather: sum('factEvidenceWeatherRejectedCount'),
    'transport-time': sum('factEvidenceTransportTimeRejectedCount'),
    accessibility: sum('factEvidenceAccessibilityRejectedCount'),
    sunset: sum('factEvidenceSunsetRejectedCount'),
    'photography-rules': sum('factEvidencePhotographyRulesRejectedCount'),
    other: sum('factEvidenceOtherRejectedCount')
  }
  const startedSourceSearches = sourceSearchEvents.filter((entry) => entry.status === 'started')
  const completedSourceSearches = sourceSearchEvents.filter((entry) =>
    entry.status === 'completed' || entry.status === 'degraded'
  )
  const sourceSearchReasons = [...new Set(sourceSearchEvents.map((entry) => entry.reason)
    .filter((reason) => reason === 'browser_budget_exhausted'))]
  return {
    runTraceFound: true,
    proposalCount: events.length,
    requested: sum('factEvidenceRequestedCount'),
    autoBound: sum('factEvidenceAutoBoundCount'),
    rejected: sum('factEvidenceRejectedCount'),
    placeMismatch: sum('factEvidencePlaceMismatchCount'),
    scopeMismatch: sum('factEvidenceScopeMismatchCount'),
    valueMismatch: sum('factEvidenceValueMismatchCount'),
    rejectedByType: Object.fromEntries(Object.entries(rejectedByType).filter(([, count]) => count > 0)),
    sourceSearch: {
      attemptCount: startedSourceSearches.length,
      plannedSearchCount: sum('searchCount', startedSourceSearches),
      completedSearchCount: sum('searchCount', completedSourceSearches),
      openedPageCount: sum('pageCount', completedSourceSearches),
      newlySourcedTargetCount: sum('newlySourcedTargetCount', completedSourceSearches),
      reservedSearchCount: Math.max(0, ...startedSourceSearches.map((entry) =>
        Number.isInteger(entry.reservedSearchCount) ? entry.reservedSearchCount : 0)),
      reservedSearchCountRemaining: completedSourceSearches.at(-1)?.reservedSearchCountRemaining ?? null,
      skippedCount: sourceSearchEvents.filter((entry) => entry.status === 'skipped').length,
      skipReasons: sourceSearchReasons
    },
    byTool
  }
}

/** 汇总无变化门槛的固定原因和计数，不读取请求文本或行程正文。 */
async function readNoOpGateDiagnostics(userDataDirectory, startedAt) {
  const contents = await readFile(join(userDataDirectory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const entries = contents.split('\n').flatMap((line) => {
    if (!line) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const run = entries.filter((entry) => entry.event === 'agent.run.started' &&
    Date.parse(entry.timestamp) >= startedAt).at(-1)
  if (typeof run?.traceId !== 'string') return { runTraceFound: false }
  const gate = entries.filter((entry) => entry.traceId === run.traceId &&
    entry.event === 'agent.itinerary_revision.noop_check').at(-1)
  if (!gate) return { runTraceFound: true, decisionRecorded: false }
  const reasons = new Set([
    'resume_pending', 'saved_progress_pending', 'route_repair_pending', 'meal_area_not_satisfied',
    'meal_requirements_unmet', 'meal_source_required', 'eligible'
  ])
  return {
    runTraceFound: true,
    decisionRecorded: true,
    status: gate.status === 'eligible' ? 'eligible' : gate.status === 'blocked' ? 'blocked' : 'unknown',
    reason: reasons.has(gate.reason) ? gate.reason : 'unknown',
    requestedAreaSatisfied: gate.requestedAreaSatisfied === true,
    pendingRestaurantAllowed: gate.pendingRestaurantAllowed === true,
    routeRepairPending: gate.routeRepairPending === true,
    savedProgressPresent: gate.savedProgressPresent === true,
    resumed: gate.resumed === true,
    mealGapCount: Number.isInteger(gate.mealGapCount) ? gate.mealGapCount : 0,
    sourceGapCount: Number.isInteger(gate.sourceGapCount) ? gate.sourceGapCount : 0
  }
}

/** 只汇总当前 Agent 回合的路线调用计数；日志不输出地点、请求参数或内部 ID。 */
async function readRouteRunDiagnostics(userDataDirectory, startedAt) {
  const contents = await readFile(join(userDataDirectory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const entries = contents.split('\n').flatMap((line) => {
    if (!line) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const run = entries.filter((entry) => entry.event === 'agent.run.started' &&
    Date.parse(entry.timestamp) >= startedAt).at(-1)
  if (typeof run?.traceId !== 'string') return { runTraceFound: false }
  const runEntries = entries.filter((entry) => entry.traceId === run.traceId)
  // 仅汇总固定工具的脱敏耗时；并行工具累计时长可能大于墙钟时间。
  const allowedToolNames = new Set([
    'search_web', 'get_weather', 'find_places', 'estimate_route', 'read_webpage',
    'research_browser_navigate', 'research_browser_snapshot', 'research_browser_open_link',
    'research_browser_scroll', 'research_browser_interact', 'research_browser_visual_read',
    'propose_trip_brief', 'propose_itineraries', 'propose_itinerary_meals',
    'propose_itinerary_facts', 'propose_preparation'
  ])
  const toolDurationByName = {}
  for (const entry of runEntries) {
    if (!['agent.tool.returned', 'agent.tool.failed'].includes(entry.event) ||
        !allowedToolNames.has(entry.toolName) || !Number.isSafeInteger(entry.durationMs) ||
        entry.durationMs < 0 || entry.durationMs > 5_400_000) continue
    const item = toolDurationByName[entry.toolName] ?? {
      callCount: 0, totalDurationMs: 0, maxDurationMs: 0, outcomes: {}
    }
    item.callCount += 1
    item.totalDurationMs += entry.durationMs
    item.maxDurationMs = Math.max(item.maxDurationMs, entry.durationMs)
    const outcome = entry.event === 'agent.tool.failed' ? 'failed'
      : ['completed', 'partial', 'rejected'].includes(entry.status) ? entry.status : 'other'
    item.outcomes[outcome] = (item.outcomes[outcome] ?? 0) + 1
    toolDurationByName[entry.toolName] = item
  }
  const toolDurationTotalMs = Object.values(toolDurationByName)
    .reduce((total, item) => total + item.totalDurationMs, 0)
  const revisionScope = runEntries.filter((entry) => entry.event === 'agent.itinerary_revision.scope')
    .map((entry) => ({
      baselineAvailable: entry.baselineAvailable === true,
      baselineDayCount: Number(entry.baselineDayCount) || 0,
      protectedDayCount: Number(entry.protectedDayCount) || 0,
      excludedStopCount: Number(entry.excludedStopCount) || 0,
      targetDayCount: Number(entry.targetDayCount) || 0
    })).at(-1)
  const routeSummary = routeLookupSummary(runEntries, run.traceId)
  const latestBindingDiagnostic = runEntries
    .filter((item) => item.event === 'agent.route.binding_diagnostic').at(-1)
  const bindingIssueFields = [
    'routeBindingNoAdjacentCount', 'routeBindingModeMismatchCount', 'routeBindingDateMismatchCount',
    'routeBindingTimeMismatchCount', 'routeBindingSummaryUnreadableCount', 'routeBindingMatchingButUnlinkedCount'
  ]
  const bindingIssueCounts = Object.fromEntries(bindingIssueFields.map((field) => [field, 0]))
  for (const entry of runEntries.filter((item) => item.event === 'agent.route.binding_diagnostic')) {
    for (const field of bindingIssueFields) {
      const count = Number(entry[field])
      if (Number.isSafeInteger(count) && count >= 0 && count <= 100) {
        bindingIssueCounts[field] += count
      }
    }
  }
  const modelRequests = runEntries.filter((entry) => entry.event === 'llm.request.started')
  const modelResponses = runEntries.filter((entry) => entry.event === 'llm.request.completed')
  const modelFailures = runEntries.filter((entry) => entry.event === 'llm.request.failed')
  const modelAttempts = runEntries.filter((entry) => entry.event === 'llm.request.attempt.started')
  const responseHeaders = runEntries.filter((entry) => entry.event === 'llm.response.headers.received')
  const modelStreams = runEntries.filter((entry) => entry.event === 'llm.stream.completed')
  const modelLengthRetries = runEntries.filter((entry) => entry.event === 'llm.response.length_retry')
  const modelPhaseMetrics = {}
  const allowedModelPhases = new Set([
    'research', 'itinerary_candidate', 'itinerary_fact_repair', 'itinerary_meal_repair',
    'forced_itinerary', 'preparation'
  ])
  let currentModelPhase = 'other'
  const phaseMetrics = new Map()
  for (const entry of runEntries) {
    if (entry.event === 'agent.request.prepared') {
      currentModelPhase = allowedModelPhases.has(entry.phase) ? entry.phase : 'other'
      continue
    }
    if (!String(entry.event).startsWith('llm.')) continue
    const metrics = phaseMetrics.get(currentModelPhase) ?? {
      requestCount: 0, attemptCount: 0, totalDurationMs: 0, maxDurationMs: 0,
      maxRequestBytes: 0, maxMessageCharacters: 0, maxToolMessageCharacters: 0,
      maxResponseHeadersMs: 0, maxStreamDurationMs: 0, maxResponseBytes: 0,
      maxToolCallArgumentBytes: 0, maxFirstChunkMs: 0, maxFirstContentMs: 0,
      maxFirstToolCallMs: 0, maxReasoningBytes: 0, maxStreamChunkCount: 0
    }
    if (entry.event === 'llm.request.attempt.started') {
      metrics.attemptCount += 1
      metrics.maxRequestBytes = Math.max(metrics.maxRequestBytes, Number(entry.requestBytes) || 0)
      metrics.maxMessageCharacters = Math.max(metrics.maxMessageCharacters, Number(entry.messageCharacters) || 0)
      metrics.maxToolMessageCharacters = Math.max(metrics.maxToolMessageCharacters, Number(entry.toolMessageCharacters) || 0)
    } else if (entry.event === 'llm.response.headers.received') {
      metrics.maxResponseHeadersMs = Math.max(metrics.maxResponseHeadersMs, Number(entry.responseHeadersMs) || 0)
    } else if (entry.event === 'llm.stream.completed') {
      metrics.maxStreamDurationMs = Math.max(metrics.maxStreamDurationMs, Number(entry.streamDurationMs) || 0)
      metrics.maxResponseBytes = Math.max(metrics.maxResponseBytes, Number(entry.responseBytes) || 0)
      metrics.maxToolCallArgumentBytes = Math.max(metrics.maxToolCallArgumentBytes, Number(entry.toolCallArgumentBytes) || 0)
      metrics.maxFirstChunkMs = Math.max(metrics.maxFirstChunkMs, Number(entry.firstChunkMs) || 0)
      metrics.maxFirstContentMs = Math.max(metrics.maxFirstContentMs, Number(entry.firstContentMs) || 0)
      metrics.maxFirstToolCallMs = Math.max(metrics.maxFirstToolCallMs, Number(entry.firstToolCallMs) || 0)
      metrics.maxReasoningBytes = Math.max(metrics.maxReasoningBytes, Number(entry.reasoningBytes) || 0)
      metrics.maxStreamChunkCount = Math.max(metrics.maxStreamChunkCount, Number(entry.streamChunkCount) || 0)
    } else if (entry.event === 'llm.request.completed') {
      const durationMs = Number(entry.durationMs) || 0
      metrics.requestCount += 1
      metrics.totalDurationMs += durationMs
      metrics.maxDurationMs = Math.max(metrics.maxDurationMs, durationMs)
    }
    phaseMetrics.set(currentModelPhase, metrics)
  }
  for (const [phase, metrics] of phaseMetrics) modelPhaseMetrics[phase] = metrics
  const contextCompactions = runEntries.filter((entry) => entry.event === 'agent.context.compacted')
  const rejectedProposals = runEntries.filter((entry) => entry.event === 'agent.itinerary.submission_rejected')
  const endpointResolutions = runEntries.filter((entry) => entry.event === 'amap.route.endpoint_resolution')
  const failure = runEntries.filter((entry) => entry.event === 'agent.run.failed').at(-1)
  const progressSaveFailure = runEntries.filter((entry) => entry.event === 'agent.run.progress_save_failed').at(-1)
  const rejectionReasons = {}
  for (const entry of rejectedProposals) {
    const reason = typeof entry.reason === 'string' && /^[a-z_]{2,60}$/u.test(entry.reason)
      ? entry.reason : 'other'
    rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1
  }
  const endpointReasonCounts = {}
  const terminalEndpoints = new Map()
  for (const entry of endpointResolutions) {
    const stage = typeof entry.routeResolutionStage === 'string' ? entry.routeResolutionStage : 'unknown'
    const status = typeof entry.routeResolutionStatus === 'string' ? entry.routeResolutionStatus : 'unknown'
    const reason = typeof entry.routeResolutionReason === 'string' ? entry.routeResolutionReason : status
    const key = `${stage}:${reason}`
    endpointReasonCounts[key] = (endpointReasonCounts[key] ?? 0) + 1
    if (typeof entry.routeAttemptId === 'string' && ['origin', 'destination'].includes(entry.routePointRole)) {
      terminalEndpoints.set(`${entry.routeAttemptId}:${entry.routePointRole}`, `${entry.routePointRole}:${stage}:${reason}`)
    }
  }
  const terminalEndpointCounts = {}
  for (const key of terminalEndpoints.values()) terminalEndpointCounts[key] = (terminalEndpointCounts[key] ?? 0) + 1
  const providerFailureCounts = {}
  const allowedProviders = new Set(['Exa', 'Tavily', 'Firecrawl', 'DuckDuckGo'])
  const allowedReasons = new Set(['quota', 'plan_limit', 'rate_limit', 'access_error', 'server_error', 'network_or_timeout', 'request_error', 'endpoint_error', 'provider_or_format_error'])
  for (const entry of entries.filter((item) => item.event === 'search.provider.disabled' &&
    Date.parse(item.timestamp) >= startedAt)) {
    if (!allowedProviders.has(entry.searchProvider) || !allowedReasons.has(entry.reason)) continue
    const key = `${entry.searchProvider}:${entry.reason}`
    providerFailureCounts[key] = (providerFailureCounts[key] ?? 0) + 1
  }
  return {
    runTraceFound: true,
    toolDurations: {
      completedCallCount: Object.values(toolDurationByName).reduce((total, item) => total + item.callCount, 0),
      summedDurationMs: toolDurationTotalMs,
      byName: toolDurationByName
    },
    revisionScope: revisionScope ?? null,
    ...(typeof failure?.errorKind === 'string' ? { runFailureKind: safeRunFailureKind(failure.errorKind) } : {}),
    ...(typeof failure?.stage === 'string' ? { runFailureStage: safeRunFailureStage(failure.stage) } : {}),
    ...(typeof failure?.persistenceFailureKind === 'string' &&
      ['message_schema', 'conversation_reference', 'duplicate_message', 'source_reference_missing',
        'source_not_successful', 'lodging_route_mismatch', 'schedule_conflict', 'unknown'].includes(failure.persistenceFailureKind)
      ? { persistenceFailureKind: failure.persistenceFailureKind } : {}),
    ...(typeof progressSaveFailure?.reason === 'string' &&
      ['itinerary_schema', 'progress_schema', 'store_rejected'].includes(progressSaveFailure.reason)
      ? { progressSaveFailureKind: progressSaveFailure.reason } : {}),
    ...routeSummary,
    routeToolVisibility: routeToolVisibilitySummary(runEntries, run.traceId),
    routeBindingCounts: latestBindingDiagnostic ? {
      ...safeNumericFields(latestBindingDiagnostic, [
        'routeAvailableCount', 'routeCurrentRunCount', 'routeLinkedCount', 'routeUnboundCount'
      ]),
      issueCounts: bindingIssueCounts
    } : undefined,
    rejectionReasons,
    endpointReasonCounts,
    terminalEndpointCounts,
    providerFailureCounts,
    routeConflictRepair: routeConflictRepairSummary(runEntries, run.traceId),
    modelDiagnostics: {
      requestCount: modelRequests.length,
      completedCount: modelResponses.length,
      failedCount: modelFailures.length,
      lengthRetryCount: modelLengthRetries.length,
      failureDetails: modelFailureSummary(runEntries, run.traceId),
      toolCallCount: modelResponses.reduce((sum, entry) => sum + (Number(entry.toolCallCount) || 0), 0),
      emptyToolResponseCount: modelResponses.filter((entry) => Number(entry.toolCallCount) === 0).length,
      totalDurationSeconds: Math.round(modelResponses.reduce((sum, entry) => sum + (Number(entry.durationMs) || 0), 0) / 1000),
      maxDurationSeconds: Math.round(Math.max(0, ...modelResponses.map((entry) => Number(entry.durationMs) || 0)) / 1000),
      contextCompaction: {
        eventCount: contextCompactions.length,
        removedCallCount: contextCompactions.reduce((sum, entry) => sum + (Number(entry.removedCallCount) || 0), 0),
        savedCharacters: contextCompactions.reduce((sum, entry) => sum + (Number(entry.contextCharactersSaved) || 0), 0)
      },
      phaseMetrics: modelPhaseMetrics,
      requestShapes: modelAttempts.slice(-20).map((entry) => ({
        ...safeNumericFields(entry, [
          'requestBytes', 'messageCharacters', 'systemMessageCharacters', 'userMessageCharacters',
          'assistantMessageCharacters', 'toolMessageCharacters', 'toolCallArgumentCharacters',
          'toolSchemaCharacters', 'messageCount', 'toolCount', 'maxTokens'
        ]),
        ...(isSafeReasoningEffort(entry.reasoningEffort) ? { reasoningEffort: entry.reasoningEffort } : {})
      })),
      responseHeaderWaitMs: responseHeaders.slice(-20).flatMap((entry) =>
        typeof entry.responseHeadersMs === 'number' && Number.isFinite(entry.responseHeadersMs)
          ? [entry.responseHeadersMs] : []),
      streamMetrics: modelStreams.slice(-20).map((entry) => safeNumericFields(entry, [
        'streamDurationMs', 'streamChunkCount', 'firstChunkMs', 'firstContentMs', 'firstToolCallMs',
        'responseBytes', 'reasoningBytes', 'contentBytes', 'toolCallArgumentBytes'
      ]))
    }
  }
}

/** 只返回运行日志定义的固定失败类别，不暴露异常正文。 */
function safeRunFailureKind(value) {
  const allowed = new Set([
    'cancelled', 'timeout', 'quota_exceeded', 'rate_limited', 'http_error', 'network_error',
    'output_limit', 'preparation_incomplete', 'itinerary_incomplete', 'empty_model_response',
    'content_filtered', 'invalid_model_response', 'response_read_error', 'input_error', 'unknown_error'
  ])
  return allowed.has(value) ? value : 'other_error'
}

/** 只公开 Agent 记录的固定失败阶段，不输出模型内容或异常原文。 */
function safeRunFailureStage(value) {
  const allowed = new Set([
    'setup', 'preflight', 'tool_recovery', 'tool_loop', 'model_request', 'model_response',
    'tool_execution', 'finalization', 'result_persistence', 'completion_checks'
  ])
  return allowed.has(value) ? value : 'other_stage'
}

/** 从运行日志提取有限数值字段；评测摘要不携带提示词或网页正文。 */
function safeNumericFields(entry, fields) {
  return Object.fromEntries(fields.flatMap((field) =>
    typeof entry[field] === 'number' && Number.isFinite(entry[field])
      ? [[field, entry[field]]] : []))
}

/** 只允许记录 Agent 主流程声明的推理档位枚举。 */
function isSafeReasoningEffort(value) {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'max'
}

/** 只计算脱敏行程质量计数；不返回地点名、备注、正文、网址或内部 ID。 */
async function readRunMetrics(page, session, label) {
  return page.evaluate(async ({ tripId, label }) => {
    const markMetricPhase = (phase) => { window.__beijingDesktopLive.metricPhase = phase }
    markMetricPhase('snapshot')
    const snapshot = await window.tripwise.getSnapshot()
    markMetricPhase('trip')
    const trip = snapshot.trips.find((item) => item.id === tripId)
    if (!trip) throw new Error('trip_missing')
    markMetricPhase('itinerary')
    const assistantDrafts = trip.messages.filter((message) =>
      message.role === 'assistant' && Array.isArray(message.itineraryOptions) && message.itineraryOptions.length > 0)
    const latestAssistantMessage = trip.messages.filter((message) => message.role === 'assistant').at(-1)
    const noOp = latestAssistantMessage?.content === '当前草案已满足这项修改，行程未变。'
    const message = assistantDrafts.at(-1)
    const options = message?.itineraryOptions ?? []
    const plan = options[0]
    const days = plan?.days ?? []
    const stops = days.flatMap((day) => day.stops ?? [])
    const blocks = days.flatMap((day) => day.scheduleBlocks ?? [])
    markMetricPhase('source_evidence')
    const sources = trip.sources ?? []
    const modelContextSources = [...sources]
      .sort((left, right) => {
        const priority = (source) => {
          if (source.status === 'success' && source.kind === 'web' && source.contentLevel === 'page' &&
              source.sourceNature !== 'community-platform' && source.factEvidenceExcerpt?.trim()) return 0
          if (source.status === 'success' && ['weather', 'place', 'route', 'user', 'plugin'].includes(source.kind)) return 1
          if (source.status === 'success') return 2
          if (source.status === 'partial') return 3
          return 4
        }
        return priority(left) - priority(right) || right.fetchedAt.localeCompare(left.fetchedAt)
      })
      .slice(0, 20)
    const factEvidencePages = modelContextSources.filter((source) => source.kind === 'web' &&
      source.status === 'success' && source.contentLevel === 'page' && source.sourceNature !== 'community-platform' &&
      typeof source.factEvidenceExcerpt === 'string' && source.factEvidenceExcerpt.trim())
    const normalizeEvidenceText = (value) => String(value ?? '').normalize('NFKC')
      .replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase()
    const placeNameGroups = [
      ['北京大学', '北大', '燕园'], ['清华大学', '清华', '清华园'],
      ['故宫博物院', '故宫', '紫禁城'], ['颐和园', '清漪园'],
      ['中国国家博物馆', '国家博物馆', '国博'],
      ['北京孔庙和国子监博物馆', '孔庙和国子监', '孔庙', '国子监'],
      ['国家体育场', '鸟巢'], ['国家游泳中心', '水立方'],
      ['天安门广场', '天安门地区', '天安门'], ['前门大街', '前门'], ['八达岭长城', '八达岭']
    ]
    const placeAliases = (placeName) => {
      const normalized = normalizeEvidenceText(placeName)
      if (!normalized) return []
      const aliases = new Set([normalized])
      for (const prefix of ['中华人民共和国', '中国', '北京市', '北京', '天津市', '天津', '上海市', '上海', '重庆市', '重庆']) {
        const normalizedPrefix = normalizeEvidenceText(prefix)
        if (normalized.startsWith(normalizedPrefix) && normalized.length - normalizedPrefix.length >= 3) {
          aliases.add(normalized.slice(normalizedPrefix.length))
        }
      }
      aliases.add(normalized.replace(/(?:风景名胜区|风景区|遗址公园|博物院|博物馆|景区|公园|遗址)$/u, ''))
      const group = placeNameGroups.find((names) => names.some((name) => normalizeEvidenceText(name) === normalized))
      group?.forEach((name) => aliases.add(normalizeEvidenceText(name)))
      return [...aliases].filter((alias) => alias.length >= 2)
    }
    const matchingEvidencePages = (stop) => {
      const aliases = placeAliases(stop.name)
      if (!aliases.length) return []
      return factEvidencePages.filter((source) => {
        const sourceText = normalizeEvidenceText([
          source.title, source.summary, source.factEvidenceExcerpt, source.location?.label
        ].filter(Boolean).join(' '))
        return aliases.some((alias) => sourceText.includes(alias))
      })
    }
    const sourceEvidenceCandidatesByType = {
      placesWithMatchingPage: 0,
      openingHoursTimeRanges: 0,
      bookingStatements: 0,
      ticketPriceStatements: 0
    }
    for (const stop of stops) {
      if (!/景点|景区|博物馆|公园|寺|庙|宫|园|遗址|长城/u.test(`${stop.category} ${stop.name}`)) continue
      const matchingPages = matchingEvidencePages(stop)
      if (matchingPages.length) sourceEvidenceCandidatesByType.placesWithMatchingPage += 1
      const pageText = matchingPages.map((source) => source.factEvidenceExcerpt).join('\n')
      if (/开放|营业|闭馆|闭园|停止入园|停止入场/u.test(pageText) &&
          /(?:[01]?\d|2[0-3]):[0-5]\d\s*[-–—~～至到]\s*(?:[01]?\d|2[0-3]):[0-5]\d/u.test(pageText)) {
        sourceEvidenceCandidatesByType.openingHoursTimeRanges += 1
      }
      if (/预约|预订|实名/u.test(pageText)) sourceEvidenceCandidatesByType.bookingStatements += 1
      if (/(?:门票|票价|成人票|学生票|收费|免费|免票)/u.test(pageText) &&
          /(?:¥|￥|\d+(?:\.\d{1,2})?\s*元|免费|免票)/u.test(pageText)) {
        sourceEvidenceCandidatesByType.ticketPriceStatements += 1
      }
    }
    const browserSources = sources.filter((source) => source.provider === 'Tripwise 研究浏览器' && source.status === 'success')
    const pageSources = browserSources.filter((source) => source.contentLevel === 'page')
    const pageSourceNatureCounts = {}
    for (const source of pageSources) {
      const nature = ['government-domain', 'community-platform', 'service', 'user-provided', 'unclassified'].includes(source.sourceNature)
        ? source.sourceNature : 'unclassified'
      pageSourceNatureCounts[nature] = (pageSourceNatureCounts[nature] ?? 0) + 1
    }
    const dpmPageSourceCount = pageSources.filter((source) => {
      try { return new URL(source.url).hostname.endsWith('dpm.org.cn') } catch { return false }
    }).length
    const routeSourceIds = new Set(sources.filter((source) => source.kind === 'route' && source.status === 'success').map((source) => source.id))
    const routeBindingDiagnostics = (() => {
      const routeSources = sources.filter((source) => source.kind === 'route' && source.status === 'success')
      const counts = {
        successfulSources: routeSources.length,
        parsedTitles: 0,
        adjacentEndpointMatches: 0,
        adjacentModeMatches: 0,
        adjacentDateMatches: 0,
        adjacentModeAndDateMatches: 0,
        nonAdjacentEndpointMatches: 0,
        lodgingBoundaryMatches: 0,
        unmatchedEndpoints: 0
      }
      const normalizeEndpoint = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
      const endpointMatches = (titlePart, stopName) => {
        const title = normalizeEndpoint(titlePart)
        const stop = normalizeEndpoint(stopName)
        const shortTitle = normalizeEndpoint(String(titlePart ?? '').replace(/[（(][^）)]*[）)]$/u, ''))
        const shortStop = normalizeEndpoint(String(stopName ?? '').replace(/[（(][^）)]*[）)]$/u, ''))
        return !!title && !!stop && (title === stop || title === shortStop || shortTitle === stop || shortTitle === shortStop)
      }
      for (const source of routeSources) {
        const [origin, destination] = String(source.title ?? '').split('→', 2).map((part) => part.trim())
        if (!origin || !destination) {
          counts.unmatchedEndpoints += 1
          continue
        }
        counts.parsedTitles += 1
        const header = String(source.summary ?? '').split(/\r?\n/u, 1)[0] ?? ''
        const mode = /，公共交通(?:（|估算)/u.test(header) ? 'transit'
          : /，步行(?:（|估算)/u.test(header) ? 'walking'
            : /，驾车(?:（|估算)/u.test(header) ? 'driving' : undefined
        const queryDate = header.match(/20\d{2}-\d{2}-\d{2}/u)?.[0]
        let adjacent = false
        let sameDayPair = false
        let modeMatch = false
        let dateMatch = false
        for (const day of days) {
          for (const [index, stop] of day.stops.entries()) {
            const next = day.stops[index + 1]
            if (!next || !endpointMatches(origin, stop.name) || !endpointMatches(destination, next.name)) continue
            adjacent = true
            sameDayPair = true
            const declaredMode = /步行/u.test(stop.transitToNext) ? 'walking'
              : /打车|出租车|网约车|驾车|自驾/u.test(stop.transitToNext) ? 'driving'
                : /公共交通|地铁|公交|巴士|机场线|接驳/u.test(stop.transitToNext) ? 'transit' : undefined
            if (declaredMode && declaredMode === mode) modeMatch = true
            if (mode !== 'transit' || queryDate === day.date) dateMatch = true
          }
          for (let fromIndex = 0; fromIndex < day.stops.length; fromIndex += 1) {
            for (let toIndex = fromIndex + 1; toIndex < day.stops.length; toIndex += 1) {
              if (endpointMatches(origin, day.stops[fromIndex].name) && endpointMatches(destination, day.stops[toIndex].name)) {
                sameDayPair = true
              }
            }
          }
        }
        const lodging = trip.brief?.lodgingLocation ?? ''
        const lodgingMatch = days.some((day) => {
          const first = day.stops[0]
          const last = day.stops.at(-1)
          return !!lodging && !!first && !!last && (
            (endpointMatches(origin, lodging) && endpointMatches(destination, first.name)) ||
            (endpointMatches(origin, last.name) && endpointMatches(destination, lodging))
          )
        })
        if (adjacent) {
          counts.adjacentEndpointMatches += 1
          if (modeMatch) counts.adjacentModeMatches += 1
          if (dateMatch) counts.adjacentDateMatches += 1
          if (modeMatch && dateMatch) counts.adjacentModeAndDateMatches += 1
        } else if (sameDayPair) {
          counts.nonAdjacentEndpointMatches += 1
        } else if (lodgingMatch) {
          counts.lodgingBoundaryMatches += 1
        } else {
          counts.unmatchedEndpoints += 1
        }
      }
      return counts
    })()
    const claims = stops.flatMap((stop) => stop.factClaims ?? [])
    const sourceById = new Map(sources.map((source) => [source.id, source]))
    const factSourceBindings = {
      sourcedWithPageSource: 0,
      pendingWithPageSource: 0,
      pendingWithOtherSource: 0,
      pendingWithoutSource: 0
    }
    for (const claim of claims) {
      const source = sourceById.get(claim.sourceId)
      const pageSource = source?.kind === 'web' && source.status === 'success' && source.contentLevel === 'page'
      if (claim.evidenceLevel === 'sourced' && pageSource) factSourceBindings.sourcedWithPageSource += 1
      if (claim.evidenceLevel !== 'pending') continue
      if (pageSource) factSourceBindings.pendingWithPageSource += 1
      else if (source) factSourceBindings.pendingWithOtherSource += 1
      else factSourceBindings.pendingWithoutSource += 1
    }
    const sourceCountsByProviderStatusLevel = {}
    for (const source of sources) {
      const provider = source.provider === 'Tripwise 研究浏览器' ? 'browser'
        : source.provider.includes('Exa') ? 'exa'
          : source.provider.includes('Firecrawl') ? 'firecrawl'
            : source.provider.includes('Tavily') ? 'tavily'
              : source.kind === 'route' ? 'route'
                : source.kind === 'weather' ? 'weather'
                  : source.kind === 'place' ? 'place' : 'other'
      const status = ['success', 'partial', 'unavailable', 'error'].includes(source.status) ? source.status : 'other'
      const level = ['page', 'snippet', 'visual-clue', 'structured', 'user-provided', 'plugin', 'status'].includes(source.contentLevel)
        ? source.contentLevel : 'none'
      const key = `${provider}:${status}:${level}`
      sourceCountsByProviderStatusLevel[key] = (sourceCountsByProviderStatusLevel[key] ?? 0) + 1
    }
    const safeFactTypes = new Set([
      'opening-hours', 'ticket-price', 'booking', 'closure', 'weather', 'transport-time',
      'accessibility', 'sunset', 'photography-rules', 'other'
    ])
    const factCountsByTypeAndEvidence = {}
    for (const claim of claims) {
      const type = safeFactTypes.has(claim.type) ? claim.type : 'other'
      const evidence = ['sourced', 'estimated', 'pending'].includes(claim.evidenceLevel) ? claim.evidenceLevel : 'other'
      const key = `${type}:${evidence}`
      factCountsByTypeAndEvidence[key] = (factCountsByTypeAndEvidence[key] ?? 0) + 1
    }
    if (!plan) {
      return {
        planCount: 0,
        dayCount: 0,
        sourceCount: sources.length,
        browserSourceCount: browserSources.length,
        browserPageSourceCount: pageSources.length,
        browserPageCharacters: pageSources.reduce((max, source) => Math.max(max, source.summary.length), 0),
        dpmPageSourceCount,
        governmentDomainPageSourceCount: pageSourceNatureCounts['government-domain'] ?? 0,
        pageSourceNatureCounts,
        sourceCountsByProviderStatusLevel,
        factCountsByTypeAndEvidence,
        factSourceBindings,
        routeSourceCount: routeSourceIds.size,
        savedRevision: trip.activeRevisionId !== null || trip.revisions.length > 0,
        daySignatures: []
      }
    }
    /** 冲突估时仍保留来源供审阅，但不计入可执行路线覆盖。 */
    const boundRouteDays = days.filter((day) => day.stops.some((stop, index) => {
      const next = day.stops[index + 1]
      return !!next && !!stop.transitEstimate && stop.transitEstimate.destinationStopId === next.id &&
        routeSourceIds.has(stop.transitEstimate.sourceId) && stop.sourceIds?.includes(stop.transitEstimate.sourceId) &&
        !/路线与当前时段冲突/u.test(stop.transitToNext)
    }) || (day.lodgingCommutes ?? []).some((commute) =>
      routeSourceIds.has(commute.sourceId) && day.stops.some((stop) => stop.id === commute.stopId)
    )).length
    const requiredMeals = [
      { date: '2026-09-21', slots: ['dinner'] },
      ...['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'].map((date) =>
        ({ date, slots: ['breakfast', 'lunch', 'dinner'] })),
      { date: '2026-09-27', slots: ['breakfast', 'lunch'] }
    ]
    markMetricPhase('meal_metrics')
    /** Playwright 页面函数不继承 Node 闭包；此实现与 beijing-case-metrics.mjs 保持一致。 */
    const mealSlot = (label, time) => {
      if (/早餐|早饭|早间|早晨|早上/u.test(label)) return 'breakfast'
      if (/午餐|午饭|中午/u.test(label)) return 'lunch'
      if (/晚餐|晚饭|傍晚|晚间|晚上/u.test(label)) return 'dinner'
      const match = String(time).match(/(?:^|[^\d])(\d{1,2}):([0-5]\d)(?!\d)/u)
      if (!match) return undefined
      const hour = Number(match[1])
      return hour < 11 ? 'breakfast' : hour < 16 ? 'lunch' : 'dinner'
    }
    /** 识别品牌名并忽略“分店待核验”后缀；不据此判断门店真实性或营业状态。 */
    const hasNonGenericMealVenueName = (value) => {
      const name = String(value ?? '').normalize('NFKC').trim()
        .replace(/^(?:早餐|早饭|午餐|午饭|晚餐|晚饭)[：:]\s*/u, '')
        .replace(/[（(][^（）()]{0,60}(?:门店|分店|店面|店铺).{0,20}(?:待|需|未核实|核验|确认|确定)[^（）()]{0,30}[）)]$/u, '')
        .trim()
      if (name.length < 3 || /附近|周边|就近|待选|待定|待确认|待补|自理|自行|机场内简餐|景区简餐|食宝街|美食街|美食城|餐饮街/u.test(name)) {
        return false
      }
      return !/^(?:早餐|早饭|午餐|午饭|晚餐|晚饭|早中晚餐|用餐|简餐|餐饮|餐馆|餐厅|饭店|就餐)(?:安排)?$/u.test(name)
    }
    // 保护验收指标：店名可计入候选，未确认的具体分店仍单独标待核验。
    if (!hasNonGenericMealVenueName('午餐：北京老字号（具体门店待核验）') ||
        hasNonGenericMealVenueName('晚餐：附近餐馆（具体店面待核验）')) {
      throw new Error('meal_name_metric_regression')
    }
    const mealSlotsFound = requiredMeals.flatMap(({ date, slots }) => {
      const day = days.find((item) => item.date === date)
      const present = new Set()
      for (const stop of day?.stops ?? []) {
        if (!/餐/u.test(stop.category)) continue
        const label = [stop.name, stop.category, stop.time, stop.notes].join(' ')
        const slot = mealSlot(label, stop.time)
        if (slot) present.add(slot)
      }
      for (const block of day?.scheduleBlocks ?? []) {
        if (block.kind !== 'meal') continue
        const slot = mealSlot([block.title, block.time, block.notes].join(' '), block.time)
        if (slot) present.add(slot)
      }
      return slots.filter((slot) => present.has(slot)).map((slot) => ({ date, slot }))
    })
    const mealSlotsMissing = requiredMeals.flatMap(({ date, slots }) => {
      const found = new Set(mealSlotsFound.filter((item) => item.date === date).map((item) => item.slot))
      return slots.filter((slot) => !found.has(slot)).map((slot) => ({ date, slot }))
    })
    const mealVenueRecords = new Map()
    for (const day of days) {
      const addMealVenue = (slot, record) => {
        if (!slot) return
        const key = `${day.date}:${slot}`
        const records = mealVenueRecords.get(key) ?? []
        records.push({
          name: String(record.name ?? '').trim(),
          isStop: typeof record.category === 'string',
          evidenceLevel: record.evidenceLevel === 'sourced' ? 'sourced' : 'pending',
          sourceIds: Array.isArray(record.sourceIds) ? record.sourceIds.filter((id) => typeof id === 'string') : []
        })
        mealVenueRecords.set(key, records)
      }
      for (const stop of day.stops) {
        if (!/餐/u.test(stop.category)) continue
        const slot = mealSlot([stop.name, stop.category, stop.time, stop.notes].join(' '), stop.time)
        addMealVenue(slot, stop)
      }
      for (const block of day.scheduleBlocks) {
        if (block.kind !== 'meal') continue
        const slot = mealSlot([block.title, block.time, block.notes].join(' '), block.time)
        addMealVenue(slot, { ...block, name: block.title })
      }
    }
    const mealVenuesWithNamedCandidate = requiredMeals.flatMap(({ date, slots }) => slots.map((slot) => ({ date, slot })))
      .filter(({ date, slot }) => (mealVenueRecords.get(`${date}:${slot}`) ?? [])
        .some((record) => record.isStop && hasNonGenericMealVenueName(record.name))).length
    const mealVenuesWithNamedCandidateByDate = {}
    const mealVenueEvidenceByDate = {}
    // 只输出来源覆盖统计，不把测试行程中的店名或原始来源内容写入日志。
    const mealVenueEvidence = {
      namedCandidateSlots: 0,
      sourcedNameSlots: 0,
      pendingNameSlots: 0,
      branchPendingNameSlots: 0,
      sourceLinkedNameSlots: 0,
      directNameEvidenceAvailableSlots: 0,
      directNameEvidenceSlots: 0,
      directNameEvidenceUnlinkedSlots: 0
    }
    const mealEvidenceSources = sources.filter((source) =>
      ['success', 'partial'].includes(source.status) && ['web', 'place', 'user', 'plugin'].includes(source.kind))
    // Playwright 不会把 Node 导入带入 page.evaluate；此处保留同一套店名直证规则。
    const normalizeMealEvidenceText = (value) => String(value ?? '').normalize('NFKC')
      .toLocaleLowerCase('zh-CN').replace(/[^\p{L}\p{N}]/gu, '')
    const pageSourceSupportsMealName = (name, source) => {
      const evidence = [source.title, source.summary, source.factEvidenceExcerpt]
        .filter((text) => typeof text === 'string').map(normalizeMealEvidenceText).join(' ')
      const baseName = name.split(/[（(]/u, 1)[0].trim()
      const baseNeedle = normalizeMealEvidenceText(baseName)
      if (baseNeedle.length < 2 || !evidence.includes(baseNeedle)) return false
      const branches = [...name.matchAll(/[（(]([^）)]+)[）)]/gu)]
        .map((match) => normalizeMealEvidenceText(match[1] ?? ''))
      return branches.every((branch) => branch.length >= 2 && evidence.includes(branch))
    }
    if (!pageSourceSupportsMealName('烤鸭（前门店）', { title: '烤鸭 前门店' }) ||
        pageSourceSupportsMealName('烤鸭（王府井店）', { title: '烤鸭 前门店' })) {
      throw new Error('meal_evidence_metric_regression')
    }
    markMetricPhase('meal_evidence')
    for (const requirement of requiredMeals) {
      for (const slot of requirement.slots) {
        // 餐休时间块不是地图地点；只有餐饮停靠点才能证明草案已有具体店面。
        const candidates = (mealVenueRecords.get(`${requirement.date}:${slot}`) ?? [])
          .filter((record) => record.isStop && hasNonGenericMealVenueName(record.name))
        if (candidates.length > 0) {
          const dateCounts = mealVenuesWithNamedCandidateByDate[requirement.date] ??= {}
          dateCounts[slot] = true
          const dateEvidence = mealVenueEvidenceByDate[requirement.date] ??= {}
          const slotEvidence = dateEvidence[slot] ??= {
            sourceLinked: false,
            directNameEvidenceAvailable: false,
            directNameEvidence: false
          }
          // 与运行时门禁一致：只验证第一个具名餐饮停靠点及其直连来源。
          const sourceCheckCandidate = candidates.find((record) => record.isStop)
          if (sourceCheckCandidate) {
            const linkedSourceIds = new Set(sourceCheckCandidate.sourceIds)
            slotEvidence.directNameEvidence = mealEvidenceSources.some((source) =>
              linkedSourceIds.has(source.id) && pageSourceSupportsMealName(sourceCheckCandidate.name, source))
          }
          mealVenueEvidence.namedCandidateSlots += 1
          const candidate = candidates.find((record) => record.evidenceLevel === 'sourced') ??
            candidates.find((record) => record.sourceIds.length > 0) ?? candidates[0]
          if (candidate.evidenceLevel === 'sourced') mealVenueEvidence.sourcedNameSlots += 1
          else mealVenueEvidence.pendingNameSlots += 1
          if (/(?:门店|分店|店面|店铺).{0,20}(?:待|需|未核实|核验|确认|确定)/u.test(candidate.name)) {
            mealVenueEvidence.branchPendingNameSlots += 1
          }
          const availableSources = candidate.sourceIds.map((id) => sourceById.get(id))
            .filter((source) => source && ['success', 'partial'].includes(source.status) &&
              ['web', 'place', 'user', 'plugin'].includes(source.kind))
          if (availableSources.length > 0) {
            mealVenueEvidence.sourceLinkedNameSlots += 1
            slotEvidence.sourceLinked = true
          }
          const matchingAvailableSources = mealEvidenceSources
            .filter((source) => pageSourceSupportsMealName(candidate.name, source))
          if (matchingAvailableSources.length > 0) {
            mealVenueEvidence.directNameEvidenceAvailableSlots += 1
            slotEvidence.directNameEvidenceAvailable = true
          }
          if (matchingAvailableSources.some((source) => candidate.sourceIds.includes(source.id))) {
            mealVenueEvidence.directNameEvidenceSlots += 1
            slotEvidence.directNameEvidence = true
          } else if (matchingAvailableSources.length > 0) {
            mealVenueEvidence.directNameEvidenceUnlinkedSlots += 1
          }
        }
      }
    }
    const mustVisitDates = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']
    markMetricPhase('quality_metrics')
    const exactDateCoverage = days.length === mustVisitDates.length &&
      days.map((day) => day.date).join(',') === mustVisitDates.join(',')
    const campusDay = days.find((day) => day.date === '2026-09-22')
    const campusCoverage = [
      ['清华大学', '清华'], ['北京大学', '北大'], ['圆明园']
    ].filter((names) => names.some((name) => campusDay?.stops.some((stop) => stop.name.includes(name)))).length
    const departureDay = days.find((day) => day.date === '2026-09-27')
    const departureAttraction = departureDay?.stops.some((stop) => {
      const identity = stop.category + ' ' + stop.name
      return /景点|景区|人文|文化|历史|博物馆|公园|寺|庙|宫|园|胡同/u.test(identity) &&
        !/餐|用餐|美食|休息|购物|自由活动|交通|接驳|住宿|酒店|航班|机场|车站|候车|进站/u.test(identity) &&
        !/^(?:地点|景点|景区)(?:待选|待定|待核验)?$/u.test(stop.name.trim())
    }) ?? false
    const mustVisitCoverage = campusCoverage + Number(departureAttraction)
    const targetDate = label === 'revision_1' ? '2026-09-23'
      : label === 'revision_2' ? '2026-09-24' : undefined
    const targetDay = targetDate ? days.find((day) => day.date === targetDate) : undefined
    // 已删除地点仍可能在解释性休息/餐饮/接驳文字中被提及；只把实际地点停靠计为未删除。
    const excludedAttractionStops = (targetDay?.stops ?? []).filter((stop) =>
      /香山|碧云寺/u.test(stop.name) && !['交通', '餐饮', '住宿', '休息'].includes(stop.category)
    )
    /** 页面评测不继承 Node 导入；规则与 beijing-case-metrics.mjs 保持一致。 */
    const hasFrontGateArea = (value) => /前门|大栅栏|鲜鱼口|北京坊|珠市口/u.test(value)
    const hasFrontGateDinner = (day) => {
      const stopHasDinner = (stop) => {
        const mealLabel = `${stop.name} ${stop.category} ${stop.notes}`
        const isMeal = /餐|用餐|美食/u.test(stop.category) || /早餐|早饭|午餐|午饭|晚餐|晚饭|用餐/u.test(mealLabel)
        const location = `${stop.name} ${stop.area} ${stop.notes}`
        const scheduleLabel = `${stop.name} ${stop.category} ${stop.time} ${stop.notes}`
        return isMeal && mealSlot(scheduleLabel, stop.time) === 'dinner' && hasFrontGateArea(location)
      }
      const blockHasDinner = (block) => {
        const location = `${block.title} ${block.area} ${block.notes}`
        return block.kind === 'meal' && mealSlot(`${block.title} ${block.time} ${block.notes}`, block.time) === 'dinner' &&
          hasFrontGateArea(location)
      }
      return (day?.stops ?? []).some(stopHasDinner) || (day?.scheduleBlocks ?? []).some(blockHasDinner)
    }
    const hasFrontGateNamedDinner = (day) => (day?.stops ?? []).some((stop) => {
      const location = `${stop.name} ${stop.area} ${stop.notes}`
      const label = `${stop.name} ${stop.category} ${stop.time} ${stop.notes}`
      return /餐/u.test(stop.category) && mealSlot(label, stop.time) === 'dinner' &&
        hasNonGenericMealVenueName(stop.name) && /前门|大栅栏|鲜鱼口|北京坊|珠市口/u.test(location)
    })
    // 具名晚餐与普通晚餐使用相同的地点字段，避免备注里的片区信息被漏判。
    const frontGateDinnerMetricFixture = {
      stops: [{
        name: '全聚德（前门店，分店待核验）', category: '餐饮', time: '18:30 晚餐',
        area: '', notes: '安排在前门片区，门店信息待核验。'
      }]
    }
    if (!hasFrontGateNamedDinner(frontGateDinnerMetricFixture)) {
      throw new Error('front_gate_named_dinner_metric_regression')
    }
    const frontGateDinnerOnSep24 = hasFrontGateDinner(days.find((day) => day.date === '2026-09-24'))
    const frontGateNamedDinnerOnSep24 = hasFrontGateNamedDinner(days.find((day) => day.date === '2026-09-24'))
    const targetRevisionChecks = label === 'revision_1' ? {
      retainedSummerPalace: targetDay?.stops.some((stop) => stop.name.includes('颐和园')) ?? false,
      removedXiangshanAndBiyunsi: Boolean(targetDay && excludedAttractionStops.length === 0),
      retainedExcludedStopCategoryCounts: excludedAttractionStops.reduce((counts, stop) => {
        const category = ['景点', '交通', '餐饮', '住宿', '休息', '其他'].includes(stop.category) ? stop.category : '其他'
        counts[category] = (counts[category] ?? 0) + 1
        return counts
      }, {}),
      postLunchHotelRest: [
        ...(targetDay?.stops ?? []), ...(targetDay?.scheduleBlocks ?? [])
      ].some((entry) => {
        const time = String(entry.time ?? '').match(/(?:^|[^\d])(\d{1,2}):([0-5]\d)(?!\d)/u)
        const startMinutes = time ? Number(time[1]) * 60 + Number(time[2]) : -1
        const followsLunch = /午餐后|午饭后|午餐结束后|午饭结束后/u.test(String(entry.time ?? ''))
        const content = [entry.name, entry.title, entry.category, entry.area, entry.notes].join(' ')
        return (startMinutes >= 12 * 60 || followsLunch) && /酒店/u.test(content) && /休息|午休/u.test(content)
      })
    } : label === 'revision_2' ? {
      frontGateDinner: hasFrontGateDinner(targetDay),
      frontGateNamedDinner: hasFrontGateNamedDinner(targetDay)
    } : undefined
    const signatures = days.map((day) => {
      const boundRoutes = day.stops.flatMap((stop, index) => {
        const next = day.stops[index + 1]
        const estimate = stop.transitEstimate
        if (!next || !estimate || estimate.destinationStopId !== next.id ||
            !routeSourceIds.has(estimate.sourceId) || !stop.sourceIds?.includes(estimate.sourceId)) return []
        return [{ from: stop.id, to: next.id, estimate }]
      })
      const boundLodgingRoutes = (day.lodgingCommutes ?? []).flatMap((commute) =>
        routeSourceIds.has(commute.sourceId) && day.stops.some((stop) => stop.id === commute.stopId)
          ? [{ direction: commute.direction, stopId: commute.stopId, commute }]
          : [])
      const allBoundRoutes = [...boundRoutes, ...boundLodgingRoutes]
      return {
        date: day.date,
        boundRouteCount: allBoundRoutes.length,
        routeSignature: JSON.stringify(allBoundRoutes),
        signature: JSON.stringify({
        title: day.title,
        stops: day.stops.map(({ name, area, time, durationMinutes, category, notes, transitToNext }) =>
          ({ name, area, time, durationMinutes, category, notes, transitToNext })),
        blocks: day.scheduleBlocks.map(({ kind, title, time, durationMinutes, area, notes }) =>
          ({ kind, title, time, durationMinutes, area, notes }))
        })
      }
    })
    markMetricPhase('final_metrics')
    return {
      noOp,
      planCount: noOp ? 0 : options.length,
      dayCount: days.length,
      exactDateCoverage,
      stopCount: stops.length,
      scheduleBlockCount: blocks.length,
      mealSlotsFound: mealSlotsFound.length,
      mealSlotsExpected: requiredMeals.reduce((total, requirement) => total + requirement.slots.length, 0),
      mealSlotsMissing: mealSlotsMissing.length,
      mealVenuesWithNamedCandidate,
      mealVenuesWithNamedCandidateByDate,
      mealVenueEvidence,
      mealVenueEvidenceByDate,
      mealSourceVerificationEnabled: snapshot.settings.connectors.webSearch &&
        trip.messages.some((item) => item.role === 'user' &&
          /具体(?:店面|店名|店铺|门店|餐馆|餐厅)/u.test(String(item.content ?? ''))),
      mealVenuesWithoutSpecificName: requiredMeals.reduce((total, requirement) => total + requirement.slots.length, 0) - mealVenuesWithNamedCandidate,
      mealSlotsMissingByDate: mealSlotsMissing.reduce((counts, meal) => {
        counts[meal.date] = (counts[meal.date] ?? 0) + 1
        return counts
      }, {}),
      mustVisitCoverage,
      frontGateDinnerOnSep24,
      frontGateNamedDinnerOnSep24,
      browserSourceCount: browserSources.length,
      browserPageSourceCount: pageSources.length,
      browserPageCharacters: pageSources.reduce((max, source) => Math.max(max, source.summary.length), 0),
      browserFactEvidenceCharacters: pageSources.reduce((total, source) => total + (source.factEvidenceExcerpt?.length ?? 0), 0),
      dpmPageSourceCount,
      governmentDomainPageSourceCount: pageSourceNatureCounts['government-domain'] ?? 0,
      pageSourceNatureCounts,
      sourceCount: sources.length,
      sourceCountsByProviderStatusLevel,
      factCountsByTypeAndEvidence,
      factSourceBindings,
      sourceEvidenceCandidatesByType,
      modelContextFactEvidencePageCount: factEvidencePages.length,
      pageEvidenceExcerptSourceCount: sources.filter((source) => source.contentLevel === 'page' &&
        typeof source.factEvidenceExcerpt === 'string' && source.factEvidenceExcerpt.length > 0).length,
      routeSourceCount: routeSourceIds.size,
      boundRouteDays,
      routeBindingDiagnostics,
      pendingFactCount: claims.filter((claim) => claim.evidenceLevel === 'pending').length,
      totalFactCount: claims.length,
      stopsMissingTime: stops.filter((stop) => !String(stop.time).trim()).length,
      stopsWithoutClockTime: stops.filter((stop) => !/(?:^|[^\d])\d{1,2}:[0-5]\d(?!\d)/u.test(String(stop.time))).length,
      blocksMissingTime: blocks.filter((block) => !String(block.time).trim()).length,
      savedRevision: trip.activeRevisionId !== null || trip.revisions.length > 0,
      targetRevisionChecks,
      daySignatures: signatures
    }
  }, { tripId: session.tripId, label })
}

/** 读取隔离配置并只向结果写出凭证是否意外落入日志或旅行数据。 */
async function auditTemporaryProfile(directory, credentials) {
  const log = await readFile(join(directory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const tripData = await readFile(join(directory, 'tripwise-data.json'), 'utf8').catch(() => '')
  return {
    credentialInLogs: credentials.some((credential) => credential.length > 0 && log.includes(credential)),
    credentialInTripData: credentials.some((credential) => credential.length > 0 && tripData.includes(credential)),
    credentialFileMode: process.platform === 'win32'
      ? 'platform-managed'
      : '0' + (await lstat(join(directory, 'tripwise-credentials.json'))).mode.toString(8).slice(-3)
  }
}

/** 只向终端输出可审阅的聚合指标，不输出模型请求明细或来源正文。 */
function summarizeRunMetrics(metrics) {
  const route = metrics.routeDiagnostics ?? {}
  const model = route.modelDiagnostics ?? {}
  const requestSizes = (model.requestShapes ?? []).map((item) => Number(item.requestBytes) || 0)
  const modelPhaseTiming = Object.fromEntries(Object.entries(model.phaseMetrics ?? {}).map(([phase, value]) => [phase, {
    requestCount: Number(value.requestCount) || 0,
    attemptCount: Number(value.attemptCount) || 0,
    totalSeconds: Math.round((Number(value.totalDurationMs) || 0) / 1000),
    maxSeconds: Math.round((Number(value.maxDurationMs) || 0) / 1000),
    maxRequestBytes: Number(value.maxRequestBytes) || 0,
    maxMessageCharacters: Number(value.maxMessageCharacters) || 0,
    maxToolMessageCharacters: Number(value.maxToolMessageCharacters) || 0,
    maxResponseHeadersMs: Number(value.maxResponseHeadersMs) || 0,
    maxStreamSeconds: Math.round((Number(value.maxStreamDurationMs) || 0) / 1000),
    maxFirstChunkMs: Number(value.maxFirstChunkMs) || 0,
    maxFirstContentMs: Number(value.maxFirstContentMs) || 0,
    maxFirstToolCallMs: Number(value.maxFirstToolCallMs) || 0,
    maxReasoningBytes: Number(value.maxReasoningBytes) || 0,
    maxStreamChunkCount: Number(value.maxStreamChunkCount) || 0
  }]))
  return {
    terminal: metrics.terminal,
    errorKind: metrics.errorKind,
    ...(route.runFailureKind ? { runFailureKind: route.runFailureKind } : {}),
    ...(route.runFailureStage ? { runFailureStage: route.runFailureStage } : {}),
    ...runFailureSummary(route),
    durationSeconds: metrics.durationSeconds,
    toolOutcomes: metrics.toolOutcomeCounts ?? {},
    noOp: metrics.noOp,
    planCount: metrics.planCount,
    dayCount: metrics.dayCount,
    ...(metrics.dailyForecastCoverage !== undefined ? { weather: {
      sourceCount: metrics.weatherSourceCount,
      successfulSourceCount: metrics.successfulWeatherSourceCount,
      dailyForecastCoverage: metrics.dailyForecastCoverage,
      dailyForecasts: metrics.dailyForecasts,
      clothingSourceCoverage: metrics.clothingSourceCoverage,
      clothingBindings: metrics.clothingBindings,
      proposedClothingItemCount: metrics.proposedClothingItemCount
    } } : {}),
    exactDateCoverage: metrics.exactDateCoverage,
    stopCount: metrics.stopCount,
    mealSlots: {
      found: metrics.mealSlotsFound,
      expected: metrics.mealSlotsExpected,
      missing: metrics.mealSlotsMissing,
      namedCandidates: metrics.mealVenuesWithNamedCandidate,
      missingNames: metrics.mealVenuesWithoutSpecificName
    },
    mealEvidence: metrics.mealVenueEvidence,
    mealSourceVerificationEnabled: metrics.mealSourceVerificationEnabled,
    mustVisitCoverage: metrics.mustVisitCoverage,
    ...(metrics.frontGateDinnerOnSep24 !== undefined
      ? { frontGateDinnerOnSep24: metrics.frontGateDinnerOnSep24 } : {}),
    ...(metrics.frontGateNamedDinnerOnSep24 !== undefined
      ? { frontGateNamedDinnerOnSep24: metrics.frontGateNamedDinnerOnSep24 } : {}),
    browser: {
      navigateCalls: metrics.browserNavigateCalls,
      openLinkCalls: metrics.browserOpenLinkCalls,
      snapshotCalls: metrics.browserSnapshotCalls,
      pageSources: metrics.browserPageSourceCount,
      dpmPageSources: metrics.dpmPageSourceCount,
      diagnostics: metrics.browserDiagnostics ? {
        attempted: metrics.browserDiagnostics.attempted,
        communityFallbackCount: metrics.browserDiagnostics.communityFallbackCount,
        linkSelectionCounts: metrics.browserDiagnostics.linkSelectionCounts,
        linkSelectionByIntent: metrics.browserDiagnostics.linkSelectionByIntent,
        linkSelectionReasonCountsByIntent: metrics.browserDiagnostics.linkSelectionReasonCountsByIntent,
        linkOpenStatusCounts: metrics.browserDiagnostics.linkOpenStatusCounts,
        linkFailureKindCounts: metrics.browserDiagnostics.linkFailureKindCounts,
        linkFailureStageCounts: metrics.browserDiagnostics.linkFailureStageCounts,
        linkRetryProgressCodeCounts: metrics.browserDiagnostics.linkRetryProgressCodeCounts,
        navigationFailureStageCounts: metrics.browserDiagnostics.navigationFailureStageCounts,
        visibleLinkCounts: metrics.browserDiagnostics.visibleLinkCounts,
        contentLevel: metrics.browserDiagnostics.contentLevel,
        toolOutcomes: metrics.browserDiagnostics.browserToolOutcomes
      } : undefined
    },
    sources: {
      total: metrics.sourceCount,
      providerStatuses: metrics.sourceCountsByProviderStatusLevel,
      searchProviderRequests: metrics.browserDiagnostics?.searchProviderOutcomes ?? {},
      searchProviderFailures: route.providerFailureCounts ?? {}
    },
    facts: {
      total: metrics.totalFactCount,
      pending: metrics.pendingFactCount,
      byType: metrics.factCountsByTypeAndEvidence,
      sourceCandidates: metrics.sourceEvidenceCandidatesByType,
      bindings: metrics.factSourceBindings,
      evidenceDiagnostics: metrics.factEvidenceDiagnostics
    },
    routes: {
      boundDays: metrics.boundRouteDays,
      sourceMatching: metrics.routeBindingDiagnostics,
      toolVisibility: route.routeToolVisibility ?? null,
      lookupCount: route.lookupCount,
      feedbackCodeCounts: route.feedbackCodeCounts ?? {},
      proposalRejections: route.rejectionReasons ?? {},
      outcomeCounts: route.outcomeCounts,
      endpointReasonCounts: route.endpointReasonCounts,
      bindingDiagnostics: route.routeBindingCounts,
      routeOptionCount: route.routeOptionCount,
      durationMs: route.durationMs,
      attemptsByDay: route.attemptsByDay,
      repair: route.routeConflictRepair
    },
    toolDurations: {
      completedCallCount: route.toolDurations?.completedCallCount ?? 0,
      summedSeconds: Math.round((route.toolDurations?.summedDurationMs ?? 0) / 1000),
      byTool: Object.fromEntries(Object.entries(route.toolDurations?.byName ?? {}).map(([name, value]) => [name, {
        calls: value.callCount,
        totalSeconds: Math.round(value.totalDurationMs / 1000),
        maxSeconds: Math.round(value.maxDurationMs / 1000),
        outcomes: value.outcomes
      }]))
    },
    model: {
      requestCount: model.requestCount,
      totalSeconds: model.totalDurationSeconds,
      maxSeconds: model.maxDurationSeconds,
      lengthRetryCount: model.lengthRetryCount,
      maxRequestBytes: Math.max(0, ...requestSizes),
      failureDetails: model.failureDetails,
      phaseTiming: modelPhaseTiming,
      contextCompaction: model.contextCompaction
    },
    noOpGate: metrics.noOpGate,
    mealRepair: metrics.mealRepairDiagnostics ? {
      finalStatus: metrics.mealRepairDiagnostics.finalStatus,
      remainingMealGapCount: metrics.mealRepairDiagnostics.remainingMealGapCount,
      remainingSourceGapCount: metrics.mealRepairDiagnostics.remainingSourceGapCount
    } : undefined,
    targetRevisionChecks: metrics.targetRevisionChecks
  }
}

/** 将系统或断言异常映射为短类别，不把异常正文带到联测输出。 */
function safeErrorKind(error) {
  if (error instanceof Error && /^(?:settings_update|trip_creation)_/u.test(error.message)) return error.message
  if (error instanceof Error && error.message === 'agent_timeout') return 'agent_timeout'
  if (error instanceof Error && /^evidence_(?:trip_snapshot_(?:snapshot|trip|itinerary|source_evidence|meal_metrics|meal_evidence|quality_metrics|final_metrics|unavailable|context_unavailable)_(?:trip_missing|meal_metric_regression|timeout|type_error|reference_error|range_error|runtime_error|other_error)|(?:route_log|noop_log|browser_log|fact_log|meal_log)_(?:trip_missing|meal_metric_regression|timeout|type_error|reference_error|range_error|runtime_error|other_error))$/u.test(error.message)) {
    return error.message
  }
  if (error instanceof Error && error.name === 'AssertionError') {
    const assertions = [
      ['Agent 终态应与日志记录的无变化门槛一致', 'noop_gate_terminal_mismatch'],
      ['指定日期应体现用户要求的修改', 'requested_date_unchanged'],
      ['只有片区和仍适用的餐次要求都满足时才应进入无变化终态', 'unexpected_no_op_state'],
      ['未指定日期应保持不变', 'untouched_date_changed'],
      ['未指定日期的已核对路线应保持不变', 'untouched_route_changed'],
      ['修改后应重新查询该日路线', 'target_route_not_queried'],
      ['9/23 应保留颐和园', 'required_attraction_removed'],
      ['9/23 应移除香山与碧云寺', 'requested_exclusions_retained'],
      ['9/23 午餐后应回酒店休息', 'post_lunch_rest_missing'],
      ['9/24 晚餐应安排在前门片区', 'requested_dinner_area_missing'],
      ['9/24 应保留前门片区的具名晚餐', 'requested_named_dinner_missing']
    ]
    const failure = assertions.find(([message]) => error.message.includes(message))
    return failure ? `quality_assertion_${failure[1]}` : 'quality_assertion'
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'ui_timeout'
  return error instanceof Error ? error.name : 'unknown'
}

/** 把评测器读取错误映射到固定类别，避免把快照或 IPC 正文写入终端。 */
function safeEvidenceFailureKind(error) {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('trip_missing')) return 'trip_missing'
  if (message.includes('meal_name_metric_regression')) return 'meal_metric_regression'
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout'
  if (error instanceof Error && error.name === 'TypeError') return 'type_error'
  if (error instanceof Error && error.name === 'ReferenceError') return 'reference_error'
  if (error instanceof Error && error.name === 'RangeError') return 'range_error'
  if (error instanceof Error && error.name === 'Error') return 'runtime_error'
  return 'other_error'
}

/** 选择北京时间起两天后的两个日期，保证仍处于 Open-Meteo 预报窗口。 */
function upcomingBeijingForecastDates() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const today = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day))
  return [2, 3].map((daysAhead) => new Date(today + daysAhead * 86_400_000).toISOString().slice(0, 10))
}

/** 请求少量日期，验证真实天气结果进入逐日计划和穿搭来源绑定。 */
function weatherSmokePrompt(startDate, endDate) {
  return [
    `请为我规划北京 ${startDate} 至 ${endDate} 的两日轻松短途旅行，生成一份可审阅的结构化计划。`,
    '请查询这两天的逐日天气，再据此安排每天的户外活动和穿搭；只采用天气服务覆盖的数据，其他日期标为未知。',
    '计划必须分别覆盖这两个日期。每日天气摘要需来自对应日期的天气来源；每天至少提供一条适用于当天、并绑定同日天气来源的穿搭准备事项。若查询失败，应将天气标为未知并说明。内容可自行决定，保持简洁。'
  ].join('\n\n')
}

/** 生成北京 9/21 至 9/27 的完整行程请求文本。 */
function beijingPlanningPrompt() {
  return [
    '请为我做北京 2026-09-21 至 2026-09-27 的 5 天 6 晚个人旅行，先给一份完整、可审阅的行程草案。本轮不要并列生成备选方案；我会根据每轮差异继续提出修改意见。尽量按以下线路安排，并保留硬约束。',
    '出发地深圳。9/21 14:30 前到深圳机场，17:00 起飞，19:00 抵达北京大兴；当晚住北京西站周边，只安排晚餐。全程住同一住宿区域。',
    '9/22 必须安排清华、北大、圆明园；9/23 参考颐和园与香山赏秋；9/24 参考天坛、国家博物馆、前门；9/25 参考八达岭长城和鸟巢/水立方；9/26 参考天安门、故宫、景山、北海、什刹海；9/27 只安排雍和宫或一个同等景点，早餐和午餐后回住宿区域取行李，16:30 后不再安排景点或用餐；18:15 从住宿区域出发，19:00 前抵达北京西站候车，20:00 乘车返程，次日傍晚抵达深圳。',
    '按以下逐日时段框架安排；遇到开放、预约或通勤冲突可调整，但固定时刻必须无冲突：9/21 落地后先下机取行李、进城入住，再晚餐；9/22 08:00 出发，09:00–11:15 清华，11:15–12:00 午餐，12:00–14:00 北大，14:30–18:00 圆明园；9/23 08:00–12:15 颐和园，午餐后接驳香山，14:15–16:15 低强度游园、16:15–17:15 碧云寺；9/24 08:00–11:15 天坛，午餐后预留安检，13:30–16:30 国家博物馆，之后前门；9/25 早班车去八达岭、游览至约13:00，返城后看鸟巢/水立方，体力不足时删减夜游；9/26 07:00–08:00 天安门广场，08:30–13:30 故宫（午餐可在馆内），随后景山、北海、什刹海；9/27 09:00 雍和宫，10:45–12:45 孔庙和国子监，12:45–13:45 午餐，之后五道营、回住宿区域取行李，16:30 后只安排返程准备，18:15 从住宿区域出发、19:00 前抵达北京西站、20:00 发车。路线时长仍以来源为准；本案例为合成测试输入，不代表已预约或已购票。',
    '单人、中等预算、中等体力；关注清北人文、北京地标、红叶和美食。尽量公共交通。要考虑景区预约、开放时间、周一闭馆、跨区通勤、入口和出口；别把尚未购买的车票或未完成的预约写成已确认。预约按能预约到规划，北大按已有内部预约办理，但要给预约渠道/时间与出发前核验提醒。',
    '请尝试检索公开可访问的小红书攻略，参考秋景、拍照、排队和交通体验；社区内容只作为游客经验，不用于确认开放时间、预约或票价。遇到登录墙时停止自动读取，说明缺口并继续使用可访问来源。',
    '必须逐日按早晨/上午/午间/下午/晚间等时段编排；每个具体景点有开始时刻和建议停留时间；每段接驳写明交通方式和明确目的地。没有成功路线来源时，通勤分钟数标待核验，不能装成实时导航。每天说明遇到下雨、客流、延误或体力下降时具体删减/替换什么。三餐要有具体店名和门店所在区域：9/21 仅晚餐，9/22–9/26 每天三餐，9/27 仅早餐和午餐。不要用“附近找餐馆”代替店名；找不到可靠店名时明确写待选。',
    '另给逐日穿搭、结合天气的温差提示、行李清单并区分托运/随身（托运行李 20kg，背包带电脑和相机，现有短袖和冲锋衣）、预约/购票清单及雨天/延误总预案。事实需附来源；不确定时标待核验。请勿再追问，先按以上信息给出可审核的方案。'
  ].join('\n\n')
}
