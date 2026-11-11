/** 旅行简报的纯展示规则；空字段保留为未知，不替用户补全信息。 */
import type { TripBrief, TripBriefField } from './types.js'

export const TRIP_BRIEF_FIELD_LABELS: Record<TripBriefField, string> = {
  departureCity: '出发地',
  destination: '目的地',
  startDate: '出发日期',
  endDate: '返程日期',
  arrivalFlight: '抵达航班或车次',
  arrivalTime: '抵达时间',
  leaveTime: '离开时间',
  travelers: '同行人',
  budget: '预算',
  lodgingLocation: '具体住宿地点',
  lodging: '住宿区域与偏好',
  pace: '行程强度',
  earlyStart: '出发时间偏好',
  interests: '兴趣点',
  transport: '交通偏好',
  dietary: '忌口与饮食',
  luggage: '行李限制',
  clothing: '穿搭与已有衣物',
  constraints: '其他约束'
}

/** 按旅行表单顺序列出可标记的简报字段。 */
export const TRIP_BRIEF_FIELDS = Object.keys(TRIP_BRIEF_FIELD_LABELS) as TripBriefField[]

export type BriefDateReadiness = 'missing' | 'partial' | 'ready'

export interface TripBriefReadiness {
  destinationReady: boolean
  departureReady: boolean
  dates: BriefDateReadiness
}

/** 验证暂未知字段：只允许简报字段、禁止重复，并要求对应值为空。 */
export function normalizeTripBriefUnknownFields(value: unknown, brief: TripBrief): TripBriefField[] | null {
  if (!Array.isArray(value) || value.length > TRIP_BRIEF_FIELDS.length) return null
  const selected = new Set<TripBriefField>()
  for (const field of value) {
    if (typeof field !== 'string' || !Object.hasOwn(TRIP_BRIEF_FIELD_LABELS, field) || selected.has(field as TripBriefField)) return null
    const briefField = field as TripBriefField
    if (brief[briefField].trim()) return null
    selected.add(briefField)
  }
  return TRIP_BRIEF_FIELDS.filter((field) => selected.has(field))
}

/** 判断出行规划最关键的目的地、日期范围和出发地是否已明确。 */
export function assessTripBriefReadiness(brief: Pick<TripBrief, 'destination' | 'departureCity' | 'startDate' | 'endDate'>): TripBriefReadiness {
  const hasStart = !!brief.startDate.trim()
  const hasEnd = !!brief.endDate.trim()
  return {
    destinationReady: !!brief.destination.trim(),
    departureReady: !!brief.departureCity.trim(),
    dates: hasStart && hasEnd ? 'ready' : hasStart || hasEnd ? 'partial' : 'missing'
  }
}
