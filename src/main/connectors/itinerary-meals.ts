/** 对已通过校验的行程局部补齐餐馆名称，避免重写整套日程。 */
import { randomUUID } from 'node:crypto'
import type { ItineraryOption, ItineraryScheduleBlock, ItineraryStop, SourceRecord } from '../../shared/types.js'
import { MAX_ITINERARY_STOPS_PER_DAY } from '../../shared/itinerary-limits.js'
import { lodgingCommuteBoundaryStop } from '../../shared/itinerary-route-endpoints.js'
import { findOpenMealStart, firstClockMinute, type MealSlot } from './itinerary-meal-window.js'
import { hasActionableTime, isPlaceholderRestaurantName, mealSlotForBlock, mealSlotForStop } from './itinerary.js'
import { ToolInputError, type ToolContext, type TravelTool } from './types.js'

const MEALS = ['breakfast', 'lunch', 'dinner'] as const
type MealTarget = { planNumber: number; dayNumber: number; date: string; slot: MealSlot; stop?: ItineraryStop; block?: ItineraryScheduleBlock }

export interface ItineraryMealRepairTarget {
  plan_number: number
  day_number: number
  date: string
  meal_slot: 'breakfast' | 'lunch' | 'dinner'
  current_name?: string
  area?: string
  time?: string
}

/** 让已有店名也进入来源核验；无直接出处时仍允许作为待核验建议。 */
export function itineraryMealSourceFeedback(
  options: ItineraryOption[],
  requirements: NonNullable<ToolContext['requiredMealSlots']>,
  sources: SourceRecord[],
  unchangedDates: string[] = []
): string[] {
  return findTargets(options, requirements, unchangedDates, sources)
    .filter((target) => target.stop && !isPlaceholderRestaurantName(target.stop.name))
    .map((target) => `${validMealTargetLabel(target)}：${target.stop!.name} 的店名来源待核验`)
}

