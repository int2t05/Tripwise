/** 验证规划请求在多轮对话中的预算意图与用户明确取消行为。 */
import { describe, expect, it } from 'vitest'
import travelEvaluationFixture from './fixtures/travel-evaluation-cases.json'
import { dailyIndoorRainAlternativesRequestedForConversation, dailyWeatherRequestedForConversation, mealAreaRequestAlreadySatisfied, mealAreaRequestAllowsPendingRestaurant, mentionsBookingWorkflow, requiredMealSlotsForRequest, requiredPreparationCategoriesForRequest, requestedItineraryFactDetails, requestsAirportTransit, requestsBookingAlternative, requestsBookingDetails, requestsDailyIndoorRainAlternatives, requestsDailyWeather, requestsDetailedItinerary, requestsItineraryContingencies, requestsOpeningHoursDetails, requestsTicketPriceDetails, requestsTripBriefUpdate, requiresItineraryOutput, requiresPreparationOutput, shouldEnrichItineraryRoutes, shouldRequestBudgetEstimate, toolsForRequestIntent, userDeclinedExternalResearch } from '../src/main/agent-tool-policy.js'
import type { ItineraryOption } from '../src/shared/types.js'

describe('Agent 预算估算策略', () => {
  it('明确金额或费用问题需要分项估算，定性预算只作为偏好', () => {
    expect(shouldRequestBudgetEstimate('人均 3000 元', ['先规划三天北京行程'])).toBe(true)
    expect(shouldRequestBudgetEstimate('', ['帮我规划北京，估算下大概要花多少钱'])).toBe(true)
    expect(shouldRequestBudgetEstimate('', ['请在方案取舍中对比预算友好与省时间的做法；只有查到的门票和交通成本才能计入，并列出未计入项。'])).toBe(true)
    expect(shouldRequestBudgetEstimate('', ['帮我规划北京，看看住宿价格'])).toBe(true)
    expect(shouldRequestBudgetEstimate('中等', ['请按中等预算筛选餐饮和住宿，先给行程草案。'])).toBe(false)
    expect(shouldRequestBudgetEstimate('', ['预算中等即可，先安排路线。'])).toBe(false)
    expect(shouldRequestBudgetEstimate('', ['请给我一份完整的旅行预算明细。'])).toBe(true)
    expect(shouldRequestBudgetEstimate('偏低', ['请标出步行负担和未知费用；未查询的不要写成精确总价。'])).toBe(true)
    expect(shouldRequestBudgetEstimate('中等，具体上限待确认', ['先规划北京七日行程'])).toBe(false)
  })

  it('把同一话题之前的费用意图延续到后续补充条件', () => {
    expect(shouldRequestBudgetEstimate('', [
      '帮我估算北京全程费用。',
      '我补充一下，是四天三晚，尽量少走路。'
    ])).toBe(true)
  })

  it('用户明确暂不需要预算时覆盖简报中的预算偏好', () => {
    expect(shouldRequestBudgetEstimate('人均 3000 元', ['这次先不用算预算'])).toBe(false)
    expect(shouldRequestBudgetEstimate('人均 3000 元', ['预算这次先不算'])).toBe(false)
    expect(shouldRequestBudgetEstimate('中等预算', ['本轮不估算预算'])).toBe(false)
    expect(shouldRequestBudgetEstimate('中等预算', ['本次不估算总预算'])).toBe(false)
  })

  it('用户后来再次询问费用时恢复预算估算', () => {
    expect(shouldRequestBudgetEstimate('人均 3000 元', [
      '这次先不用算预算。',
      '我现在还是想看看全程大概多少钱。'
    ])).toBe(true)
  })
})

