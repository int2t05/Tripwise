/** 通过 Codex App Server 维护本地线程、读取流式事件并隔离非 Tripwise 工具。 */
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { logSystemEvent } from './system-logger.js'

const MAX_RPC_LINE_BYTES = 8_000_000
const MAX_AGENT_OUTPUT_BYTES = 2_000_000
const MAX_DIAGNOSTIC_BYTES = 8_000
const SERVER_START_TIMEOUT_MS = 20_000
const RPC_TIMEOUT_MS = 20_000
const INTERRUPT_GRACE_MS = 2_000
const INTERRUPT_REJECTION_GRACE_MS = 500
const INTERRUPT_COMPLETION_GRACE_MS = 15_000
const INTERRUPT_FORCE_KILL_GRACE_MS = 1_500
const PROGRESS_LOG_INTERVAL_MS = 60_000
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'unified_exec_tty', 'code_mode', 'code_mode_host', 'code_mode_only',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'view_image',
  'image_generation', 'multi_agent', 'plugins', 'apps', 'in_app_browser'
] as const

type JsonRecord = Record<string, unknown>

interface RpcError {
  code?: number
  message?: string
  data?: unknown
}

interface RpcMessage {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: RpcError
}

export interface CodexTurnRequest {
  conversationKey: string
  phase: 'run-start' | 'continue' | 'finalize'
  fullPrompt: string
  resumedPrompt: string
  continuationPrompt: string
  toolOutput?: string
  outputSchema: Record<string, unknown>
  images?: Array<{ mimeType: 'image/jpeg' | 'image/png'; data: Buffer }>
  timeoutMs: number
  signal?: AbortSignal
  traceId?: string
}

export interface CodexTurnResult {
  text: string
  durationMs: number
  chunkCount: number
  firstDeltaMs?: number
}

interface ActiveTurn {
  threadId: string
  traceId?: string
  turnId?: string
  startedAt: number
  firstDeltaAt?: number
  chunkCount: number
  messages: Map<string, string>
  messageOrder: string[]
  completion?: JsonRecord
  resolve: (value: JsonRecord) => void
  reject: (error: Error) => void
  settled: boolean
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** 可注入的进程边界让协议测试使用本地假服务器，不接触用户账户或网络。 */
export interface CodexAppServerDependencies {
  resolveExecutable?: () => Promise<string | undefined>
  spawnProcess?: (
    executable: string,
    args: string[],
    options: {
      cwd: string
      env: NodeJS.ProcessEnv
      stdio: ['pipe', 'pipe', 'pipe']
      windowsHide: boolean
    }
  ) => ChildProcessWithoutNullStreams
}

/** 只记录对话 ID 与 Codex thread ID；对话正文仍只由 Tripwise 保存。 */
class CodexThreadIndex {
  private readonly filePath: string
  private entriesByConversation = new Map<string, string>()
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly directory: string) {
    this.filePath = join(directory, 'codex-thread-index.json')
  }

  /** 读取并校验本地线程索引；损坏时保留文件并停止继续写入。 */
  async initialize(): Promise<void> {
    if (this.loaded) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (!isRecord(value) || value.version !== 1 || !isRecord(value.threads) ||
        Object.entries(value.threads).some(([key, threadId]) =>
          !key || key.length > 220 || typeof threadId !== 'string' || threadId.length > 200
        )) {
        throw new Error('索引结构无效。')
      }
      this.entriesByConversation = new Map(Object.entries(value.threads) as Array<[string, string]>)
      await chmod(this.filePath, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Codex 本地会话索引无法读取，原文件已保留。')
      }
    }
    this.loaded = true
  }

  /** 读取某个 Tripwise 话题已关联的 Codex thread。 */
  async get(conversationKey: string): Promise<string | undefined> {
    await this.initialize()
    return this.entriesByConversation.get(conversationKey)
  }

  /** 以原子文件替换保存 thread 关联，不写入消息或密钥。 */
  async set(conversationKey: string, threadId: string): Promise<void> {
    await this.initialize()
    this.entriesByConversation.set(conversationKey, threadId)
    await this.persist()
  }

  /** 删除一个话题关联；调用方确认 Codex thread 已删除后才执行。 */
  async remove(conversationKey: string): Promise<void> {
    await this.initialize()
    if (!this.entriesByConversation.delete(conversationKey)) return
    await this.persist()
  }

  /** 返回线程关联副本，供启动时清理已删除话题留下的孤立线程。 */
  async entries(): Promise<Array<[string, string]>> {
    await this.initialize()
    return [...this.entriesByConversation.entries()]
  }

  /** 串行落盘索引，避免并发清理互相覆盖。 */
  private async persist(): Promise<void> {
    const next = this.writeQueue.then(async () => {
      const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
      try {
        await writeFile(temporaryPath, JSON.stringify({
          version: 1,
          threads: Object.fromEntries(this.entriesByConversation)
        }), { mode: 0o600 })
        await chmod(temporaryPath, 0o600)
        await rename(temporaryPath, this.filePath)
        await chmod(this.filePath, 0o600)
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw error
      }
    })
    this.writeQueue = next.catch(() => undefined)
    await next
  }
}

