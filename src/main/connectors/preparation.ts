/** 校验旅行准备事项，并作为待用户采纳的结构化候选返回。 */
import { randomUUID } from 'node:crypto'
import { PACKING_SECTIONS, type EvidenceLevel, type PackingSection, type PreparationCategory, type PreparationItem, type PreparationLocationContext } from '../../shared/types.js'
import { placeNamesMatch, routeSummarySupportsMetrics, routeTitleMatchesEndpoints } from '../../shared/preparation.js'
import { optionalDate, requireOneOf, requireText, ToolInputError, type ToolContext, type TravelTool } from './types.js'

const CATEGORIES: readonly PreparationCategory[] = [
  'booking', 'packing', 'clothing', 'food', 'alternative', 'transport', 'other'
]
const EVIDENCE_LEVELS: readonly EvidenceLevel[] = ['sourced', 'estimated', 'pending']
const DIRECT_EVIDENCE_LEVELS = new Set(['page', 'structured', 'user-provided', 'plugin'])
const CATEGORY_LABELS: Record<PreparationCategory, string> = {
  booking: '预约/购票', packing: '行李', clothing: '穿搭', food: '餐饮',
  alternative: '备选预案', transport: '交通', other: '其他'
}

/** 提供带依据状态的行李、预约、穿搭和备选事项候选。 */
export const preparationProposalTool: TravelTool = {
  definition: {
    type: 'function',
    function: {
      name: 'propose_preparation',
      description: '提交结构化准备事项。字段形状由 schema 限定；执行后返回 error、warning 或 info，按回执决定是否修改或交付。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 30,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', minLength: 1, maxLength: 120 },
                category: {
                  type: 'string', enum: CATEGORIES,
                  description: '类型：booking 预约、packing 行李、clothing 穿搭、food 餐饮、alternative 备选、transport 交通、other 其他。'
                },
                packing_section: {
                  type: 'string',
                  enum: PACKING_SECTIONS,
                  description: '行李位置：carry-on 随身、checked 托运、personal-item 个人物品、unclassified 未分类。'
                },
                detail: { type: 'string', minLength: 1, maxLength: 600, description: '事项说明。' },
                itinerary_date: { type: 'string', description: '适用行程日期，格式 YYYY-MM-DD；不适用时留空。' },
                due_date: { type: 'string', description: '事项截止日期，格式 YYYY-MM-DD；不适用时留空。' },
                location_context: {
                  type: 'object',
                  description: '地点或路线来源的结构化关联；无法确认时省略。',
                  properties: {
                    stop_id: { type: 'string', description: '停靠点 ID。' },
                    place_source_id: { type: 'string', description: '地点来源 ID。' },
                    route_option_number: { type: 'integer', minimum: 1, maximum: 3, description: '路线方案序号。' },
                    distance_meters: { type: 'integer', minimum: 1, maximum: 1_000_000 },
                    duration_minutes: { type: 'integer', minimum: 1, maximum: 1_440 },
                    route_source_id: { type: 'string', description: '路线来源 ID。' }
                  },
                  required: ['stop_id', 'place_source_id'],
                  additionalProperties: false
                },
                evidence_level: { type: 'string', enum: EVIDENCE_LEVELS, description: '证据状态；省略时按 pending 处理。' },
                source_ids: { type: 'array', maxItems: 5, items: { type: 'string' }, description: '直接支持本项的来源 ID；没有时留空。' }
              },
              required: ['title', 'category', 'detail', 'itinerary_date', 'due_date'],
              additionalProperties: false
            }
          }
        },
        required: ['items'],
        additionalProperties: false
      }
    }
  },
  provider: 'Tripwise 出行准备',
  kind: 'web',
  sourceUrl: '',
