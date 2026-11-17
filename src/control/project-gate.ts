/**
 * The Project Gate: the four conditions a request must meet before the control plane may create a Project on its own.
 *
 * A person may ask for a Project outright, and the control plane creates it on that word alone — that is the human's own
 * authority, and nothing here touches it. But a Project is also the most expensive thing this control plane creates: it
 * starts a PM, a workspace and a chain of Tickets, and nobody asked for any of it. When a model decides on its own that a
 * request deserves a Project, the decision is checked here, and only a decision that holds **all four** conditions may
 * become one.
 *
 * The four conditions are separate, and each is judged on its own evidence:
 *
 * 1. **several relatively independent modules** — the work really is several things, not one thing described twice;
 * 2. **reasonable decoupling** — those things do not need each other to move;
 * 3. **genuine parallelism** — they can really be worked at the same time;
 * 4. **the gain outweighs the coordination** — splitting them pays for the talking.
 *
 * "It is complex", "it will take a long time" and "there are many sub-tasks" are **not** any of the four. A decision whose
 * evidence is only that is refused, whatever its checkboxes say: the evidence has to point at the modules it claims,
 * because the modules are what the four conditions are about. A condition that answers "unknown" is not an answer either:
 * only a yes or a no may be judged, and only a yes opens the gate.
 *
 * The four findings are also only the model's own account of the request, so the decision has to show where it comes
 * from: the **request anchor** is a short quote of the person's own words that ask for this work, and every module
 * carries its own **anchor**, a short quote of the request that this module comes from. The gate checks the quotes
 * against the request itself, so a decision about a piece of work the person never mentioned is refused however true
 * its four findings are. The request itself is read too: a person who only chatted, who asked about a plan or who only
 * asked to talk about the work did not ask for anything to be built.
 *
 * These are bounded rules and not a proof: they say that the decision quotes the request and that the request asks for
 * work. What the four conditions mean for a real piece of work is still a judgement a person has to make.
 *
 * This module reads and judges; it never writes. The control plane owns the store, the node and the model, and the control
 * plane is what applies the verdict.
 */
import { PROJECT_GATE_CONDITIONS, type ProjectGateCondition } from '../shared/protocol.ts'
import { escapeRegExp, hasNegation, isQuestion, NEGATION_EN, NEGATION_ZH, quotedTexts, stripQuoted } from './fast-router.ts'

/** The words each condition is named by; the console and the audit read them. */
export const PROJECT_GATE_CONDITION_WORDS: Record<ProjectGateCondition, string> = {
  multiple_independent_modules: '多个相对独立的模块',
  reasonable_decoupling: '模块之间合理解耦',
  genuine_parallelism: '模块可以真实并行',
  benefit_outweighs_coordination: '并行收益抵消协调成本',
}

/**
 * One condition's finding: whether it holds, and the short reason a person can check.
 *
 * The evidence is not a summary of the model's reasoning: it is the thing a reader looks at to see whether the condition
 * really holds, so it has to name what the condition is about.
 */
export interface ProjectGateFinding {
  /** The condition this finding is about. */
  condition: ProjectGateCondition
  /** Whether the condition holds. */
  met: boolean
  /** The short, checkable reason. */
  evidence: string
}

/**
 * One module of the work: what it is responsible for, and whether it may move without the others.
 *
 * The independence is a claim with a reason of its own, because it is the claim the four conditions rest on: a module that
 * cannot move on its own is not a module the work may be split into.
 *
 * The `anchor` is the words of the person's own request that this module comes from. A module that cannot point at a
 * quote of the request is a module the model made up, and a made-up module is not one of the several independent things
 * the four conditions are about.
 */
export interface ProjectGateModule {
  /** The module's own name. */
  name: string
  /** What this module is responsible for. */
  responsibility: string
  /** Whether this module may advance without the others. */
  independent: boolean
  /** The short, checkable reason for that independence. */
  evidence: string
  /** The words of the person's own request that this module comes from. */
  anchor: string
}

/**
 * The decision a model proposes: a Project, the modules it is made of, and the four findings.
 *
 * The `requestAnchor` is the words of the person's own request that ask for this work. It is the one place where the
 * decision has to touch the request instead of the model's own account of it: without it the four findings and the
 * modules are only the model's opinion, and an opinion is enough to make a Project.
 */
