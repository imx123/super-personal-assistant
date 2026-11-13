/**
 * Short-lived session tokens: the only trustworthy source of tool context.
 *
 * The control plane signs a token when it creates or resumes a Session (or, later, when it forwards a
 * tool call). A node verifies it before running a tool, then builds a `ToolContext` from the claims.
 * Nothing in a tool's arguments can change `sid`, `pid`, `aid`, `role`, `backend` or `nodeId`.
 *
 * Format: `base64url(JSON claims).base64url(HMAC-SHA256(secret, payload segment))`, with no padding.
 * Only `node:crypto` is used. A token is a bearer secret: never log it, never include it in errors.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { BackendKind, SessionRole } from './protocol.ts'

/** The signed payload. Short claim names keep the wire form compact. */
export interface SessionTokenClaims {
  /** Token format version; a verifier rejects anything else as `unsupported`. */
  v: 1
  /** Session id: the control-plane primary key for the acting Session. */
  sid: string
  /** Project id the Session works for. */
  pid: string
  /** Assignment id; present for a Worker, absent for a PM or a scout. */
  aid?: string
  role: SessionRole
  backend: BackendKind
  nodeId: string
  /** Issued-at, integer seconds since the Unix epoch. */
  iat: number
  /** Expiry, integer seconds since the Unix epoch; a token is invalid at `exp`. */
  exp: number
}

/** Why a token could not be issued or verified. */
export type SessionTokenErrorCode = 'malformed' | 'bad-signature' | 'expired' | 'unsupported'

/** A rejected token. The message never contains the token or the secret. */
export class SessionTokenError extends Error {
  constructor(readonly code: SessionTokenErrorCode, message: string) {
    super(message)
    this.name = 'SessionTokenError'
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/
const ROLES: ReadonlySet<string> = new Set<SessionRole>(['pm', 'worker', 'scout'])
const BACKENDS: ReadonlySet<string> = new Set<BackendKind>(['dsh', 'claude', 'codex'])

/** The current time in whole seconds; an explicit `nowSeconds` makes issuance and verification testable. */
function currentSeconds(nowSeconds?: number): number {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000)
  if (!Number.isFinite(now)) throw new SessionTokenError('unsupported', 'session token time must be a finite number of seconds')
  return now
}

/** A missing secret is a deployment error, not a defect in a received token. */
function requireSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new SessionTokenError('unsupported', 'session token secret is not configured')
  }
}

function sign(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest()
}

function isClaims(value: unknown): value is SessionTokenClaims {
  if (typeof value !== 'object' || value === null) return false
  const claims = value as Record<string, unknown>
  return typeof claims.v === 'number'
    && typeof claims.sid === 'string' && claims.sid.length > 0
    && typeof claims.pid === 'string' && claims.pid.length > 0
    && typeof claims.role === 'string' && ROLES.has(claims.role)
    && typeof claims.backend === 'string' && BACKENDS.has(claims.backend)
    && typeof claims.nodeId === 'string' && claims.nodeId.length > 0
    && typeof claims.iat === 'number' && Number.isFinite(claims.iat)
    && typeof claims.exp === 'number' && Number.isFinite(claims.exp)
    && (claims.aid === undefined || typeof claims.aid === 'string')
}

/**
 * Sign one Session's claims. `ttlSeconds` must be a positive finite number, so `exp` is never earlier
 * than `iat` (a TTL below one second rounds down and therefore produces an already-expiring token).
 */
export function issueSessionToken(
  claims: Omit<SessionTokenClaims, 'v' | 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number,
  nowSeconds?: number,
): string {
  requireSecret(secret)
  if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new SessionTokenError('malformed', 'session token ttl must be a positive finite number of seconds')
  }
  const now = currentSeconds(nowSeconds)
  const iat = Math.floor(now)
  const exp = Math.floor(now + ttlSeconds)
  if (exp <= iat) throw new SessionTokenError('malformed', 'session token ttl must be at least one second')
  const payload: SessionTokenClaims = { ...claims, v: 1, iat, exp }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${encoded}.${sign(encoded, secret).toString('base64url')}`
}

/**
 * Verify a token and return its claims.
 *
 * Rejects in a fixed order: shape (`malformed`), signature (`bad-signature`), version (`unsupported`),
 * then expiry (`expired`). The signature is checked before the payload is trusted as a claim set.
 */
export function verifySessionToken(token: string, secret: string, nowSeconds?: number): SessionTokenClaims {
  requireSecret(secret)
  const now = currentSeconds(nowSeconds)
  if (typeof token !== 'string' || token.length === 0) {
    throw new SessionTokenError('malformed', 'session token is empty')
  }
  const parts = token.split('.')
  const encodedPayload = parts.at(0)
  const encodedSignature = parts.at(1)
  if (parts.length !== 2 || encodedPayload === undefined || encodedSignature === undefined) {
    throw new SessionTokenError('malformed', 'session token must have two dot-separated segments')
  }
  if (!BASE64URL.test(encodedPayload) || !BASE64URL.test(encodedSignature)) {
    throw new SessionTokenError('malformed', 'session token segments must be base64url')
  }

  const expected = sign(encodedPayload, secret)
  const provided = Buffer.from(encodedSignature, 'base64url')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new SessionTokenError('bad-signature', 'session token signature does not match')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
  } catch {
    throw new SessionTokenError('malformed', 'session token payload is not JSON')
  }
  if (!isClaims(parsed)) {
    throw new SessionTokenError('malformed', 'session token payload is not a claim set')
  }
  if (parsed.v !== 1) {
    throw new SessionTokenError('unsupported', `session token version ${String(parsed.v)} is not supported`)
  }
  if (parsed.exp <= parsed.iat) {
    throw new SessionTokenError('malformed', 'session token expires before it was issued')
  }
  if (parsed.exp <= now) {
    throw new SessionTokenError('expired', 'session token has expired')
  }
  return parsed
}
