/** 校验并解码用户主动导入的单趟旅行备份。 */
import type { ItineraryOption, SourceRetry, Trip } from '../../shared/types.js'
import {
  clone, hasOnlyKeys, isChatMessage, isLegacyTrip, isGeoLocation, isItineraryFactClaim, isItineraryLocation,
  isItineraryOption, isItineraryScheduleBlock, isPreparationItem, isRecord, isRevision, isSource,
  isTransitEstimate, isTrip
} from './schema.js'
import {
  migrateLegacyBriefUnknownFields, migrateLegacyItineraryScheduleBlocks, migrateLegacyLodgingLocation, migrateLegacyPreparationDates,
  migrateLegacyTripConversations,
  migrateLegacyPreparationLocations
} from './migrations.js'
import { normalizeTripBriefUnknownFields } from '../../shared/trip-brief.js'

export interface TripBackupSummary {
  title: string
  conversationCount: number
  messageCount: number
  sourceCount: number
  preparationItemCount: number
  revisionCount: number
}

/** 只接受当前版本、字段明确且不含应用设置的旅行备份。 */
export function parseTripBackup(value: unknown): Trip | null {
  if (!backupObjectHasOnlyKeys(value, ['format', 'formatVersion', 'trip']) || value.format !== 'tripwise-trip-backup') return null
  const version = value.formatVersion
  if (version === 10 || version === 11) return isCleanTripBackupTrip(value.trip) ? clone(value.trip) : null
  if (version === 6 || version === 7 || version === 8 || version === 9) {
    const migratedTrip = migrateLegacyBriefUnknownFields(value.trip)
    return isCleanTripBackupTrip(migratedTrip) ? clone(migratedTrip) : null
  }
  if (![1, 2, 3, 4, 5].includes(Number(version))) return null
  let legacyTrip = value.trip
  if (version === 1) {
    legacyTrip = migrateLegacyLodgingLocation(migrateLegacyItineraryScheduleBlocks(migrateLegacyPreparationDates(migrateLegacyPreparationLocations(legacyTrip))))
  } else if (version === 2) {
    legacyTrip = migrateLegacyLodgingLocation(migrateLegacyItineraryScheduleBlocks(migrateLegacyPreparationDates(legacyTrip)))
  } else if (version === 3) {
    legacyTrip = migrateLegacyLodgingLocation(migrateLegacyItineraryScheduleBlocks(legacyTrip))
  } else if (version === 4) {
    legacyTrip = migrateLegacyLodgingLocation(legacyTrip)
  }
  // 兼容开发期或手工导出的旧 envelope 中已经完整升级的话题结构；仍按当前白名单校验。
  const currentShape = migrateLegacyBriefUnknownFields(legacyTrip)
  if (isCleanTripBackupTrip(currentShape)) return clone(currentShape)
  if (!isCleanTripBackupTrip(legacyTrip, true)) return null
  const migratedTrip = migrateLegacyBriefUnknownFields(migrateLegacyTripConversations(legacyTrip))
  return isCleanTripBackupTrip(migratedTrip) ? clone(migratedTrip) : null
}

/** 校验备份中的每层对象字段，避免未知属性被导入并混入后续模型上下文。 */
function isCleanTripBackupTrip(value: unknown, legacy = false): value is Trip {
  if (!isRecord(value)) return false
  const tripKeys = legacy
    ? ['id', 'title', 'createdAt', 'updatedAt', 'brief', 'messages', 'sources', 'preparationItems', 'revisions', 'activeRevisionId']
    : ['id', 'title', 'createdAt', 'updatedAt', 'brief', 'briefUnknownFields', 'conversations', 'activeConversationId', 'messages', 'sources', 'preparationItems', 'revisions', 'activeRevisionId']
  if (legacy && value.briefUnknownFields !== undefined) tripKeys.push('briefUnknownFields')
  if ((legacy ? !isLegacyTrip(value, true) : !isTrip(value, true)) ||
    !Array.isArray(value.messages) || !Array.isArray(value.sources) || !Array.isArray(value.revisions) ||
    !Array.isArray(value.preparationItems) || (!legacy && !Array.isArray(value.conversations)) ||
    !backupObjectHasOnlyKeys(value, tripKeys) ||
    !backupObjectHasOnlyKeys(value.brief, [
      'departureCity', 'destination', 'startDate', 'endDate', 'arrivalFlight', 'arrivalTime', 'leaveTime', 'travelers',
      'budget', 'lodgingLocation', 'lodging', 'pace', 'earlyStart', 'interests', 'transport', 'dietary', 'luggage', 'clothing', 'constraints'
    ])) return false
  if (legacy && value.briefUnknownFields !== undefined &&
    normalizeTripBriefUnknownFields(value.briefUnknownFields, value.brief as unknown as Trip['brief']) === null) return false
  const messages = value.messages
  const conversations = legacy ? [] : value.conversations as unknown[]
  return messages.every((message) => isCleanBackupMessage(message, legacy)) &&
    conversations.every(isCleanBackupConversation) && value.sources.every(isCleanBackupSource) &&
    value.preparationItems.every(isCleanBackupPreparationItem) && value.revisions.every(isCleanBackupRevision)
}

