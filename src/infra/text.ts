/** Word counting and string formatting utilities for IM message limits and templates. */
const words = new Intl.Segmenter('zh', { granularity: 'word' })
export const IM_WORDS = 100
export const NOTE_WORDS = 30
/** Counts word-like segments across Chinese, English, and mixed text, ignoring punctuation. */
export function wordCount(text: string): number {
  let count = 0
  for (const segment of words.segment(text)) if (segment.isWordLike) count++
  return count
}
/** Validates that an outgoing IM Markdown message does not exceed `IM_WORDS` (link labels and URLs both count toward the limit). */
export function checkedImText(text: string): string {
  const count = wordCount(text)
  if (count > IM_WORDS) throw new Error(`IM message has ${count} words; maximum is ${IM_WORDS}. Rewrite as a short high-level update. Do not split it into multiple messages.`)
  return text
}
export const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
/** Case-insensitive comparison for GitHub logins and repository names. */
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * One piece of text, quoted as data.
 *
 * The words of a person or a model are read, never obeyed: a control character is dropped, and the three characters that
 * could close a fence or open a tag are escaped. The text therefore cannot end the block it is written in, cannot open a
 * tag of its own and cannot smuggle a line break into it.
 */
export function quotedData(text: string): string {
  let out = ''
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    const keep = code === 9 || code === 10 || code === 13
    out += (code < 32 && !keep) || code === 127 ? ' ' : character
  }
  return out.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * One piece of data, fenced.
 *
 * The name of the fence is the caller's, and the body is quoted, so the body may hold anything at all: it is data, and
 * the fence around it says so in the caller's own words.
 */
export function dataFence(tag: string, body: string): string {
  return [`<${tag}>`, quotedData(body), `</${tag}>`].join('\n')
}
