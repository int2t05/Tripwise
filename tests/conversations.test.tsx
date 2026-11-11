/** 验证旅行内话题隔离、共享资料、旧版迁移和侧栏可访问状态。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TravelAgent } from '../src/main/agent.js'
import { TripStore } from '../src/main/persistence.js'
import type { SecretVault } from '../src/main/secrets.js'
import { createUserProvidedSource } from '../src/main/connectors/user-import.js'
import { conversationMessages, conversationTitleFromMessage } from '../src/shared/conversations.js'
import { TripConversationList } from '../src/renderer/src/TripConversationList.js'

const temporaryDirectories: string[] = []

/** 给每个持久化用例建立独立目录，避免测试读写真实用户资料。 */
async function createStore(): Promise<{ directory: string; store: TripStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'tripwise-conversations-'))
  temporaryDirectories.push(directory)
  const store = new TripStore(directory)
  await store.initialize()
  return { directory, store }
}

/** 创建只含用户原文的消息，未指定时使用旅行当前话题。 */
function userMessage(id: string, content: string, conversationId?: string) {
  return {
    id,
    ...(conversationId ? { conversationId } : {}),
    role: 'user' as const,
    content,
    createdAt: new Date().toISOString(),
    sourceIds: []
  }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('旅行内独立话题', () => {
  it('创建与切换话题时保留各自消息，并共享旅行简报和来源', async () => {
    const { store } = await createStore()
    await store.createTrip({ destination: '北京', interests: '人文' })
    const tripId = store.snapshot().trips[0].id
    const original = store.snapshot().trips[0]
    const mainConversationId = original.activeConversationId
    await store.appendMessage(tripId, userMessage('main-message', '规划故宫和胡同。'))
    await store.saveSources(tripId, [createUserProvidedSource({
      title: '北京行程共享资料', url: 'https://example.com/beijing', text: '用户保存的参考内容。'
    })])

    await store.createConversation(tripId)
    const second = store.snapshot().trips[0]
    const secondConversationId = second.activeConversationId
    await store.appendMessage(tripId, userMessage('food-message', '请只讨论北京素食餐馆。'))

    const updated = store.snapshot().trips[0]
    expect(updated.conversations).toHaveLength(2)
    expect(updated.conversations.find((item) => item.id === secondConversationId)?.title).toBe('请只讨论北京素食餐馆。')
    expect(conversationMessages(updated, mainConversationId).map((message) => message.content)).toEqual(['规划故宫和胡同。'])
    expect(conversationMessages(updated, secondConversationId).map((message) => message.content)).toEqual(['请只讨论北京素食餐馆。'])
    expect(updated.brief).toMatchObject({ destination: '北京', interests: '人文' })
    expect(updated.sources.map((source) => source.title)).toContain('北京行程共享资料')

    await store.selectConversation(tripId, mainConversationId)
    expect(store.snapshot().trips[0].activeConversationId).toBe(mainConversationId)
    await expect(store.selectConversation(tripId, 'missing-conversation')).rejects.toThrow('找不到这趟旅行中的对话话题。')
  })

  it('删除话题只移除本话题记录；最后一个话题会重建空白规划', async () => {
    const { store } = await createStore()
    await store.createTrip({ destination: '北京' })
    const tripId = store.snapshot().trips[0].id
    const firstId = store.snapshot().trips[0].activeConversationId
    await store.appendMessage(tripId, userMessage('first-topic-message', '去故宫。'))
    await store.saveSources(tripId, [createUserProvidedSource({
      title: '北京共享来源', url: 'https://example.com/beijing-shared', text: '旅行级资料。'
    })])
    await store.createConversation(tripId)
    const secondId = store.snapshot().trips[0].activeConversationId
    await store.appendMessage(tripId, userMessage('second-topic-message', '找素食餐馆。'))

    await store.deleteConversation(tripId, firstId)
    const afterFirstDelete = store.snapshot().trips[0]
    expect(afterFirstDelete.conversations.map((item) => item.id)).toEqual([secondId])
    expect(afterFirstDelete.activeConversationId).toBe(secondId)
    expect(afterFirstDelete.messages.map((item) => item.content)).toEqual(['找素食餐馆。'])
    expect(afterFirstDelete.sources.map((item) => item.title)).toEqual(['北京共享来源'])

    await store.deleteConversation(tripId, secondId)
    const afterLastDelete = store.snapshot().trips[0]
    expect(afterLastDelete.conversations).toHaveLength(1)
    expect(afterLastDelete.conversations[0].title).toBe('总体规划')
    expect(afterLastDelete.conversations[0].id).not.toBe(secondId)
    expect(afterLastDelete.activeConversationId).toBe(afterLastDelete.conversations[0].id)
    expect(afterLastDelete.messages).toEqual([])
    expect(afterLastDelete.sources.map((item) => item.title)).toEqual(['北京共享来源'])
  })

  it('把舊的 v11 单话题资料无损迁到“总体规划”并保存新 schema', async () => {
    const { directory, store } = await createStore()
    await store.createTrip({ destination: '成都' })
    const tripId = store.snapshot().trips[0].id
    await store.appendMessage(tripId, userMessage('old-first', '去宽窄巷子。'))
    await store.createConversation(tripId)
    await store.appendMessage(tripId, userMessage('old-second', '查询成都天气。'))

    const oldDatabase = JSON.parse(await readFile(join(directory, 'tripwise-data.json'), 'utf8')) as {
      schemaVersion: number
      trips: Array<Record<string, unknown> & { messages: Array<Record<string, unknown>> }>
    }
    oldDatabase.schemaVersion = 11
    for (const trip of oldDatabase.trips) {
      delete trip.conversations
      delete trip.activeConversationId
      for (const message of trip.messages) delete message.conversationId
    }
    await writeFile(join(directory, 'tripwise-data.json'), JSON.stringify(oldDatabase))

    const upgraded = new TripStore(directory)
    await upgraded.initialize()
    const migrated = upgraded.snapshot().trips[0]
    expect(upgraded.snapshot().schemaVersion).toBe(16)
    expect(migrated.conversations).toHaveLength(1)
    expect(migrated.conversations[0].title).toBe('总体规划')
    expect(migrated.activeConversationId).toBe(migrated.conversations[0].id)
    expect(migrated.messages.map((message) => [message.content, message.conversationId])).toEqual([
      ['去宽窄巷子。', migrated.conversations[0].id], ['查询成都天气。', migrated.conversations[0].id]
    ])
  })

  it('把旧版 v5 备份迁到一个话题，并在 v6 备份中保留多个话题', async () => {
    const { store } = await createStore()
    await store.createTrip({ destination: '杭州' })
    const tripId = store.snapshot().trips[0].id
    await store.appendMessage(tripId, userMessage('first', '游西湖。'))
    const legacyTrip = structuredClone(store.snapshot().trips[0]) as unknown as Record<string, unknown> & {
      messages: Array<Record<string, unknown>>
    }
    delete legacyTrip.conversations
    delete legacyTrip.activeConversationId
    for (const message of legacyTrip.messages) delete message.conversationId

    const oldPreview = store.previewTripBackup({ format: 'tripwise-trip-backup', formatVersion: 5, trip: legacyTrip })
    expect(oldPreview.conversationCount).toBe(1)
    await store.importTripBackup({ format: 'tripwise-trip-backup', formatVersion: 5, trip: legacyTrip })
    const restoredOld = store.snapshot().trips[0]
    expect(restoredOld.conversations).toHaveLength(1)
    expect(conversationMessages(restoredOld, restoredOld.activeConversationId)[0].content).toBe('游西湖。')

    await store.createConversation(restoredOld.id)
    await store.appendMessage(restoredOld.id, userMessage('second', '查杭州咖啡店。'))
    const currentTrip = store.snapshot().trips[0]
    const currentBackup = { format: 'tripwise-trip-backup', formatVersion: 7, trip: currentTrip }
    expect(store.previewTripBackup(currentBackup)).toMatchObject({ conversationCount: 2, messageCount: 2 })
  })

  it('只把当前话题历史发给模型，同时提供旅行级简报和共享来源', async () => {
    const { store } = await createStore()
    await store.createTrip({ destination: '苏州' })
    const tripId = store.snapshot().trips[0].id
    const firstConversationId = store.snapshot().trips[0].activeConversationId
    await store.appendMessage(tripId, userMessage('private-first', '仅用于园林路线的话题。'))
    await store.createConversation(tripId)
    const currentConversationId = store.snapshot().trips[0].activeConversationId
    await store.appendMessage(tripId, userMessage('private-second', '仅用于素食餐馆的话题。'))
    await store.saveSources(tripId, [createUserProvidedSource({
      title: '苏州旅行共享来源', url: 'https://example.com/suzhou', text: '可在其他话题中复用。'
    })])
    await store.updateSettings({
      ...store.snapshot().settings,
      model: { baseUrl: 'https://model.example/v1', model: 'test-model' }
    })

    const sentBodies: Array<{ messages: Array<{ role: string; content?: string }> }> = []
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBodies.push(JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> })
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '已整理当前话题。' } }] }), {
        status: 200, headers: { 'content-type': 'application/json' }
      })
    })
    const vault = { get: async () => 'fixture-only-key' } as unknown as SecretVault
    await new TravelAgent().run(
      store, vault, tripId, '继续当前话题。', 'isolated-request', new AbortController().signal,
      () => undefined, undefined, currentConversationId
    )

    const sentMessages = sentBodies[0].messages
    const sentContent = sentMessages.map((message) => message.content ?? '').join('\n')
    const systemMessage = sentMessages.find((message) => message.role === 'system')?.content ?? ''
    const contextMessage = sentMessages.find((message) =>
      message.role === 'user' && message.content?.startsWith('以下 JSON 是当前旅行的参考数据；')
    )
    const tripContext = JSON.parse(contextMessage?.content?.split('\n').slice(1).join('\n') ?? '{}') as {
      tripBrief: { destination: string }
      availableSources: Array<{ title: string }>
    }
    expect(sentContent).toContain('仅用于素食餐馆的话题。')
    expect(sentContent).toContain('继续当前话题。')
    expect(sentContent).not.toContain('仅用于园林路线的话题。')
    expect(systemMessage).not.toContain('苏州')
    expect(tripContext.tripBrief.destination).toBe('苏州')
    expect(tripContext.availableSources.map((source) => source.title)).toContain('苏州旅行共享来源')
    const trip = store.snapshot().trips[0]
    expect(conversationMessages(trip, firstConversationId).map((message) => message.content)).toEqual(['仅用于园林路线的话题。'])
    expect(conversationMessages(trip, currentConversationId).map((message) => message.role)).toEqual(['user', 'user', 'assistant'])
  })

  it('为话题侧栏暴露当前项、新建按钮和消息数量', () => {
    const markup = renderToStaticMarkup(<TripConversationList
      conversations={[
        { id: 'main', title: '总体规划', createdAt: 'now', updatedAt: 'now' },
        { id: 'food', title: '素食餐馆', createdAt: 'now', updatedAt: 'now' }
      ]}
      messages={[
        { ...userMessage('one', '第一条。'), conversationId: 'main' },
        { ...userMessage('two', '第二条。'), conversationId: 'food' }
      ]}
      activeConversationId="food"
      runningConversationId={null}
      onSelect={() => undefined}
      onDelete={() => undefined}
      onCreate={() => undefined}
    />)

    expect(markup).toContain('aria-label="当前旅行话题"')
    expect(markup).toContain('aria-label="新建话题"')
    expect(markup).toContain('aria-current="page" title="素食餐馆"')
    expect(markup).toContain('aria-label="删除话题：素食餐馆"')
    expect(markup).toContain('>1</small>')
  })

  it('按可读字符截断自动标题且规整换行空白', () => {
    expect(conversationTitleFromMessage('  故宫路线\n包括胡同与博物馆  ')).toBe('故宫路线 包括胡同与博物馆')
    expect(conversationTitleFromMessage('北京'.repeat(17))).toBe(`${'北京'.repeat(16)}…`)
  })
})
