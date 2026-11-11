/** 应用内跨进程共享的领域类型。 */
export type ChatRole = 'user' | 'assistant'
export type SourceKind = 'web' | 'weather' | 'place' | 'route' | 'user' | 'plugin'
export type SourceNature = 'government-domain' | 'community-platform' | 'service' | 'user-provided' | 'unclassified'
export type SourceContentLevel = 'snippet' | 'page' | 'visual-clue' | 'structured' | 'user-provided' | 'plugin' | 'status'
export type WorkspaceView = 'chat' | 'itinerary' | 'preparation'
export type RouteMode = 'transit' | 'walking' | 'driving'
export type SourceStatus = 'success' | 'partial' | 'unavailable' | 'error'
/** 行李清单的收纳位置；规则不足时保留为待分类。 */
export const PACKING_SECTIONS = ['carry-on', 'checked', 'personal-item', 'unclassified'] as const
/** 行李物品的装包位置。 */
export type PackingSection = typeof PACKING_SECTIONS[number]
export type SourceRetry =
  | { toolName: 'search_web'; arguments: { query: string } }
  | { toolName: 'read_webpage'; arguments: { url: string } }
  | { toolName: 'search_xiaohongshu'; arguments: { query: string; limit?: number } }
  | { toolName: 'read_xiaohongshu_note'; arguments: { url: string } }
  | { toolName: 'get_weather'; arguments: { city: string; start_date?: string; end_date?: string } }
  | { toolName: 'find_places'; arguments: { city: string; query: string; near_stop_id?: string } }
  | { kind: 'mcp-connect'; serverId: string }
  | { kind: 'mcp-tool'; serverId: string; toolName: string; arguments: Record<string, unknown> }
export type PreparationCategory = 'booking' | 'packing' | 'clothing' | 'food' | 'alternative' | 'transport' | 'other'
export type EvidenceLevel = 'sourced' | 'estimated' | 'pending'
export type ItineraryFactType = 'opening-hours' | 'ticket-price' | 'booking' | 'closure' | 'weather' | 'transport-time' | 'accessibility' | 'sunset' | 'photography-rules' | 'other'

export interface TripBrief {
  departureCity: string
  destination: string
  startDate: string
  endDate: string
  arrivalFlight: string
  arrivalTime: string
  leaveTime: string
  travelers: string
  budget: string
  lodgingLocation: string
  lodging: string
  pace: string
  earlyStart: string
  interests: string
  transport: string
  dietary: string
  luggage: string
  clothing: string
  constraints: string
}

/** 旅行简报可由用户明确标记为暂未知的字段。 */
export type TripBriefField = keyof TripBrief

/** 对话中提取出的旅行条件变更；采纳前只作为待审阅草案。 */
export interface TripBriefProposal {
  base: Partial<TripBrief>
  changes: Partial<TripBrief>
}

/** 地图服务返回的经纬度，同时记录原始坐标系以避免跨底图错位。 */
export interface GeoLocation {
  latitude: number
  longitude: number
  label: string
  coordinateSystem: 'wgs84' | 'gcj02'
}

/** 用户选定地点位置时，保留可追溯来源和查询时间。 */
export interface ItineraryLocation extends GeoLocation {
  sourceId: string
  provider: string
  fetchedAt: string
}

export interface SourceRecord {
  id: string
  title: string
  url: string
  provider: string
  kind: SourceKind
  summary: string
  fetchedAt: string
  status: SourceStatus
  /** 网页事实核验用的限长正文摘录；不显示在来源卡片中。 */
  factEvidenceExcerpt?: string
  /** 来源所属渠道性质；仅描述域名/工具类型，不代表内容已核实。 */
  sourceNature?: SourceNature
  /** 标明当前保存的是搜索摘要、网页正文还是结构化服务结果。 */
  contentLevel?: SourceContentLevel
  /** 网页自行声明的作者和发布时间，展示时必须标为未独立核验。 */
  declaredAuthor?: string
  declaredPublishedAt?: string
  /** MCP 来源关联的稳定服务 ID；服务重命名后仍可显示本旅行最近状态。 */
  connectorId?: string
  location?: GeoLocation
  retry?: SourceRetry
  retrySkippedAt?: string
}

