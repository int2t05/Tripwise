/** 为关键旅行事实选择少量可直接阅读的搜索结果页面。 */
import type { ResearchBrowserLink, ResearchPageLink, SourceRecord } from '../shared/types.js'
import { itineraryPlaceNameAliases, itinerarySourceNamesPlace } from '../shared/itinerary-facts.js'
import type { BrowserLinkFailureKind, BrowserNavigationFailureKind } from './connectors/types.js'
import { normalizeResearchUrl } from './research-url.js'
import { isResearchSearchResultsUrl, resolveResearchBrowserInput } from '../shared/research-browser-input.js'
import { MAX_VISIBLE_RESEARCH_LINKS } from '../shared/research-browser-limits.js'
import { sourceNatureFor } from '../shared/source-provenance.js'

/** 限制单轮自动读取的公开网页数量，详细行程最多读取十八页。 */
const MAX_INITIAL_RESEARCH_PAGES = 18
/** 详细行程尽量覆盖用户点名地点；实际查询仍受本轮搜索总预算限制。 */
const MAX_INITIAL_ATTRACTION_SEARCHES = 18
/** 搜索服务失效时保留景点、餐饮和交通的有限浏览器回退额度。 */
export const MAX_BROWSER_FALLBACK_SEARCHES = MAX_INITIAL_ATTRACTION_SEARCHES + 2
/** 详细行程最多读取十八页正文，与正常来源预读预算一致。 */
export const MAX_BROWSER_FALLBACK_PAGES = MAX_INITIAL_RESEARCH_PAGES
/** 只对连续网络级导航故障熔断；HTTP、DNS、证书和站点拦截仍允许换源尝试。 */
export const MAX_BROWSER_NETWORK_FAILURE_STREAK = 3
/** 同一网页主机连续失败两次后，本轮跳过该主机并保留其他来源。 */
export const MAX_BROWSER_NETWORK_FAILURES_PER_HOST = 2
export type BrowserFallbackSearchIntent = 'meal' | 'community' | 'transit' | 'attraction' | 'general'
export type BrowserFallbackLinkMissReason =
  | 'no_actionable_links'
  | 'no_public_links'
  | 'attraction_name_missing'
  | 'attraction_name_not_found'
  | 'attraction_information_hint_missing'
  | 'government_fact_query_not_matched'
  | 'meal_result_not_found'
  | 'no_community_link'
  | 'community_query_not_matched'
  | 'government_transit_link_not_found'
  | 'general_relevance_below_threshold'
  | 'intent_policy_no_match'

/** 短请求为事实与餐馆补查增加专用额度，详细行程总量保持既有上限。 */
export function browserFallbackBudgetLimits(
  detailedItineraryRequested: boolean,
  factReservedWork = 0,
  mealReservedWork = 0
): { searches: number; pages: number } {
  const reservedWork = Math.max(0, Math.floor(factReservedWork)) + Math.max(0, Math.floor(mealReservedWork))
  const baseSearches = detailedItineraryRequested ? MAX_BROWSER_FALLBACK_SEARCHES : 2
  const basePages = detailedItineraryRequested ? initialResearchPageLimit(true) : 2
  const shortRequestReserve = detailedItineraryRequested ? 0 : reservedWork
  return {
    searches: baseSearches + shortRequestReserve,
    pages: basePages + shortRequestReserve
  }
}

/** 开链被 Chromium 中止时，只在当前浏览正文额度内允许一次直达恢复。 */
export function shouldRetryAbortedBrowserLink(input: {
  failureKind?: BrowserLinkFailureKind
  hasUnreservedPageBudget: boolean
  hasFactRepairReserve: boolean
  usedPages: number
  pageLimit: number
}): boolean {
  const usedPages = Math.max(0, Math.floor(input.usedPages))
  const pageLimit = Math.max(0, Math.floor(input.pageLimit))
  return input.failureKind === 'aborted' && usedPages < pageLimit &&
    (input.hasUnreservedPageBudget || input.hasFactRepairReserve)
}

