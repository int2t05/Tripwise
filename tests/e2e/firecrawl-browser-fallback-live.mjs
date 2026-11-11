/** 在隔离 Electron 资料中联测真实 Firecrawl 回退与 Agent 浏览器搜索跟进。 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const officialUrl = 'https://www.dpm.org.cn/Visit.html'
const liveTestPrompt = '请读取我导入的故宫官方页面，概述页面中的游览提示，并告诉我是否读到正文。'
const browserSearchPrompt = '请只用右侧研究浏览器搜索“故宫博物院 官方 开放时间 预约”，从搜索结果中找到故宫官网链接，再打开官网读取原文。不要使用本对话以外的来源；不要生成行程，只用两三句话说明读到的官方页面及其游览提示。'
const browserSearchQuery = '故宫博物院 官方 开放时间 预约'
const fixtureModelKey = 'tripwise-live-e2e-fixture-key'
const enabled = process.env.TRIPWISE_FIRECRAWL_BROWSER_LIVE_E2E === '1'

/** 按 Electron 平台路径读取本机凭证文件；凭证只留在进程内存和临时测试资料。 */
function localUserDataDirectory() {
  const override = process.env.TRIPWISE_USER_DATA_DIR?.trim()
  if (override) return resolve(override)
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'tripwise')
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'tripwise')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'tripwise')
}