/** 备份消息仅允许当前对话契约及其已知嵌套字段。 */
function isCleanBackupMessage(value: unknown, legacy = false): boolean {
  if (!isRecord(value) || (legacy ? !isLegacyChatMessage(value) : !isChatMessage(value)) || !backupObjectHasOnlyKeys(value, legacy ? [
    'id', 'role', 'content', 'createdAt', 'sourceIds', 'itineraryOptions', 'rejectedItineraryOptionIds',
    'preparationOptions', 'briefProposal', 'briefProposalAppliedAt'
  ] : [
    'id', 'conversationId', 'role', 'content', 'createdAt', 'sourceIds', 'itineraryOptions', 'rejectedItineraryOptionIds',
    'preparationOptions', 'briefProposal', 'briefProposalAppliedAt'
  ])) return false
  if (value.itineraryOptions !== undefined && (!Array.isArray(value.itineraryOptions) || !value.itineraryOptions.every(isCleanBackupItinerary))) return false
  if (value.preparationOptions !== undefined && (!Array.isArray(value.preparationOptions) || !value.preparationOptions.every(isCleanBackupPreparationItem))) return false
  if (value.briefProposal && !backupObjectHasOnlyKeys(value.briefProposal, ['base', 'changes'])) return false
  return true
}

/** 旧备份消息无话题 ID；其余字段仍经当前消息校验。 */
function isLegacyChatMessage(value: unknown): boolean {
  return isRecord(value) && value.conversationId === undefined && isChatMessage({ ...value, conversationId: 'legacy-conversation' })
}

/** 校验旅行话题备份字段，拒绝夹带未知属性。 */
function isCleanBackupConversation(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 100 &&
    typeof value.title === 'string' && value.title.trim().length > 0 && value.title.trim().length <= 100 &&
    typeof value.createdAt === 'string' && typeof value.updatedAt === 'string' &&
    backupObjectHasOnlyKeys(value, ['id', 'title', 'createdAt', 'updatedAt'])
}

/** 备份行程沿用原验证，并递归拒绝不属于 UI 契约的字段。 */
function isCleanBackupItinerary(value: unknown): value is ItineraryOption {
  if (!isItineraryOption(value) || !backupObjectHasOnlyKeys(value, ['id', 'title', 'summary', 'tradeoffs', 'days', 'budgetEstimate', 'mealRequirements'])) return false
  if (value.budgetEstimate && (!backupObjectHasOnlyKeys(value.budgetEstimate, ['currency', 'items', 'notApplicableCategories']) ||
    !value.budgetEstimate.items.every((item) => backupObjectHasOnlyKeys(item, [
      'id', 'category', 'title', 'amountMinFen', 'amountMaxFen', 'quantity', 'unitLabel', 'evidenceLevel', 'sourceIds', 'basis'
    ])) || !value.budgetEstimate.notApplicableCategories.every((item) => backupObjectHasOnlyKeys(item, ['category', 'reason'])))) return false
  return value.days.every((day) => backupObjectHasOnlyKeys(day, ['id', 'dayNumber', 'date', 'title', 'stops', 'scheduleBlocks', 'lodgingCommutes', 'weather']) &&
    (day.weather === undefined || backupObjectHasOnlyKeys(day.weather, ['status', 'summary', 'sourceId'])) &&
    (day.lodgingCommutes === undefined || (Array.isArray(day.lodgingCommutes) && day.lodgingCommutes.length <= 2 &&
      day.lodgingCommutes.every((commute) => backupObjectHasOnlyKeys(commute, [
        'direction', 'lodgingLocation', 'stopId', 'sourceId', 'mode', 'optionNumber', 'queryDate', 'queryTime', 'durationMinutes', 'distanceMeters'
      ])))) &&
    day.scheduleBlocks.every((block) => isItineraryScheduleBlock(block) && backupObjectHasOnlyKeys(block, ['id', 'kind', 'title', 'time', 'durationMinutes', 'area', 'notes'])) &&
    day.stops.every((stop) =>
    backupObjectHasOnlyKeys(stop, [
      'id', 'name', 'area', 'time', 'durationMinutes', 'category', 'notes', 'transitToNext', 'locked', 'sourceIds',
      'evidenceLevel', 'factClaims', 'conditionalAlternatives', 'transitEstimate', 'location'
    ]) &&
    (!stop.factClaims || stop.factClaims.every((claim) => isItineraryFactClaim(claim) && backupObjectHasOnlyKeys(claim, ['id', 'type', 'value', 'scope', 'evidenceLevel', 'sourceId']))) &&
    (!stop.conditionalAlternatives || stop.conditionalAlternatives.every((alternative) =>
      backupObjectHasOnlyKeys(alternative, ['name', 'area', 'trigger', 'evidenceLevel', 'sourceIds', 'environment']))) &&
    (!stop.location || (isItineraryLocation(stop.location) && backupObjectHasOnlyKeys(stop.location, [
      'latitude', 'longitude', 'label', 'coordinateSystem', 'sourceId', 'provider', 'fetchedAt'
    ]))) &&
    (!stop.transitEstimate || (isTransitEstimate(stop.transitEstimate) && backupObjectHasOnlyKeys(stop.transitEstimate, [
      'sourceId', 'destinationStopId', 'mode', 'fetchedAt', 'optionNumber', 'queryDate', 'queryTime', 'durationMinutes',
      'distanceMeters', 'walkingDistanceMeters', 'fareFen', 'tollFen', 'transitLines'
    ])))
  ))
}