const RETRYABLE_BROWSER_NETWORK_FAILURES = new Set<BrowserNavigationFailureKind>([
  'address_unreachable', 'connection_closed', 'connection_refused', 'connection_reset',
  'network', 'offline', 'proxy', 'timeout'
])
/** 每次搜索给模型少量高价值来源；完整结果仍保存到用户来源库。 */
/** 通用链接至少命中两个相邻词组，避免只凭目的地名打开无关页面。 */
const MIN_GENERAL_BROWSER_LINK_RELEVANCE = 4
/** 餐饮主题页命中目的地词即可打开；正文仍需单独核验门店名称。 */
const MIN_MEAL_HINTED_PAGE_RELEVANCE = 2
/** 没有餐饮主题提示时，社区页需更强相关性，其他页面需命中具体门店名。 */
const MIN_MEAL_COMMUNITY_LINK_RELEVANCE = 6
const MIN_NAMED_MEAL_PAGE_RELEVANCE = 8
/** 景点名缺席时，目的地游览页必须命中至少四个双字词，避免打开泛城市页面。 */
const MIN_DESTINATION_VISITOR_PAGE_RELEVANCE = 8
const ORIGINAL_SITE_HINT = /官方网站|官网|官方参观|官方预约|官方开放|参观须知/u
const VISITOR_INFO_HINT = /开放时间|开放时段|开放信息|预约|门票|票价|购票|票务|停止入园|闭馆|入园|入馆|入场|游客须知|参观须知|游园须知|参观指南|游览须知|入场须知|visitor information|opening hours|opening times|admission|tickets?/iu
const GOVERNMENT_FACT_PAGE_HINT = /开放|闭馆|预约|门票|票价|购票|游客须知|参观须知|游园须知|入园|入馆|入场|opening|booking|ticket|visitor/iu
const MEAL_PAGE_HINT = /餐|饭|美食|小吃|探店|用餐|饮食|点评|早餐|午餐|晚餐/u
const TRANSIT_PAGE_HINT = /交通|地铁|公交|机场|出行|线路|乘车|接驳/u
const SENSITIVE_QUERY_KEY = /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|cookie|credential|password|secret|session|signature|token|xsec[_-]?token)/i
const GENERIC_TRAVEL_INTERESTS = new Set([
  '人文', '历史', '文化', '自然', '自然风光', '美食', '拍照', '摄影', '购物', '亲子', '户外', '红叶', '赏秋',
  '景点', '景区', '北京标志景点', '城市漫步', '休闲', '博物馆', '同等景点', '一个同等景点'
])

/** 详细行程使用完整的有限正文读取预算；普通问答只读少量页面。 */
export function initialResearchPageLimit(detailedItineraryRequested: boolean): number {
  return detailedItineraryRequested ? MAX_INITIAL_RESEARCH_PAGES : 2
}

/** 识别可能来自当前网络或代理的故障，不把站点自身错误当成本机网络故障。 */
export function isRetryableBrowserNetworkFailure(
  failureKind: BrowserNavigationFailureKind | undefined
): boolean {
  return failureKind !== undefined && RETRYABLE_BROWSER_NETWORK_FAILURES.has(failureKind)
}

/** 将搜索词和网址映射到目标主机，供本轮回退去重，不写入日志。 */
export function researchBrowserTargetHost(input: string): string {
  try {
    return new URL(resolveResearchBrowserInput(input).url).hostname.toLocaleLowerCase()
  } catch {
    return 'unknown'
  }
}

