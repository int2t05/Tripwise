/** 为历史行程恢复提供按字段选择的差异，不覆盖未选中的当前草稿内容。 */
import type { ItineraryDay, ItineraryOption, ItineraryScheduleBlock, ItineraryStop } from './types.js'
import { MAX_ITINERARY_STOPS_PER_DAY } from './itinerary-limits.js'
import { lodgingCommuteBoundaryStop } from './itinerary-route-endpoints.js'

type RestoreValue = string | number | null
type PlanField = 'title' | 'summary' | 'tradeoffs'
type DayField = 'date' | 'title'
type StopField = 'name' | 'area' | 'time' | 'durationMinutes' | 'category' | 'notes' | 'transitToNext'
type ScheduleField = 'kind' | 'title' | 'time' | 'durationMinutes' | 'area' | 'notes'

type RestorePath =
  | { kind: 'plan'; field: PlanField }
  | { kind: 'day'; dayNumber: number; field: DayField }
  | { kind: 'stop'; stopId: string; field: StopField }
  | { kind: 'schedule'; blockId: string; field: ScheduleField }

type RestoreStructurePath =
  | { kind: 'day-add'; dayNumber: number }
  | { kind: 'day-remove'; dayNumber: number }
  | { kind: 'stop-add'; historicalStopId: string; dayNumber: number; index: number }
  | { kind: 'stop-remove'; stopId: string; dayNumber: number }
  | { kind: 'stop-position'; stopId: string; fromDayNumber: number; toDayNumber: number; toIndex: number }
  | { kind: 'schedule-add'; historicalBlockId: string; dayNumber: number; index: number }
  | { kind: 'schedule-remove'; blockId: string; dayNumber: number }
  | { kind: 'schedule-position'; blockId: string; fromDayNumber: number; toDayNumber: number; toIndex: number }
  | { kind: 'ambiguous'; itemType: 'stop' | 'schedule'; identity: string }

export interface ItineraryRestorableField {
  id: string
  label: string
  currentValue: string
  historicalValue: string
  restoreValue: RestoreValue
  path: RestorePath
  disabledReason?: string
}

export interface ItineraryRestorableStructureChange {
  id: string
  label: string
  currentValue: string
  historicalValue: string
  path: RestoreStructurePath
  disabledReason?: string
  requiresChangeIds?: string[]
}

export type ItineraryRestorableChange =
  | (ItineraryRestorableField & { changeType: 'field' })
  | (ItineraryRestorableStructureChange & { changeType: 'structure' })

interface StopReference {
  id: string
  day: ItineraryDay
  index: number
  stop: ItineraryStop
  identity: string
}

interface ScheduleReference {
  id: string
  day: ItineraryDay
  index: number
  block: ItineraryScheduleBlock
  identity: string
}

interface ReferenceMatch<T> {
  matches: Array<{ current: T; historical: T }>
  currentOnly: T[]
  historicalOnly: T[]
  ambiguous: Array<{ identity: string; current: T[]; historical: T[] }>
}

/** 列出两版共同对象中可独立恢复的文字、日期和时长字段。 */
export function listItineraryRestorableFields(
  current: ItineraryOption,
  historical: ItineraryOption,
  protectedStopIds: string[] = []
): ItineraryRestorableField[] {
  const fields: ItineraryRestorableField[] = []
  const protectedIds = new Set(protectedStopIds)
  addFields(fields, current, historical, [
    ['title', '方案名称'], ['summary', '方案摘要'], ['tradeoffs', '安排取舍']
  ])

  const currentDays = new Map(current.days.map((day) => [day.dayNumber, day]))
  const historicalDays = new Map(historical.days.map((day) => [day.dayNumber, day]))
  for (const [dayNumber, currentDay] of currentDays) {
    const historicalDay = historicalDays.get(dayNumber)
    if (!historicalDay) continue
    for (const field of ['date', 'title'] as const) {
      addField(fields, {
        id: `day:${dayNumber}:${field}`,
        label: `第 ${dayNumber} 天${field === 'date' ? '日期' : '主题'}`,
        currentValue: currentDay[field],
        historicalValue: historicalDay[field],
        restoreValue: historicalDay[field],
        path: { kind: 'day', dayNumber, field },
        ...(field === 'date' && currentDay.stops.some((stop) => protectedIds.has(stop.id) || stop.locked)
          ? { disabledReason: '这一天含固定安排，先保存解除固定后才能恢复日期。' }
          : {})
      })
    }
  }

  for (const { current: currentRef, historical: historicalRef } of matchReferences(
    indexStops(current), indexStops(historical)
  )) {
    const { stop } = currentRef
    const oldStop = historicalRef.stop
    const sameDay = currentRef.day.dayNumber === historicalRef.day.dayNumber
    const dayContext = sameDay
      ? `第 ${currentRef.day.dayNumber} 天`
      : `第 ${currentRef.day.dayNumber} 天（历史版本在第 ${historicalRef.day.dayNumber} 天）`
    const protectedStop = protectedIds.has(stop.id) || !!stop.locked
    for (const [field, label] of stopFields) {
      addField(fields, {
        id: `stop:${encodeURIComponent(stop.id)}:${field}`,
        label: `${oldStop.name || stop.name} · ${dayContext} · ${label}`,
        currentValue: displayValue(stop[field]),
        historicalValue: displayValue(oldStop[field]),
        restoreValue: oldStop[field],
        path: { kind: 'stop', stopId: stop.id, field },
        ...(protectedStop && (field === 'name' || field === 'time')
          ? { disabledReason: '该地点是固定安排，先保存解除固定后才能恢复名称或时段。' }
          : {})
      })
    }
  }

  for (const { current: currentRef, historical: historicalRef } of matchReferences(
    indexScheduleBlocks(current), indexScheduleBlocks(historical)
  )) {
    const { block } = currentRef
    const oldBlock = historicalRef.block
    const sameDay = currentRef.day.dayNumber === historicalRef.day.dayNumber
    const dayContext = sameDay
      ? `第 ${currentRef.day.dayNumber} 天`
      : `第 ${currentRef.day.dayNumber} 天（历史版本在第 ${historicalRef.day.dayNumber} 天）`
    for (const [field, label] of scheduleFields) {
      addField(fields, {
        id: `schedule:${encodeURIComponent(block.id)}:${field}`,
        label: `${oldBlock.title || block.title} · ${dayContext} · ${label}`,
        currentValue: displayValue(block[field]),
        historicalValue: displayValue(oldBlock[field]),
        restoreValue: oldBlock[field],
        path: { kind: 'schedule', blockId: block.id, field }
      })
    }
  }
  return fields
}

