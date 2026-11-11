/** 生成主界面的最小网络白名单；高德远程脚本只由独立沙箱地图页加载。 */
export function rendererContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:*",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src http://127.0.0.1:*",
    "form-action 'none'"
  ].join('; ')
}

/** 仅供沙箱地图 iframe 使用，网络范围按高德 JS API 与本机受限代理收窄。 */
export function amapFrameContentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "script-src http://127.0.0.1:* https://webapi.amap.com https://*.amap.com https://*.autonavi.com",
    "style-src http://127.0.0.1:* 'unsafe-inline' https://*.amap.com https://*.autonavi.com",
    "img-src http://127.0.0.1:* data: blob: https://*.amap.com https://*.autonavi.com",
    "font-src http://127.0.0.1:* data: https://*.amap.com https://*.autonavi.com",
    "connect-src http://127.0.0.1:* https://*.amap.com https://*.autonavi.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'"
  ].join('; ')
}
