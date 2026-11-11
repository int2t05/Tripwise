/** 控制目的地明确前的工具可见范围与执行权限。 */
import type { ItineraryMealSlot, ItineraryOption, PreparationCategory, TripBrief, TripBriefProposal } from '../shared/types.js'
import { parseBudgetPreference } from '../shared/budget.js'
import { mealSlotForBlock, mealSlotForStop } from '../shared/itinerary-schedule.js'
import type { ToolDefinition } from './connectors/types.js'

const UNKNOWN_DESTINATION = /^(?:未知|未定|待定|目的地待定|不确定|暂不确定|暂未确定|尚未确定|尚未决定|还没决定|还没想好|不知道(?:去哪|目的地)?|tbd|unknown)$/i
const DESTINATION_CLARIFICATION_REQUEST = /(?:确认|澄清|问清|弄清)[\s\S]{0,20}(?:具体(?:的)?(?:目的地|城市|地区|地点)|对应(?:的)?景区|(?:哪个|哪座)(?:城市|地区|地点|景区))|(?:目的地|城市|地区|地点)[\s\S]{0,20}(?:先确认|需要确认|待确认|不明确|不确定|有歧义)|(?:哪个|哪座|什么)(?:城市|地区)/u
const NEGATED_DESTINATION_CLARIFICATION = /(?:不需要|无需|不用|不必|不想|别|不要)(?:再|继续|先)?\s*(?:确认|澄清|问清|弄清)|(?:没有|不存在|无)(?:任何)?\s*(?:歧义|不确定|不明确)/u
const NEGATED_DESTINATION_PREFIX = /(?:不想去|不想|不愿意去|不愿去|不愿|不去|不再去|不再|不考虑去|不考虑|不要去|不要|别去|别|避免|排除|不选择|不选)$/u
const NEGATED_DESTINATION_PREFIX_EN = /(?:\bnot(?:\s+(?:going|go)\s+to)?|\b(?:do\s+not|don't|dont)\s+(?:want(?:\s+to)?|like|prefer)\s*(?:(?:go|going)\s+to)?|\b(?:avoid|exclude)(?:ing)?(?:\s+(?:going|go)\s+to)?)\s*$/i
const BUDGET_TERMS = /预算|费用|花费|花销|开销|成本|总价|总额|多少钱|价格/u
const BUDGET_ESTIMATE_REQUEST = /预算.{0,12}(?:估算|估计|测算|计算|金额|明细|多少|范围|上限|合计)|(?:估算|估计|测算|计算|汇总|合计).{0,12}(?:预算|费用|花费|花销|成本|总额)|(?:总预算|总费用|总花费|人均费用|人均花费|多少钱|费用多少|花费多少|价格多少|住宿价格|房价|票价|(?:给我|提供|列出).{0,5}预算)|(?:比较|对比).{0,24}(?:预算友好|省预算|省钱|经济).{0,20}(?:省时|省时间|更快|时间成本)|(?:比较|对比).{0,24}(?:省时|省时间|更快).{0,20}(?:预算|费用|成本)/u
const UNKNOWN_BUDGET_ITEMS_REQUEST = /(?:标出|列出|列明|注明|标记|汇总).{0,24}(?:未知|未查询|未核验|待核验).{0,8}(?:费用|开销|成本|价格|门票)|(?:未知|未查询|未核验|待核验).{0,8}(?:费用|开销|成本|价格|门票).{0,16}(?:标出|列出|列明|注明|标记|汇总)|(?:门票|交通).{0,12}(?:费用|成本).{0,12}(?:计入|计算|合计|未计入)|未计入.{0,8}(?:费用|成本|预算)?(?:项|类别)/u
const BUDGET_DECLINED = /(?:(?:本轮|这次|本次|现在|暂时|先)\s*)*(?:不需要|无需|不要|不用|不必|不想(?:要|看)?|不算|不做|不列|不提供|不估算|别)\s*(?:(?:再|帮我|替我|给我)\s*)?(?:(?:算|估算|列|计算|提供|生成|做|看)\s*)?(?:全程|旅行|行程)?\s*(?:总预算|预算|费用|花费|花销|开销|成本|总价|总额|价格|多少钱)|(?:总预算|预算|费用|花费|花销|开销|成本|总价|总额|价格|多少钱)\s*(?:(?:本轮|这次|本次|现在|暂时|先)\s*)*(?:不需要|无需|不要|不用|不必|不算|不做|不列|不提供|不估算|不想|别)/u
const DAILY_ITINERARY_DETAILS = /(?:每(?:天|日|个时段)|每天|每日|逐日|按天|按日)[^。！？；;\n]{0,48}(?:景点|地点|游玩|参观|停留|交通|时段|路线)|(?:景点|地点|游玩|参观|交通).{0,32}(?:每天|每日|逐日|按天|按日|分日)/u
const PLAN_DRAFT_TERMS = /(?:初稿|草案|完整|方案|规划|安排|计划|路线|行程|日程)/u
const PLAN_ACTION_TERMS = /(?:规划|安排|生成|制定|给我|帮我|整理|列出|调整|修改|改成|更换|替换|优化)/u
/** 多日时长与游览/路线词同时出现时，识别不使用“行程”一词的规划请求。 */
const MULTI_DAY_PLAN_TERMS = /(?:[零〇一二三四五六七八九十两\d]+(?:天|日))[^。！？；;\n]{0,14}(?:行程|路线|旅游|旅行|游玩|慢游|自由行|区域顺序|方案|草案|计划)/u
/** 只要求澄清且明确暂不生成计划时，避免误触发结构化行程提案。 */
const CLARIFICATION_ONLY_REQUEST = /(?:只|仅)(?:先)?(?:问|询问|澄清|确认)[^。！？；;\n]{0,36}(?:问题|条件|信息)|先只(?:问|询问|澄清|确认)/u
const ITINERARY_OUTPUT_DECLINED = /(?:先)?(?:不要|暂不|先不|不必|无需)(?:直接)?(?:生成|输出|规划|安排)[^。！？；;\n]{0,18}(?:完整)?(?:行程|路线|计划|方案|日程)/u
const ITINERARY_EDIT_SUBJECT = String.raw`行程|路线|方案|安排|第.{0,3}天|当天|这天|这一天|景点|地点|停留|步行|交通|餐次|时段`
const ITINERARY_EDIT_ACTION = String.raw`调整|调|修改|更改|改为|改成|改|换成|换|替换|删除|删掉|去掉|取消|移除|缩短|压缩|减少|少安排|少走|增加|添加|延长|提前|推迟|保留|放轻松|轻松点|轻松|放慢|多休息`
const ITINERARY_MODIFICATION_PATTERNS = [
  new RegExp(String.raw`(?:把|将)[^。！？；;\n]{0,36}(?:${ITINERARY_EDIT_SUBJECT})[^。！？；;\n]{0,18}(?:${ITINERARY_EDIT_ACTION})`, 'u'),
  new RegExp(String.raw`(?:${ITINERARY_EDIT_ACTION})[^。！？；;\n]{0,20}(?:${ITINERARY_EDIT_SUBJECT}|休息)`, 'u'),
  /(?:再|继续)?\s*(?:修改|调整|优化|修订)(?:一下|这份(?:行程|方案|路线)|当前(?:行程|方案|路线))/u
]
const DIRECT_ITINERARY_REPLACEMENT = /(?:把|将)[^。！？；;\n]{1,24}(?:换成|替换成|替换为|移到|移动到|挪到|加到|加上|添加到|加入|排到|安排到|删掉|去掉|取消|保留|缩短|减少|延长|提前|推迟|放轻松|改轻松)/u
const TRIP_BRIEF_FIELD_CHANGE = /(?:出发地|出发城市|出发日期|返程日期|目的地|预算|人数|住宿|早起|体力|忌口|饮食|行李|穿搭|航班|交通偏好|旅行信息|旅行简报)/u
const ITINERARY_SCOPE = /(?:行程|路线|方案|日程|景点|地点|景区|第.{0,3}天|当天|这天|这一天|停留|步行|接驳|餐次|餐馆|时段)/u
const NAMED_MEAL_REQUIREMENT = /(?:具体店名|具体店面|具体店铺|具体餐馆|每餐.{0,20}店|三餐.{0,20}店)/u
const NAMED_MEAL_REQUIREMENT_DECLINED = /(?:不需要|无需|不用|不必|不要求|暂不|先不|不要)(?:再)?\s*(?:提供|列出|安排|搜索|查找)?\s*(?:具体)?(?:店名|店面|店铺|餐馆)|(?:具体店名|具体店面|具体店铺|具体餐馆).{0,8}(?:不需要|无需|不用|不必|不要求|不要)/u
/** 常见中文天数表达，避免“北京两日游”被遗漏为行程请求。 */
const DAY_TRIP_TERMS = /(?:一日游|[零〇一二三四五六七八九十两\d]+日游)/u
const EXTERNAL_RESEARCH_DECLINED = /(?:不(?:再)?(?:调用|使用|做|进行|查|搜|检索|查询)|不要(?:再)?(?:调用|使用|做|进行|查|搜|检索|查询)|不用(?:再)?(?:调用|搜索|检索|查询)|不需要(?:再)?(?:调用|搜索|检索|查询)|无需(?:再)?(?:调用|搜索|检索|查询)|不必(?:再)?(?:调用|搜索|检索|查询)|别(?:再)?(?:用|调用|查|搜|检索|查询)|跳过(?:本轮|本次|这次)?(?:搜索|检索|查询))\s*(?:本轮|本次|这次|任何|外部|联网|网页|新的|旅行)?\s*(?:外部)?\s*(?:工具|服务|搜索|检索|查询|天气|地图|小红书|路线|网页资料|网页信息)/u
const LOCAL_PROPOSAL_TOOLS = new Set(['propose_trip_brief', 'propose_itineraries', 'propose_itinerary_meals', 'propose_preparation'])

/** 只有用户明确写出的目的地才可借待审提案开启外部地点检索。 */
export function hasExplicitDestinationMention(userText: string, destination: string): boolean {
  const candidate = normalizeDestinationText(destination)
  const text = userText.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ')
  if (candidate.length < 2) return false

  let index = text.indexOf(candidate)
  while (index >= 0) {
    const prefix = text.slice(Math.max(0, index - 48), index).trim().replace(/[\s，。！？、,.!?;；:：]+$/u, '')
    const compactPrefix = prefix.replace(/[\s\p{P}\p{S}]/gu, '')
    if (!NEGATED_DESTINATION_PREFIX.test(compactPrefix) && !NEGATED_DESTINATION_PREFIX_EN.test(prefix)) return true
    index = text.indexOf(candidate, index + candidate.length)
  }
  return false
}

/** 用户本轮明确要求先消歧时，即使简报已有地名也暂不授权外部旅行查询。 */
export function requiresDestinationClarification(userText: string): boolean {
  const clauses = userText.normalize('NFKC').replace(/\s+/gu, ' ').split(/[，,。！？!?；;]|但是|然而|不过|但/gu)
  return clauses.some((clause) =>
    DESTINATION_CLARIFICATION_REQUEST.test(clause) && !NEGATED_DESTINATION_CLARIFICATION.test(clause)
  )
}

/** 合并待审提案时，拒绝以模型自行猜出的城市解锁旅行检索。 */
export function hasPlanningDestination(
  brief: TripBrief,
  proposal?: TripBriefProposal,
  userText = '',
  latestUserText = userText
): boolean {
  if (requiresDestinationClarification(latestUserText)) return false

  const proposedDestination = proposal && Object.hasOwn(proposal.changes, 'destination')
    ? proposal.changes.destination
    : undefined
  const destination = proposal && Object.hasOwn(proposal.changes, 'destination')
    ? proposedDestination
    : brief.destination
  const normalized = typeof destination === 'string' ? destination.trim() : ''
  if (!normalized || UNKNOWN_DESTINATION.test(normalized)) return false
  return proposedDestination === undefined || hasExplicitDestinationMention(userText, proposedDestination)
}

/** 目的地未明时仅向模型公开旅行信息提案工具，让模型先收集或澄清目的地。 */
export function toolsForPlanningDestination(tools: ToolDefinition[], destinationReady: boolean): ToolDefinition[] {
  return destinationReady
    ? tools
    : tools.filter((tool) => tool.function.name === 'propose_trip_brief')
}

/** 用户明确跳过外部查询时，只向模型开放本地提案工具。 */
export function userDeclinedExternalResearch(userText: string): boolean {
  const noResearchInCurrentRun = /(?:本轮|本次|这次)(?:先|暂时)?\s*(?:不需要|不必|无需|不用|不要|别|不)\s*(?:再)?\s*(?:调用|使用|进行|搜索|检索|查询|查|搜)?\s*(?:任何|外部)?\s*(?:工具|服务|搜索|检索|查询|天气|地图|小红书|路线|网页资料|网页信息)/u
  return userText.normalize('NFKC').split(/[。！？；;\n]/u).some((clause) =>
    EXTERNAL_RESEARCH_DECLINED.test(clause) || noResearchInCurrentRun.test(clause)
  )
}

/** 按用户本轮意图限制工具，避免未请求行程时模型擅自提交整份计划。 */
export function toolsForRequestIntent(tools: ToolDefinition[], userText: string): ToolDefinition[] {
  const intentTools = requiresItineraryOutput(userText)
    ? tools
    : tools.filter((tool) => tool.function.name !== 'propose_itineraries')
  if (!userDeclinedExternalResearch(userText)) return intentTools

  const allowed = new Set<string>()
  if (requiresItineraryOutput(userText) || DAY_TRIP_TERMS.test(userText) || /停靠点/u.test(userText)) {
    allowed.add('propose_itineraries')
    if (requiresNamedMealStops(userText)) allowed.add('propose_itinerary_meals')
  }
  if (requiresPreparationOutput(userText) || /餐厅/u.test(userText)) {
    allowed.add('propose_preparation')
  }
  if (/(?:补充|更新|修改|调整|改为|改成).{0,15}(?:目的地|城市|日期|天数|预算|人数|住宿|体力|偏好|忌口|出发)/u.test(userText)) {
    allowed.add('propose_trip_brief')
  }
  return intentTools.filter((tool) => allowed.has(tool.function.name))
}

/** 统一识别需要独立准备事项的请求，确保 Agent 追问与工具路由使用同一规则。 */
export function requiresPreparationOutput(text: string): boolean {
  const normalized = text.normalize('NFKC')
  return /(?:穿搭(?:方案|建议|清单)?|行李(?:清单|建议)|打包(?:清单|建议)|预约(?:清单|安排|提醒|信息|事项)|美食推荐|餐饮清单|备选(?:方案|预案|安排|活动)|应急预案|行前清单|准备清单)/u.test(normalized) ||
    /(?:交通|换乘|接驳).{0,8}(?:清单|提醒|准备|核对)|(?:清单|提醒|准备|核对).{0,8}(?:交通|换乘|接驳)/u.test(normalized) ||
    /(?:下雨|雨天|降雨|天气|延误|体力不足).{0,12}(?:总?预案|备选(?:方案|预案))|(?:总?预案|备选(?:方案|预案)).{0,12}(?:下雨|雨天|降雨|天气|延误|体力不足)/u.test(normalized)
}

/** 提取用户明确要求的准备类别，供结构化清单提交前校验覆盖情况。 */
export function requiredPreparationCategoriesForRequest(text: string): PreparationCategory[] {
  const normalized = text.normalize('NFKC')
  const categoryTerms: Array<[PreparationCategory, RegExp]> = [
    ['clothing', /穿搭|穿衣|着装|穿什么|保暖建议|衣物清单/u],
    ['packing', /行李|打包|收纳/u],
    ['booking', /预约|购票|抢票|门票/u],
    ['transport', /公共交通|交通方式|交通安排|交通接驳|交通准备|交通清单|交通提醒|交通核对|公交|地铁|换乘|接驳|机场进城|通勤|城际交通/u],
    ['alternative', /备选|预案|下雨|雨天|降雨|人流|客流|拥堵|延误|排队|天气变化|体力不足/u]
  ]
  const negation = /(?:不需要|无需|不要|不用|不必|暂不|先不|暂时不)[^，,。；;]{0,8}$|^\s*(?:不需要|无需|不要|不用|不必|暂不|先不|暂时不)/u
  const clauses = normalized.split(/[，,。！？；;\n]/u)
  return categoryTerms.flatMap(([category, terms]) => {
    const requested = clauses.some((clause) => [...clause.matchAll(new RegExp(terms.source, 'gu'))]
      .some((match) => {
        const index = match.index ?? 0
        const end = index + match[0].length
        return !negation.test(clause.slice(Math.max(0, index - 12), index)) &&
          !negation.test(clause.slice(end, end + 12))
      }))
    return requested ? [category] : []
  })
}

/** 识别用户是否明确要求实际餐馆名称。 */
function requiresNamedMealStops(text: string): boolean {
  return /(?:具体店名|具体店面|具体店铺|具体餐馆|每餐.{0,20}店|三餐.{0,20}店)/u.test(text.normalize('NFKC'))
}

/** 区分行程修订与只改旅行简报字段的请求。 */
function isItineraryModificationRequest(text: string): boolean {
  const editsOnlyTripBrief = TRIP_BRIEF_FIELD_CHANGE.test(text) && !ITINERARY_SCOPE.test(text)
  return !editsOnlyTripBrief && (
    ITINERARY_MODIFICATION_PATTERNS.some((pattern) => pattern.test(text)) || DIRECT_ITINERARY_REPLACEMENT.test(text)
  )
}

/** 识别明确的逐日景点/时段/交通安排，兼容不使用“行程”一词的自然表达。 */
export function requiresItineraryOutput(text: string): boolean {
  const normalized = text.normalize('NFKC')
  if (CLARIFICATION_ONLY_REQUEST.test(normalized) && ITINERARY_OUTPUT_DECLINED.test(normalized)) return false
  if (isItineraryModificationRequest(normalized)) return true
  const requestClauses = normalized.split(/[，,。！？；;]|但是|然而|不过|之后|随后/gu)
  const declinedClauseIndex = requestClauses.findIndex((clause) => ITINERARY_OUTPUT_DECLINED.test(clause))
  if (declinedClauseIndex >= 0) {
    const remainingRequest = requestClauses.slice(declinedClauseIndex + 1).join(' ')
    if (!PLAN_ACTION_TERMS.test(remainingRequest) || !PLAN_DRAFT_TERMS.test(remainingRequest)) return false
  }
  if (requestsAirportTransit(normalized) && PLAN_ACTION_TERMS.test(normalized)) return true
  if (/(?:行程|日程|出行计划|出游计划|旅行计划|旅游计划|旅行方案|旅游方案|旅游安排|旅行安排|旅游规划|旅行规划|路线|路书|完整方案|一套方案)/u.test(normalized) &&
    PLAN_ACTION_TERMS.test(normalized)) return true
  if (/(?:机场到住宿|机场进城|交通方案|接驳方案)/u.test(normalized) && PLAN_ACTION_TERMS.test(normalized)) return true
  if (DAY_TRIP_TERMS.test(normalized) && PLAN_ACTION_TERMS.test(normalized)) return true
  if (MULTI_DAY_PLAN_TERMS.test(normalized) && PLAN_ACTION_TERMS.test(normalized)) return true
  return DAILY_ITINERARY_DETAILS.test(normalized) && PLAN_ACTION_TERMS.test(normalized) &&
    PLAN_DRAFT_TERMS.test(normalized)
}

/** 识别机场抵达与进城接驳的组合请求，供行程路由和交通检索共用。 */
export function requestsAirportTransit(text: string): boolean {
  const normalized = text.normalize('NFKC')
  const airportMentioned = /机场|航站楼/u.test(normalized)
  const arrivalOrDestinationMentioned = /落地|抵达|到达|进城|市区|酒店|住宿/u.test(normalized)
  const transitMentioned = /交通|接驳|线路|路线|通勤|地铁|机场线|进城/u.test(normalized)
  return airportMentioned && arrivalOrDestinationMentioned && transitMentioned
}

/** 识别用户明确要求逐时段、换乘和景点执行细节的规划请求。 */
export function requestsDetailedItinerary(text: string): boolean {
  const normalized = text.normalize('NFKC')
  const explicitDetail = /具体到.{0,8}(?:交通|通行)方式|(?:逐日)?按.{0,24}(?:时段|时间段).{0,8}(?:安排|编排)|每(?:个|段).{0,12}(?:景点|停靠点|接驳|交通|换乘).{0,20}(?:时段|时刻|停留|路线|方式|目的地|写明|注明|说明)/u.test(normalized)
  const photographySchedule = /(?:拍摄|摄影).{0,8}(?:时段|时间)/u.test(normalized)
  const transitBuffer = /(?:交通|接驳|换乘).{0,8}(?:缓冲|预留)(?:时间|时段|安排)?/u.test(normalized)
  return explicitDetail || photographySchedule || transitBuffer || /(?:详细|具体到|逐时段|按时段|分时段|每个时段|时段安排|通行方式|交通接驳|换乘安排|入口.{0,8}出口|开放时间限制|闭馆提醒|缓冲时间|预留时间).{0,24}(?:行程|路线|安排|交通|时段|景点|游玩|通勤)?|(?:行程|路线|交通|时段).{0,18}(?:详细|具体到|逐时段|按时段|换乘|接驳|入口|出口|开放时间|闭馆|缓冲|预留)/u.test(normalized)
}

/** 详细初稿和所有基于现有行程的修订都要复核路线；未改日期由调用方保护。 */
export function shouldEnrichItineraryRoutes(text: string, hasRevisionBaseline: boolean): boolean {
  return requiresItineraryOutput(text) && (hasRevisionBaseline || requestsDetailedItinerary(text))
}

/** 识别用户明确要求核对景点营业、夜间开放或灯光时段。 */
export function requestsOpeningHoursDetails(text: string): boolean {
  const normalized = text.normalize('NFKC')
  return /开放时间|开放时段|闭馆|停止入园|营业时间|开园时间|停止售票|(?:夜间|夜场|晚间|晚上).{0,6}(?:开放|营业|关门|闭园|亮灯|灯光)|(?:亮灯|开灯|关灯|灯饰|景观照明).{0,8}(?:时间|时段|何时|几点)|(?:开放|营业).{0,6}(?:时间|时段|情况|状态)/u.test(normalized)
}

/** 识别具体预约、购票规则，不把普通的预约准备事项当成逐站核验要求。 */
export function requestsBookingDetails(text: string): boolean {
  return /是否需要预约|预约规则|预约渠道|预约场次|预约时间|预约入口|预约截止|预约方式|门票预约|抢票时间|购票方式/u.test(text.normalize('NFKC'))
}

/** 用户提及预约或售票情形时，在方案答复中说明应用不代办。 */
export function mentionsBookingWorkflow(text: string): boolean {
  return /预约|预订|订票|购票|抢票|约满|余票|售罄/u.test(text.normalize('NFKC'))
}

/** 将票价查询与预约方式分开识别，确保两类事实都能准确标记。 */
export function requestsTicketPriceDetails(text: string): boolean {
  return /票价|门票(?:价格|费用|多少钱|金额)|门票多少钱/u.test(text.normalize('NFKC'))
}

/** 修订继承基线的逐站事实要求，避免只改时间或餐馆时遗漏仍保留景点的核验状态。 */
export function requestedItineraryFactDetails(text: string, baseline?: ItineraryOption): {
  openingHours: boolean
  booking: boolean
  ticketPrice: boolean
} {
  if (!requiresItineraryOutput(text)) return { openingHours: false, booking: false, ticketPrice: false }
  const types = new Set(baseline?.days.flatMap((day) => day.stops.flatMap((stop) =>
    (stop.factClaims ?? []).map((claim) => claim.type))) ?? [])
  return {
    openingHours: requestsOpeningHoursDetails(text) || types.has('opening-hours') || types.has('closure'),
    booking: requestsBookingDetails(text) || types.has('booking'),
    ticketPrice: requestsTicketPriceDetails(text) || types.has('ticket-price')
  }
}

/** 识别用户要求为天气、客流或交通变化准备当日调整方案。 */
export function requestsItineraryContingencies(text: string): boolean {
  return /备选|预案|下雨|雨天|降雨|人流|客流|拥堵|延误|排队|天气变化|体力不足/u.test(text.normalize('NFKC')) ||
    requestsBookingAlternative(text)
}

/** 只在用户要求逐日天气信息时，在每一天的行程卡中加入来源状态。 */
export function requestsDailyWeather(text: string): boolean {
  const normalized = text.normalize('NFKC')
  if (declinesDailyWeather(normalized)) return false
  return /(?:逐日|每日|每天|每一天).{0,8}(?:天气|气温|温度)|(?:天气|气温|温度).{0,8}(?:逐日|每日|每天|每一天)|天气预报|天气数据|(?:查询|查看|获取|提供).{0,8}(?:天气|气温|温度)/u.test(normalized)
}

/** 用户明确撤回逐日天气要求时，后续轮次不再强制保留该字段。 */
function declinesDailyWeather(text: string): boolean {
  const declinedBeforeWeather = /(?:不需要|无需|不要|不用|不必|暂不|先不|不想)\s*(?:(?:再|继续)\s*)?(?:查询|查|搜索|搜|检索|调用|使用|查看|获取|提供|看|预报)?\s*(?:(?:逐日|每日|每天|每一天)\s*)?(?:的\s*)?(?:天气|气温|温度)/u
  const declinedAfterWeather = /(?:(?:逐日|每日|每天|每一天)\s*)?(?:天气|气温|温度)\s*(?:不需要|无需|不用|不必|暂不|先不)\s*(?:(?:再|继续)\s*)?(?:查询|查|搜索|搜|检索|调用|使用|查看|获取|提供|看)?/u
  return declinedBeforeWeather.test(text) || declinedAfterWeather.test(text)
}

/** 逐日天气要求在同一旅行对话中延续，只有用户明确撤回才关闭。 */
export function dailyWeatherRequestedForConversation(userMessages: string[]): boolean {
  let requested = false
  for (const message of userMessages) {
    const normalized = message.normalize('NFKC')
    if (declinesDailyWeather(normalized)) requested = false
    else if (requestsDailyWeather(normalized)) requested = true
  }
  return requested
}

/** 识别“每天一个就近室内雨天活动”，避免将普通雨天提醒误作必需场地。 */
export function requestsDailyIndoorRainAlternatives(text: string): boolean {
  const normalized = text.normalize('NFKC')
  if (declinesDailyIndoorRainAlternatives(normalized)) return false
  const everyDay = /(?:每天|每日|每一天|逐日|每个游览日)/u.test(normalized)
  const rain = /(?:下雨|雨天|降雨)/u.test(normalized)
  const indoor = /室内/u.test(normalized)
  const alternative = /(?:替代|备选|替换|活动|去处)/u.test(normalized)
  return everyDay && rain && indoor && alternative
}

/** 用户明确撤回逐日室内雨天替代要求时关闭后续轮次的结构校验。 */
function declinesDailyIndoorRainAlternatives(text: string): boolean {
  const decline = /(?:不需要|无需|不要|不用|不必|暂不|先不|取消|去掉)/u
  const subject = /(?:雨天|下雨|降雨|室内)/u
  const output = /(?:备选|替代|替换|活动|去处)/u
  const clauses = text.split(/[。！？；;\n]/u)
  return clauses.some((clause) => {
    if (!decline.test(clause)) return false
    const subjectIndex = clause.search(subject)
    const outputIndex = clause.search(output)
    return subjectIndex >= 0 && outputIndex >= 0 && Math.abs(outputIndex - subjectIndex) <= 40
  })
}

/** 逐日室内雨天替代要求持续到用户明确撤回，保证局部修订保留原约束。 */
export function dailyIndoorRainAlternativesRequestedForConversation(userMessages: string[]): boolean {
  let requested = false
  for (const message of userMessages) {
    const normalized = message.normalize('NFKC')
    if (declinesDailyIndoorRainAlternatives(normalized)) requested = false
    else if (requestsDailyIndoorRainAlternatives(normalized)) requested = true
  }
  return requested
}

/** 只在预约失败情形明确要求替换时要求结构化条件备选。 */
export function requestsBookingAlternative(text: string): boolean {
  const normalized = text.normalize('NFKC')
  const unavailable = /约满|预约失败|预约不上|约不到|没约到|没有约到|无法预约|不能预约|售罄|无余票|没有余票|抢不到|订不到|买不到/u
  const replacement = /备选|替代|替换|换成|改游|改去/u
  return unavailable.test(normalized) && replacement.test(normalized)
}

/** 只有用户明确修改旅行简报字段时才向模型开放简报提案工具。 */
export function requestsTripBriefUpdate(userText: string): boolean {
  return /(?:补充|更新|修改|更改|调整|改成|改为|换成|删掉|取消).{0,20}(?:出发地|出发城市|目的地|日期|天数|预算|人数|住宿|体力|早起|忌口|行李|穿搭|航班|交通偏好|旅行信息|简报|不吃|不喝|过敏|素食|清真)|(?:出发地|出发城市|目的地|日期|天数|预算|人数|住宿|体力|忌口|行李|穿搭|航班|交通偏好).{0,16}(?:改成|改为|换成|更新为|调整为|修改为)/u.test(userText)
}

/** 执行边界再次检查本地提案以外的工具，防止恢复旧调用时触发外部查询。 */
export function canExecuteWithoutExternalResearch(toolName: string): boolean {
  return LOCAL_PROPOSAL_TOOLS.has(toolName)
}

/** 执行边界默认要求目的地，避免旧恢复记录或模型越权调用绕过工具列表。 */
export function canExecuteWithoutDestination(toolName: string): boolean {
  return toolName === 'propose_trip_brief'
}

/** 只有用户明确询问费用或给出金额时才要求估算；定性预算只作筛选偏好。 */
export function shouldRequestBudgetEstimate(budgetPreference: string, userMessages: string[]): boolean {
  for (const message of [...userMessages].reverse()) {
    const normalized = message.normalize('NFKC')
    if (BUDGET_DECLINED.test(normalized)) return false
    if (BUDGET_ESTIMATE_REQUEST.test(normalized) || UNKNOWN_BUDGET_ITEMS_REQUEST.test(normalized)) return true
    if (BUDGET_TERMS.test(normalized) && parseBudgetPreference(normalized, '').kind !== 'qualitative') return true
  }
  const preference = parseBudgetPreference(budgetPreference, '')
  return preference.kind === 'trip-total' || preference.kind === 'per-person' || preference.kind === 'per-day' || preference.kind === 'ambiguous'
}

/** 从明确写出的月日和餐次生成校验要求，不替用户推断未提到的餐食。 */
export function requiredMealSlotsForRequest(
  userText: string,
  startDate: string,
  endDate: string
): MealSlotRequirement[] | undefined {
  const text = userText.normalize('NFKC').replace(/[–—−]/gu, '-')
  const startBoundary = parseCalendarDate(startDate)
  const endBoundary = parseCalendarDate(endDate)
  const year = startBoundary?.getUTCFullYear() ?? endBoundary?.getUTCFullYear() ?? new Date().getUTCFullYear()
  const required = new Map<string, Set<'breakfast' | 'lunch' | 'dinner'>>()
  const excluded = new Map<string, Set<'breakfast' | 'lunch' | 'dinner'>>()
  const exclusiveMealDates = new Set<string>()
  const coveredRanges: Array<[number, number]> = []
  const applyMealChanges = (date: string, clause: string): boolean => {
    const changes = mealChangesInText(clause)
    if (!changes.slots.length && !changes.excludedSlots.length) return false
    addMealChanges(required, excluded, date, changes, startBoundary, endBoundary)
    return true
  }

  const datePart = String.raw`(\d{1,2})(?:月|\/|\.)\s*(\d{1,2})(?:日|号)?`
  const dateRangePattern = new RegExp(`${datePart}\\s*(?:-|至|到)\\s*(?:(\\d{1,2})(?:月|\\/|\\.)\\s*)?(\\d{1,2})(?:日|号)?`, 'gu')
  const dateMentionPattern = /(\d{1,2})(?:月|\/|\.)\s*(\d{1,2})(?:日|号)?/gu

  for (const match of text.matchAll(dateRangePattern)) {
    const index = match.index ?? 0
    const endIndex = index + match[0].length
    const trailingText = text.slice(endIndex)
    const nextDate = trailingText.match(/\d{1,2}(?:月|\/|\.)\s*\d{1,2}(?:日|号)?/u)?.index
    const clauseText = trailingText.slice(0, nextDate ?? trailingText.length)
    const endOfClause = clauseText.search(/[，,。；;\n]/u)
    const clause = clauseText.slice(0, endOfClause < 0 ? clauseText.length : endOfClause)
    const start = dateFromMonthDay(year, Number(match[1]), Number(match[2]), startBoundary)
    const end = dateFromMonthDay(year, Number(match[3] ?? match[1]), Number(match[4]), startBoundary)
    if (!start || !end || end < start || !mealChangesInText(clause).slots.length && !mealChangesInText(clause).excludedSlots.length) continue
    coveredRanges.push([index, endIndex])
    for (let day = start; day <= end; day = new Date(day.getTime() + 24 * 60 * 60 * 1_000)) {
      const date = day.toISOString().slice(0, 10)
      applyMealChanges(date, clause)
      if (hasExclusiveMealLimit(clause)) exclusiveMealDates.add(date)
    }
  }

  const dateMentions = [...text.matchAll(dateMentionPattern)]
  for (const [mentionIndex, match] of dateMentions.entries()) {
    const index = match.index ?? 0
    if (coveredRanges.some(([start, end]) => index >= start && index < end)) continue
    const nextDateIndex = dateMentions[mentionIndex + 1]?.index ?? text.length
    const clauseText = text.slice(index, nextDateIndex)
    const endOfClause = clauseText.search(/[，,。；;\n]/u)
    const clause = clauseText.slice(0, endOfClause < 0 ? clauseText.length : endOfClause)
    const date = dateFromMonthDay(year, Number(match[1]), Number(match[2]), startBoundary)
    if (date && applyMealChanges(date.toISOString().slice(0, 10), clause)) {
      const key = date.toISOString().slice(0, 10)
      if (hasExclusiveMealLimit(clause)) exclusiveMealDates.add(key)
    }
  }

  const allMealsRequested = /三餐|早餐.{0,24}(?:午餐|午饭).{0,24}(?:晚餐|晚饭)/u.test(text)
  const allDaysMealsRequested = /(?:每天|每日)[^。；;\n]{0,24}(?:三餐|早餐.{0,24}(?:午餐|午饭).{0,24}(?:晚餐|晚饭))/u.test(text)
  const otherFullDaysRequested = /(?:其他|其余|剩余)(?:的)?[^。；;\n]{0,16}(?:全天|全日|完整(?:游览)?日|游览日)[^。；;\n]{0,32}(?:三餐|早餐.{0,24}(?:午餐|午饭).{0,24}(?:晚餐|晚饭))/u.test(text)
  const hasPartialBoundaryMeals = startDate !== endDate && required.has(startDate) && required.has(endDate) &&
    ((required.get(startDate)?.size ?? 0) < 3 || (required.get(endDate)?.size ?? 0) < 3)
  // “三餐具体店面”配合抵达日、离开日的局部餐次，表示完整游览日也需要三餐。
  const fullTripMealRequest = otherFullDaysRequested || allDaysMealsRequested || startDate === endDate || hasPartialBoundaryMeals
  if (allMealsRequested && fullTripMealRequest && startBoundary && endBoundary && endBoundary >= startBoundary) {
    const everyMeal: Array<'breakfast' | 'lunch' | 'dinner'> = ['breakfast', 'lunch', 'dinner']
    for (let day = new Date(startBoundary); day <= endBoundary; day = new Date(day.getTime() + 24 * 60 * 60 * 1_000)) {
      const date = day.toISOString().slice(0, 10)
      const isTripBoundary = date === startDate || date === endDate
      if (otherFullDaysRequested && isTripBoundary) continue
      if (!otherFullDaysRequested && (required.get(date)?.size ?? 0) > 0) continue
      addMealSlots(required, date, everyMeal, startBoundary, endBoundary)
      if (otherFullDaysRequested || allDaysMealsRequested || hasPartialBoundaryMeals) exclusiveMealDates.add(date)
    }
  }

  if (required.size === 0 && excluded.size === 0) return undefined
  const slotOrder = ['breakfast', 'lunch', 'dinner'] as const
  const dates = [...new Set([...required.keys(), ...excluded.keys()])].sort()
  return dates.map((date) => {
    const slots = required.get(date) ?? new Set()
    const excludedSlots = excluded.get(date) ?? new Set()
    return {
    date,
    slots: slotOrder.filter((slot) => slots.has(slot) && !excludedSlots.has(slot)),
    ...(excludedSlots.size ? { excludedSlots: slotOrder.filter((slot) => excludedSlots.has(slot)) } : {}),
    ...(exclusiveMealDates.has(date) ? { exclusive: true } : {})
    }
  })
}

export type MealSlotRequirement = {
  date: string
  slots: Array<'breakfast' | 'lunch' | 'dinner'>
  excludedSlots?: Array<'breakfast' | 'lunch' | 'dinner'>
  exclusive?: boolean
}

/** 将旅行简报与用户历轮原话按时间顺序合并，局部修改不会丢失其他日期餐次。 */
export function requiredMealSlotsForConversation(
  userMessages: string[],
  startDate: string,
  endDate: string,
  briefConstraints = ''
): MealSlotRequirement[] | undefined {
  const byDate = new Map<string, MealSlotRequirement>()
  for (const text of [briefConstraints, ...userMessages]) {
    for (const requirement of requiredMealSlotsForRequest(text, startDate, endDate) ?? []) {
      const previous = byDate.get(requirement.date)
      if (!previous || requirement.exclusive) {
        byDate.set(requirement.date, requirement)
        continue
      }

      const slots = new Set(previous.slots)
      const excludedSlots = new Set(previous.excludedSlots ?? [])
      requirement.slots.forEach((slot) => {
        slots.add(slot)
        excludedSlots.delete(slot)
      })
      requirement.excludedSlots?.forEach((slot) => {
        slots.delete(slot)
        excludedSlots.add(slot)
      })
      const mealOrder = ['breakfast', 'lunch', 'dinner'] as const
      byDate.set(requirement.date, {
        date: requirement.date,
        slots: mealOrder.filter((slot) => slots.has(slot)),
        ...(excludedSlots.size ? { excludedSlots: mealOrder.filter((slot) => excludedSlots.has(slot)) } : {}),
        ...(previous.exclusive ? { exclusive: true } : {})
      })
    }
  }
  return byDate.size ? [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date)) : undefined
}

/** 延续用户既有的具体店面要求，允许后续消息明确撤回后再停止补查。 */
export function namedMealStopsRequestedForConversation(userMessages: string[], briefConstraints = ''): boolean {
  let requested = false
  for (const text of [briefConstraints, ...userMessages]) {
    const normalized = text.normalize('NFKC')
    if (NAMED_MEAL_REQUIREMENT_DECLINED.test(normalized)) requested = false
    else if (NAMED_MEAL_REQUIREMENT.test(normalized)) requested = true
  }
  return requested
}

/** 明确的一餐/两餐或“只安排”表达表示该日不可补入额外餐次。 */
function hasExclusiveMealLimit(text: string): boolean {
  return /(?:只|仅|最多|至多)[^。；;\n]{0,12}(?:一餐|两餐|二餐|早餐|早饭|午餐|午饭|晚餐|晚饭)|(?:可以吃|可吃|安排|吃)\s*(?:一|两|二)餐|(?:三餐|早餐.{0,24}(?:午餐|午饭).{0,24}(?:晚餐|晚饭))/u.test(text) ||
    /(?:改成|改为|换成)\s*(?:早餐|早饭|午餐|午饭|晚餐|晚饭)/u.test(text)
}

/** 按文本顺序解析餐次增删；列表中的后续餐次继承当前明确的否定表达。 */
function mealChangesInText(text: string): {
  slots: Array<'breakfast' | 'lunch' | 'dinner'>
  excludedSlots: Array<'breakfast' | 'lunch' | 'dinner'>
} {
  type MealSlot = 'breakfast' | 'lunch' | 'dinner'
  const changes = new Map<MealSlot, boolean>()
  const mentions: Array<{ index: number; length: number; slots: MealSlot[] }> = []
  const patterns: Array<{ slot: MealSlot; expression: RegExp }> = [
    { slot: 'breakfast', expression: /早餐|早饭|早上/gu },
    { slot: 'lunch', expression: /午餐|午饭|中午/gu },
    { slot: 'dinner', expression: /晚餐|晚饭|晚上|晚间|晚(?=安排|可以|可|只|吃|有|$)/gu }
  ]
  mentions.push(...patterns.flatMap(({ slot, expression }) => [...text.matchAll(expression)].map((match) => ({
    index: match.index ?? 0,
    length: match[0].length,
    slots: [slot]
  }))))
  for (const match of text.matchAll(/三餐/gu)) {
    mentions.push({ index: match.index ?? 0, length: match[0].length, slots: ['breakfast', 'lunch', 'dinner'] })
  }
  mentions.sort((left, right) => left.index - right.index)
  for (const mention of mentions) {
    const included = !isMealMentionNegated(text, mention.index, mention.length)
    mention.slots.forEach((slot) => changes.set(slot, included))
  }
  return {
    slots: [...changes].filter(([, included]) => included).map(([slot]) => slot),
    excludedSlots: [...changes].filter(([, included]) => !included).map(([slot]) => slot)
  }
}

/** 只将紧邻餐次的明确否定解析为取消，避免把“不要早起”误判为取消早餐。 */
function isMealMentionNegated(text: string, index: number, length: number): boolean {
  const clauseStart = Math.max(
    text.lastIndexOf('，', index), text.lastIndexOf(',', index), text.lastIndexOf('。', index),
    text.lastIndexOf('；', index), text.lastIndexOf(';', index),
    ...['但是', '不过', '但', '改成', '改为', '换成', '而是'].map((word) => text.lastIndexOf(word, index - 1))
  ) + 1
  const prefix = text.slice(clauseStart, index)
  const negativePatterns = [
    /不安排\s*$/u, /不用(?:安排)?\s*$/u, /不需要(?:安排)?\s*$/u,
    /不必(?:安排)?\s*$/u, /无需(?:安排)?\s*$/u, /不要(?:安排)?\s*$/u,
    /别(?:安排)?\s*$/u, /取消\s*$/u, /去掉\s*$/u, /删掉\s*$/u, /删除\s*$/u,
    /排除\s*$/u, /不含\s*$/u, /不包括\s*$/u, /跳过\s*$/u, /不吃\s*$/u,
    /不想(?:吃|安排)?\s*$/u
  ]
  const negative = negativePatterns.find((pattern) => pattern.test(prefix))
  if (negative) return true

  const listPrefix = prefix.match(/(?:不安排|不用安排|不用|不需要|不必|无需|不要安排|不要|别安排|别|取消|去掉|删掉|删除|排除|不含|不包括|跳过|不吃|不想吃)([\s\S]*)$/u)?.[1]
  if (listPrefix && /^[\s、和及与,，]*(?:(?:早餐|早饭|早上|午餐|午饭|中午|晚餐|晚饭|晚上|晚间|三餐)[\s、和及与,，]*)*$/u.test(listPrefix)) return true

  const afterIndex = index + length
  const clauseEndCandidates = [text.indexOf('，', afterIndex), text.indexOf(',', afterIndex), text.indexOf('。', afterIndex), text.indexOf('；', afterIndex), text.indexOf(';', afterIndex)]
    .filter((value) => value >= 0)
  const clauseEnd = Math.min(...clauseEndCandidates, text.length)
  const suffix = text.slice(afterIndex, clauseEnd)
  return /^(?:\s*)(?:不安排|不用(?:安排)?|不需要(?:安排)?|不必(?:安排)?|无需(?:安排)?|不要安排|别安排|取消|去掉|删掉|删除|排除|不含|不包括|跳过|不吃|不想吃)/u.test(suffix)
}

function addMealSlots(
  target: Map<string, Set<'breakfast' | 'lunch' | 'dinner'>>,
  date: string,
  slots: Array<'breakfast' | 'lunch' | 'dinner'>,
  startBoundary?: Date,
  endBoundary?: Date
): void {
  const parsedDate = parseCalendarDate(date)
  if (!parsedDate || (startBoundary && parsedDate < startBoundary) || (endBoundary && parsedDate > endBoundary)) return
  const existing = target.get(date) ?? new Set<'breakfast' | 'lunch' | 'dinner'>()
  slots.forEach((slot) => existing.add(slot))
  target.set(date, existing)
}

/** 将明确安排和取消分别应用到日期，后出现的同餐次表达覆盖前项。 */
function addMealChanges(
  required: Map<string, Set<'breakfast' | 'lunch' | 'dinner'>>,
  excluded: Map<string, Set<'breakfast' | 'lunch' | 'dinner'>>,
  date: string,
  changes: { slots: Array<'breakfast' | 'lunch' | 'dinner'>; excludedSlots: Array<'breakfast' | 'lunch' | 'dinner'> },
  startBoundary?: Date,
  endBoundary?: Date
): void {
  const parsedDate = parseCalendarDate(date)
  if (!parsedDate || (startBoundary && parsedDate < startBoundary) || (endBoundary && parsedDate > endBoundary)) return
  const requiredSlots = required.get(date) ?? new Set<'breakfast' | 'lunch' | 'dinner'>()
  const excludedSlots = excluded.get(date) ?? new Set<'breakfast' | 'lunch' | 'dinner'>()
  changes.slots.forEach((slot) => {
    requiredSlots.add(slot)
    excludedSlots.delete(slot)
  })
  changes.excludedSlots.forEach((slot) => {
    requiredSlots.delete(slot)
    excludedSlots.add(slot)
  })
  required.set(date, requiredSlots)
  if (excludedSlots.size) excluded.set(date, excludedSlots)
  else excluded.delete(date)
}

function dateFromMonthDay(year: number, month: number, day: number, tripStart?: Date): Date | undefined {
  let candidate = new Date(Date.UTC(year, month - 1, day))
  if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return undefined
  if (tripStart && candidate < tripStart && month < tripStart.getUTCMonth() + 1) {
    candidate = new Date(Date.UTC(year + 1, month - 1, day))
  }
  return candidate
}

function parseCalendarDate(value: string): Date | undefined {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u)
  if (!match) return undefined
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.toISOString().slice(0, 10) === value ? date : undefined
}

