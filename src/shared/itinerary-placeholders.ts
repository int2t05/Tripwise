/** 识别尚未选定具体景点的行程占位名称。 */

const PLACE_TERMS = '(?:景点|景区|地点|游览点)'
const UNRESOLVED_TERMS = '(?:待选择|待选|待定|待确认|待核验|待补|待安排|未定|未选|未确定|暂未确定)'
const UNRESOLVED_PLACE_PATTERN = new RegExp(
  `(?:${PLACE_TERMS}).{0,12}${UNRESOLVED_TERMS}|${UNRESOLVED_TERMS}.{0,12}(?:${PLACE_TERMS})`, 'u'
)

/** 占位地点不能作为路线查询端点或已核验景点展示。 */
export function isUnresolvedAttractionName(name: string): boolean {
  const normalized = name.normalize('NFKC').trim()
  return /^(?:景点|景区|地点|游览点)$/u.test(normalized) || UNRESOLVED_PLACE_PATTERN.test(normalized)
}
