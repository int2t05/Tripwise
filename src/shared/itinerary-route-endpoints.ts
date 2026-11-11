/** 统一路线与住宿接驳使用的实体地点边界。 */
import type { ItineraryStop, LodgingCommute } from './types.js'
import { isUnresolvedAttractionName } from './itinerary-placeholders.js'

/** 餐饮、住宿、休息和未确认交通提示不作为景点路线端点；具名枢纽保留。 */
export function isPhysicalItineraryStop(stop: Pick<ItineraryStop, 'name' | 'area' | 'category'>): boolean {
  const name = stop.name.trim()
  if (isUnresolvedAttractionName(name)) return false
  const identity = `${stop.category} ${name}`
  if (/交通/u.test(stop.category)) {
    if (/待确认|待核验|待选择|待定|未提供/u.test(`${name} ${stop.area}`)) return false
    return /机场|航站楼|(?:火车|高铁|动车|铁路|客运|地铁|公交)?站/u.test(`${name} ${stop.area}`)
  }
  if (/机场|站(?:北广场|南广场|东广场|西广场)?$/u.test(name)) return name.length >= 2
  if (/餐|用餐|美食/u.test(identity)) {
    return name.length >= 4 &&
      !/附近|待选|待定|待核验|商圈|片区|^(?:早餐|午餐|晚餐|简餐|餐饮|餐馆|餐厅|美食|食堂)$/u.test(name)
  }
  return name.length >= 2 &&
    !/酒店|住宿|入住|退房|休息|午休|航班|起飞|登机|候车|进站|安检|交通接驳/u.test(identity)
}

/** 读取住宿接驳方向对应的首个或末个实体地点。 */
export function lodgingCommuteBoundaryStop(
  stops: readonly ItineraryStop[],
  direction: LodgingCommute['direction']
): ItineraryStop | undefined {
  const physicalStops = stops.filter(isPhysicalItineraryStop)
  return direction === 'from-lodging' ? physicalStops[0] : physicalStops.at(-1)
}
