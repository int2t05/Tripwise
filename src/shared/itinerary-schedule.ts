/** 校验每日顺序、时间冲突、抵离缓冲和有来源的开放事实。 */
import type { ItineraryDay, ItineraryFactClaim, ItineraryMealRequirement, ItineraryMealSlot, ItineraryScheduleBlock, ItineraryScheduleBlockKind, ItineraryStop, RouteMode, TripBrief } from './types.js'
import { groupItineraryFacts, normalizeFactValue, type ItineraryFactGroup } from './itinerary-facts.js'

const ROUTE_PLANNING_BUFFER_MINUTES: Record<RouteMode, number> = {
  transit: 10,
  walking: 5,
  driving: 10
}

export interface ScheduleFinding {
  code: 'stop-overlap' | 'schedule-overlap' | 'route-buffer' | 'before-arrival' | 'after-departure' | 'arrival-transfer' | 'departure-transfer' | 'time-order' | 'opening-hours' | 'closure' | 'closure-scope' | 'meal-requirement'
  message: string
  itemIds: string[]
  /** 路线时间窗的机器可读诊断值；界面文案变化不影响下游日志。 */
  routeTiming?: {
    routeDurationMinutes: number
    availableWindowMinutes: number
    bufferMinutes: number
    requiredWindowMinutes: number
    shortfallMinutes: number
  }
}

export type ItineraryDayScheduleEntry =
  | { kind: 'stop'; stop: ItineraryStop }
  | { kind: 'block'; block: ItineraryScheduleBlock }

/** 为路线服务估时预留简短机动时间，覆盖候车、进出站与步行接驳波动。 */
export function routePlanningBufferMinutes(mode: RouteMode): number {
  return ROUTE_PLANNING_BUFFER_MINUTES[mode]
}

/** 只按精确时刻插入非地点时段，保持地点路线顺序并把模糊时段留在末尾。 */
export function orderItineraryDaySchedule(day: Pick<ItineraryDay, 'stops' | 'scheduleBlocks'>): ItineraryDayScheduleEntry[] {
  const entries: ItineraryDayScheduleEntry[] = day.stops.map((stop) => ({ kind: 'stop', stop }))
  const exactBlocks = day.scheduleBlocks
    .map((block, index) => ({ block, index, minutes: clockMinutes(block.time) }))
    .filter((item): item is { block: ItineraryScheduleBlock; index: number; minutes: number } => item.minutes !== null)
    .sort((left, right) => left.minutes - right.minutes || left.index - right.index)
  const unspecifiedBlocks = day.scheduleBlocks.filter((block) => clockMinutes(block.time) === null)

  for (const { block, minutes } of exactBlocks) {
    const nextTimedEntry = entries.findIndex((entry) => {
      const time = entry.kind === 'stop' ? entry.stop.time : entry.block.time
      const entryMinutes = clockMinutes(time)
      return entryMinutes !== null && entryMinutes > minutes
    })
    const blockEntry: ItineraryDayScheduleEntry = { kind: 'block', block }
    entries.splice(nextTimedEntry === -1 ? entries.length : nextTimedEntry, 0, blockEntry)
  }

  return [...entries, ...unspecifiedBlocks.map((block) => ({ kind: 'block' as const, block }))]
}

