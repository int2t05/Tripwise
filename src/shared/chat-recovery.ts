/** 判断对话末尾是否存在可重新处理的未完成用户消息。 */
import type { ChatMessage } from './types.js'

/** 只提供最后一条用户消息的恢复入口，避免重放已经有回复的旧请求。 */
export function findResumableMessage(messages: ChatMessage[]): ChatMessage | null {
  const latest = messages.at(-1)
  return latest?.role === 'user' ? latest : null
}