describe('Agent 餐次约束提取', () => {
  it('只提取用户明确写出的逐日餐次和日期范围', () => {
    const meals = requiredMealSlotsForRequest(
      '覆盖2026-09-21至2026-09-27每天：9/21只安排晚餐，9/22–9/26每天安排早餐、午餐、晚餐，9/27只安排早餐和午餐。',
      '2026-09-21', '2026-09-27'
    )

    expect(meals).toEqual([
      { date: '2026-09-21', slots: ['dinner'], exclusive: true },
      ...['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']
        .map((date) => ({ date, slots: ['breakfast', 'lunch', 'dinner'], exclusive: true })),
      { date: '2026-09-27', slots: ['breakfast', 'lunch'], exclusive: true }
    ])
  })

  it('识别点号日期和边界日餐次，并为完整游览日补齐三餐', () => {
    expect(requiredMealSlotsForRequest(
      '北京五天六晚旅游，从深圳出发，9.21首日只安排晚餐，9.27末日只安排早餐和午餐；其余完整游览日安排三餐。',
      '2026-09-21', '2026-09-27'
    )).toEqual([
      { date: '2026-09-21', slots: ['dinner'], exclusive: true },
      ...['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']
        .map((date) => ({ date, slots: ['breakfast', 'lunch', 'dinner'], exclusive: true })),
      { date: '2026-09-27', slots: ['breakfast', 'lunch'], exclusive: true }
    ])
  })

  it('用户未明确列出日期餐次时不推断固定餐次', () => {
    expect(requiredMealSlotsForRequest('安排北京行程，最好有几顿特色美食。', '2026-09-21', '2026-09-27')).toBeUndefined()
  })

  it('把用户明确取消的餐次解析为排除项，且不把不要早起当作取消早餐', () => {
    expect(requiredMealSlotsForRequest('9/21 不安排晚餐。', '2026-09-21', '2026-09-21')).toEqual([
      { date: '2026-09-21', slots: [], excludedSlots: ['dinner'] }
    ])
    expect(requiredMealSlotsForRequest('9/21 不安排早餐和午餐。', '2026-09-21', '2026-09-21')).toEqual([
      { date: '2026-09-21', slots: [], excludedSlots: ['breakfast', 'lunch'] }
    ])
    expect(requiredMealSlotsForRequest('9/21 晚餐不安排。', '2026-09-21', '2026-09-21')).toEqual([
      { date: '2026-09-21', slots: [], excludedSlots: ['dinner'] }
    ])
    expect(requiredMealSlotsForRequest('9/21 晚餐不要太晚。', '2026-09-21', '2026-09-21')).toEqual([
      { date: '2026-09-21', slots: ['dinner'] }
    ])
    expect(requiredMealSlotsForRequest('9/21 不早起安排早餐。', '2026-09-21', '2026-09-21')).toEqual([
      { date: '2026-09-21', slots: ['breakfast'] }
    ])
  })

  it('明确改成某餐时将当天餐次约束替换为该餐', () => {
    expect(requiredMealSlotsForRequest('9/21 改成午餐。', '2026-09-21', '2026-09-21')).toEqual([
      { date: '2026-09-21', slots: ['lunch'], exclusive: true }
    ])
  })
})

