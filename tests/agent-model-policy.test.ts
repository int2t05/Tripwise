/** 验证不同模型来源的推理强度。 */
import { describe, expect, it } from 'vitest'
import { reasoningEffortForProvider } from '../src/main/agent-model-policy.js'

describe('Agent 模型来源策略', () => {
  it('Codex App Server 统一使用 max', () => {
    expect(reasoningEffortForProvider('codex-cli', 'low')).toBe('max')
  })

  it('OpenAI-compatible 模型继续使用已有阶段选择', () => {
    expect(reasoningEffortForProvider('openai-compatible', 'low')).toBe('low')
    expect(reasoningEffortForProvider('openai-compatible', 'high')).toBe('high')
  })
})