/** 结合用户资料和可用来源生成待用户检查的准备事项。 */
  async execute(args, context) {
    const { items, ignoredSourceReferenceCount, ignoredLocationContextCount, downgradedEvidenceCount } = normalizeItems(args.items, context)
    preserveUserLuggage(items, context)
    const missingCategories = (context.requiredPreparationCategories ?? [])
      .filter((category) => !items.some((item) => item.category === category))
    const feedback = [
      ...(missingCategories.length ? [{
        severity: 'warning' as const,
        code: 'preparation_categories_missing',
        message: `缺少用户要求的${missingCategories.map((category) => CATEGORY_LABELS[category]).join('、')}事项；可补齐后再交付。`
      }] : []),
      ...(ignoredSourceReferenceCount ? [{
        severity: 'warning' as const,
        code: 'preparation_sources_removed',
        message: `${ignoredSourceReferenceCount} 个来源引用不适用于对应事项，已移除或降为待核验。`
      }] : []),
      ...(downgradedEvidenceCount ? [{
        severity: 'warning' as const,
        code: 'preparation_evidence_downgraded',
        message: `${downgradedEvidenceCount} 项缺少直接依据，已降为待核验。`
      }] : []),
      ...(ignoredLocationContextCount ? [{
        severity: 'warning' as const,
        code: 'preparation_locations_unbound',
        message: `${ignoredLocationContextCount} 个地点未能关联已确认行程，仍保留区域建议。`
      }] : [])
    ]
    return {
      output: `准备清单有 ${items.length} 项建议${missingCategories.length ? `，缺少${missingCategories.map((category) => CATEGORY_LABELS[category]).join('、')}` : ''}。`,
      sources: [],
      feedback,
      preparationOptions: items
    }
  }
}

/** 检查数量、日期、来源 ID 和证据状态，再生成稳定的本地事项。 */
function normalizeItems(value: unknown, context: ToolContext): {
  items: PreparationItem[]
  ignoredSourceReferenceCount: number
  ignoredLocationContextCount: number
  downgradedEvidenceCount: number
} {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) {
    throw new ToolInputError('准备事项数量必须为 1–30 项。')
  }
  const availableSourceIds = new Set(context.sourceIds ?? [])
  let ignoredSourceReferenceCount = 0
  let ignoredLocationContextCount = 0
  let downgradedEvidenceCount = 0
  const items = value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolInputError('准备事项必须是对象。')
    const item = raw as Record<string, unknown>
    const category = requireOneOf(item, 'category', CATEGORIES)
    let title = requireText(item, 'title', 1, 120)
    let evidenceLevel: EvidenceLevel = item.evidence_level === undefined
      ? 'pending'
      : requireOneOf(item, 'evidence_level', EVIDENCE_LEVELS)
    const packingSection = category === 'packing' ? normalizePackingSection(item.packing_section) : undefined
    const itineraryDate = optionalDate(item.itinerary_date) ?? ''
    const dueDate = optionalDate(item.due_date) ?? ''
    const rawSourceIds = item.source_ids
    if (rawSourceIds !== undefined && (!Array.isArray(rawSourceIds) || rawSourceIds.length > 5 || !rawSourceIds.every((id) => typeof id === 'string'))) {
      throw new ToolInputError('来源 ID 必须是最多 5 项的字符串列表。')
    }
    const requestedSourceIds = [...new Set((rawSourceIds ?? []) as string[])]
    let sourceIds = requestedSourceIds.filter((id) => {
      if (availableSourceIds.has(id)) return true
      ignoredSourceReferenceCount += 1
      return false
    })
    let detail = requireText(item, 'detail', 1, 600)
    const userAllowance = normalizeUserLuggageAllowance(category, title, detail, context)
    if (userAllowance) {
      title = userAllowance.title
      detail = userAllowance.detail
      evidenceLevel = 'pending'
      ignoredSourceReferenceCount += sourceIds.length
      sourceIds = []
    }
    const directlySupportingSourceIds = sourceIds.filter((id) => {
      const source = context.availableSources?.find((candidate) => candidate.id === id)
      if (!source || !sourceSupportsPreparationItem(source, category, title, detail, itineraryDate, context)) {
        ignoredSourceReferenceCount += 1
        return false
      }
      return true
    })
    sourceIds = directlySupportingSourceIds
    const quantitativeClaims = quantitativePreparationClaims(title, detail)
    const quantitativeEvidenceComplete = quantitativeClaims.every((claim) => sourceIds.some((id) => {
      const source = context.availableSources?.find((candidate) => candidate.id === id)
      return !!source && normalizeEvidenceText(source.summary).includes(claim)
    }))
    if (evidenceLevel === 'sourced' && sourceIds.length === 0) {
      evidenceLevel = 'pending'
      downgradedEvidenceCount += 1
    }
    if (evidenceLevel === 'sourced' && !quantitativeEvidenceComplete) {
      evidenceLevel = 'pending'
      downgradedEvidenceCount += 1
    }
    if (quantitativeClaims.length && !quantitativeEvidenceComplete && !userAllowance &&
      explicitNoUnverifiedLimits(context)) {
      title = safeUnverifiedLimitTitle(category, title, detail)
      detail = '本轮没有能直接支持具体数值的来源，因此不列具体限额。请按实际客票或现行官方规定核对后再更新。'
      ignoredSourceReferenceCount += sourceIds.length
      sourceIds = []
      if (evidenceLevel !== 'pending') downgradedEvidenceCount += 1
      evidenceLevel = 'pending'
    }
    validateClothingDate(category, itineraryDate, context)
    // 草案尚未确认时只丢弃可选关联，保留建议本身，避免引用草案 ID 拒绝整份清单。
    const hasUnconfirmedLocationContext = (category === 'food' || category === 'alternative') &&
      item.location_context !== undefined && !context.itinerary
    const locationContext = hasUnconfirmedLocationContext
      ? undefined
      : normalizeLocationContext(item.location_context, category, itineraryDate, title, sourceIds, context)
    if (hasUnconfirmedLocationContext) ignoredLocationContextCount += 1
    return {
      id: randomUUID(),
      title,
      category,
      ...(packingSection ? { packingSection: packingSection as PackingSection } : {}),
      detail,
      itineraryDate,
      dueDate,
      ...(locationContext ? { locationContext } : {}),
      evidenceLevel,
      sourceIds,
      checked: false
    }
  })
  removeRedundantLimitNotes(items)
  return { items, ignoredSourceReferenceCount, ignoredLocationContextCount, downgradedEvidenceCount }
}

