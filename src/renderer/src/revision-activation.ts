/** 为历史版本切换提供单次执行锁，避免连续点击造成快照竞态。 */
export async function runRevisionActivation<T>(lock: { current: boolean }, action: () => Promise<T>): Promise<T | null> {
  if (lock.current) return null
  lock.current = true
  try {
    return await action()
  } finally {
    lock.current = false
  }
}