/** 只在方案已有且用户要求具体店面时开放，避免初稿阶段被误用。 */
export const itineraryMealRepairTool: TravelTool = {
  definition: {
    type: 'function',
    function: {
      name: 'propose_itinerary_meals',
      description: '只修订已保存候选中缺少店名或漏排的指定餐次，不重写行程。restaurant_name 应为可搜索的实际商户品牌或门店名称；菜系、商圈和“附近餐馆”都不是店名。来源直接支持时标 sourced 并引用来源；没有直接来源时，可将有把握真实存在的商户品牌作为 pending 建议并留空 source_ids。不得推断具体分店、地址或营业信息。对每项提交方案序号、日期、餐次和名称；漏排时工具会寻找无冲突的短用餐窗口并沿用邻近片区。',
      parameters: {
        type: 'object',
        properties: {
          updates: {
            type: 'array', minItems: 1, maxItems: 60,
            items: {
              type: 'object',
              properties: {
                plan_number: { type: 'integer', minimum: 1, maximum: 3 },
                day_number: { type: 'integer', minimum: 1, maximum: 7 },
                date: { type: 'string', maxLength: 10, description: '日期已确认时填写，否则省略' },
                meal_slot: { type: 'string', enum: MEALS },
                restaurant_name: { type: 'string', minLength: 2, maxLength: 120, description: '来源不足时可用有把握真实存在的商户品牌作为待核验建议；不要推断分店、地址或营业情况。' },
                area: { type: 'string', maxLength: 120 },
                evidence_level: { type: 'string', enum: ['sourced', 'pending'], description: '只有来源直接支持店名时使用 sourced；无直接来源的建议用 pending，并留空 source_ids。' },
                source_ids: { type: 'array', maxItems: 5, items: { type: 'string' } },
                notes: { type: 'string', maxLength: 300 }
              },
              required: ['plan_number', 'day_number', 'meal_slot', 'restaurant_name', 'evidence_level'],
              additionalProperties: false
            }
          }
        },
        required: ['updates'],
        additionalProperties: false
      }
    }
  },
  provider: 'Tripwise 餐饮修订',
  kind: 'web',
  sourceUrl: '',
  isAvailable: (context) => !!context.requireNamedMealStops && !!context.itineraryOptions?.length &&
    findTargets(context.itineraryOptions, context.requiredMealSlots ?? [], context.unchangedItineraryDates ?? [], context.availableSources).length > 0,
  /** 只更新明确缺店的餐次，并清除因地点变化而失效的坐标和通勤事实。 */
  async execute(args, context) {
    const options = context.itineraryOptions
    if (!options?.length || !context.requireNamedMealStops) {
      throw new ToolInputError('当前没有可修订的具体店面候选。', 'meal_candidates_unavailable', 'warning')
    }
    const targets = findTargets(
      options, context.requiredMealSlots ?? [], context.unchangedItineraryDates ?? [], context.availableSources ?? []
    )
    if (!targets.length) throw new ToolInputError('当前候选没有待补店名的指定餐次。', 'meal_targets_unavailable', 'warning')
    if (!Array.isArray(args.updates) || args.updates.length < 1 || args.updates.length > targets.length) {
      throw new ToolInputError(`本轮可修订 ${targets.length} 个餐次；请提交其中至少一项且不要重复提交。`)
    }

    const targetByKey = new Map(targets.map((target) => [targetKey(target), target]))
    const seen = new Set<string>()
    const patches: MealPatch[] = []
    const rejected: string[] = []
    let rejectedSeverity: 'error' | 'warning' = 'warning'
    let updated = structuredClone(options)
    for (const raw of args.updates as unknown[]) {
      try {
        const patch = normalizePatch(raw, context, targetByKey, seen)
        const candidate = structuredClone(updated)
        applyPatch(candidate, patch, context)
        updated = candidate
        patches.push(patch)
        seen.add(targetKey(patch))
      } catch (error) {
        const reason = error instanceof ToolInputError ? error.message : '本地餐次校验未通过。'
        if (error instanceof ToolInputError && error.severity === 'error') rejectedSeverity = 'error'
        rejected.push(`${rejectedMealTargetLabel(raw)}：${reason}`)
      }
    }
    const reservedMealCount = reserveMissingMealBlocks(
      updated, context.requiredMealSlots ?? [], context.unchangedItineraryDates ?? []
    )
    if (!patches.length && reservedMealCount === 0) {
      throw new ToolInputError(
        rejected[0] ?? '本批没有可用的餐次修订。',
        rejectedSeverity === 'error' ? 'invalid_meal_update' : 'meal_update_not_applied',
        rejectedSeverity
      )
    }
    const rejectionSummary = rejected.length
      ? `另有 ${rejected.length} 项未采纳。`
      : ''
    const downgradedCount = patches.filter((patch) => patch.evidenceDowngraded).length
    const evidenceSummary = downgradedCount ? `其中 ${downgradedCount} 项因来源不足按待核验建议保留。` : ''
    const reservationSummary = reservedMealCount
      ? `另为 ${reservedMealCount} 个无法安全插入地点的明确餐次保留了待协调时间块。`
      : ''
    return {
      output: `${patches.length ? `已修订 ${patches.length}/${targets.length} 个待补餐次。` : ''}${reservationSummary}${evidenceSummary}${rejectionSummary}分店、地址和营业信息仍按来源状态核验。`,
      sources: [],
      feedback: [
        ...(rejected.length ? [{
          severity: 'warning' as const,
          code: 'meal_updates_rejected',
          message: rejected.slice(0, 3).join('；')
        }] : []),
        ...(downgradedCount ? [{
          severity: 'warning' as const,
          code: 'meal_evidence_pending',
          message: `${downgradedCount} 个餐馆建议缺少直接店名来源，保留为待核验。`
        }] : []),
        ...(reservedMealCount ? [{
          severity: 'warning' as const,
          code: 'meal_time_reserved',
          message: `${reservedMealCount} 个餐次仅保留了待协调时段，没有插入地点。`
        }] : [])
      ],
      itineraryOptions: updated
    }
  }
}

