/** 管理不可变版本、固定地点约束和行程差异摘要。 */
import type { ItineraryBudgetEstimate, ItineraryDay, ItineraryFactClaim, ItineraryOption, ItineraryRevision, ItineraryScheduleBlock, ItineraryStop, LodgingCommute, TransitEstimate } from './types.js'
import { BUDGET_CATEGORY_LABELS, BUDGET_COST_CATEGORIES, formatBudgetRange } from './budget.js'
import { itineraryEvidenceLabel, normalizeFactValue } from './itinerary-facts.js'
import { scheduleBlockKindLabel } from './itinerary-schedule.js'
import { lodgingCommuteBoundaryStop } from './itinerary-route-endpoints.js'

export type ItineraryChangeType = 'added' | 'removed' | 'moved' | 'updated'

export interface ItineraryChange {
  type: ItineraryChangeType
  title: string
  detail: string
  /** 交通影响在候选差异较多时优先展示，避免路线变更被普通字段淹没。 */
  impact?: 'transport'
  fromDay?: number
  toDay?: number
}

export interface ItineraryComparison {
  changes: ItineraryChange[]
  unchanged: boolean
}

export interface LockedStopPreservation {
  itinerary: ItineraryOption
  conflicts: string[]
}

export interface ExplicitlyExcludedItineraryStop {
  date: string
  stopId: string
  stopName: string
}

/** 从本轮明确删除指令中提取上一版行程的停靠点，不推测未提及的地点。 */
export function explicitlyExcludedItineraryStopsForRequest(
  request: string,
  previous: ItineraryOption,
  unchangedDates: string[] = []
): ExplicitlyExcludedItineraryStop[] {
  if (!request.trim()) return []
  const protectedDates = new Set(unchangedDates)
  const clauses = request.split(/[，,。；;！？!\n]+/u).filter((clause) => clause.trim())
  const excluded: ExplicitlyExcludedItineraryStop[] = []

  for (const day of previous.days) {
    if (!day.date || protectedDates.has(day.date)) continue
    for (const stop of day.stops) {
      if (clauses.some((clause) => clauseExcludesStop(clause, stop.name))) {
        excluded.push({ date: day.date, stopId: stop.id, stopName: stop.name })
      }
    }
  }

  return excluded
}

/** 比较用户要求删除的地点与候选名称，兼容常见城市前缀和地点后缀。 */
export function itineraryStopNameMatches(expectedName: string, candidateName: string): boolean {
  const expected = new Set(itineraryStopAliases(expectedName).map(normalizeStopMention))
  return itineraryStopAliases(candidateName).some((alias) => expected.has(normalizeStopMention(alias)))
}

/** 删除约束允许模型给同一地点补充“赏秋线路”等描述，但不扩大普通地点匹配。 */
export function explicitlyExcludedStopNameMatches(expectedName: string, candidateName: string): boolean {
  if (itineraryStopNameMatches(expectedName, candidateName)) return true

  const expectedAliases = itineraryStopRemovalAliases(expectedName).map(normalizeStopMention)
  return itineraryStopAliases(candidateName).some((alias) => {
    const normalized = normalizeStopMention(alias)
    return expectedAliases.some((expected) => expected.length >= 2 && normalized.startsWith(expected))
  })
}

/** 判断删除动作是否指向当前地点，而不是同一句中的保留或新增地点。 */
function clauseExcludesStop(clause: string, stopName: string): boolean {
  const actions = stopActions(clause)
  if (!actions.length) return false
  const normalizedClause = normalizedTextWithOffsets(clause)
  const mentions = itineraryStopRemovalAliases(stopName).flatMap((alias) => {
    const needle = normalizeStopMention(alias)
    if (!needle) return []
    const matches: Array<{ start: number; end: number }> = []
    let position = normalizedClause.value.indexOf(needle)
    while (position >= 0) {
      const lastIndex = position + needle.length - 1
      const start = normalizedClause.offsets[position]
      const end = normalizedClause.offsets[lastIndex]
      if (start !== undefined && end !== undefined) matches.push({ start, end: end + 1 })
      position = normalizedClause.value.indexOf(needle, position + 1)
    }
    return matches
  })
  if (!mentions.length) return false

  return mentions.some((mention) => {
    const nearestAction = actions.reduce<StopAction | undefined>((nearest, action) => {
      const distance = action.end <= mention.start
        ? mention.start - action.end
        : action.start >= mention.end ? action.start - mention.end : 0
      if (!nearest) return action
      const nearestDistance = nearest.end <= mention.start
        ? mention.start - nearest.end
        : nearest.start >= mention.end ? nearest.start - mention.end : 0
      return distance < nearestDistance ? action : nearest
    }, undefined)
    return nearestAction?.kind === 'remove'
  })
}

interface StopAction {
  kind: 'remove' | 'keep'
  start: number
  end: number
}

/** 找出句内删除与保留动作，避免把“保留 A、删除 B”误判为删除 A。 */
function stopActions(clause: string): StopAction[] {
  const actions: StopAction[] = []
  const removePatterns = [
    /不再安排|不要安排|别安排|不安排|不再去|不要去|别去|不去|不再看|不看|不再保留|不保留|不想去|不想看/gu,
    /移除|删除|删掉|删去|去掉|拿掉|取消|排除|剔除|撤掉|替换掉/gu
  ]
  const keepPatterns = [/继续安排|继续去|继续保留|仍然安排|仍安排|保留|安排|加入|添加|新增|替换成|替换为|换成|改为|想去|要去|纳入|保有/gu]

  for (const pattern of removePatterns) {
    for (const match of clause.matchAll(pattern)) {
      const start = match.index ?? 0
      const prefix = clause.slice(Math.max(0, start - 8), start)
      if (pattern === removePatterns[1] && /(?:不是|并非|不要|不必|无需|不用|不|别)\s*$/u.test(prefix)) continue
      actions.push({ kind: 'remove', start, end: start + match[0].length })
    }
  }
  for (const pattern of keepPatterns) {
    for (const match of clause.matchAll(pattern)) {
      const start = match.index ?? 0
      const prefix = clause.slice(Math.max(0, start - 8), start)
      const negated = /(?:不再|不要再|不想|不需要|不必|无需|不用|不|别再)\s*$/u.test(prefix)
      actions.push({
        kind: negated ? 'remove' : 'keep',
        start,
        end: start + match[0].length
      })
    }
  }
  return actions
}

/** 生成地点名常见短称；只移除城市前缀与明确的入口/场馆后缀。 */
function itineraryStopAliases(name: string): string[] {
  const aliases = new Set<string>()
  for (const part of name.split(/[（(]/u)) {
    let alias = part.replace(/[）)]/gu, '').trim()
    if (!alias) continue
    aliases.add(alias)
    alias = alias.replace(/^(?:中国|北京市|北京)/u, '')
    if (alias) aliases.add(alias)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const shorter = alias.replace(/(?:大学|东宫门|北宫门|南门|北门|东门|西门|入口|出口|遗址公园|博物馆|博物院|纪念馆|展览馆|风景区|步行街|大街|公园|景区)$/u, '')
      if (!shorter || shorter === alias) break
      alias = shorter
      aliases.add(alias)
    }
  }
  return [...aliases].filter((alias) => alias.length >= 2 &&
    !/^(?:大学|学校|景点|景区|公园|博物馆|博物院|纪念馆|展览馆|入口|出口|北京)$/u.test(alias))
}

/** 删除指令常用“香山”等简称；只为明确删除识别行程点名称的前缀。 */
function itineraryStopRemovalAliases(name: string): string[] {
  const aliases = new Set<string>()
  for (const alias of itineraryStopAliases(name)) {
    const normalized = normalizeStopMention(alias).replace(/^(?:中国|北京市|北京)/u, '')
    if (!normalized) continue
    aliases.add(normalized)
    const characters = [...normalized]
    for (let length = 2; length <= Math.min(characters.length, 8); length += 1) {
      aliases.add(characters.slice(0, length).join(''))
    }
  }
  return [...aliases]
}

/** 为地点别名建立字符偏移，方便将动作关联到中文句子中的具体名称。 */
function normalizedTextWithOffsets(text: string): { value: string; offsets: number[] } {
  let value = ''
  const offsets: number[] = []
  let sourceOffset = 0
  for (const character of text) {
    const normalized = character.normalize('NFKC').toLocaleLowerCase()
    if (!/[\s\p{P}\p{S}]/u.test(normalized)) {
      for (const outputCharacter of normalized) {
        value += outputCharacter
        offsets.push(sourceOffset)
      }
    }
    sourceOffset += character.length
  }
  return { value, offsets }
}

/** 统一地点别名的空白、全半角、标点和大小写。 */
function normalizeStopMention(value: string): string {
  return normalizedTextWithOffsets(value).value
}