/** 备份来源与准备事项只保留应用认识的本地资料字段。 */
function isCleanBackupSource(value: unknown): boolean {
  return isSource(value) && backupObjectHasOnlyKeys(value, [
    'id', 'title', 'url', 'provider', 'kind', 'summary', 'fetchedAt', 'status', 'sourceNature', 'contentLevel', 'factEvidenceExcerpt', 'declaredAuthor',
    'declaredPublishedAt', 'connectorId', 'location', 'retry', 'retrySkippedAt'
  ]) && (!value.location || (isGeoLocation(value.location) && backupObjectHasOnlyKeys(value.location, [
    'latitude', 'longitude', 'label', 'coordinateSystem'
  ]))) && (!value.retry || isCleanBackupRetry(value.retry))
}

/** 旅行备份中的 MCP 重试只保留稳定服务 ID、工具名和有界查询参数。 */
function isCleanBackupRetry(value: SourceRetry): boolean {
  if ('kind' in value) {
    return value.kind === 'mcp-connect'
      ? backupObjectHasOnlyKeys(value, ['kind', 'serverId'])
      : backupObjectHasOnlyKeys(value, ['kind', 'serverId', 'toolName', 'arguments'])
  }
  return backupObjectHasOnlyKeys(value, ['toolName', 'arguments'])
}

/** 拒绝旅行备份中包含未声明字段或不完整的准备事项。 */
function isCleanBackupPreparationItem(value: unknown): boolean {
  return isPreparationItem(value) && backupObjectHasOnlyKeys(value, [
    'id', 'category', 'title', 'detail', 'itineraryDate', 'dueDate', 'legacyDate', 'checked', 'sourceIds', 'evidenceLevel', 'packingSection', 'locationContext'
  ]) && (value.locationContext === undefined || backupObjectHasOnlyKeys(value.locationContext, [
    'dayNumber', 'dayTitle', 'stopId', 'stopName', 'area', 'placeSourceId', 'placeName',
    'routeOptionNumber', 'distanceMeters', 'durationMinutes', 'routeSourceId'
  ]))
}

/** 检查历史版本只包含备份契约允许的数据结构。 */
function isCleanBackupRevision(value: unknown): boolean {
  return isRevision(value) && backupObjectHasOnlyKeys(value, ['id', 'number', 'createdAt', 'summary', 'content', 'sourceIds', 'itinerary']) &&
    (value.itinerary === undefined || isCleanBackupItinerary(value.itinerary))
}

/** 确认备份对象不夹带运行时或凭证等额外字段。 */
function backupObjectHasOnlyKeys(value: unknown, allowed: string[]): value is Record<string, unknown> {
  return isRecord(value) && hasOnlyKeys(value, allowed)
}