export interface ProjectGateDecision {
  /** The title of the Project the decision would create. */
  title: string
  /** The goal of that Project. */
  goal: string
  /** The words of the person's own request that ask for this work. */
  requestAnchor: string
  /** The modules the work is split into. */
  modules: ProjectGateModule[]
  /** The four findings, one per condition. */
  conditions: ProjectGateFinding[]
}

/** One Project this control plane already holds, as the gate reads it. */
export interface ProjectGateProject {
  /** The Project's own id. */
  id: string
  /** The Project's title, as the console shows it. */
  title: string
  /** The Project's status: `active`, `paused`, `ended` or `archived`. */
  status: string
}

/** What the gate read about the request and about the Projects that already exist. */
export interface ProjectGateFacts {
  /** The person's own words, as they were written. */
  text: string
  /** Every Project this control plane holds. */
  projects: readonly ProjectGateProject[]
}

/** The verdict of the gate. */
export interface ProjectGateVerdict {
  /** Whether the Project may be created without a person asking for it. */
  allowed: boolean
  /** The stable code of the verdict; the console words it, the log keeps it. */
  reason: string
  /** The verdict in words. */
  detail: string
  /** The four findings, as they were read. */
  conditions: ProjectGateFinding[]
  /** The modules, as they were read. */
  modules: ProjectGateModule[]
  /** The condition that failed, when one did. */
  failedCondition?: ProjectGateCondition
  /** The Project the request named outright, when it named one. */
  existingProject?: { id: string; title: string }
}

/**
 * A decision the gate cannot read at all.
 *
 * A missing condition, a condition that answers something other than yes or no, a missing evidence: none of them is a
 * refusal of the work, they are a decision that cannot be judged. The control plane records the reason and creates
 * nothing.
 */
export class ProjectGateError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message)
    this.name = 'ProjectGateError'
  }
}

/** The longest title a decision may carry. */
const MAX_TITLE = 120
/** The longest goal a decision may carry. */
const MAX_GOAL = 4000
/** The longest evidence a decision may carry. */
const MAX_EVIDENCE = 600
/** The most modules a decision may name. */
const MAX_MODULES = 8
/** The longest quote of the request a decision may carry. */
const MAX_REQUEST_ANCHOR = 160
/** The longest quote of the request one module may carry. */
const MAX_MODULE_ANCHOR = 80
/** The shortest quote of the request that says something. */
const MIN_REQUEST_ANCHOR = 4
/**
 * The shortest evidence that counts as a reason.
 *
 * "Yes" is not a reason, and neither is "可以": an evidence shorter than this says nothing a reader could check.
 */
export const PROJECT_GATE_MIN_EVIDENCE = 4

/**
 * The Chinese words that ask for something to be made.
 *
 * The list is short on purpose: it names the acts that create a thing, and each of them is looked for next to the word
 * "项目". A word that merely contains one of them ("开发", "建议") is not an act, and the words between the act and the
 * word it names have to be a quantifier and a few adjectives.
 */
const PROJECT_CREATION_ZH = ['创建', '新建', '建立', '开', '启动', '建']

/** The Chinese words that name a Project. */
const PROJECT_WORD_ZH = ['项目', '工程']

/**
 * The words that may stand between the act and the Project it names.
 *
 * "创建一个独立的项目" is one request for a Project; "建议项目" is a name of something else, and "创建一份项目计划" asks
 * for a plan. Only the words of a request are allowed here.
 */
const PROJECT_MODIFIER_ZH = /^(?:(?:[一1]个|[一1]|个)|[新独立单独小大临时测试演示示例虚拟的]){0,6}$/

/**
 * The Chinese nouns that make the Project a word inside another thing.
 *
 * "建立项目文档" asks for a document, not for a Project, and a request that asks for a document must not open the gate.
 */
const PROJECT_CONTENT_NOUN_ZH = ['文档', '档案', '表单', '目录', '模板', '说明', '清单', '列表', '规范', '提案', '章程',
  '计划', '手册', '介绍', '背景', '状态', '进展', '报告', '总结', '评估', '建议', '讨论', '纪要', '会议', '调研', '分析',
  '汇报']

/** How far the words may stand between the act and the Project they name. */
const PROJECT_WORD_WINDOW = 8

/** The English words that ask for something to be made, next to the word "project". */
const PROJECT_REQUEST_EN = /\b(?:create|new|make|start|set\s+up|open)\s+(?:a\s+|an\s+|the\s+)?projects?\b/gi

