/** 在隔离资料目录中验证真实 Electron 工作区的创建、侧栏和重启持久化流程。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import axe from 'axe-core'
import { _electron as electron, chromium } from 'playwright-core'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const profileDirectory = await mkdtemp(join(tmpdir(), 'tripwise-desktop-e2e-'))
const rendererErrors = []
const remoteHosts = new Set()
const axePages = new WeakSet()
const packagedCursorSessions = new WeakMap()
let application
let modelProbeServer
let researchProxyProbeServer

const WCAG_22_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const RESEARCH_BADGE_TARGET = '.research-panel-tabs > button.selected > span'
// 仅用于本机模拟服务的假凭证，不是任何真实服务密钥。
const MODEL_PROBE_FIXTURE_KEY = 'tripwise-e2e-fixture-key'

/** 从 Electron 主进程读取隔离网页上的指针标记，不访问或记录页面正文。 */
async function readBrowserCursor(application, targetSelector = '#expand') {
  if (typeof application.evaluate === 'function') {
    return application.evaluate(async ({ webContents }, selector) => {
    const contents = webContents.getAllWebContents()
    const browserPages = contents.filter((item) => {
      try { return ['/agent-browser-interact', '/agent-browser-search'].includes(new URL(item.getURL()).pathname) } catch { return false }
    })
    let lastState = null
    for (const browser of browserPages) {
      if (browser.isDestroyed()) continue
      let state
      try {
        state = await browser.executeJavaScript(`(() => {
      const marker = document.querySelector('[data-tripwise-agent-cursor]')
      if (!marker) return null
      const target = document.querySelector(${JSON.stringify(selector)})
      const rect = target?.getBoundingClientRect()
      return {
        opacity: marker.style.opacity,
        phase: marker.dataset.phase,
        left: marker.style.left,
        top: marker.style.top,
        scrollY: window.scrollY,
        targetX: rect ? rect.left + rect.width / 2 : null,
        targetY: rect ? rect.top + rect.height / 2 : null
      }
        })()`)
      } catch {
        continue
      }
      if (!state) continue
      if (Number.isFinite(state.targetX) && Number.isFinite(state.targetY)) return state
      lastState = state
    }
    return lastState
    }, targetSelector)
  }

  // 打包版通过 Chromium CDP 连接，直接从研究网页对应的 renderer 读取同一标记。
  const pages = application.browser?.contexts().flatMap((context) => context.pages()) ?? []
  const browserPage = pages.find((page) => {
    try { return ['/agent-browser-interact', '/agent-browser-search'].includes(new URL(page.url()).pathname) } catch { return false }
  })
  const readMarker = (selector) => {
    const marker = document.querySelector('[data-tripwise-agent-cursor]')
    if (!marker) return null
    const target = document.querySelector(selector)
    const rect = target?.getBoundingClientRect()
    return {
      opacity: marker.style.opacity,
      phase: marker.dataset.phase,
      left: marker.style.left,
      top: marker.style.top,
      scrollY: window.scrollY,
      targetX: rect ? rect.left + rect.width / 2 : null,
      targetY: rect ? rect.top + rect.height / 2 : null
    }
  }
  if (browserPage) return browserPage.evaluate(readMarker, targetSelector)
  return readPackagedBrowserCursor(application, readMarker, targetSelector)
}

/** 通过 CDP 的嵌套目标会话读取 WebContentsView 页面，不依赖 Playwright 页面枚举。 */
async function readPackagedBrowserCursor(application, readMarker, targetSelector) {
  if (!application.browser) return null
  let state = packagedCursorSessions.get(application)
  if (!state) {
    const session = await application.browser.newBrowserCDPSession()
    const { targetInfos } = await session.send('Target.getTargets')
    const target = targetInfos.find((item) => {
      if (item.type !== 'page') return false
      try { return ['/agent-browser-interact', '/agent-browser-search'].includes(new URL(item.url).pathname) } catch { return false }
    })
    if (!target) {
      await session.detach()
      return null
    }
    const { sessionId } = await session.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })
    state = { session, sessionId, nextId: 0, pending: new Map() }
    session.on('Target.receivedMessageFromTarget', ({ sessionId: receivedSessionId, message }) => {
      if (receivedSessionId !== state.sessionId) return
      let packet
      try { packet = JSON.parse(message) } catch { return }
      const pending = state.pending.get(packet.id)
      if (!pending) return
      state.pending.delete(packet.id)
      clearTimeout(pending.timeout)
      if (packet.error) pending.reject(new Error(packet.error.message ?? 'CDP 页面读取失败。'))
      else pending.resolve(pending.readResult ? pending.readResult(packet.result) : packet.result?.result?.value ?? null)
    })
    packagedCursorSessions.set(application, state)
  }

  const id = ++state.nextId
  const expression = `(${readMarker.toString()})(${JSON.stringify(targetSelector)})`
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.pending.delete(id)
      reject(new Error('等待打包版研究页面返回光标状态超时。'))
    }, 2_000)
    state.pending.set(id, { resolve, reject, timeout })
    state.session.send('Target.sendMessageToTarget', {
      sessionId: state.sessionId,
      message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })
    }).catch((error) => {
      clearTimeout(timeout)
      state.pending.delete(id)
      reject(error)
    })
  })
}

/** 在已附加的打包版研究页面中执行一条 CDP 命令。 */
async function sendPackagedBrowserCommand(application, method, params = {}) {
  const state = packagedCursorSessions.get(application)
  if (!state) throw new Error('打包版研究网页会话尚未建立。')
  const id = ++state.nextId
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.pending.delete(id)
      reject(new Error('打包版研究网页截图超时。'))
    }, 5_000)
    state.pending.set(id, { resolve, reject, timeout, readResult: (result) => result ?? null })
    state.session.send('Target.sendMessageToTarget', {
      sessionId: state.sessionId,
      message: JSON.stringify({ id, method, params })
    }).catch((error) => {
      clearTimeout(timeout)
      state.pending.delete(id)
      reject(error)
    })
  })
}

/** 等待网页内滚动光标进入稳定完成态，并确认页面确已滚动。 */
async function waitForBrowserScrollCursor(application, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const marker = await readBrowserCursor(application, 'body')
    if (marker?.opacity === '1' && marker.phase === 'scrolled' && marker.scrollY > 0) return marker
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('研究浏览器滚动结束后未保留可见指针状态。')
}

/** 从隔离网页自身捕获画面，避免只截到承载 WebContentsView 的外层页面。 */
async function captureResearchBrowserScreenshot(application, expectedPhase) {
  let dataUrl
  if (typeof application.evaluate === 'function') {
    dataUrl = await application.evaluate(async ({ webContents }, phase) => {
      const browserPages = webContents.getAllWebContents().filter((item) => {
        try { return new URL(item.getURL()).pathname.startsWith('/agent-browser-') } catch { return false }
      })
      for (const browser of browserPages) {
        if (browser.isDestroyed()) continue
        try {
          const ready = await browser.executeJavaScript(`((expectedPhase) => {
            const marker = document.querySelector('[data-tripwise-agent-cursor]')
            return !!marker && marker.style.opacity === '1' && marker.dataset.phase === expectedPhase
          })(${JSON.stringify(phase)})`)
          if (ready) return (await browser.capturePage()).toDataURL()
        } catch {
          continue
        }
      }
      return null
    }, expectedPhase)
  } else if (application.browser) {
    const marker = await readBrowserCursor(application, 'body')
    if (marker?.opacity !== '1' || marker.phase !== expectedPhase) {
      throw new Error('打包版研究网页没有处于预期的截图阶段。')
    }
    const screenshot = await sendPackagedBrowserCommand(application, 'Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false
    })
    if (typeof screenshot?.data === 'string') dataUrl = `data:image/png;base64,${screenshot.data}`
  } else {
    throw new Error('当前桌面运行器不能捕获内置研究网页。')
  }
  const match = typeof dataUrl === 'string' && dataUrl.match(/^data:image\/png;base64,([\s\S]+)$/u)
  if (!match) throw new Error('内置研究网页没有返回可保存的 PNG 截图。')
  return { dataUrl, base64: match[1] }
}

/** 检查内置网页截图确实绘出了品牌绿指针叠层，而非只有 DOM 状态。 */
async function countVisibleBrowserCursorPixels(page, dataUrl) {
  return page.evaluate(async (screenshot) => {
    const image = new Image()
    image.src = screenshot
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法读取网页截图像素。')
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let visibleCursorPixels = 0
    let left = canvas.width
    let right = -1
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index] ?? 0
      const green = pixels[index + 1] ?? 0
      const blue = pixels[index + 2] ?? 0
      const alpha = pixels[index + 3] ?? 0
      if (alpha > 180 && green - red > 15 && green > blue * 1.08) {
        visibleCursorPixels += 1
        const x = (index / 4) % canvas.width
        left = Math.min(left, x)
        right = Math.max(right, x)
      }
    }
    return { visibleCursorPixels, left, right, width: canvas.width }
  }, dataUrl)
}

/** 将 Electron 的计算样式 RGB 颜色解析成通道值，并拒绝半透明颜色。 */
function parseOpaqueRgb(color) {
  const match = color.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*([\d.]+))?\s*\)$/i)
  assert.ok(match, `无法核验非 RGB 颜色：${color}`)
  assert.ok(match[4] === undefined || Number(match[4]) === 1, `颜色不是完全不透明：${color}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** 计算 Electron 实际渲染色值对应的 WCAG 对比度。 */
function renderedContrastRatio(foreground, background) {
  const luminance = (channels) => {
    const [red, green, blue] = channels.map((channel) => {
      const normalized = channel / 255
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

/** 在真实生产 renderer 中核验来源数量徽标的计算样式和文字对比度。 */
async function verifyResearchBadgeContrast(page) {
  const badges = await page.locator(RESEARCH_BADGE_TARGET).evaluateAll((elements) => elements
    .filter((element) => element.getClientRects().length > 0)
    .map((element) => {
      const style = getComputedStyle(element)
      return { foreground: style.color, background: style.backgroundColor, fontSize: style.fontSize }
    }))
  for (const badge of badges) {
    const ratio = renderedContrastRatio(parseOpaqueRgb(badge.foreground), parseOpaqueRgb(badge.background))
    assert.ok(Number.parseFloat(badge.fontSize) >= 12, `来源数量徽标字号不足 12px：${badge.fontSize}`)
    assert.ok(ratio >= 4.5, `来源数量徽标对比度不足 4.5:1：${badge.foreground} / ${badge.background} = ${ratio.toFixed(2)}:1`)
  }
  return badges.map((badge) => ({ ...badge, ratio: renderedContrastRatio(parseOpaqueRgb(badge.foreground), parseOpaqueRgb(badge.background)) }))
}

/** 核验话题消息数在真实活动行背景上的字号和文字对比度。 */
async function verifyConversationCountContrast(page) {
  const counts = await page.locator('.conversation-select > small').evaluateAll((elements) => elements
    .filter((element) => element.getClientRects().length > 0)
    .map((element) => {
      const style = getComputedStyle(element)
      const row = element.closest('.conversation-row')
      return { foreground: style.color, background: row ? getComputedStyle(row).backgroundColor : '', fontSize: style.fontSize }
    }))
  for (const count of counts) {
    const ratio = renderedContrastRatio(parseOpaqueRgb(count.foreground), parseOpaqueRgb(count.background))
    assert.ok(Number.parseFloat(count.fontSize) >= 12, `话题消息数文字字号不足 12px：${count.fontSize}`)
    assert.ok(ratio >= 4.5, `话题消息数对比度不足 4.5:1：${count.foreground} / ${count.background} = ${ratio.toFixed(2)}:1`)
  }
  return counts.map((count) => ({ ...count, ratio: renderedContrastRatio(parseOpaqueRgb(count.foreground), parseOpaqueRgb(count.background)) }))
}

/** axe 无法沿透明 label 背景找到弹窗表面时，以真实弹窗背景复核旅行信息标签。 */
async function verifyBriefFieldLabelContrast(page) {
  const labels = await page.locator('.brief-form .form-label').evaluateAll((elements) => elements.map((element) => {
    const modal = element.closest('.modal-card')
    return {
      text: element.childNodes[0]?.textContent?.trim() ?? '旅行信息字段',
      foreground: getComputedStyle(element).color,
      background: modal ? getComputedStyle(modal).backgroundColor : '',
      fontSize: getComputedStyle(element).fontSize
    }
  }))
  assert.ok(labels.length > 0, '应找到旅行信息字段标签。')
  const ratios = labels.map((label) => {
    const ratio = renderedContrastRatio(parseOpaqueRgb(label.foreground), parseOpaqueRgb(label.background))
    assert.ok(ratio >= 4.5, `${label.text}文字对比度不足 4.5:1：${ratio.toFixed(2)}:1`)
    return ratio
  })
  return { count: labels.length, minimumRatio: Math.min(...ratios) }
}

/** 在常规和最小窗口宽度核对工作区列边界与三种主视图的内容起始线。 */
async function verifyWorkspaceAlignment(page, width, height) {
  await page.setViewportSize({ width, height })
  // Electron 视口改变后先等 CSS 断点应用，避免用 resize 前一帧的布局测量。
  await page.waitForFunction(() => {
    const shell = document.querySelector('.app-shell')
    const sidebar = document.querySelector('.travel-sidebar')
    if (!shell || !sidebar) return false
    const compact = document.documentElement.clientWidth <= 1220
    const collapsed = shell.classList.contains('sidebar-collapsed')
    const expectedSidebarWidth = collapsed ? 66 : compact ? 220 : 252
    return Math.abs(sidebar.getBoundingClientRect().width - expectedSidebarWidth) <= 1
  })
  const shell = await page.evaluate(() => {
    const bounds = (selector) => {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`缺少工作区元素：${selector}`)
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    }
    return {
      header: bounds('.workspace-header'),
      tabs: bounds('.view-tabs'),
      content: bounds('.workspace-content'),
      primary: bounds('.primary-content'),
      panel: bounds('.research-panel'),
      viewportWidth: document.documentElement.clientWidth
    }
  })
  assert.equal(shell.viewportWidth, width, '测试视口应切换到目标宽度。')
  assert.ok(Math.abs(shell.header.left - shell.tabs.left) <= 1, '页头与导航应共用左侧基线。')
  assert.ok(Math.abs(shell.tabs.left - shell.content.left) <= 1, '导航与工作区应共用左侧基线。')
  assert.ok(Math.abs(shell.primary.right - shell.panel.left) <= 1, '主视图与来源栏边界应连续。')
  assert.ok(Math.abs(shell.content.right - shell.panel.right) <= 1, '来源栏应与工作区右边界对齐。')

  const itineraryGeometry = await page.locator('.itinerary-view').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      left: rect.left,
      width: rect.width,
      paddingLeft: style.paddingLeft,
      contentLeft: rect.left + Number.parseFloat(getComputedStyle(element).paddingLeft)
    }
  })
  await page.getByRole('button', { name: '规划', exact: true }).click()
  const chatContent = await page.evaluate(() => {
    const message = document.querySelector('.chat-message')
    const composer = document.querySelector('.composer-box')
    const scroll = document.querySelector('.chat-scroll')
    if (!message || !composer || !scroll) throw new Error('对话视图缺少消息或输入框。')
    const messageRect = message.getBoundingClientRect()
    const scrollRect = scroll.getBoundingClientRect()
    const primaryRect = document.querySelector('.primary-content').getBoundingClientRect()
    return {
      messageLeft: messageRect.left,
      messageWidth: messageRect.width,
      composerLeft: composer.getBoundingClientRect().left,
      primaryLeft: primaryRect.left,
      primaryWidth: primaryRect.width
    }
  })
  assert.ok(Math.abs(chatContent.messageLeft - chatContent.composerLeft) <= 1, '消息和输入框应共用内容轨道。')
  assert.ok(Math.abs(shell.primary.left - chatContent.primaryLeft) <= 1, '切换视图时主工作区列起点应保持不变。')
  assert.ok(Math.abs(shell.primary.right - (chatContent.primaryLeft + chatContent.primaryWidth)) <= 1, '切换视图时主工作区列宽应保持不变。')
  assert.ok(Math.abs(chatContent.messageLeft - itineraryGeometry.contentLeft) <= 1,
    `对话与行程视图应共用内容起始线（对话 ${chatContent.messageLeft.toFixed(1)}px，行程 ${itineraryGeometry.contentLeft.toFixed(1)}px；行程宽 ${itineraryGeometry.width.toFixed(1)}px、内边距 ${itineraryGeometry.paddingLeft}）。`)
  await page.getByRole('button', { name: '行程', exact: true }).click()
  await page.locator('.itinerary-view').waitFor({ state: 'visible' })
}

/** 启动真实主进程和生产 renderer，并复用本次测试的隔离用户资料。 */
async function launchApplication() {
  const env = {
    ...process.env,
    TRIPWISE_E2E_HEADLESS: '1',
    TRIPWISE_E2E_USER_DATA_DIR: profileDirectory
  }
  if (process.env.TRIPWISE_E2E_EXECUTABLE) {
    return launchPackagedApplication(process.env.TRIPWISE_E2E_EXECUTABLE, env)
  }

  const instance = await electron.launch({
    args: [
      researchProbeHostResolverRule(),
      '--unsafely-treat-insecure-origin-as-secure=http://tripwise-egress-test.invalid',
      projectRoot
    ],
    env,
    timeout: 30_000
  })
  const page = await instance.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  observePage(page)
  return { instance, page }
}

/** 启动只回环监听的 HTTP 代理，记录研究网页转发到的固定 IP。 */
async function startResearchProxyProbeServer() {
  const requests = []
  const pointerPhasesAtClick = []
  let resetAgentBrowserPageOnce = true
  const server = createHttpServer((request, response) => {
    requests.push({ method: request.method, url: request.url, host: request.headers.host })
    if (request.method !== 'GET') {
      response.writeHead(405).end()
      return
    }
    const pathname = new URL(request.url, 'http://tripwise-probe.invalid').pathname
    const isAgentBrowserPage = pathname.startsWith('/agent-browser')
    const isSlowAgentBrowserPage = pathname === '/agent-browser-slow'
    const isLoginAgentBrowserPage = pathname === '/agent-browser-login' || pathname === '/agent-browser-login-long'
    const isLongLoginAgentBrowserPage = pathname === '/agent-browser-login-long'
    const isInteractionPage = pathname === '/agent-browser-interact'
    const isInteractionSearchPage = pathname === '/agent-browser-search'
    const isAgentBrowserLinkTarget = pathname === '/agent-browser-link-target'
    if (pathname === '/agent-browser-pointer-phase') {
      const pointerState = new URL(request.url, 'http://tripwise-probe.invalid').searchParams
      pointerPhasesAtClick.push({ phase: pointerState.get('phase'), aligned: pointerState.get('aligned') === 'true' })
      response.writeHead(204).end()
      return
    }
    if (pathname === '/agent-browser-rerendered') {
      response.writeHead(204).end()
      return
    }
    if (pathname === '/agent-browser' && resetAgentBrowserPageOnce) {
      resetAgentBrowserPageOnce = false
      request.socket.destroy()
      return
    }
    const document = isLongLoginAgentBrowserPage
      ? '<!doctype html><meta charset="utf-8"><title>Tripwise Login Gate</title><main>扫码登录后查看更多笔记</main><article>' + '公开旅行攻略正文。'.repeat(120) + '</article>'
      : isLoginAgentBrowserPage
        ? '<!doctype html><meta charset="utf-8"><title>Tripwise Login Gate</title><main>扫码登录后查看更多笔记</main>'
      : isInteractionPage
      ? '<!doctype html><meta charset="utf-8"><title>Tripwise Browser Interaction</title><main>公开攻略摘要：查看预约与交通信息。</main><button type="button" id="expand">展开全文</button><p id="full-text" hidden>展开后正文：故宫预约与交通请以官方信息为准。</p><form method="get" action="/agent-browser-search"><input type="hidden" name="session" value="tripwise-form-secret"><label>站内搜索<input type="search" name="q" placeholder="站内搜索"></label></form><script>document.querySelector("#expand").addEventListener("click", () => { const marker = document.querySelector("[data-tripwise-agent-cursor]"); const target = document.querySelector("#expand").getBoundingClientRect(); const aligned = !!marker && Math.abs(parseFloat(marker.style.left) - (target.left + target.width / 2)) < 2 && Math.abs(parseFloat(marker.style.top) - (target.top + target.height / 2)) < 2; const query = new URLSearchParams({ phase: marker?.dataset.phase ?? "missing", aligned: String(aligned) }); fetch("/agent-browser-pointer-phase?" + query, { cache: "no-store" }).catch(() => {}); document.querySelector("#full-text").hidden = false; document.querySelector("#expand").textContent = "收起" }); fetch("/agent-browser-mutation", { method: "POST", body: "must not leave during agent run" }).catch(() => {})</script>'
      : isInteractionSearchPage
        ? '<!doctype html><meta charset="utf-8"><title>Tripwise Browser Search Results</title><main>站内搜索命中：故宫到天坛公共交通。</main>' + '<p>后续攻略内容，用于验证滚动后读取位置。</p>'.repeat(120)
        : isAgentBrowserLinkTarget
          ? '<!doctype html><meta charset="utf-8"><title>Tripwise Agent Browser Link</title><main>公开笔记摘要：景点预约请以官方信息为准。</main>'
        : isAgentBrowserPage
      ? '<!doctype html><meta name="author" content="测试页面声明"><title>Tripwise Agent Browser</title><style>html,#results-scroll{scroll-behavior:smooth}</style><main>景点预约请核对官方公告。</main><div id="results-scroll" style="height:480px;overflow:auto"><div style="height:6000px" aria-hidden="true"></div><article id="target-result"><a href="/agent-browser-link-target?access_token=tripwise-link-private-token&xsec_token=tripwise-link-xsec-token">公开攻略链接</a><p>目标结果：景点预约与交通信息。</p></article><article id="duplicate-result"><a href="/agent-browser-link-target?access_token=tripwise-link-private-token&xsec_token=tripwise-link-xsec-token">另一条同地址链接</a><p>另一条结果：不同网页语境。</p></article></div><a href="/official">官方预约</a><script>setTimeout(() => { const link = document.querySelector("#target-result a"); if (link) { const replacement = link.cloneNode(true); replacement.textContent = "替换后的官方参观须知"; link.replaceWith(replacement); fetch("/agent-browser-rerendered", { cache: "no-store" }).catch(() => {}) } }, 1500); Array.from = () => { throw new Error("page main-world override") }; window.getComputedStyle = () => { throw new Error("page main-world override") }; window.scrollBy = () => { throw new Error("page main-world override") }</script>'
      : '<!doctype html><title>Tripwise Egress Probe</title><main>固定公网 IP 转发成功</main>'
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    const timer = setTimeout(() => {
      if (!response.destroyed) response.end(document)
    }, isSlowAgentBrowserPage ? 8_000 : isAgentBrowserPage ? 250 : 0)
    response.on('close', () => clearTimeout(timer))
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法启动网页出口测试代理。')
  return { server, endpoint: `http://127.0.0.1:${address.port}`, requests, pointerPhasesAtClick }
}

