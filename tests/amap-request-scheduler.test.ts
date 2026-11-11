/** 验证高德请求队列的限速、接口隔离和取消释放行为。 */
import { describe, expect, it } from 'vitest'
import { AmapRequestScheduler } from '../src/main/connectors/amap-request-scheduler.js'

describe('高德接口请求限流', () => {
  it('同一接口的并发请求按最小间隔启动', async () => {
    const scheduler = new AmapRequestScheduler(15)
    const starts: number[] = []
    await Promise.all(Array.from({ length: 4 }, () => scheduler.run('geocode', async () => {
      starts.push(Date.now())
    })))

    expect(starts).toHaveLength(4)
    expect(starts.slice(1).every((startedAt, index) => startedAt - starts[index]! >= 12)).toBe(true)
  })

  it('不同接口使用独立配额队列', async () => {
    const scheduler = new AmapRequestScheduler(40)
    const starts: number[] = []
    await Promise.all(['geocode', 'route:transit'].map((bucket) => scheduler.run(bucket, async () => {
      starts.push(Date.now())
    })))

    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(30)
  })

  it('取消排队中的请求后仍释放后续请求', async () => {
    const scheduler = new AmapRequestScheduler(20)
    const first = scheduler.run('geocode', async () => new Promise((resolve) => setTimeout(resolve, 35)))
    const controller = new AbortController()
    const cancelled = scheduler.run('geocode', async () => '不应执行', controller.signal)
    controller.abort()
    const next = scheduler.run('geocode', async () => '完成')

    await expect(cancelled).rejects.toThrow('本次规划已取消')
    await first
    await expect(next).resolves.toBe('完成')
  })
})
