/** 汇总行程中的来源事实、冲突状态和证据标签。 */
import type { EvidenceLevel, ItineraryFactClaim } from './types.js'

/** 统一模型与执行端接受的事实原文长度，避免提示和工具结构互相冲突。 */
export const MAX_ITINERARY_FACT_QUOTE_CHARACTERS = 200

/** 统一网页摘录、事实提取和来源校验中的票务/票价关键词。 */
export const ITINERARY_TICKET_PRICE_TERMS = /票价|门票|票务|票种|购票|售票|收费|免费|成人票|学生票|price|admission|ticket/iu

/** 只把明确说明预约条件或办理方式的原文当作预约规则证据。 */
export function hasExplicitBookingRule(value: string): boolean {
  const text = value.normalize('NFKC').replace(/\s+/gu, '')
  const beforeReservation = /(?:需要|必须|无需|无须|不需要|不需|免|建议|可以|可|提前|现场|实名|线上|网上|需(?!知)|须(?!知))[^。！？；，,]{0,16}(?:预约|预订|购票|入场)/u
  const afterReservation = /(?:预约|预订|购票)[^。！？；，,]{0,16}(?:需要|必须|无需|无须|不需要|不需|免|实名|提前|通过|登录|访问|官网|网站|公众号|小程序|现场|线上|网上|电话|入场|名额|开放|需(?!知)|须(?!知))/u
  return beforeReservation.test(text) || afterReservation.test(text)
}

export interface ItineraryFactGroup {
  type: ItineraryFactClaim['type']
  scope: string
  claims: ItineraryFactClaim[]
  conflicting: boolean
}

const PLACE_NAME_GROUPS = [
  ['北京大学', '北大', '燕园'],
  ['清华大学', '清华', '清华园'],
  ['故宫博物院', '故宫', '紫禁城'],
  ['颐和园', '清漪园'],
  ['中国国家博物馆', '国家博物馆', '国博'],
  ['北京孔庙和国子监博物馆', '孔庙和国子监', '孔庙', '国子监'],
  ['国家体育场', '鸟巢'],
  ['国家游泳中心', '水立方'],
  ['天安门广场', '天安门地区', '天安门'],
  ['前门大街', '前门'],
  ['八达岭长城', '八达岭']
]

/** 将行程依据等级转换为稳定的中文导出文案。 */
export function itineraryEvidenceLabel(level: EvidenceLevel): string {
  return ({ sourced: '已关联来源', estimated: '规划估算', pending: '待核验' })[level]
}

/** 按事实类型和原文适用范围分组；不同成功来源给出不同值时保留并列冲突。 */
export function groupItineraryFacts(claims: ItineraryFactClaim[] | undefined): ItineraryFactGroup[] {
  const groups = new Map<string, ItineraryFactGroup>()
  for (const claim of claims ?? []) {
    const normalizedScope = claim.scope.normalize('NFKC').trim().toLocaleLowerCase()
    const key = `${claim.type}\u0000${normalizedScope}`
    const group = groups.get(key) ?? { type: claim.type, scope: claim.scope, claims: [], conflicting: false }
    group.claims.push(claim)
    const sourcedClaims = group.claims.filter((item) => item.evidenceLevel === 'sourced' && item.sourceId)
    group.conflicting = sourcedClaims.some((claim, index) => sourcedClaims.slice(index + 1).some((other) =>
      claim.sourceId !== other.sourceId && normalizeFactValue(claim.value) !== normalizeFactValue(other.value)
    ))
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** 将行程事实类别转换为可读中文标签。 */
export function itineraryFactTypeLabel(type: ItineraryFactClaim['type']): string {
  return ({
    'opening-hours': '营业时间',
    'ticket-price': '门票/价格',
    booking: '预约要求',
    closure: '闭馆/关闭',
    weather: '天气',
    'transport-time': '交通耗时',
    accessibility: '无障碍条件',
    sunset: '日出日落时间',
    'photography-rules': '拍摄规定',
    other: '其他事实'
  })[type]
}

/** 对比规范化后的事实值，容忍来源排版中的全半角与首尾空格。 */
export function normalizeFactValue(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase()
}

/** 统一地点书写并生成保守的常见正式名/简称，避免把同一景点的来源误判为无关。 */
export function itineraryPlaceNameAliases(placeName: string): string[] {
  const normalize = (value: string): string => value.normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase()
  const normalized = normalize(placeName)
  if (!normalized) return []

  const aliases = new Set([normalized])
  for (const prefix of ['中华人民共和国', '中国', '北京市', '北京', '天津市', '天津', '上海市', '上海', '重庆市', '重庆']) {
    const normalizedPrefix = normalize(prefix)
    if (normalized.startsWith(normalizedPrefix) && normalized.length - normalizedPrefix.length >= 3) {
      aliases.add(normalized.slice(normalizedPrefix.length))
    }
  }

  const suffix = /(?:风景名胜区|风景区|遗址公园|博物院|博物馆|景区|公园|遗址)$/u
  const shortened = normalized.replace(suffix, '')
  if (shortened.length >= 2) aliases.add(shortened)

  const group = PLACE_NAME_GROUPS.find((names) => names.some((name) => normalize(name) === normalized))
  group?.forEach((name) => aliases.add(normalize(name)))
  return [...aliases].filter((alias) => alias.length >= 2)
}

/** 从来源文本中找出词表明确覆盖的地点，用于阻止相邻景点事实串用。 */
export function itineraryKnownPlaceNamesInText(sourceText: string): string[] {
  const normalizedSource = sourceText.normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase()
  return [...new Set(PLACE_NAME_GROUPS.flatMap((group) => {
    const mentioned = group.some((name) => itineraryPlaceNameAliases(name)
      .some((alias) => normalizedSource.includes(alias)))
    return mentioned ? [group[0]!] : []
  }))]
}

/** 来源标题和正文中出现同一地点的常见正式名或简称时返回匹配。 */
export function itinerarySourceNamesPlace(sourceText: string, placeName: string): boolean {
  const normalizedSource = sourceText.normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase()
  return itineraryPlaceNameAliases(placeName).some((alias) => normalizedSource.includes(alias))
}
