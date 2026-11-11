/** 等待隔离网页出现并稳定显示可读正文。 */

export interface ResearchPageReadiness {
  loading: boolean
  text: string
  linkCount: number
}

export interface ResearchPageReadinessOptions {
  minimumStableMs: number
  timeoutMs?: number
  pollIntervalMs?: number
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
}

/** 正文与链接可能在 load 事件后渲染；等两者稳定后再生成快照。 */
export async function waitForResearchPageText(
  readPage: () => Promise<ResearchPageReadiness>,
  options: ResearchPageReadinessOptions
): Promise<void> {
  const now = options.now ?? Date.now
  const wait = options.wait ?? waitMilliseconds
  const timeoutMs = options.timeoutMs ?? 8_000
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const startedAt = now()
  let previousText = ''
  let previousLinkCount = -1
  let stableReads = 0

  while (now() - startedAt < timeoutMs) {
    const page = await readPage()
    const text = page.text.trim()
    if (!page.loading && text) {
      const contentStable = text === previousText && page.linkCount === previousLinkCount
      stableReads = contentStable ? stableReads + 1 : 0
      if (now() - startedAt >= options.minimumStableMs && stableReads >= 2) return
    } else {
      stableReads = 0
    }
    previousText = text
    previousLinkCount = page.linkCount
    await wait(pollIntervalMs)
  }
}

/** 让出事件循环，避免在等待页面渲染时阻塞 Electron 主进程。 */
function waitMilliseconds(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