/** 为失败项提供可重试的安全定位，不把模型提交的店名或备注回显到工具错误。 */
function rejectedMealTargetLabel(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '目标信息无效的餐次'
  const value = raw as Record<string, unknown>
  const plan = typeof value.plan_number === 'number' && Number.isInteger(value.plan_number) && value.plan_number > 0
    ? `方案${value.plan_number}` : '方案序号无效'
  const day = typeof value.day_number === 'number' && Number.isInteger(value.day_number) && value.day_number > 0
    ? `第${value.day_number}天` : '日期序号无效'
  const slots: Record<MealSlot, string> = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' }
  const slot = typeof value.meal_slot === 'string' && MEALS.includes(value.meal_slot as MealSlot)
    ? slots[value.meal_slot as MealSlot] : '餐次无效'
  const date = typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value.date)
    ? `（${value.date}）` : ''
  return `${plan}${day}${date}${slot}`
}

/** 将有效目标转为模型可直接复制的编号提示。 */
function validMealTargetLabel(target: MealTarget): string {
  const labels: Record<MealSlot, string> = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' }
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(target.date) ? `（${target.date}）` : ''
  return `方案${target.planNumber}第${target.dayNumber}天${date}${labels[target.slot]}`
}

/** 为局部修订提示生成最小目标清单，让模型直接使用方案、日序、日期和餐次编号。 */
export function itineraryMealRepairTargets(
  options: ItineraryOption[],
  requirements: NonNullable<ToolContext['requiredMealSlots']>,
  unchangedDates: string[] = [],
  sources?: SourceRecord[]
): ItineraryMealRepairTarget[] {
  return findTargets(options, requirements, unchangedDates, sources).flatMap((target) => {
    const day = options[target.planNumber - 1]?.days.find((candidate) => candidate.dayNumber === target.dayNumber)
    if (!day) return []
    const plannedStart = firstClockMinute(target.stop?.time ?? target.block?.time ?? '') ?? findOpenMealStart(day, target.slot)
    return [{
      plan_number: target.planNumber,
      day_number: target.dayNumber,
      date: target.date,
      meal_slot: target.slot,
      ...(target.stop && !isPlaceholderRestaurantName(target.stop.name) ? { current_name: target.stop.name } : {}),
      ...(target.stop?.area || target.block?.area || (plannedStart !== undefined ? closestArea(day, plannedStart) : '')
        ? { area: target.stop?.area || target.block?.area || (plannedStart !== undefined ? closestArea(day, plannedStart) : '') }
        : {}),
      ...(target.stop?.time || target.block?.time
        ? { time: target.stop?.time ?? target.block?.time }
        : plannedStart !== undefined
          ? { time: `${formatPlanningTime(plannedStart)}–${formatPlanningTime(plannedStart + 45)}` }
          : {})
    }]
  })
}

/** 把补出具体店名与完成来源核验分开计进度，避免来源待核验掩盖名称修复。 */
export function itineraryMealRepairMadeProgress(
  previous: readonly ItineraryMealRepairTarget[],
  remaining: readonly ItineraryMealRepairTarget[]
): boolean {
  const remainingByKey = new Map(remaining.map((target) => [mealRepairTargetKey(target), target]))
  return previous.some((target) => {
    const updatedTarget = remainingByKey.get(mealRepairTargetKey(target))
    if (!updatedTarget) return true

    const wasMissingName = !target.current_name || isPlaceholderRestaurantName(target.current_name)
    const nowHasName = !!updatedTarget.current_name && !isPlaceholderRestaurantName(updatedTarget.current_name)
    return wasMissingName && nowHasName
  })
}

/** 用计划、日期、日序和餐次识别同一个待修订项。 */
function mealRepairTargetKey(target: ItineraryMealRepairTarget): string {
  return `${target.plan_number}|${target.date}|${target.day_number}|${target.meal_slot}`
}

interface MealPatch extends MealTarget {
  restaurantName: string
  area: string
  evidenceLevel: 'sourced' | 'pending'
  evidenceDowngraded: boolean
  sourceIds: string[]
  notes: string
}

