/** 三栏旅行工作区：左侧旅行、中央对话/行程、右侧网页和来源。 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  Archive, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, Check, RotateCw,
  Compass, Globe2, Luggage, Map as MapIcon, MessageCircle, MousePointer2, PencilLine,
  PanelRightClose, Plus, Search, Settings2, ShieldCheck, Square,
  Trash2, Upload, X
} from 'lucide-react'
import type { AppSnapshot, BrowserActivityPhase, BrowserNavigationAction, BrowserState, PreparationItemUpdate, RouteEstimateResponse, RouteMode, SourceRecord, Trip, UserProvidedContentInput, WorkspaceView } from '@shared/types'
import { ResearchPanelTabs } from './ResearchPanelTabs'
import { TripConversationList } from './TripConversationList'
import { AgentProgress, type AgentProgressActivity } from './AgentProgress'
import { SkipLink } from './SkipLink'
import { BriefReadinessPanel, ChatBubble, WelcomePanel } from './ConversationView'
import { ItineraryView } from './ItineraryWorkspace'
import { StartupScreen } from './StartupScreen'
import { SettingsModal } from './SettingsModal'
import { DeleteSourceModal, PasteResearchModal, SourcesPanel } from './SourcesPanel'
import { CreateTripModal, DeleteConversationModal, DeleteTripModal, TripBriefModal } from './TripDialogs'
import { PreparationView } from './PreparationView'
import { Announcement } from './components/Announcement'
import { isNearConversationEnd, scrollBehaviorForMotionPreference } from './conversation-scroll'
import { runRevisionActivation } from './revision-activation'
import { runStartupLoad } from './startup-load'
import { errorMessage } from './ui-format'
import { getModelCredentialState } from './model-credential-state'
import { findResumableMessage } from '@shared/chat-recovery'
import { conversationMessages } from '@shared/conversations'
import { resolveResearchBrowserInput } from '@shared/research-browser-input'
import brandSymbol from '../../../build/icon.svg?url'

const BROWSER_ACTIVITY_PHASE_LABELS: Record<BrowserActivityPhase, string> = {
  opening: '打开网页',
  locating: '定位目标',
  moving: '移动光标',
  pressing: '点击中',
  clicked: '已点击',
  scrolling: '滚动页面',
  scrolled: '滚动完成',
  reading: '读取页面'
}

/** 主界面负责跨模块状态与用户动作，业务数据仍由 Electron 主进程持久化。 */
export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [startupBusy, setStartupBusy] = useState(true)
  const [view, setView] = useState<WorkspaceView>('chat')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [panelTab, setPanelTab] = useState<'sources' | 'web'>('sources')
  const [rightOpen, setRightOpen] = useState(true)
  const [browserAgentActive, setBrowserAgentActive] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [revisionTargetTitle, setRevisionTargetTitle] = useState('')
  const [activeTripOperationCounts, setActiveTripOperationCounts] = useState<Record<string, number>>({})
  const [runningRequest, setRunningRequest] = useState<string | null>(null)
  const [runningTripId, setRunningTripId] = useState<string | null>(null)
  const [runningConversationId, setRunningConversationId] = useState<string | null>(null)
  const [agentStatus, setAgentStatus] = useState('')
  const [agentActivities, setAgentActivities] = useState<AgentProgressActivity[]>([])
  const [agentStartedAt, setAgentStartedAt] = useState<number | null>(null)
  const [agentFinishedAt, setAgentFinishedAt] = useState<number | null>(null)
  const [agentOutcome, setAgentOutcome] = useState<'running' | 'completed' | 'failed' | null>(null)
  const [agentProgressTripId, setAgentProgressTripId] = useState<string | null>(null)
  const [agentProgressConversationId, setAgentProgressConversationId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [browserState, setBrowserState] = useState<BrowserState>({ url: '', title: '', loading: false, error: '', canGoBack: false, canGoForward: false })
  const [browserUrl, setBrowserUrl] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pastedSourceOpen, setPastedSourceOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [briefOpen, setBriefOpen] = useState(false)
  const [deleteTripId, setDeleteTripId] = useState<string | null>(null)
  const [deletingTripId, setDeletingTripId] = useState<string | null>(null)
  const [conversationToDeleteRef, setConversationToDeleteRef] = useState<{ tripId: string; conversationId: string } | null>(null)
  const [deletingConversationKey, setDeletingConversationKey] = useState<string | null>(null)
  const [sourceToDelete, setSourceToDelete] = useState<{ tripId: string; source: SourceRecord } | null>(null)
  const [deletingSourceId, setDeletingSourceId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [activatingRevision, setActivatingRevision] = useState(false)
  const [toast, setToast] = useState('')
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [retryingSourceIds, setRetryingSourceIds] = useState<Set<string>>(() => new Set())
  const browserSurface = useRef<HTMLDivElement>(null)
  const composerTextarea = useRef<HTMLTextAreaElement>(null)
  const chatScroll = useRef<HTMLDivElement>(null)
  const chatEnd = useRef<HTMLDivElement>(null)
  const shouldFollowChat = useRef(true)
  const activeRequest = useRef<{ requestId: string; tripId: string; conversationId: string } | null>(null)
  const revisionActivationLock = useRef(false)
  const startupLoadLock = useRef(false)

  const selectedTrip = useMemo(
    () => snapshot?.trips.find((trip) => trip.id === snapshot.selectedTripId) ?? null,
    [snapshot]
  )
  const deleteTrip = snapshot?.trips.find((trip) => trip.id === deleteTripId) ?? null
  const conversationToDeleteTrip = snapshot?.trips.find((trip) => trip.id === conversationToDeleteRef?.tripId) ?? null
  const conversationToDelete = conversationToDeleteTrip?.conversations.find((item) => item.id === conversationToDeleteRef?.conversationId) ?? null
  const deleteConversationHasActivity = Boolean(conversationToDelete && conversationToDeleteTrip &&
    runningTripId === conversationToDeleteTrip.id && runningConversationId === conversationToDelete.id)
  const deleteTripHasActivity = Boolean(deleteTrip && (
    runningTripId === deleteTrip.id ||
    (activeTripOperationCounts[deleteTrip.id] ?? 0) > 0
  ))
  const sourceToDeleteHasActivity = Boolean(sourceToDelete && (
    runningTripId === sourceToDelete.tripId ||
    (activeTripOperationCounts[sourceToDelete.tripId] ?? 0) > 0
  ))
  const activeRevision = selectedTrip?.revisions.find((revision) => revision.id === selectedTrip.activeRevisionId) ?? null
  const activeConversation = selectedTrip?.conversations.find((conversation) => conversation.id === selectedTrip.activeConversationId) ?? null
  const activeConversationMessages = useMemo(() => selectedTrip && activeConversation
    ? conversationMessages(selectedTrip, activeConversation.id)
    : [], [selectedTrip, activeConversation])
  const proposalHistory = useMemo(() => {
    const proposalNumbers = new Map<string, number>()
    let proposalNumber = 0
    let latestActiveProposalId: string | null = null
    for (const message of activeConversationMessages) {
      if (message.role !== 'assistant' || !message.itineraryOptions?.length) continue
      proposalNumber += 1
      proposalNumbers.set(message.id, proposalNumber)
      if (message.itineraryOptions.some((option) => !message.rejectedItineraryOptionIds?.includes(option.id))) {
        latestActiveProposalId = message.id
      }
    }
    return { proposalNumbers, latestActiveProposalId }
  }, [activeConversationMessages])
  const currentDraftKey = selectedTrip && activeConversation
    ? conversationDraftKey(selectedTrip.id, activeConversation.id)
    : 'newTrip'
  const currentConversationRunning = selectedTrip?.id === runningTripId && activeConversation?.id === runningConversationId
  const messageSources = useMemo(() => {
    const byId = new Map<string, SourceRecord>()
    selectedTrip?.sources.forEach((source) => byId.set(source.id, source))
    return byId
  }, [selectedTrip])
  const draft = drafts[currentDraftKey] ?? ''
  const resumableMessageId = selectedTrip && !runningRequest
    ? findResumableMessage(activeConversationMessages)?.id ?? null
    : null

  useEffect(() => {
    setRevisionTargetTitle('')
  }, [selectedTrip?.id, activeConversation?.id])

  /** 只在用户请求或首次启动时加载快照；并发重试合并为一次请求。 */
  async function loadStartupSnapshot(): Promise<void> {
    setError('')
    await runStartupLoad(
      startupLoadLock,
      () => window.tripwise.getSnapshot(),
      setSnapshot,
      (reason) => setError(errorMessage(reason)),
      setStartupBusy
    )
  }

  /** 恢复本地旅行并订阅真实 Agent 事件，保留本轮工具时间线；用请求 ID 忽略过期结果。 */
  useEffect(() => {
    void loadStartupSnapshot()
    const unsubscribeAgent = window.tripwise.onAgentEvent((event) => {
      const active = activeRequest.current
      if (!active || event.requestId !== active.requestId || event.tripId !== active.tripId || event.conversationId !== active.conversationId) return
      if (event.type === 'status' || event.type === 'tool') {
        setAgentStatus(event.message)
      }
      if (event.type === 'tool') {
        const activity: AgentProgressActivity = {
          id: event.toolCallId ?? `${Date.now()}-${event.toolName ?? 'tool'}`,
          ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
          label: event.message,
          state: 'running'
        }
        setAgentActivities((current) => [...current, activity])
      }
      if (event.type === 'tool_result') {
        setAgentActivities((current) => {
          let index = -1
          for (let activityIndex = current.length - 1; activityIndex >= 0; activityIndex -= 1) {
            const activity = current[activityIndex]
            if (activity?.state === 'running' && event.toolCallId !== undefined && activity.toolCallId === event.toolCallId) {
              index = activityIndex
              break
            }
          }
          if (index < 0) return current
          return current.map((activity, activityIndex) => activityIndex === index
            ? {
                ...activity,
                detail: event.message,
                ...(event.toolFeedback?.length ? { feedback: event.toolFeedback } : {}),
                state: event.toolOutcome === 'completed' ? 'completed'
                  : event.toolOutcome === 'partial' ? 'partial' : 'failed'
              }
            : activity)
        })
      }
      if (event.type === 'tool' && event.toolName?.startsWith('research_browser_')) {
        setBrowserAgentActive(true)
        setPanelTab('web')
        setRightOpen(true)
      }
      if (event.type === 'complete' || event.type === 'error') {
        setBrowserAgentActive(false)
        activeRequest.current = null
        setRunningRequest(null)
        setRunningTripId(null)
        setRunningConversationId(null)
        setAgentFinishedAt(Date.now())
        setAgentOutcome(event.type === 'complete' ? 'completed' : 'failed')
        setAgentStatus(event.type === 'complete' ? '方案已生成' : '本轮未完成')
        if (event.type === 'error') {
          setAgentActivities((current) => current.map((activity) => activity.state === 'running'
            ? { ...activity, state: 'failed', detail: '本轮未完成' }
            : activity))
        }
        if (event.type === 'error') setError(event.message)
        void refreshSnapshot()
      }
    })
    const unsubscribeBrowser = window.tripwise.onBrowserState((state) => {
      setBrowserState(state)
      if (state.url) setBrowserUrl(state.url)
    })
    return () => {
      unsubscribeAgent()
      unsubscribeBrowser()
    }
  }, [])

  /** 自动收起短暂提示，避免旧通知一直覆盖旅行工作区。 */
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 4_000)
    return () => window.clearTimeout(timer)
  }, [toast])

  /** 切换旅行后清除只属于上一趟旅行的来源高亮。 */
  useEffect(() => {
    setSelectedSourceId(null)
  }, [selectedTrip?.id])

  /** 切换旅行或话题后，开始跟随该对话的最新内容。 */
  useEffect(() => {
    shouldFollowChat.current = true
  }, [selectedTrip?.id, activeConversation?.id])

  /** 用户主动翻阅旧消息后暂停自动跟随，回到底部再恢复。 */
  useEffect(() => {
    if (!shouldFollowChat.current) return
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    chatEnd.current?.scrollIntoView({ behavior: scrollBehaviorForMotionPreference(prefersReducedMotion), block: 'end' })
  }, [selectedTrip?.id, activeConversation?.id, activeConversationMessages.length, agentStatus])

  /** 将 native WebContentsView 精确放在右侧网页内容区域。 */
  useEffect(() => {
    const target = browserSurface.current
    if (!target) return
    /** 依据窗口和面板尺寸更新原生网页视图的位置及可见性。 */
    const update = (): void => {
      const rect = target.getBoundingClientRect()
      const visible = rightOpen && panelTab === 'web' && rect.width > 10 && rect.height > 10
      void window.tripwise.setResearchBounds({
        x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible
      })
    }
    const observer = new ResizeObserver(update)
    observer.observe(target)
    window.addEventListener('resize', update)
    update()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      void window.tripwise.setResearchBounds({ x: 0, y: 0, width: 0, height: 0, visible: false })
    }
  }, [panelTab, rightOpen, selectedTrip?.id])

  /** 刷新旅行资料并返回新快照，供交互动作复用。 */
  async function refreshSnapshot(): Promise<AppSnapshot> {
    const next = await window.tripwise.getSnapshot()
    setSnapshot(next)
    return next
  }

  /** 跟踪旅行级异步操作，让删除确认及时阻止并解释正在运行的工作。 */
  async function withTripOperation<T>(tripId: string, operation: () => Promise<T>): Promise<T> {
    setActiveTripOperationCounts((current) => ({ ...current, [tripId]: (current[tripId] ?? 0) + 1 }))
    try {
      return await operation()
    } finally {
      setActiveTripOperationCounts((current) => {
        const next = { ...current }
        const remaining = (next[tripId] ?? 1) - 1
        if (remaining > 0) next[tripId] = remaining
        else delete next[tripId]
        return next
      })
    }
  }

  /** 创建旅行后立即进入其对话工作区。 */
  async function createTrip(input: Parameters<typeof window.tripwise.createTrip>[0] = {}): Promise<void> {
    setSaving(true)
    try {
      const next = await window.tripwise.createTrip(input)
      setSnapshot(next)
      setView('chat')
      setCreateOpen(false)
      setToast('旅行已创建')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setSaving(false)
    }
  }

  /** 新建旅行内独立话题；用户确认过的旅行简报和行程仍由该旅行共享。 */
  async function createConversation(): Promise<void> {
    if (!selectedTrip) return
    try {
      setSnapshot(await window.tripwise.createConversation(selectedTrip.id))
      setView('chat')
      setError('')
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  /** 切换同一旅行的话题时只改变活动话题 ID，不拼接其他对话历史。 */
  async function selectConversation(conversationId: string): Promise<void> {
    if (!selectedTrip || conversationId === selectedTrip.activeConversationId) return
    try {
      setSnapshot(await window.tripwise.selectConversation(selectedTrip.id, conversationId))
      setView('chat')
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  /** 删除指定话题及草稿，旅行级来源、行程版本和准备清单继续保留。 */
  async function confirmDeleteConversation(): Promise<void> {
    if (!conversationToDeleteRef || !conversationToDelete || !conversationToDeleteTrip || deleteConversationHasActivity) return
    const { tripId, conversationId } = conversationToDeleteRef
    const key = conversationDraftKey(tripId, conversationId)
    if (deletingConversationKey) return
    setDeletingConversationKey(key)
    setError('')
    try {
      const next = await window.tripwise.deleteConversation(tripId, conversationId)
      setSnapshot(next)
      setDrafts((current) => {
        const updated = { ...current }
        delete updated[key]
        return updated
      })
      if (selectedTrip?.id === tripId && conversationToDeleteTrip.activeConversationId === conversationId) setView('chat')
      setConversationToDeleteRef(null)
      setToast('已删除话题')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setDeletingConversationKey(null)
    }
  }

  /** 删除前明确展示本地资料范围；主进程也会拒绝仍有任务运行的旅行。 */
  async function confirmDeleteTrip(): Promise<void> {
    if (!deleteTrip || deleteTripHasActivity || deletingTripId) return
    setDeletingTripId(deleteTrip.id)
    setError('')
    try {
      setSnapshot(await window.tripwise.deleteTrip(deleteTrip.id))
      setDeleteTripId(null)
      setToast('已删除这趟旅行')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setDeletingTripId(null)
    }
  }

  /** 发送当前旅行需求；首次使用时允许一句话直接创建旅行。 */
  async function submitMessage(event?: FormEvent): Promise<void> {
    event?.preventDefault()
    const content = draft.trim()
    if (!content || runningRequest) return
    shouldFollowChat.current = true
    setError('')
    try {
      let tripId = selectedTrip?.id
      let conversationId = selectedTrip?.activeConversationId
      if (!tripId) {
        const next = await window.tripwise.createTrip()
        setSnapshot(next)
        tripId = next.selectedTripId ?? undefined
        conversationId = next.trips.find((trip) => trip.id === tripId)?.activeConversationId
      }
      if (!tripId || !conversationId) throw new Error('当前对话不可用，请切换话题后重试。')
      setDrafts((previous) => ({ ...previous, [conversationDraftKey(tripId!, conversationId)]: '' }))
      setRevisionTargetTitle('')
      void startAgentRequest(tripId, conversationId, content)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  /** 用已保存的原始用户消息重新发起中断请求，不重复写入聊天记录。 */
  async function startAgentRequest(tripId: string, conversationId: string, content: string, resumeMessageId?: string): Promise<void> {
    const requestId = crypto.randomUUID()
    activeRequest.current = { requestId, tripId, conversationId }
    setBrowserAgentActive(false)
    setRunningRequest(requestId)
    setRunningTripId(tripId)
    setRunningConversationId(conversationId)
    setAgentProgressTripId(tripId)
    setAgentProgressConversationId(conversationId)
    setAgentStartedAt(Date.now())
    setAgentFinishedAt(null)
    setAgentOutcome('running')
    setAgentActivities([])
    setAgentStatus('正在整理行程…')
    setError('')
    try {
      await window.tripwise.sendMessage(requestId, tripId, conversationId, content, resumeMessageId)
      await refreshSnapshot()
    } catch (reason) {
      activeRequest.current = null
      setRunningRequest(null)
      setRunningTripId(null)
      setRunningConversationId(null)
      setAgentFinishedAt(Date.now())
      setAgentOutcome('failed')
      setAgentStatus('本轮未完成')
      setAgentActivities((current) => current.map((activity) => activity.state === 'running'
        ? { ...activity, state: 'failed', detail: '本轮未完成' }
        : activity))
      setBrowserAgentActive(false)
      setError(errorMessage(reason))
    }
  }

  /** 仅重试旅行对话中最后一条没有后续回复的用户消息。 */
  function retryInterruptedMessage(messageId: string): void {
    if (!selectedTrip || runningRequest) return
    const message = findResumableMessage(activeConversationMessages)
    if (!message || message.id !== messageId) return
    shouldFollowChat.current = true
    void startAgentRequest(selectedTrip.id, message.conversationId, message.content, message.id)
  }

  /** 取消正在运行的工具调用和模型请求。 */
  async function cancelRequest(): Promise<void> {
    if (!runningRequest) return
    await window.tripwise.cancelAgent(runningRequest)
    setAgentStatus('正在停止…')
  }

  /** 将消息中的来源链接打开到右侧隔离网页视图。 */
  async function openPage(url: string): Promise<void> {
    setPanelTab('web')
    setRightOpen(true)
    setBrowserUrl(url)
    try {
      await window.tripwise.navigateResearch(url)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  /** 由用户控制右侧隔离浏览器的历史导航；模型工具不调用此入口。 */
  async function navigateBrowserHistory(action: BrowserNavigationAction): Promise<void> {
    try {
      await window.tripwise.navigateResearchHistory(action)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  /** 导入网页后预填针对当前计划的下一步；保留用户已有草稿且不自动发送。 */
  async function importPage(): Promise<void> {
    if (!selectedTrip) return
    const tripId = selectedTrip.id
    try {
      await withTripOperation(tripId, async () => {
        setSnapshot(await window.tripwise.importVisiblePage(tripId))
      })
      setPanelTab('sources')
      setDrafts((previous) => {
        const key = conversationDraftKey(tripId, selectedTrip.activeConversationId)
        if (previous[key]?.trim()) return previous
        const hasPlan = selectedTrip.activeRevisionId !== null || proposalHistory.latestActiveProposalId !== null
        return { ...previous, [key]: researchImportPrompt(hasPlan) }
      })
      setToast('网页文字已保存到旅行资料')
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  /** 保存用户手动粘贴的攻略；仅在输入框为空时预填下一步，不覆盖已有内容。 */
  async function importPastedSource(input: UserProvidedContentInput): Promise<void> {
    if (!selectedTrip) throw new Error('请先打开一趟旅行。')
    const tripId = selectedTrip.id
    await withTripOperation(tripId, async () => {
      setSnapshot(await window.tripwise.importPastedContent(tripId, input))
    })
    setPastedSourceOpen(false)
    setPanelTab('sources')
    setDrafts((previous) => {
      const key = conversationDraftKey(tripId, selectedTrip.activeConversationId)
      if (previous[key]?.trim()) return previous
      const hasPlan = selectedTrip.activeRevisionId !== null || proposalHistory.latestActiveProposalId !== null
      return { ...previous, [key]: researchImportPrompt(hasPlan) }
    })
    setToast('攻略已保存到本机。发送消息后，内容才会提供给模型')
  }

  /** 将某条助手回复保存为新的、可恢复的行程版本。 */
  async function saveRevision(conversationId: string, messageId: string, itineraryId?: string): Promise<void> {
    if (!selectedTrip) return
    try {
      const next = await window.tripwise.saveRevision(selectedTrip.id, conversationId, messageId, itineraryId)
      setSnapshot(next)
      setView('itinerary')
      setToast('行程已保存为新版本')
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  /** 串行切换历史版本，并忽略切换旅行后才返回的旧快照。 */
  async function activateRevision(revisionId: string): Promise<void> {
    if (!selectedTrip || revisionActivationLock.current || revisionId === activeRevision?.id) return
    const tripId = selectedTrip.id
    try {
      const next = await runRevisionActivation(revisionActivationLock, async () => {
        setActivatingRevision(true)
        try {
          return await window.tripwise.activateRevision(tripId, revisionId)
        } finally {
          setActivatingRevision(false)
        }
      })
      if (next) setSnapshot((current) => current?.selectedTripId === tripId ? next : current)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  /** 保存用户对单个候选的拒绝或撤销，保留原始方案以便后续复查。 */
  async function setOptionRejected(conversationId: string, messageId: string, itineraryId: string, rejected: boolean): Promise<void> {
    if (!selectedTrip) return
    try {
      setSnapshot(await window.tripwise.setItineraryOptionRejected(selectedTrip.id, conversationId, messageId, itineraryId, rejected))
      setToast(rejected ? '已跳过这份方案，可以继续规划其他安排' : '已恢复这份方案')
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  /** 保存用户编辑后的不可变版本；失败时留在编辑器中以便继续修改。 */
  async function saveEditedRevision(baseRevisionId: string, itinerary: NonNullable<Trip['revisions'][number]['itinerary']>): Promise<boolean> {
    if (!selectedTrip) return false
    setSaving(true)
    try {
      setSnapshot(await window.tripwise.saveEditedRevision(selectedTrip.id, baseRevisionId, itinerary))
      setToast('修改已保存为新版本')
      return true
    } catch (reason) {
      setError(errorMessage(reason))
      return false
    } finally {
      setSaving(false)
    }
  }

  /** 用户主动检索地图位置后，将其来源作为当前旅行资料保存。 */
  async function searchMapPlaces(city: string, query: string): Promise<SourceRecord[]> {
    if (!selectedTrip) throw new Error('先选择一趟旅行，再定位行程地点。')
    const tripId = selectedTrip.id
    return withTripOperation(tripId, async () => {
      const candidates = await window.tripwise.searchMapPlaces(tripId, city, query)
      await refreshSnapshot()
      return candidates
    })
  }

  /** 用户主动查询相邻地点路线后保存来源，再返回结构化选项供审阅。 */
  async function estimateRoute(city: string, origin: string, destination: string, mode: RouteMode, date?: string, time?: string): Promise<RouteEstimateResponse> {
    if (!selectedTrip) throw new Error('先选择一趟旅行，再估算地点间路线。')
    const tripId = selectedTrip.id
    return withTripOperation(tripId, async () => {
      const result = await window.tripwise.estimateRoute(tripId, city, origin, destination, mode, date, time)
      await refreshSnapshot()
      return result
    })
  }

  /** 将模型建议的准备事项显式采纳到当前旅行并打开清单。 */
  async function savePreparationItems(conversationId: string, messageId: string): Promise<void> {
    if (!selectedTrip) return
    try {
      const next = await window.tripwise.savePreparationItems(selectedTrip.id, conversationId, messageId)
      setSnapshot(next)
      setView('preparation')
      setToast('已加入准备清单')
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  /** 保存准备事项的完成状态，方便用户之后继续核对。 */
  async function setPreparationItemChecked(itemId: string, checked: boolean): Promise<void> {
    if (!selectedTrip) return
    try {
      setSnapshot(await window.tripwise.setPreparationItemChecked(selectedTrip.id, itemId, checked))
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  /** 保存用户修改后的清单文字，并由主进程将证据状态改为待核验。 */
  async function updatePreparationItem(itemId: string, update: PreparationItemUpdate): Promise<boolean> {
    if (!selectedTrip) return false
    try {
      setSnapshot(await window.tripwise.updatePreparationItem(selectedTrip.id, itemId, update))
      setToast('已保存，内容已标为待核验。')
      return true
    } catch (reason) {
      setError(errorMessage(reason))
      return false
    }
  }

  /** 删除用户不再需要的单条准备清单事项。 */
  async function deletePreparationItem(itemId: string): Promise<boolean> {
    if (!selectedTrip) return false
    try {
      setSnapshot(await window.tripwise.deletePreparationItem(selectedTrip.id, itemId))
      setToast('已从准备清单移除')
      return true
    } catch (reason) {
      setError(errorMessage(reason))
      return false
    }
  }

  /** 通过系统保存对话、当前版本和来源索引。 */
  async function exportTrip(): Promise<void> {
    if (!selectedTrip) return
    try {
      const result = await window.tripwise.exportTrip(selectedTrip.id)
      if (result.saved) setToast('旅行资料已导出')
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  /** 将当前旅行导出为不含应用设置和服务密钥的 JSON 备份。 */
  async function exportTripBackup(): Promise<void> {
    if (!selectedTrip) return
    try {
      const result = await window.tripwise.exportTripBackup(selectedTrip.id)
      if (result.saved) setToast('旅行备份已保存')
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  /** 从用户选定的备份恢复为新旅行，保留现有资料。 */
  async function importTripBackup(): Promise<void> {
    try {
      const result = await window.tripwise.importTripBackup()
      if (!result.imported || !result.snapshot) return
      setSnapshot(result.snapshot)
      setView('chat')
      setToast('备份已作为新旅行导入')
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  /** 切换到另一趟旅行并刷新其工作区。 */
  async function selectTrip(tripId: string): Promise<void> {
    const next = await window.tripwise.selectTrip(tripId)
    setSnapshot(next)
    setView('chat')
  }

  /** 保存用户审阅后的旅行条件，后续工具和方案共享同一份简报。 */
  async function updateTripBrief(brief: Trip['brief'], unknownFields: Trip['briefUnknownFields']): Promise<void> {
    if (!selectedTrip) return
    try {
      const next = await window.tripwise.updateTripBrief(selectedTrip.id, brief, unknownFields)
      setSnapshot(next)
      setBriefOpen(false)
      setToast('旅行信息已更新')
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  /** 应用前再次由主进程检查提案基准，避免覆盖用户后来修改的条件。 */
  async function applyBriefProposal(conversationId: string, messageId: string): Promise<void> {
    if (!selectedTrip) return
    try {
      setSnapshot(await window.tripwise.applyTripBriefProposal(selectedTrip.id, conversationId, messageId))
      setToast('旅行信息已更新')
    } catch (reason) {
      const message = errorMessage(reason)
      setError(message)
      if (message.includes('请打开“旅行信息”核对')) setBriefOpen(true)
    }
  }

  /** 重试时仅刷新所选来源及其结果，不重新发送整轮对话给模型。 */
  async function retrySource(sourceId: string): Promise<void> {
    if (!selectedTrip || retryingSourceIds.has(sourceId)) return
    const tripId = selectedTrip.id
    setRetryingSourceIds((current) => new Set(current).add(sourceId))
    try {
      await withTripOperation(tripId, async () => {
        setSnapshot(await window.tripwise.retrySource(tripId, sourceId))
      })
      setToast('来源已重新查询')
    } finally {
      setRetryingSourceIds((current) => {
        const next = new Set(current)
        next.delete(sourceId)
        return next
      })
    }
  }

  /** 将来源复核需求放入对话草稿，供用户审阅后再发送给模型。 */
  function prepareSourceRefresh(source: SourceRecord): void {
    const kind = source.kind === 'weather' ? '天气' : '路线'
    const query = source.kind === 'weather'
      ? `重新查询天气来源 ${source.id}，更新目的地逐日预报和穿搭建议。超出预报范围时说明，不要推测。`
      : `重新查询路线来源 ${source.id}。先核对起终点、日期和交通方式；信息不足时先问我，并注明查询时间。`
    setView('chat')
    setDrafts((previous) => ({ ...previous, [currentDraftKey]: `复核${kind}：${query}` }))
  }

  /** 跳过当前失败来源时只移除重试动作，保留失败记录和其他来源。 */
  async function skipSourceRetry(sourceId: string): Promise<void> {
    if (!selectedTrip) return
    setSnapshot(await window.tripwise.skipSourceRetry(selectedTrip.id, sourceId))
    setToast('已跳过该来源，可继续使用其他资料')
  }

  /** 移除单条来源前先展示影响范围，确认后由主进程同步清理结构化引用。 */
  async function confirmDeleteSource(): Promise<void> {
    if (!sourceToDelete || sourceToDeleteHasActivity || deletingSourceId) return
    const { tripId, source } = sourceToDelete
    setDeletingSourceId(source.id)
    try {
      const next = await window.tripwise.deleteSource(tripId, source.id)
      setSnapshot(next)
      setSelectedSourceId((current) => current === source.id ? null : current)
      setSourceToDelete(null)
      setToast('来源及其结构化依据已移除')
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setDeletingSourceId(null)
    }
  }

  /** 从候选来源读取完整摘要并显示，避免来源链接与资料面板脱节。 */
  function showSource(source: SourceRecord): void {
    setPanelTab('sources')
    setRightOpen(true)
    setSelectedSourceId(source.id)
  }

  if (!snapshot) {
    return <StartupScreen brandSymbol={brandSymbol} error={error} busy={startupBusy} onRetry={() => void loadStartupSnapshot()} />
  }

  const modelCredentialState = getModelCredentialState(snapshot.secrets, snapshot.settings.model.provider)
  const modelCredentialLabel = {
    stored: 'API Key 已保存',
    missing: '连接模型',
    unavailable: '凭证文件待修复',
    'codex-cli': 'Codex'
  }[modelCredentialState]

  return (
    <div className={`app-shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <SkipLink />
      <aside className="travel-sidebar" id="travel-navigation" aria-label="旅行导航">
        <div className="brand-row">
          <div className="brand-mark"><img src={brandSymbol} alt="" /></div>
          <div className="brand-word"><strong>行程有数</strong><span>TRIPWISE</span></div>
          <button
            className="icon-button sidebar-toggle"
            aria-label={sidebarCollapsed ? '展开旅行栏' : '收起旅行栏'}
            aria-controls="travel-navigation"
            aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? '展开旅行栏' : '收起旅行栏'}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            {sidebarCollapsed ? <ArrowRight size={17} /> : <ArrowLeft size={17} />}
          </button>
        </div>
        <button className="new-trip-button" onClick={() => setCreateOpen(true)} aria-label="新建旅行"><Plus size={17} /><span>新建旅行</span></button>
        <div className="sidebar-section-label">旅行</div>
        <div className="trip-list">
          {snapshot.trips.map((trip) => (
            <TripRow key={trip.id} trip={trip} active={trip.id === selectedTrip?.id} onSelect={() => void selectTrip(trip.id)} onDelete={() => setDeleteTripId(trip.id)} />
          ))}
          {snapshot.trips.length === 0 && <p className="sidebar-empty">还没有旅行</p>}
        </div>
        {selectedTrip && <TripConversationList
          conversations={selectedTrip.conversations}
          messages={selectedTrip.messages}
          activeConversationId={selectedTrip.activeConversationId}
          runningConversationId={runningTripId === selectedTrip.id ? runningConversationId : null}
          onSelect={(conversationId) => void selectConversation(conversationId)}
          onDelete={(conversationId) => setConversationToDeleteRef({ tripId: selectedTrip.id, conversationId })}
          onCreate={() => void createConversation()}
        />}
        <div className="sidebar-bottom">
          <div className="trip-backup-actions">
            <button disabled={!selectedTrip} title="导出当前旅行，不含全局设置或服务密钥" onClick={() => void exportTripBackup()}><Archive size={14} />导出备份</button>
            <button title="将备份作为新旅行导入，不覆盖现有资料" onClick={() => void importTripBackup()}><Upload size={14} />导入备份</button>
          </div>
          <small className="trip-backup-note">JSON 未加密 · 含对话和导入内容，不含密钥</small>
          <div className="privacy-note"><ShieldCheck size={15} /><span>旅行资料保存在此设备</span></div>
        <button className="settings-button" aria-label="设置" title="设置" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={17} /><span>设置</span>
            {modelCredentialState === 'missing' && <i className="status-dot" />}
          </button>
        </div>
      </aside>

      <main className="main-workspace" id="main-workspace" tabIndex={-1}>
        <header className="workspace-header">
          <div className="trip-heading">
            <h1>{selectedTrip?.title ?? '开始规划旅行'}</h1>
            {selectedTrip && <span className="trip-subtitle">{tripMeta(selectedTrip)}</span>}
          </div>
          <div className="header-actions">
            {selectedTrip && <button className="quiet-button" onClick={() => setBriefOpen(true)}><PencilLine size={15} /> 旅行信息</button>}
            {selectedTrip && <button className="quiet-button" onClick={() => void exportTrip()}><ArrowDownToLine size={16} /> 导出</button>}
            <button className={`icon-button ${rightOpen ? 'active' : ''}`} disabled={browserAgentActive} aria-label={rightOpen ? '收起来源面板' : '打开来源面板'} onClick={() => setRightOpen((open) => !open)}><PanelRightClose size={18} /></button>
          </div>
        </header>

        <nav className="view-tabs" aria-label="旅行工作区视图">
          <ViewTab icon={<MessageCircle size={16} />} label="规划" active={view === 'chat'} onClick={() => setView('chat')} />
          <ViewTab icon={<MapIcon size={16} />} label="行程" active={view === 'itinerary'} onClick={() => setView('itinerary')} />
          <ViewTab icon={<Luggage size={16} />} label="出行准备" active={view === 'preparation'} onClick={() => setView('preparation')} />
          <div className="view-tab-spacer" />
          {modelCredentialState !== 'stored' && modelCredentialState !== 'codex-cli' && <button className="connection-pill connection-action needs-attention" aria-label={`${modelCredentialLabel}；打开设置`} title="打开设置" onClick={() => setSettingsOpen(true)}><span aria-hidden="true" />{modelCredentialLabel}</button>}
        </nav>

        <section className={`workspace-content ${rightOpen ? '' : 'no-right-panel'}`}>
          <div className="primary-content">
            {error && <Announcement role="alert" className="error-banner"><span>{error}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setError('')}><X size={16} /></button></Announcement>}
            {view === 'chat' && (
              <>
                <div
                  className="chat-scroll"
                  ref={chatScroll}
                  role="region"
                  aria-label="当前旅行对话"
                  tabIndex={0}
                  onScroll={(event) => {
                    const viewport = event.currentTarget
                    shouldFollowChat.current = isNearConversationEnd(viewport.scrollTop, viewport.scrollHeight, viewport.clientHeight)
                  }}
                >
                  {selectedTrip && <BriefReadinessPanel brief={selectedTrip.brief} unknownFields={selectedTrip.briefUnknownFields} onEdit={() => setBriefOpen(true)} />}
                  {activeConversationMessages.length ? activeConversationMessages.map((message, messageIndex) => {
                    const previousMessage = [...activeConversationMessages.slice(0, messageIndex)].reverse().find((candidate) =>
                      candidate.role === 'assistant' && candidate.itineraryOptions?.some((option) =>
                        !candidate.rejectedItineraryOptionIds?.includes(option.id)
                      )
                    )
                    const baselineOption = previousMessage?.itineraryOptions?.slice().reverse().find((option) =>
                      !previousMessage.rejectedItineraryOptionIds?.includes(option.id)
                    ) ?? null
                    const savedBaseline = baselineOption
                      ? selectedTrip?.revisions.find((revision) => revision.itinerary?.id === baselineOption.id)
                      : undefined
                    const baselineLabel = baselineOption
                      ? savedBaseline ? `与第 ${savedBaseline.number} 版对比` : '与上一份草案对比'
                      : undefined
                    const canContinueRevision = message.id === proposalHistory.latestActiveProposalId && !currentConversationRunning
                    return <ChatBubble
                      key={message.id}
                      message={message}
                      tripBrief={selectedTrip!.brief}
                      revisions={selectedTrip?.revisions ?? []}
                      baselineRevision={baselineOption ? null : activeRevision}
                      baselineOption={baselineOption}
                      baselineLabel={baselineLabel}
                      proposalNumber={proposalHistory.proposalNumbers.get(message.id) ?? 1}
                      isLatestProposal={message.id === proposalHistory.latestActiveProposalId}
                      canContinueRevision={canContinueRevision}
                      tripSources={selectedTrip?.sources ?? []}
                      sources={message.sourceIds.map((id) => messageSources.get(id)).filter((item): item is SourceRecord => !!item)}
                      canResume={message.id === resumableMessageId}
                      onResume={() => retryInterruptedMessage(message.id)}
                      onSave={(itineraryId) => void saveRevision(message.conversationId, message.id, itineraryId)}
                      onRejectOption={(itineraryId, rejected) => void setOptionRejected(message.conversationId, message.id, itineraryId, rejected)}
                      onContinueRevision={(title, suggestion) => {
                        if (!canContinueRevision) return
                        setRevisionTargetTitle(title)
                        if (suggestion) {
                          setDrafts((previous) => {
                            const existing = previous[currentDraftKey]?.trim()
                            const next = existing ? `${existing}\n${suggestion}` : suggestion
                            return { ...previous, [currentDraftKey]: next }
                          })
                        }
                        const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
                        composerTextarea.current?.focus()
                        composerTextarea.current?.scrollIntoView({ behavior: scrollBehaviorForMotionPreference(prefersReducedMotion), block: 'nearest' })
                      }}
                      onSavePreparation={() => void savePreparationItems(message.conversationId, message.id)}
                      onApplyBrief={() => applyBriefProposal(message.conversationId, message.id)}
                      onOpen={openPage}
                      onShowSource={showSource}
                    />
                  }) : <WelcomePanel
                    hasTrip={!!selectedTrip}
                    onPrompt={(text) => setDrafts((previous) => ({ ...previous, [currentDraftKey]: text }))}
                  />}
                  {agentStatus && agentStartedAt !== null && agentOutcome &&
                    selectedTrip?.id === agentProgressTripId && activeConversation?.id === agentProgressConversationId &&
                    <AgentProgress status={agentStatus} startedAt={agentStartedAt} finishedAt={agentFinishedAt ?? undefined} outcome={agentOutcome} activities={agentActivities} />}
                  <div ref={chatEnd} />
                </div>
                <form className="composer-wrap" onSubmit={(event) => void submitMessage(event)}>
                  {revisionTargetTitle && <div className="revision-composer-note" role="status">继续修改：{revisionTargetTitle} · 本轮会生成一份新草案</div>}
                  <div className="composer-box">
                    <textarea
                      ref={composerTextarea}
                      value={draft}
                      onChange={(event) => setDrafts((previous) => ({ ...previous, [currentDraftKey]: event.target.value }))}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                          event.preventDefault()
                          void submitMessage()
                        }
                      }}
                      placeholder={revisionTargetTitle ? '写下想调整的内容，例如：减少步行，保留故宫…' : selectedTrip ? '写下想调整的安排或补充条件…' : '例如：北京 3 天，想去故宫和看红叶…'}
                      aria-label="旅行对话输入框"
                      rows={2}
                    />
                    <div className="composer-controls">
                      <span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>
                      {currentConversationRunning ? (
                        <button type="button" className="send-button stop-button" onClick={() => void cancelRequest()} aria-label="停止回复"><Square size={14} fill="currentColor" /></button>
                      ) : (
                        <button type="submit" className="send-button" disabled={!draft.trim() || !!runningRequest} aria-label="发送消息"><ArrowUp size={18} /></button>
                      )}
                    </div>
                  </div>
                  {runningRequest && !currentConversationRunning && <span className="composer-running-note" role="status">其他话题仍在处理中，请稍后再试。</span>}
                </form>
              </>
            )}
            {view === 'itinerary' && <ItineraryView trip={selectedTrip} activeRevision={activeRevision} saving={saving || activatingRevision} placesEnabled={snapshot.settings.connectors.places} routesEnabled={snapshot.settings.connectors.routes} amapKeySaved={snapshot.secrets.amapKeySaved} amapJsKeySaved={snapshot.secrets.amapJsKeySaved} amapSecurityCodeSaved={snapshot.secrets.amapSecurityCodeSaved} onSaveEdited={saveEditedRevision} onSearchMapPlaces={searchMapPlaces} onEstimateRoute={estimateRoute} onConfigureRoutes={() => setSettingsOpen(true)} onActivate={activateRevision} onOpen={openPage} onShowSource={showSource} onExport={() => void exportTrip()} />}
            {view === 'preparation' && <PreparationView trip={selectedTrip} activeRevision={activeRevision} onSwitchToChat={(prompt) => { setView('chat'); setDrafts((previous) => ({ ...previous, [currentDraftKey]: prompt ?? '根据目前的行程，补充每天的穿搭、预约、行李和吃饭安排，再给出下雨时的备选。查不到来源的内容请注明。' })) }} onToggleItem={(itemId, checked) => void setPreparationItemChecked(itemId, checked)} onUpdateItem={updatePreparationItem} onDeleteItem={deletePreparationItem} onOpen={openPage} />}
          </div>

          {rightOpen && <aside className="research-panel" aria-label="来源与网页">
            <div className="research-tabs">
              <ResearchPanelTabs activeView={panelTab} sourceCount={selectedTrip?.sources.length ?? 0} disabled={browserAgentActive} onSelect={setPanelTab} />
              <button className="icon-button panel-close" disabled={browserAgentActive} aria-label={browserAgentActive ? 'Agent 浏览网页期间暂不能收起面板' : '收起来源面板'} onClick={() => setRightOpen(false)}><X size={16} /></button>
            </div>
            {panelTab === 'sources' ? (
              <SourcesPanel
                trip={selectedTrip}
                selectedSourceId={selectedSourceId}
                retryingSourceIds={retryingSourceIds}
                deletionDisabled={Boolean(selectedTrip && (
                  runningTripId === selectedTrip.id ||
                  (activeTripOperationCounts[selectedTrip.id] ?? 0) > 0
                ))}
                onOpen={openPage}
                onPaste={() => setPastedSourceOpen(true)}
                onRetry={retrySource}
                onSkipRetry={skipSourceRetry}
                onRefresh={prepareSourceRefresh}
                onDelete={(source) => { if (selectedTrip) setSourceToDelete({ tripId: selectedTrip.id, source }) }}
              />
            ) : (
              <div className="browser-panel">
                <form className="browser-address" onSubmit={(event) => {
                  event.preventDefault()
                  try {
                    const target = resolveResearchBrowserInput(browserUrl)
                    void openPage(target.url)
                  } catch (reason) {
                    setError(errorMessage(reason))
                  }
                }}>
                  <button className="browser-nav-button" type="button" aria-label="返回上一页" title="返回上一页" disabled={!browserState.canGoBack || browserState.loading || browserAgentActive} onClick={() => void navigateBrowserHistory('back')}><ArrowLeft size={15} /></button>
                  <button className="browser-nav-button" type="button" aria-label="前进到下一页" title="前进到下一页" disabled={!browserState.canGoForward || browserState.loading || browserAgentActive} onClick={() => void navigateBrowserHistory('forward')}><ArrowRight size={15} /></button>
                  <button className="browser-nav-button" type="button" aria-label="刷新网页" title="刷新网页" disabled={!browserState.url || browserState.loading || browserAgentActive} onClick={() => void navigateBrowserHistory('reload')}><RotateCw size={14} /></button>
                  <div className="address-input"><Search size={14} /><input value={browserUrl} onChange={(event) => setBrowserUrl(event.target.value)} placeholder="输入网址或搜索词" aria-label="网页地址或搜索词" /><button type="submit" aria-label="搜索或打开网页"><ArrowRight size={15} /></button></div>
                </form>
                <div className="browser-toolbar">
                  <span className={`browser-state-label${browserState.accessState ? ' browser-access-state' : ''}${browserState.accessState === 'verification-required' ? ' browser-verification-state' : ''}`} role="status" aria-atomic="true">{browserState.loading ? '正在打开网页…' : browserState.error ? '无法打开网页' : browserState.accessState === 'login-required' ? '页面需要登录' : browserState.accessState === 'verification-required' ? '页面需要验证' : browserState.title || '未打开网页'}</span>
                  {browserAgentActive && <><span className="browser-agent-status" role="status">Agent 正在浏览</span><button className="text-button" title="停止本轮规划并开放手动网页操作" onClick={() => void cancelRequest()}>停止并接管</button></>}
                  <button className="text-button" disabled={!selectedTrip || !browserState.url || browserState.loading || browserAgentActive || Boolean(browserState.accessState)} onClick={() => void importPage()}>保存网页文字</button>
                </div>
                {browserState.activity && <div className={`browser-activity browser-activity-${browserState.activity.status}`} role="status" aria-live="polite" aria-atomic="true">
                  <MousePointer2 size={14} aria-hidden="true" />
                  <span className="browser-activity-message">{browserState.activity.message}</span>
                  {browserState.activity.phase && <span className={`browser-activity-phase browser-activity-phase-${browserState.activity.phase}`}>
                    {BROWSER_ACTIVITY_PHASE_LABELS[browserState.activity.phase]}
                  </span>}
                </div>}
                <div className="browser-surface" ref={browserSurface}>
                  {!browserState.url && <div className="browser-placeholder"><Globe2 size={28} /><strong>浏览网页</strong><span>打开攻略后，点击“保存网页文字”即可加入旅行资料。</span></div>}
                  {browserState.error && <Announcement role="alert" className="browser-error"><span>{browserState.error}</span><button className="text-button" onClick={() => void openPage(browserUrl)}>重试</button></Announcement>}
                  {browserState.loading && <div className="browser-loading"><span className="loading-bar" /></div>}
                </div>
                <p className="browser-footnote">{browserState.accessState === 'login-required'
                  ? '请在此页手动登录并刷新后再保存；会话仅保留到应用关闭。'
                  : browserState.accessState === 'verification-required'
                    ? '请在网页中自行处理验证并刷新；Tripwise 不会代做验证。'
                    : '可手动浏览、登录并导入当前页；搜索词发往 Bing，页内搜索发往当前网站。登录只保留到应用关闭。'}</p>
              </div>
            )}
          </aside>}
        </section>
      </main>

      {settingsOpen && <SettingsModal snapshot={snapshot} trip={selectedTrip} onClose={() => setSettingsOpen(false)} onSaved={(next) => setSnapshot(next)} onError={(message) => setError(message)} />}
      {pastedSourceOpen && selectedTrip && <PasteResearchModal onClose={() => setPastedSourceOpen(false)} onImport={importPastedSource} />}
      {createOpen && <CreateTripModal busy={saving} onClose={() => setCreateOpen(false)} onCreate={createTrip} />}
      {briefOpen && selectedTrip && <TripBriefModal trip={selectedTrip} onClose={() => setBriefOpen(false)} onSave={updateTripBrief} />}
      {deleteTrip && <DeleteTripModal
        trip={deleteTrip}
        busy={deletingTripId === deleteTrip.id}
        hasActivity={deleteTripHasActivity}
        onClose={() => { if (deletingTripId !== deleteTrip.id) setDeleteTripId(null) }}
        onConfirm={() => void confirmDeleteTrip()}
      />}
      {conversationToDelete && conversationToDeleteTrip && conversationToDeleteRef && <DeleteConversationModal
        conversation={conversationToDelete}
        messageCount={conversationToDeleteTrip.messages.filter((message) => message.conversationId === conversationToDelete.id).length}
        lastConversation={conversationToDeleteTrip.conversations.length === 1}
        busy={deletingConversationKey === conversationDraftKey(conversationToDeleteRef.tripId, conversationToDeleteRef.conversationId)}
        hasActivity={deleteConversationHasActivity}
        onClose={() => { if (!deletingConversationKey) setConversationToDeleteRef(null) }}
        onConfirm={() => void confirmDeleteConversation()}
      />}
      {sourceToDelete && <DeleteSourceModal
        source={sourceToDelete.source}
        busy={deletingSourceId === sourceToDelete.source.id}
        hasActivity={sourceToDeleteHasActivity}
        onClose={() => { if (deletingSourceId !== sourceToDelete.source.id) setSourceToDelete(null) }}
        onConfirm={() => void confirmDeleteSource()}
      />}
      {toast && <Announcement role="status" className="toast"><Check size={15} aria-hidden="true" /> {toast}<button aria-label="关闭" onClick={() => setToast('')}><X size={14} /></button></Announcement>}
    </div>
  )
}

/** 根据是否已有计划，把新资料转成一条可审阅、不会自动发送的操作建议。 */
function researchImportPrompt(hasPlan: boolean): string {
  return hasPlan
    ? '结合刚加入的资料完善当前行程，只修改有来源支持的相关安排；保留未指定日期和原有约束。社区经验不能单独证明开放、预约、票价或通勤，缺少依据时标为待核验。'
    : '结合本次旅行信息和刚加入的资料形成一份待审计划；提取相关地点与避坑经验，区分游客经验和官方事实，无法核实的内容标为待核验。'
}

/** 展示旅行列表项，并把危险删除动作放在次级交互中。 */
function TripRow({ trip, active, onSelect, onDelete }: { trip: Trip; active: boolean; onSelect: () => void; onDelete: () => void }) {
  return <div className={`trip-row ${active ? 'active' : ''}`}>
    <button className="trip-select" aria-label={`打开旅行：${trip.title}，${tripMeta(trip)}`} title={trip.title} onClick={onSelect} aria-current={active ? 'page' : undefined}>
      <span className="trip-row-icon"><Compass size={16} /></span>
      <span className="trip-row-copy"><strong>{trip.title}</strong><small>{tripMeta(trip)}</small></span>
    </button>
    <button className="trip-delete icon-button" aria-label={`删除${trip.title}`} onClick={onDelete}><Trash2 size={14} /></button>
  </div>
}

/** 标题已是目的地时只补充日期，避免导航重复显示同一城市。 */
function tripMeta(trip: Trip): string {
  const dates = trip.brief.startDate ? `${trip.brief.startDate}${trip.brief.endDate ? ` — ${trip.brief.endDate}` : ''}` : '日期待定'
  const destination = trip.brief.destination.trim()
  return destination && destination !== trip.title.trim() ? `${destination} · ${dates}` : dates
}

/** 让草稿跟随旅行和话题保存，切换对话不会覆盖未发送文字。 */
function conversationDraftKey(tripId: string, conversationId: string): string {
  return `${tripId}:${conversationId}`
}

/** 小型页面视图切换按钮，保持文字标签和可访问名称。 */
function ViewTab({ icon, label, active, onClick }: { icon: ReactNode; label: string; active: boolean; onClick: () => void }) {
  return <button className={`view-tab ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>{icon}<span>{label}</span></button>
}