/** 合并可编辑字段和日程结构差异，供用户在同一列表中审阅选择。 */
export function listItineraryRestorableChanges(
  current: ItineraryOption,
  historical: ItineraryOption,
  protectedStopIds: string[] = []
): ItineraryRestorableChange[] {
  return [
    ...listItineraryRestorableFields(current, historical, protectedStopIds)
      .map((field) => ({ ...field, changeType: 'field' as const })),
    ...listStructureChanges(current, historical, protectedStopIds)
      .map((change) => ({ ...change, changeType: 'structure' as const }))
  ]
}

/** 生成按天、地点和独立时段拆分的可选结构操作。 */
function listStructureChanges(
  current: ItineraryOption,
  historical: ItineraryOption,
  protectedStopIds: string[]
): ItineraryRestorableStructureChange[] {
  const changes: ItineraryRestorableStructureChange[] = []
  const currentDays = new Map(current.days.map((day) => [day.dayNumber, day]))
  const historicalDays = new Map(historical.days.map((day) => [day.dayNumber, day]))
  const protectedIds = new Set(protectedStopIds)

  for (const day of historical.days) {
    if (currentDays.has(day.dayNumber)) continue
    changes.push({
      id: 'day:add:' + day.dayNumber,
      label: '恢复第 ' + day.dayNumber + ' 天',
      currentValue: '当前版本没有这一天',
      historicalValue: dayDescription(day),
      path: { kind: 'day-add', dayNumber: day.dayNumber }
    })
  }
  for (const day of current.days) {
    if (historicalDays.has(day.dayNumber)) continue
    const locked = day.stops.some((stop) => protectedIds.has(stop.id) || stop.locked)
    changes.push({
      id: 'day:remove:' + day.dayNumber,
      label: '移除第 ' + day.dayNumber + ' 天',
      currentValue: dayDescription(day),
      historicalValue: '历史版本没有这一天',
      path: { kind: 'day-remove', dayNumber: day.dayNumber },
      ...(locked ? { disabledReason: '这一天含固定地点；请先保存解除固定后再恢复整日结构。' } : {})
    })
  }

  appendStopStructureChanges(changes, current, historical, currentDays, historicalDays, protectedIds)
  appendScheduleStructureChanges(changes, current, historical, currentDays, historicalDays)
  return changes
}

