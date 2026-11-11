/** 使用本机已登录的 Codex App Server 验证 Tripwise 结构化工具调用；默认跳过且不输出模型正文。 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { briefProposalTool } from '../src/main/connectors/brief.js'
import { CodexAppServer } from '../src/main/codex-app-server.js'
import { closeModelTransport, OpenAiCompatibleClient } from '../src/main/llm.js'
import { configureSystemLogger, flushSystemLogs } from '../src/main/system-logger.js'
import type { ModelSettings } from '../src/shared/types.js'

const enabled = process.env.TRIPWISE_CODEX_APP_SERVER_LIVE === '1'
const timeoutMs = 300_000

/** 从隔离日志中只提取固定类别与请求大小，不读提示词或模型结果。 */
async function readCodexProbeSummary(directory: string): Promise<Record<string, unknown>> {
  const content = await readFile(join(directory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const entries = content.split('\n').flatMap((line) => {
    try {
      const entry: unknown = JSON.parse(line)
      return entry && typeof entry === 'object' && !Array.isArray(entry)
        ? [entry as Record<string, unknown>]
        : []
    } catch {
      return []
    }
  })
  return {
    requestStarted: entries.some((entry) => entry.event === 'llm.request.started'),
    requestCompleted: entries.some((entry) => entry.event === 'llm.request.completed'),
    failure: entries.flatMap((entry) => entry.event === 'llm.request.failed' ? [{
      errorKind: entry.errorKind,
      codexFailureStage: entry.codexFailureStage,
      codexErrorClass: entry.codexErrorClass
    }] : []),
    requestShape: entries.flatMap((entry) => entry.event === 'llm.request.started' ? [{
      promptBytes: entry.codexPromptBytes,
      schemaBytes: entry.codexSchemaBytes,
      imageCount: entry.codexImageCount
    }] : []),
    appServerStages: entries.filter((entry) => typeof entry.event === 'string' && entry.event.startsWith('llm.codex_app_server.'))
      .map((entry) => ({ event: entry.event, stage: entry.codexStage, reason: entry.codexFailureReason, errorCode: entry.errorCode, exitCode: entry.exitCode, processSignal: entry.processSignal, status: entry.status })),
    interruptOutcomes: entries.filter((entry) => entry.event === 'llm.codex_app_server.turn.interrupt')
      .map((entry) => ({ status: entry.status, reason: entry.codexFailureReason, durationMs: entry.durationMs })),
    processRestartCount: entries.filter((entry) => entry.event === 'llm.codex_app_server.process.restarting').length
  }
}

/** 等待指定安全阶段，遇到响应完成或总时限时只返回固定失败类别。 */
async function waitForCodexEvent(directory: string, event: string, traceId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const path = join(directory, 'logs', 'tripwise.log')
  while (Date.now() < deadline) {
    const content = await readFile(path, 'utf8').catch(() => '')
    const entries = content.split('\n').flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line)
        return value && typeof value === 'object' && !Array.isArray(value)
          ? [value as Record<string, unknown>]
          : []
      } catch {
        return []
      }
    })
    if (entries.some((entry) => entry.traceId === traceId && entry.event === 'llm.request.completed')) {
      throw new Error('Codex App Server 本轮在取消前已完成。')
    }
    if (entries.some((entry) => entry.traceId === traceId && entry.event === event)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Codex App Server 阶段等待超时。')
}

it.skipIf(!enabled)('Codex App Server：完成真实 Tripwise 结构化工具调用', async () => {
  const baseUrl = 'https://api.openai.com/v1'
  const temporaryUserDataDirectory = await mkdtemp(join(tmpdir(), 'tripwise-codex-app-server-probe-'))
  const deadline = new AbortController()
  const timeoutError = new Error('Codex App Server smoke probe timed out')
  timeoutError.name = 'TimeoutError'
  const timeout = setTimeout(() => deadline.abort(timeoutError), timeoutMs)
  const traceId = randomUUID()
  configureSystemLogger(temporaryUserDataDirectory)
  const codexAppServer = new CodexAppServer(temporaryUserDataDirectory)

  try {
    let result: Awaited<ReturnType<OpenAiCompatibleClient['complete']>> | undefined
    let failureKind = ''
    try {
      result = await new OpenAiCompatibleClient(codexAppServer).complete(
        { provider: 'codex-cli', baseUrl, model: 'gpt-6-luna' } satisfies ModelSettings,
        '',
        [
          { role: 'system', content: '这是连接测试。只需调用 propose_trip_brief 工具，提取用户明确说出的目的地；不要返回其他内容。' },
          { role: 'user', content: '我这次想去北京。' }
        ],
        [briefProposalTool.definition],
        deadline.signal,
        [],
        traceId,
        'compact',
        { type: 'function', function: { name: 'propose_trip_brief' } },
        'max'
      )
    } catch (error) {
      failureKind = error instanceof Error ? error.name : 'UnknownError'
    }
    await flushSystemLogs()
    const diagnostics = await readCodexProbeSummary(temporaryUserDataDirectory)
    const toolCall = result?.tool_calls?.find((call) => call.function.name === 'propose_trip_brief')
    process.stdout.write(`[codex-app-server-smoke] ${JSON.stringify({
      outcome: toolCall ? 'completed' : 'failed',
      reasoningEffort: 'max',
      failureKind: failureKind || undefined,
      toolCallCount: result?.tool_calls?.length ?? 0,
      ...diagnostics
    })}\n`)
    expect(toolCall).toBeDefined()
  } finally {
    clearTimeout(timeout)
    await flushSystemLogs()
    await codexAppServer.close()
    await closeModelTransport()
    await rm(temporaryUserDataDirectory, { recursive: true, force: true })
  }
}, timeoutMs + 15_000)