/** 用明确时刻和已知时长检查地点及非地点时段；缺少数据时不猜测可行性。 */
export function analyzeDaySchedule(
  day: ItineraryDay,
  anchors: Pick<TripBrief, 'startDate' | 'endDate' | 'arrivalFlight' | 'arrivalTime' | 'leaveTime'>,
  availableSourceIds?: ReadonlySet<string>
): ScheduleFinding[] {
  const findings: ScheduleFinding[] = []
  for (let index = 1; index < day.stops.length; index++) {
    const previous = day.stops[index - 1]
    const current = day.stops[index]
    const previousStart = clockMinutes(previous.time)
    const currentStart = clockMinutes(current.time)
    if (previousStart === null || currentStart === null) continue
    if (currentStart < previousStart) {
      findings.push({
        code: 'time-order',
        message: `“${current.name}”计划时间早于上一站“${previous.name}”，请检查地点顺序或时段。`,
        itemIds: [previous.id, current.id]
      })
      continue
    }
    const previousDuration = scheduledDuration(previous.time, previous.durationMinutes)
    if (previousDuration === null) continue
    const previousEnd = previousStart + previousDuration
    if (previousEnd > currentStart) continue
    const routeEstimate = previous.transitEstimate
    const routeMinutes = routeEstimate?.durationMinutes
    if (routeEstimate && routeMinutes !== null && routeMinutes !== undefined && Number.isFinite(routeMinutes) && routeMinutes > 0) {
      const bufferMinutes = routePlanningBufferMinutes(routeEstimate.mode)
      const availableWindowMinutes = currentStart - previousEnd
      const requiredWindowMinutes = routeMinutes + bufferMinutes
      if (requiredWindowMinutes > availableWindowMinutes) {
        const shortfallMinutes = requiredWindowMinutes - availableWindowMinutes
        findings.push({
          code: 'route-buffer',
          message: `“${previous.name}”停留后还需约 ${routeMinutes} 分钟通勤，另留 ${bufferMinutes} 分钟${routeEstimate.mode === 'transit' ? '公共交通' : routeEstimate.mode === 'walking' ? '步行' : '驾车'}机动余量，早于“${current.name}”只留了 ${availableWindowMinutes} 分钟。`,
          itemIds: [previous.id, current.id],
          routeTiming: {
            routeDurationMinutes: routeMinutes,
            availableWindowMinutes,
            bufferMinutes,
            requiredWindowMinutes,
            shortfallMinutes
          }
        })
      }
    }
  }

  const timedItems = [
    ...day.stops.map((stop) => ({
      id: stop.id, title: stop.name, time: stop.time, duration: stop.durationMinutes,
      type: 'stop' as const, category: stop.category, area: stop.area, notes: stop.notes,
      subactivity: /餐|用餐|美食/u.test(`${stop.category} ${stop.name}`) ? 'meal' as const
        : /休息/u.test(`${stop.category} ${stop.name}`) ? 'rest' as const : null,
      constraintMarker: isConstraintMarker(stop),
      attraction: isScheduleAttraction(stop)
    })),
    // 机动块代表可调整的余量，不是占用活动；它可以覆盖抵达或通勤缓冲。
    ...(day.scheduleBlocks ?? []).filter((block) => block.kind !== 'buffer')
      .map((block) => ({
        id: block.id, title: block.title, time: block.time, duration: block.durationMinutes,
        type: 'block' as const, category: block.kind, area: block.area, notes: block.notes,
        subactivity: block.kind === 'meal' || block.kind === 'rest' ? block.kind : null,
        constraintMarker: false, attraction: false
      }))
  ].flatMap((item) => {
    const start = clockMinutes(item.time)
    const duration = scheduledDuration(item.time, item.duration)
    return start === null ? [] : [{ ...item, duration, start }]
  })
  for (let leftIndex = 0; leftIndex < timedItems.length; leftIndex++) {
    const left = timedItems[leftIndex]
    for (const right of timedItems.slice(leftIndex + 1)) {
      const sameStart = left.start === right.start
      const earlier = left.start < right.start ? left : right
      const later = earlier === left ? right : left
      const overlaps = !left.constraintMarker && !right.constraintMarker && (sameStart
        ? Math.max(left.duration ?? 0, right.duration ?? 0) > 0
        : earlier.duration !== null && earlier.duration > 0 && earlier.start + earlier.duration > later.start)
      if (!overlaps) continue
      // 同一场馆内的用餐是参观过程的一部分，不应被当成两个地点同时占用。
      if (isNestedSubactivity(left, right)) continue
      const placeOnly = left.type === 'stop' && right.type === 'stop'
      const leftTime = left.duration === null ? left.time : `${formatClock(left.start)}–${formatClock(left.start + left.duration)}`
      const rightTime = right.duration === null ? right.time : `${formatClock(right.start)}–${formatClock(right.start + right.duration)}`
      findings.push({
        code: placeOnly ? 'stop-overlap' : 'schedule-overlap',
        message: `“${left.title}”(${leftTime})与“${right.title}”(${rightTime})时间重叠，请调整安排。`,
        itemIds: [left.id, right.id]
      })
    }
  }

  for (const stop of day.stops) {
    findings.push(...findClosureFindings(stop, day.date, availableSourceIds))
    const openingFinding = findOpeningHoursConflict(stop, day.date, availableSourceIds)
    if (openingFinding) findings.push(openingFinding)
  }

  const firstDestinationStop = day.stops.find((stop) =>
    !isOriginSideStop(stop, anchors.arrivalFlight) && !isArrivalTransitStop(stop, anchors.arrivalTime))
  const firstTimedStop = day.stops.find((stop) =>
    !isOriginSideStop(stop, anchors.arrivalFlight) && !isArrivalTransitStop(stop, anchors.arrivalTime) &&
    !isPostArrivalLodgingMarker(stop, anchors.arrivalTime) && clockMinutes(stop.time) !== null
  )
  const arrivalAnchorExists = anchors.arrivalFlight.trim() || day.stops.some((stop) =>
    isArrivalTransitStop(stop, anchors.arrivalTime))
  if (firstTimedStop && day.date && day.date === anchors.startDate && anchors.arrivalTime) {
    const arrival = clockMinutes(anchors.arrivalTime)
    const firstStart = clockMinutes(firstTimedStop.time)
    if (arrival !== null && firstStart !== null && firstStart <= arrival) {
      findings.push({
        code: 'before-arrival',
        message: `当天首个活动地点“${firstTimedStop.name}”计划 ${firstTimedStop.time} 开始，不晚于抵达时间 ${anchors.arrivalTime}；请核对日期和接驳安排。${arrivalAnchorExists ? '抵达后离站、取行李（如适用）和前往首站的时间也未计入。' : ''}`,
        itemIds: [firstTimedStop.id]
      })
    }
  }

  // 抵达航班或车次只提供旅程锚点，不代表离站及到首站的接驳时间已纳入日程。
  if (firstDestinationStop && day.date && day.date === anchors.startDate && arrivalAnchorExists) {
    const arrivalConflict = findings.find((finding) => finding.code === 'before-arrival')
    if (!arrivalConflict) {
      findings.push({
        code: 'arrival-transfer',
        message: `抵达后离站、取行李（如适用）并前往首站“${firstDestinationStop.name}”的接驳时间尚待核对；请按实际路线预留缓冲。`,
        itemIds: [firstDestinationStop.id]
      })
    }
  }

  const lastStop = day.stops.at(-1)
  if (lastStop && day.date && day.date === anchors.endDate && anchors.leaveTime) {
    const departure = clockMinutes(anchors.leaveTime)
    const departureAnchor = isDepartureTerminalAnchor(lastStop, anchors.leaveTime) ? lastStop : undefined
    const lastActivity = departureAnchor ? day.stops.at(-2) : lastStop
    const lastStart = lastActivity ? clockMinutes(lastActivity.time) : null
    if (departure !== null && lastActivity && lastStart !== null) {
      const lastEnd = lastStart + (scheduledDuration(lastActivity.time, lastActivity.durationMinutes) ?? 0)
      if (lastEnd >= departure) {
        findings.push({
          code: 'after-departure',
          message: `末站“${lastActivity.name}”计划在 ${formatClock(lastEnd)} 结束，不早于离开时间 ${anchors.leaveTime}；请调整行程。${departureAnchor ? `前往“${departureAnchor.name}”的接驳和进站手续也未计入。` : '前往机场或车站的接驳和办理手续（值机或安检）时间也未计入。'}`,
          itemIds: [lastActivity.id, ...(departureAnchor ? [departureAnchor.id] : [])]
        })
      }
    }

    // 车站或机场的离开锚点不是游览活动；只提示核对前往该处的接驳与手续缓冲。
    if (!findings.some((finding) => finding.code === 'after-departure')) {
      findings.push({
        code: 'departure-transfer',
        message: departureAnchor
          ? `已列出“${departureAnchor.name}” ${anchors.leaveTime} 离开；前往该处的接驳和${/机场/u.test(departureAnchor.name) ? '值机、安检' : '进站、安检'}缓冲尚未核验。`
          : `末站“${lastStop.name}”之后尚未计入前往机场或车站的接驳和办理手续（值机或安检）时间；请按实际离开方式核对行程留白。`,
        itemIds: departureAnchor
          ? [...(lastActivity ? [lastActivity.id] : []), departureAnchor.id]
          : [lastStop.id]
      })
    }
  }
  return findings
}