/** The English nouns that make the Project a word inside another thing. */
const PROJECT_CONTENT_NOUN_EN = ['document', 'documents', 'doc', 'docs', 'report', 'reports', 'plan', 'plans', 'summary',
  'list', 'lists', 'template', 'templates', 'note', 'notes', 'spec', 'proposal', 'readme', 'folder', 'directory', 'file',
  'files']

/**
 * Whether the Chinese words ask for a Project to be made.
 *
 * The act has to stand next to the word it names, with only a quantifier and a few adjectives in between, and what follows
 * the word may not be another noun: "建立项目文档" asks for a document.
 */
function asksForProjectInChinese(command: string): boolean {
  for (const verb of PROJECT_CREATION_ZH) {
    let index = command.indexOf(verb)
    while (index >= 0) {
      const after = command.slice(index + verb.length, index + verb.length + PROJECT_WORD_WINDOW)
      for (const word of PROJECT_WORD_ZH) {
        const at = after.indexOf(word)
        if (at < 0) continue
        if (!PROJECT_MODIFIER_ZH.test(after.slice(0, at))) continue
        if (namesSomethingElse(command.slice(index + verb.length + at + word.length))) continue
        return true
      }
      index = command.indexOf(verb, index + 1)
    }
  }
  return false
}

/**
 * Whether the English words ask for a Project to be made.
 *
 * The same rule as in Chinese: the act stands next to the word it names, and what follows the word may not be another noun.
 */
function asksForProjectInEnglish(command: string): boolean {
  for (const match of command.matchAll(PROJECT_REQUEST_EN)) {
    const behind = command.slice((match.index ?? 0) + match[0].length)
    const word = /^[a-z]+/i.exec(behind)?.[0]?.toLowerCase() ?? ''
    if (word !== '' && PROJECT_CONTENT_NOUN_EN.includes(word)) continue
    return true
  }
  return false
}

/**
 * Whether the words that follow a Project name something else.
 *
 * A noun right after the word — or right after its "的" — is a thing of its own: a Project document is a document, and a
 * request for it is not a request for a Project.
 */
function namesSomethingElse(behind: string): boolean {
  const rest = behind.startsWith('的') ? behind.slice(1) : behind
  return PROJECT_CONTENT_NOUN_ZH.some(noun => rest.startsWith(noun))
}

/** Whether the words ask for a Project to be made, in either language. */
function asksForProject(command: string): boolean {
  return asksForProjectInChinese(command) || asksForProjectInEnglish(command)
}

/**
 * The words that say a thing is big, long or hard — and that are no evidence of any of the four conditions.
 *
 * A decision whose evidence is only this has not shown that the work may be split at all: being hard is not being
 * several things.
 */
const COMPLEXITY_MARKERS = ['复杂', '长期', '长时间', '很久', '很多子任务', '子任务多', '规模大', '体量大', '庞大', '巨大',
  '复杂一点', '复杂程度', 'complex', 'complicated', 'long-running', 'long running', 'long-term', 'long term',
  'many subtasks', 'many sub-tasks', 'huge', 'enormous', 'extensive']

/** A text a reader can check: not empty and long enough to say something. */
function isEvidence(value: string): boolean { return value.trim().length >= PROJECT_GATE_MIN_EVIDENCE }

/** A text the decision must carry. */
function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProjectGateError('invalid_decision', `The decision needs a ${name}.`)
  }
  const text = value.trim()
  if (text.length > max) throw new ProjectGateError('invalid_decision', `The ${name} is too long.`)
  return text
}

/** A text the decision must carry as a reason, and that has to be long enough to be one. */
function requiredEvidence(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProjectGateError('missing_evidence', `The decision needs the evidence for ${name}.`)
  }
  const text = value.trim()
  if (text.length > MAX_EVIDENCE) throw new ProjectGateError('invalid_decision', `The evidence for ${name} is too long.`)
  if (!isEvidence(text)) {
    throw new ProjectGateError('missing_evidence', `The evidence for ${name} is too short to check.`)
  }
  return text
}

/**
 * A quote of the person's own request that the decision has to carry.
 *
 * The quote is short on purpose: it is a few words of the request, not a restatement of it, and it is checked against the
 * request itself. A decision that cannot name the words it is about is a decision about something else.
 */
