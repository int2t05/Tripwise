/** 定义旅行工具的模型契约、执行上下文和来源结果。 */
import { randomUUID } from 'node:crypto'
import type { ExplicitlyExcludedItineraryStop } from '../../shared/itinerary-revisions.js'
import type { ConnectorSettings, GeoLocation, ItineraryFactType, ItineraryMealRequirement, ItineraryOption, OpenCliSettings, PreparationCategory, PreparationItem, ResearchBrowserLink, ResearchBrowserSnapshot, RouteOption, SourceRecord, ToolFeedback, ToolFeedbackSeverity, TripBrief, TripBriefProposal } from '../../shared/types.js'
import { sourceNatureFor } from '../../shared/source-provenance.js'

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ToolResult {
  output: string
  sources: SourceRecord[]
  /** 稳定的调试协议；仅格式错误阻止候选保存，业务反馈交由模型判断。 */
  feedback?: ToolFeedback[]
  /** 仅在主进程复用本次浏览器快照；不保存，也不传给模型。 */
  browserSnapshotLinks?: ResearchBrowserLink[]
  /** 浏览器进度使用固定语义码，不依赖可读输出文案判断动作结果。 */
  progressCode?: ToolProgressCode
  itineraryOptions?: ItineraryOption[]
  preparationOptions?: PreparationItem[]
  routeOptions?: RouteOption[]
  /** 路线查询失败类别，作为工具回执交给 Agent。 */
  routeFailureKind?: RouteToolFailureKind
  /** 高德额度熔断的固定状态，供最终路线备注说明原因。 */
  routeQuotaLimited?: boolean
  /** 浏览器导航失败的安全分类，仅用于本机排障日志，不进入旅行资料。 */
  browserNavigationFailureKind?: BrowserNavigationFailureKind
  /** Chromium 导航失败发生的固定阶段，仅用于本机排障日志。 */
  browserNavigationFailureStage?: BrowserNavigationFailureStage
  /** 浏览器开链失败的安全分类，仅记录固定枚举，不记录页面地址或异常原文。 */
  browserLinkFailureKind?: BrowserLinkFailureKind
  /** 区分快照页变化、编号丢失和 DOM 目标失效，不含页面内容。 */
  browserLinkFailureStage?: BrowserLinkFailureStage
  briefProposal?: TripBriefProposal
  /** 只包含计数的事实来源诊断，不含地点、事实值或来源正文。 */
  itineraryFactEvidenceDiagnostics?: ItineraryFactEvidenceDiagnostics
}

/** 只在主进程内部传递的浏览器动作结果；不写入模型上下文或旅行数据。 */
export type ToolProgressCode =
  | 'browser_navigation_read_completed'
  | 'browser_navigation_read_partial'
  | 'browser_search_results_read'
  | 'browser_navigation_read_blocked'
  | 'browser_navigation_read_unavailable'
  | 'browser_link_opened'
  | 'browser_link_read_partial'
  | 'browser_link_read_unavailable'
  | 'browser_link_unavailable'
  | 'browser_interact_search_completed'
  | 'browser_interact_expand_completed'
  | 'browser_interact_target_stale'
  | 'browser_interact_write_blocked'
  | 'browser_interact_search_unsupported'
  | 'browser_interact_unavailable'
  | 'browser_visual_read_completed'
  | 'browser_visual_read_blocked'
  | 'browser_visual_read_unsupported'
  | 'browser_visual_read_limit'
  | 'browser_visual_read_unavailable'

export type BrowserNavigationFailureKind =
  | 'aborted'
  | 'address_unreachable'
  | 'connection_closed'
  | 'connection_refused'
  | 'connection_reset'
  | 'dns'
  | 'http'
  | 'offline'
  | 'network'
  | 'proxy'
  | 'blocked'
  | 'timeout'
  | 'tls'
  | 'unknown'

export type BrowserNavigationFailureStage = 'requested' | 'started' | 'redirected' | 'committed'

export type BrowserLinkFailureKind = BrowserNavigationFailureKind
  | 'stale_snapshot'
  | 'access_gate'

