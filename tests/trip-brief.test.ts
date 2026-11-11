/** 验证旅行简报中“暂未知”状态与已知值互斥，并拒绝无效字段。 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMPTY_BRIEF } from '../src/main/persistence/schema.js'
import { TripStore } from '../src/main/persistence.js'
import { parseTripBackup } from '../src/main/persistence/backups.js'
import { normalizeTripBriefUnknownFields } from '../src/shared/trip-brief.js'
import { BUDGET_COST_CATEGORIES } from '../src/shared/budget.js'
import type { ItineraryOption } from '../src/shared/types.js'
import { createSource } from '../src/main/connectors/types.js'

const temporaryDirectories: string[] = []

async function createStore(): Promise<{ directory: string; store: TripStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'tripwise-brief-unknown-'))
  temporaryDirectories.push(directory)
  const store = new TripStore(directory)
  await store.initialize()
  return { directory, store }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('旅行简报暂未知字段', () => {
  it('接受空字段并按简报顺序规范化', () => {
    expect(normalizeTripBriefUnknownFields(['dietary', 'budget'], EMPTY_BRIEF)).toEqual(['budget', 'dietary'])
  })

  it('拒绝重复、未知字段和同时有值的暂未知字段', () => {
    expect(normalizeTripBriefUnknownFields(['budget', 'budget'], EMPTY_BRIEF)).toBeNull()
    expect(normalizeTripBriefUnknownFields(['unknownFields'], EMPTY_BRIEF)).toBeNull()
    expect(normalizeTripBriefUnknownFields(['budget'], { ...EMPTY_BRIEF, budget: '每天 800 元' })).toBeNull()
    expect(normalizeTripBriefUnknownFields('budget', EMPTY_BRIEF)).toBeNull()
  })

  it('把旧 schema 13 旅行迁移为空的暂未知列表并保留其他资料', async () => {
    const { directory, store } = await createStore()
    await store.createTrip({ destination: '上海', interests: '人文' })
    const dataPath = join(directory, 'tripwise-data.json')
    const oldDatabase = JSON.parse(await readFile(dataPath, 'utf8')) as {
      schemaVersion: number
      trips: Array<Record<string, unknown>>
    }
    oldDatabase.schemaVersion = 13
    delete oldDatabase.trips[0].briefUnknownFields
    await writeFile(dataPath, JSON.stringify(oldDatabase))

    const reopenedStore = new TripStore(directory)
    await reopenedStore.initialize()
    expect(reopenedStore.snapshot().schemaVersion).toBe(16)
    expect(reopenedStore.snapshot().trips[0]).toMatchObject({
      brief: { destination: '上海', interests: '人文' },
      briefUnknownFields: []
    })
  })

  it('把 schema 14 本地数据迁移到当前 schema 16', async () => {
    const { directory, store } = await createStore()
    await store.createTrip({ destination: '北京' })
    const dataPath = join(directory, 'tripwise-data.json')
    const previousDatabase = JSON.parse(await readFile(dataPath, 'utf8')) as { schemaVersion: number }
    previousDatabase.schemaVersion = 14
    await writeFile(dataPath, JSON.stringify(previousDatabase))

    const reopenedStore = new TripStore(directory)
    await reopenedStore.initialize()
    expect(reopenedStore.snapshot().schemaVersion).toBe(16)
    expect(JSON.parse(await readFile(dataPath, 'utf8')).schemaVersion).toBe(16)
  })

  it('把 schema 15 本地数据迁移到 schema 16，并默认关闭网页图像识别', async () => {
    const { directory, store } = await createStore()
    await store.createTrip({ destination: '北京' })
    const dataPath = join(directory, 'tripwise-data.json')
    const previousDatabase = JSON.parse(await readFile(dataPath, 'utf8')) as {
      schemaVersion: number
      settings: Record<string, unknown>
    }
    previousDatabase.schemaVersion = 15
    delete previousDatabase.settings.researchBrowserVisualRead
    await writeFile(dataPath, JSON.stringify(previousDatabase))

    const reopenedStore = new TripStore(directory)
    await reopenedStore.initialize()

    expect(reopenedStore.snapshot().schemaVersion).toBe(16)
    expect(reopenedStore.snapshot().settings.researchBrowserVisualRead).toBe(false)
    const savedDatabase = JSON.parse(await readFile(dataPath, 'utf8'))
    expect(savedDatabase.schemaVersion).toBe(16)
    expect(savedDatabase.settings.researchBrowserVisualRead).toBe(false)
  })

  it('在 v9 旅行备份中保留显式未知状态，并将 v8 迁移为空列表', async () => {
    const { store } = await createStore()
    await store.createTrip({ destination: '成都' })
    const trip = store.snapshot().trips[0]
    await store.updateBrief(trip.id, { ...trip.brief, budget: '' }, ['budget'])
    const currentTrip = store.snapshot().trips[0]

    const current = parseTripBackup({ format: 'tripwise-trip-backup', formatVersion: 9, trip: currentTrip })
    expect(current?.briefUnknownFields).toEqual(['budget'])

    const oldTrip = structuredClone(currentTrip) as unknown as Record<string, unknown>
    delete oldTrip.briefUnknownFields
    const previous = parseTripBackup({ format: 'tripwise-trip-backup', formatVersion: 8, trip: oldTrip })
    expect(previous?.briefUnknownFields).toEqual([])
  })

  it('在 v10 旅行备份中保留逐项预算，并拒绝费用项的未知字段', async () => {
    const { store } = await createStore()
    await store.createTrip({ destination: '北京' })
    const trip = store.snapshot().trips[0]
    const now = new Date().toISOString()
    const option: ItineraryOption = {
      id: 'budget-option', title: '预算待核验方案', summary: '先明确费用待核验项。', tradeoffs: '金额尚不完整。',
      budgetEstimate: {
        currency: 'CNY',
        items: BUDGET_COST_CATEGORIES.map((category, index) => ({
          id: `budget-item-${index}`, category, title: `${category}费用`, amountMinFen: null, amountMaxFen: null,
          quantity: 1, unitLabel: '人', evidenceLevel: 'pending', sourceIds: [], basis: '价格尚未核验。'
        })),
        notApplicableCategories: []
      },
      days: [{
        id: 'budget-day', dayNumber: 1, date: '', title: '北京城区', scheduleBlocks: [],
        stops: [{
          id: 'budget-stop', name: '故宫', area: '', time: '', durationMinutes: null, category: '人文', notes: '',
          transitToNext: '', evidenceLevel: 'pending', sourceIds: [], factClaims: []
        }]
      }]
    }
    await store.appendMessage(trip.id, {
      id: 'budget-message', role: 'assistant', content: '预算方案。', createdAt: now, sourceIds: [], itineraryOptions: [option]
    })
    const currentTrip = store.snapshot().trips[0]
    const current = parseTripBackup({ format: 'tripwise-trip-backup', formatVersion: 11, trip: currentTrip })
    expect(current?.messages[0].itineraryOptions?.[0].budgetEstimate).toEqual(option.budgetEstimate)
    expect(parseTripBackup({ format: 'tripwise-trip-backup', formatVersion: 10, trip: currentTrip })).not.toBeNull()

    const tamperedTrip = structuredClone(currentTrip) as unknown as Record<string, unknown>
    const messages = tamperedTrip.messages as Array<Record<string, unknown>>
    const options = messages[0].itineraryOptions as Array<Record<string, unknown>>
    const estimate = options[0].budgetEstimate as Record<string, unknown>
    const items = estimate.items as Array<Record<string, unknown>>
    items[0].unexpected = '不允许的字段'
    expect(parseTripBackup({ format: 'tripwise-trip-backup', formatVersion: 11, trip: tamperedTrip })).toBeNull()
  })

  it('持久化并备份限长网页事实摘录，拒绝超出边界的摘录', async () => {
    const { directory, store } = await createStore()
    await store.createTrip({ destination: '北京' })
    const trip = store.snapshot().trips[0]
    const source = createSource('故宫参观须知', 'https://example.com/palace', 'Firecrawl 网页正文', 'web', '故宫开放摘要。')
    source.contentLevel = 'page'
    source.factEvidenceExcerpt = '故宫博物院开放时间为 08:30 至 17:00。'.repeat(40).slice(0, 2_400)
    await store.saveSources(trip.id, [source])

    const reopened = new TripStore(directory)
    await reopened.initialize()
    const savedTrip = reopened.snapshot().trips[0]
    const savedSource = savedTrip.sources.find((item) => item.id === source.id)
    const backup = parseTripBackup({ format: 'tripwise-trip-backup', formatVersion: 11, trip: savedTrip })

    expect(savedSource?.factEvidenceExcerpt).toBe(source.factEvidenceExcerpt)
    expect(backup?.sources.find((item) => item.id === source.id)?.factEvidenceExcerpt).toBe(source.factEvidenceExcerpt)
    const invalidTrip = structuredClone(savedTrip) as unknown as Record<string, unknown>
    const sources = invalidTrip.sources as Array<Record<string, unknown>>
    sources[0]!.factEvidenceExcerpt = '正文'.repeat(1_201)
    expect(parseTripBackup({ format: 'tripwise-trip-backup', formatVersion: 11, trip: invalidTrip })).toBeNull()
  })

  it('用户确认模型新值后自动清除该字段的暂未知标记', async () => {
    const { store } = await createStore()
    await store.createTrip({ destination: '北京' })
    const trip = store.snapshot().trips[0]
    await store.updateBrief(trip.id, { ...trip.brief, budget: '' }, ['budget'])
    const current = store.snapshot().trips[0]
    await store.appendMessage(trip.id, {
      id: 'brief-proposal-1',
      conversationId: trip.activeConversationId,
      role: 'assistant',
      content: '可以按每天 800 元估算。',
      createdAt: new Date().toISOString(),
      sourceIds: [],
      briefProposal: { base: { budget: '' }, changes: { budget: '每天 800 元' } }
    })

    await store.applyBriefProposal(trip.id, 'brief-proposal-1', current.activeConversationId)
    expect(store.snapshot().trips[0]).toMatchObject({ brief: { budget: '每天 800 元' }, briefUnknownFields: [] })
  })
})
