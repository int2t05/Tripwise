/** 以校验过的本机 Electron 归档复用缓存，并串行执行候选包的完整构建门禁。 */
import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { candidateOutputDirectory, candidateOutputDirectoryName } from './candidate-output.mjs'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const candidateDirectoryName = candidateOutputDirectoryName()
const candidateDirectory = candidateOutputDirectory(projectRoot)
const distributableExtensions = new Set(['.AppImage', '.dmg', '.exe', '.zip'])
const platforms = {
  mac: { name: 'macOS arm64', archivePlatform: 'darwin', archiveArch: 'arm64', args: ['--mac', '--arm64'] },
  win: { name: 'Windows x64', archivePlatform: 'win32', archiveArch: 'x64', args: ['--win', '--x64'] },
  linux: { name: 'Linux x64', archivePlatform: 'linux', archiveArch: 'x64', args: ['--linux', '--x64'] }
}

/** 在受限目录深度内查找指定归档，避免遍历用户的整个缓存目录。 */
async function findArchiveFiles(directory, filename, depth, found) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error?.code)) return
    throw error
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isFile() && entry.name === filename) found.push(path)
    else if (depth > 0 && entry.isDirectory()) await findArchiveFiles(path, filename, depth - 1, found)
  }
}

/** 从 Electron 缓存中返回 SHA-256 与当前锁定 Electron 版本匹配的发行归档。 */
export async function findVerifiedElectronArchive(cacheDirectories, filename, expectedHash) {
  if (!/^[a-f\d]{64}$/i.test(expectedHash)) throw new Error('Electron 运行时校验值格式无效。')
  const candidates = []
  for (const directory of [...new Set(cacheDirectories)]) {
    await findArchiveFiles(directory, filename, 3, candidates)
  }

  const mismatched = []
  for (const path of candidates) {
    const digest = await hashFile(path)
    if (digest.toLowerCase() === expectedHash.toLowerCase()) return path
    mismatched.push(path)
  }
  if (mismatched.length) {
    throw new Error(`Electron 本机缓存 ${filename} 与官方校验值不匹配；请删除该缓存归档后重试。`)
  }
  return undefined
}

/** 对大文件按流计算摘要，避免把平台 Electron 归档整体读入内存。 */
function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const digest = createHash('sha256')
    const input = createReadStream(path)
    input.on('error', reject)
    input.on('data', (chunk) => digest.update(chunk))
    input.on('end', () => resolveHash(digest.digest('hex')))
  })
}

/** 按 Electron 下载器常见缓存位置列出候选目录；显式环境变量优先。 */
export function electronCacheDirectories({ platform, home, env }) {
  const directories = []
  if (env.ELECTRON_CACHE) directories.push(env.ELECTRON_CACHE)
  if (platform === 'darwin') directories.push(join(home, 'Library', 'Caches', 'electron'))
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) directories.push(join(env.LOCALAPPDATA, 'electron', 'Cache'))
    directories.push(join(home, 'AppData', 'Local', 'electron', 'Cache'))
  }
  if (platform === 'linux') {
    directories.push(join(env.XDG_CACHE_HOME || join(home, '.cache'), 'electron'))
    if (env.XDG_CACHE_HOME) directories.push(join(home, '.cache', 'electron'))
  }
  if (platform !== 'linux') directories.push(join(home, '.cache', 'electron'))
  return [...new Set(directories.map((directory) => resolve(directory)))]
}

/** 显式稳定签名开关或标准证书配置会启用 Developer ID 签名路径。 */
export function stableMacSigningRequested(env) {
  return env.TRIPWISE_MAC_STABLE_SIGNING === '1' || Boolean(env.CSC_NAME || env.CSC_LINK)
}

