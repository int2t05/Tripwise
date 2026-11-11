/** 覆盖连接设置与系统凭证库分步保存时的部分成功结果。 */
import { describe, expect, it } from 'vitest'
import { saveSettingsAndSecrets } from '../src/renderer/src/settings-save.js'

describe('设置与凭证保存流程', () => {
  it('报告密钥失败时仍返回已保存的普通设置快照', async () => {
    const settingsSnapshot = { revision: 2 }
    const error = new Error('凭证库暂不可用')
    const result = await saveSettingsAndSecrets(
      async () => settingsSnapshot,
      async () => { throw error }
    )

    expect(result).toEqual({ kind: 'secrets-failed', snapshot: settingsSnapshot, error })
  })

  it('两步成功时返回包含最新凭证状态的快照', async () => {
    const settingsSnapshot = { revision: 2 }
    const secretSnapshot = { revision: 3 }
    const result = await saveSettingsAndSecrets(
      async () => settingsSnapshot,
      async () => secretSnapshot
    )

    expect(result).toEqual({ kind: 'saved', snapshot: secretSnapshot })
  })

  it('普通设置保存失败时不尝试写入凭证', async () => {
    let secretsAttempted = false
    await expect(saveSettingsAndSecrets(
      async () => { throw new Error('设置保存失败') },
      async () => { secretsAttempted = true; return {} }
    )).rejects.toThrow('设置保存失败')
    expect(secretsAttempted).toBe(false)
  })
})
