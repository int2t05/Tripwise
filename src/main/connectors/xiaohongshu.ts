/** 通过用户配置的 OpenCLI 只读搜索小红书笔记并保存来源。 */
import { spawn } from 'node:child_process'
import type { OpenCliSettings, SourceRecord } from '../../shared/types.js'
import { modelSafeResearchUrl } from '../research-url.js'
import { createSource, requireText, ToolInputError, type TravelTool } from './types.js'

const OPENCLI_TIMEOUT_MS = 90_000
const MAX_STDOUT_BYTES = 2_000_000
const MAX_SEARCH_RESULTS = 5
const MAX_NOTE_TEXT = 5_000
const MIN_OPENCLI_INTERVAL_MS = 3_000
const XHS_HOSTS = new Set(['www.xiaohongshu.com', 'xiaohongshu.com'])
let openCliQueue: Promise<void> = Promise.resolve()
let lastOpenCliCallAt = 0

interface OpenCliInvocation {
  settings: OpenCliSettings
  args: string[]
  signal?: AbortSignal
}

type OpenCliInvoker = (invocation: OpenCliInvocation) => Promise<string>

export interface XiaohongshuSearchRow {
  title: string
  author: string
  likes: string
  url: string
}

interface NoteContent {
  title: string
  author: string
  text: string
  tags: string[]
  url: string
}

/** 将站点 CLI 错误映射成安全、可操作的用户提示，不回显原始 stderr。 */
export class XiaohongshuConnectorError extends Error {
  /** 只向界面传递脱敏后的站点错误说明。 */
  constructor(message: string) {
    super(message)
    this.name = 'XiaohongshuConnectorError'
  }
}

/** 创建只读的小红书搜索与笔记读取工具，便于用替身验证参数边界。 */
export function createXiaohongshuTools(invoke: OpenCliInvoker = runOpenCli): {
  search: TravelTool
  read: TravelTool
} {
  const search: TravelTool = {
    definition: {
      type: 'function',
      function: {
        name: 'search_xiaohongshu',
        description: '在用户已登录的 Chrome 会话中搜索公开小红书笔记，结果仅作为游客经验线索，不是官方事实。每次最多取 5 条；遇到登录墙或平台限制时停止并说明。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '目的地、景点或旅行主题关键词' },
            limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS, description: '结果数量，最多 5 条' }
          },
          required: ['query'],
          additionalProperties: false
        }
      }
    },
    provider: 'OpenCLI · 小红书',
    kind: 'web',
    sourceUrl: 'https://www.xiaohongshu.com/',
    isAvailable: (context) => isConfigured(context.xiaohongshu),
    /** 调用用户启用的 OpenCLI 搜索公开笔记并保存结构化结果。 */
    async execute(args, context, signal) {
      const query = requireText(args, 'query', 2, 100)
      const limit = boundedLimit(args.limit)
      const settings = requireSettings(context.xiaohongshu)
      const output = await invoke({
        settings,
        args: ['xiaohongshu', 'search', query, '--limit', String(limit), '-f', 'json'],
        signal
      })
      const rows = parseXiaohongshuSearchResults(output, limit)
      if (!rows.length) throw new XiaohongshuConnectorError('小红书没有返回可读取的笔记；可以尝试更具体的关键词，或粘贴攻略链接。')

      const sources = rows.map((row) => createSource(
        row.title,
        row.url,
        'OpenCLI · 小红书',
        'web',
        `搜索词“${query}” · 作者：${row.author || '页面未显示'} · 点赞：${row.likes || '未显示'}。此内容是社区经验，未经 Tripwise 独立核验。`,
        'success',
        undefined,
        row.author ? { declaredAuthor: row.author } : undefined
      ))
      const indexedSources = rows.map((row, index) => ({ row, source: sources[index] }))
      return {
        output: formatSearchOutput(query, indexedSources),
        sources
      }
    }
  }

  const read: TravelTool = {
    definition: {
      type: 'function',
      function: {
        name: 'read_xiaohongshu_note',
        description: '读取本旅行已搜索并保存来源中的一篇小红书公开笔记正文。不能读取未检索来源中的任意链接、个人主页、收藏、通知或评论。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: '本旅行小红书搜索结果中的完整笔记链接' } },
          required: ['url'],
          additionalProperties: false
        }
      }
    },
    provider: 'OpenCLI · 小红书',
    kind: 'web',
    sourceUrl: 'https://www.xiaohongshu.com/',
    isAvailable: (context) => isConfigured(context.xiaohongshu) && (context.availableSources ?? []).some(isXiaohongshuSource),
    /** 仅读取当前旅行已保存并校验过的笔记链接。 */
    async execute(args, context, signal) {
      const inputUrl = requireText(args, 'url', 10, 2_000)
      const source = (context.availableSources ?? []).find((item) => isXiaohongshuSource(item) && item.url === inputUrl)
      if (!source) throw new ToolInputError('只能读取本旅行已保存的小红书搜索来源。')
      const settings = requireSettings(context.xiaohongshu)
      const output = await invoke({ settings, args: ['xiaohongshu', 'note', source.url, '-f', 'json'], signal })
      const note = parseNoteContent(output, source.url)
      const summary = `${note.author ? `作者：${note.author}。` : ''}${note.text || '页面没有提供正文。'}`
      const nextSource: SourceRecord = {
        ...createSource(note.title || source.title, note.url, 'OpenCLI · 小红书笔记', 'web', summary, 'success', undefined,
          note.author ? { declaredAuthor: note.author } : undefined),
        sourceNature: 'community-platform'
      }
      return {
        output: [
          `笔记标题：${note.title || source.title}`,
          note.author ? `页面作者：${note.author}（页面显示，未独立核验）` : '',
          note.tags.length ? `标签：${note.tags.join('、')}` : '',
          `正文摘录：${note.text || '页面没有提供正文。'}`,
          '来源是社区平台内容，只能作为经验参考；不要把它当作开放时间、价格或交通事实的唯一依据。'
        ].filter(Boolean).join('\n'),
        sources: [nextSource]
      }
    }
  }

  return { search, read }
}

