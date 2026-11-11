/** 保留与旅行决策有关的网页段落，供模型阅读和本机事实校验共用。 */
import { ITINERARY_TICKET_PRICE_TERMS } from '../../shared/itinerary-facts.js'

/** 从网页正文中选取长度受限的旅行事实摘录，供模型和本地校验共用。 */

export const MAX_TRAVEL_EVIDENCE_EXCERPT_CHARACTERS = 2_400

const TRAVEL_FACT_TERMS = new RegExp(
  `开放时间|开放时段|开放至|营业时间|停止入园|停止售票|停止检票|闭馆|闭园|预约|${ITINERARY_TICKET_PRICE_TERMS.source}|实名|周一|周二|周末|节假日|旺季|淡季|入口|出口|交通|地铁|公交|游览路线|opening hours?|closing time|ticket|reservation|booking|entrance|visitor information`,
  'iu'
)

/** 规范化浏览器可见正文时保留段落，并把 DOM 语义标题标成可审计的小节。 */
export function normalizeVisiblePageText(text: string, headingTexts: string[] = []): string {
  const headings = new Set(headingTexts.map(normalizeVisibleLine).filter(Boolean))
  const lines = text.replace(/\r\n?/gu, '\n').split('\n').map((rawLine) => {
    const line = rawLine.replace(/[\t\f\v ]+/gu, ' ').trim()
    if (!line || /^#{1,6}\s/u.test(line)) return line
    return headings.has(normalizeVisibleLine(line)) ? `## ${line}` : line
  })
  return lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}

/** 标题匹配忽略全半角和空格差异。 */
function normalizeVisibleLine(value: string): string {
  return value.normalize('NFKC').replace(/^#{1,6}\s*/u, '').replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
}

/** 优先保留开放、预约、门票与交通段落，并带上所属标题上下文。 */
export function travelEvidenceExcerpt(markdown: string): string {
  const normalized = markdown.trim()
  if (normalized.length <= MAX_TRAVEL_EVIDENCE_EXCERPT_CHARACTERS) return normalized

  const blocks = normalized.split(/\n\s*\n/u).flatMap((block) => {
    const trimmed = block.trim()
    if (!trimmed) return []
    if (trimmed.length <= 900) return [trimmed]
    return trimmed.split(/(?<=[。！？；;])\s*|\n+/u).map((part) => part.trim()).filter(Boolean)
  })
  const scored = blocks.map((text, index) => ({ text, index, score: travelFactScore(text) }))
  const relevant = scored.filter((item) => item.score > 0)
  if (!relevant.length) return normalized.slice(0, MAX_TRAVEL_EVIDENCE_EXCERPT_CHARACTERS)

  const selected = new Map<number, { text: string; score: number }>()
  const headingStack: Array<{ index: number; text: string; level: number }> = []
  const headingsByIndex = new Map<number, Array<{ index: number; text: string; level: number }>>()
  for (const item of scored) {
    const heading = item.text.match(/^(#{1,6})\s+(.+)$/u)
    if (heading) {
      const level = heading[1]!.length
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) headingStack.pop()
      if (item.text.length <= 180) {
        const entry = { index: item.index, text: item.text, level }
        headingStack.push(entry)
      }
    }
    headingsByIndex.set(item.index, [...headingStack])
  }
  for (const item of relevant) {
    // 网页常把场馆名放在小节标题，开放时段则位于数段文字之后。
    // 保留标题层级，避免裁摘后只剩数值、失去地点归属。
    for (const heading of headingsByIndex.get(item.index) ?? []) {
      const existing = selected.get(heading.index)
      if (!existing || item.score + 8 > existing.score) {
        selected.set(heading.index, { text: heading.text, score: item.score + 8 })
      }
    }
    for (const neighborIndex of [item.index - 1, item.index, item.index + 1]) {
      const neighbor = scored[neighborIndex]
      if (!neighbor) continue
      const existing = selected.get(neighborIndex)
      if (!existing || item.score > existing.score) selected.set(neighborIndex, { text: neighbor.text, score: item.score })
    }
  }

  let remaining = MAX_TRAVEL_EVIDENCE_EXCERPT_CHARACTERS
  const chosen: Array<{ index: number; text: string; score: number }> = []
  for (const [index, item] of [...selected.entries()].sort((left, right) => right[1].score - left[1].score || left[0] - right[0])) {
    const allowance = remaining - (chosen.length ? 2 : 0)
    if (allowance <= 0) break
    const text = item.text.length <= allowance ? item.text : compactLongFactBlock(item.text, allowance)
    if (!text) continue
    chosen.push({ index, text, score: item.score })
    remaining -= text.length + (chosen.length > 1 ? 2 : 0)
  }
  return chosen.sort((left, right) => left.index - right.index).map((item) => item.text).join('\n\n')
}

/** 优先保留含具体时刻、金额或预约条件的段落。 */
function travelFactScore(text: string): number {
  let score = 0
  const openingFact = /开放时间|开放时段|开放至|营业时间|停止入园|停止售票|停止检票|闭馆|闭园|opening hours?|closing time/iu.test(text)
  const ticketFact = ITINERARY_TICKET_PRICE_TERMS.test(text)
  const bookingFact = /预约|实名|reservation|booking/iu.test(text)

  if (openingFact) {
    score += 5
    if (/(?:[01]?\d|2[0-3]):[0-5]\d/u.test(text)) score += 10
    if (/旺季|淡季|冬季|夏季|周一|周二|周末|节假日|\d{1,2}月\d{1,2}日/u.test(text)) score += 3
  }
  if (ticketFact) {
    score += 4
    if (/(?:¥|￥)\s*\d|\d+(?:\.\d{1,2})?\s*元|免费|免票|不收费/u.test(text)) score += 10
  }
  if (bookingFact) {
    score += 4
    if (/实名|提前\s*\d+\s*(?:天|日|小时)|预约(?:时间|时段|名额)|通过.{0,12}(?:官网|网站|小程序|公众号|平台).{0,12}(?:预约|购票)|每日.{0,8}(?:开放|发放|预约)/u.test(text)) {
      score += 8
    }
  }
  if (/周一|周二|周末|节假日|旺季|淡季|entrance|visitor information/iu.test(text)) score += 3
  if (/入口|出口|交通|地铁|公交|游览路线/iu.test(text)) score += 2
  return score
}

/** 单段仍很长时围绕旅行事实关键词裁短，避免只保留段首。 */
function compactLongFactBlock(text: string, maxCharacters: number): string {
  const match = TRAVEL_FACT_TERMS.exec(text)
  if (!match || maxCharacters <= 0) return ''
  const start = Math.max(0, match.index - Math.floor(maxCharacters / 3))
  return text.slice(start, Math.min(text.length, start + maxCharacters)).trim()
}
