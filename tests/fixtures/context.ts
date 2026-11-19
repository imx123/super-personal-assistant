/**
 * The words of a message, without the reference material beside them.
 *
 * A turn carries the person's own words and, beside them, the bounded reference material in a fence of its own. The fence
 * is the last thing in the message, and the words in front of it are the words the caller sent: a test that looks at what
 * a Session really received looks at the words, not at the fence.
 *
 * **Only the trailing fence is taken off.** Nothing else changes: the words themselves, their order, their spacing and
 * everything the caller wrote stay exactly as they went out. A message that carries no fence is returned as it is.
 */
export function withoutContextFence(text: string): string {
  const at = text.lastIndexOf('\n\n<context_reference_data>')
  if (at < 0) return text
  return text.slice(0, at)
}

/**
 * The messages one Session really received, with the reference material beside them taken off.
 *
 * The order and the number of the messages are the caller's own: nothing is dropped and nothing is added.
 */
export function messagesWithoutContext(messages: readonly string[] | undefined): readonly string[] {
  return (messages ?? []).map(withoutContextFence)
}
