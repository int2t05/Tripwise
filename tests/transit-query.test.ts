/** 验证缺少路线 API 时，接驳搜索词仍使用正确的机场和车站。 */
import { describe, expect, it } from 'vitest'
import { EMPTY_BRIEF } from '../src/main/persistence/schema.js'
import { buildTransitResearchQuery } from '../src/main/transit-query.js'

describe('公共交通接驳搜索词', () => {
  it('从口语“白云到北京大兴”识别目的地机场和北京西站简称', () => {
    const query = buildTransitResearchQuery({
      ...EMPTY_BRIEF,
      destination: '北京',
      leaveTime: '20:00',
      constraints: '14:00前从广州到广州白云机场，16:00广州白云机场到北京大兴，19:30入住酒店；20:00北京西到广州白云次日18:20。'
    })

    expect(query).toContain('北京大兴机场至北京西站')
    expect(query).not.toContain('广州白云机场至')
    expect(query).not.toContain('火车站')
    expect(query).not.toContain('大学城南')
  })

  it('解析“飞往”时不会把方向词并入机场名称', () => {
    const query = buildTransitResearchQuery({
      ...EMPTY_BRIEF,
      destination: '北京',
      leaveTime: '20:00',
      constraints: '从广州白云机场飞往北京大兴机场，19:30抵达；20:00从北京西站出发。'
    })

    expect(query).toContain('北京大兴机场至北京西站')
    expect(query).not.toContain('往北京大兴机场')
  })

  it('没有提供具体机场和车站时回退到目的地城市名称', () => {
    const query = buildTransitResearchQuery({ ...EMPTY_BRIEF, destination: '北京' })

    expect(query).toContain('北京机场至北京火车站')
  })
})
