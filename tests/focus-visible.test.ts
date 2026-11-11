/** 检查透明样式控件仍提供清楚的键盘焦点提示。 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')

describe('键盘焦点可见性', () => {
  /** 局部 outline 重置必须有更高优先级的 focus-visible 样式覆盖。 */
  it('网页地址输入框和地图交通方式选择框保留高对比焦点环', () => {
    expect(styles).toMatch(/\.address-input input:focus-visible\s*,\s*\.map-route-mode select:focus-visible\s*\{[^}]*outline:\s*3px solid #39654c/s)
    expect(styles).toMatch(/\.address-input input\s*\{[^}]*outline:\s*0/s)
    expect(styles).toMatch(/\.map-route-mode select\s*\{[^}]*outline:\s*0/s)
  })

  it('主工作区跳转链接在键盘聚焦时会进入可视区域', () => {
    expect(styles).toMatch(/\.skip-link\s*\{[^}]*transform:\s*translateY\(calc\(-100% - 14px\)\)/s)
    expect(styles).toMatch(/\.skip-link:focus-visible\s*\{[^}]*transform:\s*translateY\(0\)/s)
  })

  /** 表单局部边框样式不能覆盖全局的高对比焦点轮廓。 */
  it('行程、导入和 MCP 表单沿用全局键盘焦点环', () => {
    expect(styles).toMatch(/button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible[^\{]*\{[^}]*outline:\s*3px solid #39654c/s)
    expect(styles).not.toContain('outline: 3px solid rgba(71, 114, 92, .1)')
  })
})
