/** 使用本机假 JSONL 服务验证 Codex 持久话题，不访问模型或用户凭证。 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexAppServer, CodexAppServerError, codexFailureLogFields, type CodexTurnRequest } from '../src/main/codex-app-server.js'
import { OpenAiCompatibleClient, parseCodexOutput } from '../src/main/llm.js'

const { logSystemEventMock } = vi.hoisted(() => ({ logSystemEventMock: vi.fn() }))
vi.mock('../src/main/system-logger.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/system-logger.js')>(),
  logSystemEvent: logSystemEventMock
}))

const fakeServer = String.raw`
const fs = require('node:fs')
const args = JSON.parse(process.env.TRIPWISE_FAKE_ARGS || '[]')
const logPath = process.env.TRIPWISE_FAKE_LOG
const mode = process.env.TRIPWISE_FAKE_MODE || 'normal'
let input = ''
let turnNumber = 0
let threadNumber = 0
function record(value) { fs.appendFileSync(logPath, JSON.stringify(value) + '\n') }
function totalTurnStarts() {
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(line => {
    try { const entry = JSON.parse(line); return entry.event === 'request' && entry.method === 'turn/start' }
    catch { return false }
  }).length
}
function send(value) { process.stdout.write(JSON.stringify(value) + '\n') }
function respond(id, result) { send({ id, result }) }
record({ event: 'spawn', args })
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
  let end
  while ((end = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, end)
    input = input.slice(end + 1)
    if (!line) continue
    const request = JSON.parse(line)
    record({ event: 'request', method: request.method, params: request.params })
    if (request.method === 'initialize') respond(request.id, {})
    else if (request.method === 'initialized') continue
    else if (request.method === 'config/read') {
      const disabled = new Set(args.flatMap((value, index) => value === '--disable' ? [args[index + 1]] : []))
      const features = Object.fromEntries([
        'shell_tool', 'unified_exec', 'unified_exec_tty', 'code_mode', 'code_mode_host', 'code_mode_only',
        'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'view_image',
        'image_generation', 'multi_agent', 'plugins', 'apps', 'in_app_browser', 'mentions_v2'
      ].map(name => [name, !disabled.has(name)]))
      const mcpEnabled = !args.some(value => value === 'mcp_servers.sample.enabled=false')
      respond(request.id, { config: { mcp_servers: { sample: { enabled: mcpEnabled } }, features } })
    } else if (request.method === 'model/list') {
      respond(request.id, { data: [{ id: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'max' }] }] })
    } else if (request.method === 'thread/start') {
      threadNumber += 1
      respond(request.id, { thread: { id: 'thread-' + threadNumber } })
    } else if (request.method === 'thread/resume') {
      respond(request.id, { thread: { id: request.params.threadId } })
    } else if (request.method === 'thread/delete') respond(request.id, {})
    else if (request.method === 'turn/interrupt') {
      if (['interrupt-rejection-race', 'interrupt-no-active-turn'].includes(mode) && totalTurnStarts() === 1) {
        send({ id: request.id, error: { code: -32600, message: 'No active turn to interrupt' } })
        if (mode === 'interrupt-rejection-race') {
          setTimeout(() => send({ method: 'turn/completed', params: {
            threadId: request.params.threadId,
            turn: { id: 'turn-' + turnNumber, status: 'interrupted' }
          } }), 100)
        }
        continue
      }
      respond(request.id, {})
      if (mode === 'cancel-first-turn' && turnNumber === 1) setImmediate(() => send({
        method: 'turn/completed', params: {
          threadId: request.params.threadId,
          turn: { id: 'turn-' + turnNumber, status: 'interrupted' }
        }
      }))
    }
    else if (request.method === 'turn/start') {
      turnNumber += 1
      const turnId = 'turn-' + turnNumber
      if (mode === 'hang-first-turn-start' && totalTurnStarts() === 1) continue
      respond(request.id, { turn: { id: turnId } })
      if (mode === 'exit-first-turn' && totalTurnStarts() === 1) process.exit(17)
      if ((mode === 'fail-first-turn' || mode === 'fail-with-codex-error-info' ||
        mode === 'fail-with-new-codex-error-info' || mode === 'fail-with-quota-error-info') && totalTurnStarts() === 1) {
        setImmediate(() => send({ method: 'turn/completed', params: {
          threadId: request.params.threadId,
          turn: {
            id: turnId,
            status: 'failed',
            error: mode === 'fail-with-codex-error-info'
              ? {
                  message: 'private upstream response',
                  codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
                  additionalDetails: 'private diagnostic body'
                }
              : mode === 'fail-with-new-codex-error-info'
                ? {
                    message: 'private overloaded response',
                    codexErrorInfo: 'serverOverloaded',
                    additionalDetails: 'private provider detail'
                  }
              : mode === 'fail-with-quota-error-info'
                ? {
                    message: 'private account limit detail',
                    codexErrorInfo: { usageLimitExceeded: {} },
                    additionalDetails: 'private billing data'
                  }
              : { message: 'unclassified backend failure' }
          }
        } }))
        continue
      }
      if (['cancel-first-turn', 'interrupt-rejection-race', 'interrupt-no-active-turn'].includes(mode) && totalTurnStarts() === 1) continue
      if (mode === 'retry-notification' && totalTurnStarts() === 1) {
        setImmediate(() => {
          send({ method: 'error', params: {
            threadId: request.params.threadId,
            turnId,
            error: {
              message: 'private stream failure',
              codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
              additionalDetails: 'private provider details'
            },
            willRetry: true
          } })
          setTimeout(() => {
            const text = JSON.stringify({ type: 'message', content: 'ok', calls: [] })
            send({ method: 'item/agentMessage/delta', params: {
              threadId: request.params.threadId, turnId, itemId: 'item-' + turnNumber, delta: text
            } })
            send({ method: 'turn/completed', params: {
              threadId: request.params.threadId, turn: { id: turnId, status: 'completed' }
            } })
          }, 10)
        })
        continue
      }
      const text = JSON.stringify({ type: 'message', content: 'ok', calls: [] })
      setImmediate(() => {
        send({ method: 'item/agentMessage/delta', params: {
          threadId: request.params.threadId, turnId, itemId: 'item-' + turnNumber, delta: text
        } })
        send({ method: 'turn/completed', params: {
          threadId: request.params.threadId, turn: { id: turnId, status: 'completed' }
        } })
      })
    } else if (request.id !== undefined) send({ id: request.id, error: { code: -32601, message: 'unknown method' } })
  }
})
process.stdin.on('end', () => process.exit(0))
`

const activeServers: CodexAppServer[] = []

/** 生成统一协议请求，覆盖真实模型适配器向 App Server 发送的字段。 */
function request(overrides: Partial<CodexTurnRequest> = {}): CodexTurnRequest {
  return {
    conversationKey: 'trip-1:conversation-1',
    phase: 'run-start',
    fullPrompt: 'initial prompt',
    resumedPrompt: 'resumed prompt',
    continuationPrompt: 'continue prompt',
    outputSchema: { type: 'object' },
    timeoutMs: 5_000,
    ...overrides
  }
}

