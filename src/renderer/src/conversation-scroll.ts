/** 集中管理聊天跟随阈值和系统动态效果偏好。 */

const CONVERSATION_FOLLOW_THRESHOLD = 48

/** 只有用户仍在消息末尾附近时，才自动跟随新消息与规划进度。 */
export function isNearConversationEnd(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  const distanceFromEnd = scrollHeight - scrollTop - clientHeight
  return Number.isFinite(distanceFromEnd) && distanceFromEnd <= CONVERSATION_FOLLOW_THRESHOLD
}

/** 减少动态效果时使用浏览器即时滚动，否则保留平滑跟随。 */
export function scrollBehaviorForMotionPreference(prefersReducedMotion: boolean): ScrollBehavior {
  return prefersReducedMotion ? 'auto' : 'smooth'
}
