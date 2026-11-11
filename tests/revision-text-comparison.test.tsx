/** 验证缺少结构化字段的旅行版本仍可并排审阅文本内容。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ItineraryRevision } from '../src/shared/types.js'
import { RevisionTextComparison } from '../src/renderer/src/RevisionTextComparison'
import { compareTextLines } from '../src/renderer/src/text-line-diff.js'

const previous: ItineraryRevision = {
  id: 'revision-1', number: 1, createdAt: '2026-10-17T10:00:00.000Z',
  summary: '旧方案', content: '# 旧版路线\n第一天去故宫。', sourceIds: []
}
const current: ItineraryRevision = {
  id: 'revision-2', number: 2, createdAt: '2026-10-18T10:00:00.000Z',
  summary: '新方案', content: '# 新版路线\n第一天去颐和园。', sourceIds: []
}

describe('纯文本行程版本对照', () => {
  it('并排显示相邻版本的文本和对应版本号', () => {
    const markup = renderToStaticMarkup(<RevisionTextComparison
      current={current} previous={previous} onOpen={() => undefined}
    />)

    expect(markup).toContain('文本对照 · 第 1 版与当前第 2 版')
    expect(markup).toContain('旧版路线')
    expect(markup).toContain('新版路线')
    expect(markup).toContain('第一天去颐和园。')
    expect(markup).toContain('逐行变化')
    expect(markup).toContain('删除')
    expect(markup).toContain('新增')
  })

  it('两版都已结构化时改用地点级差异预览，不展示纯文本对照', () => {
    const structured = { days: [] } as unknown as NonNullable<ItineraryRevision['itinerary']>
    const markup = renderToStaticMarkup(<RevisionTextComparison
      current={{ ...current, itinerary: structured }}
      previous={{ ...previous, itinerary: structured }}
      onOpen={() => undefined}
    />)

    expect(markup).toBe('')
  })

  it('按行区分新增、删除和保留内容', () => {
    const diff = compareTextLines('标题\n旧路线\n保留', '标题\n新路线\n保留\n新增事项')

    expect(diff?.addedCount).toBe(2)
    expect(diff?.removedCount).toBe(1)
    expect(diff?.changes).toContainEqual({ kind: 'removed', text: '旧路线' })
    expect(diff?.changes).toContainEqual({ kind: 'added', text: '新增事项' })
    expect(diff?.changes).toContainEqual({ kind: 'unchanged', text: '保留' })
  })

  it('超过比较矩阵上限时保留全文对照并跳过逐行计算', () => {
    const longText = Array.from({ length: 1_000 }, (_, index) => `行程 ${index}`).join('\n')

    expect(compareTextLines(longText, longText)).toBeNull()
  })
})
