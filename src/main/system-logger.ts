/** 提供单进程 JSONL 运行日志；只保留排障元数据，不写用户正文或凭证。 */
import { appendFile, chmod, mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const LOG_NAME = 'tripwise.log'
const MAX_LOG_BYTES = 4 * 1024 * 1024
const ROTATED_FILE_COUNT = 3
const SAFE_TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT',
  'UND_ERR_ABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_STREAM_PREMATURE_CLOSE', 'ERR_NETWORK', 'ERR_INTERNET_DISCONNECTED',
  'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED'
])
const SAFE_TRANSPORT_ERROR_NAMES: Record<string, string> = {
  ConnectTimeoutError: 'UND_ERR_CONNECT_TIMEOUT',
  HeadersTimeoutError: 'UND_ERR_HEADERS_TIMEOUT',
  BodyTimeoutError: 'UND_ERR_BODY_TIMEOUT',
  SocketError: 'UND_ERR_SOCKET'
}
const SAFE_ROUTE_CONFLICT_FAILURE_KINDS = new Set([
  'invalid_arguments', 'revision_day_order', 'explicit_stop_not_removed', 'plan_structure',
  'required_visit_missing', 'duplicate_candidate', 'activity_deadline', 'schedule_overlap',
  'arrival_buffer', 'departure_buffer', 'schedule_order', 'schedule_constraint', 'meal_requirement',
  'duplicate_source_reference', 'source_reference', 'route_evidence', 'evidence_requirement',
  'requested_detail', 'itinerary_validation', 'invalid_option_schema', 'candidate_merge_failed'
])
const SAFE_ROUTE_CONFLICT_SCHEMA_STAGES = new Set([
  'option_header', 'budget_estimate', 'meal_requirements', 'day_count', 'day_header', 'schedule_blocks',
  'day_weather', 'day_stops', 'stop_text', 'stop_evidence', 'stop_sources', 'stop_facts',
  'stop_alternatives', 'stop_evidence_sources', 'stop_lock', 'stop_duration', 'stop_route',
  'stop_location', 'lodging_commutes', 'meal_requirement_dates', 'duplicate_ids'
])
const SAFE_ROUTE_FEEDBACK_CODES = new Set([
  'invalid_input', 'invalid_json', 'invalid_arguments', 'location_unresolved', 'route_unavailable',
  'route_data_missing', 'provider_error', 'input_error', 'tool_unavailable', 'connector_error',
  'provider_unavailable', 'source_unavailable', 'route_plan_not_submitted', 'route_segment_not_planned',
  'route_mode_mismatch', 'route_hub_unconfirmed', 'route_endpoint_unconfirmed', 'route_date_required',
  'route_source_not_bound', 'requested_route_coverage_missing', 'route_date_invalid', 'route_time_invalid'
])
const SAFE_EVIDENCE_SOURCE_KINDS = new Set(['web', 'weather', 'place', 'route', 'user', 'plugin'])
const SAFE_EVIDENCE_SOURCE_STATUSES = new Set(['partial', 'unavailable', 'error'])
/** 仅记录补证预算计数，便于区分额度配置与实际消耗，不保存查询内容。 */
const SAFE_FACT_RESEARCH_BUDGET_COUNTS = new Set([
  'targetCount', 'searchCount', 'pageCount', 'newlySourcedTargetCount', 'reservedSearchCount',
  'reservedSearchCountRemaining', 'availableSearchCount', 'availablePageCount'
])
const SAFE_FIELD_NAMES = new Set([
  'component', 'operation', 'traceId', 'modelFamily', 'reasoningEffort', 'messageCount', 'messageCharacters', 'toolCount',
  'removedCallCount', 'contextCharactersSaved', 'conciseItineraryOutput',
  'systemMessageCharacters', 'userMessageCharacters', 'assistantMessageCharacters', 'toolMessageCharacters',
  'toolCallArgumentCharacters', 'toolSchemaCharacters', 'toolOutputCharacters', 'requestBytes', 'responseBytes',
  'reasoningBytes', 'contentBytes', 'toolCallArgumentBytes', 'maxTokens', 'durationMs',
  'timeoutMs', 'retryAfterMs', 'retryDelayMs', 'responseHeadersMs', 'streamDurationMs', 'streamChunkCount', 'firstChunkMs', 'firstContentMs', 'firstToolCallMs',
  'responseCharacters', 'toolCallCount', 'attempt', 'httpStatus', 'status', 'errorKind', 'toolName', 'sourceCount',
  'itineraryCount', 'preparationCount', 'routeOptionCount',
  'routeFeedbackCodes',
  'routeAvailableCount', 'routeCurrentRunCount', 'routeLinkedCount', 'routeUnboundCount',
  'routeBindingNoAdjacentCount', 'routeBindingModeMismatchCount', 'routeBindingDateMismatchCount',
  'routeBindingTimeMismatchCount', 'routeBindingSummaryUnreadableCount', 'routeBindingMatchingButUnlinkedCount',
  'mealGapCount', 'mealNameGapCount', 'sourceGapCount', 'detailGapCount', 'factResearchStage', 'mealRepairPending', 'mealRepairAttempts',
  'requestedAreaSatisfied', 'pendingRestaurantAllowed', 'routeRepairPending', 'savedProgressPresent', 'resumed',
  'targetCountBefore', 'targetCountAfter', 'mealRepairProgressed',
  'factEvidenceRequestedCount', 'factEvidenceAutoBoundCount', 'factEvidenceRejectedCount', 'factEvidenceSourceUnavailableCount',
  'factEvidenceSourceIneligibleCount', 'factEvidencePlaceMismatchCount', 'factEvidenceScopeMismatchCount', 'factEvidenceValueMismatchCount',
  'factEvidenceOpeningHoursRejectedCount', 'factEvidenceTicketPriceRejectedCount', 'factEvidenceBookingRejectedCount',
  'factEvidenceClosureRejectedCount', 'factEvidenceWeatherRejectedCount', 'factEvidenceTransportTimeRejectedCount',
  'factEvidenceAccessibilityRejectedCount', 'factEvidenceSunsetRejectedCount',
  'factEvidencePhotographyRulesRejectedCount', 'factEvidenceOtherRejectedCount',
  'targetCount', 'searchCount', 'pageCount', 'newlySourcedTargetCount', 'reservedSearchCount',
  'reservedSearchCountRemaining', 'availableSearchCount', 'availablePageCount',
  'mealRepairFailures', 'mealRepairUsed', 'mealRepairRetryAfterPlanRepair', 'rejectedCandidatePending',
  'baselineAvailable', 'baselineDayCount', 'protectedDayCount', 'excludedStopCount', 'targetDayCount', 'restoredProtectedDayCount',
  'routeAttemptId', 'routeDayNumber', 'routeExecutionStage', 'routeFailureKind',
  'routeConflictRepairAttempt', 'routeConflictRepairCount', 'routeConflictRepairValidationRetry',
  'routeConflictRepairFailureKind', 'routeConflictRepairSchemaFailureStage',
  'invalidEvidenceSourceCount', 'invalidEvidenceSourceSummary',
  'routePointRole', 'routeGeocodeVariant', 'routeResolutionStage', 'routeResolutionStatus', 'routeResolutionReason',
  'phase', 'stage', 'platform', 'reason', 'searchProvider', 'searchOutcome', 'toolChoice', 'routeToolOffered', 'windowState', 'persistenceFailureKind',
  'browserNavigationStatus', 'browserSnapshotStatus', 'browserContentLevel', 'browserProgressCode',
  'browserNavigationFailureKind', 'browserNavigationFailureStage', 'browserSearchIntent', 'browserVisibleLinkCount', 'browserLinkSelection',
  'browserLinkSelectionReason', 'browserLinkOpenStatus', 'browserLinkRetryProgressCode', 'browserLinkFailureKind', 'browserLinkFailureStage',
  'browserCircuitFailureCount',
  'codexFailureStage', 'codexFailureReason', 'codexStage', 'codexErrorClass', 'codexServerErrorKind', 'codexUpstreamHttpStatus', 'codexReasoningEffort', 'codexPromptBytes', 'codexSchemaBytes', 'codexImageCount', 'codexExitCode',
  'exitCode', 'processSignal', 'errorCode', 'errorParameter', 'transportCode', 'diagnosticBytes', 'crashed', 'cancelled', 'startupStep', 'sessionCount', 'enabledToolCount',
  'compactItineraryOutput'
])

