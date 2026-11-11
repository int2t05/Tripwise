/** 按候选输出目录启动 macOS 打包版桌面 E2E。 */
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { candidateOutputDirectory } from './candidate-output.mjs'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 复用同一套桌面流程，避免测试固定绑定到某个候选目录。 */
function main() {
  if (process.platform !== 'darwin') throw new Error('macOS 打包版 E2E 只能在 macOS 构建机运行。')
  const application = join(candidateOutputDirectory(projectRoot), 'mac-arm64', '行程有数.app')
  const executable = join(application, 'Contents', 'MacOS', '行程有数')
  const testFile = join(projectRoot, 'tests', 'e2e', 'desktop-workspace.mjs')
  const result = spawnSync(process.execPath, [testFile], {
    cwd: projectRoot,
    env: { ...process.env, TRIPWISE_E2E_EXECUTABLE: executable },
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}

main()
