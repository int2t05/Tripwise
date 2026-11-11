/** 统一界面缩放步进和边界，供原生菜单及独立测试共同使用。 */
export type ZoomDirection = -1 | 0 | 1

/** 按 10% 调整缩放比例；0 表示恢复默认，范围限制为 50% 至 200%。 */
export function nextZoomFactor(current: number, direction: ZoomDirection): number {
  if (direction === 0) return 1
  const base = Number.isFinite(current) ? current : 1
  const stepped = Math.round((base + direction * 0.1) * 10) / 10
  return Math.max(0.5, Math.min(2, stepped))
}
