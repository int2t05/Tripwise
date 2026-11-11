/** 验证用户明确复核来源时，旧来源也能进入有界模型上下文。 */
import { describe, expect, it } from 'vitest'
import type { ResearchBrowserLink, SourceRecord, Trip } from '../src/shared/types.js'
import {
  MAX_IMPORTED_SOURCE_CHARACTERS_PER_ITEM,
  MAX_IMPORTED_SOURCE_CONTEXT_CHARACTERS,
  MAX_IMPORTED_SOURCES_PER_CONTEXT
} from '../src/shared/agent-limits.js'
import { attractionNameForBrowserFallbackQuery, browserFallbackLinkMissReason, browserFallbackSearchQuery, firecrawlReadStopReason, initialAttractionSearches, initialResearchPageLimit, isRetryableBrowserNetworkFailure, MAX_BROWSER_NETWORK_FAILURES_PER_HOST, MAX_BROWSER_NETWORK_FAILURE_STREAK, researchBrowserTargetHost, selectBrowserFallbackLink, selectBrowserFallbackSearches, selectOriginalResearchLink } from '../src/main/agent-research.js'
import { hasPageEvidenceForPlaces, importedSourcesForAgentContext, sourcesForAgentContext } from '../src/main/agent-source-context.js'
import { buildFactRepairContextMessage, factRepairSourceMap } from '../src/main/agent-context.js'

function source(id: string, fetchedAt: string): SourceRecord {
  return {
    id, title: id, url: '', provider: '测试', kind: 'weather', summary: id,
    fetchedAt, status: 'success'
  }
}

/** 构造带来源性质的网页搜索结果，用于验证自动正文读取的选择边界。 */
function webSource(id: string, url: string, sourceNature: SourceRecord['sourceNature'] = 'unclassified'): SourceRecord {
  return {
    id, title: id, url, provider: 'Tavily 搜索结果', kind: 'web', summary: '预约与开放信息',
    fetchedAt: '2026-10-21T00:00:00.000Z', status: 'success', sourceNature
  }
}