/** 只在用户明确修改部分日期时，列出需要原样保留的其他日期。 */
export function unchangedItineraryDatesForRequest(
  request: string,
  previous: ItineraryOption
): string[] {
  if (!request.trim() || /重新规划|重新排|整体重做|全程|整趟|整份行程|全部日期|所有日期|每一天/u.test(request)) return []

  const datePattern = /(?:(20\d{2})\s*(?:年|[-/.]))?\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*(?:日|号)?/gu
  const references: Array<{ date: string; start: number; end: number; targeted: boolean }> = []
  const targetIndexes = new Set<number>()
  const addReference = (date: string | undefined, start: number, end: number): void => {
    if (!date) return
    const before = request.slice(Math.max(0, start - 10), start)
    const after = request.slice(end, end + 28)
    const clauseEnd = request.slice(end).search(/[，,。；;！？!\n]/u)
    const moveClause = request.slice(end, clauseEnd < 0 ? request.length : end + clauseEnd)
    const explicitlyTargeted = /(?:只|仅)\s*(?:(?:把|将|对|改|调整|修改|替换|核对|为|选择|补充|删除|移除)\s*)?$/u.test(before)
    const markedAsDestination = /(?:目标日期|目标日)\s*(?:(?:是|为)\s*)?[:：]?\s*$/u.test(before)
    const followsMoveVerb = /(?:移动|移|挪|安排|改|调整|调|放|换)(?:到|至|往|入)(?:指定)?(?:日期|那天)?\s*[:：]?\s*$/u.test(before)
    const followedByEdit = /^\s*(?:(?:日|号)\s*)?(?:(?:的)?(?:早餐|午餐|晚餐|行程|安排)\s*){0,2}(?:只|仅)?\s*(?:(?:把|将)\s*)?(?:改|调|删|移除|替换|换|取消|增加|减少|挪|提前|延后|缩短|延长|安排)/u.test(after)
    // “把某日的地点移到另一日”中，来源日同样属于本轮修改目标。
    const isMoveSource = /(?:把|将)\s*$/u.test(before) &&
      /(?:移动|移到|移至|挪到|挪至|搬到|搬至|调到|调至|调往|安排到|安排至|换到|换至|改到|改至)/u.test(moveClause)
    references.push({
      date, start, end,
      targeted: explicitlyTargeted || markedAsDestination || followsMoveVerb || followedByEdit || isMoveSource
    })
  }

  for (const match of request.matchAll(datePattern)) {
    const matchStart = match.index ?? 0
    const matchEnd = matchStart + match[0].length
    const year = match[1]
    const month = Number(match[2])
    const day = Number(match[3])
    if (month < 1 || month > 12 || day < 1 || day > 31) continue
    const candidates = previous.days.filter((item) => {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(item.date)) return false
      const sameMonthAndDay = Number(item.date.slice(5, 7)) === month && Number(item.date.slice(8, 10)) === day
      return sameMonthAndDay && (!year || Number(item.date.slice(0, 4)) === Number(year))
    })
    if (candidates.length === 1) addReference(candidates[0]!.date, matchStart, matchEnd)
  }

  // 支持“第 2 天 / 第二天”等相对日期，序号以当前草案的 dayNumber 为准。
  const ordinalPattern = /第\s*(\d{1,2}|[一二三四五六七八九十]{1,3})\s*天/gu
  for (const match of request.matchAll(ordinalPattern)) {
    const dayNumber = parseDayNumber(match[1] ?? '')
    const day = previous.days.find((item) => item.dayNumber === dayNumber)
    const start = match.index ?? 0
    if (day) addReference(day.date, start, start + match[0].length)
  }
  references.sort((left, right) => left.start - right.start)
  references.forEach((reference, index) => {
    if (reference.targeted) targetIndexes.add(index)
  })

  // “只调整 10/27 和 10/29”中的连写日期属于同一组修改目标。
  for (const index of [...targetIndexes]) {
    for (const direction of [-1, 1]) {
      let adjacentIndex = index + direction
      while (adjacentIndex >= 0 && adjacentIndex < references.length) {
        const leftIndex = Math.min(adjacentIndex, adjacentIndex - direction)
        const rightIndex = Math.max(adjacentIndex, adjacentIndex - direction)
        const between = request.slice(references[leftIndex]!.end, references[rightIndex]!.start)
        if (!/^\s*(?:、|和|与|及|以及)\s*$/u.test(between)) break
        targetIndexes.add(adjacentIndex)
        adjacentIndex += direction
      }
    }
  }

  if (targetIndexes.size === 0) return []
  const targets = new Set([...targetIndexes].map((index) => references[index]!.date))
  return previous.days.map((day) => day.date).filter((date) => date && !targets.has(date))
}

/** 将阿拉伯或常用中文序数转换为行程日序号。 */
function parseDayNumber(value: string): number | undefined {
  if (/^\d{1,2}$/u.test(value)) return Number(value)
  const digit: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (!value.includes('十')) return value.length === 1 ? digit[value] : undefined
  const [tens, ones = ''] = value.split('十')
  if ((tens && !digit[tens]) || (ones && !digit[ones])) return undefined
  return (tens ? digit[tens]! * 10 : 10) + (ones ? digit[ones]! : 0)
}

/** 将明确未涉及的日期沿用上一版，避免模型改写用户未要求调整的日程。 */
export function preserveUnchangedItineraryDays(
  previous: ItineraryOption | undefined,
  proposed: ItineraryOption,
  unchangedDates: string[]
): ItineraryOption {
  if (!previous || unchangedDates.length === 0) return proposed
  const preservedDates = new Set(unchangedDates)
  const previousByDate = new Map(previous.days.filter((day) => day.date).map((day) => [day.date, day]))
  const previousByDayNumber = new Map(previous.days.map((day) => [day.dayNumber, day]))
  let preservedCount = 0
  const days = proposed.days.map((day) => {
    const byDate = previousByDate.get(day.date)
    const byNumber = previousByDayNumber.get(day.dayNumber)
    const previousDay = byDate && preservedDates.has(byDate.date)
      ? byDate
      : byNumber && preservedDates.has(byNumber.date) ? byNumber : undefined
    if (!previousDay) return day
    preservedCount += 1
    // 校验器会补充事实状态和提示；复制后再验证，避免改写已保存的基线。
    return structuredClone(previousDay)
  })
  return preservedCount > 0 ? { ...proposed, days } : proposed
}

/** 单地点字段或排序修改只采用目标内容，保护同日未点名的既有安排。 */
export function preserveScopedItineraryEdits(
  request: string,
  previous: ItineraryOption | undefined,
  proposed: ItineraryOption,
  unchangedDates: string[] = []
): ItineraryOption {
  if (!previous || !request.trim()) return proposed
  const protectedDates = new Set(unchangedDates)
  const targetDays = previous.days.filter((day) => day.date && !protectedDates.has(day.date))
  if (targetDays.length !== 1) return proposed

  const baselineDay = targetDays[0]!
  const candidateDay = proposed.days.find((day) => day.date === baselineDay.date)
  if (!candidateDay) return proposed

  const scopes = request.split(/[。！？!?；;\n]+/u).flatMap((clause) => {
    // 修改值可能与其他地点同名；只从赋值语句左侧判断用户点名的对象。
    const targetText = explicitEditTargetText(clause)
    const mentionedStops = baselineDay.stops.filter((stop) => requestMentionsStop(targetText, stop.name))
    const editableFields = explicitlyEditedStopFields(clause)
    const matches = editableFields.has('transitToNext') && mentionedStops.length > 1
      ? outgoingTransitStartStop(clause, mentionedStops)
      : mentionedStops
    if (matches.length !== 1 || editableFields.size === 0) return []
    if (/(?:删除|移除|新增|添加|插入|跨日|移到|移至|移动到|排序|重排|调整顺序)/u.test(clause)) return []
    return [{ clause, baselineStop: matches[0]!, editableFields, renamedTo: requestedStopName(clause) }]
  })
  if (scopes.length === 0 && preserveSingleStopSupplementEdit(request, baselineDay, candidateDay)) return proposed
  if (scopes.length === 0 && preserveSingleScheduleBlockEdit(request, baselineDay, candidateDay)) return proposed
  if (scopes.length !== 1) {
    preserveStopOrderOnly(request, baselineDay, candidateDay)
    return proposed
  }

  const scope = scopes[0]!
  const normalizedNewName = scope.renamedTo ? normalizeStopMention(scope.renamedTo) : ''
  const candidateStops = candidateDay.stops.filter((stop) => {
    const normalizedName = normalizeStopMention(stop.name)
    return normalizedNewName
      ? normalizedName === normalizedNewName || normalizedName.includes(normalizedNewName)
      : itineraryStopNameMatches(scope.baselineStop.name, stop.name)
  })
  if (candidateStops.length !== 1) return proposed

  const candidateStop = candidateStops[0]!
  const baselineStop = scope.baselineStop
  restoreUneditedStopFields(baselineStop, candidateStop, scope.editableFields)
  if (scope.editableFields.has('transitToNext')) {
    candidateStop.transitToNext = requestedStopTransitDescription(scope.clause) ?? candidateStop.transitToNext
    delete candidateStop.transitEstimate
    candidateStop.factClaims = (candidateStop.factClaims ?? []).filter((claim) => claim.type !== 'transport-time')
  }
  restoreTargetDayShell(baselineDay, candidateDay)
  candidateDay.stops = baselineDay.stops.map((stop) =>
    stop.id === baselineStop.id ? candidateStop : structuredClone(stop)
  )
  return proposed
}

