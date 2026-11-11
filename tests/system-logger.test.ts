/** 验证运行日志的字段白名单、文件权限、并发写入与轮转边界。 */
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyError, classifyPersistenceFailure, createSystemLogger, safeErrorClass, safeTransportErrorCode } from '../src/main/system-logger.js'

const temporaryDirectories: string[] = []

/** 每个用例使用隔离资料目录，结束时清除本测试生成的文件。 */
async function createTemporaryLogger(maxBytes?: number) {
  const userDataDirectory = await mkdtemp(join(tmpdir(), 'tripwise-log-test-'))
  temporaryDirectories.push(userDataDirectory)
  return createSystemLogger(userDataDirectory, maxBytes)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('本机运行日志', () => {
  it('路线诊断仅保留固定反馈码，不记录其他工具反馈或地点文本', async () => {
    const logger = await createTemporaryLogger()
    logger.info('agent.tool.result.saved', {
      toolName: 'estimate_route', routeFeedbackCodes: 'route_segment_not_planned,route_mode_mismatch'
    })
    logger.info('agent.tool.result.saved', {
      toolName: 'propose_itineraries', routeFeedbackCodes: 'route_source_not_bound,private place name'
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const entries = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(entries[0]).toMatchObject({
      toolName: 'estimate_route', routeFeedbackCodes: 'route_segment_not_planned,route_mode_mismatch'
    })
    expect(entries[1]).not.toHaveProperty('routeFeedbackCodes')
    expect(log).not.toContain('private place name')
  })

  it('将保存失败细分为固定类别且不回显行程内容', () => {
    const privateName = '私密餐馆名称'

    expect(classifyPersistenceFailure(new Error('行程地点只能引用当前旅行中的成功来源。'))).toBe('source_not_successful')
    expect(classifyPersistenceFailure(new Error('住宿接驳必须引用当前住宿地点、每日边界地点和匹配的成功路线来源。')))
      .toBe('lodging_route_mismatch')
    expect(classifyPersistenceFailure(new Error(`行程存在 1 处明确时段重叠或接驳冲突，请修正后再保存：${privateName}`)))
      .toBe('schedule_conflict')
    expect(classifyPersistenceFailure(new Error(privateName))).toBe('unknown')
  })

  it('仅记录行程无变化门槛的固定原因和计数', async () => {
    const logger = await createTemporaryLogger()
    logger.info('agent.itinerary_revision.noop_check', {
      traceId: '550e8400-e29b-41d4-a716-446655440000',
      status: 'blocked', reason: 'meal_requirements_unmet',
      requestedAreaSatisfied: true, pendingRestaurantAllowed: true,
      routeRepairPending: false, savedProgressPresent: false, resumed: false,
      mealGapCount: 1, sourceGapCount: 0,
      restaurantName: 'private restaurant name', userRequest: 'private travel request'
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const [entry] = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(entry).toMatchObject({
      event: 'agent.itinerary_revision.noop_check',
      status: 'blocked', reason: 'meal_requirements_unmet',
      requestedAreaSatisfied: true, pendingRestaurantAllowed: true,
      routeRepairPending: false, savedProgressPresent: false, resumed: false,
      mealGapCount: 1, sourceGapCount: 0
    })
    expect(entry).not.toHaveProperty('restaurantName')
    expect(entry).not.toHaveProperty('userRequest')
    expect(log).not.toContain('private restaurant name')
    expect(log).not.toContain('private travel request')
  })

  it('记录事实补证预算计数，但过滤查询文本', async () => {
    const logger = await createTemporaryLogger()
    logger.info('agent.itinerary.fact_repair.source_search', {
      status: 'skipped', reason: 'browser_budget_exhausted',
      targetCount: 18, searchCount: 6, pageCount: 4, newlySourcedTargetCount: 2,
      reservedSearchCount: 6, reservedSearchCountRemaining: 4,
      availableSearchCount: 0, availablePageCount: 0,
      query: 'private attraction query'
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const [entry] = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(entry).toMatchObject({
      event: 'agent.itinerary.fact_repair.source_search', status: 'skipped', reason: 'browser_budget_exhausted',
      targetCount: 18, searchCount: 6, pageCount: 4, newlySourcedTargetCount: 2,
      reservedSearchCount: 6, reservedSearchCountRemaining: 4,
      availableSearchCount: 0, availablePageCount: 0
    })
    expect(entry).not.toHaveProperty('query')
    expect(log).not.toContain('private attraction query')
  })

  it('只记录白名单传输错误码，不记录底层错误文本', async () => {
    const logger = await createTemporaryLogger()
    const privateDetail = 'private-model-key-in-network-error'
    const cause = Object.assign(new Error(privateDetail), { code: 'UND_ERR_SOCKET' })
    const error = new TypeError('fetch failed', { cause })
    logger.warn('llm.request.transport.retry', {
      status: 'retrying', transportCode: safeTransportErrorCode(error), providerMessage: privateDetail
    })
    logger.warn('llm.request.transport.failed', { status: 'failed', transportCode: 'PRIVATE_KEY_VALUE' })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const entries = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(entries[0]).toMatchObject({ event: 'llm.request.transport.retry', transportCode: 'UND_ERR_SOCKET' })
    expect(entries[1]).not.toHaveProperty('transportCode')
    expect(log).not.toContain(privateDetail)
    expect(safeTransportErrorCode(Object.assign(new Error('unsafe'), { code: 'PRIVATE_KEY_VALUE' }))).toBeUndefined()
  })

  it('只为 Codex 请求保留安全阶段、异常类别与大小计数', async () => {
    const logger = await createTemporaryLogger()
    const privateName = 'private exception payload'
    const error = new TypeError('invalid request shape')
    logger.warn('llm.request.failed', {
      modelFamily: 'gpt-6-luna-codex-app-server',
      errorKind: classifyError(error),
      codexFailureStage: 'output_parse', codexErrorClass: safeErrorClass(error),
      codexFailureReason: 'process_exit', codexPromptBytes: 12_345, codexSchemaBytes: 456,
      codexImageCount: 1, codexExitCode: 1,
      exception: privateName, prompt: 'private user request', rawOutput: privateName
    })
    logger.warn('llm.request.failed', {
      codexFailureStage: privateName, codexErrorClass: privateName,
      codexPromptBytes: -1, codexSchemaBytes: 1.5, codexImageCount: 20,
      codexFailureReason: privateName, codexExitCode: 999,
    })
    logger.warn('llm.codex_app_server.process.restarting', {
      codexStage: 'stream', codexFailureReason: 'no_active_turn', errorCode: -32600, status: 'restarting'
    })
    logger.warn('llm.codex_app_server.turn.failed', {
      codexStage: 'stream', codexFailureReason: 'network', codexServerErrorKind: 'httpConnectionFailed',
      codexUpstreamHttpStatus: 503, status: 'failed'
    })
    logger.warn('llm.codex_app_server.process.exited', {
      traceId: '00000000-0000-4000-8000-000000000006',
      exitCode: 17, processSignal: 'SIGKILL', diagnosticBytes: 120, stderr: privateName
    })
    logger.warn('llm.codex_app_server.process.exited', {
      traceId: '00000000-0000-4000-8000-000000000006',
      exitCode: 999, processSignal: privateName, diagnosticBytes: 80_001
    })
    logger.warn('llm.codex_app_server.turn.failed', {
      codexServerErrorKind: privateName, codexUpstreamHttpStatus: 999
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const [valid, invalid, restarting, turnFailed, processExited, invalidExit, invalidTurnError] = log.trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(valid).toMatchObject({
      errorKind: 'input_error', codexFailureStage: 'output_parse', codexErrorClass: 'TypeError',
      codexPromptBytes: 12_345, codexSchemaBytes: 456, codexImageCount: 1,
      codexFailureReason: 'process_exit', codexExitCode: 1
    })
    expect(invalid).not.toHaveProperty('codexFailureStage')
    expect(invalid).not.toHaveProperty('codexErrorClass')
    expect(invalid).not.toHaveProperty('codexPromptBytes')
    expect(restarting).toMatchObject({
      event: 'llm.codex_app_server.process.restarting', codexStage: 'stream',
      codexFailureReason: 'no_active_turn', errorCode: -32600, status: 'restarting'
    })
    expect(turnFailed).toMatchObject({
      event: 'llm.codex_app_server.turn.failed', codexStage: 'stream',
      codexFailureReason: 'network', codexServerErrorKind: 'httpConnectionFailed',
      codexUpstreamHttpStatus: 503, status: 'failed'
    })
    expect(processExited).toMatchObject({
      event: 'llm.codex_app_server.process.exited',
      traceId: '00000000-0000-4000-8000-000000000006',
      exitCode: 17, processSignal: 'SIGKILL', diagnosticBytes: 120
    })
    expect(processExited).not.toHaveProperty('stderr')
    expect(invalidExit).not.toHaveProperty('exitCode')
    expect(invalidExit).not.toHaveProperty('processSignal')
    expect(invalidExit).not.toHaveProperty('diagnosticBytes')
    expect(invalidTurnError).not.toHaveProperty('codexServerErrorKind')
    expect(invalidTurnError).not.toHaveProperty('codexUpstreamHttpStatus')
    expect(invalid).not.toHaveProperty('codexSchemaBytes')
    expect(invalid).not.toHaveProperty('codexImageCount')
    expect(invalid).not.toHaveProperty('codexFailureReason')
    expect(invalid).not.toHaveProperty('codexExitCode')
    expect(log).not.toContain(privateName)
    expect(log).not.toContain('private user request')
    expect(safeErrorClass(Object.assign(new Error('private'), { name: privateName }))).toBe('OtherError')
  })

  it('记录新 App Server 错误枚举和重试状态，不保留错误正文', async () => {
    const logger = await createTemporaryLogger()
    logger.info('llm.codex_app_server.error_notification', {
      status: 'retrying', codexFailureReason: 'upstream_error',
      codexServerErrorKind: 'serverOverloaded', codexUpstreamHttpStatus: 503, durationMs: 4_000,
      message: 'private upstream response'
    })
    logger.warn('llm.codex_app_server.error_notification', {
      status: 'reported', codexFailureReason: 'unknown error with secret',
      codexServerErrorKind: 'unrecognized provider detail', codexUpstreamHttpStatus: 999
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const [retrying, invalid] = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(retrying).toMatchObject({
      event: 'llm.codex_app_server.error_notification', status: 'retrying',
      codexFailureReason: 'upstream_error', codexServerErrorKind: 'serverOverloaded',
      codexUpstreamHttpStatus: 503, durationMs: 4_000
    })
    expect(retrying).not.toHaveProperty('message')
    expect(invalid).not.toHaveProperty('codexFailureReason')
    expect(invalid).not.toHaveProperty('codexServerErrorKind')
    expect(invalid).not.toHaveProperty('codexUpstreamHttpStatus')
    expect(log).not.toContain('private upstream response')
    expect(log).not.toContain('unrecognized provider detail')
  })

  it('记录受限搜索服务名称以便定位渠道熔断原因', async () => {
    const logger = await createTemporaryLogger()
    logger.warn('search.provider.disabled', {
      searchProvider: 'Firecrawl', reason: 'request_error', provider: 'private-provider-value'
    })
    logger.warn('search.provider.disabled', {
      searchProvider: 'private-secret-value', reason: 'access_error'
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const [valid, invalid] = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(valid).toMatchObject({ event: 'search.provider.disabled', searchProvider: 'Firecrawl', reason: 'request_error' })
    expect(valid).not.toHaveProperty('provider')
    expect(invalid).not.toHaveProperty('searchProvider')
    expect(log).not.toContain('private-secret-value')
    expect(log).not.toContain('private-provider-value')
  })

  it('只记录搜索渠道的固定结果状态、数量和耗时', async () => {
    const logger = await createTemporaryLogger()
    logger.info('search.provider.request_completed', {
      traceId: '550e8400-e29b-41d4-a716-446655440000',
      searchProvider: 'Exa', searchOutcome: 'results', sourceCount: 2, durationMs: 180,
      query: 'private search query'
    })
    logger.info('search.provider.request_completed', {
      searchProvider: 'Exa', searchOutcome: 'private search detail', sourceCount: 2,
      providerMessage: 'private provider response'
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const [valid, invalid] = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(valid).toMatchObject({
      event: 'search.provider.request_completed', searchProvider: 'Exa',
      searchOutcome: 'results', sourceCount: 2, durationMs: 180
    })
    expect(valid).not.toHaveProperty('query')
    expect(invalid).not.toHaveProperty('searchOutcome')
    expect(invalid).not.toHaveProperty('providerMessage')
    expect(log).not.toContain('private search query')
    expect(log).not.toContain('private provider response')
  })

  it('为浏览器工具返回保留安全动作码与失败阶段', async () => {
    const logger = await createTemporaryLogger()
    logger.warn('agent.tool.returned', {
      toolName: 'research_browser_open_link', status: 'partial',
      browserProgressCode: 'browser_link_unavailable',
      browserLinkFailureKind: 'stale_snapshot',
      browserLinkFailureStage: 'target_not_found_after_rerender',
      browserNavigationFailureStage: 'redirected',
      url: 'https://private.example/article', pageText: 'private browser content'
    })
    logger.warn('agent.tool.returned', {
      toolName: 'research_browser_open_link', browserProgressCode: 'private page text',
      browserNavigationFailureStage: 'private navigation stage'
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const [valid, invalid] = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(valid).toMatchObject({
      browserProgressCode: 'browser_link_unavailable',
      browserLinkFailureKind: 'stale_snapshot',
      browserLinkFailureStage: 'target_not_found_after_rerender',
      browserNavigationFailureStage: 'redirected'
    })
    expect(invalid).not.toHaveProperty('browserProgressCode')
    expect(invalid).not.toHaveProperty('browserNavigationFailureStage')
    expect(log).not.toContain('private.example')
    expect(log).not.toContain('private browser content')
  })

  it('只记录有限的浏览器搜索意图，不记录查询文本', async () => {
    const logger = await createTemporaryLogger()
    logger.info('agent.research.browser_fallback', {
      status: 'partial', browserSearchIntent: 'community', browserLinkSelection: 'community_result',
      browserLinkSelectionReason: 'community_query_not_matched',
      browserVisibleLinkCount: 12, browserLinkOpenStatus: 'page_read', browserLinkFailureKind: 'timeout',
      browserNavigationFailureStage: 'redirected', browserLinkRetryProgressCode: 'browser_navigation_read_blocked',
      query: 'private Xiaohongshu search query'
    })
    logger.info('agent.research.browser_fallback', {
      status: 'partial', browserSearchIntent: 'private-search-query',
      browserVisibleLinkCount: 81, browserLinkSelection: 'private-search-query',
      browserLinkSelectionReason: 'private-search-query', browserLinkOpenStatus: 'private-search-query',
      browserLinkFailureKind: 'private-search-query', browserNavigationFailureStage: 'private-search-query',
      browserLinkRetryProgressCode: 'private-search-query'
    })
    logger.info('agent.research.browser_fallback', {
      status: 'partial', browserSearchIntent: 'meal', browserLinkSelection: 'meal_result',
      browserLinkSelectionReason: 'meal_result_not_found', browserVisibleLinkCount: 4
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const [valid, invalid, meal] = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(valid).toMatchObject({ event: 'agent.research.browser_fallback', browserSearchIntent: 'community',
      browserVisibleLinkCount: 12, browserLinkSelection: 'community_result',
      browserLinkSelectionReason: 'community_query_not_matched', browserLinkOpenStatus: 'page_read',
      browserLinkFailureKind: 'timeout', browserNavigationFailureStage: 'redirected',
      browserLinkRetryProgressCode: 'browser_navigation_read_blocked' })
    expect(valid).not.toHaveProperty('query')
    expect(meal).toMatchObject({ browserSearchIntent: 'meal', browserLinkSelection: 'meal_result',
      browserLinkSelectionReason: 'meal_result_not_found', browserVisibleLinkCount: 4 })
    expect(invalid).not.toHaveProperty('browserSearchIntent')
    expect(invalid).not.toHaveProperty('browserVisibleLinkCount')
    expect(invalid).not.toHaveProperty('browserLinkSelection')
    expect(invalid).not.toHaveProperty('browserLinkSelectionReason')
    expect(invalid).not.toHaveProperty('browserLinkOpenStatus')
    expect(invalid).not.toHaveProperty('browserLinkFailureKind')
    expect(invalid).not.toHaveProperty('browserNavigationFailureStage')
    expect(invalid).not.toHaveProperty('browserLinkRetryProgressCode')
    expect(log).not.toContain('private Xiaohongshu search query')
  })

  it('记录非政府游览信息页选择类别且不保存页面线索', async () => {
    const logger = await createTemporaryLogger()
    logger.info('agent.research.browser_fallback', {
      status: 'partial', browserSearchIntent: 'attraction', browserLinkSelection: 'visitor_info_page',
      browserLinkSelectionReason: 'selected', browserVisibleLinkCount: 8,
      pageTitle: '北京景区开放时间与预约须知'
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const [entry] = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(entry).toMatchObject({ browserSearchIntent: 'attraction', browserLinkSelection: 'visitor_info_page' })
    expect(entry).not.toHaveProperty('pageTitle')
    expect(log).not.toContain('北京景区开放时间与预约须知')
  })

  it('仅记录白名单 Agent 失败阶段，不写异常原文', async () => {
    const logger = await createTemporaryLogger()
    logger.warn('agent.run.failed', {
      stage: 'tool_execution',
      errorKind: 'input_error', errorMessage: 'private travel details'
    })
    logger.warn('agent.run.failed', {
      stage: 'result_persistence', errorKind: 'input_error', persistenceFailureKind: 'source_not_successful',
      persistenceError: 'private travel details'
    })
    logger.warn('agent.run.failed', {
      stage: 'private-user-input', errorKind: 'input_error',
      persistenceFailureKind: 'private-travel-content'
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const [valid, persistence, invalid] = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(valid).toMatchObject({ stage: 'tool_execution', errorKind: 'input_error' })
    expect(valid).not.toHaveProperty('errorMessage')
    expect(persistence).toMatchObject({
      stage: 'result_persistence', persistenceFailureKind: 'source_not_successful'
    })
    expect(persistence).not.toHaveProperty('persistenceError')
    expect(invalid).not.toHaveProperty('stage')
    expect(invalid).not.toHaveProperty('persistenceFailureKind')
    expect(log).not.toContain('private travel details')
  })

  it('仅记录行程来源失效的类别计数，不记录来源详情', async () => {
    const logger = await createTemporaryLogger()
    logger.warn('agent.run.failed', {
      stage: 'result_persistence', persistenceFailureKind: 'source_not_successful',
      invalidEvidenceSourceCount: 2,
      invalidEvidenceSourceSummary: 'web:partial=1,weather:unavailable=1',
      url: 'https://private.example/page'
    })
    logger.warn('agent.run.failed', {
      stage: 'result_persistence', persistenceFailureKind: 'source_not_successful',
      invalidEvidenceSourceCount: 1, invalidEvidenceSourceSummary: 'private.example/page'
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const [valid, invalid] = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(valid).toMatchObject({
      invalidEvidenceSourceCount: 2,
      invalidEvidenceSourceSummary: 'web:partial=1,weather:unavailable=1'
    })
    expect(valid).not.toHaveProperty('url')
    expect(invalid).not.toHaveProperty('invalidEvidenceSourceSummary')
    expect(log).not.toContain('private.example')
  })

  it('记录模型所选路线调用的安全结果，不写地点或响应正文', async () => {
    const logger = await createTemporaryLogger()
    logger.info('agent.route.lookup.completed', {
      traceId: '550e8400-e29b-41d4-a716-446655440000',
      routeAttemptId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      routeDayNumber: 2, routeExecutionStage: 'model-tool', status: 'success',
      routeOptionCount: 2, durationMs: 1_250, origin: 'private place', response: 'private route response'
    })
    logger.info('agent.route.lookup.completed', {
      routeExecutionStage: 'private-stage', routeOptionCount: 4, origin: 'private place'
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const [valid, invalid] = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(valid).toMatchObject({
      event: 'agent.route.lookup.completed', routeExecutionStage: 'model-tool',
      status: 'success', routeOptionCount: 2, durationMs: 1_250
    })
    expect(valid).not.toHaveProperty('origin')
    expect(valid).not.toHaveProperty('response')
    expect(invalid).not.toHaveProperty('routeExecutionStage')
    expect(invalid).not.toHaveProperty('routeOptionCount')
    expect(log).not.toContain('private place')
    expect(log).not.toContain('private route response')
  })

  it('记录有界路线修订次数与恢复点失败类别，不写行程内容', async () => {
    const logger = await createTemporaryLogger()
    logger.warn('agent.route_conflict_repair.validation_retry', {
      status: 'retrying', reason: 'plan_structure', routeConflictRepairValidationRetry: 1,
      routeConflictRepairAttempt: 1, routeConflictRepairFailureKind: 'route_evidence',
      routeConflictRepairSchemaFailureStage: 'stop_facts',
      rejectedCandidate: 'private itinerary'
    })
    logger.error('agent.run.progress_save_failed', {
      reason: 'itinerary_schema', itinerary: 'private itinerary'
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const [retry, failure] = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(retry).toMatchObject({
      routeConflictRepairValidationRetry: 1, routeConflictRepairAttempt: 1,
      routeConflictRepairFailureKind: 'route_evidence', routeConflictRepairSchemaFailureStage: 'stop_facts',
      reason: 'plan_structure'
    })
    expect(failure).toMatchObject({ event: 'agent.run.progress_save_failed', reason: 'itinerary_schema' })
    expect(failure).not.toHaveProperty('itinerary')
    expect(log).not.toContain('private itinerary')
  })

  it('只写登记过的诊断字段并遮盖常见凭证文本', async () => {
    const logger = await createTemporaryLogger()
    logger.info('agent.tool.completed', {
      operation: 'agent:send',
      toolName: 'search_web',
      status: 'completed',
      traceId: '550e8400-e29b-41d4-a716-446655440000',
      requestBytes: 4_200,
      systemMessageCharacters: 8_100,
      toolCallArgumentCharacters: 2_400,
      reasoningEffort: 'medium',
      errorCode: 'invalid_request_error',
      errorParameter: 'reasoning_effort',
      toolOutputCharacters: 850,
      firstContentMs: 34_000,
      firstToolCallMs: 122_000,
      modelFamily: 'Bearer private-token',
      factEvidenceRequestedCount: 3,
      factEvidenceAutoBoundCount: 1,
      factEvidenceRejectedCount: 2,
      factEvidenceSourceUnavailableCount: 0,
      factEvidenceSourceIneligibleCount: 0,
      factEvidencePlaceMismatchCount: 1,
      factEvidenceScopeMismatchCount: 2,
      factEvidenceValueMismatchCount: 1,
      apiKey: 'private-api-key',
      content: 'private travel request',
      providerMessage: 'private raw provider detail',
      response: 'private tool response'
    })
    logger.info('agent.route.lookup.completed', {
      traceId: '550e8400-e29b-41d4-a716-446655440000',
      routeAttemptId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', routeDayNumber: 2,
      routeExecutionStage: 'model-tool', status: 'success', routeOptionCount: 3, durationMs: 1_250,
      providerMessage: 'private raw route failure'
    })
    logger.info('agent.meal_repair.evaluated', {
      status: 'ready', mealGapCount: 2, detailGapCount: 0, itineraryCount: 1,
      factResearchStage: 'idle', mealRepairPending: true,
      mealRepairAttempts: 2, mealRepairFailures: 1, mealRepairUsed: true,
      mealRepairRetryAfterPlanRepair: false, rejectedCandidatePending: false,
      restaurantName: 'private restaurant name'
    })
    logger.info('agent.itinerary_revision.scope', {
      baselineAvailable: true, baselineDayCount: 7, protectedDayCount: 6,
      excludedStopCount: 2, targetDayCount: 1,
      protectedDates: 'private itinerary dates'
    })
    logger.warn('agent.itinerary_revision.finalized', {
      baselineAvailable: true, protectedDayCount: 6, restoredProtectedDayCount: 1,
      userRequest: 'private travel request'
    })
    logger.warn('agent.research.browser_fallback', {
      status: 'degraded', browserNavigationStatus: 'opened', browserSnapshotStatus: 'failed',
      browserContentLevel: 'private-url-value', browserNavigationFailureKind: 'proxy',
      browserLinkOpenStatus: 'error', browserLinkFailureKind: 'stale_snapshot',
      browserLinkFailureStage: 'snapshot_page_changed',
      browserSearchIntent: 'community'
    })
    logger.info('agent.context.compacted', {
      status: 'completed', reason: 'source_excerpt_already_in_context',
      removedCallCount: 2, contextCharactersSaved: 4_800
    })
    logger.info('agent.request.prepared', {
      conciseItineraryOutput: true, compactItineraryOutput: false, routeToolOffered: true
    })
    logger.info('agent.itinerary.fact_evidence', {
      traceId: '550e8400-e29b-41d4-a716-446655440000',
      factEvidenceOpeningHoursRejectedCount: 2,
      factEvidenceBookingRejectedCount: 1,
      factEvidenceTicketPriceRejectedCount: 3,
      factEvidenceOtherRejectedCount: 0,
      factEvidenceRejectedRestaurantName: 'private restaurant name'
    })
    logger.info('agent.itinerary_revision.noop_skipped', {
      status: 'deferred', reason: 'meal_source_evidence_pending', mealGapCount: 2, sourceGapCount: 2,
      restaurantName: 'private restaurant name'
    })
    logger.info('agent.meal_repair.round_completed', {
      status: 'partial', attempt: 3, targetCountBefore: 18, targetCountAfter: 15,
      mealGapCount: 18, sourceGapCount: 3, mealRepairProgressed: true,
      mealRepairFailures: 0, mealRepairPending: true,
      restaurantName: 'private restaurant name'
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const [first, second, third, fourth, fifth, sixth, seventh, eighth, ninth, tenth, eleventh] = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    const entry = first!
    expect(entry).toMatchObject({
      event: 'agent.tool.completed', toolName: 'search_web', status: 'completed',
      traceId: '550e8400-e29b-41d4-a716-446655440000', requestBytes: 4_200, toolOutputCharacters: 850,
      systemMessageCharacters: 8_100, toolCallArgumentCharacters: 2_400,
      firstContentMs: 34_000, firstToolCallMs: 122_000, reasoningEffort: 'medium',
      factEvidenceRequestedCount: 3, factEvidenceAutoBoundCount: 1, factEvidenceRejectedCount: 2,
      factEvidenceSourceUnavailableCount: 0, factEvidenceSourceIneligibleCount: 0,
      factEvidencePlaceMismatchCount: 1, factEvidenceScopeMismatchCount: 2, factEvidenceValueMismatchCount: 1,
      errorCode: 'invalid_request_error', errorParameter: 'reasoning_effort'
    })
    expect(second).toMatchObject({
      event: 'agent.route.lookup.completed', routeDayNumber: 2, routeExecutionStage: 'model-tool',
      status: 'success', routeOptionCount: 3, durationMs: 1_250
    })
    expect(third).toMatchObject({
      event: 'agent.meal_repair.evaluated', status: 'ready', mealGapCount: 2,
      itineraryCount: 1, mealRepairAttempts: 2, mealRepairFailures: 1
    })
    expect(fourth).toMatchObject({
      event: 'agent.itinerary_revision.scope', baselineAvailable: true,
      baselineDayCount: 7, protectedDayCount: 6, excludedStopCount: 2, targetDayCount: 1
    })
    expect(fourth).not.toHaveProperty('protectedDates')
    expect(fifth).toMatchObject({
      event: 'agent.itinerary_revision.finalized', baselineAvailable: true,
      protectedDayCount: 6, restoredProtectedDayCount: 1
    })
    expect(fifth).not.toHaveProperty('userRequest')
    expect(sixth).toMatchObject({
      event: 'agent.research.browser_fallback', status: 'degraded',
      browserNavigationStatus: 'opened', browserSnapshotStatus: 'failed', browserSearchIntent: 'community'
    })
    expect(sixth).not.toHaveProperty('browserContentLevel')
    expect(sixth).toHaveProperty('browserNavigationFailureKind', 'proxy')
    expect(sixth).toHaveProperty('browserLinkFailureStage', 'snapshot_page_changed')
    expect(seventh).toMatchObject({
      event: 'agent.context.compacted', status: 'completed', removedCallCount: 2,
      contextCharactersSaved: 4_800
    })
    expect(eighth).toMatchObject({
      event: 'agent.request.prepared', conciseItineraryOutput: true, compactItineraryOutput: false,
      routeToolOffered: true
    })
    expect(ninth).toMatchObject({
      event: 'agent.itinerary.fact_evidence',
      factEvidenceOpeningHoursRejectedCount: 2,
      factEvidenceBookingRejectedCount: 1,
      factEvidenceTicketPriceRejectedCount: 3,
      factEvidenceOtherRejectedCount: 0
    })
    expect(ninth).not.toHaveProperty('factEvidenceRejectedRestaurantName')
    expect(tenth).toMatchObject({
      event: 'agent.itinerary_revision.noop_skipped', status: 'deferred',
      reason: 'meal_source_evidence_pending', mealGapCount: 2, sourceGapCount: 2
    })
    expect(tenth).not.toHaveProperty('restaurantName')
    expect(eleventh).toMatchObject({
      event: 'agent.meal_repair.round_completed', status: 'partial', attempt: 3,
      targetCountBefore: 18, targetCountAfter: 15, mealGapCount: 18,
      sourceGapCount: 3, mealRepairProgressed: true, mealRepairFailures: 0,
      mealRepairPending: true
    })
    expect(eleventh).not.toHaveProperty('restaurantName')
    expect(third).not.toHaveProperty('restaurantName')
    expect(entry.modelFamily).toBe('[已隐藏凭证]')
    expect(log).not.toContain('private-api-key')
    expect(log).not.toContain('private travel request')
    expect(log).not.toContain('private raw provider detail')
    expect(log).not.toContain('private tool response')
    expect(log).not.toContain('private raw route failure')
    expect(log).not.toContain('private restaurant name')
  })

  it('只保留受限路线关联字段并丢弃地址文本和无效编号', async () => {
    const logger = await createTemporaryLogger()
    logger.warn('amap.request.failed', {
      operation: 'geocode', status: 'provider_error', errorCode: '30001',
      traceId: '550e8400-e29b-41d4-a716-446655440000',
      routeAttemptId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      routeDayNumber: 2, routeExecutionStage: 'model-tool',
      routePointRole: 'origin', routeGeocodeVariant: 'area-address',
      origin: 'private travel address', routeQuery: 'private request URL',
      badAttemptId: 'not-a-uuid'
    })
    logger.info('amap.geocode.fallback_succeeded', {
      operation: 'geocode', routeAttemptId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      routeDayNumber: 2, routeExecutionStage: 'model-tool', routePointRole: 'origin',
      routeGeocodeVariant: 'area-address-no-city'
    })
    logger.warn('amap.request.failed', {
      operation: 'reverse_geocode', status: 'provider_error', errorCode: '30001',
      routeAttemptId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', routeDayNumber: 2,
      routeExecutionStage: 'model-tool', routePointRole: 'origin', routeGeocodeVariant: 'source-place-coordinate'
    })
    logger.warn('amap.request.failed', {
      routeAttemptId: 'not-a-uuid', routeDayNumber: 0, routeExecutionStage: 'arbitrary-value',
      routePointRole: 'somewhere', routeGeocodeVariant: 'raw-query',
      routeResolutionStage: 'raw-query', routeResolutionStatus: 'unknown', routeResolutionReason: 'private'
    })
    logger.info('amap.route.endpoint_resolution', {
      routeAttemptId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', routeDayNumber: 2,
      routeExecutionStage: 'model-tool', routePointRole: 'origin',
      routeResolutionStage: 'area-address', routeResolutionStatus: 'not_found',
      routeResolutionReason: 'ambiguous_match', address: 'private travel address'
    })
    logger.info('amap.route.endpoint_resolution', {
      routeAttemptId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8', routeDayNumber: 2,
      routeExecutionStage: 'model-tool', routePointRole: 'destination',
      routeResolutionStage: 'exact-poi-no-city', routeResolutionStatus: 'not_found',
      routeResolutionReason: 'no_exact_match'
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const entries = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(entries[0]).toMatchObject({
      operation: 'geocode', status: 'provider_error', errorCode: '30001',
      traceId: '550e8400-e29b-41d4-a716-446655440000',
      routeAttemptId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      routeDayNumber: 2, routeExecutionStage: 'model-tool',
      routePointRole: 'origin', routeGeocodeVariant: 'area-address'
    })
    expect(entries[0]).not.toHaveProperty('origin')
    expect(entries[0]).not.toHaveProperty('routeQuery')
    expect(entries[1]).toMatchObject({
      event: 'amap.geocode.fallback_succeeded', routeDayNumber: 2,
      routePointRole: 'origin', routeGeocodeVariant: 'area-address-no-city'
    })
    expect(entries[2]).toMatchObject({
      operation: 'reverse_geocode', routePointRole: 'origin', routeGeocodeVariant: 'source-place-coordinate'
    })
    expect(entries[3]).not.toHaveProperty('routeAttemptId')
    expect(entries[3]).not.toHaveProperty('routeDayNumber')
    expect(entries[3]).not.toHaveProperty('routeExecutionStage')
    expect(entries[3]).not.toHaveProperty('routePointRole')
    expect(entries[3]).not.toHaveProperty('routeGeocodeVariant')
    expect(entries[3]).not.toHaveProperty('routeResolutionStage')
    expect(entries[3]).not.toHaveProperty('routeResolutionStatus')
    expect(entries[3]).not.toHaveProperty('routeResolutionReason')
    expect(entries[4]).toMatchObject({
      event: 'amap.route.endpoint_resolution', routeDayNumber: 2, routePointRole: 'origin',
      routeResolutionStage: 'area-address', routeResolutionStatus: 'not_found',
      routeResolutionReason: 'ambiguous_match'
    })
    expect(entries[4]).not.toHaveProperty('address')
    expect(entries[5]).toMatchObject({
      event: 'amap.route.endpoint_resolution', routeDayNumber: 2, routePointRole: 'destination',
      routeResolutionStage: 'exact-poi-no-city', routeResolutionStatus: 'not_found',
      routeResolutionReason: 'no_exact_match'
    })
    expect(log).not.toContain('private travel address')
    expect(log).not.toContain('private request URL')
    expect(log).not.toContain('private destination')
  })

  it('记录路线绑定分类计数但不记录路线端点', async () => {
    const logger = await createTemporaryLogger()
    logger.warn('agent.route.binding_diagnostic', {
      traceId: '550e8400-e29b-41d4-a716-446655440000', status: 'partial',
      routeAvailableCount: 3, routeCurrentRunCount: 3, routeLinkedCount: 1, routeUnboundCount: 2,
      routeBindingNoAdjacentCount: 1, routeBindingModeMismatchCount: 0,
      routeBindingDateMismatchCount: 0, routeBindingTimeMismatchCount: 1,
      routeBindingSummaryUnreadableCount: 0, routeBindingMatchingButUnlinkedCount: 0,
      origin: 'private address'
    })
    await logger.flush()

    const log = await readFile(join(logger.directory, 'tripwise.log'), 'utf8')
    const entry = JSON.parse(log.trim()) as Record<string, unknown>
    expect(entry).toMatchObject({
      event: 'agent.route.binding_diagnostic', routeAvailableCount: 3, routeCurrentRunCount: 3,
      routeLinkedCount: 1, routeUnboundCount: 2, routeBindingNoAdjacentCount: 1,
      routeBindingTimeMismatchCount: 1
    })
    expect(entry).not.toHaveProperty('origin')
    expect(log).not.toContain('private address')
  })

  it('并发写入后仍产生有效 JSONL，并在 POSIX 系统限制文件与目录权限', async () => {
    const logger = await createTemporaryLogger()
    for (let index = 0; index < 32; index += 1) logger.info('agent.tool.completed', { toolName: `tool_${index}`, durationMs: index })
    await logger.flush()

    const logPath = join(logger.directory, 'tripwise.log')
    const lines = (await readFile(logPath, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(32)
    expect(lines.map((line) => JSON.parse(line).durationMs)).toEqual(Array.from({ length: 32 }, (_value, index) => index))
    if (process.platform !== 'win32') {
      expect((await stat(logger.directory)).mode & 0o077).toBe(0)
      expect((await stat(logPath)).mode & 0o077).toBe(0)
    }
  })

  it('超过单文件上限后按数量保留轮转日志', async () => {
    const logger = await createTemporaryLogger(180)
    for (let index = 0; index < 8; index += 1) {
      logger.info('agent.tool.completed', { toolName: `tool_${index}`, durationMs: index })
      await logger.flush()
    }

    const names = await readdir(logger.directory)
    expect(names).toContain('tripwise.log')
    expect(names.filter((name) => /^tripwise\.log(?:\.\d+)?$/u.test(name)).length).toBeLessThanOrEqual(4)
    expect(names.some((name) => name === 'tripwise.log.4')).toBe(false)
  })

  it('把失败只归类为稳定类别，不返回异常原文', () => {
    expect(classifyError(new Error('模型请求超时：private detail'))).toBe('timeout')
    expect(classifyError(new Error('模型单轮请求超过 30 分钟，已停止；已完成的资料已保留。'))).toBe('timeout')
    expect(classifyError(new Error('模型服务限流，自动重试后仍未恢复。'))).toBe('rate_limited')
    expect(classifyError(new Error('模型服务账户额度或余额不足。'))).toBe('quota_exceeded')
    expect(classifyError(new Error('模型接口返回 HTTP 503，private detail'))).toBe('http_error')
    expect(classifyError(new Error('模型接口续问一次后仍没有返回可显示正文或工具调用。'))).toBe('empty_model_response')
    expect(classifyError(new Error('模型输出达到长度上限，方案尚未完成。'))).toBe('output_limit')
    expect(classifyError(new Error('模型接口因输出长度限制结束，但没有生成可显示答复。'))).toBe('output_limit')
    expect(classifyError(new Error('行程方案已保留，但出行准备清单尚未完成；可以继续对话补齐。'))).toBe('preparation_incomplete')
    expect(classifyError(new Error('模型服务过滤了本次响应。'))).toBe('content_filtered')
    expect(classifyError(new Error('private detail'))).toBe('unknown_error')
  })
})