/** 启动仅监听回环地址的 OpenAI 兼容服务，并记录脱敏浏览器正文指标。 */
async function startModelProbeServer(firecrawlKey) {
  const requests = []
  let requestCount = 0
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
          response.writeHead(404).end()
          return
        }
        const rawBody = Buffer.concat(chunks).toString('utf8')
        const body = JSON.parse(rawBody)
        const messages = Array.isArray(body.messages) ? body.messages : []
        const userMessage = [...messages].reverse().find((message) => message.role === 'user')
        const hasBrowserSearchPrompt = messages.some((message) =>
          message.role === 'user' && String(message.content ?? '').includes(browserSearchPrompt))
        const browserSearchPromptIndex = hasBrowserSearchPrompt
          ? messages.findLastIndex((message) => message.role === 'user' &&
            String(message.content ?? '').includes(browserSearchPrompt))
          : -1
        const currentRunMessages = browserSearchPromptIndex >= 0 ? messages.slice(browserSearchPromptIndex + 1) : messages
        const toolMessages = currentRunMessages.filter((message) => message.role === 'tool')
        const browserBody = toolMessages.map((message) => String(message.content ?? '')).join('\n')
        const browserToolCalls = currentRunMessages.flatMap((message) => message.role === 'assistant'
          ? (message.tool_calls ?? []).filter((call) => ['research_browser_navigate', 'research_browser_snapshot'].includes(call.function?.name))
          : [])
        const toolCallNames = new Map(currentRunMessages.flatMap((message) => message.role === 'assistant'
          ? (message.tool_calls ?? []).map((call) => [call.id, call.function?.name])
          : []))
        const lastBrowserToolCall = browserToolCalls.at(-1)
        const lastBrowserToolName = lastBrowserToolCall?.function?.name ?? ''
        const lastBrowserToolUrl = (() => {
          try {
            return JSON.parse(lastBrowserToolCall?.function?.arguments ?? '{}')?.url ?? ''
          } catch {
            return ''
          }
        })()
        const officialPageSnapshotExists = toolMessages.some((toolMessage) => {
          if (toolCallNames.get(toolMessage.tool_call_id) !== 'research_browser_snapshot') return false
          const content = String(toolMessage.content ?? '')
          return content.includes(officialUrl) && /故宫|参观/u.test(content) && /开放|预约/u.test(content) &&
            !/搜索结果页只能用于发现原始网页/u.test(content)
        })
        const browserBodyContainsOfficialDomain = /dpm\.org\.cn/iu.test(browserBody)
        const planSubmitted = currentRunMessages.some((message) => message.role === 'assistant' &&
          (message.tool_calls ?? []).some((call) => call.function?.name === 'propose_itineraries'))
        requests.push({
          authorizationMatchedFixture: request.headers.authorization === `Bearer ${fixtureModelKey}`,
          bodyContainedFirecrawlKey: rawBody.includes(firecrawlKey),
          hasLiveTestPrompt: String(userMessage?.content ?? '').includes(liveTestPrompt),
          hasBrowserSearchPrompt,
          toolOutputContainsBrowserSource: browserBody.includes('Tripwise 研究浏览器'),
          toolOutputContainsSearchPageClue: browserBody.includes('Bing 搜索结果') || browserBody.includes('搜索结果页只能用于发现原始网页'),
          browserBodyContainsOfficialUrl: browserBody.includes(officialUrl),
          browserBodyContainsOfficialDomain,
          browserBodyCharacters: browserBody.length,
          browserBodyContainsTravelFacts: /开放|预约/u.test(browserBody),
          toolOutputContainsOfficialPageText: officialPageSnapshotExists,
          planSubmitted,
          lastBrowserToolName,
          lastBrowserToolUrl,
          toolNames: Array.isArray(body.tools) ? body.tools.map((tool) => tool.function?.name) : []
        })
        let message
        if (hasBrowserSearchPrompt) {
          const latestRequest = requests.at(-1)
          if (latestRequest?.toolOutputContainsOfficialPageText) {
            message = { role: 'assistant', content: '已从本轮浏览器搜索结果跟进故宫官网并读取页面原文。' }
          } else if (latestRequest?.lastBrowserToolName === 'research_browser_navigate') {
            message = { role: 'assistant', tool_calls: [{
              id: 'call_snapshot_current_browser_page', type: 'function',
              function: { name: 'research_browser_snapshot', arguments: '{}' }
            }] }
          } else if (latestRequest?.toolOutputContainsSearchPageClue && latestRequest.browserBodyContainsOfficialDomain) {
            message = { role: 'assistant', tool_calls: [{
              id: 'call_follow_official_search_result', type: 'function',
              function: { name: 'research_browser_navigate', arguments: JSON.stringify({ url: officialUrl }) }
            }] }
          } else if (latestRequest?.lastBrowserToolName === 'research_browser_snapshot') {
            message = { role: 'assistant', content: '搜索页未提供可识别的故宫官网链接，暂时无法继续核验。' }
          } else {
            message = { role: 'assistant', tool_calls: [{
              id: 'call_search_official_page', type: 'function',
              function: { name: 'research_browser_navigate', arguments: JSON.stringify({ url: browserSearchQuery }) }
            }] }
          }
        } else if (requestCount++ === 0) {
          message = { role: 'assistant', tool_calls: [{
              id: 'call_real_firecrawl_read', type: 'function',
              function: { name: 'read_webpage', arguments: JSON.stringify({ url: officialUrl }) }
            }] }
        } else {
          message = { role: 'assistant', content: '已从右侧网页读取官方参观页面。具体开放与预约条件请以页面原文和适用日期为准。' }
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message }] }))
      } catch {
        response.writeHead(400).end()
      }
    })
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法启动隔离模型探针。')
  return { server, endpoint: `http://127.0.0.1:${address.port}/v1`, requests }
}

if (!enabled) throw new Error('此联测会访问 Firecrawl 和公开官网；请显式设置 TRIPWISE_FIRECRAWL_BROWSER_LIVE_E2E=1。')

const localCredentialsPath = join(localUserDataDirectory(), 'tripwise-credentials.json')
const localCredentialStat = await lstat(localCredentialsPath)
if (!localCredentialStat.isFile() || localCredentialStat.isSymbolicLink()) {
  throw new Error('本机凭证路径不是普通文件；联测已停止，未读取凭证。')
}
if (process.platform !== 'win32' && (localCredentialStat.mode & 0o077) !== 0) {
  throw new Error('本机凭证文件权限过宽；联测已停止，未读取凭证。')
}
const credentialFile = JSON.parse(await readFile(localCredentialsPath, 'utf8'))
const firecrawlKey = credentialFile?.format === 'tripwise-credentials' && credentialFile?.schemaVersion === 1
  ? credentialFile?.secrets?.firecrawlKey
  : undefined