function requiredAnchor(value: unknown, name: string, max: number, floor: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProjectGateError('missing_evidence', `The decision needs ${name}: the words of the person's own request.`)
  }
  const text = value.trim()
  if (text.length > max) throw new ProjectGateError('invalid_decision', `${name} is too long.`)
  if (text.length < Math.max(floor, minTermLength(text))) {
    throw new ProjectGateError('missing_evidence', `${name} is too short to check.`)
  }
  return text
}

/**
 * The shortest stretch of characters that counts as a term.
 *
 * Chinese writes a term in two characters and English in a word of its own, so the bar is two characters there and three
 * here: "首页" is a term, "ho" is not.
 */
function minTermLength(text: string): number {
  return hasChinese(text) ? 2 : 3
}

/**
 * Whether the text holds a Chinese character.
 *
 * The range is the CJK Unified Ideographs block: a Chinese term is written in two characters, and an English one in a
 * word.
 */
function hasChinese(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code >= 0x3400 && code <= 0x9fff) return true
  }
  return false
}

/**
 * The text as the quotes are compared: the same words, without the spaces between them.
 *
 * The whitespace goes and the punctuation stays: a quote that adds or drops a word is not a quote of the request.
 */
function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, '')
}

/**
 * Whether a quote really is a quote of the person's own words.
 *
 * The request itself decides: the quote has to stand inside it, word for word. A paraphrase is not a quote, and a quote
 * of words the person never wrote is not a quote at all.
 */
function quotesRequest(quote: string, text: string): boolean {
  const wanted = normalizeQuote(quote)
  if (wanted === '') return false
  return normalizeQuote(text).includes(wanted)
}

/**
 * The longest stretch of characters two texts share.
 */
function longestCommonRun(first: string, second: string): number {
  let best = 0
  for (let start = 0; start < first.length; start++) {
    for (let other = 0; other < second.length; other++) {
      let run = 0
      while (start + run < first.length && other + run < second.length
        && first[start + run] === second[other + run]) run++
      if (run > best) best = run
    }
  }
  return best
}

/**
 * Whether a module is really about the words it quotes.
 *
 * The anchor says where the module comes from and the module says what it is, so the two have to be about the same thing.
 * A module named "支付网关" that quotes "首页" is not a module of this request, and a decision built on it is a decision
 * about a different piece of work.
 */
function moduleMatchesAnchor(module: ProjectGateModule, anchor: string): boolean {
  const about = `${module.name} ${module.responsibility}`.toLowerCase()
  return longestCommonRun(anchor.toLowerCase(), about) >= minTermLength(anchor)
}

/**
 * The words that ask for something to be made or changed.
 *
 * The list is bounded on purpose: it names the acts that change a thing, and it is used only to tell a request that asks
 * for work apart from one that does not. It proves nothing about the four conditions.
 */
const WORK_WORDS_ZH = [
  '改', '修改', '重写', '重做', '重构', '改造', '优化', '改进', '完善', '补齐', '补上', '实现', '开发', '创建', '新建',
  '建立', '修复', '修好', '搭建', '构建', '生成', '制作', '编写', '撰写', '整理', '梳理', '迁移', '部署', '上线', '接入',
  '集成', '对接', '搞定', '执行', '替换', '换', '统一', '拆分', '提取', '移植', '加上', '增加', '加入', '做完', '做好',
  '编译', '打包', '发布', '排查', '升级', '写入', '同步', '清理', '删除', '写',
]

/** The English words that ask for something to be made or changed. */
const WORK_WORDS_EN = [
  'rewrite', 'rewriting', 'refactor', 'refactoring', 'fix', 'build', 'implement', 'develop', 'create', 'write',
  'migrate', 'deploy', 'test', 'optimize', 'optimise', 'improve', 'finish', 'add', 'generate', 'produce', 'redesign',
  'upgrade', 'integrate', 'prepare', 'ship', 'port', 'clean', 'extract', 'split', 'replace', 'update', 'patch', 'compile',
  'package', 'publish', 'debug', 'wire', 'set up',
]

/**
 * The words that ask to talk about something rather than to do it.
 *
 * They are the words of a conversation, a question or a request for an explanation. Most of them are written as a phrase
 * with the particle that follows the verb, because the bare word is often a name of a thing as well: "聊天功能" is a
 * feature to be changed, "聊个笑话" is a conversation. A request that only carries these asks for no work to be done.
 */
