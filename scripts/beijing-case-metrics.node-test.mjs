/** 验证北京实跑指标不会将晚间景点误判为餐次。 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { browserToolOutcomeSummary, hasFrontGateDinner, modelFailureSummary, routeConflictRepairSummary, routeLookupSummary, routeToolVisibilitySummary, runFailureSummary, searchProviderOutcomeSummary, sourceSupportsMealName } from '../tests/e2e/beijing-case-metrics.mjs'

describe('北京评测的餐馆直证', () => {
  it('计划包含分店时，品牌提及不足以成为门店直证', () => {
    assert.equal(sourceSupportsMealName('海碗居（牡丹园店）', {
      title: '海碗居午餐体验', summary: '', factEvidenceExcerpt: ''
    }), false)
  })

  it('来源同时提到品牌和分店时才计为可用直证', () => {
    assert.equal(sourceSupportsMealName('海碗居（牡丹园店）', {
      title: '海碗居牡丹园店午餐体验', summary: '', factEvidenceExcerpt: ''
    }), true)
  })
})

describe('北京评测的前门晚餐指标', () => {
  it('不把前门的晚间景点误计为晚餐', () => {
    assert.equal(hasFrontGateDinner({
      stops: [{ name: '前门大街', area: '前门', category: '历史街区', time: '18:00–19:00', notes: '' }],
      scheduleBlocks: []
    }), false)
  })

  it('识别具备餐饮类别和晚餐时段的地点', () => {
    assert.equal(hasFrontGateDinner({
      stops: [{ name: '某餐馆', area: '前门片区', category: '餐饮', time: '18:00–19:00', notes: '' }],
      scheduleBlocks: []
    }), true)
  })

  it('识别前门别名下的晚餐时间块', () => {
    assert.equal(hasFrontGateDinner({
      stops: [],
      scheduleBlocks: [{ kind: 'meal', title: '晚餐', area: '大栅栏', time: '18:00–19:00', notes: '' }]
    }), true)
  })

  it('不把前门午餐计为晚餐', () => {
    assert.equal(hasFrontGateDinner({
      stops: [{ name: '午餐：某餐馆', area: '前门', category: '餐饮', time: '12:00–13:00', notes: '' }],
      scheduleBlocks: []
    }), false)
  })
})

describe('北京评测的 Agent 失败摘要', () => {
  it('保留结构化保存失败的安全分类', () => {
    assert.deepEqual(runFailureSummary({
      progressSaveFailureKind: 'store_rejected',
      error: 'secret request or provider output'
    }), { progressSaveFailureKind: 'store_rejected' })
  })

  it('忽略未识别的失败类别', () => {
    assert.deepEqual(runFailureSummary({
      progressSaveFailureKind: 'api key',
      persistenceFailureKind: 'private error text'
    }), {})
  })

  it('成功运行不显示失败分类', () => {
    assert.deepEqual(runFailureSummary({}), {})
  })

  it('保留结构化结果保存失败的安全分类', () => {
    assert.deepEqual(runFailureSummary({
      runFailureStage: 'result_persistence',
      persistenceFailureKind: 'unknown'
    }), { persistenceFailureKind: 'unknown' })
  })
})

describe('北京评测的自动路线修复摘要', () => {
  it('区分已安排、已保存、延后和候选校验失败', () => {
    const traceId = '00000000-0000-4000-8000-000000000010'
    assert.deepEqual(routeConflictRepairSummary([
      { traceId, event: 'agent.route_conflict_repair.scheduled', routeConflictRepairCount: 4 },
      { traceId, event: 'agent.route_conflict_repair.validation_retry', routeConflictRepairFailureKind: 'route_evidence' },
      {
        traceId, event: 'agent.route_conflict_repair.deferred', reason: 'candidate_not_saved',
        routeConflictRepairFailureKind: 'invalid_option_schema', routeConflictRepairSchemaFailureStage: 'stop_facts'
      },
      { traceId, event: 'agent.route_conflict_repair.proposal_saved' },
      { traceId, event: 'agent.route_conflict_repair.deferred', reason: 'private itinerary', routeConflictRepairFailureKind: 'api key' },
      { traceId: 'other-run', event: 'agent.route_conflict_repair.scheduled', routeConflictRepairCount: 99 }
    ], traceId), {
      scheduledCount: 1,
      proposalSavedCount: 1,
      deferredCount: 2,
      conflictCount: 4,
      validationRetryCount: 1,
      deferredReasons: { candidate_not_saved: 1 },
      failureKinds: { route_evidence: 1, invalid_option_schema: 1 },
      schemaFailureStages: { stop_facts: 1 }
    })
  })

  it('无路线修复事件时返回零计数', () => {
    assert.deepEqual(routeConflictRepairSummary([], 'trace'), {
      scheduledCount: 0, proposalSavedCount: 0, deferredCount: 0, conflictCount: 0,
      validationRetryCount: 0, deferredReasons: {}, failureKinds: {}, schemaFailureStages: {}
    })
  })
})

describe('北京评测的路线工具调用摘要', () => {
  it('只统计当前运行的模型路线调用和固定结果字段', () => {
    const traceId = '00000000-0000-4000-8000-000000000010'
    assert.deepEqual(routeLookupSummary([
      { traceId, event: 'agent.route.lookup.completed', status: 'success', routeDayNumber: 2, routeOptionCount: 2, durationMs: 120 },
      { traceId, event: 'agent.route.lookup.completed', status: 'provider_error', routeDayNumber: 2, routeOptionCount: 0, durationMs: 80 },
      { traceId, event: 'agent.tool.result.saved', toolName: 'estimate_route', routeFeedbackCodes: 'route_segment_not_planned,unknown_code' },
      { traceId, event: 'agent.tool.result.saved', toolName: 'propose_itineraries', routeFeedbackCodes: 'route_source_not_bound' },
      { traceId, event: 'agent.tool.result.saved', toolName: 'search_web', routeFeedbackCodes: 'route_hub_unconfirmed' },
      { traceId, event: 'agent.route.lookup.completed', status: 'private provider text', routeDayNumber: 32, routeOptionCount: 99, durationMs: 9_000_000 },
      { traceId: 'other-run', event: 'agent.route.lookup.completed', status: 'success', routeDayNumber: 1, routeOptionCount: 1, durationMs: 10 }
    ], traceId), {
      lookupCount: 3,
      outcomeCounts: { success: 1, provider_error: 1, other: 1 },
      feedbackCodeCounts: { route_segment_not_planned: 1, route_source_not_bound: 1 },
      attemptsByDay: { 2: 2 },
      routeOptionCount: 2,
      durationMs: 200
    })
  })

  it('不输出地点、端点、工具参数或来源文本', () => {
    const summary = routeLookupSummary([
      {
        traceId: 'run', event: 'agent.route.lookup.completed', status: 'success',
        origin: 'private place', destination: 'private place', query: 'private text',
        routeDayNumber: 1, routeOptionCount: 1, durationMs: 1
      },
      {
        traceId: 'run', event: 'agent.tool.result.saved', toolName: 'estimate_route',
        routeFeedbackCodes: 'route_segment_not_planned,private place'
      }
    ], 'run')
    assert.equal(JSON.stringify(summary).includes('private'), false)
    assert.deepEqual(summary, {
      lookupCount: 1, outcomeCounts: { success: 1 }, feedbackCodeCounts: { route_segment_not_planned: 1 },
      attemptsByDay: { 1: 1 }, routeOptionCount: 1, durationMs: 1
    })
  })
})

describe('北京评测的路线工具可见性', () => {
  it('统计有行程后的请求是否获配路线工具', () => {
    const traceId = 'run'
    assert.deepEqual(routeToolVisibilitySummary([
      { traceId, event: 'agent.request.prepared', itineraryCount: 0, routeToolOffered: false },
      { traceId, event: 'agent.request.prepared', itineraryCount: 1, routeToolOffered: true },
      { traceId, event: 'agent.request.prepared', itineraryCount: 2, routeToolOffered: false },
      { traceId, event: 'agent.request.prepared', itineraryCount: 1, routeToolOffered: 'private text' },
      { traceId: 'other-run', event: 'agent.request.prepared', itineraryCount: 1, routeToolOffered: true }
    ], traceId), {
      preparedRequestCount: 4,
      afterPlanRequestCount: 3,
      afterPlanVisibilityRecordedCount: 2,
      afterPlanRouteToolOfferedCount: 1,
      afterPlanRouteToolUnavailableCount: 1
    })
  })

  it('不输出用户文本或路线参数', () => {
    const summary = routeToolVisibilitySummary([{
      traceId: 'run', event: 'agent.request.prepared', itineraryCount: 1,
      routeToolOffered: true, userRequest: 'private travel request', origin: 'private place'
    }], 'run')
    assert.equal(JSON.stringify(summary).includes('private'), false)
    assert.deepEqual(summary, {
      preparedRequestCount: 1,
      afterPlanRequestCount: 1,
      afterPlanVisibilityRecordedCount: 1,
      afterPlanRouteToolOfferedCount: 1,
      afterPlanRouteToolUnavailableCount: 0
    })
  })
})

describe('北京评测的搜索渠道摘要', () => {
  it('按运行追踪号汇总渠道结果、空响应、失败、来源数和耗时', () => {
    const traceId = '00000000-0000-4000-8000-000000000001'
    assert.deepEqual(searchProviderOutcomeSummary([
      { traceId, event: 'search.provider.request_completed', searchProvider: 'Exa', searchOutcome: 'results', sourceCount: 2, durationMs: 120 },
      { traceId, event: 'search.provider.request_completed', searchProvider: 'Exa', searchOutcome: 'empty', sourceCount: 0, durationMs: 80 },
      { traceId, event: 'search.provider.request_completed', searchProvider: 'Tavily', searchOutcome: 'failed', sourceCount: 0, durationMs: 200, reason: 'plan_limit' },
      { traceId: 'other-run', event: 'search.provider.request_completed', searchProvider: 'Firecrawl', searchOutcome: 'results', sourceCount: 1, durationMs: 10 }
    ], traceId), {
      Exa: {
        requests: 2, resultRequests: 1, emptyRequests: 1, failedRequests: 0, cancelledRequests: 0,
        sourceCount: 2, durationMs: 200, failureReasons: {}
      },
      Tavily: {
        requests: 1, resultRequests: 0, emptyRequests: 0, failedRequests: 1, cancelledRequests: 0,
        sourceCount: 0, durationMs: 200, failureReasons: { plan_limit: 1 }
      }
    })
  })

  it('忽略无效渠道、状态、原因和不属于本轮的字段', () => {
    const output = searchProviderOutcomeSummary([{
      traceId: '00000000-0000-4000-8000-000000000001',
      event: 'search.provider.request_completed', searchProvider: 'Exa', searchOutcome: 'failed',
      sourceCount: 0, durationMs: 10, reason: 'private provider text', query: 'private search query'
    }, {
      traceId: '00000000-0000-4000-8000-000000000001',
      event: 'search.provider.request_completed', searchProvider: 'private provider', searchOutcome: 'results',
      sourceCount: 1, durationMs: 10
    }], '00000000-0000-4000-8000-000000000001')

    assert.deepEqual(output, {
      Exa: {
        requests: 1, resultRequests: 0, emptyRequests: 0, failedRequests: 1, cancelledRequests: 0,
        sourceCount: 0, durationMs: 10, failureReasons: {}
      }
    })
    assert.equal(JSON.stringify(output).includes('private'), false)
  })
})

describe('北京评测的浏览器工具摘要', () => {
  it('汇总固定浏览器动作码和失败阶段，不保留网页详情', () => {
    const traceId = '00000000-0000-4000-8000-000000000002'
    assert.deepEqual(browserToolOutcomeSummary([
      { traceId, event: 'agent.tool.returned', toolName: 'research_browser_navigate', browserProgressCode: 'browser_search_results_read' },
      { traceId, event: 'agent.tool.returned', toolName: 'research_browser_open_link', browserProgressCode: 'browser_link_unavailable', browserLinkFailureKind: 'stale_snapshot', browserLinkFailureStage: 'target_not_found_after_rerender' },
      { traceId, event: 'agent.tool.returned', toolName: 'research_browser_open_link', browserLinkFailureKind: 'private page content', url: 'https://private.example' },
      { traceId, event: 'agent.tool.returned', toolName: 'research_browser_navigate', browserNavigationFailureKind: 'aborted', browserNavigationFailureStage: 'redirected', url: 'https://private.example' },
      { traceId, event: 'agent.tool.returned', toolName: 'research_browser_navigate', browserNavigationFailureStage: 'private page content' },
      { traceId: 'other-run', event: 'agent.tool.returned', toolName: 'research_browser_open_link', browserProgressCode: 'browser_link_opened' }
    ], traceId), {
      callsByTool: { research_browser_navigate: 3, research_browser_open_link: 2 },
      progressCodes: { browser_search_results_read: 1, browser_link_unavailable: 1 },
      linkFailureKinds: { stale_snapshot: 1 },
      linkFailureStages: { target_not_found_after_rerender: 1 },
      navigationFailureKinds: { aborted: 1 },
      navigationFailureStages: { redirected: 1 }
    })
  })
})

describe('北京评测的模型失败摘要', () => {
  it('只输出脱敏错误类别、协议状态和允许的传输码', () => {
    const traceId = '00000000-0000-4000-8000-000000000003'
    assert.deepEqual(modelFailureSummary([
      { traceId, event: 'llm.request.failed', errorKind: 'unknown_error' },
      { traceId, event: 'llm.response.http_failed', httpStatus: 400, errorCode: 'invalid_request_error', errorParameter: 'reasoning_effort' },
      { traceId, event: 'llm.stream.failed', errorKind: 'timeout', transportCode: 'UND_ERR_BODY_TIMEOUT' },
      { traceId, event: 'llm.request.transport.retry', transportCode: 'ECONNRESET' },
      { traceId, event: 'llm.response.rate_limited', status: 'retrying', retryAfterMs: 5_000 },
      {
        traceId, event: 'llm.codex_app_server.error_notification', status: 'retrying',
        codexServerErrorKind: 'responseStreamDisconnected', codexUpstreamHttpStatus: 502,
        message: 'private upstream response'
      },
      { traceId, event: 'llm.request.failed', errorKind: 'private error with api key' },
      { traceId, event: 'llm.response.http_failed', httpStatus: 999, errorCode: 'secret response', errorParameter: 'private text' },
      { traceId, event: 'llm.stream.failed', errorKind: 'private provider body', transportCode: 'private socket text' },
      { traceId: 'other-run', event: 'llm.request.failed', errorKind: 'http_error' }
    ], traceId), {
      requestFailureKinds: { unknown_error: 1 },
      httpFailures: { '400:invalid_request_error:reasoning_effort': 1 },
      streamFailureKinds: { timeout: 1 },
      streamTransportCodes: { UND_ERR_BODY_TIMEOUT: 1 },
      transportEvents: { retries: 1, failures: 0, codes: { ECONNRESET: 1 } },
      rateLimitRetries: 1,
      codexErrorNotifications: {
        total: 1,
        retrying: 1,
        byKind: { responseStreamDisconnected: 1 },
        httpStatuses: { '502': 1 }
      }
    })
    assert.equal(JSON.stringify(modelFailureSummary([
      { traceId, event: 'llm.request.failed', errorKind: 'api key test-secret' }
    ], traceId)).includes('test-secret'), false)
  })

  it('保留 Codex 固定阶段与异常类别，不泄露原始请求或异常文本', () => {
    const traceId = '00000000-0000-4000-8000-000000000004'
    const summary = modelFailureSummary([
      {
        traceId, event: 'llm.request.failed', modelFamily: 'gpt-6-luna-codex-cli',
        errorKind: 'input_error', codexFailureStage: 'output_parse', codexErrorClass: 'TypeError',
        codexPromptBytes: 12_345, codexSchemaBytes: 405, codexImageCount: 0,
        codexFailureReason: 'process_exit', codexExitCode: 1, durationMs: 12_000,
        prompt: 'private trip context', exception: 'private exception payload'
      },
      {
        traceId, event: 'llm.request.failed', modelFamily: 'gpt-6-luna-codex-cli',
        errorKind: 'private error', codexFailureStage: 'private stage', codexErrorClass: 'private class',
        codexPromptBytes: -1, codexSchemaBytes: 1.5, codexImageCount: 99
      }
    ], traceId)

    assert.deepEqual(summary.codexFailureDetails, [{
      errorKind: 'input_error', stage: 'output_parse', errorClass: 'TypeError',
      codexPromptBytes: 12_345, codexSchemaBytes: 405, codexImageCount: 0,
      reason: 'process_exit', codexExitCode: 1, durationMs: 12_000
    }])
    assert.equal(JSON.stringify(summary).includes('private'), false)
  })

  it('保留 App Server 的失败阶段和安全分类', () => {
    const traceId = '00000000-0000-4000-8000-000000000005'
    const summary = modelFailureSummary([{
      traceId, event: 'llm.request.failed', modelFamily: 'gpt-6-luna-codex-app-server',
      errorKind: 'unknown_error', codexFailureStage: 'app_server', codexErrorClass: 'Error',
      codexPromptBytes: 4_000, codexSchemaBytes: 405, codexImageCount: 0,
      codexFailureReason: 'process_exit', errorCode: -32600
    }, {
      traceId, event: 'llm.codex_app_server.process.exited', status: 'failed',
      exitCode: 17, processSignal: 'SIGKILL', diagnosticBytes: 120
    }, {
      traceId: '00000000-0000-4000-8000-000000000099',
      event: 'llm.codex_app_server.process.exited', status: 'failed', exitCode: 99
    }], traceId)

    assert.deepEqual(summary.codexFailureDetails, [{
      errorKind: 'unknown_error', stage: 'app_server', errorClass: 'Error',
      codexPromptBytes: 4_000, codexSchemaBytes: 405, codexImageCount: 0,
      reason: 'process_exit', rpcCode: -32600, codexExitCode: 17,
      processSignal: 'SIGKILL', diagnosticBytes: 120
    }])
  })

  it('只保留 App Server 官方错误枚举和有效 HTTP 状态', () => {
    const traceId = '00000000-0000-4000-8000-000000000007'
    const summary = modelFailureSummary([{
      traceId, event: 'llm.request.failed', modelFamily: 'gpt-6-luna-codex-app-server',
      errorKind: 'unknown_error', codexFailureStage: 'app_server', codexErrorClass: 'Error',
      codexFailureReason: 'network_error', codexServerErrorKind: 'httpConnectionFailed',
      codexUpstreamHttpStatus: 503, additionalDetails: 'private provider body'
    }, {
      traceId, event: 'llm.request.failed', modelFamily: 'gpt-6-luna-codex-app-server',
      errorKind: 'private response text', codexServerErrorKind: 'private response text', codexUpstreamHttpStatus: 999
    }], traceId)

    assert.deepEqual(summary.codexFailureDetails, [{
      errorKind: 'unknown_error', stage: 'app_server', errorClass: 'Error',
      reason: 'network_error', codexServerErrorKind: 'httpConnectionFailed', codexUpstreamHttpStatus: 503
    }])
    assert.equal(JSON.stringify(summary).includes('private'), false)
  })
})
