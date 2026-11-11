/** 在本机回环地址托管隔离地图页并代理高德 API，仅由主进程附加安全密钥。 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_QUERY_LENGTH = 12_000
const MAX_RESPONSE_BYTES = 2_000_000
const REQUEST_TIMEOUT_MS = 18_000
const REQUEST_PREFIX = '/tripwise-amap'
const MAP_PAGE_PREFIX = '/tripwise-map'

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>

/** 限制目标域名、路径、体积和来源，避免把本地密钥代理变成通用代理。 */
export class AmapMapProxy {
  private readonly token = randomBytes(32).toString('hex')
  private readonly server: Server
  private securityCode: string | null = null
  private port: number | null = null
  private listenPromise: Promise<void> | null = null
  private mapAssetNames: Set<string> | null = null

  /** 注入 Electron 网络栈和只读 renderer 产物目录，避免 renderer 访问本机文件。 */
  constructor(
    private readonly fetcher: Fetcher,
    private readonly devRendererUrl?: string,
    private readonly rendererDirectory?: string
  ) {
    this.server = createServer((request, response) => void this.handle(request, response))
  }

  /** 仅在主进程更新安全密钥；renderer 只能拿到受限代理地址。 */
  setSecurityCode(value: string | null): void {
    this.securityCode = value?.trim() || null
  }

  /** 启动随机本机端口，并返回仅可访问高德许可路径的代理地址。 */
  async serviceHost(): Promise<string> {
    if (!this.securityCode) throw new Error('尚未配置高德 JS API 安全密钥。')
    if (this.port === null) await this.listen()
    return `http://127.0.0.1:${this.port}${REQUEST_PREFIX}/${this.token}/_AMapService`
  }

  /** 用随机路径在回环地址托管地图页，供无同源权限的沙箱 iframe 加载本地构建资源。 */
  async mapPageUrl(): Promise<string> {
    if (!this.rendererDirectory) throw new Error('地图页面资源尚未构建。')
    if (this.port === null) await this.listen()
    return `http://127.0.0.1:${this.port}${MAP_PAGE_PREFIX}/${this.token}/amap-map.html`
  }

  /** 应用退出时释放本机监听端口。 */
  async close(): Promise<void> {
    if (!this.server.listening) return
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    this.port = null
    this.securityCode = null
  }

