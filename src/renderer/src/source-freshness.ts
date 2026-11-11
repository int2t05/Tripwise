/** 为变化较快的旅行来源提供明确阈值的复核提醒。 */
import type { SourceRecord } from '@shared/types'

const HOUR_MS = 60 * 60 * 1_000

export interface SourceFreshnessNotice {
  label: string
  detail: string
}

/** 只提醒天气和路线等动态数据；不把网页、地点或用户资料套用统一有效期。 */
export function sourceFreshnessNotice(
  source: Pick<SourceRecord, 'kind' | 'status' | 'fetchedAt'>,
  now = Date.now()
): SourceFreshnessNotice | null {
  if (source.status !== 'success') return null

  const fetchedAt = Date.parse(source.fetchedAt)
  if (!Number.isFinite(fetchedAt) || fetchedAt > now) return null

  if (source.kind === 'weather') {
    if (now - fetchedAt < 6 * HOUR_MS) return null
    return {
      label: '天气可能已变化',
      detail: '天气查询已超过 6 小时。出发前建议重新查询。'
    }
  }

  if (source.kind === 'route') {
    if (now - fetchedAt < 24 * HOUR_MS) return null
    return {
      label: '路线可能已变化',
      detail: '路线查询已超过 24 小时。出发前建议重新查询。'
    }
  }

  return null
}
