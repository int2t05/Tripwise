/** 按运行平台规范化 renderer 地址，确保主窗口的 IPC 来源校验可跨平台工作。 */
import { resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 只允许未打包的开发进程使用 renderer 开发服务器地址。 */
export function trustedDevelopmentRendererUrl(isPackaged: boolean, configuredUrl?: string): string | undefined {
  return isPackaged || !configuredUrl?.trim() ? undefined : configuredUrl.trim()
}

/** 仅接受开发服务器同源页面，或与应用内 renderer 文件完全相同的地址。 */
export function isTrustedRendererUrl(
  input: string,
  expectedFilePath: string,
  developmentUrl?: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  try {
    const target = new URL(input)
    if (developmentUrl) {
      const expected = new URL(developmentUrl)
      return !target.username && !target.password && !target.search && isSafeFragment(target.hash) &&
        target.origin === expected.origin && target.pathname === expected.pathname
    }

    if (
      target.protocol !== 'file:' || target.hostname || target.username || target.password ||
      target.search || !isSafeFragment(target.hash) || /%(?:2f|5c)/i.test(target.pathname)
    ) return false

    const targetPath = platform === 'win32'
      ? windowsFileUrlPath(target)
      : fileURLToPath(target)
    if (!targetPath) return false

    if (platform === 'win32') {
      return win32.resolve(targetPath).toLowerCase() === win32.resolve(expectedFilePath).toLowerCase()
    }
    return resolve(targetPath) === resolve(expectedFilePath)
  } catch {
    return false
  }
}

/** 同文档可用简单片段定位；不接受编码、路径或查询式片段。 */
function isSafeFragment(hash: string): boolean {
  return hash === '' || /^#[A-Za-z][A-Za-z0-9_-]*$/.test(hash)
}

/** 将 Windows file URL 的 /C:/ 写法还原为原生盘符路径。 */
function windowsFileUrlPath(url: URL): string | undefined {
  const drivePath = decodeURIComponent(url.pathname)
    .replace(/^\/([a-z]:)(?=\/|$)/i, '$1')
    .replace(/\//g, '\\')
  return win32.isAbsolute(drivePath) ? win32.normalize(drivePath) : undefined
}
