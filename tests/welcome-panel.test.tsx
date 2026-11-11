/** 验证欢迎页用示例表达产品用途，不重复显示导航状态。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WelcomePanel } from '../src/renderer/src/ConversationView'

/** 用静态渲染检查各连接状态的用户文案和设置入口。 */
function render(hasTrip = false): string {
  return renderToStaticMarkup(
    <WelcomePanel hasTrip={hasTrip} onPrompt={() => undefined} />
  )
}

describe('欢迎页层级', () => {
  it('用标题和示例承载引导，不重复说明连接状态或功能标签', () => {
    const markup = render()

    expect(markup).toContain('规划一趟旅行')
    expect(markup).toContain('北京 · 3 天 · 故宫与红叶')
    expect(markup).not.toContain('行程规划')
    expect(markup).not.toContain('景点与路线')
    expect(markup).not.toContain('API Key 已保存')
    expect(markup).not.toContain('打开连接设置')
  })

  it('已有旅行时显示继续规划标题', () => {
    expect(render(true)).toContain('继续规划这趟旅行')
  })
})
