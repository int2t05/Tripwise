/** 提供来源与网页视图切换，并向辅助技术公开当前选中状态。 */
import { FileText, Globe2 } from 'lucide-react'

export type ResearchPanelView = 'sources' | 'web'

/** 用具备名称和按下状态的原生按钮切换右侧面板内容。 */
export function ResearchPanelTabs({ activeView, sourceCount, disabled = false, onSelect }: {
  activeView: ResearchPanelView
  sourceCount: number
  disabled?: boolean
  onSelect: (view: ResearchPanelView) => void
}) {
  return <div className="research-panel-tabs" role="group" aria-label="来源面板视图">
    <button type="button" disabled={disabled} className={activeView === 'sources' ? 'selected' : ''} aria-pressed={activeView === 'sources'} onClick={() => onSelect('sources')}>
      <FileText size={15} /> 来源{sourceCount > 0 ? <span>{sourceCount}</span> : null}
    </button>
    <button type="button" disabled={disabled} className={activeView === 'web' ? 'selected' : ''} aria-pressed={activeView === 'web'} onClick={() => onSelect('web')}>
      <Globe2 size={15} /> 网页
    </button>
  </div>
}