/** 从项目锁定的 Electron manifest 和官方 checksums 文件解析目标归档。 */
async function resolveRuntimeArchive(target, env = process.env) {
  const electronDirectory = join(projectRoot, 'node_modules', 'electron')
  const electronPackage = JSON.parse(await readFile(join(electronDirectory, 'package.json'), 'utf8'))
  const filename = `electron-v${electronPackage.version}-${target.archivePlatform}-${target.archiveArch}.zip`
  const checksums = JSON.parse(await readFile(join(electronDirectory, 'checksums.json'), 'utf8'))
  const expectedHash = checksums[filename]
  if (!expectedHash) throw new Error(`Electron 当前版本没有 ${filename} 的官方校验值。`)

  const directories = electronCacheDirectories({ platform: process.platform, home: homedir(), env })
  const archive = await findVerifiedElectronArchive(directories, filename, expectedHash)
  if (archive) {
    console.log(`复用校验通过的 Electron ${electronPackage.version} ${target.name} 运行时：${basename(archive)}`)
  } else {
    console.log(`未发现 Electron ${electronPackage.version} ${target.name} 本机缓存，electron-builder 将按当前网络配置下载。`)
  }
  return archive
}

/** 运行固定的构建步骤并让子进程日志直接显示，失败时立即停止后续步骤。 */
async function run(command, args, label, env = process.env) {
  console.log(`\n${label}`)
  await new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, env, stdio: 'inherit' })
    const stopChild = () => child.kill('SIGINT')
    process.once('SIGINT', stopChild)
    child.once('error', (error) => {
      process.removeListener('SIGINT', stopChild)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      process.removeListener('SIGINT', stopChild)
      if (code === 0) resolveExit()
      else reject(new Error(`${label}失败：${signal ? `收到 ${signal}` : `退出码 ${code}`}`))
    })
  })
}

/** 用当前 npm 所带 Node CLI 运行项目脚本，兼容 macOS、Windows 与 Linux。 */
async function runNpmScript(name, args = [], env = process.env) {
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error('请通过 npm run 调用候选包脚本，以使用当前锁定的 npm 环境。')
  await run(process.execPath, [npmCli, 'run', name, ...args], `npm run ${name}`, env)
}