/** 管理单条 JSONL 子进程连接、请求响应与服务端事件。 */
class CodexTransport {
  private readonly pending = new Map<number, PendingRpc>()
  private readonly stderrTail: Buffer[] = []
  private stderrBytes = 0
  private nextRequestId = 1
  private closed = false
  private expectedExit = false
  private closingPromise: Promise<void> | undefined
  private activeTurn: ActiveTurn | null = null
  private lastTurnTraceId: string | undefined
  private readonly lineReader

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    onExit: (code: number | null, signal: NodeJS.Signals | null, stderr: string, expected: boolean, traceId?: string) => void
  ) {
    this.lineReader = createInterface({ input: child.stdout })
    this.lineReader.on('line', (line) => this.receiveLine(line))
    child.stderr.on('data', (chunk: Buffer | string) => this.captureStderr(chunk))
    child.on('error', () => this.failPending(new Error('Codex App Server 无法启动。')))
    child.on('close', (code, signal) => {
      this.closed = true
      const traceId = this.activeTurn?.traceId ?? this.lastTurnTraceId
      const stderr = this.stderrText()
      const stderrReason = classifyServerMessage(stderr)
      const error = this.expectedExit
        ? new Error('Codex App Server 正在关闭。')
        : new CodexAppServerError(stderrReason === 'unknown_error' ? 'process_exit' : stderrReason, null, {
            exitCode: code,
            processSignal: signal,
            diagnosticBytes: this.stderrBytes
          })
      this.failPending(error)
      onExit(code, signal, stderr, this.expectedExit, traceId)
    })
  }

  /** 完成协议握手后才允许发起线程或模型请求。 */
  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'tripwise', title: 'Tripwise', version: '0.1.0' }
    }, SERVER_START_TIMEOUT_MS)
    this.notify('initialized', {})
  }

  /** 发送带超时的 JSON-RPC 请求并匹配对应响应。 */
  request(method: string, params: JsonRecord, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    if (this.closed || !this.child.stdin.writable) throw new Error('Codex App Server 连接已关闭。')
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Codex App Server 请求超时。'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ method, id, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error('Codex App Server 请求发送失败。'))
      }
    })
  }

  /** 发送不等待响应的 JSON-RPC 通知。 */
  notify(method: string, params: JsonRecord): void {
    this.write({ method, params })
  }

  /** 开始结构化 turn 并收集最终消息文本，不把内部推理写入日志或界面。 */
  async turn(params: JsonRecord, threadId: string, timeoutMs: number, signal?: AbortSignal, traceId?: string): Promise<CodexTurnResult> {
    if (signal?.aborted) throw new Error('请求已取消。')
    const startedAt = Date.now()
    let settleTurn!: (value: JsonRecord) => void
    let rejectTurn!: (error: Error) => void
    const completion = new Promise<JsonRecord>((resolve, reject) => {
      settleTurn = resolve
      rejectTurn = reject
    })
    // turn/start 被拒绝时，服务端完成事件可能先到失败分支；提前标记 rejection 已被主流程接管。
    void completion.catch(() => undefined)
    const state: ActiveTurn = {
      threadId, traceId, startedAt, chunkCount: 0, messages: new Map(), messageOrder: [],
      resolve: settleTurn, reject: rejectTurn, settled: false
    }
    this.lastTurnTraceId = traceId
    this.activeTurn = state
    let timeout: ReturnType<typeof setTimeout> | undefined
    let progress: ReturnType<typeof setInterval> | undefined
    let forceKill: ReturnType<typeof setTimeout> | undefined
    let terminatedBeforeTurnStart = false
    const terminateBeforeTurnStart = (): void => {
      if (state.turnId || terminatedBeforeTurnStart) return
      terminatedBeforeTurnStart = true
      forceKill = setTimeout(() => this.child.kill('SIGKILL'), INTERRUPT_GRACE_MS + 500)
      void this.close()
    }
    const interrupt = (): void => {
      if (state.settled) return
      if (!state.turnId) {
        terminateBeforeTurnStart()
        return
      }
      const interruptStartedAt = Date.now()
      logSystemEvent('info', 'llm.codex_app_server.turn.interrupt', {
        traceId, codexStage: 'stream', status: 'started'
      })
      void this.request('turn/interrupt', { threadId, turnId: state.turnId }, INTERRUPT_GRACE_MS)
        .then(() => {
          logSystemEvent('info', 'llm.codex_app_server.turn.interrupt', {
            traceId, codexStage: 'stream', durationMs: Date.now() - interruptStartedAt, status: 'accepted'
          })
          if (state.completion || state.settled) return
          forceKill = setTimeout(() => {
            logSystemEvent('warn', 'llm.codex_app_server.turn.interrupt_timeout', {
              traceId, codexStage: 'stream', status: 'terminating'
            })
            this.terminateForRecovery()
            forceKill = setTimeout(() => this.child.kill('SIGKILL'), INTERRUPT_FORCE_KILL_GRACE_MS)
          }, INTERRUPT_COMPLETION_GRACE_MS)
        })
        .catch(async (error: unknown) => {
          // -32600 可能表示 turn 已结束但终态事件尚在队列中；先等事件，避免误杀可复用进程。
          if (error instanceof CodexAppServerError && error.rpcCode === -32600 && !state.completion) {
            await new Promise((resolve) => setTimeout(resolve, INTERRUPT_REJECTION_GRACE_MS))
          }
          const serverReportsNoActiveTurn = error instanceof CodexAppServerError &&
            error.failureReason === 'no_active_turn'
          const terminalStateObserved = !!state.completion || state.settled || this.closed ||
            this.child.exitCode !== null || this.child.signalCode !== null
          logSystemEvent('warn', 'llm.codex_app_server.turn.interrupt', {
            traceId,
            codexStage: 'stream',
            codexFailureReason: error instanceof CodexAppServerError
              ? error.failureReason : classifyServerMessage(error instanceof Error ? error.message : ''),
            ...(error instanceof CodexAppServerError && error.rpcCode !== null ? { errorCode: error.rpcCode } : {}),
            durationMs: Date.now() - interruptStartedAt,
            status: terminalStateObserved ? 'terminal' : serverReportsNoActiveTurn ? 'restarting' : 'failed'
          })
          if (terminalStateObserved) return
          // 只有收到终态事件才能安全复用连接；无活动 turn 错误也可能伴随 App Server 残留状态。
          logSystemEvent('warn', 'llm.codex_app_server.process.restarting', {
            traceId,
            codexStage: 'stream',
            codexFailureReason: error instanceof CodexAppServerError
              ? error.failureReason : classifyServerMessage(error instanceof Error ? error.message : ''),
            ...(error instanceof CodexAppServerError && error.rpcCode !== null ? { errorCode: error.rpcCode } : {}),
            status: 'restarting'
          })
          this.terminateForRecovery()
          forceKill = setTimeout(() => this.child.kill('SIGKILL'), INTERRUPT_FORCE_KILL_GRACE_MS)
        })
    }
    const onAbort = (): void => interrupt()
    signal?.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => interrupt(), timeoutMs)
    progress = setInterval(() => logSystemEvent('info', 'llm.request.waiting', {
      traceId,
      durationMs: Date.now() - startedAt,
      progressStage: 'waiting_for_codex_app_server'
    }), PROGRESS_LOG_INTERVAL_MS)

    try {
      logSystemEvent('info', 'llm.codex_app_server.turn.starting', {
        traceId, codexStage: 'turn_start', status: 'started'
      })
      const result = await this.request('turn/start', params, RPC_TIMEOUT_MS)
      if (!isRecord(result) || !isRecord(result.turn) || typeof result.turn.id !== 'string') {
        throw new Error('Codex App Server 未返回有效 turn 标识。')
      }
      state.turnId = result.turn.id
      logSystemEvent('info', 'llm.codex_app_server.turn.accepted', {
        traceId, codexStage: 'turn_start', status: 'accepted'
      })
      if (signal?.aborted || Date.now() - startedAt >= timeoutMs) interrupt()
      if (state.completion) state.resolve(state.completion)
      const finished = await completion
      if (signal?.aborted) throw new Error('请求已取消。')
      if (Date.now() - startedAt >= timeoutMs) throw new Error('Codex App Server 请求超时，已停止。')
      const turn = isRecord(finished.turn) ? finished.turn : finished
      if (turn.status !== 'completed') {
        const failure = classifyTurnFailure(turn.error)
        throw new CodexAppServerError(failure.reason, null, undefined, failure.serverError)
      }
      const text = latestAgentMessage(state)
      if (!text) throw new Error('Codex App Server 未返回结构化消息。')
      if (Buffer.byteLength(text, 'utf8') > MAX_AGENT_OUTPUT_BYTES) throw new Error('Codex App Server 返回内容超过限制。')
      const durationMs = Date.now() - startedAt
      logSystemEvent('info', 'llm.codex_app_server.turn.completed', {
        traceId, durationMs, streamChunkCount: state.chunkCount,
        responseBytes: Buffer.byteLength(text, 'utf8'),
        ...(state.firstDeltaAt ? { firstDeltaMs: state.firstDeltaAt - startedAt } : {}),
        status: 'completed'
      })
      return {
        text, durationMs, chunkCount: state.chunkCount,
        ...(state.firstDeltaAt ? { firstDeltaMs: state.firstDeltaAt - startedAt } : {})
      }
    } catch (error) {
      if (!state.turnId && !terminatedBeforeTurnStart) terminateBeforeTurnStart()
      if (terminatedBeforeTurnStart) await this.close()
      logSystemEvent(signal?.aborted ? 'info' : 'warn', 'llm.codex_app_server.turn.failed', {
        traceId,
        codexStage: state.turnId ? 'stream' : 'turn_start',
        codexFailureReason: error instanceof CodexAppServerError
          ? error.failureReason
          : classifyServerMessage(error instanceof Error ? error.message : ''),
        ...(error instanceof CodexAppServerError && error.rpcCode !== null ? { errorCode: error.rpcCode } : {}),
        durationMs: Date.now() - startedAt,
        status: signal?.aborted ? 'cancelled' : 'failed'
      })
      if (signal?.aborted) throw new Error('请求已取消。')
      if (Date.now() - startedAt >= timeoutMs) throw new Error('Codex App Server 请求超时，已停止。')
      throw error
    } finally {
      state.settled = true
      if (this.activeTurn === state) this.activeTurn = null
      signal?.removeEventListener('abort', onAbort)
      if (timeout) clearTimeout(timeout)
      if (progress) clearInterval(progress)
      if (forceKill) clearTimeout(forceKill)
    }
  }

  /** 优雅停止子进程，并拒绝尚未完成的 RPC。 */
  async close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise
    if (this.closed) return
    this.expectedExit = true
    this.lineReader.close()
    this.failPending(new Error('Codex App Server 正在关闭。'))
    this.child.stdin.end()
    this.closingPromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 1_000)
      this.child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    await this.closingPromise
  }

  /** 中断状态无法确认时停止损坏连接，由上层下轮恢复持久 thread。 */
  terminateForRecovery(): void {
    if (this.closed) return
    this.expectedExit = true
    this.child.kill('SIGTERM')
  }

  /** 把一行 JSON-RPC 分派到请求响应、流式事件或不支持的服务端请求。 */
  private receiveLine(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > MAX_RPC_LINE_BYTES) {
      this.failPending(new Error('Codex App Server 返回了超长协议消息。'))
      this.child.kill('SIGTERM')
      return
    }
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      this.failPending(new Error('Codex App Server 返回了无效协议消息。'))
      this.child.kill('SIGTERM')
      return
    }
    if (message.id !== undefined) {
      const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
      if (pending) {
        this.pending.delete(message.id as number)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(rpcError(message.error))
        else pending.resolve(message.result)
        return
      }
      if (message.method) {
        // 工具功能全部关闭；未知的 Codex 主动请求不得保持等待或绕开 Tripwise 工具注册表。
        this.write({ id: message.id, error: { code: -32601, message: 'Tripwise 未开放该 App Server 请求。' } })
      }
      return
    }
    this.receiveTurnEvent(message)
  }

  /** 汇总模型消息增量与 turn 结果，只保留结构化回复。 */
  private receiveTurnEvent(message: RpcMessage): void {
    const state = this.activeTurn
    if (!state || !message.method || !isRecord(message.params)) return
    const params = message.params
    if (params.threadId !== state.threadId) return
    if (message.method === 'error') {
      this.receiveErrorNotification(state, params)
      return
    }
    if (message.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      const itemId = typeof params.itemId === 'string' ? params.itemId : ''
      if (!itemId) return
      if (!state.messages.has(itemId)) state.messageOrder.push(itemId)
      state.messages.set(itemId, (state.messages.get(itemId) ?? '') + params.delta)
      state.chunkCount += 1
      state.firstDeltaAt ??= Date.now()
      return
    }
    if (message.method === 'item/completed' && isRecord(params.item) && params.item.type === 'agentMessage' &&
      typeof params.item.id === 'string' && typeof params.item.text === 'string') {
      const itemId = params.item.id
      if (!state.messages.has(itemId)) state.messageOrder.push(itemId)
      state.messages.set(itemId, params.item.text)
      return
    }
    if (message.method === 'turn/completed') {
      const turn = isRecord(params.turn) ? params.turn : params
      const eventTurnId = typeof turn.id === 'string' ? turn.id : undefined
      if (state.turnId && eventTurnId && state.turnId !== eventTurnId) return
      state.completion = { turn }
      if (state.turnId || !eventTurnId) state.resolve(state.completion)
    }
  }

  /** 记录 App Server 的重试提示，只保留协议错误类别和状态码。 */
  private receiveErrorNotification(state: ActiveTurn, params: JsonRecord): void {
    if (typeof params.turnId === 'string' && state.turnId && params.turnId !== state.turnId) return
    const failure = classifyTurnFailure(params.error)
    const serverError = new CodexAppServerError(failure.reason, null, undefined, failure.serverError)
    const willRetry = params.willRetry === true
    logSystemEvent(willRetry ? 'info' : 'warn', 'llm.codex_app_server.error_notification', {
      traceId: state.traceId,
      codexStage: 'stream',
      durationMs: Date.now() - state.startedAt,
      status: willRetry ? 'retrying' : 'reported',
      ...codexFailureLogFields(serverError)
    })
  }

  /** 写入受控 JSON 行；禁止从 stdout 读取应用日志或正文日志。 */
  private write(message: JsonRecord): void {
    if (this.closed || !this.child.stdin.writable) throw new Error('Codex App Server 连接已关闭。')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /** 收集受限 stderr 尾部用于内存分类；从不写入系统日志。 */
  private captureStderr(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.stderrTail.push(bytes)
    this.stderrBytes += bytes.byteLength
    while (this.stderrBytes > MAX_DIAGNOSTIC_BYTES && this.stderrTail.length) {
      const removed = this.stderrTail.shift()!
      this.stderrBytes -= removed.byteLength
    }
  }

  private stderrText(): string {
    return Buffer.concat(this.stderrTail).toString('utf8')
  }

  /** 子进程退出后拒绝全部等待请求，避免悬挂在某个 turn。 */
  private failPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
    if (this.activeTurn && !this.activeTurn.settled) {
      this.activeTurn.reject(error)
      this.activeTurn.settled = true
    }
  }
}

