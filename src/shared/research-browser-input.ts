/** 将研究浏览器地址栏输入解析为网址导航或公开网页搜索。 */

export type ResearchBrowserTarget = { kind: 'url' | 'search'; url: string }

const SEARCH_ENDPOINT = 'https://www.bing.com/search/'
const MAX_SEARCH_QUERY_LENGTH = 300

/** 构造小红书站内公开搜索地址，避免把站内检索依赖在通用搜索引擎索引上。 */
export function buildXiaohongshuSearchUrl(query: string): string {
  const normalized = query.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (!normalized) throw new Error('请输入小红书搜索词。')
  if (normalized.length > MAX_SEARCH_QUERY_LENGTH) throw new Error(`搜索词不能超过 ${MAX_SEARCH_QUERY_LENGTH} 个字符。`)
  const url = new URL('https://www.xiaohongshu.com/search_result/')
  url.searchParams.set('keyword', normalized)
  url.searchParams.set('source', 'web_explore_feed')
  return url.href
}

/** 将完整网址直接打开；普通文字作为搜索词提交给 Bing。 */
export function resolveResearchBrowserInput(input: unknown): ResearchBrowserTarget {
  if (typeof input !== 'string') throw new Error('请输入网页地址或搜索词。')
  const value = input.trim()
  if (!value) throw new Error('请输入网页地址或搜索词。')

  if (/^https?:\/\//iu.test(value)) return { kind: 'url', url: normalizeHttpUrl(value) }
  if (/^[a-z][a-z\d+.-]*:/iu.test(value)) throw new Error('网页地址只支持 HTTP(S)。')

  const directUrl = parseHttpUrl(`https://${value}`)
  if (directUrl && !/\s/u.test(value) && directUrl.hostname.includes('.')) {
    return { kind: 'url', url: directUrl.href }
  }

  if (value.length > MAX_SEARCH_QUERY_LENGTH) throw new Error(`搜索词不能超过 ${MAX_SEARCH_QUERY_LENGTH} 个字符。`)
  const searchUrl = new URL(SEARCH_ENDPOINT)
  searchUrl.searchParams.set('q', value)
  if (searchUrl.href.length > 4_000) throw new Error('搜索词过长，请缩短后重试。')
  return { kind: 'search', url: searchUrl.href }
}

/** 识别内置搜索结果页；摘要只能帮助找到原始页面。 */
export function isResearchSearchResultsUrl(input: string): boolean {
  try {
    const url = new URL(input)
    const hostname = url.hostname.toLowerCase()
    const duckDuckGo = hostname === 'html.duckduckgo.com' && url.pathname === '/html/'
    const bing = (hostname === 'bing.com' || hostname.endsWith('.bing.com')) && url.pathname.replace(/\/$/u, '') === '/search'
    const xiaohongshu = ['xiaohongshu.com', 'www.xiaohongshu.com'].includes(hostname) &&
      url.pathname.replace(/\/$/u, '') === '/search_result' && url.searchParams.has('keyword')
    return url.protocol === 'https:' && ((duckDuckGo || bing) && url.searchParams.has('q') || xiaohongshu)
  } catch {
    return false
  }
}

/** 规范 HTTP(S) 地址的常见格式错误，交由主进程继续执行公网地址校验。 */
function normalizeHttpUrl(value: string): string {
  const parsed = parseHttpUrl(value)
  if (!parsed) throw new Error('网页地址格式不正确。')
  return parsed.href
}

/** 只解析 HTTP(S) 绝对地址；是否允许访问由隔离浏览器主进程判断。 */
function parseHttpUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return undefined
    return parsed
  } catch {
    return undefined
  }
}
