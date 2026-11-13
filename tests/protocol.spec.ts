import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { NODE_PROTOCOL_VERSION, type NodeCommand, type NodeEvent, type SessionRecord } from '../src/shared/protocol.ts'
import { SessionTokenError, issueSessionToken, verifySessionToken, type SessionTokenClaims } from '../src/shared/session-token.ts'

const SECRET = 'test-secret'
const now = 1_700_000_000
const claims = { sid: 'pm-project-1', pid: 'project-1', role: 'pm' as const, backend: 'dsh' as const, nodeId: 'node-1' }

describe('node protocol', () => {
  it('keeps the version and accepts the documented Session and command shapes', () => {
    expect(NODE_PROTOCOL_VERSION).toBe(1)
    const session: SessionRecord = { sessionId: 'pm-project-1', projectId: 'project-1', role: 'pm', nodeId: 'node-1',
      workspace: '/srv/project-1', status: 'idle', toolProfile: 'pm.v1', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z' }
    const command: NodeCommand = { type: 'session.cancel', protocolVersion: NODE_PROTOCOL_VERSION, nodeId: 'node-1',
      idempotencyKey: 'cancel-1', at: '2026-01-01T00:00:00.000Z', sessionId: session.sessionId, reason: 'test' }
    const event: NodeEvent = { type: 'session.status', protocolVersion: NODE_PROTOCOL_VERSION, nodeId: 'node-1', seq: 1,
      at: '2026-01-01T00:00:00.000Z', sessionId: session.sessionId, projectId: session.projectId, role: session.role,
      status: 'idle' }
    expect(command.type).toBe('session.cancel')
    expect(event.type).toBe('session.status')
  })
})

describe('session token', () => {
  it('round-trips the Session, Project, Assignment and backend claims', () => {
    const token = issueSessionToken({ ...claims, aid: 'assignment-1', backend: 'claude' }, SECRET, 60, now)
    const verified = verifySessionToken(token, SECRET, now + 30)
    expect(verified).toMatchObject({ v: 1, sid: 'pm-project-1', pid: 'project-1', aid: 'assignment-1', role: 'pm',
      backend: 'claude', nodeId: 'node-1', iat: now, exp: now + 60 })
  })

  it('rejects an expired token', () => {
    const token = issueSessionToken(claims, SECRET, 10, now)
    expect(() => verifySessionToken(token, SECRET, now + 10)).toThrowError(expect.objectContaining({ code: 'expired' }))
  })

  it('rejects a token signed with another secret', () => {
    const token = issueSessionToken(claims, SECRET, 60, now)
    expect(() => verifySessionToken(token, 'other-secret', now)).toThrowError(expect.objectContaining({ code: 'bad-signature' }))
  })

  it('rejects a tampered payload', () => {
    const token = issueSessionToken(claims, SECRET, 60, now)
    const [payload, signature] = token.split('.')
    const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')), pid: 'project-2' }))
      .toString('base64url')
    expect(() => verifySessionToken(`${changed}.${signature}`, SECRET, now)).toThrowError(expect.objectContaining({ code: 'bad-signature' }))
  })

  it('rejects malformed tokens without leaking their contents', () => {
    for (const token of ['', 'one-part', 'a.b.c', '.', 'not-json.signature']) {
      expect(() => verifySessionToken(token, SECRET, now)).toThrowError(SessionTokenError)
    }
  })

  it('rejects an unsupported version and an invalid claim shape', () => {
    const token = issueSessionToken(claims, SECRET, 60, now)
    const [payload] = token.split('.')
    const value = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as SessionTokenClaims
    // Change the claims and re-sign them, so each case reaches its intended check rather than the signature.
    const signed = (next: unknown) => {
      const encoded = Buffer.from(JSON.stringify(next), 'utf8').toString('base64url')
      return `${encoded}.${createHmac('sha256', SECRET).update(encoded).digest('base64url')}`
    }
    expect(() => verifySessionToken(signed({ ...value, v: 2 }), SECRET, now)).toThrowError(expect.objectContaining({ code: 'unsupported' }))
    expect(() => verifySessionToken(signed({ ...value, role: 'admin' }), SECRET, now)).toThrowError(expect.objectContaining({ code: 'malformed' }))
    expect(() => verifySessionToken(signed({ ...value, exp: value.iat }), SECRET, now)).toThrowError(expect.objectContaining({ code: 'malformed' }))
  })

  it('refuses to issue with no secret or a non-positive lifetime', () => {
    expect(() => issueSessionToken(claims, '', 60, now)).toThrowError(expect.objectContaining({ code: 'unsupported' }))
    expect(() => issueSessionToken(claims, SECRET, 0, now)).toThrowError(expect.objectContaining({ code: 'malformed' }))
    expect(() => issueSessionToken(claims, SECRET, 0.5, now)).toThrowError(expect.objectContaining({ code: 'malformed' }))
    expect(() => issueSessionToken(claims, SECRET, Number.NaN, now)).toThrowError(expect.objectContaining({ code: 'malformed' }))
  })
})
