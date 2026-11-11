/** 呈现旅行对话、模型提案和用户可继续调整的需求入口。 */
import { useState } from 'react'
import { ArrowRight, Check, ClipboardCheck, ExternalLink, FileText, Footprints, MapPin, PencilLine, RotateCw, Route, Utensils } from 'lucide-react'
import type { ChatMessage, ItineraryOption, SourceRecord, Trip, TripBrief, TripBriefField, TripBriefProposal } from '@shared/types'
import { assessTripBriefReadiness, TRIP_BRIEF_FIELD_LABELS } from '@shared/trip-brief'
import { MarkdownContent } from './MarkdownContent'
import { PlanComparison, PlanOptionCard } from './ItineraryPlans'
import { PreparationLocationSummary, evidenceLevelLabel, packingSectionLabel, preparationCategoryLabel, preparationDateLabel } from './PreparationView'

/** 只列出缺项和明确标为未知的字段，避免重复堆叠整份旅行简报。 */
export function BriefReadinessPanel({ brief, unknownFields, onEdit }: { brief: TripBrief; unknownFields: TripBriefField[]; onEdit: () => void }) {
  const readiness = assessTripBriefReadiness(brief)
  const missingFields = [
    !readiness.destinationReady ? 'destination' : null,
    !brief.startDate.trim() ? 'startDate' : null,
    !brief.endDate.trim() ? 'endDate' : null,
    !readiness.departureReady ? 'departureCity' : null
  ].filter((field): field is keyof TripBrief => field !== null)
  const pendingFields = [...new Set([...missingFields, ...unknownFields])]
  if (pendingFields.length === 0) return null

  return <section className="brief-readiness" aria-label="旅行信息状态">
    <strong>{missingFields.length > 0 ? '待补充' : '待确认'}</strong>
    <span>{pendingFields.map((field) => TRIP_BRIEF_FIELD_LABELS[field]).join('、')}</span>
    <button className="text-button" onClick={onEdit}><PencilLine size={13} /> 编辑</button>
  </section>
}

