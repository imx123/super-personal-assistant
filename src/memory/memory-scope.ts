/**
 * The scope of a memory, the authority over it, and the validation of the sources it names.
 *
 * This module is the one place that knows what a scope is, who may read and write inside it, and what a source
 * reference has to point at before the control plane believes it. It is deliberately small and deliberately free of
 * SQLite: the service that stores memories and the retriever that will search them (`P5-5`) both ask these questions
 * here, so the two can never answer them differently.
 *
 * **A scope says where a fact belongs, not who said it.** A fact about one machine is a `node_env` fact even when a
 * person wrote it, and a fact about one project is a `project` fact even when the person who wrote it works on another
 * one. The scope is bound by the thing the fact is about, so the same fact cannot be filed twice under two owners.
 *
 * **The authority over a scope never comes from the request.** A caller is described by the Session it proved — the
 * role it has, the node it runs on, the Project it was really delegated — and the scopes that follow from that are
 * computed here. A body that names a role, a node, a Project or a trust tag changes nothing: the caller that the
 * control plane authenticated is the only caller there is.
 *
 * **The trust of a fact is derived from its sources, never declared.** A person who speaks for themselves is
 * `operator_explicit`. A conclusion the control plane confirmed — an accepted review, a finished Assignment, a Ticket
 * that ended — is `verified_execution`. Everything else, including anything that came from outside, is
 * `external_tainted`, and a tainted fact stays tainted all the way to the end: it may never be promoted into the
 * global scope, and it carries its warning with it wherever it is read.
 */
import { createHash } from 'node:crypto'
import { stripQuoted } from '../control/fast-router.ts'
import { redact } from '../infra/redact.ts'

/** Where a fact belongs. `ticket` is deliberately not one of them: a Ticket's own detail is not a memory. */
export type MemoryScopeType = 'user_global' | 'node_env' | 'project'

/** How much the control plane believes the source of a fact. */
export type SourceTrust = 'operator_explicit' | 'verified_execution' | 'external_tainted'

/** The kinds of record a source reference may name. */
export type SourceRefKind =
  | 'ticket'
  | 'assignment'
  | 'review'
  | 'delivery'
  | 'audit'
  | 'console_note'
  | 'operator_message'
  | 'external_event'

/** The kinds of record a source reference may name, in the order of the contract. */
export const SOURCE_REF_KINDS: readonly SourceRefKind[] = [
  'ticket', 'assignment', 'review', 'delivery', 'audit', 'console_note', 'operator_message', 'external_event',
]

/** The kind a name stands for, when it names one. */
export function sourceRefKindOf(value: string): SourceRefKind | undefined {
  return (SOURCE_REF_KINDS as readonly string[]).includes(value) ? value as SourceRefKind : undefined
}

/** One scope: the kind of owner and the id of that owner. */
export interface MemoryScope {
  readonly scopeType: MemoryScopeType
  readonly scopeId: string
}

/** The scope of a fact that belongs to the person, and to nobody's machine or project. */
export const USER_GLOBAL: MemoryScope = { scopeType: 'user_global', scopeId: 'global' }

/** The scope of a fact about one machine. */
export function nodeScope(nodeId: string): MemoryScope {
  return { scopeType: 'node_env', scopeId: `node:${nodeId}` }
}

/** The scope of a fact about one project. */
export function projectScope(projectId: string): MemoryScope {
  return { scopeType: 'project', scopeId: `project:${projectId}` }
}

/**
 * The scope a pair of parts names, or nothing when the pair is not a scope at all.
 *
 * A `ticket` scope is refused here rather than later: the long-term memory never holds a Ticket's own detail, and the
 * only two shapes a Ticket takes are a scope key of the event history and one source reference of a candidate.
 */
export function scopeOf(scopeType: string, scopeId: string): MemoryScope | undefined {
  if (scopeType === 'user_global') return scopeId === '' ? undefined : USER_GLOBAL
  if (scopeType === 'node_env') return scopeId === '' ? undefined : { scopeType, scopeId }
  if (scopeType === 'project') return scopeId === '' ? undefined : { scopeType, scopeId }
  return undefined
}