/** 负责线程索引、权限隔离、turn 生命周期以及话题删除清理。 */
export class CodexAppServer {
  private readonly index: CodexThreadIndex
  private readonly workingDirectory: string
  private transport: CodexTransport | null = null
  private starting: Promise<CodexTransport> | null = null
  private turnQueue: Promise<void> = Promise.resolve()
  private closing = false

  constructor(
    private readonly userDataDirectory: string,
    private readonly dependencies: CodexAppServerDependencies = {}
  ) {
    this.index = new CodexThreadIndex(userDataDirectory)
    this.workingDirectory = join(userDataDirectory, 'codex-runtime')
  }

  /** 在同一话题线程执行一轮；工具结果作为独立回执追加到 Codex 历史。 */
  async complete(request: CodexTurnRequest): Promise<CodexTurnResult> {
    return this.withTurnLock(() => this.completeLocked(request))
  }

  /** 删除用户已删除话题关联的 Codex thread；失败时保留索引供下次清理。 */
  async deleteConversation(conversationKey: string): Promise<void> {
    await this.index.initialize()
    const threadId = await this.index.get(conversationKey)
    if (!threadId) return
    try {
      const transport = await this.ensureTransport()
      await transport.request('thread/delete', { threadId })
      await this.index.remove(conversationKey)
      logSystemEvent('info', 'llm.codex_app_server.thread.deleted', { status: 'completed' })
    } catch (error) {
      if (error instanceof CodexAppServerError && error.failureReason === 'thread_missing') {
        await this.index.remove(conversationKey)
        return
      }
      logSystemEvent('warn', 'llm.codex_app_server.thread.delete_failed', {
        status: 'deferred', reason: classifyServerMessage(error instanceof Error ? error.message : '')
      })
    }
  }

