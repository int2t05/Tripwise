/** 提供旅行内话题查找与自动标题规则，保证界面和主进程使用相同边界。 */
import type { ChatMessage, Trip, TripConversation } from './types.js'

/** 返回指定话题；不存在时显式返回 null，由调用方显示恢复错误。 */
export function findConversation(trip: Trip, conversationId: string): TripConversation | null {
  return trip.conversations.find((conversation) => conversation.id === conversationId) ?? null
}

/** 只读取指定话题的消息，避免把其他主题历史发送给模型或显示在当前视图。 */
export function conversationMessages(trip: Trip, conversationId: string): ChatMessage[] {
  return trip.messages.filter((message) => message.conversationId === conversationId)
}

/** 隐藏仅供主进程恢复使用的工具轮次，不把外部资料回传给界面或旅行备份。 */
export function stripAgentRunProgress(trip: Trip): Trip {
  return {
    ...trip,
    messages: trip.messages.map((message) => {
      const visibleMessage = { ...message }
      delete visibleMessage.agentRunProgress
      return visibleMessage
    })
  }
}

/** 将新话题第一条用户消息压成适合侧栏的标题，不改写消息原文。 */
export function conversationTitleFromMessage(content: string): string {
  const normalized = content.trim().replace(/\s+/gu, ' ')
  const characters = Array.from(normalized)
  return characters.length > 32 ? `${characters.slice(0, 32).join('')}…` : normalized || '新话题'
}
