/** 使用本机凭证验证模型参数与工具 schema；默认跳过且不输出模型正文或凭证。 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { itineraryMealRepairTool } from '../src/main/connectors/itinerary-meals.js'
import { itineraryProposalDefinitionForBudget } from '../src/main/connectors/itinerary.js'
import { closeModelTransport, OpenAiCompatibleClient } from '../src/main/llm.js'
import { SecretVault } from '../src/main/secrets.js'
import { classifyError, configureSystemLogger, flushSystemLogs } from '../src/main/system-logger.js'
import type { ModelSettings } from '../src/shared/types.js'
import type { ToolDefinition } from '../src/main/connectors/types.js'

const enabled = process.env.TRIPWISE_MODEL_PARAMETER_LIVE === '1'
const userDataDirectory = resolve(process.env.TRIPWISE_USER_DATA_DIR?.trim() || defaultUserDataDirectory())
const timeoutMs = 120_000

/** 使用 Electron 默认资料目录；可通过环境变量指定隔离的用户资料。 */
function defaultUserDataDirectory(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'tripwise')
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'tripwise')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'tripwise')
}

/** 只接受已保存的模型地址和模型 ID。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 只允许 HTTPS 模型地址，避免诊断探针访问本机或局域网服务。 */
function isModelSettings(value: unknown): value is ModelSettings {
  if (!isRecord(value) || typeof value.baseUrl !== 'string' || typeof value.model !== 'string') return false
  try {
    const url = new URL(value.baseUrl)
    return url.protocol === 'https:' && value.model.trim().length > 0
  } catch {
    return false
  }
}

/** 只读取模型错误日志中的状态码和白名单参数名。 */
async function latestHttpFailure(directory: string): Promise<Record<string, string | number>> {
  const contents = await readFile(join(directory, 'logs', 'tripwise.log'), 'utf8').catch(() => '')
  const entries = contents.split('\n').flatMap((line) => {
    try {
      const entry: unknown = JSON.parse(line)
      return isRecord(entry) ? [entry] : []
    } catch {
      return []
    }
  })
  const failure = entries.slice().reverse().find((entry) => entry.event === 'llm.response.http_failed')
  return failure
    ? Object.fromEntries(['httpStatus', 'errorCode', 'errorParameter'].flatMap((key) =>
      typeof failure[key] === 'string' || typeof failure[key] === 'number' ? [[key, failure[key] as string | number]] : []
    ))
    : {}
}

/** 仅当用户显式开启时调用真实模型，记录 medium 兼容性并确认 low 双工具调用。 */
it.skipIf(!enabled)('模型兼容性：记录 medium 兼容性并确认 low 双工具调用', async () => {
  const profile = JSON.parse(await readFile(join(userDataDirectory, 'tripwise-data.json'), 'utf8')) as unknown
  const model = isRecord(profile) && isRecord(profile.settings) ? profile.settings.model : undefined
  if (!isModelSettings(model)) throw new Error('model_settings_missing')

  const vault = new SecretVault(userDataDirectory)
  await vault.initialize()
  const apiKey = await vault.get('modelKey')
  if (!apiKey) throw new Error('model_key_missing')

  const proposalTool = itineraryProposalDefinitionForBudget({
    budgetRequested: false,
    requireNamedMealStops: true,
    detailedItineraryRequested: true
  })
  const mealTool = itineraryMealRepairTool.definition
  const probes: Array<{ reasoningEffort: 'low' | 'medium'; tools: ToolDefinition[] }> = [
    { reasoningEffort: 'medium', tools: [proposalTool] },
    { reasoningEffort: 'low', tools: [proposalTool, mealTool] }
  ]
  const temporaryLogDirectory = await mkdtemp(join(tmpdir(), 'tripwise-model-parameter-'))
  const deadline = new AbortController()
  const timeoutError = new Error('model_parameter_probe_timeout')
  timeoutError.name = 'TimeoutError'
  const timeout = setTimeout(() => deadline.abort(timeoutError), timeoutMs)
  configureSystemLogger(temporaryLogDirectory)

  try {
    const outcomes = []
    for (const [index, probe] of probes.entries()) {
      try {
        const result = await new OpenAiCompatibleClient().complete(
          model,
          apiKey,
          [
            { role: 'system', content: '请严格按要求调用工具，不输出额外说明。' },
            { role: 'user', content: '提交一套北京一日行程：09:00 到 11:00 参观故宫博物院，类别为人文。只调用 propose_itineraries。' }
          ],
          probe.tools,
          deadline.signal,
          [],
          `model-parameter-compatibility-probe-${index + 1}`,
          'compact',
          'required',
          probe.reasoningEffort
        )
        outcomes.push({
          reasoningEffort: probe.reasoningEffort,
          toolCount: probe.tools.length,
          outcome: 'completed',
          toolName: result.tool_calls?.[0]?.function.name ?? 'none'
        })
      } catch (error) {
        await flushSystemLogs()
        outcomes.push({
          reasoningEffort: probe.reasoningEffort,
          toolCount: probe.tools.length,
          outcome: classifyError(error),
          ...(await latestHttpFailure(temporaryLogDirectory))
        })
      }
    }
    process.stdout.write(`[model-parameter-live] ${JSON.stringify(outcomes)}\n`)
    expect(outcomes[1]?.outcome).toBe('completed')
  } finally {
    clearTimeout(timeout)
    await flushSystemLogs()
    await closeModelTransport()
    await rm(temporaryLogDirectory, { recursive: true, force: true })
  }
}, timeoutMs + 15_000)
