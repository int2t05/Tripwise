/** 管理模型、旅行数据连接器和 MCP 服务的设置界面。 */
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  Eye, FolderOpen, MapPin, Plug, Plus, Route, Search, ShieldCheck, Sun, Trash2
} from 'lucide-react'
import type {
  AppSnapshot, BuiltinConnectorTestId, ConnectorSettings, McpServerAuth, McpServerInput, McpServerSettings, McpToolDescriptor, McpTransport, ModelProvider,
  OpenCliSettings, SourceRecord, Trip
} from '@shared/types'
import { Announcement } from './components/Announcement'
import { Modal } from './components/Modal'
import { errorMessage, formatTime, statusLabel } from './ui-format'
import { saveSettingsAndSecrets } from './settings-save'
import { latestConnectorSource } from './connector-activity'

const DEFAULT_MODEL_URL = 'https://api.openai.com/v1'
const DEFAULT_MODEL_NAME = 'glm-5.3-flash'
const SETTINGS_TABS = ['model', 'sources', 'advanced'] as const
type SettingsTab = typeof SETTINGS_TABS[number]

/** 展示服务配置；凭证输入框始终为空，状态不返回密钥内容。 */
export function SettingsModal({ snapshot, trip, onClose, onSaved, onError }: {
  snapshot: AppSnapshot
  trip: Trip | null
  onClose: () => void
  onSaved: (snapshot: AppSnapshot) => void
  onError: (message: string) => void
}) {
  const [baseUrl, setBaseUrl] = useState(snapshot.settings.model.baseUrl || DEFAULT_MODEL_URL)
  const [model, setModel] = useState(snapshot.settings.model.model || DEFAULT_MODEL_NAME)
  const [modelProvider, setModelProvider] = useState<ModelProvider>(snapshot.settings.model.provider ?? 'openai-compatible')
  const [activeTab, setActiveTab] = useState<'model' | 'sources' | 'advanced'>('model')
  const [sourceProxyUrl, setSourceProxyUrl] = useState(snapshot.settings.sourceProxyUrl)
  const [connectors, setConnectors] = useState<ConnectorSettings>(snapshot.settings.connectors)
  const [xiaohongshu, setXiaohongshu] = useState<OpenCliSettings>(snapshot.settings.xiaohongshu)
  const [researchBrowserVisualRead, setResearchBrowserVisualRead] = useState(snapshot.settings.researchBrowserVisualRead)
  const [openCliArgsText, setOpenCliArgsText] = useState(snapshot.settings.xiaohongshu.args.join('\n'))
  const [modelKey, setModelKey] = useState('')
  const [amapKey, setAmapKey] = useState('')
  const [amapJsKey, setAmapJsKey] = useState('')
  const [amapSecurityCode, setAmapSecurityCode] = useState('')
  const [exaKey, setExaKey] = useState('')
  const [tavilyKey, setTavilyKey] = useState('')
  const [firecrawlKey, setFirecrawlKey] = useState('')
  const [connectorTestResults, setConnectorTestResults] = useState<Partial<Record<BuiltinConnectorTestId, string>>>({})
  const [clearModelKey, setClearModelKey] = useState(false)
  const [clearAmapKey, setClearAmapKey] = useState(false)
  const [clearAmapJsKey, setClearAmapJsKey] = useState(false)
  const [clearAmapSecurityCode, setClearAmapSecurityCode] = useState(false)
  const [clearExaKey, setClearExaKey] = useState(false)
  const [clearTavilyKey, setClearTavilyKey] = useState(false)
  const [clearFirecrawlKey, setClearFirecrawlKey] = useState(false)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  /** 修改凭证后清除旧的连接结果，避免旧 Key 的成功状态误导用户。 */
  function clearConnectorTestResult(provider: BuiltinConnectorTestId): void {
    setConnectorTestResults((current) => ({ ...current, [provider]: undefined }))
  }

  /** 仅选择本机 CLI/Node 可执行文件；路径由主进程原样保存。 */
  async function chooseOpenCliCommand(): Promise<void> {
    try {
      const path = await window.tripwise.chooseOpenCliCommand()
      if (path) setXiaohongshu((current) => ({ ...current, command: path }))
    } catch (reason) {
      onError(errorMessage(reason))
    }
  }

  /** 重新载入外部编辑的凭证文件并打开它。 */
  async function openLocalCredentialFile(): Promise<void> {
    setBusy(true)
    setStatus('')
    try {
      const next = await window.tripwise.openLocalCredentialFile()
      onSaved(next)
      setStatus('已重新载入本机凭证文件。')
    } catch (reason) {
      const message = errorMessage(reason)
      setStatus(message)
      onError(message)
    } finally {
      setBusy(false)
    }
  }

  /** 打开仅保存运行阶段和错误类别的本机诊断日志目录。 */
  async function openSystemLogDirectory(): Promise<void> {
    try {
      await window.tripwise.openSystemLogDirectory()
      setStatus('已打开运行日志文件夹。日志不包含对话正文、工具参数或密钥。')
    } catch (reason) {
      const message = errorMessage(reason)
      setStatus(message)
      onError(message)
    }
  }

  /** 保存普通设置和密钥后立即清空输入框，避免 React 状态长期保留秘密。 */
  async function save(testAfter: boolean | BuiltinConnectorTestId = false): Promise<void> {
    setBusy(true)
    setStatus('')
    if (typeof testAfter === 'string') {
      setConnectorTestResults((current) => ({ ...current, [testAfter]: '正在测试连接…' }))
    }
    try {
      const result = await saveSettingsAndSecrets(
        () => window.tripwise.updateSettings({
          model: {
            provider: modelProvider,
            baseUrl,
            model: modelProvider === 'codex-cli' ? 'gpt-6-luna' : model
          },
          sourceProxyUrl,
          connectors,
          xiaohongshu: {
            ...xiaohongshu,
            args: openCliArgsText.split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean)
          },
          researchBrowserVisualRead,
          mcpServers: snapshot.settings.mcpServers
        }),
        () => window.tripwise.saveSecrets({
          modelKey: modelKey || undefined,
          amapKey: amapKey || undefined,
          amapJsKey: amapJsKey || undefined,
          amapSecurityCode: amapSecurityCode || undefined,
          exaKey: exaKey || undefined,
          tavilyKey: tavilyKey || undefined,
          firecrawlKey: firecrawlKey || undefined,
          clearModelKey,
          clearAmapKey,
          clearAmapJsKey,
          clearAmapSecurityCode,
          clearExaKey,
          clearTavilyKey,
          clearFirecrawlKey
        })
      )
      if (result.kind === 'secrets-failed') {
        onSaved(result.snapshot)
        throw new Error(`普通设置已保存，但密钥保存失败：${errorMessage(result.error)}`)
      }
      const next = result.snapshot
      setModelKey('')
      setAmapKey('')
      setAmapJsKey('')
      setAmapSecurityCode('')
      setExaKey('')
      setTavilyKey('')
      setFirecrawlKey('')
      setClearModelKey(false)
      setClearAmapKey(false)
      setClearAmapJsKey(false)
      setClearAmapSecurityCode(false)
      setClearExaKey(false)
      setClearTavilyKey(false)
      setClearFirecrawlKey(false)
      onSaved(next)
      if (testAfter === true) {
        const result = await window.tripwise.testModel()
        setStatus(result.message)
        if (!result.ok) onError(result.message)
        onSaved(await window.tripwise.getSnapshot())
      } else if (typeof testAfter === 'string') {
        const result = await window.tripwise.testBuiltinConnector(testAfter)
        setConnectorTestResults((current) => ({ ...current, [testAfter]: result.message }))
        if (!result.ok) onError(result.message)
        onSaved(await window.tripwise.getSnapshot())
      } else {
        setStatus('设置已保存。')
      }
    } catch (reason) {
      const message = errorMessage(reason)
      if (typeof testAfter === 'string') {
        setConnectorTestResults((current) => ({ ...current, [testAfter]: message }))
      }
      setStatus(message)
      onError(message)
    } finally {
      setBusy(false)
    }
  }

  /** 切换设置分类时清除上一类的结果提示，避免旧错误误挂到新页面。 */
  function changeSettingsTab(nextTab: SettingsTab): void {
    if (nextTab === activeTab) return
    setStatus('')
    setActiveTab(nextTab)
  }

  /** 按标准页签键盘模式移动焦点，只让当前页签进入 Tab 序列。 */
  function handleSettingsTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentTab: SettingsTab): void {
    const currentIndex = SETTINGS_TABS.indexOf(currentTab)
    let nextIndex: number | null = null

    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % SETTINGS_TABS.length
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = SETTINGS_TABS.length - 1
    if (nextIndex === null) return

    event.preventDefault()
    const nextTab = SETTINGS_TABS[nextIndex]
    changeSettingsTab(nextTab)
    document.getElementById(`settings-tab-${nextTab}`)?.focus()
  }

  // 低频连接器折叠时仍显示启用数量，方便用户快速确认当前配置。
  const enabledConnectorCount = CONNECTOR_CATALOG.filter((connector) => connectors[connector.key]).length

  return <Modal title="设置" onClose={onClose}>
    <div className="settings-tabs" role="tablist" aria-label="设置分类">
      <button id="settings-tab-model" role="tab" tabIndex={activeTab === 'model' ? 0 : -1} aria-selected={activeTab === 'model'} aria-controls="settings-panel-model" onKeyDown={(event) => handleSettingsTabKeyDown(event, 'model')} onClick={() => changeSettingsTab('model')}>模型</button>
      <button id="settings-tab-sources" role="tab" tabIndex={activeTab === 'sources' ? 0 : -1} aria-selected={activeTab === 'sources'} aria-controls="settings-panel-sources" onKeyDown={(event) => handleSettingsTabKeyDown(event, 'sources')} onClick={() => changeSettingsTab('sources')}>信息源</button>
      <button id="settings-tab-advanced" role="tab" tabIndex={activeTab === 'advanced' ? 0 : -1} aria-selected={activeTab === 'advanced'} aria-controls="settings-panel-advanced" onKeyDown={(event) => handleSettingsTabKeyDown(event, 'advanced')} onClick={() => changeSettingsTab('advanced')}>高级</button>
    </div>

    <section id="settings-panel-model" className="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab-model" hidden={activeTab !== 'model'}>
      <section className="settings-section settings-model-section">
        <label className="form-label">模型来源<select value={modelProvider} onChange={(event) => setModelProvider(event.target.value as ModelProvider)}>
          <option value="openai-compatible">OpenAI 兼容 API</option>
          <option value="codex-cli">Codex</option>
        </select></label>
        {modelProvider === 'codex-cli' ? <div className="codex-model-summary"><strong>GPT-6 Luna · max</strong><span>使用本机 Codex 持续会话</span></div> : <>
          {snapshot.secrets.modelKeySaved ? <details className="settings-disclosure">
            <summary>更换 API Key</summary>
            <section className="settings-section"><label className="form-label">API Key<input type="password" value={modelKey} onChange={(event) => setModelKey(event.target.value)} placeholder="留空保持不变" autoComplete="new-password" /></label></section>
          </details> : <label className="form-label">API Key<input type="password" value={modelKey} onChange={(event) => setModelKey(event.target.value)} placeholder="粘贴服务商 Key" autoComplete="new-password" /></label>}
          <div className="credential-row"><span className="credential-state"><span className={snapshot.secrets.modelKeySaved && !clearModelKey ? 'state-green' : ''} />{clearModelKey ? '保存后清除 Key' : credentialStateLabel(snapshot.secrets.modelKeySaved)}</span>{snapshot.secrets.modelKeySaved && <button className="text-button danger-link" onClick={() => setClearModelKey((value) => !value)}>{clearModelKey ? '取消' : '清除'}</button>}</div>
          <details className="settings-disclosure">
            <summary>接口参数</summary>
            <section className="settings-section">
              <label className="form-label">服务地址<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" autoComplete="url" /></label>
              <label className="form-label">模型名称<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="例如 glm-5.3-flash" autoComplete="off" /></label>
            </section>
          </details>
        </>}
      </section>
    </section>

    <section id="settings-panel-sources" className="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab-sources" hidden={activeTab !== 'sources'}>
      <details className="settings-disclosure">
        <summary>网页搜索</summary>
        <section className="settings-section">
          <BuiltinCredentialField label="Exa API Key" value={exaKey} saved={snapshot.secrets.exaKeySaved} clearing={clearExaKey} onValueChange={setExaKey} onClearingChange={setClearExaKey} testProvider="exa" testResult={connectorTestResults.exa} onTestResultClear={() => clearConnectorTestResult('exa')} onTest={() => void save('exa')} busy={busy} />
          <BuiltinCredentialField label="Tavily API Key" value={tavilyKey} saved={snapshot.secrets.tavilyKeySaved} clearing={clearTavilyKey} onValueChange={setTavilyKey} onClearingChange={setClearTavilyKey} testProvider="tavily" testResult={connectorTestResults.tavily} onTestResultClear={() => clearConnectorTestResult('tavily')} onTest={() => void save('tavily')} busy={busy} />
          <BuiltinCredentialField label="Firecrawl API Key" value={firecrawlKey} saved={snapshot.secrets.firecrawlKeySaved} clearing={clearFirecrawlKey} onValueChange={setFirecrawlKey} onClearingChange={setClearFirecrawlKey} testProvider="firecrawl" testResult={connectorTestResults.firecrawl} onTestResultClear={() => clearConnectorTestResult('firecrawl')} onTest={() => void save('firecrawl')} busy={busy} />
          <p className="privacy-inline">预约、开放和交通等信息会交叉搜索；其他查询按需回退。测试可能使用服务额度。</p>
        </section>
      </details>
      <details className="settings-disclosure">
        <summary>地图与路线</summary>
        <section className="settings-section">
          <BuiltinCredentialField label="高德 Web 服务 Key" value={amapKey} saved={snapshot.secrets.amapKeySaved} clearing={clearAmapKey} onValueChange={setAmapKey} onClearingChange={setClearAmapKey} testProvider="amap" testResult={connectorTestResults.amap} onTestResultClear={() => clearConnectorTestResult('amap')} onTest={() => void save('amap')} busy={busy} />
          <BuiltinCredentialField label="高德 JS API Key" value={amapJsKey} saved={snapshot.secrets.amapJsKeySaved} clearing={clearAmapJsKey} onValueChange={setAmapJsKey} onClearingChange={setClearAmapJsKey} />
          <BuiltinCredentialField label="高德 JS API 安全密钥" value={amapSecurityCode} saved={snapshot.secrets.amapSecurityCodeSaved} clearing={clearAmapSecurityCode} onValueChange={setAmapSecurityCode} onClearingChange={setClearAmapSecurityCode} />
          <p className="privacy-inline">地图在线加载；更换 JS Key 后需重启。</p>
        </section>
      </details>
      <details className="settings-disclosure settings-connector-disclosure">
        <summary>规划数据来源<span>{enabledConnectorCount}/{CONNECTOR_CATALOG.length} 已启用</span></summary>
        <div className="connector-settings-list">{CONNECTOR_CATALOG.map((connector) => <ConnectorSettingRow
          key={connector.key}
          item={connector}
          enabled={connectors[connector.key]}
          status={connectorActivity(trip, connector.key, connector.kind, connectors[connector.key], snapshot.secrets.amapKeySaved)}
          onChange={(enabled) => setConnectors((current) => ({ ...current, [connector.key]: enabled }))}
        />)}</div>
      </details>
    </section>

    <section id="settings-panel-advanced" className="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab-advanced" hidden={activeTab !== 'advanced'}>
      <details className="settings-disclosure">
        <summary>数据与隐私</summary>
        <div className="privacy-card" role="note" aria-labelledby="privacy-data-flow-title">
          <ShieldCheck size={16} />
          <div>
            <strong id="privacy-data-flow-title">数据去向</strong>
            <ul>
              <li><strong>模型</strong>：会收到本次对话、旅行信息、已保存行程和准备清单、本轮工具结果，以及引用来源的链接和摘要。导入网页的正文、页面声明的作者和发布时间也会发送。</li>
              <li><strong>搜索与网页阅读</strong>：Exa 和 Tavily 会收到搜索词及各自的 API Key；DuckDuckGo 基础搜索和 Bing 网页栏搜索只收到搜索词。连接测试使用固定关键词。Firecrawl 只读取本旅行中已有的公开链接；测试会读取 example.com。它不抓取整站或小红书页面。</li>
              <li><strong>天气</strong>：Open-Meteo 地理编码服务会收到城市名称；天气服务会收到匹配坐标和查询日期。</li>
              <li><strong>地图与路线</strong>：地点查询会发送城市、关键词或附近坐标；路线查询会发送起终点、交通方式和可用的日期、时间，Web Key 随请求发送。已确认坐标、路线估时和来源会写入旅行资料及备份。JS Key 会提供给在线地图脚本，安全密钥由本机代理注入。高德公开协议尚未明确授权个人桌面 Agent、向模型传递及保存/导出结果的组合场景，公开发行前需取得书面许可。</li>
              <li><strong>网页与代理</strong>：内置右侧网页使用独立会话，不读取 Chrome 登录状态。Agent 可导航、读取文字、滚动、展开公开内容和提交同站 GET 搜索；不会登录、处理验证码、发布、预约、购买、下载或执行页面脚本。若启用网页图像识别，截图先经过无旅行资料的模型能力测试，通过后才发送当前网页视口；截图不保存，识别结果只是线索。</li>
              <li><strong>小红书（可选）</strong>：启用后，用户配置的 OpenCLI 可通过 Browser Bridge 操作已登录的 Chrome 页面。Chrome Cookie 不导入 Tripwise 配置或旅行资料；OpenCLI 和扩展以当前账户权限运行。笔记链接可能带访问参数，并保存在旅行资料中。</li>
              <li><strong>MCP 插件（可选）</strong>：本机 MCP 程序以当前账户权限运行，没有系统级沙箱；它能读取已配置的环境变量密钥。获准工具会收到模型生成的查询，可能包含旅行信息。部分失败查询参数会保存在来源记录和旅行备份中。密钥筛查不完整，请勿在查询中输入密码、令牌或 API Key。</li>
              <li><strong>Codex</strong>：使用本机登录；按话题保留会话。Tripwise 工具运行在应用内，本机文件和 Codex 工具保持关闭。</li>
            </ul>
          </div>
        </div>
      </details>
      <details className="settings-disclosure">
        <summary>本机文件与日志</summary>
        <section className="settings-section credential-storage-choice">
          <div className="settings-heading"><span className="settings-icon"><ShieldCheck size={16} /></span><div><strong>API Key 文件</strong><p>保存在本机，不访问系统钥匙串</p></div></div>
          <p className="storage-warning-copy">文件为明文 JSON，同一账户下的程序可能读取。旧版加密文件不会自动迁移或删除。<code>{snapshot.secrets.credentialFilePath}</code></p>
          {snapshot.secrets.credentialFileRecoveryRequired && <div className="storage-warning" role="status"><ShieldCheck size={16} /><span>凭证文件格式无效；原文件已保留。修复后重新载入。</span></div>}
          <div className="settings-action-row">
            <button className="secondary-button" disabled={busy} onClick={() => void openLocalCredentialFile()}><FolderOpen size={14} />{busy ? '处理中…' : '重新载入配置'}</button>
            <button className="secondary-button" onClick={() => void openSystemLogDirectory()}><FolderOpen size={14} />打开日志</button>
          </div>
          <p className="privacy-inline">日志不保存对话、工具参数、网页地址或密钥。</p>
        </section>
      </details>
      <details className="settings-disclosure">
        <summary>网络代理</summary>
        <section className="settings-section">
          <label className="form-label">代理地址<input type="url" value={sourceProxyUrl} onChange={(event) => setSourceProxyUrl(event.target.value)} placeholder="留空使用系统代理" autoComplete="url" /></label>
          <p className="privacy-inline">仅转发搜索、天气、地图和网页请求；模型请求直连。请只使用可信代理。</p>
        </section>
      </details>
      <details className="settings-disclosure">
        <summary>浏览器与小红书</summary>
        <section className="settings-section connector-settings">
          <div className={researchBrowserVisualRead ? 'connector-setting-row connector-enabled' : 'connector-setting-row'}>
            <div className="connector-setting-icon"><Eye size={15} /></div>
            <div className="connector-setting-copy"><strong>网页图像识别</strong><p>文字不足时把当前网页截图交给模型；截图不保存。</p></div>
            <label className="connector-toggle" title={researchBrowserVisualRead ? '关闭网页图像识别' : '启用网页图像识别'}>
              <input type="checkbox" checked={researchBrowserVisualRead} onChange={(event) => setResearchBrowserVisualRead(event.target.checked)} />
              <span className="connector-toggle-track" /><span className="sr-only">{researchBrowserVisualRead ? '已启用' : '已关闭'}网页图像识别</span>
            </label>
          </div>
          <section className="settings-section xiaohongshu-settings">
            <div className="connector-setting-row">
              <div className="connector-setting-icon"><Search size={15} /></div>
              <div className="connector-setting-copy"><strong>小红书公开笔记</strong><p>使用 OpenCLI 和已登录的 Chrome。</p><span>{xiaohongshuActivity(trip, xiaohongshu)}</span></div>
              <label className="connector-toggle" title={`${xiaohongshu.enabled ? '关闭' : '启用'}小红书连接器`}><input type="checkbox" checked={xiaohongshu.enabled} onChange={(event) => setXiaohongshu((current) => ({ ...current, enabled: event.target.checked }))} /><span className="connector-toggle-track" /><span className="sr-only">{xiaohongshu.enabled ? '已启用' : '已关闭'}小红书连接器</span></label>
            </div>
            <label className="form-label">OpenCLI 路径<input value={xiaohongshu.command} onChange={(event) => setXiaohongshu((current) => ({ ...current, command: event.target.value }))} placeholder="程序绝对路径" autoComplete="off" /></label>
            <button className="secondary-button opencli-path-button" onClick={() => void chooseOpenCliCommand()}><FolderOpen size={14} />选择程序</button>
            <label className="form-label">启动参数<textarea rows={2} value={openCliArgsText} onChange={(event) => setOpenCliArgsText(event.target.value)} placeholder="每行一项；通常留空" /></label>
          </section>
        </section>
      </details>
      <details className="settings-disclosure">
        <summary>自定义工具（MCP）</summary>
        <McpSettings snapshot={snapshot} trip={trip} onSaved={onSaved} onError={onError} />
      </details>
    </section>

    {status && <Announcement role="status" className={`settings-status ${status.includes('成功') || status.includes('保存') ? 'success' : ''}`}>{status}</Announcement>}
    <div className="modal-footer"><button className="secondary-button" onClick={onClose}>关闭</button><button className="primary-button" disabled={busy} onClick={() => void save(false)}>{busy ? '保存中…' : '保存'}</button><button className="test-button" disabled={busy} onClick={() => void save(true)}>{busy ? '处理中…' : '保存并测试'}</button></div>
  </Modal>
}


