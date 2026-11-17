/**
 * The Fast Router's rules: what an obvious request says, before any model reads it.
 *
 * The Router is a real Agent with a real model, and a model turn is the most expensive thing this control plane does. An
 * instruction that plainly names its target does not need one: "继续工单 3f2a…" or "告诉项目「周报整理」把登录改成 SSO"
 * can be carried out by a rule that reads the authoritative state and matches the words. This module is that rule and
 * nothing else — it has no store, no node and no model — so it can be read, tested and argued about on its own.
 *
 * The rules are deliberately narrow, and they fail towards the high-level Router. A rule that is not sure does not act: it
 * says `escalate` and lets the model decide, and it says why. A wrong dispatch is expensive — a Ticket nobody asked for, an
 * instruction a Project did not deserve, a Worker started on a Ticket that had ended — while a needless escalation costs
 * one turn. The scope of what may be acted upon is checked by the control plane against the live state; this module only
 * says what the words ask for.
 *
 * The rules read the authoritative facts the control plane hands them, never a guess: a Ticket is continued because that
 * Ticket exists and is open, and a Project is chosen because exactly one Project's id — or its full title, in quotes — is
 * in the words.
 *
 * **A target is anchored.** A name that is part of a longer word ("周报整理" inside "周报整理月报"), a name that is only
 * talked about ("请解释「周报整理」这个项目的状态") and the name of a Project this control plane does not hold are all *no
 * target*: a rule that had picked them would hand a message to a Project nobody named. The only two forms that count are
 * an exact id and a full title inside quotes.
 *
 * **An order is anchored too.** A verb that says what shall happen stands next to the target it names, and the words
 * after it are a complete instruction. "请" is not such a verb: it is how a person asks, not what they ask for. Three
 * shapes of a message are therefore kept apart, and each is asked for by the words alone:
 *
 * - an **order** — a verb next to the target and a complete instruction behind it: "告诉项目「周报整理」把登录改成 SSO";
 * - a **question** — words that ask about the state of a thing: answered from the authoritative record, never dispatched;
 * - an **ambiguity** — anything else, which the model may resolve with the person.
 */

/** What the fast router decided about one message. */
export type FastRouteOutcome =
  /** The message continues a Ticket this Router owns; it goes to that Ticket's Worker. */
  | 'existing_ticket'
  /** The message is an instruction for one existing Project; it goes to that Project's PM. */
  | 'existing_project_pm'
  /** The message asks for an independent task; it becomes a standalone Ticket with its own Worker. */
  | 'standalone_ticket'
  /** The message asks for the state of a thing it names by its id; the record itself is the answer. */
  | 'read_only'
  /** The message looks like work, but no rule may act on it; the high-level Router decides. */
  | 'escalate'
  /** The message is a question or a conversation; the Router answers it as usual. */
  | 'ordinary_reply'

/**
 * Where the message is on its way, as the control plane knows it.
 *
 * The stages are facts about different moments: a message may be accepted and routed before a Worker exists, and a Worker
 * that was asked to start is not running until the node says so. The stage therefore never claims more than happened.
 */
export type FastRouteStage =
  /** The message was accepted and a rule claimed it. */
  | 'accepted'
  /** The control plane is carrying the decision out. */
  | 'routing'
  /** The target holds the work, but it has not started yet. */
  | 'queued'
  /** The target confirmed that it took the work. */
  | 'assigned'
  /** The message was handed to the high-level Router. */
  | 'escalated'
  /** The action could not be carried out. */
  | 'failed'
  /** The action was attempted and nobody confirmed it; the control plane cannot say whether it arrived. */
  | 'unconfirmed'

/**
 * How sure a rule has to be before it may act.
 *
 * The rules below never return a dispatch below this line; the control plane checks it anyway, so that a rule that grows
 * more doubtful later stops acting rather than acting wrongly.
 */
export const FAST_ROUTE_MIN_CONFIDENCE = 0.9

/** The target a rule found: one Ticket or one Project of this control plane. */
export interface FastRouteTarget {
  /** Whether the target is a Ticket or a Project. */
  kind: 'ticket' | 'project'
  /** The target's own id. */
  id: string
  /** The target's title, as the console shows it. */
  title: string
}

