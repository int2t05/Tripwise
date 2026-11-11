/** 用受控异步操作验证启动读取的失败、重试和并发合并语义。 */
import { describe, expect, it, vi } from 'vitest'
import { runStartupLoad } from '../src/renderer/src/startup-load'

describe('启动快照读取', () => {
  it('报告第一次失败并释放锁，之后允许重试成功', async () => {
    const lock = { current: false }
    const failure = new Error('本地资料暂时不可读取')
    const load = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce('snapshot')
    const onSuccess = vi.fn<(value: string) => void>()
    const onFailure = vi.fn<(reason: unknown) => void>()
    const onBusy = vi.fn<(busy: boolean) => void>()

    await expect(runStartupLoad(lock, load, onSuccess, onFailure, onBusy)).resolves.toBe('failed')
    expect(lock.current).toBe(false)
    expect(onFailure).toHaveBeenCalledWith(failure)
    expect(onBusy.mock.calls).toEqual([[true], [false]])

    await expect(runStartupLoad(lock, load, onSuccess, onFailure, onBusy)).resolves.toBe('loaded')
    expect(onSuccess).toHaveBeenCalledWith('snapshot')
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(lock.current).toBe(false)
  })

  it('读取运行中忽略重复触发，并在原请求结束后解除忙碌状态', async () => {
    const lock = { current: false }
    let finishLoad!: (value: string) => void
    const load = vi.fn(() => new Promise<string>((resolve) => { finishLoad = resolve }))
    const onSuccess = vi.fn<(value: string) => void>()
    const onFailure = vi.fn<(reason: unknown) => void>()
    const onBusy = vi.fn<(busy: boolean) => void>()

    const first = runStartupLoad(lock, load, onSuccess, onFailure, onBusy)
    await expect(runStartupLoad(lock, load, onSuccess, onFailure, onBusy)).resolves.toBe('ignored')
    expect(load).toHaveBeenCalledTimes(1)
    expect(onBusy.mock.calls).toEqual([[true]])

    finishLoad('snapshot')
    await expect(first).resolves.toBe('loaded')
    expect(onSuccess).toHaveBeenCalledWith('snapshot')
    expect(onBusy.mock.calls).toEqual([[true], [false]])
    expect(lock.current).toBe(false)
  })
})
