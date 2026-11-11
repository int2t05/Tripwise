/** 验证逐日天气在行程草案中可见，并能打开对应来源。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ItineraryDay, SourceRecord } from '../src/shared/types.js'
import { PlanDaySchedulePreview } from '../src/renderer/src/ItineraryPlans'

const weatherSource: SourceRecord = {
  id: 'weather-source', title: '逐日天气：厦门', url: 'https://open-meteo.com/en/docs', provider: 'Open-Meteo',
  kind: 'weather', summary: '2026-11-05：小雨，20–25°C', fetchedAt: '2026-10-24T09:00:00.000Z', status: 'success',
  contentLevel: 'structured'
}

const day: ItineraryDay = {
  id: 'day-1', dayNumber: 1, date: '2026-11-05', title: '中山路',
  weather: { status: 'forecast', summary: '2026-11-05：小雨，20–25°C', sourceId: weatherSource.id },
  scheduleBlocks: [],
  stops: [{
    id: 'stop-1', name: '中山路步行街', area: '思明区', time: '09:00–11:00', durationMinutes: 120,
    category: '景点', notes: '', transitToNext: ''
  }]
}

describe('逐日天气展示', () => {
  it('显示天气状态、日期预报和可打开的来源', () => {
    const markup = renderToStaticMarkup(<PlanDaySchedulePreview
      day={day}
      lodgingLocation=""
      sources={[weatherSource]}
      onOpen={() => undefined}
      onShowSource={() => undefined}
    />)

    expect(markup).toContain('aria-label="第 1 天天气状态"')
    expect(markup).toContain('天气预报')
    expect(markup).toContain('2026-11-05：小雨，20–25°C')
    expect(markup).toContain('逐日天气：厦门')
    expect(markup).toContain('获取于')
  })

  it('没有日期匹配数据时明确显示未知，且不伪造来源链接', () => {
    const markup = renderToStaticMarkup(<PlanDaySchedulePreview
      day={{ ...day, weather: { status: 'unknown', summary: '本日天气未知。' } }}
      lodgingLocation=""
      sources={[]}
      onOpen={() => undefined}
      onShowSource={() => undefined}
    />)

    expect(markup).toContain('天气未知')
    expect(markup).toContain('本日天气未知。')
    expect(markup).toContain('没有覆盖这一天的天气来源')
    expect(markup).not.toContain('Open-Meteo')
  })
})