/** 列出地点增删、跨日移动和同日排序差异。 */
function appendStopStructureChanges(
  changes: ItineraryRestorableStructureChange[],
  current: ItineraryOption,
  historical: ItineraryOption,
  currentDays: Map<number, ItineraryDay>,
  historicalDays: Map<number, ItineraryDay>,
  protectedIds: Set<string>
): void {
  const currentRefs = indexStops(current)
  const historicalRefs = indexStops(historical)
  const matching = matchReferencesDetailed(currentRefs, historicalRefs)

  for (const ref of matching.currentOnly) {
    if (!historicalDays.has(ref.day.dayNumber)) continue
    const protectedStop = protectedIds.has(ref.id) || !!ref.stop.locked
    changes.push({
      id: 'stop:remove:' + encodeURIComponent(ref.id),
      label: '移除本次新增地点：' + ref.stop.name,
      currentValue: itemPosition(ref.day.dayNumber, ref.index, '地点'),
      historicalValue: '历史版本没有此地点',
      path: { kind: 'stop-remove', stopId: ref.id, dayNumber: ref.day.dayNumber },
      ...(protectedStop ? { disabledReason: '该地点是固定安排；请先保存解除固定后再恢复结构。' } : {})
    })
  }
  for (const ref of matching.historicalOnly) {
    const requiresChangeIds = currentDays.has(ref.day.dayNumber) ? [] : ['day:add:' + ref.day.dayNumber]
    changes.push({
      id: 'stop:add:' + encodeURIComponent(ref.id),
      label: '恢复地点：' + ref.stop.name,
      currentValue: '当前版本未安排',
      historicalValue: itemPosition(ref.day.dayNumber, ref.index, '地点'),
      path: { kind: 'stop-add', historicalStopId: ref.id, dayNumber: ref.day.dayNumber, index: ref.index },
      ...(requiresChangeIds.length ? { requiresChangeIds } : {})
    })
  }
  addAmbiguousChanges(changes, matching.ambiguous, 'stop')

  const matchedById = new Map(matching.matches.map((pair) => [pair.current.id, pair]))
  for (const { current: currentRef, historical: historicalRef } of matching.matches) {
    if (currentRef.day.dayNumber === historicalRef.day.dayNumber) continue
    addStopPositionChange(changes, currentRef, historicalRef, currentDays, protectedIds)
  }
  for (const dayNumber of currentDays.keys()) {
    if (!historicalDays.has(dayNumber)) continue
    const sameDayMatches = matching.matches.filter(({ current: currentRef, historical: historicalRef }) =>
      currentRef.day.dayNumber === dayNumber && historicalRef.day.dayNumber === dayNumber)
    const currentOrder = sameDayMatches.slice().sort((left, right) => left.current.index - right.current.index)
      .map((pair) => pair.current.id)
    const historicalOrder = sameDayMatches.slice().sort((left, right) => left.historical.index - right.historical.index)
      .map((pair) => pair.current.id)
    for (const stopId of findMovedIds(currentOrder, historicalOrder)) {
      const pair = matchedById.get(stopId)
      if (pair) addStopPositionChange(changes, pair.current, pair.historical, currentDays, protectedIds)
    }
  }
}

/** 列出独立用餐、休息或机动时段的增删、跨日移动和排序差异。 */
function appendScheduleStructureChanges(
  changes: ItineraryRestorableStructureChange[],
  current: ItineraryOption,
  historical: ItineraryOption,
  currentDays: Map<number, ItineraryDay>,
  historicalDays: Map<number, ItineraryDay>
): void {
  const matching = matchReferencesDetailed(indexScheduleBlocks(current), indexScheduleBlocks(historical))
  for (const ref of matching.currentOnly) {
    if (!historicalDays.has(ref.day.dayNumber)) continue
    changes.push({
      id: 'schedule:remove:' + encodeURIComponent(ref.id),
      label: '移除本次新增时段：' + ref.block.title,
      currentValue: itemPosition(ref.day.dayNumber, ref.index, '时段'),
      historicalValue: '历史版本没有此时段',
      path: { kind: 'schedule-remove', blockId: ref.id, dayNumber: ref.day.dayNumber }
    })
  }
  for (const ref of matching.historicalOnly) {
    const requiresChangeIds = currentDays.has(ref.day.dayNumber) ? [] : ['day:add:' + ref.day.dayNumber]
    changes.push({
      id: 'schedule:add:' + encodeURIComponent(ref.id),
      label: '恢复时段：' + ref.block.title,
      currentValue: '当前版本未安排',
      historicalValue: itemPosition(ref.day.dayNumber, ref.index, '时段'),
      path: { kind: 'schedule-add', historicalBlockId: ref.id, dayNumber: ref.day.dayNumber, index: ref.index },
      ...(requiresChangeIds.length ? { requiresChangeIds } : {})
    })
  }
  addAmbiguousChanges(changes, matching.ambiguous, 'schedule')

  const matchedById = new Map(matching.matches.map((pair) => [pair.current.id, pair]))
  for (const { current: currentRef, historical: historicalRef } of matching.matches) {
    if (currentRef.day.dayNumber !== historicalRef.day.dayNumber) {
      addSchedulePositionChange(changes, currentRef, historicalRef, currentDays)
    }
  }
  for (const dayNumber of currentDays.keys()) {
    if (!historicalDays.has(dayNumber)) continue
    const sameDayMatches = matching.matches.filter(({ current: currentRef, historical: historicalRef }) =>
      currentRef.day.dayNumber === dayNumber && historicalRef.day.dayNumber === dayNumber)
    const currentOrder = sameDayMatches.slice().sort((left, right) => left.current.index - right.current.index)
      .map((pair) => pair.current.id)
    const historicalOrder = sameDayMatches.slice().sort((left, right) => left.historical.index - right.historical.index)
      .map((pair) => pair.current.id)
    for (const blockId of findMovedIds(currentOrder, historicalOrder)) {
      const pair = matchedById.get(blockId)
      if (pair) addSchedulePositionChange(changes, pair.current, pair.historical, currentDays)
    }
  }
}