/** 仅接受成功的正文或结构化来源；行李和交通中的精确数值还须出现在来源摘要中。 */
function sourceSupportsPreparationItem(
  source: NonNullable<ToolContext['availableSources']>[number],
  category: PreparationCategory,
  title: string,
  detail: string,
  itineraryDate: string,
  context: ToolContext
): boolean {
  if (category === 'clothing') {
    return hasClothingWeatherEvidence(itineraryDate, [source.id], context)
  }
  if (source.status !== 'success' || !source.contentLevel || !DIRECT_EVIDENCE_LEVELS.has(source.contentLevel)) return false

  const quantitativeClaims = quantitativePreparationClaims(title, detail)
  if (!quantitativeClaims.length || !['packing', 'transport', 'booking'].includes(category)) return true
  const evidence = normalizeEvidenceText(source.summary)
  return quantitativeClaims.some((claim) => evidence.includes(normalizeEvidenceText(claim)))
}

/** 识别用户明确要求未核实前不列具体限额或数字的本轮约束。 */
function explicitNoUnverifiedLimits(context: ToolContext): boolean {
  return /(?:不要|不得|不写|不列|不提供|不标).{0,20}(?:具体限额|限额|具体数值|具体数字|具体尺寸|重量限值|电量限值|额度)/u
    .test(context.userRequest ?? '')
}

/** 将无来源的数值限额改写成明确的待核对事项。 */
function safeUnverifiedLimitTitle(category: PreparationCategory, title: string, detail: string): string {
  if (/充电宝/u.test(`${title} ${detail}`)) return '核对充电宝额定能量规则'
  if (/锂电池|备用电池/u.test(`${title} ${detail}`)) return '核对锂电池携带规则'
  if (/行李|随身|尺寸|重量/u.test(`${title} ${detail}`)) return '核对随身行李重量与尺寸规则'
  if (category === 'booking') return '核对预约时间和费用规则'
  return '核对具体数值规则'
}

