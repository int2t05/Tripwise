/** 将旧版旅行数据逐步转换为当前 schema；仅处理内存中的对象。 */
import type { LegacyTrip, Trip } from '../../shared/types.js'
import { randomUUID } from 'node:crypto'
import { placeNamesMatch, routeSummarySupportsMetrics, routeTitleMatchesEndpoints } from '../../shared/preparation.js'
import {
  clone, isCalendarDate, isDatabase, isLegacyTrip, isPreparationLocationContext, isRecord, isString, isTrip,
  normalizeSettings, EMPTY_BRIEF, type Database
} from './schema.js'

/** 迁移旅行字段、连接器、代理和 MCP 配置；只升级完整校验通过的旧版本文件。 */
export function loadDatabase(value: unknown): { database: Database; migrated: boolean } | null {
  if (isDatabase(value)) return { database: value, migrated: false }
  if (!isRecord(value) || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].includes(Number(value.schemaVersion)) || !normalizeSettings(value.settings) || !Array.isArray(value.trips)) return null
  const oldVersion = Number(value.schemaVersion)
  const legacyTrips = value.trips.map((trip) => migrateLegacyBriefUnknownFields(migrateLegacyLodgingLocation(migrateLegacyItineraryScheduleBlocks(migrateLegacyPreparationDates(
    oldVersion <= 6 ? migrateLegacyPreparationLocations(trip) : trip
  )))))
  if (!legacyTrips.every((trip) => isLegacyTrip(trip, oldVersion >= 2) || isTrip(trip, oldVersion >= 2))) return null
  const validLegacyTrips = legacyTrips as Array<LegacyTrip | Trip>
  const oldSelectedTripId = value.selectedTripId
  if (oldSelectedTripId !== null && !isString(oldSelectedTripId)) return null
  const oldTripIds = validLegacyTrips.map((trip) => trip.id)
  if (new Set(oldTripIds).size !== oldTripIds.length) return null
  if (isString(oldSelectedTripId) && !oldTripIds.includes(oldSelectedTripId)) return null

  const trips = validLegacyTrips.map((trip) => {
    const normalized = {
      ...trip,
      brief: { ...EMPTY_BRIEF, ...trip.brief },
      preparationItems: Array.isArray(trip.preparationItems) ? trip.preparationItems : []
    }
    return ('conversations' in trip ? normalized : migrateLegacyTripConversations(normalized)) as Trip
  })
  const database: Database = {
    schemaVersion: 16,
    selectedTripId: oldSelectedTripId,
    settings: normalizeSettings(value.settings)!,
    trips
  }
  return isDatabase(database) ? { database, migrated: true } : null
}

/** 为旧旅行增加空的暂未知字段列表，不改变既有用户填写的简报内容。 */
export function migrateLegacyBriefUnknownFields(value: unknown): unknown {
  if (!isRecord(value) || value.briefUnknownFields !== undefined) return value
  const migrated = clone(value)
  migrated.briefUnknownFields = []
  return migrated
}

/** 把旧的单流对话迁入“总体规划”，保留消息原文和原始顺序。 */
export function migrateLegacyTripConversations(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.messages) || Array.isArray(value.conversations)) return value
  const migrated = clone(value)
  const id = randomUUID()
  const messages = Array.isArray(migrated.messages) ? migrated.messages : []
  const timestamps = messages.flatMap((message) =>
    isRecord(message) && isString(message.createdAt) ? [message.createdAt] : [])
  const createdAt = isString(migrated.createdAt) ? migrated.createdAt : timestamps[0] ?? new Date().toISOString()
  const updatedAt = timestamps.at(-1) ?? (isString(migrated.updatedAt) ? migrated.updatedAt : createdAt)
  for (const message of messages) {
    if (isRecord(message)) message.conversationId = id
  }
  migrated.conversations = [{ id, title: '总体规划', createdAt, updatedAt }]
  migrated.activeConversationId = id
  return migrated
}

/** 为旧旅行补充空的具体住宿地点，绝不猜测旧住宿文字是地址还是偏好。 */
export function migrateLegacyLodgingLocation(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.brief) || value.brief.lodgingLocation !== undefined) return value
  const migrated = clone(value)
  if (isRecord(migrated.brief)) migrated.brief.lodgingLocation = ''
  return migrated
}