const DISCUSSION_WORDS_ZH = [
  '讨论一下', '讨论下', '讨论讨论', '讨论吧', '聊聊', '聊个', '聊一聊', '说说', '说一下', '说下', '讲讲', '讲一下',
  '讲一讲', '谈谈', '解释一下', '解释下', '解释', '分析一下', '分析下', '分析', '评估一下', '评估下', '评估',
  '评价一下', '评价', '比较一下', '比较', '推荐一下', '推荐', '建议一下', '建议', '介绍一下', '介绍', '科普一下',
  '想想', '想一下', '思考一下', '思考', '探讨一下', '探讨', '复盘一下', '复盘', '回顾一下', '回顾', '总结一下',
  '总结', '解读一下', '解读', '描述一下', '描述', '澄清一下', '澄清', '咨询一下', '咨询', '问一下', '看一下', '看看',
]

/** The English words that ask to talk about something rather than to do it. */
const DISCUSSION_WORDS_EN = [
  'explain', 'discuss', 'chat', 'tell', 'describe', 'compare', 'evaluate', 'analyze', 'analyse', 'review',
  'summarize', 'summarise', 'recommend', 'suggest', 'brainstorm', 'think', 'overview', 'introduce', 'explore',
  'research', 'outline', 'understand', 'opinion',
]

/**
 * The words that end one part of a request and begin another.
 *
 * "讨论一下方案，然后把首页改完" asks for two different things, and the second one is work. A request that only talks
 * about the work has no such a break in it.
 */
const CLAUSE_BREAKS = ['，', ',', '；', ';', '。', '.', '！', '!', '？', '?', '\n', '然后', '接着', '另外', '以及',
  ' and ', ' then ', ' plus ', ' also ', ' after that ']

/** One word of the request that says what the request is about. */
interface RequestMarker {
  /** Where the word stands in the request. */
  index: number
  /** The word itself. */
  word: string
}

/**
 * The earliest of the words of one kind that stands in the request.
 */
function earliestWord(text: string, chinese: readonly string[], english: readonly string[]): RequestMarker | undefined {
  let earliest: RequestMarker | undefined
  for (const word of chinese) {
    const index = text.indexOf(word)
    if (index < 0) continue
    if (earliest === undefined || index < earliest.index) earliest = { index, word }
  }
  for (const word of english) {
    const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi')
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0
      if (earliest === undefined || index < earliest.index) earliest = { index, word }
    }
  }
  return earliest
}

/**
 * Whether the request asks for work to be done.
 *
 * A request that says hello, asks about a plan or asks to talk about the work is not a permission to start a Project:
 * nobody asked for anything to be built. The rule is bounded — the request has to carry a word that asks for work, and it
 * must not be a request that only talks about it — and it says nothing about the four conditions.
 */
export function workAuthorization(text: string): 'ok' | 'no_work_instruction' | 'discussion_only' {
  const command = stripQuoted(text)
  if (command.trim() === '') return 'no_work_instruction'
  const work = earliestWord(command, WORK_WORDS_ZH, WORK_WORDS_EN)
  const talk = earliestWord(command, DISCUSSION_WORDS_ZH, DISCUSSION_WORDS_EN)
  if (talk === undefined) return work === undefined ? 'no_work_instruction' : 'ok'
  if (work === undefined) return 'discussion_only'
  if (work.index < talk.index) return 'ok'
  // The talking word comes first: the request is about talking, unless the work stands in another part of it.
  const between = command.slice(talk.index + talk.word.length, work.index)
  return CLAUSE_BREAKS.some(separator => between.includes(separator)) ? 'ok' : 'discussion_only'
}

/** The modules of a decision, read as they are. */
function readModules(value: unknown): ProjectGateModule[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProjectGateError('not_multiple_modules', 'The decision needs the modules the work is made of.')
  }
  if (value.length > MAX_MODULES) throw new ProjectGateError('invalid_decision', 'The decision names too many modules.')
  return value.map(entry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ProjectGateError('invalid_decision', 'Every module must be an object.')
    }
    const raw = entry as Record<string, unknown>
    if (typeof raw.independent !== 'boolean') {
      throw new ProjectGateError('unknown_condition',
        'Every module needs a yes or a no for whether it may move on its own; "unknown" is not an answer.')
    }
    return {
      name: requiredText(raw.name, 'module name', MAX_TITLE),
      responsibility: requiredText(raw.responsibility, 'module responsibility', MAX_EVIDENCE),
      independent: raw.independent,
      evidence: requiredEvidence(raw.evidence, `the module ${String(raw.name ?? '')}`),
      anchor: requiredAnchor(raw.anchor, `the anchor of the module ${String(raw.name ?? '')}`, MAX_MODULE_ANCHOR, 0),
    }
  })
}

