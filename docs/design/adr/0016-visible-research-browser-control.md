# ADR-0016：Agent 控制可见研究浏览器

本 ADR 的 DOM 工具、安全与网络边界继续有效；网页内指针和当前动作显示以 [ADR-0019](0019-browser-scoped-computer-use.md) 为准。

| 项 | 内容 |
|---|---|
| 状态 | 已采纳；当前工具范围见 [ADR-0019](0019-browser-scoped-computer-use.md) |
| 日期 | 2026-10-19 |
| 关联需求 | PR-02、PR-11、AUD-09 |

## 背景

Tripwise 已有隔离的右侧 `WebContentsView`，也支持用户配置本机 stdio MCP。两条路径此前没有连接：Agent 的 `read_webpage` 通过 HTTP 抽取，外部 Browser MCP 会启动独立浏览器，其网络不经过研究网页出口保护器，不能展示 Agent 正在查看的同一页面。用户需要让 Agent 阅读动态网页，同时从界面看到它访问的页面并能停止操作。

## 决策

- 在 Tripwise Agent 工具注册表中加入内置研究网页工具，直接操作右侧研究 `WebContentsView`：
  - `research_browser_navigate`：打开用户可见的普通公网 HTTP(S) 页面。
  - `research_browser_snapshot`：读取可见正文、页面声明元数据、最多 30 个安全链接和最多 20 个临时交互目标；模型输出最多 12,000 字符。
  - `research_browser_scroll`：向上或向下滚动 1–3 屏。
  - `research_browser_interact`：仅使用最近快照的临时编号，对同站 GET 搜索框提交搜索字段与查询词，或点击固定标签的展开按钮；不序列化表单里的其他字段，之后必须重新读取快照。
- 仅当网页搜索连接器启用且研究网页出口保护就绪时，才向模型公开这些工具。导航、快照、滚动和交互共用串行队列；导航使用本机研究网页 Session、DNS/目标 IP 校验和代理出口保护。
- 工具执行时，renderer 自动显示右侧网页栏并锁定网页/来源切换和面板收起。提供“停止规划”操作；取消信号中止模型任务并调用 WebContents `stop()`。停止会取消整轮规划，不只停止单次页面动作；已完成的来源仍保留。
- 页面文字、链接、页面声明作者和发布时间都作为不可信资料。快照来源加入当前 Trip，供模型引用和用户复核。敏感查询参数与片段会在 Agent 恢复点、来源链接及输出链接中清理；页面正文仍可能含站点发布的访问信息，按普通不可信内容处理。
- 快照、滚动和交互校验脚本在 Electron 独立隔离 JavaScript world 中运行，避免网页主世界覆盖内建函数后影响 DOM 读取；脚本固定在应用代码中，不接受模型提供的 CSS、JavaScript 或任意表单字段。目标编号仅对最近一次快照有效，并在执行时重新检查页面、可见性、控件标签、同站关系和 GET 方法。
- Agent 不获得通用桌面 Computer Use、坐标点击、任意按键、自动登录或凭证填写。用户可在可见的临时 WebView 手动浏览并导入当前页文字；Session 仅驻留内存，关闭应用清除，也不复用系统浏览器 Cookie。Agent 可导航到公开页面或快照中可见链接；交互限于有限滚动、同站 GET 搜索和指定展开按钮。不开放发布、点赞、收藏、评论、预约、购买、下载。Agent 运行期间拒绝非 GET/HEAD 请求。网页内容始终是不可信资料；Agent 不绕过验证码、访问限制或站点授权。
- 右侧网页面板是实际浏览过程的可见反馈，原有“Agent 正在浏览”、停止规划和来源卡继续复用，不增加独立窗口或重复状态标签。进度列表区分站内搜索、展开、成功和失效目标；查询词不进入进度文字。
- 该路径使用 Tripwise 的 OpenAI-compatible function calling 接口，是内置 Agent 工具，不是可单独配置或供其他客户端连接的第三方 Browser MCP Server。外部 MCP 服务仍按 ADR-0006 管理，不能因此宣称它已接入右侧研究页面。

