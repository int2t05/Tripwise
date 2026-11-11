/** 为北京实跑断言提供与行程餐次规则一致的纯计算指标。 */

/** 按明确餐名优先、否则按开始时刻识别餐次。 */
export function mealSlot(label, time) {
  if (/早餐|早饭|早间|早晨|早上/u.test(label)) return 'breakfast'
  if (/午餐|午饭|中午/u.test(label)) return 'lunch'
  if (/晚餐|晚饭|傍晚|晚间|晚上/u.test(label)) return 'dinner'
  const match = String(time).match(/(?:^|[^\d])(\d{1,2}):([0-5]\d)(?!\d)/u)
  if (!match) return undefined
  const hour = Number(match[1])
  return hour < 11 ? 'breakfast' : hour < 16 ? 'lunch' : 'dinner'
}

/** 仅当来源同时提及品牌与计划中写明的分店，才计为可用直证。 */
export function sourceSupportsMealName(name, source) {
  const evidence = [source.title, source.summary, source.factEvidenceExcerpt]
    .filter((text) => typeof text === 'string')
    .map(normalizeEvidenceText).join(' ')
  const baseName = name.split(/[（(]/u, 1)[0].trim()
  const baseNeedle = normalizeEvidenceText(baseName)
  if (baseNeedle.length < 2 || !evidence.includes(baseNeedle)) return false
  const branches = [...name.matchAll(/[（(]([^）)]+)[）)]/gu)]
    .map((match) => normalizeEvidenceText(match[1] ?? ''))
  return branches.every((branch) => branch.length >= 2 && evidence.includes(branch))
}

function normalizeEvidenceText(value) {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[^\p{L}\p{N}]/gu, '')
}

/** 只统计真实餐饮停靠点或餐次块，避免将晚间景点误计为晚餐。 */
export function hasFrontGateDinner(day) {
  const stopHasDinner = (stop) => {
    const mealLabel = `${stop.name} ${stop.category} ${stop.notes}`
    const isMeal = /餐|用餐|美食/u.test(stop.category) || /早餐|早饭|午餐|午饭|晚餐|晚饭|用餐/u.test(mealLabel)
    const location = `${stop.name} ${stop.area} ${stop.notes}`
    const scheduleLabel = `${stop.name} ${stop.category} ${stop.time} ${stop.notes}`
    return isMeal && mealSlot(scheduleLabel, stop.time) === 'dinner' && hasFrontGateArea(location)
  }
  const blockHasDinner = (block) => {
    const location = `${block.title} ${block.area} ${block.notes}`
    return block.kind === 'meal' && mealSlot(`${block.title} ${block.time} ${block.notes}`, block.time) === 'dinner' &&
      hasFrontGateArea(location)
  }
  return (day?.stops ?? []).some(stopHasDinner) || (day?.scheduleBlocks ?? []).some(blockHasDinner)
}

/** 输出定位 Agent 保存失败所需的安全分类，不携带异常原文或行程内容。 */
export function runFailureSummary(route) {
  const progressFailures = new Set(['itinerary_schema', 'progress_schema', 'store_rejected'])
  const persistenceFailures = new Set([
    'message_schema', 'conversation_reference', 'duplicate_message', 'source_reference_missing',
    'source_not_successful', 'lodging_route_mismatch', 'schedule_conflict', 'unknown'
  ])
  return {
    ...(persistenceFailures.has(route?.persistenceFailureKind)
      ? { persistenceFailureKind: route.persistenceFailureKind } : {}),
    ...(progressFailures.has(route?.progressSaveFailureKind)
      ? { progressSaveFailureKind: route.progressSaveFailureKind } : {})
  }
}

