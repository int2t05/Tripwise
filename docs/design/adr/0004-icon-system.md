# ADR-0004：界面图标系统

| 项 | 内容 |
|---|---|
| 状态 | Accepted（用户已确认） |
| 日期 | 2026-10-16 |
| 关联 | [UI/UX](../UIUX.md) |

## 背景

Tripwise 是信息密度较高的桌面规划工作区，需要一致的导航、来源状态、行程和准备操作图标。用户在原型方向选择中明确指定 Lucide。

## 决策

产品 UI 使用 **Lucide** 作为唯一的系统图标库。品牌 Logo 不属于系统图标，另行设计。图标要么有可见文字标签，要么提供有意义的可访问名称；不能只用颜色表达状态。

## 后果

### 正面

- 用户已选择，统一图标语言，减少实现时各页面临时拼库。
- 线性图标便于在旅行栏、工具状态和结构化行程操作中保持克制风格。

### 代价

- 对需要多种填充/粗细风格的强调状态，可选表现空间少于多风格图标库；状态仍由文字、形状和布局补足。
- 实现需固定包版本并保留上游许可声明；本 ADR 不决定品牌图形或完整视觉规范。

## 替代方案

**Phosphor**：Travel Agent 当前 React 依赖使用 Phosphor，且其样式重量选择更多。它是合理备选，但用户已明确选择 Lucide，因此本项目不混用或切换为 Phosphor。

## 参考

- [Lucide](https://github.com/lucide-icons/lucide)（访问：2026-10-16）— 用户指定的图标库与上游实现。
- [Travel Agent React package manifest](https://raw.githubusercontent.com/Prism-Shadow/travel-agent/main/packages/web/package.json)（访问：2026-10-16）— 该竞品使用 Phosphor；作为比较样本，不覆盖用户对 Tripwise 的明确选择。