/** 拒绝覆盖已有候选，避免把旧安装包或人工文件静默清空。 */
export async function assertCandidateOutputAvailable(directory) {
  try {
    await lstat(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(`候选输出目录已存在，未覆盖任何文件：${basename(directory)}`)
}

/** 解析并校验构建阶段生成的安装包清单，只允许发布项与 SHA256SUMS。 */
function candidateManifestEntries(manifest) {
  const lines = manifest.split(/\r?\n/u)
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) throw new Error('SHA256SUMS 为空，不能发布候选包。')

  const entries = lines.map((line) => {
    const match = line.match(/^([a-f\d]{64})  ([^/\\\r\n]+)$/u)
    if (!match || !distributableExtensions.has(extname(match[2]))) {
      throw new Error('SHA256SUMS 含无效摘要或非安装包文件名。')
    }
    return { digest: match[1], name: match[2] }
  })
  const names = entries.map((entry) => entry.name)
  if (new Set(names).size !== names.length) throw new Error('SHA256SUMS 含重复安装包。')
  if (names.slice().sort((left, right) => left.localeCompare(right, 'en')).join('\n') !== names.join('\n')) {
    throw new Error('SHA256SUMS 安装包顺序无效。')
  }
  return entries
}

/** 发布前先验构建清单，复制安装包时保留执行权限并清除失败的半成品目录。 */
export async function publishCandidateArtifacts(stagingDirectory, destinationDirectory) {
  const manifest = await readFile(join(stagingDirectory, 'SHA256SUMS'), 'utf8')
  const artifacts = candidateManifestEntries(manifest)
  const stagingEntries = new Map((await readdir(stagingDirectory, { withFileTypes: true })).map((entry) => [entry.name, entry]))

  for (const artifact of artifacts) {
    const entry = stagingEntries.get(artifact.name)
    if (!entry?.isFile()) throw new Error(`构建暂存目录缺少安装包：${artifact.name}`)
    if ((await hashFile(join(stagingDirectory, artifact.name))).toLowerCase() !== artifact.digest) {
      throw new Error(`构建暂存安装包与 SHA256SUMS 不匹配：${artifact.name}`)
    }
  }

  await assertCandidateOutputAvailable(destinationDirectory)
  await mkdir(destinationDirectory)
  try {
    for (const artifact of artifacts) {
      const source = join(stagingDirectory, artifact.name)
      const destination = join(destinationDirectory, artifact.name)
      const sourceMode = (await stat(source)).mode & 0o777
      await copyFile(source, destination)
      await chmod(destination, sourceMode)
    }
    await copyFile(join(stagingDirectory, 'SHA256SUMS'), join(destinationDirectory, 'SHA256SUMS'))

    const outputNames = (await readdir(destinationDirectory)).sort((left, right) => left.localeCompare(right, 'en'))
    const expectedNames = [...artifacts.map((artifact) => artifact.name), 'SHA256SUMS'].sort((left, right) => left.localeCompare(right, 'en'))
    if (outputNames.join('\n') !== expectedNames.join('\n')) throw new Error('候选输出目录含非交付文件。')
    for (const artifact of artifacts) {
      if ((await hashFile(join(destinationDirectory, artifact.name))).toLowerCase() !== artifact.digest) {
        throw new Error(`发布安装包与 SHA256SUMS 不匹配：${artifact.name}`)
      }
    }
    if (await readFile(join(destinationDirectory, 'SHA256SUMS'), 'utf8') !== manifest) {
      throw new Error('发布后的 SHA256SUMS 与构建暂存清单不一致。')
    }
    console.log(`通过：发布 ${artifacts.length} 个安装包；输出目录仅保留安装包和 SHA256SUMS。`)
  } catch (error) {
    await rm(destinationDirectory, { recursive: true, force: true })
    throw error
  }
}

/** 删除 electron-builder 留下的图标缓存、调试清单和更新差分文件。 */
export async function cleanCandidateBuildResidue(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const residue = entries.filter((entry) =>
    entry.name === '.icon-icns' ||
    entry.name === '.icon-ico' ||
    entry.name === 'builder-debug.yml' ||
    (entry.isFile() && entry.name.endsWith('.blockmap')) ||
    (entry.isFile() && entry.name.startsWith('.temp') && /\.(?:dmg|zip)$/iu.test(entry.name))
  )

  await Promise.all(residue.map((entry) =>
    rm(join(directory, entry.name), { recursive: entry.isDirectory(), force: true })
  ))
  if (residue.length) console.log(`已清理 ${residue.length} 个打包中间文件。`)
}

/** 直接调用项目锁定的 electron-builder CLI，避免 PATH 意外解析到全局版本。 */
async function buildTarget(key, outputDirectoryName, outputDirectory, env) {
  const target = platforms[key]
  const archive = await resolveRuntimeArchive(target, env)
  const args = [...target.args, `--config.directories.output=${outputDirectoryName}`]
  if (archive) args.push(`--config.electronDist=${archive}`)
  const builderCli = join(projectRoot, 'node_modules', 'electron-builder', 'cli.js')

  if (key === 'mac') {
    const stableSigning = stableMacSigningRequested(env)
    const macConfig = join(projectRoot, stableSigning ? 'electron-builder.yml' : 'electron-builder-candidate-mac.yml')
    const buildArguments = [builderCli, ...target.args, '--dir', `--config=${macConfig}`, ...args.slice(2)]
    await run(process.execPath, buildArguments, `构建${stableSigning ? '稳定签名' : '本机预览'} ${target.name} 应用目录`, env)

    const appDirectory = join(outputDirectory, 'mac-arm64')
    const appPath = await findMacApplication(appDirectory)
    if (stableSigning) {
      await verifyStableMacSignature(appPath)
    } else {
      await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], '为 macOS 本机预览应用执行 ad-hoc 签名', env)
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], '验证 macOS ad-hoc 签名', env)
    }

    await run(
      process.execPath,
      [builderCli, ...target.args, '--prepackaged', appPath, `--config=${macConfig}`, ...args.slice(2)],
      `打包已签名 ${target.name} 安装文件`,
      env
    )
    return
  }

  await run(process.execPath, [builderCli, ...args], `构建 ${target.name} 候选包`, env)
  return undefined
}

