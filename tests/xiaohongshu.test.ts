/** 验证小红书连接器只调用允许的 OpenCLI 只读命令并清洗站点结果。 */
import { describe, expect, it, vi } from 'vitest'
import type { OpenCliSettings } from '../src/shared/types.js'
import { createXiaohongshuTools, parseXiaohongshuSearchResults } from '../src/main/connectors/xiaohongshu.js'

const enabledSettings: OpenCliSettings = {
  enabled: true,
  command: '/usr/local/bin/opencli',
  args: []
}

describe('小红书 OpenCLI 连接器', () => {
  it('仅保留可信域名中的小红书笔记链接并限制结果条数', () => {
    const parsed = parseXiaohongshuSearchResults(JSON.stringify({
      ok: true,
      data: [
        { title: '故宫拍照路线', author: '旅行者', likes: '82', url: 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=abc' },
        { title: '伪造链接', author: '账号', likes: '1', url: 'https://example.com/explore/0123456789abcdef01234568' },
        { title: '重复链接', author: '账号', likes: '2', url: 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=abc' }
      ]
    }))

    expect(parsed).toEqual([{
      title: '故宫拍照路线',
      author: '旅行者',
      likes: '82',
      url: 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=abc'
    }])
  })

  it('只调用 search 命令、每次最多读取 5 条并将来源标为社区平台', async () => {
    const invocations: Array<{ settings: OpenCliSettings; args: string[] }> = []
    const tools = createXiaohongshuTools(async ({ settings, args }) => {
      invocations.push({ settings, args })
      return JSON.stringify({
        ok: true,
        data: [{
          title: '北京秋日路线',
          author: '旅行者',
          likes: '120',
          url: 'https://www.xiaohongshu.com/search_result/0123456789abcdef01234567?xsec_token=abc'
        }]
      })
    })

    expect(tools.search.isAvailable?.({ amapKey: null, xiaohongshu: { ...enabledSettings, enabled: false } })).toBe(false)
    const result = await tools.search.execute({ query: '北京秋天', limit: 5 }, { amapKey: null, xiaohongshu: enabledSettings })

    expect(invocations).toEqual([{
      settings: enabledSettings,
      args: ['xiaohongshu', 'search', '北京秋天', '--limit', '5', '-f', 'json']
    }])
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toMatchObject({ provider: 'OpenCLI · 小红书', sourceNature: 'community-platform', declaredAuthor: '旅行者' })
    expect(result.output).toContain('作为游客经验线索')
    expect(result.sources[0]?.url).toContain('xsec_token=abc')
    expect(result.output).not.toContain('xsec_token')
  })

  it('拒绝超过上限的搜索请求', async () => {
    const invoke = vi.fn(async () => '[]')
    const tools = createXiaohongshuTools(invoke)

    await expect(tools.search.execute({ query: '北京旅行', limit: 6 }, { amapKey: null, xiaohongshu: enabledSettings }))
      .rejects.toThrow(/最多返回 5 条/)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('只读取本旅行已保存的搜索笔记，并丢弃评论等无关字段', async () => {
    const invocations: string[][] = []
    const tools = createXiaohongshuTools(async ({ args }) => {
      invocations.push(args)
      if (args[1] === 'search') return JSON.stringify({ ok: true, data: [{
        title: '故宫预约经验', author: '用户作者', likes: '12', url: 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=abc'
      }] })
      return JSON.stringify({ ok: true, data: {
        title: '故宫预约经验', author: '用户作者', description: '建议提前确认预约时间。', tags: ['故宫', '预约'], comments: ['不应传入模型']
      } })
    })
    const search = await tools.search.execute({ query: '故宫预约' }, { amapKey: null, xiaohongshu: enabledSettings })
    const noteUrl = search.sources[0].url
    const read = await tools.read.execute({ url: noteUrl }, {
      amapKey: null,
      xiaohongshu: enabledSettings,
      availableSources: search.sources
    })

    expect(invocations[1]).toEqual(['xiaohongshu', 'note', noteUrl, '-f', 'json'])
    expect(read.output).toContain('建议提前确认预约时间')
    expect(read.output).not.toContain('不应传入模型')
    expect(read.sources[0].sourceNature).toBe('community-platform')
    await expect(tools.read.execute({ url: 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567' }, {
      amapKey: null,
      xiaohongshu: enabledSettings,
      availableSources: []
    })).rejects.toThrow(/已保存的小红书搜索来源/)
  })

  it('将结构化平台限制错误转换成不含上游内部字段的提示', async () => {
    const tools = createXiaohongshuTools(async () => JSON.stringify({
      ok: false,
      error: { code: 'SECURITY_BLOCK', message: 'request signature and cookie raw-value' }
    }))

    await expect(tools.search.execute({ query: '北京旅行' }, { amapKey: null, xiaohongshu: enabledSettings }))
      .rejects.toThrow(/不会绕过验证码或访问限制/)
  })
})