/** 按安全枚举汇总路线修复失败类别，便于区分校验拒绝与模型未提交。 */
export function routeConflictRepairSummary(entries, traceId) {
  const failureKinds = new Set([
    'invalid_arguments', 'revision_day_order', 'explicit_stop_not_removed', 'plan_structure',
    'required_visit_missing', 'duplicate_candidate', 'activity_deadline', 'schedule_overlap',
    'arrival_buffer', 'departure_buffer', 'schedule_order', 'schedule_constraint', 'meal_requirement',
    'duplicate_source_reference', 'source_reference', 'route_evidence', 'evidence_requirement',
    'requested_detail', 'itinerary_validation', 'invalid_option_schema', 'candidate_merge_failed'
  ])
  const schemaStages = new Set([
    'option_header', 'budget_estimate', 'meal_requirements', 'day_count', 'day_header', 'schedule_blocks',
    'day_weather', 'day_stops', 'stop_text', 'stop_evidence', 'stop_sources', 'stop_facts',
    'stop_alternatives', 'stop_evidence_sources', 'stop_lock', 'stop_duration', 'stop_route',
    'stop_location', 'lodging_commutes', 'meal_requirement_dates', 'duplicate_ids'
  ])
  const deferredReasons = new Set(['candidate_not_saved', 'model_request_failed', 'model_did_not_submit_candidate'])
  const scheduled = entries.filter((entry) => entry.traceId === traceId && entry.event === 'agent.route_conflict_repair.scheduled')
  const saved = entries.filter((entry) => entry.traceId === traceId && entry.event === 'agent.route_conflict_repair.proposal_saved')
  const deferred = entries.filter((entry) => entry.traceId === traceId && entry.event === 'agent.route_conflict_repair.deferred')
  const retries = entries.filter((entry) => entry.traceId === traceId && entry.event === 'agent.route_conflict_repair.validation_retry')
  const deferredReasonCounts = {}
  const validationFailureCounts = {}
  const schemaFailureStageCounts = {}
  for (const entry of deferred) {
    if (deferredReasons.has(entry.reason)) increment(deferredReasonCounts, entry.reason)
  }
  for (const entry of [...retries, ...deferred]) {
    if (failureKinds.has(entry.routeConflictRepairFailureKind)) {
      increment(validationFailureCounts, entry.routeConflictRepairFailureKind)
    }
  }
  for (const entry of [...retries, ...deferred]) {
    if (schemaStages.has(entry.routeConflictRepairSchemaFailureStage)) {
      increment(schemaFailureStageCounts, entry.routeConflictRepairSchemaFailureStage)
    }
  }
  return {
    scheduledCount: scheduled.length,
    proposalSavedCount: saved.length,
    deferredCount: deferred.length,
    conflictCount: scheduled.reduce((sum, entry) =>
      sum + (Number.isSafeInteger(entry.routeConflictRepairCount) && entry.routeConflictRepairCount >= 0
        ? entry.routeConflictRepairCount : 0), 0),
    validationRetryCount: retries.length,
    deferredReasons: deferredReasonCounts,
    failureKinds: validationFailureCounts,
    schemaFailureStages: schemaFailureStageCounts
  }
}

/** 汇总模型实际发起的路线工具调用，不输出地点、端点或请求内容。 */
export function routeLookupSummary(entries, traceId) {
  const statuses = new Set([
    'success', 'location_unresolved', 'route_unavailable', 'route_data_missing',
    'provider_error', 'input_error', 'tool_unavailable', 'connector_error'
  ])
  const feedbackCodes = new Set([
    'invalid_input', 'invalid_json', 'invalid_arguments', 'location_unresolved', 'route_unavailable',
    'route_data_missing', 'provider_error', 'input_error', 'tool_unavailable', 'connector_error',
    'provider_unavailable', 'source_unavailable',
    'route_plan_not_submitted', 'route_segment_not_planned', 'route_mode_mismatch',
    'route_hub_unconfirmed', 'route_endpoint_unconfirmed', 'route_date_required',
    'route_data_missing', 'route_source_not_bound', 'requested_route_coverage_missing',
    'route_date_invalid', 'route_time_invalid'
  ])
  const outcomeCounts = {}
  const feedbackCodeCounts = {}
  const attemptsByDay = {}
  let routeOptionCount = 0
  let durationMs = 0
  let lookupCount = 0
  for (const entry of entries) {
    if (entry.traceId === traceId && entry.event === 'agent.tool.result.saved' &&
        ['estimate_route', 'propose_itineraries'].includes(entry.toolName)) {
      for (const code of String(entry.routeFeedbackCodes ?? '').split(',')) {
        if (feedbackCodes.has(code)) feedbackCodeCounts[code] = (feedbackCodeCounts[code] ?? 0) + 1
      }
    }
    if (entry.traceId !== traceId || entry.event !== 'agent.route.lookup.completed') continue
    lookupCount += 1
    const status = statuses.has(entry.status) ? entry.status : 'other'
    outcomeCounts[status] = (outcomeCounts[status] ?? 0) + 1
    if (Number.isInteger(entry.routeDayNumber) && entry.routeDayNumber >= 1 && entry.routeDayNumber <= 31) {
      attemptsByDay[entry.routeDayNumber] = (attemptsByDay[entry.routeDayNumber] ?? 0) + 1
    }
    if (Number.isInteger(entry.routeOptionCount) && entry.routeOptionCount >= 0 && entry.routeOptionCount <= 3) {
      routeOptionCount += entry.routeOptionCount
    }
    if (Number.isInteger(entry.durationMs) && entry.durationMs >= 0 && entry.durationMs <= 5_400_000) {
      durationMs += entry.durationMs
    }
  }
  return { lookupCount, outcomeCounts, feedbackCodeCounts, attemptsByDay, routeOptionCount, durationMs }
}

