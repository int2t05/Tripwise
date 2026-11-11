/** 管理旅行规划可用的本机 MCP 只读工具，并清理每轮创建的子进程。 */
import { createHash } from 'node:crypto'
import {
  Client, SSEClientTransport, StreamableHTTPClientTransport,
  type Tool, type Transport
} from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { McpServerSettings, McpToolDescriptor, SourceRecord, SourceRetry } from '../../shared/types.js'
import { isSensitiveMcpQueryKey } from '../../shared/mcp-config.js'
import { isSafeMcpRetryArguments } from '../../shared/mcp-retry-safety.js'
import { createSource, type ToolDefinition, type ToolResult } from '../connectors/types.js'
import { sourceNatureFor, sourceNatureLabel } from '../../shared/source-provenance.js'

/** MCP runtime 只依赖主进程提供的凭证读取能力。 */
export interface McpSecretProvider {
  getMcpEnvironment(serverId: string, keys: string[]): Promise<Record<string, string>>
  getAmapKey?(): Promise<string | null>
}

const CONNECT_TIMEOUT_MS = 12_000
const TOOL_TIMEOUT_MS = 45_000
const MAX_TOOL_SCHEMA_LENGTH = 12_000
const MAX_TOOL_OUTPUT_LENGTH = 12_000
const MAX_TOOL_TEXT_LENGTH = 8_000
const MAX_ACTIVE_TOOLS = 24
const MAX_SOURCE_LINKS = 20
const MCP_RETRY_UNAVAILABLE_NOTE = '为保护旅行资料，Tripwise 未保存该查询的单项重试参数；如需重试，请在新一轮对话重新提出。'
const SENSITIVE_LINK_FRAGMENT = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|cookie|credential|password|secret|session|signature|token|xsec[_-]?token)/i
const MCP_HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi

interface ActiveTool {
  server: McpServerSettings
  tool: Tool
  definition: ToolDefinition
  client: Client
  redactions: string[]
}

interface McpConnection {
  client: Client
  tools: Tool[]
  redactions: string[]
}

/** 一轮对话内打开 MCP 服务并提供白名单工具；结束时统一关闭子进程。 */
export class McpToolSession {
  private readonly activeTools = new Map<string, ActiveTool>()
  private readonly clients: Client[] = []
  readonly unavailable: string[] = []
  readonly diagnostics: SourceRecord[] = []

  /** 限制运行时由 open 创建，以保证服务会话与取消信号绑定。 */
  private constructor() {}