/** 搜索渠道熔断时，按用户点名顺序选择有界的浏览器补查目标。 */
export function selectBrowserFallbackSearches<T extends { name: string; query: string }>(
  searches: readonly T[],
  limit: number
): T[] {
  const maximum = Math.max(0, Math.min(MAX_BROWSER_FALLBACK_SEARCHES, Math.floor(limit)))
  if (!maximum) return []
  const priorities: Record<BrowserFallbackSearchIntent, number> = {
    meal: 0, community: 1, transit: 2, attraction: 3, general: 4
  }
  const prioritized = searches.some((search) =>
    'intent' in search && typeof search.intent === 'string' && Object.hasOwn(priorities, search.intent)
  )
  if (!prioritized) return searches.slice(0, maximum)
  const hasSpecificIntent = searches.some((search) =>
    'intent' in search && typeof search.intent === 'string' &&
    Object.hasOwn(priorities, search.intent) && search.intent !== 'general'
  )
  const candidates = hasSpecificIntent
    ? searches.filter((search) => !('intent' in search && search.intent === 'general'))
    : searches
  return candidates.map((search, index) => ({ search, index }))
    .sort((left, right) => {
      const leftIntent = 'intent' in left.search ? left.search.intent : undefined
      const rightIntent = 'intent' in right.search ? right.search.intent : undefined
      const leftPriority = typeof leftIntent === 'string' && Object.hasOwn(priorities, leftIntent)
        ? priorities[leftIntent as BrowserFallbackSearchIntent] : 4
      const rightPriority = typeof rightIntent === 'string' && Object.hasOwn(priorities, rightIntent)
        ? priorities[rightIntent as BrowserFallbackSearchIntent] : 4
      return leftPriority - rightPriority || left.index - right.index
    })
    .slice(0, maximum)
    .map(({ search }) => search)
}

/** 搜索预算有限时从整趟行程均匀抽取查询，避免只覆盖前几天。 */
export function spreadResearchQueries(queries: readonly string[], limit: number): string[] {
  const maximum = Math.max(0, Math.floor(limit))
  if (!maximum) return []
  if (queries.length <= maximum) return [...queries]
  if (maximum === 1) return [queries[0]!]

  return Array.from({ length: maximum }, (_, index) => {
    const sourceIndex = Math.round(index * (queries.length - 1) / (maximum - 1))
    return queries[sourceIndex]!
  })
}

/** 为后续补查保留预算，同时确保短行程至少有一次前期回退机会。 */
export function remainingBrowserFallbackBudget(limit: number, used: number, reserved: number): number {
  const boundedLimit = Math.max(0, Math.floor(limit))
  const usedCount = Math.max(0, Math.floor(used))
  const remaining = Math.max(0, boundedLimit - usedCount)
  const reserve = Math.min(Math.max(0, Math.floor(reserved)), Math.max(0, boundedLimit - 1))
  return Math.max(0, remaining - reserve)
}

/** Firecrawl 配额或限流失效时停止本轮剩余的逐页请求。 */
export function firecrawlReadStopReason(sources: readonly SourceRecord[]): 'quota' | 'rate-limit' | undefined {
  for (const source of sources) {
    if (source.provider !== 'Firecrawl' || source.status !== 'error') continue
    if (/\bHTTP 402\b/u.test(source.summary)) return 'quota'
    if (/\bHTTP 429\b/u.test(source.summary)) return 'rate-limit'
  }
  return undefined
}

/** 为简报兴趣和用户按日期点名的地点生成有界开放/预约查询。 */
export function initialAttractionSearches(
  destination: string,
  interests: string,
  startDate: string,
  endDate: string,
  requestText = ''
): Array<{ name: string; query: string }> {
  const interestNames = interests.split(/[、，,；;|/]+/u)
    .map(cleanAttractionName)
  const requestNames = explicitDatedAttractionNames(requestText)
  const names = [...new Set([...interestNames, ...requestNames])]
    .filter(isConcreteAttractionName)
    .slice(0, MAX_INITIAL_ATTRACTION_SEARCHES)
  return names.map((name) => ({
    name,
    query: `${destination.trim().slice(0, 40)} ${attractionNameSearchTerms(name)} ${startDate} 至 ${endDate} 官方开放时间 预约`
      .replace(/\s+/gu, ' ').trim().slice(0, 180)
  }))
}