/** 迁移旧版旅行时清除缺少地点来源证明的关联，并将对应建议降为待核验。 */
export function migrateLegacyPreparationLocations(value: unknown): unknown {
  if (!isRecord(value)) return value
  const migrated = clone(value)
  const sources = Array.isArray(migrated.sources) ? migrated.sources.filter(isRecord) : []
  /** 只有地点与可选路线都能在成功来源中核对时才保留关联。 */
  const hasVerifiableLocation = (item: Record<string, unknown>): boolean => {
    if (!['food', 'alternative'].includes(String(item.category)) || !isPreparationLocationContext(item.locationContext)) return false
    const context = item.locationContext
    const placeSource = sources.find((source) => source.id === context.placeSourceId)
    if (!Array.isArray(item.sourceIds) || !item.sourceIds.includes(context.placeSourceId) ||
      !placeSource || placeSource.kind !== 'place' || placeSource.status !== 'success' ||
      !placeNamesMatch(String(placeSource.title), context.placeName) || !placeNamesMatch(String(item.title), context.placeName)) return false
    if (!context.routeSourceId) return true
    const routeSource = sources.find((source) => source.id === context.routeSourceId)
    return Array.isArray(item.sourceIds) && item.sourceIds.includes(context.routeSourceId) &&
      !!routeSource && routeSource.kind === 'route' && routeSource.status === 'success' &&
      routeTitleMatchesEndpoints(String(routeSource.title), context.stopName, context.placeName) &&
      routeSummarySupportsMetrics(String(routeSource.summary), context.routeOptionNumber!, context.distanceMeters, context.durationMinutes)
  }
  /** 删除失去依据的地点快照，并将相关准备建议降为待核验。 */
  const clearUnverifiableLocations = (items: unknown): void => {
    if (!Array.isArray(items)) return
    for (const item of items) {
      if (!isRecord(item) || item.locationContext === undefined) continue
      if (hasVerifiableLocation(item)) continue
      delete item.locationContext
      if (['food', 'alternative'].includes(String(item.category))) item.evidenceLevel = 'pending'
    }
  }
  if (Array.isArray(migrated.messages)) {
    for (const message of migrated.messages) {
      if (isRecord(message)) clearUnverifiableLocations(message.preparationOptions)
    }
  }
  clearUnverifiableLocations(migrated.preparationItems)
  return migrated
}

/** 拆分旧版双重含义日期；有地点快照可反证的餐饮/备选日期可迁为适用日。 */
export function migrateLegacyPreparationDates(value: unknown): unknown {
  if (!isRecord(value)) return value
  const migrated = clone(value)
  const itineraries: unknown[] = [
    ...(Array.isArray(migrated.revisions) ? migrated.revisions.flatMap((revision) =>
      isRecord(revision) && revision.itinerary ? [revision.itinerary] : []) : []),
    ...(Array.isArray(migrated.messages) ? migrated.messages.flatMap((message) =>
      isRecord(message) && Array.isArray(message.itineraryOptions) ? message.itineraryOptions : []) : [])
  ]
  /** 用已保存的路线日期与停靠点快照确认旧日期确为适用日。 */
  const hasMatchingItineraryDate = (item: Record<string, unknown>, date: string): boolean => {
    if (!['food', 'alternative'].includes(String(item.category)) || !isRecord(item.locationContext)) return false
    const context = item.locationContext
    return itineraries.some((rawItinerary) => isRecord(rawItinerary) && Array.isArray(rawItinerary.days) &&
      rawItinerary.days.some((rawDay) => isRecord(rawDay) && rawDay.date === date &&
        rawDay.dayNumber === context.dayNumber && rawDay.title === context.dayTitle && Array.isArray(rawDay.stops) &&
        rawDay.stops.some((rawStop) => isRecord(rawStop) && rawStop.id === context.stopId &&
          rawStop.name === context.stopName && rawStop.area === context.area)))
  }
  /** 将旧截止日期迁为适用日或保留待用户确认的旧日期。 */
  const migrateItems = (items: unknown): void => {
    if (!Array.isArray(items)) return
    for (const item of items) {
      if (!isRecord(item) || 'itineraryDate' in item || 'legacyDate' in item) continue
      const oldDate = isString(item.dueDate) ? item.dueDate : ''
      item.itineraryDate = oldDate && isCalendarDate(oldDate) && hasMatchingItineraryDate(item, oldDate) ? oldDate : ''
      item.dueDate = ''
      if (oldDate && !item.itineraryDate) item.legacyDate = oldDate
    }
  }
  if (Array.isArray(migrated.messages)) {
    for (const message of migrated.messages) {
      if (isRecord(message)) migrateItems(message.preparationOptions)
    }
  }
  migrateItems(migrated.preparationItems)
  return migrated
}

/** 将旧版本的地点列表补成当前行程日结构，保留已存在的有效时间块。 */
export function migrateLegacyItineraryScheduleBlocks(value: unknown): unknown {
  if (!isRecord(value)) return value
  const migrated = clone(value)
  /** 为旧行程补充空时段列表，避免误生成地点或安排。 */
  const normalizeItinerary = (rawItinerary: unknown): void => {
    if (!isRecord(rawItinerary) || !Array.isArray(rawItinerary.days)) return
    for (const day of rawItinerary.days) {
      if (isRecord(day) && !('scheduleBlocks' in day)) day.scheduleBlocks = []
    }
  }
  if (Array.isArray(migrated.messages)) {
    for (const message of migrated.messages) {
      if (!isRecord(message) || !Array.isArray(message.itineraryOptions)) continue
      for (const itinerary of message.itineraryOptions) normalizeItinerary(itinerary)
    }
  }
  if (Array.isArray(migrated.revisions)) {
    for (const revision of migrated.revisions) {
      if (isRecord(revision)) normalizeItinerary(revision.itinerary)
    }
  }
  return migrated
}
