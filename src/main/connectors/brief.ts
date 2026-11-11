/** 从对话提取旅行条件，并生成由用户确认后才应用的变更提案。 */
import type { TripBrief, TripBriefProposal } from '../../shared/types.js'
import { sanitizeBrief, validateBriefDates } from '../trip-brief.js'
import { ToolInputError, type TravelTool } from './types.js'

const FIELD_MAP = {
  departure_city: 'departureCity',
  destination: 'destination',
  start_date: 'startDate',
  end_date: 'endDate',
  arrival_flight: 'arrivalFlight',
  arrival_time: 'arrivalTime',
  leave_time: 'leaveTime',
  travelers: 'travelers',
  budget: 'budget',
  lodging_location: 'lodgingLocation',
  lodging: 'lodging',
  pace: 'pace',
  early_start: 'earlyStart',
  interests: 'interests',
  transport: 'transport',
  dietary: 'dietary',
  luggage: 'luggage',
  clothing: 'clothing',
  constraints: 'constraints'
} as const satisfies Record<string, keyof TripBrief>

const FIELD_PROPERTIES = Object.fromEntries(Object.keys(FIELD_MAP).map((field) => [field, {
  type: 'string',
  description: field === 'lodging_location'
    ? '具体酒店名称或地址；仅在用户明确提供时填写，不能从住宿区域或房型偏好推断。'
    : field === 'lodging'
      ? '住宿区域或房型偏好；不可当作可导航路线起点。'
      : '仅填写用户明确说出或明确修正的内容；不要推断。用户明确表示未知时可填空字符串。'
}]))

/** 为对话中明确提及的旅行条件生成待审变更，不直接修改已保存简报。 */
export const briefProposalTool: TravelTool = {
  definition: {
    type: 'function',
    function: {
      name: 'propose_trip_brief',
      description: '从用户对话中提取明确提供或修正的旅行条件，供用户审阅后应用。只包含本轮明确提到的字段；不要填充推测值，也不要重复没有变化的已有值。',
      parameters: {
        type: 'object',
        properties: FIELD_PROPERTIES,
        required: [],
        additionalProperties: false
      }
    }
  },
  provider: 'Tripwise 旅行信息',
  kind: 'user',
  sourceUrl: '',
  /** 只从用户本轮明确表达中提取简报字段，并返回待确认提案。 */
  async execute(args, context) {
    if (!context.tripBrief) throw new ToolInputError('当前旅行简报不可用，无法安全提取条件。')
    const proposal = normalizeProposal(args, context.tripBrief)
    const labels = Object.keys(proposal.changes).map((key) => FIELD_LABELS[key as keyof TripBrief])
    return {
      output: `整理出 ${labels.length} 项旅行信息：${labels.join('、')}。确认后应用。`,
      sources: [],
      briefProposal: proposal
    }
  }
}

/** 仅保留契约内字段，记录读取时原值并校验新旧日期组合。 */
function normalizeProposal(args: Record<string, unknown>, current: TripBrief): TripBriefProposal {
  const raw: Record<string, unknown> = {}
  for (const [external, internal] of Object.entries(FIELD_MAP)) {
    if (args[external] !== undefined) raw[internal] = args[external]
  }
  if (Object.keys(raw).length === 0) throw new ToolInputError('没有提供可审阅的旅行条件。')

  let parsed: Partial<TripBrief>
  try {
    parsed = sanitizeBrief(raw)
    validateBriefDates({ ...current, ...parsed })
  } catch (error) {
    throw new ToolInputError(error instanceof Error ? error.message : '旅行条件格式无效。')
  }

  const changes = Object.fromEntries(Object.entries(parsed).filter(([key, value]) =>
    current[key as keyof TripBrief] !== value
  )) as Partial<TripBrief>
  if (Object.keys(changes).length === 0) throw new ToolInputError('提取内容与当前旅行信息相同，无需生成变更提案。')

  const base = Object.fromEntries(Object.keys(changes).map((key) => [key, current[key as keyof TripBrief]])) as Partial<TripBrief>
  return { base, changes }
}

const FIELD_LABELS: Record<keyof TripBrief, string> = {
  departureCity: '出发地', destination: '目的地', startDate: '出发日期', endDate: '返程日期',
  arrivalFlight: '抵达航班', arrivalTime: '抵达时间', leaveTime: '离开时间', travelers: '同行人',
  budget: '预算', lodgingLocation: '具体住宿地点', lodging: '住宿区域与偏好', pace: '体力节奏', earlyStart: '是否早起', interests: '兴趣点',
  transport: '交通偏好', dietary: '忌口与饮食', luggage: '行李限制', clothing: '穿搭与已有衣物', constraints: '其他约束'
}
