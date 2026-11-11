/** 为 MCP 设置提供不落盘的连接预检，并复用现有服务密钥。 */
import type { McpServerSettings, McpToolDescriptor } from '../../shared/types.js'
import { normalizeMcpServer } from './config.js'
import { discoverMcpTools, type McpSecretProvider } from './runtime.js'

export interface McpConfigStore {
  snapshot(): { settings: { mcpServers: McpServerSettings[] } }
  updateMcpServers(servers: McpServerSettings[]): Promise<void>
}

export interface McpConfigVault extends McpSecretProvider {
  updateMcpSecretsWithCommit(
    updates: Array<{ serverId: string; key: string; value?: string; clear?: boolean }>,
    commit: () => Promise<void>
  ): Promise<void>
}

/** 保存 MCP 服务时协调密钥库和设置文件；第二步失败由凭证库恢复原值。 */
export async function saveMcpServerConfig(
  input: unknown,
  store: McpConfigStore,
  vault: McpConfigVault
): Promise<void> {
  if (!isRecord(input)) throw new Error('MCP 服务配置无效。')
  const rawId = input.id
  const currentServers = store.snapshot().settings.mcpServers
  const existing = typeof rawId === 'string' ? currentServers.find((item) => item.id === rawId) : undefined
  if (rawId !== undefined && !existing) throw new Error('找不到要修改的 MCP 服务。')
  const normalized = normalizeMcpServer(input, existing)
  const nextServers = existing
    ? currentServers.map((item) => item.id === existing.id ? normalized.server : item)
    : [...currentServers, normalized.server]
  if (nextServers.length > 8) throw new Error('最多可配置 8 个 MCP 服务。')

  const updates = [
    ...(existing?.envKeys ?? [])
      .filter((key) => !normalized.server.envKeys.includes(key))
      .map((key) => ({ serverId: normalized.server.id, key, clear: true })),
    ...normalized.environment.map(({ key, value }) => ({ serverId: normalized.server.id, key, value }))
  ]
  await vault.updateMcpSecretsWithCommit(updates, () => store.updateMcpServers(nextServers))
}

/** 删除 MCP 服务时同步清除凭证；设置写入失败则在密钥库内恢复原始密文。 */
export async function removeMcpServerConfig(
  serverId: string,
  store: McpConfigStore,
  vault: McpConfigVault
): Promise<void> {
  const currentServers = store.snapshot().settings.mcpServers
  const server = currentServers.find((item) => item.id === serverId)
  if (!server) throw new Error('找不到这个 MCP 服务。')
  const nextServers = currentServers.filter((item) => item.id !== serverId)
  const updates = server.envKeys.map((key) => ({ serverId, key, clear: true }))
  await vault.updateMcpSecretsWithCommit(updates, () => store.updateMcpServers(nextServers))
}

/** 临时连接并发现草稿服务的工具；返回前关闭子进程，不修改旅行设置或密钥库。 */
export async function testMcpServerConfig(
  input: unknown,
  servers: McpServerSettings[],
  vault: McpSecretProvider
): Promise<McpToolDescriptor[]> {
  if (!isRecord(input)) throw new Error('MCP 服务配置无效。')
  const rawId = input.id
  const existing = typeof rawId === 'string' ? servers.find((server) => server.id === rawId) : undefined
  if (rawId !== undefined && !existing) throw new Error('找不到要测试的 MCP 服务。')

  const normalized = normalizeMcpServer(input, existing)
  const enteredSecrets = new Map(
    normalized.environment
      .map(({ key, value }) => [key, value.trim()] as const)
      .filter(([, value]) => value.length > 0)
  )
  const previewVault: McpSecretProvider = {
    getAmapKey: async () => (await vault.getAmapKey?.()) ?? null,
    getMcpEnvironment: async (serverId, keys) => {
      const saved = existing?.id === serverId ? await vault.getMcpEnvironment(serverId, keys) : {}
      return {
        ...saved,
        ...Object.fromEntries(keys.flatMap((key) => {
          const value = enteredSecrets.get(key)
          return value ? [[key, value]] : []
        }))
      }
    }
  }

  // 预检不会写设置或凭证库；renderer 暂存表单值，供用户决定是否随后保存。
  return discoverMcpTools(normalized.server, previewVault)
}

/** 拒绝数组和 null，避免把非对象输入当成服务配置。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
