/** 验证候选构建只复用与 Electron 官方摘要一致的本机运行时归档。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { candidateOutputDirectory, candidateOutputDirectoryName } from './candidate-output.mjs'
import {
  cleanCandidateBuildResidue,
  electronCacheDirectories,
  findVerifiedElectronArchive,
  publishCandidateArtifacts,
  stableMacSigningRequested
} from './package-candidate-all.mjs'

const temporaryDirectories = []

/** 为各用例创建独立缓存目录，并在结束时清理。 */
async function createCacheDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'tripwise-electron-cache-'))
  temporaryDirectories.push(directory)
  return directory
}

/** 构造最小候选暂存目录，覆盖名称、摘要和执行权限保留。 */
async function createCandidateArtifactFixture(root) {
  const staging = join(root, 'staging')
  await mkdir(staging)
  const files = [
    { name: '行程有数 Setup 0.1.0.exe', content: 'windows installer' },
    { name: '行程有数-0.1.0.AppImage', content: 'linux executable' }
  ]
  for (const file of files) await writeFile(join(staging, file.name), file.content)
  await chmod(join(staging, '行程有数-0.1.0.AppImage'), 0o755)
  await mkdir(join(staging, 'linux-unpacked'))
  const lines = files
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    .map((file) => `${createHash('sha256').update(file.content).digest('hex')}  ${file.name}`)
  await writeFile(join(staging, 'SHA256SUMS'), `${lines.join('\n')}\n`)
  return { staging, files }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Electron 本机运行时缓存', () => {
  it('递归复用内容与官方摘要一致的归档', async () => {
    const cache = await createCacheDirectory()
    const nested = join(cache, 'electron-cache-key')
    await mkdir(nested)
    const archive = join(nested, 'electron-v44.9.0-darwin-arm64.zip')
    const content = Buffer.from('verified-electron-runtime')
    await writeFile(archive, content)
    const expectedHash = createHash('sha256').update(content).digest('hex')

    assert.equal(await findVerifiedElectronArchive([cache], 'electron-v44.9.0-darwin-arm64.zip', expectedHash), archive)
  })

  it('发现缓存归档但摘要不匹配时明确失败', async () => {
    const cache = await createCacheDirectory()
    const archive = join(cache, 'electron-v44.9.0-win32-x64.zip')
    await writeFile(archive, 'corrupted-runtime')

    await assert.rejects(
      findVerifiedElectronArchive([cache], 'electron-v44.9.0-win32-x64.zip', 'a'.repeat(64)),
      /官方校验值不匹配/
    )
  })

  it('缓存中没有目标归档时返回未命中供下载逻辑处理', async () => {
    const cache = await createCacheDirectory()

    assert.equal(await findVerifiedElectronArchive([cache], 'electron-v44.9.0-linux-x64.zip', 'b'.repeat(64)), undefined)
  })

  it('按平台和环境变量生成去重后的缓存位置', () => {
    const macDefault = join('/home/tester', 'Library', 'Caches', 'electron')
    assert.deepEqual(electronCacheDirectories({
      platform: 'darwin',
      home: '/home/tester',
      env: { ELECTRON_CACHE: macDefault }
    }), [macDefault, '/home/tester/.cache/electron'])
    assert.deepEqual(electronCacheDirectories({
      platform: 'linux',
      home: '/home/tester',
      env: { XDG_CACHE_HOME: '/tmp/cache' }
    }), ['/tmp/cache/electron', '/home/tester/.cache/electron'])

    const windowsHome = tmpdir()
    const localAppData = join(windowsHome, 'local-app-data')
    assert.deepEqual(electronCacheDirectories({
      platform: 'win32',
      home: windowsHome,
      env: { LOCALAPPDATA: localAppData }
    }), [
      resolve(join(localAppData, 'electron', 'Cache')),
      resolve(join(windowsHome, 'AppData', 'Local', 'electron', 'Cache')),
      resolve(join(windowsHome, '.cache', 'electron'))
    ])
  })

})

describe('macOS 稳定签名选择', () => {
  it('默认保留本机预览，配置标准证书或显式开关时启用稳定签名', () => {
    assert.equal(stableMacSigningRequested({}), false)
    assert.equal(stableMacSigningRequested({ TRIPWISE_MAC_STABLE_SIGNING: '0' }), false)
    assert.equal(stableMacSigningRequested({ TRIPWISE_MAC_STABLE_SIGNING: '1' }), true)
    assert.equal(stableMacSigningRequested({ CSC_NAME: 'Developer ID Application' }), true)
    assert.equal(stableMacSigningRequested({ CSC_LINK: '/temporary/certificate.p12' }), true)
  })
})

