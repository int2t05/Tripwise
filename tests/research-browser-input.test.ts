/** 验证研究浏览器地址栏对网址、搜索词和站内攻略入口的解析。 */
import { describe, expect, it } from 'vitest'
import { buildXiaohongshuSearchUrl, isResearchSearchResultsUrl, resolveResearchBrowserInput } from '../src/shared/research-browser-input.js'

describe('研究浏览器地址栏', () => {
  it('将普通中文输入转为公开搜索，并保留原始查询词', () => {
    const target = resolveResearchBrowserInput('  故宫 预约 开放时间  ')

    expect(target.kind).toBe('search')
    expect(new URL(target.url).searchParams.get('q')).toBe('故宫 预约 开放时间')
    expect(new URL(target.url).hostname).toBe('www.bing.com')
  })

  it('直接打开带协议和不带协议的网址', () => {
    expect(resolveResearchBrowserInput('https://example.com/guide')).toEqual({
      kind: 'url', url: 'https://example.com/guide'
    })
    expect(resolveResearchBrowserInput('www.example.com/guide')).toEqual({
      kind: 'url', url: 'https://www.example.com/guide'
    })
  })

  it('识别 Bing 与旧版 DuckDuckGo 查询页，拒绝相似伪造主机', () => {
    expect(isResearchSearchResultsUrl('https://cn.bing.com/search?q=%E6%95%85%E5%AE%AB')).toBe(true)
    expect(isResearchSearchResultsUrl('https://www.bing.com/search/?q=%E6%95%85%E5%AE%AB')).toBe(true)
    expect(isResearchSearchResultsUrl('https://html.duckduckgo.com/html/?q=%E6%95%85%E5%AE%AB')).toBe(true)
    expect(isResearchSearchResultsUrl('https://duckduckgo.com/?q=%E6%95%85%E5%AE%AB')).toBe(false)
    expect(isResearchSearchResultsUrl('https://html.duckduckgo.com.attacker.example/html/?q=x')).toBe(false)
    expect(isResearchSearchResultsUrl('https://bing.com.attacker.example/search?q=x')).toBe(false)
  })

  it('将社区攻略搜索直达小红书站内结果页，并把结果页识别为线索页', () => {
    const url = buildXiaohongshuSearchUrl('  北京\n旅行攻略  ')

    expect(new URL(url).hostname).toBe('www.xiaohongshu.com')
    expect(new URL(url).searchParams.get('keyword')).toBe('北京 旅行攻略')
    expect(isResearchSearchResultsUrl(url)).toBe(true)
    expect(isResearchSearchResultsUrl('https://www.xiaohongshu.com.attacker.example/search_result?keyword=北京')).toBe(false)
    expect(isResearchSearchResultsUrl('https://www.xiaohongshu.com/search_result/123?keyword=北京')).toBe(false)
  })

  it('拒绝空输入、不支持的协议和过长搜索词', () => {
    expect(() => resolveResearchBrowserInput('   ')).toThrow('请输入网页地址或搜索词。')
    expect(() => resolveResearchBrowserInput('file:///tmp/private.txt')).toThrow('网页地址只支持 HTTP(S)。')
    expect(() => resolveResearchBrowserInput('旅行'.repeat(151))).toThrow('搜索词不能超过 300 个字符。')
  })
})