/** 校验随行程保存的逐日餐次约束，供修订、预览与保存共用。 */
export function analyzeMealRequirements(
  days: ItineraryDay[],
  requirements: ItineraryMealRequirement[] = []
): Array<ScheduleFinding & { date: string; dayNumber: number }> {
  const slotLabels: Record<ItineraryMealSlot, string> = {
    breakfast: '早餐', lunch: '午餐', dinner: '晚餐'
  }
  const findings: Array<ScheduleFinding & { date: string; dayNumber: number }> = []
  for (const requirement of requirements) {
    const day = days.find((candidate) => candidate.date === requirement.date)
    if (!day) continue
    const items: Array<{ id: string; slot: ItineraryMealSlot; time: string }> = [
      ...day.stops.filter((stop) => /餐/u.test(stop.category)).flatMap((stop) => {
        const slot = mealSlotForStop(stop)
        return slot ? [{ id: stop.id, slot, time: stop.time }] : []
      }),
      ...day.scheduleBlocks.filter((block) => block.kind === 'meal').flatMap((block) => {
        const slot = mealSlotForBlock(block)
        return slot ? [{ id: block.id, slot, time: block.time }] : []
      })
    ]
    const counts = new Map<ItineraryMealSlot, number>()
    for (const item of items) counts.set(item.slot, (counts.get(item.slot) ?? 0) + 1)
    const issues: string[] = []
    const missing = requirement.slots.filter((slot) => !counts.has(slot))
    if (missing.length) issues.push(`缺少用户要求的${missing.map((slot) => slotLabels[slot]).join('、')}`)
    const excluded = (requirement.excludedSlots ?? []).filter((slot) => counts.has(slot))
    if (excluded.length) issues.push(`安排了用户明确取消的${excluded.map((slot) => slotLabels[slot]).join('、')}`)
    if (requirement.exclusive) {
      const additional = [...counts.keys()].filter((slot) => !requirement.slots.includes(slot))
      const repeated = requirement.slots.filter((slot) => (counts.get(slot) ?? 0) > 1)
      if (additional.length || repeated.length) {
        const labels = [...new Set([...additional, ...repeated])].map((slot) => slotLabels[slot])
        issues.push(`餐次超出用户明确限定的范围（${labels.join('、')}重复或额外安排）`)
      }
    }
    for (const [slot, requestedStarts] of Object.entries(requirement.requestedStartTimes ?? {}) as Array<[ItineraryMealSlot, string[]]>) {
      const actualStarts = new Set(items.filter((item) => item.slot === slot).flatMap((item) => {
        const start = clockMinutes(item.time)
        return start === null ? [] : [formatClock(start)]
      }))
      if (!requestedStarts.some((start) => actualStarts.has(start))) {
        issues.push(`未保留用户明确指定的餐时（${slotLabels[slot]}：${requestedStarts.join(' 或 ')}）`)
      }
    }
    if (!issues.length) continue
    findings.push({
      code: 'meal-requirement', date: day.date, dayNumber: day.dayNumber,
      message: `${day.date}：${issues.join('；')}。`, itemIds: items.map((item) => item.id)
    })
  }
  return findings
}