/** The key a scope is written under: the kind and the id, so two kinds never collide on one id. */
export function scopeKey(scope: MemoryScope): string {
  return `${scope.scopeType}:${scope.scopeId}`
}

/** The Project a scope names, when it names one. */
export function projectIdOf(scope: MemoryScope): string {
  return scope.scopeType === 'project' ? scope.scopeId.replace(/^project:/, '') : ''
}

/** The machine a scope names, when it names one. */
export function nodeIdOf(scope: MemoryScope): string {
  return scope.scopeType === 'node_env' ? scope.scopeId.replace(/^node:/, '') : ''
}

/**
 * Who acts.
 *
 * The operator is a person at the console, the three roles are Sessions of this control plane, and the manager is the
 * limited system role of `P5-4` — it exists here so that the transitions it will use are the same ones, and it grants
 * nothing that a Session record could not grant it.
 */
export type MemoryRole = 'operator' | 'router' | 'pm' | 'worker' | 'manager'

/**
 * The caller, as the control plane authenticated it.
 *
 * Every field is a fact about the caller that the control plane holds itself: the Session's own record and the work it
 * owns. Nothing here comes from a request body.
 */
export interface MemoryCaller {
  readonly role: MemoryRole
  /** The Session that acts; empty for the operator, who acts as a person and not as a Session. */
  readonly sessionId: string
  /** The node this Session runs on; empty for the operator. */
  readonly nodeId: string
  /** The Project this Session really owns; empty when it owns none. */
  readonly projectId?: string
  /** The Ticket this Session works on; empty when it works on none. */
  readonly ticketId?: string
}

/** The scopes one caller may read. */
export interface MemoryScopeSet {
  /** Whether the caller may read every scope of this control plane. */
  readonly all: boolean
  /** The scopes the caller owns outright, when it does not own every one. */
  readonly scopes: readonly MemoryScope[]
}

/**
 * The scopes one caller may read.
 *
 * The operator reads everything this control plane holds. The Router manages the pool of this control plane, so it
 * reads every scope of it. A PM reads the global scope, the node it is bound to and its own Project. A Worker reads
 * the global scope, its node and the Project of the Ticket it works on — the same three, restricted further by the
 * work it holds.
 */
export function allowedScopes(caller: MemoryCaller): MemoryScopeSet {
  if (caller.role === 'operator' || caller.role === 'router' || caller.role === 'manager') {
    return { all: true, scopes: [] }
  }
  const scopes: MemoryScope[] = [USER_GLOBAL]
  if (caller.nodeId !== '') scopes.push(nodeScope(caller.nodeId))
  if (caller.projectId !== undefined && caller.projectId !== '') scopes.push(projectScope(caller.projectId))
  return { all: false, scopes }
}

/** What one caller may propose. */
export interface MemoryProposalAuthority {
  /** Whether the caller may propose a fact for any scope that exists. */
  readonly anyScope: boolean
  /** The scopes the caller may propose a fact in, when it may not use any. */
  readonly scopes: readonly MemoryScope[]
  /** Whether the caller may propose a fact for the global scope at all. */
  readonly globalAllowed: boolean
  /**
   * Whether a proposal for the global scope waits for a person before it may be used.
   *
   * It is true for everybody. There is no path that makes a global fact effective without a decision about it.
   */
  readonly globalNeedsHuman: boolean
}

/**
 * What one caller may propose.
 *
 * The operator and the Router may propose for any scope this control plane knows. A PM may propose for the global
 * scope, for its own node and for its own Project — a proposal for the global scope waits for a person. A Worker may
 * propose for its own node and its own Project only: a Worker has no business stating a preference of the person's.
 */
