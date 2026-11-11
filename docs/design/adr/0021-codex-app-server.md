# ADR-0021：Codex App Server 持久会话

| 项 | 内容 |
|---|---|
| 状态 | 已实现；持久会话、恢复、工具回执和话题清理通过协议验证；北京旅行质量见[评测](../../evaluation/TRAVEL-CASES.md) |
| 日期 | 2026-11-11 |
| 关联 | [TECH](../TECH.md)、[ADR-0020](0020-codex-cli-model-provider.md)、[旅行评测](../../evaluation/TRAVEL-CASES.md) |

## 决策

Codex 模型连接直接启动本机 Codex CLI 的常驻 `codex app-server --stdio` 子进程，不使用每次独立启动的 `codex exec`，也不把 Codex 当作普通一次性 HTTP 模型请求。每个 Tripwise 话题关联一个持久 Codex thread，App Server 进程重启后可恢复。官方协议提供双向 JSONL RPC、消息增量与 turn 完成事件；[LLM-for-Zotero](https://github.com/yilewang/llm-for-zotero) 采用同类接入方式。[官方 Codex App Server 文档](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

Tripwise 继续拥有旅行工具的选择协议、权限检查、执行、结果保存、`error/warning/info` 反馈和步骤 UI。Codex 内置工具、用户 MCP、插件、网页、shell、浏览器和 computer-use 在 App Server 进程中关闭；不使用 experimental `dynamicTools`。

## 依据

- 现行实现位于 [`src/main/codex-app-server.ts`](../../../src/main/codex-app-server.ts)；`src/main/llm.ts` 转换 Tripwise 对话与结构化输出，`src/main/agent.ts` 管理本轮工具回执与持久 thread 的衔接。
- App Server 支持持久 thread、恢复、流式事件、取消，并以 `turn/start.toolOutput` 追加应用执行的工具结果；使用该字段时必须令 `input` 为空。官方接入流程明确要求保存 thread ID、显示 `item/agentMessage/delta`，并检查 `turn/completed` 状态；Tripwise 按协议恢复 thread 和追加工具回执。[官方接入说明](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- OpenAI 将 `codex exec` 定位为有界任务，将 App Server/SDK 定位为持久应用集成：[Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)。
- Zotero 在固定快照 [`e99ab04`](https://github.com/yilewang/llm-for-zotero/tree/e99ab04709ac0db63c9c591577fddc2c182c8e42) 中复用 App Server 进程与 thread，并将回答增量、计划、工具活动和用量回调到 UI；其源码仅作设计参考，本项目未复制代码。[进程与并发管理](https://github.com/yilewang/llm-for-zotero/blob/e99ab04709ac0db63c9c591577fddc2c182c8e42/src/utils/codexAppServerProcess.ts)、[UI 事件回调](https://github.com/yilewang/llm-for-zotero/blob/e99ab04709ac0db63c9c591577fddc2c182c8e42/src/modules/contextPanel/codexNative/turnCallbacks.ts)。
- Tripwise 同样读取 `item/agentMessage/delta`，但模型被要求输出 Tripwise 结构 JSON；主进程在 turn 完成后校验并解析，再驱动工具循环。界面展示已校验的计划、真实工具开始/结果及 warning/error，不展示原始 JSON 或内部推理。它提供持续会话和可观察的 Agent 步骤，但不逐字展示模型的结构化输出；这是输出协议的选择，不是 `codex exec` 单次调用。
- 本机 Codex `0.167.0-alpha.3.2` 的隔离探针通过：6 个用户 MCP 全部关闭、22 个已启用/指定功能全部关闭，模型目录含 `gpt-6-luna` 与 `max`。
- 真实模型短 smoke 通过：`gpt-6-luna/max` 创建持久 thread 并返回 1 个 Tripwise 结构化工具调用，耗时 115.68 秒；thread 随后删除。北京多轮实跑进一步验证了工具回注与修订。
- 北京完整实跑验证首稿、工具回执与两轮局部修改都在 App Server 话题上完成：15 次模型请求、约 17 分钟，无 App Server 请求失败。旅行质量未通过，路线绑定 0 天、81 项动态事实待核验、第二轮未落实具名晚餐；详见[评测](../../evaluation/TRAVEL-CASES.md)。
- 2026-11-11 OpenAI-compatible 北京复跑曾确认路线工具可见但模型未选择。加入有界计划回执复核后，最新复跑总计 634 秒、37 次模型请求；模型调用两次餐次修订但仍未调用路线工具，0 天路线来源，9/24 前门晚餐未具名。复核只提示模型自主取舍，不自动补查路线；完整指标见[最新评测](../../evaluation/TRAVEL-CASES.md)。
- 路线回执修改后的多次北京复跑未形成计划。2026-11-10 最新实跑耗时 517 秒；22 次模型请求中 21 次完成，末轮收到 `usageLimitExceeded`，前有 4 次 `responseStreamDisconnected` 通知并由服务端重试。新分类器将终态映射为额度不足，不再记作 `unknown_error`。本轮记录 28 次工具调用和 27 条来源，仍未产出草案；外部搜索服务也受额度/套餐限制。日志只保留固定类别、状态码、重试状态和耗时，不保存错误正文。
- 额度失败恢复回归：检索来源与工具回执先写入本地检查点；模型失败后，用户可从末尾未完成消息重试，复用来源和对话进度而不重复写入用户消息。`tests/agent-loop.test.ts` 覆盖检索成功、`insufficient_quota`、恢复重试；Codex 错误通知分类由 `tests/codex-app-server.test.ts` 覆盖。真实额度恢复后的长流程尚未复验。
- `tests/codex-app-server.test.ts` 使用本地假 JSONL 服务验证线程复用、回执追加、重启恢复、功能隔离参数及删除；该测试不连接模型或用户账户。

## 安全与恢复边界

- 启动先只读读取本机 MCP 与启用功能名，再使用逐项配置覆盖关闭；第二次读取确认无启用 MCP/功能，否则阻止真实请求。异常名称或配置形状 fail closed。
- Tripwise 不读取、复制或记录 Codex 登录凭证。App Server 仅接收指定的运行环境变量；thread 请求 `read-only` 沙箱，并在启动时关闭和验证所有已发现的 Codex MCP 与内置功能。模型只接收 Tripwise 提供的工具协议，不获得 Codex shell、文件、网页、浏览器或 computer-use 工具。App Server 仍需联网连接模型服务。
- Tripwise userData 的 `0600` 索引仅保存话题键与 Codex thread ID，不保存消息正文。Codex thread 内容由 Codex 自己持久化；删除旅行/话题时请求同步删除，清理失败时留待下次启动重试。
- 取消、超时或协议错误停止当前 turn；App Server 版本不兼容或隔离无法验证时不退回一次性调用。
- 2026-11-10 真实取消 smoke：`turn/interrupt` 返回 JSON-RPC `-32600`，消息分类为 `no_active_turn`，且未观察到 `turn/completed`。进程当时仍存活；Tripwise 有意发送 `SIGTERM` 清理无法确认状态的连接，并记录 `process.restarting`，不是 CLI 自退。新进程重新验证隔离、恢复同一 thread 并完成下一轮。测试用假服务另覆盖“错误后终态事件随后到达”路径，该路径保留同一进程；若没有终态事件则重启恢复。当前真实 CLI 的“同进程取消后继续”未通过，安全恢复路径已验证。
- App Server 属于随 Codex CLI 发布的协议接口，CLI 更新可能改变协议行为；升级时继续运行本地协议测试和真实 stream/cancel smoke。当前方案复用 Codex 会话运行时，不等于 Codex Desktop 的 UI、工具或会话列表完全相同。[官方 CLI 参考](https://developers.openai.com/codex/cli/reference)、[官方 App Server 接入说明](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。

## 验收

| 项 | 状态 |
|---|---|
| 持久话题、增量回执、重启恢复、删除清理 | 本地协议测试通过；真实北京首稿与两轮修改在同一 Tripwise 话题完成 |
| 只开放 Tripwise 工具 | 只读运行配置探针通过；代码启动时重复校验 |
| 结构化输出与工具格式校验 | 本地协议测试和真实模型短 smoke 通过 |
| 取消、异常退出与长任务 | 假服务覆盖异常退出后恢复 thread 与 turn 失败后复用进程；北京最新实跑准确识别额度耗尽和 4 次流断开重试，未形成计划 |
| 北京详细案例 | App Server 流程可运行；本次受 Codex 额度限制未形成计划，旅行内容质量门未通过 |
