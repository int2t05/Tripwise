/** 创建受限 Electron 桌面外壳，并串接本地状态、模型和网页研究视图。 */
import { app, BrowserWindow, dialog, Menu, net, session } from 'electron'
import { isAbsolute, join } from 'node:path'
import { TripStore } from './persistence.js'
import { SecretVault } from './secrets.js'
import { AmapMapProxy } from './amap-map-proxy.js'
import { TravelAgent } from './agent.js'
import { CodexAppServer } from './codex-app-server.js'
import { closeModelTransport } from './llm.js'
import { configureExternalFetcher } from './connectors/http.js'
import { amapE2eMockResponse } from './connectors/amap-e2e-mock.js'
import { sourceProxyConfig } from './network-proxy.js'
import { buildApplicationMenu } from './application-menu.js'
import { closeResearchSessionProxy, configureResearchSessionProxy, ResearchBrowser } from './research-browser.js'
import { nextZoomFactor } from './zoom.js'
import { cancelActiveRequests, registerIpc } from './ipc.js'
import { classifyError, configureSystemLogger, flushSystemLogs, logSystemEvent } from './system-logger.js'
import {
  isTrustedRendererUrl as matchesTrustedRendererUrl,
  trustedDevelopmentRendererUrl
} from './trusted-renderer-url.js'

// 端到端测试只在显式启用时改用隔离资料目录，并隐藏原生窗口。
const headlessE2e = process.env.TRIPWISE_E2E_HEADLESS === '1'
if (headlessE2e) {
  const isolatedUserDataDirectory = process.env.TRIPWISE_E2E_USER_DATA_DIR
  if (!isolatedUserDataDirectory || !isAbsolute(isolatedUserDataDirectory)) {
    throw new Error('桌面端到端测试必须使用独立的绝对路径数据目录。')
  }
  app.setPath('userData', isolatedUserDataDirectory)
}

// 生产实例共享同一旅行资料目录；端到端测试仅在显式指定隔离锁 ID 时参与实例锁。
const singleInstanceTestId = headlessE2e ? process.env.TRIPWISE_E2E_SINGLE_INSTANCE_ID : undefined
if (singleInstanceTestId !== undefined) {
  if (!/^[a-z0-9-]{1,80}$/u.test(singleInstanceTestId)) {
    throw new Error('单实例测试 ID 只能包含小写字母、数字和短横线。')
  }
  app.setName(`tripwise-single-instance-${singleInstanceTestId}`)
}
const singleInstanceLockEnabled = !headlessE2e || singleInstanceTestId !== undefined
const ownsSingleInstanceLock = !singleInstanceLockEnabled || app.requestSingleInstanceLock()

const store = new TripStore(app.getPath('userData'))
const vault = new SecretVault(app.getPath('userData'))
const codexAppServer = new CodexAppServer(app.getPath('userData'))
const agent = new TravelAgent(undefined, codexAppServer)
let mainWindow: BrowserWindow | null = null
let researchBrowser: ResearchBrowser | null = null
let amapMapProxy: AmapMapProxy | null = null
let shutdownStarted = false
let shutdownLogsFlushed = false
let shutdownFlushScheduled = false

/** 统一建立本机地图资源与安全密钥代理，并限制为当前应用构建目录。 */
function getAmapMapProxy(): AmapMapProxy {
  amapMapProxy ??= new AmapMapProxy(
    (input, init) => net.fetch(String(input), init),
    trustedDevelopmentRendererUrl(app.isPackaged, process.env.ELECTRON_RENDERER_URL),
    join(app.getAppPath(), 'out', 'renderer')
  )
  return amapMapProxy
}

/** 调整 Tripwise 主界面缩放，限制范围并按 10% 步进，避免误缩放外部研究网页。 */
function changeMainWindowZoom(direction: -1 | 0 | 1): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.setZoomFactor(nextZoomFactor(mainWindow.webContents.getZoomFactor(), direction))
}

/** 提供系统文本编辑快捷键和界面缩放菜单，不在 renderer 中模拟原生操作。 */
function configureApplicationMenu(): void {
  const template = buildApplicationMenu(process.platform === 'darwin', changeMainWindowZoom)
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** 以默认系统窗口创建三栏工作区。 */
function createWindow(): void {
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1040,
    minHeight: 680,
    show: !headlessE2e,
    backgroundColor: '#f6f7f5',
    title: '行程有数 Tripwise',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  })
  mainWindow = window
  researchBrowser = new ResearchBrowser(window, (state) => {
    if (!window.isDestroyed()) window.webContents.send('research:state', state)
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    logSystemEvent('error', 'app.renderer.crashed', { reason: details.reason, exitCode: details.exitCode })
  })
  window.webContents.on('console-message', (_event, level) => {
    if (level === 3) logSystemEvent('error', 'app.renderer.console_error', { phase: 'renderer_console', status: 'error' })
  })
  window.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) {
      logSystemEvent('error', 'app.renderer.load_failed', { phase: 'main_frame', errorCode, status: 'failed' })
    }
  })
  window.on('unresponsive', () => logSystemEvent('warn', 'app.window.unresponsive'))
  window.on('responsive', () => logSystemEvent('info', 'app.window.responsive'))
  const developmentUrl = trustedDevelopmentRendererUrl(app.isPackaged, process.env.ELECTRON_RENDERER_URL)
  if (developmentUrl) void window.loadURL(developmentUrl)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  window.on('closed', () => {
    logSystemEvent('info', 'app.window.closed')
    cancelActiveRequests()
    researchBrowser?.close()
    researchBrowser = null
    mainWindow = null
  })
}

