/** 验证真实运行状态、工具结果和等待时间清楚可见，不推断虚构阶段。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentProgress, formatAgentElapsedTime } from '../src/renderer/src/AgentProgress'

describe('AgentProgress', () => {
  it('显示实际状态和等待时间，不绘制推断阶段', () => {
    const markup = renderToStaticMarkup(<AgentProgress status="正在搜索网页资料" startedAt={Date.now() - 125_000} />)

    expect(markup).toContain('正在搜索网页资料')
    expect(markup).toContain('已用 02:05')
    expect(markup).not.toContain('规划阶段')
    expect(markup).not.toContain('agent-progress-step')
  })

  it('失败时显示真实失败状态和已返回的工具记录', () => {
    const markup = renderToStaticMarkup(<AgentProgress
      status="本轮未完成"
      startedAt={Date.now() - 60_000}
      outcome="failed"
      activities={[{ id: 'failed-search', label: '正在搜索网页资料', detail: '搜索服务超时', state: 'failed' }]}
    />)

    expect(markup).toContain('<span>本轮未完成</span>')
    expect(markup).toContain('搜索服务超时')
    expect(markup).not.toContain('停在：')
  })

  it('超过一小时后使用小时、分钟和秒显示', () => {
    expect(formatAgentElapsedTime(3_661)).toBe('01:01:01')
  })

  it('不根据状态文字猜测阶段或展示思维链', () => {
    const markup = renderToStaticMarkup(<AgentProgress status="正在分析需求并规划检索…" startedAt={Date.now()} />)

    expect(markup).toContain('正在分析需求并规划检索…')
    expect(markup).not.toContain('agent-progress-step')
    expect(markup).not.toContain('reasoning')
  })

  it('显示不同的已完成工具，不重复当前状态或同类调用', () => {
    const markup = renderToStaticMarkup(<AgentProgress
      status="正在整理行程方案"
      startedAt={Date.now()}
      activities={[
        { id: 'search-1', toolCallId: 'call-1', label: '正在搜索网页来源', detail: '5 个来源', state: 'completed' },
        { id: 'search-2', toolCallId: 'call-2', label: '正在搜索网页来源', detail: '7 个来源', state: 'completed' },
        { id: 'route', toolCallId: 'call-3', label: '正在估算路线', detail: '1 段已核对', state: 'completed' },
        { id: 'current', toolCallId: 'call-4', label: '正在整理行程方案', state: 'running' }
      ]}
    />)
    const recentMarkup = markup.split('<details class="agent-activity-history">')[0] ?? markup

    expect(recentMarkup.match(/搜索网页来源/gu)).toHaveLength(1)
    expect(recentMarkup).toContain('7 个来源')
    expect(recentMarkup).not.toContain('5 个来源')
    expect(markup).toContain('5 个来源')
    expect(recentMarkup).toContain('估算路线')
    expect(recentMarkup.match(/整理行程方案/gu)).toHaveLength(1)
    expect(recentMarkup).not.toContain('正在整理行程方案')
    expect(recentMarkup).toContain('已用')
  })

  it('将正在执行的工具显示为主状态，不再重复列入工具历史', () => {
    const markup = renderToStaticMarkup(<AgentProgress
      status="正在浏览网页"
      startedAt={Date.now()}
      activities={[{ id: 'current', label: '识别网页中的图文', state: 'running' }]}
    />)

    expect(markup).toContain('<span>识别网页中的图文</span>')
    expect(markup.match(/agent-activity activity-running/gu)).toHaveLength(1)
    expect(markup).toContain('全部步骤')
  })

  it('在工具步骤中显示结构化 warning 和 error 反馈', () => {
    const markup = renderToStaticMarkup(<AgentProgress
      status="正在校验行程"
      startedAt={Date.now()}
      activities={[
        { id: 'search', label: '正在搜索网页来源', state: 'partial', feedback: [
          { severity: 'warning', code: 'source_unavailable', message: '一个来源暂不可用。' }
        ] },
        { id: 'plan', label: '正在整理结构化行程', state: 'failed', feedback: [
          { severity: 'error', code: 'schedule_overlap', message: '时间安排存在重叠。' }
        ] }
      ]}
    />)

    expect(markup).toContain('一个来源暂不可用。')
    expect(markup).toContain('时间安排存在重叠。')
    expect(markup).toContain('feedback-warning')
    expect(markup).toContain('feedback-error')
  })

  it('保留全部工具步骤供查看，同时把默认进度保持精简', () => {
    const activities = Array.from({ length: 8 }, (_, index) => ({
      id: `step-${index}`,
      label: `正在完成步骤 ${index + 1}`,
      detail: index === 7 ? '8 个来源' : undefined,
      state: 'completed' as const
    }))
    const markup = renderToStaticMarkup(<AgentProgress
      status="正在整理行程方案"
      startedAt={Date.now()}
      activities={activities}
    />)

    expect(markup).toContain('全部步骤')
    expect(markup).toContain('<small>8</small>')
    expect(markup).toContain('本轮工具步骤')
    expect(markup).toContain('完成步骤 1')
    expect(markup).toContain('完成步骤 8')
    expect(markup).toContain('8 个来源')
  })

  it('在计划完成后保留静态步骤记录和固定耗时', () => {
    const finishedAt = Date.now()
    const markup = renderToStaticMarkup(<AgentProgress
      status="方案已生成"
      startedAt={finishedAt - 125_000}
      finishedAt={finishedAt}
      outcome="completed"
      activities={[{ id: 'search', label: '正在搜索网页来源', state: 'completed', detail: '7 个来源' }]}
    />)

    expect(markup).toContain('agent-progress-completed')
    expect(markup).toContain('<span>本轮已完成</span>')
    expect(markup).toContain('aria-label="本轮工具步骤已完成"')
    expect(markup).toContain('已用 02:05')
    expect(markup).toContain('7 个来源')
    expect(markup).not.toContain('role="status"')
  })
})
