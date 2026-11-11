/** 仅在显式启用时检查本机已保存的 Exa/Tavily 搜索连接；输出只含脱敏渠道计数。 */
import { resolve } from 'node:path'
import { it } from 'vitest'
import { SecretVault } from '../src/main/secrets.js'
import { webSearchTool } from '../src/main/connectors/web-search.js'
import { defaultTripwiseUserDataDirectory } from './helpers/manual-profile.js'

const enabled = process.env.TRIPWISE_WEB_SEARCH_LIVE_TEST === '1'
const profileDirectory = resolve(
  process.env.TRIPWISE_USER_DATA_DIR?.trim() || defaultTripwiseUserDataDirectory()
)

/** 只把来源压缩为固定渠道名、状态和安全错误类别，不返回原文或凭证。 */
function summarizeProviderStatuses(
  sources: Array<{ provider: string; status: string; summary: string }>
): { providers: Record<string, Record<string, number>>; failures: Record<string, Record<string, number>> } {
  const providers: Record<string, Record<string, number>> = {}
  const failures: Record<string, Record<string, number>> = {}
  for (const source of sources) {
    const providerName = source.provider.replace(/\s+搜索结果$/u, '')
    const provider = ['Exa', 'Tavily', 'Firecrawl', 'DuckDuckGo'].includes(providerName) ? providerName : 'other'
    const status = ['success', 'partial', 'error'].includes(source.status) ? source.status : 'other'
    const counts = providers[provider] ??= {}
    counts[status] = (counts[status] ?? 0) + 1
    if (source.status === 'error') {
      const httpStatus = source.summary.match(/\bHTTP\s+(\d{3})\b/u)?.[1]
      const failureClass = httpStatus === '432' || httpStatus === '433' ? 'plan_limit'
        : httpStatus === '402' ? 'quota'
        : httpStatus === '429' ? 'rate_limit'
          : httpStatus === '401' || httpStatus === '403' ? 'access_error'
            : httpStatus ? `http_${httpStatus}`
              : /超时/u.test(source.summary) ? 'timeout'
                : /连接|network/iu.test(source.summary) ? 'network_error' : 'provider_error'
      const failureCounts = failures[provider] ??= {}
      failureCounts[failureClass] = (failureCounts[failureClass] ?? 0) + 1
    }
  }
  return { providers, failures }
}

it.skipIf(!enabled)('使用本机已保存凭证执行一次脱敏网页搜索', async () => {
  const vault = new SecretVault(profileDirectory)
  await vault.initialize()
  const [exaKey, tavilyKey, firecrawlKey] = await Promise.all([
    vault.get('exaKey'), vault.get('tavilyKey'), vault.get('firecrawlKey')
  ])
  if (!exaKey && !tavilyKey && !firecrawlKey) throw new Error('missing_saved_search_provider_key')

  const searchProviderCircuitBreaker = {
    disabled: new Set<'Exa' | 'Tavily' | 'Firecrawl' | 'DuckDuckGo'>()
  }

  const result = await webSearchTool.execute({
    query: '北京 故宫 官方 开放时间 预约'
  }, { amapKey: null, exaKey, tavilyKey, firecrawlKey, searchProviderCircuitBreaker })
  const providerSummary = summarizeProviderStatuses(result.sources)
  const successCount = Object.values(providerSummary.providers).reduce((count, statuses) => count + (statuses.success ?? 0), 0)
  process.stderr.write(`${JSON.stringify({
    providers: providerSummary.providers,
    failures: providerSummary.failures,
    disabledProviders: [...searchProviderCircuitBreaker.disabled].sort(),
    successfulResultCount: successCount,
  })}\n`)
}, 45_000)