/** 按停靠点文字和时刻识别餐次，口径与行程候选校验保持一致。 */
export function mealSlotForStop(stop: ItineraryStop): ItineraryMealSlot | undefined {
  const label = `${stop.name} ${stop.category} ${stop.time} ${stop.notes}`
  if (/早餐|早饭|早间|早晨|早上/u.test(label)) return 'breakfast'
  if (/午餐|午饭|中午/u.test(label)) return 'lunch'
  if (/晚餐|晚饭|傍晚|晚间|晚上/u.test(label)) return 'dinner'
  const start = clockMinutes(stop.time)
  if (start === null) return undefined
  const hour = Math.floor(start / 60)
  return hour < 11 ? 'breakfast' : hour < 16 ? 'lunch' : 'dinner'
}

/** 将未标注餐名的 meal 时间块按开始时刻归入餐次。 */
export function mealSlotForBlock(block: ItineraryScheduleBlock): ItineraryMealSlot | undefined {
  const label = `${block.title} ${block.time} ${block.notes}`
  if (/早餐|早饭/u.test(label)) return 'breakfast'
  if (/午餐|午饭/u.test(label)) return 'lunch'
  if (/晚餐|晚饭/u.test(label)) return 'dinner'
  const start = clockMinutes(block.time)
  if (start === null) return undefined
  const hour = Math.floor(start / 60)
  return hour < 11 ? 'breakfast' : hour < 16 ? 'lunch' : 'dinner'
}

/** 零时长交通点和明确截止标记只表达时刻，不占用同刻开始的活动时段。 */
function isConstraintMarker(stop: ItineraryStop): boolean {
  if (stop.durationMinutes !== null) return false
  if (/(?:前|之前)(?:抵达|到达)/u.test(stop.time) || /酒店出发时刻/u.test(stop.notes)) return true
  return /交通/u.test(stop.category) && clockMinutes(stop.time) !== null && clockRange(stop.time) === null
}

/** 仅用成功来源核对闭馆；适用范围不明时提示复核，不将线索当成确定闭馆。 */
function findClosureFindings(stop: ItineraryStop, date: string, availableSourceIds?: ReadonlySet<string>): ScheduleFinding[] {
  const groups = groupItineraryFacts(stop.factClaims ?? []).filter((group) => group.type === 'closure')
  const sourcedClosureGroups = groups.filter((group) =>
    !group.conflicting && group.claims.some((claim) => hasUsableSource(claim, availableSourceIds) && isExplicitClosure(claim.value)))
  if (!sourcedClosureGroups.length) return []

  if (!date) {
    return [{
      code: 'closure-scope',
      message: `“${stop.name}”来源记录闭馆线索，但行程日期未确定；确定日期后请核对来源是否适用。`,
      itemIds: [stop.id]
    }]
  }

  const applicableGroups = sourcedClosureGroups.filter((group) => closureGroupAppliesOnDate(group, date))
  if (applicableGroups.length) {
    const claims = applicableGroups.flatMap((group) => group.claims)
      .filter((claim) => hasUsableSource(claim, availableSourceIds) && isExplicitClosure(claim.value))
    const values = new Set(claims.map((claim) => normalizeFactValue(claim.value)))
    if (values.size !== 1) return []

    const closureText = claims[0].value
    const weeklyRule = !applicableGroups.some((group) => hasExplicitDateScope(group))
    return [{
      code: 'closure',
      message: weeklyRule
        ? `“${stop.name}”计划日期 ${date} 为${weekdayLabel(date)}；来源记录“${closureText}”，请核对节假日或临时开放安排。`
        : `“${stop.name}”计划日期 ${date} 与来源中的闭馆日期相符（“${closureText}”）；请核对来源是否仍有效。`,
      itemIds: [stop.id]
    }]
  }

  const unscopedGroups = sourcedClosureGroups.filter((group) => !hasClosureDateApplicability(group))
  if (!unscopedGroups.length) return []
  const closureText = unscopedGroups.flatMap((group) => group.claims)
    .find((claim) => hasUsableSource(claim, availableSourceIds) && isExplicitClosure(claim.value))?.value
  if (!closureText) return []
  return [{
    code: 'closure-scope',
    message: `“${stop.name}”来源记录“${closureText}”，但未明确适用日期或周休规则；请核实是否影响 ${date}。`,
    itemIds: [stop.id]
  }]
}

/** 判断闭馆事实是否带有可用于日历匹配的日期，避免把文章发布时间误当适用范围。 */
function hasExplicitDateScope(group: ItineraryFactGroup): boolean {
  return /\d{4}-\d{2}-\d{2}/.test([group.scope, ...group.claims.map((claim) => claim.value)].join(' '))
}

