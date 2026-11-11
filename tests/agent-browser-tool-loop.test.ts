/** 验证浏览器由模型显式选择，工具回执和熔断状态对用户可见。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../src/shared/types.js'
import { TravelAgent } from '../src/main/agent.js'
import { BrowserNavigationError, createSource, type ResearchBrowserToolController } from '../src/main/connectors/types.js'
import { executeTool } from '../src/main/tools.js'
import { TripStore } from '../src/main/persistence.js'
import type { SecretVault } from '../src/main/secrets.js'

const temporaryDirectories: string[] = []
const officialUrl = 'https://www.dpm.org.cn/Visit.html'

/** 为 Agent 联测创建隔离的旅行目录和模型设置。 */
async function createPlanningContext() {
  const path = await mkdtemp(join(tmpdir(), 'tripwise-agent-tool-loop-'))
  temporaryDirectories.push(path)
  const store = new TripStore(path)
  await store.initialize()
  await store.createTrip({
    destination: '北京', interests: '故宫', startDate: '2026-11-10', endDate: '2026-11-10'
  })
  const trip = store.snapshot().trips[0]
  if (!trip) throw new Error('旅行资料未创建。')
  await store.updateSettings({
    ...store.snapshot().settings,
    model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
    connectors: { ...store.snapshot().settings.connectors, webSearch: true }
  })
  const vault = {
    get: async (name: string) => name === 'modelKey' ? 'fixture-model-key' : null
  } as unknown as SecretVault
  return { store, trip, vault }
}

/** 构造结构完整的计划候选，测试只关注 Agent 调用顺序。 */
function itineraryCall() {
  return {
    plan: {
      title: '北京故宫一日游', summary: '按城区和时段安排。', tradeoffs: '开放时间以来源复核。',
      days: [{ day_number: 1, date: '2026-11-10', title: '故宫人文', stops: [{
        name: '故宫博物院', area: '东城区', time: '09:00–12:00', duration_minutes: 180,
        category: '人文', notes: '开放信息以来源为准。', transit_to_next: '',
        evidence_level: 'pending', source_ids: [], fact_claims: []
      }] }]
    }
  }
}

/** 按脚本返回模型工具调用，记录每次请求开始前已执行的真实工具数。 */
function stubModel(
  steps: Array<{ name: string; arguments: Record<string, unknown> } | { content: string }>,
  executedTools: string[],
  requests: Array<{ messages?: Array<{ role: string; content?: string | null }>; executionCount: number }>
): void {
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content?: string | null }> }
    requests.push({ ...body, executionCount: executedTools.length })
    const step = steps[requests.length - 1]
    if (!step) throw new Error('测试脚本缺少模型响应。')
    const message = 'content' in step
      ? { role: 'assistant', content: step.content }
      : { role: 'assistant', tool_calls: [{
          id: `call-${requests.length}`, type: 'function',
          function: { name: step.name, arguments: JSON.stringify(step.arguments) }
        }] }
    return new Response(JSON.stringify({ choices: [{ message }] }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  })
}

