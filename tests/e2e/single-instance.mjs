/** 用隔离 Electron 资料验证重复启动会退出并保留唯一主窗口。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const profileDirectory = await mkdtemp(join(tmpdir(), 'tripwise-single-instance-e2e-'))
const singleInstanceTestId = `${process.pid}-${randomUUID().replace(/-/gu, '')}`
const require = createRequire(import.meta.url)
const electronBinary = require('electron')
const environment = {
  ...process.env,
  TRIPWISE_E2E_HEADLESS: '1',
  TRIPWISE_E2E_USER_DATA_DIR: profileDirectory,
  TRIPWISE_E2E_SINGLE_INSTANCE_ID: singleInstanceTestId
}
let primary
let duplicate

try {
  assert.equal(typeof electronBinary, 'string', '应取得当前平台 Electron 可执行文件。')
  primary = await electron.launch({
    args: ['--disable-gpu', projectRoot],
    env: environment,
    timeout: 30_000
  })
  const page = await primary.firstWindow()
  await page.getByRole('button', { name: '新建旅行', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })

  duplicate = spawn(electronBinary, ['--disable-gpu', projectRoot], { env: environment, stdio: 'ignore' })
  const duplicateExit = await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      duplicate.kill()
      rejectExit(new Error('重复启动进程未在 10 秒内退出。'))
    }, 10_000)
    duplicate.once('error', (error) => {
      clearTimeout(timeout)
      rejectExit(error)
    })
    duplicate.once('close', (code, signal) => {
      clearTimeout(timeout)
      resolveExit({ code, signal })
    })
  })

  assert.deepEqual(duplicateExit, { code: 0, signal: null }, '不持有实例锁的第二进程应正常退出。')
  assert.equal((await primary.windows()).length, 1, '重复启动不得再创建一份旅行窗口。')
  await page.getByRole('button', { name: '新建旅行', exact: true }).waitFor({ state: 'visible' })
  process.stdout.write('通过：重复启动退出，现有旅行窗口继续可用。\n')
} finally {
  if (duplicate && duplicate.exitCode === null && duplicate.signalCode === null) {
    duplicate.kill()
    await once(duplicate, 'close').catch(() => undefined)
  }
  if (primary) await primary.close().catch(() => undefined)
  await rm(profileDirectory, { recursive: true, force: true })
}
