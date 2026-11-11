/** 验证搜索回退、Firecrawl 来源限制和凭证不外泄。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureExternalFetcher } from '../src/main/connectors/http.js'
import { areSearchProvidersExhausted, createSearchProviderCircuitBreaker, createSource } from '../src/main/connectors/types.js'
import { webPageReadTool } from '../src/main/connectors/web-page.js'
import { executeTool, getToolDefinitions } from '../src/main/tools.js'

afterEach(() => {
  configureExternalFetcher()
  vi.unstubAllGlobals()
})

describe('网页搜索服务', () => {
  it('只将本轮已配置的服务纳入耗尽判断', () => {
    const breaker = createSearchProviderCircuitBreaker({ exaKey: 'exa', tavilyKey: null, firecrawlKey: null })

    expect([...breaker.disabled].sort()).toEqual(['Firecrawl', 'Tavily'])
    expect(areSearchProvidersExhausted(breaker)).toBe(false)

    breaker.disabled.add('Exa')
    expect(areSearchProvidersExhausted(breaker)).toBe(false)

    breaker.disabled.add('DuckDuckGo')
    expect(areSearchProvidersExhausted(breaker)).toBe(true)
  })

  it('连续两次无法解析 DuckDuckGo 结果后停止本轮重复搜索', async () => {
    let requestCount = 0
    configureExternalFetcher(async () => {
      requestCount += 1
      return new Response('<html><body>没有可解析的公开搜索结果</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      })
    })
    const breaker = createSearchProviderCircuitBreaker({})
    const context = {
      amapKey: null,
      traceId: '00000000-0000-4000-8000-000000000001',
      searchProviderCircuitBreaker: breaker
    }

    const first = await executeTool('search_web', JSON.stringify({ query: '北京故宫开放时间' }), context)
    const second = await executeTool('search_web', JSON.stringify({ query: '北京颐和园开放时间' }), context)
    const third = await executeTool('search_web', JSON.stringify({ query: '北京天坛开放时间' }), context)

    expect(first.sources.some((source) => source.provider === 'DuckDuckGo' && source.status === 'partial')).toBe(true)
    expect(second.sources.some((source) => source.provider === 'DuckDuckGo' && source.status === 'partial')).toBe(true)
    expect(third.output).toContain('工具当前不可用')
    expect(requestCount).toBe(2)
    expect(areSearchProvidersExhausted(breaker)).toBe(true)
  })

  it('按凭证状态向模型暴露网页搜索与正文读取工具', () => {
    const connectors = { webSearch: true, weather: false, places: false, routes: false }
    const withExa = getToolDefinitions({ amapKey: null, exaKey: 'configured', connectors })
      .map((tool) => tool.function.name)
    const withFirecrawl = getToolDefinitions({ amapKey: null, exaKey: 'configured', firecrawlKey: 'configured', connectors })
      .map((tool) => tool.function.name)

    expect(withExa).toContain('search_web')
    expect(withExa).toContain('read_webpage')
    expect(withFirecrawl).toContain('read_webpage')
  })

  it('本轮所有搜索渠道熔断后不再向模型提供网页搜索工具', () => {
    const tools = getToolDefinitions({
      amapKey: null,
      exaKey: 'configured',
      tavilyKey: 'configured',
      firecrawlKey: 'configured',
      connectors: { webSearch: true, weather: false, places: false, routes: false },
      searchProviderCircuitBreaker: {
        disabled: new Set<'Exa' | 'Tavily' | 'Firecrawl' | 'DuckDuckGo'>(['Exa', 'Tavily', 'Firecrawl', 'DuckDuckGo'])
      }
    }).map((tool) => tool.function.name)

    expect(tools).not.toContain('search_web')
  })

  it('拒绝把 DuckDuckGo 搜索结果页当作原始网页正文读取', async () => {
    const url = 'https://html.duckduckgo.com/html/?q=%E6%95%85%E5%AE%AB'
    await expect(webPageReadTool.execute({ url }, {
      amapKey: null,
      firecrawlKey: 'test-firecrawl-key',
      connectors: { webSearch: true, weather: false, places: false, routes: false },
      availableSources: [createSource('搜索结果', url, 'Tripwise 研究浏览器', 'web', '搜索摘要')]
    })).rejects.toThrow('搜索结果页只用于发现原始链接')
  })

  it('使用 Exa 搜索并将凭证只放入主进程请求头', async () => {
    let requestUrl = ''
    let requestInit: RequestInit | undefined
    configureExternalFetcher(async (input, init) => {
      requestUrl = String(input)
      requestInit = init
      return new Response(JSON.stringify({ results: [{
        title: '京都官方红叶信息',
        url: 'https://visit.example/season/autumn',
        highlights: ['预计 11 月中旬进入观赏期。'],
        author: '官方观光机构',
        publishedDate: '2026-10-01'
      }] }), { headers: { 'Content-Type': 'application/json' } })
    })

    const result = await executeTool('search_web', JSON.stringify({ query: '京都红叶观赏期' }), {
      amapKey: null,
      exaKey: 'private-exa-test-key'
    })

    expect(requestUrl).toBe('https://api.exa.ai/search')
    expect(new Headers(requestInit?.headers).get('x-api-key')).toBe('private-exa-test-key')
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({ query: '京都红叶观赏期', numResults: 4 })
    expect(result.output).toContain('预计 11 月中旬')
    expect(result.sources[0]).toMatchObject({ provider: 'Exa 搜索结果', status: 'success', declaredAuthor: '官方观光机构' })
    expect(JSON.stringify(result)).not.toContain('private-exa-test-key')
  })

  it('搜索摘要以结构化 warning 标记为线索，但不升级为阻断错误', async () => {
    configureExternalFetcher(async () => new Response(JSON.stringify({ results: [{
      title: '北京故宫开放信息',
      url: 'https://museum.example/visit',
      highlights: ['官方参观须知摘要']
    }] }), { headers: { 'Content-Type': 'application/json' } }))

    const result = await executeTool('search_web', JSON.stringify({ query: '故宫开放时间' }), {
      amapKey: null,
      exaKey: 'private-exa-test-key'
    })

    expect(result.sources[0]).toMatchObject({ status: 'success', contentLevel: 'snippet' })
    expect(result.feedback).toEqual([expect.objectContaining({
      severity: 'warning',
      code: 'search_snippet_not_evidence'
    })])
    expect(result.feedback?.some((item) => item.severity === 'error')).toBe(false)
  })

  it('近期开放和预约查询合并 Tavily 与 Exa 并按链接去重', async () => {
    const calls: string[] = []
    configureExternalFetcher(async (input, init) => {
      const url = String(input)
      calls.push(url)
      const isTavily = url === 'https://api.tavily.com/search'
      expect(isTavily
        ? new Headers(init?.headers).get('Authorization')
        : new Headers(init?.headers).get('x-api-key'))
        .toBe(isTavily ? 'Bearer private-tavily-test-key' : 'private-exa-test-key')
      return new Response(JSON.stringify({ results: [{
        title: isTavily ? '故宫开放公告' : '故宫预约须知',
        url: isTavily ? 'https://palace.example/notice' : 'https://palace.example/notice?utm_source=exa',
        content: isTavily ? '请提前预约。' : undefined,
        highlights: isTavily ? undefined : ['按预约时段入馆。'],
        published_date: 'Mon, 12 Oct 2026 08:00:00 GMT'
      }] }), { headers: { 'Content-Type': 'application/json' } })
    })

    const result = await executeTool('search_web', JSON.stringify({ query: '故宫最新开放时间和预约' }), {
      amapKey: null,
      exaKey: 'private-exa-test-key',
      tavilyKey: 'private-tavily-test-key'
    })

    expect(calls.sort()).toEqual(['https://api.exa.ai/search', 'https://api.tavily.com/search'])
    expect(result.sources.filter((source) => source.status === 'success')).toHaveLength(1)
    expect(result.sources[0]).toMatchObject({ provider: 'Tavily 搜索结果', status: 'success' })
    expect(result.output).toContain('渠道：Tavily')
  })

  it.each([432, 433])('搜索服务返回 HTTP %i 套餐限制后，本轮停用该渠道并继续使用 Exa', async (status) => {
    let tavilyCalls = 0
    let exaCalls = 0
    configureExternalFetcher(async (input) => {
      if (String(input) === 'https://api.tavily.com/search') {
        tavilyCalls += 1
        return new Response('', { status })
      }
      exaCalls += 1
      return new Response(JSON.stringify({ results: [{
        title: '故宫官方参观说明',
        url: `https://palace.example/visit-${exaCalls}`,
        highlights: ['开放与预约规则以官方通知为准。']
      }] }), { headers: { 'Content-Type': 'application/json' } })
    })

    const context = {
      amapKey: null,
      exaKey: 'private-exa-test-key',
      tavilyKey: 'private-tavily-test-key',
      searchProviderCircuitBreaker: { disabled: new Set<'Exa' | 'Tavily' | 'Firecrawl' | 'DuckDuckGo'>() }
    }
    const firstResult = await executeTool('search_web', JSON.stringify({ query: '故宫最新开放时间和预约' }), context)
    expect(tavilyCalls).toBe(1)
    expect(context.searchProviderCircuitBreaker.disabled).toContain('Tavily')
    const secondResult = await executeTool('search_web', JSON.stringify({ query: '北京颐和园最新开放时间和预约' }), context)

    expect(tavilyCalls).toBe(1)
    expect(exaCalls).toBe(2)
    expect(firstResult.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'Tavily', status: 'error', summary: `外部服务返回 HTTP ${status}。` }),
      expect.objectContaining({ provider: 'Exa 搜索结果', status: 'success' })
    ]))
    expect(secondResult.sources.every((source) => source.provider !== 'Tavily')).toBe(true)
    expect(JSON.stringify([firstResult, secondResult])).not.toContain('private-tavily-test-key')
  })

  it('时效查询保留两家搜索服务提供的不同页面并标注渠道', async () => {
    configureExternalFetcher(async (input) => {
      const isTavily = String(input) === 'https://api.tavily.com/search'
      return new Response(JSON.stringify({ results: [{
        title: isTavily ? '官方预约通知' : '场馆参观指南',
        url: isTavily ? 'https://palace.example/booking' : 'https://museum.example/visit',
        content: isTavily ? '预约后入馆。' : undefined,
        highlights: isTavily ? undefined : ['开放时间以公告为准。']
      }] }), { headers: { 'Content-Type': 'application/json' } })
    })

    const result = await executeTool('search_web', JSON.stringify({ query: '故宫最新开放时间和预约' }), {
      amapKey: null,
      exaKey: 'private-exa-test-key',
      tavilyKey: 'private-tavily-test-key'
    })

    expect(result.sources.filter((source) => source.status === 'success').map((source) => source.provider))
      .toEqual(['Tavily 搜索结果', 'Exa 搜索结果'])
    expect(result.output).toContain('渠道：Tavily、Exa')
  })

  it('Exa 和 Tavily 失败后使用 Firecrawl 搜索并保留可读取的来源链接', async () => {
    const calls: string[] = []
    let firecrawlRequestBody: Record<string, unknown> | undefined
    configureExternalFetcher(async (input, init) => {
      const url = String(input)
      calls.push(url)
      if (url === 'https://api.tavily.com/search') return new Response('', { status: 432 })
      if (url === 'https://api.exa.ai/search') return new Response('', { status: 402 })
      expect(url).toBe('https://api.firecrawl.dev/v2/search')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-firecrawl-test-key')
      firecrawlRequestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        success: true,
        data: { web: [{
          title: '故宫参观须知',
          url: 'https://www.dpm.org.cn/Visit.html',
          description: '故宫参观时间和预约信息以官方公告为准。'
        }] }
      }), { headers: { 'Content-Type': 'application/json' } })
    })

    const result = await executeTool('search_web', JSON.stringify({ query: '故宫最新开放时间和预约' }), {
      amapKey: null,
      exaKey: 'private-exa-test-key',
      tavilyKey: 'private-tavily-test-key',
      firecrawlKey: 'private-firecrawl-test-key'
    })

    expect(calls.sort()).toEqual([
      'https://api.exa.ai/search',
      'https://api.firecrawl.dev/v2/search',
      'https://api.tavily.com/search'
    ])
    expect(firecrawlRequestBody).toMatchObject({
      query: '故宫最新开放时间和预约',
      limit: 4,
      sources: [{ type: 'web' }]
    })
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'Exa', status: 'error' }),
      expect.objectContaining({ provider: 'Tavily', status: 'error' }),
      expect.objectContaining({ provider: 'Firecrawl 搜索结果', status: 'success', url: 'https://www.dpm.org.cn/Visit.html' })
    ]))
    expect(result.output).toContain('故宫参观时间和预约信息')
    expect(JSON.stringify(result)).not.toContain('private-firecrawl-test-key')
  })

  it('本轮搜索渠道失败后熔断，后续地点查询不重复等待同一服务', async () => {
    const calls: string[] = []
    configureExternalFetcher(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url === 'https://api.tavily.com/search') return new Response('', { status: 432 })
      if (url === 'https://api.exa.ai/search' || url === 'https://api.firecrawl.dev/v2/search') {
        return new Response('', { status: 402 })
      }
      throw new Error('network unavailable')
    })
    const context = {
      amapKey: null,
      exaKey: 'private-exa-test-key',
      tavilyKey: 'private-tavily-test-key',
      firecrawlKey: 'private-firecrawl-test-key',
      searchProviderCircuitBreaker: { disabled: new Set<'Exa' | 'Tavily' | 'Firecrawl' | 'DuckDuckGo'>() }
    }

    const first = await executeTool('search_web', JSON.stringify({ query: '故宫最新开放时间和预约' }), context)
    const second = await executeTool('search_web', JSON.stringify({ query: '颐和园最新开放时间和预约' }), context)

    expect(calls.sort()).toEqual([
      'https://api.exa.ai/search',
      'https://api.firecrawl.dev/v2/search',
      'https://api.tavily.com/search',
      'https://html.duckduckgo.com/html/?q=%E6%95%85%E5%AE%AB%E6%9C%80%E6%96%B0%E5%BC%80%E6%94%BE%E6%97%B6%E9%97%B4%E5%92%8C%E9%A2%84%E7%BA%A6'
    ])
    expect([...context.searchProviderCircuitBreaker.disabled].sort()).toEqual(['DuckDuckGo', 'Exa', 'Firecrawl', 'Tavily'])
    expect(first.output).toContain('暂不可用')
    expect(second.output).toContain('工具当前不可用')
  })

  it('并发检索遇到额度故障时每个付费服务只探测一次', async () => {
    const requests: string[] = []
    configureExternalFetcher(async (input) => {
      const url = new URL(String(input))
      requests.push(`${url.hostname}${url.pathname}`)
      if (url.hostname === 'api.exa.ai') return new Response('', { status: 402 })
      if (url.hostname === 'api.tavily.com') return new Response('', { status: 432 })
      if (url.hostname === 'api.firecrawl.dev') return new Response('', { status: 402 })
      return new Response(
        '<a class="result__a" href="https://example.org/visit">公开参观信息</a><div class="result__snippet">行前请核对开放时间。</div>',
        { headers: { 'Content-Type': 'text/html' } }
      )
    })
    const context = {
      amapKey: null,
      exaKey: 'private-exa-test-key',
      tavilyKey: 'private-tavily-test-key',
      firecrawlKey: 'private-firecrawl-test-key',
      searchProviderCircuitBreaker: createSearchProviderCircuitBreaker({
        exaKey: 'configured', tavilyKey: 'configured', firecrawlKey: 'configured'
      })
    }

    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => executeTool(
      'search_web', JSON.stringify({ query: `北京景点${index}最新开放时间和预约` }), context
    )))

    expect(requests.filter((request) => request === 'api.exa.ai/search')).toHaveLength(1)
    expect(requests.filter((request) => request === 'api.tavily.com/search')).toHaveLength(1)
    expect(requests.filter((request) => request === 'api.firecrawl.dev/v2/search')).toHaveLength(1)
    expect(requests.filter((request) => request === 'html.duckduckgo.com/html/')).toHaveLength(4)
    expect(results.every((result) => result.sources.some((source) =>
      source.provider === 'DuckDuckGo 搜索结果' && source.status === 'success'
    ))).toBe(true)
    expect([...context.searchProviderCircuitBreaker.disabled]).toEqual(expect.arrayContaining(['Exa', 'Tavily', 'Firecrawl']))
    expect(JSON.stringify(results)).not.toContain('private-')
  })

  it('渠道正常时并发查询仍逐条返回各自的搜索结果', async () => {
    const queries: string[] = []
    configureExternalFetcher(async (input, init) => {
      const url = String(input)
      if (url !== 'https://api.exa.ai/search') throw new Error('unexpected_search_provider')
      queries.push(String(JSON.parse(String(init?.body)).query))
      return new Response(JSON.stringify({ results: [{
        title: `公开攻略 ${queries.length}`,
        url: `https://example.org/travel/${queries.length}`,
        highlights: ['供游客参考的公开信息。']
      }] }), { headers: { 'Content-Type': 'application/json' } })
    })
    const context = { amapKey: null, exaKey: 'private-exa-test-key', searchProviderCircuitBreaker: createSearchProviderCircuitBreaker({ exaKey: 'configured' }) }

    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => executeTool(
      'search_web', JSON.stringify({ query: `京都旅行攻略${index}` }), context
    )))

    expect(queries).toHaveLength(4)
    expect(new Set(queries)).toHaveProperty('size', 4)
    expect(results.every((result) => result.sources.some((source) =>
      source.provider === 'Exa 搜索结果' && source.status === 'success'
    ))).toBe(true)
    expect(context.searchProviderCircuitBreaker.disabled).toEqual(new Set(['Tavily', 'Firecrawl']))
  })

  it('首选搜索服务失败时回退到下一家并保留可重试错误来源', async () => {
    configureExternalFetcher(async (input) => {
      if (String(input) === 'https://api.exa.ai/search') return new Response('', { status: 503 })
      return new Response(JSON.stringify({ results: [{
        title: '京都交通攻略', url: 'https://travel.example/kyoto', content: '交通资讯摘要。'
      }] }), { headers: { 'Content-Type': 'application/json' } })
    })

    const result = await executeTool('search_web', JSON.stringify({ query: '京都交通攻略' }), {
      amapKey: null,
      exaKey: 'private-exa-test-key',
      tavilyKey: 'private-tavily-test-key'
    })

    expect(result.output).toContain('已保留 Tavily 的有效结果')
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'Exa', status: 'error', retry: { toolName: 'search_web', arguments: { query: '京都交通攻略' } } }),
      expect.objectContaining({ provider: 'Tavily 搜索结果', status: 'success' })
    ]))
    expect(JSON.stringify(result)).not.toContain('private-exa-test-key')
    expect(JSON.stringify(result)).not.toContain('private-tavily-test-key')
  })

  it('所有搜索渠道失败时分别记录来源状态并保留安全重试信息', async () => {
    configureExternalFetcher(async () => new Response('', { status: 503 }))

    const result = await executeTool('search_web', JSON.stringify({ query: '京都旅行攻略' }), {
      amapKey: null,
      exaKey: 'private-exa-test-key',
      tavilyKey: 'private-tavily-test-key'
    })

    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'Exa', status: 'error' }),
      expect.objectContaining({ provider: 'Tavily', status: 'error' }),
      expect.objectContaining({ provider: 'DuckDuckGo', status: 'error' })
    ]))
    expect(result.sources.every((source) =>
      source.retry && 'toolName' in source.retry && source.retry.toolName === 'search_web' &&
      source.retry.arguments.query === '京都旅行攻略'
    )).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private-exa-test-key')
    expect(JSON.stringify(result)).not.toContain('private-tavily-test-key')
  })
})

describe('Firecrawl 单页正文读取', () => {
  it('只读取本旅行已有公开网页来源并保留来源链接', async () => {
    const source = createSource('景点开放信息', 'https://museum.example/visit', 'Exa 搜索结果', 'web', '官方页面摘要。')
    let requestBody: Record<string, unknown> = {}
    let authorization = ''
    configureExternalFetcher(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      authorization = new Headers(init?.headers).get('Authorization') ?? ''
      return new Response(JSON.stringify({
        success: true,
        data: { markdown: '# 开放时间\n今日开放至 17:00。', metadata: { title: '博物馆参观信息' } }
      }), { headers: { 'Content-Type': 'application/json' } })
    })

    const result = await executeTool('read_webpage', JSON.stringify({ url: source.url }), {
      amapKey: null,
      firecrawlKey: 'private-firecrawl-test-key',
      availableSources: [source]
    })

    expect(requestBody).toEqual({ url: source.url, formats: ['markdown'], onlyMainContent: true })
    expect(authorization).toBe('Bearer private-firecrawl-test-key')
    expect(result.output).toContain('今日开放至 17:00')
    expect(result.sources[0]).toMatchObject({ title: '博物馆参观信息', url: source.url, provider: 'Firecrawl 网页正文' })
    expect(JSON.stringify(result)).not.toContain('private-firecrawl-test-key')
  })

  it('长网页优先保留开放、预约和交通原文，并限制送入模型的摘录长度', async () => {
    const source = createSource('景点参观信息', 'https://museum.example/visit', 'Exa 搜索结果', 'web', '官方页面摘要。')
    const irrelevant = '景区历史宣传信息，不包含到访规则。'.repeat(180)
    const facts = [
      '# 北京市博物馆',
      '## 开放与参观',
      '开放时间：旺季 09:00–17:00；周一闭馆。',
      '预约须知：需实名预约，提前三天开放预约。',
      '交通方式：乘坐地铁 2 号线至东门站，从东门进入。'
    ].join('\n\n')
    configureExternalFetcher(async () => new Response(JSON.stringify({
      success: true,
      data: { markdown: `${irrelevant}\n\n${facts}`, metadata: { title: '北京市博物馆参观信息' } }
    }), { headers: { 'Content-Type': 'application/json' } }))

    const result = await executeTool('read_webpage', JSON.stringify({ url: source.url }), {
      amapKey: null,
      firecrawlKey: 'private-firecrawl-test-key',
      availableSources: [source]
    })

    expect(result.output).toContain('开放时间：旺季 09:00–17:00；周一闭馆。')
    expect(result.output).toContain('需实名预约，提前三天开放预约')
    expect(result.output).toContain('乘坐地铁 2 号线至东门站')
    expect(result.output).toContain('打开来源原文核对')
    expect(result.output).not.toContain('景区历史宣传信息')
    expect(result.sources[0]?.summary.length).toBeLessThanOrEqual(800)
    expect(result.sources[0]?.url).toBe(source.url)
  })

  it.each([
    'https://127.0.0.1/private',
    'http://127.0.0.1.nip.io/private',
    'https://192.168.1.1.sslip.io/status',
    'http://printer.localtest.me/',
    'https://example.com/page?access_token=secret',
    'https://www.xiaohongshu.com/explore/0123456789abcdef01234567'
  ])('拒绝非公开、带凭证或小红书来源 %s', async (url) => {
    const source = createSource('用户来源', url, '用户导入', 'user', '用户导入的网页。')
    const fetcher = vi.fn(async () => new Response('{}'))
    configureExternalFetcher(fetcher)

    await expect(webPageReadTool.execute({ url }, {
      amapKey: null,
      firecrawlKey: 'private-firecrawl-test-key',
      availableSources: [source]
    })).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('拒绝读取未收录在本旅行来源中的任意网址', async () => {
    const fetcher = vi.fn(async () => new Response('{}'))
    configureExternalFetcher(fetcher)

    await expect(webPageReadTool.execute({ url: 'https://unlisted.example/page' }, {
      amapKey: null,
      firecrawlKey: 'private-firecrawl-test-key',
      availableSources: []
    })).rejects.toThrow(/本旅行已搜索或由用户导入/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('Firecrawl 请求失败时保留目标网页和不含密钥的重试参数', async () => {
    const source = createSource('景点开放信息', 'https://museum.example/visit', 'Exa 搜索结果', 'web', '官方页面摘要。')
    configureExternalFetcher(async () => new Response('', { status: 503 }))

    const result = await executeTool('read_webpage', JSON.stringify({ url: source.url }), {
      amapKey: null,
      firecrawlKey: 'private-firecrawl-test-key',
      availableSources: [source]
    })

    expect(result.sources[0]).toMatchObject({
      url: source.url,
      provider: 'Firecrawl',
      status: 'error',
      retry: { toolName: 'read_webpage', arguments: { url: source.url } }
    })
    expect(JSON.stringify(result)).not.toContain('private-firecrawl-test-key')
  })

  it('Firecrawl 配额耗尽时使用 Exa 读取正文，并让本轮后续页面直达 Exa', async () => {
    const source = createSource('景点开放信息', 'https://museum.example/visit', 'Exa 搜索结果', 'web', '官方页面摘要。')
    const calls: string[] = []
    configureExternalFetcher(async (input) => {
      const url = String(input)
      calls.push(url)
      if (url === 'https://api.firecrawl.dev/v2/scrape') return new Response('', { status: 402 })
      return new Response(JSON.stringify({
        results: [{ url: source.url, title: '博物馆开放须知', text: '开放时间：9:00–17:00；预约：提前实名预约。' }],
        statuses: [{ id: source.url, status: 'success' }]
      }), { headers: { 'Content-Type': 'application/json' } })
    })
    const baseContext = {
      amapKey: null,
      exaKey: 'private-exa-test-key',
      firecrawlKey: 'private-firecrawl-test-key',
      availableSources: [source]
    }

    const first = await webPageReadTool.execute({ url: source.url }, baseContext)
    const next = await webPageReadTool.execute({ url: source.url }, { ...baseContext, firecrawlDisabled: true })

    expect(calls).toEqual([
      'https://api.firecrawl.dev/v2/scrape', 'https://api.exa.ai/contents', 'https://api.exa.ai/contents'
    ])
    expect(first.output).toContain('开放时间：9:00–17:00；预约：提前实名预约。')
    expect(first.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'Firecrawl', status: 'error' }),
      expect.objectContaining({ provider: 'Exa 网页正文', status: 'success', contentLevel: 'page' })
    ]))
    expect(next.sources[0]).toMatchObject({ provider: 'Exa 网页正文', status: 'success', contentLevel: 'page' })
    expect(JSON.stringify([first, next])).not.toContain('private-exa-test-key')
    expect(JSON.stringify([first, next])).not.toContain('private-firecrawl-test-key')
  })

  it('未配置 Firecrawl 时可直接使用 Exa 正文读取', async () => {
    const source = createSource('景点开放信息', 'https://museum.example/visit', 'Exa 搜索结果', 'web', '官方页面摘要。')
    let requestUrl = ''
    configureExternalFetcher(async (input) => {
      requestUrl = String(input)
      return new Response(JSON.stringify({
        results: [{ url: source.url, title: '参观须知', text: '参观须知：每周一闭馆。' }],
        statuses: [{ id: source.url, status: 'success' }]
      }), { headers: { 'Content-Type': 'application/json' } })
    })

    const result = await webPageReadTool.execute({ url: source.url }, {
      amapKey: null, exaKey: 'private-exa-test-key', availableSources: [source]
    })

    expect(requestUrl).toBe('https://api.exa.ai/contents')
    expect(result.output).toContain('每周一闭馆')
    expect(result.sources[0]).toMatchObject({ provider: 'Exa 网页正文', status: 'success', contentLevel: 'page' })
  })

  it('额度耗尽后本轮停用正文服务，避免重复请求并改用浏览器', async () => {
    const source = createSource('景点参观信息', 'https://museum.example/visit', '用户导入', 'user', '原始页面。')
    const calls: string[] = []
    configureExternalFetcher(async (input) => {
      calls.push(String(input))
      return new Response('', { status: 402 })
    })
    const context = {
      amapKey: null,
      firecrawlKey: 'private-firecrawl-test-key',
      exaKey: 'private-exa-test-key',
      availableSources: [source],
      searchProviderCircuitBreaker: { disabled: new Set<'Exa' | 'Tavily' | 'Firecrawl' | 'DuckDuckGo'>() }
    }

    const result = await webPageReadTool.execute({ url: source.url }, context)

    expect(calls).toEqual(['https://api.firecrawl.dev/v2/scrape', 'https://api.exa.ai/contents'])
    expect(context.searchProviderCircuitBreaker.disabled).toEqual(new Set(['Firecrawl', 'Exa']))
    expect(webPageReadTool.isAvailable?.(context)).toBe(false)
    await expect(webPageReadTool.execute({ url: source.url }, context)).rejects.toThrow(/研究浏览器/)
    expect(calls).toHaveLength(2)
    expect(JSON.stringify(result)).not.toContain(context.firecrawlKey)
    expect(JSON.stringify(result)).not.toContain(context.exaKey)
  })
})
