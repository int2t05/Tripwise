# ADR-0011：将高德远程地图脚本放入独立沙箱

| 项 | 内容 |
|---|---|
| 状态 | 已实现，待人工审阅；高德供应商许可仍受 ADR-0010 约束 |
| 日期 | 2026-10-19 |
| 关联 | [TECH](../TECH.md)、[PRD](../../PRD.md)、[ADR-0010](0010-map-provider-compatibility.md)、PR-06、PR-08、PR-11 |

## 背景

高德 JS API 是在线远程脚本。此前脚本直接加载在 React 主 renderer；该页面有 `window.tripwise`，可访问主进程明确开放给 UI 的旅行操作。因此只靠 CSP 允许高德域名，不能隔离高德脚本与旅行数据及应用 IPC。

Electron 官方安全建议把非信任内容与应用权限分开，并为嵌入页面使用 sandbox。Tripwise 需要保留路线地图在行程工作区中的嵌入体验，同时支持地图 SDK 需要的 DOM、脚本、图块网络和有限状态交互。运行环境中 renderer 从 `file://` 加载；端到端试验确认，opaque-origin sandbox iframe 直接引用 `file://` JS/CSS 会被 Electron 拒绝，日志为 `Not allowed to load local resource`。

## 决策

将地图拆为独立 `amap-map.html` 构建入口，并放入 `sandbox="allow-scripts"` iframe。iframe 不设置 `allow-same-origin`、没有 preload，不可访问父窗口或 Tripwise API；其 origin 为 opaque `null`。地图 JS API Key 和本机受限代理路径由主界面通过有界 `postMessage` 传入。主界面只接收来自当前 iframe 且 origin 为 `null` 的回传，并校验消息类型和当前行程中的 stop ID。

使用既有 `AmapMapProxy` 的回环 HTTP server 托管地图页面和静态依赖。服务绑定 `127.0.0.1`，地图静态文件通过 256-bit 随机路径访问，且只读取构建 HTML 实际引用的 JS/CSS 名称；这不是通用文件服务器。相同服务的 API 路径仍固定为高德地图端点，由主进程添加安全密钥。地图页面 CSP 仅开放本机静态资源、高德 JS API、地图图块域和固定高德 API 代理。主 renderer CSP 不开放高德脚本或图块域，只允许嵌入本机地图页。

地图 iframe 仅获得当日停靠点名称、编号、GCJ-02 坐标、选择状态和当前路线预览折线。它不能读取整份行程、来源、对话、模型凭证或旅行数据库。高德 SDK 作为远程脚本仍会处理显示地图所需的地图状态；供应商数据流与本地留存许可继续遵循 ADR-0010。

## 后果

### 正向

- 高德脚本不再与拥有 Tripwise preload 的主 React renderer 共处一个 JavaScript 上下文。
- 主界面 CSP 移除高德远程脚本权限，地图页的网络权限可单独审阅。
- 消息边界限制了地图交互能够传回主界面的内容。
- 不需要重排三栏布局或在主进程中同步维护地图控件的位置。

### 代价

- 新增地图 HTML 入口、窄消息契约和地图页面 CSP；需要同时维护主页面和地图页的生产构建。
- 地图界面显示时，本机回环服务器会托管少量静态构建资源；应用退出时关闭服务。
- 真实高德账号和真实地图脚本联测仍未完成；当前自动验收只验证地图页加载、消息安全边界和无凭证时不联系远端服务。

## 未选方案

- **让 AMap SDK 继续运行在主 renderer：** 实现最简单，但远程供应商脚本可访问整个 Tripwise preload API，安全边界不足。
- **在 `file://` 页面中直接加载 opaque-origin iframe 的本地 Vite 文件：** 已在真实 Electron E2E 中试验，Chromium 拒绝本地脚本、样式资源。
- **给 iframe 同时启用 `allow-scripts allow-same-origin`：** 可能让资源加载恢复，但失去 opaque origin 隔离条件，不采用。
- **独立 `WebContentsView` 地图：** 可提供独立 webContents 和更细的 preload，但需让主进程实时维护面板尺寸、遮挡和地图交互 IPC，增加与窗口布局耦合；目前 iframe 的沙箱已提供地图所需隔离，故不采用。

## 验收

- `npm run check`：48 个 Vitest 文件、315 项测试、TypeScript 和生产构建通过。
- `npm run test:e2e:desktop`：真实 Electron 地图页通过回环服务器加载；iframe `window.origin === 'null'`，没有 `window.tripwise`，且不能读取父窗口 `tripwise`；页面控制台无错误。
- 资源服务器只响应当前构建 HTML 引用的 JS/CSS 名称；测试确认未引用文件返回 404，API 测试确认静态资源请求不调用高德上游。
- 生产构建的主页面 CSP 不允许 AMap 域名；地图页面 CSP 单独放行高德服务。
- 高德真实账号联测、供应商场景许可和三平台安装包交互仍按 PRD/AUD-05、AUD-06 待完成。

## 参考

- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security/)（访问日期 2026-10-19）— Electron 主进程和 renderer 权限边界；Tripwise 保留 sandbox、contextIsolation 和最小 preload，并将远程地图脚本从主工作区隔离。
- [Electron Web Embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds)（访问日期 2026-10-19）— Electron 嵌入网页机制及隔离选择；Tripwise 需要地图嵌入在行程布局内，因此选择 sandbox iframe，未选择额外 WebContentsView。
- [Vite Multi-Page App](https://vite.dev/guide/build.html#multi-page-app)（访问日期 2026-10-19）— 多 HTML 入口构建方式；Tripwise 用于独立生成主工作区与地图页。
- [高德地图 JS API 2.0 加载说明](https://lbs.amap.com/api/javascript-api-v2/guide/abc/load)（访问日期 2026-10-19）— 官方地图脚本在线加载；Tripwise 在线加载，不把高德脚本打包进应用。
