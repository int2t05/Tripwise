/** 规划景点开放、预约和票价事实所需的定向网页补查。 */
import { spreadResearchQueries } from './agent-research.js'

export interface FactRepairSourceTarget {
  stop_name: string
  area?: string
  missing_facts: readonly string[]
  source_ids: readonly string[]
  preferred?: boolean
}

export interface FactRepairBrowserSearch<T extends FactRepairSourceTarget> {
  target: T
  query: string
}

/** 忽略空格和标点，统一比较相同地点及片区。 */
function normalizeSearchTargetPart(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLocaleLowerCase()
}

/** 事实补查使用剩余网页预算，并受未核验地点数限制。 */
export function factRepairBrowserSearchCapacity(
  targetCount: number,
  availableSearches: number,
  availablePages: number,
  reservedCapacity = 0
): number {
  const normalize = (value: number): number => Math.max(0, Math.floor(value))
  const reserve = normalize(reservedCapacity)
  return Math.min(
    normalize(targetCount),
    normalize(availableSearches) + reserve,
    normalize(availablePages) + reserve
  )
}

/** 合并同一地点的缺失事实类别，再均匀分配有限搜索预算。 */
export function planFactRepairBrowserSearches<T extends FactRepairSourceTarget>(
  targets: readonly T[],
  destination: string,
  limit: number
): { missingPlaceCount: number; searches: Array<FactRepairBrowserSearch<T>> } {
  const missingByPlace = new Map<string, { target: T; factTypes: Set<string>; preferred: boolean }>()
  for (const target of targets) {
    if (target.source_ids.length > 0 || !target.stop_name.trim()) continue
    const key = JSON.stringify([
      normalizeSearchTargetPart(target.stop_name), normalizeSearchTargetPart(target.area ?? '')
    ])
    const group = missingByPlace.get(key) ?? {
      target, factTypes: new Set<string>(), preferred: target.preferred === true
    }
    for (const factType of target.missing_facts) group.factTypes.add(factType)
    group.preferred ||= target.preferred === true
    missingByPlace.set(key, group)
  }

  const candidates = [...missingByPlace.values()].map(({ target, factTypes, preferred }) => {
    const missingFacts = [...factTypes]
    const factLabels = missingFacts.map((fact) => {
      if (fact === 'opening-hours') return '开放时间'
      if (fact === 'booking') return '预约'
      if (fact === 'ticket-price') return '门票'
      return fact
    })
    const query = `${destination} ${target.area?.trim() ?? ''} ${target.stop_name} 官方 ${factLabels.join(' ')}`
      .replace(/\s+/gu, ' ').trim().slice(0, 300)
    return {
      target: { ...target, missing_facts: missingFacts, ...(preferred ? { preferred: true } : {}) } as T,
      query
    }
  })
  const selectCandidates = (pool: typeof candidates, count: number) => {
    const selectedQueries = spreadResearchQueries(pool.map(({ query }) => query), count)
    return selectedQueries.flatMap((query) => {
      const candidate = pool.find((entry) => entry.query === query)
      return candidate ? [candidate] : []
    })
  }
  const preferredCandidates = candidates.filter(({ target }) => target.preferred === true)
  const otherCandidates = candidates.filter(({ target }) => target.preferred !== true)
  const selectedPreferred = selectCandidates(preferredCandidates, Math.min(limit, preferredCandidates.length))
  const selectedOthers = selectCandidates(otherCandidates, Math.max(0, limit - selectedPreferred.length))
  const searches = [...selectedPreferred, ...selectedOthers]

  return { missingPlaceCount: missingByPlace.size, searches }
}
