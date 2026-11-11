/** 按用餐片区分别生成店名发现与来源核验查询。 */
import type { ItineraryOption, ItineraryStop, SourceRecord } from '../shared/types.js'
import { isPlaceholderRestaurantName, mealSlotForBlock, mealSlotForStop } from './connectors/itinerary.js'
import { sourceDirectlyNamesRestaurant, type ItineraryMealRepairTarget } from './connectors/itinerary-meals.js'
import { spreadResearchQueries } from './agent-research.js'

export type MealResearchPurpose = 'name-discovery' | 'source-verification'

export interface MealResearchQuery {
  purpose: MealResearchPurpose
  query: string
}

interface MealResearchGroup {
  area: string
  unnamedLandmarks: string[]
  unnamedSlots: Set<string>
  namedSlots: Map<string, Set<string>>
}

const MEAL_LABELS: Record<ItineraryMealRepairTarget['meal_slot'], string> = {
  breakfast: '早餐', lunch: '午餐', dinner: '晚餐'
}

/** 聚合同片区餐次，并分开生成推荐候选与已有店名核验查询。 */
export function namedMealResearchQueries(
  options: ItineraryOption[], targets: ItineraryMealRepairTarget[], destination: string,
  sources: SourceRecord[] = []
): MealResearchQuery[] {
  const groups = new Map<string, MealResearchGroup>()

  for (const target of targets) {
    const option = options[target.plan_number - 1]
    const day = option?.days.find((item) => item.date === target.date) ??
      option?.days.find((item) => item.dayNumber === target.day_number)
    if (!day) continue

    const stopIndex = day.stops.findIndex((stop) =>
      /餐/u.test(stop.category) && mealSlotForStop(stop) === target.meal_slot
    )
    const stop = stopIndex < 0 ? undefined : day.stops[stopIndex]
    const block = day.scheduleBlocks.find((item) =>
      item.kind === 'meal' && mealSlotForBlock(item) === target.meal_slot
    )
    const nearby = nearbyMealLandmark(day.stops, stopIndex, stop?.time ?? block?.time ?? target.time ?? '')
    const name = target.current_name?.trim() ?? ''
    if (name && !isPlaceholderRestaurantName(name) &&
        sources.some((source) => sourceDirectlyNamesRestaurant(name, source))) continue

    const area = (target.area || stop?.area || block?.area || nearby?.area || '').trim()
    const landmark = nearby?.name.trim() ?? ''
    const key = normalizeArea(area) || normalizeArea(landmark) || `${target.date}:${target.day_number}`
    let group = groups.get(key)
    if (!group) {
      group = { area, unnamedLandmarks: [], unnamedSlots: new Set(), namedSlots: new Map() }
      groups.set(key, group)
    }
    if (!group.area && area) group.area = area
    if (name && !isPlaceholderRestaurantName(name)) {
      const slots = group.namedSlots.get(name) ?? new Set<string>()
      slots.add(MEAL_LABELS[target.meal_slot])
      group.namedSlots.set(name, slots)
    } else {
      group.unnamedSlots.add(MEAL_LABELS[target.meal_slot])
      if (landmark && !group.unnamedLandmarks.includes(landmark)) group.unnamedLandmarks.push(landmark)
    }
  }

  const queries: MealResearchQuery[] = []
  const city = destination.trim().slice(0, 36)
  for (const group of groups.values()) {
    if (group.unnamedSlots.size) {
      const parts = [city, group.area.slice(0, 36), group.unnamedLandmarks[0]?.slice(0, 24)]
      parts.push([...group.unnamedSlots].join('、'), '餐馆推荐 具体店名 门店')
      const query = parts.filter(Boolean).join(' ').replace(/\s+/gu, ' ').trim().slice(0, 180)
      if (query && !queries.some((item) => item.query === query)) {
        queries.push({ purpose: 'name-discovery', query })
      }
    }
    const namedEntries = [...group.namedSlots.entries()]
    for (const batch of chunk(namedEntries, 2)) {
      const slots = [...new Set(batch.flatMap(([, values]) => [...values]))]
      const parts = [city, group.area.slice(0, 36), ...batch.map(([name]) => queryName(name))]
      parts.push(slots.join('、'), '餐馆 门店地址')
      const query = parts.filter(Boolean).join(' ').replace(/\s+/gu, ' ').trim().slice(0, 180)
      if (query && !queries.some((item) => item.query === query)) {
        queries.push({ purpose: 'source-verification', query })
      }
    }
  }

  return queries
}