/** The four findings of a decision, read as they are. */
function readConditions(value: unknown): ProjectGateFinding[] {
  if (!Array.isArray(value)) throw new ProjectGateError('invalid_decision', 'The decision needs the four conditions.')
  const findings: ProjectGateFinding[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ProjectGateError('invalid_decision', 'Every condition must be an object.')
    }
    const raw = entry as Record<string, unknown>
    const condition = raw.condition
    if (typeof condition !== 'string' || !PROJECT_GATE_CONDITIONS.includes(condition as ProjectGateCondition)) {
      throw new ProjectGateError('unknown_condition', 'A condition is not one of the four.')
    }
    if (typeof raw.met !== 'boolean') {
      throw new ProjectGateError('unknown_condition', 'A condition needs a yes or a no; "unknown" is not an answer.')
    }
    findings.push({ condition: condition as ProjectGateCondition, met: raw.met,
      evidence: requiredEvidence(raw.evidence, `the condition ${PROJECT_GATE_CONDITION_WORDS[condition as ProjectGateCondition]}`) })
  }
  for (const condition of PROJECT_GATE_CONDITIONS) {
    const found = findings.filter(finding => finding.condition === condition)
    if (found.length === 0) {
      throw new ProjectGateError('missing_condition', `The decision is missing the condition ${PROJECT_GATE_CONDITION_WORDS[condition]}.`)
    }
    if (found.length > 1) {
      throw new ProjectGateError('unknown_condition', `The decision answers the condition ${PROJECT_GATE_CONDITION_WORDS[condition]} twice.`)
    }
  }
  return findings
}

/**
 * Read the decision a model proposed.
 *
 * The reading is strict on purpose: a condition that is not one of the four, an answer that is not a yes or a no, a
 * missing condition and an evidence too short to check are all decisions the gate cannot judge, and a decision it cannot
 * judge never becomes a Project.
 */
export function readProjectGateDecision(input: unknown): ProjectGateDecision {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProjectGateError('invalid_decision', 'The decision must be an object.')
  }
  const raw = input as Record<string, unknown>
  return {
    title: requiredText(raw.title, 'title', MAX_TITLE),
    goal: requiredText(raw.goal, 'goal', MAX_GOAL),
    requestAnchor: requiredAnchor(raw.requestAnchor, 'the request anchor', MAX_REQUEST_ANCHOR, MIN_REQUEST_ANCHOR),
    modules: readModules(raw.modules),
    conditions: readConditions(raw.conditions),
  }
}

/**
 * Whether the person's own words ask for a Project.
 *
 * This is the control plane's own reading, not the model's: a model that says the person asked for a Project is believed
 * only when the person's words really say so. A request that negates the creation, a request that asks and a request whose
 * only words are inside a quotation are all no request for a Project.
 */
export function explicitProjectRequest(text: string): boolean {
  const command = stripQuoted(text).trim()
  if (command === '') return false
  if (isQuestion(command)) return false
  if (negatesTheCreation(command)) return false
  return asksForProject(command)
}

/**
 * Whether the words that ask for a Project are themselves negated.
 *
 * "不要创建项目" negates the creation and is no request for a Project; "创建一个项目，不要动别的" negates something else
 * and is one. A negation that stands in front of the act is the one that matters here.
 */
function negatesTheCreation(command: string): boolean {
  for (const word of NEGATION_ZH) {
    let index = command.indexOf(word)
    while (index >= 0) {
      const after = command.slice(index + word.length, index + word.length + NEGATION_WINDOW)
      if (PROJECT_CREATION_ZH.some(verb => after.includes(verb))) return true
      index = command.indexOf(word, index + 1)
    }
  }
  const pattern = new RegExp(`\\b(?:${NEGATION_EN.map(escapeRegExp).join('|')})\\b`, 'gi')
  for (const match of command.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].length
    const after = command.slice(start, start + NEGATION_WINDOW)
    if (PROJECT_CREATION_EN.some(verb => new RegExp(`\\b${escapeRegExp(verb)}\\b`, 'i').test(after))) return true
  }
  return false
}

