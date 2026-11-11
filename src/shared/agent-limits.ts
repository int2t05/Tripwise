/** 约束模型工具调用的最大体积；完整多日行程需要更大的独立上限。 */
export const MAX_TOOL_ARGUMENT_CHARACTERS = 20_000
export const MAX_ITINERARY_ARGUMENT_CHARACTERS = 160_000
/** 多日规划可一次请求多个检索；保持批次有界并给恢复记录留出空间。 */
export const MAX_TOOL_CALLS_PER_MESSAGE = 32
/** 详细检索、逐页阅读和多轮方案修订共用的恢复记录上限。 */
export const MAX_AGENT_RUN_TRANSCRIPT_MESSAGES = 192
/** 一轮详细计划会同时保留搜索摘要、网页正文、天气和路线等来源。 */
export const MAX_AGENT_RUN_SOURCE_IDS = 256
/** 用户导入资料的云端上下文预算；界面披露和主进程筛选共用。 */
export const MAX_IMPORTED_SOURCES_PER_CONTEXT = 6
export const MAX_IMPORTED_SOURCE_CONTEXT_CHARACTERS = 24_000
export const MAX_IMPORTED_SOURCE_CHARACTERS_PER_ITEM = 8_000
