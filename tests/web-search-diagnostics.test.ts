/** 验证网页搜索逐渠道诊断只保留脱敏状态、数量和耗时。 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { logSystemEventMock } = vi.hoisted(() => ({ logSystemEventMock: vi.fn() }))

vi.mock('../src/main/system-logger.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/system-logger.js')>(),
  logSystemEvent: logSystemEventMock
}))

import { configureExternalFetcher } from '../src/main/connectors/http.js'
import { webSearchTool } from '../src/main/connectors/web-search.js'

afterEach(() => {
  configureExternalFetcher()
  logSystemEventMock.mockClear()
})

describe('网页搜索渠道诊断', () => {
  it('有结果时记录渠道、结果数和耗时，不记录查询与网页内容', async () => {
    configureExternalFetcher(async () => new Response(JSON.stringify({ results: [{
      title: 'private page title',
      url: 'https://private.example/trip',
      highlights: ['private page excerpt']
    }] }), { headers: { 'Content-Type': 'application/json' } }))

    await webSearchTool.execute({ query: 'private travel query' }, {
      amapKey: null,
      exaKey: 'private-exa-test-key',
      traceId: '00000000-0000-4000-8000-000000000001'
    })

    expect(logSystemEventMock).toHaveBeenCalledWith('info', 'search.provider.request_completed', expect.objectContaining({
      traceId: '00000000-0000-4000-8000-000000000001',
      searchProvider: 'Exa',
      searchOutcome: 'results',
      sourceCount: 1,
      durationMs: expect.any(Number)
    }))
    const diagnostics = JSON.stringify(logSystemEventMock.mock.calls)
    for (const privateValue of ['private travel query', 'private page title', 'private.example', 'private page excerpt', 'private-exa-test-key']) {
      expect(diagnostics).not.toContain(privateValue)
    }
  })

  it('分别标记失败与空结果，错误原文不进入日志', async () => {
    configureExternalFetcher(async (input) => {
      const url = String(input)
      if (url === 'https://api.exa.ai/search') return new Response('', { status: 503 })
      if (url === 'https://api.tavily.com/search') {
        return new Response(JSON.stringify({ results: [] }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('<html><body>no matching results</body></html>', { headers: { 'Content-Type': 'text/html' } })
    })

    await webSearchTool.execute({ query: 'private travel query' }, {
      amapKey: null,
      exaKey: 'private-exa-test-key',
      tavilyKey: 'private-tavily-test-key',
      traceId: '00000000-0000-4000-8000-000000000002'
    })

    const outcomes = logSystemEventMock.mock.calls
      .filter(([, event]) => event === 'search.provider.request_completed')
      .map(([level, , fields]) => ({ level, ...(fields as Record<string, unknown>) }))
    expect(outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ searchProvider: 'Exa', searchOutcome: 'failed', reason: 'server_error', level: 'warn' }),
      expect.objectContaining({ searchProvider: 'Tavily', searchOutcome: 'empty', sourceCount: 0, level: 'info' }),
      expect.objectContaining({ searchProvider: 'DuckDuckGo', searchOutcome: 'empty', sourceCount: 0, level: 'info' })
    ]))
    expect(JSON.stringify(logSystemEventMock.mock.calls)).not.toContain('private travel query')
    expect(JSON.stringify(logSystemEventMock.mock.calls)).not.toContain('private-exa-test-key')
    expect(JSON.stringify(logSystemEventMock.mock.calls)).not.toContain('private-tavily-test-key')
  })
})