  /** 连接启用的服务，仅接纳用户授权且明确标记只读的工具。 */
  static async open(servers: McpServerSettings[], vault: McpSecretProvider, signal: AbortSignal): Promise<McpToolSession> {
    const session = new McpToolSession()
    if (signal.aborted) return session
    let remainingTools = MAX_ACTIVE_TOOLS
    let toolLimitReported = false
    const configured = servers.filter((item) => item.enabled && item.allowedTools.length).flatMap((server) => {
      if (remainingTools <= 0) {
        if (!toolLimitReported) {
          session.unavailable.push(`本轮插件工具已达到 ${MAX_ACTIVE_TOOLS} 项上限。`)
          toolLimitReported = true
        }
        return []
      }
      const selected = server.allowedTools.slice(0, remainingTools)
      remainingTools -= selected.length
      if (selected.length < server.allowedTools.length) {
        session.unavailable.push(`${server.name}：本轮仅加载前 ${selected.length} 项已批准工具。`)
      }
      return [{ ...server, allowedTools: selected }]
    })
    const connected = await Promise.all(configured.map(async (server) => {
      let environment: Record<string, string> = {}
      try {
        environment = await vault.getMcpEnvironment(server.id, server.envKeys)
        return { server, environment, connection: await connectServer(server, environment, vault, signal), error: null }
      } catch (error) {
        return { server, environment, connection: null, error: safeError(error) }
      }
    }))

    let capReported = false
    for (const result of connected) {
      if (result.error || !result.connection) {
        if (signal.aborted) continue
        const secrets = redactableSecrets(result.environment)
        const serverName = redactSecrets(result.server.name, secrets)
        const detail = redactSecrets(result.error ?? 'MCP 服务连接失败。', secrets)
        session.unavailable.push(`${serverName}：${detail}`)
        session.diagnostics.push(createMcpSource(
          result.server, `连接诊断 · ${serverName}`, '', detail, 'error', secrets,
          { kind: 'mcp-connect', serverId: result.server.id }
        ))
        continue
      }
      if (signal.aborted || session.activeTools.size >= MAX_ACTIVE_TOOLS) {
        await result.connection.client.close().catch(() => undefined)
        if (!signal.aborted && !capReported) {
          session.unavailable.push(`本轮插件工具已达到 ${MAX_ACTIVE_TOOLS} 项上限。`)
          capReported = true
        }
        continue
      }
      session.clients.push(result.connection.client)
      for (const tool of result.connection.tools) {
        if (!result.server.allowedTools.includes(tool.name) || !isSafeReadOnlyTool(tool, result.server)) continue
        if (session.activeTools.size >= MAX_ACTIVE_TOOLS) {
          if (!capReported) {
            session.unavailable.push(`本轮插件工具已达到 ${MAX_ACTIVE_TOOLS} 项上限。`)
            capReported = true
          }
          break
        }
        try {
          const secrets = [...redactableSecrets(result.environment), ...result.connection.redactions]
          const definition = createDefinition(result.server, tool, secrets)
          if (session.activeTools.has(definition.function.name)) continue
          session.activeTools.set(definition.function.name, {
            server: result.server,
            tool,
            definition,
            client: result.connection.client,
            redactions: [...redactableSecrets(result.environment), ...result.connection.redactions]
          })
        } catch (error) {
          const secrets = redactableSecrets(result.environment)
          const serverName = redactSecrets(result.server.name, secrets)
          const toolName = redactSecrets(tool.name, secrets)
          session.unavailable.push(`${serverName} · ${toolName}：${safeError(error)}`)
        }
      }
    }
    return session
  }

  /** 返回通过当前会话重新发现且获准使用的模型工具。 */
  definitions(): ToolDefinition[] {
    return [...this.activeTools.values()].map((item) => item.definition)
  }

  /** 返回当前已连接插件凭证，用于清理发往模型的工具上下文。 */
  redactionValues(): string[] {
    return [...new Set([...this.activeTools.values()].flatMap((item) => item.redactions))]
  }

  /** 返回面向用户的插件进度名称，不展示模型专用的哈希工具名。 */
  label(name: string): string | undefined {
    const active = this.activeTools.get(name)
    return active
      ? `正在使用 ${redactSecrets(active.server.name, active.redactions)} · ${redactSecrets(active.tool.name, active.redactions)}`
      : undefined
  }