/** 高德为单段行程返回的可审阅路线选项。 */
export interface RouteOption {
  optionNumber: number
  /** 仅在结果采用备用交通方式时返回，供界面正确标注实际路线。 */
  mode?: RouteMode
  durationMinutes: number | null
  distanceMeters: number | null
  walkingDistanceMeters: number | null
  /** 高德公交票价，单位为分；null 表示服务未提供可确认金额。 */
  fareFen?: number | null
  /** 高德驾车道路收费，单位为分；不代表完整驾车成本。 */
  tollFen?: number | null
  transitLines: string[]
  summary: string
  /** 仅用于当前界面的路线预览；不写入旅行数据或导出文件。 */
  pathSegments?: RoutePathSegment[]
}

/** 高德路线中的一段 GCJ-02 折线坐标。 */
export interface RoutePathSegment {
  points: Array<[longitude: number, latitude: number]>
}

/** 用户主动查询路线后返回的估算及其来源记录。 */
export interface RouteEstimateResponse {
  output: string
  options: RouteOption[]
  source?: SourceRecord
}

/** 已被用户采纳到下一段交通说明中的估算依据。 */
export interface TransitEstimate {
  sourceId: string
  destinationStopId: string
  mode: RouteMode
  fetchedAt: string
  optionNumber: number
  queryDate?: string
  queryTime?: string
  durationMinutes?: number | null
  distanceMeters?: number | null
  walkingDistanceMeters?: number | null
  /** 已采纳公交路线的接口票价，单位为分；null 表示没有返回明确金额。 */
  fareFen?: number | null
  /** 已采纳驾车路线的道路收费，单位为分；不代表油费或完整驾车成本。 */
  tollFen?: number | null
  transitLines?: string[]
}

/** 与具体行程地点绑定的一条可核验事实；每条来源独立陈述，便于并列检查冲突。 */
export interface ItineraryFactClaim {
  id: string
  type: ItineraryFactType
  value: string
  scope: string
  evidenceLevel: EvidenceLevel
  sourceId?: string
}

/** 每日行程中不对应地图地点的用餐、休息或机动时间块。 */
export type ItineraryScheduleBlockKind = 'meal' | 'rest' | 'buffer'

/** 只表达时间安排；若需导航到具体餐馆或活动地点，应使用普通停靠点。 */
export interface ItineraryScheduleBlock {
  id: string
  kind: ItineraryScheduleBlockKind
  title: string
  time: string
  durationMinutes: number | null
  area: string
  notes: string
}

/** 仅在触发条件发生时采用的替代地点；不占用正式行程时段。 */
export interface ItineraryConditionalAlternative {
  name: string
  area: string
  trigger: string
  evidenceLevel: 'sourced' | 'pending'
  sourceIds: string[]
  /** 天气备选可标注室内/室外；只作为活动性质提示，地点是否适用仍看来源。 */
  environment?: 'indoor' | 'outdoor' | 'unknown'
}

/** 按已查询天气来源生成的单日状态；没有该日期数据时明确保存为 unknown。 */
export interface ItineraryDayWeather {
  status: 'forecast' | 'unknown'
  summary: string
  sourceId?: string
}

/** 一日中的结构化地点和时间信息，供时间线及地图入口共享。 */
export interface ItineraryStop {
  id: string
  name: string
  area: string
  time: string
  durationMinutes: number | null
  category: string
  notes: string
  transitToNext: string
  /** 用户锁定的预约或必去地点；重新规划时需保留日期、日序和时段。 */
  locked?: boolean
  /** 支持地点/时段/建议内容的当前旅行来源；手动修改相关内容后清空。 */
  sourceIds?: string[]
  /** 来源支撑程度；旧版本缺少此字段时按待核验展示。 */
  evidenceLevel?: EvidenceLevel
  /** 来源给出的营业、票价、预约等地点事实；不把不同来源的值合并成单一结论。 */
  factClaims?: ItineraryFactClaim[]
  /** 条件备选独立记录触发条件与地点来源，不作为日程停靠点。 */
  conditionalAlternatives?: ItineraryConditionalAlternative[]
  transitEstimate?: TransitEstimate
  location?: ItineraryLocation
}