  /** 启动时删除本地旅行中已不存在的话题线程。 */
  async reconcile(activeConversationKeys: ReadonlySet<string>): Promise<void> {
    const stale = (await this.index.entries()).filter(([key]) => !activeConversationKeys.has(key))
    for (const [conversationKey] of stale) await this.deleteConversation(conversationKey)
  }

  /** 停止常驻 App Server 子进程；持久线程保留供下次恢复。 */
  async close(): Promise<void> {
    this.closing = true
    const transport = this.transport
    this.transport = null
    await transport?.close()
  }

  /** 在同一线程上串行执行消息，避免响应流与不同话题互相串线。 */
  private async withTurnLock<T>(run: () => Promise<T>): Promise<T> {
    const result = this.turnQueue.then(run, run)
    this.turnQueue = result.then(() => undefined, () => undefined)
    return result
  }

  /** 创建或恢复话题线程，并将本轮模型结果收集为结构化文本。 */
  private async completeLocked(request: CodexTurnRequest): Promise<CodexTurnResult> {
    if (request.signal?.aborted) throw new Error('请求已取消。')
    const transport = await this.ensureTransport()
    let threadId = await this.index.get(request.conversationKey)
    let newThread = false
    if (threadId) {
      try {
        await transport.request('thread/resume', { threadId, excludeTurns: true })
        logSystemEvent('info', 'llm.codex_app_server.thread.resumed', { status: 'completed' })
      } catch (error) {
        if (!(error instanceof CodexAppServerError) || error.failureReason !== 'thread_missing') throw error
        await this.index.remove(request.conversationKey)
        threadId = undefined
      }
    }
    if (!threadId) {
      const started = await transport.request('thread/start', {
        model: 'gpt-6-luna',
        cwd: this.workingDirectory,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        serviceName: 'tripwise'
      })
      if (!isRecord(started) || !isRecord(started.thread) || typeof started.thread.id !== 'string') {
        throw new Error('Codex App Server 未能创建持久话题。')
      }
      threadId = started.thread.id
      newThread = true
      await this.index.set(request.conversationKey, threadId)
      logSystemEvent('info', 'llm.codex_app_server.thread.started', { status: 'completed' })
    }

    const prompt = request.phase === 'run-start'
      ? newThread ? request.fullPrompt : request.resumedPrompt
      : request.continuationPrompt
    // 新 thread 会把全部恢复上下文放进首条提示；仅已有 thread 才能单独追加工具回执。
    const useToolOutput = !!request.toolOutput && !newThread
    const imageDirectory = request.images?.length ? join(tmpdir(), `tripwise-codex-${randomUUID()}`) : undefined
    // 临时图片目录在 finally 中回收；线程仅保留图片消息，不依赖这些路径继续运行。
    const resolvedImageDirectory = request.images?.length ? imageDirectory : undefined
    const imagePaths: string[] = []
    const turnInput: Array<JsonRecord> = [{ type: 'text', text: prompt }]
    try {
      if (resolvedImageDirectory && request.images) {
        await mkdir(resolvedImageDirectory, { recursive: false, mode: 0o700 })
        for (const [index, image] of request.images.entries()) {
          const imagePath = join(resolvedImageDirectory, `image-${index}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`)
          await writeFile(imagePath, image.data, { mode: 0o600 })
          imagePaths.push(imagePath)
          turnInput.push({ type: 'localImage', path: imagePath })
        }
      }
      const params: JsonRecord = {
        threadId,
        input: useToolOutput ? [] : turnInput,
        ...(useToolOutput ? {
          toolOutput: { name: 'tripwise_tool_results', namespace: 'tripwise', output: request.toolOutput }
        } : {}),
        model: 'gpt-6-luna',
        effort: 'max',
        cwd: this.workingDirectory,
        approvalPolicy: 'never',
        outputSchema: request.outputSchema
      }
      return await transport.turn(params, threadId, request.timeoutMs, request.signal, request.traceId)
    } finally {
      if (resolvedImageDirectory) await rm(resolvedImageDirectory, { recursive: true, force: true })
      if (imagePaths.length) logSystemEvent('info', 'llm.codex_app_server.images.cleaned', {
        imageCount: imagePaths.length, status: 'completed'
      })
    }
  }