/** 恢复目标日的餐休和住宿接驳；单点修改不应顺带改写这些安排。 */
function restoreTargetDayShell(baseline: ItineraryDay, candidate: ItineraryDay): void {
  candidate.id = baseline.id
  candidate.dayNumber = baseline.dayNumber
  candidate.date = baseline.date
  candidate.title = baseline.title
  candidate.scheduleBlocks = structuredClone(baseline.scheduleBlocks)
  if (baseline.weather) candidate.weather = structuredClone(baseline.weather)
  else delete candidate.weather
  if (baseline.lodgingCommutes) candidate.lodgingCommutes = structuredClone(baseline.lodgingCommutes)
  else delete candidate.lodgingCommutes
}

/** 只接收被点名地点的预约事实或条件备选，避免模型顺手改写当天其他安排。 */
function preserveSingleStopSupplementEdit(request: string, baselineDay: ItineraryDay, candidateDay: ItineraryDay): boolean {
  const kind = /的预约、开放和门票信息/u.test(request) ? 'facts'
    : /的条件备选/u.test(request) ? 'alternatives' : undefined
  if (!kind) return false
  const target = request.split(/[。！？!?；;\n]/u)[0] ?? ''
  const matched = baselineDay.stops.filter((stop) => requestMentionsStop(target, stop.name))
  if (matched.length !== 1) return false
  const baselineStop = matched[0]!
  const candidates = candidateDay.stops.filter((stop) => itineraryStopNameMatches(baselineStop.name, stop.name))
  if (candidates.length !== 1) return false

  const proposedStop = candidates[0]!
  const updated = structuredClone(baselineStop)
  const removing = /(?:删除|清除|移除)(?:原有|已有|旧的)?(?:预约|开放|门票|备选)/u.test(request)
  if (kind === 'facts') {
    const relevant = new Set(['booking', 'opening-hours', 'ticket-price', 'closure'])
    const proposedFacts = (proposedStop.factClaims ?? []).filter((claim) => relevant.has(claim.type))
    if (proposedFacts.length || removing) {
      updated.factClaims = [
        ...(baselineStop.factClaims ?? []).filter((claim) => !relevant.has(claim.type)),
        ...structuredClone(proposedFacts)
      ]
      updated.sourceIds = [...new Set([...(baselineStop.sourceIds ?? []),
        ...proposedFacts.flatMap((claim) => claim.sourceId ? [claim.sourceId] : [])])]
    }
  } else if (proposedStop.conditionalAlternatives?.length || removing) {
    updated.conditionalAlternatives = structuredClone(proposedStop.conditionalAlternatives ?? [])
  }

  restoreTargetDayShell(baselineDay, candidateDay)
  candidateDay.stops = baselineDay.stops.map((stop) => stop.id === baselineStop.id ? updated : structuredClone(stop))
  return true
}

/** 单独修改餐休块时只接受明确字段，并沿用当天其他结构化安排。 */
function preserveSingleScheduleBlockEdit(
  request: string,
  baselineDay: ItineraryDay,
  candidateDay: ItineraryDay
): boolean {
  const scopes = request.split(/[。！？!?；;\n]+/u).flatMap((clause) => {
    const fields = explicitlyEditedScheduleBlockFields(clause)
    if (fields.size === 0 || /(?:删除|移除|新增|添加|插入|前后插入|跨日|移动到)/u.test(clause)) return []
    const titleMatches = baselineDay.scheduleBlocks.filter((block) => requestNamesScheduleBlock(clause, block))
    // 有明确标题时优先按标题定位，避免“午餐改成休息”同时命中已有休息块。
    const blocks = titleMatches.length > 0
      ? titleMatches
      : baselineDay.scheduleBlocks.filter((block) => requestMentionsScheduleBlock(clause, block))
    return blocks.length === 1 ? [{ clause, block: blocks[0]!, fields }] : []
  })
  if (scopes.length !== 1) return false

  const scope = scopes[0]!
  const requestedTitle = requestedScheduleBlockTitle(scope.clause)
  const idMatches = candidateDay.scheduleBlocks.filter((block) => block.id === scope.block.id)
  const requestedTitleMatches = requestedTitle
    ? candidateDay.scheduleBlocks.filter((block) => normalizeStopMention(block.title) === normalizeStopMention(requestedTitle))
    : []
  const originalTitleMatches = candidateDay.scheduleBlocks.filter((block) =>
    normalizeStopMention(block.title) === normalizeStopMention(scope.block.title))
  const matches = idMatches.length === 1 ? idMatches
    : requestedTitleMatches.length === 1 ? requestedTitleMatches
      : originalTitleMatches
  if (matches.length !== 1) return false

  const changedBlock = matches[0]!
  const requestedValues = requestedScheduleBlockValues(scope.clause)
  candidateDay.stops = structuredClone(baselineDay.stops)
  candidateDay.scheduleBlocks = baselineDay.scheduleBlocks.map((block) => {
    if (block.id !== scope.block.id) return structuredClone(block)
    const updated = structuredClone(block)
    if (scope.fields.has('kind')) updated.kind = requestedValues.kind ?? changedBlock.kind
    if (scope.fields.has('title')) updated.title = requestedValues.title ?? changedBlock.title
    if (scope.fields.has('time')) updated.time = requestedValues.time ?? changedBlock.time
    if (scope.fields.has('durationMinutes')) updated.durationMinutes = requestedValues.durationMinutes ?? changedBlock.durationMinutes
    if (scope.fields.has('area')) updated.area = requestedValues.area ?? changedBlock.area
    if (scope.fields.has('notes')) updated.notes = requestedValues.notes ?? changedBlock.notes
    return updated
  })
  candidateDay.id = baselineDay.id
  candidateDay.dayNumber = baselineDay.dayNumber
  candidateDay.date = baselineDay.date
  candidateDay.title = baselineDay.title
  if (baselineDay.weather) candidateDay.weather = structuredClone(baselineDay.weather)
  else delete candidateDay.weather
  if (baselineDay.lodgingCommutes) candidateDay.lodgingCommutes = structuredClone(baselineDay.lodgingCommutes)
  else delete candidateDay.lodgingCommutes
  return true
}

/** 从用户明确的字段赋值中识别餐休块可修改字段。 */
function explicitlyEditedScheduleBlockFields(clause: string): Set<ScheduleBlockContentField> {
  const fields = new Set<ScheduleBlockContentField>()
  if (/(?:时段|时间|时刻)\s*(?:改为|改成|调整为|设置为|设为)/u.test(clause)) fields.add('time')
  if (/(?:时长|持续时间)\s*(?:改为|改成|调整为|设置为|设为)\s*\d+\s*(?:分钟|小时)/u.test(clause)) {
    fields.add('durationMinutes')
  }
  if (/(?:类型|类别)\s*(?:改为|改成|调整为|设置为|设为)\s*(?:用餐|休息|机动|缓冲)/u.test(clause)) fields.add('kind')
  if (/(?:标题|名称)\s*(?:改为|改成|调整为|设置为|设为)/u.test(clause)) fields.add('title')
  if (/(?:片区|区域|地区)\s*(?:改为|改成|调整为|设置为|设为)/u.test(clause)) fields.add('area')
  if (/(?:说明|备注)\s*(?:改为|改成|调整为|设置为|设为)/u.test(clause)) fields.add('notes')
  return fields
}

/** 用当天已有标题或明确类别识别餐、休息和机动时间块。 */
function requestMentionsScheduleBlock(clause: string, block: ItineraryScheduleBlock): boolean {
  const normalizedClause = normalizeStopMention(clause)
  const aliases = new Set([block.title])
  if (block.kind === 'meal') {
    for (const alias of ['早餐', '早饭', '午餐', '午饭', '晚餐', '晚饭']) aliases.add(alias)
  } else if (block.kind === 'rest') {
    aliases.add('休息')
    aliases.add('午休')
  } else {
    aliases.add('缓冲')
    aliases.add('机动时间')
  }
  return [...aliases].some((alias) => {
    const normalizedAlias = normalizeStopMention(alias)
    return normalizedAlias.length >= 2 && normalizedClause.includes(normalizedAlias)
  })
}

