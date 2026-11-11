/** 集中定义行程动态事实的来源资格、正文支持和待核验规则。 */
import type { ItineraryFactType, SourceContentLevel, SourceRecord } from '../../shared/types.js'
import { hasExplicitBookingRule, itineraryKnownPlaceNamesInText, itinerarySourceNamesPlace, ITINERARY_TICKET_PRICE_TERMS } from '../../shared/itinerary-facts.js'

/** 老旅行数据缺少内容层级时按来源类型保守推断。 */
export function legacySourceContentLevel(source: SourceRecord): SourceContentLevel {
  if (source.status !== 'success') return 'status'
  if (source.kind === 'user') return 'user-provided'
  if (source.kind === 'plugin') return 'plugin'
  if (source.kind === 'weather' || source.kind === 'place' || source.kind === 'route') return 'structured'
  if (source.kind === 'web' && /网页正文|研究浏览器/u.test(source.provider)) return 'page'
  return 'snippet'
}

/** 事实来源只要求同地点和类型线索相符；具体结论仍需正文直接支持。 */
export function pageBodySupportsFactType(type: ItineraryFactType, text: string): boolean {
  const patterns: Partial<Record<ItineraryFactType, RegExp>> = {
    'opening-hours': /开放|营业|开门|关门|闭馆|闭园|停止入园|停止入场|停止入馆|周一|周末|旺季|淡季|opening|closing/iu,
    closure: /关闭|闭馆|闭园|停止入园|停止入场|停止入馆|休馆|closure|closed/iu,
    booking: /预约|预订|实名|购票|售票|入场|reservation|booking|ticket/iu,
    'ticket-price': ITINERARY_TICKET_PRICE_TERMS
  }
  return patterns[type]?.test(text) ?? false
}

/** 生成结构化事实的待核验占位值，不保留模型猜出的数值。 */
export function pendingFactValue(type: ItineraryFactType): string {
  return ({
    'opening-hours': '具体开放时段待核验',
    'ticket-price': '具体票价待核验',
    booking: '预约规则待核验',
    closure: '闭馆安排待核验',
    weather: '天气信息待核验',
    'transport-time': '路线耗时待核验',
    accessibility: '无障碍条件待核验',
    sunset: '日出日落时间待核验',
    'photography-rules': '拍摄规定待核验',
    other: '具体信息待核验'
  })[type]
}

/** 组合来源元数据和保存的短正文，供地点匹配与事实校验共用。 */
export function sourceEvidenceText(source: SourceRecord): string {
  return [source.title, source.summary, source.factEvidenceExcerpt, source.location?.label]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')
}

/** 天气来源必须包含同一日期的结构化日落时刻。 */
export function sourceSupportsStructuredSunsetDate(source: SourceRecord, date: string): boolean {
  return structuredSunsetTimeForDate(source, date) !== undefined
}

