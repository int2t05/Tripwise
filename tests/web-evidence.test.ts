/** 验证限长网页摘录优先保留可核验的旅行事实。 */
import { describe, expect, it } from 'vitest'
import { travelEvidenceExcerpt } from '../src/main/connectors/web-evidence.js'

describe('旅行网页事实摘录', () => {
  it('长开放说明中优先保留明确营业时段', () => {
    const genericBlocks = Array.from({ length: 70 }, () =>
      '开放时间及游览安排请以景区现场公告为准；可能因特殊活动、天气和客流情况临时调整，请以现场通知为准。'
    )
    const page = [
      '# 示例景区参观须知',
      ...genericBlocks,
      '开放时间：08:30–17:00；停止入园时间为 16:30。'
    ].join('\n\n')

    expect(travelEvidenceExcerpt(page)).toContain('开放时间：08:30–17:00')
  })

  it('长门票说明中优先保留明确票价', () => {
    const genericBlocks = Array.from({ length: 70 }, () =>
      '门票价格及购票安排请以景区现场公告为准；优惠票种和入园政策可能调整，请以现场通知为准。'
    )
    const page = [
      '# 示例景区购票须知',
      ...genericBlocks,
      '成人门票：45 元；学生票：22 元。'
    ].join('\n\n')

    expect(travelEvidenceExcerpt(page)).toContain('成人门票：45 元')
  })

  it('长页面的“售票信息”小节会连同景点标题和金额一起保留', () => {
    const genericBlocks = Array.from({ length: 70 }, () =>
      '游览服务以景区现场公告为准；入园规则和游客服务可能随日期调整，请提前复核。'
    )
    const page = [
      '# 北京景点参观指南',
      '## 故宫博物院',
      '### 售票信息',
      ...genericBlocks,
      '成人票：60 元；学生票：30 元。'
    ].join('\n\n')

    const excerpt = travelEvidenceExcerpt(page)

    expect(excerpt).toContain('## 故宫博物院')
    expect(excerpt).toContain('### 售票信息')
    expect(excerpt).toContain('成人票：60 元')
  })

  it('长预约说明中优先保留可执行预约条件', () => {
    const genericBlocks = Array.from({ length: 70 }, () =>
      '预约规则和入园安排请关注景区官方公告；不同活动及日期的要求可能有变化，请以官方通知为准。'
    )
    const page = [
      '# 示例景区预约须知',
      ...genericBlocks,
      '实名预约：须提前 1 日通过官方公众号预约，每日 09:00 开放未来 7 日名额。'
    ].join('\n\n')

    expect(travelEvidenceExcerpt(page)).toContain('须提前 1 日通过官方公众号预约')
  })

  it('保留事实段落所属场馆标题，避免摘录丢失地点归属', () => {
    const genericBlocks = Array.from({ length: 12 }, (_, index) =>
      `参观须知补充说明 ${index}：${'本段介绍场馆历史、建筑和参观背景。'.repeat(18)}`
    )
    const page = [
      '# 官方参观指南',
      '## 故宫博物院',
      '本段说明场馆区域和参观路线，但不包含具体开放信息。',
      '更多参观介绍与现场服务说明。',
      '开放时间：08:30–17:00。',
      ...genericBlocks
    ].join('\n\n')

    const excerpt = travelEvidenceExcerpt(page)

    expect(excerpt).toContain('## 故宫博物院')
    expect(excerpt).toContain('开放时间：08:30–17:00')
  })
})