/** 行程中的一天，由用户确认的旅行日期可选关联。 */
export interface ItineraryDay {
  id: string
  dayNumber: number
  date: string
  title: string
  stops: ItineraryStop[]
  scheduleBlocks: ItineraryScheduleBlock[]
  /** 与本日日期匹配的天气预报或明确的未知状态。 */
  weather?: ItineraryDayWeather
  /** 有精确住宿地点且路线成功时，分别保存住宿到首站/末站回住宿的来源路线。 */
  lodgingCommutes?: LodgingCommute[]
}

/** 将住宿接驳路线绑定到每日边界地点，避免误作景点间路线。 */
export interface LodgingCommute {
  direction: 'from-lodging' | 'to-lodging'
  lodgingLocation: string
  stopId: string
  sourceId: string
  mode: RouteMode
  optionNumber: number
  queryDate?: string
  queryTime?: string
  durationMinutes: number
  distanceMeters?: number | null
}

/** 可与其他候选比较、单独审阅和采纳的完整旅行方案。 */
export interface ItineraryOption {
  id: string
  title: string
  summary: string
  tradeoffs: string
  days: ItineraryDay[]
  /** 模型不可编辑的用户餐次约束快照，用于后续修订和保存时重新核验。 */
  mealRequirements?: ItineraryMealRequirement[]
  /** 可追溯的预算范围；手动修改行程后清除，避免保留过期估算。 */
  budgetEstimate?: ItineraryBudgetEstimate
}

export type ItineraryMealSlot = 'breakfast' | 'lunch' | 'dinner'

/** 用户逐日明确提出的餐次硬约束，随候选保存以保证局部修订后仍可校验。 */
export interface ItineraryMealRequirement {
  date: string
  slots: ItineraryMealSlot[]
  excludedSlots?: ItineraryMealSlot[]
  exclusive?: boolean
  requestedStartTimes?: Partial<Record<ItineraryMealSlot, string[]>>
}

/** 中国境内旅行预算的费用分类；金额统一使用人民币分。 */
export type BudgetCostCategory = 'flight' | 'intercity-transport' | 'lodging' | 'local-transport' | 'tickets' | 'meals' | 'other'

/** 单项费用按金额区间乘以明确数量计算；待核验项不提供金额。 */
export interface ItineraryBudgetItem {
  id: string
  category: BudgetCostCategory
  title: string
  amountMinFen: number | null
  amountMaxFen: number | null
  quantity: number
  unitLabel: string
  evidenceLevel: EvidenceLevel
  sourceIds: string[]
  basis: string
}

/** 明确列出不适用的预算类别，避免缺项看起来像零费用。 */
export interface BudgetCategoryExclusion {
  category: BudgetCostCategory
  reason: string
}

/** 每套候选方案独立保存的人民币预算估算。 */
export interface ItineraryBudgetEstimate {
  currency: 'CNY'
  items: ItineraryBudgetItem[]
  notApplicableCategories: BudgetCategoryExclusion[]
}

/** 将餐饮/备选建议绑定到行程停靠点；路线指标必须有路线来源。 */
export interface PreparationLocationContext {
  dayNumber: number
  dayTitle: string
  stopId: string
  stopName: string
  area: string
  placeSourceId: string
  placeName: string
  routeOptionNumber?: number
  distanceMeters?: number
  durationMinutes?: number
  routeSourceId?: string
}