if (typeof firecrawlKey !== 'string' || !firecrawlKey.trim()) {
  throw new Error('本机没有已保存的 Firecrawl 凭证；联测未启动。')
}

const profileDirectory = await mkdtemp(join(tmpdir(), 'tripwise-firecrawl-live-e2e-'))
let modelProbe
let application
const rendererErrors = []
  const rendererConsoleErrors = []

try {
  if (process.platform !== 'win32') await chmod(profileDirectory, 0o700)
  await writeFile(join(profileDirectory, 'tripwise-credentials.json'), JSON.stringify({
    format: 'tripwise-credentials',
    schemaVersion: 1,
    secrets: { modelKey: fixtureModelKey, firecrawlKey }
  }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  modelProbe = await startModelProbeServer(firecrawlKey)
  application = await electron.launch({
    args: ['--disable-gpu', projectRoot],
    env: {
      ...process.env,
      TRIPWISE_E2E_HEADLESS: '1',
      TRIPWISE_E2E_USER_DATA_DIR: profileDirectory
    },
    timeout: 30_000
  })
  const page = await application.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  page.on('pageerror', () => rendererErrors.push('renderer_error'))
  page.on('console', (message) => {
    if (message.type() === 'error') rendererConsoleErrors.push('console_error')
  })
  await page.getByLabel('旅行对话输入框').waitFor({ state: 'visible', timeout: 30_000 })

  const tripId = await page.evaluate(async ({ endpoint, sourceUrl }) => {
    const api = window.tripwise
    const initial = await api.getSnapshot()
    const settings = structuredClone(initial.settings)
    settings.model = { baseUrl: endpoint, model: 'tripwise-live-fallback-e2e' }
    settings.connectors.webSearch = true
    await api.updateSettings(settings)
    const created = await api.createTrip({
      destination: '北京', interests: '故宫博物院', startDate: '2026-11-03', endDate: '2026-11-03'
    })
    const selectedTripId = created.selectedTripId
    if (!selectedTripId) throw new Error('隔离旅行未创建。')
    await api.importPastedContent(selectedTripId, {
      title: '故宫官方参观须知',
      url: sourceUrl,
      text: '本联测只提供公开官方页面链接，正文需由读取工具获取。'
    })
    return selectedTripId
  }, { endpoint: modelProbe.endpoint, sourceUrl: officialUrl })

  // 直接 IPC 种入隔离测试资料后重载 renderer，使 React 读取持久化旅行快照。
  await page.reload()
  await page.getByLabel('旅行对话输入框').waitFor({ state: 'visible', timeout: 30_000 })
  const seededTripState = await page.evaluate(async (targetTripId) => {
    const snapshot = await window.tripwise.getSnapshot()
    const trip = snapshot.trips.find((item) => item.id === targetTripId)
    return {
      selected: snapshot.selectedTripId === targetTripId,
      destination: trip?.brief.destination ?? '',
      sourceCount: trip?.sources.length ?? 0
    }
  }, tripId)
  assert.deepEqual(seededTripState, { selected: true, destination: '北京', sourceCount: 1 },
    '隔离 renderer 应读取已创建的北京旅行和官方网页来源。')
  const rendererState = await page.evaluate(async () => ({
    snapshot: await window.tripwise.getSnapshot(),
    bodyText: document.body.innerText
  }))
  assert.equal(rendererState.snapshot.secrets.firecrawlKeySaved, true, 'renderer 只应收到凭证已保存状态。')
  assert.equal(Object.hasOwn(rendererState.snapshot.secrets, 'firecrawlKey'), false, 'renderer 快照不得包含凭证值字段。')
  assert.equal(JSON.stringify(rendererState).includes(firecrawlKey), false, 'renderer 快照和正文不得包含 Firecrawl Key。')
  await page.evaluate(() => {
    window.__firecrawlLiveE2E = { agentEvents: [], browserStates: [] }
    window.tripwise.onAgentEvent((event) => {
      const message = typeof event.message === 'string' ? event.message : ''
      const messageKind = /402|额度不足/u.test(message) ? 'quota'
        : /限流/u.test(message) ? 'rate_limit'
          : /右侧研究网页/u.test(message) ? 'browser_fallback'
            : /无法打开|未能读取/u.test(message) ? 'browser_error' : 'other'
      window.__firecrawlLiveE2E.agentEvents.push({ type: event.type, toolName: event.toolName ?? '', messageKind })
    })
    window.tripwise.onBrowserState((state) => window.__firecrawlLiveE2E.browserStates.push({
      loading: state.loading,
      hasError: Boolean(state.error),
      hasUrl: Boolean(state.url),
      titleKind: /dpm\.org\.cn/u.test(state.url) ? 'official-page'
        : /bing\.com/u.test(state.url) ? 'search-results' : state.title ? 'other-page' : 'empty'
    }))
  })

  await page.getByLabel('旅行对话输入框').fill(liveTestPrompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  try {
    await page.locator('.assistant-message').filter({ hasText: '已从右侧网页读取官方参观页面。' })
      .waitFor({ state: 'visible', timeout: 60_000 })
  } catch {
    const diagnostics = await page.evaluate(async (targetTripId) => {
      const snapshot = await window.tripwise.getSnapshot()
      const trip = snapshot.trips.find((item) => item.id === targetTripId)
      const sources = (trip?.sources ?? []).map((source) => ({
        provider: source.provider === 'Firecrawl' ? 'Firecrawl'
          : source.provider === 'Tripwise 研究浏览器' ? 'browser' : 'other',
        status: source.status,
        contentLevel: source.contentLevel ?? 'none',
        resultKind: /\bHTTP 402\b/u.test(source.summary) ? 'quota'
          : /\bHTTP 429\b/u.test(source.summary) ? 'rate_limit'
            : source.status === 'success' ? 'success' : 'other_error',
        textCharacters: source.summary.length
      }))
      const webTab = document.querySelectorAll('.research-panel-tabs > button')[1]
      const browserLabel = document.querySelector('.browser-state-label')?.textContent ?? ''
      return {
        runStatus: trip?.runStatus ?? 'missing',
        messages: (trip?.messages ?? []).slice(-6).map((message) => ({
          role: message.role,
          contentCharacters: message.content?.length ?? 0,
          containsExpectedAssistantReply: message.role === 'assistant' &&
            String(message.content ?? '').includes('已从右侧网页读取官方参观页面。'),
          hasToolCalls: Boolean(message.tool_calls?.length),
          itineraryCount: message.itineraryOptions?.length ?? 0
        })),
        assistantReplyVisible: [...document.querySelectorAll('.assistant-message')].some((element) =>
          element.textContent?.includes('已从右侧网页读取官方参观页面。')),
        sources,
        browserTabSelected: webTab?.getAttribute('aria-pressed') === 'true',
        browserLabelKind: browserLabel.includes('正在打开网页') ? 'loading'
          : browserLabel.includes('无法打开网页') ? 'error'
            : browserLabel.includes('未打开网页') ? 'empty' : browserLabel ? 'loaded' : 'missing',
        events: window.__firecrawlLiveE2E?.agentEvents ?? [],
        browserStates: window.__firecrawlLiveE2E?.browserStates ?? []
      }
    }, tripId)
    process.stderr.write(`[firecrawl-live-e2e] timeout-diagnostics ${JSON.stringify({ diagnostics, modelRequests: modelProbe.requests })}\n`)
    throw new Error('真实 Firecrawl 浏览器回退联测未能在 60 秒内完成。')
  }

  await page.waitForFunction(() => document.querySelectorAll('.research-panel-tabs > button')[1]?.getAttribute('aria-pressed') === 'true', null, { timeout: 15_000 })
  await page.waitForFunction(async (targetTripId) => {
    const snapshot = await window.tripwise.getSnapshot()
    const trip = snapshot.trips.find((item) => item.id === targetTripId)
    return trip?.sources.some((source) => source.provider === 'Tripwise 研究浏览器' &&
      source.status === 'success' && source.contentLevel === 'page')
  }, tripId, { timeout: 60_000 })

  const browserEvidence = await page.evaluate((targetTripId) => {
    const snapshot = window.tripwise.getSnapshot()
    return snapshot.then((state) => {
      const trip = state.trips.find((item) => item.id === targetTripId)
      const browser = trip?.sources.find((source) => source.provider === 'Tripwise 研究浏览器' && source.status === 'success')
      const firecrawl = trip?.sources.find((source) => source.provider === 'Firecrawl')
      return {
        browserSourceStatus: browser?.status,
        browserSourceContentLevel: browser?.contentLevel,
        browserSourceCharacters: browser?.summary.length ?? 0,
        browserSourceContainsTravelFacts: /开放|预约/u.test(browser?.summary ?? ''),
        firecrawlOutcome: !firecrawl ? 'missing'
          : /\bHTTP 402\b/u.test(firecrawl.summary ?? '') ? 'quota'
            : /\bHTTP 429\b/u.test(firecrawl.summary ?? '') ? 'rate_limit'
              : firecrawl.status === 'success' ? 'success' : 'other_error'
      }
    })
  }, tripId)

  assert.ok(['quota', 'rate_limit'].includes(browserEvidence.firecrawlOutcome),
    `Firecrawl 未返回额度/限流状态（${browserEvidence.firecrawlOutcome}），真实回退路径未被触发。`)
  assert.equal(browserEvidence.browserSourceStatus, 'success', '右侧浏览器应保存可审阅的官网正文来源。')
  assert.equal(browserEvidence.browserSourceContentLevel, 'page')
  assert.ok(browserEvidence.browserSourceCharacters > 500, '网页快照应包含足够正文，而非只保存标题。')
  assert.equal(browserEvidence.browserSourceContainsTravelFacts, true, '网页正文应包含开放或预约相关内容。')
  assert.ok(modelProbe.requests.length >= 2, '模型应在浏览器结果入上下文后继续完成回复。')
  assert.ok(modelProbe.requests[0]?.hasLiveTestPrompt, '首轮模型请求应来自本次桌面测试对话。')
  assert.ok(modelProbe.requests[0]?.toolNames.includes('read_webpage'), '模型首轮应获得 Firecrawl 网页读取工具。')
  assert.ok(modelProbe.requests.some((request) => request.toolOutputContainsBrowserSource &&
    request.browserBodyCharacters > 500 && request.browserBodyContainsTravelFacts),
  '模型续轮应收到右侧浏览器页面正文和行程事实词。')
  assert.ok(modelProbe.requests.every((request) => request.authorizationMatchedFixture), '模型调用应使用隔离测试凭证。')
  assert.ok(modelProbe.requests.every((request) => !request.bodyContainedFirecrawlKey), 'Firecrawl Key 不得发送给模型。')
  assert.equal(await page.getByLabel('网页地址或搜索词').inputValue(), officialUrl, '右侧可见网页应停留在读取的官方页面。')
  assert.deepEqual(rendererErrors, [], '桌面 renderer 不应出现运行错误。')

  const browserSearchTripId = await page.evaluate(async () => {
    const created = await window.tripwise.createTrip({ destination: '北京' })
    return created.selectedTripId
  })
  if (!browserSearchTripId) throw new Error('无法创建隔离的浏览器搜索旅行。')
  // IPC 新建旅行不会更新 React 内存快照；重载确保输入框绑定到新选中的旅行。
  await page.reload()
  await page.getByLabel('旅行对话输入框').waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForFunction(async (targetTripId) => {
    const snapshot = await window.tripwise.getSnapshot()
    return snapshot.selectedTripId === targetTripId
  }, browserSearchTripId, { timeout: 10_000 })
  await page.evaluate(() => {
    window.__firecrawlLiveE2E = { agentEvents: [], browserStates: [] }
    window.tripwise.onAgentEvent((event) => {
      const message = typeof event.message === 'string' ? event.message : ''
      const messageKind = /402|额度不足/u.test(message) ? 'quota'
        : /限流/u.test(message) ? 'rate_limit'
          : /右侧研究网页/u.test(message) ? 'browser_fallback'
            : /无法打开|未能读取/u.test(message) ? 'browser_error' : 'other'
      window.__firecrawlLiveE2E.agentEvents.push({ type: event.type, toolName: event.toolName ?? '', messageKind })
    })
    window.tripwise.onBrowserState((state) => window.__firecrawlLiveE2E.browserStates.push({
      loading: state.loading,
      hasError: Boolean(state.error),
      hasUrl: Boolean(state.url),
      titleKind: /dpm\.org\.cn/u.test(state.url) ? 'official-page'
        : /bing\.com/u.test(state.url) ? 'search-results' : state.title ? 'other-page' : 'empty'
    }))
  })

  const eventCountBeforeSearch = await page.evaluate(() => window.__firecrawlLiveE2E?.agentEvents.length ?? 0)
  const messagesBeforeSearch = await page.evaluate(async (targetTripId) => {
    const snapshot = await window.tripwise.getSnapshot()
    return snapshot.trips.find((item) => item.id === targetTripId)?.messages.length ?? 0
  }, browserSearchTripId)
  const browserSourceIdsBeforeSearch = await page.evaluate(async (targetTripId) => {
    const snapshot = await window.tripwise.getSnapshot()
    return snapshot.trips.find((item) => item.id === targetTripId)?.sources
      .filter((source) => source.provider === 'Tripwise 研究浏览器').map((source) => source.id) ?? []
  }, browserSearchTripId)
  const modelRequestsBeforeSearch = modelProbe.requests.length
  await page.getByLabel('旅行对话输入框').fill(browserSearchPrompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  let browserSearchRunState
  const browserSearchDeadline = Date.now() + 180_000
  while (Date.now() < browserSearchDeadline) {
    browserSearchRunState = await page.evaluate(async ({ targetTripId, minimumMessages, minimumEventCount, existingBrowserSourceIds }) => {
      const snapshot = await window.tripwise.getSnapshot()
      const trip = snapshot.trips.find((item) => item.id === targetTripId)
      const messages = trip?.messages ?? []
      const userIndex = messages.findLastIndex((message) => message.role === 'user' &&
        String(message.content ?? '').includes('请只用右侧研究浏览器搜索'))
      const userMessagePersisted = messages.length > minimumMessages && userIndex >= 0
      const lastAssistant = messages.slice(userIndex + 1).reverse().find((message) => message.role === 'assistant')
      const currentRunEvents = (window.__firecrawlLiveE2E?.agentEvents ?? []).slice(minimumEventCount)
      const sources = (trip?.sources ?? []).filter((source) =>
        source.provider === 'Tripwise 研究浏览器' && !existingBrowserSourceIds.includes(source.id))
      const searchSnippetSaved = sources.some((source) =>
        source.status === 'success' && source.contentLevel === 'snippet')
      const officialPageSaved = sources.some((source) =>
        source.status === 'success' && source.contentLevel === 'page' && source.summary.length > 500)
      return {
        userMessagePersisted,
        completeAfterSend: currentRunEvents.some((event) => event.type === 'complete'),
        searchSnippetSaved,
        officialPageSaved,
        assistantPlanCount: lastAssistant?.itineraryOptions?.length ?? 0,
        assistantHasText: String(lastAssistant?.content ?? '').trim().length > 0,
        eventCount: currentRunEvents.length,
        browserStates: window.__firecrawlLiveE2E?.browserStates ?? []
      }
    }, {
      targetTripId: browserSearchTripId,
      minimumMessages: messagesBeforeSearch,
      minimumEventCount: eventCountBeforeSearch,
      existingBrowserSourceIds: browserSourceIdsBeforeSearch
    })
    if (browserSearchRunState.userMessagePersisted && browserSearchRunState.completeAfterSend &&
        browserSearchRunState.assistantHasText) break
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  if (!browserSearchRunState?.userMessagePersisted || !browserSearchRunState.completeAfterSend ||
      !browserSearchRunState.searchSnippetSaved || !browserSearchRunState.officialPageSaved ||
      browserSearchRunState.assistantPlanCount !== 0 || !browserSearchRunState.assistantHasText) {
    const safeRequests = modelProbe.requests.slice(modelRequestsBeforeSearch).map((request) => ({
      hasBrowserSearchPrompt: request.hasBrowserSearchPrompt,
      toolOutputContainsSearchPageClue: request.toolOutputContainsSearchPageClue,
      browserBodyContainsOfficialUrl: request.browserBodyContainsOfficialUrl,
      browserBodyContainsOfficialDomain: request.browserBodyContainsOfficialDomain,
      toolOutputContainsOfficialPageText: request.toolOutputContainsOfficialPageText,
      lastBrowserToolName: request.lastBrowserToolName,
      lastBrowserToolTarget: request.lastBrowserToolUrl === officialUrl ? 'official-page'
        : typeof request.lastBrowserToolUrl === 'string' && request.lastBrowserToolUrl.startsWith('http') ? 'search-page'
          : request.lastBrowserToolUrl ? 'search-query' : 'none',
      toolNames: request.toolNames
    }))
    process.stderr.write(`[firecrawl-live-e2e] browser-search-diagnostics ${JSON.stringify({ state: browserSearchRunState, requests: safeRequests })}\n`)
    throw new Error('Electron Agent 浏览器搜索未在 180 秒内读取搜索摘要、跟进官网并完成回复。')
  }

  await page.waitForFunction(() => document.querySelectorAll('.research-panel-tabs > button')[1]?.getAttribute('aria-pressed') === 'true', null, { timeout: 15_000 })
  const browserSearchEvidence = await page.evaluate(async ({ targetTripId, existingBrowserSourceIds, minimumEventCount }) => {
    const snapshot = await window.tripwise.getSnapshot()
    const trip = snapshot.trips.find((item) => item.id === targetTripId)
    const messages = trip?.messages ?? []
    const userIndex = messages.findLastIndex((message) => message.role === 'user' &&
      String(message.content ?? '').includes('请只用右侧研究浏览器搜索'))
    const lastAssistant = messages.slice(userIndex + 1).reverse().find((message) => message.role === 'assistant')
    const browserSources = (trip?.sources ?? []).filter((source) => source.provider === 'Tripwise 研究浏览器')
    const newBrowserSources = browserSources.filter((source) => !existingBrowserSourceIds.includes(source.id))
    const channel = (level) => browserSources
      .filter((source) => source.contentLevel === level)
      .map((source) => ({ status: source.status, characters: source.summary.length }))
    const newChannel = (level) => newBrowserSources
      .filter((source) => source.contentLevel === level)
      .map((source) => ({ status: source.status, characters: source.summary.length }))
    return {
      runStatus: trip?.runStatus ?? 'missing',
      messageCount: trip?.messages.length ?? 0,
      userMessageCount: (trip?.messages ?? []).filter((message) => message.role === 'user').length,
      automaticPromptPersisted: (trip?.messages ?? []).some((message) => message.role === 'user' &&
        String(message.content ?? '').includes('请只用右侧研究浏览器搜索')),
      assistantPlanCount: lastAssistant?.itineraryOptions?.length ?? 0,
      searchSnippetSources: channel('snippet'),
      newSearchSnippetSources: newChannel('snippet'),
      officialPageSources: channel('page'),
      newOfficialPageSources: newChannel('page'),
      browserAddress: document.querySelector('input[aria-label="网页地址或搜索词"]')?.value ?? '',
      newSourceDiagnostics: newBrowserSources.map((source) => ({
        status: source.status,
        contentLevel: source.contentLevel ?? 'none',
        characters: source.summary.length,
        hasOfficialUrl: source.summary.includes('dpm.org.cn'),
        hasChallengeText: /captcha|unusual traffic|安全验证|机器人验证/iu.test(source.summary)
      })),
      eventTypes: (window.__firecrawlLiveE2E?.agentEvents ?? []).slice(minimumEventCount)
        .map((event) => `${event.type}:${event.toolName ?? ''}:${event.messageKind}`)
    }
  }, {
    targetTripId: browserSearchTripId,
    existingBrowserSourceIds: browserSourceIdsBeforeSearch,
    minimumEventCount: eventCountBeforeSearch
  })
  const browserSearchRequests = modelProbe.requests.slice(modelRequestsBeforeSearch)
  assert.ok(browserSearchRequests.length > 0, 'Agent 浏览器搜索期间应继续调用模型。')
  assert.ok(browserSearchRequests.some((request) => request.toolOutputContainsOfficialPageText), '模型上下文应包含本轮读取的官方网页正文。')
  assert.ok(browserSearchEvidence.newSearchSnippetSources.some((source) => source.status === 'success'),
    '本轮必须保存新的浏览器搜索摘要来源，不能以旧来源或直达官网路径代替。')
  assert.ok(browserSearchRequests.some((request) => request.toolOutputContainsSearchPageClue && request.browserBodyContainsOfficialDomain),
    '模型应收到本轮浏览器搜索摘要和其中的故宫官方原始链接。')
  assert.ok(browserSearchRequests.some((request) => request.toolNames.includes('research_browser_navigate')),
    '模型应获得右侧浏览器导航工具。')
  assert.ok(browserSearchEvidence.eventTypes.some((event) => event.startsWith('tool:research_browser_snapshot')),
    'Agent 应读取搜索结果页和官方页面的可见快照。')
  assert.equal(browserSearchEvidence.assistantPlanCount, 0, '用户只要求核对来源时不应擅自生成行程。')
  assert.ok(browserSearchEvidence.newOfficialPageSources.some((source) => source.status === 'success' && source.characters > 500), '本轮读取的官方正文应以 page 来源保存。')
  assert.equal(browserSearchEvidence.browserAddress, officialUrl, '可见网页栏最终应停留在故宫官方页面。')
  assert.deepEqual(rendererErrors, [], '浏览器搜索和官方页面读取不应产生 renderer 异常。')
  assert.deepEqual(rendererConsoleErrors, [], '浏览器搜索和官方页面读取不应产生 renderer console 错误。')
  if (process.env.TRIPWISE_E2E_SCREENSHOT_PATH) {
    await page.screenshot({ path: resolve(process.env.TRIPWISE_E2E_SCREENSHOT_PATH), fullPage: true })
  }

  await application.close()
  application = undefined
  const logText = await readFile(join(profileDirectory, 'logs', 'tripwise.log'), 'utf8')
  const logEvents = logText.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.ok(logEvents.some((event) => event.event === 'agent.research.browser_fallback' &&
    event.status === 'completed' && ['quota_exhausted', 'rate_limited'].includes(event.reason)),
  'Firecrawl 正文额度/限流失败后应记录浏览器正文回退成功。')
  assert.ok(!logText.includes(firecrawlKey), '运行日志不得包含 Firecrawl Key。')
  assert.ok(!logText.includes(fixtureModelKey), '运行日志不得包含模型测试 Key。')

  process.stdout.write(`${JSON.stringify({
    firecrawlOutcome: browserEvidence.firecrawlOutcome,
    browserFallback: 'completed',
    agentBrowserSearch: 'search-snippet-followed-by-official-page',
    visiblePage: true,
    browserSourceCharacters: browserEvidence.browserSourceCharacters,
    searchSnippetSources: browserSearchEvidence.newSearchSnippetSources.length,
    officialPageSources: browserSearchEvidence.newOfficialPageSources.length,
    modelContinuationRequests: modelProbe.requests.length,
    modelReceivedBrowserText: true,
    credentialsInModelOrLogs: false
  })}\n`)
} finally {
  if (application) await application.close().catch(() => undefined)
  if (modelProbe?.server.listening) await new Promise((resolveClose) => modelProbe.server.close(() => resolveClose()))
  await rm(profileDirectory, { recursive: true, force: true })
}
