/** 验证三平台候选安装包、SHA-256 清单、Electron Fuse 和应用代码归档。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { candidateOutputDirectory } from './candidate-output.mjs'

const require = createRequire(import.meta.url)
const { extractFile, listPackage, uncache } = require('@electron/asar')
const { FuseV1Options, getCurrentFuseWire } = require('@electron/fuses')
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDirectory = candidateOutputDirectory(projectRoot)
const packageJson = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const builderConfig = readFileSync(path.join(projectRoot, 'electron-builder.yml'), 'utf8')
const selectedPlatform = process.argv.find((argument) => argument.startsWith('--platform='))?.split('=')[1] ?? 'all'
const forceArtifactsOnly = process.argv.includes('--artifacts-only')
const forceFullVerification = process.argv.includes('--full')
const productName = builderConfig.match(/^productName:\s*["']?(.+?)["']?\s*$/m)?.[1]
const distributableExtensions = new Set(['.AppImage', '.dmg', '.exe', '.zip'])
const FUSE_ENABLED = '1'.charCodeAt(0)
const FUSE_DISABLED = '0'.charCodeAt(0)
const buildDirectories = new Set(['mac-arm64', 'win-unpacked', 'linux-unpacked'])
const outputEntries = await readdir(releaseDirectory, { withFileTypes: true })
const hasBuildStage = outputEntries.some((entry) => entry.isDirectory() && buildDirectories.has(entry.name))
const artifactsOnly = forceArtifactsOnly || (!forceFullVerification && !hasBuildStage)

assert.ok(!(forceArtifactsOnly && forceFullVerification), '不能同时请求只验证安装包和完整构建验证。')
assert.ok(productName, 'electron-builder.yml 必须声明 productName。')
assert.ok(['all', 'mac', 'win', 'linux'].includes(selectedPlatform), '候选包验证平台必须是 all、mac、win 或 linux。')
assert.ok(
  artifactsOnly || (selectedPlatform !== 'all' && selectedPlatform !== 'mac') || process.platform === 'darwin',
  'macOS 候选包验证需要 macOS 构建主机。'
)

/** 对安装文件流式计算 SHA-256，避免完整加载大型安装包。 */
async function sha256(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

/** 校验安装包、摘要和仅交付安装包时的目录内容。 */
async function verifyChecksums() {
  const packages = outputEntries
    .filter((entry) => entry.isFile() && distributableExtensions.has(path.extname(entry.name)))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'))
  const version = packageJson.version
  const expected = [
    `${productName} Setup ${version}.exe`,
    `${productName}-${version}-arm64-mac.zip`,
    `${productName}-${version}-arm64.dmg`,
    `${productName}-${version}-win.zip`,
    `${productName}-${version}.AppImage`
  ].sort((left, right) => left.localeCompare(right, 'en'))
  const scopedExpected = selectedPlatform === 'all'
    ? expected
    : expected.filter((name) => packagePlatform(name) === selectedPlatform)

  assert.ok(scopedExpected.every((name) => packages.includes(name)), `候选目录缺少 ${selectedPlatform} 安装包。`)
  assert.ok(packages.every((name) => expected.includes(name)), '候选目录包含未知的安装包。')
  if (selectedPlatform === 'all') assert.deepEqual(packages, expected, '候选目录必须且只能包含预期的五个平台安装包。')
  if (artifactsOnly) {
    const names = outputEntries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right, 'en'))
    const expectedNames = [...scopedExpected, 'SHA256SUMS'].sort((left, right) => left.localeCompare(right, 'en'))
    assert.deepEqual(names, expectedNames, '交付目录只能包含目标平台安装包与 SHA256SUMS。')
  }
  const expectedLines = await Promise.all(packages.map(async (name) =>
    `${await sha256(path.join(releaseDirectory, name))}  ${name}`
  ))
  const manifest = readFileSync(path.join(releaseDirectory, 'SHA256SUMS'), 'utf8').trimEnd().split('\n')
  assert.deepEqual(manifest, expectedLines, 'SHA256SUMS 与候选安装包不匹配。')
  console.log(`通过：${packages.length} 个安装包与 SHA256SUMS 完全匹配。`)
}

/** 运行系统归档检查工具；命令不可用或归档损坏时立即失败。 */
function verifyCommand(command, args, label) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8' })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${label} 检查失败：${result.stderr || result.stdout}`)
}

/** 检查本次选择平台对应的安装容器。 */
function verifyContainers() {
  const verified = []
  if (selectedPlatform === 'all' || selectedPlatform === 'mac') {
    verifyCommand('hdiutil', ['verify', '-quiet', path.join(releaseDirectory, `${productName}-${packageJson.version}-arm64.dmg`)], 'DMG')
    verifyZipContainer(path.join(releaseDirectory, `${productName}-${packageJson.version}-arm64-mac.zip`), 'macOS ZIP')
    verified.push('macOS DMG/ZIP')
  }
  if (selectedPlatform === 'all' || selectedPlatform === 'win') {
    verifyZipContainer(path.join(releaseDirectory, `${productName}-${packageJson.version}-win.zip`), 'Windows ZIP')
    verified.push('Windows ZIP')
  }
  if (selectedPlatform === 'linux') console.log('说明：Linux AppImage 在本机只校验 SHA-256，不在此脚本中挂载或启动。')
  if (verified.length) console.log(`通过：${verified.join(' 与 ')}容器完整。`)
}

/** 用当前目标系统已有的归档工具验证 ZIP 内容和 CRC。 */
function verifyZipContainer(filePath, label) {
  if (process.platform === 'win32') verifyCommand('7z', ['t', filePath], label)
  else verifyCommand('unzip', ['-tq', filePath], label)
}