/** How far a negation may stand from the act it negates. */
const NEGATION_WINDOW = 8

/** The English words that ask for something to be made. */
const PROJECT_CREATION_EN = ['create', 'new', 'make', 'start', 'set up', 'open']

/**
 * Why a request may not lead to a Project the control plane decided on itself.
 *
 * A request that negates, a request that asks and a request whose command is quoted content are all refused here: the
 * words of a person are what may start a Project, and a quoted command is a thing somebody said, not an order.
 */
export function projectRequestRefusal(text: string): { reason: string; detail: string } | undefined {
  const command = stripQuoted(text).trim()
  if (command === '') {
    return { reason: 'quoted_command', detail: '这条消息只有引文里的内容，没有本人的指令，不会自动建项目。' }
  }
  if (hasNegation(command)) {
    return { reason: 'request_negated', detail: '本人的请求里有否定或取消，不会自动建项目。' }
  }
  if (isQuestion(command)) {
    return { reason: 'request_question', detail: '本人的请求是一句提问，不是要建项目的指令，不会自动建项目。' }
  }
  for (const quoted of quotedTexts(text)) {
    if (asksForProject(quoted)) {
      return { reason: 'quoted_command', detail: '引文里有一个建项目的说法；那是引用的内容，不是本人的指令，不会自动建项目。' }
    }
  }
  return undefined
}

/**
 * The Project a request names outright, when it names one.
 *
 * A Project is named by its exact id or by its full title inside quotes — the same anchoring the Fast Router uses. A title
 * that is only part of a longer word, a title that is only talked about and a Project this control plane does not hold are
 * all no Project at all, and a similar title is not a hit either: it is only an ambiguity to explain.
 */
export function namedProject(text: string, projects: readonly ProjectGateProject[]): ProjectGateProject | undefined {
  const quoted = quotedTexts(text).map(part => part.trim())
  for (const project of projects) {
    if (project.id !== '' && holdsWholeId(text, project.id)) return project
    if (project.title !== '' && quoted.includes(project.title.trim())) return project
  }
  return undefined
}

/**
 * Whether the text holds the id as a whole word.
 *
 * An id that stands inside a longer word is another id: a rule that read it as this one would address a Project that was
 * never named.
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

/**
 * Whether an evidence says only that the work is big, long or hard.
 *
 * Such an evidence names no module, and the four conditions are about modules: a decision that rests on being hard is a
 * decision that has not shown the work may be split at all.
 */
function complexityOnly(evidence: string, modules: readonly ProjectGateModule[]): boolean {
  const text = evidence.toLowerCase()
  if (!COMPLEXITY_MARKERS.some(marker => text.includes(marker.toLowerCase()))) return false
  return !modules.some(module => module.name.trim() !== '' && text.includes(module.name.trim().toLowerCase()))
}

/** A verdict that refuses, with the reason and the four findings as they were read. */
function refuse(reason: string, detail: string, decision: ProjectGateDecision,
  failedCondition?: ProjectGateCondition, existingProject?: { id: string; title: string }): ProjectGateVerdict {
  return { allowed: false, reason, detail, conditions: decision.conditions, modules: decision.modules,
    ...(failedCondition === undefined ? {} : { failedCondition }),
    ...(existingProject === undefined ? {} : { existingProject }) }
}

/**
 * The verdict of the gate on one decision.
 *
 * The decision is judged, never trusted: the four conditions have to hold, each on its own evidence, and the evidence has
 * to be about the modules the decision names. The request itself is judged too — a person who negated, who asked or who
 * only quoted a command did not ask for a Project, and a person who only chatted or asked about a plan did not ask for
 * work — and a request that names a Project that already exists is a request about that Project, not about a second one.
 *
 * The decision also has to touch the request itself: the anchor is a quote of the person's own words, and every module
 * is about a quote of its own. A decision whose modules cannot be found in the request is a decision about some other
 * work, however true its four findings are.
 */
