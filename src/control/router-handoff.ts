/**
 * The high-level Router's handoff: the check that decides whether a model's own decision may reach a Project's PM.
 *
 * The Fast Router carries out a message whose target it can read off the words. The high-level Router is a model, and a
 * model that says "this belongs to that Project" is an opinion: it may be right, and it may be about a Project the person
 * never named, about work nobody asked for, or about a second Project that happens to exist. So the decision is judged
 * here, on the same terms the Project Gate is judged on: the person's own words decide, and the model's account of them
 * is never believed.
 *
 * Four things are checked, and each of them is a fact about the request rather than about the model:
 *
 * 1. **The work.** The request has to ask for work. A greeting, a joke and a request to talk about the plan ask for
 *    nothing to be done, and a PM that was told to do something nobody asked for would be a PM doing invented work.
 * 2. **The target.** Exactly one Project may be the target, and the request has to name it — by its full title or by its
 *    id. A request that names none and a request that names two are both answered with a question, not with a delivery.
 *    The one exception is the Project the request itself created: there the binding is the request's own creation, and
 *    the Project of that creation is the only one it may reach.
 * 3. **The words.** The instruction that travels to the PM has to be the person's own words. The control plane checks that the
 *    whole instruction appears in the request exactly as written. That is what keeps the history of the
 *    conversation, the files the person attached and another Project's private material out of the PM's mouth: the
 *    instruction cannot carry a word the request does not hold.
 * 4. **The scope.** An instruction that reaches into another Project, that asks for authority the request does not carry
 *    or that asks for something nobody may undo is not a routine handoff. It goes back to the person.
 *
 * The module reads and judges; it never writes and never sends. The control plane owns the store, the node and the model,
 * and the control plane is what delivers the instruction once this module has allowed it.
 */
import { asksForAuthority, asksForIrreversible, hasNegation, isQuestion, stripQuoted } from './fast-router.ts'
import { workAuthorization } from './project-gate.ts'

/** The longest goal a decision may carry. */
const MAX_INSTRUCTION = 2000
/** The longest reason a decision may carry. */
const MAX_RATIONALE = 600
/** The longest id a decision may name. */
const MAX_PROJECT_ID = 120
/** The shortest reason that counts as a reason. */
export const ROUTER_HANDOFF_MIN_RATIONALE = 4
/** The shortest instruction that says something. */
export const ROUTER_HANDOFF_MIN_INSTRUCTION = 4

/**
 * The words that ask for something to be added to what is already there.
 *
 * They ask for work as much as "改" does, and the request "请在「周报整理」补充本周数据" asks for exactly as much work
 * as a request to rewrite a page does.
 */
const EXTRA_WORK_ZH = ['补充', '追加', '跟进', '补录', '填报']
/** The English words that ask for something to be added to what is already there. */
const EXTRA_WORK_EN = ['append', 'supplement', 'follow up', 'fill in']

/**
 * The words that say "create it, and leave it alone".
 *
 * A person who says this wants a Project that exists and a PM that waits: the work starts when they say so, and not
 * before. The rule is only asked about a request that creates a Project, so a word that merely appears in an ordinary
 * request never changes anything.
 */
const CREATE_ONLY_ZH = ['只创建', '仅创建', '只新建', '仅新建', '只建项目', '仅建项目', '只立项', '仅立项', '只准备', '仅准备',
  '待命', '暂不动工', '先不动工', '暂不开工', '先不开工']
/** The English words that say "create it, and leave it alone". */
const CREATE_ONLY_EN = ['only create', 'just create', 'only prepare', 'standby', 'stand by', 'without starting']

/**
 * What the high-level Router decided about one request.
 *
 * It names the Project, the words that would really travel to its PM and the short reason a person may check. The
 * reason is not decoration: it is what the console shows beside the delivery, so that a person can see why the Router
 * thought this Project was the one.
 */
export interface RouterHandoffDecision {
  /** The Project whose PM is to receive the work. */
  projectId: string
  /** The work, in the person's own words. */
  instruction: string
  /** The short, checkable reason why this Project is the one. */
  rationale: string
}

/** One Project this control plane holds, as the handoff reads it. */
export interface RouterHandoffProject {
  /** The Project's own id. */
  id: string
  /** The Project's title, as the console shows it. */
  title: string
  /** The Project's status: `active`, `paused`, `ended` or `archived`. */
  status: string
}

/** What the handoff read about the request and about the Projects that exist. */
export interface RouterHandoffFacts {
  /** The person's own words, as they were written. */
  text: string
  /** Every Project this control plane holds. */
  projects: readonly RouterHandoffProject[]
  /** The Project this request created, when it created one. */
  createdProjectId?: string
}

/**
 * The verdict of the handoff.
 *
 * A refusal is a real answer: nothing was delivered, and the reason says what a person has to settle before the work
 * may travel.
 */
