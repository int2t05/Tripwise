/** 将内置连接器状态限定到真实来源提供方，避免相同来源类型互相串线。 */
import type { ConnectorSettings, SourceKind, SourceRecord } from '@shared/types'

const SOURCE_PROVIDERS: Record<keyof ConnectorSettings, readonly string[]> = {
  webSearch: ['Exa', 'Tavily', 'DuckDuckGo'],
  weather: ['Open-Meteo'],
  places: ['高德地图'],
  routes: ['高德地图路线规划']
}

/** 查找所选旅行中该内置连接器的最新来源，忽略其他使用同一来源类型的工具。 */
export function latestConnectorSource(
  sources: readonly SourceRecord[],
  connector: keyof ConnectorSettings,
  kind: SourceKind
): SourceRecord | undefined {
  return sources
    .filter((source) => source.kind === kind && matchesProvider(source.provider, SOURCE_PROVIDERS[connector]))
    .sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt))[0]
}

/** 提供方允许附加结果描述，但必须以已知连接器名称开头。 */
function matchesProvider(provider: string, allowed: readonly string[]): boolean {
  return allowed.some((name) => provider === name || provider.startsWith(`${name} `))
}
