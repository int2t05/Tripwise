# 项目状态

更新：2026-11-12

状态：MIT 源码与 v0.1.0 预览版已公开，提供 macOS Apple Silicon、Windows x64、Linux x64 安装包。主分支三平台 CI 与 tag 发布 CI 全绿。

需求见 [PRD](PRD.md)，实现见 [TECH](design/TECH.md) 与 [UI/UX](design/UIUX.md)，脱敏长流程记录见[北京评测](evaluation/BEIJING-LIVE.md)。本机历史评测原文不进入公开仓库。

| 项目 | 当前状态 | 证据或限制 |
|---|---|---|
| Agent 主流程 | 可用 | 对话识别意图，按需调用工具；界面展示工具步骤、结果、来源和警告。每轮一份计划草案，用户确认后保存。 |
| 多轮修改 | 通过 | 北京长流程生成 7 日计划并完成两次局部修订；每次仅修改目标日，未自动保存。 |
| 计划结构 | 通过 | 北京长流程首稿覆盖 7 日、40 个停靠点和 18 个餐次；日期连续，4 个指定景点齐全。内容覆盖不是通用结构门。 |
| 内容质量 | 待后续迭代 | 18 餐中 9 餐有候选名、0 餐有直接来源；动态开放、预约和票价事实待核验。路线与门店缺口作为 warning 保留，支持继续对话补全。 |
| 工具 trace | 已检查 | 首稿路线 mock 收到 3 次请求；第二轮内置浏览器导航 1 次、读取 1 个网页来源，并将 1 条 mock 路线绑定到目标日。Exa、Tavily、Firecrawl 因额度或计划限制失败，后备搜索有结果。 |
| 工程回归 | 通过 | `npm run check`、三平台桌面/打包版 E2E、候选包校验和上传均通过，[main CI](https://github.com/int2t05/Tripwise/actions/runs/43111137295)；发布包通过 tag CI，[tag CI](https://github.com/int2t05/Tripwise/actions/runs/43051483165)。资产命名与校验清单流程另经 YAML/Bash 和样例包校验。 |
| 依赖审计 | 有限风险已记录 | 当前生产依赖审计 0 项；完整依赖审计有 6 项中危，集中在 `electron-builder` 的 `minimatch` 构建依赖链，无高危/严重项。CI 保留审计报告并以高危为失败阈值。 |
| 凭证与本机数据 | 有边界说明 | 服务凭证和旅行数据以本机 JSON 保存，不加密；POSIX 权限分别受限。本次隔离实跑未发现凭证进入日志或行程数据，测试目录退出后清理。 |
| GitHub 发布 | v0.1.0 预览版已发布 | [Release](https://github.com/int2t05/Tripwise/releases/tag/v0.1.0)：macOS arm64 DMG/ZIP、Windows x64 安装包/ZIP、Linux x64 AppImage，附 `SHA256SUMS`。附件名称已统一，校验清单与已发布包摘要一致。安装包未正式签名或公证；第三方服务条款仍由使用者按启用渠道核对。 |

## 后续

- 使用真实旅行时，继续通过对话补全路线、门店、开放时间和预约来源；系统保留待核验状态。
- 若发布签名安装包，再完成 macOS 签名与公证，以及 Windows/Linux 原生安装验收和地图、内容渠道条款复核。
- 等构建依赖链提供兼容修复后，升级 `minimatch` 并复核构建工具链审计。