describe('Agent 外部查询限制', () => {
  const tools = [
    'search_web', 'get_weather', 'find_places', 'mcp_amap_search',
    'propose_itineraries', 'propose_itinerary_meals', 'propose_preparation', 'propose_trip_brief'
  ].map((name) => ({ type: 'function' as const, function: { name, description: '', parameters: {} } }))

  it('用户明确跳过搜索、天气和地图时只保留本地提案工具', () => {
    const request = '本轮不估算预算；不调用搜索、天气或地图。请直接整理完整行程。'
    expect(userDeclinedExternalResearch(request)).toBe(true)
    expect(toolsForRequestIntent(tools, request).map((tool) => tool.function.name)).toEqual(['propose_itineraries'])
  })

  it('用户直接要求一日游时也会开放结构化行程工具', () => {
    const request = '只生成一套北京一日游。本轮不调用搜索。'
    expect(toolsForRequestIntent(tools, request).map((tool) => tool.function.name)).toEqual(['propose_itineraries'])
  })

  it('识别中文数字天数游并开放行程与餐馆修订工具', () => {
    const request = '只生成一套北京两日游，安排具体店面。本轮不搜索。'
    expect(requiresItineraryOutput(request)).toBe(true)
    expect(toolsForRequestIntent(tools, request).map((tool) => tool.function.name))
      .toEqual(['propose_itineraries', 'propose_itinerary_meals'])
  })

  it('识别按天列景点与交通的初稿请求，不误分流为准备清单', () => {
    const request = '请按旅行信息生成可审阅的完整北京五天六晚初稿：每天列出时段、具体地点、景点和公共交通方式。'
    expect(requiresItineraryOutput(request)).toBe(true)
    expect(toolsForRequestIntent(tools, `${request} 本轮不搜索。`).map((tool) => tool.function.name))
      .toEqual(['propose_itineraries'])
  })

  it('把首轮机场到住宿接驳方案路由为结构化计划', () => {
    expect(requiresItineraryOutput('我 22:10 才落地。第一晚不要安排景点，给我机场到住宿的待核验交通方案。')).toBe(true)
  })

  it('识别机场名、落地信息和进城规划分散表达的接驳请求', () => {
    const request = '按我说的大兴机场和 19:30 落地规划进城；若航班准点后交通仍有不确定性，明确标出。'
    expect(requestsAirportTransit(request)).toBe(true)
    expect(requiresItineraryOutput(request)).toBe(true)
    expect(requestsAirportTransit('我想看机场附近的景点。')).toBe(false)
  })

  it('把自然语言修订意见路由到单份行程工具，不要求用户重复说“行程”', () => {
    const request = '把外滩停留缩短到一小时，保留预算估算。本轮不搜索。'
    expect(requiresItineraryOutput(request)).toBe(true)
    expect(toolsForRequestIntent(tools, request).map((tool) => tool.function.name)).toEqual(['propose_itineraries'])
    expect(requiresItineraryOutput('把第二天改轻松一些，但保留已锁定的预约和第一、三天安排。')).toBe(true)
    expect(requiresItineraryOutput('把香山换成颐和园。')).toBe(true)
    expect(requiresItineraryOutput('把预算改为 5000 元。')).toBe(false)
  })

  it('只开放用户本轮确实需要的行程提案工具', () => {
    const appointmentQuestion = '列出需要提前预约的项目和官方入口；抢票时间如果找不到可靠来源，不要猜。'
    const allergyQuestion = '推荐餐馆时不能仅根据菜名推断安全；需要核对过敏原和交叉污染说明，无法确认就明确提醒我联系店家。'
    const planningRequest = '请规划北京两日行程，并列出景点和交通。'

    expect(toolsForRequestIntent(tools, appointmentQuestion).map((tool) => tool.function.name))
      .not.toContain('propose_itineraries')
    expect(toolsForRequestIntent(tools, allergyQuestion).map((tool) => tool.function.name))
      .not.toContain('propose_itineraries')
    expect(toolsForRequestIntent(tools, planningRequest).map((tool) => tool.function.name))
      .toContain('propose_itineraries')
  })

  it('只要求逐日穿搭时不误认为在规划日程', () => {
    expect(requiresItineraryOutput('请根据天气整理每天的穿搭建议和行李清单。')).toBe(false)
  })

  it('不把正常检索或“不要只搜索”的表达当成禁用外部来源', () => {
    expect(userDeclinedExternalResearch('请搜索清华预约规则，并查天气和地图路线。')).toBe(false)
    expect(userDeclinedExternalResearch('不要只搜索清华预约规则，也要看看天气。')).toBe(false)
  })
})

describe('旅行评测用例的结构化产物契约', () => {
  it('30 个场景都明确规定每轮计划数，且意图路由与预期一致', () => {
    expect(travelEvaluationFixture.cases).toHaveLength(30)
    for (const evaluationCase of travelEvaluationFixture.cases) {
      expect([0, 1], evaluationCase.id).toContain(evaluationCase.expectedPlanCount)
      expect(requiresItineraryOutput(evaluationCase.prompt), evaluationCase.id)
        .toBe(evaluationCase.expectedPlanCount === 1)
    }
  })

  it('只澄清且明确暂不生成计划时不创建空计划', () => {
    expect(requiresItineraryOutput('先不要生成完整行程。只问一个最影响方案的问题；其他条件可以之后补。'))
      .toBe(false)
    expect(requiresItineraryOutput('先不要生成完整行程，先问我日期；之后再继续规划。'))
      .toBe(true)
  })

  it('只查网页且明确不要生成行程时按资料查询处理', () => {
    expect(requiresItineraryOutput(
      '请只用右侧研究浏览器搜索故宫博物院官方开放时间，从搜索结果找到官网并打开读取原文。不要生成行程，只说明页面中的游览提示。'
    )).toBe(false)
  })
})