/** 找出明确餐次中没有可识别门店的地点或时间块。 */
function findTargets(
  options: ItineraryOption[],
  requirements: NonNullable<ToolContext['requiredMealSlots']>,
  unchangedDates: string[] = [],
  availableSources?: SourceRecord[]
): MealTarget[] {
  const targets: MealTarget[] = []
  const preservedDates = new Set(unchangedDates)
  options.forEach((option, optionIndex) => {
    const requested = requirements.length
      ? requirements.flatMap((requirement) => requirement.slots.map((slot) => ({ date: requirement.date, slot })))
      : option.days.flatMap((day) => {
        const slots = new Set<MealSlot>()
        day.stops.forEach((stop) => {
          const slot = /餐/u.test(stop.category) ? mealSlotForStop(stop) : undefined
          if (slot) slots.add(slot)
        })
        day.scheduleBlocks.forEach((block) => {
          const slot = block.kind === 'meal' ? mealSlotForBlock(block) : undefined
          if (slot) slots.add(slot)
        })
        return [...slots].map((slot) => ({ date: day.date, slot }))
      })

    for (const { date, slot } of requested) {
      if (preservedDates.has(date)) continue
      const day = option.days.find((candidate) => candidate.date === date)
      if (!day) continue
      const stops = day.stops.filter((stop) => /餐/u.test(stop.category) && mealSlotForStop(stop) === slot)
      const namedStop = stops.find((stop) => !isPlaceholderRestaurantName(stop.name))
      if (namedStop) {
        // 初稿中的具名餐馆也需尝试绑定直接提及店名的来源；没有来源时不阻断草案。
        if (!availableSources || hasLinkedNameEvidence(namedStop, availableSources)) continue
        targets.push({ planNumber: optionIndex + 1, dayNumber: day.dayNumber, date, slot, stop: namedStop })
        continue
      }
      const stop = stops.find((candidate) => isPlaceholderRestaurantName(candidate.name))
      const block = stop ? undefined : day.scheduleBlocks.find((candidate) => candidate.kind === 'meal' && mealSlotForBlock(candidate) === slot)
      const untimedTarget = stop ?? block
      if (untimedTarget && !hasActionableTime(untimedTarget.time, untimedTarget.durationMinutes) &&
        findOpenMealStart(day, slot) === undefined) continue
      targets.push({ planNumber: optionIndex + 1, dayNumber: day.dayNumber, date, slot, ...(stop ? { stop } : {}), ...(block ? { block } : {}) })
    }
  })
  return targets
}

/** 只有停靠点已绑定且正文直接出现店名，来源才能关闭这项建议级核验缺口。 */
function hasLinkedNameEvidence(stop: ItineraryStop, sources: SourceRecord[]): boolean {
  const sourceIds = new Set(stop.sourceIds ?? [])
  return sources.some((source) => sourceIds.has(source.id) &&
    sourceDirectlyNamesRestaurant(stop.name, source))
}

/** 判断可用网页是否直接提到餐馆名，不据此推断分店、地址或营业状态。 */
export function sourceDirectlyNamesRestaurant(name: string, source: SourceRecord): boolean {
  return (source.status === 'success' || source.status === 'partial') && supportsName(name, source)
}

