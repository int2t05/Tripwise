/** 启动显式选择的真实旅行评测案例，不接受或回显任何凭证参数。 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDirectory = fileURLToPath(new URL('../', import.meta.url))
const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const selection = parseArguments(process.argv.slice(2))
if (selection.help) {
  process.stdout.write('用法：npm run evaluate:travel:live -- --case TW-01 [--case TW-17] [--artifacts 目录]\n       npm run evaluate:travel:live -- --all [--artifacts 目录]\n')
  process.exit(0)
}
if (!selection.all && selection.caseIds.length === 0) {
  process.stderr.write('请用 --case 指定案例；确认需要完整长时间实跑时再用 --all。\n')
  process.exit(2)
}

const environment = {
  ...process.env,
  TRIPWISE_TRAVEL_LIVE_EVAL: '1',
  TRIPWISE_TRAVEL_EVAL_CASES: selection.all ? 'all' : selection.caseIds.join(','),
  ...(selection.artifactDirectory
    ? { TRIPWISE_TRAVEL_EVAL_ARTIFACT_DIR: resolve(selection.artifactDirectory) }
    : {})
}
const child = spawn(process.execPath, [vitestCli, 'run', 'tests/travel-evaluation.manual.test.ts', '--reporter=verbose'], {
  cwd: rootDirectory,
  env: environment,
  stdio: 'inherit'
})

child.once('error', () => {
  process.stderr.write('无法启动旅行评测进程。\n')
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})

/** 解析严格白名单参数，避免意外把凭证或任意测试参数传给子进程。 */
function parseArguments(argumentsList) {
  const result = { all: false, caseIds: [], artifactDirectory: '', help: false }
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === '--help' || argument === '-h') {
      result.help = true
      continue
    }
    if (argument === '--all') {
      result.all = true
      continue
    }
    if (argument === '--case') {
      const id = argumentsList[++index]
      if (!id || !/^TW-(?:0[1-9]|[12]\d|30)$/.test(id)) throw new Error('案例编号必须是 TW-01 至 TW-30。')
      result.caseIds.push(id)
      continue
    }
    if (argument === '--artifacts') {
      const directory = argumentsList[++index]
      if (!directory || directory.startsWith('-')) throw new Error('--artifacts 需要一个目录路径。')
      result.artifactDirectory = directory
      continue
    }
    throw new Error(`不支持的评测参数：${argument}`)
  }
  if (result.all && result.caseIds.length) throw new Error('--all 不能与 --case 同时使用。')
  if (new Set(result.caseIds).size !== result.caseIds.length) throw new Error('案例编号不能重复。')
  return result
}
