/** 验证跨平台 renderer URL 规范化，不放宽主进程 IPC 来源边界。 */
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isTrustedRendererUrl, trustedDevelopmentRendererUrl } from '../src/main/trusted-renderer-url.js'

describe('主窗口 renderer URL 信任校验', () => {
  it('将 Windows file URL 的盘符路径按 Windows 规则匹配', () => {
    const rendererPath = 'C:\\Program Files\\Tripwise\\resources\\app.asar\\out\\renderer\\index.html'
    const rendererUrl = 'file:///C:/Program%20Files/Tripwise/resources/app.asar/out/renderer/index.html'

    expect(isTrustedRendererUrl(rendererUrl, rendererPath, undefined, 'win32')).toBe(true)
    expect(isTrustedRendererUrl(rendererUrl, rendererPath.replace('index.html', 'other.html'), undefined, 'win32')).toBe(false)
  })

  it('在 Unix 平台按文件路径而不是 URL 编码文本匹配', () => {
    const rendererPath = '/Applications/Tripwise Preview.app/Contents/Resources/app.asar/out/renderer/index.html'

    expect(isTrustedRendererUrl(pathToFileURL(rendererPath).href, rendererPath, undefined, 'darwin')).toBe(true)
  })

  it('开发模式仍限制在配置的 origin 和 renderer 路径', () => {
    expect(isTrustedRendererUrl('http://localhost:5173/', '', 'http://localhost:5173/', 'darwin')).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/#main-workspace', '', 'http://localhost:5173/', 'darwin')).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/other', '', 'http://localhost:5173/', 'darwin')).toBe(false)
    expect(isTrustedRendererUrl('http://localhost:5173/?x=1', '', 'http://localhost:5173/', 'darwin')).toBe(false)
    expect(isTrustedRendererUrl('http://user@localhost:5173/', '', 'http://localhost:5173/', 'darwin')).toBe(false)
    expect(isTrustedRendererUrl('http://localhost.attacker.test:5173/', '', 'http://localhost:5173/', 'darwin')).toBe(false)
  })

  it('打包应用忽略环境变量中的 renderer 开发服务器地址', () => {
    expect(trustedDevelopmentRendererUrl(true, 'https://attacker.example/renderer')).toBeUndefined()
    expect(trustedDevelopmentRendererUrl(false, 'http://localhost:5173/')).toBe('http://localhost:5173/')
  })

  it('仅接受安全片段定位，拒绝查询串、复杂片段、远端 file host 和编码分隔符', () => {
    const rendererPath = 'C:\\Program Files\\Tripwise\\resources\\app.asar\\out\\renderer\\index.html'

    expect(isTrustedRendererUrl('file:///C:/Program%20Files/Tripwise/resources/app.asar/out/renderer/index.html#main-workspace', rendererPath, undefined, 'win32')).toBe(true)
    expect(isTrustedRendererUrl('file:///C:/Program%20Files/Tripwise/resources/app.asar/out/renderer/index.html?x=1', rendererPath, undefined, 'win32')).toBe(false)
    expect(isTrustedRendererUrl('file:///C:/Program%20Files/Tripwise/resources/app.asar/out/renderer/index.html#main/workspace', rendererPath, undefined, 'win32')).toBe(false)
    expect(isTrustedRendererUrl('file:///C:/Program%20Files/Tripwise/resources/app.asar/out/renderer/index.html#%0A', rendererPath, undefined, 'win32')).toBe(false)
    expect(isTrustedRendererUrl('file://remote/C:/Program%20Files/Tripwise/resources/app.asar/out/renderer/index.html', rendererPath, undefined, 'win32')).toBe(false)
    expect(isTrustedRendererUrl('file:///C:/Program%20Files/Tripwise/resources/app.asar/out/renderer%2Findex.html', rendererPath, undefined, 'win32')).toBe(false)
  })
})
