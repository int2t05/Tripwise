/** 注册内置旅行连接器，并在统一边界校验参数、隔离错误和来源。 */
import { createSource, ToolInputError, type ToolContext, type ToolResult, type TravelTool } from './connectors/types.js'
import type { SourceRetry } from '../shared/types.js'
import { MAX_ITINERARY_ARGUMENT_CHARACTERS, MAX_TOOL_ARGUMENT_CHARACTERS } from '../shared/agent-limits.js'
import { placeSearchTool } from './connectors/places.js'
import { routeTool } from './connectors/routes.js'
import { itineraryProposalDefinitionForBudget, itineraryProposalTool } from './connectors/itinerary.js'
import { itineraryFactRepairDefinitionForSourceBindings, itineraryFactRepairTool } from './connectors/itinerary-facts.js'
import { itineraryMealRepairTool, itineraryMealSourceFeedback } from './connectors/itinerary-meals.js'
import { preparationProposalTool } from './connectors/preparation.js'
import { briefProposalTool } from './connectors/brief.js'
import { weatherTool } from './connectors/weather.js'
import { webSearchTool } from './connectors/web-search.js'
import { webPageReadTool } from './connectors/web-page.js'
import { xiaohongshuReadTool, xiaohongshuSearchTool } from './connectors/xiaohongshu.js'
import { researchBrowserTools } from './connectors/research-browser-tools.js'

export type { ToolDefinition, ToolResult, ToolContext } from './connectors/types.js'
export { parseDuckDuckGoResults } from './connectors/web-search.js'

/** 内置工具仅注册产品需要的只读能力，适配器按能力单独维护。 */
const TOOL_REGISTRY: TravelTool[] = [webSearchTool, webPageReadTool, ...researchBrowserTools, xiaohongshuSearchTool, xiaohongshuReadTool, weatherTool, placeSearchTool, routeTool, itineraryProposalTool, itineraryFactRepairTool, itineraryMealRepairTool, preparationProposalTool, briefProposalTool]

/** 按当前凭证状态只向模型公开已配置并可执行的工具。 */
export function getToolDefinitions(context: ToolContext) {
  return TOOL_REGISTRY
    .filter((tool) => isToolAvailable(tool, context))
    // 详细计划先确认地点顺序，再把路线工具交给 Agent 自主选择。
    .filter((tool) => tool !== routeTool || !context.routeCoverageRequested || !!context.itineraryOptions?.length)
    .map((tool) => {
      if (tool === itineraryProposalTool) {
        return itineraryProposalDefinitionForBudget({ ...context, budgetRequested: context.budgetRequested !== false })
      }
      if (tool === itineraryFactRepairTool) {
        return itineraryFactRepairDefinitionForSourceBindings(context.factRepairSourceBindings ?? [])
      }
      return tool.definition
    })
}