/** 有限预算先用于填补缺店名餐次，再核验已有店名。 */
export function selectMealResearchQueries(
  queries: readonly MealResearchQuery[],
  limit: number
): MealResearchQuery[] {
  const capacity = Math.max(0, Math.floor(limit))
  const selectPurpose = (purpose: MealResearchPurpose, count: number): MealResearchQuery[] => {
    const candidates = queries.filter((item) => item.purpose === purpose)
    return spreadResearchQueries(candidates.map((item) => item.query), count).flatMap((query) => {
      const candidate = candidates.find((item) => item.query === query)
      return candidate ? [candidate] : []
    })
  }
  const discoveries = selectPurpose('name-discovery', capacity)
  const verifications = selectPurpose('source-verification', capacity - discoveries.length)
  return [...discoveries, ...verifications]
}

/** 搜索摘要未直接提到目标店名，或餐次还没有店名时，应继续跟进原始网页。 */
export function mealQueryNeedsBrowserFollowup(
  query: string,
  targets: readonly ItineraryMealRepairTarget[],
  sources: SourceRecord[]
): boolean {
  const normalizedQuery = normalizeMealName(query)
  const namedTargets = targets.flatMap((target) => {
    const name = target.current_name?.trim() ?? ''
    return name && !isPlaceholderRestaurantName(name) && normalizedQuery.includes(normalizeMealName(name))
      ? [name]
      : []
  })
  if (!namedTargets.length) return true
  return namedTargets.some((name) => !sources.some((source) => sourceDirectlyNamesRestaurant(name, source)))
}

/** 选择离餐次最近的实体地点，避开酒店、交通和其他餐次。 */
function nearbyMealLandmark(stops: ItineraryStop[], mealIndex: number, mealTime: string): ItineraryStop | undefined {
  const isLandmark = (stop: ItineraryStop | undefined): stop is ItineraryStop => !!stop &&
    !/交通|接驳|住宿|酒店|航班|机场|车站|火车|高铁|动车|餐/u.test(`${stop.category} ${stop.name}`)
  const adjacent = [stops[mealIndex - 1], stops[mealIndex + 1]].find(isLandmark)
  if (adjacent) return adjacent
  const mealMinute = firstClockMinute(mealTime)
  return stops.filter(isLandmark)
    .map((stop) => ({ stop, minute: firstClockMinute(stop.time) }))
    .sort((left, right) => {
      if (mealMinute === undefined) return 0
      const leftDistance = left.minute === undefined ? Infinity : Math.abs(left.minute - mealMinute)
      const rightDistance = right.minute === undefined ? Infinity : Math.abs(right.minute - mealMinute)
      return leftDistance - rightDistance
    })[0]?.stop
}

/** 统一相邻片区标签，兼容“前门”和“前门片区”等常见写法。 */
function normalizeArea(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN')
    .replace(/北京市|北京|中国|片区|商圈|附近|地区|街道/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/** 统一搜索词和商户名的标点，只用于关联本轮定向检索目标。 */
function normalizeMealName(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase('zh-CN')
}

/** 名称较长时保留商户主体；不让搜索词中间截断分店和同行候选。 */
function queryName(value: string): string {
  const name = value.trim()
  if (name.length <= 44) return name
  const brand = name.split(/[（(]/u, 1)[0]?.trim() ?? name
  return brand.slice(0, 44)
}

/** 将同一片区的候选拆成两家一组，保持查询能被搜索服务理解。 */
function chunk<T>(values: T[], size: number): T[][] {
  const output: T[][] = []
  for (let index = 0; index < values.length; index += size) output.push(values.slice(index, index + size))
  return output
}

/** 从时间文本中取首个时刻，用于定位最近的用餐片区。 */
function firstClockMinute(value: string): number | undefined {
  const match = value.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/u)
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined
}
