/**
 * The node's read-only Git review of one Project's workspace: a bounded diff and a whitespace check.
 *
 * The reader is deliberately narrow. It runs a fixed set of Git commands with a fixed argument list, without a shell and
 * without a single argument a caller could choose: the only thing it takes from the caller is the workspace directory the
 * node itself bound to the Project. Everything else — the baseline, the paths, the diff — comes from Git.
 *
 * The boundary it enforces is the Project's own repository: the workspace must be the root of a Git repository of its own,
 * and its real path must stay inside the node root. A workspace that merely sits inside some parent repository is refused
 * rather than read, so a review can never climb out of the Project it was asked about.
 *
 * Git itself is the other half of the boundary. A repository carries its own configuration, and that configuration can
 * name a program to run and a path to read: a file system monitor, an external diff program, a text conversion filter, a
 * credential helper, an included configuration file. The review therefore runs one fixed Git program — found once, by its
 * absolute path, so a workspace cannot put its own `git` in front of the real one — switches the file system monitor and
 * the pager off, refuses an external diff program and a text conversion filter, and reads the repository's own
 * configuration file itself: a configuration that names a program or a path outside the Project is refused, not obeyed.
 *
 * The commands are read-only by construction: `diff` and `ls-files` never write, `GIT_OPTIONAL_LOCKS=0` keeps it from
 * refreshing the index behind the Worker's back, and the repository's Git directory, its object store and its work tree
 * must be its own — a linked worktree, a borrowed object store or a Git directory that points elsewhere is refused.
 */
import { execFile } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ReviewDiffResult } from '../shared/protocol.ts'

/** The largest diff text one review returns, in bytes. */
export const MAX_REVIEW_DIFF_BYTES = 64 * 1024

/**
 * How long a whole review may run.
 *
 * The bound covers every Git command of one review, not each of them, so a review always answers inside the window the
 * control plane waits for the node's answer. It stays below the control plane's own command timeout (ten seconds), so the
 * node answers before the transport would give up on it.
 */
export const REVIEW_GIT_TIMEOUT_MS = 8_000

/** How many file names one review reports. */
export const MAX_REVIEW_FILES = 100

/** How many whitespace findings one review reports. */
export const MAX_REVIEW_WHITESPACE = 50

/** How many untracked file names one review reports. */
export const MAX_REVIEW_UNTRACKED = 100

/**
 * The Git options every diff of a review uses.
 *
 * `--no-ext-diff` refuses an external diff program, `--no-textconv` refuses a text conversion filter, and `--no-color`
 * keeps the output plain text a model can read.
 */
const DIFF_OPTIONS = ['--no-ext-diff', '--no-textconv', '--no-color'] as const

/**
 * The configuration every Git command of a review runs with.
 *
 * These options outrank every configuration file Git reads, the repository's own included: `core.fsmonitor=false` switches
 * the file system monitor off (a repository that names a monitor program would otherwise have that program run by Git,
 * and the repository chooses the program, not this node), and `core.pager=cat` keeps the pager inert. The commands also
 * run with `--no-pager`, and nothing else of the repository's configuration is allowed to name a program.
 */
const GIT_OPTIONS = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'] as const

/**
 * The configuration keys a review refuses to run with, and what each of them means.
 *
 * Every one of them names a program the review's own commands would run, or a path those commands would read from
 * outside the Project: a file system monitor, an external diff program, a text conversion filter, a credential helper, an
 * included configuration file. The review's commands never need any of them, so a repository that carries one is refused
 * rather than read with it. The names are lowercased and section-qualified, the way Git itself writes them.
 *
 * A setting the review's commands never reach — a remote, a branch, a submodule, the user identity, an editor used by a
 * commit — cannot change what the read does or what it reads, and is left alone.
 */