export type SystemLogLevel = 'info' | 'warn' | 'error'
export type SystemLogValue = string | number | boolean | null | undefined
export type SystemLogFields = Record<string, SystemLogValue>

export interface SystemLogger {
  readonly directory: string
  info(event: string, fields?: SystemLogFields): void
  warn(event: string, fields?: SystemLogFields): void
  error(event: string, fields?: SystemLogFields): void
  flush(): Promise<void>
}

/** 创建可替换测试目录的日志实例；生产目录固定在 Electron userData/logs。 */
export function createSystemLogger(userDataDirectory: string, maxBytes = MAX_LOG_BYTES): SystemLogger {
  const directory = join(userDataDirectory, 'logs')
  const logPath = join(directory, LOG_NAME)
  let queuedWrite = Promise.resolve()
  let writeFailureReported = false

  /** 序列化同一进程中的写入和日志轮换，避免异步工具调用互相覆盖。 */
  function write(level: SystemLogLevel, event: string, fields: SystemLogFields = {}): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      event: safeEventName(event),
      ...safeFields(fields)
    }
    const line = `${JSON.stringify(entry)}\n`
    queuedWrite = queuedWrite.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700).catch(() => undefined)
      await rotateLogIfNeeded(logPath, maxBytes)
      await appendFile(logPath, line, { encoding: 'utf8', mode: 0o600 })
      await chmod(logPath, 0o600).catch(() => undefined)
    }).catch(() => {
      // 文件日志不可用时只输出固定诊断语句，不把原始错误带到终端。
      if (writeFailureReported) return
      writeFailureReported = true
      process.stderr.write('Tripwise: 无法写入本机运行日志。\n')
    })
  }

  return {
    directory,
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    flush: async () => {
      let observedWrite: Promise<void>
      do {
        observedWrite = queuedWrite
        await observedWrite
      } while (observedWrite !== queuedWrite)
    }
  }
}