/** 统计已提交行程后的模型请求是否获配路线工具，只返回固定计数。 */
export function routeToolVisibilitySummary(entries, traceId) {
  const prepared = entries.filter((entry) => entry.traceId === traceId && entry.event === 'agent.request.prepared')
  const afterPlan = prepared.filter((entry) => Number(entry.itineraryCount) > 0)
  return {
    preparedRequestCount: prepared.length,
    afterPlanRequestCount: afterPlan.length,
    afterPlanVisibilityRecordedCount: afterPlan.filter((entry) => typeof entry.routeToolOffered === 'boolean').length,
    afterPlanRouteToolOfferedCount: afterPlan.filter((entry) => entry.routeToolOffered === true).length,
    afterPlanRouteToolUnavailableCount: afterPlan.filter((entry) => entry.routeToolOffered === false).length
  }
}

/** 汇总单次搜索运行的固定渠道诊断，不复制检索词、网页地址或正文。 */
export function searchProviderOutcomeSummary(entries, traceId) {
  const providers = new Set(['Exa', 'Tavily', 'Firecrawl', 'DuckDuckGo'])
  const outcomes = new Set(['results', 'empty', 'failed', 'cancelled'])
  const reasons = new Set([
    'quota', 'plan_limit', 'rate_limit', 'request_error', 'endpoint_error', 'network_or_timeout',
    'access_error', 'server_error', 'provider_or_format_error'
  ])
  const summary = {}
  for (const entry of entries) {
    if (entry.traceId !== traceId || entry.event !== 'search.provider.request_completed' ||
        !providers.has(entry.searchProvider) || !outcomes.has(entry.searchOutcome)) continue
    const provider = entry.searchProvider
    summary[provider] ??= {
      requests: 0, resultRequests: 0, emptyRequests: 0, failedRequests: 0, cancelledRequests: 0,
      sourceCount: 0, durationMs: 0, failureReasons: {}
    }
    const item = summary[provider]
    item.requests += 1
    const countField = {
      results: 'resultRequests', empty: 'emptyRequests', failed: 'failedRequests', cancelled: 'cancelledRequests'
    }[entry.searchOutcome]
    item[countField] += 1
    if (Number.isSafeInteger(entry.sourceCount) && entry.sourceCount >= 0 && entry.sourceCount <= 100) {
      item.sourceCount += entry.sourceCount
    }
    if (Number.isSafeInteger(entry.durationMs) && entry.durationMs >= 0 && entry.durationMs <= 600_000) {
      item.durationMs += entry.durationMs
    }
    if (entry.searchOutcome === 'failed' && reasons.has(entry.reason)) {
      item.failureReasons[entry.reason] = (item.failureReasons[entry.reason] ?? 0) + 1
    }
  }
  return summary
}