/** 将地点位置变化和固定地点限制组合成用户可读的差异项。 */
function addStopPositionChange(
  changes: ItineraryRestorableStructureChange[],
  current: StopReference,
  historical: StopReference,
  currentDays: Map<number, ItineraryDay>,
  protectedIds: Set<string>
): void {
  const targetDayMissing = !currentDays.has(historical.day.dayNumber)
  changes.push({
    id: 'stop:position:' + encodeURIComponent(current.id) + ':' + historical.day.dayNumber + ':' + historical.index,
    label: '恢复地点位置：' + historical.stop.name,
    currentValue: itemPosition(current.day.dayNumber, current.index, '地点'),
    historicalValue: itemPosition(historical.day.dayNumber, historical.index, '地点'),
    path: {
      kind: 'stop-position', stopId: current.id, fromDayNumber: current.day.dayNumber,
      toDayNumber: historical.day.dayNumber, toIndex: historical.index
    },
    ...(protectedIds.has(current.id) || current.stop.locked
      ? { disabledReason: '该地点是固定安排；请先保存解除固定后再恢复位置。' }
      : {}),
    ...(targetDayMissing ? { requiresChangeIds: ['day:add:' + historical.day.dayNumber] } : {})
  })
}

/** 将时段位置变化转换成一项可单独勾选的恢复操作。 */
function addSchedulePositionChange(
  changes: ItineraryRestorableStructureChange[],
  current: ScheduleReference,
  historical: ScheduleReference,
  currentDays: Map<number, ItineraryDay>
): void {
  const targetDayMissing = !currentDays.has(historical.day.dayNumber)
  changes.push({
    id: 'schedule:position:' + encodeURIComponent(current.id) + ':' + historical.day.dayNumber + ':' + historical.index,
    label: '恢复时段位置：' + historical.block.title,
    currentValue: itemPosition(current.day.dayNumber, current.index, '时段'),
    historicalValue: itemPosition(historical.day.dayNumber, historical.index, '时段'),
    path: {
      kind: 'schedule-position', blockId: current.id, fromDayNumber: current.day.dayNumber,
      toDayNumber: historical.day.dayNumber, toIndex: historical.index
    },
    ...(targetDayMissing ? { requiresChangeIds: ['day:add:' + historical.day.dayNumber] } : {})
  })
}

/** 为身份不唯一的重复对象显示提示，但不提供可能误改行程的操作。 */
function addAmbiguousChanges<T extends { identity: string }>(
  changes: ItineraryRestorableStructureChange[],
  groups: Array<{ identity: string; current: T[]; historical: T[] }>,
  itemType: 'stop' | 'schedule'
): void {
  for (const group of groups) {
    const label = itemType === 'stop' ? '地点' : '时段'
    changes.push({
      id: 'ambiguous:' + itemType + ':' + encodeURIComponent(group.identity),
      label: label + '身份无法自动匹配',
      currentValue: '当前版本有 ' + group.current.length + ' 项同名内容',
      historicalValue: '历史版本有 ' + group.historical.length + ' 项同名内容',
      path: { kind: 'ambiguous', itemType, identity: group.identity },
      disabledReason: '重复名称且对象 ID 不同，无法安全判断对应关系；请在编辑器中手动调整。'
    })
  }
}

/** 标注对象在一天内的可见位置。 */
function itemPosition(dayNumber: number, index: number, itemName: string): string {
  return '第 ' + dayNumber + ' 天 · 第 ' + (index + 1) + ' 个' + itemName
}

/** 在差异项中简要说明整日包含的内容，避免用户误删未预期对象。 */
function dayDescription(day: ItineraryDay): string {
  const date = day.date ? day.date + ' · ' : ''
  const stops = day.stops.map((stop) => stop.name).join('、') || '无'
  const blocks = day.scheduleBlocks.map((block) => block.title).join('、') || '无'
  return date + (day.title || '未命名日程') + ' · 地点：' + stops + ' · 时段：' + blocks
}

/** 用最长公共子序列找出需要移动的最小对象集合。 */
function findMovedIds(current: string[], historical: string[]): Set<string> {
  const table = Array.from({ length: current.length + 1 }, () => Array<number>(historical.length + 1).fill(0))
  for (let currentIndex = current.length - 1; currentIndex >= 0; currentIndex--) {
    for (let historicalIndex = historical.length - 1; historicalIndex >= 0; historicalIndex--) {
      const row = table[currentIndex]
      const nextRow = table[currentIndex + 1]
      if (!row || !nextRow) continue
      row[historicalIndex] = current[currentIndex] === historical[historicalIndex]
        ? (nextRow[historicalIndex + 1] ?? 0) + 1
        : Math.max(nextRow[historicalIndex] ?? 0, row[historicalIndex + 1] ?? 0)
    }
  }
  const kept = new Set<string>()
  let currentIndex = 0
  let historicalIndex = 0
  while (currentIndex < current.length && historicalIndex < historical.length) {
    const currentId = current[currentIndex]
    const historicalId = historical[historicalIndex]
    if (currentId === historicalId && currentId !== undefined) {
      kept.add(currentId)
      currentIndex++
      historicalIndex++
      continue
    }
    if ((table[currentIndex + 1]?.[historicalIndex] ?? 0) >= (table[currentIndex]?.[historicalIndex + 1] ?? 0)) currentIndex++
    else historicalIndex++
  }
  return new Set(current.filter((id) => !kept.has(id)))
}