const xiaohongshuTools = createXiaohongshuTools()
export const xiaohongshuSearchTool = xiaohongshuTools.search
export const xiaohongshuReadTool = xiaohongshuTools.read

/** 串行化站点操作并留出间隔，避免 Agent 并发搜索触发平台频率限制。 */
function runOpenCli(invocation: OpenCliInvocation): Promise<string> {
  const request = openCliQueue.then(async () => {
    await waitForOpenCliInterval(invocation.signal)
    try {
      return await runOpenCliProcess(invocation)
    } finally {
      lastOpenCliCallAt = Date.now()
    }
  })
  openCliQueue = request.then(() => undefined, () => undefined)
  return request
}

/** 遵守小红书搜索间隔，并允许用户取消队列中的操作。 */
async function waitForOpenCliInterval(signal?: AbortSignal): Promise<void> {
  const delay = Math.max(0, lastOpenCliCallAt + MIN_OPENCLI_INTERVAL_MS - Date.now())
  if (!delay) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(), delay)
    /** 用户取消时立即结束限流等待。 */
    const abort = (): void => finish(new Error('小红书查询已取消。'))
    /** 统一移除取消监听并结束等待 Promise。 */
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

/** 运行用户明确配置的本机命令；禁用 shell、继承最少环境并限制输出。 */
async function runOpenCliProcess({ settings, args, signal }: OpenCliInvocation): Promise<string> {
  if (!isConfigured(settings)) throw new XiaohongshuConnectorError('请先在设置中配置 OpenCLI 命令路径并启用小红书连接器。')
  if (signal?.aborted) throw new Error('小红书查询已取消。')

  return new Promise((resolve, reject) => {
    const child = spawn(settings.command, [...settings.args, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: safeChildEnvironment()
    })
    const chunks: Buffer[] = []
    let outputLength = 0
    let settled = false
    /** 只结算一次子进程 Promise，并清理超时和取消监听。 */
    const finish = (error?: Error, value?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(value ?? '')
    }
    /** 先请求退出，进程未结束时限时强制终止。 */
    const terminate = (): void => {
      child.kill('SIGTERM')
      const forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
      forceTimer.unref()
    }
    /** 用户取消时停止本机命令并返回安全的取消错误。 */
    const abort = (): void => {
      terminate()
      finish(new Error('小红书查询已取消。'))
    }
    const timeout = setTimeout(() => {
      terminate()
      finish(new XiaohongshuConnectorError('小红书搜索超时。请检查 Chrome、Browser Bridge 和登录状态，稍后再试。'))
    }, OPENCLI_TIMEOUT_MS)
    timeout.unref()

    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputLength += buffer.byteLength
      if (outputLength > MAX_STDOUT_BYTES) {
        terminate()
        finish(new XiaohongshuConnectorError('OpenCLI 返回内容超过安全上限。'))
        return
      }
      chunks.push(buffer)
    })
    child.on('error', () => finish(new XiaohongshuConnectorError('无法启动 OpenCLI。请检查设置中的程序路径和安装状态。')))
    child.on('close', (code) => {
      if (settled) return
      if (signal?.aborted) return finish(new Error('小红书查询已取消。'))
      if (code !== 0) return finish(new XiaohongshuConnectorError('OpenCLI 查询未完成。请检查 Chrome 登录状态、Browser Bridge 连接和小红书页面状态。'))
      finish(undefined, Buffer.concat(chunks).toString('utf8'))
    })
  })
}

