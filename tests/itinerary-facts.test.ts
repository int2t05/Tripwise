/** 验证景点事实修订只接受来源正文直证，且不改动方案其他部分。 */
import { describe, expect, it } from 'vitest'
import type { ItineraryOption, ItineraryStop } from '../src/shared/types.js'
import { itineraryFactRepairTool } from '../src/main/connectors/itinerary-facts.js'
import { createSource } from '../src/main/connectors/types.js'

/** 构造一个待核验景点。 */
function stop(name: string, area: string, id = name): ItineraryStop {
  return {
    id, name, area, time: '09:00–12:00', durationMinutes: 180, category: '景点',
    notes: '', transitToNext: '', evidenceLevel: 'pending', sourceIds: [],
    factClaims: [
      { id: `${id}-hours`, type: 'opening-hours', value: '开放时间待核验', scope: '2026-11-03', evidenceLevel: 'pending' },
      { id: `${id}-booking`, type: 'booking', value: '预约规则待核验', scope: '2026-11-03', evidenceLevel: 'pending' }
    ]
  }
}

/** 构造两个日期，验证事实更新严格落在一个目标停靠点。 */
function plan(): ItineraryOption {
  return {
    id: 'plan-1', title: '北京行程', summary: '原摘要', tradeoffs: '原取舍',
    days: [
      { id: 'day-1', dayNumber: 1, date: '2026-11-03', title: '市区', scheduleBlocks: [], stops: [stop('故宫博物院', '东城区'), stop('颐和园', '海淀区')] },
      { id: 'day-2', dayNumber: 2, date: '2026-11-04', title: '海淀', scheduleBlocks: [], stops: [stop('圆明园', '海淀区', 'yuanmingyuan')] }
    ]
  }
}

/** 创建能直接证明故宫开放与预约信息的页面来源。 */
function officialSource(text = '故宫博物院每日开放时间为08:30至17:00；参观故宫博物院需提前预约。') {
  const source = createSource('故宫博物院参观须知', 'https://palace.example/visit', '网页正文', 'web', text)
  source.id = 'source-palace-official'
  source.contentLevel = 'page'
  source.factEvidenceExcerpt = text
  return source
}

/** 生成每次修订都要求的目标位置锚点。 */
function update(claims: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  return {
    plan_number: 1, day_number: 1, date: '2026-11-03', stop_name: '故宫博物院', area: '东城区',
    claims, ...overrides
  }
}

const openingClaim = (): Record<string, unknown> => ({
  quote_id: 'q1', scope: '2026-11-03', evidence_level: 'sourced'
})

const bookingClaim = (): Record<string, unknown> => ({
  quote_id: 'q2', scope: '2026-11-03', evidence_level: 'sourced'
})

/** 以最小上下文调用本地事实修订工具。 */
async function repair(
  options: ItineraryOption[], updates: unknown[], sources: ReturnType<typeof officialSource>[],
  quoteOverrides: { opening?: string; booking?: string } = {}
) {
  const factRepairSourceBindings = sources.length ? [{
    plan_number: 1, day_number: 1, date: '2026-11-03', stop_name: '故宫博物院', area: '东城区',
    source_ids: sources.map((source) => source.id),
    fact_quotes: [
      ...(quoteOverrides.opening ? [quoteOverrides.opening] : ['故宫博物院每日开放时间为08:30至17:00']).map((value) => ({
        source_id: sources[0]!.id, type: 'opening-hours' as const,
        candidates: [{ quote_id: 'q1', value }]
      })),
      ...(quoteOverrides.booking ? [quoteOverrides.booking] : ['参观故宫博物院需提前预约']).map((value) => ({
        source_id: sources[0]!.id, type: 'booking' as const,
        candidates: [{ quote_id: 'q2', value }]
      }))
    ]
  }] : []
  return itineraryFactRepairTool.execute({ updates }, {
    amapKey: null, sourceIds: sources.map((source) => source.id), availableSources: sources,
    itineraryOptions: options,
    openingHoursDetailsRequested: true, bookingDetailsRequested: true,
    factRepairSourceBindings
  })
}