/** 检查勾选项的依赖关系和恢复后每天的对象数量限制。 */
export function itineraryRestorationSelectionError(
  current: ItineraryOption,
  changes: ItineraryRestorableChange[],
  selectedChangeIds: string[]
): string {
  const selectedIds = new Set(selectedChangeIds)
  const selected = changes.filter((change) => selectedIds.has(change.id))
  const byId = new Map(changes.map((change) => [change.id, change]))
  for (const change of selected) {
    if (change.disabledReason) return change.disabledReason
    const requiredChangeIds = change.changeType === 'structure' ? change.requiresChangeIds ?? [] : []
    for (const requiredId of requiredChangeIds) {
      if (!selectedIds.has(requiredId)) return '还需同时选择“' + (byId.get(requiredId)?.label ?? '恢复目标日') + '”。'
    }
  }

  let dayCount = current.days.length
  const removedDays = new Set<number>()
  const stopCounts = new Map(current.days.map((day) => [day.dayNumber, day.stops.length]))
  const scheduleCounts = new Map(current.days.map((day) => [day.dayNumber, day.scheduleBlocks.length]))
  for (const change of selected) {
    if (change.changeType !== 'structure') continue
    const path = change.path
    if (path.kind === 'day-add') {
      dayCount++
      stopCounts.set(path.dayNumber, 0)
      scheduleCounts.set(path.dayNumber, 0)
    } else if (path.kind === 'day-remove') {
      dayCount--
      removedDays.add(path.dayNumber)
    } else if (path.kind === 'stop-add') {
      stopCounts.set(path.dayNumber, (stopCounts.get(path.dayNumber) ?? 0) + 1)
    } else if (path.kind === 'stop-remove') {
      stopCounts.set(path.dayNumber, (stopCounts.get(path.dayNumber) ?? 0) - 1)
    } else if (path.kind === 'stop-position' && path.fromDayNumber !== path.toDayNumber) {
      stopCounts.set(path.fromDayNumber, (stopCounts.get(path.fromDayNumber) ?? 0) - 1)
      stopCounts.set(path.toDayNumber, (stopCounts.get(path.toDayNumber) ?? 0) + 1)
    } else if (path.kind === 'schedule-add') {
      scheduleCounts.set(path.dayNumber, (scheduleCounts.get(path.dayNumber) ?? 0) + 1)
    } else if (path.kind === 'schedule-remove') {
      scheduleCounts.set(path.dayNumber, (scheduleCounts.get(path.dayNumber) ?? 0) - 1)
    } else if (path.kind === 'schedule-position' && path.fromDayNumber !== path.toDayNumber) {
      scheduleCounts.set(path.fromDayNumber, (scheduleCounts.get(path.fromDayNumber) ?? 0) - 1)
      scheduleCounts.set(path.toDayNumber, (scheduleCounts.get(path.toDayNumber) ?? 0) + 1)
    }
  }
  if (dayCount < 1 || dayCount > 7) return '恢复后行程天数需为 1–7 天，请减少已选日期。'
  for (const [dayNumber, count] of stopCounts) {
    if (removedDays.has(dayNumber)) continue
    if (count < 0) return '恢复后第 ' + dayNumber + ' 天的地点数量无效。'
    if (count > MAX_ITINERARY_STOPS_PER_DAY) return `恢复后第 ${dayNumber} 天超过 ${MAX_ITINERARY_STOPS_PER_DAY} 个地点，请减少已选变更。`
  }
  for (const [dayNumber, count] of scheduleCounts) {
    if (removedDays.has(dayNumber)) continue
    if (count < 0) return '恢复后第 ' + dayNumber + ' 天的时段数量无效。'
    if (count > 8) return '恢复后第 ' + dayNumber + ' 天超过 8 个时段，请减少已选变更。'
  }
  return ''
}

/** 将用户选中的历史字段写入当前草稿，其余字段和证据保持当前状态。 */
export function restoreItineraryFields(
  current: ItineraryOption,
  historical: ItineraryOption,
  selectedFieldIds: string[],
  protectedStopIds: string[] = []
): ItineraryOption {
  const selected = new Set(selectedFieldIds)
  const result = structuredClone(current)
  for (const field of listItineraryRestorableFields(current, historical, protectedStopIds)) {
    if (!selected.has(field.id) || field.disabledReason) continue
    const { path, restoreValue } = field
    if (path.kind === 'plan') {
      result[path.field] = restoreValue as string
    } else if (path.kind === 'day') {
      const day = result.days.find((item) => item.dayNumber === path.dayNumber)
      if (day) day[path.field] = restoreValue as string
    } else if (path.kind === 'stop') {
      const stop = result.days.flatMap((day) => day.stops).find((item) => item.id === path.stopId)
      if (stop) (stop as unknown as Record<StopField, RestoreValue>)[path.field] = restoreValue
    } else {
      const block = result.days.flatMap((day) => day.scheduleBlocks).find((item) => item.id === path.blockId)
      if (block) (block as unknown as Record<ScheduleField, RestoreValue>)[path.field] = restoreValue
    }
  }
  return result
}

