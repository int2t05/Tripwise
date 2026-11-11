/** 验证跨平台本地凭证文件的读写、权限、恢复和 MCP 密钥隔离。 */
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretVault } from '../src/main/secrets.js'

const temporaryDirectories: string[] = []
const CREDENTIAL_FILE_NAME = 'tripwise-credentials.json'

/** 为每个用例创建独立凭证目录。 */
async function createVault(): Promise<{ directory: string; vault: SecretVault; filePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'tripwise-credentials-test-'))
  temporaryDirectories.push(directory)
  const vault = new SecretVault(directory)
  return { directory, vault, filePath: join(directory, CREDENTIAL_FILE_NAME) }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('本地凭证文件', () => {
  it('首次载入为空状态，打开配置时创建明确版本的空文件', async () => {
    const { vault, filePath } = await createVault()
    await vault.initialize()

    expect(await vault.status()).toMatchObject({
      modelKeySaved: false,
      mcpSecretsSaved: {},
      credentialFilePath: filePath,
      credentialFileRecoveryRequired: false
    })
    await vault.prepareLocalCredentialFile()
    await expect(readFile(filePath, 'utf8')).resolves.toBe(JSON.stringify({
      format: 'tripwise-credentials',
      schemaVersion: 1,
      secrets: {}
    }, null, 2))
  })

  it('保存和重启后读取 API Key，状态不返回密钥内容', async () => {
    const { directory, vault, filePath } = await createVault()
    await vault.initialize()
    await vault.update({
      modelKey: 'model-fixture-secret',
      exaKey: 'exa-fixture-secret',
      tavilyKey: 'tavily-fixture-secret',
      firecrawlKey: 'firecrawl-fixture-secret',
      amapKey: 'amap-web-fixture-secret',
      amapJsKey: 'amap-js-fixture-secret',
      amapSecurityCode: 'amap-security-fixture-secret'
    })

    const status = await vault.status()
    const stored = await readFile(filePath, 'utf8')
    expect(status).toMatchObject({
      modelKeySaved: true,
      exaKeySaved: true,
      tavilyKeySaved: true,
      firecrawlKeySaved: true,
      amapKeySaved: true,
      amapJsKeySaved: true,
      amapSecurityCodeSaved: true
    })
    expect(JSON.stringify(status)).not.toContain('fixture-secret')
    expect(stored).toContain('model-fixture-secret')

    const reopened = new SecretVault(directory)
    await reopened.initialize()
    await expect(reopened.get('modelKey')).resolves.toBe('model-fixture-secret')
    await expect(reopened.get('amapSecurityCode')).resolves.toBe('amap-security-fixture-secret')

    await reopened.update({ clearModelKey: true, clearExaKey: true })
    await expect(reopened.get('modelKey')).resolves.toBeNull()
    await expect(reopened.status()).resolves.toMatchObject({ modelKeySaved: false, exaKeySaved: false })
  })

  it('在支持 POSIX 权限的平台限制文件为当前账户可读写', async () => {
    if (process.platform === 'win32') return
    const { vault, filePath } = await createVault()
    await vault.initialize()
    await vault.update({ modelKey: 'permission-fixture' })

    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })

  it('忽略并保留旧版加密文件，不尝试读取或迁移', async () => {
    const { directory, vault } = await createVault()
    const oldPath = join(directory, 'tripwise-secrets.json')
    const oldContents = JSON.stringify({ modelKey: 'legacy-ciphertext-fixture' })
    await writeFile(oldPath, oldContents, 'utf8')
    await vault.initialize()

    expect(await vault.status()).toMatchObject({ modelKeySaved: false, credentialFileRecoveryRequired: false })
    await expect(vault.get('modelKey')).resolves.toBeNull()
    await expect(readFile(oldPath, 'utf8')).resolves.toBe(oldContents)
  })

  it('损坏文件保留原样并阻止读取和覆盖', async () => {
    const { vault, filePath } = await createVault()
    const original = '{ invalid json'
    await writeFile(filePath, original, 'utf8')
    await vault.initialize()

    expect(await vault.status()).toMatchObject({ modelKeySaved: false, credentialFileRecoveryRequired: true })
    await expect(vault.get('modelKey')).resolves.toBeNull()
    await expect(vault.update({ modelKey: 'must-not-write' })).rejects.toThrow('本地凭证文件格式无效')
    await expect(vault.prepareLocalCredentialFile()).rejects.toThrow('本地凭证文件格式无效')
    await expect(readFile(filePath, 'utf8')).resolves.toBe(original)
  })

  it('解析损坏文件前先收紧 POSIX 权限', async () => {
    if (process.platform === 'win32') return
    const { vault, filePath } = await createVault()
    await writeFile(filePath, '{ invalid json', 'utf8')
    await chmod(filePath, 0o644)

    await vault.initialize()

    expect(await vault.status()).toMatchObject({ credentialFileRecoveryRequired: true })
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })

  it('拒绝符号链接凭证文件，避免跟随到其他文件', async () => {
    if (process.platform === 'win32') return
    const { directory, vault, filePath } = await createVault()
    const targetPath = join(directory, 'outside.json')
    const targetContents = JSON.stringify({ format: 'tripwise-credentials', schemaVersion: 1, secrets: {} })
    await writeFile(targetPath, targetContents, 'utf8')
    await symlink(targetPath, filePath)
    await vault.initialize()

    expect(await vault.status()).toMatchObject({ credentialFileRecoveryRequired: true })
    await expect(readFile(targetPath, 'utf8')).resolves.toBe(targetContents)
  })

  it('拒绝不支持的字段和超长密钥并进入恢复状态', async () => {
    const { vault, filePath } = await createVault()
    await writeFile(filePath, JSON.stringify({
      format: 'tripwise-credentials',
      schemaVersion: 1,
      secrets: { unexpected: 'value' }
    }), 'utf8')
    await vault.initialize()
    expect(await vault.status()).toMatchObject({ credentialFileRecoveryRequired: true })

    const second = await createVault()
    await writeFile(second.filePath, JSON.stringify({
      format: 'tripwise-credentials',
      schemaVersion: 1,
      secrets: { modelKey: 'x'.repeat(8_001) }
    }), 'utf8')
    await second.vault.initialize()
    expect(await second.vault.status()).toMatchObject({ credentialFileRecoveryRequired: true })
  })

  it('只向 MCP 子进程环境提供该服务已配置的密钥', async () => {
    const { vault } = await createVault()
    await vault.initialize()
    await vault.updateMcpSecretsWithCommit([
      { serverId: 'map-service', key: 'MAP_TOKEN', value: 'map-fixture-secret' },
      { serverId: 'weather-service', key: 'WEATHER_TOKEN', value: 'weather-fixture-secret' }
    ], async () => undefined)

    await expect(vault.getMcpEnvironment('map-service', ['MAP_TOKEN', 'UNKNOWN_TOKEN'])).resolves.toEqual({
      MAP_TOKEN: 'map-fixture-secret'
    })
    await expect(vault.getMcpEnvironment('invalid/server', ['MAP_TOKEN'])).resolves.toEqual({})
    await expect(vault.updateMcpSecretsWithCommit([
      { serverId: 'map-service', key: 'bad-key', value: 'ignored' }
    ], async () => undefined)).rejects.toThrow('MCP 凭证标识无效')
  })

  it('MCP 设置提交失败时恢复原凭证文件和内存状态', async () => {
    const { vault, filePath } = await createVault()
    await vault.initialize()
    await vault.update({ modelKey: 'model-fixture-secret' })
    const before = await readFile(filePath, 'utf8')

    await expect(vault.updateMcpSecretsWithCommit([
      { serverId: 'map-service', key: 'MAP_TOKEN', value: 'new-mcp-fixture-secret' }
    ], async () => { throw new Error('settings commit failed') })).rejects.toThrow('settings commit failed')

    await expect(readFile(filePath, 'utf8')).resolves.toBe(before)
    await expect(vault.getMcpEnvironment('map-service', ['MAP_TOKEN'])).resolves.toEqual({})
    await expect(vault.get('modelKey')).resolves.toBe('model-fixture-secret')
  })

  it('并发保存不同服务的密钥时保留所有更新', async () => {
    const { vault } = await createVault()
    await vault.initialize()

    await Promise.all([
      vault.update({ modelKey: 'model-fixture-secret' }),
      vault.update({ exaKey: 'exa-fixture-secret' }),
      vault.update({ tavilyKey: 'tavily-fixture-secret' })
    ])

    await expect(vault.status()).resolves.toMatchObject({ modelKeySaved: true, exaKeySaved: true, tavilyKeySaved: true })
    await expect(vault.get('modelKey')).resolves.toBe('model-fixture-secret')
    await expect(vault.get('exaKey')).resolves.toBe('exa-fixture-secret')
    await expect(vault.get('tavilyKey')).resolves.toBe('tavily-fixture-secret')
  })
})
