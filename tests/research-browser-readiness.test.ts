/** 验证网页正文延迟渲染时的有限等待与稳定检测。 */
import { describe, expect, it } from 'vitest'
import { waitForResearchPageText } from '../src/main/research-browser-readiness.js'

describe('研究浏览器页面就绪检测', () => {
  it('等待动态网页从空白加载到稳定正文', async () => {
    let now = 0
    let reads = 0
    const states = [
      { loading: false, text: '', linkCount: 0 },
      { loading: false, text: '', linkCount: 0 },
      { loading: false, text: '正在载入', linkCount: 0 },
      { loading: false, text: '官方参观须知', linkCount: 1 },
      { loading: false, text: '官方参观须知', linkCount: 1 },
      { loading: false, text: '官方参观须知', linkCount: 1 }
    ]

    await waitForResearchPageText(async () => states[Math.min(reads++, states.length - 1)]!, {
      minimumStableMs: 500,
      timeoutMs: 2_000,
      pollIntervalMs: 250,
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds }
    })

    expect(reads).toBe(6)
    expect(now).toBeGreaterThanOrEqual(1_000)
  })

  it('正文始终为空时在等待上限后返回', async () => {
    let now = 0
    let reads = 0

    await waitForResearchPageText(async () => {
      reads += 1
      return { loading: false, text: '', linkCount: 0 }
    }, {
      minimumStableMs: 500,
      timeoutMs: 1_000,
      pollIntervalMs: 250,
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds }
    })

    expect(reads).toBe(4)
    expect(now).toBe(1_000)
  })

  it('搜索页正文稳定但结果链接延迟出现时继续等待到链接列表稳定', async () => {
    let now = 0
    let reads = 0
    let observedLinkCount = 0
    const states = [
      { loading: false, text: '搜索结果', linkCount: 2 },
      { loading: false, text: '搜索结果', linkCount: 2 },
      { loading: false, text: '搜索结果', linkCount: 2 },
      { loading: false, text: '搜索结果', linkCount: 2 },
      { loading: false, text: '搜索结果', linkCount: 2 },
      { loading: false, text: '搜索结果', linkCount: 2 },
      { loading: false, text: '搜索结果', linkCount: 5 },
      { loading: false, text: '搜索结果', linkCount: 7 },
      { loading: false, text: '搜索结果', linkCount: 7 },
      { loading: false, text: '搜索结果', linkCount: 7 },
      { loading: false, text: '搜索结果', linkCount: 7 }
    ]

    await waitForResearchPageText(async () => {
      const state = states[Math.min(reads++, states.length - 1)]!
      observedLinkCount = state.linkCount
      return state
    }, {
      minimumStableMs: 2_500,
      timeoutMs: 4_000,
      pollIntervalMs: 250,
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds }
    })

    expect(now).toBeGreaterThanOrEqual(2_500)
    expect(reads).toBeGreaterThanOrEqual(11)
    expect(observedLinkCount).toBe(7)
  })
})
