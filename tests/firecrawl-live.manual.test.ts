/** 仅在显式启用时用本机保存的 Firecrawl 凭证读取一个公开官方页面。 */
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { webPageReadTool } from '../src/main/connectors/web-page.js'
import { createSource } from '../src/main/connectors/types.js'
import { SecretVault } from '../src/main/secrets.js'
import { defaultTripwiseUserDataDirectory } from './helpers/manual-profile.js'

const enabled = process.env.TRIPWISE_FIRECRAWL_LIVE_TEST === '1'
const profileDirectory = resolve(process.env.TRIPWISE_USER_DATA_DIR?.trim() || defaultTripwiseUserDataDirectory())
const sourceUrl = 'https://www.dpm.org.cn/Visit.html'

/** 只输出固定错误类别和摘录长度，不回显网页正文、错误正文或凭证。 */
function firecrawlFailureClass(summary: string): string {
  const httpStatus = summary.match(/\bHTTP (\d{3})\b/u)?.[1]
  if (httpStatus === '402') return 'quota'
  if (httpStatus === '429') return 'rate_limit'
  if (httpStatus) return `http_${httpStatus}`
  if (/请求超时|无法连接/u.test(summary)) return 'network_or_timeout'
  if (/没有可读取的正文/u.test(summary)) return 'empty_body'
  return 'provider_or_format_error'
}

it.skipIf(!enabled)('读取一个官方公开页面并输出 Firecrawl 脱敏状态', async () => {
  const vault = new SecretVault(profileDirectory)
  await vault.initialize()
  const firecrawlKey = await vault.get('firecrawlKey')
  expect(firecrawlKey, '本机 Firecrawl 凭证未配置。').toBeTruthy()

  const inputSource = createSource('故宫参观指南', sourceUrl, 'Exa 搜索结果', 'web', '官方参观页面。')
  const result = await webPageReadTool.execute({ url: sourceUrl }, {
    amapKey: null,
    firecrawlKey: firecrawlKey!,
    availableSources: [inputSource]
  })
  const bodySource = result.sources[0]
  const success = bodySource?.status === 'success' && bodySource.provider === 'Firecrawl 网页正文'
  const failureClass = success ? undefined : firecrawlFailureClass(bodySource?.summary ?? '')
  process.stderr.write(`${JSON.stringify({
    provider: 'Firecrawl', status: success ? 'success' : 'error',
    ...(failureClass ? { failureClass } : {}),
    excerptCharacters: success ? bodySource.summary.length : 0
  })}\n`)

  expect(success, `Firecrawl 单页读取失败：${failureClass ?? 'unknown'}`).toBe(true)
  expect(bodySource?.url).toBe(sourceUrl)
  expect(JSON.stringify(result)).not.toContain(firecrawlKey!)
})
