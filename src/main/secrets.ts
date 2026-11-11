/** 将服务密钥集中保存在受限权限的本地 JSON 文件中，不访问系统钥匙串。 */
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SecretStatus } from '../shared/types.js'

type SecretName = 'modelKey' | 'amapKey' | 'amapJsKey' | 'amapSecurityCode' | 'exaKey' | 'tavilyKey' | 'firecrawlKey'
type SecretValues = Record<string, string>
type LocalCredentialFile = { format: 'tripwise-credentials'; schemaVersion: 1; secrets: SecretValues }
type McpSecretUpdate = { serverId: string; key: string; value?: string; clear?: boolean }

const CREDENTIAL_FILE_NAME = 'tripwise-credentials.json'
const CREDENTIAL_FILE_MAX_BYTES = 2 * 1024 * 1024
const CREDENTIAL_ENTRY_MAX_COUNT = 200
const CREDENTIAL_VALUE_MAX_LENGTH = 8_000
const BUILTIN_SECRET_NAMES = new Set<SecretName>([
  'modelKey', 'amapKey', 'amapJsKey', 'amapSecurityCode', 'exaKey', 'tavilyKey', 'firecrawlKey'
])

interface SecretUpdateInput {
  modelKey?: string
  amapKey?: string
  amapJsKey?: string
  amapSecurityCode?: string
  exaKey?: string
  tavilyKey?: string
  firecrawlKey?: string
  clearModelKey?: boolean
  clearAmapKey?: boolean
  clearAmapJsKey?: boolean
  clearAmapSecurityCode?: boolean
  clearExaKey?: boolean
  clearTavilyKey?: boolean
  clearFirecrawlKey?: boolean
  mcpSecrets?: McpSecretUpdate[]
}

/** 管理本机 API Key；配置损坏时失败关闭并保留原文件供用户修复。 */
export class SecretVault {
  private readonly filePath: string
  private readonly secrets: SecretValues = {}
  private credentialFileRecoveryRequired = false
  private writeQueue: Promise<void> = Promise.resolve()

  /** 创建凭证文件路径；文件与旅行数据保持分离。 */
  constructor(directory: string) {
    this.filePath = join(directory, CREDENTIAL_FILE_NAME)
  }

  /** 启动时只读取本地凭证文件，不触发操作系统授权。 */
  async initialize(): Promise<void> {
    await this.reloadLocalCredentialFile()
  }

  /** 只向 renderer 返回凭证状态，不返回凭证值。 */
  async status(): Promise<SecretStatus> {
    return {
      modelKeySaved: !!this.secrets.modelKey,
      amapKeySaved: !!this.secrets.amapKey,
      amapJsKeySaved: !!this.secrets.amapJsKey,
      amapSecurityCodeSaved: !!this.secrets.amapSecurityCode,
      exaKeySaved: !!this.secrets.exaKey,
      tavilyKeySaved: !!this.secrets.tavilyKey,
      firecrawlKeySaved: !!this.secrets.firecrawlKey,
      mcpSecretsSaved: listMcpSecretKeys(this.secrets),
      credentialFilePath: this.filePath,
      credentialFileRecoveryRequired: this.credentialFileRecoveryRequired
    }
  }

  /** 返回固定配置文件路径，不暴露密钥内容。 */
  getLocalCredentialFilePath(): string {
    return this.filePath
  }

  /** 重新读取用户在外部编辑器中保存的凭证文件。 */
  async reloadLocalCredentialFile(): Promise<void> {
    await this.serializeWrite(() => this.reloadFromDisk())
  }

  /** 确保配置文件存在后再由系统默认编辑器打开。 */
  async prepareLocalCredentialFile(): Promise<void> {
    await this.serializeWrite(async () => {
      await this.reloadFromDisk()
      if (this.credentialFileRecoveryRequired) {
        throw new Error('本地凭证文件格式无效或无法读取，请先修复文件。')
      }
      if (!(await fileExists(this.filePath))) await this.persist(this.secrets)
    })
  }

  /** 保存或清除一组密钥；文件写入失败时不会伪报保存成功。 */
  async update(input: SecretUpdateInput): Promise<void> {
    await this.serializeWrite(async () => {
      if (!hasSecretChanges(input)) return
      if (this.credentialFileRecoveryRequired) throw new Error('本地凭证文件格式无效，请先修复文件再保存密钥。')
      const next = applyUpdates(this.secrets, input)
      await this.persist(next)
      replaceRecord(this.secrets, next)
    })
  }

