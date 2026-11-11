/** 验证聊天跟随不会打断用户阅读，并尊重系统动态效果设置。 */
import { describe, expect, it } from 'vitest'
import { isNearConversationEnd, scrollBehaviorForMotionPreference } from '../src/renderer/src/conversation-scroll.js'

describe('对话滚动偏好', () => {
  it('用户在末尾 48 像素内时维持自动跟随', () => {
    expect(isNearConversationEnd(652, 1200, 500)).toBe(true)
    expect(isNearConversationEnd(700, 1200, 500)).toBe(true)
  })

  it('用户翻阅更早消息时暂停自动跟随', () => {
    expect(isNearConversationEnd(651, 1200, 500)).toBe(false)
    expect(isNearConversationEnd(100, 1200, 500)).toBe(false)
  })

  it('系统减少动态效果时使用即时滚动', () => {
    expect(scrollBehaviorForMotionPreference(true)).toBe('auto')
    expect(scrollBehaviorForMotionPreference(false)).toBe('smooth')
  })
})
