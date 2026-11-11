/** 验证 MCP 配置服务、凭证协调与普通设置并发保存边界。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TripStore } from '../src/main/persistence.js'
import { normalizeMcpServer } from '../src/main/mcp/config.js'
import { removeMcpServerConfig, saveMcpServerConfig, type McpConfigStore, type McpConfigVault } from '../src/main/mcp/service.js'
import type { McpServerSettings } from '../src/shared/types.js'

const temporaryDirectories: string[] = []

/** 创建隔离的设置文件，避免用例共享本机数据。 */
async function createStore(): Promise<TripStore> {
  const directory = await mkdtemp(join(tmpdir(), 'tripwise-mcp-config-'))
  temporaryDirectories.push(directory)
  const store = new TripStore(directory)
  await store.initialize()
  return store
}

/** 提供可检查写入顺序和回滚结果的内存密钥库。 */
function createVault(): McpConfigVault & { values: Map<string, string> } {
  const values = new Map<string, string>()
  const keyFor = (serverId: string, key: string) => `${serverId}:${key}`
  return {
    values,
    async getMcpEnvironment(serverId, keys) {
      return Object.fromEntries(keys.flatMap((key) => {
        const value = values.get(keyFor(serverId, key))
        return value === undefined ? [] : [[key, value]]
      }))
    },
    async updateMcpSecretsWithCommit(updates, commit) {
      const before = new Map(values)
      for (const update of updates) {
        const key = keyFor(update.serverId, update.key)
        if (update.clear) values.delete(key)
        else if (update.value?.trim()) values.set(key, update.value.trim())
      }
      try {
        await commit()
      } catch (error) {
        values.clear()
        for (const [key, value] of before) values.set(key, value)
        throw error
      }
    }
  }
}