const REFUSED_CONFIG_KEYS: Readonly<Record<string, string>> = {
  'core.attributesfile': 'a global attributes file (core.attributesFile)',
  'core.excludesfile': 'a global excludes file (core.excludesFile)',
  'core.hookspath': 'a hooks directory of its own (core.hooksPath)',
  'core.worktree': 'a work tree of its own (core.worktree)',
  'core.sshcommand': 'an SSH command (core.sshCommand)',
  'core.gitproxy': 'a proxy command (core.gitProxy)',
  'core.askpass': 'a program that answers Git\'s questions (core.askPass)',
  'core.editor': 'an editor (core.editor)',
  'core.sequenceeditor': 'a sequence editor (core.sequenceEditor)',
  'core.credentialhelper': 'a credential helper (core.credentialHelper)',
  'diff.external': 'an external diff program (diff.external)',
  'diff.orderfile': 'a diff order file (diff.orderFile)',
  'gpg.program': 'a signing program (gpg.program)',
  'gpg.ssh.program': 'a signing program (gpg.ssh.program)',
  'include.path': 'another configuration file (include.path)',
}

/**
 * The configuration families a review refuses.
 *
 * A family is refused as a whole: every member of it names a program or a file of its own, and a repository may declare
 * as many of them as it likes.
 */
const REFUSED_CONFIG_FAMILIES: readonly { prefix: string; label: string }[] = [
  { prefix: 'alias.', label: 'a command alias (alias.*)' },
  { prefix: 'credential.', label: 'a credential helper (credential.*)' },
  { prefix: 'filter.', label: 'a content filter (filter.*)' },
  { prefix: 'includeif.', label: 'another configuration file (includeIf.*)' },
]

/** The diff drivers a review refuses: each of them runs a program of the repository's own choosing. */
const REFUSED_CONFIG_DRIVERS: readonly { suffix: string; label: string }[] = [
  { suffix: '.command', label: 'an external diff program (diff.*.command)' },
  { suffix: '.textconv', label: 'a text conversion filter (diff.*.textconv)' },
]

/** The bounds one review works under; a deployment may lower them, never raise them past the defaults. */
export interface ReviewDiffLimits {
  /** The largest diff text to return, in bytes. */
  maxDiffBytes?: number
  /** How long the whole review may run, in milliseconds. */
  timeoutMs?: number
  /** How many file names to report. */
  maxFiles?: number
  /** How many whitespace findings to report. */
  maxWhitespace?: number
  /** How many untracked file names to report. */
  maxUntracked?: number
}

/** What one review needs to know: the workspace the node bound to the Project, and the root it must stay inside. */
export interface ReviewDiffOptions extends ReviewDiffLimits {
  /** The Project's workspace on this node. */
  workspace: string
  /** The node root the workspace must resolve inside. */
  root: string
}

/** What one Git command answered. */
interface GitOutcome {
  /** The exit code; a non-zero code is a refusal or a failure, never a success. */
  code: number
  stdout: string
  stderr: string
  /** The command was killed for running too long. */
  timedOut: boolean
  /** The command printed more than the buffer allowed and was stopped. */
  tooLarge: boolean
}

/**
 * The environment one Git command runs with.
 *
 * It is built from scratch instead of inherited: the host's `GIT_DIR`, `GIT_WORK_TREE` and `GIT_CONFIG_*` must not point
 * a review at another repository, and the operator's own Git configuration could name an external diff program or a
 * credential helper. `HOME` and `USERPROFILE` name a directory that does not exist, so no global configuration is found,
 * and the system configuration and the system attributes file are switched off as well.
 */
function gitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR']) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  const empty = join(tmpdir(), 'dsh-superagent-no-home')
  environment.HOME = empty
  environment.USERPROFILE = empty
  environment.GIT_CONFIG_NOSYSTEM = '1'
  environment.GIT_CONFIG_GLOBAL = join(empty, '.gitconfig')
  environment.GIT_ATTR_NOSYSTEM = '1'
  environment.GIT_TERMINAL_PROMPT = '0'
  environment.GIT_ASKPASS = ''
  environment.GIT_OPTIONAL_LOCKS = '0'
  environment.GIT_PAGER = 'cat'
  environment.LC_ALL = 'C'
  return environment
}

/**
 * The Git program this node runs, found once.
 *
 * It is looked for in the directories of the host's own `PATH` and remembered by its absolute path. A relative entry of
 * `PATH` names a directory of the working directory — which the Project's workspace controls — so those entries are never
 * searched: a workspace could otherwise place its own `git` in front of the real one. On Windows only a real program is
 * accepted, never a batch file, because running one would need a shell.
 */