/** 确认 Mac 包有有效签名，并区分本机预览与稳定签名。 */
function verifyMacSignature() {
  if (selectedPlatform !== 'all' && selectedPlatform !== 'mac') return
  if (artifactsOnly) {
    console.log('说明：仅安装包验证不检查 .app 签名；该项需要完整构建目录。')
    return
  }
  const application = path.join(releaseDirectory, 'mac-arm64', `${productName}.app`)
  verifyCommand('codesign', ['--verify', '--deep', '--strict', application], 'macOS 应用签名')
  const result = spawnSync('codesign', ['-dv', '--verbose=2', application], { cwd: projectRoot, encoding: 'utf8' })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `macOS 签名信息读取失败：${result.stderr || result.stdout}`)
  const details = `${result.stderr}${result.stdout}`
  if (/Signature=adhoc/.test(details)) {
    assert.match(details, /TeamIdentifier=not set/, 'ad-hoc macOS 预览包不应伪装成稳定签名。')
    console.log('通过：macOS 本机预览包签名结构有效且为 ad-hoc。')
    return
  }
  assert.match(details, /TeamIdentifier=[A-Z0-9]{10}/, 'macOS 稳定签名必须包含 Apple Team ID。')
  console.log('通过：macOS 应用使用带 Apple Team ID 的稳定签名。')
}

/** 递归列出生产构建目录文件，用于与每个平台的 app.asar 逐字节核对。 */
async function listFiles(directory, relativeDirectory = '') {
  const entries = await readdir(path.join(directory, relativeDirectory), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(directory, relativePath))
    else if (entry.isFile()) files.push(relativePath)
  }
  return files
}

/** 确认每个平台的应用归档都包含与当前 out/ 相同的生产构建文件。 */
async function verifyApplicationArchives() {
  if (artifactsOnly) {
    console.log('说明：仅安装包验证跳过 ASAR 与生产构建目录比对。')
    return
  }
  const archives = applicationArchives().map((item) => item.path)
  const currentFiles = await listFiles(path.join(projectRoot, 'out'))
  assert.ok(currentFiles.length > 0, '生产构建目录 out/ 不能为空。')

  for (const archive of archives) {
    try {
      const entries = new Set(listPackage(archive).map((entry) => entry.replace(/^\//, '')))
      for (const relativePath of currentFiles) {
        const archiveEntry = `out/${relativePath.split(path.sep).join('/')}`
        assert.ok(entries.has(archiveEntry), `${archive} 缺少 ${archiveEntry}。`)
        assert.ok(
          extractFile(archive, archiveEntry).equals(readFileSync(path.join(projectRoot, 'out', relativePath))),
          `${archive} 中的 ${archiveEntry} 与当前构建不一致。`
        )
      }
    } finally {
      // ASAR 解析器会缓存完整文件树；逐平台释放，避免三份 48 MiB 归档同时占用内存。
      uncache(archive)
    }
  }
  console.log(`通过：${archives.length} 个 ASAR 中的 ${currentFiles.length} 个生产构建文件均与 out/ 逐字节一致。`)
}

/** 为当前选择列出应用归档。 */
function applicationArchives() {
  const values = [
    { platform: 'mac', path: path.join(releaseDirectory, 'mac-arm64', `${productName}.app`, 'Contents', 'Resources', 'app.asar') },
    { platform: 'win', path: path.join(releaseDirectory, 'win-unpacked', 'resources', 'app.asar') },
    { platform: 'linux', path: path.join(releaseDirectory, 'linux-unpacked', 'resources', 'app.asar') }
  ]
  return values.filter((item) => selectedPlatform === 'all' || item.platform === selectedPlatform)
}

/** 验证所选平台运行时关闭 Node 注入、启用 ASAR 校验并只从 ASAR 加载应用。 */
async function verifyElectronFuses() {
  if (artifactsOnly) {
    console.log('说明：仅安装包验证跳过 Electron Fuse 检查。')
    return
  }
  const binaries = [
    { platform: 'mac', path: path.join(releaseDirectory, 'mac-arm64', `${productName}.app`) },
    { platform: 'win', path: path.join(releaseDirectory, 'win-unpacked', `${productName}.exe`) },
    { platform: 'linux', path: path.join(releaseDirectory, 'linux-unpacked', packageJson.desktopName) }
  ].filter((item) => selectedPlatform === 'all' || item.platform === selectedPlatform)
  const expected = [
    [FuseV1Options.RunAsNode, false],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, false],
    [FuseV1Options.EnableNodeCliInspectArguments, false],
    [FuseV1Options.EnableCookieEncryption, false],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, true],
    [FuseV1Options.OnlyLoadAppFromAsar, true]
  ]

  for (const binary of binaries) {
    const config = await getCurrentFuseWire(binary.path)
    assert.equal(config.version, '1', `${binary.path} 使用了未识别的 Fuse 版本。`)
    for (const [option, enabled] of expected) {
      assert.equal(config[option], enabled ? FUSE_ENABLED : FUSE_DISABLED, `${binary.path} 的 ${FuseV1Options[option]} 状态不正确。`)
    }
  }
  console.log(`通过：${selectedPlatform} Electron Fuse 符合 electron-builder.yml。`)
}

/** 根据安装包后缀识别平台，供平台范围检查使用。 */
function packagePlatform(name) {
  if (name.endsWith('-arm64-mac.zip') || name.endsWith('-arm64.dmg')) return 'mac'
  if (name.endsWith('.exe') || name.endsWith('-win.zip')) return 'win'
  if (name.endsWith('.AppImage')) return 'linux'
  return null
}

await verifyChecksums()
verifyContainers()
verifyMacSignature()
await verifyApplicationArchives()
await verifyElectronFuses()