/** 仅加入共享地点表中的正式名、简称或旧称，帮助搜索命中名称写法不同的同一场馆。 */
function attractionNameSearchTerms(name: string): string {
  const primary = normalizeResearchText(name)
  const aliases = itineraryPlaceNameAliases(name)
    .filter((alias) => alias !== primary)
    .slice(0, 2)
  return [name, ...aliases].join(' ')
}

/** 用地点正式名或常见简称识别景点搜索，供搜索服务失败后的浏览器回退使用。 */
export function attractionNameForBrowserFallbackQuery(
  searches: readonly { name: string }[],
  query: string
): string | undefined {
  return searches.find(({ name }) => itinerarySourceNamesPlace(query, name))?.name
}

/** 景点回退保留城市与片区上下文，只移除具体日期和重复措辞。 */
export function browserFallbackSearchQuery(
  query: string,
  intent: BrowserFallbackSearchIntent,
  attractionName?: string
): string {
  if (intent !== 'attraction' || !attractionName || /^https?:\/\//iu.test(query)) return query

  const normalizedQuery = query.normalize('NFKC').replace(/\s+/gu, ' ').trim()
  const placeMatches = itineraryPlaceNameAliases(attractionName)
    .map((alias) => ({ alias, index: normalizedQuery.toLocaleLowerCase().indexOf(alias.toLocaleLowerCase()) }))
    .filter((match) => match.index >= 0)
    .sort((left, right) => left.index - right.index || right.alias.length - left.alias.length)
  const matchedPlace = placeMatches[0]
  const locationContext = matchedPlace
    ? normalizedQuery.slice(0, matchedPlace.index)
      .replace(/\b20\d{2}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\b/gu, ' ')
      .replace(/(?:官方|参观须知|开放时间|开放|闭馆|闭园|预约|门票|票价|购票|营业时间)/gu, ' ')
      .replace(/\s+/gu, ' ').trim().slice(-80).trim()
    : ''

  const factTerms = [
    [/开放|营业时间|opening|hours/iu, '开放时间'],
    [/闭馆|关闭|closed/iu, '闭馆'],
    [/预约|booking|reservation/iu, '预约'],
    [/门票|票价|购票|ticket|admission/iu, '门票']
  ] as const
  const requestedFacts = factTerms
    .filter(([pattern]) => pattern.test(query))
    .map(([, label]) => label)
  const uniqueFacts = [...new Set(requestedFacts)]
  const requestedFactQuery = uniqueFacts.length ? uniqueFacts.join(' ') : '开放时间 预约'
  return [locationContext, attractionNameSearchTerms(attractionName), '官方 参观须知', requestedFactQuery]
    .filter(Boolean).join(' ').slice(0, 300)
}

/** 只解析带日期且带明确安排动词的分句，不对自由文本做宽泛地名猜测。 */
function explicitDatedAttractionNames(requestText: string): string[] {
  const names: string[] = []
  for (const clause of requestText.split(/[；;\n。]+/u)) {
    const date = clause.match(/^\s*(?:\d{1,4}[./-]\d{1,2}(?:[./-]\d{1,2})?|\d{1,2}月\d{1,2}日?)(?!\d)/u)
    if (!date) continue
    const locations = clause.slice(date[0].length).match(/^\s*(?:只|仅)?\s*(?:必须\s*)?(?:安排|参考|游览|参观|前往|去)\s*[:：]?\s*(.+)$/u)?.[1]
    if (!locations) continue
    names.push(...splitExplicitAttractionList(locations).map(cleanAttractionName))
  }
  return names
}

/** 按顿号等强分隔符拆地点；只在景点名词后拆“和”，避免切断“颐和园”。 */
function splitExplicitAttractionList(value: string): string[] {
  const separatedConjunctions = value.replace(
    /(长城|博物馆|博物院|公园|广场|胡同|遗址|大学|[寺宫园山湖岛桥塔楼门殿])和(?=[\p{Script=Han}]{2,})/gu,
    '$1、'
  )
  return separatedConjunctions.split(/[、，,与及/或]+/u)
}

/** 清除地点列表常见的指令词和风格后缀，保留用户实际写出的地点名。 */
function cleanAttractionName(value: string): string {
  return value.trim()
    .replace(/^(?:想看|想去|游览|参观|喜欢|景点|地点|去|前往)\s*/u, '')
    .replace(/(?:赏秋|游玩|攻略)$/u, '')
    .trim()
}

/** 过滤偏好类别、虚指和过长句子，避免把说明文字当作检索地点。 */
function isConcreteAttractionName(name: string): boolean {
  return name.length >= 2 && name.length <= 24 && !GENERIC_TRAVEL_INTERESTS.has(name)
}

/** 搜索页只用于发现链接；优先官方页面，其次选择同地点的具体游览信息页。标题不核实事实。 */
export function selectOriginalResearchLink(
  links: readonly (ResearchPageLink & { context?: string })[],
  attractionName: string
): string | undefined {
  if (!itineraryPlaceNameAliases(attractionName).length) return undefined
  const candidates = links.slice(0, MAX_VISIBLE_RESEARCH_LINKS).flatMap((link, index) => {
    const url = canonicalPublicUrl(link.url)
    if (!url || isResearchSearchResultsUrl(url) ||
        sourceNatureFor(url, 'web') === 'community-platform') return []
    const hostname = new URL(url).hostname.toLowerCase()
    if (/(?:^|\.)(?:bing\.com|duckduckgo\.com)$/u.test(hostname)) return []
    const clue = browserLinkSearchText(link)
    if (!itinerarySourceNamesPlace(clue, attractionName)) return []
    const government = sourceNatureFor(url, 'web') === 'government-domain'
    const originalSiteHint = ORIGINAL_SITE_HINT.test(clue)
    const visitorInfoHint = VISITOR_INFO_HINT.test(clue)
    if (!government && !originalSiteHint && !visitorInfoHint) return []
    return [{ url, index, score: Number(government) * 8 + Number(originalSiteHint) * 4 + Number(visitorInfoHint) * 2 }]
  })
  candidates.sort((left, right) => right.score - left.score || left.index - right.index)
  return candidates[0]?.url
}

/** 从当前搜索快照中挑选一个可追踪的原文链接；社区经验不支持动态事实。 */
export function selectBrowserFallbackLink(
  links: readonly ResearchBrowserLink[],
  intent: BrowserFallbackSearchIntent,
  query: string,
  attractionName?: string,
  destination?: string
): ResearchBrowserLink | undefined {
  const visibleLinks = links.slice(0, MAX_VISIBLE_RESEARCH_LINKS).filter((link) =>
    typeof link.targetId === 'string' && /^l[1-9][0-9]{0,2}$/u.test(link.targetId)
  )
  if (intent === 'attraction' && attractionName) {
    const officialUrl = selectOriginalResearchLink(visibleLinks, attractionName)
    if (officialUrl) return visibleLinks.find((link) => canonicalPublicUrl(link.url) === officialUrl)
    const governmentPage = selectGovernmentFactPage(visibleLinks, query)
    if (governmentPage) return governmentPage
    return selectDestinationVisitorInfoPage(visibleLinks, query, destination)
  }

  if (intent === 'meal') return selectMealResearchLink(visibleLinks, query)

  if (intent === 'community') {
    const candidates = visibleLinks.flatMap((link, index) => {
      const url = canonicalPublicUrl(link.url)
      if (!url || isResearchSearchResultsUrl(url) || sourceNatureFor(url, 'web') !== 'community-platform') return []
      const score = browserLinkQueryScore(browserLinkSearchText(link), query)
      return score > 0 ? [{ link, index, score }] : []
    })
    candidates.sort((left, right) => right.score - left.score || left.index - right.index)
    if (candidates[0]) return candidates[0].link
  }

  if (intent === 'transit') {
    const candidates = visibleLinks.flatMap((link, index) => {
      const url = canonicalPublicUrl(link.url)
      if (!url || isResearchSearchResultsUrl(url) || sourceNatureFor(url, 'web') !== 'government-domain' ||
          !TRANSIT_PAGE_HINT.test(browserLinkSearchText(link))) return []
      return [{ link, index, score: browserLinkQueryScore(browserLinkSearchText(link), query) }]
    })
    candidates.sort((left, right) => right.score - left.score || left.index - right.index)
    if (candidates[0]) return candidates[0].link
  }

  if (intent === 'general') return selectGeneralResearchLink(visibleLinks, query)
  return undefined
}

/** 只返回固定筛选原因，供日志判断失败阶段；不返回页面标题、网址或查询词。 */
export function browserFallbackLinkMissReason(
  links: readonly ResearchBrowserLink[],
  intent: BrowserFallbackSearchIntent,
  query: string,
  attractionName?: string
): BrowserFallbackLinkMissReason {
  const visibleLinks = links.slice(0, MAX_VISIBLE_RESEARCH_LINKS).filter((link) =>
    typeof link.targetId === 'string' && /^l[1-9][0-9]{0,2}$/u.test(link.targetId)
  )
  if (!visibleLinks.length) return 'no_actionable_links'
  const publicLinks = visibleLinks.filter((link) => {
    const url = canonicalPublicUrl(link.url)
    return !!url && !isResearchSearchResultsUrl(url)
  })
  if (!publicLinks.length) return 'no_public_links'

  if (intent === 'attraction') {
    if (!attractionName) return 'attraction_name_missing'
    const attractionCandidateLinks = publicLinks.filter((link) => {
      const url = canonicalPublicUrl(link.url)
      if (!url || sourceNatureFor(url, 'web') === 'community-platform') return false
      return !/(?:^|\.)(?:bing\.com|duckduckgo\.com)$/u.test(new URL(url).hostname.toLowerCase())
    })
    const placeMatches = attractionCandidateLinks.filter((link) => itinerarySourceNamesPlace(browserLinkSearchText(link), attractionName))
    const hasInformativePlacePage = placeMatches.some((link) => {
      const isGovernment = sourceNatureFor(link.url, 'web') === 'government-domain'
      const hasSiteHint = ORIGINAL_SITE_HINT.test(browserLinkSearchText(link))
      const hasVisitorHint = VISITOR_INFO_HINT.test(browserLinkSearchText(link))
      return isGovernment || hasSiteHint || hasVisitorHint
    })
    if (placeMatches.length > 0) {
      return hasInformativePlacePage ? 'intent_policy_no_match' : 'attraction_information_hint_missing'
    }
    const governmentFactLinks = publicLinks.filter((link) =>
      sourceNatureFor(link.url, 'web') === 'government-domain' &&
      GOVERNMENT_FACT_PAGE_HINT.test(browserLinkSearchText(link))
    )
    if (governmentFactLinks.some((link) => browserLinkQueryScore(browserLinkSearchText(link), query) > 0)) {
      return 'intent_policy_no_match'
    }
    return governmentFactLinks.length > 0 ? 'government_fact_query_not_matched' : 'attraction_name_not_found'
  }

  if (intent === 'meal') {
    return selectMealResearchLink(visibleLinks, query) ? 'intent_policy_no_match' : 'meal_result_not_found'
  }

  if (intent === 'community') {
    const communityLinks = publicLinks.filter((link) =>
      sourceNatureFor(link.url, 'web') === 'community-platform'
    )
    if (!communityLinks.length) return 'no_community_link'
    return communityLinks.some((link) => browserLinkQueryScore(browserLinkSearchText(link), query) > 0)
      ? 'intent_policy_no_match' : 'community_query_not_matched'
  }

  if (intent === 'transit') {
    const transitLinkExists = publicLinks.some((link) =>
      sourceNatureFor(link.url, 'web') === 'government-domain' &&
      TRANSIT_PAGE_HINT.test(browserLinkSearchText(link))
    )
    return transitLinkExists ? 'intent_policy_no_match' : 'government_transit_link_not_found'
  }

  if (intent === 'general') {
    const hasRelevantPage = publicLinks.some((link) =>
      browserLinkQueryScore(browserLinkSearchText(link), query) >= MIN_GENERAL_BROWSER_LINK_RELEVANCE
    )
    return hasRelevantPage ? 'intent_policy_no_match' : 'general_relevance_below_threshold'
  }

  return 'intent_policy_no_match'
}

/** 餐饮检索可跟进社区点评、门店官网及其他高相关公开页面，不限于社区域名。 */
function selectMealResearchLink(
  links: readonly ResearchBrowserLink[],
  query: string
): ResearchBrowserLink | undefined {
  const candidates = links.flatMap((link, index) => {
    const url = canonicalPublicUrl(link.url)
    if (!url || isResearchSearchResultsUrl(url)) return []
    const clue = browserLinkSearchText(link)
    const relevance = browserLinkQueryScore(browserLinkSearchText(link), query)
    const hasMealHint = MEAL_PAGE_HINT.test(clue)
    const community = sourceNatureFor(url, 'web') === 'community-platform'
    const minimum = hasMealHint
      ? MIN_MEAL_HINTED_PAGE_RELEVANCE
      : community ? MIN_MEAL_COMMUNITY_LINK_RELEVANCE : MIN_NAMED_MEAL_PAGE_RELEVANCE
    if (relevance < minimum) return []
    return [{ link, index, relevance, community }]
  })
  candidates.sort((left, right) => right.relevance - left.relevance ||
    Number(right.community) - Number(left.community) || left.index - right.index)
  return candidates[0]?.link
}

/** 通用回退只跟进当前快照中的相关公开原文；搜索页不能充当来源。 */
function selectGeneralResearchLink(
  links: readonly ResearchBrowserLink[],
  query: string
): ResearchBrowserLink | undefined {
  const candidates = links.flatMap((link, index) => {
    const url = canonicalPublicUrl(link.url)
    if (!url || isResearchSearchResultsUrl(url)) return []
    const relevance = browserLinkQueryScore(browserLinkSearchText(link), query)
    if (relevance < MIN_GENERAL_BROWSER_LINK_RELEVANCE) return []
    const authority = sourceNatureFor(url, 'web') === 'government-domain' ? 1 : 0
    return [{ link, index, relevance, authority }]
  })
  candidates.sort((left, right) => right.relevance - left.relevance ||
    right.authority - left.authority || left.index - right.index)
  return candidates[0]?.link
}

/** 指定景点未出现在链接标题时，只回退到与查询相关的政府开放/预约页面。 */
function selectGovernmentFactPage(
  links: readonly ResearchBrowserLink[],
  query: string
): ResearchBrowserLink | undefined {
  const candidates = links.flatMap((link, index) => {
    const url = canonicalPublicUrl(link.url)
    if (!url || isResearchSearchResultsUrl(url) || sourceNatureFor(url, 'web') !== 'government-domain') return []
    const candidateText = browserLinkSearchText(link)
    if (!GOVERNMENT_FACT_PAGE_HINT.test(candidateText)) return []
    const relevance = browserLinkQueryScore(browserLinkSearchText(link), query)
    return relevance > 0 ? [{ link, index, relevance }] : []
  })
  candidates.sort((left, right) => right.relevance - left.relevance || left.index - right.index)
  return candidates[0]?.link
}

/** 景点名未出现在快照时，仅打开同目的地的公开游览信息页作后续核验线索。 */
function selectDestinationVisitorInfoPage(
  links: readonly ResearchBrowserLink[],
  query: string,
  destination?: string
): ResearchBrowserLink | undefined {
  if (!destination?.trim()) return undefined
  const selectionQuery = `${destination} ${query}`
  const candidates = links.flatMap((link, index) => {
    const url = canonicalPublicUrl(link.url)
    if (!url || isResearchSearchResultsUrl(url)) return []
    const nature = sourceNatureFor(url, 'web')
    if (nature === 'community-platform' || nature === 'government-domain') return []
    const clue = browserLinkSearchText(link)
    if (!itinerarySourceNamesPlace(clue, destination) || !VISITOR_INFO_HINT.test(clue)) return []
    const relevance = browserLinkQueryScore(browserLinkSearchText(link), selectionQuery)
    if (relevance < MIN_DESTINATION_VISITOR_PAGE_RELEVANCE) return []
    return [{ link, index, relevance }]
  })
  candidates.sort((left, right) => right.relevance - left.relevance || left.index - right.index)
  return candidates[0]?.link
}

/** 只用标题和邻近摘要评估搜索相关性，避免域名词汇虚增匹配分。 */
function browserLinkText(link: ResearchPageLink & { context?: string }): string {
  return `${link.text} ${link.context ?? ''}`
}

/** 相关度可使用公开 URL 路径，但不使用域名和查询参数，避免凭证或域名词汇干扰选链。 */
function browserLinkSearchText(link: ResearchPageLink & { context?: string }): string {
  return `${browserLinkText(link)} ${readableUrlPathForDiscovery(link.url)}`
}

/** 只解码公开 URL 路径，支持中文 slug 匹配；不展开可能包含凭证的查询参数。 */
function readableUrlPathForDiscovery(input: string): string {
  try {
    const path = new URL(input).pathname
    return path.split('/').map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    }).join(' ')
  } catch {
    return ''
  }
}

