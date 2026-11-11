/** 注册主窗口可信 IPC，并集中管理会话级旅行操作状态。 */
import { app, dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentEvent, AppSettings, BrowserBounds, BuiltinConnectorTestId, SourceRecord } from '../shared/types.js'
import { sourceNatureFor } from '../shared/source-provenance.js'
import { stripAgentRunProgress } from '../shared/conversations.js'
import { itineraryToMarkdown } from '../shared/itinerary.js'
import type { TripStore } from './persistence.js'
import type { SecretVault } from './secrets.js'
import type { AmapMapProxy } from './amap-map-proxy.js'
import type { TravelAgent } from './agent.js'
import { agentTimeoutMessage, armAgentDeadline, isAgentTimeout } from './agent-deadline.js'
import { validateBaseUrl } from './llm.js'
import { executeTool } from './tools.js'
import type { ToolResult } from './connectors/types.js'
import { sanitizeBrief, validateBriefDates } from './trip-brief.js'
import { normalizeTripBriefUnknownFields } from '../shared/trip-brief.js'
import { isResearchSearchResultsUrl } from '../shared/research-browser-input.js'
import { searchMapPlaces as searchMapPlaceCandidates } from './connectors/places.js'
import { testBuiltinConnector } from './connectors/connection-test.js'
import { createUserProvidedSource } from './connectors/user-import.js'
import { normalizeSourceProxy } from './network-proxy.js'
import { McpToolSession } from './mcp/runtime.js'
import { removeMcpServerConfig, saveMcpServerConfig, testMcpServerConfig } from './mcp/service.js'
import type { ResearchBrowser } from './research-browser.js'
import { trustedDevelopmentRendererUrl } from './trusted-renderer-url.js'
import { classifyError, logSystemEvent, systemLogDirectory } from './system-logger.js'

const MAX_TRIP_BACKUP_BYTES = 50 * 1024 * 1024
const activeRequests = new Map<string, { tripId: string; conversationId: string; controller: AbortController }>()
const deletingConversations = new Set<string>()
const activeSourceRetries = new Set<string>()
const activeTripQueries = new Set<string>()
const lockedTrips = new Set<string>()
let activeAgentRunCount = 0
let mcpConfigWriteQueue: Promise<void> = Promise.resolve()

/** 中止窗口关闭或应用退出时仍在运行的模型请求。 */
export function cancelActiveRequests(): void {
  for (const request of activeRequests.values()) request.controller.abort()
  activeRequests.clear()
}

/** 标记会写回旅行来源的异步查询，避免查询完成时旅行已被删除。 */
function trackTripQuery(tripId: string): () => void {
  if (lockedTrips.has(tripId)) throw new Error('这趟旅行正在整理资料，请稍后重试。')
  const operationId = `${tripId}:${randomUUID()}`
  activeTripQueries.add(operationId)
  return () => activeTripQueries.delete(operationId)
}

/** 串行处理 MCP 配置变更，避免基于同一份旧列表互相覆盖。 */
function serializeMcpConfigWrite<T>(operation: () => Promise<T>): Promise<T> {
  const action = mcpConfigWriteQueue.then(operation)
  mcpConfigWriteQueue = action.then(() => undefined, () => undefined)
  return action
}

/** 校验设置页可调用的内置连接器测试标识。 */
function isBuiltinConnectorTestId(value: unknown): value is BuiltinConnectorTestId {
  return value === 'exa' || value === 'tavily' || value === 'firecrawl' || value === 'amap'
}

/** 只记录规划、外部查询和写入操作，忽略高频只读界面状态请求。 */
function isDiagnosticOperation(channel: string): boolean {
  return /^(?:agent:(?:send|cancel)|model:test|connector:test|source:(?:retry|skip-retry)|routes:estimate|places:map-search|mcp:|trip:(?:create|delete|update-brief)|conversation:(?:create|delete)|revision:|preparation:|settings:update|secrets:update)/u.test(channel)
}

/** 校验密钥长度并拒绝非字符串 IPC 输入。 */
function secretInput(value: unknown, max: number): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > max || /[\r\n]/.test(value)) throw new Error('密钥格式无效。')
  return value
}

interface MainIpcDependencies {
  store: TripStore
  vault: SecretVault
  agent: TravelAgent
  getMainWindow: () => BrowserWindow | null
  getResearchBrowser: () => ResearchBrowser | null
  getAmapMapProxy: () => AmapMapProxy
  getExistingAmapMapProxy: () => AmapMapProxy | null
  isTrustedRendererUrl: (input: string) => boolean
  applySourceProxy: (value: string, rollbackValue: string) => Promise<void>
}

