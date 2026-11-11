/** 将隔离网页的出站请求固定到已校验的公网地址，并沿用系统或用户代理路由。 */
import { Agent, createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP, connect as connectTcp, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as connectTls } from 'node:tls'
import { SocksClient } from 'socks'
import { isPublicResearchAddress, normalizeResearchUrl } from './research-url.js'

type DnsQueryType = 'A' | 'AAAA'
type DnsResolverOptions = { source: 'dns'; cacheUsage: 'disallowed' }
type ResearchDnsResolver = (
  hostname: string,
  queryType: DnsQueryType,
  options: DnsResolverOptions
) => Promise<readonly string[]>
type ResearchProxyResolver = (url: string) => Promise<string>
type ResearchProxyKind = 'direct' | 'http' | 'https' | 'socks4' | 'socks5'

export interface ResearchEgressOptions {
  resolveHost: ResearchDnsResolver
  resolveProxy: ResearchProxyResolver
  isPublicAddress?: (address: string) => boolean
}

export interface ResearchProxyEndpoint {
  host: string
  port: number
}

export type ResearchProxyRoute =
  | { kind: 'direct' }
  | ({ kind: 'http' | 'https' | 'socks4' | 'socks5' } & ResearchProxyEndpoint)

const DNS_TIMEOUT_MS = 4_000
const SOCKET_TIMEOUT_MS = 8_000
const MAX_CONNECT_RESPONSE_BYTES = 64 * 1024
const DNS_OPTIONS: DnsResolverOptions = { source: 'dns', cacheUsage: 'disallowed' }
const LOOPBACK_PROXY = '127.0.0.1'

/** 启动只监听回环地址的临时转发器，供隔离网页会话使用。 */
export class ResearchEgressProxy {
  private readonly server: Server
  private readonly sockets = new Set<Duplex>()
  private addressValue = ''
  private closed = false

