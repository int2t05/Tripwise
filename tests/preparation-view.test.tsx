/** 验证出行准备页的空状态、行程分组和证据状态能被清晰呈现。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ItineraryRevision, PreparationItem, Trip } from '../src/shared/types.js'
import { PreparationView } from '../src/renderer/src/PreparationView'

const packingItem: PreparationItem = {
  id: 'packing-1', title: '带一件防风外套', category: 'packing', packingSection: 'unclassified',
  detail: '结合天气预报，在出发前复核。', itineraryDate: '2026-10-20', dueDate: '',
  evidenceLevel: 'pending', sourceIds: [], checked: false
}

const trip: Trip = {
  id: 'trip-1', title: '北京秋游', createdAt: '2026-10-18T08:00:00.000Z', updatedAt: '2026-10-18T08:00:00.000Z',
  conversations: [{ id: 'conversation-1', title: '总体规划', createdAt: '2026-10-18T08:00:00.000Z', updatedAt: '2026-10-18T08:00:00.000Z' }],
  activeConversationId: 'conversation-1',
  brief: {
    departureCity: '', destination: '北京', startDate: '', endDate: '', arrivalFlight: '', arrivalTime: '', leaveTime: '',
    travelers: '', budget: '', lodgingLocation: '', lodging: '', pace: '', earlyStart: '', interests: '', transport: '', dietary: '',
    luggage: '', clothing: '', constraints: ''
  },
  briefUnknownFields: [],
  messages: [], sources: [], preparationItems: [packingItem], revisions: [], activeRevisionId: null
}

const activeRevision = {
  id: 'revision-1', number: 1, createdAt: '2026-10-18T08:00:00.000Z', summary: '北京秋游', content: '', sourceIds: [],
  itinerary: {
    id: 'itinerary-1', title: '北京秋游', summary: '故宫与红叶', tradeoffs: '安排适量步行',
    days: [{ id: 'day-1', dayNumber: 1, date: '2026-10-20', title: '故宫与中轴线', stops: [], scheduleBlocks: [] }]
  }
} as ItineraryRevision

function render(tripValue: Trip | null, revision: ItineraryRevision | null): string {
  return renderToStaticMarkup(<PreparationView
    trip={tripValue}
    activeRevision={revision}
    onSwitchToChat={() => undefined}
    onToggleItem={() => undefined}
    onUpdateItem={async () => true}
    onDeleteItem={async () => true}
    onOpen={() => undefined}
  />)
}

describe('出行准备页', () => {
  it('没有旅行时说明如何开始', () => {
    const markup = render(null, null)

    expect(markup).toContain('<h2>还没有旅行</h2>')
    expect(markup).toContain('新建旅行后即可整理准备事项。')
  })

  it('按适用行程日组织清单并显示未核验状态', () => {
    const markup = render(trip, activeRevision)

    expect(markup).toContain('已完成 0 / 1')
    expect(markup).not.toContain('出行准备</span>')
    expect(markup).not.toContain('天气、预约和行李信息会附上来源')
    expect(markup).toContain('对应行程：第 1 天 · 故宫与中轴线')
    expect(markup).toContain('带一件防风外套')
    expect(markup).toContain('待核验')
    expect(markup).toContain('门票与预约')
    expect(markup).not.toContain('结合天气和已带衣物。')
    expect(markup).not.toContain('按旅行日期查询天气')
  })

  it('行程尚未保存时说明准备清单的使用条件并禁用准备项', () => {
    const markup = render(trip, null)

    expect(markup).toContain('保存行程后，准备事项会按天整理。')
    expect(markup).toContain('disabled=""')
    expect(markup).not.toContain('保存行程后，可按日期查看准备事项')
  })
})
