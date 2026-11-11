/** 验证长模型请求的传输等待上限与单轮时限一致。 */
import { describe, expect, it, vi } from 'vitest'

type AgentTimeouts = { headersTimeout: number; bodyTimeout: number }

const transport = vi.hoisted(() => ({ options: null as AgentTimeouts | null }))

vi.mock('undici', () => ({
  Agent: class {
    constructor(options: AgentTimeouts) {
      transport.options = options
    }

    async close(): Promise<void> {}
  }
}))

import '../src/main/llm.js'

describe('模型长响应传输时限', () => {
  it('响应头与正文等待上限均覆盖 GLM 单轮最长时限', () => {
    expect(transport.options).toEqual({ headersTimeout: 30 * 60 * 1_000, bodyTimeout: 30 * 60 * 1_000 })
  })
})