/** 区分可判断的日期/周休声明和只有模糊时间范围的闭馆线索。 */
function hasClosureDateApplicability(group: ItineraryFactGroup): boolean {
  const text = [group.scope, ...group.claims.map((claim) => claim.value)].join(' ')
  return /\d{4}-\d{2}-\d{2}/.test(text) || /(?:(?:每\s*)?(?:周|星期)\s*[一二三四五六日天]\s*(?:全天\s*)?(?:闭馆|闭园|休馆|休息|不开放|不营业|停止开放|暂停开放|关闭))/.test(text)
}

/** 判断来源是否明确把闭馆日期或每周闭馆日关联到该日。 */
function closureGroupAppliesOnDate(group: ItineraryFactGroup, date: string): boolean {
  const text = [group.scope, ...group.claims.map((claim) => claim.value)].join(' ')
  const scopedDates = [...text.matchAll(/\d{4}-\d{2}-\d{2}/g)].map(([value]) => value)
  if (scopedDates.length) return scopedDates.includes(date)

  const weekday = weekdayLabel(date)
  const weeklyClosures = [...text.matchAll(/(?:(?:每\s*)?(?:周|星期)\s*([一二三四五六日天])\s*(?:全天\s*)?(?:闭馆|闭园|休馆|休息|不开放|不营业|停止开放|暂停开放|关闭))/g)]
  return weeklyClosures.some(([, day]) => `周${day === '天' ? '日' : day}` === weekday)
}

/** 仅将肯定的场馆关闭语句当成闭馆，排除“未闭馆”等否定表述。 */
function isExplicitClosure(value: string): boolean {
  const closurePattern = /闭馆|闭园|休馆|休息|不开放|不营业|停止开放|暂停开放|关闭|停业/
  const negatedClosurePattern = /(?:并非|并未|并没有|并无|没有|未|没|不|无|非)\s*(?:临时|暂时)?(?:闭馆|闭园|休馆|休息|不开放|不营业|停止开放|暂停开放|关闭|停业)/
  return closurePattern.test(value) && !negatedClosurePattern.test(value)
}

/** 用 UTC 中午解析日历日期，避免本机时区导致星期偏移。 */
function weekdayIndex(date: string): number {
  const parsedDate = new Date(`${date}T12:00:00.000Z`)
  return Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date
    ? Number.NaN
    : parsedDate.getUTCDay()
}

/** 将星期序号格式化为简体中文标签。 */
function weekdayLabel(date: string): string {
  const weekday = weekdayIndex(date)
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday] ?? ''
}

/** 只按来源明确写出的日期或周规则检查开放时段，不推测节假日例外。 */
function findOpeningHoursConflict(stop: ItineraryStop, date: string, availableSourceIds?: ReadonlySet<string>): ScheduleFinding | null {
  if (!Number.isInteger(weekdayIndex(date))) return null

  const groups = groupItineraryFacts(stop.factClaims ?? []).filter((group) => group.type === 'opening-hours')
  const datedGroups = groups.filter((group) => /\d{4}-\d{2}-\d{2}/.test(group.scope))
  const applicableDatedGroups = datedGroups.filter((group) =>
    [...group.scope.matchAll(/\d{4}-\d{2}-\d{2}/g)].some(([scopedDate]) => scopedDate === date)
  )
  const applicableGroups = applicableDatedGroups.length
    ? applicableDatedGroups
    : groups.filter((group) => !datedGroups.includes(group) && openingHoursScopeAppliesOnDate(group.scope, date))
  if (!applicableGroups.length) return null

  const sourcedClaims = applicableGroups.flatMap((group) => group.claims)
    .filter((claim) => hasUsableSource(claim, availableSourceIds))
  if (!sourcedClaims.length) return null

  const values = new Set(sourcedClaims.map((claim) => normalizeFactValue(claim.value)))
  if (values.size > 1) {
    const conflictDetails = [...new Set(sourcedClaims.map((claim) =>
      `「${claim.scope || '适用范围未注明'}」${claim.value}`
    ))].join('；')
    return {
      code: 'opening-hours',
      message: `“${stop.name}”计划日期 ${date}，适用来源记录了不同的开放时段（${conflictDetails}）；请核对各来源，系统未从中选择一个。`,
      itemIds: [stop.id]
    }
  }

  const intervals = parseOpeningIntervals(sourcedClaims[0].value)
  const plannedStart = clockMinutes(stop.time)
  if (!intervals || plannedStart === null) return null

  const duration = scheduledDuration(stop.time, stop.durationMinutes)
  const plannedEnd = duration === null ? null : plannedStart + duration
  const fitsOpeningPeriod = intervals.some((interval) =>
    plannedStart >= interval.start && plannedStart < interval.end && (plannedEnd === null || plannedEnd <= interval.end)
  )
  if (!fitsOpeningPeriod) {
    const visitTime = plannedEnd === null
      ? `${stop.time} 开始（停留时长未提供）`
      : `${stop.time}–${formatClock(plannedEnd)}`
    const openingPeriods = intervals.map((interval) => `${formatClock(interval.start)}–${formatClock(interval.end)}`).join('、')
    const scheduleScope = applicableGroups.map((group) => group.scope.trim()).filter(Boolean).join('；')
    const applicability = applicableDatedGroups.length
      ? `来源记录 ${date} 的开放时段为 ${openingPeriods}`
      : `来源标注“${scheduleScope}”适用于${weekdayLabel(date)}，常规开放时段为 ${openingPeriods}`
    return {
      code: 'opening-hours',
      message: `“${stop.name}”计划 ${visitTime}，${applicability}；请核实节假日或临时安排及预约规则。`,
      itemIds: [stop.id]
    }
  }
  return null
}