/** 餐馆无法安全插入时保留用户明确要求的餐次，不虚构店名或冲突时刻。 */
function reserveMissingMealBlocks(
  options: ItineraryOption[],
  requirements: NonNullable<ToolContext['requiredMealSlots']>,
  unchangedDates: string[]
): number {
  const protectedDates = new Set(unchangedDates)
  let reservedCount = 0
  for (const option of options) {
    for (const requirement of requirements) {
      if (protectedDates.has(requirement.date)) continue
      const day = option.days.find((candidate) => candidate.date === requirement.date)
      if (!day) continue
      for (const slot of requirement.slots) {
        const existsAsStop = day.stops.some((stop) =>
          /餐/u.test(stop.category) && mealSlotForStop(stop) === slot
        )
        const existingBlock = day.scheduleBlocks.find((block) =>
          block.kind === 'meal' && mealSlotForBlock(block) === slot
        )
        if (existsAsStop || existingBlock) continue
        if (day.scheduleBlocks.length >= 8) {
          throw new ToolInputError(`${requirement.date} 的${slotLabel(slot)}无法插入时间块；请先合并非必需的休息或机动时段。`)
        }

        const start = findOpenMealStart(day, slot)
        const typicalStart = slot === 'breakfast' ? 450 : slot === 'lunch' ? 720 : 1_080
        day.scheduleBlocks.push({
          id: randomUUID(),
          kind: 'meal',
          title: `${slotLabel(slot)}（具体店面待核验）`,
          time: start === undefined ? '' : `${formatPlanningTime(start)}–${formatPlanningTime(start + 45)}`,
          durationMinutes: start === undefined ? null : 45,
          area: closestArea(day, start ?? typicalStart),
          notes: start === undefined
            ? '用户明确要求此餐次；当前已知日程没有可确认的空档，时段和店面待协调，可继续修改。'
            : '用户明确要求此餐次；时段是无冲突的规划窗口，具体店面待核验，可继续修改。'
        })
        reservedCount += 1
      }
    }
  }
  return reservedCount
}

/** 校验模型只更新待修订餐次，并要求来源 ID 确实支持餐馆名称。 */
function normalizePatch(
  raw: unknown,
  context: ToolContext,
  targets: Map<string, MealTarget>,
  seen: Set<string>
): MealPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolInputError('餐次修订必须是对象。')
  const value = raw as Record<string, unknown>
  const planNumber = positiveInteger(value.plan_number, '方案序号', 3)
  const dayNumber = positiveInteger(value.day_number, '行程日序号', 7)
  const date = optionalString(value, 'date', 10)
  const slot = mealSlot(value.meal_slot)
  const key = `${planNumber}|${dayNumber}|${slot}`
  const target = targets.get(key)
  if (!target) {
    const matchingDateTargets = date === undefined ? [] : [...targets.values()]
      .filter((candidate) => candidate.date === date && candidate.slot === slot)
      .slice(0, 3)
    const correction = matchingDateTargets.length
      ? `可用目标：${matchingDateTargets.map(validMealTargetLabel).join('；')}。`
      : '请从本轮目标清单复制方案序号、行程日序号、日期和餐次。'
    throw new ToolInputError(`餐次目标无效或无需修订。${correction}`, 'meal_target_mismatch', 'warning')
  }
  if (date !== undefined && date !== target.date) {
    throw new ToolInputError(
      `${validMealTargetLabel(target)} 的日期应为 ${target.date || '未确认日期'}，请按目标清单修正。`,
      'meal_date_mismatch', 'warning'
    )
  }
  if (seen.has(key)) throw new ToolInputError('同一餐次不能重复提交修订。')

  const restaurantName = requiredString(value, 'restaurant_name', 2, 120)
  if (isPlaceholderRestaurantName(restaurantName)) {
    throw new ToolInputError('请提交可识别的餐馆名称，不要使用菜系、商圈或附近餐馆等泛称。', 'restaurant_name_unspecific', 'warning')
  }
  const area = optionalString(value, 'area', 120) ?? target.stop?.area ?? target.block?.area ?? ''
  const notes = optionalString(value, 'notes', 300) ?? ''
  const evidenceLevel = value.evidence_level
  if (evidenceLevel !== 'sourced' && evidenceLevel !== 'pending') throw new ToolInputError('餐馆名称证据状态必须为 sourced 或 pending。')
  const rawSourceIds = value.source_ids
  const validSourceIdList = rawSourceIds === undefined ||
    (Array.isArray(rawSourceIds) && rawSourceIds.length <= 5 && rawSourceIds.every((id) => typeof id === 'string'))
  let sourceIds = validSourceIdList ? [...new Set((rawSourceIds ?? []) as string[])] : []
  let finalEvidenceLevel: 'sourced' | 'pending' = evidenceLevel
  let evidenceDowngraded = !validSourceIdList
  const availableIds = new Set(context.sourceIds ?? [])
  const sources = context.availableSources ?? []
  // 先按名称在本次可用来源中匹配，避免模型漏传 source_ids 丢失已有证据。
  const supportedSourceIds = sources.filter((source) =>
    availableIds.has(source.id) && (source.status === 'success' || source.status === 'partial') &&
    supportsName(restaurantName, source)
  ).map((source) => source.id)
  if (supportedSourceIds.length === 0) {
    finalEvidenceLevel = 'pending'
    evidenceDowngraded = evidenceDowngraded || evidenceLevel === 'sourced' || sourceIds.length > 0
    sourceIds = []
  } else {
    // 只保留直接支持店名的少量来源；分店和营业信息仍单独核验。
    finalEvidenceLevel = 'sourced'
    evidenceDowngraded = false
    sourceIds = [...new Set(supportedSourceIds)].slice(0, 5)
  }
  return { ...target, restaurantName, area, evidenceLevel: finalEvidenceLevel, evidenceDowngraded, sourceIds, notes }
}

