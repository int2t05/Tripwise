/** 验证工具过程文案只展示动作和结果状态，不回显工具原始内容。 */
import { describe, expect, it } from 'vitest'
import type { ToolResult } from '../src/main/tools.js'
import { createSource } from '../src/main/connectors/types.js'
import { toolLabel, toolResultProgress } from '../src/main/agent-progress.js'

function toolResult(overrides: Partial<ToolResult> = {}): ToolResult {
  return { output: '', sources: [], ...overrides }
}

describe('Agent 工具进度映射', () => {
  it('将页面内搜索和展开目标映射为可观察动作', () => {
    expect(toolLabel('research_browser_interact', JSON.stringify({ target_id: 's2', query: '不应显示的检索词' })))
      .toBe('正在搜索并读取当前网页')
    expect(toolLabel('research_browser_interact', JSON.stringify({ target_id: 'e7' })))
      .toBe('正在展开并读取网页内容')
    expect(toolLabel('research_browser_interact', '{'))
      .toBe('正在操作右侧研究网页')
  })

  it('为常用工具提供稳定标签，未知工具使用通用标签', () => {
    expect(toolLabel('estimate_route')).toBe('正在估算交通路线')
    expect(toolLabel('research_browser_snapshot')).toBe('正在重新读取右侧网页内容')
    expect(toolLabel('mcp_unknown_tool')).toBe('正在调用旅行工具')
  })

  it('成功搜索只显示动作结果，不显示搜索词或工具正文', () => {
    const progress = toolResultProgress('research_browser_interact', toolResult({
      output: '实现文案可调整，query=不应显示的检索词',
      progressCode: 'browser_interact_search_completed'
    }))

    expect(progress).toEqual({ message: '搜索结果已打开并读取', outcome: 'completed' })
    expect(JSON.stringify(progress)).not.toContain('不应显示的检索词')
  })

  it('将网页操作失败归类为不可用并隐藏原始错误', () => {
    const progress = toolResultProgress('research_browser_interact', toolResult({
      output: '失败详情不参与界面状态解析',
      progressCode: 'browser_interact_search_unsupported'
    }))

    expect(progress).toEqual({ message: '仅支持同站 GET 搜索', outcome: 'unavailable' })
    expect(JSON.stringify(progress)).not.toContain('原始页面内容')
  })

  it('区分全部来源不可用与部分来源成功', () => {
    const unavailable = createSource('检索状态', 'https://example.com/', 'test', 'web', 'quota error', 'error')
    expect(toolResultProgress('search_web', toolResult({ sources: [unavailable] })))
      .toEqual({ message: '来源暂不可用', outcome: 'unavailable' })

    const available = createSource('公开页面', 'https://example.org/', 'test', 'web', '摘要', 'success')
    expect(toolResultProgress('search_web', toolResult({ sources: [available, unavailable] })))
      .toEqual({ message: '1 个来源，1 个不可用', outcome: 'partial' })
  })

  it('将 warning feedback 保留为可见诊断并标记部分完成', () => {
    const progress = toolResultProgress('search_web', toolResult({
      feedback: [{ severity: 'warning', code: 'source_unavailable', message: '一个来源暂不可用。' }]
    }))

    expect(progress).toEqual({
      message: '没有找到可用来源',
      outcome: 'partial',
      feedback: [{ severity: 'warning', code: 'source_unavailable', message: '一个来源暂不可用。' }]
    })
  })

  it('将拒绝原因压缩成固定状态，不回显行程内容', () => {
    const progress = toolResultProgress('propose_itineraries', toolResult({
      output: '候选方案未通过校验：某个具体地点和用户资料'
    }))

    expect(progress).toEqual({ message: '草案未通过校验', outcome: 'rejected' })
    expect(JSON.stringify(progress)).not.toContain('具体地点')
  })

  it('网页视觉读取只提示待核验，不回显识别文字', () => {
    const progress = toolResultProgress('research_browser_visual_read', toolResult({
      output: '页面内可能的营业时间是某个时刻',
      progressCode: 'browser_visual_read_completed'
    }))

    expect(progress).toEqual({ message: '已读取页面视觉线索，待来源核验', outcome: 'completed' })
    expect(JSON.stringify(progress)).not.toContain('营业时间')
  })

  it('浏览器状态不受结果文案变化影响', () => {
    const progress = toolResultProgress('research_browser_open_link', toolResult({
      output: '已打开',
      progressCode: 'browser_link_opened'
    }))

    expect(progress).toEqual({ message: '网页来源已打开并读取', outcome: 'completed' })
  })

  it('正文读取失败时把已打开链接显示为部分完成', () => {
    expect(toolResultProgress('research_browser_open_link', toolResult({
      output: '页面已打开，正文暂时无法读取。',
      progressCode: 'browser_link_read_unavailable'
    }))).toEqual({ message: '网页已打开，正文暂不可用', outcome: 'partial' })
  })

  it('页面加载超时后显示部分读取状态', () => {
    expect(toolResultProgress('research_browser_navigate', toolResult({
      progressCode: 'browser_navigation_read_partial'
    }))).toEqual({ message: '页面加载超时，已读取当前可见内容', outcome: 'partial' })
    expect(toolResultProgress('research_browser_open_link', toolResult({
      progressCode: 'browser_link_read_partial'
    }))).toEqual({ message: '页面加载超时，已读取当前可见内容', outcome: 'partial' })
  })

  it('开链失败时显示可恢复的固定原因', () => {
    expect(toolResultProgress('research_browser_open_link', toolResult({
      progressCode: 'browser_link_unavailable', browserLinkFailureKind: 'stale_snapshot'
    }))).toEqual({ message: '网页已变化，请重新读取快照', outcome: 'unavailable' })
    expect(toolResultProgress('research_browser_open_link', toolResult({
      progressCode: 'browser_link_unavailable', browserLinkFailureKind: 'timeout'
    }))).toEqual({ message: '网页连接失败，可继续其他来源', outcome: 'unavailable' })
  })

  it('将导航与页面读取合并为可见状态', () => {
    expect(toolResultProgress('research_browser_navigate', toolResult({
      progressCode: 'browser_navigation_read_completed'
    }))).toEqual({ message: '网页已打开并读取', outcome: 'completed' })
    expect(toolResultProgress('research_browser_navigate', toolResult({
      progressCode: 'browser_navigation_read_blocked'
    }))).toEqual({ message: '网页要求手动处理访问门槛', outcome: 'unavailable' })
  })
})
