/** 验证慢模型进度提示的计时与清理。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withModelRequestProgress } from '../src/main/model-request-progress.js'

describe('withModelRequestProgress', () => {
  afterEach(() => vi.useRealTimers())

  it('周期汇报耗时，并在请求完成后清理计时器', async () => {
    vi.useFakeTimers()
    let resolveRequest!: (value: string) => void
    const request = new Promise<string>((resolve) => { resolveRequest = resolve })
    const onProgress = vi.fn()
    const pending = withModelRequestProgress(request, onProgress, 60_000)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(onProgress.mock.calls.map(([elapsedMs]) => elapsedMs)).toEqual([60_000, 120_000])

    resolveRequest('完成')
    await expect(pending).resolves.toBe('完成')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('请求失败后也会清理计时器', async () => {
    vi.useFakeTimers()
    const pending = withModelRequestProgress(Promise.reject(new Error('失败')), vi.fn(), 60_000)

    await expect(pending).rejects.toThrow('失败')
    expect(vi.getTimerCount()).toBe(0)
  })
})
