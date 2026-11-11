# ADR-0001：桌面应用外壳

| 项 | 内容 |
|---|---|
| 状态 | Accepted；当前源码使用 Electron 45.2.3 + React/Vite；三平台目标系统安装验证仍未完成。已保存的候选包仍基于 Electron 44.10.2，尚未重建。 |
| 日期 | 2026-10-17 |
| 关联 | [TECH](../TECH.md)、[UI/UX](../UIUX.md)、PR-12 |

## 背景

首版目标是 macOS、Windows、Linux 桌面端。用户已选定左侧旅行栏、中央对话、右侧网页/来源的工作区；来源研究需要网页面板，但外部网页属于不可信内容。桌面框架选择会影响三平台网页行为、安装体积、权限隔离、系统集成和维护方式。

Travel Agent 的公开 Web UI 规格采用 React/Vite 前端并可在浏览器和 Electron renderer 展示，属于贴近本产品的实现参照；它不能证明其当前运行质量或适合 Tripwise 的分发规模。官方 Electron 指南要求收紧 renderer 权限、隔离上下文和控制 IPC；Tauri 的系统 WebView 文档表明三平台使用不同 WebView 实现。

## 决策

首版桌面外壳采用 **Electron + React/Vite**，将旅行 UI、应用服务和外部网页分到不同权限边界：

- Tripwise UI renderer 不启用 Node 能力；本地能力仅经窄范围、类型化 IPC 暴露。
- 网页研究内容运行在独立且受限的 web contents/session 中，不共享 Tripwise renderer 的本地权限；默认不共享账户会话。
- 正式打包时关闭 `ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS` 和 Node Inspector 启动入口；只从 `app.asar` 加载应用，并在 macOS/Windows 启用嵌入式 ASAR 完整性校验。此设置不能替代代码签名或安装包来源验证。
- 外部页面不能通过提示词、DOM 或链接获得 Tripwise 本地文件、凭证或工具权限。
- 登录态网站连接器另行定义授权方式，不把“页面能打开”视为“可以自动提取内容”。
- 主 renderer 与研究网页使用独立的 WebContentsView/session；主窗口 IPC 只接受受信任主框架调用。
- 生产启动使用 Electron 单实例锁。重复启动不初始化旅行数据与 IPC；主进程将现有窗口恢复并聚焦，避免同一资料目录被多个应用进程并发修改。隔离端到端测试使用独立锁名和临时资料目录。
- 2026-09-21 已在 macOS 构建机重建三平台候选包并核对容器、ASAR 与 Electron Fuse；macOS 打包版桌面 E2E 通过。Windows/Linux 未在原生系统启动，安装/升级差异仍需原生验收；macOS 只有 ad-hoc 签名，正式签名与公证仍是发布门槛。

## 后果

### 正面

- 可沿用核心竞品的 React/Vite 与 Electron 组合经验，减少旅行工作区和可见网页之间的技术分歧。
- Chromium 渲染版本由应用控制，减少同一网页在不同系统 WebView 下的行为差异。
- Electron 主/renderer 进程边界便于明确划分 UI、系统能力和不可信网页。

### 代价

- 安装包和运行时占用通常会比轻型系统 WebView 外壳更大；本项目尚无实测数字。
- 需持续跟进 Chromium/Electron 更新、代码签名、发布和安全配置。
- 进程隔离配置错误仍可能扩大网页内容的风险，需专门审查和平台验证。

## 替代方案

### Tauri 2

优势是使用系统 WebView，应用不捆绑完整 Chromium；代价是 macOS、Windows、Linux 使用不同 WebView 版本和实现，内嵌研究页面可能表现不一致。它是候选，不因包体优势直接排除；若多数任务使用系统浏览器/手工导入而非内嵌网页，可重新评估。

### 仅使用系统浏览器

可减少应用内网页权限边界和嵌入维护，但会削弱用户在右侧查看“网页/来源”的连续体验，也不方便对照页面与计划。可作为无法嵌入时的后备打开方式，不作为默认布局。

### 以系统浏览器插件作为全部网页研究入口

可以复用用户浏览器环境，但要求用户安装扩展并授权，跨浏览器分发和帮助成本更高；也不能覆盖所有不需要登录的通用网页。因此只作为特定登录态来源的评估路径。

## 人工审计

| 检查项 | 需要的证据 | 关闭标准 |
|---|---|---|
| Electron 安全隔离 | 已实现独立 WebContentsView、权限/下载/弹窗拒绝、主框架 IPC 来源校验及打包 Fuse 限制；仍需发布前安全复核 | 2026-09-21 三平台候选 Fuse 与 ASAR 校验通过；macOS 打包版 E2E 通过，Windows/Linux 原生运行和稳定签名仍待复核 |
| 三平台适配 | macOS、Windows、Linux 打包及网页面板演练 | 三平台候选包已构建；每平台仍需原生系统完成核心流程并记录阻塞项 |
| 框架适配 | 和 Tauri 在真实目标设备上的安装/网页行为比较 | 团队接受体积、升级和系统差异，并记录取舍 |

## 参考

- [Travel Agent Web UI SPEC](https://github.com/Prism-Shadow/travel-agent/blob/main/packages/web/SPEC.md)（访问：2026-10-16）— 同类旅行桌面/网页工作区；参考其共享 Web UI 方向，不假定其运行效果已实测。
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)、[Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)、[Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model)（访问：2026-10-16）— 官方安全边界和进程资料；应用必须落实相应配置并实测。
- [Tauri WebView Versions](https://v2.tauri.app/reference/webview-versions/)（访问：2026-10-16）— 官方说明 Tauri 各桌面平台采用的 WebView 类型；不包含 Tripwise 自身的性能对比。
