/** 移除旅行来源时同步解除结构化引用，避免留下失效的事实依据。 */
import type {
  ChatMessage, ItineraryBudgetItem, ItineraryOption, ItineraryRevision, ItineraryStop, PreparationItem, Trip
} from './types.js'

/** 返回不含指定来源及其结构化引用的旅行副本。 */
export function removeSourceFromTrip(trip: Trip, sourceId: string): Trip {
  if (!sourceId || !trip.sources.some((source) => source.id === sourceId)) {
    throw new Error('找不到要移除的旅行来源。')
  }

  return {
    ...trip,
    sources: trip.sources.filter((source) => source.id !== sourceId),
    messages: trip.messages.map((message) => removeSourceFromMessage(message, sourceId)),
    revisions: trip.revisions.map((revision) => removeSourceFromRevision(revision, sourceId)),
    preparationItems: trip.preparationItems.map((item) => removeSourceFromPreparation(item, sourceId))
  }
}

/** 从对话提案中解绑来源，历史回答正文由用户决定是否保留。 */
function removeSourceFromMessage(message: ChatMessage, sourceId: string): ChatMessage {
  const nextMessage = { ...message }
  delete nextMessage.agentRunProgress
  return {
    ...nextMessage,
    sourceIds: withoutSourceId(message.sourceIds, sourceId),
    ...(message.itineraryOptions ? {
      itineraryOptions: message.itineraryOptions.map((option) => removeSourceFromItinerary(option, sourceId))
    } : {}),
    ...(message.preparationOptions ? {
      preparationOptions: message.preparationOptions.map((item) => removeSourceFromPreparation(item, sourceId))
    } : {})
  }
}

/** 保留版本内容，但让行程事实、地图位置和路线估算失去已移除来源。 */
function removeSourceFromRevision(revision: ItineraryRevision, sourceId: string): ItineraryRevision {
  return {
    ...revision,
    sourceIds: withoutSourceId(revision.sourceIds, sourceId),
    ...(revision.itinerary ? { itinerary: removeSourceFromItinerary(revision.itinerary, sourceId) } : {})
  }
}

/** 逐点清理来源引用；删除路线依据时同时清除对应的路线文案。 */
function removeSourceFromItinerary(itinerary: ItineraryOption, sourceId: string): ItineraryOption {
  return {
    ...itinerary,
    ...(itinerary.budgetEstimate ? {
      budgetEstimate: {
        ...itinerary.budgetEstimate,
        items: itinerary.budgetEstimate.items.map((item) => removeSourceFromBudgetItem(item, sourceId))
      }
    } : {}),
    days: itinerary.days.map((day) => ({
      ...day,
      ...(day.weather?.sourceId === sourceId ? {
        weather: { status: 'unknown' as const, summary: '天气来源已移除，本日天气待核验。' }
      } : {}),
      ...(day.lodgingCommutes ? {
        lodgingCommutes: day.lodgingCommutes.filter((commute) => commute.sourceId !== sourceId)
      } : {}),
      stops: day.stops.map((stop) => removeSourceFromStop(stop, sourceId))
    }))
  }
}

/** 删除预算金额依据时清除无法再证明的范围，估算项保留并提示复核。 */
function removeSourceFromBudgetItem(item: ItineraryBudgetItem, sourceId: string): ItineraryBudgetItem {
  if (!item.sourceIds.includes(sourceId)) return item
  const sourceIds = withoutSourceId(item.sourceIds, sourceId)
  if (item.evidenceLevel === 'sourced' && sourceIds.length === 0) {
    return {
      ...item,
      amountMinFen: null,
      amountMaxFen: null,
      evidenceLevel: 'pending',
      sourceIds: [],
      basis: '原金额来源已移除，请重新核验。'
    }
  }
  return {
    ...item,
    sourceIds,
    ...(item.evidenceLevel === 'estimated' ? { basis: `${item.basis.slice(0, 262)}；引用来源已移除，需复核估算依据。` } : {})
  }
}

/** 让受影响地点回到待核验状态，并丢弃无法再证明的坐标或路线数据。 */
function removeSourceFromStop(stop: ItineraryStop, sourceId: string): ItineraryStop {
  const sourceIds = withoutSourceId(stop.sourceIds ?? [], sourceId)
  const factClaims = stop.factClaims?.map((claim) => claim.sourceId === sourceId
    ? { ...claim, sourceId: undefined, evidenceLevel: 'pending' as const }
    : claim)
  const conditionalAlternatives = stop.conditionalAlternatives?.map((alternative) => {
    if (!alternative.sourceIds.includes(sourceId)) return alternative
    const sourceIds = withoutSourceId(alternative.sourceIds, sourceId)
    return { ...alternative, sourceIds, evidenceLevel: sourceIds.length ? alternative.evidenceLevel : 'pending' as const }
  })
  const locationRemoved = stop.location?.sourceId === sourceId
  const routeRemoved = stop.transitEstimate?.sourceId === sourceId
  const affected = sourceIds.length !== (stop.sourceIds?.length ?? 0) ||
    factClaims?.some((claim, index) => claim !== stop.factClaims?.[index]) === true || locationRemoved || routeRemoved

  return {
    ...stop,
    ...(stop.sourceIds ? { sourceIds } : {}),
    ...(factClaims ? { factClaims } : {}),
    ...(conditionalAlternatives ? { conditionalAlternatives } : {}),
    ...(locationRemoved ? { location: undefined } : {}),
    ...(routeRemoved ? { transitEstimate: undefined, transitToNext: '' } : {}),
    ...(affected && stop.evidenceLevel === 'sourced' ? { evidenceLevel: 'pending' as const } : {})
  }
}

/** 清理准备建议证据；失去定位来源时一并移除地点关联。 */
function removeSourceFromPreparation(item: PreparationItem, sourceId: string): PreparationItem {
  const sourceIds = withoutSourceId(item.sourceIds, sourceId)
  const context = item.locationContext
  const locationRemoved = context?.placeSourceId === sourceId
  const routeRemoved = context?.routeSourceId === sourceId
  const locationContext = locationRemoved
    ? undefined
    : routeRemoved && context
      ? removeRouteMetrics(context)
      : context
  const affected = sourceIds.length !== item.sourceIds.length || locationRemoved || routeRemoved

  return {
    ...item,
    sourceIds,
    ...(locationContext ? { locationContext } : { locationContext: undefined }),
    ...(affected && item.evidenceLevel === 'sourced' ? { evidenceLevel: 'pending' as const } : {})
  }
}

/** 移除依赖路线来源的估算字段，同时保留仍有效的地点候选关联。 */
function removeRouteMetrics(context: NonNullable<PreparationItem['locationContext']>): NonNullable<PreparationItem['locationContext']> {
  const placeContext = { ...context }
  delete placeContext.routeOptionNumber
  delete placeContext.distanceMeters
  delete placeContext.durationMinutes
  delete placeContext.routeSourceId
  return placeContext
}

/** 返回去掉指定来源 ID 的数组，不改变原数组。 */
function withoutSourceId(sourceIds: string[], sourceId: string): string[] {
  return sourceIds.filter((id) => id !== sourceId)
}
