# 行程有数 Tripwise

[![Desktop validation](https://github.com/int2t05/Tripwise/actions/workflows/desktop.yml/badge.svg?branch=main)](https://github.com/int2t05/Tripwise/actions/workflows/desktop.yml)

Tripwise 是一款开源桌面旅行规划 Agent。用户在对话中说明旅行条件，Agent 展示实际调用的工具与资料来源，生成一份结构化行程草案；用户可以逐轮修改、审阅差异，再决定是否保存。

**当前状态：公开源码预览。** 计划结构和迭代流程已有自动化验证；路线、门店和时效事实可能待核验，适合继续对话完善。当前不提供正式签名安装包。

## 能力

- 左侧旅行与话题、中央对话和计划、右侧来源与隔离研究浏览器。
- Agent 根据当前任务选择网页搜索、网页阅读、天气、地点、路线和已启用的 MCP 工具；每一步及其结果对用户可见。
- 每轮只生成一份行程草案；内容缺口保留为待核验提示，不伪造事实，也不阻止用户继续修改。
- 修改前后显示计划差异；未确认的草案不会覆盖已保存版本。
- 支持 OpenAI-compatible Chat Completions 与本机 Codex App Server；高德地点与路线、Open-Meteo 天气及网页搜索可按需配置。
- Browser Use 只操作应用内隔离网页，不读取系统浏览器登录态，不代登录或处理验证码。

## 本机开发

需要 Node.js `>=22.12.0` 和 npm。

```bash
npm ci
npm run dev
```

在「连接与隐私」中配置模型。地图、天气、搜索和 MCP 为可选服务；未配置时仍可生成带待核验项的计划。

## 验证

```bash
npm run check
npm run test:e2e:desktop
```

北京长流程会调用已保存的模型并联网检索；高德可使用本地 mock：

```bash
npm run evaluate:beijing:desktop-live -- --live --mock-map-services --skip-browser-smoke
```

该长流程用于验收计划结构和多轮修改，不代表真实路线或旅行事实已核验。脱敏结果见[北京评测](docs/evaluation/BEIJING-LIVE.md)。

## 数据与隐私

旅行资料保存在本机 JSON 文件中，未加密。服务密钥保存在本机 `tripwise-credentials.json`，同样未加密；POSIX 系统限制文件权限为 `0600`。发送对话时，旅行简报、消息和所选来源会发送给已配置的模型服务；连接器会收到完成查询所需的信息。不要把本机旅行资料、凭证文件或运行日志提交到公开仓库。更多边界见[技术架构](docs/design/TECH.md#5-安全边界)。

## 文档

- [产品需求](docs/PRD.md)
- [项目状态与剩余事项](docs/PROJECT-STATUS.md)
- [技术架构](docs/design/TECH.md)
- [UI/UX](docs/design/UIUX.md)
- [MCP 与渠道目录](docs/integrations/MCP-CATALOG.md)
- [开源渠道调研](docs/research/scraping-references.md)
- [北京评测摘要](docs/evaluation/BEIJING-LIVE.md)
- [贡献指南](CONTRIBUTING.md)

## 许可

项目代码使用 MIT License。第三方服务、模型、地图与数据来源仍受其各自条款约束。详见 [LICENSE](LICENSE)。