/** 以卡片形式组织标题、列表、引用和简单 Markdown。 */
export function ChatBubble({
  message, tripBrief, revisions, sources, tripSources, baselineRevision, baselineOption, baselineLabel, proposalNumber = 1, isLatestProposal = true, canContinueRevision = false, canResume, onResume, onSave, onRejectOption, onContinueRevision = () => undefined, onSavePreparation, onApplyBrief, onOpen, onShowSource
}: {
  message: ChatMessage
  tripBrief: TripBrief
  revisions: Trip['revisions']
  sources: SourceRecord[]
  tripSources: SourceRecord[]
  baselineRevision: Trip['revisions'][number] | null
  baselineOption?: ItineraryOption | null
  baselineLabel?: string
  proposalNumber?: number
  isLatestProposal?: boolean
  canContinueRevision?: boolean
  canResume: boolean
  onResume: () => void
  onSave: (itineraryId?: string) => void
  onRejectOption: (itineraryId: string, rejected: boolean) => void
  onContinueRevision?: (title: string, suggestion?: string) => void
  onSavePreparation: () => void
  onApplyBrief: () => Promise<void>
  onOpen: (url: string) => void
  onShowSource: (source: SourceRecord) => void
}) {
  const user = message.role === 'user'
  const planSupplement = message.content.trim()
  const hasStructuredPlan = !user && !!message.itineraryOptions?.length
  const collapsePlanSupplement = hasStructuredPlan && Array.from(planSupplement).length > 120
  const latestActiveIndex = message.itineraryOptions?.reduce((latest, candidate, candidateIndex) =>
    message.rejectedItineraryOptionIds?.includes(candidate.id) ? latest : candidateIndex, -1) ?? -1
  return <article className={`chat-message ${user ? 'user-message' : 'assistant-message'}`}>
    {!user && <div className="assistant-avatar"><Route size={16} /></div>}
    <div className="message-body">
      {planSupplement && (collapsePlanSupplement
        ? <details className="plan-assistant-supplement">
          <summary>查看补充说明</summary>
          <div className="message-card plan-assistant-supplement-content">
            <MarkdownContent text={message.content} onOpen={onOpen} collapseLargeTables={!user} />
          </div>
        </details>
        : <div className={`message-card ${user ? 'user-card' : ''}`}>
          <MarkdownContent text={message.content} onOpen={onOpen} collapseLargeTables={!user} />
        </div>)}
      {!user && message.briefProposal && <BriefProposalCard proposal={message.briefProposal} appliedAt={message.briefProposalAppliedAt} onApply={onApplyBrief} />}
      {!user && !!message.itineraryOptions?.length && <>
        {message.itineraryOptions.length > 1 && <PlanComparison options={message.itineraryOptions} brief={tripBrief} sources={tripSources} />}
        <div className="plan-option-list">
          {message.itineraryOptions.map((option, index) => <PlanOptionCard
            key={option.id}
            option={option}
            tripBrief={tripBrief}
            index={index}
            sources={tripSources}
            baselineRevision={baselineOption ? null : baselineRevision}
            baselineOption={baselineOption}
            baselineLabel={baselineLabel}
            proposalNumber={proposalNumber}
            isLatestProposal={isLatestProposal}
            canContinueRevision={canContinueRevision && index === latestActiveIndex}
            optionCount={message.itineraryOptions?.length ?? 1}
            rejected={message.rejectedItineraryOptionIds?.includes(option.id) ?? false}
            savedRevisionNumber={revisions.find((revision) => revision.itinerary?.id === option.id)?.number}
            onSave={() => onSave(option.id)}
            onReject={(rejected) => onRejectOption(option.id, rejected)}
            onContinueRevision={(suggestion) => onContinueRevision(option.title, suggestion)}
            onOpen={onOpen}
            onShowSource={onShowSource}
          />)}
        </div>
      </>}
      {!user && !!message.preparationOptions?.length && <PreparationProposal
        items={message.preparationOptions}
        sources={sources}
        onSave={onSavePreparation}
        onOpen={onOpen}
      />}
      {user && canResume && <div className="message-actions recovery-actions">
        <span>上一条回复未完成。可以重新发送。</span>
        <button className="resume-message-button" onClick={onResume}><RotateCw size={13} /> 重试</button>
      </div>}
      {!user && (!!sources.length || (!message.itineraryOptions?.length && !message.briefProposal && !!message.content.trim())) && <div className="message-actions">
        {!!sources.length && <button className="message-source-link" onClick={() => onShowSource(sources[0])}><FileText size={13} /> {sources.length} 个来源</button>}
        {!message.itineraryOptions?.length && !message.briefProposal && !!message.content.trim() && <button className="adopt-button" onClick={() => onSave()}><Check size={14} /> 保存为文本方案</button>}
      </div>}
    </div>
  </article>
}

