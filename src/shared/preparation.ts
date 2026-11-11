/** 按事项日期组织准备清单，并关联日期完全一致的行程日作为上下文。 */
import type { ItineraryDay, PreparationItem } from './types.js'

export interface PreparationDateGroup {
  kind: 'itinerary' | 'deadline' | 'legacy' | 'undated'
  date: string
  items: PreparationItem[]
  itineraryDays: ItineraryDay[]
}

/** 适用日、截止日和旧版歧义日期分开分组，避免把提醒日期误认为行程日。 */
export function groupPreparationItemsByDate(
  items: PreparationItem[],
  itineraryDays: ItineraryDay[]
): PreparationDateGroup[] {
  const itemsByDate = new Map<string, PreparationDateGroup>()
  for (const item of items) {
    const kind: PreparationDateGroup['kind'] = item.legacyDate
      ? 'legacy'
      : item.itineraryDate
        ? 'itinerary'
        : item.dueDate
          ? 'deadline'
          : 'undated'
    const date = kind === 'legacy' ? item.legacyDate! : kind === 'itinerary' ? item.itineraryDate : kind === 'deadline' ? item.dueDate : ''
    const key = `${kind}\u0000${date}`
    const group = itemsByDate.get(key) ?? { kind, date, items: [], itineraryDays: [] }
    group.items.push(item)
    itemsByDate.set(key, group)
  }

  const daysByDate = new Map<string, ItineraryDay[]>()
  for (const day of itineraryDays) {
    if (!day.date) continue
    const group = daysByDate.get(day.date) ?? []
    group.push(day)
    daysByDate.set(day.date, group)
  }

  return [...itemsByDate.values()]
    .map((group) => ({
      ...group,
      itineraryDays: group.kind === 'itinerary'
        ? [...(daysByDate.get(group.date) ?? [])].sort((left, right) => left.dayNumber - right.dayNumber)
        : []
    }))
    .sort((left, right) => {
      const priority: Record<PreparationDateGroup['kind'], number> = { itinerary: 0, deadline: 1, legacy: 2, undated: 3 }
      if (priority[left.kind] !== priority[right.kind]) return priority[left.kind] - priority[right.kind]
      return left.date.localeCompare(right.date)
    })
}

/** 只接受路线来源中同一方案明确列出的距离和耗时，拒绝借用其他方案数值。 */
export function routeSummarySupportsMetrics(
  summary: string,
  optionNumber: number,
  distanceMeters?: number,
  durationMinutes?: number,
  fareFen?: number,
  tollFen?: number
): boolean {
  const prefix = `方案 ${optionNumber}：`
  const optionLine = summary.split(/\r?\n/).find((line) => line.startsWith(prefix))
  if (!optionLine) return false
  if (distanceMeters !== undefined && !optionLine.includes(routeDistanceLabel(distanceMeters))) return false
  if (durationMinutes !== undefined && !optionLine.includes(`约 ${durationMinutes} 分钟`)) return false
  if (fareFen !== undefined && !routeLineHasAmount(optionLine, '票价估算', fareFen)) return false
  if (tollFen !== undefined && !routeLineHasAmount(optionLine, '道路收费估算', tollFen)) return false
  return true
}

/** 地点名称按 Unicode 兼容形式和空白归一后比较，避免把不同地图候选混为同一家。 */
export function placeNamesMatch(left: string, right: string): boolean {
  return normalizePlaceName(left) === normalizePlaceName(right)
}

/** 路线来源标题必须同时包含起点和终点，避免引用无关路线的数值。 */
export function routeTitleMatchesEndpoints(title: string, origin: string, destination: string): boolean {
  const normalizedTitle = normalizePlaceName(title)
  return normalizedTitle.includes(normalizePlaceName(origin)) && normalizedTitle.includes(normalizePlaceName(destination))
}

/** 方向敏感的接驳必须按路线来源标题中的起点和终点顺序匹配。 */
export function routeTitleMatchesOrderedEndpoints(title: string, origin: string, destination: string): boolean {
  const [titleOrigin, titleDestination] = title.split('→', 2).map((part) => part.trim())
  return !!titleOrigin && !!titleDestination && routeEndpointMatches(titleOrigin, origin) && routeEndpointMatches(titleDestination, destination)
}

/** 高德路线标题会把地址附在地点名后；只去掉末尾括号地址，不忽略地点名内部的别名。 */
function routeEndpointMatches(titleEndpoint: string, requestedEndpoint: string): boolean {
  if (placeNamesMatch(titleEndpoint, requestedEndpoint)) return true
  const titleName = titleEndpoint.replace(/[（(][^（）()]*[）)]$/u, '').trim()
  return titleName !== titleEndpoint && placeNamesMatch(titleName, requestedEndpoint)
}

/** 统一地点名称匹配规则，不改变原始名称的展示值。 */
function normalizePlaceName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

/** 与路线连接器使用相同的显示格式匹配来源摘要中的距离。 */
function routeDistanceLabel(meters: number): string {
  return meters >= 1_000 ? `${(meters / 1_000).toFixed(1)} km` : `${Math.round(meters)} m`
}

/** 仅比较对应的费用字段，避免把票价和道路收费混作同一费用。 */
function routeLineHasAmount(line: string, label: '票价估算' | '道路收费估算', amountFen: number): boolean {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return [...line.matchAll(new RegExp(`${escapedLabel}\\s*[¥￥]?\\s*(\\d+(?:\\.\\d{1,2})?)`, 'gu'))]
    .some((match) => yuanToFen(match[1] ?? '') === amountFen)
}

/** 将人民币元值转换成整数分，避免浮点误差。 */
function yuanToFen(value: string): number | undefined {
  const match = value.match(/^(\d+)(?:\.(\d{1,2}))?$/u)
  if (!match) return undefined
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
}
