/** 检查浅色桌面主题中的文字色和文字图标色，避免对比度回退。 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

/** 把 CSS 十六进制颜色转换为相对亮度计算所需的线性 RGB 值。 */
function relativeLuminance(color: string): number {
  let value = color.slice(1)
  if (value.length === 3) value = [...value].map((character) => character + character).join('')
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

/** 计算前景色与背景色之间的 WCAG 对比度。 */
function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground)
  const second = relativeLuminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

/** 从指定 CSS 规则读取单个声明，避免关键提示颜色只靠人工记忆。 */
function declaration(css: string, selector: string, property: string): string {
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([, selectors]) => selectors.split(',').some((candidate) => candidate.trim().endsWith(selector)))
  if (!rule) throw new Error(`找不到样式规则：${selector}`)
  const value = rule[2].match(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`))?.[1].trim()
  if (!value) throw new Error(`${selector} 缺少 ${property} 声明。`)
  return value
}

/** 将根级字号变量展开为 px，供可读性回归检查使用。 */
function resolveCssValue(value: string, rootDeclarations: string): string {
  const variable = value.match(/^var\((--[\w-]+)\)$/)?.[1]
  if (!variable) return value
  const resolved = rootDeclarations.match(new RegExp(`(?:^|;)\\s*${variable}:\\s*([^;]+)`))?.[1].trim()
  if (!resolved) throw new Error(`找不到 CSS 变量：${variable}`)
  return resolved
}

describe('浅色界面颜色对比度', () => {
  it('文字与文字图标满足普通文本或禁用状态的最低对比度', async () => {
    const css = await readFile(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
    const violations: string[] = []
    const variableColors = new Map([...css.matchAll(/(--[\w-]+):\s*(#[\da-fA-F]{3,6})\b/g)]
      .map((match) => [match[1], match[2]]))
    const rules = css.matchAll(/([^{}]+)\{([^{}]*)\}/g)

    for (const [, selector, body] of rules) {
      const colorMatch = body.match(/(?:^|;)\s*color:\s*(#[\da-fA-F]{3,6}|var\(--[\w-]+\))/)
      if (!colorMatch) continue
      const foreground = colorMatch[1].startsWith('var(')
        ? variableColors.get(colorMatch[1].slice(4, -1))
        : colorMatch[1]
      if (!foreground) continue

      const backgroundMatch = body.match(/(?:^|;)\s*background(?:-color)?:\s*(#[\da-fA-F]{3,6}|var\(--[\w-]+\))/)
      const backgroundToken = backgroundMatch?.[1]
      const background = backgroundToken?.startsWith('var(')
        ? variableColors.get(backgroundToken.slice(4, -1))
        : backgroundToken
      const isWhiteText = ['#fff', '#ffffff'].includes(foreground.toLowerCase())
      const requiredRatio = selector.includes(':disabled') || selector.includes('.disabled') ? 3 : 4.5

      if (isWhiteText && !background) {
        violations.push(`${selector.trim()}：白色文字没有同规则底色用于核验`)
        continue
      }
      const ratio = contrastRatio(foreground, background ?? '#ffffff')
      if (ratio < requiredRatio) {
        violations.push(`${selector.trim()}：${foreground} / ${background ?? '#ffffff'} = ${ratio.toFixed(2)}:1，要求 ${requiredRatio}:1`)
      }
    }

    expect(violations).toEqual([])
  })

  it('隐私说明、地图错误提示和来源数量使用可读字号与不透明底色', async () => {
    const css = await readFile(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
    const rootDeclarations = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .find(([, selector]) => selector.trim().endsWith(':root'))?.[2]
    if (!rootDeclarations) throw new Error('找不到根级排版变量。')

    const checks = [
      { selector: '.privacy-inline', foreground: '#59615a', background: '#fafbf9', opaqueBackground: true, minimumFontSize: 12 },
      { selector: '.map-load-error', foreground: '#665340', background: '#f9faf7', opaqueBackground: true, minimumFontSize: 12 },
      { selector: '.map-load-error strong', foreground: '#526153', background: '#f9faf7', opaqueBackground: false, minimumFontSize: 12 },
      { selector: '.map-load-error button', foreground: '#426b4b', background: '#fff', opaqueBackground: true, minimumFontSize: 12 },
      { selector: '.research-tabs button span', foreground: '#536054', background: '#f0f3f0', opaqueBackground: true, minimumFontSize: 12 }
    ]

    for (const check of checks) {
      const color = resolveCssValue(declaration(css, check.selector, 'color'), rootDeclarations).toLowerCase()
      const style = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .find(([, selectors]) => selectors.split(',').some((candidate) => candidate.trim().endsWith(check.selector)))?.[2]
      if (!style) throw new Error(`找不到样式规则：${check.selector}`)
      const background = style.match(/(?:^|;)\s*background(?:-color)?:\s*(#[\da-fA-F]{3,6})\b/)?.[1].toLowerCase()
      const fontToken = declaration(css, check.selector, 'font-size')
      const fontSize = Number.parseFloat(resolveCssValue(fontToken, rootDeclarations))

      expect(color, `${check.selector} 前景颜色`).toBe(check.foreground)
      if (check.opaqueBackground) expect(background, `${check.selector} 应保持可测量的不透明底色`).toBe(check.background)
      expect(contrastRatio(color, check.background), `${check.selector} 前景与背景对比度`).toBeGreaterThanOrEqual(4.5)
      expect(fontSize, `${check.selector} 字号`).toBeGreaterThanOrEqual(check.minimumFontSize)
    }
  })
})
