/** 校验 MCP 传输、远程地址和认证引用；秘密值只流向凭证库。 */
import { randomUUID } from 'node:crypto'
import type { McpServerAuth, McpServerSettings, McpTransport } from '../../shared/types.js'
import { normalizeRemoteMcpUrl } from '../../shared/mcp-config.js'

export interface McpEnvironmentInput {
  key: string
  value: string
}

/** 标准化 stdio、Streamable HTTP 与 SSE 配置，并将秘密值同普通设置分离。 */
export function normalizeMcpServer(input: unknown, current?: McpServerSettings): {
  server: McpServerSettings
  environment: McpEnvironmentInput[]
} {
  if (!isRecord(input) || !hasOnlyKeys(input, [
    'id', 'name', 'transport', 'command', 'args', 'url', 'auth', 'enabled', 'allowedTools', 'environment'
  ])) throw new Error('MCP 服务配置格式无效。')

  const id = input.id === undefined ? randomUUID() : input.id
  const name = boundedText(input.name, 1, 80, '服务名称')
  const transport = normalizeTransport(input.transport ?? current?.transport ?? 'stdio')
  if (!isId(id) || (current && current.id !== id) || (!current && input.id !== undefined)) {
    throw new Error('MCP 服务 ID 无效。')
  }
  if (!Array.isArray(input.args) || input.args.length > 40 || !input.args.every((item) => typeof item === 'string' && item.length <= 1_000)) {
    throw new Error('启动参数无效；最多支持 40 项，每项不超过 1,000 个字符。')
  }
  if (input.args.some((item) => item.includes('\0'))) throw new Error('启动参数不能包含 NUL 字符。')
  if (typeof input.enabled !== 'boolean' || !Array.isArray(input.allowedTools) || input.allowedTools.length > 50 ||
    !input.allowedTools.every((item) => typeof item === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(item)) ||
    new Set(input.allowedTools).size !== input.allowedTools.length) {
    throw new Error('MCP 工具授权设置无效。')
  }
  if (!Array.isArray(input.environment) || input.environment.length > 20) throw new Error('密钥配置最多支持 20 项。')

  const environment = input.environment.map((item) => {
    if (!isRecord(item) || !hasOnlyKeys(item, ['key', 'value']) ||
      typeof item.key !== 'string' || !/^[A-Z_][A-Z0-9_]{0,99}$/.test(item.key) ||
      typeof item.value !== 'string' || item.value.length > 8_000 || item.value.includes('\0')) {
      throw new Error('MCP 密钥名称或值无效。名称需使用大写字母、数字和下划线。')
    }
    return { key: item.key, value: item.value }
  })
  const envKeys = environment.map((item) => item.key)
  if (new Set(envKeys).size !== envKeys.length) throw new Error('MCP 密钥名称不能重复。')

  let command = ''
  let args = input.args.map((item) => item.trim())
  let url: string | undefined
  let auth: McpServerAuth | undefined
  if (transport === 'stdio') {
    command = boundedText(input.command, 1, 512, '启动命令')
    if (input.url !== undefined || input.auth !== undefined) throw new Error('stdio 服务不能配置远程地址或认证。')
  } else {
    if (typeof input.command === 'string' && input.command.trim()) throw new Error('远程 MCP 不需要启动命令。')
    if (args.length) throw new Error('远程 MCP 不需要启动参数。')
    args = []
    url = normalizeRemoteMcpUrl(input.url)
    auth = normalizeMcpAuth(input.auth ?? current?.auth ?? { type: 'none' }, envKeys, url)
  }

  return {
    server: {
      id,
      name,
      transport,
      command,
      args,
      ...(url ? { url } : {}),
      ...(auth ? { auth } : {}),
      envKeys,
      enabled: input.enabled && input.allowedTools.length > 0,
      allowedTools: [...input.allowedTools]
    },
    environment
  }
}

/** 校验传输标识；缺失旧值由调用方先补为 stdio。 */
function normalizeTransport(value: unknown): McpTransport {
  if (value === 'stdio' || value === 'streamable-http' || value === 'sse') return value
  throw new Error('MCP 传输方式无效。')
}

/** 认证配置只保存凭证引用，拒绝把值、认证头或 token 写入普通设置。 */
function normalizeMcpAuth(value: unknown, envKeys: string[], remoteUrl: string): McpServerAuth {
  if (!isRecord(value) || typeof value.type !== 'string') throw new Error('远程 MCP 认证配置无效。')
  if (value.type === 'none' && hasOnlyKeys(value, ['type'])) return { type: 'none' }
  if (value.type !== 'header' && value.type !== 'query') throw new Error('远程 MCP 认证方式无效。')

  if (value.type === 'query' && value.credential === 'amapKey' && hasOnlyKeys(value, ['type', 'name', 'credential'])) {
    if (value.name !== 'key' || new URL(remoteUrl).hostname !== 'mcp.amap.com' || new URL(remoteUrl).searchParams.has('key')) {
      throw new Error('高德认证参数配置无效。')
    }
    return { type: 'query', name: 'key', credential: 'amapKey' }
  }

  if (!hasOnlyKeys(value, ['type', 'name', 'envKey']) || typeof value.name !== 'string' ||
    typeof value.envKey !== 'string' || !/^[A-Z_][A-Z0-9_]{0,99}$/.test(value.envKey) || !envKeys.includes(value.envKey)) {
    throw new Error('远程 MCP 认证凭证必须引用已保存的密钥项。')
  }
  if (value.type === 'header') {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(value.name) ||
      isProtectedMcpHeader(value.name)) {
      throw new Error('远程 MCP 认证请求头名称无效或受保护。')
    }
    return { type: 'header', name: value.name, envKey: value.envKey }
  }

  if (!/^[A-Za-z0-9_.~-]{1,100}$/.test(value.name) || new URL(remoteUrl).searchParams.has(value.name)) {
    throw new Error('远程 MCP 认证查询参数名称无效或与地址冲突。')
  }
  return { type: 'query', name: value.name, envKey: value.envKey }
}

/** 防止凭证配置覆盖 HTTP framing、内容协商或 MCP 路由协议头。 */
function isProtectedMcpHeader(name: string): boolean {
  return /^(?:host|content-length|connection|transfer-encoding|cookie|origin|accept|content-type|mcp-session-id|mcp-protocol-version|mcp-method|mcp-name)$/i.test(name) ||
    /^mcp-param-/i.test(name)
}

/** 接受 MCP 服务端保存的标准化 ID。 */
function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)
}

/** 读取受限长度的文本，避免控制字符和首尾空格污染设置。 */
function boundedText(value: unknown, min: number, max: number, label: string): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${label}需为 ${min}–${max} 个有效字符。`)
  }
  return value.trim()
}

/** 明确限制 renderer 可提交的 MCP 配置字段。 */
function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

/** 窄化 IPC 输入对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
