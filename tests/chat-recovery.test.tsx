/** 验证中断对话只为末尾未完成消息提供清楚的恢复入口。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, TripBrief } from '../src/shared/types.js'
import { findResumableMessage } from '../src/shared/chat-recovery.js'
import { ChatBubble } from '../src/renderer/src/ConversationView'

const brief: TripBrief = {
  departureCity: '', destination: '北京', startDate: '', endDate: '', arrivalFlight: '', arrivalTime: '', leaveTime: '',
    travelers: '', budget: '', lodgingLocation: '', lodging: '', pace: '', earlyStart: '', interests: '', transport: '', dietary: '',
  luggage: '', clothing: '', constraints: ''
}

const userMessage: ChatMessage = {
  id: 'unfinished-1', conversationId: 'conversation-1', role: 'user', content: '规划北京三日游。',
  createdAt: '2026-10-18T08:00:00.000Z', sourceIds: []
}

/** 用最小消息对象渲染恢复入口，验证按钮只在恢复状态出现。 */
function renderRecoveryAction(message: ChatMessage, canResume: boolean): string {
  return renderToStaticMarkup(<ChatBubble
    message={message}
    tripBrief={brief}
    revisions={[]}
    sources={[]}
    tripSources={[]}
    baselineRevision={null}
    canResume={canResume}
    onResume={() => undefined}
    onSave={() => undefined}
    onRejectOption={() => undefined}
    onSavePreparation={() => undefined}
    onApplyBrief={async () => undefined}
    onOpen={() => undefined}
    onShowSource={() => undefined}
  />)
}

describe('中断对话恢复入口', () => {
  it('只识别旅行记录末尾尚无回复的用户消息', () => {
    const assistantMessage: ChatMessage = {
      id: 'assistant-1', conversationId: 'conversation-1', role: 'assistant', content: '我已整理好方案。',
      createdAt: '2026-10-18T08:01:00.000Z', sourceIds: []
    }

    expect(findResumableMessage([userMessage])).toBe(userMessage)
    expect(findResumableMessage([userMessage, assistantMessage])).toBeNull()
    expect(findResumableMessage([])).toBeNull()
  })

  it('只对最后一条中断消息展示重试按钮', () => {
    const resumableMarkup = renderRecoveryAction(userMessage, true)
    const completedMarkup = renderRecoveryAction(userMessage, false)

    expect(resumableMarkup).toContain('重试</button>')
    expect(resumableMarkup).toContain('上一条回复未完成。可以重新发送。')
    expect(resumableMarkup).not.toContain('message-byline')
    expect(resumableMarkup).not.toContain('你</div>')
    expect(completedMarkup).not.toContain('重试</button>')
  })

  it('空文本回复不渲染空白消息卡', () => {
    const markup = renderRecoveryAction({
      id: 'assistant-empty', conversationId: 'conversation-1', role: 'assistant', content: '',
      createdAt: '2026-10-18T08:01:00.000Z', sourceIds: []
    }, false)

    expect(markup).not.toContain('class="message-card')
    expect(markup).not.toContain('保存为文本方案')
    expect(markup).not.toContain('class="message-actions"')
  })
})
