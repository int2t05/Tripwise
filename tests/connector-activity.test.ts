/** 验证设置页仅将来源状态归属给实际调用的内置连接器。 */
import { describe, expect, it } from 'vitest'
import type { SourceKind, SourceRecord, SourceStatus } from '../src/shared/types.js'
import { latestConnectorSource } from '../src/renderer/src/connector-activity'

function source(id: string, provider: string, kind: SourceKind, status: SourceStatus, fetchedAt: string): SourceRecord {
  return { id, title: id, url: '', provider, kind, summary: id, fetchedAt, status }
}

describe('内置连接器最近状态', () => {
  it('网页搜索不显示更新的小红书或 Firecrawl 状态', () => {
    const sources = [
      source('search', 'Exa 搜索结果', 'web', 'success', '2026-10-18T10:00:00.000Z'),
      source('firecrawl', 'Firecrawl', 'web', 'error', '2026-10-18T11:00:00.000Z'),
      source('xiaohongshu', 'OpenCLI · 小红书', 'web', 'error', '2026-10-18T12:00:00.000Z')
    ]

    expect(latestConnectorSource(sources, 'webSearch', 'web')?.id).toBe('search')
  })

  it('搜索回退渠道仍属于网页搜索连接器', () => {
    const sources = [
      source('exa-failure', 'Exa', 'web', 'error', '2026-10-18T10:00:00.000Z'),
      source('fallback', 'DuckDuckGo 搜索结果', 'web', 'success', '2026-10-18T10:01:00.000Z')
    ]

    expect(latestConnectorSource(sources, 'webSearch', 'web')?.id).toBe('fallback')
  })

  it('路线和地点即便都来自高德也按来源类型分别显示', () => {
    const sources = [
      source('place', '高德地图', 'place', 'success', '2026-10-18T10:00:00.000Z'),
      source('route', '高德地图路线规划', 'route', 'error', '2026-10-18T11:00:00.000Z')
    ]

    expect(latestConnectorSource(sources, 'places', 'place')?.id).toBe('place')
    expect(latestConnectorSource(sources, 'routes', 'route')?.id).toBe('route')
  })
})