/** 只接受明确登记的诊断字段，避免调用方误把正文、参数或凭证写入文件。 */
function safeFields(fields: SystemLogFields): SystemLogFields {
  const safe: SystemLogFields = {}
  for (const [name, value] of Object.entries(fields).slice(0, 22)) {
    if (!SAFE_FIELD_NAMES.has(name) || value === undefined) continue
    if (name === 'routeToolOffered' && typeof value !== 'boolean') continue
    if (name === 'routeFeedbackCodes' && !isSafeRouteFeedbackCodes(value)) continue
    if (name === 'traceId' && (typeof value !== 'string' || !/^[a-f0-9-]{36}$/iu.test(value))) continue
    if (name === 'routeAttemptId' && (typeof value !== 'string' || !/^[a-f0-9-]{36}$/iu.test(value))) continue
    if (name === 'routeDayNumber' && (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 31)) continue
    if (SAFE_FACT_RESEARCH_BUDGET_COUNTS.has(name) &&
        (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000)) continue
    if (name === 'routeExecutionStage' && value !== 'model-tool') continue
    if (name === 'routeOptionCount' && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 3)) continue
    if (name === 'routeConflictRepairFailureKind' && !SAFE_ROUTE_CONFLICT_FAILURE_KINDS.has(String(value))) continue
    if (name === 'routeConflictRepairSchemaFailureStage' && !SAFE_ROUTE_CONFLICT_SCHEMA_STAGES.has(String(value))) continue
    if (name === 'routePointRole' && value !== 'origin' && value !== 'destination') continue
    if (name === 'routeGeocodeVariant' && ![
      'raw-input', 'area-address', 'place-name', 'area-address-no-city', 'place-name-no-city',
      'source-place-coordinate', 'poi-coordinate-citycode'
    ].includes(String(value))) continue
    if (name === 'routeResolutionStage' && ![
      'source-coordinate', 'exact-poi', 'exact-poi-no-city', 'raw-input', 'area-address', 'place-name',
      'area-address-no-city', 'place-name-no-city'
    ].includes(String(value))) continue
    if (name === 'routeResolutionStatus' && !['resolved', 'not_found', 'provider_error'].includes(String(value))) continue
    if (name === 'routeResolutionReason' && ![
      'invalid_coordinate', 'no_exact_match', 'ambiguous_match', 'area_conflict', 'city_conflict', 'no_precise_match'
    ].includes(String(value))) continue
    if (name === 'browserNavigationStatus' && !['skipped', 'opened', 'failed'].includes(String(value))) continue
    if (name === 'browserSnapshotStatus' && !['skipped', 'read', 'failed'].includes(String(value))) continue
    if (name === 'browserContentLevel' && !['none', 'snippet', 'page'].includes(String(value))) continue
    if (name === 'browserSearchIntent' && !['general', 'meal', 'community', 'transit', 'attraction'].includes(String(value))) continue
    if (name === 'browserVisibleLinkCount' && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 80)) continue
    if (name === 'browserLinkSelection' && ![
      'not_attempted', 'no_match', 'attraction_named', 'government_fact_page', 'visitor_info_page', 'meal_result', 'community_result',
      'government_transit', 'intent_match'
    ].includes(String(value))) continue
    if (name === 'browserLinkSelectionReason' && ![
      'not_attempted', 'selected', 'no_actionable_links', 'no_public_links', 'attraction_name_missing',
      'attraction_name_not_found', 'attraction_information_hint_missing', 'government_fact_query_not_matched',
      'meal_result_not_found', 'no_community_link',
      'community_query_not_matched', 'government_transit_link_not_found',
      'general_relevance_below_threshold', 'intent_policy_no_match'
    ].includes(String(value))) continue
    if (name === 'browserLinkOpenStatus' && ![
      'not_attempted', 'page_budget_exhausted', 'invalid_link', 'duplicate', 'page_read',
      'retry_page_read', 'retry_failed', 'no_page', 'read_failed', 'error'
    ].includes(String(value))) continue
    if (name === 'browserNavigationFailureKind' && ![
      'aborted', 'address_unreachable', 'connection_closed', 'connection_refused', 'connection_reset',
      'dns', 'http', 'offline', 'network', 'proxy', 'blocked', 'timeout', 'tls', 'unknown'
    ].includes(String(value))) continue
    if (name === 'browserNavigationFailureStage' && ![
      'requested', 'started', 'redirected', 'committed'
    ].includes(String(value))) continue
    if (name === 'browserLinkFailureKind' && ![
      'aborted', 'address_unreachable', 'connection_closed', 'connection_refused', 'connection_reset',
      'dns', 'http', 'offline', 'network', 'proxy', 'blocked', 'timeout', 'tls', 'unknown',
      'stale_snapshot', 'access_gate'
    ].includes(String(value))) continue
    if (name === 'browserLinkFailureStage' && ![
      'snapshot_page_changed', 'target_not_in_snapshot', 'snapshot_registry_missing',
      'snapshot_registry_page_changed', 'snapshot_target_missing', 'snapshot_target_url_missing',
      'target_not_found_after_rerender', 'target_ambiguous_after_rerender',
      'target_not_rendered', 'target_detached_during_scroll', 'target_scroll_unstable',
      'target_scroll_did_not_move', 'target_scroll_incomplete', 'cursor_action_failed', 'cursor_script_execution'
    ].includes(String(value))) continue
    if ((name === 'browserProgressCode' || name === 'browserLinkRetryProgressCode') && ![
      'browser_navigation_read_completed', 'browser_navigation_read_partial', 'browser_search_results_read', 'browser_navigation_read_blocked',
      'browser_navigation_read_unavailable', 'browser_link_opened', 'browser_link_read_partial', 'browser_link_read_unavailable',
      'browser_link_unavailable', 'browser_interact_search_completed', 'browser_interact_expand_completed',
      'browser_interact_target_stale', 'browser_interact_write_blocked', 'browser_interact_search_unsupported',
      'browser_interact_unavailable', 'browser_visual_read_completed', 'browser_visual_read_blocked',
      'browser_visual_read_unsupported', 'browser_visual_read_limit', 'browser_visual_read_unavailable'
    ].includes(String(value))) continue
    if (name === 'transportCode' && !isSafeTransportCode(value)) continue
    if (name === 'routeFailureKind' && ![
      'location_unresolved', 'route_unavailable', 'route_data_missing', 'provider_error',
      'input_error', 'tool_unavailable', 'connector_error'
    ].includes(String(value))) continue
    if (name === 'stage' && ![
      'setup', 'preflight', 'tool_recovery', 'tool_loop', 'model_request', 'model_response',
      'tool_execution', 'finalization', 'result_persistence', 'completion_checks'
    ].includes(String(value))) continue
    if (name === 'codexFailureStage' && ![
      'input_prepare', 'app_server', 'turn_start', 'stream', 'thread_start', 'thread_resume', 'output_parse'
    ].includes(String(value))) continue
    if (name === 'codexFailureReason' && ![
      'rate_limited', 'quota_exceeded', 'context_limit', 'authentication', 'timeout', 'network_error',
      'quota', 'network', 'thread_missing', 'invalid_request', 'unsupported_request', 'active_turn', 'output_schema',
      'sandbox_policy', 'model_config', 'protocol', 'thread_state', 'turn_input', 'no_active_turn',
      'process_exit', 'turn_failed', 'upstream_error', 'policy_blocked', 'unknown_error'
    ].includes(String(value))) continue
    if (name === 'codexErrorClass' && ![
      'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError',
      'AbortError', 'TimeoutError', 'OtherError'
    ].includes(String(value))) continue
    if (name === 'codexServerErrorKind' && ![
      'contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded', 'flexUnavailable',
      'serverOverloaded', 'modelNotFound', 'policyCapacityUnavailable', 'cyberPolicy', 'misalignmentPolicyViolation',
      'tooManyDenials', 'httpConnectionFailed', 'responseStreamConnectionFailed', 'internalServerError',
      'unauthorized', 'badRequest', 'threadRollbackFailed', 'sandboxError', 'responseStreamDisconnected',
      'responseTooManyFailedAttempts', 'activeTurnNotSteerable'
    ].includes(String(value))) continue
    if (name === 'codexUpstreamHttpStatus' &&
        (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 599)) continue
    if (name === 'codexReasoningEffort' && !['low', 'medium', 'high', 'max'].includes(String(value))) continue
    if (name === 'codexPromptBytes' || name === 'codexSchemaBytes') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 64_000_000) continue
    }
    if (name === 'codexImageCount' && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 4)) continue
    if ((name === 'codexExitCode' || name === 'exitCode') &&
        (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255)) continue
    if (name === 'processSignal' && ![
      'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGKILL',
      'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM'
    ].includes(String(value))) continue
    if (name === 'diagnosticBytes' &&
        (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 8_000)) continue
    if (name === 'persistenceFailureKind' && ![
      'message_schema', 'conversation_reference', 'duplicate_message', 'source_reference_missing',
      'source_not_successful', 'lodging_route_mismatch', 'schedule_conflict', 'unknown'
    ].includes(String(value))) continue
    if (name === 'invalidEvidenceSourceCount' &&
        (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000)) continue
    if (name === 'invalidEvidenceSourceSummary' && !isSafeEvidenceSourceSummary(value)) continue
    if (name === 'searchProvider' && !['Exa', 'Tavily', 'Firecrawl', 'DuckDuckGo'].includes(String(value))) continue
    if (name === 'searchOutcome' && !['results', 'empty', 'failed', 'cancelled'].includes(String(value))) continue
    if (typeof value === 'string') safe[name] = safeText(value)
    else if (typeof value === 'number' && Number.isFinite(value)) safe[name] = value
    else if (typeof value === 'boolean' || value === null) safe[name] = value
  }
  return safe
}