  /** 启动并验证 App Server；先探测用户配置，再显式关闭其中的所有 MCP。 */
  private async ensureTransport(): Promise<CodexTransport> {
    if (this.closing) throw new Error('Codex App Server 正在关闭。')
    if (this.transport) return this.transport
    if (this.starting) return this.starting
    this.starting = this.startTransport()
    try {
      this.transport = await this.starting
      return this.transport
    } finally {
      this.starting = null
    }
  }

  /** 发现用户 MCP 名称后重启隔离进程，并验证有效配置。 */
  private async startTransport(): Promise<CodexTransport> {
    await mkdir(this.userDataDirectory, { recursive: true, mode: 0o700 })
    await mkdir(this.workingDirectory, { recursive: true, mode: 0o700 })
    const executable = await (this.dependencies.resolveExecutable ?? findCodexExecutable)()
    if (!executable) throw new Error('未找到 Codex CLI。请先安装并登录，再重试。')
    const probe = await this.spawnTransport(executable, [], [])
    let serverNames: string[]
    let disabledFeatures: string[] = [...DISABLED_FEATURES]
    try {
      const response = await probe.request('config/read', {}, RPC_TIMEOUT_MS)
      const config = isRecord(response) && isRecord(response.config) ? response.config : undefined
      if (!config) throw new Error('Codex MCP 配置无法确认，已停止连接。')
      const configuredServers = config.mcp_servers
      if (configuredServers !== undefined && configuredServers !== null && !isRecord(configuredServers)) {
        throw new Error('Codex MCP 配置格式无效，已停止连接。')
      }
      const servers = isRecord(configuredServers) ? configuredServers : {}
      serverNames = Object.keys(servers)
      if (!serverNames.every((name) => /^[A-Za-z0-9_-]{1,100}$/u.test(name))) {
        throw new Error('Codex MCP 配置名称无法安全隔离，已停止连接。')
      }
      const configuredFeatures = config.features
      if (configuredFeatures !== undefined && configuredFeatures !== null && !isRecord(configuredFeatures)) {
        throw new Error('Codex 功能配置格式无效，已停止连接。')
      }
      const enabledFeatureNames = Object.entries(isRecord(configuredFeatures) ? configuredFeatures : {})
        .filter(([, enabled]) => enabled === true)
        .map(([name]) => name)
      if (!enabledFeatureNames.every((name) => /^[A-Za-z0-9_-]{1,100}$/u.test(name))) {
        throw new Error('Codex 功能名称无法安全隔离，已停止连接。')
      }
      disabledFeatures = [...new Set([...DISABLED_FEATURES, ...enabledFeatureNames])]
    } finally {
      await probe.close()
    }

    const transport = await this.spawnTransport(executable, serverNames, disabledFeatures)
    try {
      const response = await transport.request('config/read', {}, RPC_TIMEOUT_MS)
      const config = isRecord(response) && isRecord(response.config) ? response.config : undefined
      if (!config) throw new Error('Codex MCP 配置无法确认，已停止连接。')
      const configuredServers = config.mcp_servers
      if (configuredServers !== undefined && configuredServers !== null && !isRecord(configuredServers)) {
        throw new Error('Codex MCP 配置格式无效，已停止连接。')
      }
      const servers = isRecord(configuredServers) ? Object.values(configuredServers) : []
      if (servers.some((server) => !isRecord(server) || server.enabled !== false)) {
        throw new Error('Codex 外部 MCP 隔离未通过，未发送模型请求。')
      }
      const featuresValue = config.features
      if (featuresValue !== undefined && featuresValue !== null && !isRecord(featuresValue)) {
        throw new Error('Codex 功能配置格式无效，已停止连接。')
      }
      const features = isRecord(featuresValue) ? featuresValue : {}
      if ([...DISABLED_FEATURES, ...disabledFeatures].some((feature) => features[feature] === true) ||
        Object.values(features).some((enabled) => enabled === true)) {
        throw new Error('Codex 本机工具隔离未通过，未发送模型请求。')
      }
      const models = await transport.request('model/list', {})
      if (!hasAvailableCodexModel(models)) {
        throw new Error('当前 Codex 登录账户未提供 GPT-6 Luna `max`，未发送模型请求。')
      }
      logSystemEvent('info', 'llm.codex_app_server.isolation.verified', {
        disabledFeatureCount: DISABLED_FEATURES.length,
        disabledMcpCount: servers.length,
        status: 'verified'
      })
      return transport
    } catch (error) {
      await transport.close()
      throw error
    }
  }

