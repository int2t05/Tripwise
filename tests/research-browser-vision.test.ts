/** 验证图片能力探测、截图发送边界和旧版设置默认值。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAiCompatibleClient, type ApiMessage, type ModelRequestMessage } from '../src/main/llm.js'
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/main/persistence/schema.js'
import { createResearchBrowserVisualReader } from '../src/main/research-browser-vision.js'

afterEach(() => vi.unstubAllGlobals())

describe('研究浏览器视觉读取', () => {
  it('旧版设置默认关闭视觉读取', () => {
    const legacySettings = structuredClone(DEFAULT_SETTINGS)
    delete (legacySettings as Partial<typeof legacySettings>).researchBrowserVisualRead

    expect(normalizeSettings(legacySettings)?.researchBrowserVisualRead).toBe(false)
    expect(normalizeSettings({ ...legacySettings, researchBrowserVisualRead: true })?.researchBrowserVisualRead).toBe(true)
    expect(normalizeSettings({ ...legacySettings, researchBrowserVisualRead: 'yes' })).toBeNull()
  })

  it('先用合成图确认读图能力，通过后才采集并发送网页截图', async () => {
    const sentMessages: ModelRequestMessage[][] = []
    const complete = vi.fn(async (messages: ModelRequestMessage[]): Promise<ApiMessage> => {
      sentMessages.push(messages)
      return { role: 'assistant', content: messages.length === 1 ? '6' : '页面提到颐和园东门和附近公交。' }
    })
    const capture = vi.fn(async () => new Uint8Array([255, 216, 3, 4]))
    const reader = createResearchBrowserVisualReader(complete, ['private-token'])

    await expect(reader(capture)).resolves.toEqual({
      status: 'read',
      text: '页面提到颐和园东门和附近公交。'
    })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(sentMessages[0])).toContain('data:image/png;base64,')
    expect(JSON.stringify(sentMessages[0])).not.toContain('private-token')
    expect(JSON.stringify(sentMessages[1])).toContain('data:image/jpeg;base64,')
  })

  it('合成图答案不正确时不截取网页，并缓存本轮结果', async () => {
    const complete = vi.fn(async (): Promise<ApiMessage> => ({ role: 'assistant', content: '5' }))
    const capture = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const reader = createResearchBrowserVisualReader(complete, [])

    await expect(reader(capture)).resolves.toEqual({ status: 'unsupported' })
    await expect(reader(capture)).resolves.toEqual({ status: 'unsupported' })
    expect(complete).toHaveBeenCalledTimes(1)
    expect(capture).not.toHaveBeenCalled()
  })

  it('每轮最多分析三张截图', async () => {
    const complete = vi.fn(async (messages: ModelRequestMessage[]): Promise<ApiMessage> => ({
      role: 'assistant',
      content: messages.length === 1 ? '6' : '页面线索'
    }))
    const capture = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const reader = createResearchBrowserVisualReader(complete, [])

    await reader(capture)
    await reader(capture)
    await reader(capture)
    await expect(reader(capture)).resolves.toEqual({ status: 'limit' })
    expect(capture).toHaveBeenCalledTimes(3)
    expect(complete).toHaveBeenCalledTimes(4)
  })

  it('OpenAI 兼容请求只允许小型内嵌 JPEG/PNG，不请求远程图片地址', async () => {
    let requestBody: Record<string, unknown> | undefined
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '读取完成' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new OpenAiCompatibleClient()
    const settings = { baseUrl: 'https://model.example/v1', model: 'test-vision-model' }

    await client.complete(settings, 'test-key', [{
      role: 'user',
      content: [
        { type: 'text', text: '读取这张图' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQIDBA==', detail: 'high' } }
      ]
    }], undefined)
    const messages = requestBody?.messages as Array<{ content: unknown }>
    expect(messages[0]?.content).toEqual([
      { type: 'text', text: '读取这张图' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQIDBA==', detail: 'high' } }
    ])

    await expect(client.complete(settings, 'test-key', [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.com/page.png' } }]
    }], undefined)).rejects.toThrow('模型图片只接受不超过 2 MB 的内嵌 JPEG 或 PNG。')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
