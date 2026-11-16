import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

type Environment = Record<string, string | undefined>
export type DeploymentScope = 'control' | 'node'

const FIELDS = {
  control: {
    SUPERAGENT_CONTROL_HOST: 'host', SUPERAGENT_CONTROL_PORT: 'port',
    SUPERAGENT_CONTROL_TOKEN: 'token', SUPERAGENT_CONTROL_VIEWER_TOKEN: 'optionalToken',
    SUPERAGENT_CONTROL_DB: 'path', SUPERAGENT_CONSOLE_DB: 'path', SUPERAGENT_CONSOLE_DIR: 'path',
    SUPERAGENT_WORKSPACE_ROOT: 'path', SUPERAGENT_CONSOLE_EVENT_ROWS: 'rows',
    SUPERAGENT_CONSOLE_EVENT_DAYS: 'days', SUPERAGENT_CONSOLE_AUDIT_DAYS: 'days',
    SUPERAGENT_SCHEDULER_OFFSET_MINUTES: 'offset',
  },
  node: {
    SUPERAGENT_NODE_URL: 'url', SUPERAGENT_CONTROL_URL: 'optionalUrl',
    SUPERAGENT_NODE_HOST: 'host', SUPERAGENT_NODE_PORT: 'port', SUPERAGENT_NODE_ID: 'text',
    SUPERAGENT_NODE_TOKEN: 'token', SUPERAGENT_NODE_ROOT: 'path',
    SUPERAGENT_NODE_MODEL_PROVIDER: 'optionalText', SUPERAGENT_NODE_MODEL: 'optionalText',
    SUPERAGENT_NODE_REASONING_EFFORT: 'optionalText',
  },
} as const

export type DeploymentField = keyof typeof FIELDS.control | keyof typeof FIELDS.node
type Values = Partial<Record<DeploymentField, string>>
interface Profile { revision: string; values: Values }

export interface DeploymentView {
  file: string
  revision: string
  values: Values
  credentials: Partial<Record<DeploymentField, boolean>>
  /** Saved values that differ from what this control-plane process loaded. */
  pending: DeploymentField[]
  sharedNodeFile: boolean
}

export class DeploymentError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function rules(scope: DeploymentScope): Record<string, string> { return FIELDS[scope] }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(field: string): never { throw new DeploymentError(400, `配置值无效：${field}`) }

function validUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

function validateValues(scope: DeploymentScope, input: unknown): Values {
  if (!isObject(input)) throw new DeploymentError(400, '配置必须是对象。')
  const allowed = rules(scope)
  const values: Values = {}
  for (const [name, raw] of Object.entries(input)) {
    const rule = Object.hasOwn(allowed, name) ? allowed[name] : undefined
    if (!rule || typeof raw !== 'string') {
      throw new DeploymentError(400, '包含未知字段或不受支持的值类型。')
    }
    const value = raw.trim()
    const number = Number(value)
    const integer = /^-?\d+$/.test(value) && Number.isSafeInteger(number)
    if (raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) invalid(name)
    if (!value && !rule.startsWith('optional')) invalid(name)
    if (rule === 'path' && !isAbsolute(value)) invalid(name)
    if (rule === 'host' && !/^[a-zA-Z0-9.-]+$/.test(value)) invalid(name)
    if ((rule === 'url' || rule === 'optionalUrl') && value && !validUrl(value)) invalid(name)
    if (rule === 'port' && (!integer || number < 0 || number > 65535)) invalid(name)
    if (rule === 'offset' && (!integer || number < -720 || number > 840)) invalid(name)
    if ((rule === 'rows' || rule === 'days') && (!integer || number < (rule === 'rows' ? 1 : 0) || number > 1_000_000)) invalid(name)
    if ((rule === 'token' || rule === 'optionalToken') && value && !/^[!-~]{16,256}$/.test(value)) invalid(name)
    values[name as DeploymentField] = value
  }
  return values
}

export function loadDeployment(scope: DeploymentScope, file: string): Profile {
  let source: string
  try { source = readFileSync(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: '', values: {} }
    throw new DeploymentError(500, '无法读取部署配置文件。')
  }
  try {
    const data: unknown = JSON.parse(source)
    if (!isObject(data) || typeof data.revision !== 'string') throw new Error('Invalid deployment file')
    return { revision: data.revision, values: validateValues(scope, data.values) }
  } catch {
    throw new DeploymentError(500, '部署配置文件格式有误。')
  }
}

/** A startup snapshot and its separately staged overrides. Credential values never enter the HTTP view. */
export class DeploymentSettings {
  readonly active: Environment
  readonly overrides: Values

  constructor(private readonly scope: DeploymentScope, private readonly file: string, private readonly defaults: Environment,
    private readonly sharedNodeFile: boolean, private readonly check: (values: Environment) => void) {
    this.overrides = loadDeployment(scope, file).values
    this.active = { ...defaults, ...this.overrides }
  }

  view(profile = loadDeployment(this.scope, this.file)): DeploymentView {
    const next = { ...this.defaults, ...profile.values }
    const values: DeploymentView['values'] = {}
    const credentials: DeploymentView['credentials'] = {}
    const pending: DeploymentField[] = []
    for (const [key, rule] of Object.entries(rules(this.scope))) {
      const name = key as DeploymentField
      if (rule.toLowerCase().endsWith('token')) credentials[name] = Boolean(next[name])
      else values[name] = next[name] ?? ''
      if (next[name] !== this.active[name]) pending.push(name)
    }
    return { file: this.file, revision: profile.revision, values, credentials, pending, sharedNodeFile: this.sharedNodeFile }
  }

  save(input: Record<string, unknown>): DeploymentView {
    const previous = loadDeployment(this.scope, this.file)
    if (input.revision !== previous.revision) throw new DeploymentError(409, '部署配置已更新，请重新读取后再修改。')
    const patch = validateValues(this.scope, input.changes)
    const values = { ...previous.values, ...patch }
    this.check({ ...this.defaults, ...values })
    const profile = { revision: randomUUID(), values }
    const temporary = `${this.file}.${profile.revision}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      writeFileSync(temporary, JSON.stringify(profile, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      renameSync(temporary, this.file)
    } catch {
      try { rmSync(temporary, { force: true }) } catch { /* retain the original write error */ }
      throw new DeploymentError(500, '无法保存部署配置，请检查控制面进程对配置目录的写权限。')
    }
    return this.view(profile)
  }
}
