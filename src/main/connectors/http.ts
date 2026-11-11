/** 为外部数据连接器提供限时、限长且不泄漏请求地址的 HTTP 读取。 */
import { readLimitedResponseText } from '../http-response.js'
import { safeTransportErrorCode } from '../system-logger.js'

const MAX_RESPONSE_BYTES = 2_000_000
let externalFetcher: typeof fetch | undefined

/** 注入 Electron Chromium 网络栈；单元测试保留标准 fetch 替身。 */
export function configureExternalFetcher(fetcher?: typeof fetch): void {
  externalFetcher = fetcher
}

/** 下载有限大小的响应；网络错误不携带可能包含查询凭证的完整 URL。 */
export async function fetchText(
  url: string,
  signal?: AbortSignal,
  userAgent = 'Tripwise/0.1',
  timeoutMs = 18_000
): Promise<string> {
  const requestSignal = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(timeoutMs)
  ])
  let response: Response
  try {
    response = await (externalFetcher ?? globalThis.fetch)(url, {
      headers: { 'User-Agent': userAgent },
      redirect: 'error',
      signal: requestSignal
    })
  } catch (error) {
    if (signal?.aborted) throw new Error('外部查询已取消。')
    throw sanitizedTransportError('无法连接外部服务或请求超时。', error)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`外部服务返回 HTTP ${response.status}。`)
  }
  try {
    return await readLimitedResponseText(response, MAX_RESPONSE_BYTES, '外部服务返回内容过大。')
  } catch (error) {
    if (error instanceof Error && error.message === '外部服务返回内容过大。') throw error
    if (requestSignal.aborted) throw sanitizedTransportError('外部服务响应读取失败或请求超时。', error)
    throw sanitizedTransportError('外部服务响应无法读取。', error)
  }
}

/** 解析 JSON 响应并在格式异常时给出不含凭证的错误。 */
export async function fetchJson<T>(url: string, signal?: AbortSignal, userAgent?: string): Promise<T> {
  const text = await fetchText(url, signal, userAgent)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error('外部服务返回了无法识别的数据格式。')
  }
}

/** 向固定服务端点发送有界 JSON 请求，不把请求体或凭证写入日志。 */
export async function postJson<T>(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<T> {
  const requestSignal = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(25_000)
  ])
  let response: Response
  try {
    response = await (externalFetcher ?? globalThis.fetch)(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: requestSignal
    })
  } catch (error) {
    if (signal?.aborted) throw new Error('外部查询已取消。')
    throw sanitizedTransportError('无法连接外部服务或请求超时。', error)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`外部服务返回 HTTP ${response.status}。`)
  }
  try {
    const text = await readLimitedResponseText(response, MAX_RESPONSE_BYTES, '外部服务返回内容过大。')
    return JSON.parse(text) as T
  } catch (error) {
    if (error instanceof Error && error.message === '外部服务返回内容过大。') throw error
    if (requestSignal.aborted) throw sanitizedTransportError('外部服务响应读取失败或请求超时。', error)
    throw sanitizedTransportError('外部服务返回了无法识别的数据格式。', error)
  }
}

/** 保留白名单传输错误码用于诊断，不向错误消息传播底层网络文本。 */
function sanitizedTransportError(message: string, cause: unknown): Error {
  const error = new Error(message)
  const code = safeTransportErrorCode(cause)
  if (code) Object.assign(error, { code })
  return error
}