/** 二次启动时复用现有主窗口，用户已关闭窗口时再恢复工作区。 */
function focusOrCreateMainWindow(): void {
  if (headlessE2e) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** 只允许应用原始 renderer 地址的同源导航，避免 URL 前缀绕过。 */
function isTrustedRendererUrl(input: string): boolean {
  return matchesTrustedRendererUrl(
    input,
    join(__dirname, '../renderer/index.html'),
    trustedDevelopmentRendererUrl(app.isPackaged, process.env.ELECTRON_RENDERER_URL),
    process.platform
  )
}

/** 初始化数据与凭证后创建窗口，并响应 macOS 窗口生命周期。 */
async function startApplication(): Promise<void> {
  await app.whenReady()
  configureSystemLogger(app.getPath('userData'))
  logSystemEvent('info', 'app.startup.started', { platform: process.platform })
  app.on('child-process-gone', (_event, details) => {
    logSystemEvent('warn', 'app.child_process.gone', {
      phase: details.type,
      reason: details.reason,
      exitCode: details.exitCode
    })
  })
  // 主界面和地图不需要浏览器权限；默认拒绝，避免内容异常时意外获得访问能力。
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  configureApplicationMenu()
  logSystemEvent('info', 'app.startup.step', { startupStep: 'trip_store' })
  await store.initialize()
  try {
    await agent.reconcileCodexThreads(store.snapshot().trips)
  } catch (error) {
    // Codex 清理失败不影响本地旅行数据和其他模型连接启动。
    logSystemEvent('warn', 'llm.codex_app_server.reconcile_failed', { errorKind: classifyError(error) })
  }
  logSystemEvent('info', 'app.startup.step', { startupStep: 'credential_file' })
  await vault.initialize()
  const mockAmapForE2e = headlessE2e && process.env.TRIPWISE_E2E_AMAP_MOCK === '1'
  configureExternalFetcher((input, init) => {
    const mock = mockAmapForE2e ? amapE2eMockResponse(input) : null
    if (mock) {
      logSystemEvent('info', 'e2e.amap.mock_response', { operation: mock.operation })
      return Promise.resolve(mock.response)
    }
    return net.fetch(input instanceof URL ? input.toString() : input, init)
  })
  await session.defaultSession.setProxy(sourceProxyConfig(store.snapshot().settings.sourceProxyUrl))
  try {
    await configureResearchSessionProxy()
  } catch (error) {
    // 研究页出站代理不可用时关闭网页面板；其他旅行功能继续启动。
    logSystemEvent('warn', 'app.research_proxy.unavailable', { errorKind: classifyError(error) })
  }
  registerIpc({
    store,
    vault,
    agent,
    getMainWindow: () => mainWindow,
    getResearchBrowser: () => researchBrowser,
    getAmapMapProxy,
    getExistingAmapMapProxy: () => amapMapProxy,
    isTrustedRendererUrl,
    applySourceProxy
  })
  createWindow()
  logSystemEvent('info', 'app.startup.completed', { platform: process.platform })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

/** 设置连接器上游代理并复用受限网页代理；模型接口使用独立请求，不走此代理。 */
async function applySourceProxy(value: string, rollbackValue: string): Promise<void> {
  const defaultSession = session.defaultSession
  const next = sourceProxyConfig(value)
  const previous = sourceProxyConfig(rollbackValue)
  try {
    await defaultSession.setProxy(next)
    await configureResearchSessionProxy()
  } catch {
    await defaultSession.setProxy(previous).catch(() => undefined)
    await configureResearchSessionProxy().catch(() => undefined)
    throw new Error('无法应用旅行资料代理设置。')
  }
}

/** 清理正在运行的模型请求；各写操作已在落盘后才返回。 */
function stopApplication(): void {
  if (shutdownStarted) return
  shutdownStarted = true
  cancelActiveRequests()
  closeResearchSessionProxy()
  void amapMapProxy?.close()
}

/** 向用户显示启动失败原因，避免本地数据错误导致应用静默退出。 */
function reportStartupFailure(error: unknown): void {
  logSystemEvent('error', 'app.startup.failed', { errorKind: classifyError(error) })
  const detail = error instanceof Error && error.message.trim()
    ? error.message.trim().slice(0, 1_200)
    : '系统未提供具体错误详情。'
  dialog.showErrorBox(
    '行程有数启动失败',
    `应用未能完成启动。本机旅行数据不会因本次启动失败而被自动重置或删除。\n\n${detail}`
  )
  app.quit()
}

if (ownsSingleInstanceLock) {
  if (singleInstanceLockEnabled) app.on('second-instance', focusOrCreateMainWindow)
  app.on('before-quit', (event) => {
    stopApplication()
    if (shutdownLogsFlushed) return
    event.preventDefault()
    if (shutdownFlushScheduled) return
    shutdownFlushScheduled = true
    logSystemEvent('info', 'app.shutdown.started')
    void Promise.allSettled([closeModelTransport(), agent.close()])
      .then((results) => {
        if (results[0]?.status === 'rejected') {
          logSystemEvent('warn', 'llm.transport.close_failed', { errorKind: classifyError(results[0].reason) })
        }
        if (results[1]?.status === 'rejected') {
          logSystemEvent('warn', 'llm.codex_app_server.close_failed', { errorKind: classifyError(results[1].reason) })
        }
      })
      .finally(async () => {
        await flushSystemLogs()
        shutdownLogsFlushed = true
        app.quit()
      })
  })
  void startApplication().catch(reportStartupFailure)
} else {
  // 不占有锁的重复进程不初始化数据、不注册 IPC，也不写运行日志。
  app.quit()
}
