/** 模型长请求期间周期性汇报等待时长，不读取或转发模型内容。 */
export function withModelRequestProgress<T>(
  request: Promise<T>,
  onProgress: (elapsedMs: number) => void,
  intervalMs = 60_000
): Promise<T> {
  const startedAt = Date.now()
  const timer = setInterval(() => {
    try {
      onProgress(Date.now() - startedAt)
    } catch {
      // 进度通知失败时继续等待模型结果，不中断当前规划。
    }
  }, intervalMs)
  timer.unref()
  return request.finally(() => clearInterval(timer))
}