/** 汇总浏览器工具固定结果码与失败阶段，定位导航、开链和正文读取问题。 */
export function browserToolOutcomeSummary(entries, traceId) {
  const tools = new Set([
    'research_browser_navigate', 'research_browser_snapshot', 'research_browser_open_link',
    'research_browser_interact', 'research_browser_scroll', 'research_browser_visual_read'
  ])
  const progressCodes = new Set([
    'browser_navigation_read_completed', 'browser_search_results_read', 'browser_navigation_read_blocked',
    'browser_navigation_read_unavailable', 'browser_link_opened', 'browser_link_read_unavailable',
    'browser_link_unavailable', 'browser_interact_search_completed', 'browser_interact_expand_completed',
    'browser_interact_target_stale', 'browser_interact_write_blocked', 'browser_interact_search_unsupported',
    'browser_interact_unavailable', 'browser_visual_read_completed', 'browser_visual_read_blocked',
    'browser_visual_read_unsupported', 'browser_visual_read_limit', 'browser_visual_read_unavailable'
  ])
  const linkFailureKinds = new Set([
    'aborted', 'address_unreachable', 'connection_closed', 'connection_refused', 'connection_reset',
    'dns', 'http', 'offline', 'network', 'proxy', 'blocked', 'timeout', 'tls', 'unknown',
    'stale_snapshot', 'access_gate'
  ])
  const linkFailureStages = new Set([
    'snapshot_page_changed', 'target_not_in_snapshot', 'snapshot_registry_missing',
    'snapshot_registry_page_changed', 'snapshot_target_missing', 'snapshot_target_url_missing',
    'target_not_found_after_rerender', 'target_ambiguous_after_rerender',
    'target_not_rendered', 'target_detached_during_scroll', 'target_scroll_unstable',
    'target_scroll_did_not_move', 'target_scroll_incomplete', 'cursor_action_failed', 'cursor_script_execution'
  ])
  const navigationFailureKinds = new Set([
    'aborted', 'address_unreachable', 'connection_closed', 'connection_refused', 'connection_reset',
    'dns', 'http', 'offline', 'network', 'proxy', 'blocked', 'timeout', 'tls', 'unknown'
  ])
  const navigationFailureStages = new Set(['requested', 'started', 'redirected', 'committed'])
  const summary = {
    callsByTool: {}, progressCodes: {}, linkFailureKinds: {}, linkFailureStages: {},
    navigationFailureKinds: {}, navigationFailureStages: {}
  }
  for (const entry of entries) {
    if (entry.traceId !== traceId || entry.event !== 'agent.tool.returned' || !tools.has(entry.toolName)) continue
    increment(summary.callsByTool, entry.toolName)
    if (progressCodes.has(entry.browserProgressCode)) increment(summary.progressCodes, entry.browserProgressCode)
    if (linkFailureKinds.has(entry.browserLinkFailureKind)) increment(summary.linkFailureKinds, entry.browserLinkFailureKind)
    if (linkFailureStages.has(entry.browserLinkFailureStage)) increment(summary.linkFailureStages, entry.browserLinkFailureStage)
    if (navigationFailureKinds.has(entry.browserNavigationFailureKind)) increment(summary.navigationFailureKinds, entry.browserNavigationFailureKind)
    if (navigationFailureStages.has(entry.browserNavigationFailureStage)) increment(summary.navigationFailureStages, entry.browserNavigationFailureStage)
  }
  return summary
}

