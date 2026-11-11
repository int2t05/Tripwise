/** 为 Agent 网页导航设置等待上限，避免站点资源拖住整份行程。 */
import type { BrowserNavigationFailureStage } from './connectors/types.js'

export type ResearchNavigationOutcome = 'loaded' | 'timed_out'

/** 跟踪主框架导航的固定阶段，忽略 iframe 的加载事件。 */
export class ResearchNavigationTrace {
  private currentStage: BrowserNavigationFailureStage = 'requested'

  get stage(): BrowserNavigationFailureStage {
    return this.currentStage
  }

  started(isMainFrame: boolean): void {
    if (isMainFrame) this.currentStage = 'started'
  }

  redirected(isMainFrame: boolean): void {
    if (isMainFrame) this.currentStage = 'redirected'
  }

  committed(): void {
    this.currentStage = 'committed'
  }
}

/** 页面超过上限时停止剩余加载；调用方可读取已稳定显示的内容并标为 partial。 */
export async function waitForResearchNavigation(
  load: () => Promise<void>,
  stop: () => void,
  timeoutMs: number,
  stopGraceMs = 500
): Promise<ResearchNavigationOutcome> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(stopGraceMs) || stopGraceMs < 0) {
    throw new Error('研究网页导航等待时间无效。')
  }

  const loadPromise = Promise.resolve().then(load)
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timed_out'>((resolve) => {
    timeout = setTimeout(() => resolve('timed_out'), timeoutMs)
  })
  try {
    const outcome = await Promise.race([
      loadPromise.then(() => 'loaded' as const),
      deadline
    ])
    if (outcome === 'loaded') return outcome

    stop()
    await Promise.race([
      loadPromise.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, stopGraceMs))
    ])
    return 'timed_out'
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