export function proposalAuthority(caller: MemoryCaller): MemoryProposalAuthority {
  if (caller.role === 'operator') {
    return { anyScope: true, scopes: [], globalAllowed: true, globalNeedsHuman: true }
  }
  if (caller.role === 'router') {
    return { anyScope: true, scopes: [], globalAllowed: true, globalNeedsHuman: true }
  }
  if (caller.role === 'manager') {
    // The manager reviews and never proposes: it holds no opinion of its own about what is worth remembering.
    return { anyScope: false, scopes: [], globalAllowed: false, globalNeedsHuman: true }
  }
  const scopes: MemoryScope[] = []
  if (caller.nodeId !== '') scopes.push(nodeScope(caller.nodeId))
  if (caller.projectId !== undefined && caller.projectId !== '') scopes.push(projectScope(caller.projectId))
  return {
    anyScope: false,
    scopes,
    globalAllowed: caller.role === 'pm',
    globalNeedsHuman: true,
  }
}

/** Whether one caller may propose a fact in one scope. */
export function mayPropose(authority: MemoryProposalAuthority, scope: MemoryScope): boolean {
  if (scope.scopeType === 'user_global') return authority.globalAllowed
  if (authority.anyScope) return true
  return authority.scopes.some(own => own.scopeType === scope.scopeType && own.scopeId === scope.scopeId)
}

/**
 * Whether a record the control plane holds belongs to the work of this caller.
 *
 * The operator and the Router manage this whole control plane, so every record here is theirs. A PM and a Worker own one
 * piece of work: the Project they were delegated and the machine they run on. A record of another Project or of another
 * machine is not theirs, and a fact may not lean on it — a conclusion about another project's work is not a conclusion
 * about this one, however true it is.
 *
 * The rule is about the record, not about the words around it: a reference that names a record of another Project is
 * refused, and a reference that names no record at all is left to the trust that already follows it.
 */
export function recordWithinCaller(record: MemorySourceRecord, caller: MemoryCaller): boolean {
  if (caller.role === 'operator' || caller.role === 'router' || caller.role === 'manager') return true
  if (record.projectId !== undefined && record.projectId !== '' && caller.projectId !== undefined
    && caller.projectId !== '' && record.projectId !== caller.projectId) {
    return false
  }
  if (record.nodeId !== undefined && record.nodeId !== '' && caller.nodeId !== '' && record.nodeId !== caller.nodeId) {
    return false
  }
  return true
}

/**
 * Whether one caller may see the row of one candidate.
 *
 * The operator reads the whole queue, and the memory manager reads it because it reviews it. A Session reads the row of
 * the proposal it made itself and nothing else: another Session's proposal is not shown to it, and neither is its
 * checksum, its sources or its note. A proposal that is already in the queue is therefore answered to a stranger
 * without the row — the fact that it is there, and nothing about who proposed it or what it carries.
 */
export function maySeeCandidate(caller: MemoryCaller, proposedBySessionId: string): boolean {
  if (caller.role === 'operator' || caller.role === 'manager') return true
  return caller.sessionId !== '' && caller.sessionId === proposedBySessionId
}

/**
 * The source references of one row, read back as the objects they were written as.
 *
 * A row that holds something else — a body that was cut short, a column that was never filled — has no references
 * rather than broken ones: a reader that cannot make sense of the column is told nothing, not half of something.
 */
export function parseSourceRefs(value: string): readonly MemorySourceRef[] {
  if (value === '') return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is MemorySourceRef =>
      entry !== null && typeof entry === 'object' && typeof (entry as MemorySourceRef).kind === 'string'
      && typeof (entry as MemorySourceRef).id === 'string')
  } catch {
    return []
  }
}

/** One source reference as a caller offers it. */
export interface SourceRefInput {
  readonly kind: SourceRefKind
  /** The stable id of the record, in the control plane's own tables. */
  readonly id: string
  /** When the record happened, when the caller knows it. */
  readonly at?: string
  /** One redacted line about the record. It never carries the record's own text. */
  readonly summary?: string
}

