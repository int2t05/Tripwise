/** 验证行程编辑草稿按语义字段合并并限制撤销记录数量。 */
import { describe, expect, it } from 'vitest'
import { recordItineraryDraftUndo, undoItineraryDraft, type ItineraryDraftUndoEntry } from '../src/renderer/src/itinerary-draft-undo.js'

describe('行程草稿逐项撤销', () => {
  it('连续编辑同一字段只记录首次修改前的快照', () => {
    const initial = { title: '轻松游', summary: '' }
    const afterTitle = { title: '慢游北京', summary: '' }
    const afterTyping = { title: '北京慢游', summary: '' }
    const first = recordItineraryDraftUndo([], initial, 'plan:title', '修改方案名称')
    const grouped = recordItineraryDraftUndo(first, afterTitle, 'plan:title', '修改方案名称')
    const second = recordItineraryDraftUndo(grouped, afterTyping, 'plan:summary', '修改方案摘要')

    expect(grouped).toBe(first)
    expect(second).toHaveLength(2)
    expect(undoItineraryDraft(second)).toMatchObject({ snapshot: afterTyping, label: '修改方案摘要' })
    expect(undoItineraryDraft(undoItineraryDraft(second)!.history)).toMatchObject({ snapshot: initial, label: '修改方案名称' })
  })

  it('最近的不同字段先撤销，并在读取后消费记录', () => {
    const history = recordItineraryDraftUndo(
      recordItineraryDraftUndo([], { date: '', title: '第一天' }, 'day:1:date', '修改第 1 天日期'),
      { date: '2026-10-20', title: '第一天' }, 'day:1:title', '修改第 1 天主题'
    )
    const result = undoItineraryDraft(history)

    expect(result).toEqual({
      snapshot: { date: '2026-10-20', title: '第一天' },
      label: '修改第 1 天主题',
      history: history.slice(0, -1)
    })
  })

  it('字段改回本次编辑前的值时移除已抵消的撤销项', () => {
    const original = { title: '北京慢游' }
    const changed = { title: '慢游北京' }
    const history = recordItineraryDraftUndo([], original, 'plan:title', '修改方案名称')
    const reverted = recordItineraryDraftUndo(history, changed, 'plan:title', '修改方案名称', (snapshot) =>
      snapshot.title === original.title
    )

    expect(reverted).toEqual([])
  })

  it('最多保留最近 50 个语义操作', () => {
    let history: ItineraryDraftUndoEntry<{ value: number }>[] = []
    for (let index = 0; index < 60; index++) {
      history = recordItineraryDraftUndo(history, { value: index }, `edit:${index}`, `编辑 ${index}`)
    }

    expect(history).toHaveLength(50)
    expect(history[0]?.snapshot.value).toBe(10)
  })
})
