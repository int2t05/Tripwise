/** 为隔离网页施加 Chromium 连接边界，保留正常网页浏览与跳转。 */
export const RESEARCH_CONNECTION_ALLOWLIST = '("http://*/*" "https://*/*"); redirects=allow; webrtc=block'

export type ResearchResponseHeaders = Record<string, string | string[]>

/** 用应用策略覆盖站点同名响应头，防止远端策略削弱 WebRTC 限制。 */
export function enforceResearchConnectionAllowlist(
  responseHeaders: ResearchResponseHeaders = {}
): ResearchResponseHeaders {
  const nextHeaders: ResearchResponseHeaders = {}

  for (const [name, value] of Object.entries(responseHeaders)) {
    if (name.toLowerCase() !== 'connection-allowlist') {
      nextHeaders[name] = value
    }
  }

  nextHeaders['Connection-Allowlist'] = [RESEARCH_CONNECTION_ALLOWLIST]
  return nextHeaders
}
