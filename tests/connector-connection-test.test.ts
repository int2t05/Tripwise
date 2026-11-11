/** 验证设置页连接测试只访问指定服务并避免泄露凭证与响应内容。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testBuiltinConnector } from '../src/main/connectors/connection-test.js'
import { configureExternalFetcher } from '../src/main/connectors/http.js'

describe('内置连接器设置页测试', () => {
  let calls: Array<{ url: string; init?: RequestInit }>
  let responseBody: unknown
  let responseStatus: number

  beforeEach(() => {
    calls = []
    responseBody = {}
    responseStatus = 200
    configureExternalFetcher(async (input, init) => {
      calls.push({ url: String(input), init })
      return new Response(JSON.stringify(responseBody), {
        status: responseStatus,
        headers: { 'Content-Type': 'application/json' }
      })
    })
  })

  afterEach(() => configureExternalFetcher(undefined))

  it('只请求 Exa，不回退到其他搜索服务或保存返回内容', async () => {
    responseBody = { results: [{ url: 'https://example.org/travel', title: 'Example', highlights: ['test snippet'] }] }

    const result = await testBuiltinConnector('exa', 'fake-exa-secret')

    expect(result).toEqual({ ok: true, message: 'Exa连接成功；测试查询返回 1 条结果。' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.exa.ai/search')
    expect(new Headers(calls[0].init?.headers).get('x-api-key')).toBe('fake-exa-secret')
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ query: 'Tripwise 旅行搜索连接测试' })
    expect(result.message).not.toContain('fake-exa-secret')
    expect(result.message).not.toContain('test snippet')
  })

  it('只请求 Tavily，并仅返回结果数量', async () => {
    responseBody = { results: [{ url: 'https://example.org/travel', title: 'Example', content: 'private test content' }] }

    const result = await testBuiltinConnector('tavily', 'fake-tavily-secret')

    expect(result).toEqual({ ok: true, message: 'Tavily连接成功；测试查询返回 1 条结果。' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.tavily.com/search')
    expect(new Headers(calls[0].init?.headers).get('Authorization')).toBe('Bearer fake-tavily-secret')
    expect(result.message).not.toContain('private test content')
  })

  it('Firecrawl 只读取固定公开示例页且不返回正文', async () => {
    responseBody = { success: true, data: { markdown: 'Example Domain' } }

    const result = await testBuiltinConnector('firecrawl', 'fake-firecrawl-secret')

    expect(result).toEqual({ ok: true, message: 'Firecrawl 连接成功；公开示例页读取正常。' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.firecrawl.dev/v2/scrape')
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ url: 'https://example.com/' })
    expect(result.message).not.toContain('Example Domain')
  })

  it('高德 Web 服务只查询固定地点并只返回候选数量', async () => {
    responseBody = { status: '1', pois: [{ name: '故宫博物院', location: '116.397,39.918' }] }

    const result = await testBuiltinConnector('amap', 'fake-amap-secret')

    expect(result).toEqual({ ok: true, message: '高德 Web 服务连接成功；固定地点查询返回 1 个候选。' })
    expect(calls).toHaveLength(1)
    const url = new URL(calls[0].url)
    expect(url.hostname).toBe('restapi.amap.com')
    expect(url.searchParams.get('city')).toBe('北京')
    expect(url.searchParams.get('keywords')).toBe('故宫博物院')
    expect(url.searchParams.get('key')).toBe('fake-amap-secret')
    expect(result.message).not.toContain('fake-amap-secret')
  })

  it('失败只显示 HTTP 状态，不回显凭证或响应正文', async () => {
    responseStatus = 401
    responseBody = { error: 'fake-exa-secret rejected' }

    const result = await testBuiltinConnector('exa', 'fake-exa-secret')

    expect(result).toEqual({ ok: false, message: 'Exa连接失败：外部服务返回 HTTP 401。' })
    expect(result.message).not.toContain('fake-exa-secret')
    expect(result.message).not.toContain('rejected')
  })

  it.each([
    ['exa', 402, 'Exa连接失败：服务额度或账单不可用，请检查服务商账户。'],
    ['firecrawl', 402, 'Firecrawl连接失败：服务额度或账单不可用，请检查服务商账户。'],
    ['tavily', 432, 'Tavily连接失败：服务商报告套餐或使用上限，请检查账户方案。'],
    ['tavily', 433, 'Tavily连接失败：服务商报告套餐或使用上限，请检查账户方案。']
  ] as const)('%s 的 HTTP %i 显示可执行的服务状态', async (provider, status, message) => {
    responseStatus = status
    responseBody = { error: 'provider response must not be displayed' }

    const result = await testBuiltinConnector(provider, `fake-${provider}-secret`)

    expect(result).toEqual({ ok: false, message })
    expect(result.message).not.toContain('provider response')
    expect(result.message).not.toContain(`fake-${provider}-secret`)
  })
})