describe('Agent 简报工具范围', () => {
  it('行程规划不触发无关简报提案，明确修改旅行字段时才触发', () => {
    expect(requestsTripBriefUpdate('请按现有资料规划北京完整行程。')).toBe(false)
    expect(requestsTripBriefUpdate('把出发日期改为9月22日。')).toBe(true)
    expect(requestsTripBriefUpdate('补充一下，我不吃牛肉。')).toBe(true)
  })
})

describe('Agent 行程事实与备选意图', () => {
  it('区分开放闭馆事实、预约规则和普通预约准备事项', () => {
    expect(requestsOpeningHoursDetails('请列清各景点开放时间和闭馆日。')).toBe(true)
    expect(requestsOpeningHoursDetails('日落时间、夜间开放和拍摄限制都要核验。')).toBe(true)
    expect(requestsOpeningHoursDetails('核对洪崖洞景观灯饰几点亮、几点关。')).toBe(true)
    const photographyCase = travelEvaluationFixture.cases.find(({ id }) => id === 'TW-26')
    expect(photographyCase && requiresItineraryOutput(photographyCase.prompt)).toBe(true)
    expect(photographyCase && requestsOpeningHoursDetails(photographyCase.prompt)).toBe(true)
    expect(requestsBookingDetails('请说明各景点是否需要预约和预约渠道。')).toBe(true)
    expect(mentionsBookingWorkflow('如果首选日期约满，就换同片区的替代点。')).toBe(true)
    expect(mentionsBookingWorkflow('请不要替我订票。')).toBe(true)
    expect(mentionsBookingWorkflow('帮我安排北京两天行程。')).toBe(false)
    expect(requestsBookingDetails('请查清各景点票价。')).toBe(false)
    expect(requestsTicketPriceDetails('请查清各景点票价和门票价格。')).toBe(true)
    expect(requestsBookingDetails('请整理各景点预约安排。')).toBe(false)
    expect(requestsItineraryContingencies('遇到下雨、景点人多或返程延误时给出调整方案。')).toBe(true)
    expect(requestsDailyWeather('请规划厦门两日行程并查询逐日天气。')).toBe(true)
    const sourceBasedWeatherRequest = '请规划北京两日行程并查询逐日天气；只陈述来源数据，不要编造天气。'
    expect(requestsDailyWeather(sourceBasedWeatherRequest)).toBe(true)
    expect(dailyWeatherRequestedForConversation([sourceBasedWeatherRequest])).toBe(true)
    expect(requestsDailyWeather('如果下雨，每天给一个室内替代活动。')).toBe(false)
    expect(requestsDailyIndoorRainAlternatives('如果下雨，每天给一个就近室内替代活动。')).toBe(true)
    expect(requestsDailyIndoorRainAlternatives('请给一天雨天室内备选活动。')).toBe(false)
    expect(requestsDailyIndoorRainAlternatives('不需要每天给雨天室内备选活动。')).toBe(false)
    expect(dailyWeatherRequestedForConversation([
      '请规划厦门两日行程并查询逐日天气。',
      '把第二天调轻松一点。'
    ])).toBe(true)
    expect(dailyWeatherRequestedForConversation([
      '请规划厦门两日行程并查询逐日天气。',
      '后续不需要再提供逐日天气。'
    ])).toBe(false)
    expect(dailyWeatherRequestedForConversation([
      '请规划厦门两日行程并查询逐日天气。',
      '后续不需要再提供逐日天气。',
      '我又想要逐日天气了。'
    ])).toBe(true)
    expect(dailyIndoorRainAlternativesRequestedForConversation([
      '如果下雨，每天给一个就近室内替代活动。',
      '把第二天调轻松一点。'
    ])).toBe(true)
    expect(dailyIndoorRainAlternativesRequestedForConversation([
      '如果下雨，每天给一个就近室内替代活动。',
      '后续不需要雨天室内备选。'
    ])).toBe(false)
    expect(requestsBookingAlternative('如果首选日期约满，优先用同区域替代点。')).toBe(true)
    expect(requestsItineraryContingencies('如果首选日期约满，优先用同区域替代点。')).toBe(true)
    expect(requestsBookingAlternative('把香山换成颐和园。')).toBe(false)
    expect(requestsOpeningHoursDetails('帮我安排北京两天行程。')).toBe(false)
    expect(requestsBookingDetails('帮我安排北京两天行程。')).toBe(false)
    expect(requestsItineraryContingencies('帮我安排北京两天行程。')).toBe(false)
  })
})

