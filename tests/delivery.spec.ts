import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { AgentDelivery } from '../src/app/delivery.ts'

/** One entry of the persisted log a fixture replays: a plain user message or a full Session event such as a splice. */
type Recorded = UserMessage | SessionEvent

/** A DSH 0.2.2 inbox mutation; an empty `inserted` is a removal. */
function splicedEvent(inserted: UserMessage[]): SessionEvent {
  return { type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 0,
    data: { target: 'next-turn', start: 0, inserted } }
}

function fixture(history: Recorded[] = []) {
  const ctx = new Context()
  const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[] }
  const steer = vi.fn((message: UserMessage) => { inbox.nextStep.push(message) })
  const followup = vi.fn((message: UserMessage) => { inbox.nextTurn.push(message) })
  const injected = vi.fn((_message: UserMessage) => {})
  // Only the delivery-facing Agent methods participate in this fixture.
  const agent = { id: SessionId('delivery-test'), session: {}, inbox, steer, followup, inject: injected } as unknown as Agent
  const event = (recorded: Recorded): SessionEvent => 'type' in recorded ? recorded
    : { type: 'user/message', seq: SessionSeq(0), time: 0, surfaceOp: 'append', data: recorded }
  const read = vi.fn(async (offset: number, length: number) => ({ events: history.slice(offset, offset + length).map(event) }))
  const close = vi.fn(async () => {})
  const flush = vi.fn(async () => {})
  const open = vi.fn(async () => ({ read, [Symbol.asyncDispose]: close }))
  const agents = new Map([[agent.id, agent]])
  ctx.reflect.provide('agents', agents)
  ctx.reflect.provide('sessionPersistence', { open, flush })
  const delivery = new AgentDelivery(ctx)
  const signal = new AbortController()
  const send = (id = 'request', mode: 'queue' | 'steer' = 'steer') => delivery.send(agent, id, '{"event_id":"event"}', mode, signal.signal)
  const inject = (id: string, summary: string) => delivery.send(agent, id, '{"settings_saved":"policy"}', { inject: summary }, signal.signal)
  const holds = (id: string) => delivery.holds(agent, id)
  const consume = (message: UserMessage) => {
    inbox.nextStep.splice(0); inbox.nextTurn.splice(0)
    ctx.emit('session/event', agent.session, event(message))
  }
  const consumeSpliced = (inserted: UserMessage[]) => {
    inbox.nextStep.splice(0); inbox.nextTurn.splice(0)
    ctx.emit('session/event', agent.session, splicedEvent(inserted))
  }
  return { agent, agents, inbox, steer, followup, injected, open, read, close, flush, send, inject, holds, consume,
    consumeSpliced, signal }
}

it.each(['queue', 'steer'] as const)('delivers %s as an orchestrator relay, deduplicating pending and consumed messages', async mode => {
  const f = fixture()
  await f.send('request', mode)
  const target = mode === 'queue' ? f.followup : f.steer
  expect(target).toHaveBeenCalledOnce()
  const message = target.mock.calls[0]![0]
  expect(message.role).toBe('user')
  expect(message.source).toEqual({ kind: 'dsh-superagent', form: 'relay' })
  expect(Object.isFrozen(message)).toBe(true)
  await f.send('request', mode)
  f.consume(message)
  await f.send('request', mode)
  expect(target).toHaveBeenCalledOnce()
  expect(f.open).toHaveBeenCalledOnce()
  expect(f.close).toHaveBeenCalledOnce()
  const restored = fixture([message])
  await restored.send('request', mode)
  expect(restored.steer).not.toHaveBeenCalled()
  expect(restored.followup).not.toHaveBeenCalled()
})