  /** 只执行当前连接中通过用户授权的工具，并将返回值作为不可信来源保存。 */
  async execute(name: string, rawArguments: string, signal: AbortSignal): Promise<ToolResult> {
    const active = this.activeTools.get(name)
    if (!active) return {
      output: '该插件工具当前不可用或未获准。', sources: [],
      feedback: [{ severity: 'warning', code: 'mcp_tool_unavailable', message: '插件连接或工具授权当前不可用。' }]
    }
    if (rawArguments.length > 20_000) return {
      output: '工具参数过长，请重新生成本次请求。', sources: [],
      feedback: [{ severity: 'error', code: 'invalid_arguments_length', message: '工具参数超过允许长度。' }]
    }

    let args: unknown
    try {
      args = JSON.parse(rawArguments)
    } catch {
      return {
        output: '工具参数不是有效 JSON，请重新生成本次请求。', sources: [],
        feedback: [{ severity: 'error', code: 'invalid_json', message: '工具参数不是有效 JSON。' }]
      }
    }
    if (!isRecord(args)) return {
      output: '工具参数必须是 JSON 对象，请重新生成本次请求。', sources: [],
      feedback: [{ severity: 'error', code: 'invalid_arguments', message: '工具参数必须是 JSON 对象。' }]
    }
    const retry = createMcpToolRetry(active.server.id, active.tool.name, args, active.redactions)

    try {
      const result = await active.client.callTool(
        { name: active.tool.name, arguments: args },
        { timeout: TOOL_TIMEOUT_MS, signal }
      )
      const output = redactSecrets(formatResult(result.content, result.structuredContent), active.redactions)
      const links = resourceSourceLinks(result.content, active.redactions)
      const retryNotice = result.isError && !retry ? `\n${MCP_RETRY_UNAVAILABLE_NOTE}` : ''
      const sources = links.length
        ? links.slice(0, MAX_SOURCE_LINKS).map((link) => createMcpSource(
            active.server,
            `${active.tool.name} · ${link.title}`,
            link.url,
            redactSecrets(`${link.description || output}${retryNotice}`, active.redactions),
            result.isError ? 'error' : 'success',
            active.redactions,
            result.isError ? retry : undefined
          ))
        : [createMcpSource(
            active.server,
            `${active.server.name} · ${active.tool.name}`,
            '',
            `${output}${retryNotice}`,
            result.isError ? 'error' : 'success',
            active.redactions,
            result.isError ? retry : undefined
          )]
      const omittedLinks = links.length > MAX_SOURCE_LINKS ? `\n另有 ${links.length - MAX_SOURCE_LINKS} 条链接未单独保存到来源列表。` : ''
      const message = result.isError
        ? '插件返回了业务或服务错误；由 Agent 判断是否换来源或继续。'
        : '查询完成。'
      return {
        output: `${result.isError ? '插件返回错误' : '插件查询结果'}：${output}${retryNotice}${omittedLinks}`,
        sources,
        feedback: result.isError
          ? [{ severity: 'warning', code: 'mcp_tool_failed', message }]
          : []
      }
    } catch (error) {
      if (signal.aborted) throw error
      const detail = redactSecrets(safeError(error), active.redactions)
      const retryNotice = retry ? '' : `\n${MCP_RETRY_UNAVAILABLE_NOTE}`
      const source = createMcpSource(
        active.server, `${active.server.name} · ${active.tool.name}`, '', `${detail}${retryNotice}`, 'error', active.redactions, retry
      )
      return {
        output: `插件工具暂时不可用：${detail}${retryNotice}`,
        sources: [source],
        feedback: [{ severity: 'warning', code: 'mcp_provider_unavailable', message: '插件服务暂时不可用；可继续使用其他来源。' }]
      }
    }
  }

  /** 仅重连一个已启用服务，验证恢复状态后立即关闭本轮子进程。 */
  static async retryConnection(
    server: McpServerSettings,
    vault: McpSecretProvider,
    signal: AbortSignal
  ): Promise<ToolResult> {
    const session = await McpToolSession.open([server], vault, signal)
    try {
      if (signal.aborted) throw signal.reason ?? new Error('MCP 连接重试已取消。')
      const diagnostic = session.diagnostics[0]
      if (diagnostic) return { output: diagnostic.summary, sources: [diagnostic] }
      const count = session.definitions().length
      const summary = `连接成功；当前已授权 ${count} 项只读工具。`
      return {
        output: summary,
        sources: [createMcpSource(server, `连接检查 · ${server.name}`, '', summary, 'success')]
      }
    } finally {
      await session.close()
    }
  }

  /** 重新连接后只执行当前仍获准的同一只读工具，不扩大查询范围。 */
  static async retryReadOnlyTool(
    server: McpServerSettings,
    vault: McpSecretProvider,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<ToolResult> {
    const session = await McpToolSession.open([server], vault, signal)
    try {
      if (signal.aborted) throw signal.reason ?? new Error('MCP 工具重试已取消。')
      const diagnostic = session.diagnostics[0]
      if (diagnostic) return { output: diagnostic.summary, sources: [diagnostic] }
      const active = [...session.activeTools.entries()].find(([, tool]) =>
        tool.server.id === server.id && tool.tool.name === toolName
      )
      if (!active) throw new Error('该 MCP 工具已不在当前批准列表中，请重新发现并授权。')
      return await session.execute(active[0], JSON.stringify(args), signal)
    } finally {
      await session.close()
    }
  }

  /** 结束全部 MCP 客户端连接，SDK 会关闭各自的 stdio 子进程。 */
  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((client) => client.close()))
    this.clients.length = 0
    this.activeTools.clear()
  }
}

