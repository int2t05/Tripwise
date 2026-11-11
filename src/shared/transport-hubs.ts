/** 识别机场与车站名称，避免用目的地城市代替用户确认的具体枢纽。 */
const hubPattern = /[\p{Script=Han}A-Za-z0-9·]{2,}?(?:国际机场|机场|航站楼|火车站|高铁站|动车站|铁路站|客运站|(?:地铁|公交)?站)/gu
const genericHubAliases = new Set(['国际机场', '机场', '航站楼', '火车站', '高铁站', '动车站', '铁路站', '客运站', '地铁站', '公交站', '站'])

/** 判断文本是否包含机场或车站类地点名称。 */
export function mentionsTransportHub(value: string): boolean {
  return /(?:国际机场|机场|航站楼|火车站|高铁站|动车站|铁路站|客运站|(?:地铁|公交)?站)/u.test(value)
}

/** 提取枢纽全名与可用简称，排除仅等于目的地城市的片段。 */
export function transportHubAliases(value: string, destination: string): string[] {
  const normalizedDestination = normalizeHubText(destination)
  const aliases = new Set<string>()
  const addAlias = (candidate: string): void => {
    const alias = normalizeHubText(candidate)
    if (alias.length < 2 || alias === normalizedDestination || genericHubAliases.has(alias)) return
    aliases.add(alias)
  }

  for (const hubName of value.match(hubPattern) ?? []) {
    const compactName = normalizeHubText(hubName)
    const withoutInternational = compactName.replace(/国际/gu, '')
    const locationName = withoutInternational.replace(/(?:国际机场|机场|航站楼|火车站|高铁站|动车站|铁路站|客运站|(?:地铁|公交)?站)$/u, '')
    for (const candidate of [compactName, withoutInternational, locationName]) {
      addAlias(candidate)
      if (normalizedDestination && candidate.startsWith(normalizedDestination)) {
        addAlias(candidate.slice(normalizedDestination.length))
      }
    }
  }
  return [...aliases]
}

/** 只有用户原话或已确认简报包含具体枢纽名称时才视为已确认。 */
export function userConfirmedTransportHub(endpoint: string, userProvidedText: string, destination: string): boolean {
  if (!mentionsTransportHub(endpoint)) return true
  if (/(?:或|或者|还是|\/|、)/u.test(endpoint)) return false
  const userText = normalizeHubText(userProvidedText)
  const userTextWithSeparators = userProvidedText.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '')
  for (const alias of transportHubAliases(endpoint, destination)) {
    const index = userText.indexOf(alias)
    if (index < 0) continue
    const nearbyText = userText.slice(Math.max(0, index - 12), index + alias.length + 12)
    const separatorIndex = userTextWithSeparators.indexOf(alias)
    const separatorContext = separatorIndex < 0 ? '' : userTextWithSeparators.slice(
      Math.max(0, separatorIndex - 6), separatorIndex + alias.length + 8
    )
    if (/(?:可能|不确定|未确认|待确认|尚未确认|待定|未知|不知道|不清楚|还没确定)/u.test(nearbyText) ||
        /(?:或者|或|还是|\/|、)/u.test(separatorContext)) continue
    return true
  }
  return false
}

/** 统一名称匹配规则，忽略空白、标点和全半角差异。 */
function normalizeHubText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}
