/** 验证历史版本切换锁只执行一个并在结束后释放。 */
import { describe, expect, it, vi } from 'vitest'
import { runRevisionActivation } from '../src/renderer/src/revision-activation'

describe('runRevisionActivation', () => {
  it('忽略并发切换，并在首个操作结束后重新开放', async () => {
    const lock = { current: false }
    let finish!: (value: string) => void
    const action = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const first = runRevisionActivation(lock, action)
    const concurrent = await runRevisionActivation(lock, vi.fn(async () => '不应执行'))

    expect(concurrent).toBeNull()
    expect(action).toHaveBeenCalledOnce()
    finish('完成')
    await expect(first).resolves.toBe('完成')
    expect(lock.current).toBe(false)
    await expect(runRevisionActivation(lock, async () => '再次允许')).resolves.toBe('再次允许')
  })

  it('操作失败时也释放切换锁', async () => {
    const lock = { current: false }

    await expect(runRevisionActivation(lock, async () => { throw new Error('失败') })).rejects.toThrow('失败')
    expect(lock.current).toBe(false)
  })
})
