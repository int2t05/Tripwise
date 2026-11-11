/** 验证网页研究地址和隔离浏览器请求不会直达本机或常见局域网主机。 */
import { describe, expect, it } from 'vitest'
import {
  isPublicResearchAddress,
  normalizeResearchUrl,
  modelSafeResearchUrl,
  sanitizeResearchSourceUrl,
  shouldBlockResearchRequest
} from '../src/main/research-url.js'

describe('网页研究地址', () => {
  it('保留公网 HTTP(S) 页面并规范化域名尾点', () => {
    expect(normalizeResearchUrl(' https://visit.example/season?year=2026#map '))
      .toBe('https://visit.example/season?year=2026#map')
    expect(normalizeResearchUrl('http://public.example./article')).toBe('http://public.example/article')
  })

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:password@visit.example/article',
    'http://127.0.0.1/admin',
    'http://192.168.1.1/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://localhost/',
    'http://service.local/',
    'http://printer.home.arpa/',
    'http://router/',
    'http://127.0.0.1.nip.io/',
    'http://2130706433/',
    'http://0x7f000001/'
  ])('拒绝不安全地址 %s', (url) => {
    expect(() => normalizeResearchUrl(url)).toThrow()
  })
})

describe('隔离网页请求策略', () => {
  it('允许公网网页和页面内数据资源', () => {
    expect(shouldBlockResearchRequest('https://visit.example/image.webp')).toBe(false)
    expect(shouldBlockResearchRequest('data:image/png;base64,AA==')).toBe(false)
    expect(shouldBlockResearchRequest('blob:https://visit.example/asset-id')).toBe(false)
  })

  it.each([
    'file:///Users/person/private.txt',
    'http://127.0.0.1:3000/',
    'http://10.0.0.8/status',
    'http://router.local/'
  ])('阻止非公网请求 %s', (url) => {
    expect(shouldBlockResearchRequest(url)).toBe(true)
  })

  it.each([
    '8.8.8.8', '93.184.216.34', '2001:4860:4860::8888'
  ])('按当前公网单播规则允许地址 %s', (address) => {
    expect(isPublicResearchAddress(address)).toBe(true)
  })

  it.each([
    '0.1.2.3', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1',
    '172.16.0.1', '192.0.0.1', '192.168.1.1', '198.18.0.1', '203.0.113.8', '224.0.0.1',
    '240.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1',
    '2001:db8::1', '2002:7f00:1::1', '64:ff9b::7f00:1'
  ])('按当前公网单播规则拒绝地址 %s', (address) => {
    expect(isPublicResearchAddress(address)).toBe(false)
  })
})

describe('旅行来源网址', () => {
  it('仅对小红书来源保留 xsec_token，同时清除其他访问凭证', () => {
    expect(sanitizeResearchSourceUrl(
      'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=note-access&access_token=secret'
    )).toBe('https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=note-access')
    expect(sanitizeResearchSourceUrl(
      'https://travel.example/note?xsec_token=private&token=secret'
    )).toBe('https://travel.example/note')
    expect(sanitizeResearchSourceUrl(
      'https://cdn.xiaohongshu.com/note?xsec_token=private'
    )).toBe('https://cdn.xiaohongshu.com/note')
    expect(modelSafeResearchUrl(
      'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=note-access'
    )).toBe('https://www.xiaohongshu.com/explore/0123456789abcdef01234567')
  })
})
