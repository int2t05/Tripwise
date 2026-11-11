/** 测试旅行资料代理的持久化规范与 Chromium 会话配置。 */
import { describe, expect, it } from 'vitest'
import { isNormalizedSourceProxy, normalizeSourceProxy, sourceProxyConfig } from '../src/main/network-proxy.js'

describe('旅行资料代理配置', () => {
  it('空值使用系统代理设置', () => {
    expect(normalizeSourceProxy('   ')).toBe('')
    expect(sourceProxyConfig('')).toEqual({ mode: 'system' })
  })

  it('规范化 HTTP、HTTPS 与 SOCKS5 地址', () => {
    expect(normalizeSourceProxy(' http://127.0.0.1:8080/ ')).toBe('http://127.0.0.1:8080')
    expect(sourceProxyConfig('https://proxy.example:8443')).toEqual({
      mode: 'fixed_servers', proxyRules: 'https://proxy.example:8443'
    })
    expect(sourceProxyConfig('socks5://127.0.0.1:1080')).toEqual({
      mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:1080'
    })
  })

  it('拒绝凭证、路径、查询参数和非代理协议', () => {
    for (const value of [
      'http://user:password@127.0.0.1:8080',
      'http://127.0.0.1:8080/proxy',
      'http://127.0.0.1:8080?token=secret',
      'file:///tmp/proxy'
    ]) {
      expect(() => normalizeSourceProxy(value)).toThrow()
    }
  })

  it('只把规范化地址判为有效持久化值', () => {
    expect(isNormalizedSourceProxy('')).toBe(true)
    expect(isNormalizedSourceProxy('http://127.0.0.1:8080')).toBe(true)
    expect(isNormalizedSourceProxy(' http://127.0.0.1:8080/ ')).toBe(false)
    expect(isNormalizedSourceProxy(undefined)).toBe(false)
  })
})
