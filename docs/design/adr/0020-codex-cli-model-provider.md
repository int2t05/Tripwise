# ADR-0020：将 Codex CLI 作为可选模型来源

| 项 | 内容 |
|---|---|
| 状态 | 已由 [ADR-0021](0021-codex-app-server.md) 替代；一次性实现已移除，保留为历史决策 |
| 日期 | 2026-11-07 |
| 关联 | [PRD](../../PRD.md)、[TECH](../TECH.md)、[UIUX](../UIUX.md)、[ADR-0017](0017-long-model-response-transport.md) |

## 背景

OpenAI-compatible 模型可直接使用用户提供的 API Key，但北京案例的 GLM 规划耗时较长，输出质量也需要对照。用户本机已登录 Codex CLI。早期 max 实跑未产出计划；阶段化策略也未完成北京长任务。2026-11-10 按用户要求用 GPT-6 Luna `max` 全阶段复验，流程完成但质量门失败，首稿耗时 72 分钟。

## 决策

- 保留 OpenAI-compatible API 作为默认模式，增加可选 Codex CLI 模式。旧设置缺少 provider 时按原 API 模式读取；切换模式不删除原 API 地址、模型名或 Key。
- 每个模型轮次调用 `codex exec`，显式指定 `gpt-6-luna` 与 `max`。提示词携带 Tripwise 对话、工具 schema 和工具选择；JSON Schema 将 CLI 输出约束为文本或白名单 Tripwise 工具调用。只有 Tripwise 主进程执行返回的工具。
- 只沿用 CLI 自己的登录态；Tripwise 不读取、复制或记录 Codex 认证文件，不向子进程注入其他 API Key。
- 使用 `--ignore-user-config`、`--ephemeral`、只读沙箱和临时工作目录；禁用 CLI shell/代码执行、浏览器、电脑操作、MCP/插件、多 Agent 等工具。临时目录权限为 0700，输入文件为 0600，进程退出后统一清理；提示和错误正文不写入日志。
- Codex 单轮时限 30 分钟，整轮规划 90 分钟；用户取消会终止子进程。未安装或未登录时返回简短可操作错误，不回退到 API Key 模式。
- 设置页默认只显示模型配置；来源凭证与高级选项分栏/折叠。Codex 模式只显示模型名和测试入口。

## 理由

- 复用当前 Codex 登录，不新增用户管理的模型 Key；以 max 档检验完整工具回路。
- 保留 Tripwise 的旅行工具、来源校验、业务规则、工具执行授权与计划结构；模型来源改变不迁移 Agent 责任。
- 显式关闭 Codex 自带工具，降低网页或插件内容诱导子进程读取本机文件、联网或访问浏览器的风险；只读沙箱本身并不等价于关闭这些工具。
- 界面只增加一个模型来源选择，其余技术细节留在高级说明，避免把本地凭证和进阶服务挤在默认视图。

## 代价与限制

- 需要安装并登录兼容版本的 Codex CLI；不同版本可能调整参数或功能开关。启动失败时按固定错误处理，不尝试读取认证文件或自动安装 CLI。
- `codex exec` 按轮次启动独立进程，不复用线程内存；大上下文会重复传入，耗时和配额受 Codex 产品策略影响。2026-11-10 北京实跑中，模型多次追加工具调用并完成首稿、两轮修改，但首稿用时 4,342 秒，路线来源仍未绑定，餐馆来源不足。max 配置已完成联测，质量与时延未达标；不把这次运行视为产品质量通过。进度面板只展示真实状态、动作、工具结果和等待时长，不呈现推断阶段或内部推理。
- 模型质量比较仍需使用同一旅行案例并复核事实来源；一次模型输出不能证明实时信息正确。

## 验收

- 原 OpenAI-compatible 配置的行为和保存兼容性不变；旧数据迁移后 provider 默认为 API 模式。
- Codex 可使用本机登录完成结构化工具调用；返回未知工具、无效 JSON 或非对象参数时拒绝执行。
- CLI 调用中止/超时后子进程退出、临时目录删除；日志和页面不包含提示词、CLI stderr、密钥或认证文件内容。
- 默认设置页只展示模型来源和必要字段；信息源与高级设置仍可访问。

## 参考

- [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)：`codex exec` 用于有界脚本/批任务，应用内长生命周期集成优先使用 SDK 或 app-server。
- [Sandbox security](https://developers.openai.com/api/docs/guides/agents-api/environments/security)：Agent 生成代码能访问执行环境中的文件、凭证和网络，因此设置只读权限之外，还需关闭不需要的本机工具。