let gitProgram: string | undefined | null = null

function gitExecutable(): string | undefined {
  if (gitProgram === null) gitProgram = findGitExecutable()
  return gitProgram
}

function findGitExecutable(): string | undefined {
  const names = process.platform === 'win32' ? ['git.exe'] : ['git']
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(entry)) continue
    for (const name of names) {
      const candidate = join(entry, name)
      try {
        const stats = statSync(candidate)
        if (!stats.isFile()) continue
        if (process.platform !== 'win32' && (stats.mode & 0o111) === 0) continue
        return candidate
      } catch {
        // This directory holds no Git program; the next one may.
      }
    }
  }
  return undefined
}

/**
 * Run one Git command and report what it answered.
 *
 * The command runs without a shell, so nothing in its arguments can become another command, and it is killed when it
 * outruns its timeout. A command that prints more than the buffer allows is reported as `tooLarge` with the part it did
 * print, so a diff larger than the bound is cut rather than lost.
 */
function runGit(args: readonly string[], cwd: string, timeoutMs: number, maxBuffer: number): Promise<GitOutcome> {
  const program = gitExecutable()
  if (program === undefined) {
    return Promise.resolve({ code: 1, stdout: '', stderr: 'Git is not installed on this node',
      timedOut: false, tooLarge: false })
  }
  return new Promise<GitOutcome>(resolve => {
    try {
      execFile(program, ['--no-pager', ...GIT_OPTIONS, ...args],
        { cwd, env: gitEnvironment(), timeout: timeoutMs, maxBuffer, windowsHide: true, encoding: 'utf8' },
        (error, stdout, stderr) => {
          const text = (value: string | Buffer | undefined): string => value === undefined ? ''
            : typeof value === 'string' ? value : value.toString('utf8')
          if (!error) return resolve({ code: 0, stdout: text(stdout), stderr: text(stderr), timedOut: false, tooLarge: false })
          const failure = error as { code?: unknown; killed?: unknown }
          const code = typeof failure.code === 'number' ? failure.code : 1
          // A command that printed too much is stopped as well, so it was killed too; the buffer is the reason, not the clock.
          const tooLarge = failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          resolve({
            code,
            stdout: text(stdout),
            stderr: text(stderr),
            timedOut: failure.killed === true && !tooLarge,
            tooLarge,
          })
        })
    } catch (error) {
      // Git could not even be started: the answer is a failure, not a thrown error the caller has to catch.
      resolve({ code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error),
        timedOut: false, tooLarge: false })
    }
  })
}

/** The real path of a directory, or undefined when it does not exist. */
function realPathOf(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return realpathSync(path)
    } catch {
      return undefined
    }
  }
}

/** What a path is, as the file system reports it; undefined when there is nothing there. */
function lstatOf(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

/** The text of a file, or undefined when it cannot be read. */
function textOf(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Whether a path is inside a directory, compared by their real paths. */
function inside(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

/** Whether two paths are the same directory, compared by their real paths. */
function samePath(left: string, right: string): boolean {
  const normalize = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path)
  return normalize(left) === normalize(right)
}

/** The lines of a Git answer, without the empty ones. */
function linesOf(text: string): string[] {
  return text.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line !== '')
}

/**
 * The reason a Git failure is reported with.
 *
 * Git's own message is not passed on: it can carry the path of the repository or of a configuration file, and the PM has
 * no business seeing either.
 */
function failureReason(outcome: GitOutcome, fallback: string): string {
  return outcome.timedOut ? `Git did not answer within the time it was given` : fallback
}

/**
 * The section of one configuration line, lowercased.
 *
 * `[a.b]` and `[a "b"]` name the same section, and the subsection of a section is part of the key that follows it.
 */
function configSection(raw: string): string {
  const trimmed = raw.trim()
  const quoted = /^(.+?)\s+"([^"]*)"$/.exec(trimmed)
  if (quoted) return `${quoted[1]!.trim().toLowerCase()}.${quoted[2]!.toLowerCase()}`
  return trimmed.toLowerCase()
}

/**
 * The keys one Git configuration file declares, lowercased and section-qualified.
 *
 * The file is read as text and never handed to Git: a configuration file can include another one, and only this node
 * decides which files a review reads.
 */
