/** 集中定义界面共享的状态和时间格式。 */
import type { SourceRecord } from '@shared/types'

/** 以状态文字解释来源结果，不依赖颜色表达含义。 */
export function statusLabel(status: SourceRecord['status']): string {
  return ({ success: '已获取', partial: '部分结果', unavailable: '不可用', error: '查询失败' })[status]
}

/** 按来源结果状态区分内容获取时间与最近一次失败/部分查询尝试。 */
export function sourceTimestampLabel(source: Pick<SourceRecord, 'status' | 'fetchedAt'>): string {
  const action = source.status === 'success' ? '获取于' : '最近尝试于'
  return `${action} ${formatTime(source.fetchedAt)}`
}

/** 格式化时间戳供消息和来源卡片使用。 */
export function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}


/** 只向用户展示业务错误，移除 Electron IPC 在 renderer 一侧增加的方法包装。 */
export function errorMessage(reason: unknown, fallback = '操作失败，请检查连接后重试。'): string {
  if (!(reason instanceof Error)) return fallback
  const message = reason.message.trim()
  if (!message) return fallback
  const ipcError = /^Error invoking remote method '[^']+': Error:\s*([\s\S]+)$/.exec(message)
  return (ipcError?.[1] ?? message).trim()
}