/** 只识别来源明确声明的每日规则、星期和连续星期范围。 */
function openingHoursScopeAppliesOnDate(scope: string, date: string): boolean {
  const weekday = weekdayIndex(date)
  if (!Number.isInteger(weekday)) return false

  const normalizedScope = scope.replace(/\s+/g, '')
  if (/(?:每日|每天)(?=$|[0-9:，,；;、~–—-]|开放|营业|时间|时段|规则|均|无休)/.test(normalizedScope)) return true

  const indices: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
  const applicableWeekdays = new Set<number>()
  const ranges = /(?:每)?(?:周|星期)([一二三四五六日天])(?:到|至|[-–—~])(?:周|星期)?([一二三四五六日天])/g

  for (const [, firstDay, lastDay] of normalizedScope.matchAll(ranges)) {
    const first = indices[firstDay]
    const last = indices[lastDay]
    if (first === undefined || last === undefined) continue
    let current = first
    for (let count = 0; count < 7; count += 1) {
      applicableWeekdays.add(current)
      if (current === last) break
      current = (current + 1) % 7
    }
  }

  const days = /(?:每)?(?:周|星期)([一二三四五六日天])/g
  for (const [, day] of normalizedScope.matchAll(days)) {
    const index = indices[day]
    if (index !== undefined) applicableWeekdays.add(index)
  }

  return applicableWeekdays.has(weekday)
}

/** 在界面提供来源状态时，只使用当前仍成功的来源事实；测试与纯计算调用可省略此筛选。 */
function hasUsableSource(claim: ItineraryFactClaim, availableSourceIds?: ReadonlySet<string>): boolean {
  return claim.evidenceLevel === 'sourced' && !!claim.sourceId &&
    (availableSourceIds === undefined || availableSourceIds.has(claim.sourceId))
}

/** 解析最多四段明确开放时段；闭馆说明、入场限制、重叠或过夜时段不作自动判断。 */
function parseOpeningIntervals(value: string): Array<{ start: number; end: number }> | null {
  if (/闭馆|闭园|休馆|午休|不开放|不营业|暂停|停止|关闭|最后(?:入馆|入园|入场|售票)|截止入场|停止入场|停止售票/.test(value)) return null
  const ranges = [...value.matchAll(/(\d{1,2}):([0-5]\d)\s*(?:-|–|—|−|~|至|到)\s*(\d{1,2}):([0-5]\d)/g)]
  if (ranges.length === 0 || ranges.length > 4) return null
  const intervals: Array<{ start: number; end: number }> = []
  for (const [, startHour, startMinute, endHour, endMinute] of ranges) {
    const start = Number(startHour) * 60 + Number(startMinute)
    const end = Number(endHour) * 60 + Number(endMinute)
    if (Number(startHour) > 23 || Number(endHour) > 23 || start >= end) return null
    intervals.push({ start, end })
  }
  intervals.sort((left, right) => left.start - right.start)
  if (intervals.some((interval, index) => index > 0 && interval.start < intervals[index - 1].end)) return null
  return intervals
}

/** 把结构化的每日休息安排转成稳定可读的类型标签。 */
export function scheduleBlockKindLabel(kind: ItineraryScheduleBlockKind): string {
  return ({ meal: '用餐', rest: '休息', buffer: '机动' })[kind]
}

/** 只解析精确 24 小时制时间；“上午”等描述不用于自动判断。 */
function clockMinutes(value: string): number | null {
  const normalized = value.normalize('NFKC')
  const range = clockRange(normalized)
  if (range) return range.start
  const match = normalized.match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/u)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

/** 从明确时段或停留时长计算占用时间；两者不一致时采用较长区间。 */
function scheduledDuration(time: string, duration: number | null): number | null {
  const interval = clockRange(time)
  const rangeDuration = interval ? interval.end - interval.start : 0
  const stopDuration = duration !== null && Number.isFinite(duration) && duration > 0 ? duration : 0
  const effectiveDuration = Math.max(rangeDuration, stopDuration)
  return effectiveDuration > 0 ? effectiveDuration : null
}

/** 返回精确起止时段对应的分钟数；只有单个时刻或模糊文字时返回 null。 */
export function scheduleRangeDurationMinutes(time: string): number | null {
  const interval = clockRange(time)
  return interval ? interval.end - interval.start : null
}

