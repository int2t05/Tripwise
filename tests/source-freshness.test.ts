/** 验证动态旅行来源的复核阈值与保守边界。 */
import { describe, expect, it } from 'vitest'
import { sourceFreshnessNotice } from '../src/renderer/src/source-freshness.js'

const now = Date.parse('2026-10-18T12:00:00.000Z')

describe('旅行来源时效提醒', () => {
  it('天气来源达到六小时后提示重新查询', () => {
    const notice = sourceFreshnessNotice({
      kind: 'weather', status: 'success', fetchedAt: new Date(now - 6 * 60 * 60 * 1_000).toISOString()
    }, now)

    expect(notice?.label).toBe('天气可能已变化')
    expect(notice?.detail).toContain('天气查询已超过 6 小时')
    expect(notice?.detail).toContain('出发前建议重新查询')
  })

  it('路线来源不到二十四小时不提醒，达到阈值后提醒', () => {
    expect(sourceFreshnessNotice({
      kind: 'route', status: 'success', fetchedAt: new Date(now - 23 * 60 * 60 * 1_000).toISOString()
    }, now)).toBeNull()
    expect(sourceFreshnessNotice({
      kind: 'route', status: 'success', fetchedAt: new Date(now - 24 * 60 * 60 * 1_000).toISOString()
    }, now)?.label).toBe('路线可能已变化')
  })

  it('不为失败、静态来源、无效时间或未来时间给出过期结论', () => {
    expect(sourceFreshnessNotice({ kind: 'weather', status: 'error', fetchedAt: '2020-01-01T00:00:00.000Z' }, now)).toBeNull()
    expect(sourceFreshnessNotice({ kind: 'web', status: 'success', fetchedAt: '2020-01-01T00:00:00.000Z' }, now)).toBeNull()
    expect(sourceFreshnessNotice({ kind: 'weather', status: 'success', fetchedAt: 'invalid' }, now)).toBeNull()
    expect(sourceFreshnessNotice({ kind: 'route', status: 'success', fetchedAt: new Date(now + 1).toISOString() }, now)).toBeNull()
  })
})