/** 精确标题优先用于消歧，类别别名只在用户未点名标题时兜底。 */
function requestNamesScheduleBlock(clause: string, block: ItineraryScheduleBlock): boolean {
  const title = normalizeStopMention(block.title)
  return title.length >= 2 && normalizeStopMention(clause).includes(title)
}

/** 读取标题修改的新值，让模型重命名后仍能唯一找到原时间块。 */
function requestedScheduleBlockTitle(clause: string): string | undefined {
  return requestedScheduleBlockTextValue(clause, '标题|名称')
}

/** 从明确赋值中读取可安全识别的字段值；未识别时继续使用模型候选值。 */
function requestedScheduleBlockValues(clause: string): Partial<Pick<ItineraryScheduleBlock,
  'kind' | 'title' | 'time' | 'durationMinutes' | 'area' | 'notes'>> {
  const values: Partial<Pick<ItineraryScheduleBlock,
    'kind' | 'title' | 'time' | 'durationMinutes' | 'area' | 'notes'>> = {}
  const time = clause.match(/(?:时段|时间|时刻)\s*(?:改为|改成|调整为|设置为|设为)\s*((?:[01]?\d|2[0-3]):[0-5]\d)(?:\s*(?:–|—|-|至|到)\s*((?:[01]?\d|2[0-3]):[0-5]\d))?/u)
  if (time) values.time = `${formatRequestedClockTime(time[1]!)}${time[2] ? `–${formatRequestedClockTime(time[2])}` : ''}`

  const duration = clause.match(/(?:时长|持续时间)\s*(?:改为|改成|调整为|设置为|设为)\s*(\d+(?:\.\d+)?)\s*(分钟|小时)/u)
  if (duration) values.durationMinutes = Math.round(Number(duration[1]) * (duration[2] === '小时' ? 60 : 1))

  const kind = clause.match(/(?:类型|类别)\s*(?:改为|改成|调整为|设置为|设为)\s*(用餐|餐饮|进餐|早餐|午餐|晚餐|休息|午休|机动|缓冲)/u)?.[1]
  if (kind) values.kind = /休息|午休/u.test(kind) ? 'rest' : /机动|缓冲/u.test(kind) ? 'buffer' : 'meal'

  values.title = requestedScheduleBlockTextValue(clause, '标题|名称')
  values.area = requestedScheduleBlockTextValue(clause, '片区|区域|地区')
  values.notes = requestedScheduleBlockTextValue(clause, '说明|备注')
  return values
}

/** 读取引号内或逗号前的明确文本值，不从后续字段借用内容。 */
function requestedScheduleBlockTextValue(clause: string, fieldPattern: string): string | undefined {
  const match = clause.match(new RegExp(
    `(?:${fieldPattern})\\s*(?:改为|改成|调整为|设置为|设为)\\s*(?:[“"「『]([^”"」』]+)[”"」』]|([^，,；;。]+))`, 'u'
  ))
  const value = (match?.[1] ?? match?.[2])?.trim().replace(/^[“"「『]+|[”"」』]+$/gu, '').trim()
  return value || undefined
}

/** 统一明确修改中常见的单数字小时写法。 */
function formatRequestedClockTime(value: string): string {
  const [hour, minute] = value.split(':')
  return `${hour!.padStart(2, '0')}:${minute}`
}

/** 去掉显式字段赋值的右侧，只保留目标对象上下文。 */
function explicitEditTargetText(clause: string): string {
  const assignment = /(?:建议停留|建议游玩|建议游览|停留时长|停留时间|游玩时长|游览时长|时长|持续时间|时段|时间|时刻|片区|区域|地区|类别|分类|类型|标题|名称|名字|说明|备注|接驳(?:方式|路线)?|下一段交通(?:方式|路线)?|交通方式|路线)\s*(?:改为|改成|调整为|设置为|设为|重命名为|为)/u
  const index = clause.search(assignment)
  return index < 0 ? clause : clause.slice(0, index)
}

type ScheduleBlockContentField = 'kind' | 'title' | 'time' | 'durationMinutes' | 'area' | 'notes'

/** 从候选中保留用户修改字段，其余地点字段沿用最近一版。 */
function restoreUneditedStopFields(
  baseline: ItineraryStop,
  candidate: ItineraryStop,
  editableFields: ReadonlySet<StopContentField>
): void {
  const proposed = structuredClone(candidate)
  Object.assign(candidate, structuredClone(baseline))
  for (const field of editableFields) {
    switch (field) {
      case 'name': candidate.name = proposed.name; break
      case 'area': candidate.area = proposed.area; break
      case 'time': candidate.time = proposed.time; break
      case 'durationMinutes': candidate.durationMinutes = proposed.durationMinutes; break
      case 'category': candidate.category = proposed.category; break
      case 'notes': candidate.notes = proposed.notes; break
      case 'transitToNext': candidate.transitToNext = proposed.transitToNext; break
    }
  }
}

/** 只重排停靠点时保留餐休、日主题和每个地点的非时间字段。 */
function preserveStopOrderOnly(
  request: string,
  baseline: ItineraryDay,
  candidate: ItineraryDay
): boolean {
  const requestedOrder = /(?:只|仅)[^。！？!?；;\n]{0,48}(?:顺序|排序|重排)/u.test(request)
  if (!requestedOrder || /(?:删除|移除|新增|添加|插入|跨日|移到|移至|移动到)/u.test(request)) return false
  const editableFields = new Set<StopContentField>()
  if (/(?:时段|时间|时刻)\s*(?:(?:依次|分别|统一)\s*)?(?:改为|改成|调整为|设置为|设为|为)/u.test(request)) {
    editableFields.add('time')
  }
  if (candidate.stops.length !== baseline.stops.length) return false

  const matchedStops = new Set<string>()
  for (const stop of candidate.stops) {
    const candidateName = normalizeStopMention(stop.name)
    const matches = baseline.stops.filter((original) => normalizeStopMention(original.name) === candidateName)
    if (matches.length !== 1 || matchedStops.has(matches[0]!.id)) return false
    matchedStops.add(matches[0]!.id)
    restoreUneditedStopFields(matches[0]!, stop, editableFields)
  }
  if (matchedStops.size !== baseline.stops.length) return false
  restoreTargetDayShell(baseline, candidate)
  return true
}

/** 仅从单句明确赋值中读取可修改字段，不把“保持原样”误认为修改。 */
function explicitlyEditedStopFields(clause: string): Set<StopContentField> {
  const fields = new Set<StopContentField>()
  if (/(?:名称|名字)\s*(?:改为|改成|调整为|设置为|设为|重命名为)/u.test(clause)) fields.add('name')
  if (/(?:时段|时间|时刻)\s*(?:(?:依次|分别|统一)\s*)?(?:改为|改成|调整为|设置为|设为|为|提前|延后|推迟|顺延|挪到)/u.test(clause)) {
    fields.add('time')
  }
  if (/(?:建议停留|建议游玩|建议游览|停留时长|停留时间|游玩时长|游览时长)\s*(?:(?:改为|改成|调整为|设置为|设为|为)\s*)?\d+\s*(?:分钟|小时)|时长\s*(?:改为|改成|调整为|设置为|设为)\s*\d+\s*(?:分钟|小时)/u.test(clause)) {
    fields.add('durationMinutes')
  }
  if (/(?:片区|区域|地区|所在区域)\s*(?:改为|改成|调整为|设置为|设为)/u.test(clause)) fields.add('area')
  if (/(?:类别|分类|类型)\s*(?:改为|改成|调整为|设置为|设为)/u.test(clause)) fields.add('category')
  if (/(?:说明|备注)\s*(?:改为|改成|调整为|设置为|设为)/u.test(clause)) fields.add('notes')
  if (/(?:接驳(?:方式|路线)?|下一段交通(?:方式|路线)?|交通方式|路线)\s*(?:改为|改成|调整为|设置为|设为)/u.test(clause)) {
    fields.add('transitToNext')
  }
  return fields
}

type StopContentField = 'name' | 'area' | 'time' | 'durationMinutes' | 'category' | 'notes' | 'transitToNext'

/** 检查当前句子是否点名了该基线地点，忽略空格、标点和常见地点后缀。 */
function requestMentionsStop(request: string, stopName: string): boolean {
  const normalizedRequest = normalizeStopMention(request)
  const aliases = itineraryStopAliases(stopName).filter((alias) => !/^(?:大学|学校)$/u.test(alias))
  if (stopName.endsWith('大学')) {
    const shortName = stopName.slice(0, -2).replace(/^(?:中国|北京市|北京)/u, '')
    if ([...shortName].length >= 2) aliases.push(shortName)
  }
  return aliases.some((alias) => {
    const normalizedAlias = normalizeStopMention(alias)
    return normalizedAlias.length >= 2 && normalizedRequest.includes(normalizedAlias)
  })
}

