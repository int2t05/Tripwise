/** 用整数分汇总有依据的旅行预算，保留待核验和未纳入类别。 */
import type { BudgetCostCategory, ItineraryBudgetEstimate, SourceRecord } from './types.js'

export const BUDGET_COST_CATEGORIES = [
  'flight', 'intercity-transport', 'lodging', 'local-transport', 'tickets', 'meals', 'other'
] as const satisfies readonly BudgetCostCategory[]

export const BUDGET_CATEGORY_LABELS: Record<BudgetCostCategory, string> = {
  flight: '航班',
  'intercity-transport': '城际交通',
  lodging: '住宿',
  'local-transport': '市内交通',
  tickets: '门票与预约',
  meals: '餐饮',
  other: '其他'
}

export interface BudgetEstimateSummary {
  totalMinFen: number
  totalMaxFen: number
  sourcedMinFen: number
  sourcedMaxFen: number
  estimatedMinFen: number
  estimatedMaxFen: number
  pricedItemCount: number
  sourcedItemCount: number
  estimatedItemCount: number
  pendingItemCount: number
  sourceReviewItemCount: number
  pendingCategories: BudgetCostCategory[]
  missingCategories: BudgetCostCategory[]
  notApplicableCategories: BudgetCostCategory[]
  complete: boolean
}

/** 只接受带明确人民币单位和预算口径的上限；模糊文本保留为不可比较。 */
export type BudgetPreference =
  | { kind: 'trip-total'; limitFen: number }
  | { kind: 'per-person'; limitFen: number; travelers: number | null }
  | { kind: 'per-day'; limitFen: number }
  | { kind: 'ambiguous'; limitFen: number }
  | { kind: 'qualitative' }
  | { kind: 'missing' }

export type BudgetComparison = {
  kind: 'within' | 'over' | 'range-overlaps' | 'recorded-over' | 'inconclusive' | 'unsupported'
  message: string
}

/** 从预算自由文本中识别明确金额，不猜测金额是总额、日额还是人均。 */
export function parseBudgetPreference(budget: string, travelers: string): BudgetPreference {
  const text = budget.trim()
  if (!text) return { kind: 'missing' }

  const matches = [...text.matchAll(/(?<![\dA-Za-z.,])(?:(?<symbol>[¥￥]|人民币|RMB|CNY)\s*(?<symbolAmount>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?<symbolFraction>\d{1,2}))?|(?<unitAmount>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?<unitFraction>\d{1,2}))?\s*(?<unit>人民币|元|块|RMB|CNY))(?![\d.])/giu)]
  if (!matches.length) return { kind: 'qualitative' }
  if (matches.length !== 1) return { kind: 'qualitative' }

  const match = matches[0]
  const groups = match.groups ?? {}
  const remainingText = `${text.slice(0, match.index)}${text.slice(match.index! + match[0].length)}`
  if (/\d/u.test(remainingText)) return { kind: 'qualitative' }
  const amount = groups.symbolAmount ?? groups.unitAmount
  const fraction = groups.symbolFraction ?? groups.unitFraction ?? ''
  if (!amount) return { kind: 'qualitative' }

  const digits = amount.replaceAll(',', '')
  const fen = BigInt(digits) * 100n + BigInt(fraction.padEnd(2, '0') || '0')
  if (fen <= 0n || fen > BigInt(Number.MAX_SAFE_INTEGER)) return { kind: 'qualitative' }

  const nearStart = Math.max(0, match.index! - 24)
  const nearEnd = Math.min(text.length, match.index! + match[0].length + 24)
  const nearby = text.slice(nearStart, nearEnd)
  const perPerson = /人均|每人|每位|\/\s*人/u.test(nearby)
  const perDay = /每天|每日|日均|\/\s*(?:天|日)/u.test(nearby)
  const tripTotal = /总预算|全程预算|整趟预算|旅行总额|总花费|总费用|预算上限|全程|整趟|整个行程|总计/u.test(nearby)
  const limitFen = Number(fen)

  if (perPerson && !perDay) return { kind: 'per-person', limitFen, travelers: parseExplicitTravelerCount(travelers) }
  if (perDay && !perPerson) return { kind: 'per-day', limitFen }
  if (tripTotal && !perPerson && !perDay) return { kind: 'trip-total', limitFen }
  return { kind: 'ambiguous', limitFen }
}

/** 只接受整段字段就是明确人数的写法，避免把成人数误当成全体人数。 */
function parseExplicitTravelerCount(value: string): number | null {
  const text = value.trim()
  if (/^(?:单人|1\s*人)$/u.test(text)) return 1
  const match = text.match(/^(\d{1,2})\s*(?:位\s*)?(?:人|成人)(?:同行)?$/u)
  if (!match) return null
  const count = Number(match[1])
  return count > 0 ? count : null
}

