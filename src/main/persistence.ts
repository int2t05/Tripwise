/** 负责旅行数据的本机原子写入和用户操作；结构校验与迁移由独立模块处理。 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AgentRunProgress, AppSettings, ChatMessage, ItineraryOption, ItineraryRevision, McpServerSettings, PreparationItem, SourceRecord, Trip, TripBrief, TripBriefField
} from '../shared/types.js'
import { itineraryToMarkdown, lodgingCommutesHaveValidSources } from '../shared/itinerary.js'
import { analyzeDaySchedule, analyzeMealRequirements } from '../shared/itinerary-schedule.js'
import { preserveLockedStops } from '../shared/itinerary-revisions.js'
import { validateBriefDates } from './trip-brief.js'
import { removeSourceFromTrip } from '../shared/source-removal.js'
import { conversationTitleFromMessage } from '../shared/conversations.js'
import {
  briefFieldLabel, clearStaleRouteEvidence, clone, isCalendarDate, isChatMessage, sameItineraryLocationIdentity,
  isAgentRunProgress, isSettings, itinerarySourceIds, normalizeEditedItinerary, normalizePreparationItemUpdate,
  sameSourceIdentity, updateSourceMetadata, type Database, DEFAULT_SETTINGS, EMPTY_BRIEF
} from './persistence/schema.js'
import { loadDatabase } from './persistence/migrations.js'
import { parseTripBackup, type TripBackupSummary } from './persistence/backups.js'
import { normalizeTripBriefUnknownFields } from '../shared/trip-brief.js'

export type { TripBackupSummary } from './persistence/backups.js'

type ChatMessageInput = Omit<ChatMessage, 'conversationId'> & { conversationId?: string }

/** 失败天气查询可供 unknown 状态解释原因；其他行程事实仍只能引用成功来源。 */
export function itineraryEvidenceIdsRequiringSuccess(itinerary: ItineraryOption): string[] {
  const unknownWeatherIds = new Set(itinerary.days.flatMap((day) =>
    day.weather?.status === 'unknown' && day.weather.sourceId ? [day.weather.sourceId] : []
  ))
  const nonWeatherIds = new Set(itinerary.days.flatMap((day) => [
    ...day.stops.flatMap((stop) => [
      ...(stop.sourceIds ?? []),
      ...(stop.factClaims ?? []).flatMap((claim) => claim.sourceId ? [claim.sourceId] : []),
      ...(stop.conditionalAlternatives ?? []).flatMap((alternative) => alternative.sourceIds),
      ...(stop.location ? [stop.location.sourceId] : []),
      ...(stop.transitEstimate ? [stop.transitEstimate.sourceId] : [])
    ]),
    ...(day.lodgingCommutes ?? []).map((commute) => commute.sourceId)
  ]).concat(itinerary.budgetEstimate?.items.flatMap((item) => item.sourceIds) ?? []))
  return itinerarySourceIds(itinerary).filter((id) => !unknownWeatherIds.has(id) || nonWeatherIds.has(id))
}

/** 以串行事务和临时文件替换，避免并发写入或中断留下半份数据。 */
export class TripStore {
  private readonly filePath: string
  private database: Database = {
    schemaVersion: 16,
    selectedTripId: null,
    settings: clone(DEFAULT_SETTINGS),
    trips: []
  }
  private writeQueue: Promise<void> = Promise.resolve()

  /** 创建本地存储实例；正式路径由 Electron userData 目录提供。 */
  constructor(private readonly directory: string) {
    this.filePath = join(directory, 'tripwise-data.json')
  }

