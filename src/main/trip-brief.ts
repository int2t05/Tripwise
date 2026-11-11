/** 校验用户旅行简报，避免无效日期和任意 IPC 对象进入规划上下文。 */
import type { TripBrief } from '../shared/types.js'

const BRIEF_FIELDS: Array<keyof TripBrief> = [
  'departureCity', 'destination', 'startDate', 'endDate', 'arrivalFlight', 'arrivalTime', 'leaveTime',
  'travelers', 'budget', 'lodgingLocation', 'lodging', 'pace', 'earlyStart', 'interests', 'transport', 'dietary',
  'luggage', 'clothing', 'constraints'
]

/** 只保留白名单字符串字段，并校验日期和时刻格式。 */
export function sanitizeBrief(input: unknown): Partial<TripBrief> {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('旅行信息格式无效。')
  const record = input as Record<string, unknown>
  const brief: Partial<TripBrief> = {}
  for (const key of BRIEF_FIELDS) {
    if (!(key in record)) continue
    const value = record[key]
    if (typeof value !== 'string') throw new Error(`旅行信息“${key}”必须是文字。`)
    brief[key] = value.trim().slice(0, 1_000)
  }
  validateBriefDates(brief)
  return brief
}

/** 校验旅行日期、先后顺序和航班时间。 */
export function validateBriefDates(brief: Partial<TripBrief>): void {
  for (const key of ['startDate', 'endDate'] as const) {
    const value = brief[key]
    if (value && !isCalendarDate(value)) throw new Error('出发和返程日期需为有效的 YYYY-MM-DD 日期。')
  }
  if (brief.startDate && brief.endDate && brief.endDate < brief.startDate) {
    throw new Error('返程日期不能早于出发日期。')
  }
  for (const key of ['arrivalTime', 'leaveTime'] as const) {
    const value = brief[key]
    if (value && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('抵达和离开时间需使用 24 小时制 HH:MM。')
  }
}

/** 只接受真实存在的日历日期，不依赖浏览器日期控件的前端校验。 */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}