/** One source reference as it is stored and read back. */
export interface MemorySourceRef {
  readonly kind: SourceRefKind
  readonly id: string
  /** When the record happened; empty when the control plane could not find the record to say when. */
  readonly at: string
  /** One redacted line about the record, at most 200 characters. */
  readonly summary: string
  /** Whether the control plane really holds the record this reference names. */
  readonly verified: boolean
}

/** What the control plane really holds about the record a source reference names. */
export interface MemorySourceRecord {
  /** When the record happened, in the control plane's own clock. */
  readonly at: string
  /**
   * Whether the record is a conclusion the control plane confirmed: an accepted review, a finished Assignment, a Ticket
   * that ended. Only such a record may carry a fact as `verified_execution`.
   */
  readonly authoritative: boolean
  /** Whether the record came from outside the control plane's own verified facts. */
  readonly tainted: boolean
  /** The Project the record belongs to, when it has one. */
  readonly projectId?: string
  /** The machine the record was made on, when it has one. */
  readonly nodeId?: string
  /**
   * The person's own words, when the record is a message the person wrote directly.
   *
   * It is here for one check only: a fact that claims to be the person's own words has to be found in them. The words are
   * never written into the memory table — only the id of the message and a redacted line about it are.
   */
  readonly text?: string
}

/** How the control plane is asked about a record a source reference names. */
export type SourceResolver = (kind: SourceRefKind, id: string) => MemorySourceRecord | undefined

/** The most characters one source summary may hold. */
export const SOURCE_SUMMARY_LIMIT = 200

/** The most characters one source reference id may hold. */
export const SOURCE_ID_LIMIT = 128

/** The sources of one fact, and the trust they add up to. */
export interface ValidatedSources {
  /** The references as they are stored. */
  readonly refs: readonly MemorySourceRef[]
  /** The trust the sources add up to. */
  readonly trust: SourceTrust
  /** Whether the fact is the person's own words. */
  readonly operatorSpoken: boolean
}

/**
 * The sources of one fact, checked against the records the control plane really holds.
 *
 * A reference that names a record the control plane does not hold does not disappear: it stays, marked unverified, and
 * the fact it belongs to loses its trust. A fact whose sources could not be checked is `external_tainted`, and so is a
 * fact whose sources were checked and turned out to be nothing more than an observation.
 *
 * The person's own words are `operator_explicit` whoever carries them: the operator at the console, or a Session that
 * quotes a message the person wrote and that the control plane still holds.
 */
export function validateSourceRefs(inputs: readonly SourceRefInput[], resolve: SourceResolver,
  options: { readonly operator: boolean; readonly scope?: MemoryScope; readonly content?: string }): ValidatedSources {
  const refs: MemorySourceRef[] = []
  let tainted = false
  let authoritative = false
  let operatorMessage = false
  for (const input of inputs) {
    const record = resolve(input.kind, input.id)
    if (record === undefined) {
      // The control plane does not hold the record, so the reference is not a fact about anything: it stays, marked
      // unverified, and the moment the caller claimed for it is not kept either — a claimed time is not the control
      // plane's clock. The id is bounded and stripped of what is not part of an id, so a path or a token that a caller
      // put there is not written into the table as if it were a record.
      tainted = true
      refs.push({ kind: input.kind, id: boundedSourceId(input.id), at: '', summary: boundedSummary(input.summary),
        verified: false })
      continue
    }
    if (record.tainted) tainted = true
    if (record.authoritative) authoritative = true
    if (input.kind === 'operator_message') operatorMessage = true
    // The words of a fact that claims to be the person's own must be found in the person's own message. A fact that is
    // not there may come from a quotation, from an attachment or from a paraphrase of somebody else's words, and then it
    // is not the person's own words: it loses the trust of them and stays untrusted all the way down.
    if (input.kind === 'operator_message' && options.content !== undefined && record.text !== undefined
      && !groundedInMessage(options.content, record.text)) {
      tainted = true
    }
    // A record belongs to the Project or the machine it was made in: a fact about another one may not lean on it, or it
    // would be about something else than the record it names says.
    if (belongsToAnotherScope(record, options.scope)) tainted = true
    // A console note belongs to one project: it says nothing about another one, and a fact that leans on it may not
    // travel out of the project it was written in.
    if (input.kind === 'console_note' && options.scope !== undefined && record.projectId !== undefined
      && projectIdOf(options.scope) !== record.projectId) {
      tainted = true
    }
    refs.push({ kind: input.kind, id: input.id, at: record.at, summary: boundedSummary(input.summary), verified: true })
  }
  const spoken = options.operator || operatorMessage
  // A fact that leans on something the control plane could not check is tainted whoever proposed it: the person's own
  // words are what they are, but a claim they cannot back does not become a verified conclusion by being theirs.
  const trust: SourceTrust = tainted ? 'external_tainted'
    : spoken ? 'operator_explicit'
      : authoritative ? 'verified_execution'
        : 'external_tainted'
  return { refs, trust, operatorSpoken: spoken }
}

