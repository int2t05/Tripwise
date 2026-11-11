/** 验证隔离网页出站策略覆盖站点策略且不改写原始输入。 */
import { describe, expect, it } from 'vitest'
import {
  enforceResearchConnectionAllowlist,
  RESEARCH_CONNECTION_ALLOWLIST
} from '../src/main/research-connection-policy.js'

describe('研究网页连接白名单', () => {
  it('允许继续浏览 HTTP(S) 站点和重定向，同时阻止 WebRTC', () => {
    expect(enforceResearchConnectionAllowlist()).toEqual({
      'Connection-Allowlist': [RESEARCH_CONNECTION_ALLOWLIST]
    })
    expect(RESEARCH_CONNECTION_ALLOWLIST).toContain('redirects=allow')
    expect(RESEARCH_CONNECTION_ALLOWLIST).toContain('webrtc=block')
  })

  it('覆盖站点策略并保留其他响应头', () => {
    expect(enforceResearchConnectionAllowlist({
      'content-type': ['text/html; charset=utf-8'],
      'connection-allowlist': ['畸形策略头'],
      'Connection-Allowlist': ['("https://safe.example/*"); webrtc=allow']
    })).toEqual({
      'content-type': ['text/html; charset=utf-8'],
      'Connection-Allowlist': [RESEARCH_CONNECTION_ALLOWLIST]
    })
  })

  it('不修改调用方的响应头对象', () => {
    const input = { 'Content-Type': 'text/html' }
    enforceResearchConnectionAllowlist(input)
    expect(input).toEqual({ 'Content-Type': 'text/html' })
  })
})