  /** 建立 JSONL 传输并完成握手；不读取或复制 Codex 登录凭证。 */
  private async spawnTransport(executable: string, mcpNames: string[], disabledFeatures: readonly string[]): Promise<CodexTransport> {
    const args = [
      'app-server', '--stdio',
      ...disabledFeatures.flatMap((feature) => ['--disable', feature]),
      ...mcpNames.flatMap((name) => ['--config', `mcp_servers.${name}.enabled=false`])
    ]
    let process: ChildProcessWithoutNullStreams
    try {
      const options: Parameters<NonNullable<CodexAppServerDependencies['spawnProcess']>>[2] = {
        cwd: this.workingDirectory,
        env: codexEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      }
      process = this.dependencies.spawnProcess
        ? this.dependencies.spawnProcess(executable, args, options)
        : spawn(executable, args, options) as ChildProcessWithoutNullStreams
    } catch {
      throw new Error('无法启动 Codex App Server。')
    }
    const transport = new CodexTransport(process, (code, signal, stderr, expected, traceId) => {
      if (this.transport === transport) this.transport = null
      // 只记退出码和 OS 信号，区分 CLI 自退、被终止和主动关闭，不写 stderr 正文。
      if (!expected) logSystemEvent('warn', 'llm.codex_app_server.process.exited', {
        traceId,
        exitCode: code,
        processSignal: signal,
        codexFailureReason: classifyServerMessage(stderr),
        diagnosticBytes: Buffer.byteLength(stderr, 'utf8'),
        status: 'failed'
      })
    })
    try {
      await transport.initialize()
      return transport
    } catch (error) {
      await transport.close()
      throw error
    }
  }
}

/** 解析 CLI 的固定位置，不通过 shell，也不读取认证文件。 */
async function findCodexExecutable(): Promise<string | undefined> {
  const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const candidates = [
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, executableName)),
    join(homedir(), '.local', 'bin', executableName),
    join(homedir(), '.npm-global', 'bin', executableName),
    ...(process.platform === 'darwin' ? [
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
    ] : [])
  ]
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return candidate
    } catch {
      // 继续检查其他受支持的安装位置。
    }
  }
  return undefined
}

/** 只向 Codex 进程传递运行所需环境变量，避免泄漏其他供应商 API Key。 */
function codexEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'HOME', 'USERPROFILE', 'CODEX_HOME', 'TMPDIR', 'TEMP', 'LANG', 'LC_ALL', 'SYSTEMROOT']
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
}

/** 读取 turn 中最后一条模型消息；结构化输出由上层再次按 Tripwise schema 校验。 */
function latestAgentMessage(state: ActiveTurn): string {
  for (const id of [...state.messageOrder].reverse()) {
    const message = state.messages.get(id)
    if (message) return message
  }
  return ''
}

/** 归一化 Codex RPC 错误，不把原始服务端正文传给日志。 */
function rpcError(error: RpcError): Error {
  const message = typeof error.message === 'string' ? error.message : ''
  const failureReason = error.code === -32600 && /no active turn to interrupt|no active turn|turn.{0,30}not active/iu.test(message)
    ? 'no_active_turn'
    : error.code === -32601 ? 'unsupported_request'
    : error.code === -32600 || error.code === -32602 ? 'invalid_request'
      : error.code === -32603 ? 'protocol'
        : classifyServerMessage(message)
  return new CodexAppServerError(failureReason, error.code ?? null)
}

