/** 验证研究浏览器只识别页面开头的明确登录墙与验证提示。 */
import { describe, expect, it } from 'vitest'
import { classifyResearchPageAccess } from '../src/shared/research-page-access.js'

describe('研究网页访问门槛识别', () => {
  it('识别登录后才能查看的短页面', () => {
    expect(classifyResearchPageAccess('扫码登录后查看笔记')).toBe('login-required')
    expect(classifyResearchPageAccess('登录后查看更多笔记内容')).toBe('login-required')
  })

  it('识别要求人工验证的短页面', () => {
    expect(classifyResearchPageAccess('访问异常，请完成安全验证')).toBe('verification-required')
    expect(classifyResearchPageAccess('请输入验证码后继续')).toBe('verification-required')
  })

  it('不把长文章或普通登录链接误判为访问门槛', () => {
    expect(classifyResearchPageAccess(`页面顶部有登录入口。${'北京旅行攻略正文。'.repeat(80)}`)).toBeUndefined()
    expect(classifyResearchPageAccess('登录')).toBeUndefined()
    expect(classifyResearchPageAccess('')).toBeUndefined()
  })

  it('长页面开头的登录或验证遮罩仍会被识别', () => {
    expect(classifyResearchPageAccess(`扫码登录后查看笔记。${'北京旅行攻略正文。'.repeat(200)}`)).toBe('login-required')
    expect(classifyResearchPageAccess(`请输入验证码后继续。${'北京旅行攻略正文。'.repeat(200)}`)).toBe('verification-required')
    expect(classifyResearchPageAccess(`${'北京旅行攻略正文。'.repeat(200)}扫码登录后查看笔记`)).toBeUndefined()
  })
})
