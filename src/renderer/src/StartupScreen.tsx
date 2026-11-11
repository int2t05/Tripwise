/** 展示工作区启动、载入失败及用户主动重试状态。 */
import { Announcement } from './components/Announcement'

/** 启动失败时保留原始错误说明，并提供显式且可重复的恢复入口。 */
export function StartupScreen({ brandSymbol, error, busy, onRetry }: {
  brandSymbol: string
  error: string
  busy: boolean
  onRetry: () => void
}) {
  return <main className="boot-screen" aria-busy={busy}>
    <div className="brand-mark"><img src={brandSymbol} alt="" /></div>
    {error
      ? <>
        <h1>无法打开 Tripwise</h1>
        <Announcement role="alert" className="error-banner boot-error">{error}</Announcement>
        <button className="primary-button" type="button" disabled={busy} onClick={onRetry}>{busy ? '正在重试…' : '重试'}</button>
      </>
      : <span role="status">正在加载旅行资料…</span>}
  </main>
}
