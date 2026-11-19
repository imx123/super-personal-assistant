/**
 * The setting a person stated in their own words, read out of the message they wrote.
 *
 * **This is a narrow door, not a parser.** The Router may offer a preference of the person, and it may only do so when the
 * person wrote the words themselves. That check used to depend on the model calling the proposal tool in its very first
 * turn, which is a hope rather than a rule: a Router that answered a question first, or that answered in two turns, would
 * never offer the preference at all, and the person would have to say it twice. So the control plane reads the message
 * itself — and it reads it narrowly.
 *
 * **What counts as a setting.** The message must carry an explicit marker — `请记住`, `请记下`, `请备忘`, `记住：`,
 * `记下：` — and the marker must stand outside every quotation, in the person's own voice. Everything after the marker, up
 * to the end of the sentence, is the setting.
 *
 * **What does not count.**
 *
 * - A marker inside a quotation is somebody else's words: the person talked about the words, they did not say them.
 * - A marker that is refused (`不用记住`, `don't remember`) is the opposite of a setting.
 * - A sentence that only talks about a sentence (`请记住这句话：…`) is a discussion of a setting, not a setting.
 * - An attachment, an observation from outside and an earlier message are not the person's own words at all, and the
 *   control plane never reads them here: only the message the person just wrote to the Router is read.
 *
 * **What it is not.** A setting read here is not a memory: it is a proposal that waits for a decision, exactly like every
 * other proposal. The scope rules, the trust that the sources carry and the review that decides are the ones that always
 * were — this door adds a way in, and it does not loosen anything.
 */
import { stripQuoted } from '../control/fast-router.ts'

/** The markers that say the person is setting something down. */
const MARKERS: readonly string[] = ['请记住', '请记下', '请备忘', '记住：', '记住:', '记下：', '记下:']

/** The words that undo the marker right in front of it. */
const REFUSALS: readonly string[] = ['不要', '不用', '不必', '无需', '没必要', '勿', '别记', '别忘',
  'do not', "don't", 'dont', 'no need']

/** The words that say the sentence is about a sentence and not about a setting. */
const DISCUSSIONS: readonly string[] = ['他说', '她说', '他们说', '提到', '讨论', '这句话', '这句', '引述', '引用']

/** The most characters one setting may hold. */
const SETTING_LIMIT = 500

/** How much of the message before the marker is read for a refusal. */
const REFUSAL_WINDOW = 10

/**
 * The setting the person stated in this message, or nothing.
 *
 * The answer is the words themselves: they are a part of the message, so the control plane may check them against the
 * message later — the same check every other proposal of the person's own words goes through.
 */
export function statedPreferenceOf(text: string): string | undefined {
  // The person's own voice: the quoted spans are taken out first, so a marker inside a quotation is not a marker here.
  const spoken = stripQuoted(text)
  for (const marker of MARKERS) {
    const at = spoken.indexOf(marker)
    if (at < 0) continue
    // A refusal right in front of the marker turns the whole sentence into the opposite of a setting.
    const before = spoken.slice(Math.max(0, at - REFUSAL_WINDOW), at).toLowerCase()
    if (REFUSALS.some(word => before.includes(word))) continue
    const setting = firstSentence(spoken.slice(at + marker.length))
    if (setting === '') continue
    // The colon that follows the marker is not part of the setting.
    const body = setting.replace(/^[：:、,，\s]+/, '').trim()
    if (body === '') continue
    // A sentence that only talks about a sentence is not a setting.
    if (DISCUSSIONS.some(word => body.includes(word))) continue
    if (body.length > SETTING_LIMIT) continue
    return body
  }
  return undefined
}

/**
 * The first sentence of a text.
 *
 * The end of the sentence is a Chinese or an English full stop, a question or an exclamation, a semicolon or a line of its
 * own. A comma does not end it: a setting often carries a list of its own.
 */
function firstSentence(text: string): string {
  const trimmed = text.trim()
  const end = trimmed.search(/[。！？；!?;\n]/)
  const sentence = end < 0 ? trimmed : trimmed.slice(0, end)
  return sentence.trim()
}