/** 汇总模型失败的固定类别与协议字段，不输出请求内容、服务地址或原始错误。 */
export function modelFailureSummary(entries, traceId) {
  const errorKinds = new Set([
    'cancelled', 'timeout', 'quota_exceeded', 'rate_limited', 'http_error', 'network_error',
    'output_limit', 'preparation_incomplete', 'itinerary_incomplete', 'empty_model_response',
    'content_filtered', 'invalid_model_response', 'response_read_error', 'input_error', 'unknown_error'
  ])
  const providerCodes = new Set([
    'insufficient_quota', 'billing_hard_limit_reached', 'rate_limit_exceeded', 'invalid_api_key',
    'model_not_found', 'context_length_exceeded', 'invalid_request_error', 'unsupported_value'
  ])
  const providerParameters = new Set([
    'max_tokens', 'max_completion_tokens', 'reasoning_effort', 'tool_choice', 'tools', 'messages', 'temperature', 'stream'
  ])
  const transportCodes = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT',
    'UND_ERR_ABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET', 'UND_ERR_STREAM_PREMATURE_CLOSE', 'ERR_NETWORK', 'ERR_INTERNET_DISCONNECTED',
    'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED'
  ])
  const requestFailureKinds = {}
  const httpFailures = {}
  const streamFailureKinds = {}
  const streamTransportCodes = {}
  const transportEvents = { retries: 0, failures: 0, codes: {} }
  const codexFailureStages = new Set([
    'input_prepare', 'app_server', 'turn_start', 'stream', 'thread_start', 'thread_resume', 'output_parse'
  ])
  const codexFailureReasons = new Set([
    'rate_limited', 'quota', 'quota_exceeded', 'context_limit', 'authentication', 'timeout', 'network', 'network_error',
    'thread_missing', 'invalid_request', 'unsupported_request', 'active_turn', 'output_schema',
    'sandbox_policy', 'model_config', 'protocol', 'thread_state', 'turn_input', 'process_exit',
    'turn_failed', 'upstream_error', 'policy_blocked', 'unknown_error'
  ])
  const codexErrorClasses = new Set([
    'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError',
    'AbortError', 'TimeoutError', 'OtherError'
  ])
  const codexServerErrorKinds = new Set([
    'contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded', 'flexUnavailable',
    'serverOverloaded', 'modelNotFound', 'policyCapacityUnavailable', 'cyberPolicy', 'misalignmentPolicyViolation',
    'tooManyDenials', 'httpConnectionFailed', 'responseStreamConnectionFailed', 'internalServerError',
    'unauthorized', 'badRequest', 'threadRollbackFailed', 'sandboxError', 'responseStreamDisconnected',
    'responseTooManyFailedAttempts', 'activeTurnNotSteerable'
  ])
  const processSignals = new Set([
    'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGKILL',
    'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM'
  ])
  const processExitByTrace = new Map()
  for (const entry of entries) {
    if (entry.traceId !== traceId || entry.event !== 'llm.codex_app_server.process.exited' || entry.status !== 'failed') continue
    const processExit = {
      ...(safeBoundedInteger(entry.exitCode, 0, 255) !== undefined ? { exitCode: entry.exitCode } : {}),
      ...(processSignals.has(entry.processSignal) ? { processSignal: entry.processSignal } : {}),
      ...(safeBoundedInteger(entry.diagnosticBytes, 0, 8_000) !== undefined
        ? { diagnosticBytes: entry.diagnosticBytes } : {})
    }
    if (Object.keys(processExit).length) processExitByTrace.set(entry.traceId, processExit)
  }
  const codexFailureDetails = []
  const codexErrorNotifications = { total: 0, retrying: 0, byKind: {}, httpStatuses: {} }
  let rateLimitRetries = 0

  for (const entry of entries) {
    if (entry.traceId !== traceId) continue
    if (entry.event === 'llm.codex_app_server.error_notification') {
      if (!['retrying', 'reported'].includes(entry.status)) continue
      codexErrorNotifications.total += 1
      if (entry.status === 'retrying') codexErrorNotifications.retrying += 1
      increment(codexErrorNotifications.byKind,
        codexServerErrorKinds.has(entry.codexServerErrorKind) ? entry.codexServerErrorKind : 'unclassified')
      if (safeBoundedInteger(entry.codexUpstreamHttpStatus, 100, 599) !== undefined) {
        increment(codexErrorNotifications.httpStatuses, String(entry.codexUpstreamHttpStatus))
      }
    } else if (entry.event === 'llm.request.failed' && errorKinds.has(entry.errorKind)) {
      increment(requestFailureKinds, entry.errorKind)
      if (entry.modelFamily === 'gpt-6-luna-codex-cli' || entry.modelFamily === 'gpt-6-luna-codex-app-server') {
        const processExit = processExitByTrace.get(entry.traceId)
        const exitCode = safeBoundedInteger(entry.codexExitCode, 0, 255) ?? processExit?.exitCode
        const processSignal = processSignals.has(entry.processSignal) ? entry.processSignal : processExit?.processSignal
        const diagnosticBytes = safeBoundedInteger(entry.diagnosticBytes, 0, 8_000) ?? processExit?.diagnosticBytes
        codexFailureDetails.push({
          errorKind: entry.errorKind,
          ...(codexFailureStages.has(entry.codexFailureStage) ? { stage: entry.codexFailureStage } : {}),
          ...(codexErrorClasses.has(entry.codexErrorClass) ? { errorClass: entry.codexErrorClass } : {}),
          ...(codexFailureReasons.has(entry.codexFailureReason) ? { reason: entry.codexFailureReason } : {}),
          ...(safeBoundedInteger(entry.errorCode, -1_000_000, 1_000_000) !== undefined
            ? { rpcCode: entry.errorCode } : {}),
          ...(codexServerErrorKinds.has(entry.codexServerErrorKind)
            ? { codexServerErrorKind: entry.codexServerErrorKind } : {}),
          ...(safeBoundedInteger(entry.codexUpstreamHttpStatus, 100, 599) !== undefined
            ? { codexUpstreamHttpStatus: entry.codexUpstreamHttpStatus } : {}),
          ...(safeBoundedInteger(entry.codexPromptBytes, 0, 64_000_000) !== undefined
            ? { codexPromptBytes: entry.codexPromptBytes } : {}),
          ...(safeBoundedInteger(entry.codexSchemaBytes, 0, 64_000_000) !== undefined
            ? { codexSchemaBytes: entry.codexSchemaBytes } : {}),
          ...(safeBoundedInteger(entry.codexImageCount, 0, 4) !== undefined
            ? { codexImageCount: entry.codexImageCount } : {}),
          ...(exitCode !== undefined ? { codexExitCode: exitCode } : {}),
          ...(processSignal ? { processSignal } : {}),
          ...(diagnosticBytes !== undefined ? { diagnosticBytes } : {}),
          ...(safeBoundedInteger(entry.durationMs, 0, 1_800_000) !== undefined
            ? { durationMs: entry.durationMs } : {})
        })
      }
    } else if (entry.event === 'llm.response.http_failed') {
      const status = Number.isInteger(entry.httpStatus) && entry.httpStatus >= 100 && entry.httpStatus <= 599
        ? entry.httpStatus : undefined
      const code = providerCodes.has(entry.errorCode) ? entry.errorCode : undefined
      const parameter = providerParameters.has(entry.errorParameter) ? entry.errorParameter : undefined
      if (status !== undefined) increment(httpFailures, `${status}:${code ?? 'unknown'}:${parameter ?? 'unknown'}`)
    } else if (entry.event === 'llm.stream.failed') {
      if (errorKinds.has(entry.errorKind)) increment(streamFailureKinds, entry.errorKind)
      if (transportCodes.has(entry.transportCode)) increment(streamTransportCodes, entry.transportCode)
    } else if (entry.event === 'llm.request.transport.retry' || entry.event === 'llm.request.transport.failed') {
      const isRetry = entry.event === 'llm.request.transport.retry'
      if (isRetry) transportEvents.retries += 1
      else transportEvents.failures += 1
      if (transportCodes.has(entry.transportCode)) increment(transportEvents.codes, entry.transportCode)
    } else if (entry.event === 'llm.response.rate_limited' && entry.status === 'retrying') {
      rateLimitRetries += 1
    }
  }

  return {
    requestFailureKinds,
    httpFailures,
    streamFailureKinds,
    streamTransportCodes,
    transportEvents,
    rateLimitRetries,
    ...(codexErrorNotifications.total ? { codexErrorNotifications } : {}),
    ...(codexFailureDetails.length ? { codexFailureDetails } : {})
  }
}

/** 接受北京前门片区在用户行程中的常见地名。 */
function hasFrontGateArea(value) {
  return /前门|大栅栏|鲜鱼口|北京坊|珠市口/u.test(value)
}

/** 按允许列表聚合固定字段，忽略原始网页和模型内容。 */
function increment(counts, value) {
  if (typeof value === 'string') counts[value] = (counts[value] ?? 0) + 1
}

/** 只接受预期范围内的整数诊断值，忽略任意对象、浮点数和负数。 */
function safeBoundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined
}