## 考虑过的方案

| 方案 | 决定 |
|---|---|
| 继续只用 HTTP 网页抽取 | 不作为唯一方式。部分动态页面依赖浏览器渲染；HTTP 阅读继续作为 Firecrawl 等渠道保留。 |
| 直接配置 Microsoft Playwright MCP | 不用于右侧研究页面。它启动独立浏览器会话，用户无法在当前面板看到同一页面，且其子进程网络不会走本机研究网页出口保护。 |
| 在通用 MCP 中放开所有浏览器点击/输入工具 | 不采用。工具声明的只读标记不能证明实际行为；点击、输入、提交和下载可能改变站点或账户状态，也难以逐动作显示和授权。 |
| 让 Agent 控制现有隔离 WebView | 采用。没有新增浏览器进程或运行依赖，复用可见页面、权限拒绝和出口保护；只允许可验证的公开 GET 搜索和限定标签展开动作。 |

## 验证

- `npm run typecheck` 通过。
- `npx vitest run tests/research-browser-tools.test.ts tests/agent-firecrawl-browser-fallback.test.ts` 通过，覆盖工具暴露、目标编号、搜索词边界、URL 验证/清理、来源生成和滚动边界。
- 桌面 E2E 用本机假网页验证展开正文、重新读取快照、同站 GET 搜索、用户后退/前进/刷新、手动导入当前页、临时 Session，以及页面内指针定位到已校验的展开目标；动作栏不显示搜索词，运行结束后清除标记。不请求真实旅行网站。
- `tests/agent-firecrawl-browser-fallback.test.ts` 验证 Firecrawl HTTP 402 后只读一页、右侧浏览器工具事件、正文进入模型上下文和计划继续交付；浏览器及搜索/抽取服务使用受控替身，不代表真实站点验收。
- 以上结果不覆盖真实旅行网站、提示注入攻击、Windows/Linux 目标机、屏幕阅读器或第三方 Browser MCP 接管同一页面。

## 后果与待办

- 公开页面搜索框若使用 POST、动态控件不在标签白名单、需要认证或验证码，Agent 不会自动操作；用户可在当前临时会话内手动浏览并导入资料。会话关闭后不会保留登录态。小红书开放平台当前文档的快速接入能力以用户基本信息为主，没有提供笔记搜索接口；网页兜底仅限当前会话可访问的内容，不绕过站点访问限制。
- 页面内容仍可能包含提示注入；Agent 系统规则要求将其视为不可信证据，但模型防护并不构成确定性隔离。真实网站测试应覆盖可见正文、链接、错误页面、敏感链接和恶意页面指令。
- “停止规划”取消整轮模型任务。取消后保留已完成来源；当前未完成浏览器调用可由用户重试或另发消息恢复。
- 若未来确需第三方 Browser MCP Server 与右侧 WebView 互操作，应单独评审 MCP transport、工具权限、图像结果、并发导航、平台支持及页面副作用；不得直接让外部 MCP 进程获得 WebContents、Node 或 renderer IPC。

## 参考

- [Electron WebContentsView API](https://www.electronjs.org/docs/latest/api/web-contents-view)
- [Electron WebContents API：隔离世界脚本与 stop](https://www.electronjs.org/docs/latest/api/web-contents)
- [Electron Security Tutorial](https://www.electronjs.org/docs/latest/tutorial/security)
- [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)
- [Playwright MCP：页面快照与交互工作流](https://github.com/microsoft/playwright/blob/main/docs/src/getting-started-mcp.md)
- [Playwright BrowserContext：隔离非持久会话](https://playwright.dev/docs/api/class-browsercontext)
- [小红书开放平台快速接入](https://openaccount.xiaohongshu.com/docs/quick-start)
- [ADR-0006：本机 MCP stdio 插件接入](0006-mcp-stdio-connectors.md)
