/** 共享远程 MCP 地址校验，确保凭证不写入普通设置文件。 */

const SENSITIVE_QUERY_KEY = /(?:^key$|api[_-]?key|access[_-]?token|auth(?:orization)?|cookie|credential|password|secret|session|signature|token|xsec[_-]?token)/i

/** 判断查询参数名是否可能承载访问凭证。 */
export function isSensitiveMcpQueryKey(value: string): boolean {
  return SENSITIVE_QUERY_KEY.test(value)
}

/** 仅接受安全远程地址或回环开发地址，并拒绝内嵌凭证。 */
export function normalizeRemoteMcpUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 2_048 || /[\u0000-\u0020]/.test(value)) {
    throw new Error('远程 MCP 地址无效。')
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('远程 MCP 地址无效。')
  }
  const loopback = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
    url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if ((!loopback && url.protocol !== 'https:') || (loopback && !['http:', 'https:'].includes(url.protocol)) ||
    !url.hostname || url.username || url.password || url.hash ||
    [...url.searchParams.keys()].some(isSensitiveMcpQueryKey)) {
    throw new Error('远程 MCP 仅支持 HTTPS（本机回环可用 HTTP），且地址不能包含凭证或片段。')
  }
  return url.href
}