/** 保留 Chromium 导航失败时可安全记录的阶段，不保存 URL 或原始错误。 */
export class BrowserNavigationError extends Error {
  constructor(readonly stage: BrowserNavigationFailureStage, cause: unknown) {
    super('研究网页导航失败。', { cause })
    this.name = 'BrowserNavigationError'
  }
}

export type BrowserLinkFailureStage =
  | 'snapshot_page_changed'
  | 'target_not_in_snapshot'
  | 'snapshot_registry_missing'
  | 'snapshot_registry_page_changed'
  | 'snapshot_target_missing'
  | 'snapshot_target_url_missing'
  | 'target_not_found_after_rerender'
  | 'target_ambiguous_after_rerender'
  | 'target_not_rendered'
  | 'target_detached_during_scroll'
  | 'target_scroll_unstable'
  | 'target_scroll_did_not_move'
  | 'target_scroll_incomplete'
  | 'cursor_action_failed'
  | 'cursor_script_execution'

/** 为浏览器快照开链保留可记录的固定失败原因。 */
export class BrowserLinkOpenError extends Error {
  constructor(readonly stage: BrowserLinkFailureStage, cause?: unknown) {
    const messages: Record<BrowserLinkFailureStage, string> = {
      snapshot_page_changed: '网页快照页面已变化，请重新读取页面快照。',
      target_not_in_snapshot: '网页链接编号不属于当前快照，请先重新读取。',
      snapshot_registry_missing: '当前网页快照已失效，请重新读取页面。',
      snapshot_registry_page_changed: '当前网页已变化，请重新读取页面快照。',
      snapshot_target_missing: '网页链接编号不在当前页面快照中，请重新读取。',
      snapshot_target_url_missing: '网页链接目标已失效，请重新读取页面。',
      target_not_found_after_rerender: '页面已更新，未能恢复目标链接；请重新读取页面。',
      target_ambiguous_after_rerender: '页面中存在多个相同链接，已停止自动打开；请重新读取页面。',
      target_not_rendered: '页面中的目标链接暂不可见，请重新读取页面后重试。',
      target_detached_during_scroll: '页面更新导致目标链接消失，请重新读取页面。',
      target_scroll_unstable: '页面仍在滚动，暂未打开链接；请稍后重新读取。',
      target_scroll_did_not_move: '页面未能滚动到目标链接，请重新读取页面后重试。',
      target_scroll_incomplete: '目标链接仍在视口外，已停止打开；请重新读取页面。',
      cursor_action_failed: '无法显示目标操作指针，链接未打开。',
      cursor_script_execution: '网页操作中断，链接未能打开。'
    }
    super(messages[stage], cause === undefined ? undefined : { cause })
    this.name = 'BrowserLinkOpenError'
  }
}

export type FactEvidenceRejectionReason = 'source-unavailable' | 'source-ineligible' | 'place-mismatch' | 'scope-mismatch' | 'value-mismatch'

/** 用固定维度记录行程事实校验失败，供本机日志和验收报告定位问题。 */
export interface ItineraryFactEvidenceDiagnostics {
  requestedCount: number
  autoBoundCount: number
  rejectedCount: number
  sourceUnavailableCount: number
  sourceIneligibleCount: number
  placeMismatchCount: number
  scopeMismatchCount: number
  valueMismatchCount: number
  rejectedByType: Partial<Record<ItineraryFactType, number>>
}

/** 区分地点、路线数据、服务和输入错误，避免把故障描述成无结果。 */
export type RouteToolFailureKind = 'location_unresolved' | 'route_unavailable' | 'route_data_missing' | 'provider_error' |
  'input_error' | 'tool_unavailable' | 'connector_error'

/** 仅保存在单次 Agent 运行内；渠道失败后停止重复请求同一搜索服务。 */
export type SearchProviderName = 'Exa' | 'Tavily' | 'Firecrawl' | 'DuckDuckGo'
export const SEARCH_PROVIDER_NAMES: readonly SearchProviderName[] = ['Exa', 'Tavily', 'Firecrawl', 'DuckDuckGo']

export interface SearchProviderCircuitBreaker {
  disabled: Set<SearchProviderName>
  /** 防止搜索页持续返回无法解析的空结果时重复调用同一渠道。 */
  emptyResultCounts?: Map<SearchProviderName, number>
  /** 同一轮并行检索按服务商排队，确保失败状态生效后再启动下一条查询。 */
  providerQueues?: Map<SearchProviderName, Promise<void>>
}

