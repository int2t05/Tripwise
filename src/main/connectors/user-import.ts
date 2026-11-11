/** 校验并规范化用户主动粘贴的旅行攻略，内容按不可信来源保存。 */
import { randomUUID } from 'node:crypto'
import type { SourceRecord } from '../../shared/types.js'

const MAX_TITLE_LENGTH = 200
const MAX_URL_LENGTH = 4_000
const MAX_TEXT_LENGTH = 30_000

/** 生成用户提供来源记录；不访问链接或将文字发送到外部服务。 */
export function createUserProvidedSource(input: unknown): SourceRecord {
  if (!isRecord(input)) throw new Error('粘贴内容格式无效。')
  const title = cleanSingleLine(input.title, MAX_TITLE_LENGTH)
  if (!title) throw new Error('请填写资料标题。')
  const url = normalizeOptionalUrl(input.url)
  const text = cleanPastedText(input.text)
  if (!text) throw new Error('请粘贴攻略正文。')
  if (text.length > MAX_TEXT_LENGTH) throw new Error(`正文最多 ${MAX_TEXT_LENGTH.toLocaleString()} 个字符。`)

  return {
    id: randomUUID(),
    title,
    url,
    provider: '用户粘贴',
    kind: 'user',
    summary: text,
    fetchedAt: new Date().toISOString(),
    status: 'success',
    contentLevel: 'user-provided',
    sourceNature: 'user-provided'
  }
}

/** 可选来源链接只接受普通 HTTP(S) 地址，并拒绝内嵌账号密码。 */
function normalizeOptionalUrl(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error('来源链接格式无效。')
  const normalized = value.trim()
  if (!normalized) return ''
  if (normalized.length > MAX_URL_LENGTH) throw new Error('来源链接过长或格式无效。')
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw new Error('来源链接必须是完整的 HTTP 或 HTTPS 地址。')
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('来源链接只支持普通 HTTP 或 HTTPS 地址。')
  }
  return url.href
}

/** 清除不可见控制符，保留换行，便于用户粘贴多段攻略。 */
function cleanPastedText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('正文格式无效。')
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim()
}

/** 标题以单行展示，避免控制符污染来源列表。 */
function cleanSingleLine(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

/** 拒绝数组和 null，保持 IPC 输入为普通记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
