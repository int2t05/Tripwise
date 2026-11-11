/** 以可解释的来源渠道规则标注信息性质，不把渠道标签当作事实核验。 */
import type { SourceKind, SourceNature } from './types.js'

const COMMUNITY_DOMAINS = [
  'xiaohongshu.com',
  'xhslink.com',
  'mafengwo.cn',
  'qyer.com',
  'dianping.com',
  'tripadvisor.com',
  'tripadvisor.cn'
]

/** 仅按服务类型和明确域名标记来源；未知域名保持未分类。 */
export function sourceNatureFor(url: string, kind: SourceKind): SourceNature {
  if (kind === 'weather' || kind === 'place' || kind === 'route') return 'service'
  const hostname = hostnameOf(url)
  if (COMMUNITY_DOMAINS.some((domain) => isDomainOrSubdomain(hostname, domain))) return 'community-platform'
  if (hostname === 'gov.cn' || hostname.endsWith('.gov.cn')) return 'government-domain'
  if (kind === 'user') return 'user-provided'
  return 'unclassified'
}

/** 提供来源卡和模型工具结果共用的简短中文来源标签。 */
export function sourceNatureLabel(nature: SourceNature): string {
  return ({
    'government-domain': '政府域名',
    'community-platform': '社区平台',
    service: '数据服务',
    'user-provided': '用户提供',
    unclassified: '来源待确认'
  })[nature]
}

/** 解析网页主机名；非法或非网页 URL 不参与域名分类。 */
function hostnameOf(value: string): string {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.hostname.toLowerCase().replace(/\.$/, '') : ''
  } catch {
    return ''
  }
}

/** 要求完整域名后缀边界，避免把 xiaohongshu.com.attacker.test 误判成社区来源。 */
function isDomainOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}
