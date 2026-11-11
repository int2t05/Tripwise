/** 覆盖 MCP 新旧协议协商、只读授权、来源输出和密钥脱敏。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { McpServerSettings } from '../src/shared/types.js'
import { isSafeMcpRetryArguments } from '../src/shared/mcp-retry-safety.js'
import { discoverMcpTools, McpToolSession } from '../src/main/mcp/runtime.js'
import { testMcpServerConfig } from '../src/main/mcp/service.js'

const MCP_FIXTURE = String.raw`
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const split = buffer.indexOf('\n');
    const line = buffer.slice(0, split);
    buffer = buffer.slice(split + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === 'server/discover') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
    }
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' }
      } }) + '\n');
    }
    if (request.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [
        { name: 'search_places', description: '只读地点查询 https://example.com/docs?token=tool-description-token', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
        { name: 'error_query', description: '只读查询但测试时返回错误', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
        { name: 'structured_query', description: '返回结构化结果', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'url_schema_probe', description: '敏感链接 schema', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'https://example.com/search?access_token=schema-only-token' } } }, annotations: { readOnlyHint: true } },
        { name: 'secret_probe', description: '凭证说明：' + process.env.API_KEY, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'schema_probe', description: '安全说明', inputSchema: { type: 'object', properties: { token: { type: 'string', description: process.env.API_KEY } } }, annotations: { readOnlyHint: true } },
        { name: 'env_probe', description: '父进程环境：' + process.env.TRIPWISE_TEST_PARENT_SECRET, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: process.env.API_KEY, description: '凭证化工具名', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
        { name: 'publish_post', description: '写入社交内容', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: true } },
        { name: 'unknown_tool', description: '未声明只读', inputSchema: { type: 'object' } }
      ] } }) + '\n');
    }
    if (request.method === 'tools/call') {
      const isError = request.params.name === 'error_query';
      const structuredOnly = request.params.name === 'structured_query';
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
        isError,
        content: structuredOnly ? [] : [
          { type: 'text', text: '地点：' + request.params.arguments.query + '；密钥回显：' + process.env.API_KEY + '；网页：https://example.com/lookup?access_token=text-only-token' },
          { type: 'resource_link', name: '小红书旅行笔记', uri: 'https://www.xiaohongshu.com/explore/1' },
          { type: 'resource_link', name: '旅行社区攻略', uri: 'https://www.mafengwo.cn/travel/1' },
          { type: 'resource_link', name: '凭证来源 ' + process.env.LINK_SECRET, uri: 'https://example.com/lookup?token=' + encodeURIComponent(process.env.LINK_SECRET), description: '凭证摘要 ' + process.env.LINK_SECRET },
          { type: 'resource_link', name: '带访问令牌的链接', uri: 'https://example.com/lookup?access_token=link-only-token' },
          { type: 'resource_link', name: '带通用凭证参数的链接', uri: 'https://example.com/lookup?key=plain-key-link-secret' },
          { type: 'resource_link', name: '带片段的普通链接', uri: 'https://example.com/lookup?view=route#fragment-only-secret', description: '说明：https://example.com/detail?token=description-only-token' }
        ],
        ...(structuredOnly ? { structuredContent: { url: 'https://example.com/lookup?token=structured-only-token' } } : {})
      } }) + '\n');
    }
  }
});
process.stdin.on('end', () => {
  try { require('node:fs').writeFileSync(process.argv[2] || process.argv[1], 'closed'); } catch {}
});
`

const MODERN_MCP_FIXTURE = String.raw`
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const split = buffer.indexOf('\n');
    const line = buffer.slice(0, split);
    buffer = buffer.slice(split + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    const result = request.method === 'server/discover'
      ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
      : request.method === 'tools/list'
        ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: [
            { name: 'lookup_places', description: '只读地点查询', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } }
          ] }
        : { resultType: 'complete', content: [{ type: 'text', text: '已查询：' + request.params.arguments.query }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  }
});
`

/** 启动无外网的 Streamable HTTP MCP 假服务，用于验证认证和协议调用。 */
async function startStreamableFixture(secret: string, protocol: 'legacy' | 'modern' = 'legacy') {
  const requests: Array<{
    url: string
    authorization: string | undefined
    method: string
    protocolVersion: string | undefined
    mcpMethodHeader: string | undefined
    mcpNameHeader: string | undefined
    apiKeyHeader: string | undefined
  }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8')
    const protocolVersion = request.headers['mcp-protocol-version']
    const normalizedProtocolVersion = Array.isArray(protocolVersion) ? protocolVersion[0] : protocolVersion
    const mcpMethodHeader = request.headers['mcp-method']
    const normalizedMcpMethodHeader = Array.isArray(mcpMethodHeader) ? mcpMethodHeader[0] : mcpMethodHeader
    const mcpNameHeader = request.headers['mcp-name']
    const normalizedMcpNameHeader = Array.isArray(mcpNameHeader) ? mcpNameHeader[0] : mcpNameHeader
    const apiKeyHeader = request.headers['x-api-key']
    const normalizedApiKeyHeader = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader
    if (!body) {
      requests.push({
        url: request.url ?? '', authorization: request.headers.authorization,
        method: request.method ?? '', protocolVersion: normalizedProtocolVersion,
        mcpMethodHeader: normalizedMcpMethodHeader, mcpNameHeader: normalizedMcpNameHeader,
        apiKeyHeader: normalizedApiKeyHeader
      })
      response.writeHead(200).end()
      return
    }
    const message = JSON.parse(body) as {
      id?: string | number
      method: string
      params?: { name?: string; arguments?: Record<string, unknown> }
    }
    requests.push({
      url: request.url ?? '', authorization: request.headers.authorization,
      method: message.method, protocolVersion: normalizedProtocolVersion,
      mcpMethodHeader: normalizedMcpMethodHeader, mcpNameHeader: normalizedMcpNameHeader,
      apiKeyHeader: normalizedApiKeyHeader
    })
    if (message.method === 'notifications/initialized' || !('id' in message)) {
      response.writeHead(202).end()
      return
    }
    if (protocol === 'legacy' && message.method === 'server/discover') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' }
      }))
      return
    }
    const result = protocol === 'modern' && message.method === 'server/discover'
      ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
      : message.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture-remote', version: '1' } }
      : message.method === 'tools/list'
        ? { tools: [{
            name: 'lookup_route', description: '读取路线',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
            annotations: { readOnlyHint: true }
          }, {
            name: 'personal_map', description: '创建旅行地图', inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true }
          }] }
        : message.method === 'tools/call'
          ? { content: [{ type: 'text', text: `查询 ${String(message.params?.arguments?.query)}；凭证 ${secret}` }] }
          : {}
    if (protocol === 'modern' && message.method !== 'server/discover') {
      Object.assign(result, { resultType: 'complete' })
    }
    if (protocol === 'modern' && message.method === 'tools/list') {
      Object.assign(result, { ttlMs: 0, cacheScope: 'private' })
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    requests,
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

/** 启动无外网的旧式 SSE MCP 服务，验证兼容传输和跨主机凭证限制。 */
async function startSseFixture(secret: string) {
  const requests: Array<{ url: string; authorization: string | undefined; method: string }> = []
  const streams = new Set<import('node:http').ServerResponse>()
  const server = createServer(async (request, response) => {
    requests.push({ url: request.url ?? '', authorization: request.headers.authorization, method: request.method ?? '' })
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write('event: endpoint\ndata: /messages\n\n')
      streams.add(response)
      request.once('close', () => streams.delete(response))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8')
    if (!body) {
      response.writeHead(202).end()
      return
    }
    const message = JSON.parse(body) as { id?: string | number; method: string; params?: { name?: string } }
    response.writeHead(202).end()
    if (!('id' in message)) return
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture-sse', version: '1' } }
      : message.method === 'tools/list'
        ? { tools: [{
            name: 'lookup_weather', description: '读取旅行天气', inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true }
          }] }
        : { content: [{ type: 'text', text: `天气查询已完成；凭证 ${secret}` }] }
    for (const stream of streams) {
      stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`)
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    requests,
    url: `http://127.0.0.1:${address.port}/events`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

describe('MCP 重试参数安全校验', () => {
  it('允许普通查询并拒绝凭证字段、凭证文本和超限结构', () => {
    expect(isSafeMcpRetryArguments({ query: '故宫附近的公共交通', filters: { openNow: true } })).toBe(true)
    expect(isSafeMcpRetryArguments({ api_key: 'credential-value' })).toBe(false)
    expect(isSafeMcpRetryArguments({ query: 'Authorization: abcdefgh123456' })).toBe(false)
    expect(isSafeMcpRetryArguments({ query: 'x'.repeat(4_001) })).toBe(false)

    let deeplyNested: Record<string, unknown> = { value: 'query' }
    for (let depth = 0; depth < 9; depth += 1) deeplyNested = { child: deeplyNested }
    expect(isSafeMcpRetryArguments(deeplyNested)).toBe(false)
    const hostileProxy = new Proxy({}, { getPrototypeOf: () => { throw new Error('拒绝对象检查') } })
    expect(isSafeMcpRetryArguments(hostileProxy)).toBe(false)
  })
})

/** 提供仅用于测试的 MCP 只读查询服务和内存凭证。 */
function testServer(exitMarker: string): McpServerSettings {
  return {
    id: 'fixture-server', name: '测试地点服务', command: process.execPath,
    args: ['-e', MCP_FIXTURE, exitMarker], envKeys: ['API_KEY', 'LINK_SECRET'], enabled: true,
    allowedTools: ['search_places', 'error_query', 'structured_query', 'url_schema_probe', 'secret_probe', 'schema_probe', 'env_probe', 'fixture-secret-value', 'publish_post', 'unknown_tool']
  }
}

describe('MCP stdio 插件运行时', () => {
  it('预检新服务不修改设置，使用输入密钥后关闭进程并脱敏工具说明', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tripwise-mcp-preview-'))
    const exitMarker = join(directory, 'child-closed')
    const fixturePath = join(directory, 'mcp-fixture.cjs')
    await writeFile(fixturePath, MCP_FIXTURE, 'utf8')
    const fixture = testServer(exitMarker)
    const input = {
      name: fixture.name,
      command: fixture.command,
      args: [fixturePath, exitMarker],
      enabled: false,
      allowedTools: [],
      environment: [{ key: 'API_KEY', value: 'preview-secret-value' }]
    }
    const before = structuredClone(input)
    const savedServers: McpServerSettings[] = []
    try {
      const tools = await testMcpServerConfig(input, savedServers, { getMcpEnvironment: async () => ({}) })
      expect(tools.find((tool) => tool.name === 'search_places')).toMatchObject({ readOnly: true, destructive: false })
      expect(tools.find((tool) => tool.name === 'search_places')?.description).toContain('[已隐藏含敏感访问参数的链接]')
      expect(tools.find((tool) => tool.name === 'search_places')?.description).not.toContain('tool-description-token')
      const secretTool = tools.find((tool) => tool.name === 'secret_probe')
      expect(secretTool?.description).toContain('[已隐藏凭证]')
      expect(secretTool?.description).not.toContain('preview-secret-value')
      expect(tools.some((tool) => tool.name === '[已隐藏凭证]')).toBe(true)
      expect(input).toEqual(before)
      expect(savedServers).toEqual([])
      expect(await readFile(exitMarker, 'utf8')).toBe('closed')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)

  it('stdio 自动协商 2026 无状态协议并正常调用只读工具', async () => {
    const server: McpServerSettings = {
      id: 'modern-stdio', name: '新版地点服务', command: process.execPath,
      args: ['-e', MODERN_MCP_FIXTURE], envKeys: [], enabled: true, allowedTools: ['lookup_places']
    }
    const vault = { getMcpEnvironment: async () => ({}) }
    let session: McpToolSession | undefined
    try {
      session = await McpToolSession.open([server], vault, new AbortController().signal)
      expect(session.unavailable).toEqual([])
      const [definition] = session.definitions()
      expect(definition?.function.name).toContain('lookup_places')
      const result = await session.execute(
        definition!.function.name, JSON.stringify({ query: '圆明园附近天气' }), new AbortController().signal
      )
      expect(result.output).toContain('已查询：圆明园附近天气')
    } finally {
      await session?.close()
    }
  }, 20_000)

  it('通过 Streamable HTTP 连接远程只读工具，并仅在请求内注入高德凭证', async () => {
    const secret = 'amap-runtime-fixture-secret'
    const fixture = await startStreamableFixture(secret)
    const server: McpServerSettings = {
      id: 'amap-remote', name: '远程地点服务', transport: 'streamable-http',
      command: '', args: [], url: fixture.url,
      auth: { type: 'query', name: 'key', credential: 'amapKey' },
      envKeys: [], enabled: true, allowedTools: ['lookup_route', 'personal_map']
    }
    const vault = {
      getMcpEnvironment: async () => ({}),
      getAmapKey: async () => secret
    }
    let session: McpToolSession | undefined
    try {
      session = await McpToolSession.open([server], vault, new AbortController().signal)
      const definitions = session.definitions()
      const [definition] = definitions
      expect(definitions).toHaveLength(1)
      expect(definition?.function.name).toContain('lookup_route')
      const discovered = await discoverMcpTools(server, vault)
      expect(discovered.find((tool) => tool.name === 'personal_map')).toMatchObject({ readOnly: false, destructive: true })
      const result = await session.execute(
        definition!.function.name, JSON.stringify({ query: '北京西站到故宫' }), new AbortController().signal
      )

      expect(fixture.requests.some((request) => request.url.includes(`key=${secret}`))).toBe(true)
      expect(fixture.requests.some((request) => request.method === 'server/discover')).toBe(true)
      expect(fixture.requests.some((request) => request.method === 'initialize')).toBe(true)
      expect(fixture.requests.every((request) => request.authorization === undefined)).toBe(true)
      expect(result.output).toContain('北京西站到故宫')
      expect(result.output).toContain('[已隐藏凭证]')
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(JSON.stringify(server)).not.toContain(secret)
    } finally {
      await session?.close()
      await fixture.close()
    }
  }, 20_000)

  it('连接 2026 无状态远程服务并保留认证与来源脱敏边界', async () => {
    const secret = 'modern-mcp-runtime-fixture-secret'
    const fixture = await startStreamableFixture(secret, 'modern')
    const server: McpServerSettings = {
      id: 'modern-remote', name: '新版路线服务', transport: 'streamable-http',
      command: '', args: [], url: fixture.url,
      auth: { type: 'header', name: 'X-API-Key', envKey: 'MCP_AUTH_TOKEN' },
      envKeys: ['MCP_AUTH_TOKEN'], enabled: true, allowedTools: ['lookup_route']
    }
    const vault = { getMcpEnvironment: async () => ({ MCP_AUTH_TOKEN: secret }) }
    let session: McpToolSession | undefined
    try {
      session = await McpToolSession.open([server], vault, new AbortController().signal)
      expect(session.definitions(), session.unavailable.join('\n')).toHaveLength(1)
      const [definition] = session.definitions()
      expect(definition?.function.name).toContain('lookup_route')
      const result = await session.execute(
        definition!.function.name, JSON.stringify({ query: '北京西站到故宫' }), new AbortController().signal
      )

      expect(fixture.requests.map((request) => request.method)).toEqual(['server/discover', 'tools/list', 'tools/call'])
      expect(fixture.requests.every((request) => request.protocolVersion === '2026-07-28')).toBe(true)
      expect(fixture.requests.map((request) => request.mcpMethodHeader)).toEqual(['server/discover', 'tools/list', 'tools/call'])
      expect(fixture.requests[2]?.mcpNameHeader).toBe('lookup_route')
      expect(fixture.requests.every((request) => request.authorization === undefined)).toBe(true)
      expect(fixture.requests.every((request) => request.apiKeyHeader === secret)).toBe(true)
      expect(fixture.requests.every((request) => request.url === '/mcp')).toBe(true)
      expect(result.output).toContain('北京西站到故宫')
      expect(result.output).toContain('[已隐藏凭证]')
      expect(JSON.stringify(result)).not.toContain(secret)
    } finally {
      await session?.close()
      await fixture.close()
    }
  }, 20_000)

  it('兼容 SSE 远程传输，将静态认证头用于发现和工具调用', async () => {
    const secret = 'sse-runtime-fixture-secret'
    const fixture = await startSseFixture(secret)
    const server: McpServerSettings = {
      id: 'sse-remote', name: '天气 MCP', transport: 'sse', command: '', args: [], url: fixture.url,
      auth: { type: 'header', name: 'Authorization', envKey: 'MCP_AUTH_TOKEN' },
      envKeys: ['MCP_AUTH_TOKEN'], enabled: true, allowedTools: ['lookup_weather']
    }
    const vault = { getMcpEnvironment: async () => ({ MCP_AUTH_TOKEN: secret }) }
    let session: McpToolSession | undefined
    try {
      session = await McpToolSession.open([server], vault, new AbortController().signal)
      const [definition] = session.definitions()
      expect(definition?.function.name).toContain('lookup_weather')
      const result = await session.execute(definition!.function.name, '{}', new AbortController().signal)
      expect(fixture.requests.some((request) => request.method === 'GET' && request.authorization === secret)).toBe(true)
      expect(fixture.requests.some((request) => request.method === 'POST' && request.authorization === secret)).toBe(true)
      expect(result.output).toContain('天气查询已完成')
      expect(JSON.stringify(result)).not.toContain(secret)
    } finally {
      await session?.close()
      await fixture.close()
    }
  }, 20_000)

  it('仅公开获准的只读工具、隐藏密钥回显并把结果作为来源保存', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tripwise-mcp-test-'))
    const exitMarker = join(directory, 'child-closed')
    const server = testServer(exitMarker)
    const vault = { getMcpEnvironment: async () => ({ API_KEY: 'fixture-secret-value', LINK_SECRET: 'url-secret value=' }) }
    let session: McpToolSession | undefined
    try {
      session = await McpToolSession.open([server], vault, new AbortController().signal)
      const definitions = session.definitions()
      expect(definitions).toHaveLength(5)
      expect(definitions.find((item) => item.function.name.includes('search_places'))?.function.description).toContain('只读插件')
      expect(definitions.find((item) => item.function.name.includes('search_places'))?.function.description).toContain('[已隐藏含敏感访问参数的链接]')
      expect(JSON.stringify(definitions)).not.toContain('tool-description-token')
      expect(definitions.find((item) => item.function.name.includes('secret_probe'))?.function.description).toContain('[已隐藏凭证]')
      expect(JSON.stringify(definitions)).not.toContain('fixture-secret-value')
      expect(session.unavailable.join('\n')).not.toContain('fixture-secret-value')
      expect(session.unavailable.join('\n')).toContain('工具元数据包含已配置凭证，已跳过。')
      expect(session.unavailable.join('\n')).toContain('MCP 工具参数结构包含敏感链接，已跳过。')

      const result = await session.execute(definitions[0].function.name, JSON.stringify({ query: '故宫周边' }), new AbortController().signal)
      expect(result.output).toContain('故宫周边')
      expect(result.output).toContain('[已隐藏凭证]')
      expect(result.output).toContain('[已隐藏含敏感访问参数的链接]')
      expect(result.output).toContain('社区平台（不代表事实已核验）')
      expect(result.output).not.toContain('fixture-secret-value')
      expect(result.sources).toHaveLength(3)
      expect(result.sources[0]).toMatchObject({ kind: 'plugin', provider: 'MCP · 测试地点服务', connectorId: 'fixture-server', sourceNature: 'community-platform', status: 'success' })
      expect(result.sources[1]).toMatchObject({ title: 'search_places · 旅行社区攻略', url: 'https://www.mafengwo.cn/travel/1', sourceNature: 'community-platform' })
      expect(result.sources[2]).toMatchObject({ title: 'search_places · 带片段的普通链接', url: 'https://example.com/lookup?view=route' })
      expect(JSON.stringify(result.sources)).not.toContain('fixture-secret-value')
      expect(JSON.stringify(result.sources)).not.toContain('url-secret value=')
      expect(JSON.stringify(result.sources)).not.toContain('link-only-token')
      expect(JSON.stringify(result.sources)).not.toContain('plain-key-link-secret')
      expect(JSON.stringify(result.sources)).not.toContain('fragment-only-secret')
      expect(result.output).not.toContain('plain-key-link-secret')
      expect(result.output).not.toContain('link-only-token')
      expect(result.output).not.toContain('fragment-only-secret')
      expect(result.output).not.toContain('text-only-token')
      expect(JSON.stringify(result.sources)).toContain('[已隐藏含敏感访问参数的链接]')
      expect(JSON.stringify(result.sources)).not.toContain('description-only-token')
      expect(JSON.stringify(result)).not.toContain('url-secret value=')
      expect(JSON.stringify(result)).not.toContain('url-secret%20value%3D')
      expect(result.sources[0].summary).not.toContain('fixture-secret-value')

      const structuredTool = definitions.find((item) => item.function.name.includes('structured_query'))!
      const structured = await session.execute(structuredTool.function.name, '{}', new AbortController().signal)
      expect(structured.output).toContain('[已隐藏含敏感访问参数的链接]')
      expect(JSON.stringify(structured)).not.toContain('structured-only-token')

      const errorTool = definitions.find((item) => item.function.name.includes('error_query'))!
      const failed = await session.execute(errorTool.function.name, JSON.stringify({ query: '故宫附近交通' }), new AbortController().signal)
      expect(failed.feedback).toEqual([expect.objectContaining({ severity: 'warning', code: 'mcp_tool_failed' })])
      expect(failed.sources[0]).toMatchObject({
        status: 'error', connectorId: 'fixture-server',
        retry: { kind: 'mcp-tool', serverId: 'fixture-server', toolName: 'error_query', arguments: { query: '故宫附近交通' } }
      })
      expect(JSON.stringify(failed.sources)).not.toContain('fixture-secret-value')
      const malformedArguments = await session.execute(errorTool.function.name, '{', new AbortController().signal)
      expect(malformedArguments.feedback).toEqual([expect.objectContaining({ severity: 'error', code: 'invalid_json' })])

      const retried = await McpToolSession.retryReadOnlyTool(
        server, vault, 'error_query', { query: '再次查询故宫附近交通' }, new AbortController().signal
      )
      expect(retried.sources[0]).toMatchObject({ status: 'error', retry: {
        kind: 'mcp-tool', toolName: 'error_query', arguments: { query: '再次查询故宫附近交通' }
      } })
      await expect(McpToolSession.retryReadOnlyTool(
        { ...server, allowedTools: ['search_places'] }, vault, 'error_query', { query: '未授权查询' }, new AbortController().signal
      )).rejects.toThrow('该 MCP 工具已不在当前批准列表中')

      const connectionCheck = await McpToolSession.retryConnection(server, vault, new AbortController().signal)
      expect(connectionCheck.sources[0]).toMatchObject({ status: 'success', connectorId: 'fixture-server' })
      expect(connectionCheck.output).toContain('连接成功')

      const credentialInput = await session.execute(
        errorTool.function.name, JSON.stringify({ query: 'fixture-secret-value' }), new AbortController().signal
      )
      expect(credentialInput.sources[0].retry).toBeUndefined()
      expect(credentialInput.sources[0].summary).toContain('未保存该查询的单项重试参数')
      expect(credentialInput.output).toContain('未保存该查询的单项重试参数')
    } finally {
      await session?.close()
      try {
        expect(await readFile(exitMarker, 'utf8')).toBe('closed')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }, 20_000)

  it('不会把未授权的父进程环境变量暴露给 MCP 工具元数据', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tripwise-mcp-env-test-'))
    const exitMarker = join(directory, 'child-closed')
    const previousValue = process.env.TRIPWISE_TEST_PARENT_SECRET
    process.env.TRIPWISE_TEST_PARENT_SECRET = 'parent-process-only-fixture'
    let session: McpToolSession | undefined
    try {
      session = await McpToolSession.open(
        [testServer(exitMarker)],
        { getMcpEnvironment: async () => ({ API_KEY: 'fixture-secret-value' }) },
        new AbortController().signal
      )
      expect(JSON.stringify(session.definitions())).not.toContain('parent-process-only-fixture')
    } finally {
      if (previousValue === undefined) delete process.env.TRIPWISE_TEST_PARENT_SECRET
      else process.env.TRIPWISE_TEST_PARENT_SECRET = previousValue
      await session?.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)

  it('将服务握手失败保留为可关联的插件诊断来源', async () => {
    const server: McpServerSettings = {
      id: 'missing-server', name: '失效服务', command: '/tripwise/missing-mcp-command', args: [],
      envKeys: [], enabled: true, allowedTools: ['search_places']
    }
    const session = await McpToolSession.open([server], { getMcpEnvironment: async () => ({}) }, new AbortController().signal)
    try {
      expect(session.unavailable).toHaveLength(1)
      expect(session.diagnostics).toHaveLength(1)
      expect(session.diagnostics[0]).toMatchObject({
        kind: 'plugin', connectorId: 'missing-server', title: '连接诊断 · 失效服务', status: 'error', url: ''
      })
      expect(session.diagnostics[0].summary).toContain('找不到插件程序')
      expect(session.diagnostics[0].summary).not.toContain('/tripwise/missing-mcp-command')
      expect(session.diagnostics[0].retry).toEqual({ kind: 'mcp-connect', serverId: 'missing-server' })

      const retried = await McpToolSession.retryConnection(server, { getMcpEnvironment: async () => ({}) }, new AbortController().signal)
      expect(retried.sources[0]).toMatchObject({ status: 'error', retry: { kind: 'mcp-connect', serverId: 'missing-server' } })
      expect(JSON.stringify(retried)).not.toContain('/tripwise/missing-mcp-command')
    } finally {
      await session.close()
    }
  }, 20_000)
})