/** 路线工具和计划回执仅保留固定错误码，拒绝地点名或任意回显文本。 */
function isSafeRouteFeedbackCodes(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 160) return false
  if (!value) return true
  const codes = value.split(',')
  return codes.length <= 4 && codes.every((code) => SAFE_ROUTE_FEEDBACK_CODES.has(code))
}

/** 为评测日志提取至多四个固定路线反馈码，不携带用户内容。 */
export function safeRouteFeedbackCodes(codes: readonly string[]): string[] {
  return [...new Set(codes.filter((code) => SAFE_ROUTE_FEEDBACK_CODES.has(code)))].slice(0, 4)
}

/** 只允许来源类型、固定状态和计数组成的保存失败摘要。 */
function isSafeEvidenceSourceSummary(value: unknown): value is string {
  if (value === 'none') return true
  if (typeof value !== 'string' || value.length > 400) return false
  const entries = value.split(',')
  if (entries.length > SAFE_EVIDENCE_SOURCE_KINDS.size * SAFE_EVIDENCE_SOURCE_STATUSES.size) return false
  return entries.every((entry) => {
    const match = /^(web|weather|place|route|user|plugin):(partial|unavailable|error)=([1-9]\d{0,2})$/u.exec(entry)
    return !!match && SAFE_EVIDENCE_SOURCE_KINDS.has(match[1] ?? '') &&
      SAFE_EVIDENCE_SOURCE_STATUSES.has(match[2] ?? '') && Number(match[3]) <= 100
  })
}

