/** 验证 Agent 通过隔离浏览器执行可见、受限的网页研究。 */
import { describe, expect, it, vi } from 'vitest'
import type { ResearchBrowserSnapshot } from '../src/shared/types.js'
import type { ResearchBrowserToolController } from '../src/main/connectors/types.js'
import { BrowserLinkOpenError, BrowserNavigationError } from '../src/main/connectors/types.js'
import { executeTool, getToolDefinitions } from '../src/main/tools.js'
import { normalizeVisiblePageText } from '../src/main/connectors/web-evidence.js'

const snapshot: ResearchBrowserSnapshot = {
  url: 'https://travel.example/guide',
  title: '北京旅行攻略',
  text: '故宫预约需提前查看官方公告。'.repeat(20),
  declaredAuthor: '页面声明作者',
  declaredPublishedAt: '2026-10-01',
  links: [
    { targetId: 'l1', text: '官方公告', url: 'https://travel.example/official' },
    { targetId: 'l2', text: '签名链接', url: 'https://travel.example/note?xsec_token=private-token' },
    { targetId: 'l3', text: '小红书笔记', url: 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=private-token' },
    { targetId: 'l4', text: '本地地址', url: 'http://127.0.0.1/private' }
  ],
  interactionTargets: [
    { id: 's1', action: 'search', label: '站内搜索' },
    { id: 'e1', action: 'expand', label: '展开全文' }
  ]
}

function createBrowser(overrides: Partial<ResearchBrowserToolController> = {}): ResearchBrowserToolController {
  return {
    isAvailable: () => true,
    navigate: vi.fn(async (url) => ({ url: String(url), title: '北京旅行攻略' })),
    openSnapshotLink: vi.fn(async () => ({ url: 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=private-token', title: '小红书笔记' })),
    readSnapshot: vi.fn(async () => snapshot),
    captureViewport: vi.fn(async () => new Uint8Array([1, 2, 3])),
    scroll: vi.fn(async () => undefined),
    interact: vi.fn(async (_targetId, query) => ({ action: query ? 'search' as const : 'expand' as const })),
    ...overrides
  }
}

const context = (researchBrowser: ResearchBrowserToolController) => ({
  amapKey: null,
  connectors: { webSearch: true, weather: false, places: false, routes: false },
  researchBrowser
})

describe('Agent 研究浏览器工具', () => {
  it('保留网页段落换行并标记可见标题', () => {
    const text = normalizeVisiblePageText(
      '颐和园\n开放时间\n06:00 至 20:00\n\n故宫\n开放时间\n08:30 至 17:00',
      ['颐和园', '开放时间', '故宫']
    )

    expect(text).toBe('## 颐和园\n## 开放时间\n06:00 至 20:00\n\n## 故宫\n## 开放时间\n08:30 至 17:00')
  })

  it('只在隔离网页和网页搜索连接器都可用时公开工具', () => {
    const names = getToolDefinitions(context(createBrowser())).map((item) => item.function.name)
    expect(names).toEqual(expect.arrayContaining([
      'research_browser_navigate', 'research_browser_snapshot', 'research_browser_open_link',
      'research_browser_scroll', 'research_browser_interact'
    ]))
    expect(getToolDefinitions({ amapKey: null, connectors: { webSearch: true, weather: false, places: false, routes: false } })
      .map((item) => item.function.name)).not.toContain('research_browser_navigate')
    expect(getToolDefinitions(context(createBrowser({ isAvailable: () => false })))
      .map((item) => item.function.name)).not.toContain('research_browser_snapshot')
    expect(getToolDefinitions({ ...context(createBrowser()), connectors: { webSearch: false, weather: false, places: false, routes: false } })
      .map((item) => item.function.name)).not.toContain('research_browser_scroll')
    const visualReadContext = {
      ...context(createBrowser()),
      researchBrowserVisualReadEnabled: true,
      analyzeResearchScreenshot: vi.fn()
    }
    expect(getToolDefinitions(visualReadContext).map((item) => item.function.name))
      .toContain('research_browser_visual_read')
    expect(getToolDefinitions({ ...visualReadContext, researchBrowserVisualReadEnabled: false })
      .map((item) => item.function.name)).not.toContain('research_browser_visual_read')
  })

  it('只读取用户启用后的截图，并将识别结果明确标为待核验线索', async () => {
    const captureViewport = vi.fn(async () => new Uint8Array([9, 8, 7]))
    const browser = createBrowser({ captureViewport })
    const analyzeResearchScreenshot = vi.fn(async (capture: () => Promise<Uint8Array>) => {
      expect([...await capture()]).toEqual([9, 8, 7])
      return { status: 'read' as const, text: '画面中有一处红叶步道。' }
    })
    const enabledContext = {
      ...context(browser),
      researchBrowserVisualReadEnabled: true,
      analyzeResearchScreenshot
    }
    const result = await executeTool('research_browser_visual_read', '{}', enabledContext)

    expect(captureViewport).toHaveBeenCalledTimes(1)
    expect(analyzeResearchScreenshot).toHaveBeenCalledTimes(1)
    expect(result.output).toContain('尚未核验')
    expect(result.output).toContain('红叶步道')
    expect(result.sources).toMatchObject([{
      title: '北京旅行攻略',
      url: 'https://travel.example/guide',
      provider: 'Tripwise 视觉读取',
      contentLevel: 'visual-clue',
      summary: '模型对当前网页视口的图像解读：画面中有一处红叶步道。'
    }])
    expect(result.sources[0]?.factEvidenceExcerpt).toBeUndefined()
    expect(result.progressCode).toBe('browser_visual_read_completed')

    const disabledResult = await executeTool('research_browser_visual_read', '{}', {
      ...enabledContext,
      researchBrowserVisualReadEnabled: false
    })
    expect(disabledResult.output).toContain('不可用或未启用')
    expect(captureViewport).toHaveBeenCalledTimes(1)
  })

  it('页面要求登录或验证时不截图，也不创建视觉来源', async () => {
    const captureViewport = vi.fn(async () => new Uint8Array([1]))
    const analyzeResearchScreenshot = vi.fn()
    const result = await executeTool('research_browser_visual_read', '{}', {
      ...context(createBrowser({
        captureViewport,
        readSnapshot: vi.fn(async () => ({ ...snapshot, accessState: 'login-required' as const }))
      })),
      researchBrowserVisualReadEnabled: true,
      analyzeResearchScreenshot
    })

    expect(result.output).toContain('当前页面要求登录')
    expect(captureViewport).not.toHaveBeenCalled()
    expect(analyzeResearchScreenshot).not.toHaveBeenCalled()
    expect(result.sources).toEqual([])
    expect(result.progressCode).toBe('browser_visual_read_blocked')
  })

  it('图片能力验证未通过时不采集当前网页截图', async () => {
    const captureViewport = vi.fn(async () => new Uint8Array([1]))
    const result = await executeTool('research_browser_visual_read', '{}', {
      ...context(createBrowser({ captureViewport })),
      researchBrowserVisualReadEnabled: true,
      analyzeResearchScreenshot: vi.fn(async () => ({ status: 'unsupported' as const }))
    })

    expect(result.output).toContain('未发送当前网页截图')
    expect(captureViewport).not.toHaveBeenCalled()
  })

  it('导航只接受普通公网 HTTP(S) 地址，并在 UI 操作同一个浏览器会话', async () => {
    const browser = createBrowser()
    const result = await executeTool('research_browser_navigate', JSON.stringify({ url: 'https://travel.example/guide?access_token=private-token' }), context(browser))
    expect(browser.navigate).toHaveBeenCalledWith('https://travel.example/guide?access_token=private-token', undefined)
    expect(result.output).not.toContain('private-token')
    expect(result.output).toContain('https://travel.example/guide')
    expect(result.output).toContain('故宫预约需提前查看官方公告。')
    expect(result.output).toContain('l1 [链接] 官方公告')
    expect(result.sources).toMatchObject([{ contentLevel: 'page', url: 'https://travel.example/guide' }])
    expect(result.progressCode).toBe('browser_navigation_read_completed')
    expect(browser.readSnapshot).toHaveBeenCalledOnce()

    const blocked = await executeTool('research_browser_navigate', JSON.stringify({ url: 'http://127.0.0.1/private' }), context(browser))
    expect(blocked.output).toContain('公开 HTTP(S)')
    expect(browser.navigate).toHaveBeenCalledTimes(1)
  })

  it('导航等待超时后只返回部分线索，不把正文绑定为完整证据', async () => {
    const browser = createBrowser({
      navigate: vi.fn(async (url) => ({ url: String(url), title: '北京旅行攻略', navigationTimedOut: true })),
      readSnapshot: vi.fn(async () => ({ ...snapshot, navigationTimedOut: true }))
    })
    const result = await executeTool('research_browser_navigate', JSON.stringify({
      url: 'https://travel.example/guide'
    }), context(browser))

    expect(result.progressCode).toBe('browser_navigation_read_partial')
    expect(result.output).toContain('不会将其作为完整原文证据')
    expect(result.sources).toMatchObject([{ status: 'partial', contentLevel: 'page' }])
    expect(result.sources[0]?.factEvidenceExcerpt).toBeUndefined()
  })

  it('已识别访问门槛后阻止 Agent 再次导航同一站点', async () => {
    const browser = createBrowser({ accessGateForUrl: vi.fn(() => 'login-required' as const) })
    const result = await executeTool('research_browser_navigate', JSON.stringify({
      url: 'https://www.xiaohongshu.com/search_result?keyword=%E5%8C%97%E4%BA%AC'
    }), context(browser))

    expect(result.output).toContain('已停止该站点的自动读取')
    expect(result.sources).toEqual([])
    expect(result.progressCode).toBe('browser_navigation_read_blocked')
    expect(browser.navigate).not.toHaveBeenCalled()
  })

  it.each([
    ['ERR_PROXY_CONNECTION_FAILED', 'proxy', '代理连接失败'],
    ['ERR_NAME_NOT_RESOLVED', 'dns', '域名解析失败'],
    ['ERR_CONNECTION_RESET', 'connection_reset', '连接被重置'],
    ['ERR_CONNECTION_REFUSED', 'connection_refused', '目标拒绝连接'],
    ['ERR_CONNECTION_CLOSED', 'connection_closed', '被对端关闭'],
    ['ERR_TIMED_OUT', 'timeout', '连接超时']
  ])('导航错误 %s 只暴露安全类别，不回显异常里的凭证网址', async (errorCode, failureKind, message) => {
    const privateUrl = 'https://travel.example/guide?access_token=private-token'
    const failure = Object.assign(new Error(`${errorCode} loading ${privateUrl}`), {
      code: errorCode
    })
    const browser = createBrowser({ navigate: vi.fn(async () => { throw failure }) })
    const result = await executeTool('research_browser_navigate', JSON.stringify({ url: privateUrl }), context(browser))

    expect(result.browserNavigationFailureKind).toBe(failureKind)
    expect(result.output).toContain(message)
    expect(result.output).not.toContain('private-token')
    expect(result.sources[0]).toMatchObject({ status: 'error', url: 'https://travel.example/guide' })
    expect(result.sources[0]?.summary).not.toContain('private-token')
  })

  it('导航失败同时保留固定阶段，且不回显 Chromium 错误原文', async () => {
    const privateUrl = 'https://travel.example/guide?access_token=private-token'
    const cause = Object.assign(new Error(`net::ERR_ABORTED loading ${privateUrl}`), { code: 'ERR_ABORTED' })
    const browser = createBrowser({ navigate: vi.fn(async () => {
      throw new BrowserNavigationError('redirected', cause)
    }) })

    const result = await executeTool('research_browser_navigate', JSON.stringify({ url: privateUrl }), context(browser))

    expect(result).toMatchObject({
      progressCode: 'browser_navigation_read_blocked',
      browserNavigationFailureKind: 'aborted',
      browserNavigationFailureStage: 'redirected'
    })
    expect(result.output).not.toContain('ERR_ABORTED')
    expect(result.output).not.toContain('private-token')
  })

  it('Agent 可用搜索词打开 Bing，结果页仅作为链接发现来源', async () => {
    const browser = createBrowser({ readSnapshot: vi.fn(async () => ({
      ...snapshot,
      url: 'https://www.bing.com/search/?q=%E6%95%85%E5%AE%AB',
      links: [{
        targetId: 'l1', text: '参观须知', url: 'https://www.dpm.org.cn/Visit.html',
        context: '故宫博物院官方参观须知：开放时间、预约及票务信息。页面卡片摘要。'
      }]
    })) })
    const navigation = await executeTool('research_browser_navigate', JSON.stringify({ url: '故宫开放时间 官方' }), context(browser))
    const expectedUrl = new URL('https://www.bing.com/search/')
    expectedUrl.searchParams.set('q', '故宫开放时间 官方')
    expect(browser.navigate).toHaveBeenCalledWith(expectedUrl.href, undefined)
    expect(navigation.output).toContain('Bing 搜索结果页')
    expect(navigation.output).toContain('搜索结果页只能用于发现原始网页')
    expect(navigation.sources).toMatchObject([{ contentLevel: 'snippet' }])
    expect(navigation.feedback).toContainEqual(expect.objectContaining({
      severity: 'warning', code: 'browser_search_page_not_evidence'
    }))
    expect(navigation.progressCode).toBe('browser_search_results_read')
    expect(navigation.browserSnapshotLinks).toMatchObject([{ targetId: 'l1', context: '故宫博物院官方参观须知：开放时间、预约及票务信息。页面卡片摘要。' }])
    expect(navigation.output).toContain('l1 [链接] 参观须知')
    expect(navigation.output).toContain('附近文字：故宫博物院官方参观须知：开放时间、预约及票务信息。页面卡片摘要。')

    const longContextBrowser = createBrowser({ readSnapshot: vi.fn(async () => ({
      ...snapshot,
      url: 'https://www.bing.com/search/?q=%E6%95%85%E5%AE%AB',
      links: [{ targetId: 'l1', text: '参观须知', url: 'https://www.dpm.org.cn/Visit.html', context: 'x'.repeat(200) }]
    })) })
    const longContextResult = await executeTool('research_browser_navigate', JSON.stringify({ url: '故宫官方参观须知' }), context(longContextBrowser))
    const visibleLink = longContextResult.output.split('\n').find((line) => line.includes('附近文字：'))
    expect(visibleLink?.endsWith('x'.repeat(140))).toBe(true)

    const page = await executeTool('research_browser_snapshot', '{}', context(browser))
    expect(page.output).toContain('搜索结果页只能用于发现原始网页')
    expect(page.sources).toMatchObject([{ contentLevel: 'snippet', url: 'https://www.bing.com/search/?q=%E6%95%85%E5%AE%AB' }])
    expect(page.feedback).toContainEqual(expect.objectContaining({
      severity: 'warning', code: 'browser_search_page_not_evidence'
    }))
  })

  it('读取可见页面、只保留安全链接，并将页面作为不可信来源保存', async () => {
    const result = await executeTool('research_browser_snapshot', '{}', context(createBrowser()))
    expect(result.output).toContain('故宫预约需提前查看官方公告。')
    expect(result.output).toContain('https://travel.example/official')
    expect(result.output).not.toContain('private-token')
    expect(result.output).toContain('l3 [链接] 小红书笔记')
    expect(result.output).not.toContain('127.0.0.1')
    expect(result.sources).toMatchObject([{ title: '北京旅行攻略', url: 'https://travel.example/guide', provider: 'Tripwise 研究浏览器' }])
    expect(result.sources[0]).toMatchObject({ declaredAuthor: '页面声明作者', declaredPublishedAt: '2026-10-01' })
    expect(result.output.startsWith(result.sources[0]!.factEvidenceExcerpt ?? '')).toBe(true)
    expect(result.output).toContain('s1 [站内搜索框] 站内搜索')
    expect(result.output).toContain('e1 [展开内容] 展开全文')
  })

  it('通过快照链接编号打开小红书笔记，令牌只留在本机来源记录', async () => {
    const pageUrl = 'https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa?xsec_token=page-access'
    const browser = createBrowser({ readSnapshot: vi.fn(async () => ({ ...snapshot, url: pageUrl })) })
    const page = await executeTool('research_browser_snapshot', '{}', context(browser))
    expect(page.output).not.toContain('xsec_token')
    expect(page.sources[0]?.url).toBe(pageUrl)

    const opened = await executeTool('research_browser_open_link', JSON.stringify({ target_id: 'l3' }), context(browser))
    expect(browser.openSnapshotLink).toHaveBeenCalledWith('l3', undefined)
    expect(opened.output).toContain('小红书笔记')
    expect(opened.output).toContain('故宫预约需提前查看官方公告。')
    expect(opened.output).not.toContain('private-token')
    expect(opened.progressCode).toBe('browser_link_opened')
    expect(opened.sources).toMatchObject([{ contentLevel: 'page' }])
  })

  it('区分快照链接已打开但正文读取失败', async () => {
    const browser = createBrowser({
      readSnapshot: vi.fn(async () => { throw new Error('private page detail') })
    })
    const opened = await executeTool('research_browser_open_link', JSON.stringify({ target_id: 'l3' }), context(browser))

    expect(opened.output).toContain('正文暂时无法读取')
    expect(opened.output).not.toContain('private page detail')
    expect(opened.sources).toEqual([])
    expect(opened.progressCode).toBe('browser_link_read_unavailable')
  })

  it.each([
    ['ERR_TIMED_OUT', 'timeout', '网页连接超时'],
    ['网页链接编号已失效，请先读取当前页面快照。', 'stale_snapshot', '网页已变化'],
    ['当前网页需要用户手动处理访问门槛。', 'access_gate', '手动处理登录或验证']
  ])('开链失败 %s 只返回固定类别和恢复提示', async (failure, failureKind, message) => {
    const privateUrl = 'https://travel.example/guide?access_token=private-token'
    const error = failure === 'ERR_TIMED_OUT'
      ? Object.assign(new Error(`${failure} loading ${privateUrl}`), { code: failure })
      : new Error(failure)
    const browser = createBrowser({ openSnapshotLink: vi.fn(async () => { throw error }) })
    const opened = await executeTool('research_browser_open_link', JSON.stringify({ target_id: 'l3' }), context(browser))

    expect(opened.progressCode).toBe('browser_link_unavailable')
    expect(opened.browserLinkFailureKind).toBe(failureKind)
    expect(opened.output).toContain(message)
    expect(opened.output).not.toContain(privateUrl)
    expect(opened.sources).toEqual([])
  })

  it('开链导航失败时保留固定导航阶段', async () => {
    const privateUrl = 'https://travel.example/guide?access_token=private-token'
    const cause = Object.assign(new Error(`net::ERR_ABORTED loading ${privateUrl}`), { code: 'ERR_ABORTED' })
    const browser = createBrowser({
      openSnapshotLink: vi.fn(async () => { throw new BrowserNavigationError('committed', cause) })
    })
    const opened = await executeTool('research_browser_open_link', JSON.stringify({ target_id: 'l3' }), context(browser))

    expect(opened).toMatchObject({
      browserLinkFailureKind: 'aborted',
      browserNavigationFailureStage: 'committed'
    })
    expect(opened.output).not.toContain('ERR_ABORTED')
    expect(opened.output).not.toContain('private-token')
  })

  it('指针脚本被 Chromium 中断时保留动作阶段并允许安全分类', async () => {
    const privateUrl = 'https://travel.example/guide?access_token=private-token'
    const cause = Object.assign(new Error(`net::ERR_ABORTED loading ${privateUrl}`), { code: 'ERR_ABORTED' })
    const browser = createBrowser({ openSnapshotLink: vi.fn(async () => {
      throw new BrowserLinkOpenError('cursor_script_execution', cause)
    }) })
    const opened = await executeTool('research_browser_open_link', JSON.stringify({ target_id: 'l3' }), context(browser))

    expect(opened).toMatchObject({
      browserLinkFailureKind: 'aborted',
      browserLinkFailureStage: 'cursor_script_execution'
    })
    expect(opened.output).not.toContain('ERR_ABORTED')
    expect(opened.output).not.toContain('private-token')
  })

  it.each([
    'snapshot_page_changed', 'target_not_in_snapshot', 'snapshot_registry_missing',
    'snapshot_registry_page_changed', 'snapshot_target_missing', 'snapshot_target_url_missing',
    'target_not_found_after_rerender', 'target_ambiguous_after_rerender',
    'target_not_rendered', 'target_detached_during_scroll', 'target_scroll_unstable',
    'target_scroll_did_not_move', 'target_scroll_incomplete', 'cursor_action_failed', 'cursor_script_execution'
  ] as const)(
    '把快照开链阶段 %s 作为固定诊断返回', async (stage) => {
    const browser = createBrowser({ openSnapshotLink: vi.fn(async () => { throw new BrowserLinkOpenError(stage) }) })
    const opened = await executeTool('research_browser_open_link', JSON.stringify({ target_id: 'l3' }), context(browser))

    expect(opened.progressCode).toBe('browser_link_unavailable')
    expect(opened.browserLinkFailureKind).toBe('stale_snapshot')
    expect(opened.browserLinkFailureStage).toBe(stage)
    expect(opened.output).toContain('当前网页已变化')
    expect(opened.output).not.toContain(stage)
    }
  )

  it('识别登录墙后停止自动读取，不将登录页保存为旅行来源', async () => {
    const browser = createBrowser({ readSnapshot: vi.fn(async () => ({
      ...snapshot,
      title: '北京旅游 - 小红书搜索',
      text: '扫码登录后查看更多笔记',
      accessState: 'login-required' as const
    })) })
    const result = await executeTool('research_browser_snapshot', '{}', context(browser))

    expect(result.output).toContain('当前页面要求登录')
    expect(result.output).toContain('手动登录')
    expect(result.sources).toEqual([])
  })

  it('只对最近快照编号执行站内搜索/展开，并且不回显搜索词', async () => {
    const browser = createBrowser()
    const search = await executeTool('research_browser_interact', JSON.stringify({ target_id: 's1', query: '北京秋色攻略' }), context(browser))
    expect(browser.interact).toHaveBeenCalledWith('s1', '北京秋色攻略', undefined)
    expect(search.output).toContain('站内 GET 搜索')
    expect(search.output).toContain('故宫预约需提前查看官方公告。')
    expect(search.output).not.toContain('北京秋色攻略')
    expect(search.progressCode).toBe('browser_interact_search_completed')

    const expand = await executeTool('research_browser_interact', JSON.stringify({ target_id: 'e1' }), context(browser))
    expect(browser.interact).toHaveBeenCalledWith('e1', undefined, undefined)
    expect(expand.output).toContain('展开当前页面')
    expect(expand.output).toContain('故宫预约需提前查看官方公告。')
    expect(expand.progressCode).toBe('browser_interact_expand_completed')

    const invalid = await executeTool('research_browser_interact', JSON.stringify({ target_id: 'bad;id', query: 'login' }), context(browser))
    expect(invalid.output).toContain('目标已失效')
    expect(invalid.progressCode).toBeUndefined()
    expect(browser.interact).toHaveBeenCalledTimes(2)
  })

  it('将浏览器会话中失效的快照目标标记为不可用', async () => {
    const browser = createBrowser({
      interact: vi.fn(async () => { throw new Error('网页交互目标已失效。') })
    })
    const result = await executeTool('research_browser_interact', JSON.stringify({ target_id: 'e1' }), context(browser))

    expect(result.progressCode).toBe('browser_interact_target_stale')
    expect(result.output).not.toContain('网页交互目标已失效。')
  })

  it('来源卡摘要保持短小，同时保留限长正文摘录供事实校验', async () => {
    const travelParagraphs = Array.from({ length: 40 }, (_value, index) =>
      `${'入口与公共交通信息仅作线路发现。'.repeat(4)}第${index + 1}段。`
    )
    const pageText = [...travelParagraphs, '故宫开放时间为 08:30 至 17:00。'].join('\n\n')
    const browser = createBrowser({ readSnapshot: vi.fn(async () => ({ ...snapshot, text: pageText })) })
    const result = await executeTool('research_browser_snapshot', '{}', context(browser))
    const source = result.sources[0]

    expect(source?.summary.length).toBe(800)
    expect(source?.factEvidenceExcerpt).toContain('故宫开放时间')
    expect(source?.factEvidenceExcerpt?.length).toBeLessThanOrEqual(2_400)
    expect(source?.factEvidenceExcerpt?.indexOf('故宫开放时间')).toBeGreaterThan(800)
  })

  it('限制滚动方向和页数，浏览器取消信号继续传给主进程', async () => {
    const browser = createBrowser()
    const controller = new AbortController()
    const scrolled = await executeTool('research_browser_scroll', JSON.stringify({ direction: 'down', pages: 2 }), context(browser), controller.signal)
    expect(browser.scroll).toHaveBeenCalledWith('down', 2, controller.signal)
    expect(scrolled.output).toContain('故宫预约需提前查看官方公告。')
    expect(scrolled.sources).toMatchObject([{ contentLevel: 'page' }])
    const invalid = await executeTool('research_browser_scroll', JSON.stringify({ direction: 'down', pages: 4 }), context(browser))
    expect(invalid.output).toContain('1–3')
    expect(browser.scroll).toHaveBeenCalledTimes(1)
  })
})
