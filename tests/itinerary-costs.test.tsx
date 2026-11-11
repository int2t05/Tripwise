/** 验证行程交通费用仅汇总用户已采纳且有结构化金额的路线。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ItineraryOption } from '../src/shared/types.js'
import { summarizeItineraryTransportCosts } from '../src/shared/itinerary.js'
import { ItineraryTransportCostSummary } from '../src/renderer/src/ItineraryPlans.js'

/** 构造包含不同交通方式和未知金额的计划，确保未知值不会误作零。 */
function makeItinerary(): ItineraryOption {
  const estimate = (mode: 'transit' | 'walking' | 'driving', amount?: number | null) => ({
    sourceId: `source-${mode}-${amount ?? 'unknown'}`,
    destinationStopId: 'destination', mode, fetchedAt: '2026-10-18T00:00:00.000Z', optionNumber: 1,
    ...(mode === 'transit' ? { fareFen: amount ?? null } : {}),
    ...(mode === 'driving' ? { tollFen: amount ?? null } : {})
  })
  return {
    id: 'cost-plan', title: '路线费用示例', summary: '', tradeoffs: '',
    days: [{
      id: 'day-one', dayNumber: 1, date: '2026-10-20', title: '第一天', scheduleBlocks: [],
      stops: [
        { id: 'transit-priced', name: '地点一', area: '', time: '', durationMinutes: null, category: '', notes: '', transitToNext: '', transitEstimate: estimate('transit', 450) },
        { id: 'transit-unknown', name: '地点二', area: '', time: '', durationMinutes: null, category: '', notes: '', transitToNext: '', transitEstimate: estimate('transit', null) },
        { id: 'driving-priced', name: '地点三', area: '', time: '', durationMinutes: null, category: '', notes: '', transitToNext: '', transitEstimate: estimate('driving', 275) },
        { id: 'walking', name: '地点四', area: '', time: '', durationMinutes: null, category: '', notes: '', transitToNext: '', transitEstimate: estimate('walking') }
      ]
    }]
  }
}

describe('已采纳路线费用汇总', () => {
  it('分别累计已知公交票价和驾车道路收费，并统计未返回金额的路段', () => {
    expect(summarizeItineraryTransportCosts(makeItinerary())).toEqual({
      publicTransportLegCount: 2, knownPublicTransportFareCount: 1, publicTransportFareFen: 450,
      drivingLegCount: 1, knownDrivingTollCount: 1, drivingTollFen: 275
    })
  })

  it('展示费用来源范围、未返回数量和没有计入的支出类别', () => {
    const markup = renderToStaticMarkup(<ItineraryTransportCostSummary itinerary={makeItinerary()} />)

    expect(markup).toContain('路线费用估算')
    expect(markup).toContain('公共交通票价小计')
    expect(markup).toContain('¥4.50')
    expect(markup).toContain('1/2 段已返回')
    expect(markup).toContain('道路收费小计')
    expect(markup).toContain('¥2.75')
    expect(markup).toContain('未乘出行人数')
    expect(markup).toContain('不含住宿、门票、餐饮、航班和打车费用')
  })

  it('没有已采纳路线时明确说明尚无费用数据', () => {
    const itinerary = makeItinerary()
    itinerary.days[0].stops.forEach((stop) => { delete stop.transitEstimate })

    const markup = renderToStaticMarkup(<ItineraryTransportCostSummary itinerary={itinerary} />)
    expect(markup).toContain('尚无已采纳的路线费用估算')
    expect(markup).not.toContain('¥0.00')
  })
})
