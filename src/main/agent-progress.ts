/** 把内部工具调用映射为安全、可读的用户进度。 */
import type { AgentEvent } from '../shared/types.js'
import type { BrowserLinkFailureKind, ToolProgressCode } from './connectors/types.js'
import type { ToolResult } from './tools.js'

/** 将内部工具名转换为用户可读进度，不回显模型参数。 */
export function toolLabel(name: string, argumentsJson?: string): string {
  if (name === 'research_browser_interact') {
    try {
      const args: unknown = JSON.parse(argumentsJson ?? '{}')
      const targetId = isRecord(args) ? args.target_id : undefined
      if (typeof targetId === 'string' && /^s[1-9][0-9]{0,2}$/u.test(targetId)) return '正在搜索并读取当前网页'
      if (typeof targetId === 'string' && /^e[1-9][0-9]{0,2}$/u.test(targetId)) return '正在展开并读取网页内容'
    } catch {
      return '正在操作右侧研究网页'
    }
    return '正在操作右侧研究网页'
  }
  const labels: Record<string, string> = {
    search_web: '正在搜索网页来源',
    read_webpage: '正在读取已选网页正文',
    search_xiaohongshu: '正在搜索小红书公开笔记',
    read_xiaohongshu_note: '正在读取小红书笔记正文',
    get_weather: '正在查询逐日天气',
    find_places: '正在查找地点候选',
    estimate_route: '正在估算交通路线',
    propose_itineraries: '正在整理结构化行程方案',
    propose_itinerary_facts: '正在补充景点事实来源',
    propose_itinerary_meals: '正在补齐具体餐馆',
    propose_preparation: '正在整理出行准备清单',
    propose_trip_brief: '正在提取旅行信息供你确认',
    validate_model_tool_call: '正在校验工具调用格式',
    research_browser_navigate: '正在打开并读取右侧研究网页',
    research_browser_snapshot: '正在重新读取右侧网页内容',
    research_browser_open_link: '正在打开并读取网页来源',
    research_browser_scroll: '正在滚动并读取网页后续内容',
    research_browser_visual_read: '正在识别网页中的图文'
  }
  return labels[name] ?? '正在调用旅行工具'
}

/** 为进度面板生成不含参数、原文或 URL 的工具结果摘要。 */
export function toolResultProgress(name: string, result: ToolResult): {
  message: string
  outcome: NonNullable<AgentEvent['toolOutcome']>
  feedback?: NonNullable<AgentEvent['toolFeedback']>
} {
  const feedback = result.feedback ?? []
  const browserProgress = browserToolProgress(name, result.progressCode, result.browserLinkFailureKind)
  const successfulSources = result.sources.filter((source) => source.status === 'success').length
  const failedSources = result.sources.length - successfulSources
  const rejectedProposal = name === 'propose_itineraries' && !result.itineraryOptions?.length
  const rejectedFactUpdate = name === 'propose_itinerary_facts' && !result.itineraryOptions?.length
  const rejectedMealUpdate = name === 'propose_itinerary_meals' && !result.itineraryOptions?.length
  const rejectedPreparation = name === 'propose_preparation' && !result.preparationOptions?.length
  const hasError = feedback.some((item) => item.severity === 'error')
  const hasWarning = feedback.some((item) => item.severity === 'warning')
  const outcome = browserProgress?.outcome ?? (hasError || rejectedProposal || rejectedFactUpdate || rejectedMealUpdate || rejectedPreparation
    ? 'rejected'
    : result.sources.length > 0 && successfulSources === 0
      ? 'unavailable'
      : hasWarning || failedSources > 0 || result.output.startsWith('部分候选未通过校验：')
        ? 'partial'
        : 'completed')
  const message = browserProgress?.message ?? (name === 'propose_itinerary_facts'
          ? result.itineraryOptions?.length
            ? result.output.startsWith('已补充') ? '景点事实已补充' : '计划已保留，缺项待核验'
            : '景点事实补充未完成'
          : result.itineraryOptions?.length
            ? `已生成 ${result.itineraryOptions.length} 份草案`
            : name === 'propose_itinerary_meals' && outcome !== 'rejected'
              ? '餐次已更新'
              : result.preparationOptions?.length
                ? `已整理 ${result.preparationOptions.length} 项准备事项`
                : result.routeOptions?.length
                  ? `已取得 ${result.routeOptions.length} 段路线结果`
                  : result.sources.length > 0
                    ? successfulSources > 0 ? `${successfulSources} 个来源${failedSources ? `，${failedSources} 个不可用` : ''}` : '来源暂不可用'
                    : name === 'search_web' || name === 'search_xiaohongshu'
                      ? '没有找到可用来源'
                      : rejectedProposal ? '草案未通过校验'
                        : rejectedFactUpdate ? '事实补充未通过校验'
                          : rejectedMealUpdate ? '餐次修订未通过校验'
                            : rejectedPreparation ? '准备清单未通过校验'
                              : '已返回结果'
  )
  return { message, outcome, ...(feedback.length ? { feedback } : {}) }
}

