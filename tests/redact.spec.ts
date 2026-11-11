/** Redaction of diagnostics that outlive the server log: credentials, request data and machine paths. */
import { describe, expect, it } from 'vitest'
import { resolveDeployment } from '../src/deployment.ts'
import { redact, redactError, redactValues } from '../src/infra/redact.ts'
import { SetupError } from '../src/setup.ts'
import { testMachine } from './fixtures/deployment.ts'

describe('redact', () => {
  it('removes a credential printed by a CLI but keeps the failure category', () => {
    const text = redact('gh: Bad credentials (HTTP 401); token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    expect(text).toBe('gh: Bad credentials (HTTP 401); token=[redacted]')
    expect(redact('gh: Not Found (HTTP 404)')).toBe('gh: Not Found (HTTP 404)')
    expect(redact('lark-cli: app secret is abc12345')).toBe('lark-cli: app secret is [redacted]')
  })
  it('removes query values from a request URL', () => {
    expect(redact('GET https://api.feishu.cn/open-apis/bot/v3/info?access_token=t-abc123&page=2 failed'))
      .toBe('GET https://api.feishu.cn/open-apis/bot/v3/info?access_token=[redacted]&page=[redacted] failed')
    expect(redact('https://user:password@example.com/x')).toBe('https://[redacted]@example.com/x')
  })
  it('removes absolute filesystem paths on both platforms and in file URLs', () => {
    expect(redact('lark-cli: /home/me/.config/lark/config.json: permission denied'))
      .toBe('lark-cli: <path>: permission denied')
    expect(redact('gh: C:\\Users\\Max\\.config\\gh\\hosts.yml: not found')).toBe('gh: <path>: not found')
    expect(redact('open file:///C:/Users/Max/secret.txt')).toBe('open file://<path>')
    // Relative paths, prose slashes and IP addresses stay readable.
    expect(redact('and/or a/b, connect ECONNREFUSED 127.0.0.1:443')).toBe('and/or a/b, connect ECONNREFUSED 127.0.0.1:443')
  })
  it('keeps authorization headers and bearer values out of prose and JSON', () => {
    expect(redact('authorization: Bearer abcdef123456')).toBe('authorization: [redacted]')
    expect(redact('{"password":"hunter2","message":"bad token abc123"}')).toBe('{"password":"[redacted]","message":"bad token [redacted]"}')
  })
  it('is idempotent so a stored diagnostic can be redacted again', () => {
    const once = redact('token=abc123 at /home/me/x https://x/y?token=z')
    expect(redact(once)).toBe(once)
  })
  it('redacts an error message, not its stack', () => {
    expect(redactError(new Error('failed for https://x/y?token=z at /srv/work'))).toBe('failed for https://x/y?token=[redacted] at <path>')
    expect(redactError('plain failure')).toBe('plain failure')
  })
  it('redacts each value in a record', () => {
    expect(redactValues({ block: 'eval', error: 'token=abc123', count: '3' }))
      .toEqual({ block: 'eval', error: 'token=[redacted]', count: '3' })
  })
})

describe('SetupError', () => {
  it('stores only the redacted CLI output in the problem the panel and state snapshots read', () => {
    const problem = new SetupError('feishuCliFailed', { output: 'lark-cli: token=abc123 at /home/me/.config/lark' }).problem
    expect(problem.values.output).toBe('lark-cli: token=[redacted] at <path>')
    expect(problem.detail).toContain('The bot lark-cli does not work.')
    expect(problem.detail).not.toContain('abc123')
    expect(problem.detail).not.toContain('/home/me')
  })
  it('keeps structured operator-facing values, which localize the problem', () => {
    const problem = new SetupError('repositoryReadOnly', { account: 'agent-bot', repository: 'acme/widgets' }).problem
    expect(problem.values).toEqual({ account: 'agent-bot', repository: 'acme/widgets' })
    expect(problem.detail).toBe('@agent-bot cannot push to acme/widgets.')
  })
  it('redacts what a failing account CLI printed when setup records its problem', async () => {
    const leaky = async (): Promise<string> => {
      throw new Error('gh: Bad credentials (HTTP 401) token=abc123 GET https://api.github.com/user?access_token=z at /home/me/.config/gh/hosts.yml')
    }
    // An absolute executable lets setup reach the probe without a real CLI; the probe throws the diagnostic.
    const error = await resolveDeployment(testMachine(), { repository: 'acme/widgets', cli: process.execPath }, leaky, '')
      .catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(SetupError)
    const problem = (error as SetupError).problem
    expect(problem).toMatchObject({ place: 'github', code: 'agentCliSignedOut' })
    expect(problem.values.output).toContain('gh: Bad credentials (HTTP 401)')
    expect(problem.values.output).not.toContain('abc123')
    expect(problem.values.output).not.toContain('access_token=z')
    expect(problem.values.output).not.toContain('/home/me')
    expect(problem.detail).not.toContain('abc123')
  })
})