/** 创建可按稳定服务 ID 查询、且不包含 MCP 凭证的来源记录。 */
function createMcpSource(
  server: McpServerSettings,
  title: string,
  url: string,
  summary: string,
  status: SourceRecord['status'],
  redactions: string[] = [],
  retry?: SourceRetry
): SourceRecord {
  return {
    ...createSource(
      redactSecrets(title, redactions),
      url,
      `MCP · ${redactSecrets(server.name, redactions)}`,
      'plugin',
      redactSecrets(summary, redactions),
      status
    ),
    connectorId: server.id,
    ...(retry ? { retry } : {})
  }
}

/** 仅保存有界且不含凭证的 MCP 查询参数，供用户发起同一工具重试。 */
function createMcpToolRetry(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[]
): SourceRetry | undefined {
  if (containsSecretInJson(args, secrets) || !isSafeMcpRetryArguments(args)) return undefined
  try {
    const serialized = JSON.stringify(args)
    return { kind: 'mcp-tool', serverId, toolName, arguments: JSON.parse(serialized) as Record<string, unknown> }
  } catch {
    return undefined
  }
}

/** 在设置页临时启动单个服务，返回工具摘要后立即关闭进程。 */
export async function discoverMcpTools(
  server: McpServerSettings,
  vault: McpSecretProvider,
  signal = AbortSignal.timeout(CONNECT_TIMEOUT_MS * 2)
): Promise<McpToolDescriptor[]> {
  const environment = await vault.getMcpEnvironment(server.id, server.envKeys)
  const connection = await connectServer(server, environment, vault, signal)
  const secrets = [...redactableSecrets(environment), ...connection.redactions]
  try {
    return connection.tools.slice(0, 100).map((tool) => ({
      name: redactSecrets(tool.name.slice(0, 128), secrets),
      description: redactSecrets(sanitizeMcpText((tool.description ?? '').slice(0, 300)), secrets),
      readOnly: isSafeReadOnlyTool(tool, server),
      destructive: tool.annotations?.destructiveHint === true || isAmapSideEffectTool(server, tool.name)
    }))
  } finally {
    await connection.client.close()
  }
}

/** 创建一条不启用 shell、不过量继承环境变量且不转发 stderr 的本地连接。 */
async function connectServer(
  server: McpServerSettings,
  environment: Record<string, string>,
  vault: McpSecretProvider,
  signal: AbortSignal
): Promise<McpConnection> {
  // 新版协议用于 stdio 和 Streamable HTTP；旧 SSE 服务继续走原握手。
  const supportsStatelessProtocol = server.transport !== 'sse'
  const client = new Client(
    { name: 'tripwise-desktop', version: '0.1.0' },
    supportsStatelessProtocol ? { versionNegotiation: { mode: 'auto' } } : undefined
  )
  let configured: { transport: Transport; redactions: string[] }
  try {
    configured = await createTransport(server, environment, vault)
  } catch (error) {
    throw new Error(safeError(error))
  }
  try {
    await client.connect(configured.transport, { timeout: CONNECT_TIMEOUT_MS, signal })
    const result = await client.listTools({}, { timeout: CONNECT_TIMEOUT_MS, signal, cacheMode: 'bypass' })
    return { client, tools: result.tools, redactions: configured.redactions }
  } catch (error) {
    await client.close().catch(() => undefined)
    throw new Error(redactSecrets(safeError(error), configured.redactions))
  }
}

