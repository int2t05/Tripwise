/** 验证模型工具结构错误可见、可回传，并能在同一轮自动重交。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TravelAgent } from '../src/main/agent.js'
import { TripStore } from '../src/main/persistence.js'
import type { SecretVault } from '../src/main/secrets.js'
import type { AgentEvent } from '../src/shared/types.js'

const temporaryDirectories: string[] = []

/** 创建隔离旅行数据，避免联测接触用户资料。 */
async function createPlanningContext() {
  const directory = await mkdtemp(join(tmpdir(), 'tripwise-format-recovery-'))
  temporaryDirectories.push(directory)
  const store = new TripStore(directory)
  await store.initialize()
  await store.createTrip({ destination: '北京', startDate: '2026-11-03', endDate: '2026-11-03' })
  const trip = store.snapshot().trips[0]
  if (!trip) throw new Error('旅行资料未创建。')
  await store.updateSettings({
    ...store.snapshot().settings,
    model: { baseUrl: 'https://model.example/v1', model: 'test-model' },
    connectors: { ...store.snapshot().settings.connectors, webSearch: false, weather: false, places: false, routes: false }
  })
  const vault = { get: async (name: string) => name === 'modelKey' ? 'fixture-model-key' : null } as unknown as SecretVault
  return { store, trip, vault }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('模型工具结构恢复', () => {
  it('把结构 error 显示为步骤，回传模型后接受修正的计划', async () => {
    const { store, trip, vault } = await createPlanningContext()
    const requests: Array<{ messages?: Array<{ role: string; content?: string | null }> }> = []
    const events: AgentEvent[] = []
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content?: string | null }> }
      requests.push(body)
      const response = requests.length === 1
        ? { role: 'assistant', tool_calls: [{
            id: 'malformed-call', type: 'function', function: { name: 'propose_itineraries', arguments: {} }
          }] }
        : requests.length === 2
          ? { role: 'assistant', tool_calls: [{
              id: 'valid-plan', type: 'function', function: { name: 'propose_itineraries', arguments: JSON.stringify({ plan: {
                title: '北京一日游', summary: '按市区片区游览。', tradeoffs: '',
                days: [{ day_number: 1, date: '2026-11-03', title: '市区', stops: [
                  { name: '故宫博物院', area: '东城区', time: '09:00–12:00', duration_minutes: 180,
                    category: '人文景点', notes: '', transit_to_next: '', evidence_level: 'pending', source_ids: [] }
                ] }]
              } }) }
            }] }
          : { role: 'assistant', content: '行程草案已整理，可以继续修改。' }
      return new Response(JSON.stringify({ choices: [{ message: response }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    })

    await new TravelAgent().run(
      store, vault, trip.id, '请规划北京一日游。', 'tool-format-recovery',
      new AbortController().signal, (event) => events.push(event)
    )

    const savedTrip = store.snapshot().trips.find((item) => item.id === trip.id)
    const plan = savedTrip?.messages.flatMap((message) => message.itineraryOptions ?? []).at(-1)
    const formatStep = events.find((event) => event.type === 'tool_result' && event.toolName === 'validate_model_tool_call')
    expect(requests).toHaveLength(3)
    expect(requests[1]?.messages?.at(-1)?.content).toContain('工具调用必须包含有效的 id、function.name')
    expect(formatStep).toMatchObject({
      toolOutcome: 'rejected',
      toolFeedback: [{ severity: 'error', code: 'invalid_tool_call_structure' }]
    })
    expect(plan?.title).toBe('北京一日游')
    expect(events.find((event) => event.type === 'tool' && event.toolName === 'validate_model_tool_call')?.message)
      .toBe('正在校验工具调用格式')
  })
})
