/** 将启动快照读取的并发保护和失败/成功回调保持为单一流程。 */
export type StartupLoadResult = 'loaded' | 'failed' | 'ignored'

/** 合并重复启动请求；失败交给调用方显示，结束时始终释放忙碌状态。 */
export async function runStartupLoad<T>(lock: { current: boolean }, load: () => Promise<T>, onSuccess: (value: T) => void, onFailure: (reason: unknown) => void, onBusy: (busy: boolean) => void): Promise<StartupLoadResult> {
  if (lock.current) return 'ignored'
  lock.current = true
  onBusy(true)
  try {
    const value = await load()
    onSuccess(value)
    return 'loaded'
  } catch (reason) {
    onFailure(reason)
    return 'failed'
  } finally {
    lock.current = false
    onBusy(false)
  }
}