it.each(['pending', 'consumed', 'live'] as const)('recognizes legacy plugin identity in %s input without rewriting it', async location => {
  // Bypass TypeScript's current source union to construct the retired serialized shape.
  const old: UserMessage = JSON.parse(JSON.stringify({ id: 'dsh-superagent:request', role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-superagent', form: 'relay' } }))
  const before = JSON.stringify(old)
  const f = fixture(location === 'consumed' ? [old] : [])
  if (location === 'pending') f.inbox.nextTurn.push(old)
  if (location === 'live') f.read.mockImplementationOnce(async () => { f.consume(old); return { events: [] } })
  await f.send()
  expect(f.steer).not.toHaveBeenCalled()
  expect(JSON.stringify(old)).toBe(before)
  await f.send('different-request')
  expect(f.steer).toHaveBeenCalledOnce()
})

it.each(['another-plugin', undefined])('does not treat a legacy plugin source %s as this producer', async plugin => {
  const old: UserMessage = JSON.parse(JSON.stringify({ id: 'dsh-superagent:request', role: 'user', content: [], source: { kind: 'plugin', plugin, form: 'relay' } }))
  const f = fixture([old])
  await f.send()
  expect(f.steer).toHaveBeenCalledOnce()
})

it.each(['pending', 'consumed'] as const)('recognizes legacy user RPC identity in %s input', async location => {
  const old = createUserMessage({ content: [{ type: 'text', text: 'old relay' }], source: { kind: 'user', rpcId: 'request' } })
  const f = fixture(location === 'consumed' ? [old] : [])
  if (location === 'pending') f.inbox.nextTurn.push(old)
  await f.send()
  expect(f.steer).not.toHaveBeenCalled()
  expect(old.source.kind).toBe('user')
  await f.send('different-request')
  expect(f.steer).toHaveBeenCalledOnce()
})

it('retries a failed durability barrier without another delivery and permits concurrent retries', async () => {
  const f = fixture()
  f.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk busy'))
  await expect(f.send()).rejects.toThrow('disk busy')
  f.consume(f.steer.mock.calls[0]![0])
  await Promise.all([f.send(), f.send()])
  expect(f.steer).toHaveBeenCalledOnce()
  expect(f.flush).toHaveBeenCalledTimes(4)
})

it('retries history failures and reads past the first page', async () => {
  const old = createUserMessage({ content: [], source: { kind: 'user', rpcId: 'request' } })
  const f = fixture([...Array.from({ length: 512 }, () => createUserMessage({ content: [], source: { kind: 'user' } })), old])
  f.read.mockRejectedValueOnce(new Error('read failed'))
  await expect(f.send()).rejects.toThrow('read failed')
  await f.send()
  expect(f.steer).not.toHaveBeenCalled()
  expect(f.close).toHaveBeenCalledTimes(2)
})

it('keeps consumption that happens during the initial history read', async () => {
  const f = fixture()
  const old = createUserMessage({ content: [], source: { kind: 'user', rpcId: 'request' } })
  f.read.mockImplementationOnce(async () => { f.consume(old); return { events: [] } })
  await f.send()
  expect(f.steer).not.toHaveBeenCalled()
})

it('does not dispatch when cancelled or disposed during history loading', async () => {
  const cancelled = fixture()
  cancelled.read.mockImplementationOnce(async () => { cancelled.signal.abort(); return { events: [] } })
  await expect(cancelled.send()).rejects.toThrow()
  expect(cancelled.steer).not.toHaveBeenCalled()
  const disposed = fixture()
  disposed.read.mockImplementationOnce(async () => { disposed.agents.clear(); return { events: [] } })
  await expect(disposed.send()).rejects.toThrow('disposed')
  expect(disposed.steer).not.toHaveBeenCalled()
})

it('injects a notice once, as dsh-superagent\'s notice with its summary, without waking the agent', async () => {
  const f = fixture()
  await f.inject('notice:settings', 'Settings saved')
  await f.inject('notice:settings', 'Settings saved')
  expect(f.injected).toHaveBeenCalledOnce()
  expect(f.injected.mock.calls[0]![0]).toMatchObject({ role: 'user', source: { kind: 'dsh-superagent', form: 'notice', summary: 'Settings saved' } })
  expect([f.steer, f.followup].map(spy => spy.mock.calls.length)).toEqual([0, 0])
})

it('tells whether the Session holds a message: one waiting in its inbox, one it took, and one in its stored history', async () => {
  const f = fixture()
  expect(await f.holds('request')).toBe(false)
  await f.send('request')
  expect(await f.holds('request')).toBe(true)
  f.consume(f.steer.mock.calls[0]![0])
  expect([f.inbox.nextStep.length, await f.holds('request')]).toEqual([0, true])
  const restored = fixture([f.steer.mock.calls[0]![0]])
  expect([await restored.holds('request'), await restored.holds('other')]).toEqual([true, false])
})

it('recognizes a delivery persisted only as an inbox splice, so a restart does not send it again', async () => {
  // DSH 0.2.2 logs a delivered message as `agent/inbox/spliced`; it never appears as `user/message` in the log.
  const sent = fixture()
  await sent.send('request')
  const message = sent.steer.mock.calls[0]![0]
  const restored = fixture([splicedEvent([message])])

  await restored.send('request')
  expect(restored.steer).not.toHaveBeenCalled()
  expect(restored.followup).not.toHaveBeenCalled()
  expect(await restored.holds('request')).toBe(true)
})

it('recognizes a live inbox splice once the history is loaded', async () => {
  const sent = fixture()
  await sent.send('request')
  const message = sent.steer.mock.calls[0]![0]

  // Loading the history first proves the live event, not a replayed log, is what marks the id.
  const f = fixture()
  expect(await f.holds('request')).toBe(false)
  f.consumeSpliced([message])
  expect(await f.holds('request')).toBe(true)
  await f.send('request')
  expect(f.steer).not.toHaveBeenCalled()
})

it('does not mark a delivery from a splice that only removes inbox messages', async () => {
  const f = fixture([splicedEvent([])])
  await f.send('request')
  expect(f.steer).toHaveBeenCalledOnce()
})

it('ignores malformed spliced payloads instead of failing the read', async () => {
  const notAnArray = { type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 0,
    data: { target: 'next-turn', start: 0, inserted: 'not-an-array' } } as unknown as SessionEvent
  const withoutSource = { type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 0,
    data: { target: 'next-turn', start: 0, inserted: [{ id: 'dsh-superagent:request', role: 'user', content: [] }] } } as unknown as SessionEvent
  const f = fixture([notAnArray, withoutSource])

  await f.send('request')
  expect(f.steer).toHaveBeenCalledOnce()
})
