/** 验证右侧面板切换公开分组名称和当前按下状态。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ResearchPanelTabs } from '../src/renderer/src/ResearchPanelTabs'

describe('ResearchPanelTabs', () => {
  it('将网页视图的选择状态暴露给辅助技术', () => {
    const markup = renderToStaticMarkup(
      <ResearchPanelTabs activeView="web" sourceCount={3} onSelect={() => undefined} />
    )

    expect(markup).toContain('role="group" aria-label="来源面板视图"')
    expect(markup).toContain('aria-pressed="false">')
    expect(markup).toContain('aria-pressed="true">')
    expect(markup).toContain('来源<span>3</span>')
    expect(markup).toContain('网页')
  })
})