  /** 由 listen 完成目标解析与本地监听后创建转发器实例。 */
  private constructor(private readonly options: ResearchEgressOptions) {
    this.server = createServer((request, response) => {
      void this.handleHttpRequest(request, response)
    })
    this.server.maxConnections = 96
    this.server.headersTimeout = 15_000
    this.server.requestTimeout = 30_000
    this.server.keepAliveTimeout = 1_000
    this.server.on('connection', (socket) => this.track(socket))
    this.server.on('connect', (request, socket, head) => {
      this.track(socket)
      void this.handleConnectRequest(request, socket, head)
    })
    this.server.on('upgrade', (_request, socket) => socket.destroy())
    this.server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })
  }

  /** 绑定随机端口，避免长期占用固定本机端口。 */
  static async listen(options: ResearchEgressOptions): Promise<ResearchEgressProxy> {
    const proxy = new ResearchEgressProxy(options)
    await new Promise<void>((resolve, reject) => {
      /** 让监听错误中止代理启动，避免返回不可用端口。 */
      const onError = (error: Error): void => reject(error)
      proxy.server.once('error', onError)
      proxy.server.listen(0, LOOPBACK_PROXY, () => {
        proxy.server.removeListener('error', onError)
        resolve()
      })
    })
    const address = proxy.server.address()
    if (!address || typeof address === 'string') {
      proxy.close()
      throw new Error('无法启动网页出站保护。')
    }
    proxy.addressValue = `${LOOPBACK_PROXY}:${address.port}`
    return proxy
  }

  /** 返回 Chromium 需要使用的回环代理规则，并保留对 localhost 的显式代理。 */
  get sessionProxyConfig(): { mode: 'fixed_servers'; proxyRules: string; proxyBypassRules: '<-loopback>' } {
    return {
      mode: 'fixed_servers',
      proxyRules: `http=${this.addressValue};https=${this.addressValue}`,
      proxyBypassRules: '<-loopback>'
    }
  }

  /** 关闭监听端口并终止仍在转发的浏览器和目标连接。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    if (this.server.listening) {
      this.server.closeAllConnections()
      this.server.close()
    }
  }

  /** 校验普通 HTTP 代理请求后，连接至解析结果中的公网地址。 */
  private async handleHttpRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let target: URL
    try {
      target = new URL(normalizeResearchUrl(request.url))
      if (target.protocol !== 'http:') throw new Error('只允许普通 HTTP 代理请求。')
    } catch {
      writeProxyError(response, 403)
      return
    }

    let targetPort: number
    try {
      targetPort = targetPortNumber(target, 80)
    } catch (error) {
      writeProxyError(response, error instanceof ResearchTargetBlockedError ? 403 : 502)
      return
    }
    let outgoing: ReturnType<typeof httpRequest> | undefined
    const retryable = isReplayableResearchRequest(request)
    request.once('aborted', () => outgoing?.destroy())
    response.once('close', () => {
      if (!response.writableEnded) outgoing?.destroy()
    })

    /** 只在上游尚未返回响应头时重放无请求体 GET/HEAD，最多一次。 */
    const forward = async (attempt: 0 | 1): Promise<void> => {
      let agent: ConnectedSocketAgent | undefined
      let upstreamStarted = false
      try {
        if (response.destroyed || request.aborted) return
        const addresses = await this.resolvePublicAddresses(target.hostname)
        const routes = await this.resolveRoutes(target.href)
        const connection = await this.connectToTarget(routes, addresses, targetPort, false)
        this.track(connection.socket)
        agent = new ConnectedSocketAgent(connection.socket)

        const proxyRoute = connection.route.kind === 'http' || connection.route.kind === 'https'
          ? connection.route
          : undefined
        const path = proxyRoute
          ? `http://${formatIpAuthority(connection.address, targetPort)}${target.pathname}${target.search}`
          : `${target.pathname}${target.search}` || '/'
        outgoing = httpRequest({
          hostname: proxyRoute ? proxyRoute.host : connection.address,
          port: proxyRoute ? proxyRoute.port : targetPort,
          method: request.method,
          path,
          headers: forwardRequestHeaders(request.headers, target.host),
          agent
        }, (upstream) => {
          upstreamStarted = true
          response.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, forwardResponseHeaders(upstream.headers))
          upstream.pipe(response)
          upstream.once('end', () => agent?.destroy())
          upstream.once('aborted', () => response.destroy())
        })
        outgoing.once('error', () => {
          agent?.destroy()
          if (attempt === 0 && retryable && !upstreamStarted && !response.headersSent && !request.aborted) {
            void forward(1)
            return
          }
          writeProxyError(response, 502)
        })
        if (retryable) {
          request.resume()
          outgoing.end()
        } else {
          request.pipe(outgoing)
        }
      } catch (error) {
        agent?.destroy()
        outgoing?.destroy()
        if (attempt === 0 && retryable && !response.headersSent && !request.aborted) {
          await forward(1)
          return
        }
        writeProxyError(response, error instanceof ResearchTargetBlockedError ? 403 : 502)
      }
    }

    await forward(0)
  }

  /** 建立 HTTPS 隧道时，把 CONNECT 目标替换为已经校验的公网 IP。 */
  private async handleConnectRequest(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    let target: URL
    try {
      target = new URL(`https://${request.url ?? ''}`)
      if (target.pathname !== '/' || target.search || target.hash) throw new Error('CONNECT 地址无效。')
      target = new URL(normalizeResearchUrl(target.href))
    } catch {
      writeConnectError(client, 403)
      return
    }

    let connection: TargetConnection | undefined
    try {
      const targetPort = targetPortNumber(target, 443)
      const addresses = await this.resolvePublicAddresses(target.hostname)
      const routes = await this.resolveRoutes(target.href)
      connection = await this.connectToTarget(routes, addresses, targetPort, true)
      this.track(connection.socket)
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) connection.socket.write(head)
      client.pipe(connection.socket)
      connection.socket.pipe(client)
      client.once('error', () => connection?.socket.destroy())
      client.once('close', () => connection?.socket.destroy())
      connection.socket.once('error', () => client.destroy())
      connection.socket.once('close', () => client.destroy())
    } catch (error) {
      connection?.socket.destroy()
      writeConnectError(client, error instanceof ResearchTargetBlockedError ? 403 : 502)
    }
  }

  /** DNS A/AAAA 只查一次且不读缓存；任何内网结果、空结果或超时都会阻止连接。 */
  private async resolvePublicAddresses(hostname: string): Promise<string[]> {
    return resolvePublicResearchAddresses(
      hostname,
      this.options.resolveHost,
      this.options.isPublicAddress ?? isPublicResearchAddress
    )
  }

  /** 按 Electron 当前会话解析的代理顺序读取目标路由；未知路由失败关闭。 */
  private async resolveRoutes(url: string): Promise<ResearchProxyRoute[]> {
    return parseResearchProxyRoutes(await this.options.resolveProxy(url))
  }

  /** 只尝试解析结果中列出的路由，绝不隐式回退到直连。 */
  private async connectToTarget(
    routes: ResearchProxyRoute[],
    addresses: string[],
    port: number,
    tunnel: boolean
  ): Promise<TargetConnection> {
    let lastError: unknown
    for (const route of routes) {
      for (const address of addresses) {
        if (this.closed) throw new Error('网页出站代理已关闭。')
        let socket: Socket | undefined
        try {
          socket = await this.connectRoute(route, address, port)
          if (this.closed) {
            socket.destroy()
            throw new Error('网页出站代理已关闭。')
          }
          if (tunnel && (route.kind === 'http' || route.kind === 'https')) {
            await establishHttpTunnel(socket, address, port)
          }
          return { route, address, socket }
        } catch (error) {
          socket?.destroy()
          if (error instanceof ProxyRouteRejectedError) throw error
          lastError = error
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('网页连接失败。')
  }

  /** 创建目标或上游代理 Socket 后立即跟踪，便于关闭应用时中断建连。 */
  private async connectRoute(route: ResearchProxyRoute, address: string, port: number): Promise<Socket> {
    if (route.kind === 'direct') {
      const socket = connectTcp({ host: address, port })
      this.track(socket)
      return connectSocket(socket, 'connect')
    }
    if (route.kind === 'http') {
      const socket = connectTcp({ host: route.host, port: route.port })
      this.track(socket)
      return connectSocket(socket, 'connect')
    }
    if (route.kind === 'https') {
      const socket = connectTls({
        host: route.host,
        port: route.port,
        ...(isIP(route.host) ? {} : { servername: route.host })
      })
      this.track(socket)
      return connectSocket(socket, 'secureConnect')
    }
    if (route.kind === 'socks4' && isIP(address) !== 4) {
      throw new Error('SOCKS4 不支持该 IP 地址类型。')
    }

    const proxySocket = connectTcp({ host: route.host, port: route.port })
    this.track(proxySocket)
    await connectSocket(proxySocket, 'connect')
    const connected = await SocksClient.createConnection({
      proxy: { host: route.host, port: route.port, type: route.kind === 'socks5' ? 5 : 4 },
      command: 'connect',
      destination: { host: address, port },
      existing_socket: proxySocket,
      timeout: SOCKET_TIMEOUT_MS,
      set_tcp_nodelay: true
    })
    return connected.socket
  }

  /** 跟踪所有回环和上游 Socket，应用退出或视图关闭时统一释放。 */
  private track(socket: Duplex): void {
    if (this.sockets.has(socket)) return
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
  }
}

interface TargetConnection {
  route: ResearchProxyRoute
  address: string
  socket: Socket
}

/** 将已连接的 Socket 交给单次 HTTP 请求，避免 Node 再次解析目标域名。 */
class ConnectedSocketAgent extends Agent {
  /** 把已验证并连接的 Socket 交给一次请求，避免再次解析域名。 */
  constructor(private readonly socket: Socket) {
    super({ keepAlive: false, maxSockets: 1 })
  }

  /** 返回固定 Socket，确保 Node HTTP 客户端不自行新建连接。 */
  override createConnection(): Socket {
    return this.socket
  }
}

/** 解析 Chromium `resolveProxy` 返回的路由列表，并拒绝未知代理协议。 */
export function parseResearchProxyRoutes(proxyInfo: string): ResearchProxyRoute[] {
  const entries = proxyInfo.split(';').map((entry) => entry.trim()).filter(Boolean)
  if (!entries.length) throw new Error('网页代理未返回可用路由。')

  return entries.map((entry) => {
    if (entry.toUpperCase() === 'DIRECT') return { kind: 'direct' }
    const match = /^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(.+)$/i.exec(entry)
    if (!match) throw new Error('网页代理路由不受支持。')
    const kind: ResearchProxyKind = /^(PROXY|HTTP)$/i.test(match[1])
      ? 'http'
      : match[1].toUpperCase() === 'HTTPS'
        ? 'https'
        : match[1].toUpperCase() === 'SOCKS5'
          ? 'socks5'
          : 'socks4'
    return { kind, ...parseProxyEndpoint(match[2], kind) }
  })
}

/** 对每个域名只发起一次无缓存 A/AAAA 查询，并拒绝混有内网地址的结果集。 */
export async function resolvePublicResearchAddresses(
  hostname: string,
  resolveHost: ResearchDnsResolver,
  isPublicAddress: (address: string) => boolean = isPublicResearchAddress
): Promise<string[]> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let answers: PromiseSettledResult<readonly string[]>[]
  try {
    answers = await Promise.race([
      Promise.allSettled([
        resolveHost(hostname, 'A', DNS_OPTIONS),
        resolveHost(hostname, 'AAAA', DNS_OPTIONS)
      ]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('DNS 解析超时。')), DNS_TIMEOUT_MS)
      })
    ])
  } catch {
    throw new ResearchTargetBlockedError()
  } finally {
    if (timeout) clearTimeout(timeout)
  }

  const addresses = [...new Set(answers.flatMap((answer) => answer.status === 'fulfilled' ? answer.value : []))]
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new ResearchTargetBlockedError()
  }
  return addresses
}