/** 稳定签名模式必须使用带 Team ID 的证书，避免静默退回 ad-hoc。 */
async function verifyStableMacSignature(appPath) {
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], '验证 macOS 稳定签名')
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', appPath], { encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error('无法读取 macOS 稳定签名信息。')
  const details = `${result.stderr}${result.stdout}`
  if (/Signature=adhoc|TeamIdentifier=not set/.test(details)) {
    throw new Error('稳定签名模式没有生成带 Team ID 的签名；请检查 Developer ID 证书配置。')
  }
  console.log('通过：macOS 应用使用带 Team ID 的稳定签名。')
}

/** 从 macOS 打包目录中定位唯一的应用 bundle，避免依赖展示名称。 */
async function findMacApplication(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const applications = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
  if (applications.length !== 1) {
    throw new Error(`macOS 应用目录应恰有一个 .app，实际找到 ${applications.length} 个。`)
  }
  return join(directory, applications[0].name)
}

/** 执行单平台或三平台流程，确保每种模式都有对应测试与完整性门禁。 */
async function packageCandidate(selection) {
  if (selection !== 'all' && !Object.hasOwn(platforms, selection)) {
    throw new Error('用法：npm run package:candidate:{mac|win|linux|all}')
  }
  await assertCandidateOutputAvailable(candidateDirectory)
  await runNpmScript('check')

  const targets = selection === 'all' ? Object.keys(platforms) : [selection]
  if (selection === 'all') {
    await run(process.execPath, [join(projectRoot, 'tests', 'e2e', 'desktop-workspace.mjs')], '开发版桌面端到端冒烟')
    await run(process.execPath, [join(projectRoot, 'tests', 'e2e', 'single-instance.mjs')], '单实例启动端到端验证')
  }

  const stagingDirectoryName = `release-candidate-stage-${process.pid}-${randomUUID().slice(0, 8)}`
  const stagingDirectory = candidateOutputDirectory(projectRoot, { TRIPWISE_CANDIDATE_OUTPUT: stagingDirectoryName })
  const stagingEnvironment = { ...process.env, TRIPWISE_CANDIDATE_OUTPUT: stagingDirectoryName }
  await mkdir(stagingDirectory)
  try {
    for (const target of targets) {
      await buildTarget(target, stagingDirectoryName, stagingDirectory, stagingEnvironment)
      if (target === 'mac') await runNpmScript('test:e2e:packaged:mac', [], stagingEnvironment)
    }

    await cleanCandidateBuildResidue(stagingDirectory)
    await runNpmScript('checksums', ['--', stagingDirectoryName], stagingEnvironment)
    await runNpmScript(selection === 'all' ? 'verify:candidate' : `verify:candidate:${selection}`, [], stagingEnvironment)

    await publishCandidateArtifacts(stagingDirectory, candidateDirectory)
    const destinationEnvironment = { ...process.env, TRIPWISE_CANDIDATE_OUTPUT: candidateDirectoryName }
    const platformArgs = selection === 'all' ? [] : ['--', `--platform=${selection}`]
    await runNpmScript('verify:candidate:artifacts', platformArgs, destinationEnvironment)
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true })
    console.log('已清理构建暂存目录。')
  }
}

/** 通过 npm script 参数启动，以一处定义维护所有候选包构建顺序。 */
async function main() {
  const selection = process.argv[2]
  await packageCandidate(selection)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : '未知构建错误。'
    console.error(`候选包流程已停止：${message}`)
    process.exitCode = 1
  })
}
