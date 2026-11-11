/** 展示旅行来源、导入攻略并管理单条来源的生命周期。 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ExternalLink, FileText, Globe2, MapPin, Plug, RefreshCw, Route, Search, Sun, Trash2
} from 'lucide-react'
import type { SourceNature, SourceRecord, Trip, UserProvidedContentInput } from '@shared/types'
import {
  MAX_IMPORTED_SOURCE_CHARACTERS_PER_ITEM,
  MAX_IMPORTED_SOURCE_CONTEXT_CHARACTERS,
  MAX_IMPORTED_SOURCES_PER_CONTEXT
} from '../../shared/agent-limits'
import { sourceNatureFor, sourceNatureLabel } from '../../shared/source-provenance'
import { Modal } from './components/Modal'
import { scrollBehaviorForMotionPreference } from './conversation-scroll'
import { errorMessage, sourceTimestampLabel, statusLabel } from './ui-format'
import { sourceFreshnessNotice } from './source-freshness'

/** 列出当前旅行的资料、来源性质和来源级动作。 */
export function SourcesPanel({ trip, selectedSourceId, retryingSourceIds, deletionDisabled, onOpen, onPaste, onRetry, onSkipRetry, onRefresh, onDelete }: {
  trip: Trip | null
  selectedSourceId: string | null
  retryingSourceIds: Set<string>
  deletionDisabled: boolean
  onOpen: (url: string) => void
  onPaste: () => void
  onRetry: (sourceId: string) => Promise<void>
  onSkipRetry: (sourceId: string) => Promise<void>
  onRefresh: (source: SourceRecord) => void
  onDelete: (source: SourceRecord) => void
}) {
  if (!trip) return <div className="sources-empty"><div className="source-empty-icon"><Search size={20} /></div><strong>还没有旅行资料</strong><p>网页、天气、地点和导入的攻略会显示在这里。</p></div>
  return <div className="sources-content">
    <div className="sources-header"><div className="sources-header-actions"><button className="text-button" onClick={onPaste}>粘贴攻略</button><button className="icon-button" aria-label="在网页面板搜索" onClick={() => onOpen('https://www.bing.com')}><Globe2 size={16} /></button></div></div>
    {trip.sources.length ? <div className="source-list">
      {trip.sources.map((source) => <SourceCard
        key={source.id}
        source={source}
        selected={source.id === selectedSourceId}
        retrying={retryingSourceIds.has(source.id)}
        deletionDisabled={deletionDisabled}
        onRefresh={() => onRefresh(source)}
        onRetry={() => onRetry(source.id)}
        onSkipRetry={() => onSkipRetry(source.id)}
        onDelete={() => onDelete(source)}
        onOpen={() => source.url && onOpen(source.url)}
      />)}
    </div> : <div className="sources-empty"><div className="source-empty-icon"><Search size={20} /></div><strong>还没有资料</strong><p>搜索网页，或粘贴攻略。</p></div>}
  </div>
}

