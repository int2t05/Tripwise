/** 按高德接口类别串行控制请求频率，避免路线批量查询触发服务限流。 */

const AMAP_MIN_REQUEST_GAP_MS = 400

type QueueState = {
  tail: Promise<void>
  lastStartedAt: number
}

/** 为不同接口维护独立队列；请求失败或取消后仍释放后续任务。 */
export class AmapRequestScheduler {
  private readonly queues = new Map<string, QueueState>()

  /** 创建限流器；测试可缩短间隔，产品默认值保留每秒约 2.5 次余量。 */
  constructor(private readonly minimumGapMs = AMAP_MIN_REQUEST_GAP_MS) {}

  /** 按接口顺序执行请求，并响应整轮规划的取消信号。 */
  async run<T>(bucket: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const queue = this.queues.get(bucket) ?? { tail: Promise.resolve(), lastStartedAt: 0 }
    const predecessor = queue.tail
    let release!: () => void
    const ticket = new Promise<void>((resolve) => { release = resolve })
    const queuedTail = predecessor.then(() => ticket)
    queue.tail = queuedTail
    this.queues.set(bucket, queue)
    await predecessor

    try {
      const waitMs = Math.max(0, this.minimumGapMs - (Date.now() - queue.lastStartedAt))
      if (waitMs > 0) await waitForDelay(waitMs, signal)
      if (signal?.aborted) throw new Error('本次规划已取消。')
      queue.lastStartedAt = Date.now()
      return await task()
    } finally {
      release()
      if (queue.tail === queuedTail && this.queues.get(bucket) === queue) {
        // 保留 lastStartedAt，以便紧随其后的新请求仍遵守最小间隔。
        queue.tail = Promise.resolve()
      }
    }
  }
}

/** 等待限流间隔；用户取消时立即解除等待队列。 */
function waitForDelay(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('本次规划已取消。'))
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', cancel)
      resolve()
    }
    const timer = setTimeout(finish, durationMs)
    const cancel = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      reject(new Error('本次规划已取消。'))
    }
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

/** 产品共享限流器：地理编码、公交、步行和驾车使用各自的服务配额桶。 */
export const amapRequestScheduler = new AmapRequestScheduler()
