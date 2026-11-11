/** 验证具体机场/车站须由用户原话确认，目的地城市不等同于枢纽确认。 */
import { describe, expect, it } from 'vitest'
import { transportHubAliases, userConfirmedTransportHub } from '../src/shared/transport-hubs.js'

describe('旅行枢纽确认', () => {
  it('不会把目的地城市当作该城市机场的确认', () => {
    expect(transportHubAliases('成都机场', '成都')).toEqual(['成都机场'])
    expect(userConfirmedTransportHub('成都机场', '我去成都旅行。', '成都')).toBe(false)
  })

  it('接受用户在原话中提供的机场或车站名称及常见简称', () => {
    expect(userConfirmedTransportHub('成都天府国际机场', '航班落地天府机场。', '成都')).toBe(true)
    expect(userConfirmedTransportHub('北京西站', '返程从北京西站发车。', '北京')).toBe(true)
  })

  it('不把用户明确表示不确定的候选机场当成已确认枢纽', () => {
    expect(userConfirmedTransportHub('成都天府机场', '我不确定是天府还是双流机场。', '成都')).toBe(false)
    expect(userConfirmedTransportHub('天府机场或双流机场', '航班抵达地点待确认。', '成都')).toBe(false)
  })

  it('只把紧邻枢纽名称的分隔词作为候选歧义，不误读前文“景点或用餐”', () => {
    expect(userConfirmedTransportHub(
      '北京西站',
      '9/27 16:30后不安排景点或用餐。20:00从北京西站乘动车，次日18:20抵达广州白云。',
      '北京'
    )).toBe(true)
    expect(userConfirmedTransportHub('北京西站', '从北京西站或北京站乘车。', '北京')).toBe(false)
    expect(userConfirmedTransportHub('北京西站', '从北京西站/北京站乘车。', '北京')).toBe(false)
  })
})