/** 本轮高德路线额度触顶后停止后续请求；只保存供应商固定错误码。 */
export type AmapRouteQuotaErrorCode = '10003' | '10004' | '10010'
export interface AmapRouteCircuitBreaker {
  quotaErrorCode?: AmapRouteQuotaErrorCode
}

/** 每次 Agent 运行单独创建，重新运行时可在配置变更后重试路线服务。 */
export function createAmapRouteCircuitBreaker(): AmapRouteCircuitBreaker {
  return {}
}

/** 按本轮配置初始化搜索熔断；未配置的付费服务不应阻止剩余渠道耗尽判断。 */
export function createSearchProviderCircuitBreaker(credentials: {
  exaKey?: string | null
  tavilyKey?: string | null
  firecrawlKey?: string | null
}): SearchProviderCircuitBreaker {
  const disabled = new Set<SearchProviderName>()
  if (!credentials.exaKey) disabled.add('Exa')
  if (!credentials.tavilyKey) disabled.add('Tavily')
  if (!credentials.firecrawlKey) disabled.add('Firecrawl')
  return { disabled, emptyResultCounts: new Map(), providerQueues: new Map() }
}

/** 判断本轮所有网页搜索渠道是否已熔断。 */
export function areSearchProvidersExhausted(circuitBreaker?: SearchProviderCircuitBreaker): boolean {
  return !!circuitBreaker && SEARCH_PROVIDER_NAMES.every((provider) => circuitBreaker.disabled.has(provider))
}

/** 关联同一次模型选定的路线查询；字段不包含地点文本。 */
export interface RouteRequestDiagnostics {
  traceId?: string
  attemptId: string
  dayNumber?: number
  pointRole?: 'origin' | 'destination'
  geocodeVariant?: 'raw-input' | 'area-address' | 'place-name' | 'area-address-no-city' | 'place-name-no-city' | 'source-place-coordinate' | 'poi-coordinate-citycode'
}

/** 仅记录路线端点定位阶段和失败类别，不包含地点文本或坐标。 */
export type RouteResolutionStage = 'source-coordinate' | 'exact-poi' | 'exact-poi-no-city' | 'raw-input' |
  'area-address' | 'place-name' | 'area-address-no-city' | 'place-name-no-city'
export type RouteResolutionStatus = 'resolved' | 'not_found' | 'provider_error'
export type RouteResolutionReason = 'invalid_coordinate' | 'no_exact_match' | 'ambiguous_match' |
  'area_conflict' | 'city_conflict' | 'no_precise_match'

/** 路线端点可选的可信高德坐标提示，不进入模型参数或日志。 */
export interface TrustedMapRouteEndpoint {
  sourceId: string
  provider: string
  location: GeoLocation
}