/** 用兼容中英文空白的比较形式匹配城市名，不推测简称或行政区别名。 */
function normalizeDestinationText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim()
}

/** 只识别单一餐次片区修改；若草案已满足，就在本地结束而不生成重复版本。 */
export function mealAreaRequestTarget(
  text: string,
  baseline?: ItineraryOption
): { date: string; slot: ItineraryMealSlot } | undefined {
  const request = parseMealAreaRequest(text, baseline)
  return request ? { date: request.day.date, slot: request.slot } : undefined
}

/** 单一餐次片区修改仅在该餐次已有可用地点时视为完成。 */
export function mealAreaRequestAlreadySatisfied(text: string, baseline?: ItineraryOption): boolean {
  const request = parseMealAreaRequest(text, baseline)
  if (!request) return false

  const matchingMealStop = request.day.stops.some((stop) => {
    const label = `${stop.name} ${stop.category} ${stop.notes}`
    const isMeal = /餐|用餐|美食/u.test(stop.category) || /早餐|早饭|午餐|午饭|晚餐|晚饭|用餐/u.test(label)
    const location = normalizeMealArea(`${stop.name} ${stop.area} ${stop.notes}`)
    return isMeal && mealSlotForStop(stop) === request.slot && request.matchingAreas.some((area) => location.includes(area))
  })
  const matchingMealBlock = request.day.scheduleBlocks.some((block) => {
    const location = normalizeMealArea(`${block.title} ${block.area} ${block.notes}`)
    return block.kind === 'meal' && mealSlotForBlock(block) === request.slot &&
      request.matchingAreas.some((area) => location.includes(area))
  })
  return matchingMealStop || matchingMealBlock
}