/** 把起始时刻与计划停留时长合并为清楚的建议时段，方便快速浏览行程。 */
export function plannedStopTimeLabel(time: string, durationMinutes: number | null): string {
  const normalized = time.normalize('NFKC').trim()
  if (!normalized || clockRange(normalized) || durationMinutes === null ||
      !Number.isInteger(durationMinutes) || durationMinutes <= 0 || durationMinutes > 720) return time

  const match = normalized.match(/(?:^|[^\d])((?:[01]?\d|2[0-3]):[0-5]\d)(?!\d)/u)
  if (!match || match.index === undefined) return time
  const [hour, minute] = match[1].split(':').map(Number)
  const start = hour * 60 + minute
  const end = start + durationMinutes
  if (end > 24 * 60) return time

  const timeStart = match.index + match[0].lastIndexOf(match[1])
  const timeEnd = timeStart + match[1].length
  const prefix = normalized.slice(0, timeStart).trim()
  const suffix = normalized.slice(timeEnd).trim()
  return [prefix, `${formatClock(start)}–${formatClock(end)}`, suffix].filter(Boolean).join(' ')
}

/** 解析明确写出的同日时段，不把单个时刻或模糊描述当成结束时间。 */
function clockRange(value: string): { start: number; end: number } | null {
  const match = value.normalize('NFKC').match(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)\s*[-–—~～至到]\s*([01]?\d|2[0-3]):([0-5]\d)(?!\d)/u)
  if (!match) return null
  const start = Number(match[1]) * 60 + Number(match[2])
  const end = Number(match[3]) * 60 + Number(match[4])
  return end > start ? { start, end } : null
}

/** 抵达日从出发地机场开始时，不用目的地落地时间判定首站过早。 */
function isOriginDepartureStop(stop: ItineraryStop, arrivalFlight: string): boolean {
  const text = `${stop.name} ${stop.time} ${stop.notes}`
  const compactName = stop.name.replace(/\s+/gu, '')
  const airportRoute = /机场(?:飞|→|->|至|到)/u.test(compactName)
  const airportProcess = /机场/u.test(text) && /值机|候机|登机|起飞|出发机场/u.test(text)
  const railProcess = /车站|火车站/u.test(text) && /进站|候车|检票|开车|出发站/u.test(text)
  const terminalDeadline = /交通/u.test(stop.category) && /机场|车站|火车站/u.test(text) && /(?:前抵达|前到达|前到|最迟)/u.test(stop.time)
  const flightDepartureTime = flightDepartureClockLabel(arrivalFlight)
  const isFlightDepartureTime = !!flightDepartureTime && /交通|航班/u.test(stop.category) &&
    containsExplicitClock(stop.time, flightDepartureTime)
  return airportProcess || railProcess || terminalDeadline ||
    (/交通/u.test(stop.category) && /机场|车站|火车站|航班|飞机|动车|高铁/u.test(text) &&
      (/出发|起飞|开车/u.test(text) || airportRoute)) || isFlightDepartureTime
}

/** 起飞前结束的出发城市交通不受目的地落地时刻约束。 */
function isOriginSideStop(stop: ItineraryStop, arrivalFlight: string): boolean {
  if (isOriginDepartureStop(stop, arrivalFlight)) return true
  const departureTime = flightDepartureClockLabel(arrivalFlight)
  const departureMinutes = departureTime ? clockMinutes(departureTime) : null
  const start = clockMinutes(stop.time)
  if (departureMinutes === null || start === null) return false
  const end = start + (scheduledDuration(stop.time, stop.durationMinutes) ?? 0)
  return end <= departureMinutes
}

/** 将地点类型限制在可包含馆内用餐的游览点范围。 */
function isScheduleAttraction(stop: ItineraryStop): boolean {
  return !/餐|用餐|美食|休息|购物|自由活动|交通|接驳|住宿|酒店|航班|机场|车站|火车|高铁|动车/u
    .test(`${stop.category} ${stop.name}`)
}

/** 用餐或休息只有明确属于同一场馆、且完整落在游览时段内时才视为子活动。 */
function isNestedSubactivity(
  left: { type: 'stop' | 'block'; title: string; subactivity: 'meal' | 'rest' | null; attraction: boolean; start: number; duration: number | null; area: string; notes: string },
  right: { type: 'stop' | 'block'; title: string; subactivity: 'meal' | 'rest' | null; attraction: boolean; start: number; duration: number | null; area: string; notes: string }
): boolean {
  const activity = left.subactivity ? left : right.subactivity ? right : undefined
  const visit = left.attraction ? left : right.attraction ? right : undefined
  if (!activity || !visit || visit.type !== 'stop' || visit.duration === null || activity.duration === null) return false
  if (activity.start < visit.start || activity.start + activity.duration > visit.start + visit.duration) return false
  const normalizePlace = (value: string): string => value.normalize('NFKC')
    .replace(/(?:内部|馆内|园内|院内|景区内|场馆内|校内|内部|园区内|内)$/u, '')
    .replace(/[\s\p{P}\p{S}]/gu, '')
  const area = normalizePlace(activity.area)
  const visitArea = normalizePlace(visit.area)
  const visitName = normalizePlace(visit.title)
  const preciseArea = area.length >= 2 && (
    (area === visitArea && !/(?:市|区|县|省)$/u.test(area)) || area === visitName
  )
  const locationText = `${activity.title} ${activity.area} ${activity.notes}`
  const normalizedLocationText = normalizePlace(locationText)
  const specificVisitArea = visitArea.length >= 2 && !/(?:市|区|县|省)$/u.test(visitArea)
  const namesTheVisitVenue = (visitName.length >= 2 && normalizedLocationText.includes(visitName)) ||
    (specificVisitArea && normalizedLocationText.includes(visitArea))
  const insideNotes = activity.subactivity === 'meal'
    ? /(?:馆内|园内|院内|景区内|场馆内|校内|园区内|内部|里面)/u.test(locationText)
    : /(?:馆|园|院|景区|场馆|校区|园区)内(?:休息|歇息)?|内部(?:休息|歇息)|里面(?:休息|歇息)/u.test(locationText)
  return preciseArea || (namesTheVisitVenue && insideNotes)
}