/** 将用户复制的社媒/网页攻略存为本地来源，发送模型前由用户再发起对话。 */
export function PasteResearchModal({ onClose, onImport }: {
  onClose: () => void
  onImport: (input: UserProvidedContentInput) => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  /** 校验并导入用户提供的链接或文字，保留来源状态。 */
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onImport({ title, url, text })
      onClose()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return <Modal wide title="添加旅行攻略" subtitle="小红书等页面暂时无法直接读取时，可以粘贴正文。作者和发布时间未经核实。" onClose={onClose}>
    <form className="paste-research-form" onSubmit={(event) => void submit(event)}>
      <label className="form-label">攻略名称<input data-modal-initial-focus value={title} maxLength={200} required onChange={(event) => setTitle(event.target.value)} placeholder="如：北京秋日红叶路线" /></label>
      <label className="form-label">原始链接（可选）<input type="url" value={url} maxLength={4_000} onChange={(event) => setUrl(event.target.value)} placeholder="https://www.xiaohongshu.com/..." /></label>
      <label className="form-label">攻略内容<textarea value={text} maxLength={30_000} rows={10} required onChange={(event) => setText(event.target.value)} placeholder="粘贴笔记或攻略文字。图片、评论和账号信息不会保存。" /></label>
      {error && <p className="paste-research-error" role="alert">{error}</p>}
      <div className="paste-research-footer"><small>{text.length.toLocaleString()} / 30,000 字符 · 仅保存在本机</small><div><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || !title.trim() || !text.trim()}>{busy ? '正在保存…' : '保存资料'}</button></div></div>
      <p className="privacy-inline">保存仅在本机；发送消息后，模型会收到最多 {MAX_IMPORTED_SOURCES_PER_CONTEXT} 篇相关资料，单篇不超过 {MAX_IMPORTED_SOURCE_CHARACTERS_PER_ITEM.toLocaleString()} 字符，总计不超过 {MAX_IMPORTED_SOURCE_CONTEXT_CHARACTERS.toLocaleString()} 字符。</p>
    </form>
  </Modal>
}