/** 用查询中的可见词排序搜索结果，不把结果标题当作事实证据。 */
function browserLinkQueryScore(title: string, query: string): number {
  const normalizedTitle = normalizeResearchText(title)
  const rawTerms = query.match(/[\p{Script=Han}]+|[a-z0-9]{2,}/giu) ?? []
  const terms = rawTerms.flatMap((term) => {
    if (!/^[\p{Script=Han}]+$/u.test(term)) return [term]
    const characters = Array.from(term)
    return characters.length < 2 ? characters : characters.slice(0, -1).map((_, index) =>
      `${characters[index]}${characters[index + 1]}`
    )
  })
  return terms.reduce((score, term) => {
    const normalizedTerm = normalizeResearchText(term)
    return normalizedTerm.length >= 2 && normalizedTitle.includes(normalizedTerm)
      ? score + Math.min(normalizedTerm.length, 6)
      : score
  }, 0)
}

/** 去除空白和标点，仅用于对比用户已明确给出的地点名称。 */
function normalizeResearchText(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase()
}

/** 只保留公开网页链接；小红书笔记访问令牌仅留在进程内用于打开原文。 */
function canonicalPublicUrl(value: string): string | undefined {
  try {
    const url = new URL(normalizeResearchUrl(value))
    const xiaohongshuNote = ['xiaohongshu.com', 'www.xiaohongshu.com'].includes(url.hostname.toLowerCase()) &&
      /^\/(?:explore|note)\/[a-f0-9]{24}\/?$/iu.test(url.pathname)
    const hasUnsafeSensitiveParameter = [...url.searchParams.keys()].some((key) =>
      SENSITIVE_QUERY_KEY.test(key) && !(xiaohongshuNote && key.toLowerCase() === 'xsec_token')
    )
    if (hasUnsafeSensitiveParameter) return undefined
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|ref|source)$/i.test(key)) url.searchParams.delete(key)
    }
    return url.href
  } catch {
    return undefined
  }
}