/** 相邻路段的去向写了两处地点时，接驳字段归属箭头前的起点。 */
function outgoingTransitStartStop(clause: string, mentionedStops: ItineraryStop[]): ItineraryStop[] {
  const positioned = mentionedStops.flatMap((stop) => {
    const range = stopMentionRange(clause, stop.name)
    return range ? [{ stop, ...range }] : []
  }).sort((left, right) => left.start - right.start)
  const first = positioned[0]
  const second = positioned[1]
  if (!first || !second) return []
  const connector = clause.slice(first.end, second.start)
  return /(?:到|至|前往|去|→|->)/u.test(connector) ? [first.stop] : []
}

/** 返回地点在请求中的首个精确别名区间，供识别有向路线端点使用。 */
function stopMentionRange(request: string, stopName: string): { start: number; end: number } | undefined {
  const normalizedRequest = normalizedTextWithOffsets(request)
  const aliases = itineraryStopAliases(stopName).filter((alias) => !/^(?:大学|学校)$/u.test(alias))
  if (stopName.endsWith('大学')) {
    const shortName = stopName.slice(0, -2).replace(/^(?:中国|北京市|北京)/u, '')
    if ([...shortName].length >= 2) aliases.push(shortName)
  }
  const ranges = aliases.flatMap((alias) => {
    const needle = normalizeStopMention(alias)
    const position = normalizedRequest.value.indexOf(needle)
    if (!needle || position < 0) return []
    const lastIndex = position + needle.length - 1
    const start = normalizedRequest.offsets[position]
    const end = normalizedRequest.offsets[lastIndex]
    return start === undefined || end === undefined ? [] : [{ start, end: end + 1 }]
  }).sort((left, right) => left.start - right.start || right.end - left.end)
  return ranges[0]
}

/** 提取用户明确给出的更名结果，用于把模型新名称映射回原地点。 */
function requestedStopName(clause: string): string | undefined {
  const match = clause.match(/(?:名称|名字)\s*(?:改为|改成|调整为|设置为|设为|重命名为)\s*[“"「『]?([^”"」』，,；;。]+)/u)
  const name = match?.[1]?.trim()
  return name ? name.replace(/[“"「『”"」』]+/gu, '').trim() || undefined : undefined
}

/** 读取用户明确填写的接驳值，防止模型改成其他交通方式。 */
function requestedStopTransitDescription(clause: string): string | undefined {
  const match = clause.match(/(?:接驳(?:方式|路线|说明)?|下一段交通(?:方式|路线)?|交通方式|路线)\s*(?:改为|改成|调整为|设置为|设为)\s*[：:]?\s*([^，,。；;！？!?]+)/u)
  const description = match?.[1]?.trim().replace(/^[“"「『]|[”"」』]$/gu, '').trim()
  return description || undefined
}

interface LocatedStop {
  key: string
  dayNumber: number
  stop: ItineraryStop
}

interface LocatedScheduleBlock {
  key: string
  dayNumber: number
  block: ItineraryScheduleBlock
}

interface IndexedStop {
  key: string
  day: ItineraryOption['days'][number]
  index: number
  stop: ItineraryStop
}

/** 返回活动版本之前编号最大的快照，历史数组的存储顺序不影响选择。 */
export function previousItineraryRevision(
  revisions: ItineraryRevision[],
  activeRevisionId: string | null
): ItineraryRevision | null {
  const active = revisions.find((revision) => revision.id === activeRevisionId)
  if (!active) return null

  return revisions.reduce<ItineraryRevision | null>((previous, revision) => {
    if (revision.number >= active.number || (previous && revision.number <= previous.number)) return previous
    return revision
  }, null)
}

/** 保留用户固定的地点、所在日期与时段；手动编辑仅能先解除固定再修改。 */
export function preserveLockedStops(
  previous: ItineraryOption | undefined,
  proposed: ItineraryOption,
  allowExplicitUnlock = false
): LockedStopPreservation {
  const itinerary: ItineraryOption = {
    ...proposed,
    days: proposed.days.map((day) => ({ ...day, stops: day.stops.map((stop) => ({ ...stop })) }))
  }
  if (!previous) return { itinerary, conflicts: [] }

  const previousStops = indexStops(previous)
  const nextStops = indexStops(itinerary)
  const nextByKey = new Map(nextStops.map((entry) => [entry.key, entry]))
  const nextById = new Map(nextStops.map((entry) => [entry.stop.id, entry]))
  const conflicts: string[] = []
  const preserved: Array<{ previous: IndexedStop; next: IndexedStop }> = []

  for (const oldEntry of previousStops.filter((entry) => entry.stop.locked)) {
    const nextEntry = nextByKey.get(oldEntry.key) ?? (allowExplicitUnlock ? nextById.get(oldEntry.stop.id) : undefined)
    if (!nextEntry) {
      conflicts.push(`固定地点“${oldEntry.stop.name}”在新行程中缺失；请先解除固定，再删除或更名。`)
      continue
    }
    if (allowExplicitUnlock && nextEntry.stop.locked === false) continue

    const oldName = oldEntry.stop.name.normalize('NFKC').trim().toLocaleLowerCase()
    const nextName = nextEntry.stop.name.normalize('NFKC').trim().toLocaleLowerCase()
    if (oldName !== nextName) {
      conflicts.push(`固定地点“${oldEntry.stop.name}”不能直接更名；请先解除固定并保存。`)
      continue
    }

    const oldDate = oldEntry.day.date
    if (oldEntry.day.dayNumber !== nextEntry.day.dayNumber) {
      conflicts.push(`固定地点“${oldEntry.stop.name}”从第 ${oldEntry.day.dayNumber} 天移到了第 ${nextEntry.day.dayNumber} 天。`)
      continue
    }
    if (oldDate && oldDate !== nextEntry.day.date) {
      conflicts.push(`固定地点“${oldEntry.stop.name}”所在日期从 ${oldDate} 改为 ${nextEntry.day.date || '未确定'}。`)
      continue
    }
    if (oldEntry.stop.time !== nextEntry.stop.time) {
      conflicts.push(`固定地点“${oldEntry.stop.name}”的时段从“${oldEntry.stop.time || '未安排'}”改为“${nextEntry.stop.time || '未安排'}”。`)
      continue
    }
    if (oldEntry.stop.location && nextEntry.stop.location && !sameCoordinates(oldEntry.stop.location, nextEntry.stop.location)) {
      conflicts.push(`固定地点“${oldEntry.stop.name}”的地图位置发生变化。`)
      continue
    }
    if (oldEntry.stop.location && !nextEntry.stop.location) nextEntry.stop.location = { ...oldEntry.stop.location }
    nextEntry.stop.locked = true
    preserved.push({ previous: oldEntry, next: nextEntry })
  }

  const previousAnchorsByDay = groupByDay(preserved.map((entry) => entry.previous))
  const nextAnchorsByDay = groupByDay(preserved.map((entry) => entry.next))
  for (const [dayNumber, oldAnchors] of previousAnchorsByDay) {
    const nextAnchors = nextAnchorsByDay.get(dayNumber) ?? []
    const oldOrder = [...oldAnchors].sort((left, right) => left.index - right.index).map((entry) => entry.key)
    const nextOrder = [...nextAnchors].sort((left, right) => left.index - right.index).map((entry) => entry.key)
    if (oldOrder.some((key, index) => nextOrder[index] !== key)) {
      conflicts.push(`第 ${dayNumber} 天的固定地点顺序发生变化。`)
    }
  }

  return { itinerary, conflicts: [...new Set(conflicts)] }
}

/** 比较两个已确认地图点的坐标系和经纬度。 */
function sameCoordinates(left: NonNullable<ItineraryStop['location']>, right: NonNullable<ItineraryStop['location']>): boolean {
  return left.coordinateSystem === right.coordinateSystem && left.latitude === right.latitude && left.longitude === right.longitude
}