/** 创建只会将 JSONL 回执写到临时目录的模拟 Codex 进程。 */
function createServer(userData: string, logPath: string, mode = 'normal'): CodexAppServer {
  const server = new CodexAppServer(userData, {
    resolveExecutable: async () => 'fake-codex',
    spawnProcess: (_executable, args, options) => spawn(process.execPath, ['-e', fakeServer], {
      ...options,
      env: {
        ...options.env,
        TRIPWISE_FAKE_ARGS: JSON.stringify(args),
        TRIPWISE_FAKE_LOG: logPath,
        TRIPWISE_FAKE_MODE: mode
      }
    }) as ChildProcessWithoutNullStreams
  })
  activeServers.push(server)
  return server
}

/** 读取模拟协议记录；测试断言不依赖进程中的隐藏状态。 */
async function readRecords(path: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(path, 'utf8').catch(() => '')
  return content.split('\n').flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line)
      return value && typeof value === 'object' && !Array.isArray(value)
        ? [value as Record<string, unknown>]
        : []
    } catch {
      return []
    }
  })
}

/** 等待假 App Server 收到指定方法，避免在并发进程状态上使用固定延迟。 */
async function waitForRequest(path: string, method: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await readRecords(path)).some((entry) => entry.event === 'request' && entry.method === method)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待假 App Server 请求超时：${method}`)
}

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map((server) => server.close()))
  logSystemEventMock.mockClear()
})

describe('Codex App Server 持久话题', () => {
  it('把内部连接失败转成脱敏、可排查的请求日志字段', () => {
    expect(codexFailureLogFields(new CodexAppServerError('network', -32600))).toEqual({
      codexFailureReason: 'network_error', errorCode: -32600
    })
    expect(codexFailureLogFields(new CodexAppServerError('quota', 99_999_999))).toEqual({
      codexFailureReason: 'quota_exceeded'
    })
    expect(codexFailureLogFields(new CodexAppServerError('process_exit', null, {
      exitCode: 17, processSignal: null, diagnosticBytes: 42
    }))).toEqual({
      codexFailureReason: 'process_exit', codexExitCode: 17, diagnosticBytes: 42
    })
    expect(codexFailureLogFields(new CodexAppServerError('turn_failed', null))).toEqual({
      codexFailureReason: 'turn_failed'
    })
    expect(codexFailureLogFields(new CodexAppServerError('upstream_error', null, undefined, {
      kind: 'serverOverloaded'
    }))).toEqual({
      codexFailureReason: 'upstream_error', codexServerErrorKind: 'serverOverloaded'
    })
    expect(codexFailureLogFields(new Error('private server response'))).toEqual({})
  })

  it('记录 App Server 可重试错误通知，但等待 turn 终态且不保存正文', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tripwise-codex-error-notification-'))
    const userData = join(directory, 'user-data')
    const logPath = join(directory, 'protocol.jsonl')
    const server = createServer(userData, logPath, 'retry-notification')
    try {
      await expect(server.complete(request())).resolves.toMatchObject({ text: expect.any(String), chunkCount: 1 })
      const notification = logSystemEventMock.mock.calls.find((call) =>
        call[1] === 'llm.codex_app_server.error_notification'
      )
      expect(notification).toEqual(['info', 'llm.codex_app_server.error_notification', expect.objectContaining({
        status: 'retrying',
        codexFailureReason: 'network_error',
        codexServerErrorKind: 'responseStreamDisconnected',
        codexUpstreamHttpStatus: 502
      })])
      expect(JSON.stringify(logSystemEventMock.mock.calls)).not.toContain('private')
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('持续复用线程、增量追加工具回执、重启恢复并在删除话题时清理', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tripwise-codex-app-server-'))
    const userData = join(directory, 'user-data')
    const logPath = join(directory, 'protocol.jsonl')
    try {
      const firstProcess = createServer(userData, logPath)
      await expect(firstProcess.complete(request())).resolves.toMatchObject({ text: expect.any(String), chunkCount: 1 })
      await expect(firstProcess.complete(request({
        phase: 'continue',
        toolOutput: JSON.stringify({ status: 'warning', result: 'route estimate unavailable' })
      }))).resolves.toMatchObject({ text: expect.any(String), chunkCount: 1 })
      await firstProcess.close()

      const resumedProcess = createServer(userData, logPath)
      await expect(resumedProcess.complete(request({
        phase: 'run-start',
        fullPrompt: 'must not replace a resumed thread',
        resumedPrompt: 'resume request plus recovered tool result',
        toolOutput: JSON.stringify({ results: [{ status: 'warning', result: 'recovered' }] })
      }))).resolves.toMatchObject({ text: expect.any(String), chunkCount: 1 })
      await expect(resumedProcess.complete(request({
        phase: 'run-start',
        fullPrompt: 'must not replace a resumed thread',
        resumedPrompt: 'next user turn'
      }))).resolves.toMatchObject({ text: expect.any(String), chunkCount: 1 })
      await resumedProcess.deleteConversation('trip-1:conversation-1')

      const records = await readRecords(logPath)
      const requests = records.filter((item) => item.event === 'request')
      const methods = requests.map((item) => item.method)
      const starts = requests.filter((item) => item.method === 'thread/start')
      const resumes = requests.filter((item) => item.method === 'thread/resume')
      const turns = requests.filter((item) => item.method === 'turn/start')
      expect(starts).toHaveLength(1)
      expect(resumes).toHaveLength(3)
      expect(methods).toContain('thread/delete')
      expect((turns[1]?.params as Record<string, unknown>).toolOutput).toMatchObject({
        name: 'tripwise_tool_results', namespace: 'tripwise'
      })
      expect((turns[1]?.params as Record<string, unknown>).input).toEqual([])
      expect((turns[2]?.params as Record<string, unknown>).input).toEqual([])
      expect((turns[2]?.params as Record<string, unknown>).toolOutput).toBeDefined()
      expect((turns[3]?.params as Record<string, unknown>).input).toMatchObject([
        { type: 'text', text: 'next user turn' }
      ])

      const spawns = records.filter((item) => item.event === 'spawn')
      const isolatedArguments = spawns.at(-1)?.args as string[]
      expect(isolatedArguments).toContain('--disable')
      expect(isolatedArguments).toContain('shell_tool')
      expect(isolatedArguments).toContain('mentions_v2')
      expect(isolatedArguments).toContain('mcp_servers.sample.enabled=false')

      const indexPath = join(userData, 'codex-thread-index.json')
      expect(JSON.parse(await readFile(indexPath, 'utf8'))).toEqual({ version: 1, threads: {} })
      expect((await stat(indexPath)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('收到取消后中断活动 turn，并保留线程供下一轮继续', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tripwise-codex-cancel-'))
    const userData = join(directory, 'user-data')
    const logPath = join(directory, 'protocol.jsonl')
    const server = createServer(userData, logPath, 'cancel-first-turn')
    const controller = new AbortController()
    try {
      const running = server.complete(request({ signal: controller.signal }))
      await waitForRequest(logPath, 'turn/start')
      controller.abort()
      await expect(running).rejects.toThrow('请求已取消。')
      await expect(server.complete(request({ phase: 'run-start', resumedPrompt: '取消后的新请求' })))
        .resolves.toMatchObject({ text: expect.any(String) })

      const requests = (await readRecords(logPath)).filter((entry) => entry.event === 'request')
      expect(requests.filter((entry) => entry.method === 'turn/interrupt')).toHaveLength(1)
      expect(requests.filter((entry) => entry.method === 'thread/start')).toHaveLength(1)
      expect(requests.filter((entry) => entry.method === 'thread/resume')).toHaveLength(1)
      expect(requests.filter((entry) => entry.method === 'turn/start')).toHaveLength(2)
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('中断 RPC 遇到已结束竞态时等待终态事件并复用同一进程', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tripwise-codex-interrupt-race-'))
    const userData = join(directory, 'user-data')
    const logPath = join(directory, 'protocol.jsonl')
    const server = createServer(userData, logPath, 'interrupt-rejection-race')
    const controller = new AbortController()
    try {
      const running = server.complete(request({ signal: controller.signal }))
      await waitForRequest(logPath, 'turn/start')
      controller.abort()
      await expect(running).rejects.toThrow('请求已取消。')
      await expect(server.complete(request({ phase: 'run-start', resumedPrompt: '中断竞态后的新请求' })))
        .resolves.toMatchObject({ text: expect.any(String) })

      const records = await readRecords(logPath)
      const requests = records.filter((entry) => entry.event === 'request')
      expect(records.filter((entry) => entry.event === 'spawn')).toHaveLength(2)
      expect(requests.filter((entry) => entry.method === 'turn/interrupt')).toHaveLength(1)
      expect(requests.filter((entry) => entry.method === 'thread/start')).toHaveLength(1)
      expect(requests.filter((entry) => entry.method === 'thread/resume')).toHaveLength(1)
      expect(requests.filter((entry) => entry.method === 'turn/start')).toHaveLength(2)
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('服务端没有终态事件时重启连接并恢复持久 thread', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tripwise-codex-no-active-turn-'))
    const userData = join(directory, 'user-data')
    const logPath = join(directory, 'protocol.jsonl')
    const server = createServer(userData, logPath, 'interrupt-no-active-turn')
    const controller = new AbortController()
    try {
      const running = server.complete(request({ signal: controller.signal }))
      await waitForRequest(logPath, 'turn/start')
      controller.abort()
      await expect(running).rejects.toThrow('请求已取消。')
      await expect(server.complete(request({ phase: 'run-start', resumedPrompt: '停止后继续' })))
        .resolves.toMatchObject({ text: expect.any(String) })

      const records = await readRecords(logPath)
      const requests = records.filter((entry) => entry.event === 'request')
      expect(records.filter((entry) => entry.event === 'spawn').length).toBeGreaterThanOrEqual(4)
      expect(requests.filter((entry) => entry.method === 'turn/interrupt')).toHaveLength(1)
      expect(requests.filter((entry) => entry.method === 'thread/start')).toHaveLength(1)
      expect(requests.filter((entry) => entry.method === 'thread/resume')).toHaveLength(1)
      expect(requests.filter((entry) => entry.method === 'turn/start')).toHaveLength(2)
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 15_000)

  it('取消未确认 turn/start 时关闭进程并恢复原 thread', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tripwise-codex-cancel-start-'))
    const userData = join(directory, 'user-data')
    const logPath = join(directory, 'protocol.jsonl')
    const server = createServer(userData, logPath, 'hang-first-turn-start')
    const controller = new AbortController()
    try {
      const startedAt = Date.now()
      const running = server.complete(request({ signal: controller.signal, timeoutMs: 10_000 }))
      await waitForRequest(logPath, 'turn/start')
      controller.abort()
      await expect(running).rejects.toThrow('请求已取消。')
      expect(Date.now() - startedAt).toBeLessThan(2_000)
      await expect(server.complete(request({ phase: 'run-start', resumedPrompt: '恢复后继续' })))
        .resolves.toMatchObject({ text: expect.any(String) })

      const requests = (await readRecords(logPath)).filter((entry) => entry.event === 'request')
      const processStarts = (await readRecords(logPath)).filter((entry) => entry.event === 'spawn')
      expect(processStarts.length).toBeGreaterThanOrEqual(4)
      expect(requests.filter((entry) => entry.method === 'thread/start')).toHaveLength(1)
      expect(requests.filter((entry) => entry.method === 'thread/resume')).toHaveLength(1)
      expect(requests.filter((entry) => entry.method === 'turn/start')).toHaveLength(2)
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('App Server 意外退出后，下一轮重启进程并恢复持久 thread', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tripwise-codex-crash-'))
    const userData = join(directory, 'user-data')
    const logPath = join(directory, 'protocol.jsonl')
    const server = createServer(userData, logPath, 'exit-first-turn')
    try {
      const failure = await server.complete(request()).catch((error: unknown) => error)
      expect(failure).toMatchObject({
        failureReason: 'process_exit',
        processExit: { exitCode: 17, processSignal: null, diagnosticBytes: 0 }
      })
      expect(codexFailureLogFields(failure)).toMatchObject({
        codexFailureReason: 'process_exit', codexExitCode: 17, diagnosticBytes: 0
      })
      await expect(server.complete(request({ phase: 'run-start', resumedPrompt: '进程恢复后继续' })))
        .resolves.toMatchObject({ text: expect.any(String) })

      const records = await readRecords(logPath)
      const requests = records.filter((entry) => entry.event === 'request')
      const processStarts = records.filter((entry) => entry.event === 'spawn')
      expect(processStarts.length).toBeGreaterThanOrEqual(4)
      expect(requests.filter((entry) => entry.method === 'thread/start')).toHaveLength(1)
      expect(requests.filter((entry) => entry.method === 'thread/resume')).toHaveLength(1)
      expect(requests.filter((entry) => entry.method === 'turn/start')).toHaveLength(2)
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('把未知 turn 失败归为 turn_failed，不误报子进程退出', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tripwise-codex-turn-failed-'))
    const userData = join(directory, 'user-data')
    const logPath = join(directory, 'protocol.jsonl')
    const server = createServer(userData, logPath, 'fail-first-turn')
    try {
      const failure = await server.complete(request()).catch((error: unknown) => error)
      expect(failure).toMatchObject({ failureReason: 'turn_failed' })
      expect((failure as CodexAppServerError).processExit).toBeUndefined()
      expect(codexFailureLogFields(failure)).toEqual({ codexFailureReason: 'turn_failed' })
      await expect(server.complete(request({ phase: 'run-start', resumedPrompt: 'turn 失败后继续' })))
        .resolves.toMatchObject({ text: expect.any(String) })
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('从 turn 失败事件提取官方错误类别与 HTTP 状态，不保存服务端正文', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tripwise-codex-turn-error-info-'))
    const userData = join(directory, 'user-data')
    const logPath = join(directory, 'protocol.jsonl')
    const server = createServer(userData, logPath, 'fail-with-codex-error-info')
    try {
      const failure = await server.complete(request()).catch((error: unknown) => error)
      expect(failure).toMatchObject({
        failureReason: 'network',
        serverError: { kind: 'httpConnectionFailed', httpStatusCode: 503 }
      })
      expect((failure as Error).message).not.toContain('private')
      expect(codexFailureLogFields(failure)).toEqual({
        codexFailureReason: 'network_error',
        codexServerErrorKind: 'httpConnectionFailed',
        codexUpstreamHttpStatus: 503
      })
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('识别当前 App Server 协议中的模型过载错误', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tripwise-codex-overload-info-'))
    const userData = join(directory, 'user-data')
    const logPath = join(directory, 'protocol.jsonl')
    const server = createServer(userData, logPath, 'fail-with-new-codex-error-info')
    try {
      const failure = await server.complete(request()).catch((error: unknown) => error)
      expect(failure).toMatchObject({
        failureReason: 'upstream_error',
        serverError: { kind: 'serverOverloaded' }
      })
      expect(codexFailureLogFields(failure)).toEqual({
        codexFailureReason: 'upstream_error', codexServerErrorKind: 'serverOverloaded'
      })
      expect((failure as Error).message).not.toContain('private')
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('把 App Server 用量额度错误映射为可读额度提示且不泄露正文', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tripwise-codex-quota-info-'))
    const userData = join(directory, 'user-data')
    const logPath = join(directory, 'protocol.jsonl')
    const server = createServer(userData, logPath, 'fail-with-quota-error-info')
    try {
      const failure = await server.complete(request()).catch((error: unknown) => error)
      expect(failure).toMatchObject({
        failureReason: 'quota',
        serverError: { kind: 'usageLimitExceeded' }
      })
      expect((failure as Error).message).toContain('额度不足')
      expect((failure as Error).message).not.toContain('private')
      expect(codexFailureLogFields(failure)).toEqual({
        codexFailureReason: 'quota_exceeded', codexServerErrorKind: 'usageLimitExceeded'
      })
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('只接受白名单旅行工具的结构化响应', () => {
    const response = parseCodexOutput(JSON.stringify({
      type: 'tool_calls',
      content: '我先核对景点交通。',
      calls: [{ name: 'search_web', arguments: JSON.stringify({ query: '景点交通官方信息' }) }]
    }), new Set(['search_web']))
    expect(response.tool_calls?.[0]?.function.name).toBe('search_web')
    expect(() => parseCodexOutput(JSON.stringify({
      type: 'tool_calls', content: '',
      calls: [{ name: 'shell', arguments: '{}' }]
    }), new Set(['search_web']))).toThrow('无效的 Tripwise 工具调用')
  })

  it('把续轮回执和恢复用户文本脱敏后再写入持久线程', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tripwise-codex-redaction-'))
    const userData = join(directory, 'user-data')
    const logPath = join(directory, 'protocol.jsonl')
    const secret = 'tripwise-test-secret-7a9f'
    const conversationKey = 'trip-1:conversation-redaction'
    const server = createServer(userData, logPath)
    const client = new OpenAiCompatibleClient(server)
    const settings = { provider: 'codex-cli', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna' } as const
    const messages = [
      { role: 'system' as const, content: '只返回简短消息。' },
      { role: 'user' as const, content: '北京旅行' }
    ]

    try {
      await client.complete(settings, '', messages, [], undefined, [secret], undefined, 'compact', 'auto', 'max', false, {
        conversationKey, userText: '北京旅行', phase: 'run-start'
      })
      await client.complete(settings, '', messages, [], undefined, [secret], undefined, 'compact', 'auto', 'max', false, {
        conversationKey,
        userText: `继续规划，凭证 ${secret}`,
        phase: 'run-start',
        continuationMessages: [{ role: 'tool', tool_call_id: 'result-1', content: `路线结果含 ${secret}` }]
      })

      const content = await readFile(logPath, 'utf8')
      const records = await readRecords(logPath)
      const turns = records.filter((item) => item.event === 'request' && item.method === 'turn/start')
      const resumedParams = turns[1]?.params as Record<string, unknown>
      const toolOutput = resumedParams.toolOutput as Record<string, unknown>
      expect(content).not.toContain(secret)
      expect(resumedParams.input).toEqual([])
      expect(toolOutput.output).toContain('[已隐藏凭证]')
      expect(String(toolOutput.output)).toContain('继续规划')
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
