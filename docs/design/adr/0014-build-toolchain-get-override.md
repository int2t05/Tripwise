# ADR-0014：固定 Electron 构建下载器版本

| 项 | 内容 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-10-19 |
| 关联 | [TECH](../TECH.md)、[PRD AUD-07](../../PRD.md)、[ADR-0013](0013-local-json-credentials.md) |

## 背景

`electron-builder@26.17.0` 间接使用 `@electron/get@3.1.0`，其依赖链包含 `global-agent`、`roarr` 和受 GHSA-hp3w-g68c-fv3c 影响的 `sprintf-js@1.1.3`。这些包只用于开发和打包，不进入用户运行依赖。npm 建议降级 `electron-builder` 的修复会引入更多严重告警，因此不采用。

## 决策

在根 `package.json` 中通过 npm `overrides` 将 `@electron/get` 固定到 `5.1.0`，并保留 `electron-builder@26.17.0`。锁文件是该覆盖的唯一安装来源；常规开发与 CI 使用 `npm ci`。

该覆盖跨越 `app-builder-lib` 声明的 `@electron/get ^3.0.0` 主版本范围。上游 v5 是 ESM 模块，最低要求 Node.js `22.12.0`；Tripwise 的构建环境下限为 Node.js `22.12.0`。完整候选流程已在 Node.js `24.21.0` 验证；最低版本的生产构建和测试套件已在 Node.js `22.12.0` 验证。实际使用的下载函数和缓存枚举仍由 v5 提供。

## 验证

- `npm ci` 完成，依赖树中仅保留 `@electron/get@5.1.0`。
- 初始验收时完整 `npm audit` 与 `npm audit --omit=dev` 均为 0 项已知漏洞。
- 从 Node.js 官方清单校验 `22.12.0` macOS arm64 归档 SHA-256 后，在该版本确认 `@electron/get` 可由 CommonJS 调用、`app-builder-lib` 下载器函数和缓存枚举存在；`npm test` 的 395 项 Vitest 与 16 项 Node 脚本测试，以及 `npm run build` 均通过。
- `npm run package:candidate:all` 通过 TypeScript、54 个 Vitest 文件的 395 项测试、16 项 Node 脚本测试、开发版和 macOS 打包版 E2E，并完成 macOS arm64、Windows x64、Linux x64 候选构建。
- 候选门禁确认五个安装包的 SHA-256、DMG/ZIP 容器、三平台 ASAR 文件一致性及 Electron Fuses 均通过。

## 当前审计状态（2026-11-06）

生产依赖审计仍为 0 项；完整审计有 6 项中危，来自 `minimatch`。本日将 `electron-builder` 从 `26.17.0` 更新至 `26.18.1`，并完成三平台候选包、macOS 打包版 E2E 和完整性检查；当前依赖树仍含 `minimatch@9.0.9` 与 `10.2.6`，因此告警未消除。[GHSA](https://github.com/advisories/GHSA-g3hv-75wg-m249) 的修复版为 `11.0.1`；[上游兼容跟踪](https://github.com/electron-userland/electron-builder/issues/10537)仍未关闭。没有覆盖 `minimatch` 主版本范围，以免绕过 `app-builder-lib` 声明的依赖契约。当前状态见[项目进度](../../PROJECT-STATUS.md#当前验收)。

## 代价与复核

该依赖覆盖可能与未来 `app-builder-lib` 对 v3 专属行为的依赖冲突。每次更新 `electron-builder`、`app-builder-lib`、`@electron/get` 或 Node.js 下限时，必须重新执行 `npm ci`、完整依赖审计和 `npm run package:candidate:all`。当稳定版 `app-builder-lib` 原生支持安全版本后，可移除覆盖。