/** 展示内置服务凭证状态，并在编辑时撤销待清除标记。 */
function BuiltinCredentialField({ label, value, saved, clearing, onValueChange, onClearingChange, testProvider, testResult, onTestResultClear, onTest, busy = false }: {
  label: string
  value: string
  saved: boolean
  clearing: boolean
  onValueChange: (value: string) => void
  onClearingChange: (clearing: boolean) => void
  testProvider?: BuiltinConnectorTestId
  testResult?: string
  onTestResultClear?: () => void
  onTest?: () => void
  busy?: boolean
}) {
  return <>
    <label className="form-label">{label}<input
      type="password"
      disabled={busy}
      value={value}
      onChange={(event) => {
        onValueChange(event.target.value)
        onTestResultClear?.()
        if (clearing) onClearingChange(false)
      }}
      placeholder={saved ? '已配置；如需更换请输入新 Key' : '粘贴服务商提供的 Key'}
      autoComplete="new-password"
      spellCheck={false}
    /></label>
    <div className="credential-row">
      <span className="credential-state"><span className={saved && !clearing ? 'state-green' : ''} />{clearing ? '保存后清除已保存的 Key' : credentialStateLabel(saved)}</span>
      {saved && <button className="text-button danger-link" disabled={busy} onClick={() => { onClearingChange(!clearing); onTestResultClear?.() }}>{clearing ? '取消清除' : '清除 Key'}</button>}
    </div>
    {testProvider && onTest && <div className="credential-test-row">
      <button className="test-button" disabled={busy || clearing} onClick={onTest}>保存并测试连接</button>
      {testResult && <span role="status" className={`credential-test-result ${testResult.includes('成功') ? 'success' : ''}`}>{testResult}</span>}
    </div>}
  </>
}

