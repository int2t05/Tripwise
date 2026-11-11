/** 验证聊天长表的收纳行为和表格辅助技术语义。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, TripBrief } from '../src/shared/types.js'
import { ChatBubble } from '../src/renderer/src/ConversationView.js'

const brief: TripBrief = {
  departureCity: '', destination: '北京', startDate: '', endDate: '', arrivalFlight: '', arrivalTime: '', leaveTime: '',
  travelers: '', budget: '', lodgingLocation: '', lodging: '', pace: '', earlyStart: '', interests: '', transport: '',
  dietary: '', luggage: '', clothing: '', constraints: ''
}

const longTable = [
  '| 日期 | 天气 |', '| --- | --- |',
  '| 10-26 | 多云 |', '| 10-27 | 晴 |', '| 10-28 | 晴 |', '| 10-29 | 多云 |',
  '| 10-30 | 多云 |', '| 10-31 | 多云 |', '| 11-01 | 多云 |'
].join('\n')

/** 通过真实聊天气泡验证助手和用户消息采用不同的折叠规则。 */
function renderMessage(role: ChatMessage['role'], content: string): string {
  const message: ChatMessage = {
    id: `${role}-1`, conversationId: 'conversation-1', role, content,
    createdAt: '2026-09-21T12:00:00.000Z', sourceIds: []
  }
  return renderToStaticMarkup(<ChatBubble
    message={message}
    tripBrief={brief}
    revisions={[]}
    sources={[]}
    tripSources={[]}
    baselineRevision={null}
    canResume={false}
    onResume={() => undefined}
    onSave={() => undefined}
    onRejectOption={() => undefined}
    onSavePreparation={() => undefined}
    onApplyBrief={async () => undefined}
    onOpen={() => undefined}
    onShowSource={() => undefined}
  />)
}

describe('聊天长表呈现', () => {
  it('助手长表默认收起，列标题和完整数据仍可访问', () => {
    const markup = renderMessage('assistant', `已保存逐日天气。\n\n${longTable}`)

    expect(markup).toContain('<details class="markdown-table-disclosure"><summary>日期 · 7 行</summary>')
    expect(markup).toContain('<thead><tr><th scope="col">日期</th><th scope="col">天气</th></tr></thead>')
    expect(markup).toContain('<tbody>')
    expect(markup).toContain('10-26')
    expect(markup).toContain('11-01')
  })

  it('短表保持展开，避免给简单结果增加操作', () => {
    const shortTable = ['| 日期 | 天气 |', '| --- | --- |', '| 10-26 | 多云 |', '| 10-27 | 晴 |'].join('\n')
    const markup = renderMessage('assistant', shortTable)

    expect(markup).not.toContain('markdown-table-disclosure')
    expect(markup).toContain('<th scope="col">日期</th>')
    expect(markup).toContain('10-27')
  })

  it('用户发来的长表不自动收起', () => {
    const markup = renderMessage('user', longTable)

    expect(markup).not.toContain('markdown-table-disclosure')
    expect(markup).toContain('<th scope="col">日期</th>')
    expect(markup).toContain('11-01')
  })
})
