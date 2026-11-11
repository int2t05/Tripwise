/** 并排查看相邻版本的纯文本行程，补足旧版资料没有结构化差异的问题。 */
import { useMemo } from 'react'
import type { ItineraryRevision } from '@shared/types'
import { MarkdownContent } from './MarkdownContent'
import { compareTextLines } from './text-line-diff'

/** 仅当至少一版没有结构化行程时提供文本对照。 */
export function RevisionTextComparison({ current, previous, onOpen }: {
  current: ItineraryRevision
  previous: ItineraryRevision
  onOpen: (url: string) => void
}) {
  const shouldCompareText = !current.itinerary || !previous.itinerary
  const diff = useMemo(
    () => shouldCompareText ? compareTextLines(previous.content, current.content) : null,
    [shouldCompareText, previous.content, current.content]
  )
  if (!shouldCompareText) return null
  return <details className="revision-text-comparison">
    <summary>文本对照 · 第 {previous.number} 版与当前第 {current.number} 版</summary>
    <div className="revision-comparison-grid">
      <article className="revision-comparison-pane">
        <h3>第 {previous.number} 版</h3>
        <MarkdownContent text={previous.content} onOpen={onOpen} />
      </article>
      <article className="revision-comparison-pane">
        <h3>当前第 {current.number} 版</h3>
        <MarkdownContent text={current.content} onOpen={onOpen} />
      </article>
    </div>
    {diff ? <details className="revision-text-diff">
      <summary>逐行变化 · 新增 {diff.addedCount} 行，删除 {diff.removedCount} 行</summary>
      <div className="revision-diff-list">
        {diff.changes.map((change, index) => <div className={`revision-diff-line diff-${change.kind}`} key={`${change.kind}-${index}`}>
          <strong>{change.kind === 'added' ? '新增' : change.kind === 'removed' ? '删除' : '保留'}</strong>
          <code>{change.text || ' '}</code>
        </div>)}
      </div>
    </details> : <p className="revision-diff-limit">文本较长，暂不计算逐行变化；上方仍可并排查看两版。</p>}
  </details>
}
