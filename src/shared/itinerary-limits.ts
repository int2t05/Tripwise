/** 行程地点数量边界；模型草案为系统补齐硬锚点预留额外空间。 */
/** 单日模型草案最多提交的地点数。 */
export const MAX_PROPOSED_STOPS_PER_DAY = 12

/** 单日最终行程最多包含的地点数，覆盖航班、机场、住宿和车站锚点。 */
export const MAX_ITINERARY_STOPS_PER_DAY = MAX_PROPOSED_STOPS_PER_DAY + 5

/** 单个停靠点的通用来源列表上限；事实和路线字段另存各自的精确来源。 */
export const MAX_ITINERARY_STOP_SOURCE_IDS = 6

/** 单个停靠点可保存的结构化事实数量上限。 */
export const MAX_ITINERARY_FACT_CLAIMS_PER_STOP = 8

/** 将新证据来源放在列表前面，同时维持持久化结构的固定上限。 */
export function mergeItineraryStopSourceIds(
  current: readonly string[] | undefined,
  incoming: readonly string[]
): string[] {
  return [...new Set([...incoming, ...(current ?? [])])].slice(0, MAX_ITINERARY_STOP_SOURCE_IDS)
}
