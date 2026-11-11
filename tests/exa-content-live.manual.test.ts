/** 仅在显式启用时检查 Exa 对公开官网页面的正文提取；不输出正文或凭证。 */
import { resolve } from 'node:path'
import { it } from 'vitest'
import { SecretVault } from '../src/main/secrets.js'
import { postJson } from '../src/main/connectors/http.js'
import { defaultTripwiseUserDataDirectory } from './helpers/manual-profile.js'

const enabled = process.env.TRIPWISE_EXA_CONTENT_LIVE_TEST === '1'
const profileDirectory = resolve(
  process.env.TRIPWISE_USER_DATA_DIR?.trim() || defaultTripwiseUserDataDirectory()
)

/** 仅保留安全诊断字段，页面内容和请求凭证绝不写入测试输出。 */
it.skipIf(!enabled)('使用本机 Exa 凭证读取一页故宫官网正文并输出脱敏诊断', async () => {
  const vault = new SecretVault(profileDirectory)
  await vault.initialize()
  const apiKey = await vault.get('exaKey')
  if (!apiKey) throw new Error('missing_saved_exa_key')

  const response = await postJson<unknown>('https://api.exa.ai/contents', {
    ids: ['https://www.dpm.org.cn/Visit.html'],
    text: { maxCharacters: 2_400 }
  }, { 'x-api-key': apiKey })
  if (!isRecord(response) || !Array.isArray(response.results)) {
    throw new Error('exa_contents_response_unrecognized')
  }

  const result = response.results.find((item) => isRecord(item) && item.url === 'https://www.dpm.org.cn/Visit.html')
  const pageText = isRecord(result) && typeof result.text === 'string' ? result.text : ''
  const pageStatus = Array.isArray(response.statuses)
    ? response.statuses.find((item) => isRecord(item) && item.id === 'https://www.dpm.org.cn/Visit.html')
    : undefined
  process.stderr.write(`${JSON.stringify({
    pageStatus: isRecord(pageStatus) && typeof pageStatus.status === 'string' ? pageStatus.status : 'missing',
    textCharacters: pageText.length,
    hasOpeningHoursTerms: /开放|闭馆|停止入场/u.test(pageText),
    hasBookingTerms: /预约|购票/u.test(pageText),
    hasReportedCost: isRecord(response.costDollars) && typeof response.costDollars.total === 'number'
  })}\n`)
})

/** 约束 API 响应只按对象字段读取，不把任何外部值当作可执行内容。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
