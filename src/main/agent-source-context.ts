/** 为模型保留旅行中最近来源，并优先加入用户明确要求复核的来源。 */
import type { SourceRecord } from '../shared/types.js'
import {
  MAX_IMPORTED_SOURCE_CHARACTERS_PER_ITEM,
  MAX_IMPORTED_SOURCE_CONTEXT_CHARACTERS,
  MAX_IMPORTED_SOURCES_PER_CONTEXT
} from '../shared/agent-limits.js'
import { itinerarySourceNamesPlace } from '../shared/itinerary-facts.js'

const MAX_AVAILABLE_SOURCES = 20

export interface ImportedSourceContext {
  source: SourceRecord
  text: string
}

/** 已知来源编号可将较旧来源提升到上下文前部，不增加上下文条数上限。 */
export function sourcesForAgentContext(
  sources: SourceRecord[], latestUserMessage: string, preferredPlaceNames: string[] = []
): SourceRecord[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]))
  const referencedIds = [...new Set(
    [...latestUserMessage.matchAll(/来源编号为\s+([^\s，。；]+)/g)].map((match) => match[1])
  )].slice(0, 3)
  const referencedSources = referencedIds.flatMap((id) => {
    const source = sourceById.get(id)
    return source ? [source] : []
  })
  const referencedIdSet = new Set(referencedSources.map((source) => source.id))
  const recentSources = [...sources]
    .sort((left, right) => sourceContextPriority(left) - sourceContextPriority(right) ||
      Number(!sourceMatchesPlaces(left, preferredPlaceNames)) - Number(!sourceMatchesPlaces(right, preferredPlaceNames)) ||
      right.fetchedAt.localeCompare(left.fetchedAt))
    .filter((source) => !referencedIdSet.has(source.id))

  return [...referencedSources, ...recentSources].slice(0, MAX_AVAILABLE_SOURCES)
}

/** 判断来源正文或标题是否直接提到任一当前目标地点。 */
function sourceMatchesPlaces(source: SourceRecord, placeNames: string[]): boolean {
  if (placeNames.length === 0) return false
  const sourceText = [source.title, source.summary, source.factEvidenceExcerpt, source.location?.label]
    .filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ')
  return placeNames.some((name) => itinerarySourceNamesPlace(sourceText, name))
}

/** 按用户点名、目的地和当前行程地点选择导入攻略，并在固定正文预算内均分内容。 */
export function importedSourcesForAgentContext(
  sources: SourceRecord[],
  destination: string,
  placeNames: string[],
  latestUserMessage: string
): ImportedSourceContext[] {
  const normalizedMessage = normalizeSourceContextText(latestUserMessage)
  const communityRequested = /小红书|攻略|游记|探店|踩坑|避坑|体验|笔记/u.test(latestUserMessage)
  const ranked = sources.filter((source) => source.kind === 'user' && source.status === 'success')
    .map((source) => {
      const sourceText = [source.title, source.summary, source.url].join(' ')
      const normalizedTitle = normalizeSourceContextText(source.title)
      const titleMentioned = normalizedTitle.length >= 2 && normalizedMessage.includes(normalizedTitle)
      const matchedPlaces = placeNames.filter((name) => itinerarySourceNamesPlace(sourceText, name))
      const requestedPlaceMatches = placeNames.filter((name) =>
        itinerarySourceNamesPlace(latestUserMessage, name) && matchedPlaces.includes(name)
      ).length
      const destinationMatched = !!destination && itinerarySourceNamesPlace(sourceText, destination)
      const score = Number(titleMentioned) * 1_000 + requestedPlaceMatches * 100 +
        Number(destinationMatched) * 20 + matchedPlaces.length * 5 +
        Number(communityRequested && source.sourceNature === 'community-platform')
      return { source, score }
    })
    .sort((left, right) => right.score - left.score || right.source.fetchedAt.localeCompare(left.source.fetchedAt))
    .slice(0, MAX_IMPORTED_SOURCES_PER_CONTEXT)

  let remainingCharacters = MAX_IMPORTED_SOURCE_CONTEXT_CHARACTERS
  return ranked.flatMap(({ source }, index) => {
    const remainingItems = ranked.length - index
    const itemBudget = Math.min(MAX_IMPORTED_SOURCE_CHARACTERS_PER_ITEM,
      Math.floor(remainingCharacters / remainingItems))
    const text = source.summary.slice(0, itemBudget)
    remainingCharacters -= text.length
    return text ? [{ source, text }] : []
  })
}

/** 统一导入来源与当前请求的文本比较，忽略标点、空格和全半角差异。 */
function normalizeSourceContextText(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase()
}

/** 先让事实正文和结构化服务结果进入上下文，再用最近状态补足检索线索。 */
function sourceContextPriority(source: SourceRecord): number {
  if (source.status === 'success' && source.kind === 'web' && source.contentLevel === 'page' &&
      source.sourceNature !== 'community-platform' && source.factEvidenceExcerpt?.trim()) return 0
  if (source.status === 'success' && ['weather', 'place', 'route', 'user', 'plugin'].includes(source.kind)) return 1
  if (source.status === 'success') return 2
  if (source.status === 'partial') return 3
  return 4
}

/** 只复用能直接提到当前计划地点的成功网页正文，不以摘要或无关旧来源跳过检索。 */
export function hasPageEvidenceForPlaces(sources: SourceRecord[], placeNames: string[]): boolean {
  const names = [...new Set(placeNames.map((name) => name.trim()).filter(Boolean))]
  if (names.length === 0) return false

  return sources.some((source) => {
    if (source.kind !== 'web' || source.status !== 'success' || source.contentLevel !== 'page' ||
        !source.factEvidenceExcerpt?.trim()) return false
    const sourceText = [source.title, source.summary, source.factEvidenceExcerpt, source.location?.label]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' ')
    return names.some((name) => itinerarySourceNamesPlace(sourceText, name))
  })
}
