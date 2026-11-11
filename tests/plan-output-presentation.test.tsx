/** 验证结构化计划优先呈现，较长补充正文可按需展开。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ItineraryOption, TripBrief } from '../src/shared/types.js'
import { ChatBubble } from '../src/renderer/src/ConversationView.js'

const brief: TripBrief = {
  departureCity: '', destination: '北京', startDate: '', endDate: '', arrivalFlight: '', arrivalTime: '',
  leaveTime: '', travelers: '', budget: '', lodgingLocation: '', lodging: '', pace: '', earlyStart: '',
  interests: '', transport: '', dietary: '', luggage: '', clothing: '', constraints: ''
}

const itinerary: ItineraryOption = {
  id: 'plan-1', title: '北京一日游', summary: '故宫与中轴线，按预约时段顺游。', tradeoffs: '',
  days: [{ id: 'day-1', dayNumber: 1, date: '2026-11-03', title: '故宫与中轴线', stops: [], scheduleBlocks: [] }]
}

/** 用完整的聊天边界属性渲染草案卡，避免测试依赖真实旅行资料。 */
function renderPlanMessage(content: string): string {
  const message: ChatMessage = {
    id: 'assistant-1', conversationId: 'conversation-1', role: 'assistant', content,
    createdAt: '2026-09-21T12:00:00.000Z', sourceIds: [], itineraryOptions: [itinerary]
  }
  return renderToStaticMarkup(<ChatBubble
    message={message}
    tripBrief={brief}
    revisions={[]}
    sources={[]}
    tripSources={[]}
    baselineRevision={null}
    isLatestProposal
    canContinueRevision={false}
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

describe('结构化计划呈现', () => {
  it('长补充正文默认收起，计划卡仍直接可见', () => {
    const note = '这段补充说明只在需要时查看。'
    const markup = renderPlanMessage(note.repeat(9))

    expect(markup).toContain('<details class="plan-assistant-supplement"><summary>查看补充说明</summary>')
    expect(markup).toContain('class="plan-option-card"')
    expect(markup).toContain('北京一日游')
  })

  it('短的执行提醒保持可见，不额外增加折叠层', () => {
    const markup = renderPlanMessage('故宫预约仍需按官方页面确认。')

    expect(markup).not.toContain('plan-assistant-supplement')
    expect(markup).toContain('故宫预约仍需按官方页面确认。')
  })

  it('计划卡不重复显示与逐项来源状态冲突的全局免责声明', () => {
    const markup = renderPlanMessage('')

    expect(markup).not.toContain('来源只对应地点推荐')
    expect(markup).not.toContain('message-byline')
    expect(markup).not.toContain('行程有数</div>')
    expect(markup).toContain('故宫与中轴线，按预约时段顺游。')
    expect(markup).toContain('第 1 天')
  })
})
