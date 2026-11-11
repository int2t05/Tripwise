/** 校验用于公开旅行资料的可选网络代理；凭证不写入普通设置。 */
export interface SessionProxyConfig {
  mode: 'system' | 'fixed_servers'
  proxyRules?: string
  proxyBypassRules?: string
}

/** 仅接受无认证的 HTTP、HTTPS 或 SOCKS5 代理地址。 */
export function normalizeSourceProxy(input: unknown): string {
  if (typeof input !== 'string' || input.length > 512 || input.includes('\0')) {
    throw new Error('来源代理地址无效。')
  }
  const value = input.trim()
  if (!value) return ''

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('来源代理地址无效。')
  }

  const hasPath = !!url.pathname && url.pathname !== '/'
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname ||
    url.username || url.password || hasPath || url.search || url.hash) {
    throw new Error('来源代理需为不含账号密码、路径或查询参数的 HTTP、HTTPS 或 SOCKS5 地址。')
  }
  return `${url.protocol}//${url.host}`
}

/** 空地址使用系统代理；有地址时让 Chromium 网络栈统一转发资料请求。 */
export function sourceProxyConfig(value: string): SessionProxyConfig {
  const normalized = normalizeSourceProxy(value)
  return normalized
    ? { mode: 'fixed_servers', proxyRules: normalized }
    : { mode: 'system' }
}

/** 判断持久化代理值是否为已规范化的合法地址。 */
export function isNormalizedSourceProxy(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return normalizeSourceProxy(value) === value
  } catch {
    return false
  }
}