/** 对两个版本中的地点、顺序、日期和时间字段做可解释的结构化比较。 */
export function compareItineraries(previous: ItineraryOption, proposed: ItineraryOption): ItineraryComparison {
  const oldStops = locateStops(previous)
  const newStops = locateStops(proposed)
  const oldByKey = new Map(oldStops.map((item) => [item.key, item]))
  const newByKey = new Map(newStops.map((item) => [item.key, item]))
  const changes: ItineraryChange[] = []

  for (const oldItem of oldStops) {
    const nextItem = newByKey.get(oldItem.key)
    if (!nextItem) {
      changes.push({
        type: 'removed', title: oldItem.stop.name, detail: `从第 ${oldItem.dayNumber} 天移除`, fromDay: oldItem.dayNumber
      })
      continue
    }
    if (oldItem.dayNumber !== nextItem.dayNumber) {
      changes.push({
        type: 'moved', title: oldItem.stop.name,
        detail: `从第 ${oldItem.dayNumber} 天移到第 ${nextItem.dayNumber} 天`,
        fromDay: oldItem.dayNumber, toDay: nextItem.dayNumber
      })
    }
    const transitChange = compareTransitEstimate(oldItem.stop.transitEstimate, nextItem.stop.transitEstimate)
    const changedFields = compareStopFields(oldItem.stop, nextItem.stop, transitChange)
    if (changedFields.length) {
      changes.push({
        type: 'updated', title: oldItem.stop.name, detail: changedFields.join('；'),
        ...(transitChange || oldItem.stop.transitToNext !== nextItem.stop.transitToNext ? { impact: 'transport' } : {}),
        fromDay: oldItem.dayNumber, toDay: nextItem.dayNumber
      })
    }
  }

  for (const nextItem of newStops) {
    if (!oldByKey.has(nextItem.key)) {
      changes.push({ type: 'added', title: nextItem.stop.name, detail: `加入第 ${nextItem.dayNumber} 天`, toDay: nextItem.dayNumber })
    }
  }

  const oldBlocks = locateScheduleBlocks(previous)
  const newBlocks = locateScheduleBlocks(proposed)
  const oldBlocksByKey = new Map(oldBlocks.map((item) => [item.key, item]))
  const newBlocksByKey = new Map(newBlocks.map((item) => [item.key, item]))
  for (const oldItem of oldBlocks) {
    const nextItem = newBlocksByKey.get(oldItem.key)
    if (!nextItem) {
      changes.push({ type: 'removed', title: oldItem.block.title, detail: `从第 ${oldItem.dayNumber} 天移除${scheduleBlockKindLabel(oldItem.block.kind)}安排`, fromDay: oldItem.dayNumber })
      continue
    }
    if (oldItem.dayNumber !== nextItem.dayNumber) {
      changes.push({ type: 'moved', title: oldItem.block.title, detail: `从第 ${oldItem.dayNumber} 天移到第 ${nextItem.dayNumber} 天`, fromDay: oldItem.dayNumber, toDay: nextItem.dayNumber })
    }
    const fields = compareScheduleBlockFields(oldItem.block, nextItem.block)
    if (fields.length) {
      changes.push({ type: 'updated', title: oldItem.block.title, detail: fields.join('；'), fromDay: oldItem.dayNumber, toDay: nextItem.dayNumber })
    }
  }
  for (const nextItem of newBlocks) {
    if (!oldBlocksByKey.has(nextItem.key)) {
      changes.push({ type: 'added', title: nextItem.block.title, detail: `加入第 ${nextItem.dayNumber} 天的${scheduleBlockKindLabel(nextItem.block.kind)}安排`, toDay: nextItem.dayNumber })
    }
  }

  const movedKeys = new Set(oldStops.flatMap((item) => {
    const nextItem = newByKey.get(item.key)
    return nextItem && nextItem.dayNumber !== item.dayNumber ? [item.key] : []
  }))
  const oldDays = indexDays(previous)
  const nextDays = indexDays(proposed)
  for (const [dayNumber, oldDay] of oldDays) {
    const nextDay = nextDays.get(dayNumber)
    if (!nextDay) continue
    const oldKeys = oldDay.stops.map((stop) => findLocatedKey(stop, dayNumber, oldStops)).filter((key): key is string => !!key)
    const nextKeys = nextDay.stops.map((stop) => findLocatedKey(stop, dayNumber, newStops)).filter((key): key is string => !!key)
    const commonKeys = new Set(oldKeys.filter((key) => newByKey.get(key)?.dayNumber === dayNumber))
    const oldOrder = oldKeys.filter((key) => commonKeys.has(key))
    const nextOrder = nextKeys.filter((key) => commonKeys.has(key))
    const stableKeys = longestCommonSubsequence(oldOrder, nextOrder)
    for (const key of oldOrder) {
      if (stableKeys.has(key) || movedKeys.has(key)) continue
      const item = oldByKey.get(key)
      if (!item) continue
      changes.push({ type: 'moved', title: item.stop.name, detail: `在第 ${dayNumber} 天调整顺序`, fromDay: dayNumber, toDay: dayNumber })
    }
  }

  for (const [dayNumber, oldDay] of oldDays) {
    const nextDay = nextDays.get(dayNumber)
    if (!nextDay) continue
    const fields: string[] = []
    if (oldDay.date !== nextDay.date) fields.push(`日期：${displayValue(oldDay.date)} → ${displayValue(nextDay.date)}`)
    if (oldDay.title !== nextDay.title) fields.push(`主题：${displayValue(oldDay.title)} → ${displayValue(nextDay.title)}`)
    if (serializeDailyWeather(oldDay.weather) !== serializeDailyWeather(nextDay.weather)) {
      fields.push(`天气：${dailyWeatherSummary(oldDay.weather)} → ${dailyWeatherSummary(nextDay.weather)}`)
    }
    if (fields.length) changes.push({ type: 'updated', title: `第 ${dayNumber} 天`, detail: fields.join('；'), fromDay: dayNumber, toDay: dayNumber })
  }

  const allDayNumbers = new Set([...oldDays.keys(), ...nextDays.keys()])
  for (const dayNumber of allDayNumbers) {
    const oldDay = oldDays.get(dayNumber)
    const nextDay = nextDays.get(dayNumber)
    changes.push(...compareLodgingCommutes(oldDay, nextDay))
    if (oldDay && !nextDay && isEmptyDay(oldDay)) {
      changes.push({ type: 'removed', title: `第 ${dayNumber} 天`, detail: `空白日程移除${oldDay.date ? `（${oldDay.date}）` : ''}`, fromDay: dayNumber })
    } else if (nextDay && !oldDay && isEmptyDay(nextDay)) {
      changes.push({ type: 'added', title: `第 ${dayNumber} 天`, detail: `新增空白日程${nextDay.date ? `（${nextDay.date}）` : ''}`, toDay: dayNumber })
    }
  }
  if (previous.title !== proposed.title) {
    changes.push({ type: 'updated', title: '方案名称', detail: `${displayValue(previous.title)} → ${displayValue(proposed.title)}` })
  }
  if (previous.summary !== proposed.summary) {
    changes.push({ type: 'updated', title: '方案摘要', detail: `${displayValue(previous.summary)} → ${displayValue(proposed.summary)}` })
  }
  if (previous.tradeoffs !== proposed.tradeoffs) {
    changes.push({ type: 'updated', title: '安排取舍', detail: `${displayValue(previous.tradeoffs)} → ${displayValue(proposed.tradeoffs)}` })
  }
  const budgetChange = compareBudgetEstimate(previous.budgetEstimate, proposed.budgetEstimate)
  if (budgetChange) changes.push({ type: 'updated', title: '预算估算', detail: budgetChange })

  return { changes, unchanged: changes.length === 0 }
}

/** 比较逐日天气状态和来源，防止天气变化在修订预览中被隐藏。 */
function serializeDailyWeather(weather: ItineraryDay['weather']): string {
  return weather ? JSON.stringify({ status: weather.status, summary: weather.summary, sourceId: weather.sourceId ?? '' }) : ''
}

/** 将逐日天气差异压缩为用户可读的状态，不在差异面板重复整条预报。 */
function dailyWeatherSummary(weather: ItineraryDay['weather']): string {
  if (!weather) return '未提供'
  const status = weather.status === 'forecast' ? '天气预报' : '天气未知'
  return `${status}${weather.summary ? `（${weather.summary.slice(0, 48)}）` : ''}`
}

/** 比较预算明细时忽略模型临时生成的 ID 和费用项顺序。 */
function compareBudgetEstimate(previous: ItineraryBudgetEstimate | undefined, proposed: ItineraryBudgetEstimate | undefined): string | null {
  if (serializeBudgetEstimate(previous) === serializeBudgetEstimate(proposed)) return null
  return `费用明细、依据或来源已更新：${budgetEstimateSummary(previous)} → ${budgetEstimateSummary(proposed)}`
}

/** 生成对比预览中的保守金额概览，待核验或缺失类别不计为零元。 */
function budgetEstimateSummary(estimate: ItineraryBudgetEstimate | undefined): string {
  if (!estimate) return '未提供预算估算'
  const pricedItems = estimate.items.filter((item) => item.evidenceLevel !== 'pending' &&
    item.amountMinFen !== null && item.amountMaxFen !== null)
  const minimum = pricedItems.reduce((sum, item) => sum + item.amountMinFen! * item.quantity, 0)
  const maximum = pricedItems.reduce((sum, item) => sum + item.amountMaxFen! * item.quantity, 0)
  const represented = new Set(estimate.items.map((item) => item.category))
  const pending = new Set(estimate.items.filter((item) => item.evidenceLevel === 'pending' ||
    item.amountMinFen === null || item.amountMaxFen === null).map((item) => item.category))
  const excluded = new Set(estimate.notApplicableCategories.map((item) => item.category))
  const unresolved = BUDGET_COST_CATEGORIES.filter((category) => pending.has(category) ||
    (!represented.has(category) && !excluded.has(category)))
  const amount = pricedItems.length ? formatBudgetRange(minimum, maximum) : '无可计算金额'
  const caveat = unresolved.length ? `；待核验/未列出：${unresolved.map((category) => BUDGET_CATEGORY_LABELS[category]).join('、')}` : ''
  return `${amount}${caveat}`
}