/** 将修订应用到原地点或替代餐次时间块，并保留其他行程字段。 */
function applyPatch(options: ItineraryOption[], patch: MealPatch, context: ToolContext): void {
  const option = options[patch.planNumber - 1]
  const day = option?.days.find((candidate) => candidate.date === patch.date)
  if (!day) throw new ToolInputError('餐次日期已变化，请重新生成修订。', 'meal_date_changed', 'warning')
  const noteParts = [patch.stop?.notes, patch.block?.notes, patch.notes]
  if (patch.evidenceLevel === 'pending') noteParts.push('店名为待核验建议；分店、地址和当日营业信息需出发前确认。')
  if (patch.evidenceDowngraded) noteParts.push('当前来源未能直接支持店名，已按待核验建议保留。')
  const notes = [...new Set(noteParts.filter((part): part is string => typeof part === 'string')
    .map((part) => part.trim()).filter(Boolean))].join(' ').slice(0, 500)
  const previousBoundaries = lodgingCommuteBoundarySnapshot(day.stops)

  if (patch.stop) {
    const index = day.stops.findIndex((stop) => stop.id === patch.stop!.id)
    if (index < 0) throw new ToolInputError('待修订的餐馆地点已变化，请重新生成修订。', 'meal_stop_changed', 'warning')
    const updatedStop: ItineraryStop = {
      ...day.stops[index], name: patch.restaurantName, area: patch.area, notes,
      location: undefined, transitEstimate: undefined,
      factClaims: [], evidenceLevel: patch.evidenceLevel, sourceIds: patch.sourceIds
    }
    day.stops[index] = updatedStop
    const previous = day.stops[index - 1]
    const next = day.stops[index + 1]
    if (previous) resetTransitEdge(previous, patch.restaurantName, transitMode(previous.transitToNext, context))
    resetTransitEdge(updatedStop, next?.name ?? '', transitMode(updatedStop.transitToNext, context))
    removeStaleLodgingCommutes(day, previousBoundaries)
    return
  }

  if (day.stops.length >= MAX_ITINERARY_STOPS_PER_DAY) {
    throw new ToolInputError(
      `每天最多保留 ${MAX_ITINERARY_STOPS_PER_DAY} 个地点；请保留原用餐时间块并待核验门店。`,
      'meal_stop_limit', 'warning'
    )
  }
  const blockIndex = day.scheduleBlocks.findIndex((block) => block.id === patch.block?.id)
  if (patch.block) {
    if (blockIndex < 0) throw new ToolInputError('待修订的用餐时间块已变化，请重新生成修订。', 'meal_block_changed', 'warning')
    const block = day.scheduleBlocks[blockIndex]
    if (!block) throw new ToolInputError('待修订的用餐时间块已变化，请重新生成修订。', 'meal_block_changed', 'warning')
    const plannedMinute = firstClockMinute(block.time)
    const minute = plannedMinute ?? findOpenMealStart(day, patch.slot)
    if (minute === undefined) throw new ToolInputError('当天没有可安全插入的用餐窗口，请先重新排程后再补具体店面。', 'meal_window_unavailable', 'warning')
    const time = plannedMinute === undefined
      ? `${formatPlanningTime(minute)}–${formatPlanningTime(minute + 45)}`
      : block.time
    const stop: ItineraryStop = {
      id: randomUUID(), name: patch.restaurantName, area: patch.area, time: `${time} ${slotLabel(patch.slot)}`,
      durationMinutes: plannedMinute === undefined ? 45 : block.durationMinutes, category: '餐饮', notes, transitToNext: '',
      evidenceLevel: patch.evidenceLevel, sourceIds: patch.sourceIds, factClaims: []
    }
    insertMealStop(day.stops, stop, minute, context)
    day.scheduleBlocks.splice(blockIndex, 1)
    removeStaleLodgingCommutes(day, previousBoundaries)
    return
  }

  const minute = findOpenMealStart(day, patch.slot)
  if (minute === undefined) throw new ToolInputError('当天没有可安全插入的用餐窗口，请先重新排程后再补具体店面。', 'meal_window_unavailable', 'warning')
  const area = patch.area || closestArea(day, minute)
  const stop: ItineraryStop = {
    id: randomUUID(), name: patch.restaurantName, area,
    time: `${formatPlanningTime(minute)}–${formatPlanningTime(minute + 45)} ${slotLabel(patch.slot)}`,
    durationMinutes: 45, category: '餐饮', notes, transitToNext: '',
    evidenceLevel: patch.evidenceLevel, sourceIds: patch.sourceIds, factClaims: []
  }
  insertMealStop(day.stops, stop, minute, context)
  removeStaleLodgingCommutes(day, previousBoundaries)
}