/** 用户确认后保存的预约、穿搭、行李与备选事项。 */
export interface PreparationItem {
  id: string
  title: string
  category: PreparationCategory
  /** 行李事项的收纳位置；旧数据缺少时按待分类展示。 */
  packingSection?: PackingSection
  detail: string
  /** 事项适用的行程日期；不会被当作提醒截止日。 */
  itineraryDate: string
  /** 用户需要在此日期前完成事项时填写。 */
  dueDate: string
  /** 旧版单日期字段含义不明；迁移时保留，需用户确认后清除。 */
  legacyDate?: string
  locationContext?: PreparationLocationContext
  evidenceLevel: EvidenceLevel
  sourceIds: string[]
  checked: boolean
}

/** 用户可修改的准备清单字段；证据和来源始终沿用原记录。 */
export type LegacyPreparationDateAction = 'itinerary' | 'deadline' | 'clear'
export type PreparationItemUpdate = Pick<PreparationItem, 'title' | 'detail' | 'itineraryDate' | 'dueDate'> &
  Pick<Partial<PreparationItem>, 'packingSection'> & { legacyDateAction?: LegacyPreparationDateAction }

export interface ChatMessage {
  id: string
  /** 归属的独立话题；同一旅行中的来源、简报和已确认行程可共享。 */
  conversationId: string
  role: ChatRole
  content: string
  createdAt: string
  sourceIds: string[]
  itineraryOptions?: ItineraryOption[]
  /** 用户明确拒绝的候选 ID；保留在对话中，支持撤销拒绝。 */
  rejectedItineraryOptionIds?: string[]
  preparationOptions?: PreparationItem[]
  briefProposal?: TripBriefProposal
  briefProposalAppliedAt?: string
  /** 仅本地恢复失败的模型工具轮次；不会显示在聊天界面或旅行备份中。 */
  agentRunProgress?: AgentRunProgress
}

