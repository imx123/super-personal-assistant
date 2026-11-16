/**
 * The console's Markdown.
 *
 * The Router answers in Markdown, and the console shows the answer as the Router wrote it: the blocks a person reads,
 * the code exactly as it was written, and no address a person may not follow.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Markdown } from '../src/console/markdown.tsx'

/** The console's own HTML for one answer. */
const html = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }))

it('reads the blocks a person reads: headings, emphasis, quotes and rules', () => {
  const answer = html('# 标题\n\n## 周报验收\n\n这是 **重点**、*斜体* 和 `inline()`。\n\n> 这是引用\n\n---')
  expect(answer).toContain('<h1>标题</h1>')
  expect(answer).toContain('<h2>周报验收</h2>')
  expect(answer).toContain('<strong>重点</strong>')
  expect(answer).toContain('<em>斜体</em>')
  expect(answer).toContain('<code>inline()</code>')
  expect(answer).toContain('<blockquote>')
  expect(answer).toContain('这是引用')
  expect(answer).toContain('<hr/>')
})

it('reads ordered and unordered lists, and a list inside a list', () => {
  const answer = html('- 事项一\n  - 子任务\n\n1. 第一条\n2. 第二条')
  expect(answer).toContain('<ul><li>事项一<ul><li>子任务</li></ul></li></ul>')
  expect(answer).toContain('<ol><li>第一条</li><li>第二条</li></ol>')
})

it('reads a task list as boxes that are already marked', () => {
  const answer = html('- [x] 已完成\n- [ ] 还没做')
  expect(answer).toContain('type="checkbox"')
  expect(answer).toContain('checked=""')
  expect(answer.match(/type="checkbox"/g)?.length).toBe(2)
  expect(answer).toContain('已完成')
  expect(answer).toContain('还没做')
})

it('ends a list before the next top-level heading without a blank line', () => {
  expect(html('- 项目\n## 下一节')).toContain('</ul><h2>下一节</h2>')
})

it('keeps mixed fence characters as code and handles deeply nested quotes', () => {
  expect(html('~~~\n~`~\n~~~')).toContain('<pre><code>~`~</code></pre>')
  expect(html('>'.repeat(10_000) + ' 内容')).toContain('内容')
})

it('keeps the code of a fenced block exactly as it was written', () => {
  const code = 'const value = 42;\nconsole.log(value);'
  const answer = html('```js\n' + code + '\n```')
  expect(answer).toContain('<pre><code>' + code + '</code></pre>')
  // The language is named above the block, not inside the code.
  expect(answer).toContain('>js<')
})

it('reads a table as a head and a body, and keeps the cells of a row', () => {
  const answer = html('| 状态 | 结果 |\n| --- | --- |\n| Worker | 已完成 |')
  expect(answer).toContain('<thead><tr><th>状态</th><th>结果</th></tr></thead>')
  expect(answer).toContain('<tbody><tr><td>Worker</td><td>已完成</td></tr></tbody>')
})

it('follows an address a person may follow, and shows the others as the words they were written as', () => {
  const answer = html('[安全链接](https://example.com) [危险链接](javascript:alert%281%29)')
  expect(answer).toContain('href="https://example.com"')
  expect(answer).not.toContain('javascript:')
  expect(answer).toContain('危险链接')
})

it('never interprets the HTML of an answer and never loads an image', () => {
  const answer = html('<script>alert(1)</script>\n\n<img id="unsafe-raw" src="/unexpected-raw">\n\n![远程图片](https://example.com/tracker.png)')
  expect(answer).not.toContain('<script')
  expect(answer).not.toContain('<img')
  expect(answer).not.toContain('tracker.png"')
  expect(answer).toContain('&lt;script&gt;')
  expect(answer).toContain('图片：远程图片')
})

it('reads an address that only looks safe as what it is', () => {
  // The entities are read first, so an address that hides its scheme is refused as well.
  const answer = html('[x](javascript&#58;alert(1))')
  expect(answer).not.toContain('href=')
  expect(answer).toContain('x')
})

it('keeps the lines of a paragraph as they were written', () => {
  const answer = html('第一行\n第二行')
  expect(answer).toContain('第一行<br/>第二行')
})
