/**
 * The console's Markdown.
 *
 * The Router answers in Markdown, and the console shows the answer as the Router wrote it: headings, emphasis, ordered
 * and unordered lists, task lists, fenced and inline code, quotes, tables and links.
 *
 * The rendering is done with React's own elements. There is no `dangerouslySetInnerHTML` in this file, and no HTML in
 * the source is ever interpreted: a `<script>` or an `<img>` in an answer stays the text it was written as, and the
 * console asks no other origin for anything.
 *
 * A link is a link only when its scheme is one a person may follow — `http`, `https`, `mailto`. Anything else, a
 * `javascript:` address or a `data:` address among them, is shown as the words it was written as and never becomes a
 * clickable target. The scheme is read after the entities are decoded, so an address that only looks safe is refused
 * too.
 *
 * The code in an answer is the code as it was written: a fenced block keeps its own spaces and its own line breaks, and
 * a wide one scrolls inside its own box instead of widening the page.
 */
import { Fragment, type ReactElement, type ReactNode } from 'react'

/* ------------------------------------------------------------------ the document */

/** How a table column is aligned. */
type Align = 'left' | 'center' | 'right' | undefined

/** One task of a task list. */
interface Task { done: boolean }

/** One item of a list: its own blocks, and the box of a task when it is one. */
interface ListItem { task?: Task; blocks: Block[] }

/** One block of a document. */
type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; language: string; code: string }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; loose: boolean; items: ListItem[] }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] }
  | { kind: 'rule' }

/** The characters a backslash may hold still. */
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~<>|]/

/** The entities a document may carry. */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…',
  mdash: '—', ndash: '–', middot: '·', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', times: '×', divide: '÷', deg: '°', bull: '•',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', rarr: '→', larr: '←',
}

/** Read the entities of a text, so an address that only looks safe is seen as it is. */
function decode(text: string): string {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try { return String.fromCodePoint(code) } catch { return whole }
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * The address a link may carry.
 *
 * Only `http`, `https` and `mailto` are followed. Everything else — `javascript:`, `data:`, `file:`, a scheme nobody
 * knows — is refused, and the link is shown as the words it was written as.
 */
function safeUrl(url: string): string | undefined {
  const trimmed = url.trim()
  if (trimmed === '' || /[\s\u0000-\u001f]/.test(trimmed)) return undefined
  if (/^(https?):\/\//i.test(trimmed)) return trimmed
  if (/^mailto:[^\s]+$/i.test(trimmed)) return trimmed
  return undefined
}

/** An address shown the way a person reads it: the host and a short path. */
function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname.length > 24 ? `${parsed.pathname.slice(0, 24)}…` : parsed.pathname
    return `${parsed.host}${path === '/' ? '' : path}`
  } catch {
    // Not an address after all; it is shown as it was written.
    return url
  }
}

/** Whether a character may stand inside a word, where an underscore is not an emphasis. */
function wordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9]/.test(char)
}

/* ------------------------------------------------------------------ the blocks */