/** 比较完整估算或已计入小计；缺项时不把未计费用当作零。 */
export function compareBudgetPreference(
  estimate: ItineraryBudgetEstimate,
  sources: SourceRecord[],
  budget: string,
  travelers: string
): BudgetComparison {
  const preference = parseBudgetPreference(budget, travelers)
  if (preference.kind === 'missing') return { kind: 'unsupported', message: '未填写金额预算，暂不比较。' }
  if (preference.kind === 'qualitative') return { kind: 'unsupported', message: '预算金额或范围不明确，暂不自动比较。' }
  if (preference.kind === 'ambiguous') return { kind: 'unsupported', message: `已识别 ${formatBudgetFen(preference.limitFen)}，但未说明是全程、人均还是每日上限。` }
  if (preference.kind === 'per-day') return { kind: 'unsupported', message: `每日预算为 ${formatBudgetFen(preference.limitFen)}；当前估算按整段行程汇总，暂不比较。` }
  if (preference.kind === 'per-person' && preference.travelers === null) {
    return { kind: 'unsupported', message: `人均上限为 ${formatBudgetFen(preference.limitFen)}，同行总人数未明确，暂不比较。` }
  }

  const summary = summarizeBudgetEstimate(estimate, sources)
  if (!summary.pricedItemCount) return { kind: 'inconclusive', message: '尚无可计算金额，暂不能比较预算。' }

  const limitFen = preference.kind === 'per-person'
    ? BigInt(preference.limitFen) * BigInt(preference.travelers!)
    : BigInt(preference.limitFen)
  const limitLabel = preference.kind === 'per-person'
    ? `人均预算 ${formatBudgetFen(preference.limitFen)}`
    : `全程预算 ${formatBudgetFen(preference.limitFen)}`
  const range = formatBudgetRange(summary.totalMinFen, summary.totalMaxFen)
  const estimateLabel = preference.kind === 'per-person'
    ? `${range}（按 ${preference.travelers} 人平均折算 ${formatBudgetRange(
      Math.floor(summary.totalMinFen / preference.travelers!), Math.ceil(summary.totalMaxFen / preference.travelers!)
    )}/人）`
    : range
  if (summary.complete) {
    if (BigInt(summary.totalMaxFen) <= limitFen) return { kind: 'within', message: `完整估算 ${estimateLabel} 在${limitLabel}内。` }
    if (BigInt(summary.totalMinFen) > limitFen) return { kind: 'over', message: `完整估算 ${estimateLabel} 已高于${limitLabel}。` }
    return { kind: 'range-overlaps', message: `完整估算 ${estimateLabel} 跨过${limitLabel}，需按实际价格取舍。` }
  }

  const unresolved = [...new Set([...summary.pendingCategories, ...summary.missingCategories])]
  const review = summary.sourceReviewItemCount > 0 ? `另有 ${summary.sourceReviewItemCount} 项来源需复核` : ''
  const missing = unresolved.length ? `未计入${unresolved.map((category) => BUDGET_CATEGORY_LABELS[category]).join('、')}` : ''
  const caveat = [missing, review].filter(Boolean).join('；')
  if (BigInt(summary.totalMinFen) > limitFen) {
    return { kind: 'recorded-over', message: `已计入最低金额 ${estimateLabel} 高于${limitLabel}；${caveat || '估算仍不完整'}。` }
  }
  return {
    kind: 'inconclusive',
    message: `已计入小计 ${estimateLabel}，因${caveat || '估算范围不完整'}，无法确认是否符合${limitLabel}。`
  }
}

/** 按单价区间乘数量；来源缺失或待核验类别会阻止汇总被称为完整总额。 */
export function summarizeBudgetEstimate(
  estimate: ItineraryBudgetEstimate,
  sources: SourceRecord[] = []
): BudgetEstimateSummary {
  let totalMinFen = 0
  let totalMaxFen = 0
  let sourcedMinFen = 0
  let sourcedMaxFen = 0
  let estimatedMinFen = 0
  let estimatedMaxFen = 0
  let pricedItemCount = 0
  let sourcedItemCount = 0
  let estimatedItemCount = 0
  let pendingItemCount = 0
  let sourceReviewItemCount = 0
  const itemCategories = new Set<BudgetCostCategory>()
  const pendingCategories = new Set<BudgetCostCategory>()

  for (const item of estimate.items) {
    itemCategories.add(item.category)
    if (item.evidenceLevel === 'pending' || item.amountMinFen === null || item.amountMaxFen === null) {
      pendingItemCount += 1
      pendingCategories.add(item.category)
      continue
    }

    const minFen = item.amountMinFen * item.quantity
    const maxFen = item.amountMaxFen * item.quantity
    totalMinFen += minFen
    totalMaxFen += maxFen
    pricedItemCount += 1
    if (item.evidenceLevel === 'sourced') {
      sourcedMinFen += minFen
      sourcedMaxFen += maxFen
      sourcedItemCount += 1
    } else {
      estimatedMinFen += minFen
      estimatedMaxFen += maxFen
      estimatedItemCount += 1
    }
    if (item.sourceIds.some((id) => sources.find((source) => source.id === id)?.status !== 'success')) {
      sourceReviewItemCount += 1
    }
  }

  const notApplicableCategories = new Set(estimate.notApplicableCategories.map((item) => item.category))
  const missingCategories = BUDGET_COST_CATEGORIES.filter((category) =>
    !itemCategories.has(category) && !notApplicableCategories.has(category))

  return {
    totalMinFen,
    totalMaxFen,
    sourcedMinFen,
    sourcedMaxFen,
    estimatedMinFen,
    estimatedMaxFen,
    pricedItemCount,
    sourcedItemCount,
    estimatedItemCount,
    pendingItemCount,
    sourceReviewItemCount,
    pendingCategories: [...pendingCategories],
    missingCategories,
    notApplicableCategories: [...notApplicableCategories],
    complete: pricedItemCount > 0 && pendingCategories.size === 0 && missingCategories.length === 0 && sourceReviewItemCount === 0
  }
}

/** 使用人民币两位小数呈现金额，底层仍保留整数分。 */
export function formatBudgetFen(amountFen: number): string {
  return `¥${Math.floor(amountFen / 100)}.${String(amountFen % 100).padStart(2, '0')}`
}

/** 相等金额显示为单值，其他情况保留上下界。 */
export function formatBudgetRange(minFen: number, maxFen: number): string {
  return minFen === maxFen
    ? formatBudgetFen(minFen)
    : `${formatBudgetFen(minFen)}–${formatBudgetFen(maxFen)}`
}