/**
 * Whether the words of a fact are the words of the person.
 *
 * The words have to be found in the message the person wrote, and they have to be found outside every quotation: a person
 * who quotes somebody else did not say those words themselves. Everything else — an attachment, an observation from
 * outside, the model's own paraphrase — is not in the message at all and is therefore not the person's words either.
 *
 * The comparison is the same one the fingerprint uses: NFKC, folded blanks, trimmed and lower-cased, so that the same
 * words in the same order are the same words however they were spaced or cased.
 */
export function groundedInMessage(content: string, message: string): boolean {
  const needle = normalizeMemoryText(content)
  if (needle === '') return false
  if (!normalizeMemoryText(message).includes(needle)) return false
  // The quoted spans are taken out of the message first: what is left is what the person wrote with their own voice.
  return normalizeMemoryText(stripQuoted(message)).includes(needle)
}

/**
 * Whether a record belongs to another scope than the fact that leans on it.
 *
 * The record the control plane holds names the Project or the machine it was made in. A fact about one Project may not
 * lean on another Project's record, and a fact about one machine may not lean on another machine's record: it would
 * then say something the record does not say. A fact about the person, and a fact about a scope the record does not
 * name, are left alone — the record says nothing about them either way.
 */
function belongsToAnotherScope(record: MemorySourceRecord, scope: MemoryScope | undefined): boolean {
  if (scope === undefined) return false
  if (record.projectId !== undefined && scope.scopeType === 'project'
    && projectIdOf(scope) !== record.projectId) {
    return true
  }
  if (record.nodeId !== undefined && scope.scopeType === 'node_env' && nodeIdOf(scope) !== record.nodeId) return true
  return false
}

/**
 * One source reference id, as it is stored.
 *
 * An id the control plane could not check came from the caller, so it may be anything at all: a path, a token, a
 * sentence. It is redacted, stripped of everything that is not part of an id and bounded, so a memory never keeps the
 * caller's own text as if it were the name of a record. The reference stays marked unverified either way: the fact
 * that leans on it is not believed because of how its id reads.
 */
export function boundedSourceId(id: string): string {
  const cleaned = redact(id).replace(/[^A-Za-z0-9._:@-]+/g, '_')
  return cleaned.slice(0, SOURCE_ID_LIMIT)
}

/** One source summary, redacted and bounded. */
export function boundedSummary(summary: string | undefined): string {
  if (summary === undefined) return ''
  return redact(summary).slice(0, SOURCE_SUMMARY_LIMIT)
}

/**
 * The normalized form of a body: the same words in the same order, however they were spaced or cased.
 *
 * Two people who write the same preference differently are the same preference, and the memory of it is one row.
 */
export function normalizeMemoryText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * The fingerprint of a body inside a scope.
 *
 * The scope is part of the fingerprint: the same words about one machine and about one project are two facts, and only
 * the scope decides which one a duplicate is.
 */
