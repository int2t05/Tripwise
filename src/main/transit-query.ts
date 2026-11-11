/** 为无路线 API 的旅行预检生成少暴露个人信息的公共交通搜索词。 */
import type { TripBrief } from '../shared/types.js'

const PLACE_TOKEN = '[\\p{Script=Han}A-Za-z0-9·]{2,24}'

/** 用目的地机场和返程车站组合接驳查询，不把精确住宿或出发住址发给搜索服务。 */
export function buildTransitResearchQuery(brief: TripBrief): string {
  const destination = brief.destination.trim().slice(0, 40)
  const arrivalAirport = arrivalAirportForBrief(brief) ?? `${destination}机场`
  const departureStation = departureStationForBrief(brief)
  const destinationStation = departureStation ?? `${destination}火车站`
  return `${destination} ${arrivalAirport}至${destinationStation} 公共交通 地铁 接驳 换乘线路`
    .replace(/\s+/gu, ' ').trim().slice(0, 180)
}

/** 从飞行、落地或到达表达中提取与目的地匹配的机场。 */
function arrivalAirportForBrief(brief: TripBrief): string | undefined {
  const text = `${brief.arrivalFlight}\n${brief.constraints}`
  const destination = normalizePlace(brief.destination)
  const directedTargets = [...text.matchAll(new RegExp(`(飞往|飞至|飞|抵达|到达|落地(?:于)?|到|至)\\s*(${PLACE_TOKEN})`, 'gu'))]
    .map((match) => ({ verb: match[1] ?? '', place: normalizeAirportCandidate(match[2] ?? '') }))
    .filter((item) => item.place.length > 0)
  const matchesDestination = (place: string): boolean => {
    const normalized = normalizePlace(place.replace(/机场$/u, ''))
    return !!destination && (normalized.includes(destination) || destination.includes(normalized))
  }

  const directedTarget = directedTargets.find((item) => matchesDestination(item.place))
  if (directedTarget) return ensureAirportSuffix(directedTarget.place)

  const flightAirport = extractAirportMentions(brief.arrivalFlight).find(matchesDestination)
  if (flightAirport) return ensureAirportSuffix(flightAirport)

  const destinationAirport = extractAirportMentions(text).find(matchesDestination)
  if (destinationAirport) return ensureAirportSuffix(destinationAirport)

  const flightTarget = directedTargets.find((item) => item.verb.startsWith('飞'))
  return flightTarget ? ensureAirportSuffix(flightTarget.place) : undefined
}

/** 从离开时刻后的文本读取车站，兼容“从北京西站出发”和“20:23北京西到广州”。 */
function departureStationForBrief(brief: TripBrief): string | undefined {
  const leaveTime = brief.leaveTime.trim()
  const leaveIndex = leaveTime ? brief.constraints.indexOf(leaveTime) : -1
  if (leaveIndex < 0) return undefined
  const afterTime = brief.constraints.slice(leaveIndex + leaveTime.length, leaveIndex + leaveTime.length + 48)
  const station = afterTime.match(/(?:从\s*)?([\p{Script=Han}A-Za-z·]{2,16}?)(?:站)?\s*(?:出发|乘车|开车|发车|到|至)/u)?.[1]
    ?? afterTime.match(/([\p{Script=Han}A-Za-z·]{2,16}站)/u)?.[1]
  if (!station) return undefined
  return station.endsWith('站') ? station : `${station}站`
}

/** 清除机场名称前的方向词、时刻和随后动作文字。 */
function normalizeAirportCandidate(value: string): string {
  const withoutDirection = value.trim().replace(/^(?:从|由|往|向|到|至|抵达|到达|飞往|飞至|落地(?:于)?)/u, '')
  const airportName = withoutDirection.match(/^[\p{Script=Han}A-Za-z0-9·]{2,22}机场/u)?.[0]
  if (airportName) return airportName
  return withoutDirection.replace(/\d.*$/u, '').replace(/(?:入住|住宿|抵达|落地|出发|起飞|乘机|航班).*$/u, '').trim()
}

/** 只抽取带有明确机场后缀的地点，避免把城区和车站当机场。 */
function extractAirportMentions(value: string): string[] {
  return [...value.matchAll(/[\p{Script=Han}A-Za-z0-9·]{2,22}机场/gu)]
    .map((match) => normalizeAirportCandidate(match[0]))
    .filter(Boolean)
}

/** 统一空白和行政区后缀，供目的地与机场名称比较。 */
function normalizePlace(value: string): string {
  return value.toLocaleLowerCase().replace(/(?:市|省|自治区|特别行政区)$/u, '').replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 为目的地机场简称补全“机场”，保留原文已明确写出的机场名。 */
function ensureAirportSuffix(value: string): string {
  const normalized = value.trim()
  return /机场$/u.test(normalized) ? normalized : `${normalized}机场`
}