/** 用明确状态说明凭证是否写入本机配置文件。 */
function credentialStateLabel(saved: boolean): string {
  return saved ? '已保存' : '未配置'
}

interface EnvironmentDraft {
  key: string
  value: string
}

/** 让用户配置本机或远程 MCP 服务，并逐项批准只读工具。 */
function McpSettings({ snapshot, trip, onSaved, onError }: {
  snapshot: AppSnapshot
  trip: Trip | null
  onSaved: (snapshot: AppSnapshot) => void
  onError: (message: string) => void
}) {
  const [serverId, setServerId] = useState('')
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [url, setUrl] = useState('')
  const [authType, setAuthType] = useState<'none' | 'header' | 'query'>('none')
  const [authName, setAuthName] = useState('Authorization')
  const [authEnvKey, setAuthEnvKey] = useState('MCP_AUTH_TOKEN')
  const [authSecretValue, setAuthSecretValue] = useState('')
  const [useAmapKey, setUseAmapKey] = useState(false)
  const [environment, setEnvironment] = useState<EnvironmentDraft[]>([])
  const [enabled, setEnabled] = useState(false)
  const [tools, setTools] = useState<McpToolDescriptor[]>([])
  const [allowedTools, setAllowedTools] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  /** 将保存的非敏感服务配置载入表单，密钥只显示已保存状态。 */
  function editServer(server: McpServerSettings): void {
    setServerId(server.id)
    setName(server.name)
    setTransport(server.transport ?? 'stdio')
    setCommand(server.command)
    setArgsText(server.args.join('\n'))
    setUrl(server.url ?? '')
    const auth = server.auth ?? { type: 'none' as const }
    setAuthType(auth.type)
    setAuthName(auth.type === 'none' ? 'Authorization' : auth.name)
    setAuthEnvKey('envKey' in auth ? auth.envKey : 'MCP_AUTH_TOKEN')
    setUseAmapKey(auth.type === 'query' && 'credential' in auth && auth.credential === 'amapKey')
    setAuthSecretValue('')
    setEnvironment(server.envKeys.map((key) => ({ key, value: '' })))
    setEnabled(server.enabled)
    setAllowedTools(server.allowedTools)
    setTools([])
    setStatus('')
  }

  /** 清空表单并开始录入新服务。 */
  function newServer(): void {
    setServerId('')
    setName('')
    setTransport('stdio')
    setCommand('')
    setArgsText('')
    setUrl('')
    setAuthType('none')
    setAuthName('Authorization')
    setAuthEnvKey('MCP_AUTH_TOKEN')
    setAuthSecretValue('')
    setUseAmapKey(false)
    setEnvironment([])
    setEnabled(false)
    setAllowedTools([])
    setTools([])
    setStatus('')
  }

  /** 填入高德官方 MCP 远程端点，沿用地图设置中已保存的 Web 服务 Key。 */
  function useAmapPreset(): void {
    setServerId('')
    setName('高德地图')
    setTransport('streamable-http')
    setCommand('')
    setArgsText('')
    setUrl('https://mcp.amap.com/mcp')
    setAuthType('query')
    setAuthName('key')
    setAuthSecretValue('')
    setUseAmapKey(true)
    setEnvironment([])
    setEnabled(false)
    setAllowedTools([])
    setTools([])
    setStatus('')
  }

  /** 统一构造预检和保存输入；renderer 密钥在 IPC 返回后立即清空。 */
  function buildInput(approved: string[], turnOn: boolean): McpServerInput {
    const auth: McpServerAuth | undefined = transport === 'stdio' ? undefined
      : useAmapKey
        ? { type: 'query', name: 'key', credential: 'amapKey' }
        : authType === 'none' ? { type: 'none' }
          : { type: authType, name: authName, envKey: authEnvKey }
    const credentials = transport === 'stdio' ? environment
      : authType !== 'none' && !useAmapKey
        ? [...environment.filter((item) => item.key !== authEnvKey), { key: authEnvKey, value: authSecretValue }]
        : []
    return {
      ...(serverId ? { id: serverId } : {}),
      name,
      transport,
      command: transport === 'stdio' ? command : '',
      args: transport === 'stdio' ? argsText.split('\n').map((item) => item.trim()).filter(Boolean) : [],
      ...(transport === 'stdio' ? {} : { url, auth }),
      enabled: turnOn,
      allowedTools: approved,
      environment: credentials.filter((item) => item.key.trim()).map((item) => ({ key: item.key.trim(), value: item.value }))
    }
  }

  /** 保存服务参数与临时输入的密钥；renderer 随即清除密钥文本。 */
  async function persist(approved = allowedTools, turnOn = enabled): Promise<string> {
    const input = buildInput(approved, turnOn)
    const next = await window.tripwise.saveMcpServer(input)
    const saved = next.settings.mcpServers.find((item) => item.id === serverId) ?? next.settings.mcpServers.at(-1)
    if (!saved) throw new Error('MCP 服务保存后未出现在设置中。')
    onSaved(next)
    setServerId(saved.id)
    const savedAuth = saved.auth ?? { type: 'none' as const }
    setUseAmapKey(savedAuth.type === 'query' && 'credential' in savedAuth && savedAuth.credential === 'amapKey')
    setAuthEnvKey('envKey' in savedAuth ? savedAuth.envKey : 'MCP_AUTH_TOKEN')
    setEnvironment(saved.envKeys.map((key) => ({ key, value: '' })))
    setAuthSecretValue('')
    setStatus('服务配置已保存在本机。')
    return saved.id
  }

  /** 临时测试配置的本机进程，发现工具后关闭；此操作不保存设置或新密钥。 */
  async function discover(): Promise<void> {
    setBusy(true)
    setStatus('')
    try {
      const discovered = await window.tripwise.testMcpServer(buildInput(allowedTools, enabled))
      const safeTools = discovered.filter((tool) => tool.readOnly && !tool.destructive)
      const approved = allowedTools.filter((tool) => safeTools.some((item) => item.name === tool))
      setTools(discovered)
      setAllowedTools(approved)
      setStatus(`连接成功，发现 ${discovered.length} 项工具。配置尚未保存；只有明确标记为只读且非破坏性的工具可以启用。`)
    } catch (reason) {
      const message = errorMessage(reason)
      setStatus(message)
      onError(message)
    } finally {
      setBusy(false)
    }
  }

  /** 保存已发现工具的逐项授权与服务启用状态。 */
  async function saveAuthorizations(): Promise<void> {
    setBusy(true)
    setStatus('')
    try {
      await persist(allowedTools, enabled)
      setStatus(allowedTools.length ? '插件授权已保存。' : '服务配置已保存；选择只读工具后才会参与规划。')
    } catch (reason) {
      const message = errorMessage(reason)
      setStatus(message)
      onError(message)
    } finally {
      setBusy(false)
    }
  }

  /** 删除服务配置并清除其关联密钥。 */
  async function removeServer(server: McpServerSettings): Promise<void> {
    if (!window.confirm(`删除“${server.name}”并清除它保存的密钥？`)) return
    setBusy(true)
    try {
      onSaved(await window.tripwise.removeMcpServer(server.id))
      if (serverId === server.id) newServer()
    } catch (reason) {
      const message = errorMessage(reason)
      setStatus(message)
      onError(message)
    } finally {
      setBusy(false)
    }
  }

  const endpointReady = transport === 'stdio' ? !!command.trim() : !!url.trim()
  const authRequired = transport !== 'stdio' && authType !== 'none'
  const authReady = !authRequired || (useAmapKey
    ? snapshot.secrets.amapKeySaved
    : !!authSecretValue || !!snapshot.secrets.mcpSecretsSaved[serverId]?.includes(authEnvKey))
  const canTest = !!name.trim() && endpointReady && authReady

  return <section className="settings-section mcp-settings">
    <div className="settings-heading"><span className="settings-icon"><Plug size={16} /></span><div><strong>自定义工具（MCP）</strong><p>接入地点、路线、天气和攻略等外部数据工具。</p></div></div>
    <div className="mcp-security-note"><ShieldCheck size={15} /><span>{transport === 'stdio'
      ? '本机服务会以当前账户权限运行，命令和参数保存在本机设置中。'
      : '远程服务会收到模型生成的查询，内容可能包含旅行日期和地点；仅连接你信任的 HTTPS 服务。认证值保存在本机凭证文件，并只发送到此服务。'} 获准工具的结果会进入旅行资料和模型上下文，部分失败查询参数会保存在来源记录和旅行备份。只有声明为只读且非破坏性的工具可以启用；来源内容仍需核对。</span></div>

    {snapshot.settings.mcpServers.length > 0 && <div className="mcp-server-list">
      {snapshot.settings.mcpServers.map((server) => {
        const activity = mcpServerActivity(trip, server)
        return <div className={`mcp-server-row ${serverId === server.id ? 'active' : ''}`} key={server.id}>
          <button className="mcp-server-select" onClick={() => editServer(server)}>
            <strong>{server.name}</strong>
            <span>{server.enabled ? '规划时启用' : '已停用'} · 已授权 {server.allowedTools.length} 项工具</span>
            <small className={`mcp-server-activity ${activity.status}`}>{activity.label}</small>
            {activity.detail && <small className="mcp-server-activity-detail">{activity.detail}</small>}
          </button>
          <button className="text-button danger-link" disabled={busy} onClick={() => void removeServer(server)}>删除</button>
        </div>
      })}
    </div>}

    <div className="mcp-form-heading"><strong>{serverId ? '编辑工具服务' : '添加工具服务'}</strong>{serverId && <button className="text-button" onClick={newServer}>新建服务</button>}</div>
    <div className="mcp-form-grid">
      <label className="form-label">服务名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：攻略搜索" /></label>
      <label className="form-label">连接方式<select value={transport} onChange={(event) => {
        const next = event.target.value as McpTransport
        setTransport(next)
        if (next !== 'stdio') setUseAmapKey(false)
      }}><option value="stdio">本机程序（stdio）</option><option value="streamable-http">远程 HTTP（Streamable）</option><option value="sse">远程 HTTP（SSE）</option></select></label>
    </div>
    {transport === 'stdio' ? <>
      <label className="form-label">启动命令<input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="例如：npx、uvx 或绝对路径" autoComplete="off" /></label>
      <label className="form-label">启动参数（每行一项；不经过 shell）<textarea rows={3} value={argsText} onChange={(event) => setArgsText(event.target.value)} placeholder={'-y\n@publisher/travel-mcp'} /></label>
      <div className="mcp-env-heading"><span>密钥环境变量</span><button className="text-button" onClick={() => setEnvironment((items) => [...items, { key: '', value: '' }])}><Plus size={12} /> 添加</button></div>
      {environment.map((item, index) => <div className="mcp-env-row" key={`${serverId}-${index}`}>
        <input aria-label="环境变量名称" value={item.key} onChange={(event) => setEnvironment((items) => items.map((row, rowIndex) => rowIndex === index ? { ...row, key: event.target.value.toUpperCase() } : row))} placeholder="例如：API_KEY" />
        <input aria-label="环境变量密钥" type="password" value={item.value} onChange={(event) => setEnvironment((items) => items.map((row, rowIndex) => rowIndex === index ? { ...row, value: event.target.value } : row))} placeholder={snapshot.secrets.mcpSecretsSaved[serverId]?.includes(item.key) ? '已配置；留空保留' : '粘贴密钥'} autoComplete="new-password" />
        <button className="icon-button danger" aria-label="移除环境变量" onClick={() => setEnvironment((items) => items.filter((_, rowIndex) => rowIndex !== index))}><Trash2 size={14} /></button>
      </div>)}
    </> : <>
      <label className="form-label">MCP 地址<input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" autoComplete="url" /></label>
      <div className="mcp-form-grid">
        <label className="form-label">认证方式<select value={useAmapKey ? 'amap' : authType} onChange={(event) => {
          if (event.target.value === 'amap') {
            setUseAmapKey(true)
            setAuthType('query')
            setAuthName('key')
          } else {
            setUseAmapKey(false)
            setAuthType(event.target.value as 'none' | 'header' | 'query')
          }
        }}><option value="none">无</option><option value="header">请求头密钥</option><option value="query">查询参数密钥</option><option value="amap">高德 Web 服务 Key</option></select></label>
        {authType !== 'none' && <label className="form-label">{useAmapKey ? '高德认证参数' : authType === 'header' ? '请求头名称' : '参数名称'}<input value={authName} disabled={useAmapKey} onChange={(event) => setAuthName(event.target.value)} placeholder={authType === 'header' ? 'Authorization' : 'key'} /></label>}
      </div>
        {authType !== 'none' && !useAmapKey && <label className="form-label">认证密钥<input aria-label="MCP 认证密钥" type="password" value={authSecretValue} onChange={(event) => setAuthSecretValue(event.target.value)} placeholder={snapshot.secrets.mcpSecretsSaved[serverId]?.includes(authEnvKey) ? '已配置；留空保留' : '粘贴服务密钥'} autoComplete="new-password" /></label>}
      {useAmapKey && <p className={`mcp-credential-status ${snapshot.secrets.amapKeySaved ? 'configured' : ''}`}>{snapshot.secrets.amapKeySaved ? '将使用地图设置中已保存的高德 Web 服务 Key。' : '高德 Web 服务 Key 尚未配置，请先在上方地图设置中保存。'}</p>}
    </>}
    {!serverId && <button className="text-button mcp-amap-preset" onClick={useAmapPreset}>使用高德官方 MCP 配置</button>}

    {tools.length > 0 && <div className="mcp-tools-list">
      <div className="mcp-env-heading"><span>发现的工具 · 默认不启用</span><span>{allowedTools.length} 项已批准</span></div>
      {tools.map((tool) => {
        const selectable = tool.readOnly && !tool.destructive
        return <label className={`mcp-tool-option ${selectable ? '' : 'unavailable'}`} key={tool.name}>
          <input type="checkbox" checked={allowedTools.includes(tool.name)} disabled={!selectable} onChange={(event) => setAllowedTools((current) => event.target.checked ? [...current, tool.name] : current.filter((item) => item !== tool.name))} />
          <span><strong>{tool.name}</strong><small>{tool.description || (selectable ? '已声明只读。' : '未声明为只读或标记为破坏性操作，不能启用。')}</small></span>
          <em>{selectable ? '只读' : tool.destructive ? '破坏性' : '未声明只读'}</em>
        </label>
      })}
    </div>}

    <label className="mcp-enable-row"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>在后续旅行规划中使用已批准工具</span></label>
    {status && <Announcement role="status" className={`settings-status ${status.includes('已保存') || status.includes('发现') ? 'success' : ''}`}>{status}</Announcement>}
    <div className="mcp-actions"><button className="secondary-button" disabled={busy || !canTest} onClick={() => void discover()}>{busy ? '连接中…' : '测试连接并发现工具'}</button><button className="primary-button" disabled={busy || !name.trim() || !endpointReady || (enabled && !authReady)} onClick={() => void saveAuthorizations()}>{busy ? '保存中…' : '保存插件授权'}</button></div>
  </section>
}

