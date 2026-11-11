/** 验证模型驱动检索使用的浏览器回退预算和故障恢复。 */
import { describe, expect, it } from 'vitest'
import {
  browserFallbackBudgetLimits,
  initialResearchPageLimit,
  MAX_BROWSER_FALLBACK_PAGES,
  MAX_BROWSER_FALLBACK_SEARCHES,
  remainingBrowserFallbackBudget,
  shouldRetryAbortedBrowserLink,
  selectBrowserFallbackSearches,
  spreadResearchQueries
} from '../src/main/agent-research.js'

describe('Agent 网页研究预算', () => {
  it('搜索服务不可用时仍能回退全部景点、餐饮和交通查询', () => {
    const targets = [
      { name: '一般资料', query: 'general', intent: 'general' as const },
      { name: '餐饮', query: 'meal', intent: 'meal' as const },
      { name: '交通', query: 'transit', intent: 'transit' as const },
      ...Array.from({ length: 18 }, (_, index) => ({
        name: `景点 ${index + 1}`, query: `attraction-${index + 1}`, intent: 'attraction' as const
      }))
    ]

    const selected = selectBrowserFallbackSearches(targets, MAX_BROWSER_FALLBACK_SEARCHES)

    expect(MAX_BROWSER_FALLBACK_SEARCHES).toBe(20)
    expect(selected).toHaveLength(20)
    expect(selected.map((target) => target.name)).toEqual([
      '餐饮', '交通', ...Array.from({ length: 18 }, (_, index) => `景点 ${index + 1}`)
    ])
  })

  it('正文回退与详细行程预读共享十八页上限', () => {
    expect(MAX_BROWSER_FALLBACK_PAGES).toBe(initialResearchPageLimit(true))
    expect(MAX_BROWSER_FALLBACK_PAGES).toBe(18)
    expect(initialResearchPageLimit(false)).toBe(2)
  })

  it('短修改轮保留事实与餐馆专用额度，详细行程总上限不变', () => {
    const shortRevision = browserFallbackBudgetLimits(false, 6, 4)
    expect(shortRevision).toEqual({ searches: 12, pages: 12 })
    expect(remainingBrowserFallbackBudget(shortRevision.searches, 0, 10)).toBe(2)
    expect(remainingBrowserFallbackBudget(shortRevision.pages, 0, 10)).toBe(2)
    expect(remainingBrowserFallbackBudget(shortRevision.searches, 2, 10)).toBe(0)

    expect(browserFallbackBudgetLimits(true, 6, 4)).toEqual({ searches: 20, pages: 18 })
    expect(browserFallbackBudgetLimits(false)).toEqual({ searches: 2, pages: 2 })
  })

  it('只在仍有正文额度时恢复 Chromium 中止的开链', () => {
    expect(shouldRetryAbortedBrowserLink({
      failureKind: 'aborted', hasUnreservedPageBudget: true, hasFactRepairReserve: false, usedPages: 1, pageLimit: 2
    })).toBe(true)
    expect(shouldRetryAbortedBrowserLink({
      failureKind: 'aborted', hasUnreservedPageBudget: false, hasFactRepairReserve: true, usedPages: 1, pageLimit: 2
    })).toBe(true)
    expect(shouldRetryAbortedBrowserLink({
      failureKind: 'aborted', hasUnreservedPageBudget: false, hasFactRepairReserve: true, usedPages: 2, pageLimit: 2
    })).toBe(false)
    expect(shouldRetryAbortedBrowserLink({
      failureKind: 'aborted', hasUnreservedPageBudget: false, hasFactRepairReserve: false, usedPages: 1, pageLimit: 2
    })).toBe(false)
    expect(shouldRetryAbortedBrowserLink({
      failureKind: 'connection_reset', hasUnreservedPageBudget: true, hasFactRepairReserve: true, usedPages: 1, pageLimit: 2
    })).toBe(false)
  })

  it('餐饮补查预算按整趟日期分散，而不是集中在行程开头', () => {
    const queries = Array.from({ length: 21 }, (_, index) => `第${Math.floor(index / 3) + 1}天餐次${index % 3 + 1}`)

    expect(spreadResearchQueries(queries, 4)).toEqual([
      '第1天餐次1', '第3天餐次2', '第5天餐次2', '第7天餐次3'
    ])
    expect(spreadResearchQueries(queries, 1)).toEqual(['第1天餐次1'])
    expect(spreadResearchQueries(queries, 0)).toEqual([])
  })

  it('为事实与餐饮补查保留浏览器额度，且短行程仍有前期回退机会', () => {
    expect(remainingBrowserFallbackBudget(20, 0, 10)).toBe(10)
    expect(remainingBrowserFallbackBudget(20, 9, 10)).toBe(1)
    expect(remainingBrowserFallbackBudget(20, 0, 4)).toBe(16)
    expect(remainingBrowserFallbackBudget(2, 0, 10)).toBe(1)
    expect(remainingBrowserFallbackBudget(2, 1, 10)).toBe(0)
    expect(remainingBrowserFallbackBudget(20, 20, 0)).toBe(0)
  })
})