/** What one rule decided about one message. */
export interface FastRouteDecision {
  /** What the message is. */
  outcome: FastRouteOutcome
  /** Where the message is on its way; the control plane moves it on as the facts arrive. */
  stage: FastRouteStage
  /** How sure the rule was, between 0 and 1. */
  confidence: number
  /** The stable code of the reason; the console words it, the log keeps it. */
  reason: string
  /** The reason in words, for the console and the audit. */
  detail: string
  /** The target the rule found, when it found one. */
  target?: FastRouteTarget
  /** The title of a Ticket to create. */
  title?: string
  /** The goal of a Ticket to create. */
  goal?: string
  /** The text that would really be delivered to a Worker or a PM. */
  instruction?: string
}

/** One Ticket of this control plane, as the rules read it. */
export interface FastRouteTicket {
  /** The Ticket's own id. */
  id: string
  /** The Ticket's title. */
  title: string
  /** The Project it belongs to; empty for a Ticket the Router owns. */
  projectId?: string
  /** Whether the Ticket has ended. */
  ended: boolean
  /** Whether its Project archived it. */
  archived: boolean
}

/** One Project of this control plane, as the rules read it. */
export interface FastRouteProject {
  /** The Project's own id. */
  id: string
  /** The Project's title. */
  title: string
  /** The Project's status: `active`, `paused`, `ended` or `archived`. */
  status: string
}

/** The authoritative facts the rules read. */
export interface FastRouteFacts {
  /** Every Ticket this control plane holds. */
  tickets: readonly FastRouteTicket[]
  /** Every Project this control plane manages. */
  projects: readonly FastRouteProject[]
}

/**
 * The words that make a message a question rather than an order.
 *
 * A question is asked at its beginning ("为什么这个项目…" ) or at its end ("…现在什么状态？"), and the two places are the
 * only ones that count: a question word in the middle of a sentence is part of the words, not the shape of the message.
 */
const QUESTION_END_ZH = ['吗', '呢', '如何', '怎么', '为什么', '什么', '多少', '哪些', '哪个', '是否', '能否', '可否',
  '是不是', '有没有']
const QUESTION_START_ZH = ['为什么', '怎么', '如何', '什么', '多少', '哪些', '哪个', '是否', '能否', '可否', '是不是',
  '有没有']

/** The English words a question may begin with. */
const QUESTION_START_EN = ['what', 'how', 'why', 'when', 'where', 'which', 'who', 'can', 'could', 'should', 'would',
  'is', 'are', 'was', 'were', 'do', 'does', 'did', 'has', 'have', 'may', 'might', 'am']

/**
 * The Chinese words that make a message a negation or a cancellation.
 *
 * The single character "不" is not one of them: it is part of too many ordinary words ("不存在的项目", "不同的看法"), and a
 * rule that refused every message with a "不" in it would refuse the very sentences that name a Project that is not there.
 */
const NEGATION_ZH = ['不要', '不用', '不必', '不需', '无需', '不得', '不是', '没有', '别', '勿', '取消', '撤销', '停止',
  '暂停', '停下', '算了']

/** The English words that make a message a negation or a cancellation. */
const NEGATION_EN = ["don't", 'don’t', 'dont', 'do not', 'does not', 'doesn’t', 'not', 'never', 'no', 'without',
  'cancel', 'abort', 'halt', 'stop', 'skip']

/** The Chinese words that ask for something to be made. */
const CREATION_ZH = ['创建', '新建', '建立', '生成', '制作', '做', '写']

/** The English words that ask for something to be made. */
const CREATION_EN = ['create', 'make', 'build', 'generate', 'produce', 'write', 'add']

/**
 * The words that start a task of its own.
 *
 * They are fewer than the words that ask for something to be made: a task of its own is *created*, and a step inside a
 * task — "create an isolated sample file, write hello into it" — is not a second task. Only a conjunction between two of
 * them makes a message ask for more than one thing.
 */
const TASK_ZH = ['创建', '新建', '建立', '生成', '制作']

/** The English words that start a task of its own. */
const TASK_EN = ['create', 'make', 'build', 'generate', 'produce']

/** The words that join two tasks into one request. */
const CONJUNCTION = /并|并且|同时|另外|以及|\band\b|\bplus\b|\balso\b|\bthen\b/i

/** The Chinese words that say a task is independent of everything else. */
const MARKER_ZH = ['独立', '单独', '隔离', '一次性', '单个']

/** The English words that say a task is independent of everything else. */
const MARKER_EN = ['standalone', 'stand-alone', 'independent', 'isolated', 'separate', 'one-off', 'one off']

