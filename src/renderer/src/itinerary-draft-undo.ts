/** 为行程编辑草稿提供有界、按语义操作分组的撤销记录。 */

export interface ItineraryDraftUndoEntry<T> {
  key: string
  label: string
  snapshot: T
}

const MAX_UNDO_ENTRIES = 50

/** 连续修改同一字段时只保留首次修改前的快照，避免逐字占用撤销记录。 */
export function recordItineraryDraftUndo<T>(
  history: ItineraryDraftUndoEntry<T>[],
  snapshot: T,
  key: string,
  label: string,
  returnsToPrevious: (snapshot: T) => boolean = () => false
): ItineraryDraftUndoEntry<T>[] {
  const previous = history.at(-1)
  if (previous && returnsToPrevious(previous.snapshot)) return history.slice(0, -1)
  if (previous?.key === key) return history
  return [...history.slice(-(MAX_UNDO_ENTRIES - 1)), { key, label, snapshot }]
}

/** 取回最近一次语义操作之前的草稿，并消费对应撤销记录。 */
export function undoItineraryDraft<T>(history: ItineraryDraftUndoEntry<T>[]): {
  snapshot: T
  label: string
  history: ItineraryDraftUndoEntry<T>[]
} | null {
  const previous = history.at(-1)
  if (!previous) return null
  return { snapshot: previous.snapshot, label: previous.label, history: history.slice(0, -1) }
}
