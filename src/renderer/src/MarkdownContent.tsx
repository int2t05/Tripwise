/** 在不执行 HTML 或脚本的前提下显示 Agent 的有限 Markdown 输出。 */
import type { ReactNode } from 'react'

/** 安全地渲染有限 Markdown；助手长表可按需展开，结构化行程保持原样。 */
export function MarkdownContent({ text, onOpen, collapseLargeTables = false }: { text: string; onOpen: (url: string) => void; collapseLargeTables?: boolean }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index].trimEnd()
    if (!line.trim()) { index += 1; continue }
    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      const level = heading[1].length
      const Heading = `h${level + 2}` as 'h3' | 'h4' | 'h5'
      blocks.push(<Heading key={index}><InlineText text={heading[2]} onOpen={onOpen} /></Heading>)
      index += 1
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) items.push(lines[index++].replace(/^\s*[-*]\s+/, ''))
      blocks.push(<ul key={`ul-${index}`}>{items.map((item, i) => <li key={i}><InlineText text={item} onOpen={onOpen} /></li>)}</ul>)
      continue
    }
    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) items.push(lines[index++].replace(/^\s*\d+[.)]\s+/, ''))
      blocks.push(<ol key={`ol-${index}`}>{items.map((item, i) => <li key={i}><InlineText text={item} onOpen={onOpen} /></li>)}</ol>)
      continue
    }
    if (/^>\s?/.test(line)) {
      blocks.push(<blockquote key={index}><InlineText text={line.replace(/^>\s?/, '')} onOpen={onOpen} /></blockquote>)
      index += 1
      continue
    }
    if (/^\|/.test(line)) {
      const rows: string[][] = []
      while (index < lines.length && /^\s*\|/.test(lines[index])) {
        const cells = lines[index++].split('|').slice(1, -1).map((cell) => cell.trim())
        if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue
        rows.push(cells)
      }
      if (rows.length) {
        const [headerRow, ...dataRows] = rows
        const table = <div className="markdown-table-wrap" key={`table-${index}`}><table>
          <thead><tr>{headerRow.map((cell, column) => <th key={column} scope="col"><InlineText text={cell} onOpen={onOpen} /></th>)}</tr></thead>
          <tbody>{dataRows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column}><InlineText text={cell} onOpen={onOpen} /></td>)}</tr>)}</tbody>
        </table></div>
        if (collapseLargeTables && dataRows.length >= 6) {
          const firstColumn = headerRow[0]?.trim()
          const summary = `${firstColumn || '数据'} · ${dataRows.length} 行`
          blocks.push(<details className="markdown-table-disclosure" key={`table-${index}`}><summary>{summary}</summary>{table}</details>)
        } else {
          blocks.push(table)
        }
      }
      continue
    }
    blocks.push(<p key={index}><InlineText text={line} onOpen={onOpen} /></p>)
    index += 1
  }
  return <div className="markdown-content">{blocks}</div>
}

/** 把加粗和 HTTP(S) 链接渲染为安全文本及应用内导航按钮。 */
function InlineText({ text, onOpen }: { text: string; onOpen: (url: string) => void }) {
  const tokenPattern = /(\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)]+|\*\*[^*]+\*\*)/g
  const parts: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = tokenPattern.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const token = match[0]
    const markdownLink = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/)
    if (markdownLink) {
      parts.push(<button className="inline-link" key={match.index} onClick={() => onOpen(trimPunctuation(markdownLink[2]))}>{markdownLink[1]}</button>)
    } else if (token.startsWith('**')) {
      parts.push(<strong key={match.index}>{token.slice(2, -2)}</strong>)
    } else {
      const cleanUrl = trimPunctuation(token)
      parts.push(<button className="inline-link" key={match.index} onClick={() => onOpen(cleanUrl)}>{cleanUrl}</button>)
      if (cleanUrl !== token) parts.push(token.slice(cleanUrl.length))
    }
    last = tokenPattern.lastIndex
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

/** 去除 URL 尾随标点，保持中文句子断句自然。 */
function trimPunctuation(url: string): string {
  return url.replace(/[，。；！？、]+$/g, '')
}