  /** 与 MCP 配置一并提交密钥；设置提交失败时恢复原文件内容。 */
  async updateMcpSecretsWithCommit(updates: McpSecretUpdate[], commit: () => Promise<void>): Promise<void> {
    await this.serializeWrite(async () => {
      if (this.credentialFileRecoveryRequired) throw new Error('本地凭证文件格式无效，请先修复文件再保存插件密钥。')
      const input: SecretUpdateInput = { mcpSecrets: updates }
      for (const item of updates) {
        if (!isMcpSecretReference(item.serverId, item.key)) throw new Error('MCP 凭证标识无效。')
      }
      if (!hasSecretChanges(input)) {
        await commit()
        return
      }

      const previous = { ...this.secrets }
      const next = applyUpdates(this.secrets, input)
      await this.persist(next)
      replaceRecord(this.secrets, next)
      try {
        await commit()
      } catch (error) {
        try {
          await this.persist(previous)
          replaceRecord(this.secrets, previous)
        } catch {
          this.credentialFileRecoveryRequired = true
          throw new Error('MCP 配置提交失败，凭证回滚也失败；请检查本地凭证文件。')
        }
        throw error
      }
    })
  }

  /** 读取模型和内置连接器凭证，值始终留在主进程。 */
  async get(name: SecretName): Promise<string | null> {
    if (this.credentialFileRecoveryRequired) return null
    return this.secrets[name] || null
  }

  /** 高德 MCP 与内置地图共用同一个 Web 服务 Key。 */
  async getAmapKey(): Promise<string | null> {
    return this.get('amapKey')
  }

  /** 仅为经过标识校验的 MCP 环境变量创建密钥映射。 */
  async getMcpEnvironment(serverId: string, keys: string[]): Promise<Record<string, string>> {
    if (this.credentialFileRecoveryRequired || !Array.isArray(keys)) return {}
    const environment: Record<string, string> = {}
    for (const key of keys) {
      if (!isMcpSecretReference(serverId, key)) continue
      const value = this.secrets[mcpSecretName(serverId, key)]
      if (value) environment[key] = value
    }
    return environment
  }

  /** 从磁盘载入并校验 JSON；格式不符时保留原文件且不回退到其他存储。 */
  private async reloadFromDisk(): Promise<void> {
    let fileInfo
    try {
      fileInfo = await lstat(this.filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        replaceRecord(this.secrets, {})
        this.credentialFileRecoveryRequired = false
        return
      }
      this.markRecoveryRequired()
      return
    }

    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > CREDENTIAL_FILE_MAX_BYTES) {
      this.markRecoveryRequired()
      return
    }