/** 解析唯一餐次、日期与片区，供无变化判断和目标缺口检查共用。 */
function parseMealAreaRequest(
  text: string,
  baseline?: ItineraryOption
): { day: ItineraryOption['days'][number]; slot: ItineraryMealSlot; matchingAreas: string[] } | undefined {
  if (!baseline) return undefined
  const normalized = text.normalize('NFKC').trim()
  const request = /(?:^|[。！？；;:：\n])\s*(?:只把|只将|仅把|仅将|只改|仅改|只调整|仅调整)\s*((?:20\d{2}[-/.年])?\d{1,2}[-/.月]\d{1,2}日?)\s*(早餐|早饭|午餐|午饭|晚餐|晚饭)\s*(?:改成|改到|调整为|安排在|安排到|换成|放在)\s*([^\n。！？；;]{1,20}?(?:附近|一带|片区|区域|周边|周围))/u.exec(normalized)
  if (!request) return undefined
  const changeActions = normalized.match(/(?:改成|改到|调整为|安排到|安排在|换成|替换为|移动到|移到|新增|增加|删掉|删除|移除|取消)/gu) ?? []
  const requestEnd = (request.index ?? 0) + request[0].length
  const hasAnotherEdit = /(?:同时|另外|顺便|还要|并且|再把|另把|另将)[^。！？；;]{0,30}(?:把|将|加|添|删|去掉|移|安排|改|换|调|取消)/u.test(normalized.slice(requestEnd))
  if (changeActions.length !== 1 || hasAnotherEdit) return undefined

  const dateToken = /^(?:(\d{4})[-/.年])?(\d{1,2})[-/.月](\d{1,2})日?$/u.exec(request[1] ?? '')
  if (!dateToken) return undefined
  const [, year, month, day] = dateToken
  const matchingDays = baseline.days.filter((candidate) => {
    const [candidateYear, candidateMonth, candidateDay] = candidate.date.split('-')
    return candidateMonth === month?.padStart(2, '0') && candidateDay === day?.padStart(2, '0') &&
      (!year || candidateYear === year)
  })
  if (matchingDays.length !== 1) return undefined

  const slot: ItineraryMealSlot = /^(?:早餐|早饭)$/u.test(request[2] ?? '') ? 'breakfast'
    : /^(?:午餐|午饭)$/u.test(request[2] ?? '') ? 'lunch' : 'dinner'
  const requestedArea = normalizeMealArea(request[3] ?? '')
  if (!requestedArea) return undefined
  const matchingAreas = requestedArea === '前门'
    ? ['前门', '大栅栏', '鲜鱼口', '北京坊', '珠市口']
    : [requestedArea]
  const targetDay = matchingDays[0]
  return targetDay ? { day: targetDay, slot, matchingAreas } : undefined
}

/** 只有用户明确接受待核验店名时，片区已满足才可忽略来源缺口。 */
export function mealAreaRequestAllowsPendingRestaurant(text: string): boolean {
  return text.normalize('NFKC').split(/[。！？；;\n]/u).some((clause) => {
    const sourceUnavailable = /(?:来源|证据)[^。！？；;\n]{0,24}(?:不足|不够|缺少|没有|不能|无法|不支持)|(?:没有|缺少|无法)[^。！？；;\n]{0,12}(?:来源|证据)/u.test(clause)
    const keepPending = /(?:保留|暂留|标记为|列为)[^。！？；;\n]{0,8}(?:待选|待核验|待确认|待补|未核验)/u.test(clause)
    return sourceUnavailable && keepPending
  })
}

/** 清理餐次片区的常见后缀和空白，供用户请求与草案位置做字面比较。 */
function normalizeMealArea(value: string): string {
  return value.normalize('NFKC').replace(/(?:附近|一带|片区|区域|周边|周围)+$/u, '')
    .replace(/[\s，,。.、:：/\\_-]+/gu, '')
}
