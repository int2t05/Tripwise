/** 为餐次修订统一判断可用窗口，避免反馈与写入规则分叉。 */
import type { ItineraryDay, ItineraryMealSlot } from '../../shared/types.js'

export type MealSlot = ItineraryMealSlot

/** 为新增餐次寻找不与已知停留或时间块重叠的 45 分钟窗口。 */
export function findOpenMealStart(day: ItineraryDay, slot: MealSlot): number | undefined {
  const candidates = slot === 'breakfast' ? [420, 450, 480, 510, 540]
    : slot === 'lunch' ? [660, 690, 720, 750, 780, 810, 840]
      : [1_020, 1_050, 1_080, 1_110, 1_140, 1_170, 1_200]
  const occupied = [
    ...day.stops.map((stop) => ({ time: stop.time, duration: stop.durationMinutes })),
    ...day.scheduleBlocks.filter((block) => block.kind !== 'buffer')
      .map((block) => ({ time: block.time, duration: block.durationMinutes }))
  ].flatMap(({ time, duration }) => {
    const start = firstClockMinute(time)
    if (start === undefined) return []
    const end = secondClockMinute(time)
    return [{ start, end: start + Math.max(duration ?? 60, end !== undefined && end > start ? end - start : 0) }]
  })
  return candidates.find((start) => occupied.every((item) => start + 45 <= item.start || start >= item.end))
}

/** 从时间文本中读取首个时刻，用于排序和餐次窗口判断。 */
export function firstClockMinute(value: string): number | undefined {
  const match = value.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/u)
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined
}

/** 读取显式时间范围的结束时刻，用于避免窗口覆盖既有行程。 */
function secondClockMinute(value: string): number | undefined {
  const matches = [...value.matchAll(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu)]
  const match = matches[1]
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined
}
