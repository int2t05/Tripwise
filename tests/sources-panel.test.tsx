/** 验证来源卡和来源移除弹窗渲染出的用户可见范围与可访问状态。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SourceRecord, Trip } from '../src/shared/types.js'
import { DeleteSourceModal, SourcesPanel } from '../src/renderer/src/SourcesPanel'

const source: SourceRecord = {
  id: 'source-1', title: '北京官方开放信息', url: 'https://example.com/opening', provider: '测试来源',
  kind: 'web', summary: '开放时段需按出行日复核。', fetchedAt: '2026-10-18T10:00:00.000Z', status: 'success'
}

const trip = { id: 'trip-1', sources: [source] } as Trip

describe('来源面板', () => {
  it('空旅行时说明来源会显示的位置', () => {
    const markup = renderToStaticMarkup(<SourcesPanel
      trip={null} selectedSourceId={null} retryingSourceIds={new Set()} deletionDisabled={false}
      onOpen={() => undefined} onPaste={() => undefined} onRetry={async () => undefined}
      onSkipRetry={async () => undefined} onRefresh={() => undefined} onDelete={() => undefined}
    />)

    expect(markup).toContain('还没有旅行资料')
    expect(markup).toContain('网页、天气、地点和导入的攻略')
  })

  it('来源卡展示资料摘要、来源性质和可访问的移除动作', () => {
    const markup = renderToStaticMarkup(<SourcesPanel
      trip={trip} selectedSourceId={source.id} retryingSourceIds={new Set()} deletionDisabled={false}
      onOpen={() => undefined} onPaste={() => undefined} onRetry={async () => undefined}
      onSkipRetry={async () => undefined} onRefresh={() => undefined} onDelete={() => undefined}
    />)

    expect(markup).toContain('北京官方开放信息')
    expect(markup).toContain('开放时段需按出行日复核。')
    expect(markup).toContain('来源待确认')
    expect(markup).not.toContain('网页资料')
    expect(markup).not.toContain('旅行资料</strong>')
    expect(markup).not.toContain('已获取')
    expect(markup).toContain('aria-label="移除来源：北京官方开放信息"')
    expect(markup).toContain('查看来源')
  })

  it('服务来源只显示类型，部分结果仍保留状态', () => {
    const partialWeather: SourceRecord = {
      ...source, id: 'partial-weather', title: '北京逐日天气', kind: 'weather', status: 'partial'
    }
    const markup = renderToStaticMarkup(<SourcesPanel
      trip={{ ...trip, sources: [partialWeather] }} selectedSourceId={null} retryingSourceIds={new Set()} deletionDisabled={false}
      onOpen={() => undefined} onPaste={() => undefined} onRetry={async () => undefined}
      onSkipRetry={async () => undefined} onRefresh={() => undefined} onDelete={() => undefined}
    />)

    expect(markup).toContain('天气')
    expect(markup).toContain('部分结果')
    expect(markup).not.toContain('数据服务')
    expect(markup).not.toContain('已获取')
  })

  it('视觉读取来源明确显示为图像线索', () => {
    const visualSource: SourceRecord = {
      ...source,
      id: 'visual-source',
      title: '图像线索 · 北京旅行攻略',
      provider: 'Tripwise 视觉读取',
      contentLevel: 'visual-clue',
      summary: '模型对当前网页视口的图像解读：红叶步道。'
    }
    const markup = renderToStaticMarkup(<SourcesPanel
      trip={{ ...trip, sources: [visualSource] }} selectedSourceId={visualSource.id}
      retryingSourceIds={new Set()} deletionDisabled={false}
      onOpen={() => undefined} onPaste={() => undefined} onRetry={async () => undefined}
      onSkipRetry={async () => undefined} onRefresh={() => undefined} onDelete={() => undefined}
    />)

    expect(markup).toContain('图像线索')
    expect(markup).toContain('截图未保存，不能单独核验动态事实')
  })

  it('社区搜索来源标明只有摘要，正文来源不显示摘要标签', () => {
    const snippet: SourceRecord = {
      ...source,
      id: 'community-snippet',
      title: '北京秋叶路线搜索结果',
      url: 'https://www.xiaohongshu.com/search_result',
      sourceNature: 'community-platform',
      contentLevel: 'snippet'
    }
    const snippetMarkup = renderToStaticMarkup(<SourcesPanel
      trip={{ ...trip, sources: [snippet] }} selectedSourceId={snippet.id} retryingSourceIds={new Set()} deletionDisabled={false}
      onOpen={() => undefined} onPaste={() => undefined} onRetry={async () => undefined}
      onSkipRetry={async () => undefined} onRefresh={() => undefined} onDelete={() => undefined}
    />)
    const pageMarkup = renderToStaticMarkup(<SourcesPanel
      trip={{ ...trip, sources: [{ ...snippet, contentLevel: 'page' }] }} selectedSourceId={snippet.id} retryingSourceIds={new Set()} deletionDisabled={false}
      onOpen={() => undefined} onPaste={() => undefined} onRetry={async () => undefined}
      onSkipRetry={async () => undefined} onRefresh={() => undefined} onDelete={() => undefined}
    />)

    expect(snippetMarkup).toContain('社区平台')
    expect(snippetMarkup).toContain('搜索摘要')
    expect(snippetMarkup).toContain('仅用于发现原文，不作为动态事实依据')
    expect(pageMarkup).not.toContain('搜索摘要')
  })

  it('旧天气来源提示复核，并提供重新查询入口', () => {
    const oldWeatherSource: SourceRecord = {
      ...source, id: 'weather-source', title: '北京逐日天气', kind: 'weather',
      fetchedAt: new Date(Date.now() - 7 * 60 * 60 * 1_000).toISOString()
    }
    const markup = renderToStaticMarkup(<SourcesPanel
      trip={{ ...trip, sources: [oldWeatherSource] }} selectedSourceId={null} retryingSourceIds={new Set()} deletionDisabled={false}
      onOpen={() => undefined} onPaste={() => undefined} onRetry={async () => undefined}
      onSkipRetry={async () => undefined} onRefresh={() => undefined} onDelete={() => undefined}
    />)

    expect(markup).toContain('天气可能已变化')
    expect(markup).toContain('天气查询已超过 6 小时')
    expect(markup).toContain('重新查询')
  })

  it('规划或来源查询运行时禁用移除动作并解释原因', () => {
    const markup = renderToStaticMarkup(<SourcesPanel
      trip={trip} selectedSourceId={null} retryingSourceIds={new Set()} deletionDisabled
      onOpen={() => undefined} onPaste={() => undefined} onRetry={async () => undefined}
      onSkipRetry={async () => undefined} onRefresh={() => undefined} onDelete={() => undefined}
    />)

    expect(markup).toContain('aria-label="移除来源：北京官方开放信息" disabled=""')
    expect(markup).toContain('规划或查询完成后可移除来源')
  })
})

describe('来源移除确认弹窗', () => {
  it('显示清理范围并保留历史文字边界', () => {
    const markup = renderToStaticMarkup(<DeleteSourceModal
      source={source} busy={false} hasActivity={false} onClose={() => undefined} onConfirm={() => undefined}
    />)

    expect(markup).toContain('移除这条资料？')
    expect(markup).toContain('删除链接、摘要、页面声明信息和重试参数')
    expect(markup).toContain('历史对话不会改写')
    expect(markup).toContain('aria-modal="true"')
  })

  it('来源操作运行时展示忙碌提示并禁用确认', () => {
    const markup = renderToStaticMarkup(<DeleteSourceModal
      source={source} busy={false} hasActivity onClose={() => undefined} onConfirm={() => undefined}
    />)

    expect(markup).toContain('role="status"')
    expect(markup).toContain('完成后即可移除资料')
    expect(markup).toContain('class="danger-button" disabled=""')
    expect(markup).toContain('>移除来源</button>')
  })
})