  /** 只托管本地地图构建文件，并代理固定的高德地图端点。 */
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin
    if (!isAllowedOrigin(origin, this.devRendererUrl)) {
      response.writeHead(403).end()
      return
    }
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With')
    response.setHeader('Access-Control-Max-Age', '300')
    response.setHeader('Cache-Control', 'no-store')
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end()
      return
    }
    let requestUrl: URL
    try {
      requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    } catch {
      response.writeHead(400).end()
      return
    }
    if (requestUrl.pathname.startsWith(`${MAP_PAGE_PREFIX}/`)) {
      await this.serveMapAsset(request, response, requestUrl)
      return
    }
    if (request.method !== 'GET' || !this.securityCode) {
      response.writeHead(405).end()
      return
    }
    const prefix = `${REQUEST_PREFIX}/${this.token}/_AMapService/`
    if (!requestUrl.pathname.startsWith(prefix) || requestUrl.search.length > MAX_QUERY_LENGTH) {
      response.writeHead(404).end()
      return
    }
    const endpoint = requestUrl.pathname.slice(prefix.length)
    const target = amapTarget(endpoint)
    if (!target) {
      response.writeHead(404).end()
      return
    }

    const upstream = new URL(target)
    requestUrl.searchParams.delete('jscode')
    requestUrl.searchParams.set('jscode', this.securityCode)
    upstream.search = requestUrl.searchParams.toString()
    const controller = new AbortController()
    request.once('aborted', () => controller.abort())
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })
    try {
      const result = await this.fetcher(upstream, {
        method: 'GET',
        headers: { Accept: 'application/json, text/plain, */*' },
        redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      })
      const body = await readLimitedBody(result)
      const contentType = result.headers.get('content-type')
      response.writeHead(result.status, {
        ...(contentType ? { 'Content-Type': contentType.slice(0, 120) } : {}),
        'Content-Length': body.byteLength,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
        'Access-Control-Max-Age': '300'
      })
      response.end(body)
    } catch {
      if (!response.headersSent) response.writeHead(502)
      response.end()
    }
  }

  /** 只开放当前构建 HTML 实际引用的 JS/CSS 文件，拒绝任意路径和文件读取。 */
  private async serveMapAsset(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const prefix = `${MAP_PAGE_PREFIX}/${this.token}/`
    if (request.method !== 'GET' || !this.rendererDirectory || url.search || !url.pathname.startsWith(prefix)) {
      response.writeHead(request.method === 'GET' ? 404 : 405).end()
      return
    }
    const relativePath = url.pathname.slice(prefix.length)
    const isMapDocument = relativePath === 'amap-map.html'
    if (!isMapDocument && !await this.isBuiltMapAsset(relativePath)) {
      response.writeHead(404).end()
      return
    }
    const assetPath = isMapDocument
      ? join(this.rendererDirectory, 'amap-map.html')
      : join(this.rendererDirectory, 'assets', relativePath.slice('assets/'.length))
    try {
      const body = await readFile(assetPath)
      const contentType = isMapDocument ? 'text/html; charset=utf-8' : contentTypeFor(relativePath)
      response.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': body.byteLength,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      })
      response.end(body)
    } catch {
      response.writeHead(404).end()
    }
  }

  /** 从构建页提取唯一静态依赖名，路径只接受安全文件名和显式 assets 前缀。 */
  private async isBuiltMapAsset(relativePath: string): Promise<boolean> {
    if (!/^assets\/[A-Za-z0-9._-]+\.(?:js|css)$/.test(relativePath) || !this.rendererDirectory) return false
    if (!this.mapAssetNames) {
      try {
        const html = await readFile(join(this.rendererDirectory, 'amap-map.html'), 'utf8')
        this.mapAssetNames = new Set([...html.matchAll(/(?:src|href)="\.\/assets\/([A-Za-z0-9._-]+\.(?:js|css))"/g)]
          .map((match) => match[1]))
      } catch {
        this.mapAssetNames = new Set()
      }
    }
    return this.mapAssetNames.has(relativePath.slice('assets/'.length))
  }

  /** 监听仅绑定回环地址，不向局域网或公网开放。 */
  private listen(): Promise<void> {
    if (this.listenPromise) return this.listenPromise
    this.listenPromise = new Promise<void>((resolve, reject) => {
      /** 监听失败时移除一次性事件并允许调用方重试启动。 */
      const onError = (error: Error): void => {
        this.server.removeListener('error', onError)
        this.listenPromise = null
        reject(error)
      }
      this.server.once('error', onError)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', onError)
        const address = this.server.address()
        if (!address || typeof address === 'string') {
          this.listenPromise = null
          reject(new Error('无法启动高德地图本机代理。'))
          return
        }
        this.port = address.port
        resolve()
      })
    })
    return this.listenPromise
  }
}

/** 仅为地图页托管脚本样式；不允许 HTML 把本机服务用于下载或 MIME 猜测。 */
function contentTypeFor(path: string): string {
  return path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'
}

/** 固定上游域名，拒绝任意路径和非地图服务请求。 */
function amapTarget(endpoint: string): string | null {
  if (endpoint === 'v4/map/styles') return 'https://webapi.amap.com/v4/map/styles'
  if (/^v[35]\/[a-zA-Z0-9/_-]+$/.test(endpoint)) return `https://restapi.amap.com/${endpoint}`
  return null
}

/** 不允许外部网页把本机服务当作可读接口使用。 */
function isAllowedOrigin(origin: string | undefined, devRendererUrl?: string): boolean {
  if (!origin || origin === 'null' || origin === 'file://') return true
  if (!devRendererUrl) return false
  try {
    return new URL(devRendererUrl).origin === new URL(origin).origin
  } catch {
    return false
  }
}

/** 限制响应读取体积，防止服务或中间代理返回无界数据。 */
async function readLimitedBody(response: Response): Promise<Buffer> {
  if (response.headers.get('content-length')) {
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('高德地图返回内容过大。')
    }
  }
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('高德地图返回内容过大。')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size)
}