/** 解析代理地址并应用对应协议的默认端口。 */
function parseProxyEndpoint(authority: string, kind: ResearchProxyKind): ResearchProxyEndpoint {
  const scheme = kind === 'https' ? 'https:' : kind === 'socks4' || kind === 'socks5' ? 'socks5:' : 'http:'
  let url: URL
  try {
    url = new URL(`${scheme}//${authority}`)
  } catch {
    throw new Error('网页代理地址无效。')
  }
  if (!url.hostname || url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('网页代理地址无效。')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = Number(url.port || (kind === 'https' ? 443 : kind.startsWith('socks') ? 1080 : 80))
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('网页代理地址无效。')
  return { host, port }
}

/** 等待 TCP 或 TLS 握手完成，并给连接建立设置上限。 */
function connectSocket(socket: Socket, eventName: 'connect' | 'secureConnect'): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => fail(new Error('代理连接超时。')), SOCKET_TIMEOUT_MS)
    /** 握手结束后移除超时和所有监听，避免连接器残留。 */
    const cleanup = (): void => {
      clearTimeout(timeout)
      socket.removeListener(eventName, onConnect)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }
    /** 连接成功后解除监听并交出已连接 Socket。 */
    const onConnect = (): void => {
      cleanup()
      resolve(socket)
    }
    /** 将底层 Socket 错误统一交给清理与拒绝路径。 */
    const onError = (error: Error): void => fail(error)
    /** 将握手前关闭视为代理连接失败。 */
    const onClose = (): void => fail(new Error('代理连接已关闭。'))
    /** 统一清理 Socket 后拒绝握手，覆盖超时和网络错误。 */
    const fail = (error: Error): void => {
      cleanup()
      socket.destroy()
      reject(error)
    }
    socket.once(eventName, onConnect)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