/**
 * The Chinese words that name something a task may produce.
 *
 * The list only answers "does this request name a thing at all": it never decides what happens to it, and it is kept to
 * the nouns a person actually writes down.
 */
const TASK_NOUN_ZH = ['工单', '工作单', '任务单', '任务', '文件', '脚本', '程序', '示例', '页面', '报告', '文档', '测试',
  '模块', '笔记', '表格', '仓库', '工具', '分支', '接口', '应用']

/** The English words that name something a task may produce. */
const TASK_NOUN_EN = ['ticket', 'task', 'work item', 'file', 'script', 'program', 'sample', 'example', 'page', 'report',
  'document', 'test', 'module', 'note', 'repository', 'tool', 'branch', 'api', 'application']

/**
 * The Chinese words that give work to a Project's PM.
 *
 * "请" is not one of them: it is how a person asks, not what they ask for, and a rule that read it as a handoff would
 * hand every polite question to a Project. A handoff verb says that somebody else shall do the work.
 */
const HANDOFF_ZH = ['告诉', '转告', '转达', '通知', '交给', '转交', '发给', '发送给', '传达', '派给', '派工', '委托',
  '指派', '布置', '汇报给', '让']

/** The English words that give work to a Project's PM. */
const HANDOFF_EN = ['tell', 'inform', 'notify', 'send', 'forward', 'relay', 'delegate', 'assign', 'hand off', 'handoff']

/** The Chinese words that continue the work of a Ticket that is already open. */
const CONTINUE_ZH = ['继续', '接着', '追加', '补充', '跟进', '再做', '重做']

/** The English words that continue the work of a Ticket that is already open. */
const CONTINUE_EN = ['continue', 'resume', 'append', 'follow up', 'keep going']

/**
 * The Chinese words that ask about the state of a thing.
 *
 * A message that only asks is never dispatched: it is answered from the authoritative record.
 */
const STATE_ZH = ['状态', '进度', '进展', '情况', '详情']

/** The English words that ask about the state of a thing. */
const STATE_EN = ['status', 'progress', 'state']

/**
 * The Chinese words that ask for something to be done, when no target was found.
 *
 * These words never dispatch anything. They only say whether the message is worth an escalation record: a message that
 * asks for work the rules could not place is left to the model with a reason written down, and a message that asks for
 * nothing is a conversation.
 *
 * The handoff verbs are in this list as well — a message that hands work to somebody without naming a target this
 * control plane holds is exactly the request the model has to place. "发给" is not: it is part of "发给我", which asks for
 * nothing but an answer.
 */
const COMMAND_ZH = ['创建', '新建', '建立', '生成', '制作', '派发', '派工', '执行', '运行', '跑', '部署', '发布', '删除',
  '移除', '修改', '更新', '修复', '排查', '重启', '安装', '下载', '上传', '翻译', '转换', '统计', '提取', '汇总', '总结',
  '整理', '继续', '追加', '完成', '处理', '帮我', '麻烦', '写', '重做', '配置', '告诉', '转告', '交给', '转交', '通知',
  '转达', '派给', '委托', '指派', '布置']

/** The English words that ask for something to be done, when no target was found. */
const COMMAND_EN = ['create', 'make', 'build', 'write', 'add', 'delete', 'remove', 'update', 'change', 'run', 'execute',
  'start', 'dispatch', 'assign', 'organize', 'summarise', 'summarize', 'check', 'fix', 'restart', 'deploy', 'submit',
  'merge', 'open', 'configure', 'install', 'download', 'upload', 'translate', 'convert', 'extract', 'continue', 'finish',
  'redo', 'tell', 'inform', 'notify', 'send', 'forward', 'relay', 'delegate']

/**
 * The Chinese words that name a scope nobody may undo.
 *
 * An instruction that asks for one of these is not carried out by a rule: the cost of a wrong irreversible action is paid
 * by the Project, and no rule can take it back. The list is short on purpose — it names the scopes that are not the
 * business of a routing rule, and everything else is left to the model and to the person behind it.
 */
const IRREVERSIBLE_ZH = ['删除', '删掉', '删库', '清空', '清库', '抹掉', '覆盖', '强制推送', '强制合并', '发布到生产',
  '上线到生产', '生产环境', '付款', '转账', '扣款', '重置', '格式化']

/** The English words that name a scope nobody may undo. */
const IRREVERSIBLE_EN = ['delete', 'drop database', 'purge', 'wipe', 'overwrite', 'force push', 'force merge',
  'deploy to production', 'release to production', 'payment', 'transfer', 'charge', 'reset', 'format', 'rm -rf']

