/** 验证网页出口在 DNS 校验、代理路由和实际 TCP 连接之间固定同一公网 IP。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from 'node:http'
import { connect as connectTcp, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net'
import {
  parseResearchProxyRoutes,
  ResearchEgressProxy,
  resolvePublicResearchAddresses
} from '../src/main/research-egress-proxy.js'

const egressProxies: ResearchEgressProxy[] = []
const servers: Array<HttpServer | NetServer> = []
const sockets: Socket[] = []

afterEach(async () => {
  for (const proxy of egressProxies.splice(0)) proxy.close()
  for (const socket of sockets.splice(0)) socket.destroy()
  await Promise.all(servers.splice(0).map((server) => closeServer(server)))
  vi.useRealTimers()
})

describe('研究网页出站代理路由', () => {
  it('解析 Chromium 的直连、HTTP、HTTPS 与 SOCKS 代理列表', () => {
    expect(parseResearchProxyRoutes('PROXY proxy.example:8080; DIRECT')).toEqual([
      { kind: 'http', host: 'proxy.example', port: 8080 },
      { kind: 'direct' }
    ])
    expect(parseResearchProxyRoutes('HTTPS [::1]:8443; SOCKS5 socks.example:1080; SOCKS legacy:1080')).toEqual([
      { kind: 'https', host: '::1', port: 8443 },
      { kind: 'socks5', host: 'socks.example', port: 1080 },
      { kind: 'socks4', host: 'legacy', port: 1080 }
    ])
  })

  it.each(['', 'PROXY user:pass@proxy.example:8080', 'QUIC proxy.example:443'])('拒绝空白或不支持的代理路由 %s', (route) => {
    expect(() => parseResearchProxyRoutes(route)).toThrow()
  })

  it('以无缓存 DNS A/AAAA 查询合并所有公网地址', async () => {
    const resolveHost = vi.fn(async (_hostname: string, type: 'A' | 'AAAA') =>
      type === 'A' ? ['93.184.216.34'] : ['2606:2800:220:1:248:1893:25c8:1946']
    )
    await expect(resolvePublicResearchAddresses('travel.example', resolveHost)).resolves.toEqual([
      '93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'
    ])
    expect(resolveHost).toHaveBeenNthCalledWith(1, 'travel.example', 'A', { source: 'dns', cacheUsage: 'disallowed' })
    expect(resolveHost).toHaveBeenNthCalledWith(2, 'travel.example', 'AAAA', { source: 'dns', cacheUsage: 'disallowed' })
  })

  it('有内网结果、无可用地址或 DNS 超时都失败关闭', async () => {
    await expect(resolvePublicResearchAddresses('travel.example', async (_hostname, type) =>
      type === 'A' ? ['8.8.8.8'] : ['fd00::1']
    )).rejects.toThrow()
    await expect(resolvePublicResearchAddresses('travel.example', async () => [])).rejects.toThrow()

    vi.useFakeTimers()
    const pending = resolvePublicResearchAddresses('travel.example', async () => new Promise(() => {}))
    const expectation = expect(pending).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(4_000)
    await expectation
  })

  it('直连时用已校验 IP 建连，并保留网页原始 Host 与路径', async () => {
    let received: { host?: string; path?: string } = {}
    const origin = createHttpServer((request, response) => {
      received = { host: request.headers.host, path: request.url }
      response.end('direct')
    })
    const originPort = await listen(origin)
    const proxy = await createProxy('DIRECT')

    const response = await requestThroughProxy(proxy, `http://travel.example.test:${originPort}/route?day=2`)

    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('direct')
    expect(received).toEqual({ host: `travel.example.test:${originPort}`, path: '/route?day=2' })
  })

  it('HTTP 上游代理收到带 IP 的目标 URI 和原始 Host', async () => {
    let received: { host?: string; path?: string } = {}
    const upstream = createHttpServer((request, response) => {
      received = { host: request.headers.host, path: request.url }
      response.end('proxied')
    })
    const upstreamPort = await listen(upstream)
    const proxy = await createProxy(`PROXY 127.0.0.1:${upstreamPort}`)
    const originPort = 8181

    const response = await requestThroughProxy(proxy, `http://travel.example.test:${originPort}/route?day=3`)

    expect(response.statusCode).toBe(200)
    expect(received).toEqual({
      host: `travel.example.test:${originPort}`,
      path: `http://127.0.0.1:${originPort}/route?day=3`
    })
  })

  it('HTTP GET 上游在返回响应头前重置连接时最多重试一次', async () => {
    let requests = 0
    const upstream = createHttpServer((request, response) => {
      requests += 1
      if (requests === 1) {
        request.socket.destroy()
        return
      }
      response.end('recovered')
    })
    const upstreamPort = await listen(upstream)
    const proxy = await createProxy(`PROXY 127.0.0.1:${upstreamPort}`)

    const response = await requestThroughProxy(proxy, 'http://travel.example.test:8181/retry')

    expect(response).toEqual({ statusCode: 200, body: 'recovered' })
    expect(requests).toBe(2)
  })

  it('HTTP POST 上游重置连接时不重放请求', async () => {
    let requests = 0
    const upstream = createHttpServer((request, _response) => {
      requests += 1
      request.socket.destroy()
    })
    const upstreamPort = await listen(upstream)
    const proxy = await createProxy(`PROXY 127.0.0.1:${upstreamPort}`)

    const response = await requestThroughProxy(proxy, 'http://travel.example.test:8181/no-retry', 'POST')

    expect(response.statusCode).toBe(502)
    expect(requests).toBe(1)
  })

  it('HTTPS CONNECT 上游收到 IP 字面量并保持隧道双向传输', async () => {
    let connectTarget = ''
    const target = createNetServer((socket) => socket.write('ready'))
    const targetPort = await listen(target)
    const upstream = createHttpServer()
    upstream.on('connect', (request, client, head) => {
      connectTarget = request.url ?? ''
      const destination = connectTcp({ host: '127.0.0.1', port: targetPort })
      destination.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) destination.write(head)
        client.pipe(destination)
        destination.pipe(client)
      })
    })
    const upstreamPort = await listen(upstream)
    const proxy = await createProxy(`PROXY 127.0.0.1:${upstreamPort}`)

    const tunnel = await openConnectTunnel(proxyPort(proxy), `travel.example.test:${targetPort}`)

    expect(tunnel.statusLine).toMatch(/200 Connection Established/)
    expect(connectTarget).toBe(`127.0.0.1:${targetPort}`)
    expect(tunnel.data).toContain('ready')
    tunnel.socket.destroy()
  })

  it('SOCKS5 上游只收到校验后的 IP 作为 CONNECT 目标', async () => {
    let socksTarget = ''
    const origin = createHttpServer((request, response) => response.end(`host=${request.headers.host};path=${request.url}`))
    const originPort = await listen(origin)
    const socksProxy = createSocks5Proxy((host, port) => {
      socksTarget = `${host}:${port}`
    })
    const socksPort = await listen(socksProxy)
    const proxy = await createProxy(`SOCKS5 127.0.0.1:${socksPort}`)

    const response = await requestThroughProxy(proxy, `http://travel.example.test:${originPort}/socks`)

    expect({ response, socksTarget }).toEqual({
      response: { statusCode: 200, body: `host=travel.example.test:${originPort};path=/socks` },
      socksTarget: `127.0.0.1:${originPort}`
    })
  })

  it('只在显式列出的备用路由中回退', async () => {
    const origin = createHttpServer((_request, response) => response.end('fallback'))
    const originPort = await listen(origin)
    const proxy = await createProxy('PROXY 127.0.0.1:1; DIRECT')

    const response = await requestThroughProxy(proxy, `http://travel.example.test:${originPort}/fallback`)

    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('fallback')
  })

  it('混有内网 DNS 地址时不连接目标，也不查询代理', async () => {
    let connections = 0
    const origin = createHttpServer((_request, response) => {
      connections += 1
      response.end('unsafe')
    })
    const originPort = await listen(origin)
    const resolveProxy = vi.fn(async () => 'DIRECT')
    const proxy = await ResearchEgressProxy.listen({
      resolveHost: async (_hostname, type) => type === 'A' ? ['127.0.0.1'] : ['8.8.8.8'],
      resolveProxy
    })
    egressProxies.push(proxy)

    const response = await requestThroughProxy(proxy, `http://travel.example.test:${originPort}/blocked`)

    expect(response.statusCode).toBe(403)
    expect(connections).toBe(0)
    expect(resolveProxy).not.toHaveBeenCalled()
  })
})

/** 为测试创建只把环回地址视作公网的实际 TCP 代理服务。 */
async function createProxy(proxyInfo: string): Promise<ResearchEgressProxy> {
  const proxy = await ResearchEgressProxy.listen({
    resolveHost: async (_hostname, type) => type === 'A' ? ['127.0.0.1'] : [],
    resolveProxy: async () => proxyInfo,
    isPublicAddress: () => true
  })
  egressProxies.push(proxy)
  return proxy
}