/** Whether a line begins a block of its own, rather than continuing the text above it. */
function blockStart(line: string): boolean {
  return /^\s{0,3}#{1,6}[ \t]+/.test(line)
    || /^\s{0,3}(`{3,}|~{3,})/.test(line)
    || /^\s{0,3}>/.test(line)
    || /^\s{0,3}([-*+]|\d{1,9}[.)])[ \t]+/.test(line)
    || /^\s{0,3}([-*_])[ \t]*(\1[ \t]*){2,}$/.test(line)
}

/** The blocks of a document, read from its lines. */
function parseBlocks(lines: string[], depth = 0): Block[] {
  if (depth >= 32) return [{ kind: 'paragraph', text: lines.join('\n') }]
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.trim() === '') { index += 1; continue }

    // A fenced code block: what is inside it is kept exactly as it was written.
    const fence = /^\s{0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[ \t]*$/.exec(line)
    if (fence !== null) {
      const marker = fence[1]!
      const body: string[] = []
      index += 1
      while (index < lines.length) {
        const closing = lines[index]!.trim()
        if (closing.length >= marker.length && closing === marker[0]!.repeat(closing.length)) {
          index += 1
          break
        }
        body.push(lines[index]!)
        index += 1
      }
      blocks.push({ kind: 'code', language: fence[2] ?? '', code: body.join('\n') })
      continue
    }

    // A heading.
    const heading = /^\s{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2] ?? '' })
      index += 1
      continue
    }

    // A rule.
    if (/^\s{0,3}([-*_])[ \t]*(\1[ \t]*){2,}$/.test(line)) {
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }

    // A quote: the lines under its mark, read as a document of their own.
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = []
      while (index < lines.length) {
        const current = lines[index]!
        if (/^\s{0,3}>/.test(current)) {
          body.push(current.replace(/^\s{0,3}>[ \t]?/, ''))
          index += 1
          continue
        }
        // A line of text under a quote continues it, unless it begins a block of its own.
        const continues = current.trim() !== '' && !blockStart(current)
          && body.length > 0 && body.at(-1)!.trim() !== ''
        if (!continues) break
        body.push(current)
        index += 1
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(body, depth + 1) })
      continue
    }

    // A table.
    const table = parseTable(lines, index)
    if (table !== undefined) {
      blocks.push(table.block)
      index = table.next
      continue
    }

    // A list.
    const list = parseList(lines, index, depth)
    if (list !== undefined) {
      blocks.push(list.block)
      index = list.next
      continue
    }

    // A paragraph: the lines above the next block.
    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index]!
      if (current.trim() === '') break
      if (paragraph.length > 0 && (blockStart(current) || isTableStart(lines, index))) break
      paragraph.push(current.trim())
      index += 1
    }
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
    else index += 1
  }
  return blocks
}

/** One table row, split on the pipes that separate the cells. */
function splitRow(row: string): string[] {
  const cells: string[] = []
  let current = ''
  let index = 0
  while (index < row.length) {
    const char = row[index]!
    if (char === '\\' && row[index + 1] === '|') { current += '|'; index += 2; continue }
    if (char === '|') { cells.push(current); current = ''; index += 1; continue }
    current += char
    index += 1
  }
  cells.push(current)
  const trimmed = cells.map(cell => cell.trim())
  // The outer pipes are the row's frame, not cells of their own.
  if (trimmed.length > 0 && trimmed[0] === '') trimmed.shift()
  if (trimmed.length > 0 && trimmed.at(-1) === '') trimmed.pop()
  return trimmed
}

/** Whether the lines at an index are the head of a table. */
function isTableStart(lines: string[], index: number): boolean {
  const head = lines[index]
  const delimiter = lines[index + 1]
  if (head === undefined || delimiter === undefined) return false
  if (!head.includes('|')) return false
  return /^\s*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(delimiter)
}

/** A table: its head, the alignment of its columns, and its rows. */
function parseTable(lines: string[], start: number): { block: Block; next: number } | undefined {
  const head = lines[start]!
  const delimiter = lines[start + 1]
  if (delimiter === undefined || !head.includes('|')) return undefined
  if (!/^\s*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(delimiter)) return undefined
  const heads = splitRow(head)
  const align = splitRow(delimiter).map(cell => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    return left && right ? 'center' : right ? 'right' : left ? 'left' : undefined
  })
  if (heads.length === 0 || heads.length !== align.length) return undefined
  const rows: string[][] = []
  let index = start + 2
  while (index < lines.length) {
    const current = lines[index]!
    if (current.trim() === '' || !current.includes('|')) break
    rows.push(splitRow(current))
    index += 1
  }
  return { block: { kind: 'table', head: heads, align, rows }, next: index }
}

/** The beginning of a list item: its mark, the column its text starts in, and that text. */
interface ListStart { ordered: boolean; indent: number; content: number; rest: string }

function listStart(line: string): ListStart | undefined {
  const match = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(line)
  if (match === null) return undefined
  const indent = match[1]!.length
  const marker = match[2]!
  return {
    ordered: /\d/.test(marker),
    indent,
    content: indent + marker.length + match[3]!.length,
    rest: match[4] ?? '',
  }
}

/** A list: its items, read from the lines that hold them. */
function parseList(lines: string[], start: number, depth: number): { block: Block; next: number } | undefined {
  const first = listStart(lines[start]!)
  if (first === undefined) return undefined
  const items: ListItem[] = []
  let pending: string[] = []
  let loose = false
  let separated = false
  let index = start

  const flush = (): void => {
    if (pending.length === 0) return
    const blocks = parseBlocks(pending, depth + 1)
    let task: Task | undefined
    const head = blocks[0]
    if (head !== undefined && head.kind === 'paragraph') {
      const marker = /^\[([ xX])\][ \t]+/.exec(head.text)
      if (marker !== null) {
        task = { done: marker[1] !== ' ' }
        blocks[0] = { kind: 'paragraph', text: head.text.slice(marker[0].length) }
      }
    }
    items.push(task === undefined ? { blocks } : { task, blocks })
    pending = []
  }

  while (index < lines.length) {
    const line = lines[index]!
    const item = listStart(line)
    if (item !== undefined && item.indent < first.content) {
      // Another item of this list; a list of the other kind ends it.
      if (item.ordered !== first.ordered) break
      flush()
      if (separated) loose = true
      separated = false
      pending = [item.rest]
      index += 1
      continue
    }
    if (line.trim() === '') { separated = true; index += 1; continue }
    if (item !== undefined && item.indent >= first.content) {
      // A list of its own, inside this item.
      pending.push(line.slice(first.content))
      index += 1
      continue
    }
    const indent = /^[ \t]*/.exec(line)![0].length
    if (indent < first.content && (blockStart(line) || isTableStart(lines, index))) break
    if (separated) {
      // A line of text that is indented enough continues the item that was open.
      if (indent < first.content) break
      pending.push(line.slice(first.content))
      index += 1
      continue
    }
    pending.push(line.trim())
    index += 1
  }
  flush()
  if (items.length === 0) return undefined
  return { block: { kind: 'list', ordered: first.ordered, loose, items }, next: index }
}

/* ------------------------------------------------------------------ the inlines */

/**
 * The inlines of a text: what a person reads between the blocks.
 *
 * `prefix` keeps the keys of two texts apart when they end up in the same list.
 */
function parseInline(source: string, prefix = ''): ReactNode[] {
  const nodes: ReactNode[] = []
  let text = ''
  let index = 0
  let key = 0

  const flush = (): void => {
    if (text === '') return
    nodes.push(decode(text))
    text = ''
  }

  while (index < source.length) {
    const rest = source.slice(index)
    const char = source[index]!
    const previous = index > 0 ? source[index - 1] : undefined

    // A backslash holds the character after it still.
    if (char === '\\' && index + 1 < source.length && ESCAPABLE.test(source[index + 1]!)) {
      text += source[index + 1]
      index += 2
      continue
    }

    // A code span keeps its content as it was written.
    if (char === '`') {
      const span = /^(`+)([\s\S]*?)\1(?!`)/.exec(rest)
      if (span !== null && span[2] !== '') {
        flush()
        nodes.push(<code key={`${prefix}${key++}`}>{span[2]}</code>)
        index += span[0].length
        continue
      }
    }

    // An image is never loaded: the console asks no other origin for anything, so it is shown by its own words.
    if (rest.startsWith('![')) {
      const image = /^!\[([^\]]*)\]\([ \t]*([^)\s]*)(?:[ \t]+"[^"]*")?[ \t]*\)/.exec(rest)
      if (image !== null) {
        flush()
        const alt = decode(image[1] ?? '').trim()
        nodes.push(<span className="md-image" key={`${prefix}${key++}`}>图片：{alt === '' ? '未命名' : alt}</span>)
        index += image[0].length
        continue
      }
    }

    // A link: the words it was written as, and the address it points at.
    if (char === '[') {
      const link = /^\[([^\]]*)\]\([ \t]*([^)\s]*)(?:[ \t]+"[^"]*")?[ \t]*\)/.exec(rest)
      if (link !== null) {
        flush()
        const label = link[1] ?? ''
        const target = safeUrl(decode(link[2] ?? ''))
        nodes.push(target === undefined
          ? <Fragment key={`${prefix}${key++}`}>{parseInline(label)}</Fragment>
          : <a key={`${prefix}${key++}`} href={target} target="_blank" rel="noopener noreferrer">{parseInline(label)}</a>)
        index += link[0].length
        continue
      }
    }

    // An address written between angle brackets.
    if (char === '<') {
      const auto = /^<((?:https?|mailto):[^>\s]+)>/.exec(rest)
      if (auto !== null) {
        flush()
        const url = decode(auto[1]!)
        const target = safeUrl(url)
        nodes.push(target === undefined
          ? <Fragment key={`${prefix}${key++}`}>{url}</Fragment>
          : <a key={`${prefix}${key++}`} href={target} target="_blank" rel="noopener noreferrer">{url}</a>)
        index += auto[0].length
        continue
      }
    }

    // Strong.
    const strong = /^\*\*(?!\s)([\s\S]*?\S)\*\*/.exec(rest)
    if (strong !== null) {
      flush()
      nodes.push(<strong key={`${prefix}${key++}`}>{parseInline(strong[1]!)}</strong>)
      index += strong[0].length
      continue
    }
    if (!wordChar(previous)) {
      const strongWord = /^__(?!\s)([\s\S]*?\S)__/.exec(rest)
      if (strongWord !== null) {
        flush()
        nodes.push(<strong key={`${prefix}${key++}`}>{parseInline(strongWord[1]!)}</strong>)
        index += strongWord[0].length
        continue
      }
    }

    // Emphasis.
    const emphasis = /^\*(?!\s)([\s\S]*?\S)\*/.exec(rest)
    if (emphasis !== null) {
      flush()
      nodes.push(<em key={`${prefix}${key++}`}>{parseInline(emphasis[1]!)}</em>)
      index += emphasis[0].length
      continue
    }
    if (!wordChar(previous)) {
      const emphasisWord = /^_(?!\s)([\s\S]*?\S)_/.exec(rest)
      if (emphasisWord !== null) {
        flush()
        nodes.push(<em key={`${prefix}${key++}`}>{parseInline(emphasisWord[1]!)}</em>)
        index += emphasisWord[0].length
        continue
      }
    }

    // Strike.
    const strike = /^~~(?!\s)([\s\S]*?\S)~~/.exec(rest)
    if (strike !== null) {
      flush()
      nodes.push(<del key={`${prefix}${key++}`}>{parseInline(strike[1]!)}</del>)
      index += strike[0].length
      continue
    }

    // A bare address.
    if (/^https?:\/\//.test(rest) && !wordChar(previous)) {
      const bare = /^(https?:\/\/[^\s<>"'`]+)/.exec(rest)
      if (bare !== null) {
        let url = bare[1]!
        // The punctuation that ends a sentence is not part of the address.
        while (url.length > 0 && '.,;:!?，。；：！？、）'.includes(url.at(-1)!)) url = url.slice(0, -1)
        while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
          url = url.slice(0, -1)
        }
        if (url.replace(/^https?:\/\//, '').length > 0) {
          flush()
          nodes.push(<a key={`${prefix}${key++}`} href={url} target="_blank" rel="noopener noreferrer">{shortUrl(url)}</a>)
          index += url.length
          continue
        }
      }
    }

    text += char
    index += 1
  }

  flush()
  return nodes
}

