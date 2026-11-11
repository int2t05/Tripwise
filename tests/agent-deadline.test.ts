/** 验证普通模型和长思考模型使用各自时限，且结束后清理计时器。 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentDurationForModel, agentTimeoutMessage, armAgentDeadline, isAgentTimeout, MAX_AGENT_DURATION_MS, MAX_GLM_AGENT_DURATION_MS } from '../src/main/agent-deadline.js'

afterEach(() => vi.useRealTimers())

describe('旅行规划总时限', () => {
  it('三十五分钟后中止请求并提供可区分的超时原因', () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const clearDeadline = armAgentDeadline(controller)

    vi.advanceTimersByTime(MAX_AGENT_DURATION_MS - 1)
    expect(controller.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)

    expect(controller.signal.aborted).toBe(true)
    expect(isAgentTimeout(controller.signal)).toBe(true)
    clearDeadline()
  })

  it('任务先结束时清理截止计时器', () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const clearDeadline = armAgentDeadline(controller)

    clearDeadline()
    vi.advanceTimersByTime(MAX_AGENT_DURATION_MS)

    expect(controller.signal.aborted).toBe(false)
    expect(isAgentTimeout(controller.signal)).toBe(false)
  })

  it('GLM-5.3-Flash 单轮最长 30 分钟，整轮可运行 90 分钟', () => {
    expect(agentDurationForModel('glm-5.3-flash')).toBe(MAX_GLM_AGENT_DURATION_MS)
    expect(agentDurationForModel('glm-5.3-flash')).toBe(90 * 60 * 1_000)
    expect(agentDurationForModel('test-model')).toBe(MAX_AGENT_DURATION_MS)
    expect(agentTimeoutMessage('glm-5.3-flash')).toContain('90 分钟')

    vi.useFakeTimers()
    const controller = new AbortController()
    const clearDeadline = armAgentDeadline(controller, 'GLM-5.3-FLASH')
    vi.advanceTimersByTime(MAX_GLM_AGENT_DURATION_MS - 1)
    expect(controller.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(controller.signal.aborted).toBe(true)
    expect(controller.signal.reason.message).toBe('规划超过 90 分钟时限。')
    clearDeadline()
  })
})