/** 构造右侧可见研究浏览器。 */
function browserController(
  navigate: ResearchBrowserToolController['navigate']
): ResearchBrowserToolController {
  return {
    isAvailable: () => true,
    navigate,
    readSnapshot: vi.fn(async () => ({
      url: officialUrl, title: '故宫博物院参观指南', text: '官方正文：开放时间和预约要求以参观须知为准。', links: []
    })),
    scroll: vi.fn(async () => undefined),
    interact: vi.fn(async () => ({ action: 'expand' as const }))
  }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('模型驱动的研究工具循环', () => {
  it('搜索警告回到模型后，由模型选择可见浏览器并再提交计划', async () => {
    const { store, trip, vault } = await createPlanningContext()
    const executedTools: string[] = []
    const requests: Array<{ messages?: Array<{ role: string; content?: string | null }>; executionCount: number }> = []
    const browser = browserController(vi.fn(async (url) => ({ url: String(url), title: '故宫博物院参观指南' })))
    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      executedTools.push(name)
      if (name === 'search_web') {
        return {
          output: '搜索渠道暂不可用。',
          sources: [createSource('搜索服务状态', 'https://search.example/status', 'Exa 搜索结果', 'web', 'HTTP 402：额度不足。', 'error')],
          feedback: [{ severity: 'warning', code: 'search_quota', message: '搜索渠道额度不足。' }]
        }
      }
      return executeTool(name, rawArguments, context, signal)
    }
    stubModel([
      { name: 'search_web', arguments: { query: '故宫官方开放时间' } },
      { name: 'research_browser_navigate', arguments: { url: officialUrl } },
      { name: 'propose_itineraries', arguments: itineraryCall() },
      { content: '北京一日计划已整理。' }
    ], executedTools, requests)

    const events: AgentEvent[] = []
    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id, '请规划北京一日游，按时段安排故宫并核对开放时间。',
      'model-selects-browser', new AbortController().signal, (event) => events.push(event),
      undefined, undefined, browser
    )

    const secondRequestTools = requests[1]?.messages?.filter((message) => message.role === 'tool') ?? []
    const searchReceipt = JSON.parse(secondRequestTools.at(-1)?.content ?? '{}') as {
      status?: string; feedback?: Array<{ severity?: string; code?: string }>
    }
    expect(requests.map((request) => request.executionCount)).toEqual([0, 1, 2, 3])
    expect(searchReceipt.status).toBe('warning')
    expect(searchReceipt.feedback).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'search_quota' }))
    expect(executedTools).toEqual(['search_web', 'research_browser_navigate', 'propose_itineraries'])
    expect(browser.navigate).toHaveBeenCalledOnce()
    expect(events.filter((event) => event.type === 'tool').map((event) => event.toolName)).toEqual(executedTools)
    expect(events.filter((event) => event.type === 'tool_result').map((event) => event.toolName)).toEqual(executedTools)
    expect(store.snapshot().trips.find((item) => item.id === trip.id)?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'Tripwise 研究浏览器', contentLevel: 'page', status: 'success' })
    ]))
  })

  it('重复网络失败只熔断当前主机，仍允许模型选择其他来源', async () => {
    const { store, trip, vault } = await createPlanningContext()
    const executedTools: string[] = []
    const requests: Array<{ messages?: Array<{ role: string; content?: string | null }>; executionCount: number }> = []
    let currentUrl = ''
    const browser = browserController(vi.fn(async (url) => {
      currentUrl = String(url)
      if (new URL(currentUrl).hostname === 'dead.example') {
        throw new BrowserNavigationError('started', new Error('net::ERR_CONNECTION_RESET'))
      }
      return { url: currentUrl, title: '公开来源' }
    }))
    const toolExecutor: typeof executeTool = async (name, rawArguments, context, signal) => {
      executedTools.push(name)
      return executeTool(name, rawArguments, context, signal)
    }
    stubModel([
      { name: 'research_browser_navigate', arguments: { url: 'https://dead.example/visit' } },
      { name: 'research_browser_navigate', arguments: { url: 'https://dead.example/visit' } },
      { name: 'research_browser_navigate', arguments: { url: 'https://public.example/visit' } },
      { name: 'research_browser_navigate', arguments: { url: 'https://dead.example/visit' } },
      { name: 'propose_itineraries', arguments: itineraryCall() },
      { content: '北京一日计划已整理。' }
    ], executedTools, requests)

    const events: AgentEvent[] = []
    await new TravelAgent(toolExecutor).run(
      store, vault, trip.id, '请规划北京一日游，按时段安排故宫。',
      'browser-host-circuit', new AbortController().signal, (event) => events.push(event),
      undefined, undefined, browser
    )

    expect(browser.navigate).toHaveBeenCalledTimes(3)
    expect(browser.navigate).toHaveBeenNthCalledWith(1, 'https://dead.example/visit', expect.any(AbortSignal))
    expect(browser.navigate).toHaveBeenNthCalledWith(2, 'https://dead.example/visit', expect.any(AbortSignal))
    expect(browser.navigate).toHaveBeenNthCalledWith(3, 'https://public.example/visit', expect.any(AbortSignal))
    const browserResults = events.filter((event) => event.type === 'tool_result' && event.toolName === 'research_browser_navigate')
    expect(browserResults).toHaveLength(4)
    expect(browserResults[2]?.toolOutcome).toBe('completed')
    expect(browserResults[3]?.toolFeedback).toContainEqual(expect.objectContaining({
      severity: 'warning', code: 'browser_network_circuit_open'
    }))
    expect(executedTools).toEqual([
      'research_browser_navigate', 'research_browser_navigate', 'research_browser_navigate', 'propose_itineraries'
    ])
  })
})