/** 比较修订前后的住宿接驳端点；端点变化时清除已失效的路线事实。 */
function lodgingCommuteBoundarySnapshot(stops: ItineraryStop[]): Map<'from-lodging' | 'to-lodging', string> {
  const directions = ['from-lodging', 'to-lodging'] as const
  return new Map(directions.flatMap((direction) => {
    const stop = lodgingCommuteBoundaryStop(stops, direction)
    return stop ? [[direction, `${stop.id}\u0000${stop.name}\u0000${stop.area}\u0000${stop.category}`] as const] : []
  }))
}

/** 早餐或晚餐成为当天边界地点时，旧住宿路线不可继续绑定。 */
function removeStaleLodgingCommutes(
  day: ItineraryOption['days'][number],
  previous: Map<'from-lodging' | 'to-lodging', string>
): void {
  if (!day.lodgingCommutes?.length) return
  const current = lodgingCommuteBoundarySnapshot(day.stops)
  const valid = day.lodgingCommutes.filter((commute) =>
    previous.get(commute.direction) === current.get(commute.direction) &&
    commute.stopId === lodgingCommuteBoundaryStop(day.stops, commute.direction)?.id
  )
  if (valid.length) day.lodgingCommutes = valid
  else delete day.lodgingCommutes
}

/** 把餐馆按时刻插入地点序列，并使变更后的相邻接驳回到待核验状态。 */
function insertMealStop(stops: ItineraryStop[], stop: ItineraryStop, minute: number, context: ToolContext): void {
  const insertAt = stops.findIndex((candidate) => {
    const candidateMinute = firstClockMinute(candidate.time)
    return candidateMinute !== undefined && candidateMinute > minute
  })
  const index = insertAt < 0 ? stops.length : insertAt
  const previous = stops[index - 1]
  const next = stops[index]
  if (previous) resetTransitEdge(previous, stop.name, transitMode(previous.transitToNext, context))
  if (next) resetTransitEdge(stop, next.name, transitMode(previous?.transitToNext ?? '', context))
  stops.splice(index, 0, stop)
}

