# 旅行规划 Agent：开源竞品与渠道参考库

**研究基线：** 2026-10-17；小红书官方接口复核更新至 2026-10-19

**状态：** PRD 方向审计的研究基线；开源公开资料比较已完成，运行时和合规审计未完成

**覆盖：** 旅行规划产品、跨平台桌面 Agent、插件/工具路由、社媒及网页采集、地图天气交通、用户公开反馈

**后续产品决策：** 本文第 4 节记录“暂不先做远程 MCP/SSE”的研究建议；后续根据用户对渠道可扩展性的确认，已采用 stdio 与远程 Streamable HTTP、自动协商 MCP 2026 协议及旧协议回退，并保留旧 SSE 兼容。当前实现和安全边界以 [MCP ADR-0006](../design/adr/0006-mcp-stdio-connectors.md) 为准；此注释保留原研究判断的时间语境。

## 1. 结论先行

### 产品竞争判断

1. **存在高度重合的桌面直接竞品。** [Prism-Shadow/travel-agent](https://github.com/Prism-Shadow/travel-agent) 公开展示 macOS/Windows/Linux 桌面端、聊天旁浏览器、小红书攻略到高德路线，以及携程网页预订到付款前交给用户。它已覆盖本项目的多端桌面、自然语言起步、旅行上下文、方案理由和渠道演示。其规格把预订交易作为中心，并明确拒绝把“行程规划工作区”本身作为产品；因此有竞争重合，也存在任务重心差异。README 自称开发预览、安装包未签名且完整预订流验收仍在进行；这些是项目自述，不等于独立测试结论。
2. **“多渠道 + 交叉验证”也已有旅行 Agent 实现。** [huahuanao/travel-agent](https://github.com/huahuanao/travel-agent) 将小红书游记、大众点评商户和高德 POI/路线组合成 11 个工具，分来源采集并处理冲突、源故障降级；它是 CLI/Agent host 工作流，须自行准备 Node、Python、API key、本地抓取服务并登录。README 同时记录小红书自动化会超时、大众点评上游解析失效，说明渠道广度与可靠性不是一回事。
3. **结构化证据与版本化重规划已有高重合参考。** [RoutePilot](https://github.com/tiammomo/RoutePilot) 将问答、来源与检索轨迹、行程快照、验证报告和版本化重规划组织为 Artifact；其 Provider Gateway 涵盖高德 POI/路线/营业时间/天气。它是 Web 工作台且公开方案架构较重。来源追溯、行程版本和验证本身不能作为独占差异。
4. **来源追溯、交互式修改和路线管理已有多处样例。** [JourneyPilot](https://github.com/Lagom-TA/JourneyPilot) 汇集来源、路线、天气、地图和报告；[trip-decider](https://github.com/Hugin-Z/trip-decider) 区分 sourced、estimated、conflicting、unknown；[Itinerary Workspace](https://github.com/Jameszhao1103/itinerary-workspace) 将地图、时间线与助手修改预览放进同一行程状态；[MyTripPlanner](https://github.com/Prot10/MyTripPlanner) 展示字段级 diff 和撤销；[TREK](https://github.com/liketrek/TREK) 提供路线/行程管理与插件扩展参考。
5. **多渠道是高价值能力，也是维护负担。** [Agent-Reach](https://github.com/Panniantong/Agent-Reach) 的思路是为平台选后端、检查渠道健康和 fallback；[OpenCLI](https://github.com/jackwener/OpenCLI) 展示以站点 adapter 扩展命令的方式。可借鉴“连接器目录 + 能力声明 + 健康检查 + 输出规范化”，不要把“支持了多少渠道”误当成稳定性、合规性或用户价值。
6. **小红书渠道应设为独立风险门。** 官方授权范围页面当前只开放 basic_info，read_notes 仍列为规划中；公开 API 目录没有可依赖的通用笔记搜索/读取接口。OpenCLI 复用用户控制的 Chrome 会话，提供搜索和笔记读取，但结果依赖易变化的 DOM；近期有登录墙、验证码和筛选布局问题。Tripwise 因此把 OpenCLI 做成默认关闭的只读试点，并保留粘贴/导入回退；该实现不等于平台授权或长期可用承诺。[官方授权范围](https://openaccount.xiaohongshu.com/docs/scope)、[官方 API 参考](https://openaccount.xiaohongshu.com/docs/api-reference)、[Agent-Reach XHS 后端对照](https://github.com/Panniantong/Agent-Reach/blob/main/agent_reach/skill/references/social.md)、[OpenCLI 小红书适配器](https://github.com/jackwener/OpenCLI/blob/e6174a952c763a836a9bb0dd2f097d2962b3876b/docs/adapters/browser/xiaohongshu.md)。

### 可验证的产品机会（推断，待试点验证）

相对 Travel Agent，Tripwise 已将以下方向实现为工作台流程：把用户保存/粘贴的攻略纳入旅行资料，确认地点后加入地图和时间线同步的日程；把抵离时间、固定地点、步行强度和已知开放时间放入可见的可行性检查；对修改显示差异、锁定已确认项，并从方案生成准备建议。它将交易 Agent 转成规划工作台，但“来源证据、同步地图、版本修改、分渠道检索”分别已有开源样例；整体差异和用户价值仍待真实旅行任务验证，不能宣称市场空白。

## 2. 调研方法与证据边界

- 以公开 GitHub 仓库、README、架构/工具文档、Issues/Discussions 以及公开用户帖为主要资料；重点查看项目宣称的用户流程、连接器、权限/登录方式、行程结构、审阅修改和已知边界。
- 对核心竞品除阅读 README、规格和架构文档外，还通过 GitHub 代理将 12 个高相关仓库浅克隆到临时目录，固定记录 HEAD 和许可，并抽查连接器、证据、计划版本及界面状态代码。克隆仅用于只读研究，没有将竞品源码复制进 Tripwise。未在本轮运行竞品、不做实机操作；README/演示按项目自述处理，代码静态阅读不等于端到端验证。
- 项目 star、commit 和版本会变化；未用它们推断需求规模。分级只表示和本项目的相关度，不代表代码质量或推荐依赖。
- Reddit/公开讨论是自选样本，个别帖子可能带有项目推广属性。它们可用于发现问题和语言线索，不能代表旅行者总体比例。
- 列入参考库不代表建议直接抓取、复用代码或绕过平台限制；逐项核对 License、服务条款、个人信息规则和 API 使用范围是后续接入前置条件。

### 2.1 只读源码检查快照

以下 commit 是本轮浅克隆时检视的版本，commit 链接用于复现定位。只读检查了列出的源码/测试路径；没有运行这些项目，也没有复制其实现。许可证只按仓库根目录文件记录，不能代替逐文件版权核查。

| 仓库（检视 commit / 日期） | 根许可 | 实际抽查路径 | 对 Tripwise 的工程启发 |
|---|---|---|---|
| [Travel Agent `dd0ac16`](https://github.com/Prism-Shadow/travel-agent/tree/dd0ac16e1dc3d01a908cfaa907afdbcafdebe589)（2026-09-08） | Apache-2.0（内嵌高德 Skill 声明 MIT） | `SPEC.md`、`packages/web/SPEC.md`、`packages/skills/skills/amap-lbs-skill/index.js`、`packages/skills/skills/trip-workspace/SKILL.md`、`packages/core/src/environment/mcp/config.ts`、`packages/server/src/http/routes/agent-config.ts`、`packages/server/test/agent-config-mcp-servers.test.ts`、`packages/server/src/interaction/service.ts`、trip/session services | 旅行上下文、浏览器选择和待确认交互值得借鉴；MCP 支持 stdio/HTTP/SSE，并有不落盘连接预检。高德 Skill 展示 POI/地理编码/路线封装，但它走旧 v3 接口，不能代替当前 API 文档。 |
| [Agent-Reach `94f06c1`](https://github.com/Panniantong/Agent-Reach/tree/94f06c1969dfc1834001269d79d3ad0972d9dee6)（2026-10-08） | MIT | `channels/base.py`、`channels/xiaohongshu.py`、`backends/opencli.py`、`integrations/mcp_server.py`、`skill/SKILL.md`、XHS setup guide、credential-boundary tests | 渠道有有序后端、独立健康探测和可操作状态；Agent-Reach 自带 MCP 目前只暴露 `get_status`，实际搜索/读取由 Skill 指引调用 OpenCLI 或其他上游工具，因此不能直接作为 Tripwise 的 XHS 搜索 MCP 服务。XHS 桌面与服务端方案依赖不同登录方式；健康检查不把“服务可达”伪装成“实际笔记能力已验证”。 |
| [huahuanao/travel-agent `3ed18b4`](https://github.com/huahuanao/travel-agent/tree/3ed18b4c57444df843580ae94ad9297e1ebf4959)（2026-10-01） | MIT | `docs/architecture.md`、`.pi/extensions/travel-tools/`、known issues/recovery | 其三角验证将 UGC 观点、商户存在性和地图事实分工；依赖本地 MCP 与登录态，复杂度及站点故障要对用户显式化。 |
| [RoutePilot `dc9f4c8`](https://github.com/tiammomo/RoutePilot/tree/dc9f4c8ed5f63723186d5ce9942bc9c6db902197)（2026-07-15） | MIT | `apps/web/src/entities/run/reducer.ts`、run persistence 和 artifact presentation | 运行状态使用序号、生命周期、待输入/待批准与候选/已发布 artifact 分离；Tripwise 可先借鉴清楚的候选/已确认文案，不必引入其服务端 run 架构。 |
| [JourneyPilot `20a79d5`](https://github.com/Lagom-TA/JourneyPilot/tree/20a79d5f27f9366b77970ba1741ed0b0dba97f7f)（2026-10-08） | MIT | `entities/request_contract.py`、`entities/intent_spec.py`、`entities/coverage_disclosure.py` | 严格的输入条款台账可区分已映射、未解决和不支持约束；适合作后续方案覆盖检查，不应把自由文本直接当已满足。 |
| [itinerary-workspace `6049216`](https://github.com/Jameszhao1103/itinerary-workspace/tree/6049216e200418867d4e496f52c1a69cd65d5139)（2026-05-21） | MIT | `public/app/route-state.js`、`map.js`、计划编辑与冲突 UI | 结构化 itinerary 驱动地图/时间线；选择和冲突可在多个视图同步。Tripwise 也已实现按日地图、地点互选和路线估时；仍缺道路几何与地图拖拽编辑。 |
| [trip-decider `a2e0aa3`](https://github.com/Hugin-Z/trip-decider/tree/a2e0aa3c3e0b53f1b7c03c7c8a2bca64af8ba6cf)（2026-09-20） | MIT | `src/trip_decider/evidence_core.py`、`evidence_broker.py`、`adapters/contracts.py` | 将事实支持度、来源新鲜度和失败后的旧数据复用分开建模；动态事实需显示更新时间，缓存命中不能标作新鲜查询。 |
| [MyTripPlanner `cc66d99`](https://github.com/Prot10/MyTripPlanner/tree/cc66d99ae9891bb6679261b86117056646129468)（2026-07-12） | AGPL-3.0-or-later | `src/agent/toolExecutors.js`、`src/components/ChatPanel.jsx` | 每次地点/日期工具操作返回可逆命令并显示逐项撤销，是局部修改 UX 的具体参考。其强 copyleft 许可意味着仅作分析参考，不能直接复制代码。 |
| [OpenCLI `e6174a9`](https://github.com/jackwener/OpenCLI/tree/e6174a952c763a836a9bb0dd2f097d2962b3876b)（2026-10-17） | Apache-2.0 | `clis/xiaohongshu/search.js`、`docs/adapters/browser/xiaohongshu.md`、search issues | 适配器通过可见页面输入、筛选、DOM 抽取和限量滚动搜笔记；主产品只能把它作为易变化的外部 CLI，固定允许命令并保留失败回退。没有复制上游实现。 |
| [TREK `1c05ee4`](https://github.com/liketrek/TREK/tree/1c05ee4b3ac9523c41ccdd3baad989ba48a7409a)（2026-09-26） | AGPL-3.0 | `client/src/store/pluginStore.ts`、`permissionsStore.ts`、server plugin permission tests | 插件是能力、权限、界面槽位和生命周期的组合，不只是一个 URL；其许可不适合作为 Tripwise 未审阅代码的直接依赖。 |
| [trip-tide `c18f10d`](https://github.com/Chendestiny/trip-tide/tree/c18f10d761dcb3645a9324bba991a17e61ac76c8)（2026-09-20） | 未发现仓库根许可证文件 | `backend/core/`、`backend/trip/`、`frontend/src/views/trip/`、开发说明 | 中国目的地和约束排程是相关方向；其自身开发记录也强调须以实际调用代码为准，并记录过未接入的死代码。没有明确许可证，不复用其源码。 |
| [china-travel-kit `81cf319`](https://github.com/tczyliu/china-travel-kit/tree/81cf3194cc8a2bfcf275f1525fc49be88a39d628)（2026-08-25） | MIT（另有 NOTICE/商标说明） | `china_travel_kit/validation.py`、`integrity.py`、`query.py`、`mcp.py`、城市数据 | 静态目的地资料应带 schema/完整性校验和来源；MCP 是数据接口的一种形式，不会自动提供实时营业或交通事实。 |

### 2.2 Travel Agent 高德路线源码观察

对照固定版本 [Travel Agent `dd0ac16`](https://github.com/Prism-Shadow/travel-agent/tree/dd0ac16e1dc3d01a908cfaa907afdbcafdebe589) 的 `packages/skills/skills/amap-lbs-skill/index.js` 与 `trip-workspace/SKILL.md`：

- 高德能力被拆成地点检索、地理编码、周边查询、路线和地图可视化入口；Key 从 Agent vault 读取，工具按意图调用。Tripwise 保留这种按任务/能力拆分的做法，路线请求由主进程代发；当前凭证存储已改为本地 JSON 文件，见 [ADR-0013](../design/adr/0013-local-json-credentials.md)。
- 该仓库被检查的路线脚本调用 `/v3/direction/...`，公交工具附带 `appname`，并可把地图任务 JSON 编码进可分享地图链接。Tripwise 没有复制这些脚本或地图页面。
- 高德当前 [路径规划 2.0 Web 服务文档](https://lbs.amap.com/api/webservice/guide/api/newroute)（页面标注最后更新 2026-06-17）列出 `/v5/direction/...`；公交路线必填起终点 `citycode`，可按日期/时刻查询，耗时通过 `show_fields=cost` 请求。故本项目实现使用 v5，地理编码仍按官方 `/v3/geocode/geo` 接口解析地点坐标。
- 体验差异：竞品的 Skill 面向 Agent 生成地图链接/计划文件；Tripwise 在地图相邻地点段显示用户点击获取的路线选项，来源与获取时间可查，只有点「采用」才写入新的不可变行程版本。路线结果按目的地、日期/明确时刻绑定，修改顺序或日期后旧估算会被清除。

以上是固定 commit 的静态代码观察，不代表本轮运行了 Travel Agent 或用其配置做了真实高德请求。根仓库许可与内嵌 Skill 的上游许可是不同层级；只作为实现/交互参考，不直接复用代码。

### 2.3 Travel Agent 与 Agent-Reach 源码审计：对当前工程的直接影响

本节是在 2026-10-17 对上述固定 commit 做的增量静态审计。只读查看源码和测试，不运行竞品，也不复制其代码。

| 对照点 | Travel Agent 源码证据 | Agent-Reach 源码证据 | Tripwise 当前状态与决策 |
|---|---|---|---|
| 插件接入 | `packages/core/src/environment/mcp/config.ts` 将 MCP 配置解析为 stdio、Streamable HTTP 和显式 SSE 三种 transport；`packages/server/src/http/routes/agent-config.ts` 的 `POST /mcp-test` 复用运行时 resolver、限制探测时间、临时建目录，发现后关闭客户端且不写 Agent 配置；对应测试覆盖有效配置、坏 transport、可达和不可达服务。 | `channels/base.py` 按平台选择后端；`integrations/mcp_server.py` 当前仅注册一个 `get_status` 工具。`skill/SKILL.md` 将 XHS 搜索路由到 `opencli xiaohongshu search`，读取需再调用上游工具。 | Tripwise 保留用户手动配置的 MCP stdio 和逐工具授权，同时增加固定命令的 OpenCLI XHS 适配器。Agent-Reach status MCP 不提供 XHS 内容，因此不作为该工具后端。 |
| 健康状态 | MCP 连接结果按服务器分别报告；连接关闭、取消和失败时有资源清理。 | `doctor.py` 对各 channel 单独捕获异常并清理 URL 凭证；XHS 将 installed/process-reachable/configured/real capability 分开措辞。`backends/opencli.py` 要求实时 loopback daemon + extension connection 才算 ready，磁盘文件存在不算连接成功。 | 当前设置页有显式发现按钮，运行时故障作为单条插件来源呈现，但没有持久化的最近检查时间/逐级健康状态。后续应提供单独的“检查连接”状态，不能把“工具可发现”理解为登录态、搜索权限或结果质量已验证。 |
| 凭证边界 | MCP 环境变量与服务配置分离；配置文件可包含 headers，但客户端侧需由用户自行负责保护。 | XHS 桌面后端复用用户控制的 Chrome；服务端 MCP 通过 Cookie-Editor 显式导入。`tests/test_doctor_credential_boundaries.py` 确认健康检查不会调用可能自动提取/刷新 Cookie 的命令；权限测试校验 Cookie 文件权限。 | 小红书工具不收集或传入 Cookie；由用户配置的 OpenCLI/Browser Bridge 使用用户已有 Chrome 会话。Tripwise 不自动登录或绕过限制；OpenCLI 程序以用户权限运行且没有 OS 级沙箱。 |
| 交互与旅行状态 | `packages/server/src/interaction/service.ts` 以会话为范围管理请求卡片；答案必须与卡片类型相符，任务结束时待处理问题会结清。`trip-workspace` Skill 约定旅行文件夹中 `trip.json` 与 `itinerary.md` 的写入责任，服务端只把模型推断出的目的地填入空字段，不能覆盖用户已确认值。 | 渠道状态返回可读提示和可执行修复方向，而不只返回布尔值。 | Tripwise 已把结构化行程、用户确认、来源与不可变版本交给确定性主进程管理。可借鉴“状态、下一步动作和事实分级”的表达，但不需要引入 Travel Agent 的多包服务端或完整 Agent 运行时。 |
| 浏览器 | `packages/skills/skills/penguin-browser/SKILL.md` 明确区分应用内浏览器与用户 Chrome；浏览器后端由会话显式选择，所选后端不可用时保持可见，不静默切换。Web SPEC 规定页面只展示可见内容，不把不可见页面当作事实。 | OpenCLI 接入用户已运行的 Chrome 扩展/daemon；只检测到扩展文件不能证明其已启用。 | Tripwise 的内置网页面板仍隔离且不登录；只有用户显式启用小红书适配器时才让配置的 OpenCLI 操作 Chrome。设置页解释会访问小红书、最近运行状态与失败，不会悄悄切换浏览器后端。 |

**落地优先级与当前状态（研究结论）：**

1. MCP 草稿预检已实现：不先写设置/密钥；显式启动、限时发现、关闭进程；展示每项工具的只读声明；逐项授权后保存。它沿用 Tripwise 的主进程权限与密钥边界。
2. 继续完善连接器状态词汇：区分“未配置、已配置、连接成功、能力待验证、上次失败”，显示独立检查时间和可执行的修复提示。当前有工具发现结果和按 Trip 记录的最近运行状态，但还没有逐级健康/能力验证体系。健康探测只读，不自动登录、不刷新凭证、不执行未知平台命令。
3. 对 XHS 保持可退回的用户供料流程（粘贴/导入链接和文本）。Chrome 会话适配器与本机 MCP 都必须独立审查安装权限、认证、站点政策、内容留存和异常关停；不同后端不能共用一个模糊的绿色“可用”标记。
4. 保持工具接口可扩展，但不为了渠道数量先做远端 MCP/SSE 或复杂插件市场。新增 transport 应有具体候选和威胁模型支撑；远端 URL、重定向、header secret 和网络访问目标需单独评审。

上述结论是从固定版本源码抽取的设计证据，不等价于这些实现已被运行验证，也不代表它们对第三方平台拥有授权。

## 3. 产品与竞品比较

| 项目 | 重合/参考点 | 可借鉴 | 差距或风险 |
|---|---|---|---|
| [Prism-Shadow/travel-agent](https://github.com/Prism-Shadow/travel-agent) | 桌面多端、聊天旁真实浏览器、小红书攻略→高德路线 demo、机酒网页流程；旅行对象跨多个会话 | 一句话开始、先聊后归入旅行、选项带理由、浏览器透明可见、旅行简报跨会话；本地可读旅行文件 | 产品主任务是网页交易并在付款前停下，明确拒绝“规划工作区”定位；行程/地图由模型文档输出，UI只读；整体预订流验收尚在进行 |
| [huahuanao/travel-agent](https://github.com/huahuanao/travel-agent) | 小红书 + 大众点评 + 高德；11 个旅行工具；三源交叉核验、失败降级 | 将游客观点、商户信息、地图事实区分；真实记录登录、超时、解析失效和 fallback | CLI/pi 工作流，不是桌面消费者 UI；需要本地服务、扫码登录、key 和多步安装；它的 XHS/点评依赖不能视作稳定服务 |
| [tiammomo/RoutePilot](https://github.com/tiammomo/RoutePilot) | 带来源问答、证据、结构化 TripSnapshot、行程校验、版本化重规划、高德 Provider | 问答先轻量、需要完整规划再补日期/人数/预算；明确 artifact 版本和校验结果 | Web 产品；架构包含多个 agent、持久任务、Postgres/Redis/RAG，复杂度高于当前 PRD 主张；端到端成熟度未独立验证 |
| [wangzhichuan123/trip-planner-agent](https://github.com/wangzhichuan123/trip-planner-agent) | LangGraph 并行查景点/天气/酒店/XHS；Amap 地图、推荐、预算、来源追溯和逐日行程 | 把检索进度做成前端事件；XHS 可选、不可用时走降级分支 | README/代码仓库显示仍是小型原型；4 commits、截图和真实运行能力未经本轮验证 |
| [Lagom-TA/JourneyPilot](https://github.com/Lagom-TA/JourneyPilot) | 多源调研、来源支持的行程、互动地图、天气、记忆、报告/PDF | 让行程、证据、地图和导出共享同一 delivery；运行可恢复、可取消、可编辑 | 需要配置多个 Provider 和服务；网页工作区而非桌面优先；中国本地渠道覆盖有限（项目自述） |
| [Hugin-Z/trip-decider](https://github.com/Hugin-Z/trip-decider) | 证据约束、12306/高德、事实核验、可审计行程 | 字段级证据状态、freshness 与 support 分离、unknown 不偷换为 false、版本安全 | README 限定端到端实测区域，航班/酒店来源未形成统一覆盖；低 star 不等于低质量，但社区采用证据有限 |
| [Jameszhao1103/itinerary-workspace](https://github.com/Jameszhao1103/itinerary-workspace) | 地图 + 时间线 + 对话式编辑；变更预览/拒绝；冲突审阅 | 单一结构化行程状态、先 preview 再 apply、问题修复队列和撤销 | 地图 Provider 示例偏 Google；更像编辑工作区，不主打多社媒采集 |
| [Prot10/MyTripPlanner](https://github.com/Prot10/MyTripPlanner) | 对话收集需求、即时构建行程、地图/通勤/酒店/餐饮、MCP | 结构化问询、工具操作后字段级 diff、撤销、工具 schemas、本地数据 | 公路旅行/欧美来源偏重；AGPL-3.0 对服务化衍生作品有要求，需做许可证审计 |
| [liketrek/TREK](https://github.com/liketrek/TREK) | 行程、地图、路线、预算、打包、多端/PWA、协作和插件 | 地图按天过滤、路线段时间、路由 provider 扩展、导出、路线失败回退 | 主要是旅行管理产品而非研究 Agent；需要把简单用户流程做轻 |
| [Chendestiny/trip-tide](https://github.com/Chendestiny/trip-tide) | 中国旅行规划、地图、确定性日程、LLM 建议 | 行程拆分、开放时间/用餐/住宿区作为结构化约束；维护者用项目经历解释为何将关键排程从自由工具调用改为确定性逻辑 | 维护者性能与旧流程比较是自述，不是独立基准；覆盖量/实用性需重新核验 |
| [tczyliu/china-travel-kit](https://github.com/tczyliu/china-travel-kit) | 中国目的地资料、来源信息、CLI/API/MCP/Skill | 数据新鲜度、可解释匹配、只读 MCP、无运行依赖数据查询 | Alpha；项目 README 说明为 56 个地点的预览数据，不是在线导航或预订服务 |
| [MyTripPlanner 的路线与互动 UI](https://github.com/Prot10/MyTripPlanner) | 多方案/路线和自然语言编辑 | 明确工具事件、行程实时视图、上下文持久化 | 其 GitHub README 中展示的运行能力未经本轮实测 |
| [Yyh3/china-travel-planner-skills](https://github.com/Yyh3/china-travel-planner-skills) | 中国行程 Skill，覆盖天气、地图、航班、铁路、小红书等 | 按任务组织工具/技能，跨来源工作流 | 技能包而不是面向普通旅行者的桌面应用；依赖来源接口 |

### 3.1 Travel Agent 对本 PRD 需求的逐项覆盖审计

判定依据为该仓库当前公开的 README、根 `SPEC.md`、`packages/web/SPEC.md`、架构文档和 `tasks/todo.md`。**目标中**只表示产品规格把它作为能力；不是本轮独立验证通过。**未见**表示这些公开材料没有证明相应产品能力；不能推断仓库私下绝无实现。

| PRD | Travel Agent 覆盖状态 | 公开证据与差距 |
|---|---|---|
| PR-01 对话收集简报 | 部分 | 无前置表单、可一句话开始；Trip 保存地点/日期/同行人/预算，共享约束 chips；规格没有航班抵离、住宿锚点、饮食/行李等完整字段流程。 |
| PR-02 多源检索与降级 | 部分 | 可在内置浏览器或用户 Chrome 操作旅行网站；XHS→Amap 有演示。浏览器后端可见、不可用不会静默切换；未见旅行连接器目录、逐来源健康/权限/替代入口。 |
| PR-03 事实来源/新鲜度 | 部分 | 根规格要求每个选项附理由，TODO 将 source-backed reasons 写入待完成的真实任务验收；未见营业、票务、天气等事实逐字段记录 URL、发布时间和抓取时间。 |
| PR-04 官方事实与 UGC 区分 | 未见 | XHS 演示证明用游客攻略，但公开规格没有事实/观点分类或冲突并列规则。 |
| PR-05 单份方案与连续修订 | 目标覆盖 | 根规格以收敛选项、逐项说明理由为核心；完整预订流仍是待验收目标。Tripwise 每轮生成一份草案并基于最近草案修订；比较诉求在方案内说明取舍，不并列生成多份。 |
| PR-06 结构化路线与时刻 | 部分 | Trip 目录可含 `itinerary.md`、可选 `places.json` 和地图图像；XHS demo 生成两日计划并打开地图链接。未见按开放时间/停留/缓冲/抵离锚点做统一时刻校验的规格。 |
| PR-07 局部修改、diff、撤销 | 部分/未见 | 可在后续对话中继续旅行任务；模型写 itinerary，但 Web UI 规格明说行程文档和地图只读，未见字段级变更预览、锁定项或撤销。 |
| PR-08 地图/时间线统一状态 | 部分 | 规格将地图定位为支持空间论点的证据；展示为模型产出的文件/链接，没有公开确认地图、日程和编辑器共享单一结构化状态。 |
| PR-09 天气、穿搭、行李、预约 | 未见 | 不是公开产品规格所列的规划能力；根 SPEC 明确拒绝把规划工作区作为产品定位。 |
| PR-10 雨天/低体力替代与就近餐饮 | 未见 | 在所读的产品/界面规格中未见对应的首要用户流程。 |
| PR-11 旅行来源插件管理 | 部分 | 有 Chrome 扩展作为浏览器后端，复用用户登录态；它不是面向旅行来源的连接器市场，也未见搜索/地图/天气等工具的消费者权限目录。 |
| PR-12 导出和删除 | 部分 | 旅行资料以本地普通文件保存、用户可读取；行程界面只读，删除 Trip 时保留已有用户文件。未见明确的行程导出向导和删除来源记录/凭证的完整产品流程。 |

### 3.2 从 Travel Agent 提炼的产品需求

以下是该仓库规格中明确写出的设计，不代表本轮已独立验证运行时。根 SPEC 将 Trip 设为一等对象：Trip 保存本地目录、地点/时间/同行者/预算和行程；对话是工作方式，可在聊出旅行意图后再明确加入 Trip。核心交互是一句话开始、减少选项并说明理由、等待用户点击确认；浏览器后端由每段对话明确选择，任务运行中不切换，也不在不可用时静默 fallback。仓库 README 另展示默认应用内浏览器与可选的用户 Chrome 扩展，二者各有独立浏览器资料/登录状态。来源： [根产品规格](https://github.com/Prism-Shadow/travel-agent/blob/main/SPEC.md)、[README](https://github.com/Prism-Shadow/travel-agent)。

| 提炼出的需求 | 本产品决定 | 原因与边界 |
|---|---|---|
| 允许用户从一句话或自由探索开始，之后再整理成旅行 | 采用 | 用户不必在知道目的地和日期之前先完成长表单。 |
| 旅行作为上下文容器；不同主题对话共享旅行身份和备注 | 采用并调整 | 保留聊天历史分离，日程、来源和准备项目进入同一结构化 Trip。 |
| 显示来源/浏览器当前状态；不隐藏认证与 backend 切换 | 采用 | 旅行数据检索的失败会影响用户决策；用户需要能识别登录失效、超时和替代路径。 |
| 候选项附理由，关键动作由用户确认 | 采用 | 路线差异、地点变更与影响需要解释；确认修改后再改变已选计划。 |
| 本地可读、用户可控的旅行文件 | 调整 | 桌面端本地优先保存；云模型和连接器的数据发送必须单独说明，不能把“本地保存”说成离线。 |
| 在网页上代填订单，最终停在付款页 | 不采用 | Tripwise 的工作终点是可接受的计划和准备清单；首版不做预订、支付或订单账本。 |
| 不做规划工作区，行程主要由模型文件/地图链接体现 | 不采用 | 这与本产品的主工作任务冲突；时间线、地图、来源和修改需要共享可编辑计划。 |

竞品的 Web UI SPEC 还明确关注草稿保留、加载/空/错误状态、键盘焦点和 Trip 卡片等实际交互细节；因此本产品“更美观”必须转成验收行为：用户看得懂当日时间/地点/交通，能恢复草稿，检索失败时知道下一步，浏览器/插件状态可辨认。该项目的公开规格不足以证明实际视觉质量或任务成功率；完整 UI 规格见 [Web UI SPEC](https://github.com/Prism-Shadow/travel-agent/blob/main/packages/web/SPEC.md)，完成度边界见 [TODO](https://github.com/Prism-Shadow/travel-agent/blob/main/tasks/todo.md)。

**用户体验审计：** 该项目的界面规格并不简单或粗糙：写明了中英文、旅行卡片与封面、旅行概览、草稿恢复、约束 chips、键盘焦点、移动窄屏设置、加载/空/错误状态等细节；规划桌面 UI 不能把“看起来更漂亮”当作充分差异。另一方面，开始前需配置模型 API key，Chrome 扩展当前从源码加载；README 对未签名安装包的系统警告和初始登录凭证有明确说明。它的规格强调对话和真实网页并排，不把地图/时间线作为主要编辑器；行程文档在 UI 中只读。真实视觉质量未做截图审阅，文档细节也不代表实际操作质量。

**相对该核心竞品可探索的特色（均为产品假设，不代表品类独占）：**

1. **从收藏到日程：** 用户粘贴/保存的链接先进入收件箱，提取地点并让用户确认；未定位内容仍保留在来源卡，不丢信息。
2. **先看修改再确认：** 方案卡突出与上一稿相比的地点、日期、时段和交通变化；解释本轮取舍，用户确认后再保存。
3. **日程是主界面：** 同一计划驱动每日时间线和地图；到达/离开时间、住宿区、开放时间、缓冲和体力强度触发可见检查，停留时间可自行调整。
4. **安全的多轮修改：** 用户锁定机票/预约/想去地点后，只重算受影响的日期；预览变化、保留旧版本并可撤销。
5. **一份计划带出准备：** 结合逐日天气和限制生成预约、穿搭、托运/随身行李、就近餐饮和替代活动，不把这些作为散落在长对话里的附录。
6. **渠道失败可理解、可继续：** 连接器用普通语言说明登录/配额/失效，失败时给重试、换来源、粘贴链接等动作；首次规划无需先安装一组插件。

**判断：** 这能形成与 Travel Agent 的产品重心差异，但多源证据、结构化行程、版本重规划和同步地图在其他开源项目中均有先例。真正可守的差异要体现在低配置门槛、国内渠道维护质量和把计划改到可执行的具体交互上；目前没有足够用户研究证明哪一项最有价值。

## 4. 可借鉴用户问题与替代方案

### 公开反馈信号

- [TREK Discussion #365](https://github.com/liketrek/TREK/discussions/365)：用户希望考虑点到点路程和景点停留时长，判断一天是否排得下。维护者回应停留时间缺少可靠数据库且因人而异，更适合把时长和时间线展示给用户，而不是假装优化器能保证可行。这支持“显示通勤数据 + 用户可调停留时长/缓冲”的设计。
- [TREK Issue #1962](https://github.com/liketrek/TREK/issues/1962)：多日地图同时显示全部地点、切换某天不能过滤/突出该日、地点缺少顺序编号。这说明地图与每天行程必须联动。该 issue 后续标注为修复中/已在下一版本，不代表同类问题普遍发生。
- [公开讨论：收藏地图地点与真正日程之间的断层](https://www.reddit.com/r/Travel_Planning/comments/1sz932c/do_you_plan_trips_from_saved_map_pins_or_build/)：发帖者用 7 天游程 Google Sheets，把地图 pins 转成按日行程，并提到备注、链接、住宿、成本、时间的组织问题。
- [公开讨论：社媒收藏失去上下文](https://www.reddit.com/r/travelplanning/comments/1v43lwq/does-anyone-else-have-hundreds-of-saved-travel/)：发帖者提到 Instagram/TikTok/Reddit 收藏、截图和 Google Maps pins 散落，社媒内容缺少地图位置上下文。这是一个个体/小样本信号，不能据此估算普及率。
- [公开讨论：用户依赖多个标签页和工具](https://www.reddit.com/r/travelplanning/comments/1uv4t8b/how_do_you_actually_plan_trips_these_days/)：帖子与评论提到 ChatGPT、Reddit、Google Maps、博客、航班搜索之间切换；Google Maps 常承担地点保存，Sheets/Docs/Notion/共享笔记承担日程。
- [公开讨论：按 Anchor / Fill / Backup 组织日程](https://www.reddit.com/r/travelplanning/comments/1vv2x9s/the_itinerary_hack_that_actually_saved_my_last/)：用户以每日核心活动、附近机动点和雨天/低体力备选降低过度排程与临时落空。

### 替代方案

1. **手工拼装：** Google/高德地图收藏 + 搜索/社媒 + Sheets/Docs/备忘录/群聊。成本是重复录入、难保持来源上下文和版本一致。
2. **综合旅行产品：** Trip.com 等站内推荐、酒店/机票和攻略内容；交易强，但跨平台来源整合和用户自选模型/插件不是其核心方向。
3. **通用对话模型：** 提供灵感和草稿，用户自行核实时间、地点、路线和数据时效；主要风险是事实过期或看起来合理但不可执行。
4. **传统行程管理器：** 地图、日历、行李、预算、订单集中管理；对话式多源检索与来源核验能力各不相同。
5. **Agent 框架 + 自配插件：** 技术用户可自行连接工具；扩展灵活，但配置、认证、失败排查和结构化行程需要用户承担。

**结论（推断）：** 设计应将“找信息”“核事实”“按空间与时间排程”“审阅变化”连成同一工作流，而不是只给一份 Markdown 回答。这个判断来自公开产品结构和小样本公开反馈；仍需后续用户试点验证，不能视为已完成用户访谈。

## 5. 开源参考仓库清单

标记说明：**A** 与目标直接相关；**B** 可借鉴工具/交互/架构；**C** 探索性、早期、历史或需高强度审查。一个表格行的“项目”下可能含多个变体；同源 fork 不算独立竞品。

### 5.1 旅行规划产品、Agent、工作区与研究基准

| 级别 | 项目 | 可借鉴的能力或研究点 | 接入/成熟度注意 |
|---|---|---|---|
| A | [Prism-Shadow/travel-agent](https://github.com/Prism-Shadow/travel-agent) | 桌面聊天 + 网页浏览；小红书到高德路线；携程流程用户确认 | 最直接竞品；当前 README 称开发预览，实机未验证 |
| A | [huahuanao/travel-agent](https://github.com/huahuanao/travel-agent) | 小红书/大众点评/高德三源旅行规划，观点/商户/地图交叉核验，来源失败降级 | CLI/pi 工作流；本地登录态和多服务配置；README 记录上游失效与超时 |
| A | [tiammomo/RoutePilot](https://github.com/tiammomo/RoutePilot) | 带证据的问答、行程 Artifact/版本、确定性校验和重规划、高德事实 Provider | Web 工作台；架构较重；本轮未运行 |
| B | [wangzhichuan123/trip-planner-agent](https://github.com/wangzhichuan123/trip-planner-agent) | XHS/景点/酒店/天气并行检索，Amap 地图、推荐探索、来源追溯和预算 | README 显示为小型 LangGraph 原型；实际功能未验证 |
| A | [Lagom-TA/JourneyPilot](https://github.com/Lagom-TA/JourneyPilot) | LangGraph/MCP、多源研究、来源标注、地图、天气、个人记忆、可恢复、PDF | Provider 需要配置；自托管栈较完整 |
| A | [Hugin-Z/trip-decider](https://github.com/Hugin-Z/trip-decider) | 12306 + 高德事实核验、字段证据、freshness、计划版本和 honest failure | 地域/服务覆盖有限，不能泛化到全国实时可用 |
| A | [Prot10/MyTripPlanner](https://github.com/Prot10/MyTripPlanner) | 对话式问询、路线地图、编辑/变更 diff、MCP 和本地数据 | Road trip 偏重；AGPL-3.0 需审计 |
| A | [Jameszhao1103/itinerary-workspace](https://github.com/Jameszhao1103/itinerary-workspace) | 行程单一状态源、地图/时间线同步、修改 preview/apply/reject、冲突队列 | AI 之外有规则回退；偏网页 workspace |
| A | [liketrek/TREK](https://github.com/liketrek/TREK) | 地图、路线、费用、行李、分享、PWA、路线插件和多日视图 | 旅行管理器；插件生态和复杂度可供观察 |
| A | [Chendestiny/trip-tide](https://github.com/Chendestiny/trip-tide) | 中国目的地数据、确定性日程切分、地图和天气 | 性能/调用量描述为维护者自述 |
| A | [tczyliu/china-travel-kit](https://github.com/tczyliu/china-travel-kit) | 中国入境旅行数据、可解释匹配、数据更新时间、CLI/HTTP/MCP/Skill | Alpha 数据集；README 标注开发预览 |
| A | [Yyh3/china-travel-planner-skills](https://github.com/Yyh3/china-travel-planner-skills) | 中国旅行 Agent Skill，含地图、天气、航班、铁路和内容渠道工作流 | 面向 Agent host 的技能集合，不是终端用户应用 |
| B | [DewarTsang/trip-planner](https://github.com/DewarTsang/trip-planner) | LangGraph + Amap MCP 多 Agent 旅行规划 | CC BY-NC-SA-4.0，商业复用限制需审计 |
| B | [6339-zhu/travel-planner](https://github.com/6339-zhu/travel-planner) | 中国行程、Amap MCP、天气/POI、CLI/Web | 参考接口组合；项目实用性未验证 |
| B | [TwoSigma-Labs/Travel-Planner-Agent](https://github.com/TwoSigma-Labs/Travel-Planner-Agent) | FastAPI/React + LangGraph，多 agent 分工处理航班/酒店/天气/景点 | 教学/原型架构参考；服务数据需配置/验证 |
| B | [sarakshnbzg/tripbreeze-ai](https://github.com/sarakshnbzg/tripbreeze-ai) | LangGraph、实时搜索、预算/天气、人工审阅 | 依赖托管搜索/API；自述能力未实测 |
| B | [paras160500/Trip-Planner-AI-with-MCP-LANGGraph-Render](https://github.com/paras160500/Trip-Planner-AI-with-MCP-LANGGraph-Render) | 旅行规划 Agent、MCP、状态持久化、容器部署 | README 明示原型，航班/酒店/天气需独立核验 |
| B | [Aaryav1130/Trip.AI](https://github.com/Aaryav1130/Trip.AI) | 对话式行程、地图和预算提示 | Web app 参考；数据准确性未验证 |
| B | [yuexuanchi-sys/travel-planning-agent](https://github.com/yuexuanchi-sys/travel-planning-agent) | provider fallback、确定性无 key 模式、修改预览、地图 | 较新的项目；须再看测试和真实 Provider 状态 |
| B | [YueranCao2001/TripWeaverAgent](https://github.com/YueranCao2001/TripWeaverAgent) | 证据约束、确定性排程、约束验证、OSM 路由 | 偏工程/研究样例；需核验真实数据覆盖 |
| B | [RicterZ/mapannai-plus](https://github.com/RicterZ/mapannai-plus) | 交互式地图、按天组织、路线可视化、内置 MCP | Google Places 与 MapLibre/OSM 并存；密钥/服务条款检查 |
| B | [kylepontier/trip-planner](https://github.com/kylepontier/trip-planner) | 家庭旅行结构化 intake、天气与坐标 enrichment | 小范围可参考；非完整出行 Agent |
| B | [shayan2772/Travel-Itinerary-Generator-with-Google-Maps-MCP](https://github.com/shayan2772/Travel-Itinerary-Generator-with-Google-Maps-MCP) | Google Maps MCP 生成旅行行程 | 教学型参考，核验维护和真实数据 |
| B | [GongRzhe/TRAVEL-PLANNER-MCP-Server](https://github.com/GongRzhe/TRAVEL-PLANNER-MCP-Server) | 旅行规划 MCP server 的工具 schema | 项目功能覆盖和当前维护需复查 |
| B | [TripForgeAI](https://github.com/Priyanka-Tru/tripforgeai) | 流式对话、多 agent、预算卡和数据置信度 | 面向印度旅行；一部分实时接口/服务依赖外部 API |
| B | [VoyagerTripPlanner](https://github.com/krishnakaushik25/VoyagerTripPlanner) | 图片定位、多模态行程 Agent 的探索 | 多组件和模型依赖较多，项目演示不代表落地能力 |
| B | [travel-roamradar](https://github.com/giovannibrees/travel-roamradar) | 个人旅行记录、时间线、AI Agent、Cloudflare Workers | 行程规划之外覆盖订单/旅行归档 |
| B | [trip-loom-monorepo](https://github.com/leojuriolli7/trip-loom-monorepo) | 端到端旅行流程、人工确认节点 | 交易/预订流程需区分 demo 与生产接入 |
| B | [AtlasAgent](https://github.com/wpfbcr/AtlasAgent) | 全球旅行定制 Agent Skill pack | Skill pack 而不是通用 UI；逐项核验来源 |
| B | [student-budget-travel](https://github.com/jiakezhu/student-budget-travel) | 学生预算、天气、景点时间、路线密度的中文旅行 Skill | 人群垂直，数据源与 Skill host 需检查 |
| B | [TripMate](https://github.com/Rebeccaxy/TripMate) | 移动端旅行规划与第三方 API + Agent | 移动 app 参考，不是桌面竞品 |
| B | [TripCraft](https://github.com/Soumyabrata2003/TripCraft) | 旅行规划 benchmark / 约束感知评估 | 研究基准不等于可交付产品；适合作评测线索 |

### 5.2 旅行数据、票务、酒店和订票相关工具

| 级别 | 项目 | 可借鉴的能力或研究点 | 接入/成熟度注意 |
|---|---|---|---|
| B | [MikkoParkkola/trvl](https://github.com/MikkoParkkola/trvl) | 旅行 MCP/CLI 汇聚航班、酒店、火车、汽车、渡轮和价格提醒；以一个路由工具压缩工具列表 | README 宣称 20+ provider；核验服务条款、价格覆盖及商业许可 |
| B | [nanwer/trip-search-mcp](https://github.com/nanwer/trip-search-mcp) | 机票、住宿、活动、天气、汇率搜索，结构化结果与本地价格观察 | 部分能力依赖 SerpAPI/第三方，非第一方交易源 |
| B | [skarlekar/mcp_travelassistant](https://github.com/skarlekar/mcp_travelassistant) | 航班、酒店、活动、地理编码、天气、财务拆分多个 MCP 服务 | 多服务部署参考；面向开发者 |
| B | [Spoofkapoof/travel-mcp-server](https://github.com/Spoofkapoof/travel-mcp-server) | Amadeus/AviationStack 航班酒店 MCP 聚合 | 需要 API 账户/key；数据商授权需确认 |
| B | [bokangsibolla/duffel-mcp](https://github.com/bokangsibolla/duffel-mcp) | Duffel 航班/住宿只读搜索 MCP | Duffel 账户和 token；预订未纳入其只读参考模式 |
| B | [flightclaw/agents](https://github.com/flightclaw/agents) | Hosted flight MCP、查询/价格追踪接口 | 托管服务而非独立自托管数据源；账号/成本/数据发送审查 |
| C | [drfccv/mcp-server-12306](https://github.com/drfccv/mcp-server-12306) | 12306 车次、席位、站点、换乘查询 MCP | README 里“官方/实时”说法未由本次独立验证 |
| C | [Joooook/12306-mcp](https://github.com/Joooook/12306-mcp) | 12306 查询 MCP，含车次/站点/换乘 | 项目自述偏学习用途；运行可靠性未测 |
| C | [boy-373/12306-train-mcp](https://github.com/boy-373/12306-train-mcp) | 12306 列车查询相关 MCP 备选 | 候选仓库；数据源与维护状态需核验 |
| C | [HasData/booking-mcp](https://github.com/HasData/booking-mcp) | 远程 Booking 酒店查询 MCP | Hosted 服务/额度或付费，不是纯 OSS 数据源 |
| C | [lesterppo/hermes-travel-cli](https://github.com/lesterppo/hermes-travel-cli) | Agoda/Trip.com/Airbnb/Booking 的旅行 CLI 实验 | README 标注接口为 reverse-engineered 且有 bot wall；仅作风险样本，不建议作为稳定依赖 |
| C | [Bill666666/trip-mcp](https://github.com/Bill666666/trip-mcp) | 携程/Trip Moments MCP 的搜索和内容工具 | README 标注开发预览/功能受站点阻挡；忽略发布、互动等写入能力 |
| C | [imoonkey/openweb](https://github.com/imoonkey/openweb) | 携程/Trip.com 站点 skill 和内部接口探索 | 站点内部接口可能变动，不能当稳定公开 API |
| C | [travala/travel-mcp](https://github.com/travala/travel-mcp) | 酒店搜索到预订的交易型 MCP 流程 | 商业服务及交易能力；本项目首版不照搬自动预订 |

### 5.3 社媒、UGC 与用户授权内容渠道

| 级别 | 项目 | 覆盖/能力 | 接入/成熟度注意 |
|---|---|---|---|
| A | [Panniantong/Agent-Reach](https://github.com/Panniantong/Agent-Reach) | Web、YouTube、GitHub、X、Bilibili、Reddit、Instagram、XHS 等渠道路由；安装/健康检查/fallback | 更像安装器、选择器和健康检查器，不是旅行产品或统一抓取引擎；README 对账号风险有说明 |
| A | [jackwener/OpenCLI](https://github.com/jackwener/OpenCLI) | 大量站点 adapter；当前目录包括小红书、B 站、知乎、Trip.com、Twitter、Reddit 等 | Apache-2.0；多数浏览器能力依赖登录态。其内部适配器仍随页面 DOM 变化而维护，不将用户本地安装的 CLI 当作可信代码 |
| A | [NanmiCoder/MediaCrawler](https://github.com/NanmiCoder/MediaCrawler) | 小红书、抖音、快手、B 站、微博、贴吧、知乎等平台内容采集 | 项目 README 标注学习用途，不推荐商用/大规模；Cookie/浏览器自动化与平台规则风险 |
| A | [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) | 小红书 MCP 搜索/feed/详情/评论等，也包括发布、评论动作 | 只研究只读能力；项目需要用户登录态，写入动作不纳入旅行规划产品 |
| B | [tamnd/xiaohongshu-cli](https://github.com/tamnd/xiaohongshu-cli) | CLI 搜索/笔记/用户/评论/Feed/导出 JSONL 和有限 crawl | README 说明搜索/评论等登录面与网站签名/API 细节；变化、限流及 cookie 风险高 |
| B | [Suoyiran1/xhs-cli](https://github.com/Suoyiran1/xhs-cli) | 浏览器自动化方式搜索/读小红书，提供 CLI JSON 输出 | README 表示逻辑移植自 xiaohongshu-mcp；不是独立实现/稳定性证据 |
| B | [jackwener/xiaohongshu-cli](https://github.com/jackwener/xiaohongshu-cli) | 搜索/阅读/feed/话题及交互 CLI，适配 Agent Skill | README 称“reverse-engineered API”；含点赞/评论/发布，接入时严格限读 |
| C | [jxygzzy/xhs-cli](https://github.com/jxygzzy/xhs-cli) | 搜索、阅读、评论、下载及 raw 接口调用 | 覆盖面广意味着风险面也广；raw API 特别不适合作为稳定产品契约 |
| C | [xyj2570/xhs-mcp](https://github.com/xyj2570/xhs-mcp) | 无浏览器的轻量小红书 MCP：搜索、详情、作者等 | 要求用户手动复制 Cookie；轻量不等于平台授权或稳定 |
| C | [DevinChen2014/xiaohongshu-xhs-rednote-mcp](https://github.com/DevinChen2014/xiaohongshu-xhs-rednote-mcp) | 社媒数据 MCP，含笔记/评论/创作者信息 | Provider/服务授权及登录方式需单独核验 |
| C | [Youhai020616/redbook-cli](https://github.com/Youhai020616/xiaohongshu) | XHS CLI + MCP + CDP 备选、搜索与读取 | 包装上游 MCP；浏览器/CDP 登录，存在来源同一导致的冗余 |
| C | [shanyang-me/xhs-mcp](https://github.com/shanyang-me/xhs-mcp) | xiaohongshu-mcp 分支/变体 | 作为同源实现对照，不作为独立竞品 |
| C | [iFurySt/RedNote-MCP](https://github.com/iFurySt/RedNote-MCP) | RedNote 小红书 MCP 参考 | 需复核维护状态、登录方式和工具边界 |
| C | [Andy-SoulShell/xhs-downloader](https://github.com/Andy-SoulShell/xhs-downloader) | XHS API/CLI/MCP/浏览器扩展和内容下载 | 下载/发布能力不等于可用于产品化搜索；授权和内容版权风险需评估 |
| C | [JoeanAmier/XHS-Downloader](https://github.com/JoeanAmier/XHS-Downloader) | 以 URL 为入口的内容/媒体下载、API、MCP | 下载工具不是攻略检索/排序产品；GPL-3.0 与内容再分发需审查 |
| C | [Authurzk/mediacrawler](https://github.com/Authurzk/mediacrawler) | XHS/B 站/抖音多来源聚合、去重/排序原型 | 早期项目；README 要求 Cookie，Mock/真实平台能力要区分 |
| B | [DIYgod/RSSHub](https://github.com/DIYgod/RSSHub) | RSS 路由生态，聚合大量网站/社交内容 | 订阅与更新适合，不等于按旅行意图检索全量内容；AGPL-3.0 |
| B | [tmwgsicp/ForgeRSS](https://github.com/tmwgsicp/ForgeRSS) | RSS 与社交平台内容采集组合 | 一些来源依赖登录态；README 描述的反爬方式不作为产品建议 |
| B | [Yi-luo-hua/BilibiliCrawler](https://github.com/Yi-luo-hua/BilibiliCrawler) | Windows 桌面界面与 B 站爬取/MCP 组合 | 单平台参考；分析/评论读取应注意个人信息和平台规则 |
| B | [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) | YouTube 等视频元数据/字幕工作流 | 不是跨社媒搜索或旅行产品；内容使用权和平台限制需遵守 |
| C | [TikHub/TikHub-API-Python-SDK](https://github.com/TikHub/TikHub-API-Python-SDK) | 托管数据 API SDK，含部分社媒搜索能力 | 后端服务/商业额度依赖；不是自托管 OSS 抓取器 |
| C | [DWJWendy/mafengwo_spider](https://github.com/DWJWendy/mafengwo_spider)、[haoyuefanglai/mafengwo](https://github.com/haoyuefanglai/mafengwo)、[pf12345/python-for-travel-notes](https://github.com/pf12345/python-for-travel-notes) | 马蜂窝/旅行笔记爬取的历史实现 | 老旧依赖或教学项目；仅作数据结构与历史风险参考，不作生产依赖 |

**小红书采集结论：** 这些仓库证明社区持续尝试提供“搜索→读取→评论/作者→结构化输出”的能力，但它们不证明官方长期授权、服务可用性或商用许可。优先级应放在“官方开放接口/用户主动提供内容/明确授权连接器”；对 unofficial connector 做可关停隔离、低频只读、凭证本地保存、数据最小留存、清楚提示失效和风险。不得绕过验证码、访问控制或平台反爬。

#### 小红书接入方式比较：内置浏览器还是其他方案

比较同一任务：用户给出目的地/关键词后，找少量相关游记或读取指定笔记，将地点线索保留为可核对的来源卡。以下是从官方公开文档与项目说明得出的产品评估，不是法律意见或接口稳定性实测。

**官方接口复核（2026-10-19）：** [API 参考](https://openaccount.xiaohongshu.com/docs/api-reference)标注于 2026-08-19 更新，目录列出授权状态、OAuth/Token、用户基础信息、授权管理和设备授权等 11 类接口，未列出笔记搜索或正文读取端点。[授权范围](https://openaccount.xiaohongshu.com/docs/scope)标注于 2026-03-29 更新，仍仅开放 `basic_info`，`read_notes` 仍为规划中。公开 API 目前不能满足旅行笔记发现与读取需求；这不构成对 OpenCLI 复用用户 Chrome 会话的许可，也不能据此判断该站点自动化在所有场景下是否合法或不合法。

| 方式 | 搜索/读取覆盖 | 用户设置与凭证 | 稳定/维护特征 | 结论 |
|---|---|---|---|---|
| 官方开放 API | 当前 scope 仅 basic_info；read_notes 标为规划中，公开 API 参考无通用笔记搜索/读取 | 正常应用授权 | 合约接口最适合长期产品化，但当前公开权限不足以实现本任务 | 持续观察，开放搜索/读取后优先评估。来源：[scope](https://openaccount.xiaohongshu.com/docs/scope)、[API reference](https://openaccount.xiaohongshu.com/docs/api-reference)。 |
| 用户粘贴分享链接/文字 | 只覆盖用户已找到并主动提供的内容；链接可能需要登录或无法完整解析 | 最低设置，不需读取账户会话 | 对网站 DOM 变化依赖较小；不能替代关键词发现 | 基础版必须支持；失败时保留原始链接/文字。 |
| 通用搜索 + 应用内可见浏览器 | 能发现/打开公开网页；XHS 搜索结果、正文和登录内容不保证可见或可结构化 | 浏览器在应用内；登录态通常与 Chrome 分离，用户需另行决定是否登录 | 视觉透明但页面改动仍会使自动化失效；“能浏览”不等于搜索 API | 用于通用网页与用户检查来源，作为 XHS 的兜底，不单独承诺结构化检索。Travel Agent README 也把应用内浏览器与用户 Chrome 分为不同 profile。 |
| 用户 Chrome 会话扩展（OpenCLI；Agent-Reach 可作路由器） | OpenCLI 适配器通过 Chrome/Browser Bridge 进行站内搜索、DOM 抽取和笔记读取；Agent-Reach Skill 会调用 OpenCLI 命令。Agent-Reach 自带 MCP 在固定 commit `94f06c1` 中只提供状态查询，不返回笔记 | 需要 Chrome 运行、安装并启用 Browser Bridge、由用户维持登录；Agent-Reach 文档表示不替用户登录或读取/导出 Chrome Cookie | 可复用用户现有会话；扩展/daemon 配对、权限范围、跨平台安装和站点 UI 变化带来维护成本。搜索代码中有布局与风控检测，但近期公开 issue 仍报告验证码/登录墙、筛选面板重复匹配及 DOM 结构变化 | Tripwise 已实现默认关闭的试点：固定调用 OpenCLI `search`/`note`、每次最多 5 条、进程串行且至少间隔 3 秒，只可读取本 Trip 已搜索来源；未接入 Agent-Reach status MCP。真实 Chrome 会话、多平台配置、平台规则与用户价值仍未验收。来源：[Agent-Reach MCP](https://github.com/Panniantong/Agent-Reach/blob/94f06c1969dfc1834001269d79d3ad0972d9dee6/agent_reach/integrations/mcp_server.py)、[Agent-Reach Skill](https://github.com/Panniantong/Agent-Reach/blob/94f06c1969dfc1834001269d79d3ad0972d9dee6/agent_reach/skill/SKILL.md)、[OpenCLI XHS adapter at `e6174a9`](https://github.com/jackwener/OpenCLI/blob/e6174a952c763a836a9bb0dd2f097d2962b3876b/docs/adapters/browser/xiaohongshu.md)。 |
| 独立本地 MCP + 手工 Cookie 导入（xiaohongshu-mcp 类） | 声明支持搜索、详情等读取，亦可能包含写入工具；需要严格 allowlist | 用户扫码/登录或从 Cookie-Editor 手工导入，安装/运行额外服务和浏览器 | 本地运行减少额外托管方，但新增凭证复制、存储、版本和服务管理；近期仓库 issues 可见搜索/详情超时类报告，说明要准备健康检查和失效回退 | 不作为普通用户默认连接方式；只可作为高级可选插件，在凭证安全和跨平台安装经过验证后再评估。来源：[README](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/README_EN.md)、[issues](https://github.com/xpzouying/xiaohongshu-mcp/issues)。 |
| 第三方托管搜索/抓取 API | 取决于数据提供方，接入体验可能简单 | 行程关键词、链接或登录凭证可能经过第三方服务，另有费用/配额 | 运维由供应商承担，但供应商授权、数据留存、价格、地域覆盖、来源时效和退出机制需要合同级核验 | 暂不作为默认；如候选 API 有清楚授权和数据条款，可按同一验收集比较。 |
| 自建私有接口/逆向 HTTP 爬虫 | 技术上可尝试搜索和读取，但紧绑未公开接口、签名/令牌和页面变化 | 可能要求账户凭证、Cookie 或设备身份 | 接口变化、账户限流/风控和安全维护成本高；不可把社区 PoC 等同于官方许可 | 不作为产品方案；不实现验证码、访问控制或反爬绕过。 |

**推荐路线和当前状态：** 基础闭环仍必须是“通用网页 + 用户主动提供链接/文字 + 地图 + 天气”，不要求所有用户安装或登录小红书。源码调研确认 Agent-Reach MCP 只提供状态查询，XHS 实际搜索/读取需调用 OpenCLI CLI；Tripwise 已为此实现专用调用器，不连接 Agent-Reach status MCP，也不把模型输入拼成 shell 命令。工具只允许固定的 `search`/`note` 子命令，用户逐项配置本机可执行程序/参数前缀，默认关闭；命令以当前账户权限运行，Tripwise 没有 OS 沙箱。内置浏览器仍负责可见网页读取与手动核查。官方 API 尚未开放笔记读取，OpenCLI 适配器近期仍有页面布局/验证码故障记录，因此该连接器只能先做实验试点，不能声称生产可用。明确禁止自动登录、Tripwise 读取/导入 Cookie、验证码/反爬绕过、批量抓取、媒体归档与社媒写入；真实 Chrome/Browser Bridge 验收及规则审查完成前维持默认关闭。

**政策边界：** 官方授权范围只证明当前开放权限不足，不自动证明未授权采集在法律上禁止或允许。小红书小程序服务协议中的蜘蛛/复制内容条款属于该开放平台/小程序协议范围，不能直接当作面向所有公开网页的法律结论；它进一步说明产品不可假设社区采集工具已获平台授权。正式启用前需针对实际产品形态、账户、内容存储和调用方式审查适用规则。来源：[授权范围](https://openaccount.xiaohongshu.com/docs/scope)、[小程序第三方开发者服务协议](https://miniapp.xiaohongshu.com/doc/DC430242)。

#### 本轮 OpenCLI 代码级核查（2026-10-17）

**事实：** 在 [OpenCLI commit `e6174a9`](https://github.com/jackwener/OpenCLI/tree/e6174a952c763a836a9bb0dd2f097d2962b3876b) 检查仓库根许可证、[XHS adapter 文档](https://github.com/jackwener/OpenCLI/blob/e6174a952c763a836a9bb0dd2f097d2962b3876b/docs/adapters/browser/xiaohongshu.md) 与 [`search.js`](https://github.com/jackwener/OpenCLI/blob/e6174a952c763a836a9bb0dd2f097d2962b3876b/clis/xiaohongshu/search.js)。根许可和 npm 元数据为 Apache-2.0。文档要求 Chrome 已运行并登录小红书、安装 Browser Bridge 扩展；`search`返回标题、作者、点赞数和 URL，`note`读取标题、作者、正文、互动数与标签。代码把搜索命令标为 read access，但通过 UI 输入、筛选控件、MutationObserver、DOM 选择器和滚动收集结果，并对真实笔记 URL、主机和字段形状做校验。读取正文需沿用搜索结果中的完整签名 URL，常带 `xsec_token`；裸 ID 可能无法访问。

**稳定性证据：** 仓库公开 issue 包含 [筛选元素重复导致 `ambiguous_option`](https://github.com/jackwener/OpenCLI/issues/2445) 和[搜索页转入验证码/布局不兼容](https://github.com/jackwener/OpenCLI/issues/2562)等问题，说明代码级的失败分类和选择器兜底不等于站点持续可用。XHS 文档对部分分页/布局检查注明仅用离线 fixture 验证。它没有给 Tripwise 提供站点 SLA。平台官方[授权范围](https://openaccount.xiaohongshu.com/docs/scope)当前仅列出 `basic_info`，`read_notes` 为规划项。

**Tripwise 决策（产品方案）：** 使用 OpenCLI 作为用户本机可选依赖，不复制其采集实现；通过专用适配器固定只调用 `xiaohongshu search` 和 `xiaohongshu note`，搜索最多 5 条、队列串行并间隔至少 3 秒；正文读取必须匹配本旅行已有的成功搜索来源。只保存标题、页面作者、点赞数、限长正文和原始链接；不抓评论/通知/收藏、不下载媒体、不自动登录。stderr 不传入模型，命令不经 shell，进程设超时/输出上限；程序路径由用户选择并以当前账户权限运行，无 OS 沙箱。设置页提示会复用用户 Chrome、可能遇到登录墙/平台限制；连接器默认关闭。搜索链接中平台参数会随来源本地保存并可能出现在用户主动导出的未加密 JSON 备份中。

**推断与剩余验收：** 用户控制 Chrome 让授权和登录会话比 Cookie-Editor 复制更容易理解，但仍需要安装扩展、维护 CLI 路径，并会让 OpenCLI 进程拥有当前用户的普通系统权限。因本机尚未配置 OpenCLI/Browser Bridge，本次只做 mock adapter、来源/参数边界测试，未进行真实账号搜索或平台规则审查；不可将该 connector 状态显示为真实登录/能力已验证。只有目标用户试点证明安装与失效回退可用，且针对实际产品形态完成规则/安全审查后，才考虑默认启用或正式发布。

### 5.4 网页检索、正文抽取与浏览器 Agent

| 级别 | 项目 | 可借鉴的能力 | 限制/用途 |
|---|---|---|---|
| B | [unclecode/crawl4ai](https://github.com/unclecode/crawl4ai) | 浏览器渲染、深度/自适应 crawl、面向 LLM 的内容输出 | 抽取底座，不等于来源有权访问；资源和站点限制 |
| B | [firecrawl/firecrawl](https://github.com/firecrawl/firecrawl) | search/scrape/crawl 等网页摄取 API | AGPL-3.0；Hosted 与自托管功能/成本要核查 |
| B | [jina-ai/MCP](https://github.com/jina-ai/MCP) | URL 读取、搜索和 rerank 的 MCP 示例 | GitHub repo 开源不意味着后端 API 免 key/免费/本地运行 |
| B | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | 官方 Playwright 浏览器 MCP、页面导航/交互/会话 | 浏览器自动化会触发账户权限和站点条款；不要作为所有渠道默认抓取方式 |
| B | [webllm/browser-use](https://github.com/webllm/browser-use) | TypeScript 浏览器 Agent/MCP | 适合浏览器接入研究；需隔离站点权限并处理失效 |
| B | [ScrapeGraphAI/scrapegraph-ai](https://github.com/ScrapeGraphAI/Scrapegraph-ai) | LLM 驱动抓取流程和结构化抽取 | 区分开源库与托管 API；成本、结果验证和许可证需检查 |
| B | [ScrapeGraphAI/scrapegraph-mcp](https://github.com/ScrapeGraphAI/scrapegraph-mcp) | 将抓取流程暴露为 MCP | 需要 SGAI 托管服务 key，不是纯本地数据层 |
| C | [pazyork/crawl4ai-mcp](https://github.com/pazyork/crawl4ai-mcp) | search_web 与 fetch_urls 两类简化 MCP 工具 | 包装层早期；底层抓取质量/授权继承 Crawl4AI 约束 |
| B | [yokingma/one-search-mcp](https://github.com/yokingma/one-search-mcp) | 多搜索提供商 + 本地浏览器搜索 + scrape/map/extract | provider 需要分别配置；聚合器不自动消除结果重复和失效 |
| C | [tickernelz/mcp-web-search](https://github.com/tickernelz/mcp-web-search) | DuckDuckGo/Bing/SearXNG fallback、网页/PDF 等 URL 提取 | 社区工具；搜索结果稳定性与商业使用要另测 |
| C | [rinaldowouterson/mcp-open-webresearch](https://github.com/rinaldowouterson/mcp-open-webresearch) | 多引擎深度搜索、递归来源提取和限速 | 搜索摘要需追溯原文；递归研究易增加成本与来源噪音 |
| C | [mrkrsl/web-search-mcp](https://github.com/mrkrsl/web-search-mcp) | Bing/Brave/DuckDuckGo fallback 与正文抽取 | 依赖页面结构，未验证抗封锁能力 |
| C | [liliang-cn/mcp-websearch-server](https://github.com/liliang-cn/mcp-websearch-server) | 多搜索引擎与 chromedp 正文抽取 | 结果来自抓取搜索页；稳定性/条款核验 |
| C | [arufian/Crawlit](https://github.com/arufian/Crawlit) | Firecrawl API 兼容的自托管抓取尝试 | 早期/维护者自述，应先做样本质量测试 |
| B | [pranavms13/web-search-mcp](https://github.com/pranavms13/web-search-mcp) | Google/DDG/Bing 浏览器搜索 fallback 和抽取 | headless browser 成本和引擎拦截风险 |

### 5.5 地图、POI、路线与空间规划

| 级别 | 项目 | 可借鉴的能力 | 接入/注意 |
|---|---|---|---|
| A | [baidu-maps/mcp](https://github.com/baidu-maps/mcp) | 百度官方 MCP：地理编码、POI、详情、路线矩阵、驾车/公交/步行/骑行、天气、路况 | 需要百度地图 key/权限；核实调用额度、展示和缓存条款 |
| B | [ganyu123456/mcp-map-server](https://github.com/ganyu123456/mcp-map-server) | 高德/百度可选后端、地点、路线、距离、天气和平台状态 | 社区封装；坐标系在 GCJ-02/BD-09 间不能混用 |
| B | [luodora/mcp-amap](https://github.com/luodora/mcp-amap) | 高德地理编码、POI、路线和距离 MCP | 社区 adapter；高德 key 与服务配额要求 |
| B | [JavaAIDev/amap-mcp-server](https://github.com/JavaAIDev/amap-mcp-server) | 高德地图服务 MCP 与跨平台安装参考 | key/接口权限需配置；实际覆盖要复测 |
| C | [zengzeruidd-a11y/amap-mcp-server](https://github.com/zengzeruidd-a11y/amap-mcp-server) | 高德 POI、路线、天气等工具组合 | 社区项目；与高德政策、key 限额相依 |
| B | [mapbox/mcp-server](https://github.com/mapbox/mcp-server) | Mapbox 地理编码、路线与地点能力 | Mapbox key/商业条款，适合国际 Provider |
| B | [apurvaumredkar/google-maps-mcp](https://github.com/apurvaumredkar/google-maps-mcp) | Google Places/Routes，多方式路线、距离矩阵和 POI | Google key 和地图内容展示/缓存规则 |
| B | [cablate/mcp-google-map](https://github.com/cablate/mcp-google-map) | Google Places/Routes、地点与路线查询 | 同上；属于社区 MCP 封装 |
| B | [morelandjs/google-maps-connector](https://github.com/morelandjs/google-maps-connector) | 自托管 GCP + Google Maps OAuth/MCP 的实现样例 | 运行在用户 GCP、要配置云服务和 billing |
| B | [RicterZ/mapannai-plus](https://github.com/RicterZ/mapannai-plus) | 地图编辑器、按天标点和路线、多 MCP 控制 | 将“地点收藏→日程”做成可视工作区的参考 |
| B | [arthurpanhku/DragonMCP](https://github.com/arthurpanhku/DragonMCP) | 大中华和亚洲本地服务，包括高德、香港 MTR 等 | 服务覆盖混合 live/mock，逐项查看项目矩阵 |
| B | [sparkgeo/geo-mcp-servers](https://github.com/sparkgeo/geo-mcp-servers) | GIS/地理 MCP 目录，记录数据访问和活跃度 | 目录用于发现候选，不等于维护者背书 |
| B | [Project OSRM/osrm-backend](https://github.com/Project-OSRM/osrm-backend) | OSM 路网的路径/距离/时间服务 | 自部署和数据更新责任；公共 demo 有限额 |
| B | [graphhopper/graphhopper](https://github.com/graphhopper/graphhopper) | 路由引擎，支持路网、路线和矩阵计算 | 自部署能力/商业许可需检查；适合算法层参考 |
| B | [valhalla/valhalla](https://github.com/valhalla/valhalla) | 开源路线引擎，步行/驾车/骑行等 | 需管理地图数据、更新和运行成本 |
| B | [OSM Nominatim](https://github.com/osm-search/Nominatim) | OSM 地理编码/反向地理编码 | 公共实例有严格使用政策；商业产品宜自托管或合约服务 |
| B | [Overpass API](https://github.com/drolbr/Overpass-API) | OSM POI/category 查询 | 不等于营业时间/当前运营状态的权威来源；公共实例限流 |

### 5.6 天气与出行前准备

| 级别 | 项目 | 能力/用途 | 注意 |
|---|---|---|---|
| B | [weather-mcp/weather-mcp](https://github.com/weather-mcp/weather-mcp) | NOAA/Open-Meteo 等数据的多工具天气 MCP，含预报/空气质量/灾害数据 | 覆盖因数据提供方而异；海外数据更强，免费源有公平使用限制 |
| B | [cmer81/open-meteo-mcp](https://github.com/cmer81/open-meteo-mcp) | 预报、历史、空气质量、海洋、地理编码等 Open-Meteo MCP | README 明确免费免 key 条件为非商业；商用要看 Open-Meteo 当前价格/许可 |
| B | [cyanheads/open-meteo-mcp-server](https://github.com/cyanheads/open-meteo-mcp-server) | Open-Meteo 天气/历史数据 MCP，结构化参数与覆盖 notice | 同样有商业服务条件；部署要求相对新 |
| C | [diyakamboj/weather-mcp-server](https://github.com/diyakamboj/weather-mcp-server) | Open-Meteo 的轻量天气 MCP 封装 | 小范围候选，需核验 schema、维护状态与商业使用条件 |
| C | [raythurman2386/goweathermcp](https://github.com/raythurman2386/goweathermcp) | Go 写的 Open-Meteo 天气 MCP 简化实现 | 小范围候选，需核验 schema 和维护状态 |

### 5.7 插件/桌面 Agent 架构参考

| 级别 | 项目 | 可借鉴点 | 关联边界 |
|---|---|---|---|
| A | [Agent-Reach](https://github.com/Panniantong/Agent-Reach) | 插件/渠道安装、自动选后端、doctor/health、fallback、认证状态 | 它的价值在渠道层；不是面向旅行者的产品体验 |
| A | [OpenCLI](https://github.com/jackwener/OpenCLI) | 站点适配器、浏览器桥接、插件安装和命令清单 | Apache-2.0；适配器绑定站点变化，权限隔离和维护成本是核心 |
| B | [BANG404/openagent](https://github.com/BANG404/openagent) | Tauri 跨平台桌面 Agent、MCP/skills/plugins 和本地会话 | 通用工作台，不是旅行产品；公开宿主 SDK 部分受限 |
| B | [Dodaios/Dodaios](https://github.com/Dodaios/Dodaios) | 跨平台桌面 Agent 插件市场、MCP/skills/CLI 安装 | 面向通用 Agent；适合看扩展和安装体验 |
| B | [Euraika-Labs/pan-agent](https://github.com/Euraika-Labs/pan-agent) | Go runtime + Tauri 桌面、多模型、本地持久记忆与权限提示 | 通用电脑 Agent；权限模型需独立安全评估 |
| B | [Lukeus/taurus](https://github.com/Lukeus/taurus) | Rust 共用 Agent harness + Tauri 桌面和 CLI，多模型/MCP | 开发者工作区；可观察共享 runtime 的边界 |
| B | [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | 页面导航、可访问性快照、点击/输入及可见浏览器自动化；官方文档采用“导航→快照→交互→重新快照”循环 | 用户配置的第三方 MCP 仍只放行声明为只读的工具；其图片结果被忽略，独立浏览器也不连接右侧研究页。连接器不是“爬取一切”的授权凭证；需结合逐次授权、浏览器隔离与页面提示注入防护设计 |
| B | [webllm/browser-use](https://github.com/webllm/browser-use) | 浏览器 Agent 自动化接口 | 需限制可访问域名、用户登录态和自动操作 |

**浏览器交互复核（2026-09-23）：** Playwright MCP 的文档采用“导航→可访问性快照→目标交互→重新快照”模式，并可使用隔离 BrowserContext；Electron 的 `WebContents.sendInputEvent` 需要窗口聚焦，不适合让 Agent 抢桌面焦点。Tripwise 继续复用右侧隔离 `WebContentsView`，新增内置 `research_browser_interact`：仅可使用最近快照编号提交同站 GET 搜索，或展开固定标签的公开内容；之后重新读取页面。Agent 操作时右侧页面可见，现有浏览状态、停止规划和来源卡提供反馈，不增设独立窗口。开发版桌面 E2E 使用本机假页面验证展开正文、快照回读和 GET 搜索；不登录、不复用系统 Cookie、不绕过验证码/访问限制。小红书开放平台快速接入文档展示用户基本信息等能力，没有笔记搜索接口；此浏览器路径只能处理当前会话可见的公开内容，不能保证在小红书页面可搜索或读取全部内容。

这不是系统级 Computer Use 或第三方 Browser MCP Server。用户可选的视觉读取先通过图片能力探测，再临时分析当前网页截图；只保存带原页链接的图像线索摘要，不保存图片、不据此确认动态事实。Agent 不提供坐标点击、任意按键、自动登录、发布、互动、预约、购买或下载。网页和按钮行为仍是不可信内容，允许的控件标签不能证明网站内部行为绝无副作用。真实旅行网站、恶意页面指令注入、Windows/Linux 目标机仍待验收；第三方 Browser MCP 仍独立运行，不能控制应用内研究页面。

主要依据：[Playwright MCP 页面交互工作流](https://github.com/microsoft/playwright/blob/main/docs/src/getting-started-mcp.md)、[Playwright BrowserContext 隔离](https://playwright.dev/docs/api/class-browsercontext)、[Electron WebContents 输入事件](https://www.electronjs.org/docs/latest/api/web-contents)、[小红书开放平台快速接入](https://openaccount.xiaohongshu.com/docs/quick-start)。

### 5.8 UI/UX 与桌面技术参考

本节根据仓库公开的 README、产品规格、架构/工具文档、依赖清单和 README 图片说明归纳设计模式；本轮没有运行竞品应用或逐像素审阅其真实截图。Travel Agent README 发布了[对话旁网页的桌面截图](https://raw.githubusercontent.com/Prism-Shadow/travel-agent/main/assets/readme/desktop-browser.png)和 [Chrome 扩展引导图](https://raw.githubusercontent.com/Prism-Shadow/travel-agent/main/assets/readme/travel-browser-en.png)；截图说明支持工作区并排布局，但本报告不声称已验证截图中的细部视觉。2026-10-16，用户选择了“对话研究”主工作区（左侧旅行栏、中央对话、右侧网页/来源）和 Lucide 图标。Tripwise 的 UI/UX 方案已记录该布局、行程与地图交互和连接状态；视觉差异及易用性仍需目标用户任务验证。

#### 产品布局与交互模式

| 参考仓库 | 公开实现/规格证据 | 可转用到 Tripwise 的部分 | 不直接照搬的部分 |
|---|---|---|---|
| [Prism-Shadow/travel-agent](https://github.com/Prism-Shadow/travel-agent) | 根 SPEC 把 Trip 作为一等对象，聊天为工作方式；Web UI SPEC 规定旅行侧栏、独立对话/旅行归档、共享旅行备注、浏览器选择可见、草稿保留、只读 itinerary/map 文件 | 沿用旅行侧栏、自由对话起步、草稿可恢复、浏览器/渠道状态明示；对话、来源、计划和准备共享 Trip 上下文 | 其主要交付是网页交易并停在付款前；行程文件和地图只读。Tripwise 以可审阅/可修改的结构化行程作为交付 |
| [Prot10/MyTripPlanner](https://github.com/Prot10/MyTripPlanner) | README 描述访谈式问题轮播、用户确认 brief、检索进度 stepper、地图/日程逐步出现、交互式候选卡和常驻 notebook | 把必需条件分批问清楚；长任务显示步骤和可取消/失败状态；模型提出候选时用卡片比较 | 首屏不可强制长问卷；公路旅行和酒店交易数据模型不适合作为中国城市行程首版 |
| [Jameszhao1103/itinerary-workspace](https://github.com/Jameszhao1103/itinerary-workspace) | README 声明 Map、Timeline、Plan、Selection 和 Assistant 共享一份 itinerary；AI 修改先 preview/apply/reject；支持锁定、冲突审阅、undo/redo | 地图、日程和对话必须派生自同一份行程；显示字段级修改影响后由用户接受；保留锁定项和撤销路径 | 它把专业行程编辑工作区放在中心，Tripwise 仍需降低首次使用门槛，把复杂操作按需显露 |
| [liketrek/TREK](https://github.com/liketrek/TREK) | README 描述按日拖动地点/路线、地图 Provider 可替换；多个扩展模块可以启用或关闭 | 按日筛选地图、显示地点顺序和路线段、扩展能力可选安装 | 它覆盖协作、成本、预订、文件、日记等大量旅行管理需求；Tripwise 不应把插件目录做成首屏，也不应复制其范围 |
| [Lagom-TA/JourneyPilot](https://github.com/Lagom-TA/JourneyPilot) 与 [tiammomo/RoutePilot](https://github.com/tiammomo/RoutePilot) | 文档/README 将来源、地图、天气、路线、计划版本或研究交付放在同一工作区 | 用来源对象支撑路线建议；生成和重规划要可取消、可恢复，并展示版本/来源 | 两者的多 Provider/任务基础设施较复杂；Tripwise 只保留支撑个人旅行和失败恢复所需的机制 |
| [huahuanao/travel-agent](https://github.com/huahuanao/travel-agent) | 项目将小红书、大众点评和高德结果交叉使用，并记录上游超时/解析失败及降级 | 来源需保留类型和置信度；官方事实与游客经验分开；连接器失败不阻断手工导入 | CLI 工作流和登录/运行依赖不能作为普通用户桌面端默认设置流程 |

#### 信息来源和工具接入界面

| 参考仓库 | 值得借鉴的界面机制 | 对 Tripwise 的设计约束 |
|---|---|---|
| [Cherry Studio](https://github.com/CherryHQ/cherry-studio) | 跨平台桌面客户端支持多模型和 MCP；文档把连接器服务器管理、授权和 Agent 绑定分别呈现 | 模型提供方与旅行数据连接器分开管理；连接器认证状态、能力和可用性放在设置/连接器页，聊天里只呈现当前任务相关状态 |
| [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) | MCP 服务器可在 UI 查看/管理，Agent skills 可配置，并能从聊天工具菜单按需选择 | 连接器要可发现、可配置、可关闭；运行时只把此任务所需工具暴露给 Agent，避免把全部工具堆给用户和模型 |
| [Open WebUI](https://github.com/open-webui/open-webui) | MCP 与 OpenAPI 工具可绑定给 Agent，服务端负责执行并把工具结果送回模型；文档指出协议接通不保证模型会正确调用 | “已连接”与“成功完成旅行任务”分别观测；模型工具调用失败要提供可读错误和继续路径 |
| [Agent-Reach](https://github.com/Panniantong/Agent-Reach) 与 [OpenCLI](https://github.com/jackwener/OpenCLI) | 渠道适配器、健康诊断、认证状态和备用来源组织方式 | 多渠道产品需要能力目录、来源级健康/失败状态、重试或用户导入动作；不要把适配器数量等同于可用率 |

#### 跨平台桌面与技术取舍

| 方向 | 仓库/文档证据 | 取舍 |
|---|---|---|
| Electron + React/Vite | Travel Agent 的[Web UI 规格](https://github.com/Prism-Shadow/travel-agent/blob/main/packages/web/SPEC.md)说明同一 React/Vite SPA 由浏览器开发和 Electron renderer 展示；[Cherry Studio](https://github.com/CherryHQ/cherry-studio)也是 Electron 桌面应用 | 适合 Tripwise：有核心竞品实现参照；Chromium 可减少三平台内置网页渲染差异，适合可见网页研究。代价是应用包更大，必须严格隔离网页内容与桌面权限 |
| Tauri 2 + Web 前端 | [官方 WebView 文档](https://v2.tauri.app/reference/webview-versions/)说明 Tauri 不随应用捆绑 WebView；Windows 用 WebView2，macOS 用 WKWebView，Linux 用 WebKitGTK | 包体积更小，但不同系统的渲染引擎和系统版本会带来网页显示/行为差异。适用于不依赖重度嵌入网页的轻桌面应用；Tripwise 需要实测目标网站后再考虑替换 Electron |
| Electron 安全边界 | [官方安全文档](https://www.electronjs.org/docs/latest/tutorial/security/)推荐 renderer sandbox、context isolation 和最小化特权桥接；[进程模型文档](https://www.electronjs.org/docs/latest/tutorial/process-model)说明 sandbox renderer 通过 IPC 请求系统能力 | 网页浏览器面板和主应用界面不可共用 Node 权限；外站页面只能经显式、窄范围的桥接。平台兼容性优势不代表可以信任网页内容 |

**调研建议的落地状态：** Electron 主界面、结构化 Trip 状态、模型 Provider adapter、内置旅行工具和可选 MCP 互操作已通过 [桌面外壳 ADR](../design/adr/0001-desktop-shell.md)、[工具边界 ADR](../design/adr/0002-tool-connectors.md) 与 [MCP stdio ADR](../design/adr/0006-mcp-stdio-connectors.md) 审阅并进入实现。Agent 仍按“收集 brief → 检索 → 归一化证据 → 生成方案 → 用户审阅 → 应用修改”组织；模型负责提取和建议，确定性代码负责状态、权限、版本和持久化。渠道来源的规则、隐私和维护审查仍需单独完成，尤其是小红书登录态读取。

#### 图标系统与原型方向

Travel Agent 的 [React 包依赖清单](https://raw.githubusercontent.com/Prism-Shadow/travel-agent/main/packages/web/package.json)使用 Phosphor；[MyTripPlanner](https://raw.githubusercontent.com/Prot10/MyTripPlanner/main/package.json)、[Serkanbyx/travel-planner](https://raw.githubusercontent.com/Serkanbyx/travel-planner/main/package.json) 和 [travel-itinerary-app](https://raw.githubusercontent.com/tworoniak/travel-itinerary-app/main/package.json) 使用 Lucide。这是实现选择的样本，不是用户偏好调查。[Lucide](https://github.com/lucide-icons/lucide)有统一的线框风格并提供多前端框架包；[Phosphor](https://github.com/phosphor-icons/react)提供六种粗细/填充样式，表现变化更丰富。此前建议采用 **Lucide 单一系统图标**，并固定尺寸阶梯、为行动图标提供文字或无障碍标签；用户已明确确认 Lucide。品牌 Logo 另行定制为“路径 + 途经点”的几何记号，不从图标库拼装，不用 emoji。Phosphor 仍是竞品比较项，不是当前项目候选决策。

| UI 原型方向 | 主界面 | 参考组合 | 收益 | 主要代价 |
|---|---|---|---|---|
| 对话研究 | 左侧旅行/导航，中央自然语言对话，右侧可见浏览器与证据；生成后可切到行程 | Travel Agent | 上手熟悉，渠道研究透明，能直接展示来源状态 | 计划编辑空间偏窄；需要明确从“聊”切换到“审行程”的时机 |
| 行程工作台 | 日程时间线和当天空间路线为主，Agent 在需要时展开 | Itinerary Workspace + TREK | 最适合查看可行性、改动和日程地图同步 | 初次启动比聊天页更复杂，用户可能误以为必须先做完整编辑 |
| 来源工作台 | 左侧来源收件箱，右侧候选计划；逐条确认地点和证据 | Agent-Reach 渠道目录 + 证据型旅行 Agent | 最能展示渠道广度、原文和不确定性 | 信息密度较高；若作为默认页，会让普通用户先理解连接器而非解决行程问题 |

**用户已确认的方向（2026-10-16，当前实现已同步）：** 采用“对话研究”作为默认主工作区：左侧旅行栏组织 Trip 和对话；中央区域以聊天承载需求补充、单份草案、修订差异和检索进度；右侧提供网页与来源面板，显示当前任务的浏览状态和证据。行程切到独立视图，使用结构化时间线和交互地图；用户可编辑、审阅差异并保存新版本。用户明确要求比较时，在当前草案中说明取舍，不并列显示多方案。参考规格不能证明该布局优于其他方向，仍需真实旅行任务和用户试点验证。

## 6. 来源整合建议（推断）

从这些参考项目抽象的最小连接器契约可包括：

| 字段 | 用途 |
|---|---|
| connector_id / provider | 识别来源、健康状态与版本 |
| capabilities | 声明 search、read、geocode、route、weather 等只读能力 |
| auth_mode / permissions | 让用户了解 key、浏览器登录或 Cookie 的用途与风险 |
| item_id / canonical_url | 去重、打开原文和追溯 |
| content_type / title / text | 区分攻略、官方公告、地点资料和评价 |
| author / published_at / fetched_at | 展示发布方、内容时间和采集时间 |
| geo_candidates / confidence | 将社媒提到的地点匹配到地图并标注置信度 |
| claims / evidence_refs | 将营业时间、票价、路线等事实对应到出处 |
| status / retryable / next_action | 区分未登录、限流、超时、无结果、冲突、需用户处理 |

这是一项实现提案，不是上述仓库共用的既有标准。连接器以只读为默认；新增站点需要能力声明、来源健康检查、权限说明、失败展示、缓存/保留期限和 license/terms 审查。对于社媒 UGC，收集最小必要文本与链接，展示作者/时间，去重后供用户筛选；不要默认批量归档图片、下载视频或再发布内容。

## 7. 对 PRD 的影响与待验证项

1. **核心竞品的全需求公开规格审计已完成。** 12 项 PRD 要求逐项见 3.1。仍需在可运行版本上验证首页、来源查看、行程编辑、失败提示等真实交互；本轮不把源码规格等同于用户体验验证。
2. **不要宣称特征首创。** Travel Agent 覆盖桌面、多会话、真实网页、小红书到地图；huahuanao 覆盖多渠道交叉核验；RoutePilot/JourneyPilot/trip-decider 覆盖证据、版本、验证；Itinerary Workspace/MyTripPlanner 覆盖同步视图和 diff 修改。
3. **用户体验特色要有可观察的工作流结果。** 验收重点放在收藏转地点、修订差异、到离程锚点下的行程可行性、锁定项后的局部修改、以及从同一计划生成准备清单；不要用“更漂亮”“更智能”代替验收。
4. **保持用户看得到但不被工具细节淹没。** Travel Agent 的 UI 规格已经列出无前置表单、草稿保留、明确浏览器状态、空/错/载入状态、键盘操作和旅行卡片等细节；Tripwise 已选择聊天为主的对话研究布局，来源和连接器诊断按需展开，行程视图细节见 [UI/UX 方案](../design/UIUX.md)。
5. **地图与日程、时间与体力都要可审阅。** TREK issues 及 Itinerary Workspace 提示：按日筛选、地点编号、路线段耗时和修改同步是可验收体验；停留/排队/休息的时长应可调或标估，不能以模型给出的分钟数保证可行。
6. **小红书连接器仍是发布门槛，不是纯工程任务。** 专用连接器已实现为默认关闭的实验试点，但平台规则、账户风险、数据最小化与留存、用户授权和目标机失效关停尚待人工审查；Agent-Reach status MCP 不能代替内容检索连接器；若审查不通过，链接/用户导入继续支撑基本工作流。
7. **首版不要为“全渠道”牺牲可靠性。** 可先让网页/地图/天气等基线工具直达，连接器按需启用；任何来源失败都不能丢失用户提供内容或让整个规划失败。

## 8. 重点来源

- 官方数据/接口： [小红书开放平台 API 参考](https://openaccount.xiaohongshu.com/docs/api-reference)、[百度地图官方 MCP](https://github.com/baidu-maps/mcp)、[Open-Meteo MCP](https://github.com/cmer81/open-meteo-mcp)。
- 核心竞品证据： [Travel Agent README](https://github.com/Prism-Shadow/travel-agent)、[根产品规格](https://github.com/Prism-Shadow/travel-agent/blob/main/SPEC.md)、[Web UI 规格](https://github.com/Prism-Shadow/travel-agent/blob/main/packages/web/SPEC.md)、[开发 TODO / 完整任务验收状态](https://github.com/Prism-Shadow/travel-agent/blob/main/tasks/todo.md)。
- 其他高重合开源项目： [huahuanao/travel-agent](https://github.com/huahuanao/travel-agent)、[RoutePilot](https://github.com/tiammomo/RoutePilot)、[JourneyPilot](https://github.com/Lagom-TA/JourneyPilot)、[trip-decider](https://github.com/Hugin-Z/trip-decider)、[Itinerary Workspace](https://github.com/Jameszhao1103/itinerary-workspace)。
- 公开产品反馈： [TREK 行程可行性讨论](https://github.com/liketrek/TREK/discussions/365)、[TREK 地图 issue](https://github.com/liketrek/TREK/issues/1962)、[地图收藏到日程的公开讨论](https://www.reddit.com/r/Travel_Planning/comments/1sz932c/do_you_plan_trips_from_saved_map_pins_or_build/)、[社媒收藏难转行程](https://www.reddit.com/r/travelplanning/comments/1v43lwq/does-anyone-else-have-hundreds-of-saved-travel/)。
- 渠道扩展： [Agent-Reach](https://github.com/Panniantong/Agent-Reach)、[OpenCLI adapters](https://github.com/jackwener/OpenCLI)、[MediaCrawler](https://github.com/NanmiCoder/MediaCrawler)、[xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)。

**审计状态：** 只读检查 Travel Agent `dd0ac16`、Agent-Reach `94f06c1` 和 OpenCLI `e6174a9` 源码；确认 Agent-Reach 自带 MCP 仅提供 `get_status`，XHS 内容查询需调用 OpenCLI 等独立工具。Travel Agent 的 README、根 SPEC、Web UI SPEC 和 TODO 已对照 PRD 12 项需求；研究还比较了桌面 UI/UX、连接器管理、技术栈和图标。用户已选择对话研究布局与 Lucide 图标。研究没有实机运行竞品或核验真实像素布局；因此不声称截图级复刻/视觉评测已完成。当前 OpenCLI 代码路径已被 Tripwise 测试覆盖，但没有真实 Chrome/小红书会话验证。尚未对本产品的 XHS 接入形态完成平台规则/安全审查，也未完成目标用户试点；小红书保持默认关闭并仍是发布门槛。
