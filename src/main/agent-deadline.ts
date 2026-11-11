/** 限制一次旅行规划的最长执行时间，并区分用户取消与系统超时。 */
export const MAX_AGENT_DURATION_MS = 35 * 60 * 1_000
/** GLM 与 Codex 持久会话预留 90 分钟完成多轮工具交互。 */
export const MAX_GLM_AGENT_DURATION_MS = 90 * 60 * 1_000

/** 按模型设置总时限：普通模型保持现有上限，GLM 可完成多个长思考轮次。 */
export function agentDurationForModel(model: string): number {
  return /^(?:glm-5\.3-flash(?:$|[-.])|codex-cli:)/i.test(model.trim()) ? MAX_GLM_AGENT_DURATION_MS : MAX_AGENT_DURATION_MS
}

/** 生成与当前模型时限一致的简短提示。 */
export function agentTimeoutMessage(model: string): string {
  return `本次规划超过 ${Math.round(agentDurationForModel(model) / 60_000)} 分钟时限，已停止；已完成的来源已保留，可以继续对话或缩小范围重试。`
}

/** 为单次规划启动截止计时器，并返回可在任务结束时调用的清理函数。 */
export function armAgentDeadline(controller: AbortController, model = ''): () => void {
  const duration = agentDurationForModel(model)
  const timer = setTimeout(() => {
    const timeoutError = new Error(`规划超过 ${Math.round(duration / 60_000)} 分钟时限。`)
    timeoutError.name = 'TimeoutError'
    controller.abort(timeoutError)
  }, duration)
  timer.unref()
  return () => clearTimeout(timer)
}

/** 判断中止原因是否由规划总时限触发。 */
export function isAgentTimeout(signal: AbortSignal): boolean {
  return signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
}
