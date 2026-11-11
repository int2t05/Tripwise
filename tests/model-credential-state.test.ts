/** 验证模型凭证状态只区分已保存、未配置和文件待修复。 */
import { describe, expect, it } from 'vitest'
import { getModelCredentialState } from '../src/renderer/src/model-credential-state'

const baseStatus = {
  modelKeySaved: false,
  credentialFileRecoveryRequired: false
}

describe('模型凭证状态', () => {
  it('不把未配置或损坏文件误报为已保存', () => {
    expect(getModelCredentialState(baseStatus)).toBe('missing')
    expect(getModelCredentialState(baseStatus, 'codex-cli')).toBe('codex-cli')
    expect(getModelCredentialState({ ...baseStatus, modelKeySaved: true })).toBe('stored')
    expect(getModelCredentialState({ ...baseStatus, credentialFileRecoveryRequired: true })).toBe('unavailable')
    expect(getModelCredentialState({ ...baseStatus, modelKeySaved: true, credentialFileRecoveryRequired: true })).toBe('unavailable')
  })
})