/** 显示所选旅行中该插件最近实际调用结果，不把未调用误报为健康。 */
function mcpServerActivity(trip: Trip | null, server: McpServerSettings): { status: string; label: string; detail: string } {
  const provider = `MCP · ${server.name}`
  const latest = trip?.sources
    .filter((source) => source.kind === 'plugin' && (source.connectorId === server.id || (!source.connectorId && source.provider === provider)))
    .sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt))[0]
  if (!latest) return { status: 'unknown', label: '本旅行尚无运行记录', detail: '' }
  return {
    status: latest.status === 'success' ? 'success' : 'failure',
    label: `本旅行最近运行 · ${statusLabel(latest.status)} · ${formatTime(latest.fetchedAt)}`,
    detail: latest.status === 'success' ? '' : latest.summary
  }
}

interface ConnectorCatalogItem {
  key: keyof ConnectorSettings
  label: string
  provider: string
  kind: SourceRecord['kind']
  icon: ReactNode
}

const CONNECTOR_CATALOG: ConnectorCatalogItem[] = [
  { key: 'webSearch', label: '网页搜索', provider: 'Exa / Tavily → DuckDuckGo', kind: 'web', icon: <Search size={15} /> },
  { key: 'weather', label: '天气预报', provider: 'Open-Meteo', kind: 'weather', icon: <Sun size={15} /> },
  { key: 'places', label: '地点搜索', provider: '高德地图', kind: 'place', icon: <MapPin size={15} /> },
  { key: 'routes', label: '路线估时', provider: '高德 Web 服务', kind: 'route', icon: <Route size={15} /> }
]