  /** 读取用户数据；未知版本会失败并保留原文件，避免破坏性重置。 */
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      const loaded = loadDatabase(parsed)
      if (!loaded) throw new Error('本地数据格式或版本不受支持。')
      this.database = loaded.database
      if (loaded.migrated) await this.persist(loaded.database)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.persist(this.database)
        return
      }
      throw error
    }
  }

  /** 返回当前应用数据的隔离副本。 */
  snapshot(): Database {
    return clone(this.database)
  }

  /** 校验备份并返回导入确认所需的本地资料数量。 */
  previewTripBackup(input: unknown): TripBackupSummary {
    const trip = parseTripBackup(input)
    if (!trip) throw new Error('旅行备份无效或版本不受支持；未修改当前资料。')
    return {
      title: trip.title,
      conversationCount: trip.conversations.length,
      messageCount: trip.messages.length,
      sourceCount: trip.sources.length,
      preparationItemCount: trip.preparationItems.length,
      revisionCount: trip.revisions.length
    }
  }

  /** 将有效备份作为新旅行加入，不覆盖现有旅行或共享服务设置。 */
  async importTripBackup(input: unknown): Promise<void> {
    const sourceTrip = parseTripBackup(input)
    if (!sourceTrip) throw new Error('旅行备份无效或版本不受支持；未修改当前资料。')
    const restoredTrip = clone(sourceTrip)
    restoredTrip.id = randomUUID()
    restoredTrip.title = `${sourceTrip.title}（恢复副本）`
    restoredTrip.updatedAt = new Date().toISOString()
    await this.transact((data) => {
      data.trips.unshift(restoredTrip)
      data.selectedTripId = restoredTrip.id
    })
  }

  /** 创建新的旅行工作区，并保留已有旅行。 */
  async createTrip(input: Partial<TripBrief> = {}): Promise<void> {
    await this.transact((data) => {
      const now = new Date().toISOString()
      const brief = { ...EMPTY_BRIEF, ...input }
      const conversationId = randomUUID()
      const trip: Trip = {
        id: randomUUID(),
        title: brief.destination.trim() || '新的旅行',
        createdAt: now,
        updatedAt: now,
        brief,
        briefUnknownFields: [],
        conversations: [{ id: conversationId, title: '总体规划', createdAt: now, updatedAt: now }],
        activeConversationId: conversationId,
        messages: [],
        sources: [],
        preparationItems: [],
        revisions: [],
        activeRevisionId: null
      }
      data.trips.unshift(trip)
      data.selectedTripId = trip.id
    })
  }

  /** 在当前旅行中新开话题，沿用旅行级简报、来源、行程和准备清单。 */
  async createConversation(tripId: string): Promise<void> {
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      const now = new Date().toISOString()
      const conversationId = randomUUID()
      trip.conversations.unshift({ id: conversationId, title: '新话题', createdAt: now, updatedAt: now })
      trip.activeConversationId = conversationId
      trip.updatedAt = now
    })
  }

  /** 删除话题消息；共享行程资料保留，最后一个话题删除后重建空白规划。 */
  async deleteConversation(tripId: string, conversationId: string): Promise<void> {
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      const index = trip.conversations.findIndex((conversation) => conversation.id === conversationId)
      if (index < 0) throw new Error('找不到这趟旅行中的对话话题。')
      const wasActive = trip.activeConversationId === conversationId
      trip.conversations.splice(index, 1)
      trip.messages = trip.messages.filter((message) => message.conversationId !== conversationId)
      const now = new Date().toISOString()
      if (trip.conversations.length === 0) {
        const replacementId = randomUUID()
        trip.conversations.push({ id: replacementId, title: '总体规划', createdAt: now, updatedAt: now })
        trip.activeConversationId = replacementId
      } else if (wasActive) {
        trip.activeConversationId = trip.conversations[0].id
      }
      trip.updatedAt = now
    })
  }

  /** 切换旅行内当前话题；不会把其他话题的消息复制到此对话。 */
  async selectConversation(tripId: string, conversationId: string): Promise<void> {
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      if (!trip.conversations.some((conversation) => conversation.id === conversationId)) {
        throw new Error('找不到这趟旅行中的对话话题。')
      }
      trip.activeConversationId = conversationId
      trip.updatedAt = new Date().toISOString()
    })
  }

  /** 只切换当前旅行，不修改行程内容。 */
  async selectTrip(tripId: string): Promise<void> {
    await this.transact((data) => {
      if (!data.trips.some((trip) => trip.id === tripId)) throw new Error('找不到这趟旅行。')
      data.selectedTripId = tripId
    })
  }

  /** 更新用户可审阅的旅行条件，并同步旅行标题和修改时间。 */
  async updateBrief(tripId: string, brief: TripBrief, unknownFields: TripBriefField[] = []): Promise<void> {
    const normalizedUnknownFields = normalizeTripBriefUnknownFields(unknownFields, brief)
    if (!normalizedUnknownFields) throw new Error('暂未知项目必须是空白的旅行信息字段。')
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      trip.brief = { ...EMPTY_BRIEF, ...clone(brief) }
      trip.briefUnknownFields = normalizedUnknownFields
      trip.title = trip.brief.destination.trim() || '新的旅行'
      trip.updatedAt = new Date().toISOString()
    })
  }

  /** 仅应用用户确认的简报提案；同字段在提案生成后被修改时拒绝覆盖。 */
  async applyBriefProposal(tripId: string, messageId: string, conversationId?: string): Promise<void> {
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      const targetConversationId = conversationId ?? trip.activeConversationId
      const message = trip.messages.find((item) => item.id === messageId && item.conversationId === targetConversationId && item.role === 'assistant')
      if (!message?.briefProposal) throw new Error('找不到待审阅的旅行信息提案。')
      if (message.briefProposalAppliedAt) return

      const { base, changes } = message.briefProposal
      const conflicts = Object.keys(changes).filter((field) => {
        const key = field as keyof TripBrief
        return trip.brief[key] !== base[key] && trip.brief[key] !== changes[key]
      })
      if (conflicts.length) throw new Error(`旅行信息已发生变化（${conflicts.map(briefFieldLabel).join('、')}），请打开“旅行信息”核对后再应用。`)

      const nextBrief = { ...trip.brief, ...clone(changes) }
      trip.briefUnknownFields = trip.briefUnknownFields.filter((field) => !nextBrief[field].trim())
      validateBriefDates(nextBrief)
      const now = new Date().toISOString()
      trip.brief = nextBrief
      trip.title = nextBrief.destination.trim() || '新的旅行'
      message.briefProposalAppliedAt = now
      trip.updatedAt = now
    })
  }

  /** 删除单趟旅行的本地对话、来源和版本快照。 */
  async deleteTrip(tripId: string): Promise<void> {
    await this.transact((data) => {
      const index = data.trips.findIndex((trip) => trip.id === tripId)
      if (index < 0) throw new Error('找不到这趟旅行。')
      data.trips.splice(index, 1)
      if (data.selectedTripId === tripId) data.selectedTripId = data.trips[0]?.id ?? null
    })
  }

  /** 移除单条来源并解除其证据、位置和路线引用。 */
  async deleteSource(tripId: string, sourceId: string): Promise<void> {
    await this.transact((data) => {
      const index = data.trips.findIndex((trip) => trip.id === tripId)
      if (index < 0) throw new Error('找不到这趟旅行。')
      const trip = removeSourceFromTrip(data.trips[index], sourceId)
      trip.updatedAt = new Date().toISOString()
      trip.revisions = trip.revisions.map((revision) => revision.itinerary
        ? { ...revision, content: itineraryToMarkdown(revision.itinerary, trip.sources) }
        : revision)
      data.trips[index] = trip
    })
  }

  /** 保存对话消息并更新时间，模型失败时用户输入仍会保留。 */
  async appendMessage(tripId: string, input: ChatMessageInput, conversationId?: string): Promise<void> {
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      const targetConversationId = conversationId ?? input.conversationId ?? trip.activeConversationId
      const conversation = trip.conversations.find((item) => item.id === targetConversationId)
      if (!conversation || (input.conversationId !== undefined && input.conversationId !== targetConversationId)) {
        throw new Error('对话消息所属的话题无效。')
      }
      const message: ChatMessage = { ...input, conversationId: targetConversationId }
      if (!isChatMessage(message)) throw new Error('对话消息结构无效，无法保存。')
      if (trip.messages.some((item) => item.id === message.id)) throw new Error('对话消息 ID 已存在，无法重复保存。')
      const availableIds = new Set(trip.sources.map((source) => source.id))
      const referencedIds = [
        ...message.sourceIds,
        ...(message.agentRunProgress?.sourceIds ?? []),
        ...(message.preparationOptions ?? []).flatMap((item) => item.sourceIds),
        ...(message.itineraryOptions ?? []).flatMap((option) => itinerarySourceIds(option))
      ]
      if (referencedIds.some((id) => !availableIds.has(id))) {
        throw new Error('对话方案引用了当前旅行中不存在的来源，请重新检索后再提交。')
      }
      const itineraryEvidenceIds = (message.itineraryOptions ?? []).flatMap((option) => itineraryEvidenceIdsRequiringSuccess(option))
      if (itineraryEvidenceIds.some((id) => !trip.sources.some((source) => source.id === id && source.status === 'success'))) {
        throw new Error('行程地点只能引用当前旅行中的成功来源。')
      }
      if ((message.itineraryOptions ?? []).some((option) =>
        !lodgingCommutesHaveValidSources(option, trip.brief.lodgingLocation, trip.sources))) {
        throw new Error('住宿接驳必须引用当前住宿地点、每日边界地点和匹配的成功路线来源。')
      }
      const firstUserMessage = message.role === 'user' && !trip.messages.some((item) =>
        item.conversationId === targetConversationId && item.role === 'user')
      if (message.role === 'user') {
        for (const previous of trip.messages) {
          if (previous.conversationId === targetConversationId && previous.role === 'user') delete previous.agentRunProgress
        }
      } else {
        const pendingUser = [...trip.messages].reverse().find((item) =>
          item.conversationId === targetConversationId && item.role === 'user')
        if (pendingUser) delete pendingUser.agentRunProgress
      }
      trip.messages.push(message)
      if (firstUserMessage && conversation.title === '新话题') {
        conversation.title = conversationTitleFromMessage(message.content)
      }
      conversation.updatedAt = message.createdAt
      trip.updatedAt = message.createdAt
    })
  }

  /** 原子保存未完成工具轮次，限制恢复范围为话题最后一条待回复用户消息。 */
  async updateAgentRunProgress(tripId: string, messageId: string, progress: AgentRunProgress): Promise<void> {
    if (!isAgentRunProgress(progress)) throw new Error('模型工具恢复点结构无效，无法保存。')
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      const message = trip.messages.find((item) => item.id === messageId)
      const latestMessage = [...trip.messages].reverse().find((item) => item.conversationId === message?.conversationId)
      if (!message || message.role !== 'user' || latestMessage?.id !== messageId) {
        throw new Error('只能保存当前话题最后一条待回复消息的恢复点。')
      }
      const availableIds = new Set(trip.sources.map((source) => source.id))
      if (progress.sourceIds.some((id) => !availableIds.has(id))) throw new Error('恢复点引用了当前旅行中不存在的来源。')
      message.agentRunProgress = clone(progress)
      const now = new Date().toISOString()
      const conversation = trip.conversations.find((item) => item.id === message.conversationId)
      if (conversation) conversation.updatedAt = now
      trip.updatedAt = now
    })
  }

  /** 去重保存来源并返回与输入顺序一致的记录 ID。 */
  async saveSources(tripId: string, sources: SourceRecord[]): Promise<string[]> {
    let ids: string[] = []
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      ids = sources.map((source) => {
        const existing = trip.sources.find((item) => sameSourceIdentity(item, source))
        if (existing) {
          if (source.kind === 'plugin') existing.title = source.title
          existing.summary = source.summary
          existing.fetchedAt = source.fetchedAt
          existing.status = source.status
          updateSourceMetadata(existing, source)
          if (source.location) existing.location = clone(source.location)
          if (source.retry) existing.retry = clone(source.retry)
          else delete existing.retry
          if (source.retrySkippedAt) existing.retrySkippedAt = source.retrySkippedAt
          else delete existing.retrySkippedAt
          return existing.id
        }
        trip.sources.unshift(source)
        return source.id
      })
      trip.updatedAt = new Date().toISOString()
    })
    return ids
  }

  /** 用单来源重试结果更新原失败记录，并将其余搜索结果作为独立来源追加。 */
  async applySourceRetryResult(tripId: string, sourceId: string, sources: SourceRecord[], output: string): Promise<void> {
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      const index = trip.sources.findIndex((item) => item.id === sourceId)
      const previous = trip.sources[index]
      if (!previous?.retry || previous.status === 'success') throw new Error('该来源已不可重试，请刷新来源列表。')

      const now = new Date().toISOString()
      if (sources.length === 0) {
        previous.summary = output.slice(0, 800) || '重试未返回来源结果。'
        previous.fetchedAt = now
        previous.status = 'unavailable'
        delete previous.retrySkippedAt
      } else {
        const [first, ...additional] = sources
        trip.sources[index] = { ...clone(first), id: sourceId }
        for (const source of additional) {
          // 插件来源还要比较稳定连接器 ID 和标题，避免同服务的不同工具相互覆盖。
          const existing = trip.sources.find((item) => item.id !== sourceId && sameSourceIdentity(item, source))
          if (existing) {
            existing.title = source.title
            existing.summary = source.summary
            existing.fetchedAt = source.fetchedAt
            existing.status = source.status
            updateSourceMetadata(existing, source)
            if (source.location) existing.location = clone(source.location)
            if (source.retry) existing.retry = clone(source.retry)
            else delete existing.retry
            if (source.retrySkippedAt) existing.retrySkippedAt = source.retrySkippedAt
            else delete existing.retrySkippedAt
          } else {
            trip.sources.unshift(clone(source))
          }
        }
      }
      trip.updatedAt = now
    })
  }

  /** 记录用户跳过单来源重试，保留失败证据但关闭该条重试动作。 */
  async skipSourceRetry(tripId: string, sourceId: string): Promise<void> {
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      const source = trip.sources.find((item) => item.id === sourceId)
      if (!source?.retry || source.status === 'success') throw new Error('该来源当前没有可跳过的重试。')
      delete source.retry
      source.retrySkippedAt = new Date().toISOString()
      trip.updatedAt = source.retrySkippedAt
    })
  }

  /** 将用户明确选中的助手回复写成新的行程版本。 */
  async saveRevision(tripId: string, messageId: string, itineraryId?: string, conversationId?: string): Promise<void> {
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      const targetConversationId = conversationId ?? trip.activeConversationId
      const message = trip.messages.find((item) => item.id === messageId && item.conversationId === targetConversationId && item.role === 'assistant')
      if (!message) throw new Error('找不到可保存的方案。')
      const proposedItinerary = itineraryId
        ? message.itineraryOptions?.find((option) => option.id === itineraryId)
        : undefined
      if (itineraryId && !proposedItinerary) throw new Error('找不到这套候选行程，请重新生成后再审阅。')
      const existingRevision = proposedItinerary
        ? trip.revisions.find((revision) => revision.itinerary?.id === proposedItinerary.id)
        : undefined
      if (existingRevision) throw new Error(`这套候选已保存为第 ${existingRevision.number} 版。`)
      if (proposedItinerary && message.rejectedItineraryOptionIds?.includes(proposedItinerary.id)) {
        throw new Error('这套候选已被拒绝；撤销拒绝后才能继续审阅。')
      }
      if (message.itineraryOptions?.length && !proposedItinerary) throw new Error('请选择一套候选行程再保存。')
      if (proposedItinerary) {
        const latestMessageId = latestUnrejectedItineraryMessageId(trip.messages, targetConversationId)
        if (latestMessageId !== message.id) {
          throw new Error('已有更新草案，请在最新草案上确认。')
        }
      }
      const activeItinerary = trip.revisions.find((revision) => revision.id === trip.activeRevisionId)?.itinerary
      const preservation = proposedItinerary
        ? preserveLockedStops(activeItinerary, proposedItinerary)
        : { itinerary: undefined, conflicts: [] }
      if (preservation.conflicts.length) throw new Error(`新方案与已固定安排冲突：${preservation.conflicts.join(' ')}`)
      const itinerary = preservation.itinerary
      if (itinerary) assertScheduleFeasible(itinerary, trip.brief)
      const itineraryReferences = itinerary ? itinerarySourceIds(itinerary) : []
      if (itineraryReferences.some((id) => !trip.sources.some((source) => source.id === id))) {
        throw new Error('行程引用的来源不属于当前旅行，请重新检索后再保存。')
      }
      if ((itinerary ? itineraryEvidenceIdsRequiringSuccess(itinerary) : [])
        .some((id) => !trip.sources.some((source) => source.id === id && source.status === 'success'))) {
        throw new Error('当前行程引用的来源已经失败；请重新检索或移除失效依据后再采纳。')
      }
      if (itinerary && !lodgingCommutesHaveValidSources(itinerary, trip.brief.lodgingLocation, trip.sources)) {
        throw new Error('住宿接驳必须引用当前住宿地点、每日边界地点和匹配的成功路线来源。')
      }
      const revision: ItineraryRevision = {
        id: randomUUID(),
        number: (trip.revisions.at(-1)?.number ?? 0) + 1,
        createdAt: new Date().toISOString(),
        summary: itinerary?.title || message.content.trim().split('\n')[0].slice(0, 90) || `行程方案 ${trip.revisions.length + 1}`,
        content: itinerary ? itineraryToMarkdown(itinerary, trip.sources) : message.content,
        sourceIds: [...new Set([...message.sourceIds, ...itineraryReferences])],
        ...(itinerary ? { itinerary: clone(itinerary) } : {})
      }
      trip.revisions.push(revision)
      trip.activeRevisionId = revision.id
      trip.updatedAt = revision.createdAt
    })
  }

  /** 记录或撤销用户对单个候选方案的拒绝，不删除原始提案。 */
  async setItineraryOptionRejected(
    tripId: string, messageId: string, itineraryId: string, rejected: boolean, conversationId?: string
  ): Promise<void> {
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      const targetConversationId = conversationId ?? trip.activeConversationId
      const message = trip.messages.find((item) => item.id === messageId && item.conversationId === targetConversationId && item.role === 'assistant')
      if (!message?.itineraryOptions?.some((option) => option.id === itineraryId)) {
        throw new Error('找不到这套候选行程，请重新生成后再审阅。')
      }
      const existingRevision = trip.revisions.find((revision) => revision.itinerary?.id === itineraryId)
      if (rejected && existingRevision) throw new Error(`这套候选已保存为第 ${existingRevision.number} 版，不能再标记为拒绝。`)
      const rejectedIds = new Set(message.rejectedItineraryOptionIds ?? [])
      if (rejected) rejectedIds.add(itineraryId)
      else rejectedIds.delete(itineraryId)
      if (rejectedIds.size) {
        message.rejectedItineraryOptionIds = message.itineraryOptions
          .filter((option) => rejectedIds.has(option.id))
          .map((option) => option.id)
      } else {
        delete message.rejectedItineraryOptionIds
      }
      trip.updatedAt = new Date().toISOString()
    })
  }

  /** 基于仍处于活动状态的版本保存用户编辑，并生成新的不可变行程快照。 */
  async saveEditedRevision(tripId: string, baseRevisionId: string, input: unknown): Promise<void> {
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      if (trip.activeRevisionId !== baseRevisionId) throw new Error('行程版本已变化，请先切回当前版本或重新载入后再保存。')
      const baseRevision = trip.revisions.find((revision) => revision.id === baseRevisionId)
      if (!baseRevision) throw new Error('找不到编辑起点版本，请重新载入行程。')
      const normalized = normalizeEditedItinerary(clearStaleRouteEvidence(input, baseRevision.itinerary, trip.brief.lodgingLocation))
      const preservation = preserveLockedStops(baseRevision.itinerary, normalized, true)
      if (preservation.conflicts.length) throw new Error(`请先处理已固定安排：${preservation.conflicts.join(' ')}`)
      const itinerary = preservation.itinerary
      assertScheduleFeasible(itinerary, trip.brief)
      const priorStops = new Map((baseRevision.itinerary?.days.flatMap((day) => day.stops) ?? []).map((stop) => [stop.id, stop]))
      for (const day of itinerary.days) {
        for (const stop of day.stops) {
          const previous = priorStops.get(stop.id)
          const previousDayDate = baseRevision.itinerary?.days.find((item) => item.stops.some((candidate) => candidate.id === stop.id))?.date
          const currentDayDate = day.date
          const evidenceFieldsChanged = previous && (
            previous.name !== stop.name || previous.area !== stop.area || previous.time !== stop.time ||
            previous.durationMinutes !== stop.durationMinutes || previous.category !== stop.category ||
            previous.notes !== stop.notes || previous.transitToNext !== stop.transitToNext || previousDayDate !== currentDayDate ||
            !sameItineraryLocationIdentity(previous.location, stop.location)
          )
          if (!previous || evidenceFieldsChanged) {
            stop.sourceIds = []
            stop.evidenceLevel = 'pending'
            stop.factClaims = []
          }
          if (previous && previous.name !== stop.name && previous.location?.sourceId === stop.location?.sourceId) {
            delete stop.location
          }
          const sameTransitEvidence = previous?.transitEstimate && stop.transitEstimate &&
            previous.transitEstimate.sourceId === stop.transitEstimate.sourceId &&
            previous.transitEstimate.destinationStopId === stop.transitEstimate.destinationStopId &&
            previous.transitEstimate.mode === stop.transitEstimate.mode &&
            previous.transitEstimate.optionNumber === stop.transitEstimate.optionNumber &&
            previous.transitEstimate.fetchedAt === stop.transitEstimate.fetchedAt &&
            previous.transitEstimate.queryDate === stop.transitEstimate.queryDate &&
            previous.transitEstimate.queryTime === stop.transitEstimate.queryTime &&
            previous.transitEstimate.fareFen === stop.transitEstimate.fareFen &&
            previous.transitEstimate.tollFen === stop.transitEstimate.tollFen
          if (previous && previous.transitToNext !== stop.transitToNext && sameTransitEvidence) {
            delete stop.transitEstimate
          }
        }
      }
      const selectedSourceIds = itinerary.days.flatMap((day) => [
        ...(day.weather?.sourceId ? [day.weather.sourceId] : []),
        ...day.stops.flatMap((stop) => [
        ...(stop.sourceIds ?? []),
        ...(stop.factClaims ?? []).flatMap((claim) => claim.sourceId ? [claim.sourceId] : []),
        ...(stop.location ? [stop.location.sourceId] : []),
        ...(stop.transitEstimate ? [stop.transitEstimate.sourceId] : [])
        ])
      ])
      selectedSourceIds.push(...itinerary.days.flatMap((day) => (day.lodgingCommutes ?? []).map((commute) => commute.sourceId)))
      if (selectedSourceIds.some((sourceId) => !trip.sources.some((source) => source.id === sourceId))) {
        throw new Error('行程引用的来源不属于当前旅行，请重新检索后再保存。')
      }
      const itineraryEvidenceIds = itineraryEvidenceIdsRequiringSuccess(itinerary)
      if (itineraryEvidenceIds.some((sourceId) => !trip.sources.some((source) => source.id === sourceId && source.status === 'success'))) {
        throw new Error('行程地点只能引用当前旅行中的成功来源。')
      }
      if (!lodgingCommutesHaveValidSources(itinerary, trip.brief.lodgingLocation, trip.sources)) {
        throw new Error('修改后的住宿接驳与当前住宿、地点或路线来源不一致；请重新查询。')
      }
      const routeSourceIds = itinerary.days.flatMap((day) => day.stops.flatMap((stop) =>
        stop.transitEstimate ? [stop.transitEstimate.sourceId] : []
      ))
      if (routeSourceIds.some((sourceId) => !trip.sources.some((source) => source.id === sourceId && source.kind === 'route'))) {
        throw new Error('交通估算引用的来源不是有效路线来源，请重新查询后再保存。')
      }
      const createdAt = new Date().toISOString()
      const revision: ItineraryRevision = {
        id: randomUUID(),
        number: (trip.revisions.at(-1)?.number ?? 0) + 1,
        createdAt,
        summary: itinerary.title,
        content: itineraryToMarkdown(itinerary, trip.sources),
        sourceIds: [...new Set([...baseRevision.sourceIds, ...selectedSourceIds])],
        itinerary
      }
      trip.revisions.push(revision)
      trip.activeRevisionId = revision.id
      trip.updatedAt = createdAt
    })
  }

  /** 将用户明确采纳的助手准备建议加入旅行清单，并按候选 ID 去重。 */
  async savePreparationItems(tripId: string, messageId: string, conversationId?: string): Promise<void> {
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      const targetConversationId = conversationId ?? trip.activeConversationId
      const message = trip.messages.find((item) => item.id === messageId && item.conversationId === targetConversationId && item.role === 'assistant')
      if (!message?.preparationOptions?.length) throw new Error('找不到可添加的准备建议。')
      /** 以类别、规范化标题、日期和停靠点识别重复准备事项。 */
      const keyFor = (item: PreparationItem): string => `${item.category}\u0000${item.title.normalize('NFKC').trim().toLocaleLowerCase()}\u0000${item.itineraryDate}\u0000${item.dueDate}\u0000${item.legacyDate ?? ''}\u0000${item.locationContext?.stopId ?? ''}`
      const knownItems = new Set(trip.preparationItems.map(keyFor))
      const additions = message.preparationOptions.filter((item) => {
        const key = keyFor(item)
        if (knownItems.has(key)) return false
        knownItems.add(key)
        return true
      })
      const sourceIds = new Set(trip.sources.map((source) => source.id))
      if (additions.some((item) => item.sourceIds.some((sourceId) => !sourceIds.has(sourceId)))) {
        throw new Error('准备建议引用的来源已被移除，请重新检索后再添加。')
      }
      trip.preparationItems.push(...additions.map(clone))
      trip.updatedAt = new Date().toISOString()
    })
  }

  /** 保存用户对单条准备事项的勾选状态。 */
  async setPreparationItemChecked(tripId: string, itemId: string, checked: boolean): Promise<void> {
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      const item = trip.preparationItems.find((candidate) => candidate.id === itemId)
      if (!item) throw new Error('找不到这条准备事项。')
      item.checked = checked
      trip.updatedAt = new Date().toISOString()
    })
  }

  /** 更新用户可编辑字段，并将手动修改后的事实重新标为待核验。 */
  async updatePreparationItem(tripId: string, itemId: string, input: unknown): Promise<void> {
    const update = normalizePreparationItemUpdate(input)
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      const item = trip.preparationItems.find((candidate) => candidate.id === itemId)
      if (!item) throw new Error('找不到这条准备事项。')
      if (update.packingSection !== undefined && item.category !== 'packing') {
        throw new Error('只有行李事项可以修改装包位置。')
      }
      if (item.legacyDate && !update.legacyDateAction) {
        throw new Error('请先确认旧版日期是适用行程日、完成截止日，还是不再保留。')
      }
      if (!item.legacyDate && update.legacyDateAction) {
        throw new Error('这条事项没有待确认的旧版日期。')
      }
      if (item.legacyDate && update.legacyDateAction === 'itinerary' && !isCalendarDate(update.itineraryDate || item.legacyDate)) {
        throw new Error('旧版日期格式无效；请选择有效的适用行程日，或清除旧日期。')
      }
      if (item.legacyDate && update.legacyDateAction === 'deadline' && !isCalendarDate(update.dueDate || item.legacyDate)) {
        throw new Error('旧版日期格式无效；请选择有效的完成截止日，或清除旧日期。')
      }
      const itineraryDate = item.legacyDate && update.legacyDateAction === 'itinerary'
        ? update.itineraryDate || item.legacyDate
        : update.itineraryDate
      const dueDate = item.legacyDate && update.legacyDateAction === 'deadline'
        ? update.dueDate || item.legacyDate
        : update.dueDate
      if (!item.legacyDate && item.title === update.title && item.detail === update.detail && item.itineraryDate === itineraryDate && item.dueDate === dueDate &&
        (update.packingSection === undefined || item.packingSection === update.packingSection)) return
      item.title = update.title
      item.detail = update.detail
      item.itineraryDate = itineraryDate
      item.dueDate = dueDate
      delete item.legacyDate
      delete item.locationContext
      if (update.packingSection !== undefined) item.packingSection = update.packingSection
      item.evidenceLevel = 'pending'
      trip.updatedAt = new Date().toISOString()
    })
  }

  /** 删除用户不再需要的单条准备事项，不影响原始对话建议和来源。 */
  async deletePreparationItem(tripId: string, itemId: string): Promise<void> {
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      const index = trip.preparationItems.findIndex((candidate) => candidate.id === itemId)
      if (index < 0) throw new Error('找不到这条准备事项。')
      trip.preparationItems.splice(index, 1)
      trip.updatedAt = new Date().toISOString()
    })
  }

  /** 切换历史版本时保持快照不变。 */
  async activateRevision(tripId: string, revisionId: string): Promise<void> {
    await this.transact((data) => {
      const trip = this.requireTrip(data, tripId)
      if (!trip.revisions.some((revision) => revision.id === revisionId)) throw new Error('找不到该行程版本。')
      trip.activeRevisionId = revisionId
      trip.updatedAt = new Date().toISOString()
    })
  }

  /** 校验并保存模型、内置连接器和非敏感 MCP 配置。 */
  async updateSettings(settings: AppSettings): Promise<void> {
    if (!isSettings(settings)) throw new Error('模型或连接器设置无效。')
    await this.transact((data) => {
      data.settings = clone(settings)
    })
  }

  /** 更新普通设置并保留事务执行时最新的 MCP 服务列表。 */
  async updateSettingsPreservingMcpServers(settings: AppSettings): Promise<void> {
    await this.transact((data) => {
      const next = { ...clone(settings), mcpServers: clone(data.settings.mcpServers) }
      if (!isSettings(next)) throw new Error('模型或连接器设置无效。')
      data.settings = next
    })
  }

  /** 仅更新 MCP 服务列表，避免设置页的旧快照覆盖并发配置。 */
  async updateMcpServers(servers: McpServerSettings[]): Promise<void> {
    await this.transact((data) => {
      const next = { ...data.settings, mcpServers: clone(servers) }
      if (!isSettings(next)) throw new Error('MCP 服务配置无效。')
      data.settings = next
    })
  }

  /** 在串行队列中持久化一份完整状态；失败时不替换内存状态。 */
  private async transact(mutate: (data: Database) => void): Promise<void> {
    const action = this.writeQueue.then(async () => {
      const next = clone(this.database)
      mutate(next)
      await this.persist(next)
      this.database = next
    })
    this.writeQueue = action.catch(() => undefined)
    await action
  }

  /** 通过同目录临时文件原子替换数据库。 */
  private async persist(data: Database): Promise<void> {
    const tempPath = `${this.filePath}.tmp`
    await writeFile(tempPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(tempPath, this.filePath)
  }

  /** 统一处理不存在的旅行 ID，避免调用方漏掉数据边界。 */
  private requireTrip(data: Database, tripId: string): Trip {
    const trip = data.trips.find((item) => item.id === tripId)
    if (!trip) throw new Error('找不到这趟旅行。')
    return trip
  }
}