/** 统一裁切文本并遮盖常见令牌格式，日志字段只用于状态和错误分类。 */
function safeText(value: string): string {
  return value.slice(0, 160)
    .replace(/\b(?:Bearer|Basic|Token)\s+[^\s,;]+/giu, '[已隐藏凭证]')
    .replace(/\b(?:sk-|fc-|tvly-|AIza)[A-Za-z0-9_-]{12,}\b/giu, '[已隐藏凭证]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|密钥|令牌|密码)\s*[:=]\s*)[^\s,;&}]+/giu, '$1[已隐藏]')
}

/** 避免把任意输入内容当成日志事件名，保留稳定的点分层级。 */
function safeEventName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/gu, '_').slice(0, 80) || 'system.event'
}

/** 单文件超限时保留三个轮转文件；旧日志删除范围仅限本应用日志名。 */
async function rotateLogIfNeeded(logPath: string, maxBytes: number): Promise<void> {
  let size = 0
  try {
    size = (await stat(logPath)).size
  } catch {
    return
  }
  if (size < maxBytes) return

  await rm(`${logPath}.${ROTATED_FILE_COUNT}`, { force: true }).catch(() => undefined)
  for (let index = ROTATED_FILE_COUNT - 1; index >= 1; index -= 1) {
    const current = `${logPath}.${index}`
    const next = `${logPath}.${index + 1}`
    await rm(next, { force: true }).catch(() => undefined)
    await rename(current, next).catch(() => undefined)
  }
  await rm(`${logPath}.1`, { force: true }).catch(() => undefined)
  await rename(logPath, `${logPath}.1`).catch(() => undefined)
}