/** 展示模型从本轮对话提取的旅行条件，并要求用户主动确认后写入。 */
function BriefProposalCard({ proposal, appliedAt, onApply }: {
  proposal: TripBriefProposal
  appliedAt?: string
  onApply: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const entries = Object.entries(proposal.changes) as Array<[keyof TripBrief, string]>
  /** 应用提案期间锁住按钮，并在完成或失败后恢复交互。 */
  const apply = async (): Promise<void> => {
    setBusy(true)
    try {
      await onApply()
    } finally {
      setBusy(false)
    }
  }
  return <section className="brief-proposal-card" aria-label="旅行信息变更">
    <header><div><strong>旅行信息变更</strong><span>{entries.length} 项待确认</span></div><PencilLine size={15} /></header>
    <div className="brief-proposal-list">{entries.map(([key, value]) => <div className="brief-proposal-row" key={key}>
      <strong>{briefFieldLabel(key)}</strong>
      <span>{proposal.base[key] || '未填写'}</span>
      <ArrowRight size={13} aria-hidden="true" />
      <span className="brief-proposal-value">{value || '清空'}</span>
    </div>)}</div>
    <p>只更新旅行信息；已保存行程不变。</p>
    <button className={appliedAt ? 'secondary-button brief-applied' : 'primary-button'} disabled={busy || !!appliedAt} onClick={() => void apply()}>
      {appliedAt ? <><Check size={14} /> 已应用</> : busy ? '正在保存…' : '应用修改'}
    </button>
  </section>
}

/** 将准备建议展示为待审清单，保留证据状态和来源入口。 */
function PreparationProposal({ items, sources, onSave, onOpen }: {
  items: NonNullable<ChatMessage['preparationOptions']>
  sources: SourceRecord[]
  onSave: () => void
  onOpen: (url: string) => void
}) {
  return <section className="prep-proposal-card">
    <header><div><strong>准备事项</strong><span>{items.length} 项 · 检查后加入</span></div><ClipboardCheck size={16} /></header>
    <div className="prep-proposal-list">{items.map((item) => <article key={item.id}>
      <div className="prep-proposal-title"><span>{preparationCategoryLabel(item.category)}</span>{item.category === 'packing' && <span className="prep-packing-section">{packingSectionLabel(item.packingSection ?? 'unclassified')}</span>}<strong>{item.title}</strong><small className={`evidence-${item.evidenceLevel}`}>{evidenceLevelLabel(item.evidenceLevel)}</small></div>
      {item.locationContext && <PreparationLocationSummary context={item.locationContext} />}
      <p>{item.detail}</p>
      <div className="prep-proposal-meta">{item.itineraryDate && <span>适用日 {preparationDateLabel(item.itineraryDate)}</span>}{item.dueDate && <span>截止 {preparationDateLabel(item.dueDate)}</span>}{item.legacyDate && <span className="preparation-location-stale">旧版日期待确认：{item.legacyDate}</span>}{item.sourceIds.map((sourceId) => {
        const source = sources.find((candidate) => candidate.id === sourceId)
        return source?.url ? <button className="text-button" key={sourceId} onClick={() => onOpen(source.url)}>{source.kind === 'place' ? '打开地图候选' : source.kind === 'route' ? `查看路线方案 ${item.locationContext?.routeOptionNumber ?? ''}`.trim() : '查看依据'} <ExternalLink size={11} /></button> : null
      })}</div>
    </article>)}</div>
    <button className="primary-button" onClick={onSave}><ClipboardCheck size={14} /> 加入准备清单</button>
  </section>
}

/** 用图标和短标签表达示例，点击后仍填入完整需求。 */
export function WelcomePanel({ hasTrip, onPrompt }: {
  hasTrip: boolean
  onPrompt: (text: string) => void
}) {
  const suggestions = [
    { icon: <MapPin size={15} />, label: '北京 · 3 天 · 故宫与红叶', prompt: '北京 3 天，想去故宫和看红叶，每天别排太满。' },
    { icon: <Utensils size={15} />, label: '成都 · 2 天 · 美食少折返', prompt: '成都 2 天，想吃当地菜，景点尽量安排在同一区域。' },
    { icon: <Footprints size={15} />, label: '厦门 · 2 天 · 带父母轻松游', prompt: '厦门 2 天，和父母一起，少爬坡、少走路。' }
  ]
  return <div className="welcome-panel">
    <h2>{hasTrip ? '继续规划这趟旅行' : '规划一趟旅行'}</h2>
    <div className="suggestion-grid">
      {suggestions.map((item) => <button key={item.label} onClick={() => onPrompt(item.prompt)}>
        <span className="suggestion-icon" aria-hidden="true">{item.icon}</span>
        <span>{item.label}</span>
        <ArrowRight size={15} aria-hidden="true" />
      </button>)}
    </div>
  </div>
}

/** 显示简报字段的人类可读标签，供模型提案审阅卡使用。 */
function briefFieldLabel(key: keyof TripBrief): string {
  return ({
    departureCity: '出发地', destination: '目的地', startDate: '出发日期', endDate: '返程日期', arrivalFlight: '抵达航班或车次',
    arrivalTime: '抵达时间', leaveTime: '离开时间', travelers: '同行人', budget: '预算', lodgingLocation: '具体住宿地点', lodging: '住宿区域与偏好',
    pace: '行程强度', earlyStart: '出发时间偏好', interests: '兴趣点', transport: '交通偏好', dietary: '忌口与饮食',
    luggage: '行李限制', clothing: '穿搭与已有衣物', constraints: '其他约束'
  })[key]
}
