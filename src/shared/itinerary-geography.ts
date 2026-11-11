/** 从行程中识别可能的片区往返；只用于用户审阅，不改变停靠点顺序。 */
import type { ItineraryDay, ItineraryOption, ItineraryStop } from './types.js'

export interface ItineraryGeographicReview {
  dayNumber: number
  date: string
  areaSequence: string[]
}

/** 跨日出现的同名游览地点；该结果只供用户审阅，不自动删除地点。 */
export interface RepeatedLandmarkReview {
  name: string
  visits: Array<{ dayNumber: number; date: string }>
}

interface AreaVisit {
  label: string
  keys: Set<string>
}

/** 对区域名称生成有限别名，兼容行政区前缀及“街/片区”等后缀。 */
function areaKeys(area: string, destination: string): { label: string; keys: Set<string> } | undefined {
  const cityNames = new Set([
    '中国', destination.trim(), `${destination.trim()}市`, `${destination.trim()}省`
  ].filter(Boolean).map(normalizeAreaKey))
  const segments = area.normalize('NFKC').split(/[·•、，,|/／>→]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment && !cityNames.has(normalizeAreaKey(segment)))
  const meaningful = segments.filter((segment) => !/^(?:[^市区县旗]{1,6})(?:市|区|县|旗|省)$/u.test(segment))
  const candidates = meaningful.length ? meaningful : segments.slice(-1)
  const keys = new Set(candidates.flatMap((segment) => areaAliases(segment)))
  if (!keys.size) return undefined
  return { label: candidates.at(-1) ?? area.trim(), keys }
}

/** 生成原名称和有限地点后缀别名，不做模糊词义匹配。 */
function areaAliases(value: string): string[] {
  const key = normalizeAreaKey(value)
  if (!key) return []
  const short = key.replace(/(?:大街|街道|街区|胡同|片区|商圈|区域|景区|园区|校区|新区|城区|区|县|市|省)$/u, '')
  return [...new Set([key, short].filter(Boolean))]
}

/** 统一全半角、空白和标点，保留区域名称本身。 */
function normalizeAreaKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 餐饮、住宿、交通和休息不是需要提示跨日重复的游览地点。 */
function isReviewableLandmark(stop: ItineraryStop): boolean {
  return !/(?:餐|美食|酒店|住宿|交通|接驳|航班|机场|车站|候车|休息|休整|午休|机动|缓冲|入住|退房)/u
    .test(`${stop.category} ${stop.name}`)
}

/** 只按规范化后的完整名称匹配，避免把近似景点误报为重复。 */
export function repeatedLandmarkReviews(option: ItineraryOption): RepeatedLandmarkReview[] {
  const visitsByName = new Map<string, RepeatedLandmarkReview>()
  for (const day of option.days) {
    const seenToday = new Set<string>()
    for (const stop of day.stops) {
      if (!isReviewableLandmark(stop)) continue
      const key = normalizeAreaKey(stop.name)
      if (!key || seenToday.has(key)) continue
      seenToday.add(key)
      const review = visitsByName.get(key) ?? { name: stop.name.trim(), visits: [] }
      if (!review.visits.some((visit) => visit.dayNumber === day.dayNumber)) {
        review.visits.push({ dayNumber: day.dayNumber, date: day.date })
      }
      visitsByName.set(key, review)
    }
  }

  return [...visitsByName.values()]
    .filter((review) => review.visits.length > 1)
    .sort((left, right) => left.visits[0]!.dayNumber - right.visits[0]!.dayNumber || left.name.localeCompare(right.name, 'zh-CN'))
}

/** 为重复景点提示生成可编辑的修改起点，不直接改变计划。 */
export function repeatedLandmarkRevisionSuggestion(reviews: RepeatedLandmarkReview[]): string {
  const visible = reviews.slice(0, 5).map((review) => {
    const days = review.visits.map((visit) => `第 ${visit.dayNumber} 天${visit.date ? `（${visit.date}）` : ''}`).join('、')
    return `${review.name}（${days}）`
  })
  const remainingCount = Math.max(0, reviews.length - visible.length)
  return `请核对跨日重复的景点：${visible.join('、')}${remainingCount ? `，另有 ${remainingCount} 项` : ''}。保留用户指定、已预约和锁定的地点；若是不同展览、分馆或有意重访，请保留并说明原因，否则只调整涉及的日期，其他日期不变。`
}

/** 交通、住宿和纯休息点不代表可用于判断游览片区的地点。 */
function isGeographicVisit(stop: ItineraryStop): boolean {
  return !/(?:交通|接驳|住宿|酒店|航班|机场|车站|候车|休息|休整|午休|机动|缓冲)/u.test(`${stop.category} ${stop.name}`)
}

/** 汇总同一片区的相邻停靠点，并识别日程中途离开后再次返回的情况。 */
export function itineraryGeographicReview(
  day: ItineraryDay,
  destination = ''
): ItineraryGeographicReview | undefined {
  const visits: AreaVisit[] = []
  for (const stop of day.stops) {
    if (!isGeographicVisit(stop) || !stop.area.trim()) continue
    const area = areaKeys(stop.area, destination)
    if (!area) continue
    const previous = visits.at(-1)
    if (previous && hasAreaOverlap(previous.keys, area.keys)) {
      area.keys.forEach((key) => previous.keys.add(key))
      continue
    }
    visits.push(area)
  }

  if (visits.length < 3) return undefined
  const returnsToPriorArea = visits.some((visit, index) => index >= 2 &&
    visits.slice(0, index - 1).some((previous) => hasAreaOverlap(previous.keys, visit.keys)))
  return returnsToPriorArea
    ? { dayNumber: day.dayNumber, date: day.date, areaSequence: visits.map((visit) => visit.label) }
    : undefined
}

/** 两个标注重叠时仅表示名称相同或有限后缀别名相同。 */
function hasAreaOverlap(left: Set<string>, right: Set<string>): boolean {
  return [...left].some((key) => right.has(key))
}
