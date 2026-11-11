/** 为指定发布目录中的安装包生成 SHA-256 校验清单。 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { candidateOutputDirectory, candidateOutputDirectoryName } from './candidate-output.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requestedDirectoryName = process.argv[2]
const releaseDirectoryName = requestedDirectoryName === 'release'
  ? 'release'
  : requestedDirectoryName
    ? candidateOutputDirectoryName({ TRIPWISE_CANDIDATE_OUTPUT: requestedDirectoryName })
    : process.env.TRIPWISE_CANDIDATE_OUTPUT
      ? candidateOutputDirectoryName(process.env)
      : 'release'

if (process.argv.length > 3) {
  throw new Error('用法：node scripts/update-package-checksums.mjs [release|release-candidate[-name]]。')
}

const releaseDirectory = releaseDirectoryName === 'release'
  ? path.join(projectRoot, releaseDirectoryName)
  : candidateOutputDirectory(projectRoot, { TRIPWISE_CANDIDATE_OUTPUT: releaseDirectoryName })
const manifestPath = path.join(releaseDirectory, 'SHA256SUMS')
const distributableExtensions = new Set(['.AppImage', '.dmg', '.exe', '.zip'])

/** 流式计算大安装包的摘要，避免把完整文件读入内存。 */
async function sha256(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

/** 按文件名稳定排序，清单只包含可分发的安装包，不包含 blockmap。 */
async function writeChecksums() {
  const entries = await readdir(releaseDirectory, { withFileTypes: true })
  const packages = entries
    .filter((entry) => entry.isFile() && distributableExtensions.has(path.extname(entry.name)))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'))

  if (packages.length === 0) throw new Error(`${releaseDirectoryName} 目录中没有可校验的安装包。`)

  const lines = await Promise.all(packages.map(async (name) => `${await sha256(path.join(releaseDirectory, name))}  ${name}`))
  await writeFile(manifestPath, `${lines.join('\n')}\n`, 'utf8')
}

await writeChecksums()