export interface RouterHandoffVerdict {
  /** Whether the instruction may be delivered to that Project's PM. */
  allowed: boolean
  /** The stable code of the reason; the console words it, the log keeps it. */
  reason: string
  /** The reason in words. */
  detail: string
  /** The Project the instruction is for, when it may be delivered. */
  project?: { id: string; title: string }
  /** The instruction that would really travel, when it may be delivered. */
  instruction?: string
}

/**
 * A decision the handoff cannot read at all.
 *
 * A missing field, a reason too short to check: none of them is a refusal of the work, they are a decision that cannot
 * be judged. The control plane records the reason and delivers nothing.
 */
export class RouterHandoffError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message)
    this.name = 'RouterHandoffError'
  }
}

/** The PM receives an exact excerpt of the current request. */
export function tracedFromRequest(instruction: string, text: string): boolean {
  const excerpt = instruction.trim()
  return excerpt.length > 0 && text.includes(excerpt)
}

/**
 * Whether the text holds the id as a whole word.
 *
 * An id that stands inside a longer word is another id: a check that read it as this one would bind the request to a
 * Project nobody named.
 */
function holdsWholeId(text: string, id: string): boolean {
  if (id === '') return false
  let index = text.indexOf(id)
  while (index >= 0) {
    const before = index === 0 ? '' : text[index - 1]!
    const after = text[index + id.length] ?? ''
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true
    index = text.indexOf(id, index + 1)
  }
  return false
}

/** Whether the character is part of a word, so that an id beside it is a different one. */
function isWordCharacter(character: string): boolean {
  return character !== '' && /[0-9A-Za-z_-]/.test(character)
}

/** A shorter title is ignored only at the same position as a longer title. */
export function mentionedProjects(text: string, projects: readonly RouterHandoffProject[]): RouterHandoffProject[] {
  const matchedIds = new Set<string>()
  const titles: { id: string; start: number; end: number }[] = []
  for (const project of projects) {
    if (holdsWholeId(text, project.id)) matchedIds.add(project.id)
    const title = project.title.trim()
    if (title === '') continue
    for (let start = text.indexOf(title); start >= 0; start = text.indexOf(title, start + 1)) {
      titles.push({ id: project.id, start, end: start + title.length })
    }
  }
  titles.sort((a, b) => a.start - b.start || b.end - a.end)
  let cover: (typeof titles)[number] | undefined
  for (const title of titles) {
    if (cover && cover.end >= title.end && (cover.start !== title.start || cover.end !== title.end)) continue
    matchedIds.add(title.id)
    cover = title
  }
  return projects.filter(project => matchedIds.has(project.id))
}

/**
 * Whether the request asks for work, in the words it uses.
 *
 * It reads the request the way the Project Gate reads it, and it knows the words that add something to what is already
 * there: "补充" asks for as much work as "改" does.
 */
export function handoffWorkIntent(text: string): 'ok' | 'no_work_instruction' | 'discussion_only' {
  const base = workAuthorization(text)
  if (base !== 'no_work_instruction') return base
  const command = stripQuoted(text)
  if (command.trim() === '') return 'no_work_instruction'
  return firstOf(command, EXTRA_WORK_ZH, EXTRA_WORK_EN) === undefined ? 'no_work_instruction' : 'ok'
}

/** The first place one of the words stands, in Chinese or in English. */
function firstOf(text: string, chinese: readonly string[], english: readonly string[]): { index: number } | undefined {
  let best: { index: number } | undefined
  for (const word of chinese) {
    const index = text.indexOf(word)
    if (index >= 0 && (best === undefined || index < best.index)) best = { index }
  }
  const pattern = english.length === 0 ? undefined : new RegExp(`\\b(?:${english.map(escape).join('|')})\\b`, 'i')
  if (pattern) {
    const match = pattern.exec(text)
    if (match && (best === undefined || match.index < best.index)) best = { index: match.index }
  }
  return best
}

/** The word as a pattern of its own. */
function escape(word: string): string { return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/**
 * Whether the person asked for the Project to be created and to wait.
 *
 * Such a request keeps the Project idle after its creation: the PM is there, and it does not start work nobody asked
 * for. The rule is only asked about a request that creates a Project, so it never touches an ordinary one.
 */
export function createOnlyRequest(text: string): boolean {
  const command = stripQuoted(text)
  for (const word of CREATE_ONLY_ZH) if (command.includes(word)) return true
  const pattern = new RegExp(`\\b(?:${CREATE_ONLY_EN.map(escape).join('|')})\\b`, 'i')
  return pattern.test(command)
}

/** A text the decision must carry. */
function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RouterHandoffError('invalid_decision', `The decision needs a ${name}.`)
  }
  const text = value.trim()
  if (text.length > max) throw new RouterHandoffError('invalid_decision', `The ${name} is too long.`)
  return text
}