it.skipIf(!enabled)('Codex App Server：取消活动 turn 后恢复同一 Tripwise thread', async () => {
  const baseUrl = 'https://api.openai.com/v1'
  const temporaryUserDataDirectory = await mkdtemp(join(tmpdir(), 'tripwise-codex-app-server-cancel-'))
  const cancellation = new AbortController()
  const deadline = setTimeout(() => cancellation.abort(), timeoutMs)
  const conversationKey = `live-cancel:${randomUUID()}`
  const cancelledTraceId = randomUUID()
  const recoveryTraceId = randomUUID()
  configureSystemLogger(temporaryUserDataDirectory)
  const codexAppServer = new CodexAppServer(temporaryUserDataDirectory)
  const client = new OpenAiCompatibleClient(codexAppServer)
  const settings = { provider: 'codex-cli', baseUrl, model: 'gpt-6-luna' } satisfies ModelSettings

  try {
    const cancelledTurn = client.complete(settings, '', [
      { role: 'system', content: '这是 Tripwise 连接恢复测试。按要求调用工具，不要提供其他内容。' },
      { role: 'user', content: '我想去北京，请提取目的地。' }
    ], [briefProposalTool.definition], cancellation.signal, [], cancelledTraceId, 'compact',
    { type: 'function', function: { name: 'propose_trip_brief' } }, 'max', false, {
      conversationKey, userText: '我想去北京，请提取目的地。', phase: 'run-start'
    })

    await waitForCodexEvent(temporaryUserDataDirectory, 'llm.codex_app_server.turn.accepted', cancelledTraceId, 60_000)
    cancellation.abort()
    await expect(cancelledTurn).rejects.toThrow('请求已取消。')
    await waitForCodexEvent(temporaryUserDataDirectory, 'llm.codex_app_server.turn.failed', cancelledTraceId, 10_000)
    const recovered = await client.complete(settings, '', [
      { role: 'system', content: '只用一句话确认恢复。' },
      { role: 'user', content: '请回复“已恢复”。' }
    ], [], undefined, [], recoveryTraceId, 'compact', 'auto', 'max', false, {
      conversationKey, userText: '请回复“已恢复”。', phase: 'run-start'
    })
    await flushSystemLogs()
    const diagnostics = await readCodexProbeSummary(temporaryUserDataDirectory)
    const appServerStages = diagnostics.appServerStages as Array<Record<string, unknown>>
    const cancelledTurnCount = appServerStages.filter((entry) =>
      entry.event === 'llm.codex_app_server.turn.failed' && entry.status === 'cancelled'
    ).length
    const resumedThreadCount = appServerStages.filter((entry) =>
      entry.event === 'llm.codex_app_server.thread.resumed'
    ).length
    const unexpectedExitCount = appServerStages.filter((entry) =>
      entry.event === 'llm.codex_app_server.process.exited'
    ).length
    const forcedStopCount = appServerStages.filter((entry) =>
      entry.event === 'llm.codex_app_server.turn.interrupt_timeout'
    ).length
    process.stdout.write(`[codex-app-server-cancel-smoke] ${JSON.stringify({
      cancelledTurnCount,
      resumedThreadCount,
      unexpectedExitCount,
      forcedStopCount,
      recoveryResponsePresent: typeof recovered.content === 'string' && recovered.content.length > 0,
      ...diagnostics
    })}\n`)
    expect(cancelledTurnCount).toBe(1)
    expect(resumedThreadCount).toBeGreaterThan(0)
    expect(unexpectedExitCount).toBe(0)
    expect(forcedStopCount).toBe(0)
    expect(typeof recovered.content).toBe('string')
  } finally {
    clearTimeout(deadline)
    await flushSystemLogs()
    await codexAppServer.close()
    await closeModelTransport()
    await rm(temporaryUserDataDirectory, { recursive: true, force: true })
  }
}, timeoutMs * 2 + 15_000)