export function evaluateProjectGate(decision: ProjectGateDecision, facts: ProjectGateFacts): ProjectGateVerdict {
  const refusal = projectRequestRefusal(facts.text)
  if (refusal !== undefined) return refuse(refusal.reason, refusal.detail, decision)
  const existing = namedProject(facts.text, facts.projects)
  if (existing !== undefined) {
    return refuse('existing_project', `这条请求已经点名了项目「${existing.title}」，不会再建一个重复的项目。`, decision,
      undefined, { id: existing.id, title: existing.title })
  }
  const proposedTitle = decision.title.normalize('NFKC').trim().toLowerCase()
  const sameTitle = facts.projects.find(project => project.title.normalize('NFKC').trim().toLowerCase() === proposedTitle)
  if (sameTitle !== undefined) {
    return refuse('existing_project', `项目「${sameTitle.title}」已存在，请先确认是否沿用。`, decision,
      undefined, { id: sameTitle.id, title: sameTitle.title })
  }
  // The request has to ask for work. A chat and a request to talk about the work are not a permission to build anything.
  const work = workAuthorization(facts.text)
  if (work === 'no_work_instruction') {
    return refuse('no_work_instruction', '本人的请求没有要求开展这项工作，不会自动建项目。', decision)
  }
  if (work === 'discussion_only') {
    return refuse('discussion_only', '本人的请求只要求讨论或解释，没有要求动手做，不会自动建项目。', decision)
  }
  if (decision.modules.length < 2) {
    return refuse('not_multiple_modules', '这项工作不是一个能拆开的模块集合，不会自动建项目。', decision,
      'multiple_independent_modules')
  }
  // The decision has to be about the person's own words: the anchor is a quote of the request, and every module is about
  // a quote of its own. A module that cannot be found in the request is a module the model made up.
  if (!quotesRequest(decision.requestAnchor, facts.text)) {
    return refuse('anchor_not_in_request',
      '判定里的 requestAnchor 在本人的请求里找不到；它必须是请求里逐字出现的一段话，不会自动建项目。', decision)
  }
  const anchors = new Set<string>()
  for (const module of decision.modules) {
    if (!quotesRequest(module.anchor, facts.text)) {
      return refuse('module_anchor_not_in_request',
        `模块「${module.name}」的 anchor 在本人的请求里找不到；它必须是请求里逐字出现的一段话，不会自动建项目。`, decision,
        'multiple_independent_modules')
    }
    const quoted = normalizeQuote(module.anchor)
    if (anchors.has(quoted)) {
      return refuse('module_anchor_duplicated',
        `模块「${module.name}」和另一个模块引用了同一句本人原话，不算两个相对独立的模块，不会自动建项目。`, decision,
        'multiple_independent_modules')
    }
    anchors.add(quoted)
    if (!moduleMatchesAnchor(module, module.anchor)) {
      return refuse('module_not_grounded',
        `模块「${module.name}」和它引用的本人原话不是同一件事，不会自动建项目。`, decision, 'multiple_independent_modules')
    }
  }
  const responsibilities = new Set<string>()
  for (const module of decision.modules) {
    const responsibility = module.responsibility.trim()
    if (responsibilities.has(responsibility)) {
      return refuse('module_responsibility_duplicated',
        `模块「${module.name}」和另一个模块的责任相同，不算两个相对独立的模块，不会自动建项目。`, decision,
        'multiple_independent_modules')
    }
    responsibilities.add(responsibility)
    if (!module.independent) {
      return refuse('module_not_independent',
        `模块「${module.name}」不能独立推进，不会自动建项目。`, decision, 'reasonable_decoupling')
    }
  }
  for (const finding of decision.conditions) {
    if (!isEvidence(finding.evidence)) {
      return refuse('missing_evidence',
        `条件「${PROJECT_GATE_CONDITION_WORDS[finding.condition]}」没有给出可核对的理由，不会自动建项目。`, decision,
        finding.condition)
    }
  }
  const unmet = decision.conditions.find(finding => !finding.met)
  if (unmet !== undefined) {
    return refuse('condition_not_met',
      `条件「${PROJECT_GATE_CONDITION_WORDS[unmet.condition]}」不成立，不会自动建项目。`, decision, unmet.condition)
  }
  for (const finding of decision.conditions) {
    if (complexityOnly(finding.evidence, decision.modules)) {
      return refuse('complexity_is_not_evidence',
        `条件「${PROJECT_GATE_CONDITION_WORDS[finding.condition]}」的理由只是说事情复杂或耗时，不能代替模块之间的独立性，不会自动建项目。`,
        decision, finding.condition)
    }
  }
  return { allowed: true, reason: 'allowed', detail: '四项条件都成立，每项都有可核对的理由。',
    conditions: decision.conditions, modules: decision.modules }
}