/**
 * Read the decision a model proposed.
 *
 * The reading is strict on purpose: a decision without a target, without words or without a reason a reader could check
 * is a decision the control plane cannot judge, and a decision it cannot judge never reaches a PM.
 */
export function readRouterHandoffDecision(input: unknown): RouterHandoffDecision {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new RouterHandoffError('invalid_decision', 'The decision must be an object.')
  }
  const raw = input as Record<string, unknown>
  const instruction = requiredText(raw.instruction, 'instruction', MAX_INSTRUCTION)
  if (instruction.length < ROUTER_HANDOFF_MIN_INSTRUCTION) {
    throw new RouterHandoffError('invalid_decision', 'The instruction is too short to say something.')
  }
  const rationale = requiredText(raw.rationale, 'rationale', MAX_RATIONALE)
  if (rationale.length < ROUTER_HANDOFF_MIN_RATIONALE) {
    throw new RouterHandoffError('missing_evidence', 'The decision needs a reason that is long enough to check.')
  }
  return { projectId: requiredText(raw.projectId, 'project id', MAX_PROJECT_ID), instruction, rationale }
}

/** A verdict that refuses, with the reason and the words. */
function refuse(reason: string, detail: string): RouterHandoffVerdict { return { allowed: false, reason, detail } }

/**
 * The verdict of the handoff on one decision.
 *
 * The decision is judged, never trusted: the request has to ask for work, the target has to be the one the request names
 * — or the one the request created — and the instruction has to be the person's own words. A request that names no
 * Project, that names two, that only asks, that negates, that reaches into another Project or that asks for a new
 * authority is answered with a reason and not with a delivery.
 */
export function evaluateRouterHandoff(decision: RouterHandoffDecision, facts: RouterHandoffFacts): RouterHandoffVerdict {
  const text = facts.text.trim()
  // The work: the request has to ask for something to be done.
  const work = handoffWorkIntent(text)
  if (work === 'no_work_instruction') {
    return refuse('no_work_instruction', '本人的请求没有要求开展这项工作，不会自动交给项目 PM。')
  }
  if (work === 'discussion_only') {
    return refuse('discussion_only', '本人的请求只要求讨论或解释，没有要求动手做，不会自动交给项目 PM。')
  }
  // A question is not an order, and a negated one is not either.
  if (isQuestion(text) || /(?:怎么样|怎样)[。！!，,]*$/.test(text)) return refuse('request_question', '本人的请求是一句提问，不会自动交给项目 PM。')
  if (hasNegation(stripQuoted(text))) {
    return refuse('request_negated', '本人的请求里有否定或取消，不会自动交给项目 PM。')
  }
  // The target: a Project of this control plane, and only one.
  const project = facts.projects.find(item => item.id === decision.projectId)
  if (project === undefined) return refuse('unknown_project', `这个控制面里没有项目 ${decision.projectId}。`)
  if (facts.createdProjectId !== undefined) {
    // The request created a Project: that Project is the only one this request may reach.
    if (facts.createdProjectId !== project.id) {
      return refuse('created_project_mismatch', '这条请求已经建了自己的项目，工作只交给那个项目的 PM。')
    }
  } else {
    const named = mentionedProjects(text, facts.projects)
    if (named.length === 0) {
      return refuse('target_not_named', '本人的请求没有点名任何项目，无法核对这是哪一个项目；先向本人确认是哪个项目。')
    }
    if (named.length > 1) {
      return refuse('ambiguous_target', `本人的请求里出现了 ${named.length} 个项目，先向本人确认是哪一个。`)
    }
    if (named[0]!.id !== project.id) {
      return refuse('target_mismatch', '模型选的项目不是本人的请求点名的那个，先向本人确认。')
    }
  }
  // The scope: no other Project. It is read before the words, because an instruction that reaches into another Project
  // is the sharper fact: it would give one PM something about a Project it does not own.
  const instruction = decision.instruction.trim()
  for (const other of mentionedProjects(instruction, facts.projects)) {
    if (other.id !== project.id) {
      return refuse('cross_project', '交给 PM 的内容说到别的项目，不会自动交接。')
    }
  }
  // The words: the instruction has to be the person's own.
  if (!tracedFromRequest(instruction, text)) {
    return refuse('instruction_not_in_request', '交给 PM 的内容必须来自本人的原话；历史、附件和别的项目的材料不能一起送过去。')
  }
  // The rest of the scope: no new authority, nothing nobody may undo.
  if (asksForIrreversible(text) || asksForIrreversible(instruction)) {
    return refuse('irreversible_scope', '这项工作的范围不可逆，先由本人确认，不会自动交接。')
  }
  if (asksForAuthority(text) || asksForAuthority(instruction)) {
    return refuse('new_authority', '这项工作要新的授权，先由本人确认，不会自动交接。')
  }
  return { allowed: true, reason: 'allowed',
    detail: `本人的请求点名的项目是「${project.title}」，交给它的 PM。`,
    project: { id: project.id, title: project.title }, instruction }
}
