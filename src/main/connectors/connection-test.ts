/** 以固定、非个人请求测试内置连接器，不保存结果或返回内容。 */
import type { BuiltinConnectorTestId } from '../../shared/types.js'
import { testAmapWebService } from './places.js'
import { testSearchProvider } from './web-search.js'
import { testFirecrawlConnection } from './web-page.js'

export interface ConnectorConnectionTestResult {
  ok: boolean
  message: string
}

/** 只验证单个服务的凭证和响应结构，不触发备用服务。 */
export async function testBuiltinConnector(
  provider: BuiltinConnectorTestId,
  apiKey: string
): Promise<ConnectorConnectionTestResult> {
  const label = providerLabel(provider)
  try {
    if (provider === 'exa' || provider === 'tavily') {
      const count = await testSearchProvider(provider, apiKey)
      return { ok: true, message: `${label}连接成功；测试查询返回 ${count} 条结果。` }
    }
    if (provider === 'firecrawl') {
      await testFirecrawlConnection(apiKey)
      return { ok: true, message: 'Firecrawl 连接成功；公开示例页读取正常。' }
    }
    const count = await testAmapWebService(apiKey)
    return { ok: true, message: `高德 Web 服务连接成功；固定地点查询返回 ${count} 个候选。` }
  } catch (error) {
    return { ok: false, message: `${label}连接失败：${safeFailureMessage(error, provider)}` }
  }
}

/** 将服务标识映射为固定中文名称。 */
function providerLabel(provider: BuiltinConnectorTestId): string {
  const labels: Record<BuiltinConnectorTestId, string> = {
    exa: 'Exa',
    tavily: 'Tavily',
    firecrawl: 'Firecrawl',
    amap: '高德 Web 服务'
  }
  return labels[provider]
}

/** 按服务商已知状态提示额度或套餐问题，其余只显示 HTTP 码。 */
function safeFailureMessage(error: unknown, provider: BuiltinConnectorTestId): string {
  if (!(error instanceof Error)) return '服务暂时不可用，请检查网络后重试。'
  const message = error.message
  const httpStatus = message.match(/^外部服务返回 HTTP (\d{3})。$/u)?.[1]
  if (httpStatus === '402' && (provider === 'exa' || provider === 'firecrawl')) {
    return '服务额度或账单不可用，请检查服务商账户。'
  }
  if ((httpStatus === '432' || httpStatus === '433') && provider === 'tavily') {
    return '服务商报告套餐或使用上限，请检查账户方案。'
  }
  if (httpStatus) return message
  if (/^(?:无法连接外部服务或请求超时|外部服务返回了无法识别的数据格式|外部服务响应读取失败或请求超时|外部服务响应无法读取|外部服务返回内容过大|Exa 返回的数据格式无法识别|Tavily 返回的数据格式无法识别|Firecrawl 测试页面没有返回正文|高德地点服务暂时不可用)\u3002?$/.test(message)) {
    return message
  }
  return '服务暂时不可用，请检查凭证和网络后重试。'
}