let activeLogger: SystemLogger | null = null

/** 按当前应用数据目录初始化进程级日志；测试和外部进程不得改写正式资料目录。 */
export function configureSystemLogger(userDataDirectory: string): SystemLogger {
  activeLogger = createSystemLogger(userDataDirectory)
  return activeLogger
}

/** 仅在应用完成初始化后使用；尚未初始化时安全忽略启动前事件。 */
export function logSystemEvent(level: SystemLogLevel, event: string, fields: SystemLogFields = {}): void {
  activeLogger?.[level](event, fields)
}

/** 供应用退出时等待排队中的轻量日志写入完成。 */
export async function flushSystemLogs(): Promise<void> {
  await activeLogger?.flush()
}

/** 返回运行日志目录给主进程原生文件管理器使用，不暴露任意路径参数。 */
export function systemLogDirectory(): string {
  if (!activeLogger) throw new Error('运行日志尚未初始化。')
  return activeLogger.directory
}

/** 将异常归类为稳定标签；日志不读取或保存供应商错误原文。 */
export function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/abort|cancel|取消/iu.test(message)) return 'cancelled'
  if (/timeout|timed out|超时|deadline|单轮请求超过\s*\d+\s*分钟/iu.test(message)) return 'timeout'
  if (/insufficient_quota|billing_hard_limit_reached|额度不足|余额不足/iu.test(message)) return 'quota_exceeded'
  if (/HTTP 429|限流/u.test(message)) return 'rate_limited'
  if (/HTTP \d{3}/iu.test(message)) return 'http_error'
  if (/network|connection|socket|proxy|连接中断|网络/iu.test(message)) return 'network_error'
  if (/输出.{0,8}(?:长度上限|长度限制)|响应超过安全读取上限|返回内容过大/u.test(message)) return 'output_limit'
  if (/行程方案已保留，但出行准备清单尚未完成/u.test(message)) return 'preparation_incomplete'
  if (/暂未生成可审阅的行程方案/u.test(message)) return 'itinerary_incomplete'
  if (/只返回.{0,8}推理|没有生成可显示答复|未返回可显示正文|没有返回可显示正文|无可显示正文/u.test(message)) return 'empty_model_response'
  if (/内容过滤|过滤了本次响应/u.test(message)) return 'content_filtered'
  if (/无效的 JSON 响应|JSON 分块/u.test(message)) return 'invalid_model_response'
  if (/响应无法读取/u.test(message)) return 'response_read_error'
  if (/invalid|格式|无效|必须|需要|请先/iu.test(message)) return 'input_error'
  return 'unknown_error'
}

