/** 验证外部 HTTP 正文按字节限长，避免无长度响应无限占用内存。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureExternalFetcher, fetchText, postJson } from '../src/main/connectors/http.js'

afterEach(() => {
  configureExternalFetcher()
  vi.unstubAllGlobals()
})

describe('外部 HTTP 响应读取', () => {
  it('可解码跨分块的 UTF-8 正文', async () => {
    const encoded = new TextEncoder().encode('北京天气')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 4))
        controller.enqueue(encoded.slice(4))
        controller.close()
      }
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))

    await expect(fetchText('https://weather.example/forecast')).resolves.toBe('北京天气')
  })

  it('使用 Electron 注入的外部网络传输层', async () => {
    const fetcher = vi.fn(async () => new Response('ok'))
    configureExternalFetcher(fetcher)

    await expect(fetchText('https://weather.example/forecast')).resolves.toBe('ok')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('连接失败保留白名单传输码，但不传播底层错误文本', async () => {
    const privateDetail = 'private-network-endpoint-and-credential'
    configureExternalFetcher(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error(privateDetail), { code: 'UND_ERR_SOCKET' })
      })
    })

    const error = await fetchText('https://weather.example/forecast').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('无法连接外部服务或请求超时。')
    expect((error as Error).message).not.toContain(privateDetail)
    expect((error as Error & { code?: string }).code).toBe('UND_ERR_SOCKET')
  })

  it('发送有界 JSON POST 并解析 JSON 响应', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('error')
      expect(new Headers(init?.headers).get('x-api-key')).toBe('private-test-key')
      expect(JSON.parse(String(init?.body))).toEqual({ query: '京都红叶' })
      return new Response(JSON.stringify({ results: [] }), { headers: { 'Content-Type': 'application/json' } })
    })
    configureExternalFetcher(fetcher)

    await expect(postJson('https://search.example/api', { query: '京都红叶' }, { 'x-api-key': 'private-test-key' }))
      .resolves.toEqual({ results: [] })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('在无 Content-Length 的超限响应中途取消读取', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2_000_001))
      },
      cancel
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))

    await expect(fetchText('https://weather.example/forecast')).rejects.toThrow('外部服务返回内容过大。')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('通过 Content-Length 提前拒绝并取消响应', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
      },
      cancel
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'Content-Length': '2000001' } })))

    await expect(fetchText('https://weather.example/forecast')).rejects.toThrow('外部服务返回内容过大。')
    expect(cancel).toHaveBeenCalledOnce()
  })
})