/** 注册 IPC 命令，敏感凭证只留在主进程。 */
export function registerIpc(dependencies: MainIpcDependencies): void {
  const { store, vault, agent, applySourceProxy } = dependencies
  const getAmapMapProxy = dependencies.getAmapMapProxy
  const getExistingAmapMapProxy = dependencies.getExistingAmapMapProxy
  /** 在处理窗口级命令前确认应用窗口仍可用。 */
  const requireMainWindow = (): BrowserWindow => {
    const window = dependencies.getMainWindow()
    if (!window || window.isDestroyed()) throw new Error('应用窗口当前不可用。')
    return window
  }
  /** 在网页命令前确认隔离研究视图已经创建。 */
  const requireResearchBrowser = (): ResearchBrowser => {
    const browser = dependencies.getResearchBrowser()
    if (!browser) throw new Error('网页面板当前不可用。')
    return browser
  }
  /** 返回应用快照，并只暴露凭证存在状态而不返回密钥值。 */
  const appSnapshot = async () => {
    const data = store.snapshot()
    return {
      trips: data.trips.map(stripAgentRunProgress),
      selectedTripId: data.selectedTripId,
      settings: data.settings,
      secrets: await vault.status()
    }
  }
  /** 限定 IPC 只能由当前主窗口的受信任主框架调用。 */
  const handleTrustedIpc = <Args extends unknown[], Result>(
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, ...args: Args) => Result
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      const frame = event.senderFrame
      const window = dependencies.getMainWindow()
      if (
        !window || window.isDestroyed() || event.sender !== window.webContents ||
        !frame || frame !== event.sender.mainFrame || !dependencies.isTrustedRendererUrl(frame.url)
      ) {
        throw new Error('该操作只能由 Tripwise 主窗口发起。')
      }
      const shouldLog = isDiagnosticOperation(channel)
      const startedAt = Date.now()
      if (shouldLog) logSystemEvent('info', 'ipc.operation.started', { operation: channel })
      try {
        const result = await handler(event, ...(args as Args))
        if (shouldLog) logSystemEvent('info', 'ipc.operation.completed', {
          operation: channel,
          durationMs: Date.now() - startedAt,
          status: 'completed'
        })
        return result
      } catch (error) {
        if (shouldLog) logSystemEvent('warn', 'ipc.operation.failed', {
          operation: channel,
          durationMs: Date.now() - startedAt,
          status: 'failed',
          errorKind: classifyError(error)
        })
        throw error
      }
    })
  }
  handleTrustedIpc('app:get-snapshot', appSnapshot)
  handleTrustedIpc('system:open-log-directory', async () => {
    const openError = await shell.openPath(systemLogDirectory())
    if (openError) throw new Error('无法打开运行日志文件夹。')
  })
  handleTrustedIpc('trip:create', async (_event, input: unknown) => {
    await store.createTrip(sanitizeBrief(input))
    return appSnapshot()
  })
  handleTrustedIpc('trip:select', async (_event, tripId: unknown) => {
    if (typeof tripId !== 'string') throw new Error('旅行 ID 无效。')
    await store.selectTrip(tripId)
    return appSnapshot()
  })
  handleTrustedIpc('conversation:create', async (_event, tripId: unknown) => {
    if (typeof tripId !== 'string' || tripId.length > 100) throw new Error('旅行 ID 无效。')
    await store.createConversation(tripId)
    return appSnapshot()
  })
  handleTrustedIpc('conversation:select', async (_event, tripId: unknown, conversationId: unknown) => {
    if (typeof tripId !== 'string' || tripId.length > 100 || typeof conversationId !== 'string' || conversationId.length > 100) {
      throw new Error('对话话题请求无效。')
    }
    await store.selectConversation(tripId, conversationId)
    return appSnapshot()
  })
  handleTrustedIpc('conversation:delete', async (_event, tripId: unknown, conversationId: unknown) => {
    if (typeof tripId !== 'string' || tripId.length > 100 || typeof conversationId !== 'string' || conversationId.length > 100) {
      throw new Error('对话话题请求无效。')
    }
    const key = `${tripId}:${conversationId}`
    if (deletingConversations.has(key)) throw new Error('该话题正在删除，请稍候。')
    if ([...activeRequests.values()].some((request) => request.tripId === tripId && request.conversationId === conversationId)) {
      throw new Error('该话题仍在规划中，请等回复结束后再删除。')
    }
    deletingConversations.add(key)
    try {
      await store.deleteConversation(tripId, conversationId)
      await agent.deleteCodexConversationThread(tripId, conversationId)
      return appSnapshot()
    } finally {
      deletingConversations.delete(key)
    }
  })
  handleTrustedIpc('trip:update-brief', async (_event, tripId: unknown, input: unknown, unknownFieldsInput: unknown) => {
    if (typeof tripId !== 'string') throw new Error('旅行 ID 无效。')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('旅行信息格式无效。')
    const trip = store.snapshot().trips.find((item) => item.id === tripId)
    if (!trip) throw new Error('找不到这趟旅行。')
    const brief = { ...trip.brief, ...sanitizeBrief(input) }
    validateBriefDates(brief)
    const requestedUnknownFields = unknownFieldsInput === undefined ? trip.briefUnknownFields : unknownFieldsInput
    const unknownFields = normalizeTripBriefUnknownFields(requestedUnknownFields, brief)
    if (!unknownFields) throw new Error('暂未知项目必须是空白的旅行信息字段。')
    await store.updateBrief(tripId, brief, unknownFields)
    return appSnapshot()
  })
  handleTrustedIpc('trip:apply-brief-proposal', async (_event, tripId: unknown, conversationId: unknown, messageId: unknown) => {
    if (typeof tripId !== 'string' || typeof conversationId !== 'string' || typeof messageId !== 'string') {
      throw new Error('旅行信息提案 ID 无效。')
    }
    await store.applyBriefProposal(tripId, messageId, conversationId)
    return appSnapshot()
  })
  handleTrustedIpc('source:retry', async (_event, tripId: unknown, sourceId: unknown) => {
    if (typeof tripId !== 'string' || tripId.length > 100 || typeof sourceId !== 'string' || sourceId.length > 100) {
      throw new Error('来源重试请求无效。')
    }
    if (lockedTrips.has(tripId)) throw new Error('这趟旅行正在整理资料，请稍后重试。')
    const data = store.snapshot()
    const trip = data.trips.find((item) => item.id === tripId)
    if (!trip) throw new Error('找不到这趟旅行。')
    const source = trip.sources.find((item) => item.id === sourceId)
    if (!source?.retry || source.status === 'success') throw new Error('该来源当前不可重试。')
    const retry = source.retry
    const mcpServer = 'kind' in retry
      ? data.settings.mcpServers.find((server) => server.id === retry.serverId)
      : undefined
    if ('kind' in retry) {
      // MCP 重试只重连当前启用服务，并在执行前复核该只读工具仍获授权。
      if (source.kind !== 'plugin' || source.connectorId !== retry.serverId) {
        throw new Error('MCP 重试来源与插件服务不匹配，请重新检索后重试。')
      }
      if (!mcpServer?.enabled) throw new Error('该 MCP 服务已关闭或已移除，请检查设置后重试。')
      const hasEndpoint = (mcpServer.transport ?? 'stdio') === 'stdio' ? !!mcpServer.command : !!mcpServer.url
      if (!hasEndpoint || !mcpServer.allowedTools.length) throw new Error('该 MCP 服务当前没有可运行的已授权工具。')
      if (retry.kind === 'mcp-tool' && !mcpServer.allowedTools.includes(retry.toolName)) {
        throw new Error('该 MCP 工具已取消授权，请重新发现并授权后重试。')
      }
    } else if (retry.toolName === 'search_xiaohongshu' || retry.toolName === 'read_xiaohongshu_note') {
      if (!data.settings.xiaohongshu.enabled || !data.settings.xiaohongshu.command) {
        throw new Error('小红书连接器未启用或未配置，请在设置中完成配置后重试。')
      }
    } else {
      const connector = retry.toolName === 'search_web' || retry.toolName === 'read_webpage' ? 'webSearch'
        : retry.toolName === 'get_weather' ? 'weather'
          : 'places'
      if (!data.settings.connectors[connector]) throw new Error('该来源连接器已关闭，请在设置中启用后重试。')
    }
    if ('kind' in retry && !mcpServer) throw new Error('该 MCP 服务当前不可用，请检查设置后重试。')

    const lockKey = `${tripId}:${sourceId}`
    if (activeSourceRetries.has(lockKey)) throw new Error('该来源正在重试，请稍候。')
    activeSourceRetries.add(lockKey)
    try {
      let result: ToolResult
      if ('kind' in retry) {
        const server = mcpServer
        if (!server) throw new Error('该 MCP 服务当前不可用，请检查设置后重试。')
        result = retry.kind === 'mcp-connect'
          ? await McpToolSession.retryConnection(server, vault, AbortSignal.timeout(60_000))
          : await McpToolSession.retryReadOnlyTool(
              server, vault, retry.toolName, retry.arguments, AbortSignal.timeout(60_000)
            )
      } else {
        result = await executeTool(retry.toolName, JSON.stringify(retry.arguments), {
            amapKey: await vault.get('amapKey'),
            exaKey: await vault.get('exaKey'),
            tavilyKey: await vault.get('tavilyKey'),
            firecrawlKey: await vault.get('firecrawlKey'),
            connectors: data.settings.connectors,
            xiaohongshu: data.settings.xiaohongshu,
            availableSources: trip.sources,
            itinerary: trip.revisions.find((revision) => revision.id === trip.activeRevisionId)?.itinerary
          })
      }
      await store.applySourceRetryResult(tripId, sourceId, result.sources, result.output)
      return appSnapshot()
    } finally {
      activeSourceRetries.delete(lockKey)
    }
  })
  handleTrustedIpc('source:skip-retry', async (_event, tripId: unknown, sourceId: unknown) => {
    if (typeof tripId !== 'string' || tripId.length > 100 || typeof sourceId !== 'string' || sourceId.length > 100) {
      throw new Error('来源跳过请求无效。')
    }
    if (lockedTrips.has(tripId)) throw new Error('这趟旅行正在整理资料，请稍后再操作。')
    const lockKey = `${tripId}:${sourceId}`
    if (activeSourceRetries.has(lockKey)) throw new Error('该来源正在重试，请稍候再跳过。')
    // 跳过重试与移除来源共享锁，避免两项来源写入互相覆盖。
    activeSourceRetries.add(lockKey)
    try {
      await store.skipSourceRetry(tripId, sourceId)
      return appSnapshot()
    } finally {
      activeSourceRetries.delete(lockKey)
    }
  })
  handleTrustedIpc('source:delete', async (_event, tripId: unknown, sourceId: unknown) => {
    if (typeof tripId !== 'string' || !tripId || tripId.length > 100 || typeof sourceId !== 'string' || !sourceId || sourceId.length > 100) {
      throw new Error('来源移除请求无效。')
    }
    const retryPrefix = `${tripId}:`
    const hasAgentRequest = [...activeRequests.values()].some((request) => request.tripId === tripId)
    const hasSourceRetry = [...activeSourceRetries].some((key) => key.startsWith(retryPrefix))
    const hasTripQuery = [...activeTripQueries].some((key) => key.startsWith(retryPrefix))
    if (lockedTrips.has(tripId) || hasAgentRequest || hasSourceRetry || hasTripQuery) {
      throw new Error('这趟旅行仍有规划或来源查询正在运行，请等待完成后再移除来源。')
    }
    // 整理期间拒绝新查询和重试，确保来源快照及其结构化引用原子更新。
    lockedTrips.add(tripId)
    try {
      await store.deleteSource(tripId, sourceId)
      return appSnapshot()
    } finally {
      lockedTrips.delete(tripId)
    }
  })
  handleTrustedIpc('trip:delete', async (_event, tripId: unknown) => {
    if (typeof tripId !== 'string' || !tripId || tripId.length > 100) throw new Error('旅行 ID 无效。')
    const retryPrefix = `${tripId}:`
    const hasAgentRequest = [...activeRequests.values()].some((request) => request.tripId === tripId)
    const hasSourceRetry = [...activeSourceRetries].some((key) => key.startsWith(retryPrefix))
    const hasTripQuery = [...activeTripQueries].some((key) => key.startsWith(retryPrefix))
    if (lockedTrips.has(tripId) || hasAgentRequest || hasSourceRetry || hasTripQuery) {
      throw new Error('这趟旅行仍有规划或来源查询正在运行，请停止或等待完成后再删除。')
    }
    lockedTrips.add(tripId)
    try {
      const trip = store.snapshot().trips.find((item) => item.id === tripId)
      const conversationIds = trip?.conversations.map((conversation) => conversation.id) ?? []
      await store.deleteTrip(tripId)
      await Promise.all(conversationIds.map((conversationId) =>
        agent.deleteCodexConversationThread(tripId, conversationId)
      ))
      return appSnapshot()
    } finally {
      lockedTrips.delete(tripId)
    }
  })
  handleTrustedIpc('trip:export', async (_event, tripId: unknown) => {
    if (typeof tripId !== 'string') throw new Error('旅行 ID 无效。')
    const trip = store.snapshot().trips.find((item) => item.id === tripId)
    if (!trip) throw new Error('找不到这趟旅行。')
    const active = trip.revisions.find((item) => item.id === trip.activeRevisionId)
    const markdown = [
      `# ${trip.title}`,
      '',
      `- 出发地：${trip.brief.departureCity || '未填写'}`,
      `- 目的地：${trip.brief.destination || '未填写'}`,
      `- 日期：${trip.brief.startDate || '未填写'}${trip.brief.endDate ? ` 至 ${trip.brief.endDate}` : ''}`,
      '',
      '## 当前行程版本',
      '',
      active?.itinerary ? itineraryToMarkdown(active.itinerary, trip.sources) : active?.content || '尚未保存行程方案。',
      ...(active?.itinerary && active.content ? ['', '### 方案说明', '', active.content] : []),
      '',
      '## 来源',
      '',
      ...(trip.sources.length ? trip.sources.map((item) => `- [${item.title}](${item.url}) · ${item.provider} · ${item.fetchedAt}`) : ['- 暂无来源']),
      '',
      '## 对话记录',
      '',
      ...trip.conversations.flatMap((conversation) => [
        `### 话题：${conversation.title}`,
        '',
        ...trip.messages.filter((item) => item.conversationId === conversation.id)
          .map((item) => `#### ${item.role === 'user' ? '用户' : '行程有数'} · ${item.createdAt}\n\n${item.content}\n`),
        ''
      ])
    ].join('\n')
    const result = await dialog.showSaveDialog(requireMainWindow(), {
      title: '导出旅行资料',
      defaultPath: `${trip.title.replace(/[\\/:*?"<>|]/g, '-')}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    await writeFile(result.filePath, markdown, { encoding: 'utf8', mode: 0o600 })
    return { saved: true, path: result.filePath }
  })
  handleTrustedIpc('trip:export-backup', async (_event, tripId: unknown) => {
    if (typeof tripId !== 'string') throw new Error('旅行 ID 无效。')
    const storedTrip = store.snapshot().trips.find((item) => item.id === tripId)
    if (!storedTrip) throw new Error('找不到这趟旅行。')
    const trip = stripAgentRunProgress(storedTrip)
    const content = JSON.stringify({ format: 'tripwise-trip-backup', formatVersion: 11, trip }, null, 2)
    if (Buffer.byteLength(content, 'utf8') > MAX_TRIP_BACKUP_BYTES) throw new Error('旅行资料超过 50 MiB，无法生成单文件备份。')
    const result = await dialog.showSaveDialog(requireMainWindow(), {
      title: '备份当前旅行',
      defaultPath: `${trip.title.replace(/[\\/:*?"<>|]/g, '-')}.tripwise.json`,
      filters: [{ name: 'Tripwise 旅行备份', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    await writeFile(result.filePath, content, { encoding: 'utf8', mode: 0o600 })
    return { saved: true, path: result.filePath }
  })
  handleTrustedIpc('trip:import-backup', async () => {
    const selection = await dialog.showOpenDialog(requireMainWindow(), {
      title: '选择 Tripwise 旅行备份',
      properties: ['openFile'],
      filters: [{ name: 'Tripwise 旅行备份', extensions: ['json'] }]
    })
    if (selection.canceled || !selection.filePaths[0]) return { imported: false }
    const path = selection.filePaths[0]
    if ((await stat(path)).size > MAX_TRIP_BACKUP_BYTES) throw new Error('备份文件超过 50 MiB，无法导入。')
    const content = await readFile(path, 'utf8')
    if (Buffer.byteLength(content, 'utf8') > MAX_TRIP_BACKUP_BYTES) throw new Error('备份文件超过 50 MiB，无法导入。')
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new Error('备份文件不是有效的 JSON；当前资料未修改。')
    }
    const preview = store.previewTripBackup(parsed)
    const confirmation = await dialog.showMessageBox(requireMainWindow(), {
      type: 'warning',
      title: '导入旅行备份',
      message: `将“${preview.title}”作为一趟新旅行导入。`,
      detail: `包含 ${preview.conversationCount} 个话题、${preview.messageCount} 条消息、${preview.sourceCount} 条来源、${preview.preparationItemCount} 项出行准备和 ${preview.revisionCount} 个行程版本。现有旅行不会被替换；模型/地图设置与服务密钥不包含在备份中，也不会更改。`,
      buttons: ['取消', '导入为新旅行'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (confirmation.response !== 1) return { imported: false }
    await store.importTripBackup(parsed)
    return { imported: true, snapshot: await appSnapshot() }
  })
  handleTrustedIpc('settings:choose-opencli-command', async () => {
    const selection = await dialog.showOpenDialog(requireMainWindow(), {
      title: '选择 OpenCLI 程序或 Node.js 可执行文件',
      properties: ['openFile']
    })
    return selection.canceled ? null : selection.filePaths[0] ?? null
  })
  handleTrustedIpc('settings:update', async (_event, input: AppSettings) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !input.model) throw new Error('模型设置无效。')
    const provider = input.model.provider ?? 'openai-compatible'
    if (provider !== 'openai-compatible' && provider !== 'codex-cli') throw new Error('模型来源无效。')
    const previousSettings = store.snapshot().settings
    const baseUrl = provider === 'openai-compatible'
      ? validateBaseUrl(String(input.model.baseUrl ?? ''))
      : previousSettings.model.baseUrl
    const model = provider === 'codex-cli' ? 'gpt-6-luna' : String(input.model.model ?? '').trim()
    if (!model || model.length > 160) throw new Error('模型名称需为 1–160 个字符。')
    if (typeof input.researchBrowserVisualRead !== 'boolean') throw new Error('网页图像识别设置无效。')
    const sourceProxyUrl = normalizeSourceProxy(input.sourceProxyUrl)
    const requestedConnectors = input.connectors
    const connectorKeys = ['webSearch', 'weather', 'places', 'routes'] as const
    if (!requestedConnectors || typeof requestedConnectors !== 'object' || Array.isArray(requestedConnectors) ||
      !connectorKeys.every((key) => typeof requestedConnectors[key] === 'boolean')) {
      throw new Error('连接器启用设置无效。')
    }
    const requestedXiaohongshu = input.xiaohongshu
    if (!requestedXiaohongshu || typeof requestedXiaohongshu !== 'object' || Array.isArray(requestedXiaohongshu) ||
      Object.keys(requestedXiaohongshu).some((key) => !['enabled', 'command', 'args'].includes(key)) ||
      typeof requestedXiaohongshu.enabled !== 'boolean' || typeof requestedXiaohongshu.command !== 'string' ||
      requestedXiaohongshu.command.length > 1_024 || requestedXiaohongshu.command.includes('\0') ||
      !Array.isArray(requestedXiaohongshu.args) || requestedXiaohongshu.args.length > 16 ||
      !requestedXiaohongshu.args.every((arg) => typeof arg === 'string' && arg.length <= 1_024 && !arg.includes('\0')) ||
      (requestedXiaohongshu.command.trim() !== '' && !isAbsolute(requestedXiaohongshu.command.trim())) ||
      (requestedXiaohongshu.enabled && !requestedXiaohongshu.command.trim())) {
      throw new Error('小红书连接器设置无效。请使用绝对程序路径；Windows 可选择 node.exe，并将 OpenCLI 主入口逐项填写为启动参数。')
    }
    await applySourceProxy(sourceProxyUrl, previousSettings.sourceProxyUrl)
    try {
      await store.updateSettingsPreservingMcpServers({
        model: { provider, baseUrl, model },
        sourceProxyUrl,
        connectors: {
          webSearch: requestedConnectors.webSearch,
          weather: requestedConnectors.weather,
          places: requestedConnectors.places,
          routes: requestedConnectors.routes
        },
        xiaohongshu: {
          enabled: requestedXiaohongshu.enabled,
          command: requestedXiaohongshu.command.trim(),
          args: requestedXiaohongshu.args.map((arg) => arg.trim())
        },
        researchBrowserVisualRead: input.researchBrowserVisualRead,
        mcpServers: previousSettings.mcpServers
      })
    } catch (error) {
      try {
        await applySourceProxy(previousSettings.sourceProxyUrl, sourceProxyUrl)
      } catch {
        throw new Error('设置保存失败，来源代理状态未能恢复；请重启应用。')
      }
      throw error
    }
    return appSnapshot()
  })
  handleTrustedIpc('mcp:save-server', async (_event, input: unknown) => {
    return serializeMcpConfigWrite(async () => {
      await saveMcpServerConfig(input, store, vault)
      return appSnapshot()
    })
  })
  handleTrustedIpc('mcp:test-server', async (_event, input: unknown) => {
    return testMcpServerConfig(input, store.snapshot().settings.mcpServers, vault)
  })
  handleTrustedIpc('mcp:remove-server', async (_event, serverId: unknown) => {
    if (typeof serverId !== 'string') throw new Error('MCP 服务 ID 无效。')
    return serializeMcpConfigWrite(async () => {
      await removeMcpServerConfig(serverId, store, vault)
      return appSnapshot()
    })
  })
  handleTrustedIpc('secrets:update', async (_event, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('凭证设置无效。')
    const data = input as Record<string, unknown>
    const modelKey = secretInput(data.modelKey, 8_000)
    const amapKey = secretInput(data.amapKey, 512)
    const amapJsKey = secretInput(data.amapJsKey, 512)
    const amapSecurityCode = secretInput(data.amapSecurityCode, 512)
    const exaKey = secretInput(data.exaKey, 8_000)
    const tavilyKey = secretInput(data.tavilyKey, 8_000)
    const firecrawlKey = secretInput(data.firecrawlKey, 8_000)
    await vault.update({
      modelKey,
      amapKey,
      amapJsKey,
      amapSecurityCode,
      exaKey,
      tavilyKey,
      firecrawlKey,
      clearModelKey: data.clearModelKey === true,
      clearAmapKey: data.clearAmapKey === true,
      clearAmapJsKey: data.clearAmapJsKey === true,
      clearAmapSecurityCode: data.clearAmapSecurityCode === true,
      clearExaKey: data.clearExaKey === true,
      clearTavilyKey: data.clearTavilyKey === true,
      clearFirecrawlKey: data.clearFirecrawlKey === true
    })
    if (data.clearAmapSecurityCode === true || amapSecurityCode) {
      getExistingAmapMapProxy()?.setSecurityCode(await vault.get('amapSecurityCode'))
    }
    return appSnapshot()
  })
  handleTrustedIpc('secrets:open-local-file', async () => {
    await vault.prepareLocalCredentialFile()
    const openError = await shell.openPath(vault.getLocalCredentialFilePath())
    if (openError) throw new Error('本地凭证文件已保存，但无法打开：' + openError)
    return appSnapshot()
  })
  handleTrustedIpc('map:get-amap-frame-url', async () => {
    const developmentUrl = trustedDevelopmentRendererUrl(app.isPackaged, process.env.ELECTRON_RENDERER_URL)
    if (developmentUrl) return new URL('./amap-map.html', developmentUrl).toString()
    return getAmapMapProxy().mapPageUrl()
  })
  handleTrustedIpc('map:get-amap-config', async () => {
    const jsKey = await vault.get('amapJsKey')
    const securityCode = await vault.get('amapSecurityCode')
    if (!jsKey) throw new Error('请先在「连接与隐私」设置中配置高德地图 JS API Key。')
    if (!securityCode) throw new Error('请先在「连接与隐私」设置中配置高德 JS API 安全密钥。')
    const proxy = getAmapMapProxy()
    proxy.setSecurityCode(securityCode)
    return { jsKey, serviceHost: await proxy.serviceHost() }
  })
  handleTrustedIpc('model:test', () => agent.testConnection(vault, store))
  handleTrustedIpc('connector:test', async (_event, providerInput: unknown) => {
    if (!isBuiltinConnectorTestId(providerInput)) throw new Error('内置连接器测试类型无效。')
    const secretNames = {
      exa: 'exaKey',
      tavily: 'tavilyKey',
      firecrawl: 'firecrawlKey',
      amap: 'amapKey'
    } as const
    const labels: Record<BuiltinConnectorTestId, string> = {
      exa: 'Exa',
      tavily: 'Tavily',
      firecrawl: 'Firecrawl',
      amap: '高德 Web 服务'
    }
    const secretName = secretNames[providerInput]
    const apiKey = await vault.get(secretName)
    if (!apiKey) {
      const secrets = await vault.status()
      return {
        ok: false,
        message: secrets.credentialFileRecoveryRequired
          ? '本机凭证文件无法读取，请在连接设置中修复后重试。'
          : `请先在连接设置中填写 ${labels[providerInput]} Key。`
      }
    }
    return testBuiltinConnector(providerInput, apiKey)
  })
  handleTrustedIpc('agent:send', async (event, requestId: unknown, tripId: unknown, conversationId: unknown, content: unknown, resumeMessageId: unknown) => {
    if (typeof requestId !== 'string' || requestId.length > 100 || typeof tripId !== 'string' ||
      typeof conversationId !== 'string' || conversationId.length > 100 || typeof content !== 'string') {
      throw new Error('对话请求格式无效。')
    }
    if (resumeMessageId !== undefined && (typeof resumeMessageId !== 'string' || resumeMessageId.length > 100)) {
      throw new Error('待重新处理的消息标识无效。')
    }
    if (lockedTrips.has(tripId)) throw new Error('这趟旅行正在整理资料，请稍后再发送消息。')
    if (deletingConversations.has(`${tripId}:${conversationId}`)) throw new Error('该话题正在删除，请稍后再发送消息。')
    if (activeRequests.has(requestId)) throw new Error('此对话请求已经在运行。')
    if (activeAgentRunCount > 0) throw new Error('已有一轮规划正在运行，请等它完成或停止后再发送。')
    const controller = new AbortController()
    const modelSettings = store.snapshot().settings.model
    const modelName = modelSettings.provider === 'codex-cli' ? 'codex-cli:gpt-6-luna' : modelSettings.model
    const clearDeadline = armAgentDeadline(controller, modelName)
    activeRequests.set(requestId, { tripId, conversationId, controller })
    activeAgentRunCount += 1
    const researchBrowser = dependencies.getResearchBrowser() ?? undefined
    /** 只向仍存活的请求窗口发送 Agent 进度与结果事件。 */
    const emit = (agentEvent: AgentEvent): void => {
      if (!event.sender.isDestroyed()) event.sender.send('agent:event', agentEvent)
    }
    try {
      researchBrowser?.setAgentReadOnlyMode(true)
      await agent.run(
        store, vault, tripId, content, requestId, controller.signal, emit, resumeMessageId, conversationId,
        researchBrowser
      )
    } catch (error) {
      const timedOut = isAgentTimeout(controller.signal)
      const message = timedOut
        ? agentTimeoutMessage(modelName)
        : error instanceof Error ? error.message : '本次规划未能完成。'
      emit({ requestId, tripId, conversationId, type: 'error', message })
    } finally {
      researchBrowser?.setAgentReadOnlyMode(false)
      activeAgentRunCount = Math.max(0, activeAgentRunCount - 1)
      clearDeadline()
      activeRequests.delete(requestId)
    }
  })
  handleTrustedIpc('agent:cancel', (_event, requestId: unknown) => {
    if (typeof requestId === 'string') activeRequests.get(requestId)?.controller.abort()
  })
  handleTrustedIpc('revision:save', async (_event, tripId: unknown, conversationId: unknown, messageId: unknown, itineraryId: unknown) => {
    if (typeof tripId !== 'string' || typeof conversationId !== 'string' || typeof messageId !== 'string') throw new Error('行程版本请求无效。')
    if (itineraryId !== undefined && typeof itineraryId !== 'string') throw new Error('候选行程 ID 无效。')
    await store.saveRevision(tripId, messageId, itineraryId, conversationId)
    return appSnapshot()
  })
  handleTrustedIpc('revision:set-option-rejected', async (_event, tripId: unknown, conversationId: unknown, messageId: unknown, itineraryId: unknown, rejected: unknown) => {
    if (typeof tripId !== 'string' || typeof conversationId !== 'string' || typeof messageId !== 'string' ||
      typeof itineraryId !== 'string' || typeof rejected !== 'boolean') {
      throw new Error('候选方案审核请求无效。')
    }
    await store.setItineraryOptionRejected(tripId, messageId, itineraryId, rejected, conversationId)
    return appSnapshot()
  })
  handleTrustedIpc('revision:save-edited', async (_event, tripId: unknown, baseRevisionId: unknown, itinerary: unknown) => {
    if (typeof tripId !== 'string' || typeof baseRevisionId !== 'string') throw new Error('行程修改请求无效。')
    await store.saveEditedRevision(tripId, baseRevisionId, itinerary)
    return appSnapshot()
  })
  handleTrustedIpc('places:map-search', async (_event, tripId: unknown, city: unknown, query: unknown) => {
    if (typeof tripId !== 'string' || typeof city !== 'string' || typeof query !== 'string' ||
      city.trim().length < 1 || city.trim().length > 80 || query.trim().length < 1 || query.trim().length > 180) {
      throw new Error('地点定位请求无效。')
    }
    const trip = store.snapshot().trips.find((item) => item.id === tripId)
    if (!trip) throw new Error('找不到这趟旅行。')
    if (!store.snapshot().settings.connectors.places) throw new Error('地点连接器已关闭，请在设置中启用后再定位。')
    const finishQuery = trackTripQuery(tripId)
    try {
      const amapKey = await vault.get('amapKey')
      if (!amapKey) throw new Error('请先在「连接与隐私」设置中配置高德 Web 服务 Key。')
      const result = await searchMapPlaceCandidates(city.trim(), query.trim(), amapKey)
      const sourceIds = await store.saveSources(tripId, result.sources)
      const savedTrip = store.snapshot().trips.find((item) => item.id === tripId)
      return sourceIds.map((id) => savedTrip?.sources.find((source) => source.id === id)).filter((source): source is SourceRecord => !!source)
    } finally {
      finishQuery()
    }
  })
  handleTrustedIpc('routes:estimate', async (_event, tripId: unknown, city: unknown, origin: unknown, destination: unknown, mode: unknown, date: unknown, time: unknown) => {
    if (typeof tripId !== 'string' || tripId.length > 100 || typeof city !== 'string' || city.trim().length < 1 || city.trim().length > 80 ||
      typeof origin !== 'string' || origin.trim().length < 1 || origin.trim().length > 120 ||
      typeof destination !== 'string' || destination.trim().length < 1 || destination.trim().length > 120 ||
      !['transit', 'walking', 'driving'].includes(String(mode)) ||
      (date !== undefined && (typeof date !== 'string' || date.length > 10)) ||
      (time !== undefined && (typeof time !== 'string' || time.length > 5))) {
      throw new Error('路线估算请求无效。')
    }
    if (typeof date === 'string' && date.trim()) validateBriefDates({ startDate: date.trim() })
    if (typeof time === 'string' && time.trim() && !/^(?:[01]?\d|2[0-3])-[0-5]\d$/.test(time.trim())) {
      throw new Error('公共交通出发时刻需使用 H-MM 或 HH-MM。')
    }
    const finishQuery = trackTripQuery(tripId)
    try {
      const data = store.snapshot()
      if (!data.trips.some((trip) => trip.id === tripId)) throw new Error('找不到这趟旅行。')
      if (!data.settings.connectors.routes) throw new Error('路线连接器已关闭，请在设置中启用后再估算。')
      const amapKey = await vault.get('amapKey')
      if (!amapKey) throw new Error('请先在「连接与隐私」设置中配置高德 Web 服务 Key。')
      const result = await executeTool('estimate_route', JSON.stringify({
        city: city.trim(), origin: origin.trim(), destination: destination.trim(), mode,
        ...(typeof date === 'string' && date.trim() ? { date: date.trim() } : {}),
        ...(typeof time === 'string' && time.trim() ? { time: time.trim() } : {})
      }), { amapKey, connectors: data.settings.connectors })
      const sourceIds = await store.saveSources(tripId, result.sources)
      const savedTrip = store.snapshot().trips.find((trip) => trip.id === tripId)
      const source = sourceIds.map((id) => savedTrip?.sources.find((item) => item.id === id)).find((item) => !!item)
      return {
        output: result.output,
        options: result.routeOptions ?? [],
        ...(source ? { source } : {})
      }
    } finally {
      finishQuery()
    }
  })
  handleTrustedIpc('preparation:save', async (_event, tripId: unknown, conversationId: unknown, messageId: unknown) => {
    if (typeof tripId !== 'string' || typeof conversationId !== 'string' || typeof messageId !== 'string') throw new Error('准备清单请求无效。')
    await store.savePreparationItems(tripId, messageId, conversationId)
    return appSnapshot()
  })
  handleTrustedIpc('preparation:set-checked', async (_event, tripId: unknown, itemId: unknown, checked: unknown) => {
    if (typeof tripId !== 'string' || typeof itemId !== 'string' || typeof checked !== 'boolean') {
      throw new Error('准备事项更新请求无效。')
    }
    await store.setPreparationItemChecked(tripId, itemId, checked)
    return appSnapshot()
  })
  handleTrustedIpc('preparation:update', async (_event, tripId: unknown, itemId: unknown, update: unknown) => {
    if (typeof tripId !== 'string' || typeof itemId !== 'string') throw new Error('准备事项修改请求无效。')
    await store.updatePreparationItem(tripId, itemId, update)
    return appSnapshot()
  })
  handleTrustedIpc('preparation:delete', async (_event, tripId: unknown, itemId: unknown) => {
    if (typeof tripId !== 'string' || typeof itemId !== 'string') throw new Error('准备事项删除请求无效。')
    await store.deletePreparationItem(tripId, itemId)
    return appSnapshot()
  })
  handleTrustedIpc('revision:activate', async (_event, tripId: unknown, revisionId: unknown) => {
    if (typeof tripId !== 'string' || typeof revisionId !== 'string') throw new Error('行程版本请求无效。')
    await store.activateRevision(tripId, revisionId)
    return appSnapshot()
  })
  handleTrustedIpc('research:navigate', async (_event, input: unknown) => {
    requireMainWindow()
    await requireResearchBrowser().navigate(input)
  })
  handleTrustedIpc('research:navigate-history', (_event, input: unknown) => {
    requireMainWindow()
    if (input !== 'back' && input !== 'forward' && input !== 'reload') throw new Error('网页导航动作无效。')
    requireResearchBrowser().navigateHistory(input)
  })
  handleTrustedIpc('research:set-bounds', (_event, input: BrowserBounds) => {
    requireMainWindow()
    if (!input || typeof input !== 'object') return
    requireResearchBrowser().setBounds(input)
  })
  handleTrustedIpc('research:read-visible-page', async () => {
    return requireResearchBrowser().readVisiblePage()
  })
  handleTrustedIpc('research:import-visible-page', async (_event, tripId: unknown) => {
    if (typeof tripId !== 'string') throw new Error('旅行 ID 无效。')
    const finishQuery = trackTripQuery(tripId)
    try {
      const page = await requireResearchBrowser().readVisiblePage()
      if (page.accessState === 'login-required') throw new Error('当前页面需要登录，尚未保存；请在右侧手动登录后再试。')
      if (page.accessState === 'verification-required') throw new Error('当前页面要求人工验证，尚未保存；请手动处理或改用公开来源。')
      const record: SourceRecord = {
        id: randomUUID(),
        title: page.title,
        url: page.url,
        provider: '网页导入',
        kind: 'user',
        summary: page.text,
        fetchedAt: new Date().toISOString(),
        status: 'success',
        sourceNature: sourceNatureFor(page.url, 'user'),
        ...(isResearchSearchResultsUrl(page.url) ? { contentLevel: 'snippet' as const } : {}),
        ...(page.declaredAuthor ? { declaredAuthor: page.declaredAuthor } : {}),
        ...(page.declaredPublishedAt ? { declaredPublishedAt: page.declaredPublishedAt } : {})
      }
      await store.saveSources(tripId, [record])
      return appSnapshot()
    } finally {
      finishQuery()
    }
  })
  handleTrustedIpc('research:import-pasted-content', async (_event, tripId: unknown, input: unknown) => {
    if (typeof tripId !== 'string') throw new Error('旅行 ID 无效。')
    const finishQuery = trackTripQuery(tripId)
    try {
      await store.saveSources(tripId, [createUserProvidedSource(input)])
      return appSnapshot()
    } finally {
      finishQuery()
    }
  })
}