/**
 * The Chinese words that ask for more authority than the message already carries.
 *
 * A routing rule hands a task to somebody who already has the authority to do it. A message that asks for authority is a
 * decision a person makes, not a rule.
 */
const AUTHORITY_ZH = ['授权', '权限', '批准', '许可', '提权', '密钥', '凭据', '令牌']

/** The English words that ask for more authority than the message already carries. */
const AUTHORITY_EN = ['authorize', 'authorization', 'grant', 'permission', 'privilege', 'credential', 'token', 'secret',
  'api key']

/** How close the words of one request may stand to each other; the rule reads one request, not two sentences. */
const MARKER_NEARBY = 16

/**
 * How close a verb may stand to the target it names.
 *
 * The verb and the target belong to one request, and the window is what tells "告诉项目「周报整理」…" from a sentence
 * that mentions a Project somewhere else.
 */
const VERB_NEARBY = 12

/** The longest title a rule writes for a Ticket. */
const TITLE_LIMIT = 40

/**
 * The quoted spans of a message; what they hold is data, not an instruction.
 *
 * The apostrophe is not one of them: a word like "don't" is a word, not a quote, and reading it as one would hide the
 * negation the rule has to see.
 */
const QUOTED = /「([^」]*)」|『([^』]*)』|“([^”]*)”|《([^》]*)》|"([^"]*)"|`([^`]*)`/g

/** The lead-in of a message that asks for a Ticket, and what is left of it afterwards. */
const TICKET_LEAD_IN = [
  /(?:创建|新建|建立|生成|派发|发送|派|开|发)\s*(?:一|1)?\s*(?:个|张|份|条|项)?\s*(?:独立|单独|隔离|一次性|单个)?\s*(?:的)?\s*(?:工单|工作单|任务单|任务)\s*(?:[:：,，]\s*)?/,
  /(?:create|make|open|dispatch|start|write)\s+(?:a|an|one|the|new)?\s*(?:standalone|stand-alone|independent|isolated|separate|one-off|one off)?\s*(?:work\s+item\s+)?(?:ticket|task)\s*(?:[:：,]\s*)?/i,
]

/** The lead-in of the goal of a Ticket, once the Ticket itself is named. */
const GOAL_LEAD_IN = /^(?:目标是|内容是|内容为|内容|to|for|that|which)\s*[:：]?\s*/i

/** One match of a word list: where it stands and how long it is. */
interface WordMatch {
  index: number
  length: number
}

/** One quoted span of a message: where it stands and what it holds. */
interface QuotedSpan {
  start: number
  end: number
  content: string
}

/** One target a rule found, and where the message named it. */
interface FoundTarget {
  target: FastRouteTarget
  start: number
  end: number
  /** Whether the message named the target by its exact id, rather than by its title in quotes. */
  byId: boolean
}

/** The first place one of the words stands, in Chinese or in English. */
function firstWord(text: string, chinese: readonly string[], english: readonly string[]): WordMatch | undefined {
  let best: WordMatch | undefined
  for (const word of chinese) {
    const index = text.indexOf(word)
    if (index < 0) continue
    if (best === undefined || index < best.index) best = { index, length: word.length }
  }
  const pattern = english.length === 0 ? undefined : new RegExp(`\\b(?:${english.map(escapeRegExp).join('|')})\\b`, 'i')
  if (pattern) {
    const match = pattern.exec(text)
    if (match && (best === undefined || match.index < best.index)) best = { index: match.index, length: match[0].length }
  }
  return best
}

/** Every place one of the words stands, in Chinese or in English. */
function allWords(text: string, chinese: readonly string[], english: readonly string[]): WordMatch[] {
  const found: WordMatch[] = []
  for (const word of chinese) {
    let index = text.indexOf(word)
    while (index >= 0) {
      found.push({ index, length: word.length })
      index = text.indexOf(word, index + word.length)
    }
  }
  const pattern = english.length === 0 ? undefined : new RegExp(`\\b(?:${english.map(escapeRegExp).join('|')})\\b`, 'gi')
  if (pattern) {
    for (const match of text.matchAll(pattern)) found.push({ index: match.index ?? 0, length: match[0].length })
  }
  return found.sort((left, right) => left.index - right.index)
}

