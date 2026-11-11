/** 验证设置页默认简洁，并保留可审阅的隐私与凭证信息。 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AppSnapshot } from '../src/shared/types.js'
import { SettingsModal } from '../src/renderer/src/SettingsModal'

const snapshot: AppSnapshot = {
  trips: [],
  selectedTripId: null,
  settings: {
    model: { baseUrl: '', model: '' },
    sourceProxyUrl: '',
    connectors: { webSearch: true, weather: true, places: true, routes: true },
    xiaohongshu: { enabled: false, command: '', args: [] },
    researchBrowserVisualRead: false,
    mcpServers: []
  },
  secrets: {
    modelKeySaved: false,
    amapKeySaved: false,
    amapJsKeySaved: false,
    amapSecurityCodeSaved: false,
    exaKeySaved: false,
    tavilyKeySaved: false,
    firecrawlKeySaved: false,
    mcpSecretsSaved: {},
    credentialFilePath: '/tmp/tripwise-credentials.json',
    credentialFileRecoveryRequired: false
  }
}

function renderSettings(value: AppSnapshot = snapshot): string {
  return renderToStaticMarkup(
    <SettingsModal snapshot={value} trip={null} onClose={() => undefined} onSaved={() => undefined} onError={() => undefined} />
  )
}

describe('设置页层级', () => {
  it('默认只展示模型设置，其他配置按页签和折叠项查看', () => {
    const markup = renderSettings()
    expect(markup).toContain('aria-selected="true"')
    expect(markup).toContain('OpenAI 兼容 API')
    expect(markup).toContain('id="settings-panel-sources"')
    expect(markup).toContain('id="settings-panel-advanced"')
    expect(markup).toContain('class="settings-disclosure"')
    expect(markup).toContain('<summary>接口参数</summary>')
    expect(markup).not.toContain('<details class="settings-disclosure" open')
    expect(markup).toContain('保存并测试')
    expect(markup).not.toContain('连接与隐私')
    expect(markup).not.toContain('OpenAI 兼容模型')

    const disclosure = markup.indexOf('数据与隐私')
    expect(disclosure).toBeGreaterThanOrEqual(0)
    expect(markup).toContain('本次对话、旅行信息、已保存行程和准备清单、本轮工具结果')
    expect(markup).toContain('已确认坐标、路线估时和来源会写入旅行资料及备份')
    expect(markup).toContain('高德公开协议尚未明确授权个人桌面 Agent、向模型传递及保存/导出结果的组合场景')
    expect(markup).toContain('Open-Meteo 地理编码服务会收到城市名称')
    expect(markup).toContain('本机 MCP 程序以当前账户权限运行')
    expect(markup).toContain('内置右侧网页使用独立会话')
    expect(markup).toContain('用户配置的 OpenCLI 可通过 Browser Bridge 操作已登录的 Chrome 页面')
    expect(markup).toContain('Chrome Cookie 不导入 Tripwise 配置或旅行资料')
    expect(markup).toContain('OpenCLI 和扩展以当前账户权限运行')
    expect(markup).toContain('密钥筛查不完整')
    expect(markup).toContain('连接测试使用固定关键词')
    expect(markup).toContain('测试会读取 example.com')
    expect(markup.match(/保存并测试连接/g)).toHaveLength(4)
    expect(markup).toContain('系统钥匙串')
    expect(markup).toContain('网页图像识别')
    expect(markup).toContain('截图不保存')
  })

  it('显示配置文件位置、明文存储风险和损坏恢复提示', () => {
    const configured = structuredClone(snapshot)
    configured.secrets.credentialFilePath = '/Users/test/Library/Application Support/tripwise/tripwise-credentials.json'
    configured.secrets.modelKeySaved = true
    const markup = renderSettings(configured)

    expect(markup).toContain('文件为明文 JSON')
    expect(markup).toContain('同一账户下的程序可能读取')
    expect(markup).toContain('/Users/test/Library/Application Support/tripwise/tripwise-credentials.json')
    expect(markup).toContain('>已保存</span>')
    expect(markup).toContain('<summary>更换 API Key</summary>')
    expect(markup).toContain('重新载入配置')

    const broken = structuredClone(snapshot)
    broken.secrets.credentialFileRecoveryRequired = true
    const brokenMarkup = renderSettings(broken)
    expect(brokenMarkup).toContain('凭证文件格式无效；原文件已保留')
  })
})
