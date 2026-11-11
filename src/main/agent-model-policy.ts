/** 为模型来源选择兼容的推理强度。 */
import type { ModelProvider } from '../shared/types.js'
import type { ModelReasoningEffort } from './llm.js'

/** Codex App Server 固定使用 max；OpenAI-compatible 沿用 Agent 当前阶段强度。 */
export function reasoningEffortForProvider(
  provider: ModelProvider | undefined,
  compatibleEffort: ModelReasoningEffort
): ModelReasoningEffort {
  if (provider !== 'codex-cli') return compatibleEffort
  return 'max'
}