/** 读取天气服务针对某日返回的日落时刻。 */
export function structuredSunsetTimeForDate(source: SourceRecord, date: string): string | undefined {
  if (source.kind !== 'weather' || !['success', 'partial'].includes(source.status) ||
    source.contentLevel !== 'structured' || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return undefined
  const row = source.summary.split(/\r?\n/u).map((line) => line.trim())
    .find((line) => line.startsWith(`${date}：`) || line.startsWith(`${date}:`))
  return row?.match(/日落\s*((?:[01]?\d|2[0-3]):[0-5]\d)/u)?.[1]
}

/** 搜索摘要只能发现原文；事实依据须来自正文、用户资料或匹配类型的结构化结果。 */
export function sourceCanSupportFact(type: ItineraryFactType, source: SourceRecord, scope = ''): boolean {
  const level = source.contentLevel ?? legacySourceContentLevel(source)
  if (source.sourceNature === 'community-platform' && type !== 'other') return false
  switch (type) {
    case 'opening-hours':
    case 'ticket-price':
    case 'booking':
    case 'closure':
      return ['web', 'user', 'plugin'].includes(source.kind) &&
        ['page', 'user-provided', 'plugin'].includes(level) && source.status === 'success'
    case 'weather':
      return ['web', 'weather', 'user', 'plugin'].includes(source.kind) &&
        ['page', 'structured', 'user-provided', 'plugin'].includes(level) && source.status === 'success'
    case 'transport-time':
      return source.kind === 'route' && level === 'structured' && source.status === 'success'
    case 'accessibility':
      return ['web', 'user', 'plugin'].includes(source.kind) &&
        ['page', 'user-provided', 'plugin'].includes(level) && source.status === 'success'
    case 'sunset':
      if (source.kind === 'weather') return sourceSupportsStructuredSunsetDate(source, scope)
      return ['web', 'user', 'plugin'].includes(source.kind) &&
        ['page', 'user-provided', 'plugin'].includes(level) && source.status === 'success'
    case 'photography-rules':
      return ['web', 'user', 'plugin'].includes(source.kind) &&
        ['page', 'user-provided', 'plugin'].includes(level) && source.status === 'success'
    case 'other':
      return ['page', 'structured', 'user-provided', 'plugin'].includes(level) && source.status === 'success'
  }
}

/** 景点事实必须匹配当前停靠点的原始正文，日落天气事实除外。 */
export function requiresVenueFactText(type: ItineraryFactType, source: SourceRecord): boolean {
  if (type === 'sunset' && source.kind === 'weather') return false
  return ['opening-hours', 'ticket-price', 'booking', 'closure', 'accessibility', 'sunset', 'photography-rules', 'other']
    .includes(type)
}

/** 正文或来源标题直接提到当前停靠点时才可绑定地点事实。 */
export function sourceDirectlyNamesStop(source: SourceRecord, stopName: string): boolean {
  return itinerarySourceNamesPlace(sourceEvidenceText(source), stopName)
}

/** 地点名和事实值须出现在同句，或属于明确标记的该场馆小节。 */
export function sourceDirectlySupportsStopFact(
  type: ItineraryFactType,
  source: SourceRecord,
  stopName: string,
  value: string,
  otherStopNames: string[] = [],
  scope = ''
): boolean {
  const title = [source.title, source.location?.label].filter(Boolean).join(' ')
  const body = [source.summary, source.factEvidenceExcerpt].filter(Boolean).join('\n\n')
  const knownOtherPlaces = itineraryKnownPlaceNamesInText(`${title}\n${body}`)
  const samePlace = (name: string): boolean => name === stopName ||
    itinerarySourceNamesPlace(name, stopName) && itinerarySourceNamesPlace(stopName, name)
  const distinctOtherStops = [...new Set([...otherStopNames, ...knownOtherPlaces].map((name) => name.trim()).filter((name) =>
    name && !samePlace(name)
  ))]
  const titleNamesTarget = itinerarySourceNamesPlace(title, stopName)
  const titleNamesOtherStop = distinctOtherStops.some((name) => itinerarySourceNamesPlace(title, name))
  const supportsFact = (evidenceText: string): boolean =>
    factValueSupportedInText(type, evidenceText, value, scope, title)
  // 标题若把多个行程地点并列，只能依靠正文中的地点句或对应小节定位事实。
  let withinStopSection = titleNamesTarget && !titleNamesOtherStop
  let factSectionHeading = ''
  for (const rawLine of body.split(/\n+/u)) {
    const line = rawLine.trim()
    if (!line) continue
    const heading = line.match(/^#{1,6}\s+(.+)$/u)?.[1]?.trim()
    if (heading) {
      const headingNamesTarget = itinerarySourceNamesPlace(heading, stopName)
      const headingNamesOtherStop = distinctOtherStops.some((name) => itinerarySourceNamesPlace(heading, name))
      if (headingNamesTarget && !headingNamesOtherStop) {
        withinStopSection = true
        factSectionHeading = heading
        if (supportsFact(heading)) return true
      } else if (headingNamesOtherStop) {
        withinStopSection = false
        factSectionHeading = ''
      } else if (isGenericItineraryFactHeading(heading)) {
        if (withinStopSection) factSectionHeading = heading
      } else if (!titleNamesTarget || titleNamesOtherStop) {
        // 来源标题不能确定地点时，普通章节会结束上一地点的上下文。
        withinStopSection = false
        factSectionHeading = ''
      }
      continue
    }

    // 与事实候选提取保持相同分句边界，支持同一长句中的独立中文逗号子句。
    const lineNamesOtherStop = distinctOtherStops.some((name) => itinerarySourceNamesPlace(line, name))
    if (withinStopSection && !lineNamesOtherStop &&
        supportsFact(`${factSectionHeading}\n${line}`)) return true
    for (const segment of line.split(/(?<=[。！？；;，,])\s*/u)
      .map((item) => item.trim().replace(/[。！？；;，,]+$/u, '').trim()).filter(Boolean)) {
      const segmentNamesTarget = itinerarySourceNamesPlace(segment, stopName)
      const segmentNamesOtherStop = distinctOtherStops.some((name) => itinerarySourceNamesPlace(segment, name))
      if (segmentNamesTarget && segmentNamesOtherStop) {
        // 同一句同时指向多个地点时，无法确定数值归属。
        withinStopSection = false
        factSectionHeading = ''
        continue
      }
      if (segmentNamesTarget) {
        withinStopSection = true
        factSectionHeading = ''
      } else if (segmentNamesOtherStop) {
        withinStopSection = false
        factSectionHeading = ''
      }
      if (segmentNamesTarget && supportsFact(segment)) return true
      if (withinStopSection && !segmentNamesOtherStop &&
          supportsFact(`${factSectionHeading}\n${segment}`)) return true
    }
  }
  return false
}

/** 开放、价格、预约和闭馆等动态事实不以模型估算值替代。 */
export function requiresDirectFactEvidence(type: ItineraryFactType): boolean {
  return ['opening-hours', 'ticket-price', 'booking', 'closure', 'accessibility', 'sunset', 'photography-rules'].includes(type)
}

/** 只允许通用事实标题延续当前场馆小节，避免跨地点读取。 */
function isGenericItineraryFactHeading(heading: string): boolean {
  const factHeading = /开放时间|开放时段|营业时间|停止入园|停止入场|停止入馆|停止售票|停止检票|闭馆|闭园|预约须知|预约|购票|售票|门票|票价|票务|票种|参观须知|游览须知|入园须知|游客须知|交通|游览路线/u.exec(heading)
  if (!factHeading) return false
  const prefix = heading.slice(0, factHeading.index).trim()
  return /^(?:旺季|淡季|冬季|夏季|园中园|园区|景区|公园|入园|入馆|游客|参观|预约|门票|官方|日常)?$/u.test(prefix)
}

/** 检查事实值是否出现在同一证据文字中；兼容时间范围和明确票价格式。 */
function factValueSupportedInText(
  type: ItineraryFactType,
  evidenceText: string,
  value: string,
  scope = '',
  sourceTitle = ''
): boolean {
  const sourceText = normalizeFactEvidenceText(evidenceText)
  const normalizedValue = normalizeFactEvidenceText(value)
  if (!normalizedValue || /待核验|待确认|未知/u.test(normalizedValue)) return false
  if (type === 'opening-hours' &&
      !openingHoursScopeSupportsDate(evidenceText, value, scope, sourceTitle)) return false
  if (type === 'booking') return sourceText.includes(normalizedValue) && hasExplicitBookingRule(value)
  if (sourceText.includes(normalizedValue)) return true

  if (type === 'opening-hours') {
    const claimedTimes = clockTimes(value)
    const sourceTimes = new Set(clockTimes(evidenceText))
    return claimedTimes.length > 0 && claimedTimes.every((time) => sourceTimes.has(time)) &&
      /开放|营业|开馆|闭馆|闭园|停止入馆|停止入场|停止入园/u.test(evidenceText)
  }
  if (type === 'ticket-price') {
    const claimedAmounts = moneyAmounts(value)
    const sourceAmounts = new Set(moneyAmounts(evidenceText))
    const freeClaim = /免费|免票|不收费/u.test(value)
    return (freeClaim && /免费|免票|不收费/u.test(evidenceText)) ||
      (claimedAmounts.length > 0 && claimedAmounts.every((amount) => sourceAmounts.has(amount) &&
        /门票|票价|票务|收费|售价|成人票|票/u.test(evidenceText)))
  }
  return false
}

/** 季节、星期或节假日时段只有在原文能映射到具体日期时才支持日期范围。 */
function openingHoursScopeSupportsDate(
  evidenceText: string,
  value: string,
  scope: string,
  sourceTitle: string
): boolean {
  const match = scope.match(/^(\d{4})-(\d{2})-(\d{2})$/u)
  if (!match) return true
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  const parsedDate = new Date(Date.UTC(date.year, date.month - 1, date.day))
  if (parsedDate.getUTCFullYear() !== date.year || parsedDate.getUTCMonth() + 1 !== date.month ||
      parsedDate.getUTCDate() !== date.day) return false

  const context = `${sourceTitle}\n${evidenceText}\n${value}`
  const mentionsCalendarDate = /(?:\d{4}年\s*\d{1,2}月\s*\d{1,2}日?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/u.test(context)
  const conditionalSchedule = mentionsCalendarDate ||
    /旺季|淡季|春季|夏季|秋季|冬季|暑期|寒假|节假日|春节|国庆|工作日|周末|周[一二三四五六日天]|\d{1,2}月(?:\d{1,2}日)?/u.test(context)
  if (!conditionalSchedule) return true
  // 日期或季节映射必须出现在支持事实值的正文上下文中，不能从来源标题推断。
  const supportingText = `${evidenceText}\n${value}`
  return containsExplicitDate(supportingText, date) || containsDateRange(supportingText, date)
}

/** 日期写明年份时只匹配同一年，避免把旧公告套用到其他年份。 */
function containsExplicitDate(
  text: string,
  date: { year: number; month: number; day: number }
): boolean {
  const year = String(date.year)
  const month = String(date.month).padStart(2, '0')
  const day = String(date.day).padStart(2, '0')
  return new RegExp(`(?:${year}年\\s*0?${date.month}月\\s*0?${date.day}日?|${year}[-/.]${month}[-/.]${day})(?!\\d)`, 'u').test(text)
}

/** 检查正文中的明确月日区间是否覆盖指定日期，支持跨年季节。 */
function containsDateRange(
  text: string,
  date: { year: number; month: number; day: number }
): boolean {
  const numericDateRange = /(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\s*(?:至|到|[-—–~～])\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/gu
  for (const range of text.matchAll(numericDateRange)) {
    const start = parseNumericDate(range[1]!)
    const end = parseNumericDate(range[2]!)
    if (!start || !end) continue
    const targetOrdinal = date.year * 10_000 + date.month * 100 + date.day
    const startOrdinal = start.year * 10_000 + start.month * 100 + start.day
    const endOrdinal = end.year * 10_000 + end.month * 100 + end.day
    if (startOrdinal <= targetOrdinal && targetOrdinal <= endOrdinal) return true
  }

  const fullDateRange = /((?:(\d{4})年)?(\d{1,2})月(\d{1,2})日?)\s*(?:至|到|[-—–~～])\s*((?:(\d{4})年)?(\d{1,2})月(\d{1,2})日?)/gu
  for (const range of text.matchAll(fullDateRange)) {
    const startMonth = Number(range[3])
    const startDay = Number(range[4])
    const endMonth = Number(range[7])
    const endDay = Number(range[8])
    if (!validMonthDay(startMonth, startDay) || !validMonthDay(endMonth, endDay)) continue
    const startYear = range[2] ? Number(range[2]) : range[6] ? Number(range[6]) : undefined
    const endYear = range[6] ? Number(range[6]) : startYear
    if (startYear !== undefined && endYear !== undefined) {
      const targetOrdinal = date.year * 10_000 + date.month * 100 + date.day
      const startOrdinal = startYear * 10_000 + startMonth * 100 + startDay
      const endOrdinal = endYear * 10_000 + endMonth * 100 + endDay
      if (startOrdinal <= targetOrdinal && targetOrdinal <= endOrdinal) return true
    } else if (monthDayRangeContains(startMonth, startDay, endMonth, endDay, date.month, date.day)) {
      return true
    }
  }

  const monthRange = /((?:(\d{4})年)?(\d{1,2})月)\s*(?:至|到|[-—–~～])\s*((?:(\d{4})年)?(\d{1,2})月)/gu
  for (const range of text.matchAll(monthRange)) {
    const startMonth = Number(range[3])
    const endMonth = Number(range[6])
    if (startMonth < 1 || startMonth > 12 || endMonth < 1 || endMonth > 12) continue
    const lastDay = new Date(Date.UTC(date.year, endMonth, 0)).getUTCDate()
    const startYear = range[2] ? Number(range[2]) : range[5] ? Number(range[5]) : undefined
    const endYear = range[5] ? Number(range[5]) : startYear
    if (startYear !== undefined && endYear !== undefined) {
      const targetOrdinal = date.year * 10_000 + date.month * 100 + date.day
      const startOrdinal = startYear * 10_000 + startMonth * 100 + 1
      const endOrdinal = endYear * 10_000 + endMonth * 100 + lastDay
      if (startOrdinal <= targetOrdinal && targetOrdinal <= endOrdinal) return true
    } else if (monthDayRangeContains(startMonth, 1, endMonth, lastDay, date.month, date.day)) {
      return true
    }
  }
  return false
}

/** 解析 ISO、斜线或点分隔的完整日期。 */
function parseNumericDate(value: string): { year: number; month: number; day: number } | undefined {
  const match = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u)
  if (!match) return undefined
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
  const parsed = new Date(Date.UTC(date.year, date.month - 1, date.day))
  return parsed.getUTCFullYear() === date.year && parsed.getUTCMonth() + 1 === date.month &&
    parsed.getUTCDate() === date.day ? date : undefined
}

/** 对比月日区间并正确处理跨年开放季。 */
function monthDayRangeContains(
  startMonth: number,
  startDay: number,
  endMonth: number,
  endDay: number,
  month: number,
  day: number
): boolean {
  const start = startMonth * 100 + startDay
  const end = endMonth * 100 + endDay
  const target = month * 100 + day
  return start <= end ? start <= target && target <= end : target >= start || target <= end
}

/** 拒绝不可能的月份/日期，避免区间比较接受无效日历文本。 */
function validMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(2024, month, 0)).getUTCDate()
}

/** 统一正文与模型时间范围的空格、全半角和连接号差异。 */
function normalizeFactEvidenceText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase()
    .replace(/((?:[01]?\d|2[0-3]):[0-5]\d)\s*[-–—~～至到]\s*((?:[01]?\d|2[0-3]):[0-5]\d)/gu, '$1至$2')
    .replace(/[\p{P}\p{S}\s]/gu, '')
}

/** 抽取规范化钟点；“8:30”和“08:30”按同一时刻处理。 */
function clockTimes(value: string): string[] {
  return [...value.matchAll(/(?<!\d)((?:[01]?\d|2[0-3])):([0-5]\d)(?!\d)/gu)]
    .map((match) => `${match[1]!.padStart(2, '0')}:${match[2]}`)
}

/** 仅把明确带货币单位的数字当作票价。 */
function moneyAmounts(value: string): string[] {
  return [...value.normalize('NFKC').matchAll(/(?:¥|￥)\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*元/gu)]
    .map((match) => Number(match[1] ?? match[2]).toFixed(2).replace(/\.00$/u, ''))
}
