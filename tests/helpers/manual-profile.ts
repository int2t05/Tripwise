/** 为需使用本机保存配置的手动评测提供跨平台资料目录。 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 按 Electron userData 的平台默认位置定位本机配置。 */
export function defaultTripwiseUserDataDirectory(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'tripwise')
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'tripwise')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'tripwise')
}

/** 只读取本机设置文档；凭证仍由 SecretVault 单独解密和访问。 */
export async function readTripwiseProfile(userDataDirectory: string): Promise<unknown> {
  return JSON.parse(await readFile(join(userDataDirectory, 'tripwise-data.json'), 'utf8')) as unknown
}