/** 从航班说明中提取起飞时刻，优先匹配显式起飞/出发文字。 */
function flightDepartureClockLabel(value: string): string | undefined {
  const matches = [...value.matchAll(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu)]
  const departure = matches.find((match) => {
    const start = match.index ?? 0
    return /(?:起飞|出发|登机|乘机|飞往|飞至)/u.test(value.slice(start + match[0].length, start + match[0].length + 40))
  }) ?? matches[0]
  if (!departure) return undefined
  return `${String(Number(departure[1])).padStart(2, '0')}:${departure[2]}`
}

/** 使用数字边界匹配整点时刻，支持“14:00–16:00”这类起飞区间。 */
function containsExplicitClock(value: string, expected: string): boolean {
  return new RegExp(`(?:^|[^0-9])${expected}(?![0-9])`, 'u').test(value)
}

/** 目的地机场/车站到达点是接驳锚点，不当成落地后的首个活动。 */
function isArrivalTransitStop(stop: ItineraryStop, arrivalTime: string): boolean {
  const text = `${stop.name} ${stop.time} ${stop.notes}`
  const isTerminal = /机场|车站|火车站|航班|飞机|动车|高铁/u.test(text)
  const isArrival = /抵达|到达|落地/u.test(text)
  const expectedArrival = clockMinutes(arrivalTime)
  const arrivalMoment = expectedArrival !== null && clockMinutes(stop.time) === expectedArrival &&
    clockRange(stop.time) === null && stop.durationMinutes === null
  if (!isArrival || !arrivalMoment) return false
  return /交通/u.test(stop.category) || isTerminal
}

/** “抵达时刻后入住”是时间锚点说明，不代表旅客在落地同一刻已到达住宿。 */
function isPostArrivalLodgingMarker(stop: ItineraryStop, arrivalTime: string): boolean {
  const arrivalMinutes = clockMinutes(arrivalTime)
  return /住宿/u.test(stop.category) && /后入住/u.test(stop.time) && arrivalMinutes !== null &&
    clockMinutes(stop.time) === arrivalMinutes
}

/** 返程末站在明确离开时刻对应机场、车站或码头时，按交通锚点而非游览活动检查。 */
function isDepartureTerminalAnchor(stop: ItineraryStop, leaveTime: string): boolean {
  const departureTime = departureClockLabel(leaveTime)
  if (!departureTime) return false
  const departureClock = new RegExp(`(?:^|[^\\d])${departureTime}(?!\\d)`, 'u')
  return /交通/u.test(stop.category) && /机场|站|码头/u.test(stop.name) && departureClock.test(stop.time)
}


/** 从离开说明中识别车次离站时刻，排除前往车站和次日抵达时间。 */
export function departureClockLabel(value: string): string | undefined {
  const matches = [...value.matchAll(/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/gu)]
  if (matches.length === 0) return undefined
  const ranked = matches.map((match) => {
    const index = match.index ?? 0
    const before = value.slice(Math.max(0, index - 18), index)
    const after = value.slice(index + match[0].length, index + match[0].length + 30)
    const score = (/(?:乘坐?|开车|发车|起飞|离开|离站|出发|返程)/u.test(after.slice(0, 18)) ? 5 : 0) +
      (/[A-Za-z]{1,2}\d{2,4}/u.test(after.slice(0, 24)) ? 4 : 0) +
      (/^\s*[\p{Script=Han}A-Za-z0-9·]{1,16}(?:站|机场|码头|站台)/u.test(after) ? 3 : 0) -
      (/(?:抵达|到达|落地)/u.test(after.slice(0, 18)) ? 8 : 0) -
      (/(?:次日|第二天|翌日)/u.test(before.slice(-10)) ? 8 : 0)
    return {
      time: `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`,
      index,
      score
    }
  })
  return ranked.sort((left, right) => right.score - left.score || left.index - right.index)[0]?.time
}

/** 将超出当天范围的分钟数保留为可读的相对时刻。 */
function formatClock(totalMinutes: number): string {
  const minutesInDay = 24 * 60
  const normalized = ((totalMinutes % minutesInDay) + minutesInDay) % minutesInDay
  const dayLabel = totalMinutes >= minutesInDay ? '次日 ' : ''
  return `${dayLabel}${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`
}