/** 按传输方式建立 MCP 客户端；远程凭证只在请求内存中注入。 */
async function createTransport(
  server: McpServerSettings,
  environment: Record<string, string>,
  vault: McpSecretProvider
): Promise<{ transport: Transport; redactions: string[] }> {
  const transportType = server.transport ?? 'stdio'
  if (transportType === 'stdio') {
    return {
      transport: new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: environment,
        stderr: 'ignore',
        maxBufferSize: 1_000_000
      }),
      redactions: redactableSecrets(environment)
    }
  }

  if (!server.url) throw new Error('远程 MCP 地址未配置。')
  const url = new URL(server.url)
  const auth = server.auth ?? { type: 'none' as const }
  const headers: Record<string, string> = {}
  const redactions: string[] = []
  if (auth.type !== 'none') {
    const value = 'credential' in auth ? await vault.getAmapKey?.() : environment[auth.envKey]
    if (!value?.trim()) {
      throw new Error('credential' in auth ? '高德 Web 服务 Key 尚未配置。' : 'MCP 认证密钥尚未配置。')
    }
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('MCP 认证密钥格式无效。')
    redactions.push(value)
    if (auth.type === 'query') url.searchParams.set(auth.name, value)
    else headers[auth.name] = value
  }

  const options = {
    requestInit: { headers, redirect: 'error' as const },
    fetch: createConfiguredFetch(url.origin, auth.type === 'query' ? auth.name : undefined,
      auth.type === 'query' ? redactions[0] : undefined),
    redirectPolicy: 'same-origin' as const
  }
  const transport = transportType === 'streamable-http'
    ? new StreamableHTTPClientTransport(url, options)
    : new SSEClientTransport(url, options)
  return { transport, redactions }
}

/** 限定 MCP 客户端请求主机并拒绝跳转，避免服务端诱导凭证跨主机发送。 */
function createConfiguredFetch(origin: string, queryName?: string, queryValue?: string): typeof fetch {
  return async (input, init) => {
    const inputUrl = input instanceof Request
      ? new URL(input.url)
      : input instanceof URL ? input : new URL(input)
    if (inputUrl.origin !== origin) throw new Error('远程 MCP 请求超出已配置的服务主机。')
    if (queryName && queryValue) inputUrl.searchParams.set(queryName, queryValue)
    const request = input instanceof Request ? new Request(inputUrl, input) : inputUrl
    return fetch(request, { ...init, redirect: 'error' })
  }
}

/** MCP 标注只是能力声明；版本一只允许显式标记只读且非破坏性的工具。 */
function isSafeReadOnlyTool(tool: Tool, server: McpServerSettings): boolean {
  return tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true &&
    !isAmapSideEffectTool(server, tool.name) && /^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name) && isRecord(tool.inputSchema)
}

/** 高德 MCP 的个人地图、导航、打车和票务动作可能产生外部效果，留给用户在应用外确认。 */
function isAmapSideEffectTool(server: McpServerSettings, toolName: string): boolean {
  if (server.transport !== 'streamable-http' || !server.url) return false
  try {
    const isAmapServer = new URL(server.url).hostname === 'mcp.amap.com'
    const usesAmapCredential = server.auth?.type === 'query' && 'credential' in server.auth && server.auth.credential === 'amapKey'
    if (!isAmapServer && !usesAmapCredential) return false
  } catch {
    return false
  }
  return /(?:personal[_-]?map|navigat|taxi|ride[_-]?hail|book|ticket|order)/i.test(toolName)
}

/** 将 MCP 工具名隔离进 OpenAI 函数命名空间，并限制 schema 体积。 */
function createDefinition(server: McpServerSettings, tool: Tool, secrets: string[]): ToolDefinition {
  const serverPart = server.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'server'
  const namePart = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 26) || 'tool'
  const digest = createHash('sha256').update(`${server.id}:${tool.name}`).digest('hex').slice(0, 10)
  const schemaText = JSON.stringify(tool.inputSchema)
  if (schemaText.length > MAX_TOOL_SCHEMA_LENGTH) throw new Error(`工具 ${tool.name} 的参数结构超过限制。`)
  if (containsSecret(tool.name, secrets) || containsSecretInJson(tool.inputSchema, secrets)) {
    throw new Error('工具标识或参数结构包含已配置凭证。')
  }
  if (containsSensitiveUrlInJson(tool.inputSchema)) {
    throw new Error('工具参数结构包含敏感链接。')
  }
  return {
    type: 'function',
    function: {
      name: `mcp_${serverPart}_${namePart}_${digest}`.slice(0, 64),
      description: redactSecrets(sanitizeMcpText(`[只读插件 ${server.name}] ${(tool.description ?? tool.name).slice(0, 800)}`), secrets),
      parameters: tool.inputSchema as Record<string, unknown>
    }
  }
}