/** 使用费用内容而非临时 ID 识别预算变化，并忽略项目排列顺序。 */
function serializeBudgetEstimate(estimate: ItineraryBudgetEstimate | undefined): string {
  if (!estimate) return ''
  const items = estimate.items.map(({ id: _id, ...item }) => ({
    ...item,
    sourceIds: [...item.sourceIds].sort()
  })).sort((left, right) => `${left.category}\u0000${left.title}`.localeCompare(`${right.category}\u0000${right.title}`))
  const notApplicableCategories = [...estimate.notApplicableCategories]
    .sort((left, right) => left.category.localeCompare(right.category))
  return JSON.stringify({ currency: estimate.currency, items, notApplicableCategories })
}

/** 给每次出现的同名地点单独编号，以便行程内重复到访时稳定匹配。 */
function locateStops(itinerary: ItineraryOption): LocatedStop[] {
  const occurrences = new Map<string, number>()
  return itinerary.days.flatMap((day) => day.stops.map((stop) => {
    const normalizedName = stop.name.normalize('NFKC').trim().toLocaleLowerCase()
    const occurrence = (occurrences.get(normalizedName) ?? 0) + 1
    occurrences.set(normalizedName, occurrence)
    return { key: `${normalizedName}#${occurrence}`, dayNumber: day.dayNumber, stop }
  }))
}

/** 以类型和标题匹配模型新生成的时段，允许其临时 ID 变化。 */
function locateScheduleBlocks(itinerary: ItineraryOption): LocatedScheduleBlock[] {
  const occurrences = new Map<string, number>()
  return itinerary.days.flatMap((day) => (day.scheduleBlocks ?? []).map((block) => {
    const identity = `${block.kind}\u0000${block.title.normalize('NFKC').trim().toLocaleLowerCase()}`
    const occurrence = (occurrences.get(identity) ?? 0) + 1
    occurrences.set(identity, occurrence)
    return { key: `${identity}#${occurrence}`, dayNumber: day.dayNumber, block }
  }))
}

/** 比较同一地点的可见安排字段；不依赖模型侧生成的临时 ID。 */
function compareStopFields(previous: ItineraryStop, proposed: ItineraryStop, transitChange: string | null): string[] {
  const fields: Array<[string, string | number | null, string | number | null]> = [
    ['区域', previous.area, proposed.area],
    ['时段', previous.time, proposed.time],
    ['停留时间', previous.durationMinutes, proposed.durationMinutes],
    ['类型', previous.category, proposed.category],
    ['说明', previous.notes, proposed.notes],
    ['下一段交通', previous.transitToNext, proposed.transitToNext],
    ['固定安排', previous.locked ? '已固定' : '未固定', proposed.locked ? '已固定' : '未固定'],
    ['依据状态', itineraryEvidenceLabel(previous.evidenceLevel ?? 'pending'), itineraryEvidenceLabel(proposed.evidenceLevel ?? 'pending')]
  ]
  const changes = fields.filter(([, oldValue, nextValue]) => oldValue !== nextValue)
    .map(([label, oldValue, nextValue]) => `${label}：${displayValue(oldValue)} → ${displayValue(nextValue)}`)
  if (transitChange) changes.push(transitChange)
  const oldSourceIds = [...(previous.sourceIds ?? [])].sort()
  const proposedSourceIds = [...(proposed.sourceIds ?? [])].sort()
  if (oldSourceIds.join('\u0000') !== proposedSourceIds.join('\u0000')) {
    const sourceChange = oldSourceIds.length === proposedSourceIds.length
      ? `来源关联已更新（${proposedSourceIds.length} 条）`
      : `来源关联：${oldSourceIds.length} 条 → ${proposedSourceIds.length} 条`
    changes.push(sourceChange)
  }
  const oldFacts = serializeFactClaims(previous.factClaims)
  const proposedFacts = serializeFactClaims(proposed.factClaims)
  if (oldFacts !== proposedFacts) {
    const oldCount = previous.factClaims?.length ?? 0
    const nextCount = proposed.factClaims?.length ?? 0
    changes.push(`事实声明已更新（${oldCount} 条 → ${nextCount} 条）`)
  }
  const oldAlternatives = serializeConditionalAlternatives(previous)
  const proposedAlternatives = serializeConditionalAlternatives(proposed)
  if (oldAlternatives !== proposedAlternatives) {
    changes.push(`条件备选已更新：${summarizeConditionalAlternatives(previous)} → ${summarizeConditionalAlternatives(proposed)}`)
  }
  const oldLocation = previous.location ? `${previous.location.latitude},${previous.location.longitude}` : ''
  const nextLocation = proposed.location ? `${proposed.location.latitude},${proposed.location.longitude}` : ''
  if (oldLocation !== nextLocation) changes.push(`地图定位：${previous.location?.label || '未定位'} → ${proposed.location?.label || '未定位'}`)
  return changes
}

/** 仅按用户可见的备选地点、触发条件、状态和来源比较修订，不依赖临时顺序。 */
function serializeConditionalAlternatives(stop: ItineraryStop): string {
  return JSON.stringify((stop.conditionalAlternatives ?? []).map((item) => ({
    name: item.name.trim(),
    area: item.area.trim(),
    trigger: item.trigger.trim(),
    environment: item.environment ?? 'unknown',
    evidenceLevel: item.evidenceLevel,
    sourceIds: [...item.sourceIds].sort()
  })).sort((left, right) => `${left.trigger}\u0000${left.name}`.localeCompare(`${right.trigger}\u0000${right.name}`)))
}

/** 为修订差异生成简短条件备选摘要。 */
function summarizeConditionalAlternatives(stop: ItineraryStop): string {
  const alternatives = stop.conditionalAlternatives ?? []
  return alternatives.length
    ? alternatives.map((item) => `${item.trigger}→${item.name}${item.environment === 'indoor' ? '（室内）' : item.environment === 'outdoor' ? '（室外）' : ''}（${item.evidenceLevel === 'sourced' ? '有来源' : '待核验'}）`).join('；')
    : '无'
}

/** 对比站间路线的可见指标；路线来源 ID 变化时单独提示依据刷新。 */
function compareTransitEstimate(previous: TransitEstimate | undefined, proposed: TransitEstimate | undefined): string | null {
  if (!previous && !proposed) return null
  const previousSummary = previous ? transitEstimateSummary(previous) : '未提供'
  const proposedSummary = proposed ? transitEstimateSummary(proposed) : '未提供'
  const sourceChanged = !!previous && !!proposed && previous.sourceId !== proposed.sourceId
  if (previousSummary === proposedSummary && !sourceChanged) return null
  return `交通估算：${previousSummary} → ${proposedSummary}${sourceChanged ? '；路线来源已更新' : ''}`
}

/** 将路线模式、指标、查询时间和方案号组合成适合差异预览的短句。 */
function transitEstimateSummary(estimate: TransitEstimate): string {
  const details = [
    `${routeModeLabel(estimate.mode)}${typeof estimate.durationMinutes === 'number' ? `约 ${estimate.durationMinutes} 分钟` : '耗时未提供'}`,
    `距离 ${formatRouteDistance(estimate.distanceMeters)}`,
    typeof estimate.walkingDistanceMeters === 'number' ? `步行 ${formatRouteDistance(estimate.walkingDistanceMeters)}` : '',
    estimate.mode === 'transit' ? `票价 ${formatFen(estimate.fareFen)}` : '',
    estimate.mode === 'driving' ? `道路收费 ${formatFen(estimate.tollFen)}` : '',
    estimate.transitLines?.length ? `线路 ${estimate.transitLines.join(' → ')}` : '',
    estimate.queryDate ? `查询 ${estimate.queryDate}${estimate.queryTime ? ` ${estimate.queryTime.replace('-', ':')}` : ''}` : '',
    `方案 ${estimate.optionNumber}`
  ].filter(Boolean)
  return details.join('，')
}

