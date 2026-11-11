/** 使用本机已保存设置做真实模型连接探针；默认跳过且不输出凭证或模型正文。 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { TravelAgent } from '../src/main/agent.js'
import { TripStore } from '../src/main/persistence.js'
import { SecretVault } from '../src/main/secrets.js'
import { classifyError, configureSystemLogger, flushSystemLogs, isSafeTransportCode } from '../src/main/system-logger.js'
import type { ModelSettings } from '../src/shared/types.js'
import { defaultTripwiseUserDataDirectory } from './helpers/manual-profile.js'

const enabled = process.env.TRIPWISE_MODEL_CONNECTION_LIVE === '1'
const userDataDirectory = resolve(process.env.TRIPWISE_USER_DATA_DIR?.trim() || defaultTripwiseUserDataDirectory())
const timeoutMs = 120_000

/** 读取日志中的安全诊断字段，不读取错误正文、请求内容或凭证。 */
async function safeModelDiagnostics(directory: string): Promise<Record<string, unknown>> {
  const contents = await readFile(join(directory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const entries = contents.split('\n').flatMap((line) => {
    try {
      const entry: unknown = JSON.parse(line)
      return isRecord(entry) ? [entry] : []
    } catch {
      return []
    }
  })
  const failed = entries.slice().reverse().find((entry) => entry.event === 'llm.response.http_failed')
  const transportErrorCodes: Record<string, number> = {}
  for (const entry of entries) {
    if (!isSafeTransportCode(entry.transportCode)) continue
    transportErrorCodes[entry.transportCode] = (transportErrorCodes[entry.transportCode] ?? 0) + 1
  }
  const attempts = entries.filter((entry) => entry.event === 'llm.request.attempt.started')
  const headers = entries.filter((entry) => entry.event === 'llm.response.headers.received')
  const streams = entries.filter((entry) => entry.event === 'llm.stream.completed')
  const completed = entries.filter((entry) => entry.event === 'llm.request.completed')
  const numericFields = [
    'requestBytes', 'messageCharacters', 'systemMessageCharacters', 'userMessageCharacters',
    'assistantMessageCharacters', 'toolMessageCharacters', 'toolCallArgumentCharacters',
    'toolSchemaCharacters', 'messageCount', 'toolCount', 'maxTokens'
  ] as const
  return {
    requestAttempts: attempts.length,
    requestedMaxTokens: attempts.flatMap((entry) => typeof entry.maxTokens === 'number' ? [entry.maxTokens] : []),
    /** 仅输出请求体规模和分段耗时，便于区分模型首响延迟与生成时间。 */
    requestShape: attempts.map((entry) => Object.fromEntries(numericFields.flatMap((field) =>
      typeof entry[field] === 'number' && Number.isFinite(entry[field]) ? [[field, entry[field]]] : []
    ))),
    responseHeadersMs: headers.flatMap((entry) => typeof entry.responseHeadersMs === 'number' ? [entry.responseHeadersMs] : []),
    streamMetrics: streams.map((entry) => Object.fromEntries([
      'streamDurationMs', 'streamChunkCount', 'firstChunkMs', 'firstContentMs', 'firstToolCallMs',
      'responseBytes', 'reasoningBytes', 'contentBytes', 'toolCallArgumentBytes'
    ].flatMap((field) => typeof entry[field] === 'number' && Number.isFinite(entry[field])
      ? [[field, entry[field]]] : []))),
    requestDurationMs: completed.flatMap((entry) => typeof entry.durationMs === 'number' ? [entry.durationMs] : []),
    transportErrorCodes,
    ...(failed && typeof failed.httpStatus === 'number' ? { httpStatus: failed.httpStatus } : {}),
    ...(failed && typeof failed.errorCode === 'string' ? { errorCode: failed.errorCode } : {}),
    ...(failed && typeof failed.retryAfterMs === 'number' ? { retryAfterMs: failed.retryAfterMs } : {}),
    ...(failed && typeof failed.maxTokens === 'number' ? { maxTokens: failed.maxTokens } : {})
  }
}

/** 避免把异常对象或任意模型资料识别为日志记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

it.skipIf(!enabled)('用已保存配置完成真实 OpenAI-compatible 模型工具调用', async () => {
  const profile = JSON.parse(await readFile(join(userDataDirectory, 'tripwise-data.json'), 'utf8')) as unknown
  const model = isRecord(profile) && isRecord(profile.settings) ? profile.settings.model : undefined
  if (!isModelSettings(model)) throw new Error('model_settings_missing')

  const vault = new SecretVault(userDataDirectory)
  await vault.initialize()
  if (!await vault.get('modelKey')) throw new Error('model_key_missing')

  const temporaryLogDirectory = await mkdtemp(join(tmpdir(), 'tripwise-model-probe-'))
  const deadline = new AbortController()
  const timeoutError = new Error('model_probe_timeout')
  timeoutError.name = 'TimeoutError'
  const timeout = setTimeout(() => deadline.abort(timeoutError), timeoutMs)
  configureSystemLogger(temporaryLogDirectory)

  try {
    const store = { snapshot: () => ({ settings: { model } }) } as unknown as TripStore
    const result = await new TravelAgent().testConnection(vault, store, deadline.signal)
    await flushSystemLogs()
    const diagnostics = await safeModelDiagnostics(temporaryLogDirectory)
    process.stdout.write(`[model-connection-live] ${JSON.stringify({
      ok: result.ok,
      errorKind: result.ok ? undefined : classifyError(new Error(result.message)),
      message: result.message,
      ...diagnostics
    })}\n`)
    expect(result.ok, result.message).toBe(true)
  } finally {
    clearTimeout(timeout)
    await flushSystemLogs()
    await rm(temporaryLogDirectory, { recursive: true, force: true })
  }
}, timeoutMs + 15_000)

/** 只接受保存设置中的模型 ID 和普通服务地址。 */
function isModelSettings(value: unknown): value is ModelSettings {
  if (!isRecord(value) || typeof value.baseUrl !== 'string' || typeof value.model !== 'string') return false
  try {
    const url = new URL(value.baseUrl)
    return url.protocol === 'https:' && value.model.trim().length > 0
  } catch {
    return false
  }
}
