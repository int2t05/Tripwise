/** 校验网页地址并分类出站保护可访问的公网目标。 */
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.lan',
  '.home.arpa',
  '.nip.io',
  '.sslip.io',
  '.localtest.me',
  '.lvh.me',
  '.vcap.me'
]
const SENSITIVE_QUERY_KEY = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|cookie|credential|password|secret|session|signature|token|xsec[_-]?token)/i

/** 只接受普通 HTTP(S) 域名；拒绝凭证、所有 IP 字面量和常见本地 DNS 名称。 */
export function normalizeResearchUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 4_000) throw new Error('网页地址无效。')
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('网页地址无效。')
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  const unbracketedHost = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  const localName = !hostname.includes('.') || hostname === 'localhost' ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))

  if (!['http:', 'https:'].includes(url.protocol) || !hostname || url.username || url.password ||
    isIP(unbracketedHost) || localName) {
    throw new Error('网页研究只支持不带凭证的 HTTP(S) 公网域名。')
  }

  // 统一去掉尾点，避免同一主机绕过本地名称判断。
  url.hostname = hostname
  return url.href
}

/** 清除链接中的访问凭证和片段，避免进入模型、来源卡或恢复点。 */
export function sanitizeResearchUrl(input: unknown): string {
  const url = new URL(normalizeResearchUrl(input))
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.delete(key)
  }
  url.hash = ''
  return url.href
}

/** 保存旅行来源时保留小红书笔记访问参数；其他 URL 凭证仍须清除。 */
export function sanitizeResearchSourceUrl(input: unknown): string {
  const url = new URL(normalizeResearchUrl(input))
  const isXiaohongshu = url.hostname === 'xiaohongshu.com' || url.hostname === 'www.xiaohongshu.com'
  for (const key of [...url.searchParams.keys()]) {
    if (isXiaohongshu && key.toLowerCase() === 'xsec_token') continue
    if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.delete(key)
  }
  url.hash = ''
  return url.href
}

/** 为模型上下文清理来源网址；缺失或无效的地址以空字符串表示。 */
export function modelSafeResearchUrl(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) return ''
  try {
    return sanitizeResearchUrl(input)
  } catch {
    return ''
  }
}

/** 为隔离网页会话阻止非网页协议及不安全的 HTTP(S) 目标请求。 */
export function shouldBlockResearchRequest(input: string): boolean {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return true
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:') return false
  if (!['http:', 'https:'].includes(url.protocol)) return true
  try {
    normalizeResearchUrl(url.href)
    return false
  } catch {
    return true
  }
}

/** 只接受被地址分类库标记为公网单播的 DNS 结果。 */
export function isPublicResearchAddress(input: string): boolean {
  try {
    return ipaddr.parse(input).range() === 'unicast'
  } catch {
    return false
  }
}