describe('详细行程请求识别', () => {
  it('局部修改继承仍在基线中的开放、预约和票价核验要求', () => {
    const baseline = { days: [{ stops: [{ factClaims: [
      { type: 'opening-hours' }, { type: 'booking' }, { type: 'ticket-price' }
    ] }] }] } as Parameters<typeof requestedItineraryFactDetails>[1]

    expect(requestedItineraryFactDetails('只把 9/23 调轻松，保留颐和园。', baseline)).toEqual({
      openingHours: true, booking: true, ticketPrice: true
    })
    expect(requestedItineraryFactDetails('天气怎么样？', baseline)).toEqual({
      openingHours: false, booking: false, ticketPrice: false
    })
  })

  it('识别逐时段交通与开放时间细节，同时不把普通规划当作细化模式', () => {
    expect(requestsDetailedItinerary('北京详细时段与交通安排，列出入口、换乘和开放时间限制。')).toBe(true)
    expect(requestsDetailedItinerary('请具体到每天的交通接驳和缓冲时间。')).toBe(true)
    expect(requestsDetailedItinerary('具体到通行方式、每个时段的景点；每段接驳写明交通方式和明确目的地。')).toBe(true)
    expect(requestsDetailedItinerary('必须逐日按早晨、上午、午间、下午、晚间等时段编排；每个具体景点有开始时刻和建议停留时间。')).toBe(true)
    expect(requestsDetailedItinerary('请规划重庆两日夜景摄影行程，安排拍摄时段和交通缓冲。')).toBe(true)
    expect(requestsDetailedItinerary('只生成一套北京一日游，三餐安排具体店面，查开放时间和天气。')).toBe(false)
    expect(requestsDetailedItinerary('帮我规划三天北京行程，轻松一些。')).toBe(false)
  })

  it('详细初稿及任何已有行程修订都触发路线复核，普通对话不触发', () => {
    const fineEdit = '只把 9/24 晚餐改成前门一带的就近安排；其他日期保持不变。'
    const detailedDraft = '请生成北京三日详细逐时段行程，并核对交通接驳。'

    expect(requestsDetailedItinerary(fineEdit)).toBe(false)
    expect(shouldEnrichItineraryRoutes(fineEdit, true)).toBe(true)
    expect(shouldEnrichItineraryRoutes(fineEdit, false)).toBe(false)
    expect(shouldEnrichItineraryRoutes(detailedDraft, false)).toBe(true)
    expect(shouldEnrichItineraryRoutes('预算改成中等。', true)).toBe(false)
  })
})

