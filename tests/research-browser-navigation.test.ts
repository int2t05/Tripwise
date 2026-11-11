/** 验证慢速页面会在有限时间后停止，且加载错误不会被当作成功。 */
import { describe, expect, it, vi } from 'vitest'
import { ResearchNavigationTrace, waitForResearchNavigation } from '../src/main/research-browser-navigation.js'

describe('研究浏览器导航期限', () => {
  it('只按主框架事件推进导航阶段', () => {
    const trace = new ResearchNavigationTrace()
    expect(trace.stage).toBe('requested')

    trace.started(false)
    trace.redirected(false)
    expect(trace.stage).toBe('requested')

    trace.started(true)
    expect(trace.stage).toBe('started')
    trace.redirected(true)
    expect(trace.stage).toBe('redirected')
    trace.committed()
    expect(trace.stage).toBe('committed')
  })

  it('页面按时加载时保留完整页面', async () => {
    const stop = vi.fn()

    await expect(waitForResearchNavigation(async () => undefined, stop, 100))
      .resolves.toBe('loaded')
    expect(stop).not.toHaveBeenCalled()
  })

  it('超过期限时停止加载并返回可标记的部分状态', async () => {
    vi.useFakeTimers()
    const stop = vi.fn()
    const load = vi.fn(() => new Promise<void>(() => undefined))
    try {
      const pending = waitForResearchNavigation(load, stop, 100, 10)
      await vi.advanceTimersByTimeAsync(110)
      await expect(pending).resolves.toBe('timed_out')
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('保留导航自身的加载错误', async () => {
    const stop = vi.fn()

    await expect(waitForResearchNavigation(async () => { throw new Error('load failed') }, stop, 100))
      .rejects.toThrow('load failed')
    expect(stop).not.toHaveBeenCalled()
  })
})