/** 在 Chromium 中将测试域名解析到无需出网的公网文档地址。 */
function researchProbeHostResolverRule() {
  return '--host-resolver-rules=MAP tripwise-egress-test.invalid 93.184.216.34'
}

/** 启动只绑定回环地址的 OpenAI-compatible mock，并只记录脱敏断言字段。 */
async function startModelProbeServer() {
  const requests = []
  const queuedResponses = []
  let responseStatus = 200
  const server = createHttpServer((request, response) => {
    const chunks = []
    let requestBytes = 0
    request.on('data', (chunk) => {
      requestBytes += chunk.length
      if (requestBytes <= 3_100_000) chunks.push(chunk)
    })
    request.on('end', () => {
      if (requestBytes > 3_100_000) {
        response.writeHead(413).end()
        return
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end()
        return
      }
      try {
        const rawBody = Buffer.concat(chunks).toString('utf8')
        const body = JSON.parse(rawBody)
        const messages = Array.isArray(body.messages) ? body.messages : []
        const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')
        const systemPrompt = messages.find((message) => message.role === 'system')?.content ?? ''
        const tripContextMessage = messages.find((message) =>
          message.role === 'user' && String(message.content).startsWith('以下 JSON 是当前旅行的参考数据；')
        )?.content ?? ''
        const imagePayloads = messages.flatMap((message) => Array.isArray(message.content)
          ? message.content
            .filter((part) => part?.type === 'image_url' && typeof part.image_url?.url === 'string')
            .map((part) => ({
              mimeType: /^data:(image\/[a-z0-9.+-]+);base64,/iu.exec(part.image_url.url)?.[1] ?? '',
              characterLength: part.image_url.url.length
            }))
          : [])
        let tripContext = {}
        try {
          tripContext = JSON.parse(String(tripContextMessage).split('\n').slice(1).join('\n'))
        } catch {
          tripContext = {}
        }
        const priorToolCalls = messages.flatMap((message) => Array.isArray(message.tool_calls)
          ? message.tool_calls.map((toolCall) => toolCall.function?.name).filter((name) => typeof name === 'string')
          : [])
        const queuedResponseToolCalls = Array.isArray(queuedResponses[0]?.message?.tool_calls)
          ? queuedResponses[0].message.tool_calls.map((toolCall) => toolCall.function?.name)
          : []
        requests.push({
          authorizationMatchedFixture: request.headers.authorization === `Bearer ${MODEL_PROBE_FIXTURE_KEY}`,
          bodyContainedCredential: rawBody.includes(MODEL_PROBE_FIXTURE_KEY),
          model: body.model,
          toolNames: Array.isArray(body.tools) ? body.tools.map((tool) => tool.function?.name) : [],
          ...(priorToolCalls.length ? { priorToolCalls } : {}),
          ...(queuedResponseToolCalls.length ? { queuedResponseToolCalls } : {}),
          imagePayloads,
          toolChoice: body.tool_choice,
          userPrompt: lastUserMessage?.content,
          userPrompts: messages.filter((message) => message.role === 'user')
            .map((message) => typeof message.content === 'string' ? message.content : ''),
          tripContextMarksBudgetUnknown: Array.isArray(tripContext.briefUnknownFields) && tripContext.briefUnknownFields.includes('预算'),
          userImportedSourceTitles: Array.isArray(tripContext.userImportedSources)
            ? tripContext.userImportedSources.map((source) => source.title)
            : [],
          ...(typeof tripContext.latestDraft?.title === 'string' ? {
            latestDraftTitle: tripContext.latestDraft.title,
            latestDraftStopTimes: Array.isArray(tripContext.latestDraft.days)
              ? tripContext.latestDraft.days.flatMap((day) => Array.isArray(day.stops)
                ? day.stops.map((stop) => stop.time).filter((time) => typeof time === 'string')
                : [])
              : []
          } : {}),
          toolOutputContainsUnconfirmedDestination: messages.some((message) =>
            message.role === 'tool' && String(message.content).includes('用户原话未明确提及目的地')),
          toolOutputContainsBlockedDestination: messages.some((message) =>
            message.role === 'tool' && String(message.content).includes('当前目的地未明确')),
          toolOutputContainsResearchBrowserPage: messages.some((message) =>
            message.role === 'tool' && String(message.content).includes('景点预约请核对官方公告。')),
          ...(messages.some((message) => message.role === 'tool' && String(message.content).includes('已停止该站点的自动读取'))
            ? { toolOutputContainsResearchBrowserLoginGate: true }
            : {}),
          toolOutputContainsExpandedBrowserText: messages.some((message) =>
            message.role === 'tool' && String(message.content).includes('展开后正文：故宫预约与交通请以官方信息为准。')),
          toolOutputContainsBrowserSearchResult: messages.some((message) =>
            message.role === 'tool' && String(message.content).includes('站内搜索命中：故宫到天坛公共交通。')),
          toolOutputContainsVisualClue: messages.some((message) =>
            message.role === 'tool' && String(message.content).includes('模型从当前网页视口识别到以下线索')),
          bodyContainsResearchUrlCredential: rawBody.includes('tripwise-browser-private-token'),
          bodyContainsSnapshotLinkCredential: rawBody.includes('tripwise-link-private-token') ||
            rawBody.includes('tripwise-link-xsec-token')
        })
        response.writeHead(responseStatus, { 'Content-Type': 'application/json' })
        if (responseStatus === 200) {
          const queued = queuedResponses.shift()
          const message = queued?.message ?? {
            role: 'assistant',
            tool_calls: [{ id: 'call_e2e_probe', type: 'function', function: {
              name: 'propose_trip_brief', arguments: '{"destination":"北京"}'
            } }]
          }
          const body = JSON.stringify({ choices: [{ message }] })
          if (queued?.delayMs) setTimeout(() => response.end(body), queued.delayMs)
          else response.end(body)
        } else {
          response.end(JSON.stringify({ error: { message: 'mock authentication failure' } }))
        }
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
  if (!address || typeof address === 'string') throw new Error('无法启动模型连接测试用本机服务。')
  return {
    server,
    endpoint: `http://127.0.0.1:${address.port}/v1`,
    requests,
    setResponseStatus(status) { responseStatus = status },
    queueResponse(message, delayMs = 0) { queuedResponses.push({ message, delayMs }) }
  }
}

/** 为本机模型服务构造一份可审阅的上海候选，避免真实出行来源请求。 */
function makeBudgetPlan(sourceId) {
  const items = [
    ['flight', '往返交通', 100_000, 120_000],
    ['intercity-transport', '城际交通', 20_000, 30_000],
    ['lodging', '住宿', 40_000, 50_000],
    ['local-transport', '市内交通', 5_000, 8_000],
    ['tickets', '门票与预约', 10_000, 15_000],
    ['meals', '餐饮', 30_000, 40_000]
  ].map(([category, title, amountMinFen, amountMaxFen]) => ({
    category,
    title,
    amount_min_fen: amountMinFen,
    amount_max_fen: amountMaxFen,
    quantity: 1,
    unit_label: '项',
    evidence_level: 'estimated',
    source_ids: [],
    basis: '仅供端到端测试的规划区间，不代表实时价格。'
  }))

  return {
    title: '上海慢行一日游',
    summary: '根据用户导入的外滩散步攻略整理轻松路线。',
    tradeoffs: '按用户给出的预算上限作规划估算；金额和营业信息仍需出发前复核。',
    budget_estimate: {
      currency: 'CNY',
      items,
      not_applicable_categories: [{ category: 'other', reason: '本测试方案不估算个人购物。' }]
    },
    days: [{
      day_number: 1,
      date: '',
      title: '外滩与黄浦江畔',
      stops: [
        {
          name: '外滩', area: '上海市·黄浦区·外滩', time: '16:00', duration_minutes: 45,
          category: '人文与夜景', notes: '依据用户导入攻略安排；具体活动与营业信息待核验。',
          transit_to_next: '', evidence_level: 'sourced', source_ids: [sourceId], fact_claims: []
        },
        {
          name: '陆家嘴滨江', area: '浦东新区·陆家嘴', time: '17:15—18:00', duration_minutes: 45,
          category: '城市景观', notes: '具体开放和交通信息待核验。',
          transit_to_next: '', evidence_level: 'pending', source_ids: [], fact_claims: []
        },
        {
          name: '外滩夜景', area: '黄浦区·外滩', time: '18:30—19:30', duration_minutes: 45,
          category: '人文与夜景', notes: '该返回顺序用于验证片区审阅入口。',
          transit_to_next: '', evidence_level: 'pending', source_ids: [], fact_claims: []
        }
      ],
      schedule_blocks: [{
        kind: 'meal', title: '午餐', time: '12:00', duration_minutes: 60,
        area: '外滩附近', notes: '餐馆待选'
      }]
    }]
  }
}

/** 在主进程替换系统文件对话框入口，让真实 IPC 流程使用隔离测试文件。 */
async function installBackupDialogStubs(instance, backupFilePath) {
  return instance.evaluate(({ dialog }, filePath) => {
    const calls = { save: [], open: [], confirm: [] }
    dialog.showSaveDialog = async (...args) => {
      const options = args.at(-1)
      calls.save.push(options?.title ?? '')
      if (options?.title !== '备份当前旅行') throw new Error(`意外的保存对话框：${options?.title ?? '无标题'}`)
      return { canceled: false, filePath }
    }
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1)
      calls.open.push(options?.title ?? '')
      if (options?.title !== '选择 Tripwise 旅行备份') throw new Error(`意外的打开对话框：${options?.title ?? '无标题'}`)
      return { canceled: false, filePaths: [filePath] }
    }
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1)
      calls.confirm.push(options?.title ?? '')
      if (options?.title !== '导入旅行备份') throw new Error(`意外的确认对话框：${options?.title ?? '无标题'}`)
      return { response: 1, checkboxChecked: false }
    }
    globalThis.__tripwiseE2EBackupDialogCalls = calls
    return true
  }, backupFilePath)
}

/** 对已打包应用启用仅回环 DevTools，避开生产包禁用的 Node inspector 通道。 */
async function launchPackagedApplication(executablePath, env) {
  const port = await reserveLoopbackPort()
  const child = spawn(executablePath, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    researchProbeHostResolverRule()
  ], { env, stdio: 'ignore' })
  let launchError
  child.once('error', (error) => { launchError = error })
  let browser
  const deadline = Date.now() + 30_000
  try {
    while (Date.now() < deadline) {
      if (launchError) throw new Error(`无法启动打包应用：${launchError.message}`)
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`打包应用提前退出，退出码：${child.exitCode ?? child.signalCode}`)
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (response.ok) {
          browser ??= await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 })
          const page = browser.contexts().flatMap((context) => context.pages())[0]
          if (page) {
            await page.emulateMedia({ reducedMotion: 'reduce' })
            observePage(page)
            return { instance: createPackagedInstance(browser, child), page }
          }
        }
      } catch {
        // 应用与 renderer 启动时继续短暂轮询本机 DevTools 端口。
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
    }
    throw new Error('等待打包应用创建生产 renderer 超时。')
  } catch (error) {
    await browser?.close().catch(() => undefined)
    if (!launchError) await stopPackagedProcess(child)
    throw error
  }
}

/** 释放一个本机端口；应用启动后只将调试服务绑定到回环地址。 */
async function reserveLoopbackPort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  if (!address || typeof address === 'string') throw new Error('无法分配本机端到端测试端口。')
  return address.port
}

/** 关闭 CDP 会话和打包应用子进程，避免测试留下桌面进程。 */
function createPackagedInstance(browser, child) {
  let closeTask
  return {
      browser,
    close() {
      closeTask ??= (async () => {
        await browser.close().catch(() => undefined)
        await stopPackagedProcess(child)
      })()
      return closeTask
    }
  }
}

/** 等待打包 Electron 主进程退出，超时后终止这次测试启动的进程。 */
async function stopPackagedProcess(child) {
  if (hasPackagedProcessExited(child)) return
  child.kill('SIGTERM')
  if (!await waitForPackagedProcess(child, 5_000)) {
    child.kill('SIGKILL')
    await waitForPackagedProcess(child, 1_000)
  }
}

/** 等待受测进程退出，并清除退出监听与超时计时器。 */
function waitForPackagedProcess(child, timeoutMs) {
  if (hasPackagedProcessExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs)
    const finish = (exited) => {
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
      resolve(exited)
    }
    const onExit = () => finish(true)
    const onError = () => finish(true)
    child.once('exit', onExit)
    child.once('error', onError)
    if (hasPackagedProcessExited(child)) finish(true)
  })
}

/** 判断子进程是否已通过退出码或系统信号结束。 */
function hasPackagedProcessExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

/** 统一收集页面异常和远端请求，确保本地打包流程与开发流程使用相同断言。 */
function observePage(page) {
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') rendererErrors.push(message.text())
  })
  page.on('request', (request) => {
    const url = new URL(request.url())
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      remoteHosts.add(url.host)
    }
  })
}

/** 在真实生产页面运行 WCAG 2.2 AA 自动规则；未自动判定项仍需人工检查。 */
async function assertAccessible(page, stateLabel) {
  if (!axePages.has(page)) {
    const session = await page.context().newCDPSession(page)
    try {
      const injected = await session.send('Runtime.evaluate', { expression: axe.source, awaitPromise: true })
      assert.equal(injected.exceptionDetails, undefined, '无法将 axe-core 测试脚本注入生产页面。')
    } finally {
      await session.detach()
    }
    axePages.add(page)
  }
  const badgeContrast = await verifyResearchBadgeContrast(page)
  const conversationCountContrast = await verifyConversationCountContrast(page)
  const result = await page.evaluate(async ({ tags, sourceBadgeSelector }) => {
    const scan = await window.axe.run(document, { runOnly: { type: 'tag', values: tags } })
    const sourceBadges = new Set(document.querySelectorAll(sourceBadgeSelector))
    return {
      passes: scan.passes.length,
      incomplete: scan.incomplete.map((item) => ({
        rule: item.id,
        help: item.help,
        nodes: item.nodes.map((node) => ({
          targets: node.target,
          isVerifiedResearchBadge: node.target.some((target) => {
            try { return sourceBadges.has(document.querySelector(target)) } catch { return false }
          }),
          styles: node.target.flatMap((target) => {
            let element
            try { element = document.querySelector(target) } catch { return [] }
            if (!element) return []
            const style = getComputedStyle(element)
            const backgrounds = []
            for (let current = element; current && backgrounds.length < 4; current = current.parentElement) {
              const ancestorStyle = getComputedStyle(current)
              backgrounds.push(`${current.tagName.toLowerCase()}${typeof current.className === 'string' && current.className ? `.${current.className.split(/\\s+/).join('.')}` : ''}=${ancestorStyle.backgroundColor}`)
              if (ancestorStyle.backgroundColor.startsWith('rgb(') && !ancestorStyle.backgroundColor.includes(', 0)')) break
              if (ancestorStyle.backgroundColor === 'rgba(0, 0, 0, 0)') continue
            }
            return [`text=${style.color}; background=${style.backgroundColor}; size=${style.fontSize}; ancestors=${backgrounds.join(' <- ')}`]
          })
        }))
      })),
      violations: scan.violations.map((violation) => ({
        rule: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary }))
      }))
    }
  }, { tags: WCAG_22_AA_TAGS, sourceBadgeSelector: RESEARCH_BADGE_TARGET })
  const findings = result.violations.map((violation) =>
    `${violation.rule} (${violation.impact}): ${violation.help}\n${violation.nodes.map((node) => `  ${node.target.join(' ')}\n${node.summary}`).join('\n')}`
  ).join('\n')
  assert.equal(result.violations.length, 0, `${stateLabel} 存在 WCAG 2.2 AA 自动检查问题：\n${findings}`)
  const unresolvedIncomplete = result.incomplete.map((item) => ({
    ...item,
    nodes: item.nodes.filter((node) => !(item.rule === 'color-contrast'
      && badgeContrast.length > 0
      && node.isVerifiedResearchBadge))
  })).filter((item) => item.nodes.length > 0)
  const manualReview = unresolvedIncomplete.map((item) => `${item.rule}: ${item.nodes.map((node) => `${node.targets.join(', ')}${node.styles.length ? ` (${node.styles.join(' | ')})` : ''}`).join('; ') || item.help}`).join('；')
  const contrastEvidence = [
    ...badgeContrast.map((badge) => `来源数 ${badge.foreground} / ${badge.background} = ${badge.ratio.toFixed(2)}:1，${badge.fontSize}`),
    ...conversationCountContrast.map((count) => `话题数 ${count.foreground} / ${count.background} = ${count.ratio.toFixed(2)}:1，${count.fontSize}`)
  ].join('；')
  process.stdout.write(`通过：${stateLabel} 的 axe-core WCAG 2.2 AA 扫描（${result.passes} 项通过，${unresolvedIncomplete.length} 项未自动判定${manualReview ? `：${manualReview}` : ''}${contrastEvidence ? `；实际 DOM 对比度已核验：${contrastEvidence}` : ''}）。\n`)
}

/** 通过真实 Tab 顺序抵达控件，并检查焦点可见且没有落入视口外。 */
async function tabToControl(page, target, label, maxSteps = 40) {
  for (let step = 1; step <= maxSteps; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return step - 1
    await page.keyboard.press('Tab')
    const state = await page.evaluate(() => {
      const element = document.activeElement
      const bounds = element.getBoundingClientRect()
      return {
        tagName: element.tagName,
        accessibleName: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 80) || '',
        visible: bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0 && bounds.left < innerWidth && bounds.top < innerHeight,
        focusVisible: element.matches(':focus-visible')
      }
    })
    assert.notEqual(state.tagName, 'BODY', `${label} 的 Tab 顺序不能丢失焦点。`)
    assert.ok(state.visible, `${label} 的 Tab 顺序经过视口外控件：${JSON.stringify(state)}`)
    if (await target.evaluate((element) => element === document.activeElement)) {
      assert.ok(state.focusVisible, `${label} 获得键盘焦点时应显示焦点指示：${JSON.stringify(state)}`)
      return step
    }
  }
  throw new Error(`无法在 ${maxSteps} 次 Tab 操作内到达${label}。`)
}

/** 确认默认本地 renderer 的通知权限也由主进程明确拒绝。 */
async function assertBrowserPermissionsDenied(page) {
  const permission = await page.evaluate(async () => Notification.requestPermission())
  assert.equal(permission, 'denied', 'Tripwise 内置页面不应获批浏览器通知权限。')
}

