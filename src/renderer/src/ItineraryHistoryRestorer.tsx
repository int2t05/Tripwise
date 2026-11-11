/** 让用户从历史结构化版本挑选变更并应用到尚未保存的编辑草稿。 */
import { useState } from 'react'
import type { ItineraryOption, ItineraryRevision } from '@shared/types'
import {
  itineraryRestorationSelectionError,
  listItineraryRestorableChanges,
  type ItineraryRestorableChange
} from '@shared/itinerary-restoration'

/** 从历史版本按项恢复字段、地点顺序、独立时段和日程结构。 */
export function ItineraryHistoryRestorer({ itinerary, revisions, protectedStopIds, onApply }: {
  itinerary: ItineraryOption
  revisions: ItineraryRevision[]
  protectedStopIds: string[]
  onApply: (revision: ItineraryRevision, changeIds: string[]) => void
}) {
  const availableRevisions = revisions.filter((revision) => revision.itinerary)
  const [revisionId, setRevisionId] = useState(availableRevisions[0]?.id ?? '')
  const [selectedChanges, setSelectedChanges] = useState<Set<string>>(() => new Set())
  const revision = availableRevisions.find((item) => item.id === revisionId) ?? availableRevisions[0]
  const changes = revision?.itinerary ? listItineraryRestorableChanges(itinerary, revision.itinerary, protectedStopIds) : []
  const availableChanges = changes.filter((change) => !change.disabledReason)
  const selectedCount = availableChanges.filter((change) => selectedChanges.has(change.id)).length
  const selectionError = itineraryRestorationSelectionError(itinerary, changes, [...selectedChanges])
  const structureChanges = changes.filter((change) => change.changeType === 'structure')
  const fieldChanges = changes.filter((change) => change.changeType === 'field')

  /** 同步单项恢复选择，保留其余已选差异。 */
  function toggleChange(changeId: string, selected: boolean): void {
    setSelectedChanges((current) => {
      const next = new Set(current)
      if (selected) next.add(changeId)
      else next.delete(changeId)
      return next
    })
  }

  /** 切换历史版本时清空旧版本的差异选择。 */
  function selectRevision(nextRevisionId: string): void {
    setRevisionId(nextRevisionId)
    setSelectedChanges(new Set())
  }

  /** 仅将通过约束检查的勾选差异交给当前草稿。 */
  function applySelected(): void {
    if (!revision || selectedCount === 0 || selectionError) return
    onApply(revision, availableChanges.filter((change) => selectedChanges.has(change.id)).map((change) => change.id))
    setSelectedChanges(new Set())
  }

  return <details className="itinerary-history-restorer">
    <summary>从历史版本恢复行程</summary>
    <div className="itinerary-restore-panel">
      <p>按项勾选要恢复的内容，其他草稿内容保持不变。旧地点恢复后会重新核对来源、事实和定位；结构变化会清除失效路线估算。旧交通说明只恢复文字，仍需核对。固定安排不能通过此操作更改。</p>
      {availableRevisions.length > 0
        ? <label className="editor-field itinerary-restore-version"><span>历史版本</span>
          <select value={revision?.id ?? ''} onChange={(event) => selectRevision(event.target.value)}>
            {availableRevisions.map((item) => <option key={item.id} value={item.id}>
              第 {item.number} 版 · {item.summary}
            </option>)}
          </select>
        </label>
        : <p className="itinerary-restore-empty">没有包含结构化行程的历史版本。</p>}
      {revision && changes.length > 0
        ? <>
          <div className="itinerary-restore-actions">
            <button type="button" className="text-button" disabled={!availableChanges.length} onClick={() => setSelectedChanges(new Set(availableChanges.map((change) => change.id)))}>全选可恢复差异</button>
            <button type="button" className="text-button" onClick={() => setSelectedChanges(new Set())}>清空选择</button>
          </div>
          {structureChanges.length > 0 && <section className="itinerary-restore-group" aria-label="日程结构差异">
            <h4>地点、时段与日期结构</h4>
            <div className="itinerary-restore-fields">
              {structureChanges.map((change) =>
                <RestoreChangeChoice key={change.id} change={change} selected={selectedChanges.has(change.id)} onToggle={toggleChange} />)}
            </div>
          </section>}
          {fieldChanges.length > 0 && <section className="itinerary-restore-group" aria-label="方案和地点字段差异">
            <h4>方案和地点字段</h4>
            <div className="itinerary-restore-fields">
              {fieldChanges.map((change) =>
                <RestoreChangeChoice key={change.id} change={change} selected={selectedChanges.has(change.id)} onToggle={toggleChange} />)}
            </div>
          </section>}
          {selectionError && <p className="itinerary-restore-selection-error" role="status">{selectionError}</p>}
          <button type="button" className="secondary-button itinerary-restore-apply" disabled={!selectedCount || !!selectionError} onClick={applySelected}>
            应用所选 {selectedCount ? selectedCount + ' 项' : '内容'} 到草稿
          </button>
        </>
        : revision && <p className="itinerary-restore-empty">当前草稿与第 {revision.number} 版没有可恢复的差异。</p>}
    </div>
  </details>
}

/** 展示单项当前值和历史值，并解释固定约束和恢复依赖。 */
function RestoreChangeChoice({ change, selected, onToggle }: {
  change: ItineraryRestorableChange
  selected: boolean
  onToggle: (changeId: string, selected: boolean) => void
}) {
  return <label className="itinerary-restore-choice">
    <input type="checkbox" checked={selected} disabled={!!change.disabledReason} onChange={(event) => onToggle(change.id, event.target.checked)} />
    <span><strong>{change.label}</strong><small>当前：{change.currentValue}</small><small>历史：{change.historicalValue}</small>
      {change.disabledReason && <small className="itinerary-restore-disabled">{change.disabledReason}</small>}
      {change.changeType === 'structure' && change.requiresChangeIds?.length
        ? <small>需要同时恢复对应日期</small>
        : null}
    </span>
  </label>
}