/** 从相邻停留点复用区域文字，避免为新增餐次虚构门店地址。 */
function closestArea(day: ItineraryOption['days'][number], minute: number): string {
  return day.stops.map((stop) => ({ area: stop.area, minute: firstClockMinute(stop.time) }))
    .filter((item): item is { area: string; minute: number } => !!item.area && item.minute !== undefined)
    .sort((left, right) => Math.abs(left.minute - minute) - Math.abs(right.minute - minute))[0]?.area ?? ''
}

/** 格式化局部修订采用的规划时刻，不代表路线或营业时间事实。 */
function formatPlanningTime(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

/** 清除地点修改后失效的路线数值和交通事实，保留下一站与方式说明。 */
function resetTransitEdge(stop: ItineraryStop, destination: string, mode: string): void {
  stop.transitEstimate = undefined
  stop.factClaims = (stop.factClaims ?? []).filter((claim) => claim.type !== 'transport-time')
  stop.transitToNext = destination
    ? `${mode ? `${mode}前往` : '交通方式待核验，前往'}${destination}；线路和耗时待核验。`
    : ''
}

/** 优先沿用已写明的交通方式或用户偏好，不构造未验证线路与时长。 */
function transitMode(existing: string, context: ToolContext): string {
  const modePattern = /地铁|公交|公共交通|步行|骑行|出租车|网约车|打车|驾车|自驾/u
  return existing.match(modePattern)?.[0] ?? context.tripBrief?.transport.match(modePattern)?.[0] ?? ''
}

/** 核对来源标题、摘要或正文摘录是否直接出现店名，避免把泛攻略挂作名称证据。 */
function supportsName(name: string, source: SourceRecord): boolean {
  if (!['web', 'place', 'user', 'plugin'].includes(source.kind)) return false
  const evidence = [source.title, source.summary, source.factEvidenceExcerpt]
    .filter((text): text is string => typeof text === 'string')
    .map(normalizeEvidenceText).join(' ')
  const baseName = name.split(/[（(]/u, 1)[0]?.trim() ?? name
  const baseNeedle = normalizeEvidenceText(baseName)
  if (baseNeedle.length < 2 || !evidence.includes(baseNeedle)) return false

  // 品牌提及不能替代分店证据；名称带门店后缀时，来源也必须提到该后缀。
  const branchNames = [...name.matchAll(/[（(]([^）)]+)[）)]/gu)].map((match) => normalizeEvidenceText(match[1] ?? ''))
  return branchNames.every((branch) => branch.length >= 2 && evidence.includes(branch))
}

/** 统一忽略标点和空格比较中英文来源中的店名。 */
function normalizeEvidenceText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[^\p{L}\p{N}]/gu, '')
}

/** 餐次字段只接受固定枚举。 */
function mealSlot(value: unknown): MealSlot {
  if (typeof value !== 'string' || !MEALS.includes(value as MealSlot)) throw new ToolInputError('餐次必须是 breakfast、lunch 或 dinner。')
  return value as MealSlot
}

/** 在餐馆停靠点时段中保留用户要求的餐次标签。 */
function slotLabel(slot: MealSlot): string {
  return slot === 'breakfast' ? '早餐' : slot === 'lunch' ? '午餐' : '晚餐'
}

/** 读取有限范围的整数。 */
function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new ToolInputError(`${label}必须是 1–${maximum} 的整数。`)
  }
  return value
}

/** 读取长度受限的必填文本。 */
function requiredString(value: Record<string, unknown>, key: string, min: number, max: number): string {
  const field = value[key]
  if (typeof field !== 'string' || field.trim().length < min || field.length > max) throw new ToolInputError(`${key} 格式无效。`)
  return field.trim()
}

/** 读取长度受限的可选文本。 */
function optionalString(value: Record<string, unknown>, key: string, max: number): string | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'string' || field.length > max) throw new ToolInputError(`${key} 格式无效。`)
  return field.trim()
}

/** 构造方案、日期和餐次唯一键。 */
function targetKey(target: Pick<MealTarget, 'planNumber' | 'dayNumber' | 'slot'>): string {
  return `${target.planNumber}|${target.dayNumber}|${target.slot}`
}
