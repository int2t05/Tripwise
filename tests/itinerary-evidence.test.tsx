/** 验证行程事实会区分历史来源关联与当前来源状态。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ItineraryStop, SourceRecord } from '../src/shared/types.js'
import { ItineraryEvidenceLinks } from '../src/renderer/src/ItineraryPlans'

const source: SourceRecord = {
  id: 'opening-source', title: '博物馆开放公告', url: 'https://example.com/opening', provider: '官方网页',
  kind: 'web', summary: '开放时间以出行日期公告为准。', fetchedAt: '2026-10-18T10:00:00.000Z', status: 'success'
}

const stop: ItineraryStop = {
  id: 'museum', name: '城市博物馆', area: '', time: '10:00', durationMinutes: 90,
  category: '人文', notes: '', transitToNext: '', evidenceLevel: 'sourced', sourceIds: [source.id],
  factClaims: [{
    id: 'opening-hours', type: 'opening-hours', value: '09:00–17:00', scope: '2026-10-20',
    evidenceLevel: 'sourced', sourceId: source.id
  }]
}

/** 使用固定来源状态渲染地点及事实依据，检查面向用户的状态文案。 */
function renderEvidence(sourceRecord?: SourceRecord): string {
  return renderToStaticMarkup(<ItineraryEvidenceLinks
    stop={stop}
    sources={sourceRecord ? [sourceRecord] : []}
    onOpen={() => undefined}
    onShowSource={() => undefined}
  />)
}

describe('行程来源状态', () => {
  it('成功来源显示获取时间和逐项事实依据', () => {
    const markup = renderEvidence(source)

    expect(markup).toContain('已关联来源')
    expect(markup).toContain('获取于')
    expect(markup).toContain('09:00–17:00')
    expect(markup).not.toContain('事实需复核')
  })

  it('待核验事实可展示相关网页，但明确不代表内容已核实', () => {
    const markup = renderToStaticMarkup(<ItineraryEvidenceLinks
      stop={{
        ...stop,
        evidenceLevel: 'pending',
        sourceIds: [],
        factClaims: [{
          id: 'opening-hours-pending', type: 'opening-hours', value: '具体开放时段待核验', scope: '2026-10-20',
          evidenceLevel: 'pending', sourceId: source.id
        }]
      }}
      sources={[source]}
      onOpen={() => undefined}
      onShowSource={() => undefined}
    />)

    expect(markup).toContain('博物馆开放公告')
    expect(markup).toContain('待核验')
    expect(markup).toContain('参考来源已关联，事实内容仍待核验。')
  })

  it('方案证据旁也提示较旧天气，并可打开来源面板重新查询', () => {
    const oldWeather: SourceRecord = {
      ...source, id: 'weather-source', title: '北京逐日天气', kind: 'weather',
      fetchedAt: new Date(Date.now() - 7 * 60 * 60 * 1_000).toISOString()
    }
    const markup = renderToStaticMarkup(<ItineraryEvidenceLinks
      stop={{ ...stop, sourceIds: [oldWeather.id] }}
      sources={[oldWeather]}
      onOpen={() => undefined}
      onShowSource={() => undefined}
    />)

    expect(markup).toContain('天气可能已变化')
    expect(markup).toContain('去来源面板重新查询')
  })

  it('动态事实行内提示较旧的天气和路线来源，并按事实组去重', () => {
    const oldWeather: SourceRecord = {
      ...source, id: 'weather-source', title: '北京逐日天气', kind: 'weather',
      fetchedAt: new Date(Date.now() - 7 * 60 * 60 * 1_000).toISOString()
    }
    const oldRoute: SourceRecord = {
      ...source, id: 'route-source', title: '地铁路线', kind: 'route',
      fetchedAt: new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString()
    }
    const markup = renderToStaticMarkup(<ItineraryEvidenceLinks
      stop={{
        ...stop,
        sourceIds: [oldWeather.id, oldRoute.id],
        factClaims: [
          { id: 'weather-a', type: 'weather', value: '小雨', scope: '第 1 天', evidenceLevel: 'sourced', sourceId: oldWeather.id },
          { id: 'weather-b', type: 'weather', value: '12–18℃', scope: '第 1 天', evidenceLevel: 'sourced', sourceId: oldWeather.id },
          { id: 'route-a', type: 'transport-time', value: '约 25 分钟', scope: '博物馆→公园', evidenceLevel: 'sourced', sourceId: oldRoute.id }
        ]
      }}
      sources={[oldWeather, oldRoute]}
      onOpen={() => undefined}
      onShowSource={() => undefined}
    />)

    const factClaimsMarkup = markup.slice(markup.indexOf('class="itinerary-fact-claims"'))
    expect(factClaimsMarkup.match(/天气可能已变化/g)).toHaveLength(1)
    expect(factClaimsMarkup.match(/路线可能已变化/g)).toHaveLength(1)
    expect(factClaimsMarkup.match(/去来源面板重新查询/g)).toHaveLength(2)
    expect(markup).toContain('aria-label="逐项来源事实"')
  })

  it('普通网页中的动态事实不套用天气或路线时效阈值', () => {
    const markup = renderToStaticMarkup(<ItineraryEvidenceLinks
      stop={{
        ...stop,
        sourceIds: [source.id],
        factClaims: [{
          id: 'opening-hours', type: 'opening-hours', value: '09:00–17:00', scope: '2026-10-20',
          evidenceLevel: 'sourced', sourceId: source.id
        }]
      }}
      sources={[{ ...source, fetchedAt: '2020-01-01T00:00:00.000Z' }]}
      onOpen={() => undefined}
      onShowSource={() => undefined}
    />)

    expect(markup).not.toContain('建议复核')
  })

  it('失败来源改为显示最近尝试时间并提醒复核事实', () => {
    const markup = renderEvidence({ ...source, status: 'error' })

    expect(markup).toContain('最近尝试于')
    expect(markup).toContain('来源查询失败')
    expect(markup).toContain('事实需复核')
  })

  it('来源记录缺失时不把旧事实误显示为当前可用来源', () => {
    const markup = renderEvidence()

    expect(markup).toContain('来源已不可用，请重新核对。')
  })
})