/** 如果原清单已有同主题待核验项，不再保留本机改写出的重复提醒。 */
function removeRedundantLimitNotes(items: PreparationItem[]): void {
  const generatedTitles = new Map<string, RegExp>([
    ['核对充电宝额定能量规则', /充电宝|额定能量|移动电源/u],
    ['核对锂电池携带规则', /锂电池|备用电池/u],
    ['核对随身行李重量与尺寸规则', /随身行李|登机箱|尺寸.{0,8}重量|重量.{0,8}尺寸/u],
    ['核对预约时间和费用规则', /预约|门票|费用|票价/u]
  ])
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    const topic = item ? generatedTitles.get(item.title) : undefined
    if (!item || !topic) continue
    const duplicateExists = items.some((candidate) => candidate.id !== item.id &&
      ['packing', 'transport', 'booking'].includes(candidate.category) && candidate.evidenceLevel === 'pending' &&
      topic.test(`${candidate.title} ${candidate.detail}`))
    if (duplicateExists) items.splice(index, 1)
  }
}

/** 只核对容易造成错误执行的尺寸、重量、电量、时长、金额等带单位数值。 */
function quantitativePreparationClaims(title: string, detail: string): string[] {
  const text = `${title} ${detail}`
  const claims = [
    ...[...text.matchAll(/\d+(?:[.,]\d+)?\s*(?:kg|公斤|g|克|cm|厘米|mm|毫米|km|公里|米|m|wh|瓦时|kwh|千瓦时|w|瓦|ml|毫升|l|升|分钟|小时|h|元|％|%)/giu)]
      .map((match) => match[0]),
    ...[...text.matchAll(/\d+(?:[.,]\d+)?(?:\s*[×xX]\s*\d+(?:[.,]\d+)?){1,2}\s*(?:cm|厘米|mm|毫米|m|米)?/giu)]
      .map((match) => match[0])
  ]
  return [...new Set(claims.map(normalizeEvidenceText))]
}

/** 统一常见单位、乘号和空格，允许来源与正文采用等价写法。 */
function normalizeEvidenceText(value: string): string {
  return value.toLocaleLowerCase()
    .replace(/\s+/gu, '')
    .replace(/[x×]/gu, '×')
    .replace(/公斤/gu, 'kg')
    .replace(/厘米/gu, 'cm')
    .replace(/毫米/gu, 'mm')
    .replace(/公里/gu, 'km')
    .replace(/千瓦时/gu, 'kwh')
    .replace(/瓦时/gu, 'wh')
    .replace(/毫升/gu, 'ml')
    .replace(/小时/gu, 'h')
    .replace(/分钟/gu, 'min')
}

/** 客票相关的用户额度保持原始语义，不让模型改写为另一种行李额度。 */
function normalizeUserLuggageAllowance(
  category: PreparationCategory,
  title: string,
  detail: string,
  context: ToolContext
): { title: string; detail: string } | undefined {
  const luggage = context.tripBrief?.luggage.trim()
  if (!luggage || !/托运/u.test(luggage)) return undefined
  const weights = luggage.split(/[；;。\n]/u).filter((part) => /托运/u.test(part))
    .flatMap((part) => [...part.matchAll(/(\d+(?:[.,]\d+)?)\s*(kg|公斤|g|克)/giu)])
  if (!weights.length) return undefined

  const candidateText = `${title} ${detail}`
  const checkedClaimMatches = weights.some((match) => {
    const claim = `${match[1]}${match[2]}`
    return new RegExp(`${escapeRegExp(claim)}|${escapeRegExp(claim.replace(/kg/iu, '公斤').replace(/g/iu, '克'))}`, 'iu').test(candidateText) &&
      /托运/u.test(candidateText)
  })
  if (!checkedClaimMatches || !['packing', 'transport'].includes(category)) return undefined

  return {
    title: '托运行李额度（用户提供）',
    detail: `用户提供的行李信息：${luggage}。该信息未与实际客票核对；随身行李、备用电池和托运规则需分别确认。`
  }
}