/** 持久化模型工具轮次、格式校验提示和工具结果，供本地中断恢复。 */
export interface AgentRunTranscriptMessage {
  role: 'assistant' | 'tool' | 'user'
  content?: string | null
  tool_call_id?: string
  /** 系统代执行的检索步骤保留在恢复记录中，但不占用模型规划轮次。 */
  researchOnly?: true
  /** 本轮允许执行的工具白名单，用于中断恢复时再次校验模型调用。 */
  allowedToolNames?: string[]
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

/** 本地中断恢复点，不含系统提示词、模型密钥或完整旅行快照。 */
export interface AgentRunProgress {
  transcript: AgentRunTranscriptMessage[]
  sourceIds: string[]
  itineraryOptions: ItineraryOption[]
  preparationOptions: PreparationItem[]
  briefProposal?: TripBriefProposal
  updatedAt: string
}

/** 旧 schema 单条消息结构；只在迁移时接收，当前保存结构总有话题 ID。 */
export type LegacyChatMessage = Omit<ChatMessage, 'conversationId'>

/** 单趟旅行中的独立对话话题；消息保存在旅行消息表中并按此 ID 隔离。 */
export interface TripConversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface ItineraryRevision {
  id: string
  number: number
  createdAt: string
  summary: string
  content: string
  sourceIds: string[]
  itinerary?: ItineraryOption
}

export interface Trip {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  brief: TripBrief
  /** 用户明确表示暂时无法确认的简报字段，Agent 不应反复追问。 */
  briefUnknownFields: TripBriefField[]
  conversations: TripConversation[]
  activeConversationId: string
  /** 消息按 conversationId 归属；此数组包含旅行中的所有话题。 */
  messages: ChatMessage[]
  sources: SourceRecord[]
  preparationItems: PreparationItem[]
  revisions: ItineraryRevision[]
  activeRevisionId: string | null
}

/** schema v1–v11 的单话题旅行结构，仅供无损升级现有资料。 */
export type LegacyTrip = Omit<Trip, 'conversations' | 'activeConversationId' | 'messages' | 'briefUnknownFields'> & {
  messages: LegacyChatMessage[]
}

export type ModelProvider = 'openai-compatible' | 'codex-cli'

export interface ModelSettings {
  /** 缺失时按旧版设置解释为 OpenAI-compatible。 */
  provider?: ModelProvider
  baseUrl: string
  model: string
}

/** 用户可独立启停的内置外部数据连接器。 */
export interface ConnectorSettings {
  webSearch: boolean
  weather: boolean
  places: boolean
  routes: boolean
}

/** 可选 OpenCLI 连接配置；只保存启动方式，不保存浏览器凭证。 */
export interface OpenCliSettings {
  enabled: boolean
  command: string
  /** Windows 可用 Node 可执行文件作为 command，并在此填写 OpenCLI 主入口路径。 */
  args: string[]
}

export type McpTransport = 'stdio' | 'streamable-http' | 'sse'

/** 远程 MCP 的静态认证；凭证值始终放在本机凭证库中。 */
export type McpServerAuth =
  | { type: 'none' }
  | { type: 'header' | 'query'; name: string; envKey: string }
  | { type: 'query'; name: 'key'; credential: 'amapKey' }

/** 用户配置的本机或远程 MCP 服务；密钥只保存在主进程凭证库中。 */
export interface McpServerSettings {
  id: string
  name: string
  /** 缺失时按旧版设置解释为 stdio。 */
  transport?: McpTransport
  command: string
  args: string[]
  url?: string
  auth?: McpServerAuth
  envKeys: string[]
  enabled: boolean
  allowedTools: string[]
}

/** MCP 服务公开的只读工具摘要，不向 renderer 暴露连接对象。 */
export interface McpToolDescriptor {
  name: string
  description: string
  readOnly: boolean
  destructive: boolean
}

/** 从设置页提交的 MCP 服务表单；environment 的值只发往主进程凭证库。 */
export interface McpServerInput {
  id?: string
  name: string
  transport?: McpTransport
  command: string
  args: string[]
  url?: string
  auth?: McpServerAuth
  enabled: boolean
  allowedTools: string[]
  environment: Array<{ key: string; value: string }>
}

export interface AppSettings {
  model: ModelSettings
  /** 仅用于网页、天气、地点和路线服务；模型接口仍直连。 */
  sourceProxyUrl: string
  connectors: ConnectorSettings
  xiaohongshu: OpenCliSettings
  /** 用户显式启用后，才允许研究浏览器截图发送给模型。 */
  researchBrowserVisualRead: boolean
  mcpServers: McpServerSettings[]
}

export interface SecretStatus {
  modelKeySaved: boolean
  amapKeySaved: boolean
  amapJsKeySaved: boolean
  amapSecurityCodeSaved: boolean
  exaKeySaved: boolean
  tavilyKeySaved: boolean
  firecrawlKeySaved: boolean
  mcpSecretsSaved: Record<string, string[]>
  /** 本机明文凭证文件路径；API Key 不会进入界面快照。 */
  credentialFilePath: string
  credentialFileRecoveryRequired: boolean
}

/** 地图 JS API 运行配置；安全密钥由主进程代理持有，不发送到 renderer。 */
export interface AmapMapRuntimeConfig {
  jsKey: string
  serviceHost: string
}

export interface AppSnapshot {
  trips: Trip[]
  selectedTripId: string | null
  settings: AppSettings
  secrets: SecretStatus
}

export interface TripBackupImportResult {
  imported: boolean
  snapshot?: AppSnapshot
}

/** 工具给 Agent 的分级反馈；错误阻止候选保存，警告与提示交由模型判断。 */
export type ToolFeedbackSeverity = 'error' | 'warning' | 'info'

export interface ToolFeedback {
  severity: ToolFeedbackSeverity
  code: string
  message: string
}

export interface AgentEvent {
  requestId: string
  tripId: string
  conversationId: string
  type: 'status' | 'tool' | 'tool_result' | 'complete' | 'error'
  message: string
  toolName?: string
  /** 仅用于把同一次工具调用的开始与结果在界面中配对。 */
  toolCallId?: string
  toolOutcome?: 'completed' | 'partial' | 'unavailable' | 'rejected'
  /** 用户可查看的工具校验反馈，不包含模型参数或内部推理。 */
  toolFeedback?: ToolFeedback[]
}

export interface BrowserState {
  url: string
  title: string
  loading: boolean
  error: string
  accessState?: ResearchPageAccessState
  /** Agent 当前或最近一次浏览动作；只用于工作区实时显示，不写入旅行数据。 */
  activity?: BrowserActivity | null
  canGoBack: boolean
  canGoForward: boolean
}

/** 浏览器动作的可见状态，不包含搜索词、表单值或目标页面中的隐私参数。 */
export interface BrowserActivity {
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  message: string
  /** 来自浏览器实际 DOM 动作的阶段，不包含页面文本或搜索词。 */
  phase?: BrowserActivityPhase
}

/** 右侧网页栏展示的当前自动化阶段。 */
export type BrowserActivityPhase =
  | 'opening'
  | 'locating'
  | 'moving'
  | 'pressing'
  | 'clicked'
  | 'scrolling'
  | 'scrolled'
  | 'reading'

/** 只标记页面明确要求用户处理的访问门槛，不尝试自动通过。 */
export type ResearchPageAccessState = 'login-required' | 'verification-required'

/** 右侧研究浏览器允许用户执行的历史导航动作。 */
export type BrowserNavigationAction = 'back' | 'forward' | 'reload'

/** 用户主动查看网页时可导入的正文和页面自报作者/发布时间。 */
export interface ResearchPageContent {
  url: string
  title: string
  text: string
  accessState?: ResearchPageAccessState
  declaredAuthor?: string
  declaredPublishedAt?: string
}

/** 可见研究页中可安全导航的普通链接；不包含表单和可执行脚本。 */
export interface ResearchPageLink {
  text: string
  url: string
}

/** 网页快照提供的短期链接编号；真实查询参数仅保留在隔离浏览器主进程。 */
export interface ResearchBrowserLink extends ResearchPageLink {
  targetId?: string
  /** 搜索结果卡片的邻近摘要；只用于候选排序，不作为事实证据。 */
  context?: string
}

/** 页面快照中由 Agent 调用的临时安全交互目标，不包含表单值或通用选择器。 */
export interface ResearchBrowserInteractionTarget {
  id: string
  action: 'search' | 'expand'
  label: string
}

/** Agent 读取的可见页面快照、有限链接和当前页可交互目标。 */
export interface ResearchBrowserSnapshot extends ResearchPageContent {
  links: ResearchBrowserLink[]
  interactionTargets?: ResearchBrowserInteractionTarget[]
  /** 自动加载超时后读取的稳定页面内容只能作为部分线索。 */
  navigationTimedOut?: boolean
}

/** 用户自行复制粘贴的攻略资料；内容只在本地保存，直到用户发送对话。 */
export interface UserProvidedContentInput {
  title: string
  url?: string
  text: string
}

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

/** 设置页可独立探测的内置服务，不包含地图 JavaScript SDK。 */
export type BuiltinConnectorTestId = 'exa' | 'tavily' | 'firecrawl' | 'amap'

export interface TripwiseApi {
  getSnapshot(): Promise<AppSnapshot>
  createTrip(input?: Partial<TripBrief>): Promise<AppSnapshot>
  selectTrip(tripId: string): Promise<AppSnapshot>
  createConversation(tripId: string): Promise<AppSnapshot>
  selectConversation(tripId: string, conversationId: string): Promise<AppSnapshot>
  deleteConversation(tripId: string, conversationId: string): Promise<AppSnapshot>
  updateTripBrief(tripId: string, brief: TripBrief, unknownFields: TripBriefField[]): Promise<AppSnapshot>
  applyTripBriefProposal(tripId: string, conversationId: string, messageId: string): Promise<AppSnapshot>
  retrySource(tripId: string, sourceId: string): Promise<AppSnapshot>
  skipSourceRetry(tripId: string, sourceId: string): Promise<AppSnapshot>
  deleteSource(tripId: string, sourceId: string): Promise<AppSnapshot>
  deleteTrip(tripId: string): Promise<AppSnapshot>
  exportTripBackup(tripId: string): Promise<{ saved: boolean; path?: string }>
  importTripBackup(): Promise<TripBackupImportResult>
  sendMessage(requestId: string, tripId: string, conversationId: string, content: string, resumeMessageId?: string): Promise<void>
  cancelAgent(requestId: string): Promise<void>
  saveRevision(tripId: string, conversationId: string, messageId: string, itineraryId?: string): Promise<AppSnapshot>
  setItineraryOptionRejected(tripId: string, conversationId: string, messageId: string, itineraryId: string, rejected: boolean): Promise<AppSnapshot>
  saveEditedRevision(tripId: string, baseRevisionId: string, itinerary: ItineraryOption): Promise<AppSnapshot>
  searchMapPlaces(tripId: string, city: string, query: string): Promise<SourceRecord[]>
  estimateRoute(tripId: string, city: string, origin: string, destination: string, mode: RouteMode, date?: string, time?: string): Promise<RouteEstimateResponse>
  savePreparationItems(tripId: string, conversationId: string, messageId: string): Promise<AppSnapshot>
  setPreparationItemChecked(tripId: string, itemId: string, checked: boolean): Promise<AppSnapshot>
  updatePreparationItem(tripId: string, itemId: string, update: PreparationItemUpdate): Promise<AppSnapshot>
  deletePreparationItem(tripId: string, itemId: string): Promise<AppSnapshot>
  activateRevision(tripId: string, revisionId: string): Promise<AppSnapshot>
  updateSettings(settings: AppSettings): Promise<AppSnapshot>
  chooseOpenCliCommand(): Promise<string | null>
  saveMcpServer(input: McpServerInput): Promise<AppSnapshot>
  testMcpServer(input: McpServerInput): Promise<McpToolDescriptor[]>
  removeMcpServer(serverId: string): Promise<AppSnapshot>
  saveSecrets(input: {
    modelKey?: string
    amapKey?: string
    amapJsKey?: string
    amapSecurityCode?: string
    exaKey?: string
    tavilyKey?: string
    firecrawlKey?: string
    clearModelKey?: boolean
    clearAmapKey?: boolean
    clearAmapJsKey?: boolean
    clearAmapSecurityCode?: boolean
    clearExaKey?: boolean
    clearTavilyKey?: boolean
    clearFirecrawlKey?: boolean
  }): Promise<AppSnapshot>
  openLocalCredentialFile(): Promise<AppSnapshot>
  openSystemLogDirectory(): Promise<void>
  getAmapMapConfig(): Promise<AmapMapRuntimeConfig>
  getAmapMapFrameUrl(): Promise<string>
  testModel(): Promise<{ ok: boolean; message: string }>
  testBuiltinConnector(provider: BuiltinConnectorTestId): Promise<{ ok: boolean; message: string }>
  testBuiltinConnector(provider: BuiltinConnectorTestId): Promise<{ ok: boolean; message: string }>
  navigateResearch(url: string): Promise<void>
  /** 在隔离研究网页中执行用户发起的历史导航。 */
  navigateResearchHistory(action: BrowserNavigationAction): Promise<void>
  setResearchBounds(bounds: BrowserBounds): Promise<void>
  getResearchPageText(): Promise<ResearchPageContent>
  importVisiblePage(tripId: string): Promise<AppSnapshot>
  importPastedContent(tripId: string, input: UserProvidedContentInput): Promise<AppSnapshot>
  exportTrip(tripId: string): Promise<{ saved: boolean; path?: string }>
  onAgentEvent(callback: (event: AgentEvent) => void): () => void
  onBrowserState(callback: (state: BrowserState) => void): () => void
}