/** 将选中的字段和结构差异写入草稿，并清除因此失效的路线依据。 */
export function restoreItineraryChanges(
  current: ItineraryOption,
  historical: ItineraryOption,
  selectedChangeIds: string[],
  protectedStopIds: string[] = [],
  createId: () => string = () => globalThis.crypto.randomUUID()
): ItineraryOption {
  const changes = listItineraryRestorableChanges(current, historical, protectedStopIds)
  const selectionError = itineraryRestorationSelectionError(current, changes, selectedChangeIds)
  if (selectionError) throw new Error(selectionError)

  const selectedIds = new Set(selectedChangeIds)
  const selectedChanges = changes.filter((change) => selectedIds.has(change.id))
  const fieldIds = selectedChanges
    .filter((change): change is ItineraryRestorableField & { changeType: 'field' } => change.changeType === 'field')
    .map((change) => change.id)
  const structureChanges = selectedChanges
    .filter((change): change is ItineraryRestorableStructureChange & { changeType: 'structure' } => change.changeType === 'structure')
  const result = restoreItineraryFields(current, historical, fieldIds, protectedStopIds)
  const allocatedIds = new Set<string>()

  for (const change of structureChanges) {
    const path = change.path
    if (path.kind !== 'day-add') continue
    const historicalDay = historical.days.find((day) => day.dayNumber === path.dayNumber)
    if (!historicalDay) continue
    result.days.push({
      id: createUniqueId(result, createId, allocatedIds),
      dayNumber: historicalDay.dayNumber,
      date: historicalDay.date,
      title: historicalDay.title,
      stops: [],
      scheduleBlocks: []
    })
  }

  for (const change of structureChanges) {
    if (change.path.kind === 'stop-remove') {
      removeStopById(result, change.path.stopId)
    } else if (change.path.kind === 'schedule-remove') {
      removeScheduleBlockById(result, change.path.blockId)
    }
  }

  const stopInsertions: Array<{ dayNumber: number; index: number; value: ItineraryStop }> = []
  const scheduleInsertions: Array<{ dayNumber: number; index: number; value: ItineraryScheduleBlock }> = []
  for (const change of structureChanges) {
    const path = change.path
    if (path.kind === 'stop-position') {
      const stop = removeStopById(result, path.stopId)
      if (!stop) continue
      const before = findStopReference(current, path.stopId)
      if (before && before.day.dayNumber !== path.toDayNumber) clearMovedStopEvidence(stop)
      stopInsertions.push({ dayNumber: path.toDayNumber, index: path.toIndex, value: stop })
    } else if (path.kind === 'schedule-position') {
      const block = removeScheduleBlockById(result, path.blockId)
      if (block) scheduleInsertions.push({ dayNumber: path.toDayNumber, index: path.toIndex, value: block })
    } else if (path.kind === 'stop-add') {
      const historicalStop = findStopReference(historical, path.historicalStopId)?.stop
      if (historicalStop) stopInsertions.push({
        dayNumber: path.dayNumber,
        index: path.index,
        value: cloneHistoricalStop(historicalStop, createUniqueId(result, createId, allocatedIds))
      })
    } else if (path.kind === 'schedule-add') {
      const historicalBlock = findScheduleReference(historical, path.historicalBlockId)?.block
      if (historicalBlock) scheduleInsertions.push({
        dayNumber: path.dayNumber,
        index: path.index,
        value: { ...structuredClone(historicalBlock), id: createUniqueId(result, createId, allocatedIds) }
      })
    }
  }

  insertByHistoricalIndex(stopInsertions, result, (day) => day.stops)
  insertByHistoricalIndex(scheduleInsertions, result, (day) => day.scheduleBlocks)

  const removedDayNumbers = new Set(structureChanges.flatMap((change) =>
    change.path.kind === 'day-remove' ? [change.path.dayNumber] : []
  ))
  result.days = result.days.filter((day) => !removedDayNumbers.has(day.dayNumber))
  result.days.sort((left, right) => left.dayNumber - right.dayNumber)
  clearInvalidRouteEvidence(result, current)
  return result
}

/** 按历史下标插入移动或恢复的地点和时段。 */
function insertByHistoricalIndex<T extends { id: string }>(
  insertions: Array<{ dayNumber: number; index: number; value: T }>,
  itinerary: ItineraryOption,
  getItems: (day: ItineraryDay) => T[]
): void {
  const grouped = new Map<number, typeof insertions>()
  for (const insertion of insertions) {
    const group = grouped.get(insertion.dayNumber) ?? []
    group.push(insertion)
    grouped.set(insertion.dayNumber, group)
  }
  for (const [dayNumber, entries] of grouped) {
    const day = itinerary.days.find((item) => item.dayNumber === dayNumber)
    if (!day) continue
    entries.sort((left, right) => left.index - right.index)
    const items = getItems(day)
    for (const entry of entries) {
      items.splice(Math.min(entry.index, items.length), 0, entry.value)
    }
  }
}

