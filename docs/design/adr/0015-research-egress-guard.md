# ADR-0015：研究网页出站保护

| 项 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-19 |
| 关联需求 | PR-02、PR-11、AUD-08 |

## 背景

在 `webRequest.onBeforeRequest` 中检查 DNS，只能说明检查时域名解析到了什么地址，不能确保 Chromium 随后连接同一地址。DNS 记录可能变化；系统或用户代理也可能在代理端重新解析原域名。只做请求前检查，无法约束实际 TCP 目标。

## 决策

- 研究网页继续使用独立 `WebContentsView` 和 Electron Session，不获得 Tripwise preload、Node、IPC、权限、下载或弹窗能力。
- 启动只绑定 `127.0.0.1` 随机端口的本机 HTTP 转发器。隔离 Session 通过固定代理访问页面，并用 `proxyBypassRules: '<-loopback>'` 撤销 Chromium 对回环目标的隐式代理绕过。保护器未就绪时，网页请求失败关闭；其他旅行功能可继续使用。
- 每个 HTTP(S) 目标先做 URL 校验，再通过 Electron `resolveHost` 同时查询 DNS A/AAAA，明确禁用缓存。任一应答不是公网单播、没有可用地址或 4 秒内未完成时，拒绝请求。
- 研究页保留 `disable_non_proxied_udp` 策略作为附加限制；每个安全 HTTP(S) 响应都会移除服务端提供的同名头，再设置唯一的 `Connection-Allowlist: ("http://*/*" "https://*/*"); redirects=allow; webrtc=block`。该策略允许正常网页与重定向，每一跳仍经过 URL/DNS/固定 IP 检查，并由 Chromium 阻止页面建立 WebRTC 连接。
- 保护器从默认 Session 的 `resolveProxy(url)` 获取系统或用户代理路由。它只尝试 Electron 列出的路由；不支持的协议失败关闭。
- 直连时，TCP Socket 直接连接已校验 IP。HTTP(S) 代理收到以 IP 为目标的请求或 CONNECT 隧道；HTTP URI 保留原始网页域名只放在 `Host` 头。SOCKS 请求使用 IP 地址作为 CONNECT 目标。这样正常代理不会再按原域名解析目标。
- 来源代理只配置在默认 Session；研究网页 Session 始终只连接本机保护器。模型 API 请求仍不经过来源代理。
- 连接超时、并发连接数和 CONNECT 响应头大小均有上限；应用退出时关闭监听端口并销毁转发 Socket。

## 考虑过的方案

| 方案 | 决定 |
|---|---|
| 只在 `webRequest` 预检 DNS | 不采用。检查结果没有绑定到 Chromium 实际连接，存在检查与连接之间的时间差。 |
| 仅依赖 Chromium 系统代理或用户代理 | 不采用。代理可以在远端重新解析网页域名，应用无法证明其连接目标与本机 DNS 检查结果一致。 |
| 让每个研究网页请求直接使用 Node `fetch` | 不采用。失去 Chromium 页面、Cookie 隔离、导航和渲染行为，也无法替代现有 `WebContentsView`。 |
| 研究页始终强制直连 | 不采用。部分使用环境必须通过系统或用户代理访问公开网站。 |

## 验证

- `tests/research-egress-proxy.test.ts` 覆盖路由解析、DNS A/AAAA 与超时、内网地址拒绝、直连固定 IP、HTTP 代理绝对 URI、HTTPS CONNECT、SOCKS5 和显式路由回退。
- `tests/research-connection-policy.test.ts` 验证畸形或放宽的站点策略会被唯一应用策略覆盖，其他响应头保留，且不改写原始响应对象。
- `tests/e2e/desktop-workspace.mjs` 使用真实 Electron 和本机 HTTP 假代理，访问测试专用域名。Chromium 页面成功加载；上游代理收到 `93.184.216.34:80` 目标和原始 `Host`，测试没有请求真实网站。
- 同一 Electron E2E 临时放宽 WebRTC IP 路由策略，再在研究网页内协商两个本地 PeerConnection；Chromium 仍将两端连接状态置为 `failed`，验证阻断来自响应策略而非 UDP 端口限制。
- `npm run test:e2e:desktop` 覆盖完整桌面交互流程、固定 IP 代理链路和 Chromium WebRTC 阻断。单元测试及构建通过情况以当前验收记录为准。

## 风险与范围

- 系统或用户代理仍是用户信任的网络边界。恶意代理可以忽略 HTTP 目标地址、按自己的策略转发或访问其网络可达的资源；设置页明确要求只配置可信代理。
- 需要认证的代理不受支持；设置页只接收无认证 HTTP、HTTPS 和 SOCKS5 代理。系统代理若要求认证，网页请求会失败，不会绕过到直连。
- Electron 集成验收使用本机 HTTP 代理。实际系统/PAC 代理、TLS 上游代理、代理认证和目标平台网络栈仍需单独验收；HTTPS CONNECT 与 SOCKS 路由由本地协议测试覆盖。
- 当前源码使用 Electron 45.2.3 / Chromium 156.0.8078.80；macOS Electron E2E 已验证 WebRTC 在 TCP/UDP 路由策略放宽时仍被浏览器策略阻断。保存的候选包仍是 Electron 44.10.2 / Chromium 152。Windows/Linux 目标系统尚未运行该 E2E；系统/PAC 路由、TLS 上游代理和 DNS 答案变化的专门竞态矩阵仍需目标平台验收。
- DNS 重绑定不能改变已经交给 Socket 或代理的 IP 目标；对每次后续重定向/子资源请求会重新校验。DNS 答案变化时的专门竞态注入测试仍可补充。
- 使用本机转发器会增加一跳和少量延迟。网络失败时网页显示加载失败，来源导入和其他旅行数据仍保留。

## 参考

- [Electron Session API](https://www.electronjs.org/docs/latest/api/session) 与 [ProxyConfig](https://www.electronjs.org/docs/latest/api/structures/proxy-config)
- [Electron WebContents API：WebRTC IP 处理策略](https://www.electronjs.org/docs/latest/api/web-contents)
- [Electron 45 版本说明](https://www.electronjs.org/blog/electron-45-0)、[Electron 45.2.3 运行时版本](https://releases.electronjs.org/release/v45.2.3) 与 [Connection Allowlist 规范草案](https://wicg.github.io/connection-allowlists/)
- [Node.js HTTP Agent API](https://nodejs.org/api/http.html#class-httpagent)
- [Chromium WebRTC IP handling policy](https://chromium.googlesource.com/chromium/src/+/main/content/public/common/webrtc_ip_handling_policy.h) 与 [RFC 8828](https://www.rfc-editor.org/rfc/rfc8828.html)
- [socks package 源码与协议实现](https://github.com/JoshGlazebrook/socks)