function configKeys(text: string): string[] {
  const keys: string[] = []
  let section = ''
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[')) {
      const end = line.indexOf(']')
      if (end < 0) continue
      section = configSection(line.slice(1, end))
      continue
    }
    const equals = line.indexOf('=')
    const name = (equals < 0 ? line : line.slice(0, equals)).trim().toLowerCase()
    if (name === '') continue
    keys.push(section === '' ? name : `${section}.${name}`)
  }
  return keys
}

/**
 * What a refused configuration key means, or undefined when the key is one a review may run with.
 *
 * The answer is a fixed phrase and never the key itself: a repository chooses the name of its own subsections, and the
 * reason a PM reads must not carry a name the repository made up.
 */
function refusedConfigLabel(key: string): string | undefined {
  const exact = REFUSED_CONFIG_KEYS[key]
  if (exact !== undefined) return exact
  for (const family of REFUSED_CONFIG_FAMILIES) if (key.startsWith(family.prefix)) return family.label
  if (key.startsWith('diff.')) {
    for (const driver of REFUSED_CONFIG_DRIVERS) if (key.endsWith(driver.suffix)) return driver.label
  }
  return undefined
}

/** What the guard found in one repository: it is the repository's own, and its configuration may be read. */
type GuardResult = { ok: true } | { ok: false; reason: string }

/**
 * Check that the repository of the workspace is the workspace's own, and that its configuration may be read with.
 *
 * A workspace whose `.git` is a file or a link points at another repository — a linked worktree or a submodule — and is
 * refused. A repository that shares its objects with another one, or that names a program or a path outside itself in its
 * own configuration, is refused as well: the review reads one repository, with a fixed command set, and nothing of the
 * repository's own choosing runs or is read.
 */
function guardRepository(workspace: string): GuardResult {
  const dotGit = join(workspace, '.git')
  const stats = lstatOf(dotGit)
  if (!stats) return { ok: false, reason: 'The Project workspace holds no Git directory of its own' }
  if (!stats.isDirectory()) {
    return { ok: false, reason: 'The Project workspace\'s Git directory points at another repository, which a review does not follow' }
  }
  const gitDir = realPathOf(dotGit)
  if (!gitDir || !inside(workspace, gitDir)) {
    return { ok: false, reason: 'The Project workspace\'s Git directory lies outside the workspace' }
  }

  // A linked worktree keeps its objects in another repository's directory; the review reads one repository's own objects.
  if (lstatOf(join(gitDir, 'commondir'))) {
    return { ok: false, reason: 'The Project workspace is a linked worktree of another repository, which a review does not follow' }
  }

  // The object store must be this repository's own, and it must not borrow the objects of another one.
  const objects = join(gitDir, 'objects')
  const objectStats = lstatOf(objects)
  if (objectStats) {
    if (!objectStats.isDirectory()) {
      return { ok: false, reason: 'The Project repository\'s object directory is not a directory of its own' }
    }
    const realObjects = realPathOf(objects)
    if (!realObjects || !inside(gitDir, realObjects)) {
      return { ok: false, reason: 'The Project repository\'s object directory lies outside the repository' }
    }
    const alternates = textOf(join(objects, 'info', 'alternates'))
    if (alternates !== undefined && alternates.trim() !== '') {
      return { ok: false, reason: 'The Project repository borrows its objects from another repository, which a review does not follow' }
    }
  }

  // The repository's own configuration, read by this node and not by Git: an included file is a file of the
  // repository's own choosing, and a review reads none of those.
  for (const name of ['config', 'config.worktree']) {
    const path = join(gitDir, name)
    const configStats = lstatOf(path)
    if (!configStats) continue
    if (!configStats.isFile()) {
      return { ok: false, reason: `The Project repository\'s ${name} is not a regular file of its own` }
    }
    const realConfig = realPathOf(path)
    if (!realConfig || !inside(gitDir, realConfig)) {
      return { ok: false, reason: `The Project repository\'s ${name} lies outside the repository` }
    }
    const text = textOf(path)
    if (text === undefined) {
      return { ok: false, reason: `The Project repository\'s ${name} could not be read` }
    }
    for (const key of configKeys(text)) {
      const label = refusedConfigLabel(key)
      if (label !== undefined) {
        return { ok: false, reason: `The Project repository\'s own Git configuration declares ${label}; a read-only review `
          + 'does not run with such a configuration' }
      }
    }
  }
  return { ok: true }
}

