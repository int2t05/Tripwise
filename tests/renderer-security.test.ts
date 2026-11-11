/** 锁定生产 renderer 的内容安全策略与高德地图必需白名单。 */
import { describe, expect, it } from 'vitest'
import { amapFrameContentSecurityPolicy, rendererContentSecurityPolicy } from '../src/shared/renderer-security-policy.js'

/** 解析策略指令，避免测试只检查未经拆分的整段字符串。 */
function policyDirectives(): Map<string, string[]> {
  return new Map(rendererContentSecurityPolicy().split(';').map((directive) => {
    const [name, ...values] = directive.trim().split(/\s+/)
    return [name, values]
  }))
}

describe('renderer 内容安全策略', () => {
  it('主工作区不加载远程地图脚本，只允许嵌入本地地图页', () => {
    const directives = policyDirectives()
    expect(directives.get('default-src')).toEqual(["'self'"])
    expect(directives.get('object-src')).toEqual(["'none'"])
    expect(directives.get('frame-src')).toEqual(['http://127.0.0.1:*'])
    expect(directives.get('base-uri')).toEqual(["'none'"])
    expect(directives.get('form-action')).toEqual(["'none'"])
    expect(directives.get('script-src')).toEqual(["'self'"])
    expect(directives.get('script-src')).not.toContain("'unsafe-inline'")
    expect(directives.get('script-src')).not.toContain("'unsafe-eval'")
    expect(directives.get('style-src')).toContain("'unsafe-inline'")
    expect(directives.get('connect-src')).toContain('http://127.0.0.1:*')
    expect(directives.get('connect-src')).not.toContain('https://*.amap.com')
    expect(directives.get('connect-src')).not.toContain('*')
  })

  it('把高德网络权限限定在独立地图页 CSP 中', () => {
    const directives = new Map(amapFrameContentSecurityPolicy().split(';').map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/)
      return [name, values]
    }))
    expect(directives.get('default-src')).toEqual(["'none'"])
    expect(directives.get('script-src')).toContain('http://127.0.0.1:*')
    expect(directives.get('script-src')).toContain('https://webapi.amap.com')
    expect(directives.get('connect-src')).toContain('http://127.0.0.1:*')
    expect(directives.get('object-src')).toEqual(["'none'"])
    expect(directives.get('frame-src')).toEqual(["'none'"])
  })
})
