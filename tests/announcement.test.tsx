/** 确认不抢焦点的动态消息声明了正确的播报角色。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Announcement } from '../src/renderer/src/components/Announcement'

describe('动态消息播报', () => {
  it('把进度和成功消息声明为原子状态消息', () => {
    const markup = renderToStaticMarkup(<Announcement role="status" className="test-status">行程已保存</Announcement>)

    expect(markup).toContain('role="status"')
    expect(markup).toContain('aria-atomic="true"')
    expect(markup).toContain('行程已保存')
  })

  it('把需要用户注意的错误声明为原子提醒', () => {
    const markup = renderToStaticMarkup(<Announcement role="alert" className="test-error">网页加载失败</Announcement>)

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('aria-atomic="true"')
    expect(markup).toContain('网页加载失败')
  })
})