/** 启动本机 HTTP/Net 测试服务器并返回临时端口。 */
async function listen(server: HttpServer | NetServer): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return address.port
}

/** 经回环研究代理发起 HTTP 请求，收集完整状态码和正文。 */
function requestThroughProxy(proxy: ResearchEgressProxy, targetUrl: string, method: 'GET' | 'POST' = 'GET'): Promise<{
  statusCode?: number
  body: string
}> {
  const port = proxyPort(proxy)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method,
      path: targetUrl,
      headers: { host: new URL(targetUrl).host }
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString() }))
    })
    request.once('error', reject)
    request.end()
  })
}

/** 通过 HTTP CONNECT 连接到研究代理，并收集首个隧道数据包。 */
function openConnectTunnel(proxyPortValue: number, targetAuthority: string): Promise<{
  socket: Socket
  statusLine: string
  data: string
}> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: '127.0.0.1', port: proxyPortValue })
    sockets.push(socket)
    let data = Buffer.alloc(0)
    let headerParsed = false
    let statusLine = ''
    const timeout = setTimeout(() => reject(new Error('CONNECT 测试超时。')), 5_000)
    const finish = (): void => {
      clearTimeout(timeout)
      resolve({ socket, statusLine, data: data.toString() })
    }
    socket.once('connect', () => socket.write(`CONNECT ${targetAuthority} HTTP/1.1\r\nHost: ${targetAuthority}\r\n\r\n`))
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk])
      if (!headerParsed) {
        const separator = data.indexOf('\r\n\r\n')
        if (separator < 0) return
        headerParsed = true
        const header = data.subarray(0, separator).toString()
        statusLine = header.split('\r\n')[0]
        data = data.subarray(separator + 4)
      }
      if (!statusLine.includes('200') || data.includes('ready')) finish()
    })
    socket.once('error', reject)
  })
}