/** 只向子进程提供查找 OpenCLI/Chrome 所需的路径与临时目录变量。 */
function safeChildEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
    'TMP', 'TEMP', 'TMPDIR', 'SYSTEMROOT', 'WINDIR', 'LANG', 'LC_ALL'
  ]
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []))
}

/** 解析 OpenCLI JSON 外壳；拒绝额外日志混入的损坏输出。 */
function parseJsonPayload(output: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(output.trim()) as unknown
  } catch {
    throw new XiaohongshuConnectorError('OpenCLI 返回的数据格式无法识别。请更新 OpenCLI 后重试。')
  }
  if (isRecord(parsed) && parsed.ok === false) throw mapOpenCliError(parsed.error)
  if (isRecord(parsed) && parsed.ok === true && 'data' in parsed) return parsed.data
  return parsed
}

/** 将上游明确的登录墙和风控错误转换为不含站点内部细节的提示。 */
function mapOpenCliError(value: unknown): XiaohongshuConnectorError {
  const code = isRecord(value) && typeof value.code === 'string' ? value.code.toLowerCase() : ''
  if (code.includes('auth')) return new XiaohongshuConnectorError('小红书需要登录。请先在你控制的 Chrome 中登录，并确认 Browser Bridge 已连接。')
  if (code.includes('security') || code.includes('captcha') || code.includes('rate')) {
    return new XiaohongshuConnectorError('小红书暂时限制了本次搜索。请稍后再试；Tripwise 不会绕过验证码或访问限制。')
  }
  if (code.includes('empty')) return new XiaohongshuConnectorError('小红书没有返回匹配笔记；可以尝试更具体的关键词。')
  return new XiaohongshuConnectorError('OpenCLI 查询失败。请检查 Chrome 登录状态、Browser Bridge 连接和小红书页面状态。')
}