/**
 * Read the changes of one Project's workspace.
 *
 * The result is always an answer: a workspace that is not a repository, a repository without a commit, a directory that
 * belongs to a parent repository, a repository whose own configuration names a program, a diff larger than the bound and
 * a Git command that ran out of time each produce their own status with a reason, never an exception the caller has to
 * interpret.
 */
export async function reviewWorkspace(options: ReviewDiffOptions): Promise<ReviewDiffResult> {
  const maxDiffBytes = Math.max(1, options.maxDiffBytes ?? MAX_REVIEW_DIFF_BYTES)
  const budgetMs = Math.max(1, options.timeoutMs ?? REVIEW_GIT_TIMEOUT_MS)
  const maxFiles = Math.max(1, options.maxFiles ?? MAX_REVIEW_FILES)
  const maxWhitespace = Math.max(1, options.maxWhitespace ?? MAX_REVIEW_WHITESPACE)
  const maxUntracked = Math.max(1, options.maxUntracked ?? MAX_REVIEW_UNTRACKED)
  // One budget for the whole review: every Git command gets what is left of it, so the node always answers inside the
  // window the control plane waits for.
  const deadline = Date.now() + budgetMs
  const remaining = (): number => Math.max(1, deadline - Date.now())

  const root = realPathOf(resolve(options.root))
  if (!root) return { status: 'refused', reason: 'The node root does not exist on this node' }
  const workspace = realPathOf(resolve(options.workspace))
  if (!workspace) return { status: 'refused', reason: 'The Project workspace does not exist on this node' }
  if (!inside(root, workspace)) {
    return { status: 'refused', reason: 'The Project workspace must be a directory inside the node root' }
  }

  // The repository the workspace belongs to. A workspace that only sits inside some parent repository is refused: a
  // review reads the Project's own repository and never a repository above it.
  const top = await runGit(['rev-parse', '--show-toplevel'], workspace, remaining(), 64 * 1024)
  if (top.timedOut) return { status: 'timeout', workspace, reason: `Git did not answer within ${budgetMs} ms` }
  if (top.code !== 0) return { status: 'no-repository', workspace, reason: 'The Project workspace is not a Git repository' }
  const repository = realPathOf(resolve(top.stdout.trim())) ?? resolve(top.stdout.trim())
  if (!samePath(repository, workspace)) {
    return { status: 'refused', workspace,
      reason: `The Project workspace is not the root of its own Git repository: it belongs to the repository at ${repository}` }
  }

  // The repository must be this workspace's own, and its own configuration may not name a program or a path outside it.
  const guard = guardRepository(workspace)
  if (!guard.ok) return { status: 'refused', workspace, reason: guard.reason }

  // The baseline. A repository without a commit has nothing to compare against, and says so instead of pretending.
  const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], workspace, remaining(), 64 * 1024)
  if (head.timedOut) return { status: 'timeout', workspace, reason: `Git did not answer within ${budgetMs} ms` }
  const baseline = head.code === 0 ? head.stdout.trim() : undefined

  const diff = await readDiff(workspace, baseline, remaining, budgetMs, maxDiffBytes)
  if (diff.status === 'timeout' || diff.status === 'failed') {
    return { status: diff.status, workspace, ...(diff.reason === undefined ? {} : { reason: diff.reason }) }
  }
  const files = await readNames(workspace, baseline, remaining, maxFiles)
  const untracked = await readUntracked(workspace, remaining(), maxUntracked)
  const whitespace = await readWhitespace(workspace, baseline, remaining, budgetMs, maxWhitespace)
  const reasons = [diff.reason, files.reason, untracked.reason, whitespace.reason]
    .filter((reason): reason is string => reason !== undefined)

  return {
    status: diff.status,
    workspace,
    ...(baseline === undefined ? {} : { baseline }),
    diff: diff.text,
    files: files.names,
    fileCount: files.count,
    untracked: untracked.names,
    untrackedCount: untracked.count,
    whitespace: whitespace.lines,
    whitespaceClean: whitespace.clean,
    // A part that could not be read leaves the answer incomplete: a missing file and an unchecked line are not a clean
    // workspace, and the answer says which part is missing.
    complete: files.complete && untracked.complete && whitespace.complete,
    ...(reasons.length === 0 ? {} : { reason: reasons.join('; ') }),
  }
}