/** 建立最小 SOCKS5 测试转发端，记录实际请求的目标 IP 和端口。 */
function createSocks5Proxy(onTarget: (host: string, port: number) => void): NetServer {
  return createNetServer((client) => {
    let state: 'greeting' | 'connect' = 'greeting'
    let pending = Buffer.alloc(0)
    const handleHandshake = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk])
      if (state === 'greeting' && pending.length >= 2 + pending[1]) {
        const length = 2 + pending[1]
        pending = pending.subarray(length)
        state = 'connect'
        client.write(Buffer.from([5, 0]))
      }
      if (state !== 'connect' || pending.length < 4) return

      const addressType = pending[3]
      const addressLength = addressType === 1 ? 4 : addressType === 4 ? 16 : pending.length > 4 ? 1 + pending[4] : Infinity
      const requestLength = 4 + addressLength + 2
      if (!Number.isFinite(requestLength) || pending.length < requestLength) return
      const addressBytes = pending.subarray(4, 4 + addressLength)
      const host = addressType === 1
        ? [...addressBytes].join('.')
        : addressType === 4
          ? addressBytes.toString('hex')
          : addressBytes.subarray(1).toString()
      const port = pending.readUInt16BE(4 + addressLength)
      pending = pending.subarray(requestLength)
      state = 'greeting'
      onTarget(host, port)
      const destination = connectTcp({ host, port })
      destination.once('connect', () => {
        client.removeListener('data', handleHandshake)
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
        client.pipe(destination)
        destination.pipe(client)
      })
      destination.once('error', () => client.destroy())
    }
    client.on('data', handleHandshake)
  })
}

/** 从研究代理配置中读取本机临时端口。 */
function proxyPort(proxy: ResearchEgressProxy): number {
  const match = /127\.0\.0\.1:(\d+)/.exec(proxy.sessionProxyConfig.proxyRules)
  if (!match) throw new Error('研究代理未分配本机端口。')
  return Number(match[1])
}

/** 关闭测试服务器并等待其释放监听端口。 */
function closeServer(server: HttpServer | NetServer): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}
