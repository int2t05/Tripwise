/** 为纯文本行程计算有界的逐行比较结果。 */
export type TextLineChangeKind = 'unchanged' | 'added' | 'removed'

export interface TextLineChange {
  kind: TextLineChangeKind
  text: string
}

export interface TextLineDiff {
  changes: TextLineChange[]
  addedCount: number
  removedCount: number
}

const MAX_COMPARISON_CELLS = 1_000_000

/** 用最长公共子序列突出增删；超出矩阵上限时交由界面并排展示全文。 */
export function compareTextLines(previous: string, current: string): TextLineDiff | null {
  const previousLines = previous.split(/\r?\n/)
  const currentLines = current.split(/\r?\n/)
  const width = currentLines.length + 1
  const cellCount = (previousLines.length + 1) * width
  if (cellCount > MAX_COMPARISON_CELLS) return null

  const matrix = new Uint16Array(cellCount)
  for (let previousIndex = previousLines.length - 1; previousIndex >= 0; previousIndex -= 1) {
    for (let currentIndex = currentLines.length - 1; currentIndex >= 0; currentIndex -= 1) {
      const index = previousIndex * width + currentIndex
      matrix[index] = previousLines[previousIndex] === currentLines[currentIndex]
        ? matrix[(previousIndex + 1) * width + currentIndex + 1] + 1
        : Math.max(matrix[(previousIndex + 1) * width + currentIndex], matrix[previousIndex * width + currentIndex + 1])
    }
  }

  const changes: TextLineChange[] = []
  let addedCount = 0
  let removedCount = 0
  let previousIndex = 0
  let currentIndex = 0
  while (previousIndex < previousLines.length || currentIndex < currentLines.length) {
    if (previousIndex < previousLines.length && currentIndex < currentLines.length && previousLines[previousIndex] === currentLines[currentIndex]) {
      changes.push({ kind: 'unchanged', text: currentLines[currentIndex] })
      previousIndex += 1
      currentIndex += 1
    } else if (
      previousIndex < previousLines.length &&
      (currentIndex === currentLines.length || matrix[(previousIndex + 1) * width + currentIndex] >= matrix[previousIndex * width + currentIndex + 1])
    ) {
      changes.push({ kind: 'removed', text: previousLines[previousIndex] })
      removedCount += 1
      previousIndex += 1
    } else {
      changes.push({ kind: 'added', text: currentLines[currentIndex] })
      addedCount += 1
      currentIndex += 1
    }
  }

  return { changes, addedCount, removedCount }
}