try {
  const modelProbe = await startModelProbeServer()
  modelProbeServer = modelProbe.server
  const researchProxyProbe = await startResearchProxyProbeServer()
  researchProxyProbeServer = researchProxyProbe.server
  let launched = await launchApplication()
  application = launched.instance
  let { page } = launched
  await assertBrowserPermissionsDenied(page)
  if (!process.env.TRIPWISE_E2E_EXECUTABLE) {
    const webRtcPolicy = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .flatMap((window) => window.contentView.children)
        .map((view) => view.webContents?.getWebRTCIPHandlingPolicy?.())
        .find(Boolean) ?? null
    )
    assert.equal(webRtcPolicy, 'disable_non_proxied_udp', '隔离研究网页限制未代理的 WebRTC UDP。')
    const researchSessionIsPersistent = await application.evaluate(({ session }) =>
      session.fromPartition('tripwise-research').isPersistent()
    )
    assert.equal(researchSessionIsPersistent, false, '研究网页的手动登录态只能留在内存，不能跨应用重启。')
  }

  // 验证空白工作区可从旅行侧栏进入连接设置并正确恢复焦点。
  await page.getByRole('button', { name: '新建旅行', exact: true }).waitFor({ state: 'visible' })
  await assertAccessible(page, '空白旅行规划页')
  // 验证键盘可跳过重复导航，并把焦点送到主要工作区。
  const skipLink = page.getByRole('link', { name: '跳至主要内容', exact: true })
  await page.keyboard.press('Tab')
  assert.equal(await skipLink.evaluate((element) => element === document.activeElement), true, '键盘顺序第一项应为跳过重复导航的入口。')
  await page.waitForFunction(() => {
    const element = document.querySelector('.skip-link')
    return !!element && element.matches(':focus-visible') && element.getBoundingClientRect().top >= 0
  }, undefined, { timeout: 3_000 })
  const skipLinkFocus = await skipLink.evaluate((element) => ({
    top: element.getBoundingClientRect().top,
    transform: getComputedStyle(element).transform
  }))
  assert.ok(skipLinkFocus.top >= 0, `跳转链接获得键盘焦点时应进入可视区域：${JSON.stringify(skipLinkFocus)}`)
  await page.keyboard.press('Enter')
  assert.equal(await page.locator('#main-workspace').evaluate((element) => element === document.activeElement), true, '跳转链接应将焦点移至主工作区。')
  const configureModelButton = page.getByRole('button', { name: '设置', exact: true })
  await configureModelButton.waitFor({ state: 'visible' })
  assert.match(await page.locator('.connection-pill').innerText(), /连接模型/, '未配置模型时应提供直达设置的入口。')
  await configureModelButton.click()
  const firstRunSettings = page.getByRole('dialog', { name: '设置' })
  await firstRunSettings.waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  await firstRunSettings.waitFor({ state: 'detached' })
  assert.equal(await configureModelButton.evaluate((element) => element === document.activeElement), true, '关闭首次配置弹窗后应把焦点还给模型设置入口。')
  process.stdout.write('通过：空白工作区可从侧栏打开连接设置，关闭后焦点返回原入口。\n')
  // 使用两日隔离计划验证重名提示预填，并在本段结束时清除临时旅行。
  await page.getByRole('button', { name: '新建旅行', exact: true }).click()
  const createDialog = page.getByRole('dialog', { name: '新建旅行' })
  const createDestination = createDialog.getByLabel('目的地')
  const closeDialogButton = createDialog.getByRole('button', { name: '关闭窗口' })
  const createTripButton = createDialog.getByRole('button', { name: '创建旅行', exact: true })
  const initialFocusState = await createDestination.evaluate((element) => ({
    focused: element === document.activeElement,
    activeElement: document.activeElement?.outerHTML.slice(0, 180) ?? '无活动元素',
    documentHasFocus: document.hasFocus(),
    visibility: document.visibilityState
  }))
  assert.equal(initialFocusState.focused, true, `弹窗打开后应把焦点放到主要输入项：${JSON.stringify(initialFocusState)}`)
  await assertAccessible(page, '新建旅行弹窗')
  await createDestination.focus()
  await page.keyboard.press('Shift+Tab')
  assert.equal(await closeDialogButton.evaluate((element) => element === document.activeElement), true, '弹窗内焦点应按可见顺序移动。')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await createTripButton.evaluate((element) => element === document.activeElement), true, '弹窗 Shift+Tab 应从首项循环到末项。')
  await page.keyboard.press('Tab')
  assert.equal(await closeDialogButton.evaluate((element) => element === document.activeElement), true, '弹窗 Tab 应从末项循环回首项。')
  await page.keyboard.press('Escape')
  await createDialog.waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('button', { name: '新建旅行', exact: true }).evaluate((element) => element === document.activeElement), true, '关闭弹窗后应将焦点还给打开按钮。')
  await page.getByRole('button', { name: '新建旅行', exact: true }).click()
  const reopenedCreateDialog = page.getByRole('dialog', { name: '新建旅行' })
  await reopenedCreateDialog.getByLabel('目的地').fill('北京')
  await reopenedCreateDialog.getByRole('button', { name: '创建旅行', exact: true }).click()
  try {
    await page.getByRole('heading', { name: '北京', exact: true }).waitFor({ state: 'visible', timeout: 5_000 })
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      activeElement: document.activeElement?.outerHTML.slice(0, 180) ?? '无活动元素',
      openDialog: document.querySelector('[role="dialog"]')?.textContent?.slice(0, 500) ?? '',
      visibleText: document.body.innerText.slice(-1_200)
    }))
    throw new Error(`创建旅行后未显示目的地：${JSON.stringify(diagnostic)}；${error instanceof Error ? error.message : String(error)}`)
  }
  assert.equal(await page.locator('.trip-backup-actions button').first().isDisabled(), false, '创建旅行后应能立即备份当前旅行。')
  assert.equal(await page.locator('.trip-subtitle').innerText(), '日期待定', '旅行标题已是目的地时，页头只补充日期状态。')
  await assertAccessible(page, '已创建旅行')
  await page.getByRole('button', { name: '新建话题', exact: true }).click()
  await page.getByRole('button', { name: '删除话题：新话题', exact: true }).click()
  const deleteConversationDialog = page.getByRole('dialog', { name: '删除“新话题”' })
  await assertAccessible(page, '删除话题确认')
  await deleteConversationDialog.getByRole('button', { name: '删除话题', exact: true }).click()
  await deleteConversationDialog.waitFor({ state: 'detached' })
  assert.equal(await page.locator('.conversation-select').count(), 1, '删除新话题后应保留原话题。')
  process.stdout.write('通过：话题可经确认删除，其他旅行话题继续保留。\n')
  const accessibleMain = page.getByRole('main')
  const itineraryTab = page.getByRole('button', { name: '行程', exact: true })
  const preparationTab = page.getByRole('button', { name: '出行准备', exact: true })
  await accessibleMain.focus()
  const itineraryTabPosition = await tabToControl(page, itineraryTab, '行程视图切换')
  assert.ok(itineraryTabPosition > 0 && itineraryTabPosition < 10, '行程视图应能从主工作区按合理 Tab 顺序到达。')
  await page.keyboard.press('Enter')
  assert.equal(await itineraryTab.getAttribute('aria-current'), 'page', 'Enter 应能通过键盘打开行程视图。')
  await tabToControl(page, preparationTab, '出行准备视图切换')
  await page.keyboard.press('Space')
  assert.equal(await preparationTab.getAttribute('aria-current'), 'page', 'Space 应能通过键盘打开出行准备视图。')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await itineraryTab.evaluate((element) => element === document.activeElement), true, 'Shift+Tab 应按相反顺序回到行程视图。')
  await page.keyboard.press('Shift+Tab')
  const chatTab = page.getByRole('button', { name: '规划', exact: true })
  assert.equal(await chatTab.evaluate((element) => element === document.activeElement), true, 'Shift+Tab 应按相反顺序回到对话视图。')
  await page.keyboard.press('Enter')
  assert.equal(await chatTab.getAttribute('aria-current'), 'page', 'Enter 应能通过键盘返回对话视图。')

  const webPanelTab = page.locator('.research-panel-tabs > button').nth(1)
  const sourcesPanelTab = page.locator('.research-panel-tabs > button').nth(0)
  await webPanelTab.focus()
  await page.keyboard.press('Enter')
  assert.equal(await webPanelTab.getAttribute('aria-pressed'), 'true', 'Enter 应能通过键盘打开网页面板。')
  await sourcesPanelTab.focus()
  await page.keyboard.press('Space')
  assert.equal(await sourcesPanelTab.getAttribute('aria-pressed'), 'true', 'Space 应能通过键盘返回来源面板。')

  await accessibleMain.focus()
  const composer = page.getByLabel('旅行对话输入框')
  await tabToControl(page, composer, '旅行规划输入框')
  await composer.fill('键盘换行')
  await composer.press('Shift+Enter')
  assert.equal(await composer.inputValue(), '键盘换行\n', 'Shift+Enter 应保留草稿并插入换行。')
  await composer.fill('')
  process.stdout.write('通过：主工作区视图、右侧来源/网页面板和旅行输入框可由键盘到达；Enter/Space 切换、反向焦点顺序、可见焦点及 Shift+Enter 均正常。\n')
  const blockedResearchNavigation = await page.evaluate(async () => {
    try {
      await window.tripwise.navigateResearch('http://127.0.0.1:8080/private')
      return ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })
  assert.match(blockedResearchNavigation, /公网域名/, '网页研究不能导航到用户机器上的代理或其他本机服务。')

  const navigation = page.getByRole('complementary', { name: '旅行导航' })
  await navigation.getByRole('button', { name: '收起旅行栏' }).click()
  const mainWorkspace = page.getByRole('main')
  assert.equal(await mainWorkspace.getByRole('button', { name: '展开旅行栏', exact: true }).count(), 0, '主区不应重复显示展开旅行栏按钮。')
  await navigation.getByRole('button', { name: '展开旅行栏', exact: true }).click()
  await navigation.getByRole('button', { name: '收起旅行栏' }).waitFor({ state: 'visible' })

  await page.getByRole('button', { name: '旅行信息' }).click()
  const briefDialog = page.getByRole('dialog', { name: '旅行信息' })
  await assertAccessible(page, '旅行信息弹窗')
  await briefDialog.getByRole('textbox', { name: '目的地', exact: true }).fill('上海')
  await briefDialog.getByRole('textbox', { name: '预算', exact: true }).fill('每天 800 元')
  await briefDialog.locator('.brief-unknown-disclosure > summary').click()
  await assertAccessible(page, '旅行信息中的暂未知选项')
  const briefLabelContrast = await verifyBriefFieldLabelContrast(page)
  process.stdout.write(`通过：旅行信息标签以弹窗实际底色人工复核对比度（${briefLabelContrast.count} 项，最低 ${briefLabelContrast.minimumRatio.toFixed(2)}:1）。\n`)
  await briefDialog.getByRole('checkbox', { name: '预算', exact: true }).check()
  assert.equal(await briefDialog.getByRole('textbox', { name: '预算', exact: true }).inputValue(), '', '标记预算暂未知时应清除旧值。')
  await briefDialog.getByRole('button', { name: '保存旅行信息', exact: true }).click()
  await page.getByRole('heading', { name: '上海', exact: true }).waitFor({ state: 'visible' })
  await page.locator('.brief-readiness').getByText('预算', { exact: false }).waitFor({ state: 'visible' })
  const unknownBudgetState = await page.evaluate(async () => {
    const snapshot = await window.tripwise.getSnapshot()
    const trip = snapshot.trips.find((item) => item.id === snapshot.selectedTripId)
    return { budget: trip?.brief.budget, unknownFields: trip?.briefUnknownFields }
  })
  assert.deepEqual(unknownBudgetState, { budget: '', unknownFields: ['budget'] }, '旅行数据应区分明确未知与普通空白。')
  process.stdout.write('通过：旅行简报可明确标记暂未知，并在界面与数据中保留状态。\n')

  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settingsDialog = page.getByRole('dialog', { name: '设置' })
  await settingsDialog.waitFor({ state: 'visible' })
  await assertAccessible(page, '设置')
  const modelTab = settingsDialog.getByRole('tab', { name: '模型', exact: true })
  const sourceTab = settingsDialog.getByRole('tab', { name: '信息源', exact: true })
  const advancedTab = settingsDialog.getByRole('tab', { name: '高级', exact: true })
  assert.equal(await modelTab.getAttribute('tabindex'), '0', '只有当前设置页签应进入 Tab 序列。')
  assert.equal(await sourceTab.getAttribute('tabindex'), '-1', '未选中的设置页签应由方向键访问。')
  await modelTab.focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await sourceTab.getAttribute('aria-selected'), 'true', '右方向键应切到下一页签。')
  assert.equal(await sourceTab.evaluate((element) => element === document.activeElement), true, '切换页签后焦点应跟随选中项。')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await modelTab.getAttribute('aria-selected'), 'true', '左方向键应返回上一页签。')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await advancedTab.getAttribute('aria-selected'), 'true', '首个页签按左方向键应循环到末尾。')
  await page.keyboard.press('Home')
  assert.equal(await modelTab.getAttribute('aria-selected'), 'true', 'Home 应选择首个页签。')
  await page.keyboard.press('End')
  assert.equal(await advancedTab.getAttribute('aria-selected'), 'true', 'End 应选择末尾页签。')
  await page.keyboard.press('Home')
  assert.equal(await modelTab.getAttribute('tabindex'), '0', '键盘切换后应只保留一个 Tab 停靠点。')
  process.stdout.write('通过：设置页签支持左右方向键、Home、End 与单一 Tab 停靠点。\n')
  await settingsDialog.getByRole('tab', { name: '高级', exact: true }).click()
  await settingsDialog.locator('details').filter({ hasText: '本机文件与日志' }).locator('summary').click()
  await settingsDialog.locator('details').filter({ hasText: '网络代理' }).locator('summary').click()
  await settingsDialog.locator('details').filter({ hasText: '数据与隐私' }).locator('summary').click()
  await settingsDialog.getByText(/日志不保存对话/).waitFor({ state: 'visible' })
  const openLogDirectoryButton = settingsDialog.getByRole('button', { name: '打开日志', exact: true })
  await openLogDirectoryButton.scrollIntoViewIfNeeded()
  assert.equal(await openLogDirectoryButton.isVisible(), true, '设置页应提供本机运行日志入口。')
  assert.match(await settingsDialog.innerText(), /日志不保存对话、工具参数、网页地址或密钥/, '设置页应说明本机日志的收集边界。')
  await settingsDialog.getByText(/请只使用可信代理/).waitFor({ state: 'visible' })
  const privacyDisclosure = await settingsDialog.locator('.privacy-card').innerText()
  assert.match(privacyDisclosure, /本次对话、旅行信息、已保存行程和准备清单/, '隐私说明应点明发送给模型的旅行资料。')
  assert.match(privacyDisclosure, /Open-Meteo/, '隐私说明应列出天气服务的数据去向。')
  assert.match(privacyDisclosure, /高德/, '隐私说明应列出地图和路线服务的数据去向。')
  assert.match(privacyDisclosure, /Chrome Cookie 不导入 Tripwise 配置或旅行资料/, '隐私说明应说明 Tripwise 不保存浏览器凭证。')
  assert.match(privacyDisclosure, /OpenCLI 可通过 Browser Bridge 操作已登录的 Chrome 页面/, '隐私说明应说明小红书连接器会使用 Chrome 登录会话。')
  assert.match(privacyDisclosure, /没有系统级沙箱/, '隐私说明应说明本机 MCP 插件的运行权限。')
  await settingsDialog.getByRole('tab', { name: '模型', exact: true }).click()
  const modelParameters = settingsDialog.locator('.settings-model-section details')
  if (!(await modelParameters.evaluate((element) => element.open))) await modelParameters.locator('summary').click()
  await settingsDialog.getByLabel('服务地址').fill(modelProbe.endpoint)
  await settingsDialog.getByLabel('模型名称').fill('tripwise-e2e-mock')
  await settingsDialog.getByRole('textbox', { name: 'API Key', exact: true }).fill(MODEL_PROBE_FIXTURE_KEY)
  await settingsDialog.getByRole('button', { name: '保存并测试', exact: true }).click()
  await settingsDialog.getByText('连接成功，可以开始规划行程。', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(await page.locator('.connection-pill').count(), 0, '模型已配置后不占用工作区显示状态标签。')
  const savedModelConfig = await page.evaluate(async () => {
    const snapshot = await window.tripwise.getSnapshot()
    return {
      baseUrl: snapshot.settings.model.baseUrl,
      model: snapshot.settings.model.model,
      provider: snapshot.settings.model.provider,
      modelKeySaved: snapshot.secrets.modelKeySaved
    }
  })
  assert.deepEqual(savedModelConfig, {
    baseUrl: modelProbe.endpoint,
    model: 'tripwise-e2e-mock',
    provider: 'openai-compatible',
    modelKeySaved: true
  }, '设置页应保存模型地址/名称，并只向 renderer 返回 Key 的存在状态。')
  assert.equal(modelProbe.requests.length, 1, '连接测试应只请求一次 Chat Completions。')
  assert.deepEqual(modelProbe.requests[0], {
    authorizationMatchedFixture: true,
    bodyContainedCredential: false,
    model: 'tripwise-e2e-mock',
    toolNames: ['propose_trip_brief'],
    imagePayloads: [],
    toolChoice: 'auto',
    userPrompt: '我这次想去北京。',
    userPrompts: ['我这次想去北京。'],
    tripContextMarksBudgetUnknown: false,
    userImportedSourceTitles: [],
    toolOutputContainsUnconfirmedDestination: false,
    toolOutputContainsBlockedDestination: false,
    toolOutputContainsResearchBrowserPage: false,
    toolOutputContainsExpandedBrowserText: false,
    toolOutputContainsBrowserSearchResult: false,
    toolOutputContainsVisualClue: false,
    bodyContainsResearchUrlCredential: false,
    bodyContainsSnapshotLinkCredential: false
  }, '模型请求应使用凭证头、发送实际工具契约，并避免把凭证放进请求正文。')
  modelProbe.setResponseStatus(401)
  await settingsDialog.getByRole('button', { name: '保存并测试', exact: true }).click()
  await settingsDialog.getByText(/模型接口返回 HTTP 401/).waitFor({ state: 'visible' })
  assert.equal(modelProbe.requests.length, 2, '连接失败检查应向同一本机端点发起一次请求。')
  assert.equal(modelProbe.requests[1].authorizationMatchedFixture, true)
  assert.equal(modelProbe.requests[1].bodyContainedCredential, false)
  assert.equal((await page.locator('body').innerText()).includes(MODEL_PROBE_FIXTURE_KEY), false, 'Key 不得出现在 UI 错误或页面文字中。')
  await settingsDialog.getByRole('tab', { name: '信息源', exact: true }).click()
  assert.equal(await settingsDialog.getByText(/模型接口返回 HTTP 401/u).count(), 0,
    '切换设置分类后应清除其他分类遗留的测试错误。')
  const planningSourcesDisclosure = settingsDialog.locator('.settings-connector-disclosure')
  assert.match(await planningSourcesDisclosure.locator('summary').innerText(), /4\/4 已启用/u,
    '折叠的数据来源列表应保留当前启用数量。')
  assert.equal(await planningSourcesDisclosure.locator('.connector-setting-row').first().isVisible(), false,
    '低频数据来源开关默认收起，避免设置页堆叠重复说明。')
  await planningSourcesDisclosure.locator('summary').click()
  assert.equal(await planningSourcesDisclosure.locator('.connector-setting-row:visible').count(), 4,
    '展开后应提供全部四个内置数据来源开关。')
  await assertAccessible(page, '展开的数据来源设置')
  await planningSourcesDisclosure.locator('summary').click()
  await settingsDialog.locator('#settings-panel-sources > details.settings-disclosure > summary').filter({ hasText: '网页搜索' }).click()
  await settingsDialog.getByRole('button', { name: '保存并测试连接', exact: true }).first().click()
  await settingsDialog.getByText('请先在连接设置中填写 Exa Key。', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(modelProbe.requests.length, 2, '缺少连接器凭证时不应额外访问模型服务。')
  process.stdout.write('通过：设置页保存并测试 OpenAI-compatible 配置；本机 mock 验证工具调用、认证头、脱敏 HTTP 401，以及缺少连接器密钥时不会发起请求。\n')

  modelProbe.setResponseStatus(200)
  await settingsDialog.getByRole('tab', { name: '高级', exact: true }).click()
  await settingsDialog.locator('details').filter({ hasText: '浏览器与小红书' }).locator('summary').click()
  await settingsDialog.locator('label.connector-toggle').filter({ hasText: '已关闭网页图像识别' }).click()
  const proxyDisclosure = settingsDialog.locator('details').filter({ hasText: '网络代理' })
  if (!(await proxyDisclosure.evaluate((element) => element.open))) await proxyDisclosure.locator('summary').click()
  await settingsDialog.getByLabel('代理地址').waitFor({ state: 'visible' })
  await settingsDialog.getByLabel('代理地址').fill(researchProxyProbe.endpoint)
  await settingsDialog.getByRole('button', { name: '保存', exact: true }).click()
  await settingsDialog.getByText('设置已保存。', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(await settingsDialog.getByRole('checkbox', { name: '已启用网页图像识别', exact: true }).isChecked(), true,
    '网页图像识别应通过明确的本地设置启用。')
  await page.keyboard.press('Escape')
  await settingsDialog.waitFor({ state: 'detached' })
  const researchPanelClose = page.locator('.research-panel .panel-close')
  if (await researchPanelClose.isVisible().catch(() => false)) await researchPanelClose.click()
  await page.getByRole('button', { name: '打开来源面板', exact: true }).waitFor({ state: 'visible' })
  modelProbe.setResponseStatus(200)
  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_browser_navigate', type: 'function', function: {
      name: 'research_browser_navigate',
      arguments: '{"url":"http://tripwise-egress-test.invalid/agent-browser?access_token=tripwise-browser-private-token"}'
    } }]
  })
  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_browser_open_link', type: 'function', function: {
      name: 'research_browser_open_link', arguments: '{"target_id":"l1"}'
    } }]
  }, 1_800)
  modelProbe.queueResponse({ role: 'assistant', content: '我在右侧隔离网页中读取了预约提示和页面来源。' })
  const browserRequestStart = modelProbe.requests.length
  await page.getByLabel('旅行对话输入框').fill('用右侧研究浏览器打开测试页面，读取预约提示。')
  await page.getByRole('button', { name: '发送消息' }).click()
  await page.getByText('Agent 正在浏览', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 })
  await page.locator('.browser-panel').waitFor({ state: 'visible' })
  assert.equal(await webPanelTab.getAttribute('aria-pressed'), 'true', '右侧面板收起时，Agent 开始浏览应自动展开并切到网页。')
  assert.equal(await webPanelTab.isDisabled(), true, 'Agent 正在浏览时不应隐藏当前可操作的 WebView。')
  try {
    await page.locator('.browser-state-label').filter({ hasText: 'Tripwise Agent Browser' }).waitFor({ state: 'visible', timeout: 10_000 })
  } catch (error) {
    const browserDiagnostic = await page.evaluate(() => ({
      label: document.querySelector('.browser-state-label')?.textContent,
      activity: document.querySelector('.browser-activity')?.textContent,
      error: document.querySelector('.browser-error')?.textContent,
      agentProgress: document.querySelector('.agent-progress')?.textContent?.slice(0, 500)
    }))
    process.stderr.write(`浏览器面板诊断：${JSON.stringify(browserDiagnostic)}\n`)
    throw error
  }
  await page.locator('.assistant-message').getByText('我在右侧隔离网页中读取了预约提示和页面来源。', { exact: true }).waitFor({ state: 'visible' })
  await page.getByText('Agent 正在浏览', { exact: true }).waitFor({ state: 'detached' })
  assert.ok(modelProbe.requests[2].toolNames.includes('research_browser_navigate'), '浏览器导航工具应进入模型工具列表。')
  assert.ok(modelProbe.requests[2].toolNames.includes('research_browser_snapshot'), '浏览器快照工具应进入模型工具列表。')
  assert.ok(modelProbe.requests[2].toolNames.includes('research_browser_open_link'), '浏览器快照链接应通过临时编号开放给模型。')
  const browserRequests = modelProbe.requests.slice(browserRequestStart)
  const observedBrowserToolCalls = [...new Set(browserRequests.flatMap((request) => request.priorToolCalls))]
  assert.ok(observedBrowserToolCalls.includes('research_browser_navigate'), '模型应调用浏览器导航。')
  assert.ok(observedBrowserToolCalls.includes('research_browser_open_link'), '模型应能继续打开编号来源。')
  assert.ok(!observedBrowserToolCalls.includes('research_browser_snapshot'), '导航和打开链接应直接返回页面内容，不额外调用快照。')
  assert.ok(browserRequests.some((request) => request.toolOutputContainsResearchBrowserPage), '页面正文应作为浏览器工具结果回到模型。')
  assert.ok(browserRequests.every((request) => !request.bodyContainsResearchUrlCredential), '恢复的浏览器工具调用不得包含访问令牌。')
  assert.ok(browserRequests.every((request) => !request.bodyContainsSnapshotLinkCredential), '快照链接中的查询凭证不得进入后续模型上下文。')
  const browserSourceState = await page.evaluate(async () => {
    const snapshot = await window.tripwise.getSnapshot()
    const trip = snapshot.trips.find((item) => item.id === snapshot.selectedTripId)
    return {
      latest: trip?.sources.find((source) => source.provider === 'Tripwise 研究浏览器'),
      initial: trip?.sources.find((source) => source.provider === 'Tripwise 研究浏览器' && source.url.endsWith('/agent-browser'))
    }
  })
  if (browserSourceState.latest?.title !== 'Tripwise Agent Browser Link') {
    const log = await readFile(join(profileDirectory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
    const failureStages = log.split('\n').flatMap((line) => {
      try {
        const entry = JSON.parse(line)
        return entry.event === 'agent.tool.returned' && entry.browserLinkFailureStage
          ? [entry.browserLinkFailureStage] : []
      } catch { return [] }
    })
    process.stderr.write(`浏览器开链失败阶段：${JSON.stringify(failureStages)}\n`)
    const layout = await application.evaluate(async ({ webContents }) => {
      const browser = webContents.getAllWebContents().find((item) => {
        try { return new URL(item.getURL()).pathname === '/agent-browser' } catch { return false }
      })
      if (!browser || browser.isDestroyed()) return null
      return browser.executeJavaScriptInIsolatedWorld(1001, [{ code: `(() => {
        const target = document.querySelector('#target-result a')
        const rect = target?.getBoundingClientRect()
        const ancestors = []
        for (let element = target?.parentElement; element && element !== document.documentElement; element = element.parentElement) {
          if (element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1) {
            const bounds = element.getBoundingClientRect()
            const style = getComputedStyle(element)
            ancestors.push({ id: element.id, overflowY: style.overflowY, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop, top: bounds.top, bottom: bounds.bottom })
          }
        }
        const root = document.scrollingElement
        return { innerHeight, innerWidth, target: rect && { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }, ancestors, root: root && { clientHeight: root.clientHeight, scrollHeight: root.scrollHeight, scrollTop: root.scrollTop } }
      })()` }])
    })
    process.stderr.write(`浏览器长页滚动布局：${JSON.stringify(layout)}\n`)
  }
  assert.equal(browserSourceState.latest?.title, 'Tripwise Agent Browser Link', '跟进页面快照应保存为用户可审阅的旅行来源。')
  assert.equal(browserSourceState.latest?.url, 'http://tripwise-egress-test.invalid/agent-browser-link-target', '跟进来源链接应清除访问令牌。')
  assert.equal(browserSourceState.initial?.url, 'http://tripwise-egress-test.invalid/agent-browser', '初始来源链接应清除访问令牌。')
  assert.ok(researchProxyProbe.requests.some((request) => {
    const url = new URL(request.url, 'http://tripwise-proxy.invalid')
    return url.pathname === '/agent-browser-link-target' && url.search === ''
  }), '点击快照链接时，应在加载前清除非小红书查询凭证。')
  const rerenderRequestIndex = researchProxyProbe.requests.findIndex((request) =>
    new URL(request.url, 'http://tripwise-proxy.invalid').pathname === '/agent-browser-rerendered'
  )
  const linkNavigationIndex = researchProxyProbe.requests.findIndex((request) =>
    new URL(request.url, 'http://tripwise-proxy.invalid').pathname === '/agent-browser-link-target'
  )
  assert.ok(rerenderRequestIndex >= 0 && linkNavigationIndex > rerenderRequestIndex,
    '页面重绘并修改链接文案后，Agent 仍应按快照中的唯一地址定位可视指针并继续导航。')
  assert.ok(!JSON.stringify(researchProxyProbe.requests).includes('tripwise-link-private-token'), '出口请求日志不得保留普通链接凭证。')
  assert.ok(!JSON.stringify(researchProxyProbe.requests).includes('tripwise-link-xsec-token'), '非小红书链接不得保留 xsec_token。')
  assert.ok(researchProxyProbe.requests.some((request) => request.url.includes('/agent-browser') && !request.url.includes('tripwise-browser-private-token')),
    '网页会话应复用出口保护，并在请求前剥离访问令牌。')
  assert.equal(researchProxyProbe.requests.filter((request) => new URL(request.url, 'http://tripwise-proxy.invalid').pathname === '/agent-browser').length, 2,
    '公开网页遇到一次连接重置后应有界重试并成功读取。')
  process.stdout.write('通过：Agent 在右侧隔离 WebView 中导航、读取并跟进编号链接；查询凭证未进入模型或出口日志。\n')

  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_visual_read', type: 'function', function: {
      name: 'research_browser_visual_read', arguments: '{}'
    } }]
  })
  modelProbe.queueResponse({ role: 'assistant', content: '6' })
  modelProbe.queueResponse({ role: 'assistant', content: '页面配图展示了故宫红墙与银杏，可作为秋季拍照线索。' }, 1_200)
  modelProbe.queueResponse({ role: 'assistant', content: '网页画面提供了红墙与银杏的拍照线索；具体地点和开放信息仍需核对来源。' })
  await page.getByLabel('旅行对话输入框').fill('读取当前网页里的图片攻略线索。')
  await page.getByRole('button', { name: '发送消息' }).click()
  await page.locator('.agent-progress-heading').getByText('识别网页中的图文', { exact: true })
    .waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('.assistant-message').getByText('网页画面提供了红墙与银杏的拍照线索；具体地点和开放信息仍需核对来源。', { exact: true })
    .waitFor({ state: 'visible', timeout: 15_000 })
  assert.equal(await page.locator('.agent-progress-steps').count(), 0,
    '运行进度不得显示由状态文字推测的阶段条。')
  await page.getByText('Agent 正在浏览', { exact: true }).waitFor({ state: 'detached', timeout: 10_000 })
  const visualReadRequestIndex = modelProbe.requests.findIndex((request) =>
    request.userPrompt === '读取当前网页里的图片攻略线索。' && request.toolNames.includes('research_browser_visual_read')
  )
  assert.ok(visualReadRequestIndex >= 0,
    '显式启用后，Agent 工具列表应提供当前页面图像读取。')
  assert.deepEqual(modelProbe.requests[visualReadRequestIndex + 1].imagePayloads.map((image) => image.mimeType), ['image/png'],
    '发送真实网页截图前，应先向同一模型发送合成 PNG 能力探针。')
  assert.deepEqual(modelProbe.requests[visualReadRequestIndex + 2].imagePayloads.map((image) => image.mimeType), ['image/jpeg'],
    '合成图识别通过后，Electron 应实际捕获网页并发送压缩 JPEG。')
  assert.ok(modelProbe.requests[visualReadRequestIndex + 2].imagePayloads[0].characterLength > 100,
    '截图请求应包含真实图片数据，而不是空占位。')
  assert.equal(modelProbe.requests[visualReadRequestIndex + 3].toolOutputContainsVisualClue, true,
    '模型应收到明确标记为未核验的视觉线索。')
  const visualPlanState = await page.evaluate(async () => {
    const snapshot = await window.tripwise.getSnapshot()
    const trip = snapshot.trips.find((item) => item.id === snapshot.selectedTripId)
    return {
      serializedTrip: JSON.stringify(trip),
      visualSource: trip?.sources.find((source) => source.provider === 'Tripwise 视觉读取')
    }
  })
  assert.equal(visualPlanState.serializedTrip.includes('data:image/jpeg;base64,'), false, '当前网页截图不得持久化到旅行状态。')
  assert.equal(visualPlanState.serializedTrip.includes('data:image/png;base64,'), false, '合成图能力探针不得持久化到旅行状态。')
  assert.equal(visualPlanState.visualSource?.contentLevel, 'visual-clue', '视觉摘要应以独立图像线索来源保存。')
  assert.match(visualPlanState.visualSource?.summary ?? '', /红墙与银杏/u, '来源应保留模型识别到的可见线索。')
  assert.equal(visualPlanState.visualSource?.factEvidenceExcerpt, undefined, '视觉线索不得进入网页事实证据摘录。')
  await sourcesPanelTab.click()
  await page.getByText('图像线索', { exact: true }).waitFor({ state: 'visible' })
  await webPanelTab.click()
  process.stdout.write('通过：真实 Electron WebView 捕获页面视口；视觉摘要可追溯，旅行状态不保存图片载荷。\n')

  await page.evaluate((url) => window.tripwise.navigateResearch(url), 'http://tripwise-egress-test.invalid/agent-browser-login-long')
  await page.locator('.browser-state-label').getByText('页面需要登录', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 })
  assert.equal(await page.locator('.browser-state-label.browser-access-state').isVisible(), true,
    '登录状态应在网页标题栏以独立样式显示。')
  assert.equal(await page.getByRole('button', { name: '保存网页文字', exact: true }).isDisabled(), true,
    '登录遮罩后的长页面应显示门槛并禁用导入。')
  assert.match(await page.locator('.browser-footnote').innerText(), /手动登录并刷新/u,
    '登录门槛应显示用户可自行登录的恢复路径。')
  const sourcesBeforeLoginGate = await page.evaluate(async () => {
    const snapshot = await window.tripwise.getSnapshot()
    return snapshot.trips.find((trip) => trip.id === snapshot.selectedTripId)?.sources.length ?? 0
  })
  const loginGateImportError = await page.evaluate(async () => {
    const snapshot = await window.tripwise.getSnapshot()
    const tripId = snapshot.selectedTripId
    if (!tripId) return '当前没有旅行。'
    try {
      await window.tripwise.importVisiblePage(tripId)
      return ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })
  assert.match(loginGateImportError, /当前页面需要登录，尚未保存；请在右侧手动登录后再试。/u,
    '主进程仍须拒绝绕过界面直接导入登录墙。')
  const sourcesAfterLoginGate = await page.evaluate(async () => {
    const snapshot = await window.tripwise.getSnapshot()
    return snapshot.trips.find((trip) => trip.id === snapshot.selectedTripId)?.sources.length ?? 0
  })
  assert.equal(sourcesAfterLoginGate, sourcesBeforeLoginGate, '登录墙页面不能作为旅行来源保存。')
  process.stdout.write('通过：登录墙状态在网页栏可见；登录页不会写入旅行来源，用户可手动登录后再导入。\n')

  const slowPageRequestsBeforeGateRetry = researchProxyProbe.requests.filter((request) =>
    request.url.includes('/agent-browser-slow')
  ).length
  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_browser_gate', type: 'function', function: {
      name: 'research_browser_navigate', arguments: '{"url":"http://tripwise-egress-test.invalid/agent-browser-slow"}'
    } }]
  })
  modelProbe.queueResponse({ role: 'assistant', content: '当前站点要求登录，已停止继续自动读取。' })
  await page.getByLabel('旅行对话输入框').fill('继续读取刚才这个站点。')
  await page.getByRole('button', { name: '发送消息' }).click()
  await page.locator('.assistant-message').getByText('当前站点要求登录，已停止继续自动读取。', { exact: true })
    .waitFor({ state: 'visible', timeout: 10_000 })
  assert.equal(researchProxyProbe.requests.filter((request) => request.url.includes('/agent-browser-slow')).length,
    slowPageRequestsBeforeGateRetry, '登录墙后 Agent 不得再次请求同源网页。')
  assert.ok(modelProbe.requests.at(-1)?.toolOutputContainsResearchBrowserLoginGate,
    '模型应收到停止同站自动读取的固定提示。')
  process.stdout.write('通过：登录墙后 Agent 不会继续请求同站网页。\n')

  await page.evaluate((url) => window.tripwise.navigateResearch(url), 'http://tripwise-egress-test.invalid/agent-browser')
  await page.locator('.browser-state-label').filter({ hasText: 'Tripwise Agent Browser' }).waitFor({ state: 'visible', timeout: 10_000 })

  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_browser_cancel', type: 'function', function: {
      name: 'research_browser_navigate', arguments: '{"url":"http://tripwise-egress-test.invalid/agent-browser-slow"}'
    } }]
  })
  await page.getByLabel('旅行对话输入框').fill('打开慢速测试网页。')
  await page.getByRole('button', { name: '发送消息' }).click()
  await page.getByText('Agent 正在浏览', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 })
  await page.getByRole('button', { name: '停止并接管', exact: true }).click()
  await page.getByText('本次规划已取消。', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 })
  await page.getByText('Agent 正在浏览', { exact: true }).waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '刷新网页', exact: true }).waitFor({ state: 'visible', timeout: 5_000 })
  assert.equal(await page.getByRole('button', { name: '刷新网页', exact: true }).isEnabled(), true,
    '停止 Agent 浏览后，用户应能接管当前网页。')
  assert.ok(researchProxyProbe.requests.some((request) => request.url.includes('/agent-browser-slow')),
    '取消验证应在页面加载期间触发浏览器导航。')
  process.stdout.write('通过：用户可从网页栏停止正在运行的浏览器规划，Agent 请求与网页加载同时取消。\n')

  await webPanelTab.click()
  await page.evaluate(() => window.tripwise.navigateResearch('http://tripwise-egress-test.invalid/egress-probe'))
  await page.locator('.browser-state-label').filter({ hasText: 'Tripwise Egress Probe' }).waitFor({ state: 'visible', timeout: 10_000 })
  assert.ok(researchProxyProbe.requests.some((request) =>
    request.method === 'GET' && request.url === 'http://93.184.216.34:80/egress-probe' &&
    request.host === 'tripwise-egress-test.invalid'
  ), `Chromium 应经本机出口保护访问网页，代理目标必须是已校验 IP 且 Host 保留原域名。实际请求：${JSON.stringify(researchProxyProbe.requests)}`)
  process.stdout.write('通过：真实 Electron 网页会话经回环出口代理连接；上游代理收到的是校验后的公网 IP，Host 保留原域名。\n')
  if (!process.env.TRIPWISE_E2E_EXECUTABLE) {
    const webRtcStates = await application.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()
        .flatMap((window) => window.contentView.children)
        .find((child) => child.webContents?.getURL().startsWith('http://tripwise-egress-test.invalid/'))
      if (!view?.webContents) throw new Error('未找到已加载的隔离研究网页。')

      const contents = view.webContents
      const previousPolicy = contents.getWebRTCIPHandlingPolicy()
      contents.setWebRTCIPHandlingPolicy('default')
      try {
        return await contents.executeJavaScript(`(async () => {
          const peers = [new RTCPeerConnection(), new RTCPeerConnection()]
          const terminalState = (peer) => new Promise((resolve) => {
            const finish = () => {
              if (peer.iceConnectionState === 'failed' || peer.iceConnectionState === 'connected') {
                peer.removeEventListener('iceconnectionstatechange', finish)
                resolve(peer.iceConnectionState)
              }
            }
            peer.addEventListener('iceconnectionstatechange', finish)
            setTimeout(() => resolve(peer.iceConnectionState), 5000)
            finish()
          })
          const states = peers.map(terminalState)
          peers[0].createDataChannel('tripwise-egress-test')
          peers[0].onicecandidate = ({ candidate }) => {
            if (candidate) void peers[1].addIceCandidate(candidate).catch(() => {})
          }
          peers[1].onicecandidate = ({ candidate }) => {
            if (candidate) void peers[0].addIceCandidate(candidate).catch(() => {})
          }
          const offer = await peers[0].createOffer()
          await peers[0].setLocalDescription(offer)
          await peers[1].setRemoteDescription(peers[0].localDescription)
          const answer = await peers[1].createAnswer()
          await peers[1].setLocalDescription(answer)
          await peers[0].setRemoteDescription(peers[1].localDescription)
          const result = await Promise.all(states)
          for (const peer of peers) peer.close()
          return result
        })()`)
      } finally {
        if (!contents.isDestroyed()) contents.setWebRTCIPHandlingPolicy(previousPolicy)
      }
    })
    assert.deepEqual(webRtcStates, ['failed', 'failed'], '网页连接策略应由 Chromium 阻止 WebRTC，而不依赖 UDP 限制。')
    process.stdout.write('通过：Chromium 连接白名单在放宽 WebRTC IP 路由策略时仍会阻止 RTC 连接。\n')
  }

  await navigation.locator('.trip-delete').click()
  const deleteTripDialog = page.getByRole('dialog', { name: /删除“.*”/ })
  await deleteTripDialog.waitFor({ state: 'visible' })
  const deleteTripDisclosure = await deleteTripDialog.innerText()
  assert.match(deleteTripDisclosure, /旅行信息与条件/)
  assert.match(deleteTripDisclosure, /对话记录/)
  assert.match(deleteTripDisclosure, /已保存来源与导入资料/)
  assert.match(deleteTripDisclosure, /其他旅行、设置和服务密钥会保留/)
  assert.match(deleteTripDisclosure, /发给模型或外部服务的数据不会随旅行删除/)
  await deleteTripDialog.getByRole('button', { name: '取消', exact: true }).click()
  await deleteTripDialog.waitFor({ state: 'detached' })
  process.stdout.write('通过：设置页披露模型/地图/天气/小红书/MCP 数据流，旅行删除弹窗区分本机清除范围与外部副本。\n')

  if (!process.env.TRIPWISE_E2E_EXECUTABLE) {
    const backupFilePath = join(profileDirectory, 'e2e-tripwise-backup.json')
    const originalBackupState = await page.evaluate(async () => {
      const snapshot = await window.tripwise.getSnapshot()
      return { tripId: snapshot.selectedTripId, tripCount: snapshot.trips.length }
    })
    assert.equal(originalBackupState.tripCount, 1, '导入前应只有原始测试旅行。')
    await installBackupDialogStubs(application, backupFilePath)
    await page.getByRole('button', { name: '导出备份', exact: true }).click()
    await page.getByText('旅行备份已保存', { exact: true }).waitFor({ state: 'visible' })
    const backupContent = await readFile(backupFilePath, 'utf8')
    const backup = JSON.parse(backupContent)
    assert.deepEqual(Object.keys(backup).sort(), ['format', 'formatVersion', 'trip'], '旅行备份只包含版本标记和单趟旅行资料。')
    assert.equal(backup.format, 'tripwise-trip-backup')
    assert.equal(backup.formatVersion, 11)
    assert.equal(backup.trip.brief.destination, '上海')
    assert.deepEqual(backup.trip.briefUnknownFields, ['budget'], '备份应保留显式暂未知字段。')
    assert.equal(backupContent.includes(MODEL_PROBE_FIXTURE_KEY), false, '旅行备份不得包含模型凭证。')
    process.stdout.write('通过：真实桌面 IPC 将当前旅行导出到隔离 JSON 文件，并保留暂未知状态且不包含模型 Key。\n')

    await page.getByRole('button', { name: '导入备份', exact: true }).click()
    await page.getByText('备份已作为新旅行导入', { exact: true }).waitFor({ state: 'visible' })
    const importedBackupState = await page.evaluate(async () => {
      const snapshot = await window.tripwise.getSnapshot()
      return {
        selectedTripId: snapshot.selectedTripId,
        trips: snapshot.trips.map((trip) => ({
          id: trip.id,
          title: trip.title,
          destination: trip.brief.destination,
          unknownFields: trip.briefUnknownFields
        })),
        modelBaseUrl: snapshot.settings.model.baseUrl,
        modelName: snapshot.settings.model.model,
        modelKeySaved: snapshot.secrets.modelKeySaved
      }
    })
    assert.equal(importedBackupState.trips.length, 2, '恢复备份应新增旅行且保留原旅行。')
    const restoredTrip = importedBackupState.trips.find((trip) => trip.id !== originalBackupState.tripId)
    const originalTrip = importedBackupState.trips.find((trip) => trip.id === originalBackupState.tripId)
    assert.ok(restoredTrip, '恢复旅行应使用新的 Trip ID。')
    assert.ok(originalTrip, '原始旅行 ID 应继续存在。')
    assert.equal(restoredTrip.title, '上海（恢复副本）')
    assert.equal(restoredTrip.destination, '上海')
    assert.deepEqual(restoredTrip.unknownFields, ['budget'])
    assert.equal(importedBackupState.selectedTripId, restoredTrip.id, '导入成功后应打开新旅行副本。')
    assert.equal(importedBackupState.modelBaseUrl, modelProbe.endpoint, '导入旅行不得改动共享模型设置。')
    assert.equal(importedBackupState.modelName, 'tripwise-e2e-mock')
    assert.equal(importedBackupState.modelKeySaved, true, '导入旅行不得删除已配置凭证。')
    const dialogCalls = await application.evaluate(() => globalThis.__tripwiseE2EBackupDialogCalls)
    assert.deepEqual(dialogCalls, {
      save: ['备份当前旅行'],
      open: ['选择 Tripwise 旅行备份'],
      confirm: ['导入旅行备份']
    }, '界面操作应依次经过原生保存、选择和确认对话框入口。')
    process.stdout.write('通过：原生导入确认将备份恢复为新旅行，保留原旅行和共享模型配置。\n')

    await writeFile(backupFilePath, '{', 'utf8')
    await page.getByRole('button', { name: '导入备份', exact: true }).click()
    try {
      await page.getByRole('alert').getByText('备份文件不是有效的 JSON；当前资料未修改。', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 })
    } catch (error) {
      const diagnostic = {
        banners: await page.locator('.error-banner').allInnerTexts(),
        dialogCalls: await application.evaluate(() => globalThis.__tripwiseE2EBackupDialogCalls),
        backupContents: await readFile(backupFilePath, 'utf8')
      }
      throw new Error(`损坏备份错误未按预期显示：${JSON.stringify(diagnostic)}；${error instanceof Error ? error.message : String(error)}`)
    }
    const afterInvalidBackup = await page.evaluate(async () => {
      const snapshot = await window.tripwise.getSnapshot()
      return { selectedTripId: snapshot.selectedTripId, tripIds: snapshot.trips.map((trip) => trip.id) }
    })
    assert.equal(afterInvalidBackup.tripIds.length, 2, '无效备份不能改变旅行数量。')
    assert.equal(afterInvalidBackup.selectedTripId, importedBackupState.selectedTripId, '无效备份不能切换当前旅行。')
    assert.deepEqual(new Set(afterInvalidBackup.tripIds), new Set(importedBackupState.trips.map((trip) => trip.id)), '无效备份不能删除或替换现有旅行。')
    const callsAfterInvalidBackup = await application.evaluate(() => globalThis.__tripwiseE2EBackupDialogCalls)
    assert.deepEqual(callsAfterInvalidBackup, {
      save: ['备份当前旅行'],
      open: ['选择 Tripwise 旅行备份', '选择 Tripwise 旅行备份'],
      confirm: ['导入旅行备份']
    }, '无效 JSON 应在打开文件后被拒绝，不应进入二次确认。')
    await page.getByRole('alert').getByRole('button', { name: '关闭提示' }).click()
    process.stdout.write('通过：损坏 JSON 显示错误且不修改原有旅行。\n')

    await page.getByRole('button', { name: /^打开旅行：上海，日期待定/ }).click()
    await page.getByRole('heading', { name: '上海', exact: true }).waitFor({ state: 'visible' })
  } else {
    process.stdout.write('跳过：打包版自动化无法注入 Electron 主进程的原生文件对话框；JSON 备份往返已由开发版 E2E 覆盖。\n')
  }

  // 目的地留空时，即使模型尝试调用天气工具，主进程也必须拒绝并先追问用户。
  await page.getByRole('button', { name: '旅行信息' }).click()
  const missingDestinationDialog = page.getByRole('dialog', { name: '旅行信息' })
  await missingDestinationDialog.getByRole('textbox', { name: '目的地', exact: true }).fill('')
  await missingDestinationDialog.getByRole('button', { name: '保存旅行信息', exact: true }).click()
  await missingDestinationDialog.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '规划', exact: true }).click()
  modelProbe.setResponseStatus(200)
  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_fake_destination', type: 'function', function: {
      name: 'propose_trip_brief', arguments: '{"destination":"北京"}'
    } }]
  })
  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_weather_without_destination', type: 'function', function: {
      name: 'get_weather', arguments: '{"city":"北京"}'
    } }]
  })
  modelProbe.queueResponse({
    role: 'assistant',
    content: '你想去哪个城市或地区？确定目的地后，我再为你查天气和景点信息。'
  })
  await page.getByLabel('旅行对话输入框').fill('帮我规划一次旅行。')
  await page.getByRole('button', { name: '发送消息' }).click()
  await page.locator('.assistant-message').getByText(/你想去哪个城市或地区/).waitFor({ state: 'visible' })
  const completedProgress = page.locator('.agent-progress')
  await completedProgress.waitFor({ state: 'visible' })
  assert.ok((await completedProgress.getAttribute('class')).includes('agent-progress-completed'),
    '完成计划后应保留静态步骤记录。')
  assert.equal(await completedProgress.getAttribute('aria-label'), '本轮工具步骤已完成')
  assert.equal(modelProbe.requests.length, 15, '缺少目的地时应过滤模型猜测、拒绝工具越权并完成澄清回答。')
  assert.deepEqual(modelProbe.requests[12].toolNames, ['propose_trip_brief'], '目的地缺失时只能向模型开放旅行信息提案工具。')
  assert.equal(modelProbe.requests[12].userPrompt, '帮我规划一次旅行。')
  assert.equal(modelProbe.requests[12].tripContextMarksBudgetUnknown, true, '旅行上下文应标记预算未知，由系统规则控制不重复追问。')
  assert.equal(modelProbe.requests[12].authorizationMatchedFixture, true)
  assert.equal(modelProbe.requests[12].bodyContainedCredential, false)
  assert.deepEqual(modelProbe.requests[13].toolNames, ['propose_trip_brief'])
  assert.equal(modelProbe.requests[13].toolOutputContainsUnconfirmedDestination, true, '后续模型轮次应知道猜测的城市已从旅行提案中移除。')
  assert.equal(modelProbe.requests[13].authorizationMatchedFixture, true)
  assert.equal(modelProbe.requests[13].bodyContainedCredential, false)
  assert.deepEqual(modelProbe.requests[14].toolNames, ['propose_trip_brief'])
  assert.equal(modelProbe.requests[14].toolOutputContainsBlockedDestination, true, '模型越界请求天气时，主进程应返回目的地门禁结果。')
  assert.equal(modelProbe.requests[14].authorizationMatchedFixture, true)
  assert.equal(modelProbe.requests[14].bodyContainedCredential, false)
  const missingDestinationState = await page.evaluate(async () => {
    const snapshot = await window.tripwise.getSnapshot()
    const trip = snapshot.trips.find((item) => item.id === snapshot.selectedTripId)
    return {
      destination: trip?.brief.destination,
      sourceCount: trip?.sources.length,
      proposalCount: trip?.messages.filter((message) => message.role === 'assistant' && message.briefProposal).length,
      clarificationVisibleInHistory: trip?.messages.some((message) =>
        message.role === 'assistant' && message.content.includes('你想去哪个城市或地区')) ?? false
    }
  })
  assert.deepEqual(missingDestinationState, {
    destination: '',
    sourceCount: 3,
    proposalCount: 0,
    clarificationVisibleInHistory: true
  }, '目的地缺失时应保留澄清对话，不保存猜测提案或目的地，并保留此前已保存来源。')
  process.stdout.write('通过：目的地缺失时模型猜测的城市被丢弃、越界天气调用被拦截，Agent 先追问且没有生成外部来源。\n')

  // 从用户实际的攻略导入流程走到模型候选，连续修改两轮，再由用户审阅并保存最终行程。
  await page.getByRole('button', { name: '旅行信息' }).click()
  const planningBriefDialog = page.getByRole('dialog', { name: '旅行信息' })
  await planningBriefDialog.getByRole('textbox', { name: '目的地', exact: true }).fill('上海')
  await planningBriefDialog.getByRole('textbox', { name: '同行人', exact: true }).fill('2 人')
  await planningBriefDialog.getByRole('textbox', { name: '预算', exact: true }).fill('全程预算上限 5000 元')
  await planningBriefDialog.getByRole('button', { name: '保存旅行信息', exact: true }).click()
  await planningBriefDialog.waitFor({ state: 'detached' })

  const sourcePanel = page.getByRole('complementary', { name: '来源与网页' })
  await sourcePanel.getByRole('button', { name: /^来源/ }).click()
  await sourcePanel.getByRole('button', { name: '粘贴攻略', exact: true }).click()
  const pasteSourceDialog = page.getByRole('dialog', { name: '添加旅行攻略' })
  await pasteSourceDialog.getByRole('textbox', { name: '攻略名称', exact: true }).fill('上海外滩散步攻略')
  await pasteSourceDialog.getByRole('textbox', { name: '原始链接（可选）', exact: true }).fill('https://example.com/shanghai-bund-walk')
  await pasteSourceDialog.getByRole('textbox', { name: '攻略内容', exact: true }).fill('傍晚沿外滩步行，附近可以看陆家嘴天际线。营业和活动信息仍需核验。')
  await pasteSourceDialog.getByRole('button', { name: '保存资料', exact: true }).click()
  await pasteSourceDialog.waitFor({ state: 'detached' })
  await page.getByText('攻略已保存到本机。发送消息后，内容才会提供给模型', { exact: true }).waitFor({ state: 'visible' })
  assert.match(await page.getByLabel('旅行对话输入框').inputValue(), /结合本次旅行信息和刚加入的资料形成一份待审计划/u,
    '首次粘贴攻略后应预填与旅行信息结合的待审计划提示。')
  const importedSourceCard = sourcePanel.locator('.source-card').filter({ hasText: '上海外滩散步攻略' })
  await importedSourceCard.waitFor({ state: 'visible' })
  assert.equal(await sourcePanel.getByText('旅行资料', { exact: true }).count(), 0,
    '来源页签已标明面板用途，不应重复显示次标题。')
  assert.equal(await importedSourceCard.getByText('手动导入', { exact: true }).count(), 1,
    '手动来源仍应通过类型清楚区分。')
  assert.equal(await importedSourceCard.getByText('用户提供', { exact: true }).count(), 0,
    '手动导入类型已说明来源属性，不应再重复显示性质标签。')
  assert.equal(await importedSourceCard.getByText('已获取', { exact: true }).count(), 0,
    '成功状态不需要占用卡片标签。')
  const sourceHeaderAlignment = await sourcePanel.locator('.sources-header').evaluate((element) => getComputedStyle(element).justifyContent)
  assert.equal(sourceHeaderAlignment, 'flex-end', '来源操作应沿面板右侧对齐。')
  const planningSourceId = await page.evaluate(async () => {
    const snapshot = await window.tripwise.getSnapshot()
    const trip = snapshot.trips.find((item) => item.id === snapshot.selectedTripId)
    return trip?.sources.find((source) => source.title === '上海外滩散步攻略')?.id ?? null
  })
  assert.equal(typeof planningSourceId, 'string', '导入的攻略应成为当前旅行中的来源记录。')

  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_budget_itinerary', type: 'function', function: {
      name: 'propose_itineraries',
      arguments: JSON.stringify({ plans: [makeBudgetPlan(planningSourceId)] })
    } }]
  })
  modelProbe.queueResponse({ role: 'assistant', content: '上海一日计划已整理，可在方案中查看并继续修改。' })
  await page.getByLabel('旅行对话输入框').fill('基于我刚导入的攻略，为两人只安排一套上海一日慢行路线，按全程预算上限比较费用。')
  await page.getByLabel('旅行对话输入框').press('Enter')
  try {
    await page.getByRole('heading', { name: '上海慢行一日游', exact: true }).waitFor({ state: 'visible' })
  } catch (error) {
    const diagnostic = await page.evaluate(async () => {
      const snapshot = await window.tripwise.getSnapshot()
      const trip = snapshot.trips.find((item) => item.id === snapshot.selectedTripId)
      return {
        runStatus: trip?.runStatus,
        recentMessages: trip?.messages.slice(-5).map((message) => ({
          role: message.role,
          toolName: message.name,
          hasContent: Boolean(message.content.trim()),
          proposalTitles: message.itineraryOptions?.map((option) => option.title) ?? []
        })),
        candidateTitles: trip?.messages.flatMap((message) => message.role === 'assistant' ? message.itineraryOptions?.map((option) => option.title) ?? [] : [])
      }
    })
    const recentModelRequests = modelProbe.requests.slice(-3).map(({ model, toolNames, toolChoice, authorizationMatchedFixture, bodyContainedCredential }) => ({
      model, toolNames, toolChoice, authorizationMatchedFixture, bodyContainedCredential
    }))
    process.stderr.write(`预算方案候选未出现；脱敏诊断：${JSON.stringify({ diagnostic, recentModelRequests })}\n`)
    throw error
  }
  const candidate = page.locator('.plan-option-card').filter({ has: page.getByRole('heading', { name: '上海慢行一日游', exact: true }) })
  assert.equal(await candidate.locator('.plan-edit-guidance').count(), 0,
    '修改范围由每日、地点和时段菜单表达，不重复显示说明段落。')
  const budgetDisclosure = candidate.locator('.plan-budget-disclosure')
  assert.equal(await budgetDisclosure.evaluate((details) => details.open), false, '预算逐项明细默认收起，不挤占主要行程。')
  assert.match(await budgetDisclosure.locator('summary').innerText(), /¥2050\.00–¥2630\.00/u,
    '收起状态仍应显示预算范围。')
  if (process.env.TRIPWISE_E2E_PLAN_SCREENSHOT) {
    await candidate.screenshot({ path: process.env.TRIPWISE_E2E_PLAN_SCREENSHOT })
  }
  await budgetDisclosure.locator('summary').click()
  await candidate.getByText('完整估算 ¥2050.00–¥2630.00 在全程预算 ¥5000.00内。', { exact: true }).waitFor({ state: 'visible' })
  await page.locator('.agent-progress.agent-progress-completed').last().waitFor({ state: 'visible' })
  assert.equal(modelProbe.requests.length, 17, '结构化方案提交后应把工具回执交给模型，由模型决定结束。')
  assert.ok(modelProbe.requests[15].toolNames.includes('propose_itineraries'), '目的地与旅行来源明确后，模型应获得行程提案工具。')
  assert.equal(modelProbe.requests[15].tripContextMarksBudgetUnknown, false)
  assert.deepEqual(modelProbe.requests[15].userImportedSourceTitles, ['上海外滩散步攻略'], '用户导入的资料应进入真实模型上下文。')
  assert.equal(modelProbe.requests[15].authorizationMatchedFixture, true)
  assert.equal(modelProbe.requests[15].bodyContainedCredential, false)
  assert.equal(await page.locator('.plan-option-card').count(), 1, '默认规划应只显示一份行程草案。')
  await candidate.getByText('待审阅', { exact: true }).waitFor({ state: 'visible' })
  const bundStop = candidate.locator('.plan-option-stop').filter({ hasText: '外滩' })
  await candidate.locator('.plan-day-edit-menu summary').first().getByText('修改当天', { exact: true }).waitFor({ state: 'visible' })
  await candidate.getByRole('group', { name: '修改地点：外滩', exact: true }).getByText('修改', { exact: true }).waitFor({ state: 'visible' })
  await bundStop.locator('.plan-option-stop-time').filter({ hasText: '16:00–16:45' }).waitFor({ state: 'visible' })
  await candidate.getByText('外滩 → 陆家嘴滨江 → 外滩夜景', { exact: true }).waitFor({ state: 'visible' })
  const geographyReview = candidate.locator('.geographic-sequence-review')
  assert.equal(await geographyReview.evaluate((details) => details.open), false, '非阻断的片区顺序说明默认收起。')
  await geographyReview.locator(':scope > summary').click()
  await geographyReview.getByText('外滩 → 陆家嘴 → 外滩', { exact: false }).waitFor({ state: 'visible' })
  await assertAccessible(page, '带片区复核提示的行程草案')
  const firstStopContext = candidate.locator('.plan-stop-context').first()
  assert.equal(await firstStopContext.evaluate((details) => details.open), false, '地点的长说明和来源默认收起，计划仍可快速浏览。')
  await firstStopContext.locator('summary').click()
  await firstStopContext.getByText('依据用户导入攻略安排', { exact: false }).waitFor({ state: 'visible' })
  await firstStopContext.getByRole('button', { name: /上海外滩散步攻略/u }).waitFor({ state: 'visible' })
  await firstStopContext.locator('summary').click()
  const geographyPresentation = await geographyReview.evaluate((section) => {
    const paragraph = section.querySelector('p')
    if (!paragraph) throw new Error('片区复核提示缺少说明文字。')
    const paragraphStyle = getComputedStyle(paragraph)
    const sectionStyle = getComputedStyle(section)
    return {
      foreground: paragraphStyle.color,
      background: sectionStyle.backgroundColor,
      fontSize: paragraphStyle.fontSize,
      clientWidth: section.clientWidth,
      scrollWidth: section.scrollWidth
    }
  })
  const geographyContrast = renderedContrastRatio(
    parseOpaqueRgb(geographyPresentation.foreground),
    parseOpaqueRgb(geographyPresentation.background)
  )
  assert.ok(geographyContrast >= 4.5, `片区复核文字对比度不足 4.5:1：${geographyContrast.toFixed(2)}:1`)
  assert.ok(Number.parseFloat(geographyPresentation.fontSize) >= 12, '片区复核说明文字不应小于 12px。')
  assert.ok(geographyPresentation.scrollWidth <= geographyPresentation.clientWidth + 1, '片区复核卡片不应产生横向溢出。')
  const stopTextStyles = await candidate.locator('.plan-option-stop-title, .plan-option-stop-area, .plan-option-stop-time, .plan-option-schedule-time').evaluateAll((elements) => elements.map((element) => {
    const surface = element.closest('.plan-option-days > div')
    return {
      foreground: getComputedStyle(element).color,
      background: surface ? getComputedStyle(surface).backgroundColor : '',
      fontSize: getComputedStyle(element).fontSize
    }
  }))
  assert.ok(stopTextStyles.length > 0, '草案应显示地点、片区和时段。')
  for (const style of stopTextStyles) {
    const ratio = renderedContrastRatio(parseOpaqueRgb(style.foreground), parseOpaqueRgb(style.background))
    assert.ok(ratio >= 4.5, `地点/片区/时段文字对比度不足 4.5:1：${ratio.toFixed(2)}:1`)
    assert.ok(Number.parseFloat(style.fontSize) >= 12, `地点/片区/时段文字小于 12px：${style.fontSize}`)
  }
  const stopListSurface = await candidate.locator('.plan-option-stop-list').evaluate((list) => {
    const dayCard = list.closest('.plan-option-days > div')
    return {
      foreground: getComputedStyle(list).color,
      background: dayCard ? getComputedStyle(dayCard).backgroundColor : ''
    }
  })
  const stopListContrast = renderedContrastRatio(parseOpaqueRgb(stopListSurface.foreground), parseOpaqueRgb(stopListSurface.background))
  assert.ok(stopListContrast >= 4.5, `日程列表文字对比度不足 4.5:1：${stopListContrast.toFixed(2)}:1`)
  process.stdout.write(`通过：片区说明 ${geographyContrast.toFixed(2)}:1，地点/片区/时段文字均为至少 12px，日程文字 ${stopListContrast.toFixed(2)}:1，卡片无横向溢出。\n`)
  const revisionInput = page.getByLabel('旅行对话输入框')
  const requestCountBeforeLocalEdit = modelProbe.requests.length
  const planStops = candidate.locator('.plan-option-stop')
  await planStops.first().locator('.plan-stop-drag-handle').dragTo(planStops.nth(1), { targetPosition: { x: 8, y: 2 } })
  assert.match(await revisionInput.inputValue(), /只调整第 1 天的地点顺序：将“外滩”移到“陆家嘴滨江”之前/u, '拖动地点应预填明确的同日顺序修改，不直接变更计划。')
  assert.equal(modelProbe.requests.length, requestCountBeforeLocalEdit, '拖动地点只准备修改意见，不应自动发送模型请求。')
  await revisionInput.fill('')
  const dayEditMenu = candidate.locator('.plan-day-edit-menu')
  await dayEditMenu.locator('summary').click()
  await dayEditMenu.getByRole('button', { name: '改日期', exact: true }).click()
  assert.match(await revisionInput.inputValue(), /只调整.*第 1 天.*改到指定日期/u, '改日期入口应保留当天安排并限定目标日期。')
  assert.match(await revisionInput.inputValue(), /重新核对目标日期的开放、预约、天气和交通时段/u, '改日期入口应提示复核受日期影响的事实。')
  assert.equal(modelProbe.requests.length, requestCountBeforeLocalEdit, '改日期入口只预填修改意见，不应自动发送。')
  await revisionInput.fill('')
  await dayEditMenu.getByRole('button', { name: '改主题', exact: true }).click()
  assert.match(await revisionInput.inputValue(), /只调整第 1 天.*只修改当天主题/u, '改主题入口应只修改该日标题范围。')
  assert.equal(modelProbe.requests.length, requestCountBeforeLocalEdit, '改主题入口只预填修改意见，不应自动发送。')
  await revisionInput.fill('')
  await dayEditMenu.getByRole('button', { name: '调整节奏', exact: true }).click()
  assert.match(await revisionInput.inputValue(), /只调整第 1 天.*当天节奏调整为/u, '节奏修改应预填目标日期和修改类型。')
  assert.equal(modelProbe.requests.length, requestCountBeforeLocalEdit, '点击局部修改只预填输入框，不应自动发送请求。')
  await revisionInput.fill('')
  await dayEditMenu.getByRole('button', { name: '增加地点', exact: true }).click()
  assert.match(await revisionInput.inputValue(), /只调整第 1 天.*加入地点/u, '新增地点应保留目标日期范围。')
  assert.equal(modelProbe.requests.length, requestCountBeforeLocalEdit, '新增地点入口不应自动发送请求。')
  await revisionInput.fill('')
  await dayEditMenu.getByRole('button', { name: '指定地点顺序', exact: true }).click()
  assert.match(await revisionInput.inputValue(), /按下面列出的先后顺序安排地点/u, '指定顺序入口应允许用户明确给出地点序列。')
  assert.equal(modelProbe.requests.length, requestCountBeforeLocalEdit, '指定地点顺序入口不应自动发送请求。')
  await revisionInput.fill('')
  const firstStopEditMenu = candidate.locator('.plan-option-stop').first().locator('.plan-stop-edit-menu')
  assert.equal(await firstStopEditMenu.locator('.plan-stop-edit-trigger').innerText(), '修改', '每个地点行只显示一个修改入口。')
  assert.equal(await firstStopEditMenu.getByRole('button', { name: '改时段', exact: true }).isVisible(), false,
    '细项修改默认收起，避免长行程出现密集按钮。')
  const selectStopEdit = async (name) => {
    if (!(await firstStopEditMenu.evaluate((details) => details.open))) {
      await firstStopEditMenu.locator('.plan-stop-edit-trigger').click()
    }
    const action = firstStopEditMenu.getByRole('button', { name, exact: true })
    if (!(await action.isVisible())) {
      const advanced = firstStopEditMenu.locator('.plan-stop-advanced-edit')
      if (!(await advanced.evaluate((details) => details.open))) await advanced.locator('summary').click()
    }
    await action.waitFor({ state: 'visible' })
    return action
  }
  const localEditStyle = await (await selectStopEdit('改时段')).evaluate((button) => ({
    foreground: getComputedStyle(button).color,
    background: getComputedStyle(button).backgroundColor,
    fontSize: getComputedStyle(button).fontSize
  }))
  const localEditContrast = renderedContrastRatio(parseOpaqueRgb(localEditStyle.foreground), parseOpaqueRgb(localEditStyle.background))
  assert.ok(localEditContrast >= 4.5, `单项修改入口对比度不足 4.5:1：${localEditContrast.toFixed(2)}:1`)
  assert.ok(Number.parseFloat(localEditStyle.fontSize) >= 12, '单项修改入口文字不应小于 12px。')
  await (await selectStopEdit('改名称')).click()
  assert.match(await revisionInput.inputValue(), /只修改第 1 天“外滩”在行程中的名称/u, '改名入口应限定日期和目标地点。')
  assert.equal(modelProbe.requests.length, requestCountBeforeLocalEdit, '改名入口只预填修改意见，不应自动发送。')
  await revisionInput.fill('')
  await (await selectStopEdit('改时段')).click()
  assert.match(await revisionInput.inputValue(), /只调整第 1 天的“外滩”时段/u, '按地点修改应预填地点、日期和修改字段。')
  assert.equal(modelProbe.requests.length, requestCountBeforeLocalEdit, '按地点选择修改粒度不应直接提交。')
  await revisionInput.fill('')
  await (await selectStopEdit('改停留时长')).click()
  assert.match(await revisionInput.inputValue(), /只调整第 1 天“外滩”的建议停留时长/u, '停留时长修改应只指向目标地点的一个字段。')
  await revisionInput.fill('')
  await (await selectStopEdit('改片区')).click()
  assert.match(await revisionInput.inputValue(), /只调整第 1 天“外滩”的所属片区/u, '片区修改不应误触发地点替换。')
  await revisionInput.fill('')
  await (await selectStopEdit('在前面加地点')).click()
  assert.match(await revisionInput.inputValue(), /在第 1 天“外滩”之前加入一个地点/u, '前置地点入口应锚定当前地点。')
  await revisionInput.fill('')
  await (await selectStopEdit('在后面加地点')).click()
  assert.match(await revisionInput.inputValue(), /在第 1 天“外滩”之后加入一个地点/u, '追加地点入口应锚定目标地点。')
  assert.equal(modelProbe.requests.length, requestCountBeforeLocalEdit, '追加地点入口不应自动提交修改。')
  await revisionInput.fill('')
  await (await selectStopEdit('调整位置')).click()
  assert.match(await revisionInput.inputValue(), /只调整第 1 天“外滩”在行程中的位置/u, '移动地点入口应明确不新增或删除地点。')
  await revisionInput.fill('')
  await (await selectStopEdit('移到另一天')).click()
  assert.match(await revisionInput.inputValue(), /只把第 1 天“外滩”移到指定日期.*受影响两天/u, '跨日移动入口应明确两个受影响日期和复核范围。')
  assert.equal(modelProbe.requests.length, requestCountBeforeLocalEdit, '跨日移动只预填修改意见，不应自动发送。')
  await revisionInput.fill('')
  await (await selectStopEdit('改接驳')).click()
  assert.match(await revisionInput.inputValue(), /只调整第 1 天从“外滩”到“陆家嘴滨江”的接驳/u, '接驳修改应锚定相邻路段。')
  assert.equal(modelProbe.requests.length, requestCountBeforeLocalEdit, '接驳修改入口不应自动提交。')
  await revisionInput.fill('')
  await (await selectStopEdit('核对预约与门票')).click()
  assert.match(await revisionInput.inputValue(), /只核对第 1 天“外滩”的预约、开放和门票信息/u, '预约入口应只指向目标地点的事实。')
  await revisionInput.fill('')
  await candidate.locator('.plan-option-stop').first().getByRole('button', { name: '改这段', exact: true }).click()
  assert.match(await revisionInput.inputValue(), /只调整第 1 天从“外滩”到“陆家嘴滨江”的接驳/u, '交通行应能就地发起路段修改。')
  await revisionInput.fill('')
  const mealEditMenu = candidate.locator('.plan-option-schedule-item').locator('.plan-block-edit-menu')
  assert.equal(await mealEditMenu.locator(':scope > summary').innerText(), '修改时段', '餐休块提供独立的修改入口。')
  await mealEditMenu.locator(':scope > summary').click()
  await mealEditMenu.locator('.plan-stop-advanced-edit > summary').click()
  await mealEditMenu.getByRole('button', { name: '改说明', exact: true }).click()
  assert.match(await revisionInput.inputValue(), /只修改第 1 天的“午餐”时段的说明/u, '餐休块的说明修改应只指向该字段。')
  assert.equal(modelProbe.requests.length, requestCountBeforeLocalEdit, '餐休块的快捷编辑只预填，不自动发送。')
  await revisionInput.fill('')
  await mealEditMenu.locator(':scope > summary').click()
  await mealEditMenu.getByRole('button', { name: '选具体餐馆', exact: true }).click()
  assert.match(await revisionInput.inputValue(), /只为第 1 天的“午餐”时段选择具体餐馆.*不重复保留同一餐的时间块/u,
    '用餐块可替换为有地点的餐馆安排。')
  assert.equal(modelProbe.requests.length, requestCountBeforeLocalEdit, '选餐馆只预填，不自动发送。')
  await revisionInput.fill('')
  const requestCountBeforeGeographicRevision = modelProbe.requests.length
  await geographyReview.getByRole('button', { name: '按片区调整这一天', exact: true }).click()
  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_itinerary_revision', type: 'function', function: {
      name: 'propose_itineraries',
      arguments: JSON.stringify({ plans: [{
        ...makeBudgetPlan(planningSourceId),
        title: '上海轻松修订',
        summary: '缩短外滩停留，保留预算估算。',
        days: [{
          ...makeBudgetPlan(planningSourceId).days[0],
          stops: [{ ...makeBudgetPlan(planningSourceId).days[0].stops[0], time: '17:00–18:00' }]
        }]
      }] })
    } }]
  })
  modelProbe.queueResponse({ role: 'assistant', content: '上海路线修订已整理，可审阅。' })
  assert.equal(await revisionInput.evaluate((element) => document.activeElement === element), true, '继续修改应将焦点移到聊天输入框。')
  const geographicSuggestion = await revisionInput.inputValue()
  assert.match(geographicSuggestion, /请复核第 1 天的片区顺序“外滩 → 陆家嘴 → 外滩”/u, '片区提醒应预填可编辑的单日调整要求。')
  assert.equal(modelProbe.requests.length, requestCountBeforeGeographicRevision, '点击片区调整只预填输入框，不应自动发送请求。')
  const revisionNote = page.locator('.revision-composer-note')
  await revisionNote.waitFor({ state: 'visible' })
  assert.match(await revisionNote.innerText(), /继续修改：上海慢行一日游/u)
  await revisionInput.fill(`${geographicSuggestion}\n把外滩停留缩短到一小时，保留预算估算。本轮不搜索。`)
  await revisionInput.press('Enter')
  const revisedCandidate = page.locator('.plan-option-card').filter({ has: page.getByRole('heading', { name: '上海轻松修订', exact: true }) })
  try {
    await revisedCandidate.getByText('第 1 轮修改', { exact: true }).waitFor({ state: 'visible' })
  } catch (error) {
    const diagnostic = await page.evaluate(async () => {
      const snapshot = await window.tripwise.getSnapshot()
      const trip = snapshot.trips.find((item) => item.id === snapshot.selectedTripId)
      return {
        runStatus: trip?.runStatus,
        recentMessages: trip?.messages.slice(-6).map((message) => ({
          role: message.role,
          toolName: message.name,
          hasContent: Boolean(message.content.trim()),
          proposalTitles: message.itineraryOptions?.map((option) => option.title) ?? []
        }))
      }
    })
    const recentRequests = modelProbe.requests.slice(-4).map(({ toolNames, toolChoice, bodyContainedCredential }) => ({ toolNames, toolChoice, bodyContainedCredential }))
    process.stderr.write(`连续修改草案未出现；脱敏诊断：${JSON.stringify({ diagnostic, recentRequests })}\n`)
    throw error
  }
  await candidate.getByText('已有新草案', { exact: true }).waitFor({ state: 'visible' })
  await revisedCandidate.getByText('待审阅', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(await revisedCandidate.evaluate((card) => {
    const diff = card.querySelector('.plan-change-preview')
    const days = card.querySelector('.plan-option-days')
    return !!diff && !!days && !!(diff.compareDocumentPosition(days) & Node.DOCUMENT_POSITION_FOLLOWING)
  }), true, '修订差异应紧跟摘要，并出现在逐日计划之前。')
  assert.equal(await candidate.getByRole('button', { name: '确认并保存', exact: true }).isEnabled(), false,
    '生成更新草案后，旧方案不得再保存为当前版本。')
  assert.equal(await page.locator('.plan-option-card').count(), 2, '修改后应保留首稿并新增一份修订稿。')

  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_itinerary_second_revision', type: 'function', function: {
      name: 'propose_itineraries',
      arguments: JSON.stringify({ plans: [{
        ...makeBudgetPlan(planningSourceId),
        title: '上海沿江慢行修订',
        summary: '在上一轮基础上再减少停留点，继续保留预算估算。',
        days: [{
          ...makeBudgetPlan(planningSourceId).days[0],
          stops: [{ ...makeBudgetPlan(planningSourceId).days[0].stops[0], time: '17:30–18:30' }]
        }]
      }] })
    } }]
  })
  modelProbe.queueResponse({ role: 'assistant', content: '第二轮修订已整理，可审阅。' })
  await revisedCandidate.getByRole('button', { name: '继续修改', exact: true }).click()
  assert.match(await revisionNote.innerText(), /继续修改：上海轻松修订/u, '第二轮修改入口应指向最新草案。')
  await revisionInput.fill('再删掉一处可选停留，保留预算。本轮不搜索。')
  await revisionInput.press('Enter')
  const secondRevisedCandidate = page.locator('.plan-option-card').filter({
    has: page.getByRole('heading', { name: '上海沿江慢行修订', exact: true })
  })
  try {
    await secondRevisedCandidate.getByText('第 2 轮修改', { exact: true }).waitFor({ state: 'visible' })
  } catch (error) {
    const diagnostic = await page.evaluate(async () => {
      const snapshot = await window.tripwise.getSnapshot()
      const trip = snapshot.trips.find((item) => item.id === snapshot.selectedTripId)
      return {
        runStatus: trip?.runStatus,
        recentMessages: trip?.messages.slice(-6).map((message) => ({
          role: message.role,
          toolName: message.name,
          hasContent: Boolean(message.content.trim()),
          proposalTitles: message.itineraryOptions?.map((option) => option.title) ?? []
        }))
      }
    })
    const latestRequest = modelProbe.requests.at(-1)
    process.stderr.write(`第二轮连续修改草案未出现；脱敏诊断：${JSON.stringify({ diagnostic, latestRequest: {
      userPrompt: latestRequest?.userPrompt,
      latestDraftTitle: latestRequest?.latestDraftTitle,
      latestDraftStopTimes: latestRequest?.latestDraftStopTimes,
      bodyContainedCredential: latestRequest?.bodyContainedCredential
    } })}\n`)
    throw error
  }
  assert.equal(modelProbe.requests.at(-1)?.latestDraftTitle, '上海轻松修订', '第二轮模型上下文必须以第一轮修订稿为基线。')
  assert.ok(modelProbe.requests.at(-1)?.latestDraftStopTimes.includes('17:00–18:00'), '第二轮上下文应带入第一轮修改后的时段。')
  assert.equal(modelProbe.requests.at(-1)?.bodyContainedCredential, false, '多轮修订上下文不得包含模型凭证。')
  await candidate.getByText('已有新草案', { exact: true }).waitFor({ state: 'visible' })
  await revisedCandidate.getByText('已有新草案', { exact: true }).waitFor({ state: 'visible' })
  await secondRevisedCandidate.getByText('待审阅', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(await page.locator('.plan-option-card').count(), 3, '连续两轮修改应保留首稿和前一轮，并只新增当前草案。')

  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_itinerary_third_revision', type: 'function', function: {
      name: 'propose_itineraries',
      arguments: JSON.stringify({ plans: (() => {
        const base = makeBudgetPlan(planningSourceId)
        const day = base.days[0]
        return [{
          ...base,
          title: '上海午餐说明修订',
          summary: '补充午餐安排说明，保留前两轮路线与预算。',
          days: [{
            ...day,
            stops: [{ ...day.stops[0], time: '17:30–18:30' }],
            schedule_blocks: day.schedule_blocks.map((block) => ({ ...block, notes: '简餐后步行前往地铁站；餐馆尚待选择。' }))
          }]
        }]
      })() })
    } }]
  })
  modelProbe.queueResponse({ role: 'assistant', content: '午餐说明已更新，可审阅。' })
  await secondRevisedCandidate.getByRole('button', { name: '继续修改', exact: true }).click()
  assert.match(await revisionNote.innerText(), /继续修改：上海沿江慢行修订/u, '第三轮修改入口应指向第二轮草案。')
  const requestCountBeforeMealRevision = modelProbe.requests.length
  const latestMealEditMenu = secondRevisedCandidate.locator('.plan-option-schedule-item').locator('.plan-block-edit-menu')
  await latestMealEditMenu.locator(':scope > summary').click()
  await latestMealEditMenu.locator('.plan-stop-advanced-edit > summary').click()
  await latestMealEditMenu.getByRole('button', { name: '改说明', exact: true }).click()
  assert.match(await revisionInput.inputValue(), /只修改第 1 天的“午餐”时段的说明/u, '餐休块快捷修改应填入确切日期、对象和字段。')
  assert.equal(modelProbe.requests.length, requestCountBeforeMealRevision, '餐休块快捷修改不能自动发送模型请求。')
  const mealNotes = secondRevisedCandidate.locator('.plan-schedule-notes').filter({ hasText: '餐馆待选' })
  assert.equal(await mealNotes.locator('p').isVisible(), false, '餐休备注默认收起，减少计划卡正文噪音。')
  await mealNotes.locator('summary').click()
  await mealNotes.locator('p').waitFor({ state: 'visible' })
  assert.match(await mealNotes.locator('p').innerText(), /餐馆待选/u, '展开后应能查看餐休备注。')
  await mealNotes.locator('summary').click()
  await revisionInput.fill(`${await revisionInput.inputValue()}简餐后步行前往地铁站；餐馆尚待选择。本轮不搜索。`)
  await revisionInput.press('Enter')
  const thirdRevisedCandidate = page.locator('.plan-option-card').filter({
    has: page.getByRole('heading', { name: '上海午餐说明修订', exact: true })
  })
  try {
    await thirdRevisedCandidate.getByText('第 3 轮修改', { exact: true }).waitFor({ state: 'visible' })
  } catch (error) {
    const diagnostic = await page.evaluate(async () => {
      const snapshot = await window.tripwise.getSnapshot()
      const trip = snapshot.trips.find((item) => item.id === snapshot.selectedTripId)
      return {
        runStatus: trip?.runStatus,
        recentMessages: trip?.messages.slice(-6).map((message) => ({
          role: message.role,
          toolName: message.name,
          hasContent: Boolean(message.content.trim()),
          proposalTitles: message.itineraryOptions?.map((option) => option.title) ?? []
        }))
      }
    })
    const latestRequest = modelProbe.requests.at(-1)
    process.stderr.write(`第三轮连续修改草案未出现；脱敏诊断：${JSON.stringify({ diagnostic, latestRequest: {
      userPrompt: latestRequest?.userPrompt,
      latestDraftTitle: latestRequest?.latestDraftTitle,
      latestDraftStopTimes: latestRequest?.latestDraftStopTimes,
      bodyContainedCredential: latestRequest?.bodyContainedCredential
    } })}\n`)
    throw error
  }
  assert.equal(modelProbe.requests.at(-1)?.latestDraftTitle, '上海沿江慢行修订', '第三轮模型上下文必须以第二轮修订稿为基线。')
  assert.ok(modelProbe.requests.at(-1)?.latestDraftStopTimes.includes('17:30–18:30'), '第三轮上下文应保留第二轮调整的景点时段。')
  assert.ok(modelProbe.requests.at(-1)?.userPrompts?.some((prompt) =>
    /只修改第 1 天的“午餐”时段的说明/u.test(prompt)
  ), 'Agent 应收到单字段修改的范围提示。')
  await candidate.getByText('已有新草案', { exact: true }).waitFor({ state: 'visible' })
  await revisedCandidate.getByText('已有新草案', { exact: true }).waitFor({ state: 'visible' })
  await secondRevisedCandidate.getByText('已有新草案', { exact: true }).waitFor({ state: 'visible' })
  await thirdRevisedCandidate.getByText('待审阅', { exact: true }).waitFor({ state: 'visible' })
  const revisedMealNotes = thirdRevisedCandidate.locator('.plan-schedule-notes').filter({ hasText: '餐馆尚待选择' })
  assert.equal(await revisedMealNotes.locator('p').isVisible(), false, '修订后的餐休说明仍默认收起。')
  await revisedMealNotes.locator('summary').click()
  await revisedMealNotes.getByText('简餐后步行前往地铁站；餐馆尚待选择。', { exact: true }).waitFor({ state: 'visible' })
  const revisedBundStop = thirdRevisedCandidate.locator('.plan-option-stop').filter({ hasText: '外滩' })
  await revisedBundStop.locator('.plan-option-stop-time').filter({ hasText: '17:30–18:30' }).waitFor({ state: 'visible' })
  assert.equal(await page.locator('.plan-option-card').count(), 4, '连续三轮修改应保留前三份草案，并显示最新草案。')

  await thirdRevisedCandidate.getByRole('button', { name: '确认并保存', exact: true }).click()
  const confirmedBudgetCard = page.locator('.itinerary-view .itinerary-budget-card[aria-label="预算估算"]')
  await confirmedBudgetCard.getByText('完整估算 ¥2050.00–¥2630.00 在全程预算 ¥5000.00内。', { exact: true }).waitFor({ state: 'visible' })
  const savedPlanningState = await page.evaluate(async () => {
    const snapshot = await window.tripwise.getSnapshot()
    const trip = snapshot.trips.find((item) => item.id === snapshot.selectedTripId)
    const revision = trip?.revisions.find((item) => item.id === trip.activeRevisionId)
    return {
      briefBudget: trip?.brief.budget,
      travelers: trip?.brief.travelers,
      sourceTitle: trip?.sources.find((source) => source.title === '上海外滩散步攻略')?.title,
      itineraryTitle: revision?.itinerary?.title,
      mealNotes: revision?.itinerary?.days[0]?.scheduleBlocks[0]?.notes,
      revisionCount: trip?.revisions.length,
      budgetCategoryCount: revision?.itinerary?.budgetEstimate?.items.length
    }
  })
  assert.deepEqual(savedPlanningState, {
    briefBudget: '全程预算上限 5000 元',
    travelers: '2 人',
    sourceTitle: '上海外滩散步攻略',
    itineraryTitle: '上海午餐说明修订',
    mealNotes: '简餐后步行前往地铁站；餐馆尚待选择。',
    revisionCount: 1,
    budgetCategoryCount: 6
  }, '连续三轮修改后，只有用户最终确认的草案应连同字段级餐休调整、预算估算和来源持久化。')
  process.stdout.write('通过：用户导入攻略后生成单份方案；连续三轮修改均基于最新草案，第三轮只改餐休说明并保存最终版本。\n')

  await page.getByRole('button', { name: '新建旅行', exact: true }).click()
  const repeatedReviewCreateDialog = page.getByRole('dialog', { name: '新建旅行' })
  await repeatedReviewCreateDialog.getByRole('textbox', { name: '目的地', exact: true }).fill('杭州')
  await repeatedReviewCreateDialog.getByRole('textbox', { name: '出发日期', exact: true }).fill('2026-09-22')
  await repeatedReviewCreateDialog.getByRole('textbox', { name: '返程日期', exact: true }).fill('2026-09-23')
  await repeatedReviewCreateDialog.getByRole('button', { name: '创建旅行', exact: true }).click()
  await page.getByRole('heading', { name: '杭州', exact: true }).waitFor({ state: 'visible' })
  const repeatedReviewTripId = await page.evaluate(async () => (await window.tripwise.getSnapshot()).selectedTripId)
  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_repeated_landmark', type: 'function', function: {
      name: 'propose_itineraries',
      arguments: JSON.stringify({ plans: [{
        title: '跨日重复地点回归计划', summary: '用于检查跨日地点提示。', tradeoffs: '测试行程，不代表真实推荐。',
        days: [
          { day_number: 1, date: '2026-09-22', title: '第一天', schedule_blocks: [], stops: [
            { name: '测试博物馆', area: '西湖片区', time: '09:00—11:00', duration_minutes: 120, category: '景点', notes: '', transit_to_next: '' }
          ] },
          { day_number: 2, date: '2026-09-23', title: '第二天', schedule_blocks: [], stops: [
            { name: '测试 博物馆', area: '西湖片区', time: '10:00—12:00', duration_minutes: 120, category: '景点', notes: '', transit_to_next: '' }
          ] }
        ]
      }] })
    } }]
  })
  // 计划工具回执后模型还需终答；显式排队，避免落入 mock 的默认简报响应。
  modelProbe.queueResponse({ role: 'assistant', content: '杭州行程已整理，可核对跨日重复地点提示。' })
  const repeatedReviewInput = page.getByLabel('旅行对话输入框')
  await repeatedReviewInput.fill('按已确认日期整理两天杭州行程，本轮不搜索。')
  await repeatedReviewInput.press('Enter')
  const repeatedReviewCard = page.locator('.plan-option-card').filter({
    has: page.getByRole('heading', { name: '跨日重复地点回归计划', exact: true })
  })
  await repeatedReviewCard.waitFor({ state: 'visible' })
  const dayDisclosures = repeatedReviewCard.locator('.plan-day-disclosure')
  assert.equal(await dayDisclosures.count(), 2, '多日计划应逐日折叠展示。')
  assert.equal(await dayDisclosures.nth(0).evaluate((details) => details.open), true, '首日默认展开，便于立即审阅计划内容。')
  assert.equal(await dayDisclosures.nth(1).evaluate((details) => details.open), false, '其余日期默认收起，避免长行程一次铺满页面。')
  const secondDaySummary = dayDisclosures.nth(1).locator('.plan-day-disclosure-summary')
  await secondDaySummary.focus()
  await page.keyboard.press('Enter')
  assert.equal(await dayDisclosures.nth(1).evaluate((details) => details.open), true, '键盘 Enter 应展开选定日期。')
  await page.keyboard.press('Space')
  assert.equal(await dayDisclosures.nth(1).evaluate((details) => details.open), false, '键盘 Space 应收起选定日期。')
  await secondDaySummary.click()
  await dayDisclosures.nth(1).locator('.plan-option-stop-title').waitFor({ state: 'visible' })
  const repeatedLandmarkReview = repeatedReviewCard.locator('.repeated-landmark-review')
  await repeatedLandmarkReview.getByRole('button', { name: '核对重复地点', exact: true }).waitFor({ state: 'visible' })
  await assertAccessible(page, '跨日重复景点提示')
  const duplicatePresentation = await repeatedLandmarkReview.evaluate((section) => {
    const text = section.querySelector('p')
    if (!text) throw new Error('重复景点提示缺少说明文字。')
    return {
      foreground: getComputedStyle(text).color,
      background: getComputedStyle(section).backgroundColor,
      fontSize: getComputedStyle(text).fontSize,
      clientWidth: section.clientWidth,
      scrollWidth: section.scrollWidth
    }
  })
  const duplicateContrast = renderedContrastRatio(
    parseOpaqueRgb(duplicatePresentation.foreground), parseOpaqueRgb(duplicatePresentation.background)
  )
  assert.ok(duplicateContrast >= 4.5, `重复景点提示对比度不足 4.5:1：${duplicateContrast.toFixed(2)}:1`)
  assert.ok(Number.parseFloat(duplicatePresentation.fontSize) >= 12, '重复景点说明文字不应小于 12px。')
  assert.ok(duplicatePresentation.scrollWidth <= duplicatePresentation.clientWidth + 1, '重复景点提示不应产生横向溢出。')
  assert.match(await repeatedLandmarkReview.innerText(), /测试博物馆[\s\S]*第 1 天（2026-09-22）[\s\S]*第 2 天（2026-09-23）/u)
  const requestsBeforeRepeatedReview = modelProbe.requests.length
  await repeatedLandmarkReview.getByRole('button', { name: '核对重复地点', exact: true }).click()
  const repeatedSuggestion = await repeatedReviewInput.inputValue()
  assert.match(repeatedSuggestion, /测试博物馆（第 1 天（2026-09-22）、第 2 天（2026-09-23））/u)
  assert.match(repeatedSuggestion, /若是不同展览、分馆或有意重访，请保留/u)
  assert.equal(modelProbe.requests.length, requestsBeforeRepeatedReview, '重复地点入口只预填修改意见，不自动发送请求。')
  await navigation.getByRole('button', { name: '删除杭州', exact: true }).click()
  const repeatedReviewDeleteDialog = page.getByRole('dialog', { name: '删除“杭州”' })
  await repeatedReviewDeleteDialog.getByRole('button', { name: '删除旅行资料', exact: true }).click()
  await page.waitForFunction(async (tripId) => {
    const snapshot = await window.tripwise.getSnapshot()
    return !snapshot.trips.some((trip) => trip.id === tripId)
  }, repeatedReviewTripId, { timeout: 5_000 })
  const repeatedReviewCleanup = await page.evaluate(async () => {
    const snapshot = await window.tripwise.getSnapshot()
    return {
      selectedTripId: snapshot.selectedTripId,
      trips: snapshot.trips.map((trip) => ({ id: trip.id, title: trip.title }))
    }
  })
  assert.ok(!repeatedReviewCleanup.trips.some((trip) => trip.id === repeatedReviewTripId),
    `跨日重复回归用的临时旅行应在验证后删除（目标：${repeatedReviewTripId}；剩余：${JSON.stringify(repeatedReviewCleanup)}）。`)
  await navigation.getByRole('button', { name: /^打开旅行：上海，日期待定/ }).first().click()
  await page.getByRole('heading', { name: '上海午餐说明修订', exact: true }).waitFor({ state: 'visible' })
  process.stdout.write(`通过：跨日重名景点显示具体日期，提示对比度 ${duplicateContrast.toFixed(2)}:1、文字至少 12px、无横向溢出；修改入口只预填不发送。\n`)

  await page.getByRole('button', { name: '旅行信息' }).click()
  const restoreUnknownBudgetDialog = page.getByRole('dialog', { name: '旅行信息' })
  await restoreUnknownBudgetDialog.locator('.brief-unknown-disclosure > summary').click()
  await restoreUnknownBudgetDialog.getByRole('checkbox', { name: '预算', exact: true }).check()
  await restoreUnknownBudgetDialog.getByRole('button', { name: '保存旅行信息', exact: true }).click()
  await restoreUnknownBudgetDialog.waitFor({ state: 'detached' })
  const restoredUnknownBudget = await page.evaluate(async () => {
    const snapshot = await window.tripwise.getSnapshot()
    const trip = snapshot.trips.find((item) => item.id === snapshot.selectedTripId)
    return { budget: trip?.brief.budget, unknownFields: trip?.briefUnknownFields }
  })
  assert.deepEqual(restoredUnknownBudget, { budget: '', unknownFields: ['budget'] }, '后续保存预算方案不得破坏显式未知状态的恢复用例。')

  await page.getByRole('button', { name: '规划', exact: true }).click()
  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_browser_interact_navigate', type: 'function', function: {
      name: 'research_browser_navigate', arguments: '{"url":"http://tripwise-egress-test.invalid/agent-browser-interact"}'
    } }]
  })
  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_browser_expand', type: 'function', function: {
      name: 'research_browser_interact', arguments: '{"target_id":"e1"}'
    } }]
  })
  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_browser_search', type: 'function', function: {
      name: 'research_browser_interact', arguments: '{"target_id":"s1","query":"故宫交通"}'
    } }]
  })
  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_browser_stale_target', type: 'function', function: {
      name: 'research_browser_interact', arguments: '{"target_id":"e999"}'
    } }]
  })
  modelProbe.queueResponse({
    role: 'assistant',
    tool_calls: [{ id: 'call_e2e_browser_scroll', type: 'function', function: {
      name: 'research_browser_scroll', arguments: '{"direction":"down","pages":1}'
    } }]
  })
  // 留出时间核验已完成的滚动光标；完成后进度区会卸载。
  modelProbe.queueResponse({ role: 'assistant', content: '我读取了公开攻略展开内容、站内搜索与后续页面，并会继续核对官方信息。' }, 8_000)
  await page.evaluate(() => {
    window.__tripwiseBrowserActivityTrace = []
    window.__tripwiseAgentActivityTrace = []
    const recordActivity = () => {
      const label = document.querySelector('.browser-activity')?.textContent?.trim()
      if (label) window.__tripwiseBrowserActivityTrace.push(label)
      const activities = [...document.querySelectorAll('.agent-activity')]
        .map((activity) => activity.textContent?.trim() ?? '').filter(Boolean)
      if (activities.length) window.__tripwiseAgentActivityTrace.push(activities)
    }
    new MutationObserver(recordActivity).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
  await page.getByLabel('旅行对话输入框').fill('请展开攻略全文，再用网页的站内搜索查找故宫交通。')
  await page.getByRole('button', { name: '发送消息' }).click()
  await page.getByText('Agent 正在浏览', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 })
  const concurrentAttempt = await page.evaluate(async () => {
    const snapshot = await window.tripwise.getSnapshot()
    const trip = snapshot.trips.find((item) => item.id === snapshot.selectedTripId)
    if (!trip) throw new Error('并发请求测试找不到当前旅行。')
    try {
      await window.tripwise.sendMessage('e2e-concurrent-agent-run', trip.id, trip.activeConversationId, '不要启动第二轮规划。')
      return { rejected: false, message: '' }
    } catch (error) {
      return { rejected: true, message: error instanceof Error ? error.message : String(error) }
    }
  })
  assert.equal(concurrentAttempt.rejected, true, '主进程必须拒绝并发 Agent 运行，避免两个话题争用同一研究网页。')
  assert.match(concurrentAttempt.message, /已有一轮规划正在运行/u, '并发拒绝应说明当前有一轮规划运行。')
  await page.locator('.browser-activity').getByText('正在展开页面内容', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
  const recentActivities = page.locator('.agent-activity-list')
  await recentActivities.getByText('展开并读取网页内容', { exact: true }).waitFor({ state: 'visible' })
  await recentActivities.getByText('搜索并读取当前网页', { exact: true }).waitFor({ state: 'visible' })
  const activityHistory = page.locator('.agent-activity-history')
  await activityHistory.locator('summary').click()
  await activityHistory.getByText('展开并读取网页内容', { exact: true }).first().waitFor({ state: 'visible' })
  await activityHistory.getByText('搜索并读取当前网页', { exact: true }).first().waitFor({ state: 'visible' })
  try {
    await page.waitForFunction(() => {
      const trace = window.__tripwiseAgentActivityTrace ?? []
      return trace.some((items) => items.some((item) => item.includes('展开并读取网页内容') && item.includes('内容已展开并读取'))) &&
        trace.some((items) => items.some((item) => item.includes('搜索并读取当前网页') && item.includes('搜索结果已打开并读取')))
    }, undefined, { timeout: 10_000 })
  assert.deepEqual(researchProxyProbe.pointerPhasesAtClick, [{ phase: 'pressing', aligned: true }],
    '展开控件应在指针已对齐并显示按下反馈时触发。')
  } catch (error) {
    process.stderr.write(`Agent 浏览动作记录：${await page.locator('.agent-progress').innerText().catch(() => '进度面板已关闭')}\n`)
    process.stderr.write(`末轮模型请求：${JSON.stringify(modelProbe.requests.slice(-8).map(({ userPrompt, priorToolCalls, queuedResponseToolCalls, toolOutputContainsExpandedBrowserText, toolOutputContainsBrowserSearchResult }) => ({ userPrompt, priorToolCalls, queuedResponseToolCalls, toolOutputContainsExpandedBrowserText, toolOutputContainsBrowserSearchResult })))}\n`)
    throw error
  }
  const staleBrowserActivity = page.locator('.agent-activity-list .agent-activity').filter({ hasText: '目标失效，请重新读取网页' })
  await staleBrowserActivity.getByText('目标失效，请重新读取网页', { exact: true }).waitFor({ state: 'visible' })
  assert.match(await staleBrowserActivity.getAttribute('class') ?? '', /activity-failed/u, '失效交互目标应显示失败状态，不标为完成。')
  const browserActivityLabels = await page.locator('.agent-activity-label').allInnerTexts()
  assert.ok(browserActivityLabels.every((label) => !label.includes('故宫交通')), '网页搜索查询词不得进入工具进度标签。')
  await page.locator('.browser-state-label').filter({ hasText: 'Tripwise Browser Search Results' }).waitFor({ state: 'visible', timeout: 10_000 })
  const scrollCursor = await waitForBrowserScrollCursor(application)
  assert.ok(scrollCursor.scrollY > 0, '网页内可视指针应保留滚动完成态，并确认页面已滚动后再读取。')
  // 外层 renderer 截图不包含独立的 WebContentsView；直接检查其稳定完成态画面。
  const browserScreenshot = await captureResearchBrowserScreenshot(application, 'scrolled')
  const cursorPixels = await countVisibleBrowserCursorPixels(page, browserScreenshot.dataUrl)
  assert.ok(cursorPixels.visibleCursorPixels >= 30,
    `内置网页截图应包含可见指针图形，实际品牌绿像素：${cursorPixels.visibleCursorPixels}。`)
  assert.ok(cursorPixels.right < cursorPixels.width - 8,
    `指针与阶段提示应完整留在网页视口内，最右像素：${cursorPixels.right}/${cursorPixels.width}。`)
  if (process.env.TRIPWISE_E2E_BROWSER_ACTIVITY_SCREENSHOT) {
    await writeFile(process.env.TRIPWISE_E2E_BROWSER_ACTIVITY_SCREENSHOT, Buffer.from(browserScreenshot.base64, 'base64'))
  }
  process.stdout.write(`通过：内置网页滚动完成态截图检测到 ${cursorPixels.visibleCursorPixels} 个指针像素，提示未被视口裁切。\n`)
  await page.locator('.assistant-message').getByText('我读取了公开攻略展开内容、站内搜索与后续页面，并会继续核对官方信息。', { exact: true }).waitFor({ state: 'visible' })
  await page.getByText('Agent 正在浏览', { exact: true }).waitFor({ state: 'detached' })
  const browserActivityTrace = await page.evaluate(() => window.__tripwiseBrowserActivityTrace ?? [])
  assert.ok(browserActivityTrace.some((label) => label.includes('正在打开网页')), '网页栏应展示当前导航动作。')
  assert.ok(browserActivityTrace.some((label) => label.includes('正在读取页面')), '网页栏应展示页面读取动作。')
  assert.ok(browserActivityTrace.some((label) => label.includes('正在搜索当前网页')), '网页栏应展示页面内搜索动作。')
  assert.ok(browserActivityTrace.some((label) => label.includes('正在向下滚动 1 屏')), '网页栏应展示页面内滚动动作。')
  for (const phase of ['定位目标', '移动光标', '点击中', '已点击', '滚动页面', '滚动完成']) {
    assert.ok(browserActivityTrace.some((label) => label.includes(phase)), `网页栏应展示浏览器自动化阶段：${phase}。`)
  }
  assert.ok(browserActivityTrace.every((label) => !label.includes('故宫交通')), '网页栏动作提示不得暴露搜索词。')
  const agentActivityTrace = await page.evaluate(() => window.__tripwiseAgentActivityTrace ?? [])
  assert.ok(agentActivityTrace.some((items) => items.some((item) => item.includes('展开并读取网页内容') && item.includes('内容已展开并读取'))),
    '中央进度区应在工具结果后显示页面展开结果。')
  assert.ok(agentActivityTrace.some((items) => items.some((item) => item.includes('搜索并读取当前网页') && item.includes('搜索结果已打开并读取'))),
    '中央进度区应在工具结果后显示搜索读取结果。')
  assert.equal(await readBrowserCursor(application), null,
    'Agent 结束后不应残留页面指针标记。')
  const browserBack = page.getByRole('button', { name: '返回上一页', exact: true })
  const browserForward = page.getByRole('button', { name: '前进到下一页', exact: true })
  const browserReload = page.getByRole('button', { name: '刷新网页', exact: true })
  const browserSearchTitle = await page.locator('.browser-state-label').innerText()
  assert.ok(
    !researchProxyProbe.requests.some((request) => request.method !== 'GET' && request.url.includes('/agent-browser-mutation')),
    'Agent 控制网页期间，页面脚本发起的非 GET/HEAD 请求不得到达网页出口。'
  )
  assert.equal(await browserBack.isEnabled(), true, '网页有历史记录时应能后退。')
  await browserBack.click()
  await page.waitForFunction((previousTitle) => {
    const label = document.querySelector('.browser-state-label')
    return !!label && label.textContent !== previousTitle
  }, browserSearchTitle)
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="前进到下一页"]')
    return button instanceof HTMLButtonElement && !button.disabled
  })
  assert.equal(await browserForward.isEnabled(), true, '后退后应能前进。')
  await browserForward.click()
  await page.locator('.browser-state-label').getByText(browserSearchTitle, { exact: true }).waitFor({ state: 'visible' })
  await browserReload.click()
  await page.locator('.browser-state-label').getByText(browserSearchTitle, { exact: true }).waitFor({ state: 'visible' })
  assert.match(await page.locator('.browser-footnote').innerText(), /手动浏览、登录/u, '网页面板应明确支持用户接管临时浏览器。')
  assert.match(await page.locator('.browser-footnote').innerText(), /登录只保留到应用关闭/u, '网页面板应说明登录会话只保留在内存。')
  const travelComposer = page.getByRole('textbox', { name: '旅行对话输入框', exact: true })
  await travelComposer.fill('')
  const hasCurrentPlan = await page.evaluate(async () => {
    const snapshot = await window.tripwise.getSnapshot()
    const trip = snapshot.trips.find((item) => item.id === snapshot.selectedTripId)
    if (!trip) return false
    const currentProposal = trip.messages.some((message) => message.conversationId === trip.activeConversationId &&
      message.role === 'assistant' && message.itineraryOptions?.length &&
      message.itineraryOptions.some((option) => !message.rejectedItineraryOptionIds?.includes(option.id)))
    return trip.activeRevisionId !== null || currentProposal
  })
  await page.getByRole('button', { name: '保存网页文字', exact: true }).click()
  await page.getByText('网页文字已保存到旅行资料', { exact: true }).waitFor({ state: 'visible' })
  const importedPrompt = await travelComposer.inputValue()
  assert.match(importedPrompt, /刚加入的资料/u, '网页导入后应预填将新资料用于行程的下一步。')
  assert.match(importedPrompt, hasCurrentPlan ? /完善当前行程/u : /待审计划/u,
    '网页导入提示应对应当前有无方案的状态。')
  await travelComposer.fill('保留我已经写好的行程要求')
  await webPanelTab.click()
  await page.getByRole('button', { name: '保存网页文字', exact: true }).click()
  await page.getByText('网页文字已保存到旅行资料', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(await travelComposer.inputValue(), '保留我已经写好的行程要求', '再次导入网页不得覆盖用户草稿。')
  const importedManualPage = await page.evaluate(async () => {
    const snapshot = await window.tripwise.getSnapshot()
    const trip = snapshot.trips.find((item) => item.id === snapshot.selectedTripId)
    return trip?.sources.find((source) => source.provider === '网页导入' && source.summary.includes('站内搜索命中：故宫到天坛公共交通。')) ?? null
  })
  assert.ok(importedManualPage, '用户应能把手动浏览的当前页正文加入旅行资料。')
  const browserInteractionRequests = modelProbe.requests.filter((request) =>
    Array.isArray(request.toolNames) && request.toolNames.includes('research_browser_interact')
  )
  assert.ok(browserInteractionRequests.length >= 1, '模型工具契约应提供受限浏览器交互。')
  const interactionCalls = [...new Set(modelProbe.requests
    .filter((request) => request.userPrompt === '请展开攻略全文，再用网页的站内搜索查找故宫交通。')
    .flatMap((request) => request.priorToolCalls ?? []))]
  assert.ok(interactionCalls.includes('research_browser_navigate') && interactionCalls.includes('research_browser_interact'),
    '浏览器流程应先导航，再执行快照中列出的搜索或展开操作。')
  assert.ok(!interactionCalls.includes('research_browser_snapshot'),
    '导航、展开和搜索应在各自的工具结果中返回快照，不触发额外模型轮次。')
  assert.ok(modelProbe.requests.some((request) => request.toolOutputContainsExpandedBrowserText), '展开按钮正文应进入下一轮模型上下文。')
  assert.ok(modelProbe.requests.some((request) => request.toolOutputContainsBrowserSearchResult), '同站 GET 搜索结果应进入下一轮模型上下文。')
  assert.ok(researchProxyProbe.requests.some((request) =>
    request.method === 'GET' && request.url.includes('/agent-browser-search?q=%E6%95%85%E5%AE%AB%E4%BA%A4%E9%80%9A') &&
    !request.url.includes('tripwise-form-secret') && !request.url.includes('session=')
  ), '网页搜索应只以同站 GET 发送搜索字段，不序列化隐藏表单字段。')
  process.stdout.write('通过：右侧研究网页可供 Agent 搜索/读取，也可由用户手动登录、后退、前进、刷新并导入正文；会话仅驻留内存。\n')

  await page.getByRole('button', { name: '设置', exact: true }).click()
  const credentialSettings = page.getByRole('dialog', { name: '设置' })
  await credentialSettings.waitFor({ state: 'visible' })
  const changeApiKey = credentialSettings.getByText('更换 API Key', { exact: true })
  assert.equal(await credentialSettings.getByLabel('API Key', { exact: true }).isVisible().catch(() => false), false,
    '已保存密钥时默认应折叠输入框。')
  await changeApiKey.click()
  await credentialSettings.getByLabel('API Key', { exact: true }).waitFor({ state: 'visible' })
  await credentialSettings.getByRole('button', { name: '清除', exact: true }).click()
  await credentialSettings.getByRole('button', { name: '保存', exact: true }).click()
  await credentialSettings.getByText('设置已保存。', { exact: true }).waitFor({ state: 'visible' })
  const revokedModelCredential = await page.evaluate(async () => {
    const snapshot = await window.tripwise.getSnapshot()
    return snapshot.secrets.modelKeySaved
  })
  assert.equal(revokedModelCredential, false, '用户应能从设置页清除本机保存的模型 Key。')
  process.stdout.write('通过：设置页清除已保存的模型 Key，主进程仅返回凭证是否保存的状态。\n')
  await page.keyboard.press('Escape')

  // 恢复原测试旅行的地点，继续验证准备页和本地资料重启恢复。
  await page.getByRole('button', { name: '旅行信息' }).click()
  const restoreDestinationDialog = page.getByRole('dialog', { name: '旅行信息' })
  await restoreDestinationDialog.getByRole('textbox', { name: '目的地', exact: true }).fill('上海')
  await restoreDestinationDialog.getByRole('button', { name: '保存旅行信息', exact: true }).click()
  await restoreDestinationDialog.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '出行准备', exact: true }).click()
  await assertAccessible(page, '出行准备页')

  // 关闭并重新启动整个应用，确认本地资料确实从隔离目录恢复。
  await application.close()
  launched = await launchApplication()
  application = launched.instance
  page = launched.page
  await page.getByRole('heading', { name: '上海', exact: true }).waitFor({ state: 'visible' })

  const persistedData = JSON.parse(await readFile(join(profileDirectory, 'tripwise-data.json'), 'utf8'))
  const expectedTripCount = process.env.TRIPWISE_E2E_EXECUTABLE ? 1 : 2
  assert.equal(persistedData.trips.length, expectedTripCount, '端到端测试应只在临时隔离资料中写入预期旅行。')
  const persistedSelectedTrip = persistedData.trips.find((trip) => trip.id === persistedData.selectedTripId)
  assert.ok(persistedSelectedTrip, '重启后应能找到当前选中的旅行。')
  assert.equal(persistedSelectedTrip.brief.destination, '上海', '当前旅行应在本地资料中持久化。')
  assert.deepEqual(persistedSelectedTrip.briefUnknownFields, ['budget'], '当前旅行的暂未知状态应在应用重启后保留。')
  if (expectedTripCount === 2) {
    assert.ok(persistedData.trips.some((trip) => trip.id !== persistedSelectedTrip.id && trip.brief.destination === '上海'), '导入操作不得覆盖原始旅行。')
  }
  const now = new Date().toISOString()

  // 只在隔离资料里构造两版行程，验证历史结构恢复在真实生产界面的选择、应用和撤销。
  const historyTrip = persistedData.trips.find((trip) => trip.id === persistedData.selectedTripId)
  assert.ok(historyTrip, '历史行程测试应修改当前选中的旅行。')
  const makeHistoryStop = (id, name) => ({
    id, name, area: '东城区', time: '09:00', durationMinutes: 60, category: '人文', notes: '', transitToNext: ''
  })
  const makeHistoryPlan = (id, title, summary, tradeoffs, stopNames) => ({
    id, title, summary, tradeoffs,
    days: [{
      id: 'e2e-history-day', dayNumber: 1, date: '', title: '第一天', scheduleBlocks: [],
      stops: stopNames.map(([stopId, name]) => makeHistoryStop(stopId, name))
    }]
  })
  const historyPlan = makeHistoryPlan('e2e-history-old-plan', '历史方案', '旧版摘要', '旧版取舍', [
    ['e2e-history-palace', '故宫'], ['e2e-history-old-stop', '景山']
  ])
  historyPlan.days[0].stops[1].time = '11:00'
  const currentPlan = makeHistoryPlan('e2e-history-current-plan', '当前方案', '当前摘要', '', [
    ['e2e-history-palace', '故宫'], ['e2e-history-new-stop', '天坛']
  ])
  currentPlan.days[0].stops[1].time = '11:00'
  historyTrip.revisions = [
    { id: 'e2e-history-old-revision', number: 1, createdAt: now, summary: historyPlan.title, content: '', sourceIds: [], itinerary: historyPlan },
    { id: 'e2e-history-current-revision', number: 2, createdAt: now, summary: currentPlan.title, content: '', sourceIds: [], itinerary: currentPlan }
  ]
  historyTrip.activeRevisionId = 'e2e-history-current-revision'
  await writeFile(join(profileDirectory, 'tripwise-data.json'), JSON.stringify(persistedData), { mode: 0o600 })

  await application.close()
  launched = await launchApplication()
  application = launched.instance
  page = launched.page
  await page.getByRole('heading', { name: '上海', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '行程', exact: true }).click()
  await page.getByRole('button', { name: '编辑行程', exact: true }).click()
  await page.locator('.itinerary-history-restorer > summary').click()
  const historyRestore = page.locator('.itinerary-history-restorer')
  const historicalStopAdd = historyRestore.locator('.itinerary-restore-choice').filter({ hasText: '恢复地点：景山' })
  const currentStopRemove = historyRestore.locator('.itinerary-restore-choice').filter({ hasText: '移除本次新增地点：天坛' })
  await historicalStopAdd.locator('input').check()
  if (process.env.TRIPWISE_E2E_HISTORY_SELECTION_SCREENSHOT) {
    await historyRestore.scrollIntoViewIfNeeded()
    await page.screenshot({ path: process.env.TRIPWISE_E2E_HISTORY_SELECTION_SCREENSHOT, fullPage: true })
  }
  assert.equal(await historyRestore.locator('.itinerary-restore-apply').isDisabled(), false, '选中单项结构差异后应可应用。')
  await historyRestore.locator('.itinerary-restore-apply').click()
  let stopNames = await page.locator('.itinerary-editor-stop input[placeholder="输入地点名称"]').evaluateAll((inputs) =>
    inputs.map((input) => input.value)
  )
  assert.deepEqual(stopNames, ['故宫', '景山', '天坛'], '单独恢复历史地点时，应保留未选中的当前地点。')
  await page.getByRole('button', { name: /撤销最近修改/ }).click()
  stopNames = await page.locator('.itinerary-editor-stop input[placeholder="输入地点名称"]').evaluateAll((inputs) =>
    inputs.map((input) => input.value)
  )
  assert.deepEqual(stopNames, ['故宫', '天坛'], '撤销应回到恢复操作前的草稿。')
  await historicalStopAdd.locator('input').check()
  await currentStopRemove.locator('input').check()
  await historyRestore.locator('.itinerary-restore-apply').click()
  stopNames = await page.locator('.itinerary-editor-stop input[placeholder="输入地点名称"]').evaluateAll((inputs) =>
    inputs.map((input) => input.value)
  )
  assert.deepEqual(stopNames, ['故宫', '景山'], '同时恢复新增和删除差异后，应得到选择的历史结构。')
  if (process.env.TRIPWISE_E2E_HISTORY_SCREENSHOT) {
    await historyRestore.scrollIntoViewIfNeeded()
    await page.screenshot({ path: process.env.TRIPWISE_E2E_HISTORY_SCREENSHOT, fullPage: true })
  }
  await page.locator('.itinerary-editor-plan-fields textarea').first().fill('当前摘要（空取舍可保存）')
  await page.getByRole('button', { name: '保存为新版本', exact: true }).click()
  await page.locator('.itinerary-editor').waitFor({ state: 'detached' })
  assert.doesNotMatch(await page.locator('.itinerary-summary').innerText(), /安排取舍/u,
    '没有实际取舍时，已保存行程不应显示空白说明栏。')
  await page.getByRole('button', { name: '编辑行程', exact: true }).click()
  assert.equal(await page.locator('.itinerary-editor-plan-fields textarea').nth(1).inputValue(), '',
    '行程编辑器应保留空取舍，不要求填写套话。')
  await page.getByRole('button', { name: '取消修改', exact: true }).click()

  // 仅在临时测试资料中植入已定位行程，检查实际生产地图页的 Electron 沙箱边界。
  const mapTrip = historyTrip
  const mapSource = {
    id: 'e2e-map-source', title: '故宫博物院', url: 'https://ditu.amap.com/search?query=故宫博物院',
    provider: '高德地图', kind: 'place', summary: '端到端隔离测试来源。', fetchedAt: now, status: 'success'
  }
  const alternativeSource = {
    id: 'e2e-map-alternative-source', title: '景山公园', url: 'https://ditu.amap.com/search?query=景山公园',
    provider: '高德地图', kind: 'place', summary: '端到端隔离测试备选来源。', fetchedAt: now, status: 'success'
  }
  const mapLocation = {
    latitude: 39.9163, longitude: 116.3972, label: '故宫博物院', coordinateSystem: 'gcj02',
    sourceId: mapSource.id, provider: mapSource.provider, fetchedAt: now
  }
  // 保留聊天消息仍引用的攻略来源，同时追加地图隔离测试来源。
  mapTrip.sources = [...mapTrip.sources, mapSource, alternativeSource]
  mapTrip.revisions = [{
    id: 'e2e-map-revision', number: 1, createdAt: now, summary: '地图沙箱端到端测试。', content: '',
    sourceIds: [mapSource.id],
    itinerary: {
      id: 'e2e-map-option', title: '北京测试行程', summary: '检查地图隔离。', tradeoffs: '只包含测试地点。',
      days: [{
        id: 'e2e-map-day', dayNumber: 1, date: '', title: '第一天', scheduleBlocks: [],
        stops: [{
          id: 'e2e-map-stop', name: '故宫博物院', area: '东城区', time: '09:00', durationMinutes: 120,
          category: '人文', notes: '', transitToNext: '', sourceIds: [mapSource.id], evidenceLevel: 'sourced', location: mapLocation,
          conditionalAlternatives: [{
            name: '景山公园', area: '西城区·景山', trigger: '故宫预约约满时改游',
            evidenceLevel: 'sourced', sourceIds: [alternativeSource.id]
          }]
        }]
      }]
    }
  }]
  mapTrip.activeRevisionId = 'e2e-map-revision'
  await writeFile(join(profileDirectory, 'tripwise-data.json'), JSON.stringify(persistedData), { mode: 0o600 })

  await application.close()
  launched = await launchApplication()
  application = launched.instance
  page = launched.page
  await page.getByRole('heading', { name: '上海', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '行程', exact: true }).click()
  await assertAccessible(page, '已定位行程与地图')
  const conditionalAlternative = page.locator('.itinerary-conditional-alternative')
  await conditionalAlternative.getByText('备选：景山公园（西城区·景山）', { exact: true }).waitFor({ state: 'visible' })
  await conditionalAlternative.getByText('触发：故宫预约约满时改游', { exact: true }).waitFor({ state: 'visible' })
  assert.match(await conditionalAlternative.locator('button.text-button').innerText(), /景山公园/u,
    '条件备选应展示独立的可打开来源链接。')
  await page.getByRole('region', { name: '行程地图' }).waitFor({ state: 'visible' })
  await page.getByText('© 高德地图', { exact: true }).waitFor({ state: 'visible' })
  const mapFrameLocator = page.frameLocator('iframe[title="第 1 天高德地图"]')
  await mapFrameLocator.locator('#map').waitFor({ state: 'attached' })
  const mapFrame = page.frames().find((candidate) => new URL(candidate.url()).pathname.endsWith('/amap-map.html'))
  assert.ok(mapFrame, '已定位行程应加载独立地图 HTML 页面。')
  const mapIsolation = await mapFrame.evaluate(() => ({
    origin: window.origin,
    tripwise: typeof window.tripwise,
    parentTripwise: (() => {
      try { return typeof window.parent.tripwise } catch { return 'blocked' }
    })(),
    contentPolicy: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
  }))
  assert.equal(mapIsolation.origin, 'null', '地图 iframe 必须具有 sandbox opaque origin。')
  assert.equal(mapIsolation.tripwise, 'undefined', '地图 iframe 不得获得 Tripwise preload API。')
  assert.notEqual(mapIsolation.parentTripwise, 'object', '地图 iframe 不得读取主界面的 Tripwise API。')
  assert.match(mapIsolation.contentPolicy, /https:\/\/webapi\.amap\.com/, '高德脚本来源应仅出现在地图页 CSP。')
  await verifyWorkspaceAlignment(page, 1480, 940)
  await verifyWorkspaceAlignment(page, 1040, 680)
  await page.setViewportSize({ width: 1480, height: 940 })
  await page.frameLocator('iframe[title="第 1 天高德地图"]').locator('#map').waitFor({ state: 'attached' })
  if (process.env.TRIPWISE_E2E_SCREENSHOT) {
    await page.screenshot({ path: process.env.TRIPWISE_E2E_SCREENSHOT, fullPage: true })
  }
  assert.deepEqual(rendererErrors, [], `renderer 产生错误：${rendererErrors.join('\n')}`)
  assert.deepEqual([...remoteHosts], [], `无地图凭证的隔离流程不应请求远端服务：${[...remoteHosts].join(', ')}`)
  await application.close()
  application = undefined
  const systemLogText = await readFile(join(profileDirectory, 'logs', 'tripwise.log'), 'utf8')
  const systemLogs = systemLogText.trim().split('\n').map((line) => JSON.parse(line))
  const loggedRun = systemLogs.find((entry) => entry.event === 'agent.run.started' && entry.traceId)
  assert.ok(loggedRun, '运行日志应记录 Agent 开始事件和关联 ID。')
  assert.ok(systemLogs.some((entry) => entry.event === 'agent.run.completed' && entry.traceId === loggedRun.traceId), '运行日志应以同一关联 ID 记录 Agent 完成。')
  assert.ok(systemLogs.some((entry) => entry.event === 'llm.request.attempt.started' && entry.traceId === loggedRun.traceId && entry.requestBytes > 0), '运行日志应记录脱敏请求大小并可关联模型调用。')
  assert.ok(systemLogs.some((entry) => entry.event === 'agent.tool.result.saved' && entry.toolOutputCharacters > 0), '运行日志应确认工具结果已写入后续模型上下文。')
  assert.ok(!systemLogText.includes(MODEL_PROBE_FIXTURE_KEY), '运行日志不得写入模型凭证。')
  assert.ok(!systemLogText.includes('tripwise-link-private-token'), '运行日志不得写入普通网页链接凭证。')
  assert.ok(!systemLogText.includes('tripwise-link-xsec-token'), '运行日志不得写入小红书链接访问参数。')
  process.stdout.write('通过：旅行创建、侧栏收起/展开、旅行信息编辑及应用重启后持久化。\n')
  process.stdout.write('通过：历史行程结构差异可在编辑器中逐项应用并撤销。\n')
  process.stdout.write('通过：1480 px 与最小 1040 px 工作区列边界及对话/行程内容基线对齐。\n')
  process.stdout.write('通过：运行日志可关联 Agent、模型请求和已返回的工具结果，且不含测试凭证。\n')
  process.stdout.write('通过：地图 attribution 可见；iframe 使用 opaque origin，且无法访问 Tripwise preload API。\n')
  process.stdout.write('通过：端到端流程未发现 renderer 异常。\n')
  process.stdout.write('通过：未发起任何远端网络请求。\n')
} finally {
  if (application) await application.close().catch(() => undefined)
  if (modelProbeServer?.listening) {
    await new Promise((resolveClose) => modelProbeServer.close(() => resolveClose()))
  }
  if (researchProxyProbeServer?.listening) {
    await new Promise((resolveClose) => researchProxyProbeServer.close(() => resolveClose()))
  }
  await rm(profileDirectory, { recursive: true, force: true })
}