    try {
      if (process.platform !== 'win32') await chmod(this.filePath, 0o600)
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      if (!isLocalCredentialFile(value)) {
        this.markRecoveryRequired()
        return
      }
      replaceRecord(this.secrets, normalizeSecrets(value.secrets))
      this.credentialFileRecoveryRequired = false
    } catch {
      this.markRecoveryRequired()
    }
  }

  /** 原子替换凭证文件，并在支持的平台限制为当前账户读写。 */
  private async persist(secrets: SecretValues): Promise<void> {
    if (this.credentialFileRecoveryRequired) throw new Error('本地凭证文件格式无效；原文件已保留。')
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporaryPath = [this.filePath, randomUUID(), 'tmp'].join('.')
    const contents: LocalCredentialFile = {
      format: 'tripwise-credentials',
      schemaVersion: 1,
      secrets: Object.fromEntries(Object.entries(secrets).sort(([left], [right]) => left.localeCompare(right)))
    }
    try {
      await writeFile(temporaryPath, JSON.stringify(contents, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      await rename(temporaryPath, this.filePath)
      if (process.platform !== 'win32') await chmod(this.filePath, 0o600)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /** 串行化读写，避免并发更新互相覆盖。 */
  private async serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const action = this.writeQueue.then(operation)
    this.writeQueue = action.then(() => undefined, () => undefined)
    return action
  }

  /** 清空内存凭证并记录恢复状态；磁盘文件保持不变。 */
  private markRecoveryRequired(): void {
    replaceRecord(this.secrets, {})
    this.credentialFileRecoveryRequired = true
  }
}

/** 把内置密钥和 MCP 更新应用到副本，便于写盘成功后再提交内存状态。 */
function applyUpdates(current: SecretValues, input: SecretUpdateInput): SecretValues {
  const next = { ...current }
  const updates: Array<[SecretName, string | undefined, boolean | undefined]> = [
    ['modelKey', input.modelKey, input.clearModelKey],
    ['amapKey', input.amapKey, input.clearAmapKey],
    ['amapJsKey', input.amapJsKey, input.clearAmapJsKey],
    ['amapSecurityCode', input.amapSecurityCode, input.clearAmapSecurityCode],
    ['exaKey', input.exaKey, input.clearExaKey],
    ['tavilyKey', input.tavilyKey, input.clearTavilyKey],
    ['firecrawlKey', input.firecrawlKey, input.clearFirecrawlKey]
  ]
  for (const [name, value, clear] of updates) setSecret(next, name, value, clear)
  for (const item of input.mcpSecrets ?? []) {
    if (!isMcpSecretReference(item.serverId, item.key)) throw new Error('MCP 凭证标识无效。')
    setSecret(next, mcpSecretName(item.serverId, item.key), item.value, item.clear)
  }
  if (Object.keys(next).length > CREDENTIAL_ENTRY_MAX_COUNT) throw new Error('本地凭证项目数量超过限制。')
  return next
}

/** 设置或删除单项密钥，并对写入值执行长度限制。 */
function setSecret(target: SecretValues, name: string, value?: string, clear?: boolean): void {
  if (clear) {
    delete target[name]
    return
  }
  if (value === undefined || !value.trim()) return
  const secret = value.trim()
  if (secret.length > CREDENTIAL_VALUE_MAX_LENGTH) throw new Error('密钥长度超过限制。')
  target[name] = secret
}

/** 仅当表单确实变更凭证时写文件。 */
function hasSecretChanges(input: SecretUpdateInput): boolean {
  return Boolean(
    input.clearModelKey || input.modelKey?.trim() ||
    input.clearAmapKey || input.amapKey?.trim() ||
    input.clearAmapJsKey || input.amapJsKey?.trim() ||
    input.clearAmapSecurityCode || input.amapSecurityCode?.trim() ||
    input.clearExaKey || input.exaKey?.trim() ||
    input.clearTavilyKey || input.tavilyKey?.trim() ||
    input.clearFirecrawlKey || input.firecrawlKey?.trim() ||
    input.mcpSecrets?.some((item) => item.clear || item.value?.trim())
  )
}

/** 校验配置文件结构、字段名和大小，拒绝任意键及超限数据。 */
function isLocalCredentialFile(value: unknown): value is LocalCredentialFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const file = value as Record<string, unknown>
  if (file.format !== 'tripwise-credentials' || file.schemaVersion !== 1 ||
    !file.secrets || typeof file.secrets !== 'object' || Array.isArray(file.secrets)) return false
  const secrets = file.secrets as Record<string, unknown>
  if (Object.keys(secrets).length > CREDENTIAL_ENTRY_MAX_COUNT) return false
  return Object.entries(secrets).every(([name, secret]) =>
    isCredentialName(name) && typeof secret === 'string' && secret.length <= CREDENTIAL_VALUE_MAX_LENGTH
  )
}

/** 凭证文件只接受内置字段及有限格式的 MCP 服务环境变量名。 */
function isCredentialName(name: string): boolean {
  if (BUILTIN_SECRET_NAMES.has(name as SecretName)) return true
  const match = /^mcp:([a-zA-Z0-9_-]{1,80}):([A-Z_][A-Z0-9_]{0,99})$/.exec(name)
  return !!match && isMcpSecretReference(match[1], match[2])
}

/** 清除空字符串并复制成应用内部使用的普通映射。 */
function normalizeSecrets(secrets: SecretValues): SecretValues {
  return Object.fromEntries(Object.entries(secrets)
    .map(([name, value]) => [name, value.trim()] as const)
    .filter(([, value]) => value.length > 0))
}

/** 使用受限标识把 MCP 环境变量映射到凭证文件键名。 */
function isMcpSecretReference(serverId: string, key: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(serverId) && /^[A-Z_][A-Z0-9_]{0,99}$/.test(key)
}

/** MCP 服务凭证键名不包含密钥值。 */
function mcpSecretName(serverId: string, key: string): string {
  return 'mcp:' + serverId + ':' + key
}

/** 只向界面返回已配置的服务名和环境变量名。 */
function listMcpSecretKeys(secrets: SecretValues): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const name of Object.keys(secrets)) {
    const match = /^mcp:([a-zA-Z0-9_-]{1,80}):([A-Z_][A-Z0-9_]{0,99})$/.exec(name)
    if (!match) continue
    result[match[1]] ??= []
    result[match[1]].push(match[2])
  }
  for (const keys of Object.values(result)) keys.sort()
  return result
}

/** 判断文件是否存在而不跟随符号链接。 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** 用快照完整恢复内存映射，确保失败更新不会残留新键。 */
function replaceRecord(target: SecretValues, snapshot: SecretValues): void {
  for (const key of Object.keys(target)) delete target[key]
  Object.assign(target, snapshot)
}