/** 只返回内建异常类别，避免日志记录任意自定义 name 或异常正文。 */
export function safeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return 'OtherError'
  const known = new Set([
    'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError',
    'AbortError', 'TimeoutError'
  ])
  return known.has(error.name) ? error.name : 'OtherError'
}

/** 仅把草案保存失败映射到固定类别，日志不保留错误正文或旅行内容。 */
export function classifyPersistenceFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message === '对话消息结构无效，无法保存。') return 'message_schema'
  if (message === '对话消息所属的话题无效。') return 'conversation_reference'
  if (message === '对话消息 ID 已存在，无法重复保存。') return 'duplicate_message'
  if (message === '对话方案引用了当前旅行中不存在的来源，请重新检索后再提交。') return 'source_reference_missing'
  if (message === '行程地点只能引用当前旅行中的成功来源。') return 'source_not_successful'
  if (message === '住宿接驳必须引用当前住宿地点、每日边界地点和匹配的成功路线来源。') return 'lodging_route_mismatch'
  if (/^行程存在 \d+ 处明确时段重叠或接驳冲突，请修正后再保存：/u.test(message)) return 'schedule_conflict'
  return 'unknown'
}

/** 判断诊断码是否来自固定的网络错误白名单。 */
export function isSafeTransportCode(value: unknown): value is string {
  return typeof value === 'string' && SAFE_TRANSPORT_CODES.has(value)
}

/** 从异常 cause 链中提取已知传输错误码，拒绝记录任意底层文本。 */
export function safeTransportErrorCode(error: unknown): string | undefined {
  let candidate = error
  for (let depth = 0; depth < 4 && candidate && typeof candidate === 'object'; depth += 1) {
    const record = candidate as { code?: unknown; name?: unknown; cause?: unknown }
    if (isSafeTransportCode(record.code)) return record.code
    if (typeof record.name === 'string' && SAFE_TRANSPORT_ERROR_NAMES[record.name]) {
      return SAFE_TRANSPORT_ERROR_NAMES[record.name]
    }
    candidate = record.cause
  }
  return undefined
}