export function contentFingerprint(content: string, scope: MemoryScope): string {
  return createHash('sha256')
    .update(`${normalizeMemoryText(content)} ${scope.scopeType} ${scope.scopeId}`)
    .digest('hex').slice(0, 32)
}

/**
 * The idempotency key of one candidate.
 *
 * It is built from the sources that carried the fact, the fingerprint of its body and the scope it was proposed for: the
 * same proposal, offered again by a retry or after a restart, has the same key and is one row.
 */
export function candidateIdempotencyKey(refs: readonly MemorySourceRef[], fingerprint: string,
  proposed: MemoryScope): string {
  const keys = refs.map(ref => `${ref.kind}:${ref.id}`).sort().join(',')
  return createHash('sha256')
    .update(`${keys} ${fingerprint} ${proposed.scopeType} ${proposed.scopeId}`)
    .digest('hex').slice(0, 32)
}

/** A Windows drive path or a UNC share. */
const WINDOWS_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?:[^\s\\/:*?"<>|']+[\\/])*[^\s\\/:*?"<>|']*|\\\\[^\s\\/']+[\\/][^\s\\/']+/g
/** An absolute POSIX path. */
const POSIX_PATH = /(?<![\w.~:/\\-])\/(?:[A-Za-z0-9._@%+~-]+\/)+[A-Za-z0-9._@%+~-]*/g
/** A credential written as a field: `api_key=…`, `api key: …`, `token: "…"`, `password=…`. */
const SECRET_FIELD = /(?<![A-Za-z0-9_-])((?:x-)?(?:api[-_\s]?key|access[-_\s]?token|refresh[-_\s]?token|id[-_\s]?token|auth[-_\s]?token|token|secret|client[-_\s]?secret|app[-_\s]?secret|password|passwd|pwd|private[-_]?key|verification[-_\s]?token|encrypt[-_]?key))("?\s*[:=]\s*|%3D)("[^"]*"|'[^']*'|[^\s,;&"'<>)\][{]+)/gi
/** An authorization header, which carries a credential in whatever follows it. */
const AUTHORIZATION = /(?<![A-Za-z0-9_-])((?:proxy-|x-)?authorization)"?\s*[:=]\s*([^\r\n]*)/gi
/** A token of a known format, which is a secret wherever it appears. */
const KNOWN_SECRET = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g

/**
 * Whether a value that follows a credential-shaped name is a credential.
 *
 * The name alone is not enough: a memory may well say that a token is rotated every month. A value that is quoted, that
 * carries a digit, that is long, or that was written after an `=` is a value nobody meant as prose.
 */
function isCredentialValue(separator: string, value: string): boolean {
  if (separator.includes('=') || separator.includes('%3D')) return true
  if (/^["']/.test(value) && /["']$/.test(value)) return true
  const text = value.replace(/^["']|["']$/g, '')
  return /\d/.test(text) || text.length >= 12
}

/** Whether a body names a place on a machine. */
export function containsAbsolutePath(text: string): boolean {
  WINDOWS_PATH.lastIndex = 0
  POSIX_PATH.lastIndex = 0
  return WINDOWS_PATH.test(text) || POSIX_PATH.test(text)
}

/** Whether a body carries a credential. */
export function containsSecret(text: string): boolean {
  KNOWN_SECRET.lastIndex = 0
  if (KNOWN_SECRET.test(text)) return true
  SECRET_FIELD.lastIndex = 0
  for (const match of text.matchAll(SECRET_FIELD)) {
    const separator = match[2] ?? ''
    const value = match[3] ?? ''
    if (isCredentialValue(separator, value)) return true
  }
  AUTHORIZATION.lastIndex = 0
  for (const match of text.matchAll(AUTHORIZATION)) {
    const separator = match[2] ?? ''
    const value = match[3] ?? ''
    if (isCredentialValue(separator, value)) return true
  }
  return false
}