export interface ToolContext {
  amapKey: string | null
  /** 本轮高德路线请求达到额度或频率限制后停止后续网络调用。 */
  amapRouteCircuitBreaker?: AmapRouteCircuitBreaker
  /** 关联单次 Agent 运行内的外部渠道诊断，不包含用户输入。 */
  traceId?: string
  /** 本轮用户原话；用于按其明确写出的地点覆盖比例校验候选。 */
  userRequest?: string
  /** 搜索和网页抽取凭证只由主进程注入，不进入模型上下文。 */
  exaKey?: string | null
  tavilyKey?: string | null
  searchProviderCircuitBreaker?: SearchProviderCircuitBreaker
  /** 本轮 Firecrawl 配额/限流后，后续正文读取直接切换到 Exa。 */
  firecrawlDisabled?: boolean
  firecrawlKey?: string | null
  connectors?: ConnectorSettings
  xiaohongshu?: OpenCliSettings
  researchCompleted?: boolean
  /** 用户明确跳过联网检索时允许提交待核验草案，不把未知事实当作已验证。 */
  allowUnresearchedDraft?: boolean
  sourceIds?: string[]
  /** 当前 Agent 运行中取得的来源；用于把未纳入候选的结果作为诊断反馈。 */
  currentRunSourceIds?: string[]
  /** 当前旅行可引用的完整来源记录，用于校验模型提交的依据链接。 */
  availableSources?: SourceRecord[]
  /** 当前确认的结构化行程，用于将餐饮与备选绑定到真实停靠点。 */
  itinerary?: ItineraryOption
  /** 当前规划轮次中尚待用户审阅的候选方案，供局部修订工具保留其余内容。 */
  itineraryOptions?: ItineraryOption[]
  /** 上一份未拒绝草案；显式单日修订时用于保留未涉及日期。 */
  revisionBaseline?: ItineraryOption
  /** 本轮明确未要求更改的日期，由主进程从用户原话中保守识别。 */
  unchangedItineraryDates?: string[]
  /** 本轮明确要求移除的旧停靠点；候选仍包含这些地点时拒绝交付。 */
  excludedItineraryStops?: ExplicitlyExcludedItineraryStop[]
  tripBrief?: TripBrief
  /** 用户填写了预算或本轮明确询问费用时，要求候选行程提供完整分类估算。 */
  budgetRequested?: boolean
  /** 用户明确要求具体餐馆时，拒绝区域或菜品描述充当店名。 */
  requireNamedMealStops?: boolean
  /** 用户本轮明确要求的准备类别；用于把内容缺口作为 warning 回传。 */
  requiredPreparationCategories?: PreparationCategory[]
  /** 用户明确列出逐日餐次时，候选必须包含相应餐饮地点。 */
  requiredMealSlots?: ItineraryMealRequirement[]
  /** 用户明确要求逐时段、交通接驳或开放时间等执行细节。 */
  detailedItineraryRequested?: boolean
  /** 详细初稿或行程修改需要把交通路线缺口作为 warning 返回模型。 */
  routeCoverageRequested?: boolean
  /** 用户明确要求开放时间或闭馆事实。 */
  openingHoursDetailsRequested?: boolean
  /** 用户明确要求预约、购票规则。 */
  bookingDetailsRequested?: boolean
  /** 用户明确要求核对景点门票价格。 */
  ticketPriceDetailsRequested?: boolean
  /** 将景点事实修订可引用的网页正文来源限制到同一目标。 */
  factRepairSourceBindings?: Array<{
    plan_number: number
    day_number: number
    date: string
    stop_name: string
    area: string
    source_ids: string[]
    /** 每条工具声明仅允许引用该来源正文中提取的原句候选。 */
    fact_quotes?: Array<{
      source_id: string
      type: ItineraryFactType
      candidates: Array<{ quote_id: string; value: string }>
    }>
  }>
  /** 用户要求说明天气、客流或延误时的日程调整。 */
  itineraryContingenciesRequested?: boolean
  /** 用户明确要求预约失败时改游其他地点。 */
  bookingAlternativeRequested?: boolean
  /** 用户明确要求在行程中展示逐日天气；天气值由日期匹配的天气来源生成。 */
  dailyWeatherRequested?: boolean
  /** 用户明确要求每天提供有地点来源的室内雨天备选。 */
  dailyIndoorRainAlternativesRequested?: boolean
  /** 可选的可信地图端点提示；不进入模型工具参数或日志。 */
  routeEndpoints?: {
    originPoiName: string
    originArea: string
    destinationPoiName: string
    destinationArea: string
    originLocation?: TrustedMapRouteEndpoint
    destinationLocation?: TrustedMapRouteEndpoint
  }
  /** 本机日志关联一次路线工具调用，不进入模型上下文或旅行记录。 */
  routeDiagnostics?: RouteRequestDiagnostics
  /** 指向右侧可见隔离网页；Agent 只可导航、读取、有限滚动与安全搜索/展开。 */
  researchBrowser?: ResearchBrowserToolController
  /** 截图读取默认关闭；仅启用且图片模型验证成功后才会调用。 */
  researchBrowserVisualReadEnabled?: boolean
  analyzeResearchScreenshot?: ResearchBrowserVisualReader
}

export type ResearchBrowserVisualReadResult =
  | { status: 'read'; text: string }
  | { status: 'unsupported' }
  | { status: 'failed' }
  | { status: 'limit' }

/** 使用惰性截图回调，先验证模型图片能力，再采集当前网页视口。 */
export type ResearchBrowserVisualReader = (
  capture: () => Promise<Uint8Array>,
  signal?: AbortSignal
) => Promise<ResearchBrowserVisualReadResult>