/** 仅保留有限文本和安全 HTTP 链接，不将图片、二进制或任意对象交给模型。 */
function formatResult(content: unknown[], structuredContent: unknown): string {
  const text = content.flatMap((item) => {
    if (!isRecord(item)) return []
    if (item.type === 'text' && typeof item.text === 'string') return [sanitizeMcpText(item.text).slice(0, MAX_TOOL_TEXT_LENGTH)]
    if (item.type === 'resource_link' && typeof item.name === 'string') {
      const uri = typeof item.uri === 'string' ? safeResourceLinkUrl(item.uri) ?? '' : ''
      const nature = sourceNatureLabel(sourceNatureFor(uri, 'plugin'))
      return [`来源链接：${sanitizeMcpText(item.name).slice(0, 200)}${uri ? ` (${uri})` : ''}；渠道标签：${nature}（不代表事实已核验）`]
    }
    return []
  })
  if (!text.length && structuredContent !== undefined) {
    try {
      text.push(sanitizeMcpText(JSON.stringify(structuredContent)).slice(0, MAX_TOOL_TEXT_LENGTH))
    } catch {
      text.push('插件返回了无法显示的结构化内容。')
    }
  }
  return (text.join('\n').slice(0, MAX_TOOL_OUTPUT_LENGTH) || '插件没有返回可读取的文字。')
}

/** 校验动态 JSON 对象，避免数组或 null 被视为工具参数字典。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只保留无凭证的 HTTP(S) 来源链接，并去除片段和敏感查询参数。 */
function safeResourceLinkUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      [...url.searchParams.keys()].some(isSensitiveMcpQueryKey)) return undefined
    url.hash = ''
    return url.href
  } catch {
    return undefined
  }
}

/** 清理 MCP 文本中的敏感访问链接，并从其余网页地址移除片段。 */
function sanitizeMcpText(value: string): string {
  return value.replace(MCP_HTTP_URL_PATTERN, (candidate) =>
    safeResourceLinkUrl(candidate) ?? '[已隐藏含敏感访问参数的链接]'
  )
}

/** 拒绝会原样进入模型上下文的参数 schema 中的敏感 URL。 */
function containsSensitiveUrlInJson(value: unknown): boolean {
  if (typeof value === 'string') {
    return [...value.matchAll(MCP_HTTP_URL_PATTERN)].some(([candidate]) => isSensitiveMcpUrl(candidate))
  }
  if (Array.isArray(value)) return value.some(containsSensitiveUrlInJson)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, item]) =>
    containsSensitiveUrlInJson(key) || containsSensitiveUrlInJson(item)
  )
}

/** 检查 URL 凭证、敏感查询参数和疑似令牌片段。 */
function isSensitiveMcpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password || [...url.searchParams.keys()].some(isSensitiveMcpQueryKey)) return true
    return SENSITIVE_LINK_FRAGMENT.test(decodeURIComponent(url.hash.slice(1)))
  } catch {
    return true
  }
}

/** 从 MCP resource_link 内容块提取可点击的 HTTP(S) 地址。 */
function resourceLinkUrl(value: unknown): string {
  return isRecord(value) && value.type === 'resource_link' && typeof value.uri === 'string'
    ? safeResourceLinkUrl(value.uri) ?? ''
    : ''
}