describe('模型来源上下文', () => {
  it('按地点相关性选取多篇导入攻略，优先用户点名来源并限制总正文预算', () => {
    const userSource = (id: string, title: string, summary: string, day: number): SourceRecord => ({
      id, title, url: `https://example.com/${id}`, provider: '网页导入', kind: 'user', summary,
      fetchedAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`, status: 'success',
      sourceNature: 'community-platform', contentLevel: 'user-provided'
    })
    const sources = [
      userSource('named-by-user', '用户点名笔记', `${'颐和园避坑体验。'.repeat(1_000)}`, 18),
      ...Array.from({ length: 5 }, (_, index) => userSource(
        `relevant-${index}`, `颐和园攻略 ${index}`, `${'北京颐和园的游览体验。'.repeat(1_000)}`, 19 + index
      )),
      ...Array.from({ length: 6 }, (_, index) => userSource(
        `recent-${index}`, `无关城市笔记 ${index}`, `${'上海周末安排。'.repeat(1_000)}`, 25
      ))
    ]
    const selected = importedSourcesForAgentContext(
      sources, '北京', ['颐和园'], '参考用户点名笔记和颐和园的小红书攻略与避坑体验'
    )

    expect(selected).toHaveLength(MAX_IMPORTED_SOURCES_PER_CONTEXT)
    expect(selected[0]?.source.id).toBe('named-by-user')
    expect(selected.map(({ source }) => source.id)).toContain('relevant-0')
    expect(selected.map(({ source }) => source.id)).not.toContain('recent-0')
    expect(selected.every(({ text }) => text.length <= MAX_IMPORTED_SOURCE_CHARACTERS_PER_ITEM)).toBe(true)
    expect(selected.reduce((total, item) => total + item.text.length, 0))
      .toBeLessThanOrEqual(MAX_IMPORTED_SOURCE_CONTEXT_CHARACTERS)
  })

  it('将用户指向的较旧来源放在最近来源之前，并保持二十条上限', () => {
    const sources = Array.from({ length: 25 }, (_, index) => source(
      `source-${index}`,
      new Date(Date.parse('2026-10-18T12:00:00.000Z') - index * 60_000).toISOString()
    ))

    const context = sourcesForAgentContext(sources, '请复核天气，来源编号为 source-24')

    expect(context).toHaveLength(20)
    expect(context[0].id).toBe('source-24')
    expect(context.filter((item) => item.id === 'source-24')).toHaveLength(1)
  })

  it('忽略未知编号并按获取时间选择最近二十条', () => {
    const sources = Array.from({ length: 25 }, (_, index) => source(
      `source-${index}`,
      new Date(Date.parse('2026-10-18T12:00:00.000Z') - index * 60_000).toISOString()
    ))

    const context = sourcesForAgentContext(sources, '来源编号为 missing-source')

    expect(context).toHaveLength(20)
    expect(context[0].id).toBe('source-0')
    expect(context.some((item) => item.id === 'source-24')).toBe(false)
  })

  it('优先保留成功网页正文，避免新检索摘要挤掉可核验页面', () => {
    const pages: SourceRecord[] = Array.from({ length: 4 }, (_, index) => ({
      ...webSource(`page-${index}`, `https://example.com/page-${index}`),
      title: `景点须知 ${index}`, contentLevel: 'page', factEvidenceExcerpt: `开放时间 ${index}`,
      fetchedAt: '2026-10-20T00:00:00.000Z'
    }))
    const snippets: SourceRecord[] = Array.from({ length: 20 }, (_, index) => ({
      ...webSource(`snippet-${index}`, `https://example.com/search/${index}`),
      contentLevel: 'snippet', fetchedAt: '2026-09-22T00:00:00.000Z'
    }))

    const context = sourcesForAgentContext([...pages, ...snippets], '规划北京旅行')

    expect(context).toHaveLength(20)
    expect(context.slice(0, 4).map((source) => source.id)).toEqual(['page-0', 'page-1', 'page-2', 'page-3'])
  })

  it('事实补证时优先选择目标景点正文，并只向模型提供同地点页面', () => {
    const relevant: SourceRecord = {
      ...webSource('palace-page', 'https://www.dpm.org.cn/Visit.html'),
      title: '故宫博物院参观须知', contentLevel: 'page',
      factEvidenceExcerpt: '故宫博物院每日开放时间为 08:30 至 17:00。',
      fetchedAt: '2026-10-18T00:00:00.000Z'
    }
    const unrelated: SourceRecord[] = Array.from({ length: 22 }, (_, index) => ({
      ...webSource(`unrelated-${index}`, `https://example.com/${index}`),
      title: `颐和园参观须知 ${index}`, contentLevel: 'page',
      factEvidenceExcerpt: '颐和园开放时间为 06:00 至 20:00。',
      fetchedAt: new Date(Date.parse('2026-09-23T00:00:00.000Z') + index * 1_000).toISOString()
    }))
    const selected = sourcesForAgentContext([relevant, ...unrelated], '核对故宫开放时间', ['故宫博物院'])
    expect(selected[0]?.id).toBe(relevant.id)

    const trip = {
      brief: { destination: '北京', startDate: '2026-09-21', endDate: '2026-09-27' },
      sources: [relevant, ...unrelated]
    } as unknown as Trip
    const result = factRepairSourceMap(trip.sources, [{
      plan_number: 1, day_number: 6, date: '2026-09-26', stop_name: '故宫博物院', area: '东城区',
      missing_facts: ['opening-hours', 'booking']
    }], '核对故宫开放时间和预约')
    const message = buildFactRepairContextMessage(trip, [{
      plan_number: 1, day_number: 6, date: '2026-09-26', stop_name: '故宫博物院', area: '东城区',
      missing_facts: ['opening-hours', 'booking']
    }], '核对故宫开放时间和预约')
    const context = JSON.parse(message.content!.split('\n').slice(1).join('\n')) as {
      availableSources: Array<{ id: string; targetEvidence: Array<{ placeName: string; excerpt: string }> }>
      targets: Array<{ stop_name: string; source_ids: string[] }>
    }

    expect(context.targets).toEqual([expect.objectContaining({
      stop_name: '故宫博物院', source_ids: [relevant.id]
    })])
    expect(context.availableSources.map((source) => source.id)).toEqual([relevant.id])
    expect(context.availableSources[0]?.targetEvidence).toEqual([expect.objectContaining({
      placeName: '故宫博物院', excerpt: expect.stringContaining('08:30 至 17:00')
    })])
    expect(result.targets[0]?.fact_quotes).toEqual([{
      source_id: relevant.id,
      type: 'opening-hours',
      candidates: [{ quote_id: 'q1', value: '故宫博物院每日开放时间为 08:30 至 17:00' }]
    }])
  })

  it('景点介绍段建立的地点上下文可覆盖后续通用事实小节', () => {
    const page: SourceRecord = {
      ...webSource('generic-visit-guide', 'https://example.com/visit'),
      title: '参观指南', contentLevel: 'page',
      factEvidenceExcerpt: [
        '# 参观指南',
        '本页介绍故宫博物院参观安排。',
        '## 开放时间',
        '旺季开放时间为08:30至17:00。'
      ].join('\n'),
      fetchedAt: '2026-10-18T00:00:00.000Z'
    }
    const target = {
      plan_number: 1, day_number: 1, date: '2026-09-22', stop_name: '故宫博物院', area: '东城区',
      missing_facts: ['opening-hours']
    }

    const result = factRepairSourceMap([page], [target], '核对故宫开放时间')

    expect(result.targets[0]?.source_ids).toEqual([page.id])
    expect(result.targets[0]?.fact_quotes).toEqual([{
      source_id: page.id,
      type: 'opening-hours',
      candidates: [{ quote_id: 'q1', value: '旺季开放时间为08:30至17:00' }]
    }])
    expect(result.uncoveredTargets).toEqual([])
  })

  it('“售票信息”小节中的票价仍绑定到前置景点标题', () => {
    const page: SourceRecord = {
      ...webSource('beijing-ticket-guide', 'https://example.com/tickets'),
      title: '北京景点参观指南', contentLevel: 'page',
      factEvidenceExcerpt: [
        '# 参观指南',
        '## 故宫博物院',
        '### 售票信息',
        '成人票：60 元；学生票：30 元。'
      ].join('\n'),
      fetchedAt: '2026-10-18T00:00:00.000Z'
    }
    const target = {
      plan_number: 1, day_number: 1, date: '2026-09-22', stop_name: '故宫博物院', area: '东城区',
      missing_facts: ['ticket-price']
    }

    const result = factRepairSourceMap([page], [target], '核对故宫门票价格')

    expect(result.targets[0]?.source_ids).toEqual([page.id])
    expect(result.targets[0]?.fact_quotes).toContainEqual(expect.objectContaining({
      source_id: page.id, type: 'ticket-price', candidates: [
        { quote_id: 'q1', value: '成人票：60 元' }, { quote_id: 'q2', value: '学生票：30 元' }
      ]
    }))
  })

  it('正文从一个行程景点转到另一个后不串用后续通用事实小节', () => {
    const page: SourceRecord = {
      ...webSource('two-place-guide', 'https://example.com/beijing-visitors'),
      title: '北京景点参观指南', contentLevel: 'page',
      factEvidenceExcerpt: [
        '# 北京景点参观指南',
        '故宫博物院参观信息。',
        '颐和园参观信息。',
        '## 开放时间',
        '旺季开放时间为06:00至20:00。'
      ].join('\n'),
      fetchedAt: '2026-10-18T00:00:00.000Z'
    }
    const targets = [
      {
        plan_number: 1, day_number: 1, date: '2026-09-22', stop_name: '故宫博物院', area: '东城区',
        missing_facts: ['opening-hours']
      },
      {
        plan_number: 1, day_number: 2, date: '2026-09-23', stop_name: '颐和园', area: '海淀区',
        missing_facts: ['opening-hours']
      }
    ]

    const result = factRepairSourceMap([page], targets, '核对北京景点开放时间')

    expect(result.targets[0]?.source_ids).toEqual([])
    expect(result.targets[0]?.fact_quotes).toEqual([])
    expect(result.targets[1]?.source_ids).toEqual([page.id])
    expect(result.targets[1]?.fact_quotes).toEqual([{
      source_id: page.id,
      type: 'opening-hours',
      candidates: [{ quote_id: 'q1', value: '旺季开放时间为06:00至20:00' }]
    }])
  })

  it('景点介绍页不算开放、预约或票价事实来源', () => {
    const backgroundPage: SourceRecord = {
      ...webSource('palace-background', 'https://www.dpm.org.cn/history'),
      title: '故宫博物院景区介绍', contentLevel: 'page',
      factEvidenceExcerpt: '故宫博物院的历史与园区背景介绍。'
    }
    const target = {
      plan_number: 1, day_number: 1, date: '2026-09-22', stop_name: '故宫博物院', area: '东城区',
      missing_facts: ['opening-hours', 'booking', 'ticket-price']
    }

    const result = factRepairSourceMap([backgroundPage], [target], '核对故宫开放时间、预约和票价')

    expect(result.targets[0]?.source_ids).toEqual([])
    expect(result.uncoveredTargets).toEqual([target])
    expect(result.sources).toEqual([])
  })

  it('只说预约要求以另一份须知为准时仍需继续检索', () => {
    const referralPage: SourceRecord = {
      ...webSource('palace-referral', 'https://www.dpm.org.cn/visit'),
      title: '故宫博物院参观须知', contentLevel: 'page',
      factEvidenceExcerpt: '故宫博物院开放时间和预约要求以参观须知为准。'
    }
    const target = {
      plan_number: 1, day_number: 1, date: '2026-09-22', stop_name: '故宫博物院', area: '东城区',
      missing_facts: ['booking']
    }

    const result = factRepairSourceMap([referralPage], [target], '核对故宫预约规则')

    expect(result.targets[0]?.source_ids).toEqual([])
    expect(result.uncoveredTargets).toEqual([target])
  })

  it('只把正文直接支持的事实类别视为已覆盖', () => {
    const openingPage: SourceRecord = {
      ...webSource('palace-hours', 'https://www.dpm.org.cn/Visit.html'),
      title: '故宫博物院参观须知', contentLevel: 'page',
      factEvidenceExcerpt: '故宫博物院每日开放时间为 08:30 至 17:00。'
    }
    const target = {
      plan_number: 1, day_number: 1, date: '2026-09-22', stop_name: '故宫博物院', area: '东城区',
      missing_facts: ['opening-hours', 'booking', 'ticket-price']
    }

    const result = factRepairSourceMap([openingPage], [target], '核对故宫开放时间、预约和票价')

    expect(result.targets[0]?.source_ids).toEqual([openingPage.id])
    expect(result.uncoveredTargets).toEqual([expect.objectContaining({
      stop_name: '故宫博物院', missing_facts: ['booking', 'ticket-price']
    })])
    expect(result.sources.map((item) => item.id)).toEqual([openingPage.id])
  })

  it('多地点补证仍保留每篇正文末尾的目标事实，不按页数从开头截断', () => {
    const pages = Array.from({ length: 12 }, (_, index) => {
      const placeName = `景点${String.fromCharCode(65 + index)}`
      const background = `${placeName}参观介绍。`.repeat(230)
      const fact = `${placeName}开放时间为08:30至17:00。`
      const source: SourceRecord = {
        ...webSource(`page-${index}`, `https://example.com/page-${index}`),
        title: `${placeName}参观须知`, contentLevel: 'page',
        factEvidenceExcerpt: `${background}${fact}`.padEnd(2_400, '参观说明。'),
        fetchedAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
      }
      return { placeName, source }
    })
    const trip = {
      brief: { destination: '北京', startDate: '2026-10-01', endDate: '2026-10-12' },
      sources: pages.map(({ source }) => source)
    } as unknown as Trip
    const targets = pages.map(({ placeName }, index) => ({
      plan_number: 1, day_number: index + 1,
      date: `2026-10-${String(index + 1).padStart(2, '0')}`,
      stop_name: placeName, area: '北京', missing_facts: ['opening-hours']
    }))

    const message = buildFactRepairContextMessage(trip, targets, '核对每天景点开放时间')
    const context = JSON.parse(message.content!.split('\n').slice(1).join('\n')) as {
      availableSources: Array<{
        id: string
        targetEvidence: Array<{ placeName: string; excerpt: string }>
      }>
    }

    for (const { placeName } of pages) {
      expect(context.availableSources.some((item) =>
        item.targetEvidence.some((evidence) => evidence.placeName === placeName &&
          evidence.excerpt.includes(`${placeName}开放时间为08:30至17:00`))
      )).toBe(true)
    }
    expect(context.availableSources.reduce((total, item) => total + item.targetEvidence.reduce(
      (sum, evidence) => sum + evidence.excerpt.length, 0
    ), 0))
      .toBeLessThanOrEqual(18_000)
  })

  it('同一多景点页面只向每个地点发送各自小节的事实原文', () => {
    const source: SourceRecord = {
      ...webSource('beijing-guide', 'https://example.com/beijing'),
      title: '北京景点游览指南', contentLevel: 'page',
      factEvidenceExcerpt: [
        '# 北京游览指南',
        '## 故宫博物院',
        '开放时间为08:30至17:00。',
        '## 颐和园',
        '开放时间为06:00至20:00。'
      ].join('\n'),
      fetchedAt: '2026-10-01T00:00:00.000Z'
    }
    const trip = {
      brief: { destination: '北京', startDate: '2026-10-01', endDate: '2026-10-02' },
      sources: [source]
    } as unknown as Trip

    const message = buildFactRepairContextMessage(trip, [
      { plan_number: 1, day_number: 1, date: '2026-10-01', stop_name: '故宫博物院', area: '东城', missing_facts: ['opening-hours'] },
      { plan_number: 1, day_number: 2, date: '2026-10-02', stop_name: '颐和园', area: '海淀', missing_facts: ['opening-hours'] }
    ], '核对北京景点开放时间')
    const context = JSON.parse(message.content!.split('\n').slice(1).join('\n')) as {
      availableSources: Array<{ targetEvidence: Array<{ placeName: string; excerpt: string }> }>
    }
    const evidence = context.availableSources[0]?.targetEvidence ?? []

    expect(evidence).toEqual([
      expect.objectContaining({ placeName: '故宫博物院', excerpt: expect.stringContaining('08:30至17:00') }),
      expect.objectContaining({ placeName: '颐和园', excerpt: expect.stringContaining('06:00至20:00') })
    ])
    expect(evidence[0]?.excerpt).not.toContain('06:00至20:00')
    expect(evidence[1]?.excerpt).not.toContain('08:30至17:00')
  })

  it('局部修订只复用提到计划地点的成功网页正文', () => {
    const sources: SourceRecord[] = [
      {
        ...webSource('relevant-page', 'https://www.dpm.org.cn/Visit.html'),
        title: '故宫博物院参观须知', contentLevel: 'page',
        factEvidenceExcerpt: '故宫博物院开放时间与预约方式。'
      },
      {
        ...webSource('irrelevant-page', 'https://example.com/other'),
        title: '颐和园参观须知', contentLevel: 'page',
        factEvidenceExcerpt: '颐和园开放时间与预约方式。'
      },
      {
        ...webSource('search-snippet', 'https://example.com/search'),
        title: '故宫博物院搜索摘要', contentLevel: 'snippet',
        factEvidenceExcerpt: '故宫博物院开放时间与预约方式。'
      },
      {
        ...webSource('failed-page', 'https://example.com/failed'),
        title: '故宫博物院页面', contentLevel: 'page', status: 'error',
        factEvidenceExcerpt: '故宫博物院开放时间与预约方式。'
      }
    ]

    expect(hasPageEvidenceForPlaces(sources, ['故宫博物院', '北海公园'])).toBe(true)
    expect(hasPageEvidenceForPlaces(sources.slice(1), ['故宫博物院'])).toBe(false)
    expect(hasPageEvidenceForPlaces(sources, [])).toBe(false)
  })
})