/**
 * The diff of the tracked changes, compared against the baseline.
 *
 * With a baseline the diff is the worktree against that commit, so it holds the staged and the unstaged changes of every
 * tracked file at once. Without one the staged and the unstaged changes are read separately, each labelled, because
 * there is no commit to compare them to.
 */
async function readDiff(workspace: string, baseline: string | undefined, remaining: () => number, budgetMs: number,
  maxDiffBytes: number): Promise<{ status: ReviewDiffResult['status']; text: string; reason?: string }> {
  const buffer = maxDiffBytes + 64 * 1024
  const truncated = `The diff is larger than the bound of ${maxDiffBytes} bytes and was cut short`
  if (baseline !== undefined) {
    const outcome = await runGit(['diff', ...DIFF_OPTIONS, baseline, '--'], workspace, remaining(), buffer)
    if (outcome.timedOut) return { status: 'timeout', text: '', reason: `Git did not answer within ${budgetMs} ms` }
    if (outcome.tooLarge) return { status: 'truncated', text: cut(outcome.stdout, maxDiffBytes), reason: truncated }
    if (outcome.code !== 0) {
      return { status: 'failed', text: '', reason: failureReason(outcome, 'Git could not read the changes of the workspace') }
    }
    // A diff that fits in the buffer but not in the bound is cut as well, and it says that it was cut.
    if (Buffer.byteLength(outcome.stdout, 'utf8') > maxDiffBytes) {
      return { status: 'truncated', text: cut(outcome.stdout, maxDiffBytes), reason: truncated }
    }
    return { status: 'ok', text: outcome.stdout }
  }
  // Without a commit there is nothing to compare against, so the staged and the unstaged changes are read separately.
  const staged = await runGit(['diff', ...DIFF_OPTIONS, '--cached', '--'], workspace, remaining(), buffer)
  if (staged.timedOut) return { status: 'timeout', text: '', reason: `Git did not answer within ${budgetMs} ms` }
  const unstaged = await runGit(['diff', ...DIFF_OPTIONS, '--'], workspace, remaining(), buffer)
  if (unstaged.timedOut) return { status: 'timeout', text: '', reason: `Git did not answer within ${budgetMs} ms` }
  if (unstaged.code !== 0) {
    return { status: 'failed', text: '', reason: failureReason(unstaged, 'Git could not read the changes of the workspace') }
  }
  // A repository without a commit may refuse the staged part; the unstaged changes are still worth showing.
  const stagedText = staged.code === 0 ? staged.stdout : ''
  const text = ['# staged changes (the repository has no commit yet)', stagedText,
    '# unstaged changes (the repository has no commit yet)', unstaged.stdout].join('\n')
  if (staged.tooLarge || unstaged.tooLarge || Buffer.byteLength(text, 'utf8') > maxDiffBytes) {
    return { status: 'truncated', text: cut(text, maxDiffBytes), reason: truncated }
  }
  return { status: 'no-baseline', text,
    reason: 'The repository has no commit yet, so the changes are shown without a baseline' }
}

/** The names of the files the diff touches, bounded. */
async function readNames(workspace: string, baseline: string | undefined, remaining: () => number, maxFiles: number):
Promise<{ names: string[]; count: number; complete: boolean; reason?: string }> {
  const sets = baseline === undefined
    ? [['diff', '--name-only', '--cached', '--'], ['diff', '--name-only', '--']]
    : [['diff', '--name-only', baseline, '--']]
  const names: string[] = []
  let complete = true
  let reason: string | undefined
  for (const args of sets) {
    const outcome = await runGit(args, workspace, remaining(), 256 * 1024)
    if (outcome.timedOut) {
      complete = false
      reason = 'Git did not name the changed files within the time it was given'
      continue
    }
    if (outcome.code !== 0 && !outcome.tooLarge) {
      complete = false
      reason = reason ?? 'Git could not name the changed files'
      continue
    }
    // What the command did print is kept, but a command that was cut short leaves the list incomplete.
    if (outcome.tooLarge) {
      complete = false
      reason = reason ?? 'The list of changed files was larger than the bound and was cut short'
    }
    for (const name of linesOf(outcome.stdout)) if (!names.includes(name)) names.push(name)
  }
  return { names: names.slice(0, maxFiles), count: names.length, complete, ...(reason === undefined ? {} : { reason }) }
}

