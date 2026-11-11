/** 为尚未建立内容的页面提供一致且可理解的下一步说明。 */
import type { ReactNode } from 'react'

/** 显示页面的空状态、原因和下一步提示。 */
export function EmptyWorkspace({ icon, title, action }: { icon: ReactNode; title: string; action: string }) {
  return <div className="empty-workspace"><div>{icon}</div><h2>{title}</h2><p>{action}</p></div>
}