/* ------------------------------------------------------------------ the rendering */

/** One block, as the console shows it. */
function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case 'paragraph': {
      const lines = block.text.split('\n')
      const content: ReactNode[] = []
      lines.forEach((line, index) => {
        if (index > 0) content.push(<br key={`br-${index}`} />)
        content.push(...parseInline(line, `${key}.${index}.`))
      })
      // Raw HTML is shown as the text it is: the console never interprets it.
      if (/^\s*<[^>]*>\s*$/.test(block.text)) return <p className="md-raw" key={key}>{content}</p>
      return <p key={key}>{content}</p>
    }
    case 'heading': {
      const content = parseInline(block.text)
      if (block.level === 1) return <h1 key={key}>{content}</h1>
      if (block.level === 2) return <h2 key={key}>{content}</h2>
      if (block.level === 3) return <h3 key={key}>{content}</h3>
      if (block.level === 4) return <h4 key={key}>{content}</h4>
      if (block.level === 5) return <h5 key={key}>{content}</h5>
      return <h6 key={key}>{content}</h6>
    }
    case 'code': {
      return (
        <div className="md-code" key={key}>
          {block.language === '' ? null : <span className="md-code-lang">{block.language}</span>}
          <pre><code>{block.code}</code></pre>
        </div>
      )
    }
    case 'quote':
      return <blockquote key={key}>{renderBlocks(block.blocks)}</blockquote>
    case 'list': {
      const items = block.items.map((item, index) => (
        <li key={index} className={item.task === undefined ? undefined : 'md-task'}>{renderItem(item, block.loose)}</li>
      ))
      return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>
    }
    case 'table': {
      const head = block.head.map((cell, index) => (
        <th key={index} style={alignStyle(block.align[index])}>{parseInline(cell)}</th>
      ))
      const rows = block.rows.map((row, rowIndex) => (
        <tr key={rowIndex}>
          {row.map((cell, cellIndex) => (
            <td key={cellIndex} style={alignStyle(block.align[cellIndex])}>{parseInline(cell)}</td>
          ))}
        </tr>
      ))
      return (
        <div className="md-table" key={key}>
          <table>
            <thead><tr>{head}</tr></thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
      )
    }
    case 'rule':
      return <hr key={key} />
    default:
      return null
  }
}