/** 用户明确填写的行李约束即使模型漏写，也保存在待核验清单中。 */
function preserveUserLuggage(items: PreparationItem[], context: ToolContext): void {
  const luggage = context.tripBrief?.luggage.trim()
  if (!luggage) return
  const canonicalTitle = '托运行李额度（用户提供）'
  const canonicalItems = items.filter((item) => item.title === canonicalTitle)
  if (canonicalItems.length > 1) {
    const retainedId = canonicalItems[0]?.id
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index]?.title === canonicalTitle && items[index]?.id !== retainedId) items.splice(index, 1)
    }
  }
  const existingText = normalizeEvidenceText(items.map((item) => `${item.title} ${item.detail}`).join(' '))
  if (existingText.includes(normalizeEvidenceText(luggage))) return

  const item: PreparationItem = {
    id: randomUUID(),
    title: '行李信息（用户提供）',
    category: 'other',
    detail: `用户提供的行李信息：${luggage}。该信息未与实际客票核对；随身行李、备用电池和托运规则需分别确认。`,
    itineraryDate: '',
    dueDate: '',
    evidenceLevel: 'pending',
    sourceIds: [],
    checked: false
  }
  if (items.length >= 30) {
    const removableIndex = findRedundantPreparationItem(items, context.requiredPreparationCategories ?? [])
    if (removableIndex < 0) {
      throw new ToolInputError(
        '准备清单已达 30 项，无法同时保留用户填写的行李信息；请压缩清单后重试。',
        'preparation_limit_conflict', 'warning'
      )
    }
    items.splice(removableIndex, 1)
  }
  items.push(item)
}

/** 安全转义用户输入中的单位字符，供额度匹配正则使用。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** 未知装包位置明确归为待分类；非行李项上的可选字段不影响整批清单。 */
function normalizePackingSection(value: unknown): PackingSection {
  return typeof value === 'string' && (PACKING_SECTIONS as readonly string[]).includes(value)
    ? value as PackingSection
    : 'unclassified'
}

/** 30 项已满时优先替换非必需或同类冗余项，保留用户要求的每个类别。 */
function findRedundantPreparationItem(items: PreparationItem[], required: PreparationCategory[]): number {
  const counts = new Map<PreparationCategory, number>()
  items.forEach((item) => counts.set(item.category, (counts.get(item.category) ?? 0) + 1))
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item && !required.includes(item.category)) return index
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item && item.category !== 'clothing' && (counts.get(item.category) ?? 0) > 1) return index
  }
  return -1
}

/** 将逐日穿搭绑定到真实行程日；证据不足由调用方降级，不拒绝整份清单。 */
function validateClothingDate(category: PreparationCategory, itineraryDate: string, context: ToolContext): void {
  if (category !== 'clothing') return

  if (context.itinerary) {
    const itineraryDates = new Set(context.itinerary.days.map((day) => day.date))
    if (!itineraryDate || !itineraryDates.has(itineraryDate)) {
      throw new ToolInputError('穿搭日期不在当前已确认行程中；请改用对应行程日或暂不绑定日期。', 'clothing_date_unmatched', 'warning')
    }
  }
}

/** 只有包含适用日期预报的天气来源，才支持逐日穿搭的 sourced 状态。 */
function hasClothingWeatherEvidence(
  itineraryDate: string,
  sourceIds: string[],
  context: ToolContext
): boolean {
  return !!context.availableSources?.find((source) =>
    sourceIds.includes(source.id) &&
    source.kind === 'weather' &&
    (source.status === 'success' || source.status === 'partial') &&
    (!itineraryDate || source.summary.split('\n').some((row) => row.startsWith(`${itineraryDate}：`)))
  )
}