/**
 * The untracked files of the workspace: their names only.
 *
 * Their content is never read: an untracked file may hold anything, and a review of a code change has no business in it.
 */
async function readUntracked(workspace: string, timeoutMs: number, maxUntracked: number):
Promise<{ names: string[]; count: number; complete: boolean; reason?: string }> {
  const outcome = await runGit(['ls-files', '--others', '--exclude-standard'], workspace, timeoutMs, 256 * 1024)
  if (outcome.timedOut) {
    return { names: [], count: 0, complete: false, reason: 'Git did not name the untracked files within the time it was given' }
  }
  if (outcome.code !== 0 && !outcome.tooLarge) {
    return { names: [], count: 0, complete: false, reason: 'Git could not name the untracked files' }
  }
  const names = linesOf(outcome.stdout)
  if (outcome.tooLarge) {
    return { names: names.slice(0, maxUntracked), count: names.length, complete: false,
      reason: 'The list of untracked files was larger than the bound and was cut short' }
  }
  return { names: names.slice(0, maxUntracked), count: names.length, complete: true }
}

/**
 * The whitespace problems of the changes.
 *
 * `git diff --check` answers with the problems it found and exits with a non-zero code when it found any, which is not a
 * failure of the review: the findings are the answer. A check that failed or ran out of time is a different matter: it
 * found nothing because it never finished, and the answer says so instead of calling the workspace clean.
 */
async function readWhitespace(workspace: string, baseline: string | undefined, remaining: () => number, budgetMs: number,
  maxWhitespace: number): Promise<{ lines: string[]; clean: boolean; complete: boolean; reason?: string }> {
  const sets = baseline === undefined
    ? [['diff', '--no-color', '--check', '--cached', '--'], ['diff', '--no-color', '--check', '--']]
    : [['diff', '--no-color', '--check', baseline, '--']]
  const found: string[] = []
  for (const args of sets) {
    const outcome = await runGit(args, workspace, remaining(), 256 * 1024)
    if (outcome.timedOut) {
      return { lines: [], clean: false, complete: false, reason: `Git did not check the whitespace within ${budgetMs} ms` }
    }
    if (outcome.tooLarge) {
      return { lines: [], clean: false, complete: false,
        reason: 'The whitespace check found more problems than the bound allows, so its answer is incomplete' }
    }
    const lines = linesOf(outcome.stdout)
    // Git answers a whitespace problem with a non-zero status and the findings themselves; a status without findings is
    // a failure of the check, not an answer about the changes.
    if (outcome.code !== 0 && lines.length === 0) {
      return { lines: [], clean: false, complete: false,
        reason: failureReason(outcome, 'Git could not check the whitespace of the changes') }
    }
    for (const line of lines) if (!found.includes(line)) found.push(line)
  }
  const shown = found.slice(0, maxWhitespace)
  // The bound on the list is visible in the answer: a PM is told how many problems there were, not only how many are shown.
  if (found.length > maxWhitespace) {
    return { lines: shown, clean: false, complete: true,
      reason: `The whitespace check found ${found.length} problems; only the first ${maxWhitespace} of them are shown` }
  }
  return { lines: shown, clean: found.length === 0, complete: true }
}

/** Cut a text at a byte bound and mark that it was cut; the mark itself fits inside the bound. */
function cut(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const mark = '\n… (the diff was cut short)'
  const room = Math.max(0, maxBytes - Buffer.byteLength(mark, 'utf8'))
  return `${Buffer.from(text, 'utf8').subarray(0, room).toString('utf8')}${mark}`
}
