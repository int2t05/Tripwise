/** 识别页面开头的明确登录墙或人工验证提示，避免把门槛页当旅行来源。 */
import type { ResearchPageAccessState } from './types.js'

const MAX_GATE_PAGE_CHARACTERS = 800

/** 只检查页面开头的明确门槛短语，普通页脚里的登录链接不触发。 */
export function classifyResearchPageAccess(text: string): ResearchPageAccessState | undefined {
  const normalized = text.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase()
    .slice(0, MAX_GATE_PAGE_CHARACTERS)
  if (normalized.length === 0) return undefined
  if (/扫码登录|登录后(?:查看|浏览|搜索|查看更多|解锁)|请(?:先)?登录(?:后|以|继续)|登录后才能/u.test(normalized)) {
    return 'login-required'
  }
  if (/安全验证|行为验证|人机验证|请输入验证码|完成验证后|访问异常/u.test(normalized)) {
    return 'verification-required'
  }
  return undefined
}