/** 把插件明确返回的网页链接拆成独立来源卡，并去重和限制数量。 */
function resourceSourceLinks(content: unknown[], secrets: string[]): Array<{ title: string; url: string; description: string }> {
  const links: Array<{ title: string; url: string; description: string }> = []
  for (const item of content) {
    if (!isRecord(item) || item.type !== 'resource_link' || typeof item.name !== 'string') continue
    const rawUrl = resourceLinkUrl(item)
    if (!rawUrl) continue
    const url = containsSecret(rawUrl, secrets) ? '' : rawUrl
    const title = redactSecrets(sanitizeMcpText(item.name.trim()).slice(0, 200), secrets)
    if (!title || (url && links.some((link) => link.url === url))) continue
    const description = typeof item.description === 'string'
      ? sanitizeMcpText(item.description).slice(0, MAX_TOOL_TEXT_LENGTH)
      : ''
    links.push({ title, url, description: redactSecrets(description, secrets) })
  }
  return links
}

/** 检查外部 MCP 元数据是否直接包含已配置的长凭证。 */
function containsSecret(value: string, secrets: string[]): boolean {
  return secrets.some((secret) => new RegExp(secretPattern(secret), 'i').test(value))
}

/** 递归检查 MCP 参数结构中的键和值，防止服务把凭证伪装成 schema 元数据。 */
function containsSecretInJson(value: unknown, secrets: string[]): boolean {
  if (typeof value === 'string') return containsSecret(value, secrets)
  if (Array.isArray(value)) return value.some((item) => containsSecretInJson(item, secrets))
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, item]) => containsSecret(key, secrets) || containsSecretInJson(item, secrets))
}

/** 只映射已知的启动错误，避免把命令路径和服务返回细节发给模型。 */
function safeError(error: unknown): string {
  if (error instanceof Error && error.message === '高德 Web 服务 Key 尚未配置。') return error.message
  if (error instanceof Error && error.message === 'MCP 认证密钥尚未配置。') return error.message
  if (error instanceof Error && error.message === '远程 MCP 地址未配置。') return error.message
  if (error instanceof Error && error.message === 'MCP 认证密钥格式无效。') return error.message
  if (error instanceof Error && error.message === '找不到插件程序；请检查命令路径和安装状态。') return error.message
  if (error instanceof Error && error.message === '系统拒绝启动插件程序；请检查执行权限。') return error.message
  if (error instanceof Error && error.message === 'MCP 服务连接失败；请检查插件程序状态与协议兼容性。') return error.message
  if (error instanceof Error && error.message === 'MCP 服务连接超时或已取消。') return error.message
  if (error instanceof Error && error.message === '工具标识或参数结构包含已配置凭证。') {
    return '工具元数据包含已配置凭证，已跳过。'
  }
  if (error instanceof Error && error.message === '工具参数结构包含敏感链接。') {
    return 'MCP 工具参数结构包含敏感链接，已跳过。'
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return '找不到插件程序；请检查命令路径和安装状态。'
    if (code === 'EACCES' || code === 'EPERM') return '系统拒绝启动插件程序；请检查执行权限。'
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || /timeout|timed out/i.test(error.message))) {
    return 'MCP 服务连接超时或已取消。'
  }
  return 'MCP 服务连接失败；请检查插件程序状态与协议兼容性。'
}

/** 以较长密钥做文本及常见 URL 编码脱敏，避免把短选项全局替换。 */
function redactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => result.replace(new RegExp(secretPattern(secret), 'gi'), '[已隐藏凭证]'), value)
}

/** 同时识别原文、URI 百分号编码和表单查询常用的加号空格编码。 */
function secretPattern(secret: string): string {
  return [...secret].map((character) => {
    const raw = escapeRegExp(character)
    const encoded = [...new TextEncoder().encode(character)]
      .map((byte) => `%${byte.toString(16).padStart(2, '0')}`)
      .join('')
    return character === ' '
      ? `(?:\\s|\\+|${encoded})`
      : `(?:${raw}|${encoded})`
  }).join('')
}

/** 将普通文本转换为正则安全片段。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 短环境值可能是普通选项，不用于自动文本脱敏。 */
function redactableSecrets(environment: Record<string, string>): string[] {
  return Object.values(environment).filter((value) => value.length >= 4)
}
