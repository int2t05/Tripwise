/** 统一校验 MCP 单项重试参数，避免敏感查询进入本地记录或备份。 */

const MAX_RETRY_JSON_LENGTH = 20_000
const MAX_RETRY_NODES = 1_000
const MAX_RETRY_DEPTH = 8
const MAX_RETRY_COLLECTION_LENGTH = 100
const MAX_RETRY_STRING_LENGTH = 4_000
const MAX_RETRY_KEY_LENGTH = 200
const CREDENTIAL_FIELD_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|cookie)/i
const CREDENTIAL_VALUE_PATTERN = /(?:bearer\s+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization)\s*[:=]\s*)[a-z0-9._~+/-]{8,}/i

/** 校验普通 JSON 参数的大小、嵌套结构和凭证特征。 */
export function isSafeMcpRetryArguments(value: unknown): value is Record<string, unknown> {
  try {
    if (!isPlainRecord(value)) return false
    if (JSON.stringify(value).length > MAX_RETRY_JSON_LENGTH) return false
    return visitRetryValue(value, 0, { nodes: 0 })
  } catch {
    return false
  }
}

/** 递归限制单项重试数据，拒绝非 JSON 值及常见凭证内容。 */
function visitRetryValue(value: unknown, depth: number, state: { nodes: number }): boolean {
  state.nodes += 1
  if (state.nodes > MAX_RETRY_NODES || depth > MAX_RETRY_DEPTH) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') {
    return value.length <= MAX_RETRY_STRING_LENGTH && !CREDENTIAL_VALUE_PATTERN.test(value)
  }
  if (Array.isArray(value)) {
    return value.length <= MAX_RETRY_COLLECTION_LENGTH && value.every((item) => visitRetryValue(item, depth + 1, state))
  }
  if (!isPlainRecord(value)) return false

  const entries = Object.entries(value)
  return entries.length <= MAX_RETRY_COLLECTION_LENGTH && entries.every(([key, item]) =>
    key.length <= MAX_RETRY_KEY_LENGTH && !CREDENTIAL_FIELD_PATTERN.test(key) && visitRetryValue(item, depth + 1, state)
  )
}

/** 仅接受普通对象，避免序列化自定义实例时触发未预期行为。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
