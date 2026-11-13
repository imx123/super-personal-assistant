/** DSH-free structural views of host Session events, and the transcript projections the control plane reads from them. */

/** A content block of a Session message; only its kind and text are read. */
export interface ContentBlockView {
  readonly type: string
  readonly text?: string
}

/** One Session event as the control plane reads it: its kind, its time, and an opaque payload a projector narrows. */
export interface SessionEventView {
  readonly type: string
  /** Unix epoch milliseconds. */
  readonly time: number
  /** The event's payload; a projector checks the fields it reads. */
  readonly data: unknown
}

/** What the transcript resource keeps of a message: its role and its non-reasoning content blocks. */
export interface TranscriptEntry {
  readonly type: string
  readonly message: { readonly role: string; readonly content: readonly ContentBlockView[] }
}

/** The direct human message one turn carried, with its text blocks joined by newlines. */
export interface TurnUserMessage {
  readonly id: string
  readonly text: string
  /** Unix epoch milliseconds of its `user/message` event. */
  readonly time: number
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** A block the transcript keeps: any typed block but a reasoning one, matched by its kind rather than its full payload. */
const isContentBlock = (block: unknown): block is ContentBlockView =>
  isObject(block) && typeof block.type === 'string' && block.type !== 'reasoning'

/** Retains message content while omitting streamed chunks, usage accounting, and reasoning blocks. */
export function transcriptEntry(event: SessionEventView): TranscriptEntry | undefined {
  if (event.type !== 'user/message' && event.type !== 'tool/result' && event.type !== 'assistant/message') return undefined
  if (!isObject(event.data)) return undefined
  const message = event.type === 'user/message' ? event.data : event.data.message
  if (!isObject(message) || !Array.isArray(message.content) || typeof message.role !== 'string') return undefined
  const content: readonly unknown[] = message.content
  return { type: event.type, message: { role: message.role, content: content.filter(isContentBlock) } }
}

/** The direct human `user/message` event's message; `source.kind` tells a person's prompt from injected context. */
export function directUserMessage(event: SessionEventView): TurnUserMessage | undefined {
  if (event.type !== 'user/message' || !isObject(event.data)) return undefined
  const { id, source, content } = event.data
  if (typeof id !== 'string' || !isObject(source) || source.kind !== 'user' || !Array.isArray(content)) return undefined
  const blocks: readonly unknown[] = content
  const text = blocks.flatMap(block => isObject(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('\n')
  return { id, text, time: event.time }
}

/** The direct human message the Session's current turn carried, or undefined when that turn began none. */
export function currentTurnUserMessage(events: readonly SessionEventView[]): TurnUserMessage | undefined {
  const boundary = events.findLastIndex(event => event.type === 'turn/start' || event.type === 'turn/end')
  if (events[boundary]?.type !== 'turn/start') return undefined
  for (let index = events.length - 1; index > boundary; index--) {
    const message = directUserMessage(events[index]!)
    if (message) return message
  }
  return undefined
}
