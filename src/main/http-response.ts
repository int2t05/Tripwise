/** 以字节上限读取外部响应，避免无长度声明的响应耗尽应用内存。 */

/** 流式读取响应正文；超过上限时立即取消网络读取。 */
export async function readLimitedResponseText(
  response: Response,
  maximumBytes: number,
  oversizedMessage: string
): Promise<string> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(oversizedMessage)
  }

  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(oversizedMessage)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}
