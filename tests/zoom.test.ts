/** 验证主界面缩放步进、重置和边界。 */
import { describe, expect, it } from 'vitest'
import { nextZoomFactor } from '../src/main/zoom.js'

describe('主界面缩放', () => {
  it('以 10% 步进并可重置到默认比例', () => {
    expect(nextZoomFactor(1, 1)).toBe(1.1)
    expect(nextZoomFactor(1.1, -1)).toBe(1)
    expect(nextZoomFactor(1.8, 0)).toBe(1)
  })

  it('将比例限制在 50% 到 200%', () => {
    expect(nextZoomFactor(2, 1)).toBe(2)
    expect(nextZoomFactor(0.5, -1)).toBe(0.5)
  })

  it('当前比例无效时从默认比例继续调整', () => {
    expect(nextZoomFactor(Number.NaN, 1)).toBe(1.1)
  })
})