/** 在统一错误边界执行只读连接器，保留可追溯失败来源供用户审阅。 */
export async function executeTool(
  name: string,
  rawArguments: string,
  context: ToolContext,
  signal?: AbortSignal
): Promise<ToolResult> {
  const tool = TOOL_REGISTRY.find((candidate) => candidate.definition.function.name === name)
  if (!tool || !isToolAvailable(tool, context)) {
    const message = name === 'estimate_route' && context.amapRouteCircuitBreaker?.quotaErrorCode
      ? '高德路线服务已达到本轮调用限制；剩余路线和耗时保留为待核验，可稍后重试。'
      : '该旅行工具当前不可用或未启用。'
    return {
      ...routeFailureResult(name, message, 'tool_unavailable'),
      ...(name === 'estimate_route' && context.amapRouteCircuitBreaker?.quotaErrorCode ? { routeQuotaLimited: true } : {})
    }
  }
  const maxArgumentCharacters = name === 'propose_itineraries'
    ? MAX_ITINERARY_ARGUMENT_CHARACTERS
    : MAX_TOOL_ARGUMENT_CHARACTERS
  if (rawArguments.length > maxArgumentCharacters) {
    return routeFailureResult(name, '工具参数过长，请重新生成本次请求。', 'input_error')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return routeFailureResult(name, '工具参数不是有效 JSON。', 'input_error', 'invalid_json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return routeFailureResult(name, '工具参数必须是 JSON 对象。', 'input_error', 'invalid_arguments')
  }

  try {
    const result = await tool.execute(parsed as Record<string, unknown>, context, signal)
    const mealEvidenceResult = attachNamedMealSourceFeedback(name, result, context)
    return attachSourceFeedback(attachRetry(mealEvidenceResult, createSourceRetry(name, parsed as Record<string, unknown>)))
  } catch (error) {
    if (signal?.aborted) throw error
    if (name === 'estimate_route' && context.amapRouteCircuitBreaker?.quotaErrorCode) {
      return {
        ...routeFailureResult(
          name,
          '高德路线服务已达到本轮调用限制；剩余路线和耗时保留为待核验，可稍后重试。',
          'tool_unavailable'
        ),
        routeQuotaLimited: true
      }
    }
    const detail = error instanceof Error ? error.message : '服务暂时不可用。'
    if (error instanceof ToolInputError) {
      const message = redactToolSecrets(detail, context).slice(0, 1_200)
      const routeFailureKind = name === 'estimate_route'
        ? error.severity === 'error'
          ? 'input_error'
          : error.code === 'route_endpoint_unconfirmed' || error.code === 'route_hub_unconfirmed'
            ? 'location_unresolved'
            : 'route_data_missing'
        : undefined
      return {
        output: message,
        sources: [],
        feedback: [{ severity: error.severity, code: error.code, message }],
        ...(routeFailureKind ? { routeFailureKind } : {})
      }
    }
    const summary = `${tool.provider}查询失败；相关信息应保留为待核验，可继续使用其他来源。`
    const retry = createSourceRetry(name, parsed as Record<string, unknown>)
    return {
      output: summary,
      sources: tool.sourceUrl
        ? [createSource(`${tool.provider}查询状态`, tool.sourceUrl, tool.provider, tool.kind, '服务暂不可用。', 'error')]
          .map((source) => retry ? { ...source, retry } : source)
        : [],
      feedback: [{ severity: 'warning', code: 'provider_unavailable', message: summary }],
      ...(name === 'estimate_route' ? { routeFailureKind: 'connector_error' as const } : {})
    }
  }
}

/** 将具名餐馆的正文证据缺口作为 warning 返回，不阻止草案或强制补查。 */
function attachNamedMealSourceFeedback(name: string, result: ToolResult, context: ToolContext): ToolResult {
  if (name !== 'propose_itineraries' || !context.requireNamedMealStops || !result.itineraryOptions?.length) {
    return result
  }
  const gaps = itineraryMealSourceFeedback(
    result.itineraryOptions,
    context.requiredMealSlots ?? [],
    context.availableSources ?? [],
    context.unchangedItineraryDates ?? []
  )
  if (gaps.length === 0) return result

  const feedback = {
    severity: 'warning' as const,
    code: 'meal_source_evidence_pending',
    message: `${gaps.length} 个具名餐次没有绑定直接提及店名的来源正文，仍待核验。可按需检索并调用餐次修订工具；没有直接证据时保留待核验状态。`
  }
  return { ...result, feedback: [...(result.feedback ?? []), feedback] }
}

/** 保留路线工具边界拒绝类型，便于自动补查与日志区分参数问题和服务问题。 */
function routeFailureResult(
  name: string,
  output: string,
  routeFailureKind: NonNullable<ToolResult['routeFailureKind']>,
  code: string = routeFailureKind
): ToolResult {
  return {
    output,
    sources: [],
    feedback: [{
      severity: routeFailureKind === 'input_error' ? 'error' : 'warning',
      code,
      message: output
    }],
    ...(name === 'estimate_route' ? { routeFailureKind } : {})
  }
}

/** 搜索多渠道存在部分失败时，将状态作为结构化警告交还 Agent。 */
function attachSourceFeedback(result: ToolResult): ToolResult {
  if (result.feedback?.length) return result
  const failedCount = result.sources.filter((source) => source.status === 'error' || source.status === 'unavailable').length
  if (failedCount === 0) return result
  return {
    ...result,
    feedback: [{
      severity: 'warning',
      code: 'source_unavailable',
      message: `${failedCount} 个来源不可用；判断是否需要改用其他来源。`
    }]
  }
}

/** 防止供应商异常回显本轮已知凭证。 */
function redactToolSecrets(message: string, context: ToolContext): string {
  const secrets = [context.amapKey, context.exaKey, context.tavilyKey, context.firecrawlKey]
    .filter((value): value is string => typeof value === 'string' && value.length >= 8)
  return secrets.reduce((text, secret) => text.split(secret).join('[已隐藏]'), message)
}

/** 只把允许重试的旅行查询参数放进来源记录，不保存服务密钥或任意模型参数。 */
function createSourceRetry(name: string, args: Record<string, unknown>): SourceRetry | undefined {
  /** 仅返回长度受限的文本参数，不把任意对象或密钥带入重试记录。 */
  const text = (key: string, max: number): string | undefined => {
    const value = args[key]
    return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : undefined
  }
  if (name === 'search_web') {
    const query = text('query', 180)
    return query ? { toolName: 'search_web', arguments: { query } } : undefined
  }
  if (name === 'read_webpage') {
    const url = text('url', 4_000)
    return url ? { toolName: 'read_webpage', arguments: { url } } : undefined
  }
  if (name === 'search_xiaohongshu') {
    const query = text('query', 100)
    const rawLimit = args.limit
    const limit = typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 5
      ? rawLimit
      : undefined
    return query ? { toolName: 'search_xiaohongshu', arguments: { query, ...(limit ? { limit } : {}) } } : undefined
  }
  if (name === 'read_xiaohongshu_note') {
    const url = text('url', 2_000)
    return url ? { toolName: 'read_xiaohongshu_note', arguments: { url } } : undefined
  }
  if (name === 'find_places') {
    const city = text('city', 80)
    const query = text('query', 100)
    const nearStopId = text('near_stop_id', 100)
    return city && query
      ? { toolName: 'find_places', arguments: { city, query, ...(nearStopId ? { near_stop_id: nearStopId } : {}) } }
      : undefined
  }
  if (name === 'get_weather') {
    const city = text('city', 80)
    if (!city) return undefined
    const startDate = text('start_date', 10)
    const endDate = text('end_date', 10)
    return {
      toolName: 'get_weather',
      arguments: { city, ...(startDate ? { start_date: startDate } : {}), ...(endDate ? { end_date: endDate } : {}) }
    }
  }
  return undefined
}

/** 只为部分或失败结果提供来源级重试入口，成功结果不会误显示重试按钮。 */
function attachRetry(result: ToolResult, retry: SourceRetry | undefined): ToolResult {
  if (!retry) return result
  return {
    ...result,
    sources: result.sources.map((source) => source.status === 'success' ? source : { ...source, retry })
  }
}

/** 同时检查用户开关与服务凭证状态，防止模型直接调用被关闭的工具。 */
function isToolAvailable(tool: TravelTool, context: ToolContext): boolean {
  if (tool.connector && context.connectors?.[tool.connector] === false) return false
  return tool.isAvailable?.(context) ?? true
}
