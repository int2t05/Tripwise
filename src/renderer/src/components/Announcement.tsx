/** 为不改变焦点的动态消息提供一致的辅助技术播报语义。 */
import type { ReactNode } from 'react'

/** 将成功、进度和错误消息映射到对应的 live region 角色。 */
export function Announcement({ role, className, children }: {
  role: 'status' | 'alert'
  className: string
  children: ReactNode
}) {
  return <div className={className} role={role} aria-atomic="true">{children}</div>
}