describe('景点事实局部修订', () => {
  it('由本机按引文编号回填原文，不采纳模型附带的改写值', async () => {
    const original = plan()
    const source = officialSource()
    const result = await itineraryFactRepairTool.execute({ updates: [update([{
      quote_id: 'q1', scope: '2026-11-03', evidence_level: 'sourced',
      value: '故宫开放时间为 09:00 至 23:00'
    }]) ] }, {
      amapKey: null, sourceIds: [source.id], availableSources: [source],
      itineraryOptions: [original],
      openingHoursDetailsRequested: true,
      factRepairSourceBindings: [{
        plan_number: 1, day_number: 1, date: '2026-11-03', stop_name: '故宫博物院', area: '东城区',
        source_ids: [source.id], fact_quotes: [{
          source_id: source.id, type: 'opening-hours',
          candidates: [{ quote_id: 'q1', value: '故宫博物院每日开放时间为08:30至17:00' }]
        }]
      }]
    })
    const fact = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.find((claim) => claim.type === 'opening-hours')

    expect(fact).toMatchObject({
      type: 'opening-hours', value: '故宫博物院每日开放时间为08:30至17:00',
      evidenceLevel: 'sourced', sourceId: source.id
    })
    expect(result.itineraryFactEvidenceDiagnostics).toMatchObject({
      requestedCount: 1, rejectedCount: 0, valueMismatchCount: 0
    })
  })

  it('工具只接受编号，不接受模型自由填写的事实值', () => {
    const definition = itineraryFactRepairTool.definition.function

    expect(definition.description).toContain('只能选择提供的 quote_id')
    expect(definition.description).toContain('按编号恢复来源类别和原文')
    expect(JSON.stringify(definition)).toContain('quote_id')
    expect(JSON.stringify(definition)).not.toContain('source_id 对应正文中的连续原文')
  })

  it('接受正文直证的声明，并保留其他景点、日期和计划文字', async () => {
    const original = plan()
    const source = officialSource()
    const result = await repair([original], [update([openingClaim(), bookingClaim()])], [source])
    const updated = result.itineraryOptions?.[0]
    const targetClaims = updated?.days[0]?.stops[0]?.factClaims ?? []

    expect(targetClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'opening-hours', value: '故宫博物院每日开放时间为08:30至17:00', evidenceLevel: 'sourced', sourceId: source.id }),
      expect.objectContaining({ type: 'booking', value: '参观故宫博物院需提前预约', evidenceLevel: 'sourced', sourceId: source.id })
    ]))
    expect(updated?.title).toBe(original.title)
    expect(updated?.summary).toBe(original.summary)
    expect(updated?.days[0]?.stops[1]).toEqual(original.days[0]?.stops[1])
    expect(updated?.days[1]).toEqual(original.days[1])
    expect(original.days[0]?.stops[0]?.factClaims?.every((claim) => claim.evidenceLevel === 'pending')).toBe(true)
  })

  it('不接受其他景点正文作为目标景点证据，并保留待核验项', async () => {
    const original = plan()
    const source = officialSource('颐和园开放时间为06:00至20:00。')
    const result = await repair([original], [update([openingClaim()])], [source], {
      opening: '颐和园开放时间为06:00至20:00'
    })

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims).toEqual(original.days[0]?.stops[0]?.factClaims)
    expect(result.itineraryFactEvidenceDiagnostics).toMatchObject({ requestedCount: 1, rejectedCount: 1 })
  })

  it('编号指向的原文仍须通过正文与地点校验', async () => {
    const original = plan()
    const source = officialSource()
    const result = await repair([original], [update([openingClaim()])], [source], {
      opening: '故宫博物院开放时间为09:00至18:00'
    })

    expect(result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims).toEqual(original.days[0]?.stops[0]?.factClaims)
    expect(result.itineraryFactEvidenceDiagnostics).toMatchObject({ requestedCount: 1, valueMismatchCount: 1 })
  })

  it('开放时段原文正确但未证明适用日期时，应指出范围不匹配并继续待核验', async () => {
    const original = plan()
    const quote = '故宫博物院旺季每日开放时间为08:30至17:00'
    const source = officialSource(`${quote}。`)
    const result = await repair([original], [update([openingClaim()])], [source], { opening: quote })
    const fact = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.find((claim) => claim.type === 'opening-hours')

    expect(fact).toMatchObject({ evidenceLevel: 'pending', value: '开放时间待核验' })
    expect(result.itineraryFactEvidenceDiagnostics).toMatchObject({
      requestedCount: 1, rejectedCount: 1, scopeMismatchCount: 1, valueMismatchCount: 0
    })
    expect(result.output).toContain('原文未证明该开放时段适用于所填日期')
    expect(result.output).not.toContain('事实值必须复制')
  })

  it('拒绝语义相近但不是正文原文的预约值', async () => {
    const original = plan()
    const source = officialSource()
    const result = await repair([original], [update([bookingClaim()])], [source], {
      booking: '必须提前在网上预约'
    })
    const fact = result.itineraryOptions?.[0]?.days[0]?.stops[0]?.factClaims?.find((claim) => claim.type === 'booking')

    expect(fact).toMatchObject({ evidenceLevel: 'pending', value: '预约规则待核验' })
    expect(result.itineraryFactEvidenceDiagnostics).toMatchObject({ requestedCount: 1, valueMismatchCount: 1 })
    expect(result.output).toContain('事实值必须复制对应正文中的连续原文')
  })

  it('拒绝日期或区域不匹配的停靠点更新', async () => {
    const original = plan()
    const source = officialSource()
    const result = await repair([original], [update([openingClaim()], { date: '2026-11-04' })], [source])

    expect(result.itineraryOptions?.[0]?.days).toEqual(original.days)
    expect(result.output).toContain('未采纳')
  })

  it('没有可直证事实时接受空更新并原样保留草案', async () => {
    const original = plan()
    const result = await repair([original], [], [])

    expect(result.itineraryOptions).toEqual([original])
    expect(result.output).toContain('仍待核验')
  })
})