/** 为服务层补充配置失败注入，同时保留真实 TripStore 快照读取。 */
function withStoreFailure(store: TripStore): McpConfigStore {
  return {
    snapshot: () => store.snapshot(),
    updateMcpServers: async () => { throw new Error('模拟设置写入失败') }
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('MCP 配置与凭证一致性', () => {
  it('拒绝把通用 key 查询参数写入远程服务地址', () => {
    for (const url of [
      'https://travel.example/mcp?key=plain-key-secret',
      'https://travel.example/mcp?KEY=plain-key-secret',
      'https://travel.example/mcp?api_key=plain-key-secret'
    ]) {
      expect(() => normalizeMcpServer({
        name: '路线查询', transport: 'streamable-http', command: '', args: [], url,
        enabled: false, allowedTools: [], environment: []
      })).toThrow('地址不能包含凭证或片段')
    }
    expect(() => normalizeMcpServer({
      name: '路线查询', transport: 'streamable-http', command: '', args: [],
      url: 'https://travel.example/mcp?monkey=banana',
      enabled: false, allowedTools: [], environment: []
    })).not.toThrow()
  })

  it('拒绝把认证凭证绑定到 MCP 协议路由头或 HTTP framing 头', () => {
    for (const name of ['Mcp-Method', 'Mcp-Name', 'Mcp-Param-Query', 'MCP-Protocol-Version', 'Content-Type', 'Accept']) {
      expect(() => normalizeMcpServer({
        name: '路线查询', transport: 'streamable-http', command: '', args: [],
        url: 'https://travel.example/mcp', auth: { type: 'header', name, envKey: 'API_TOKEN' },
        enabled: false, allowedTools: [], environment: [{ key: 'API_TOKEN', value: 'fixture-token' }]
      })).toThrow('认证请求头名称无效或受保护')
    }
    expect(() => normalizeMcpServer({
      name: '路线查询', transport: 'streamable-http', command: '', args: [],
      url: 'https://travel.example/mcp', auth: { type: 'header', name: 'X-API-Key', envKey: 'API_TOKEN' },
      enabled: false, allowedTools: [], environment: [{ key: 'API_TOKEN', value: 'fixture-token' }]
    })).not.toThrow()
  })

  it('提交新服务后只在普通设置中保存环境变量名', async () => {
    const store = await createStore()
    const vault = createVault()

    await saveMcpServerConfig({
      name: '地图查询', command: 'node', args: ['server.js'], enabled: true,
      allowedTools: ['search_places'], environment: [{ key: 'MAP_TOKEN', value: 'fixture-secret' }]
    }, store, vault)

    const server = store.snapshot().settings.mcpServers[0]
    expect(server).toMatchObject({ name: '地图查询', envKeys: ['MAP_TOKEN'] })
    expect(server).not.toHaveProperty('environment')
    expect(JSON.stringify(store.snapshot().settings)).not.toContain('fixture-secret')
    expect(vault.values.get(`${server.id}:MAP_TOKEN`)).toBe('fixture-secret')
  })

  it('保存远程高德服务地址与认证引用，不把 API Key 写进旅行设置', async () => {
    const store = await createStore()
    const vault = createVault()
    await saveMcpServerConfig({
      name: '高德地图', transport: 'streamable-http', command: '', args: [],
      url: 'https://mcp.amap.com/mcp', auth: { type: 'query', name: 'key', credential: 'amapKey' },
      enabled: false, allowedTools: [], environment: []
    }, store, vault)

    const server = store.snapshot().settings.mcpServers[0]
    expect(server).toMatchObject({ transport: 'streamable-http', url: 'https://mcp.amap.com/mcp' })
    expect(server.auth).toEqual({ type: 'query', name: 'key', credential: 'amapKey' })
    expect(JSON.stringify(store.snapshot().settings)).not.toContain('apiKey')
  })

  it('编辑远程认证服务时保留未重新输入的已保存密钥', async () => {
    const store = await createStore()
    const vault = createVault()
    const server: McpServerSettings = {
      id: 'remote-weather', name: '远程天气', transport: 'streamable-http', command: '', args: [],
      url: 'https://weather.example/mcp', auth: { type: 'header', name: 'Authorization', envKey: 'MCP_AUTH_TOKEN' },
      envKeys: ['MCP_AUTH_TOKEN'], enabled: true, allowedTools: ['get_weather']
    }
    await store.updateMcpServers([server])
    vault.values.set('remote-weather:MCP_AUTH_TOKEN', 'saved-remote-token')

    await saveMcpServerConfig({
      id: server.id, name: server.name, transport: server.transport, command: '', args: [], url: server.url,
      auth: server.auth, enabled: true, allowedTools: server.allowedTools,
      environment: [{ key: 'MCP_AUTH_TOKEN', value: '' }]
    }, store, vault)

    expect(store.snapshot().settings.mcpServers[0].envKeys).toEqual(['MCP_AUTH_TOKEN'])
    expect(vault.values.get('remote-weather:MCP_AUTH_TOKEN')).toBe('saved-remote-token')
    expect(await vault.getMcpEnvironment(server.id, server.envKeys)).toEqual({ MCP_AUTH_TOKEN: 'saved-remote-token' })
  })

  it('设置文件提交失败时恢复本次新增或变更的密钥', async () => {
    const store = await createStore()
    const server: McpServerSettings = {
      id: 'map-service', name: '地图查询', command: 'node', args: [], envKeys: ['MAP_TOKEN'],
      enabled: true, allowedTools: ['search_places']
    }
    await store.updateMcpServers([server])
    const vault = createVault()
    vault.values.set('map-service:MAP_TOKEN', 'previous-secret')
    const failingStore = withStoreFailure(store)

    await expect(saveMcpServerConfig({
      id: server.id, name: server.name, command: server.command, args: server.args,
      enabled: true, allowedTools: server.allowedTools,
      environment: [{ key: 'MAP_TOKEN', value: 'replacement-secret' }, { key: 'NEW_TOKEN', value: 'new-secret' }]
    }, failingStore, vault)).rejects.toThrow('模拟设置写入失败')

    expect(vault.values).toEqual(new Map([['map-service:MAP_TOKEN', 'previous-secret']]))
    expect(store.snapshot().settings.mcpServers).toEqual([server])
  })

  it('删除失败时保留服务与凭证，成功时同时清除二者', async () => {
    const store = await createStore()
    const server: McpServerSettings = {
      id: 'weather-service', name: '天气查询', command: 'node', args: [], envKeys: ['WEATHER_KEY'],
      enabled: true, allowedTools: ['get_weather']
    }
    await store.updateMcpServers([server])
    const vault = createVault()
    vault.values.set('weather-service:WEATHER_KEY', 'weather-fixture')

    await expect(removeMcpServerConfig(server.id, withStoreFailure(store), vault)).rejects.toThrow('模拟设置写入失败')
    expect(store.snapshot().settings.mcpServers).toEqual([server])
    expect(vault.values.get('weather-service:WEATHER_KEY')).toBe('weather-fixture')

    await removeMcpServerConfig(server.id, store, vault)
    expect(store.snapshot().settings.mcpServers).toEqual([])
    expect(vault.values.has('weather-service:WEATHER_KEY')).toBe(false)
  })

  it('旧设置页快照保存时保留当前 MCP 服务列表', async () => {
    const store = await createStore()
    const staleSettings = store.snapshot().settings
    const server: McpServerSettings = {
      id: 'route-service', name: '路线查询', command: 'node', args: [], envKeys: [],
      enabled: true, allowedTools: ['route']
    }
    await store.updateMcpServers([server])

    await store.updateSettingsPreservingMcpServers({
      ...staleSettings,
      model: { baseUrl: 'https://model.example/v1', model: 'fixture-model' }
    })

    expect(store.snapshot().settings.mcpServers).toEqual([server])
    expect(store.snapshot().settings.model.model).toBe('fixture-model')
  })
})
