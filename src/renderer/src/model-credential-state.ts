/** 用脱敏后的凭证状态说明模型当前是否可用。 */
import type { ModelProvider, SecretStatus } from '@shared/types'

export type ModelCredentialState = 'stored' | 'missing' | 'unavailable' | 'codex-cli'

/** Codex 使用本机登录态；其他模式在凭证文件损坏时提示修复。 */
export function getModelCredentialState(
  secrets: Pick<SecretStatus, 'modelKeySaved' | 'credentialFileRecoveryRequired'>,
  provider: ModelProvider = 'openai-compatible'
): ModelCredentialState {
  if (provider === 'codex-cli') return 'codex-cli'
  if (secrets.credentialFileRecoveryRequired) return 'unavailable'
  return secrets.modelKeySaved ? 'stored' : 'missing'
}
