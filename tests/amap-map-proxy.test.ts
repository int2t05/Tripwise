/** 验证高德地图代理只访问白名单，并由主进程附加安全密钥。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AmapMapProxy } from '../src/main/amap-map-proxy.js'

const proxies: AmapMapProxy[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('高德地图本机安全代理', () => {
  it('只代理允许的高德服务，并在主进程侧覆盖安全密钥且不缓存响应', async () => {
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response('{"status":"1"}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))
    const proxy = new AmapMapProxy(fetcher)
    proxies.push(proxy)
    proxy.setSecurityCode('server-only-security-fixture')
    const host = await proxy.serviceHost()
    const response = await fetch(`${host}/v3/place/text?keywords=故宫&jscode=attacker-value`)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('{"status":"1"}')
    const [target, request] = fetcher.mock.calls[0]
    const upstream = new URL(String(target))
    expect(upstream.origin).toBe('https://restapi.amap.com')
    expect(upstream.pathname).toBe('/v3/place/text')
    expect(upstream.searchParams.get('keywords')).toBe('故宫')
    expect(upstream.searchParams.get('jscode')).toBe('server-only-security-fixture')
    expect(upstream.searchParams.get('jscode')).not.toBe('attacker-value')
    expect(request).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(host).not.toContain('server-only-security-fixture')
  })

  it('只接受已传入的开发 renderer 来源，不从环境变量信任打包版网页', async () => {
    const fetcher = vi.fn(async () => new Response('{"status":"1"}'))
    vi.stubEnv('ELECTRON_RENDERER_URL', 'https://attacker.example/')
    const proxy = new AmapMapProxy(fetcher)
    proxies.push(proxy)
    proxy.setSecurityCode('server-only-security-fixture')
    const host = await proxy.serviceHost()
    const rejected = await fetch(`${host}/v3/place/text`, {
      headers: { Origin: 'https://attacker.example' }
    })

    expect(rejected.status).toBe(403)
    expect(fetcher).not.toHaveBeenCalled()
    const devProxy = new AmapMapProxy(fetcher, 'http://localhost:5173/')
    proxies.push(devProxy)
    devProxy.setSecurityCode('server-only-security-fixture')
    const devHost = await devProxy.serviceHost()
    const accepted = await fetch(`${devHost}/v3/place/text`, {
      headers: { Origin: 'http://localhost:5173' }
    })

    expect(accepted.status).toBe(200)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('拒绝外部目标和不受支持的方法，不调用上游', async () => {
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response('unexpected'))
    const proxy = new AmapMapProxy(fetcher)
    proxies.push(proxy)
    proxy.setSecurityCode('server-only-security-fixture')
    const host = await proxy.serviceHost()

    const unsupported = await fetch(`${host}/https://example.com/private`)
    const post = await fetch(`${host}/v3/place/text`, { method: 'POST' })

    expect(unsupported.status).toBe(404)
    expect(post.status).toBe(405)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('配置不完整时不启动代理', async () => {
    const proxy = new AmapMapProxy(async () => new Response('unexpected'))
    proxies.push(proxy)
    await expect(proxy.serviceHost()).rejects.toThrow('尚未配置高德 JS API 安全密钥')
  })

  it('只通过随机回环路径托管地图 HTML 和其实际引用的构建资源', async () => {
    const rendererDirectory = await mkdtemp(join(tmpdir(), 'tripwise-map-frame-test-'))
    temporaryDirectories.push(rendererDirectory)
    await mkdir(join(rendererDirectory, 'assets'))
    await writeFile(join(rendererDirectory, 'amap-map.html'), '<script type="module" src="./assets/map.js"></script><link rel="stylesheet" href="./assets/map.css">')
    await writeFile(join(rendererDirectory, 'assets', 'map.js'), 'window.fixtureMap = true')
    await writeFile(join(rendererDirectory, 'assets', 'map.css'), '#map { height: 100%; }')
    await writeFile(join(rendererDirectory, 'assets', 'unreferenced.js'), 'window.untrusted = true')
    const fetcher = vi.fn(async () => new Response('unexpected'))
    const proxy = new AmapMapProxy(fetcher, undefined, rendererDirectory)
    proxies.push(proxy)

    const pageUrl = await proxy.mapPageUrl()
    const page = await fetch(pageUrl)
    const script = await fetch(new URL('./assets/map.js', pageUrl))
    const stylesheet = await fetch(new URL('./assets/map.css', pageUrl))
    const unreferenced = await fetch(new URL('./assets/unreferenced.js', pageUrl))

    expect(new URL(pageUrl).hostname).toBe('127.0.0.1')
    expect(new URL(pageUrl).pathname).toMatch(/^\/tripwise-map\/[a-f0-9]{64}\/amap-map\.html$/)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(script.status).toBe(200)
    expect(script.headers.get('access-control-allow-origin')).toBe('*')
    expect(await script.text()).toContain('fixtureMap')
    expect(stylesheet.status).toBe(200)
    expect(stylesheet.headers.get('content-type')).toContain('text/css')
    expect(unreferenced.status).toBe(404)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('拒绝读取超出上限的服务响应', async () => {
    const fetcher = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response('x'.repeat(2_000_001)))
    const proxy = new AmapMapProxy(fetcher)
    proxies.push(proxy)
    proxy.setSecurityCode('server-only-security-fixture')
    const host = await proxy.serviceHost()
    const response = await fetch(`${host}/v4/map/styles?key=public-key-fixture`)

    expect(response.status).toBe(502)
    expect(await response.text()).toBe('')
  })
})