/** 明示单条来源删除范围，尤其提醒用户历史对话文字不会被改写。 */
export function DeleteSourceModal({ source, busy, hasActivity, onClose, onConfirm }: {
  source: SourceRecord
  busy: boolean
  hasActivity: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return <Modal title="移除这条资料？" subtitle="这只会影响当前旅行。" onClose={onClose}>
    <div className="delete-trip-content">
      <p className="delete-trip-intro"><strong>{source.title}</strong></p>
      <ul className="delete-trip-scope">
        <li>删除链接、摘要、页面声明信息和重试参数。</li>
        <li>行程和准备清单会解除这条资料的引用；失去依据的内容会标为待核验，相关路线和坐标会清除。</li>
        <li>历史对话不会改写。要删除整趟旅行，请从侧栏删除。</li>
      </ul>
      {hasActivity && <p className="delete-trip-busy" role="status">当前仍在规划或查询。完成后即可移除资料。</p>}
      <div className="modal-footer delete-trip-footer">
        <button type="button" className="secondary-button" disabled={busy} data-modal-initial-focus onClick={onClose}>取消</button>
        <button type="button" className="danger-button" disabled={busy || hasActivity} onClick={onConfirm}><Trash2 size={14} />{busy ? '正在移除…' : '移除来源'}</button>
      </div>
    </div>
  </Modal>
}

/** 单条来源卡显示获取时间、服务商、摘要和跳转入口。 */
function SourceCard({ source, selected, retrying, deletionDisabled, onOpen, onRefresh, onRetry, onSkipRetry, onDelete }: {
  source: SourceRecord
  selected: boolean
  retrying: boolean
  deletionDisabled: boolean
  onOpen: () => void
  onRefresh: () => void
  onRetry: () => Promise<void>
  onSkipRetry: () => Promise<void>
  onDelete: () => void
}) {
  const cardRef = useRef<HTMLElement>(null)
  const [retryError, setRetryError] = useState('')
  useEffect(() => {
    if (!selected) return
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    cardRef.current?.scrollIntoView({ behavior: scrollBehaviorForMotionPreference(prefersReducedMotion), block: 'nearest' })
  }, [selected])
  const Icon = source.kind === 'weather' ? Sun : source.kind === 'place' ? MapPin : source.kind === 'route' ? Route : source.kind === 'user' ? FileText : source.kind === 'plugin' ? Plug : Globe2
  const nature = source.sourceNature ?? sourceNatureFor(source.url, source.kind)
  const contentLevelLabel = source.contentLevel === 'snippet' ? '搜索摘要'
    : source.contentLevel === 'visual-clue' ? '图像线索' : undefined
  const contentLevelTitle = source.contentLevel === 'snippet'
    ? '仅用于发现原文，不作为动态事实依据。'
    : source.contentLevel === 'visual-clue'
      ? '由模型解读网页视口生成；截图未保存，不能单独核验动态事实。'
      : undefined
  const freshnessNotice = sourceFreshnessNotice(source)
  /** 串行执行单条来源操作，并将可读错误留在对应来源旁。 */
  async function runSourceAction(action: () => Promise<void>): Promise<void> {
    setRetryError('')
    try {
      await action()
    } catch (reason) {
      setRetryError(errorMessage(reason))
    }
  }
  return <article ref={cardRef} className={`source-card ${source.status !== 'success' ? 'source-unavailable' : ''} ${selected ? 'source-selected' : ''}`}>
    <div className="source-card-top">
      <span className="source-icon"><Icon size={15} /></span>
      {source.kind !== 'web' && <span className={`source-kind kind-${source.kind}`}>{kindLabel(source.kind)}</span>}
      {source.kind === 'web' && <span className={`source-nature nature-${nature}`} title={sourceNatureDescription(nature)}>{sourceNatureLabel(nature)}</span>}
      {contentLevelLabel && <span className="source-content-level" title={contentLevelTitle}>{contentLevelLabel}</span>}
      {(source.retrySkippedAt || source.status !== 'success') &&
        <span className="source-status">{source.retrySkippedAt ? '已跳过' : statusLabel(source.status)}</span>}
    </div>
    <h3>{source.title}</h3>
    <p>{source.summary}</p>
    {freshnessNotice && <div className="source-freshness" role="status"><strong>{freshnessNotice.label}</strong><small>{freshnessNotice.detail}</small></div>}
    {(source.declaredAuthor || source.declaredPublishedAt) && <p className="source-declared-metadata">
      页面声明 · {source.declaredAuthor ? `作者：${source.declaredAuthor}` : ''}{source.declaredAuthor && source.declaredPublishedAt ? ' · ' : ''}{source.declaredPublishedAt ? `发布时间：${formatDeclaredDate(source.declaredPublishedAt)}` : ''} · 未独立核验
    </p>}
    {retryError && <p className="source-retry-error" role="alert">{retryError}</p>}
    <div className="source-card-bottom">
      <span>{source.provider} · {sourceTimestampLabel(source)}</span>
      <div className="source-card-actions">
        {source.retry && <>
          <button className="text-button" disabled={retrying} onClick={() => void runSourceAction(onRetry)}>{retrying ? '查询中…' : '重试'}</button>
          <button className="text-button source-skip-action" disabled={retrying} onClick={() => void runSourceAction(onSkipRetry)}>跳过</button>
        </>}
        <button className="text-button source-remove-action" aria-label={`移除来源：${source.title}`} disabled={deletionDisabled} title={deletionDisabled ? '规划或查询完成后可移除来源' : undefined} onClick={onDelete}><Trash2 size={12} /> 移除</button>
        {freshnessNotice && <button className="text-button" onClick={onRefresh}><RefreshCw size={12} />重新查询</button>}
        <button className="text-button" disabled={!source.url} onClick={onOpen}>查看来源 <ExternalLink size={12} /></button>
      </div>
    </div>
  </article>
}

/** 以中文类型标签统一来源分类呈现。 */
function kindLabel(kind: Exclude<SourceRecord['kind'], 'web'>): string {
  return ({ weather: '天气', place: '地点', route: '路线估算', user: '手动导入', plugin: '旅行插件' })[kind]
}

/** 为来源性质说明分类依据和核验边界。 */
function sourceNatureDescription(nature: SourceNature): string {
  return ({
    'government-domain': '域名属于 .gov.cn；不代表页面中的具体信息仍有效。',
    'community-platform': '链接域名属于社区平台；作者身份与内容真实性未核验。',
    service: '结果来自天气或地图数据服务，不是景点官方公告。',
    'user-provided': '此网页由用户主动导入，内容未由 Tripwise 独立核验。',
    unclassified: '未能根据来源类型或域名确定内容性质。'
  })[nature]
}

/** 只格式化可解析的页面声明日期；原始声明仍保留在来源记录中。 */
function formatDeclaredDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