/** 从当前结果中移除地点并返回对象，供跨日移动使用。 */
function removeStopById(itinerary: ItineraryOption, stopId: string): ItineraryStop | undefined {
  for (const day of itinerary.days) {
    const index = day.stops.findIndex((stop) => stop.id === stopId)
    if (index === -1) continue
    return day.stops.splice(index, 1)[0]
  }
  return undefined
}

/** 从当前结果中移除独立时段并返回对象，供跨日移动使用。 */
function removeScheduleBlockById(itinerary: ItineraryOption, blockId: string): ItineraryScheduleBlock | undefined {
  for (const day of itinerary.days) {
    const index = day.scheduleBlocks.findIndex((block) => block.id === blockId)
    if (index === -1) continue
    return day.scheduleBlocks.splice(index, 1)[0]
  }
  return undefined
}

/** 为恢复对象生成不与当前行程 ID 冲突的本机 ID。 */
function createUniqueId(itinerary: ItineraryOption, createId: () => string, allocatedIds: Set<string>): string {
  const usedIds = new Set([
    itinerary.id,
    ...itinerary.days.flatMap((day) => [
      day.id,
      ...day.stops.flatMap((stop) => [stop.id, ...(stop.factClaims ?? []).map((claim) => claim.id)]),
      ...day.scheduleBlocks.map((block) => block.id)
    ])
  ])
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = createId()
    if (id && !usedIds.has(id) && !allocatedIds.has(id)) {
      allocatedIds.add(id)
      return id
    }
  }
  throw new Error('无法为恢复的行程内容分配唯一 ID。')
}

/** 恢复旧地点时保留用户文字，但要求重新确认来源、事实、定位和路线。 */
function cloneHistoricalStop(stop: ItineraryStop, id: string): ItineraryStop {
  const restored = structuredClone(stop)
  restored.id = id
  restored.sourceIds = []
  restored.evidenceLevel = 'pending'
  restored.factClaims = []
  delete restored.location
  delete restored.transitEstimate
  return restored
}

/** 跨日移动后清除日期相关的地点依据和站间路线信息。 */
function clearMovedStopEvidence(stop: ItineraryStop): void {
  stop.sourceIds = []
  stop.evidenceLevel = 'pending'
  stop.factClaims = []
  stop.transitToNext = ''
  delete stop.transitEstimate
}

/** 校验结构变化后边界接驳、日期事实和站间路线仍然绑定当前日程。 */
function clearInvalidRouteEvidence(result: ItineraryOption, current: ItineraryOption): void {
  const previousStops = new Map(current.days.flatMap((day) => day.stops.map((stop, index) => [
    stop.id,
    { dayNumber: day.dayNumber, date: day.date, nextStopId: day.stops[index + 1]?.id, stop }
  ] as const)))
  for (const day of result.days) {
    const previousDay = current.days.find((item) => item.dayNumber === day.dayNumber)
    const previousFirst = previousDay && lodgingCommuteBoundaryStop(previousDay.stops, 'from-lodging')
    const previousLast = previousDay && lodgingCommuteBoundaryStop(previousDay.stops, 'to-lodging')
    const currentFirst = lodgingCommuteBoundaryStop(day.stops, 'from-lodging')
    const currentLast = lodgingCommuteBoundaryStop(day.stops, 'to-lodging')
    if (previousDay && (previousDay.date !== day.date ||
      previousFirst?.id !== currentFirst?.id || previousLast?.id !== currentLast?.id)) {
      delete day.lodgingCommutes
    }
    for (let index = 0; index < day.stops.length; index++) {
      const stop = day.stops[index]
      if (!stop) continue
      const previous = previousStops.get(stop.id)
      if (!previous) continue
      const dateChanged = previous.date !== day.date
      const dayChanged = previous.dayNumber !== day.dayNumber
      if (dateChanged) {
        stop.sourceIds = []
        stop.evidenceLevel = 'pending'
        stop.factClaims = []
      }
      if (dateChanged || dayChanged || previous.nextStopId !== day.stops[index + 1]?.id ||
        previous.stop.name !== stop.name || previous.stop.time !== stop.time) {
        stop.transitToNext = ''
        delete stop.transitEstimate
      } else if (previous.stop.transitToNext !== stop.transitToNext) {
        delete stop.transitEstimate
      }
    }
  }
}

/** 在历史对象列表中查找稳定 ID 对应的地点。 */
function findStopReference(itinerary: ItineraryOption, stopId: string): StopReference | undefined {
  return indexStops(itinerary).find((reference) => reference.id === stopId)
}

/** 在历史对象列表中查找稳定 ID 对应的独立时段。 */
function findScheduleReference(itinerary: ItineraryOption, blockId: string): ScheduleReference | undefined {
  return indexScheduleBlocks(itinerary).find((reference) => reference.id === blockId)
}