/** 校验并截断搜索结果，忽略上游增加的字段或不受信任的外域链接。 */
export function parseXiaohongshuSearchResults(output: string, limit = MAX_SEARCH_RESULTS): XiaohongshuSearchRow[] {
  const payload = parseJsonPayload(output)
  const rows = Array.isArray(payload) ? payload : isRecord(payload) && Array.isArray(payload.results) ? payload.results : null
  if (!rows) throw new XiaohongshuConnectorError('OpenCLI 搜索结果结构不符合预期。')
  const results: XiaohongshuSearchRow[] = []
  for (const value of rows) {
    if (!isRecord(value)) continue
    const title = safeText(value.title, 300)
    const url = safeNoteUrl(value.url)
    if (!title || !url || results.some((row) => row.url === url)) continue
    results.push({
      title,
      author: safeText(value.author, 120),
      likes: safeText(value.likes, 40),
      url
    })
    if (results.length >= limit) break
  }
  return results
}

/** 解析单条笔记，只保留公开正文、作者与标签，不读取评论等其他数据。 */
function parseNoteContent(output: string, url: string): NoteContent {
  const payload = parseJsonPayload(output)
  const row = Array.isArray(payload) ? payload[0] : payload
  if (!isRecord(row)) throw new XiaohongshuConnectorError('OpenCLI 笔记内容结构不符合预期。')
  const tags = Array.isArray(row.tags) ? row.tags.flatMap((item) => {
    const tag = safeText(item, 60)
    return tag ? [tag] : []
  }).slice(0, 12) : []
  return {
    title: safeText(row.title, 300),
    author: safeText(row.author, 120),
    text: safeText(row.description ?? row.content ?? row.text, MAX_NOTE_TEXT),
    tags,
    url: safeNoteUrl(row.url) || url
  }
}

/** 只接受真实小红书笔记 URL，避免将任意地址传给浏览器工具。 */
function safeNoteUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_000) return ''
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !XHS_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password ||
      !/^\/(?:search_result|explore|note)\/[0-9a-f]{24}\/?$/i.test(url.pathname)) return ''
    return url.href
  } catch {
    return ''
  }
}

/** 确认正文来源确实是 Tripwise 已保存的小红书社区来源。 */
function isXiaohongshuSource(source: SourceRecord): boolean {
  return source.provider.startsWith('OpenCLI · 小红书') && source.sourceNature === 'community-platform' && Boolean(safeNoteUrl(source.url))
}

/** 以纯文本传递页面字段，去掉控制字符并限制模型上下文长度。 */
function safeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

/** 限定模型请求的结果数量，避免高频或批量抓取。 */
function boundedLimit(value: unknown): number {
  if (value === undefined) return MAX_SEARCH_RESULTS
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_SEARCH_RESULTS) {
    throw new ToolInputError(`小红书搜索每次最多返回 ${MAX_SEARCH_RESULTS} 条结果。`)
  }
  return Number(value)
}

/** 生成简短结构化结果，显式标注作者互动数据来自页面显示。 */
function formatSearchOutput(query: string, items: Array<{ row: XiaohongshuSearchRow; source: SourceRecord }>): string {
  return `小红书搜索“${query}”返回 ${items.length} 条公开笔记。页面显示字段未经独立核验，只能作为游客经验线索：\n` +
    items.map(({ row, source }, index) => `${index + 1}. ${row.title}\n   页面作者：${row.author || '未显示'} · 页面点赞：${row.likes || '未显示'}\n   来源 ID：${source.id}\n   链接：${modelSafeResearchUrl(source.url)}`).join('\n')
}

/** 判断值是否为普通对象，避免数组和 null 被当成站点返回记录。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 本机配置必须显式启用并提供启动命令；不使用 PATH 的隐式解析。 */
function isConfigured(value: OpenCliSettings | undefined): value is OpenCliSettings {
  return Boolean(value?.enabled && value.command.trim() && Array.isArray(value.args))
}

/** 将已通过 IPC 校验的 OpenCLI 配置窄化给执行器。 */
function requireSettings(value: OpenCliSettings | undefined): OpenCliSettings {
  if (!isConfigured(value)) throw new XiaohongshuConnectorError('请先在设置中配置 OpenCLI 命令路径并启用小红书连接器。')
  return value
}