/** 比较住宿与首末实体地点的边界路线，不把它与景点间路线混在一起。 */
function compareLodgingCommutes(previousDay: ItineraryDay | undefined, proposedDay: ItineraryDay | undefined): ItineraryChange[] {
  const dayNumber = proposedDay?.dayNumber ?? previousDay?.dayNumber
  if (dayNumber === undefined) return []
  const previousCommutes = previousDay?.lodgingCommutes ?? []
  const proposedCommutes = proposedDay?.lodgingCommutes ?? []
  const directions: LodgingCommute['direction'][] = ['from-lodging', 'to-lodging']
  const changes: ItineraryChange[] = []

  for (const direction of directions) {
    const previous = previousCommutes.find((commute) => commute.direction === direction)
    const proposed = proposedCommutes.find((commute) => commute.direction === direction)
    if (!previous && !proposed) continue
    const directionLabel = direction === 'from-lodging' ? '住宿→首站' : '末站→住宿'
    const title = `第 ${dayNumber} 天住宿接驳`
    if (!previous && proposed) {
      changes.push({
        type: 'added', title, detail: `新增${directionLabel}路线：${describeLodgingCommute(proposed, proposedDay)}`,
        impact: 'transport', toDay: dayNumber
      })
      continue
    }
    if (previous && !proposed) {
      changes.push({
        type: 'removed', title, detail: `移除${directionLabel}路线：${describeLodgingCommute(previous, previousDay)}`,
        impact: 'transport', fromDay: dayNumber
      })
      continue
    }
    if (!previous || !proposed) continue
    const fields = compareLodgingCommuteFields(previous, proposed, previousDay, proposedDay)
    if (fields.length) changes.push({
      type: 'updated', title, detail: `${directionLabel}路线：${fields.join('；')}`,
      impact: 'transport', fromDay: dayNumber, toDay: dayNumber
    })
  }
  return changes
}

/** 仅显示用户决策相关的接驳端点、模式、指标和路线依据变化。 */
function compareLodgingCommuteFields(
  previous: LodgingCommute,
  proposed: LodgingCommute,
  previousDay: ItineraryDay | undefined,
  proposedDay: ItineraryDay | undefined
): string[] {
  const previousEndpoint = commuteEndpoint(previousDay, previous.direction)
  const proposedEndpoint = commuteEndpoint(proposedDay, proposed.direction)
  const fields: Array<[string, string | number, string | number]> = [
    ['住宿地点', previous.lodgingLocation, proposed.lodgingLocation],
    ['边界地点', previousEndpoint, proposedEndpoint],
    ['交通方式', routeModeLabel(previous.mode), routeModeLabel(proposed.mode)],
    ['耗时', `${previous.durationMinutes} 分钟`, `${proposed.durationMinutes} 分钟`],
    ['距离', formatRouteDistance(previous.distanceMeters), formatRouteDistance(proposed.distanceMeters)],
    ['查询日期', previous.queryDate ?? '未指定', proposed.queryDate ?? '未指定'],
    ['查询时刻', previous.queryTime?.replace('-', ':') ?? '未指定', proposed.queryTime?.replace('-', ':') ?? '未指定'],
    ['路线方案', previous.optionNumber, proposed.optionNumber]
  ]
  const changes = fields.filter(([, oldValue, nextValue]) => oldValue !== nextValue)
    .map(([label, oldValue, nextValue]) => `${label} ${oldValue} → ${nextValue}`)
  if (previous.sourceId !== proposed.sourceId) changes.push('路线来源已更新')
  return changes
}

/** 生成方向明确的住宿路线摘要，用于新增或移除路线的说明。 */
function describeLodgingCommute(commute: LodgingCommute, day: ItineraryDay | undefined): string {
  const endpoint = commuteEndpoint(day, commute.direction)
  const from = commute.direction === 'from-lodging' ? commute.lodgingLocation : endpoint
  const to = commute.direction === 'from-lodging' ? endpoint : commute.lodgingLocation
  const distance = typeof commute.distanceMeters === 'number' ? `，距离 ${formatRouteDistance(commute.distanceMeters)}` : ''
  const schedule = commute.queryDate ? `，查询 ${commute.queryDate}${commute.queryTime ? ` ${commute.queryTime.replace('-', ':')}` : ''}` : ''
  return `${from} → ${to}，${routeModeLabel(commute.mode)}约 ${commute.durationMinutes} 分钟${distance}${schedule}`
}

/** 读取住宿接驳方向对应的当日边界地点名称，不依赖每次生成的临时 ID。 */
function commuteEndpoint(day: ItineraryDay | undefined, direction: LodgingCommute['direction']): string {
  const stop = day ? lodgingCommuteBoundaryStop(day.stops, direction) : undefined
  return stop?.name || (direction === 'from-lodging' ? '首站未安排' : '末站未安排')
}

/** 判断被整体增删的日期是否没有任何地点、时段或接驳内容。 */
function isEmptyDay(day: ItineraryDay): boolean {
  return day.stops.length === 0 && (day.scheduleBlocks ?? []).length === 0 && !(day.lodgingCommutes ?? []).length
}

/** 为路线差异统一显示交通方式名称。 */
function routeModeLabel(mode: TransitEstimate['mode']): string {
  return mode === 'transit' ? '公共交通' : mode === 'walking' ? '步行' : '驾车'
}

/** 以米或千米显示路线服务返回的距离；缺失值明确标注未知。 */
function formatRouteDistance(meters: number | null | undefined): string {
  if (typeof meters !== 'number' || !Number.isFinite(meters)) return '未知'
  return meters >= 1_000 ? `${(meters / 1_000).toFixed(1)} 公里` : `${Math.round(meters)} 米`
}

/** 以人民币显示服务直接返回的金额，不对空值作零元推断。 */
function formatFen(fen: number | null | undefined): string {
  if (typeof fen !== 'number' || !Number.isSafeInteger(fen) || fen < 0) return '未返回'
  return `¥${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, '0')}`
}

/** 比较非地点时段的可见时间、时长、区域和说明。 */
function compareScheduleBlockFields(previous: ItineraryScheduleBlock, proposed: ItineraryScheduleBlock): string[] {
  const fields: Array<[string, string | number | null, string | number | null]> = [
    ['类型', scheduleBlockKindLabel(previous.kind), scheduleBlockKindLabel(proposed.kind)],
    ['时间', previous.time, proposed.time],
    ['时长', previous.durationMinutes, proposed.durationMinutes],
    ['区域', previous.area, proposed.area],
    ['说明', previous.notes, proposed.notes]
  ]
  return fields.filter(([, oldValue, nextValue]) => oldValue !== nextValue)
    .map(([label, oldValue, nextValue]) => `${label}：${displayValue(oldValue)} → ${displayValue(nextValue)}`)
}

/** 对来源事实排序后比较，避免模型返回顺序变化被误报成内容变化。 */
function serializeFactClaims(claims: ItineraryFactClaim[] | undefined): string {
  return JSON.stringify((claims ?? []).map(({ type, value, scope, evidenceLevel, sourceId }) => ({
    type, value: normalizeFactValue(value), scope: normalizeFactValue(scope), evidenceLevel, sourceId: sourceId ?? ''
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
}

/** 以规范化名称和重复出现序号匹配模型新生成的地点 ID。 */
function indexStops(itinerary: ItineraryOption): IndexedStop[] {
  const occurrences = new Map<string, number>()
  return itinerary.days.flatMap((day) => day.stops.map((stop, index) => {
    const name = stop.name.normalize('NFKC').trim().toLocaleLowerCase()
    const occurrence = (occurrences.get(name) ?? 0) + 1
    occurrences.set(name, occurrence)
    return { key: `${name}#${occurrence}`, day, index, stop }
  }))
}

/** 分日比较预约锚点顺序，允许在锚点之间插入普通行程。 */
function groupByDay(entries: IndexedStop[]): Map<number, IndexedStop[]> {
  const grouped = new Map<number, IndexedStop[]>()
  for (const entry of entries) {
    const day = grouped.get(entry.day.dayNumber) ?? []
    day.push(entry)
    grouped.set(entry.day.dayNumber, day)
  }
  return grouped
}

/** 按日期编号读取行程日，避免跨日移动影响地点匹配。 */
function indexDays(itinerary: ItineraryOption): Map<number, ItineraryOption['days'][number]> {
  return new Map(itinerary.days.map((day) => [day.dayNumber, day]))
}

/** 以地点名和所在日查找前面建立的稳定键。 */
function findLocatedKey(stop: ItineraryStop, dayNumber: number, located: LocatedStop[]): string | undefined {
  return located.find((item) => item.dayNumber === dayNumber && item.stop.id === stop.id)?.key
}

/** 为相对顺序比较计算最长公共子序列，插入地点不会误报旧地点移动。 */
function longestCommonSubsequence<T>(left: T[], right: T[]): Set<T> {
  const lengths = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0))
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      lengths[i][j] = left[i] === right[j]
        ? lengths[i + 1][j + 1] + 1
        : Math.max(lengths[i + 1][j], lengths[i][j + 1])
    }
  }
  const sequence = new Set<T>()
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      sequence.add(left[i])
      i++
      j++
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++
    else j++
  }
  return sequence
}

/** 以产品界面能理解的方式显示空值或时长。 */
function displayValue(value: string | number | null): string {
  if (value === null) return '未确定'
  if (typeof value === 'number') return value ? `${value} 分钟` : '未确定'
  return value || '未安排'
}