/** 对比固定的行程标题字段，避免漏掉用户可编辑的方案说明。 */
function addFields(
  fields: ItineraryRestorableField[],
  current: ItineraryOption,
  historical: ItineraryOption,
  entries: Array<[PlanField, string]>
): void {
  for (const [field, label] of entries) {
    addField(fields, {
      id: `plan:${field}`, label,
      currentValue: current[field], historicalValue: historical[field],
      restoreValue: historical[field], path: { kind: 'plan', field }
    })
  }
}

/** 差异为空时不显示选择项，减少无效勾选。 */
function addField(fields: ItineraryRestorableField[], field: ItineraryRestorableField): void {
  if (field.currentValue !== field.historicalValue) fields.push(field)
}

/** 按稳定 ID 优先、再按唯一规范化名称关联历史地点。 */
function indexStops(itinerary: ItineraryOption): StopReference[] {
  return itinerary.days.flatMap((day) => day.stops.map((stop, index) => ({
    id: stop.id, day, index, stop, identity: normalizeIdentity(stop.name)
  })))
}

/** 按稳定 ID 优先、再按唯一类型和标题关联历史时段。 */
function indexScheduleBlocks(itinerary: ItineraryOption): ScheduleReference[] {
  return itinerary.days.flatMap((day) => day.scheduleBlocks.map((block, index) => ({
    id: block.id, day, index, block, identity: block.kind + '\u0000' + normalizeIdentity(block.title)
  })))
}

/** 让临时 ID 可通过唯一名称匹配；重复名称不猜测对象身份。 */
function matchReferences<T extends { id: string; identity: string }>(
  current: T[],
  historical: T[]
): Array<{ current: T; historical: T }> {
  return matchReferencesDetailed(current, historical).matches
}

/** 先按 ID 匹配，再只匹配两版中各出现一次的语义身份。 */
function matchReferencesDetailed<T extends { id: string; identity: string }>(
  current: T[],
  historical: T[]
): ReferenceMatch<T> {
  const currentById = new Map(current.map((item) => [item.id, item]))
  const usedCurrent = new Set<T>()
  const usedHistorical = new Set<T>()
  const matches: Array<{ current: T; historical: T }> = []

  for (const oldItem of historical) {
    const match = currentById.get(oldItem.id)
    if (!match || usedCurrent.has(match)) continue
    usedCurrent.add(match)
    usedHistorical.add(oldItem)
    matches.push({ current: match, historical: oldItem })
  }

  const currentGroups = groupByIdentity(current.filter((item) => !usedCurrent.has(item)))
  const historicalGroups = groupByIdentity(historical.filter((item) => !usedHistorical.has(item)))
  const identities = new Set([...currentGroups.keys(), ...historicalGroups.keys()])
  const ambiguous: ReferenceMatch<T>['ambiguous'] = []
  const ambiguousCurrent = new Set<T>()
  const ambiguousHistorical = new Set<T>()

  for (const identity of identities) {
    const currentGroup = currentGroups.get(identity) ?? []
    const historicalGroup = historicalGroups.get(identity) ?? []
    if (currentGroup.length === 1 && historicalGroup.length === 1) {
      const currentItem = currentGroup[0]
      const historicalItem = historicalGroup[0]
      if (!currentItem || !historicalItem) continue
      usedCurrent.add(currentItem)
      usedHistorical.add(historicalItem)
      matches.push({ current: currentItem, historical: historicalItem })
    } else if (currentGroup.length && historicalGroup.length && (currentGroup.length > 1 || historicalGroup.length > 1)) {
      currentGroup.forEach((item) => ambiguousCurrent.add(item))
      historicalGroup.forEach((item) => ambiguousHistorical.add(item))
      ambiguous.push({ identity, current: currentGroup, historical: historicalGroup })
    }
  }

  return {
    matches,
    currentOnly: current.filter((item) => !usedCurrent.has(item) && !ambiguousCurrent.has(item)),
    historicalOnly: historical.filter((item) => !usedHistorical.has(item) && !ambiguousHistorical.has(item)),
    ambiguous
  }
}

/** 把相同语义身份的行程对象分组，避免重复名称被错误合并。 */
function groupByIdentity<T extends { identity: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    if (!item.identity) continue
    const group = groups.get(item.identity) ?? []
    group.push(item)
    groups.set(item.identity, group)
  }
  return groups
}

/** 统一大小写、全半角和首尾空白，仅作历史对象身份匹配。 */
function normalizeIdentity(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase()
}

/** 将历史差异值转换为列表中可读的文字。 */
function displayValue(value: RestoreValue): string {
  if (value === null || value === '') return '未填写'
  if (value === 'meal') return '用餐'
  if (value === 'rest') return '休息'
  if (value === 'buffer') return '机动时间'
  return String(value)
}

const stopFields: Array<[StopField, string]> = [
  ['name', '名称'], ['area', '区域'], ['time', '时段'], ['durationMinutes', '停留分钟'],
  ['category', '类型'], ['notes', '说明'], ['transitToNext', '下一段交通说明']
]

const scheduleFields: Array<[ScheduleField, string]> = [
  ['kind', '安排类型'], ['title', '安排名称'], ['time', '时段'], ['durationMinutes', '时长'],
  ['area', '适用区域'], ['notes', '说明']
]