/** 把原始诊断转成稳定错误类别；绝不记录路径、提示词或认证内容。 */
function classifyServerMessage(message: string): CodexFailureReason {
  const text = message.toLowerCase()
  if (/thread.*(not found|unknown|does not exist)|unknown thread/u.test(text)) return 'thread_missing'
  if (/rate|429|usage limit|quota|credit/u.test(text)) return 'quota'
  if (/unauthorized|authentication|not logged in|login required|401/u.test(text)) return 'authentication'
  if (/context.{0,20}(length|window)|too many tokens/u.test(text)) return 'context_limit'
  if (/timeout|timed out/u.test(text)) return 'timeout'
  if (/network|connection|socket|dns|503|502/u.test(text)) return 'network'
  if (/already.{0,20}(active|running|in progress)|turn.{0,30}(active|in progress)/u.test(text)) return 'active_turn'
  if (/output.?schema|json.?schema/u.test(text)) return 'output_schema'
  if (/sandbox|readable.?roots/u.test(text)) return 'sandbox_policy'
  if (/model|provider/u.test(text)) return 'model_config'
  if (/json.?rpc|request envelope/u.test(text)) return 'protocol'
  if (/thread.{0,20}(loaded|resume)|not loaded/u.test(text)) return 'thread_state'
  if (/(?:turn\/start|input|content)/u.test(text)) return 'turn_input'
  if (/unsupported|not supported|not allowed|unknown (?:field|parameter)|unexpected (?:field|parameter)/u.test(text)) return 'unsupported_request'
  if (/invalid request|invalid params|invalid parameter|missing required field|malformed/u.test(text)) return 'invalid_request'
  return 'unknown_error'
}

export type CodexFailureReason = 'thread_missing' | 'quota' | 'authentication' | 'context_limit' | 'timeout' | 'network' |
  'invalid_request' | 'unsupported_request' | 'active_turn' | 'output_schema' | 'sandbox_policy' |
  'model_config' | 'protocol' | 'thread_state' | 'turn_input' | 'no_active_turn' | 'process_exit' | 'turn_failed' |
  'upstream_error' | 'policy_blocked' | 'unknown_error'

type CodexServerErrorKind = 'contextWindowExceeded' | 'sessionBudgetExceeded' | 'usageLimitExceeded' |
  'rateLimitExceeded' | 'flexUnavailable' | 'serverOverloaded' | 'modelNotFound' | 'policyCapacityUnavailable' |
  'cyberPolicy' | 'misalignmentPolicyViolation' | 'tooManyDenials' | 'httpConnectionFailed' |
  'responseStreamConnectionFailed' | 'internalServerError' | 'unauthorized' | 'badRequest' | 'threadRollbackFailed' |
  'sandboxError' | 'responseStreamDisconnected' | 'responseTooManyFailedAttempts' | 'activeTurnNotSteerable'

interface SafeCodexServerErrorInfo {
  kind?: CodexServerErrorKind
  httpStatusCode?: number
}

/** 线程缺失可以安全重建；其他失败保留线程，以便用户恢复。 */
export class CodexAppServerError extends Error {
  constructor(
    readonly failureReason: CodexFailureReason,
    readonly rpcCode: number | null,
    readonly processExit?: {
      exitCode: number | null
      processSignal: NodeJS.Signals | null
      diagnosticBytes: number
    },
    readonly serverError?: SafeCodexServerErrorInfo
  ) {
    super(userMessageForFailure(failureReason))
    this.name = 'Error'
  }
}

/** 将内部失败映射到日志安全枚举，不带入服务端原文。 */
export function codexFailureLogFields(error: unknown): Record<string, string | number> {
  if (!(error instanceof CodexAppServerError)) return {}
  const reason = error.failureReason === 'quota' ? 'quota_exceeded'
    : error.failureReason === 'network' ? 'network_error'
      : error.failureReason === 'upstream_error' ? 'upstream_error'
        : error.failureReason === 'policy_blocked' ? 'policy_blocked' : error.failureReason
  const safeRpcCode = error.rpcCode !== null && Number.isSafeInteger(error.rpcCode) && Math.abs(error.rpcCode) <= 1_000_000
    ? error.rpcCode : undefined
  const processExit = error.processExit
  const safeExitCode = processExit?.exitCode !== null && processExit?.exitCode !== undefined &&
    Number.isInteger(processExit.exitCode) && processExit.exitCode >= 0 && processExit.exitCode <= 255
    ? processExit.exitCode : undefined
  const safeProcessSignal = processExit?.processSignal && SAFE_PROCESS_SIGNALS.has(processExit.processSignal)
    ? processExit.processSignal : undefined
  const safeDiagnosticBytes = processExit?.diagnosticBytes !== undefined &&
    Number.isInteger(processExit.diagnosticBytes) && processExit.diagnosticBytes >= 0 &&
    processExit.diagnosticBytes <= MAX_DIAGNOSTIC_BYTES
    ? processExit.diagnosticBytes : undefined
  const serverError = error.serverError
  const safeServerErrorKind = serverError?.kind && SAFE_CODEX_SERVER_ERROR_KINDS.has(serverError.kind)
    ? serverError.kind : undefined
  const safeUpstreamStatus = serverError?.httpStatusCode !== undefined &&
    Number.isInteger(serverError.httpStatusCode) && serverError.httpStatusCode >= 100 &&
    serverError.httpStatusCode <= 599 ? serverError.httpStatusCode : undefined
  return {
    codexFailureReason: reason,
    ...(safeRpcCode !== undefined ? { errorCode: safeRpcCode } : {}),
    ...(safeExitCode !== undefined ? { codexExitCode: safeExitCode } : {}),
    ...(safeProcessSignal !== undefined ? { processSignal: safeProcessSignal } : {}),
    ...(safeDiagnosticBytes !== undefined ? { diagnosticBytes: safeDiagnosticBytes } : {}),
    ...(safeServerErrorKind ? { codexServerErrorKind: safeServerErrorKind } : {}),
    ...(safeUpstreamStatus !== undefined ? { codexUpstreamHttpStatus: safeUpstreamStatus } : {})
  }
}

