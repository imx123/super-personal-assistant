/**
 * Removes credentials, request data and machine paths from diagnostics that outlive the server log.
 * Management responses, health details, persisted effect errors and Ticket reports are read by the panel and by backups,
 * so only the redacted form is kept. Messages keep their stable category text; only the sensitive substrings change, so
 * an operator still sees what failed and can rerun a CLI to read its raw output.
 */

/** Replacement for a credential or another value that came from a request. */
export const REDACTED = '[redacted]'
/** Replacement for an absolute filesystem path. */
export const REDACTED_PATH = '<path>'

/** Whether a value following a credential-shaped name is a credential rather than an English word such as `keep`. */
const credentialValue = (value: string, separator: string): boolean => {
  // `name=value` is a query parameter, JSON field or CLI flag: its value is never prose.
  if (separator.includes('=') || separator.includes('%3D')) return true
  if (/^["']/.test(value) && /["']$/.test(value)) return true
  const text = value.replace(/^["']|["']$/g, '')
  return /^(?:bearer|basic|token|digest)\s+/i.test(text) || /\d/.test(text) || text.length >= 12
}

/** Authorization headers carry a scheme, then the credential, up to the end of their line. */
const AUTH_HEADER = /(?<![A-Za-z0-9_-])((?:proxy-|x-)?authorization)"?\s*[:=]\s*[^\r\n]*/gi
/** `token=…`, `api_key: …`, `password=…` and the same names as query parameters or JSON fields. */
const CREDENTIAL = /(?<![A-Za-z0-9_-])((?:x-)?(?:api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|token|secret|client[-_]?secret|app[-_]?secret|password|passwd|pwd|private[-_]?key|verification[-_]?token|encrypt[-_]?key))("?\s*[:=]\s*|%3D)("[^"]*"|'[^']*'|[^\s,;&"'<>)\][{]+)/gi
/** A secret written in prose, such as `bad token abc123` or `app secret is abc123`; an English word alone is not one. */
const PROSE_CREDENTIAL = /\b(token|secret|api key|password)\s+((?:is|was)\s+)?([A-Za-z0-9._~+/=-]{6,})/gi
/** A bare `Bearer …` outside a header line. */
const SCHEME_CREDENTIAL = /\b(bearer|basic|digest)\s+([A-Za-z0-9._~+/=-]{8,})/gi
/** Well-known token formats, which are credentials wherever they appear. */
const KNOWN_TOKENS: readonly RegExp[] = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
]
/** Userinfo in a URL, which can hold a password. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi
/** The query string of any URL or request target: its values are volatile request data. */
const QUERY_VALUE = /([?&][A-Za-z0-9_.~%+-]+=)[^&#\s"'<>]*/g
/** A `file:` URL's path, including the Windows form `file:///C:/…`. */
const FILE_URL = /\bfile:\/\/[^\s"'<>|]*/gi
/** A Windows drive path or a UNC share. */
const WINDOWS_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?:[^\s\\/:*?"<>|']+[\\/])*[^\s\\/:*?"<>|']*|(?<![A-Za-z0-9])\\\\[^\s\\/']+[\\/](?:[^\s\\/']+[\\/]?)+/g
/** An absolute POSIX path such as `/home/me/.config/gh`, at a word start and outside URLs. */
const POSIX_PATH = /(?<![\w.~:/\\-])\/(?:[A-Za-z0-9._@%+~-]+\/)+[A-Za-z0-9._@%+~-]*/g
const TRAILING_PUNCTUATION = /[.,:;!?]+$/

/** Replace an absolute path, keeping the punctuation that ended the sentence around it. */
function pathReplacement(match: string): string {
  const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? ''
  const path = trailing ? match.slice(0, -trailing.length) : match
  // A single slash, or a drive letter with nothing after it, is not an absolute path worth hiding.
  return path.length > 2 ? `${REDACTED_PATH}${trailing}` : match
}

/**
 * Redact one diagnostic for storage or a management response.
 * Query values, credential names, known token formats, URL userinfo and absolute paths are replaced; everything else,
 * including the error's category and status text, is preserved.
 */
export function redact(text: string): string {
  let value = text
    .replace(AUTH_HEADER, (_match, name: string) => `${name}: ${REDACTED}`)
    .replace(CREDENTIAL, (match, name: string, separator: string, raw: string) => {
      if (!credentialValue(raw, separator)) return match
      // Keep quoting so a JSON or shell fragment still reads as one.
      const quoted = /^["']/.test(raw) && /["']$/.test(raw)
      return `${name}${separator}${quoted ? `"${REDACTED}"` : REDACTED}`
    })
    .replace(PROSE_CREDENTIAL, (match, name: string, connector: string | undefined, raw: string) =>
      /\d/.test(raw) ? `${name} ${connector ?? ''}${REDACTED}` : match)
    .replace(SCHEME_CREDENTIAL, (_match, scheme: string) => `${scheme} ${REDACTED}`)
  for (const pattern of KNOWN_TOKENS) value = value.replace(pattern, REDACTED)
  return value
    .replace(URL_USERINFO, (_match, scheme: string) => `${scheme}${REDACTED}@`)
    .replace(QUERY_VALUE, (_match, name: string) => `${name}${REDACTED}`)
    .replace(FILE_URL, () => `file://${REDACTED_PATH}`)
    .replace(WINDOWS_PATH, pathReplacement)
    .replace(POSIX_PATH, pathReplacement)
}

/** Redact the text of an arbitrary thrown value; the message is kept, never the stack. */
export const redactError = (error: unknown): string => redact(error instanceof Error ? error.message : String(error))

/** Redact every string in a map of values that a response or a health entry carries. */
export function redactValues<T extends Record<string, string>>(values: T): T {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, redact(value)])) as T
}