describe('已满足修改的本地终态', () => {
  const baseline: ItineraryOption = {
    id: 'plan-1', title: '北京计划', summary: '', tradeoffs: '',
    days: [{
      id: 'day-4', dayNumber: 4, date: '2026-09-24', title: '前门',
      stops: [{
        id: 'dinner', name: '晚餐待选', area: '前门片区', time: '18:00', durationMinutes: 60,
        category: '餐饮', notes: '', transitToNext: ''
      }],
      scheduleBlocks: []
    }]
  }

  it('识别指定日期和餐次已在目标片区的单点修改', () => {
    expect(mealAreaRequestAlreadySatisfied(
      '只把 9/24 晚餐改成前门一带的就近安排；若已有来源不能支持具体店名就保留待选。其他日期保持不变。',
      baseline
    )).toBe(true)
    expect(mealAreaRequestAlreadySatisfied(
      '第二轮修改：以刚才最新的修订为基线。只把 9/24 晚餐改成前门一带的就近安排；若已有来源不能支持具体店名就保留待选。其他日期、刚调整的 9/23、每天餐次范围和抵离时刻都保持不变。请返回一份完整修订草案，不并列方案。',
      baseline
    )).toBe(true)
  })

  it('仅在用户明确接受证据不足时保留待核验店名', () => {
    expect(mealAreaRequestAllowsPendingRestaurant(
      '只把 9/24 晚餐改成前门一带；若已有来源不能支持具体店名就保留待选。'
    )).toBe(true)
    expect(mealAreaRequestAllowsPendingRestaurant(
      '来源不可用。只把 9/24 晚餐改成前门一带。'
    )).toBe(false)
    expect(mealAreaRequestAllowsPendingRestaurant(
      '只把 9/24 晚餐改成前门一带；店名需要来源。'
    )).toBe(false)
  })

  it('不会把日期、餐次或地点不匹配的草案判为已满足', () => {
    expect(mealAreaRequestAlreadySatisfied('只把 9/25 晚餐改成前门一带。', baseline)).toBe(false)
    expect(mealAreaRequestAlreadySatisfied('只把 9/24 午餐改成前门一带。', baseline)).toBe(false)
    expect(mealAreaRequestAlreadySatisfied('只把 9/24 晚餐改成三里屯一带。', baseline)).toBe(false)
  })

  it('只处理单一片区修改，不吞掉具名餐馆或附加修改', () => {
    expect(mealAreaRequestAlreadySatisfied('只把 9/24 晚餐改成某某烤鸭店。', baseline)).toBe(false)
    expect(mealAreaRequestAlreadySatisfied(
      '只把 9/24 晚餐改成前门一带，同时把 9/25 午餐改到三里屯。', baseline
    )).toBe(false)
    expect(mealAreaRequestAlreadySatisfied(
      '只把 9/24 晚餐改成前门一带，同时加上国家博物馆。', baseline
    )).toBe(false)
    expect(mealAreaRequestAlreadySatisfied('只把 9/24 景点改到前门一带。', baseline)).toBe(false)
  })

  it('接受前门片区别名并读取餐次时间块', () => {
    const scheduleBlockPlan: ItineraryOption = {
      ...baseline,
      days: [{
        ...baseline.days[0]!, stops: [], scheduleBlocks: [{
          id: 'dinner-block', kind: 'meal', title: '晚餐', time: '18:00',
          durationMinutes: 60, area: '大栅栏', notes: ''
        }]
      }]
    }
    expect(mealAreaRequestAlreadySatisfied('只把 9/24 晚餐改成前门一带。', scheduleBlockPlan)).toBe(true)
  })
})

describe('准备清单类别提取', () => {
  it('只要求雨天或延误预案时也会触发准备清单', () => {
    expect(requiresPreparationOutput('只整理雨天/延误总预案。')).toBe(true)
  })

  it('提取用户明确要求的穿搭、行李、预约和备选预案类别', () => {
    expect(requiredPreparationCategoriesForRequest('另给逐日穿搭、行李清单、预约/购票清单及雨天/延误总预案。'))
      .toEqual(['clothing', 'packing', 'booking', 'alternative'])
  })

  it('公共交通规划需要交通准备提醒，但可尊重用户明确取消', () => {
    expect(requiresPreparationOutput('另给逐日穿搭、行李清单，行程尽量公共交通。')).toBe(true)
    expect(requiredPreparationCategoriesForRequest('另给逐日穿搭、行李清单，行程尽量公共交通。'))
      .toEqual(['clothing', 'packing', 'transport'])
    expect(requiresPreparationOutput('出发前交通核对提醒。')).toBe(true)
    expect(requiredPreparationCategoriesForRequest('不需要交通提醒，只整理行李清单。'))
      .toEqual(['packing'])
  })

  it('尊重用户明确取消的类别要求', () => {
    expect(requiredPreparationCategoriesForRequest('不需要穿搭和备选预案，只整理行李清单。'))
      .toEqual(['packing'])
  })
})