/** 只提取 App Server 文档定义的错误类别和 HTTP 状态，不保留原始服务端文本。 */
function classifyTurnFailure(errorValue: unknown): {
  reason: CodexFailureReason
  serverError?: SafeCodexServerErrorInfo
} {
  const error = isRecord(errorValue) ? errorValue : {}
  const message = typeof error.message === 'string' ? error.message : ''
  const infoValue = error.codexErrorInfo
  const info = isRecord(infoValue) ? infoValue : {}
  const kind = typeof infoValue === 'string' && SAFE_CODEX_SERVER_ERROR_KINDS.has(infoValue as CodexServerErrorKind)
    ? infoValue as CodexServerErrorKind
    : Object.keys(info).find((key): key is CodexServerErrorKind => SAFE_CODEX_SERVER_ERROR_KINDS.has(key as CodexServerErrorKind))
  const detail = kind && isRecord(info[kind]) ? info[kind] : {}
  const status = detail.httpStatusCode
  const serverError: SafeCodexServerErrorInfo = {
    ...(kind ? { kind } : {}),
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? { httpStatusCode: status } : {})
  }
  const reasonByKind: Partial<Record<CodexServerErrorKind, CodexFailureReason>> = {
    contextWindowExceeded: 'context_limit',
    sessionBudgetExceeded: 'quota',
    usageLimitExceeded: 'quota',
    rateLimitExceeded: 'quota',
    flexUnavailable: 'upstream_error',
    serverOverloaded: 'upstream_error',
    policyCapacityUnavailable: 'upstream_error',
    internalServerError: 'upstream_error',
    responseTooManyFailedAttempts: 'upstream_error',
    cyberPolicy: 'policy_blocked',
    misalignmentPolicyViolation: 'policy_blocked',
    tooManyDenials: 'policy_blocked',
    modelNotFound: 'model_config',
    threadRollbackFailed: 'thread_state',
    activeTurnNotSteerable: 'active_turn',
    badRequest: 'invalid_request',
    unauthorized: 'authentication',
    sandboxError: 'sandbox_policy',
    httpConnectionFailed: 'network',
    responseStreamConnectionFailed: 'network',
    responseStreamDisconnected: 'network'
  }
  const reason = (kind ? reasonByKind[kind] : undefined) ?? classifyServerMessage(message)
  return {
    reason: reason === 'unknown_error' ? 'turn_failed' : reason,
    ...(Object.keys(serverError).length ? { serverError } : {})
  }
}

/** 把运行分类映射为简短、可操作的用户提示。 */
function userMessageForFailure(reason: CodexFailureReason): string {
  if (reason === 'thread_missing') return 'Codex 会话已不存在，Tripwise 会在下次请求时重新建立。'
  if (reason === 'authentication') return 'Codex 登录状态不可用；请先在 Codex CLI 登录后重试。'
  if (reason === 'quota') return 'Codex 当前额度不足或触发限流，请稍后重试。'
  if (reason === 'context_limit') return 'Codex 会话上下文已达到上限，请新建话题后继续。'
  if (reason === 'timeout') return 'Codex App Server 请求超时，已停止本轮。'
  if (reason === 'process_exit') return 'Codex App Server 进程已退出，本轮未完成。'
  if (reason === 'turn_failed') return 'Codex App Server 未能完成本轮；请根据已有资料决定是否重试。'
  if (reason === 'network') return 'Codex 服务连接失败，请检查网络后重试。'
  if (reason === 'upstream_error') return 'Codex 服务暂时无法完成本轮；已保留已有资料，可以稍后继续。'
  if (reason === 'policy_blocked') return 'Codex 服务未能处理本轮请求；已保留已有资料，请调整请求后重试。'
  if (reason === 'invalid_request') return 'Codex App Server 拒绝了本轮请求格式，请更新应用后重试。'
  if (reason === 'unsupported_request') return '当前 Codex App Server 不支持 Tripwise 所需功能，请升级后重试。'
  if (reason === 'active_turn') return 'Codex 话题仍有一轮请求运行，请稍后重试。'
  if (reason === 'no_active_turn') return 'Codex 本轮已停止，请继续修改行程。'
  if (reason === 'output_schema') return 'Codex 返回格式与 Tripwise 当前协议不兼容，请更新 Codex 后重试。'
  if (reason === 'sandbox_policy') return 'Codex 运行隔离设置未通过，Tripwise 已停止本轮请求。'
  if (reason === 'model_config') return '当前 Codex 账户或版本未提供所需模型，请检查模型列表后重试。'
  if (reason === 'protocol') return 'Codex App Server 协议通信失败，请重启 Tripwise 后重试。'
  if (reason === 'thread_state') return 'Codex 会话状态无法恢复，请重试或新建话题。'
  if (reason === 'turn_input') return 'Codex App Server 无法接受本轮输入，请更新 Codex 后重试。'
  return 'Codex App Server 未能完成本轮，请检查本机登录状态后重试。'
}

const SAFE_PROCESS_SIGNALS = new Set<NodeJS.Signals>([
  'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGKILL',
  'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM'
])

const SAFE_CODEX_SERVER_ERROR_KINDS = new Set<CodexServerErrorKind>([
  'contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded', 'flexUnavailable',
  'serverOverloaded', 'modelNotFound', 'policyCapacityUnavailable', 'cyberPolicy', 'misalignmentPolicyViolation',
  'tooManyDenials', 'httpConnectionFailed', 'responseStreamConnectionFailed', 'internalServerError', 'unauthorized',
  'badRequest', 'threadRollbackFailed', 'sandboxError', 'responseStreamDisconnected',
  'responseTooManyFailedAttempts', 'activeTurnNotSteerable'
])

/** 检查模型列表含所需型号和 max 推理档，不发起模型请求。 */
function hasAvailableCodexModel(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.data)) return false
  return value.data.some((model) => isRecord(model) && model.id === 'gpt-6-luna' &&
    Array.isArray(model.supportedReasoningEfforts) && model.supportedReasoningEfforts.some((effort) =>
      isRecord(effort) ? effort.reasoningEffort === 'max' || effort.value === 'max' : effort === 'max'
    ))
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