/** 由主进程研究浏览器实现，避免旅行连接器依赖 Electron 类型。 */
export interface ResearchBrowserToolController {
  isAvailable(): boolean
  accessGateForUrl?(url: string): 'login-required' | 'verification-required' | undefined
  navigate(input: unknown, signal?: AbortSignal): Promise<{ url: string; title: string; navigationTimedOut?: boolean }>
  openSnapshotLink?(targetId: string, signal?: AbortSignal): Promise<{ url: string; title: string; navigationTimedOut?: boolean }>
  readSnapshot(signal?: AbortSignal): Promise<ResearchBrowserSnapshot>
  captureViewport?(signal?: AbortSignal): Promise<Uint8Array>
  scroll(direction: 'up' | 'down', pages: number, signal?: AbortSignal): Promise<void>
  interact(targetId: string, query?: string, signal?: AbortSignal): Promise<{ action: 'search' | 'expand' }>
}

export interface TravelTool {
  definition: ToolDefinition
  provider: string
  kind: SourceRecord['kind']
  sourceUrl: string
  connector?: keyof ConnectorSettings
  isAvailable?: (context: ToolContext) => boolean
  execute(args: Record<string, unknown>, context: ToolContext, signal?: AbortSignal): Promise<ToolResult>
}

/** 创建带唯一标识、获取时间和有限摘要的标准来源记录。 */
export function createSource(
  title: string,
  url: string,
  provider: string,
  kind: SourceRecord['kind'],
  summary: string,
  status: SourceRecord['status'] = 'success',
  location?: GeoLocation,
  attribution?: Pick<SourceRecord, 'declaredAuthor' | 'declaredPublishedAt'>
): SourceRecord {
  const declaredAuthor = cleanAttribution(attribution?.declaredAuthor, 120)
  const declaredPublishedAt = cleanAttribution(attribution?.declaredPublishedAt, 100)
  const contentLevel = status !== 'success'
    ? 'status'
    : kind === 'user' ? 'user-provided'
      : kind === 'plugin' ? 'plugin'
        : kind === 'weather' || kind === 'place' || kind === 'route' ? 'structured'
          : 'snippet'
  return {
    id: randomUUID(),
    title: title.slice(0, 300),
    url,
    provider,
    kind,
    summary: summary.slice(0, 800),
    fetchedAt: new Date().toISOString(),
    status,
    contentLevel,
    sourceNature: sourceNatureFor(url, kind),
    ...(declaredAuthor ? { declaredAuthor } : {}),
    ...(declaredPublishedAt ? { declaredPublishedAt } : {}),
    ...(location ? { location } : {})
  }
}

/** 限长并清理网页自报字段，避免控制字符和冗长内容污染来源卡。 */
function cleanAttribution(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
  return normalized || undefined
}

/** 读取字符串参数并统一检查长度，拒绝模型生成的空值和超长值。 */
export function requireText(args: Record<string, unknown>, key: string, min: number, max: number): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new ToolInputError(`参数 ${key} 长度应为 ${min}–${max} 个字符。`)
  }
  return value.trim()
}

/** 将参数限制在已声明的字符串枚举中。 */
export function requireOneOf<T extends string>(
  args: Record<string, unknown>,
  key: string,
  options: readonly T[]
): T {
  const value = args[key]
  if (typeof value !== 'string' || !options.includes(value as T)) {
    throw new ToolInputError(`参数 ${key} 不受支持。`)
  }
  return value as T
}

/** 只接受真实存在的 YYYY-MM-DD 日历日期。 */
export function optionalDate(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ToolInputError('日期需使用 YYYY-MM-DD 格式。')
  }
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new ToolInputError('日期不是有效的日历日期。')
  }
  return value
}

/** 标记模型工具的用户参数错误，避免将其伪装成外部来源故障。 */
export class ToolInputError extends Error {
  /** 保留稳定错误码；业务约束可作为警告回传，由 Agent 决定后续动作。 */
  constructor(
    message: string,
    readonly code = 'invalid_input',
    readonly severity: ToolFeedbackSeverity = 'error'
  ) {
    super(message)
    this.name = 'ToolInputError'
  }
}