describe('候选包输出目录', () => {
  it('默认使用候选目录，并允许同级的独立候选目录', () => {
    assert.equal(candidateOutputDirectoryName({}), 'release-candidate-current')
    assert.equal(candidateOutputDirectoryName({ TRIPWISE_CANDIDATE_OUTPUT: 'release-candidate-copy-review' }), 'release-candidate-copy-review')
    assert.equal(candidateOutputDirectory('/project', { TRIPWISE_CANDIDATE_OUTPUT: 'release-candidate-copy-review' }), '/project/release-candidate-copy-review')
  })

  it('拒绝绝对路径、目录穿越和非候选目录名', () => {
    for (const value of ['/tmp/release-candidate', '../release', 'release', 'release-candidate/next']) {
      assert.throws(() => candidateOutputDirectoryName({ TRIPWISE_CANDIDATE_OUTPUT: value }), /候选输出目录只能/)
    }
  })

  it('GitHub 桌面矩阵把打包、E2E 与 artifact 上传固定到同一输出目录', async () => {
    const workflowPath = new URL('../.github/workflows/desktop.yml', import.meta.url)
    const workflow = await readFile(workflowPath, 'utf8')
    const jobStart = workflow.indexOf('  desktop:\n')
    const stepsStart = workflow.indexOf('    steps:\n', jobStart)
    assert.notEqual(jobStart, -1)
    assert.notEqual(stepsStart, -1)

    const jobConfiguration = workflow.slice(jobStart, stepsStart)
    assert.match(jobConfiguration, /^    env:\n      TRIPWISE_CANDIDATE_OUTPUT: release-candidate\n/mu)
    assert.equal(candidateOutputDirectoryName({ TRIPWISE_CANDIDATE_OUTPUT: 'release-candidate' }), 'release-candidate')
    assert.match(jobConfiguration, /executable: release-candidate\//u)
    assert.match(jobConfiguration, /artifact_paths:[\s\S]*?release-candidate\//u)
  })
})

describe('候选包构建残留清理', () => {
  it('清理图标缓存、调试清单和更新差分文件，保留安装包与验证目录', async () => {
    const output = await createCacheDirectory()
    const iconCache = join(output, '.icon-icns')
    await mkdir(iconCache)
    await writeFile(join(iconCache, 'icon.icns'), 'temporary icon')
    await writeFile(join(output, 'preview.zip.blockmap'), 'update metadata')
    await writeFile(join(output, 'builder-debug.yml'), 'temporary builder patterns')
    await writeFile(join(output, '.temp-preview.dmg'), 'interrupted installer')
    await writeFile(join(output, 'preview.dmg'), 'installer')
    await mkdir(join(output, 'mac-arm64'))

    await cleanCandidateBuildResidue(output)

    await assert.rejects(access(iconCache))
    await assert.rejects(access(join(output, 'preview.zip.blockmap')))
    await assert.rejects(access(join(output, 'builder-debug.yml')))
    await assert.rejects(access(join(output, '.temp-preview.dmg')))
    await access(join(output, 'preview.dmg'))
    await access(join(output, 'mac-arm64'))
  })
})

describe('候选安装包发布', () => {
  it('只复制安装包与校验清单，并保留 Linux 安装包的执行权限', async () => {
    const root = await createCacheDirectory()
    const { staging, files } = await createCandidateArtifactFixture(root)
    const destination = join(root, 'release-candidate-slim')

    await publishCandidateArtifacts(staging, destination)

    const expectedNames = [...files.map((file) => file.name), 'SHA256SUMS'].sort((left, right) => left.localeCompare(right, 'en'))
    assert.deepEqual(await readdir(destination), expectedNames)
    assert.equal((await stat(join(destination, '行程有数-0.1.0.AppImage'))).mode & 0o777, 0o755)
  })

  it('拒绝覆盖已经存在的候选目录', async () => {
    const root = await createCacheDirectory()
    const { staging } = await createCandidateArtifactFixture(root)
    const destination = join(root, 'release-candidate-preserve')
    await mkdir(destination)
    await writeFile(join(destination, 'keep.txt'), 'existing output')

    await assert.rejects(publishCandidateArtifacts(staging, destination), /未覆盖任何文件/u)
    assert.equal(await readFile(join(destination, 'keep.txt'), 'utf8'), 'existing output')
  })

  it('发现暂存包摘要不匹配时不创建发布目录', async () => {
    const root = await createCacheDirectory()
    const { staging, files } = await createCandidateArtifactFixture(root)
    const destination = join(root, 'release-candidate-invalid')
    await writeFile(join(staging, files[0].name), 'tampered installer')

    await assert.rejects(publishCandidateArtifacts(staging, destination), /与 SHA256SUMS 不匹配/u)
    await assert.rejects(access(destination))
  })
})