/** 展示当前内置连接器的开关与本旅行最近一次来源状态。 */
function ConnectorSettingRow({ item, enabled, status, onChange }: {
  item: ConnectorCatalogItem
  enabled: boolean
  status: string
  onChange: (enabled: boolean) => void
}) {
  return <article className={`connector-setting-row ${enabled ? 'connector-enabled' : ''}`}>
    <div className="connector-setting-icon">{item.icon}</div>
    <div className="connector-setting-copy"><strong>{item.label}<small>{item.provider}</small></strong><span>{status}</span></div>
    <label className="connector-toggle" title={`${enabled ? '关闭' : '启用'}${item.label}`}><input type="checkbox" checked={enabled} onChange={(event) => onChange(event.target.checked)} /><span className="connector-toggle-track" /><span className="sr-only">{enabled ? '已启用' : '已关闭'}{item.label}</span></label>
  </article>
}

/** 有新来源时显示其状态；无历史记录时不把“已启用”误说成“连接成功”。 */
function connectorActivity(
  trip: Trip | null,
  key: keyof ConnectorSettings,
  kind: SourceRecord['kind'],
  enabled: boolean,
  hasAmapKey: boolean
): string {
  if (key === 'places' && enabled && !hasAmapKey) return '未连接 · 需配置高德 Web 服务 Key'
  if (key === 'routes' && enabled && !hasAmapKey) return '未连接 · 需配置高德 Key'
  const latest = latestConnectorSource(trip?.sources ?? [], key, kind)
  const activity = latest
    ? `${statusLabel(latest.status)} · ${formatTime(latest.fetchedAt)}`
    : '尚无本旅行查询记录'
  return `${enabled ? '已启用' : '已关闭'} · ${activity}`
}

/** 显示小红书插件的最近旅行结果，不把配置存在误报成连接成功。 */
function xiaohongshuActivity(trip: Trip | null, settings: OpenCliSettings): string {
  if (!settings.enabled) return '已关闭'
  if (!settings.command) return '未配置 · 请填写 OpenCLI 命令路径'
  const latest = trip?.sources
    .filter((source) => source.provider.startsWith('OpenCLI · 小红书'))
    .sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt))[0]
  return latest
    ? `${statusLabel(latest.status)} · ${formatTime(latest.fetchedAt)}${latest.status === 'success' ? '' : ` · ${latest.summary}`}`
    : '已配置 · 本旅行尚无查询记录'
}