/** 通过 HTTP 或 HTTPS 代理建立隧道；非 200 响应视为代理明确拒绝。 */
function establishHttpTunnel(socket: Socket, address: string, port: number): Promise<void> {
  const authority = formatIpAuthority(address, port)
  const request = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: keep-alive\r\n\r\n`
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0)
    const timeout = setTimeout(() => fail(new Error('代理隧道建立超时。')), SOCKET_TIMEOUT_MS)
    /** 清除隧道响应监听与超时，避免处理结束后继续累积数据。 */
    const cleanup = (): void => {
      clearTimeout(timeout)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }
    /** 有界读取 CONNECT 响应头并确认上游返回 200 后开放隧道。 */
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk])
      if (received.length > MAX_CONNECT_RESPONSE_BYTES) {
        fail(new Error('代理响应头过大。'))
        return
      }
      const separator = received.indexOf('\r\n\r\n')
      if (separator < 0) return
      const header = received.subarray(0, separator).toString('latin1')
      const extra = received.subarray(separator + 4)
      const statusCode = /^HTTP\/1\.[01]\s+(\d{3})(?:\s|$)/i.exec(header)?.[1]
      cleanup()
      socket.pause()
      if (extra.length) socket.unshift(extra)
      if (statusCode !== '200') {
        socket.destroy()
        reject(new ProxyRouteRejectedError())
        return
      }
      resolve()
    }
    /** 将隧道 Socket 错误交给统一清理流程。 */
    const onError = (error: Error): void => fail(error)
    /** 隧道建立前关闭连接时返回明确失败。 */
    const onClose = (): void => fail(new Error('代理隧道已关闭。'))
    /** 清理事件并销毁拒绝服务的隧道 Socket。 */
    const fail = (error: Error): void => {
      cleanup()
      socket.destroy()
      reject(error)
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    socket.write(request)
  })
}

/** 仅转发端到端连接响应中的必要头，删除代理与逐跳传输头。 */
function forwardRequestHeaders(headers: IncomingHttpHeaders, host: string): IncomingHttpHeaders {
  const blocked = new Set([
    'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'upgrade', 'expect'
  ])
  for (const token of String(headers.connection ?? '').split(',')) {
    if (token.trim()) blocked.add(token.trim().toLowerCase())
  }
  const forwarded: IncomingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !blocked.has(name.toLowerCase()) && name.toLowerCase() !== 'host') {
      forwarded[name] = value
    }
  }
  forwarded.host = host
  return forwarded
}

/** 仅重放无请求体的 GET/HEAD；其他方法可能产生副作用或无法安全重建请求体。 */
function isReplayableResearchRequest(request: IncomingMessage): boolean {
  const method = request.method?.toUpperCase()
  const contentLength = request.headers['content-length']
  const hasNoBody = contentLength === undefined
    ? request.headers['transfer-encoding'] === undefined
    : Number(contentLength) === 0
  return (method === 'GET' || method === 'HEAD') && hasNoBody
}

/** 让本机 HTTP 栈重新生成连接与分块响应头，避免透传代理跳端头。 */
function forwardResponseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const blocked = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'transfer-encoding', 'upgrade'])
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) =>
    value !== undefined && !blocked.has(name.toLowerCase())
  ))
}

/** 为普通 HTTP 请求返回不泄漏地址、DNS 或代理细节的状态码。 */
function writeProxyError(response: ServerResponse, statusCode: 403 | 502): void {
  if (response.headersSent || response.destroyed) {
    response.destroy()
    return
  }
  const reason = statusCode === 403 ? 'Forbidden' : 'Bad Gateway'
  response.writeHead(statusCode, reason, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
  response.end('网页连接失败。')
}

/** 为 HTTPS 隧道返回状态，失败时不暴露内网地址和本机代理信息。 */
function writeConnectError(socket: Duplex, statusCode: 403 | 502): void {
  if (socket.destroyed || !socket.writable) return
  const reason = statusCode === 403 ? 'Forbidden' : 'Bad Gateway'
  socket.end(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\n\r\n`)
}

/** 输出适用于代理 URI 和 CONNECT 请求的 IPv4/IPv6 地址格式。 */
function formatIpAuthority(address: string, port: number): string {
  const host = isIP(address) === 6 ? `[${address}]` : address
  return `${host}:${port}`
}

/** 拒绝零端口和超范围端口，避免把网页 URL 当作任意本机服务入口。 */
function targetPortNumber(target: URL, defaultPort: number): number {
  const port = Number(target.port || defaultPort)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new ResearchTargetBlockedError()
  return port
}

/** 仅对 HTTP 代理返回带 IP 的绝对 URI，TLS 隧道则使用同一 IP 作为 CONNECT 目标。 */
class ProxyRouteRejectedError extends Error {
  /** 记录代理明确拒绝当前目标的安全错误类型。 */
  constructor() {
    super('上游代理拒绝请求。')
  }
}

/** 区分目标不安全与普通代理故障，供本机 HTTP 响应返回准确状态。 */
class ResearchTargetBlockedError extends Error {
  /** 将未通过公网地址检查的目标与普通网络故障区分开。 */
  constructor() {
    super('网页目标未通过公网地址校验。')
  }
}