/** 将模型选择的停靠点解析为行程快照，并验证路线指标引用成功来源。 */
function normalizeLocationContext(
  value: unknown,
  category: PreparationCategory,
  itineraryDate: string,
  itemTitle: string,
  itemSourceIds: string[],
  context: ToolContext
): PreparationLocationContext | undefined {
  const categoryRequiresStop = category === 'food' || category === 'alternative'
  if (value === undefined) return undefined
  if (!isRecord(value) || Object.keys(value).some((key) =>
    !['stop_id', 'place_source_id', 'route_option_number', 'distance_meters', 'duration_minutes', 'route_source_id'].includes(key)
  )) {
    throw new ToolInputError('地点关联仅适用于有已确认行程的餐饮或备选活动。')
  }
  if (!categoryRequiresStop || !context.itinerary) {
    throw new ToolInputError('当前事项没有可绑定的已确认行程地点；请删除地点关联并保留区域建议。', 'preparation_location_unavailable', 'warning')
  }

  const stopId = requireText(value, 'stop_id', 1, 100)
  const matches = context.itinerary.days.flatMap((day) => day.stops
    .filter((stop) => stop.id === stopId)
    .map((stop) => ({ day, stop })))
  if (matches.length !== 1) {
    throw new ToolInputError('餐饮或备选活动引用了当前行程中不存在或重复的停靠点。', 'preparation_stop_unmatched', 'warning')
  }
  const [{ day, stop }] = matches
  if (itineraryDate !== day.date) {
    throw new ToolInputError('餐饮或备选活动适用日期与关联地点日期不一致。', 'preparation_location_date_mismatch', 'warning')
  }

  const placeSourceId = requireText(value, 'place_source_id', 1, 100)
  const placeSource = context.availableSources?.find((source) => source.id === placeSourceId)
  if (!itemSourceIds.includes(placeSourceId) || !context.sourceIds?.includes(placeSourceId) ||
    !placeSource || placeSource.kind !== 'place' || placeSource.status !== 'success' ||
    !placeNamesMatch(placeSource.title, itemTitle)) {
    throw new ToolInputError(
      '餐饮或备选标题没有匹配当前地点来源；请改用已检索地点或删除绑定。',
      'preparation_place_unverified', 'warning'
    )
  }

  const distanceMeters = optionalPositiveInteger(value.distance_meters, '路线距离', 1_000_000)
  const durationMinutes = optionalPositiveInteger(value.duration_minutes, '路线耗时', 1_440)
  const hasRouteMetric = distanceMeters !== undefined || durationMinutes !== undefined
  const routeOptionNumber = optionalPositiveInteger(value.route_option_number, '路线方案序号', 3)
  const routeSourceId = value.route_source_id === undefined ? undefined : requireText(value, 'route_source_id', 1, 100)
  if (hasRouteMetric) {
    const routeSource = context.availableSources?.find((source) => source.id === routeSourceId)
    if (!routeSourceId || !routeOptionNumber || !itemSourceIds.includes(routeSourceId) || !context.sourceIds?.includes(routeSourceId) ||
      !routeSource || routeSource.kind !== 'route' || routeSource.status !== 'success' ||
      !routeSummarySupportsMetrics(routeSource.summary, routeOptionNumber, distanceMeters, durationMinutes) ||
      !routeTitleMatchesEndpoints(routeSource.title, stop.name, placeSource.title)) {
      throw new ToolInputError(
        '路线距离或耗时缺少匹配的成功路线来源；请移除数值或重新查询。',
        'preparation_route_unverified', 'warning'
      )
    }
  } else if (routeSourceId !== undefined || routeOptionNumber !== undefined) {
    throw new ToolInputError('没有路线指标时不要填写路线来源或方案序号。')
  }

  return {
    dayNumber: day.dayNumber,
    dayTitle: day.title,
    stopId: stop.id,
    stopName: stop.name,
    area: stop.area,
    placeSourceId: placeSource.id,
    placeName: placeSource.title,
    ...(routeOptionNumber === undefined ? {} : { routeOptionNumber }),
    ...(distanceMeters === undefined ? {} : { distanceMeters }),
    ...(durationMinutes === undefined ? {} : { durationMinutes }),
    ...(routeSourceId ? { routeSourceId } : {})
  }
}

/** 仅接受有界正整数，防止模型将任意字符串显示为路线事实。 */
function optionalPositiveInteger(value: unknown, label: string, maximum: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new ToolInputError(`${label}必须是 1–${maximum} 的整数。`)
  }
  return value
}

/** 只接受普通对象，避免模型把数组或 null 当地点关联。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