/** 把浏览器动作码映射到固定进度文案，不解析页面或工具输出。 */
function browserToolProgress(name: string, code?: ToolProgressCode, linkFailureKind?: BrowserLinkFailureKind): {
  message: string
  outcome: NonNullable<AgentEvent['toolOutcome']>
} | undefined {
  if (name === 'research_browser_interact') {
    switch (code) {
      case 'browser_interact_search_completed': return { message: '搜索结果已打开并读取', outcome: 'completed' }
      case 'browser_interact_expand_completed': return { message: '内容已展开并读取', outcome: 'completed' }
      case 'browser_interact_target_stale': return { message: '目标失效，请重新读取网页', outcome: 'unavailable' }
      case 'browser_interact_write_blocked': return { message: '网页修改请求已拦截', outcome: 'unavailable' }
      case 'browser_interact_search_unsupported': return { message: '仅支持同站 GET 搜索', outcome: 'unavailable' }
      case 'browser_interact_unavailable': return { message: '网页交互未完成', outcome: 'unavailable' }
      default: return { message: '网页交互未完成', outcome: 'unavailable' }
    }
  }
  if (name === 'research_browser_open_link') {
    if (code === 'browser_link_opened') return { message: '网页来源已打开并读取', outcome: 'completed' }
    if (code === 'browser_link_read_partial') return { message: '页面加载超时，已读取当前可见内容', outcome: 'partial' }
    if (code === 'browser_link_read_unavailable') return { message: '网页已打开，正文暂不可用', outcome: 'partial' }
    if (linkFailureKind === 'stale_snapshot') return { message: '网页已变化，请重新读取快照', outcome: 'unavailable' }
    if (linkFailureKind === 'access_gate') return { message: '网页需要手动处理访问门槛', outcome: 'unavailable' }
    if (linkFailureKind && linkFailureKind !== 'unknown' && linkFailureKind !== 'aborted') {
      return { message: '网页连接失败，可继续其他来源', outcome: 'unavailable' }
    }
    return { message: '网页链接未打开', outcome: 'unavailable' }
  }
  if (name === 'research_browser_navigate') {
    switch (code) {
      case 'browser_navigation_read_completed': return { message: '网页已打开并读取', outcome: 'completed' }
      case 'browser_navigation_read_partial': return { message: '页面加载超时，已读取当前可见内容', outcome: 'partial' }
      case 'browser_search_results_read': return { message: '搜索结果已读取', outcome: 'completed' }
      case 'browser_navigation_read_blocked': return { message: '网页要求手动处理访问门槛', outcome: 'unavailable' }
      case 'browser_navigation_read_unavailable': return { message: '网页已打开，正文暂不可用', outcome: 'partial' }
      default: return { message: '网页未打开', outcome: 'unavailable' }
    }
  }
  if (name === 'research_browser_visual_read') {
    switch (code) {
      case 'browser_visual_read_completed': return { message: '已读取页面视觉线索，待来源核验', outcome: 'completed' }
      case 'browser_visual_read_unsupported': return { message: '模型不支持图片读取，截图未发送', outcome: 'unavailable' }
      case 'browser_visual_read_limit': return { message: '已达到视觉读取上限', outcome: 'unavailable' }
      case 'browser_visual_read_blocked': return { message: '网页要求手动处理访问验证', outcome: 'unavailable' }
      case 'browser_visual_read_unavailable': return { message: '网页图像读取未完成', outcome: 'unavailable' }
      default: return { message: '网页图像读取未完成', outcome: 'unavailable' }
    }
  }
  return undefined
}

/** 仅接受解析后的 JSON 对象，避免读取任意属性时触发异常。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