describe('自动网页正文读取来源选择', () => {
  it('浏览器搜索只跟进点名景点的原始页面线索，不跟进社区、搜索页或带令牌的链接', () => {
    const links = [
      { text: '故宫博物院攻略', url: 'https://www.xiaohongshu.com/explore/example' },
      { text: '故宫博物院官网', url: 'https://www.bing.com/search/?q=故宫博物院' },
      { text: '故宫博物院官方网站', url: 'https://example.com/visit?access_token=secret' },
      { text: '北京故宫博物院参观须知', url: 'https://www.dpm.org.cn/Visit.html' },
      { text: '北京旅游政务平台', url: 'https://www.beijing.gov.cn/visit' }
    ]

    expect(selectOriginalResearchLink(links, '故宫博物院')).toBe('https://www.dpm.org.cn/Visit.html')
    expect(selectOriginalResearchLink(links, '天坛公园')).toBeUndefined()
  })

  it('浏览器搜索可将景点简称匹配到正式名标题', () => {
    const links = [
      { text: '北京大学官方网站：预约参观', url: 'https://www.pku.edu.cn/visit' },
      { text: '中国国家博物馆参观须知', url: 'https://www.chnmuseum.cn/visit' }
    ]

    expect(selectOriginalResearchLink(links, '北大')).toBe('https://www.pku.edu.cn/visit')
    expect(selectOriginalResearchLink(links, '国博')).toBe('https://www.chnmuseum.cn/visit')
  })

  it('浏览器搜索识别北京景点与校园的常见别称', () => {
    const links = [
      { targetId: 'l1', text: '紫禁城参观须知：开放时间与预约', url: 'https://www.dpm.org.cn/Visit.html' },
      { targetId: 'l2', text: '燕园预约参观', url: 'https://www.pku.edu.cn/visit' },
      { targetId: 'l3', text: '清漪园游园须知', url: 'https://summerpalace.net.cn/visit' }
    ]

    expect(selectBrowserFallbackLink(links, 'attraction', '故宫博物院 开放时间 预约', '故宫博物院'))
      .toMatchObject({ targetId: 'l1' })
    expect(selectOriginalResearchLink(links, '北京大学')).toBe('https://www.pku.edu.cn/visit')
    expect(selectOriginalResearchLink(links, '颐和园')).toBe('https://summerpalace.net.cn/visit')
  })

  it('搜索结果标题较短时使用相邻摘要识别景点原文，但摘要不变成事实证据', () => {
    const links = [{
      targetId: 'l1', text: '参观须知', url: 'https://www.dpm.org.cn/Visit.html',
      context: '故宫博物院官方参观须知：开放时间、预约及票务信息。'
    }]

    expect(selectOriginalResearchLink(links, '故宫博物院')).toBe('https://www.dpm.org.cn/Visit.html')
    expect(selectBrowserFallbackLink(links, 'attraction', '故宫 开放时间 预约', '故宫博物院'))
      .toMatchObject({ targetId: 'l1' })
    expect(browserFallbackLinkMissReason(links, 'attraction', '故宫 开放时间 预约', '故宫博物院'))
      .toBe('intent_policy_no_match')
  })

  it('仅在 URL 路径中的中文 slug 可帮助发现访问信息页，不解码查询参数或放宽事实来源', () => {
    const links = [
      {
        targetId: 'l1', text: '查看',
        url: 'https://travel.example/%E6%95%85%E5%AE%AB%E5%8D%9A%E7%89%A9%E9%99%A2/%E5%8F%82%E8%A7%82%E9%A1%BB%E7%9F%A5'
      },
      {
        targetId: 'l2', text: '了解更多',
        url: 'https://travel.example/%E6%95%85%E5%AE%AB%E5%8D%9A%E7%89%A9%E9%99%A2/about'
      }
    ]

    expect(selectBrowserFallbackLink(links, 'attraction', '故宫博物院 开放时间 预约', '故宫博物院'))
      .toMatchObject({ targetId: 'l1' })
    expect(selectBrowserFallbackLink(links.slice(1), 'attraction', '故宫博物院 开放时间 预约', '故宫博物院'))
      .toBeUndefined()
  })

  it('景点筛选不使用域名和查询参数伪造地点或开放信息线索', () => {
    const links = [
      { targetId: 'l1', text: '查看', url: 'https://travel.example/story?ref=故宫博物院官方预约开放时间' },
      { targetId: 'l2', text: '查看', url: 'https://故宫博物院官方预约开放.example/story' }
    ]

    for (const link of links) {
      expect(selectOriginalResearchLink([link], '故宫博物院')).toBeUndefined()
      expect(selectBrowserFallbackLink([link], 'attraction', '故宫博物院 官方开放时间 预约', '故宫博物院'))
        .toBeUndefined()
    }
  })

  it('景点自动回退会检查快照中超过模型展示上限的链接', () => {
    const links: ResearchBrowserLink[] = Array.from({ length: 34 }, (_, index) => ({
      targetId: `l${index + 1}`,
      text: '搜索页导航链接',
      url: `https://example.com/navigation/${index + 1}`
    }))
    links.push({
      targetId: 'l35',
      text: '参观须知',
      url: 'https://www.dpm.org.cn/Visit.html',
      context: '故宫博物院官方参观须知：开放时间、预约及票务信息。'
    })

    expect(selectBrowserFallbackLink(links, 'attraction', '故宫 开放时间 预约', '故宫博物院'))
      .toMatchObject({ targetId: 'l35' })
  })

  it('景点自动回退不会检查快照容量之外的链接', () => {
    const links: ResearchBrowserLink[] = Array.from({ length: 80 }, (_, index) => ({
      targetId: `l${index + 1}`,
      text: '搜索页导航链接',
      url: `https://example.com/navigation/${index + 1}`
    }))
    links.push({
      targetId: 'l81',
      text: '故宫博物院官方参观须知 开放时间 预约',
      url: 'https://www.dpm.org.cn/Visit.html'
    })

    expect(selectBrowserFallbackLink(links, 'attraction', '故宫 开放时间 预约', '故宫博物院'))
      .toBeUndefined()
  })

  it('官方页面不可用时跟进点名景点的公开游览信息页，并排除社区与泛介绍', () => {
    const links = [
      { targetId: 'l1', text: '故宫博物院旅游攻略', url: 'https://www.xiaohongshu.com/explore/palace' },
      { targetId: 'l2', text: '故宫博物院周边地图', url: 'https://travel.example/palace/map' },
      { targetId: 'l3', text: '故宫博物院开放时间、预约和购票指南', url: 'https://travel.example/palace/visit' }
    ]

    expect(selectBrowserFallbackLink(links, 'attraction', '北京 故宫开放时间 预约', '故宫博物院'))
      .toMatchObject({ targetId: 'l3' })
  })

  it('景点名缺席链接标题时只回退到相关政府开放/预约页', () => {
    const links = [
      { targetId: 'l1', text: '北京旅游政务平台', url: 'https://www.beijing.gov.cn/travel' },
      { targetId: 'l2', text: '北京景区开放时间与预约须知', url: 'https://www.beijing.gov.cn/visit' },
      { targetId: 'l3', text: '景区开放时间与预约攻略', url: 'https://travel.example/palace/visit' },
      { targetId: 'l4', text: '北京景区开放时间与预约', url: 'https://beijing.gov.cn.attacker.example/visit' }
    ]

    expect(selectBrowserFallbackLink(links, 'attraction', '北京 故宫博物院 官方开放时间 预约', '故宫博物院'))
      .toMatchObject({ targetId: 'l2' })
    expect(selectBrowserFallbackLink(links.slice(0, 1), 'attraction', '北京 故宫博物院 官方开放时间 预约', '故宫博物院'))
      .toBeUndefined()
  })

  it('景点和政府页都未命中时，只回退到同目的地的高相关公开游览信息页', () => {
    const links = [
      { targetId: 'l1', text: '上海景区开放时间与预约须知', url: 'https://travel.example/shanghai/visit' },
      { targetId: 'l2', text: '北京周末游玩推荐', url: 'https://travel.example/beijing/weekend' },
      { targetId: 'l3', text: '北京景区开放时间与预约须知', url: 'https://travel.example/beijing/visit' },
      { targetId: 'l4', text: '北京景区开放时间与预约攻略', url: 'https://www.xiaohongshu.com/explore/beijing' },
      { targetId: 'l5', text: '景区开放时间与预约', url: 'https://www.beijing.gov.cn/visit' }
    ]

    expect(selectBrowserFallbackLink(
      links, 'attraction', '故宫博物院 开放时间 预约', '故宫博物院', '北京'
    )).toMatchObject({ targetId: 'l5' })
    expect(selectBrowserFallbackLink(
      links.slice(0, 4), 'attraction', '故宫博物院 开放时间 预约', '故宫博物院', '北京'
    )).toMatchObject({ targetId: 'l3' })
    expect(selectBrowserFallbackLink(
      links.slice(0, 2), 'attraction', '故宫博物院 开放时间 预约', '故宫博物院', '北京'
    )).toBeUndefined()
    expect(selectBrowserFallbackLink(
      links.slice(0, 4), 'attraction', '故宫博物院 开放时间 预约', '故宫博物院'
    )).toBeUndefined()
  })

  it('用公开 URL 路径补足短标题相关度，不把域名或查询参数当作线索', () => {
    const destinationGuide = {
      targetId: 'l1', text: '参观须知',
      url: 'https://travel.example/%E5%8C%97%E4%BA%AC%E6%99%AF%E5%8C%BA%E5%BC%80%E6%94%BE%E6%97%B6%E9%97%B4%E4%B8%8E%E9%A2%84%E7%BA%A6'
    }
    const queryParameterOnly = {
      targetId: 'l2', text: '查看详情',
      url: 'https://travel.example/unrelated?topic=%E5%8C%97%E4%BA%AC%E6%95%85%E5%AE%AB%E5%BC%80%E6%94%BE%E6%97%B6%E9%97%B4%E9%A2%84%E7%BA%A6'
    }
    const domainOnly = {
      targetId: 'l3', text: '查看详情',
      url: 'https://beijing-attraction-opening.example/unrelated'
    }

    expect(selectBrowserFallbackLink(
      [destinationGuide], 'attraction', '故宫博物院 官方开放时间 预约', '故宫博物院', '北京'
    )).toMatchObject({ targetId: 'l1' })
    expect(selectBrowserFallbackLink(
      [queryParameterOnly], 'general', '北京 故宫博物院 开放时间 预约'
    )).toBeUndefined()
    expect(selectBrowserFallbackLink(
      [domainOnly], 'general', '北京 景点 开放时间 预约'
    )).toBeUndefined()
  })

  it('按地点别名识别景点回退查询，不要求模型重复用户写法', () => {
    const searches = initialAttractionSearches('北京', '故宫博物院', '2026-09-21', '2026-09-27')

    expect(attractionNameForBrowserFallbackQuery(searches, '北京 故宫开放时间与预约')).toBe('故宫博物院')
    expect(attractionNameForBrowserFallbackQuery(searches, '北京秋季旅游攻略')).toBeUndefined()
  })

  it('景点浏览器回退词保留地点上下文、官方参观页意图和事实类型，移除行程日期', () => {
    expect(browserFallbackSearchQuery(
      '北京 故宫博物院 2026-09-21 至 2026-09-27 官方开放时间 预约',
      'attraction', '故宫博物院'
    )).toBe('北京 故宫博物院 故宫 紫禁城 官方 参观须知 开放时间 预约')
    expect(browserFallbackSearchQuery('北京 天坛 2026-09-21 票价购票', 'attraction', '天坛'))
      .toBe('北京 天坛 官方 参观须知 门票')
    expect(browserFallbackSearchQuery('北京 机场交通接驳', 'general', '故宫博物院'))
      .toBe('北京 机场交通接驳')
    expect(browserFallbackSearchQuery('https://example.com/visit', 'attraction', '故宫博物院'))
      .toBe('https://example.com/visit')
  })

  it('景点事实补查保留目标前的城市与片区，避免搜索上下文丢失', () => {
    expect(browserFallbackSearchQuery(
      '北京 海淀区 圆明园西洋楼遗址 2026-09-22 官方开放时间 预约',
      'attraction', '圆明园西洋楼遗址'
    )).toBe('北京 海淀区 圆明园西洋楼遗址 圆明园西洋楼 官方 参观须知 开放时间 预约')
  })

  it('餐馆搜索从快照中选择社区原文，并保留浏览器内短期目标编号', () => {
    const links = [
      { targetId: 'l1', text: '北京出行路线攻略', url: 'https://www.xiaohongshu.com/explore/route' },
      { targetId: 'l2', text: '北京前门餐厅探店笔记', url: 'https://www.dianping.com/shop/123' },
      { targetId: 'l3', text: '前门地铁公交线路', url: 'https://www.beijing.gov.cn/transport' }
    ]

    expect(selectBrowserFallbackLink(links, 'meal', '北京前门晚餐餐厅')).toMatchObject({ targetId: 'l2' })
  })

  it('餐馆搜索可跟进匹配度高的餐馆官网，不限于社区平台', () => {
    const links = [
      { targetId: 'l1', text: '北京周末路线攻略', url: 'https://www.xiaohongshu.com/explore/route' },
      { targetId: 'l2', text: '全聚德前门店 · 北京烤鸭门店信息', url: 'https://www.quanjude.com.cn/store/qianmen' },
      { targetId: 'l3', text: '搜索结果：北京前门全聚德晚餐', url: 'https://www.bing.com/search/?q=北京前门全聚德晚餐' },
      { targetId: 'l4', text: '上海餐馆推荐', url: 'https://food.example/shanghai' }
    ]

    expect(selectBrowserFallbackLink(links, 'meal', '北京 前门 全聚德 晚餐 餐馆 门店地址'))
      .toMatchObject({ targetId: 'l2' })
  })

  it('通用回退只跟进与查询相关的公开原文，不选择搜索页或无关链接', () => {
    const links = [
      { targetId: 'l1', text: '北京大兴机场线乘车指南', url: 'https://www.beijing.gov.cn/transport/airport' },
      { targetId: 'l2', text: '北京周末赏花攻略', url: 'https://www.xiaohongshu.com/explore/flower' },
      { targetId: 'l3', text: '北京大兴机场交通', url: 'https://www.bing.com/search/?q=北京大兴机场交通' },
      { targetId: 'l4', text: '上海地铁出行指南', url: 'https://travel.example/shanghai/transit' }
    ]

    expect(selectBrowserFallbackLink(links, 'general', '北京 大兴机场 交通接驳')).toMatchObject({ targetId: 'l1' })
    expect(selectBrowserFallbackLink(links.slice(1, 2), 'general', '北京 大兴机场 交通接驳')).toBeUndefined()
  })

  it('浏览器链接未命中时只返回固定筛选原因', () => {
    expect(browserFallbackLinkMissReason([], 'attraction', '北京 故宫开放时间', '故宫博物院'))
      .toBe('no_actionable_links')
    expect(browserFallbackLinkMissReason([
      { targetId: 'l1', text: '故宫开放时间', url: 'https://www.bing.com/search/?q=故宫开放时间' }
    ], 'attraction', '北京 故宫开放时间', '故宫博物院')).toBe('no_public_links')
    expect(browserFallbackLinkMissReason([
      { targetId: 'l1', text: '故宫博物院旅游攻略', url: 'https://travel.example/palace/about' }
    ], 'attraction', '北京 故宫开放时间', '故宫博物院')).toBe('attraction_information_hint_missing')
    expect(browserFallbackLinkMissReason([
      { targetId: 'l1', text: '北京周末赏花攻略', url: 'https://travel.example/beijing/flowers' }
    ], 'general', '北京 大兴机场 交通接驳')).toBe('general_relevance_below_threshold')
    expect(browserFallbackLinkMissReason([
      { targetId: 'l1', text: '北京全聚德历史介绍', url: 'https://travel.example/beijing/history' }
    ], 'meal', '北京 前门 全聚德 晚餐 餐馆 门店地址')).toBe('meal_result_not_found')
  })

  it('显式社区搜索只选择可见社区文章链接，不把摘要或官方页冒充社区来源', () => {
    const links = [
      { targetId: 'l1', text: '北京秋天一天怎么玩', url: 'https://www.xiaohongshu.com/explore/autumn' },
      { targetId: 'l2', text: '北京旅游官方公告', url: 'https://www.beijing.gov.cn/travel' },
      { targetId: 'l3', text: '搜索结果：小红书攻略', url: 'https://www.bing.com/search/?q=小红书' },
      { targetId: 'l4', text: '上海秋日咖啡馆', url: 'https://www.xiaohongshu.com/explore/shanghai' }
    ]

    expect(selectBrowserFallbackLink(links, 'community', 'site:xiaohongshu.com 北京秋季攻略')).toMatchObject({ targetId: 'l1' })
    expect(selectBrowserFallbackLink(links.slice(1), 'community', 'site:xiaohongshu.com 北京秋季攻略')).toBeUndefined()
    expect(selectBrowserFallbackLink(links.slice(3), 'community', 'site:xiaohongshu.com 北京秋季攻略')).toBeUndefined()
  })

  it('详细行程使用完整但有上限的正文读取预算，普通问答只读两页', () => {
    expect(initialResearchPageLimit(true)).toBe(18)
    expect(initialResearchPageLimit(false)).toBe(2)
  })

  it('只把连续网络类浏览器失败纳入本轮熔断', () => {
    expect(MAX_BROWSER_NETWORK_FAILURE_STREAK).toBe(3)
    expect(MAX_BROWSER_NETWORK_FAILURES_PER_HOST).toBe(2)
    expect(isRetryableBrowserNetworkFailure('connection_reset')).toBe(true)
    expect(isRetryableBrowserNetworkFailure('proxy')).toBe(true)
    expect(isRetryableBrowserNetworkFailure('http')).toBe(false)
    expect(isRetryableBrowserNetworkFailure('dns')).toBe(false)
    expect(isRetryableBrowserNetworkFailure(undefined)).toBe(false)
    expect(researchBrowserTargetHost('北京 故宫 官方开放时间')).toBe('www.bing.com')
    expect(researchBrowserTargetHost('https://www.dpm.org.cn/Visit.html')).toBe('www.dpm.org.cn')
  })

  it('搜索渠道不可用时按顺序选择点名景点，并限制浏览器补查数量', () => {
    const searches = ['故宫', '天坛', '颐和园', '香山', '八达岭', '雍和宫', '景山', '北海', '国博', '清华', '北大', '前门'].map((name) => ({
      name, query: `北京 ${name} 官方开放时间`
    }))

    expect(selectBrowserFallbackSearches(searches, 2).map((item) => item.name)).toEqual(['故宫', '天坛'])
    expect(selectBrowserFallbackSearches(searches, 20)).toHaveLength(searches.length)
    expect(selectBrowserFallbackSearches(searches, 0)).toEqual([])
  })

  it('浏览器补查预算内优先补餐馆、交通，再补景点和通用查询', () => {
    const searches = [
      { name: '目的地资料', query: '北京旅行资料', intent: 'general' as const },
      { name: '故宫', query: '北京故宫开放时间', intent: 'attraction' as const },
      { name: '餐馆候选', query: '北京餐馆', intent: 'meal' as const },
      { name: '公共交通', query: '大兴机场进城', intent: 'transit' as const },
      { name: '天坛', query: '北京天坛开放时间', intent: 'attraction' as const }
    ]

    expect(selectBrowserFallbackSearches(searches, 3).map(({ name }) => name))
      .toEqual(['餐馆候选', '公共交通', '故宫'])
    expect(selectBrowserFallbackSearches(searches, 10).map(({ name }) => name))
      .toEqual(['餐馆候选', '公共交通', '故宫', '天坛'])
  })

  it('只为具体兴趣地点生成开放与预约查询', () => {
    const queries = initialAttractionSearches(
      '北京', '清华、北大、圆明园；红叶、北京标志景点、人文、美食', '2026-09-21', '2026-09-27'
    )

    expect(queries.map((item) => item.name)).toEqual(['清华', '北大', '圆明园'])
    expect(queries[0]?.query).toContain('官方开放时间 预约')
    expect(queries[0]?.query).toContain('2026-09-21 至 2026-09-27')
    expect(queries[0]?.query).toContain('清华大学 清华园')
  })

  it('偏好类别和没有明确地名的简报不触发地点查询', () => {
    expect(initialAttractionSearches('北京', '人文、美食、红叶', '2026-09-21', '2026-09-27')).toEqual([])
  })

  it('补查用户按日期明确列出的地点，并保持兴趣地点优先和十八次上限', () => {
    const request = '9/22 必须安排清华、北大、圆明园；9/23 参考颐和园与香山赏秋；9/24 参考天坛、国家博物馆、前门；9/27 只安排雍和宫或一个同等景点。'
    const searches = initialAttractionSearches(
      '北京', '清华、北大、圆明园；红叶、人文、美食', '2026-09-21', '2026-09-27', request
    )

    expect(searches.map((item) => item.name)).toEqual([
      '清华', '北大', '圆明园', '颐和园', '香山', '天坛', '国家博物馆', '前门', '雍和宫'
    ])
    expect(searches.every((item) => item.query.includes('官方开放时间 预约'))).toBe(true)
    expect(searches.find((item) => item.name === '颐和园')?.query).toContain('清漪园')
  })

  it('长行程浏览器回退可覆盖十八个明确点名地点', () => {
    const attractions = ['场馆甲', '场馆乙', '场馆丙', '场馆丁', '场馆戊', '场馆己', '场馆庚', '场馆辛', '场馆壬', '场馆癸', '场馆子', '场馆丑', '场馆寅', '场馆卯', '场馆辰', '场馆巳', '场馆午', '场馆未', '场馆申']
    const request = attractions.map((name) => `9/21 参考 ${name}`).join('；')
    const searches = initialAttractionSearches('北京', '', '2026-09-21', '2026-09-27', request)

    expect(searches.map((item) => item.name)).toEqual(attractions.slice(0, 18))
  })

  it('忽略没有明确日期安排动词的自由文本，避免猜测地点名', () => {
    expect(initialAttractionSearches(
      '北京', '人文、美食、红叶', '2026-09-21', '2026-09-27',
      '希望安排一个轻松的周末，也看看当地特色。'
    )).toEqual([])
  })

  it('保留复合地名，并拆开带地点后缀的并列地点', () => {
    const searches = initialAttractionSearches(
      '北京', '人文', '2026-09-21', '2026-09-27',
      '9/25 参考八达岭长城和鸟巢/水立方。'
    )

    expect(searches.map((item) => item.name)).toEqual(['八达岭长城', '鸟巢', '水立方'])
  })

  it('Firecrawl 返回配额或限流错误时停止后续自动读取', () => {
    const failedSource = (summary: string): SourceRecord => ({
      ...webSource('failed-page', 'https://museum.example/visit'),
      provider: 'Firecrawl', status: 'error', summary
    })

    expect(firecrawlReadStopReason([failedSource('外部服务返回 HTTP 402。')])).toBe('quota')
    expect(firecrawlReadStopReason([failedSource('外部服务返回 HTTP 429。')])).toBe('rate-limit')
    expect(firecrawlReadStopReason([failedSource('网络请求超时。')])).toBeUndefined()
    expect(firecrawlReadStopReason([{ ...failedSource('HTTP 402'), provider: 'Tavily' }])).toBeUndefined()
  })


})