/** 保存新版本前拒绝时段重叠和路线时长超出空档的安排。 */
function assertScheduleFeasible(itinerary: ItineraryOption, tripBrief: TripBrief): void {
  const conflicts = itinerary.days.flatMap((day, dayIndex) =>
    analyzeDaySchedule(day, tripBrief)
      .filter((finding) => finding.code === 'stop-overlap' || finding.code === 'schedule-overlap' || finding.code === 'route-buffer')
      .map((finding) => `${day.date || `第 ${dayIndex + 1} 天`}：${finding.message}`)
  ).concat(analyzeMealRequirements(itinerary.days, itinerary.mealRequirements).map((finding) => finding.message))
  if (!conflicts.length) return

  const visibleConflicts = conflicts.slice(0, 8)
  const remaining = conflicts.length > visibleConflicts.length
    ? `；另有 ${conflicts.length - visibleConflicts.length} 处冲突`
    : ''
  throw new Error(`行程存在 ${conflicts.length} 处明确时段重叠或接驳冲突，请修正后再保存：${visibleConflicts.join('；')}${remaining}`)
}

/** 从目标话题倒序找出最后一条含未拒绝草案的消息，防止保存已过期方案。 */
function latestUnrejectedItineraryMessageId(messages: ChatMessage[], conversationId: string): string | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (message?.conversationId !== conversationId || message.role !== 'assistant') continue
    if (message.itineraryOptions?.some((option) => !message.rejectedItineraryOptionIds?.includes(option.id))) return message.id
  }
  return null
}