/** One item of a list: a task's box, and the item's own blocks. */
function renderItem(item: ListItem, loose: boolean): ReactNode {
  const blocks = item.blocks
  const head = blocks[0]
  const paragraph = head !== undefined && head.kind === 'paragraph' ? head : undefined
  // A tight item holds its first paragraph without a paragraph of its own, the way a list is read.
  const content = paragraph !== undefined && !loose
    ? <>{parseInline(paragraph.text)}{blocks.length > 1 ? renderBlocks(blocks.slice(1)) : null}</>
    : renderBlocks(blocks)
  if (item.task === undefined) return <>{content}</>
  return (
    <>
      <input className="md-task-box" type="checkbox" checked={item.task.done} readOnly disabled
        aria-label={item.task.done ? '已完成' : '未完成'} />
      {content}
    </>
  )
}

/** The blocks of a document, as the console shows them. */
function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((block, index) => renderBlock(block, index))
}

/** The alignment of a table column. */
function alignStyle(align: Align): { textAlign?: 'left' | 'center' | 'right' } | undefined {
  return align === undefined ? undefined : { textAlign: align }
}

/**
 * A text of the Router, as Markdown.
 *
 * The text is read as a document and shown as React's own elements: no HTML in it is ever interpreted, no image in it
 * is ever loaded, and a link that points at an address a person may not follow is shown as the words it was written
 * as.
 */
export function Markdown(props: { text: string }): ReactElement {
  const blocks = parseBlocks(props.text.split('\n'))
  return <div className="md">{renderBlocks(blocks)}</div>
}