/** The first place one of the words stands after `from`. */
function firstWordAfter(text: string, chinese: readonly string[], english: readonly string[],
  from: number, spans: readonly QuotedSpan[] = []): WordMatch | undefined {
  const found = allWords(text, chinese, english)
    .filter(match => match.index >= from && !insideQuote(spans, match))
  return found[0]
}

/** A word that stands inside another word is not a word here. */
function escapeRegExp(word: string): string { return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** Whether the message asks a question rather than gives an order. */
function isQuestion(text: string): boolean {
  if (text.endsWith('?') || text.endsWith('？')) return true
  for (const word of QUESTION_END_ZH) if (text.endsWith(word)) return true
  for (const word of QUESTION_START_ZH) if (text.startsWith(word)) return true
  const pattern = new RegExp(`^(?:${QUESTION_START_EN.map(escapeRegExp).join('|')})\\b`, 'i')
  return pattern.test(text)
}

/** Whether the message carries a negation or a cancellation. */
function hasNegation(text: string): boolean {
  for (const word of NEGATION_ZH) if (text.includes(word)) return true
  const pattern = new RegExp(`\\b(?:${NEGATION_EN.map(escapeRegExp).join('|')})\\b`, 'i')
  return pattern.test(text)
}

/** The message without its quoted spans: what the person said, and not what they quoted. */
function stripQuoted(text: string): string { return text.replace(QUOTED, ' ') }

/** The quoted spans of the message, and what each of them holds. */
function quotedSpans(text: string): QuotedSpan[] {
  const found: QuotedSpan[] = []
  for (const match of text.matchAll(QUOTED)) {
    const start = match.index ?? 0
    const content = match.slice(1).find(part => part !== undefined) ?? ''
    found.push({ start, end: start + match[0].length, content })
  }
  return found
}

/** Whether the message asks for something to be done, when no rule may act on it. */
function hasCommand(text: string): boolean {
  return firstWord(text, COMMAND_ZH, COMMAND_EN) !== undefined
}

/**
 * Whether the message gives work to somebody else.
 *
 * The verb has to stand next to the target it names: a handoff verb somewhere else in the sentence says nothing about the
 * Project that happens to be mentioned. A verb inside a quotation is not a verb the person used.
 */
function hasHandoff(text: string, mention: { start: number; end: number }, spans: readonly QuotedSpan[]): boolean {
  return handoffBefore(text, mention, spans) || handoffAfter(text, mention, spans)
}

/** Whether a handoff verb stands right before the target it names. */
function handoffBefore(text: string, mention: { start: number; end: number }, spans: readonly QuotedSpan[]): boolean {
  const verb = lastWordBefore(text, HANDOFF_ZH, HANDOFF_EN, mention.start, spans)
  return verb !== undefined && mention.start - (verb.index + verb.length) <= VERB_NEARBY
}

/** Whether a handoff verb stands right after the target it names. */
function handoffAfter(text: string, mention: { start: number; end: number }, spans: readonly QuotedSpan[]): boolean {
  const verb = firstWordAfter(text, HANDOFF_ZH, HANDOFF_EN, mention.end, spans)
  return verb !== undefined && verb.index - mention.end <= VERB_NEARBY
}

/** Whether a continuation verb stands right before the Ticket it names. */
function hasContinuation(text: string, mention: { start: number; end: number }, spans: readonly QuotedSpan[]): boolean {
  const verb = lastWordBefore(text, CONTINUE_ZH, CONTINUE_EN, mention.start, spans)
  if (verb === undefined) return false
  if (mention.start - (verb.index + verb.length) > VERB_NEARBY) return false
  const after = firstWordAfter(text, CONTINUE_ZH, CONTINUE_EN, mention.end, spans)
  return after === undefined || after.index - mention.end <= VERB_NEARBY
}

/** The last place one of the words stands before `from`. */
function lastWordBefore(text: string, chinese: readonly string[], english: readonly string[],
  from: number, spans: readonly QuotedSpan[] = []): WordMatch | undefined {
  const found = allWords(text, chinese, english)
    .filter(match => match.index + match.length <= from && !insideQuote(spans, match))
  return found[found.length - 1]
}

/**
 * Whether a word stands inside a quoted span.
 *
 * What is quoted is data: a verb inside a quotation is a word the person talked about, not an order they gave.
 */
function insideQuote(spans: readonly QuotedSpan[], match: WordMatch): boolean {
  return spans.some(span => match.index >= span.start && match.index < span.end)
}

/**
 * Whether the words ask about the state of a thing rather than ordering it to work.
 *
 * The state words stand at the beginning of what is left of the message, once the leading particles are dropped: "的进度"
 * asks about the progress, and it is not an instruction. An order behind a target is what the target is asked to do.
 */
function asksForState(text: string): boolean {
  const value = text.trim().replace(/^[的地得了着过吗呢吧啊呀嘛，,：:；;]+/, '')
  if (value === '') return false
  for (const word of STATE_ZH) if (value.startsWith(word)) return true
  return STATE_EN.some(word => new RegExp(`^${escapeRegExp(word)}\\b`, 'i').test(value))
}

/**
 * Whether the words ask about a thing instead of ordering it to work.
 *
 * A question about the state is answered from the authoritative record; an order behind a target is what the target is
 * asked to do.
 */
function isStateQuery(text: string): boolean {
  return asksForState(text) || isQuestion(text)
}

/** Whether the words ask for a scope nobody may undo. */
function asksForIrreversible(text: string): boolean {
  for (const word of IRREVERSIBLE_ZH) if (text.includes(word)) return true
  const pattern = new RegExp(`\\b(?:${IRREVERSIBLE_EN.map(escapeRegExp).join('|')})\\b`, 'i')
  return pattern.test(text)
}

/** Whether the words ask for more authority than the message carries. */
function asksForAuthority(text: string): boolean {
  for (const word of AUTHORITY_ZH) if (text.includes(word)) return true
  const pattern = new RegExp(`\\b(?:${AUTHORITY_EN.map(escapeRegExp).join('|')})\\b`, 'i')
  return pattern.test(text)
}

/**
 * Whether the message asks for more than one task.
 *
 * One request that names two things joined by a conjunction is two things — "create a standalone ticket and create a
 * script" — while one request that names a task and a step of it is one thing: "create an isolated sample file, write
 * hello into it". Only the conjunction tells them apart, so only the conjunction is looked for.
 */
function asksForSeveralTasks(text: string): boolean {
  const verbs = allWords(text, TASK_ZH, TASK_EN)
  for (let index = 1; index < verbs.length; index++) {
    const before = verbs[index - 1]!
    const after = verbs[index]!
    const between = text.slice(before.index + before.length, after.index)
    if (CONJUNCTION.test(between)) return true
  }
  return false
}

/**
 * The targets the message names, and where it named them.
 *
 * A Ticket is named by its id, and a Project by its id or by its full title inside quotes. Nothing else counts: a title
 * that is part of a longer word, a title that is only talked about and a title this control plane does not hold are all
 * no target at all.
 */
function findTargets(text: string, facts: FastRouteFacts): FoundTarget[] {
  const found: FoundTarget[] = []
  for (const ticket of facts.tickets) {
    const at = indexOfId(text, ticket.id)
    if (at !== undefined) {
      found.push({ target: { kind: 'ticket', id: ticket.id, title: ticket.title }, start: at, end: at + ticket.id.length,
        byId: true })
    }
  }
  for (const project of facts.projects) {
    const at = indexOfId(text, project.id)
    if (at !== undefined) {
      found.push({ target: { kind: 'project', id: project.id, title: project.title }, start: at, end: at + project.id.length,
        byId: true })
      continue
    }
    const quoted = quotedSpans(text).find(span => span.content.trim() === project.title)
    if (quoted !== undefined) {
      found.push({ target: { kind: 'project', id: project.id, title: project.title }, start: quoted.start, end: quoted.end,
        byId: false })
    }
  }
  return found.sort((left, right) => left.start - right.start)
}

/**
 * Where the text holds the id as a whole word.
 *
 * An id that stands inside a longer word is another id: a rule that read it as this one would address a Ticket that was
 * never named.
 */
function indexOfId(text: string, id: string): number | undefined {
  if (id === '') return undefined
  let index = text.indexOf(id)
  while (index >= 0) {
    const before = index === 0 ? '' : text[index - 1]!
    const after = text[index + id.length] ?? ''
    if (!isWordCharacter(before) && !isWordCharacter(after)) return index
    index = text.indexOf(id, index + 1)
  }
  return undefined
}

/** Whether the character is part of a word, so that an id beside it is a different one. */
function isWordCharacter(character: string): boolean {
  return character !== '' && /[0-9A-Za-z_-]/.test(character)
}

/**
 * The goal of a Ticket: what is left of the message once the Ticket itself is named.
 */
function goalOf(text: string): string {
  let goal = text.trim()
  for (const lead of TICKET_LEAD_IN) goal = goal.replace(lead, '')
  goal = goal.replace(GOAL_LEAD_IN, '').trim()
  return goal.replace(/^[\s:：,，、。.；;]+/, '').trim()
}

/** The title of a Ticket: the first clause of its goal, short enough to read. */
function titleOf(goal: string): string {
  const clause = goal.split(/[，,。.；;、\n]/).find(part => part.trim() !== '')?.trim() ?? goal.trim()
  return clause.length > TITLE_LIMIT ? `${clause.slice(0, TITLE_LIMIT)}…` : clause
}

/** A decision without a target: the rule found nothing to act on. */
function decide(outcome: FastRouteOutcome, reason: string, detail: string, confidence: number): FastRouteDecision {
  return { outcome, stage: outcome === 'escalate' ? 'escalated' : 'accepted', confidence, reason, detail }
}

/**
 * The rule that reads one message against the authoritative facts.
 *
 * It never writes anything and never calls anything: it returns what the words ask for and how sure it is, and the control
 * plane decides what may really happen.
 */
export function fastRoute(text: string, facts: FastRouteFacts): FastRouteDecision {
  const raw = text.trim()
  if (raw === '') return decide('ordinary_reply', 'empty_message', '这条消息没有内容。', 0)
  const command = stripQuoted(raw)
  if (command.trim() === '') return decide('ordinary_reply', 'quoted_text', '命令只在引号里，是引用的内容而不是指令。', 0)
  if (hasNegation(command)) return decide('ordinary_reply', 'negation', '消息里有否定或取消的意思，不由快路由执行。', 0)

  const targets = findTargets(raw, facts)
  if (targets.length > 1) return decide('escalate', 'multiple_targets', '消息里出现了多个目标，快路由不猜。', 0)
  if (targets.length === 1) return routeTarget(targets[0]!, raw, facts)

  // A question is a question, whatever else it says: "创建一个隔离的示例文件？" asks about the file, it does not make it.
  if (isQuestion(raw)) return decide('ordinary_reply', 'question', '这是一句提问，交给 Router 回答。', 0)
  if (asksForSeveralTasks(command)) return decide('escalate', 'multiple_tasks', '消息里有多件事，交给高层 Router 拆开。', 0)
  const task = standaloneTask(command, raw)
  if (task !== undefined) return task
  if (hasCommand(command)) {
    return decide('escalate', 'needs_model', '消息要求做事，但快路由没有确定的目标，交给高层 Router。', 0)
  }
  return decide('ordinary_reply', 'conversation', '这是一句普通的对话。', 0)
}

/** The rule that acts on the one target the message names. */
function routeTarget(found: FoundTarget, raw: string, facts: FastRouteFacts): FastRouteDecision {
  const { target } = found
  const spans = quotedSpans(raw)
  if (target.kind === 'ticket') {
    const ticket = facts.tickets.find(item => item.id === target.id)
    if (ticket === undefined) return decide('escalate', 'unknown_ticket', '消息里的工单不在这个控制面里，交给高层 Router。', 0)
    if (ticket.archived) return decide('escalate', 'ticket_archived', '这张工单已经归档，不会被重新打开。', 0)
    if (ticket.ended) return decide('escalate', 'ticket_ended', '这张工单已经结束，不会被重新打开。', 0)
  }
  const instruction = raw.slice(found.end).trim()
  // A question about the state of the thing is answered from the authoritative record and dispatched to nobody.
  if (isStateQuery(instruction) || isQuestion(raw)) {
    if (found.byId) {
      return { outcome: 'read_only', stage: 'accepted', confidence: 0.96, reason: 'read_only_id',
        detail: '消息只问这张工单或这个项目的状态，直接按权威记录回答。', target }
    }
    return decide('ordinary_reply', asksForState(instruction) ? 'read_only' : 'question',
      asksForState(instruction) ? '消息只提到这个项目，交给 Router 用权威状态回答。' : '这是一句提问，交给 Router 回答。', 0)
  }
  if (target.kind === 'ticket') {
    const ticket = facts.tickets.find(item => item.id === target.id)!
    // A Project's own Ticket belongs to its PM: the Router decides what that Project needs, not a rule.
    if (ticket.projectId !== undefined) {
      return decide('escalate', 'ticket_of_project', '这张工单属于一个项目，交给高层 Router 判断。', 0)
    }
    if (!hasContinuation(raw, found, spans)) {
      return decide('escalate', 'ambiguous_target', '消息提到这张工单，但没说清要做什么，交给高层 Router。', 0)
    }
    const blocked = scopeRefusal(instruction, facts, target.id)
    if (blocked !== undefined) return blocked
    return { outcome: 'existing_ticket', stage: 'accepted', confidence: 0.98, reason: 'explicit_ticket_id',
      detail: '消息点名了这张独立工单，续接它的 Worker。', target, instruction: raw }
  }
  const project = facts.projects.find(item => item.id === target.id)
  if (project === undefined) return decide('escalate', 'unknown_project', '消息里的项目不在这个控制面里，交给高层 Router。', 0)
  if (project.status !== 'active') {
    return decide('escalate', 'project_unavailable', `项目「${project.title}」现在是 ${project.status}，快路由不投递。`, 0)
  }
  if (!hasHandoff(raw, found, spans)) {
    return decide('escalate', 'ambiguous_target', '消息提到这个项目，但没说清要交给它做什么，交给高层 Router。', 0)
  }
  if (instruction === '') {
    return decide('escalate', 'missing_instruction', '消息要把事情交给这个项目，但没有说清是什么事，交给高层 Router。', 0)
  }
  const blocked = scopeRefusal(instruction, facts, target.id)
  if (blocked !== undefined) return blocked
  return { outcome: 'existing_project_pm', stage: 'accepted', confidence: 0.95, reason: 'explicit_project',
    detail: `消息点名了项目「${project.title}」，直接交给它的 PM。`, target, instruction: raw }
}

/**
 * The scope a rule may not act on by itself.
 *
 * Three things are left to the model and the person behind it: a scope nobody may undo, a request for more authority
 * than the message carries, and an instruction that reaches into another Project.
 */
function scopeRefusal(instruction: string, facts: FastRouteFacts, targetId: string): FastRouteDecision | undefined {
  if (asksForIrreversible(instruction)) {
    return decide('escalate', 'irreversible_scope', '这条指令的范围不可逆，交给高层 Router 和操作员。', 0)
  }
  if (asksForAuthority(instruction)) {
    return decide('escalate', 'new_authority', '这条指令要新的授权，交给高层 Router 和操作员。', 0)
  }
  for (const project of facts.projects) {
    if (project.id === targetId) continue
    if (indexOfId(instruction, project.id) !== undefined) {
      return decide('escalate', 'cross_project', '这条指令说到别的项目，交给高层 Router。', 0)
    }
    if (instruction.includes(project.title)) {
      return decide('escalate', 'cross_project', '这条指令说到别的项目，交给高层 Router。', 0)
    }
  }
  return undefined
}

/**
 * The rule that reads a message as an independent task of its own.
 *
 * The shape is read from the message without its quotations — a quoted instruction is not the person's own order — but the
 * goal is the person's own words, quotations included: what a task has to write into a file stays exactly as it was
 * written.
 */
function standaloneTask(command: string, raw: string): FastRouteDecision | undefined {
  const marker = firstWord(command, MARKER_ZH, MARKER_EN)
  if (marker === undefined) return undefined
  const creation = firstWord(command, CREATION_ZH, CREATION_EN)
  if (creation === undefined) return undefined
  // The words of one request stand together: "创建一个独立工单" is one request, and two of them are two.
  if (Math.abs(creation.index - marker.index) > MARKER_NEARBY) return undefined
  const noun = firstWordAfter(command, TASK_NOUN_ZH, TASK_NOUN_EN, marker.index + marker.length)
  if (noun === undefined) return undefined
  const goal = goalOf(raw)
  if (goal === '') {
    return decide('escalate', 'missing_goal', '消息要一个独立任务，但没有说清做什么，交给高层 Router 追问。', 0)
  }
  if (asksForIrreversible(goal)) {
    return decide('escalate', 'irreversible_scope', '这个任务的范围不可逆，交给高层 Router 和操作员。', 0)
  }
  if (asksForAuthority(goal)) {
    return decide('escalate', 'new_authority', '这个任务要新的授权，交给高层 Router 和操作员。', 0)
  }
  return { outcome: 'standalone_ticket', stage: 'accepted', confidence: 0.92, reason: 'standalone_task',
    detail: '这是一条明确的独立任务，直接派一张独立工单。', title: titleOf(goal), goal }
}
