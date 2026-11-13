/**
 * Runtime checks for a `NodeCommand`, and the one refusal a node reports when a command never reaches its backend.
 *
 * A command that crossed HTTP or a process boundary is no longer a TypeScript value: its discriminated union and field
 * types are gone, so the node checks the shape it was promised instead of executing a half-formed command. These checks
 * only prove a command is well formed; the port and its host stay the authority on whether it applies to them.
 */
import { NODE_PROTOCOL_VERSION, type NodeCommand } from '../shared/protocol.ts'

/** Why a node refused a command; `execution-failed` is the node's fault, the other three are the caller's. */
export type NodeCommandErrorCode =
  | 'unsupported-protocol-version'
  | 'unknown-command'
  | 'invalid-command'
  | 'execution-failed'

/**
 * A command a node refused.
 *
 * `code` is what a transport maps onto a status: an unknown command or an unsupported protocol version is a bad request,
 * an invalid field is unprocessable, and a failed execution is the node's own error. `cause` keeps the backend error that
 * made an execution fail.
 */
export class NodeCommandError extends Error {
  constructor(readonly code: NodeCommandErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'NodeCommandError'
  }
}

const BACKENDS: ReadonlySet<string> = new Set(['dsh', 'claude', 'codex'])

/** Validates one command's envelope and the fields its `type` requires, and reports the refusal a node would give. */
export function validateNodeCommand(value: unknown): NodeCommand {
  const command = record(value, 'command')
  if (command.protocolVersion !== NODE_PROTOCOL_VERSION) {
    throw new NodeCommandError('unsupported-protocol-version',
      `Unsupported protocol version: ${String(command.protocolVersion)}`)
  }
  const type = identifier(command, 'type', 'command')
  identifier(command, 'nodeId', 'command')
  identifier(command, 'idempotencyKey', 'command')
  stringField(command, 'at', 'command')

  switch (type) {
    case 'node.register': {
      const path = 'node.register.registration'
      const registration = record(command.registration, path)
      if (registration.protocolVersion !== NODE_PROTOCOL_VERSION) {
        throw new NodeCommandError('unsupported-protocol-version',
          `Unsupported protocol version: ${String(registration.protocolVersion)}`)
      }
      identifier(registration, 'nodeId', path)
      backendField(registration, 'backend', path)
      stringField(registration, 'version', path)
      optionalStringArray(registration, 'capabilities', path)
      break
    }

    case 'node.heartbeat': {
      const path = 'node.heartbeat.status'
      const status = record(command.status, path)
      identifier(status, 'nodeId', path)
      backendField(status, 'backend', path)
      stringField(status, 'version', path)
      booleanField(status, 'online', path)
      stringField(status, 'at', path)
      optionalStringArray(status, 'capabilities', path)
      break
    }

    case 'project.bind':
    case 'workspace.ensure':
      identifier(command, 'projectId', type)
      identifier(command, 'workspace', type)
      break

    case 'pm.ensure':
      identifier(command, 'sessionId', type)
      identifier(command, 'workspace', type)
      identifier(command, 'sessionToken', type)
      stringField(command, 'prompt', type)
      projectField(command.project, `${type}.project`)
      profileField(command.profile, `${type}.profile`)
      break

    case 'worker.create':
      identifier(command, 'sessionId', type)
      identifier(command, 'projectId', type)
      identifier(command, 'assignmentId', type)
      identifier(command, 'ticketId', type)
      identifier(command, 'workspace', type)
      identifier(command, 'sessionToken', type)
      stringField(command, 'prompt', type)
      profileField(command.profile, `${type}.profile`)
      break

    case 'session.message':
      identifier(command, 'sessionId', type)
      stringField(command, 'text', type)
      break

    case 'session.cancel':
      identifier(command, 'sessionId', type)
      optionalString(command, 'reason', type)
      break

    case 'session.archive':
      identifier(command, 'sessionId', type)
      break

    case 'session.inspect':
      identifier(command, 'sessionId', type)
      break

    case 'permission.set':
      identifier(command, 'sessionId', type)
      identifier(command, 'permission', type)
      break

    default:
      // No TypeScript member covers this value, so a node that trusted the annotation would silently accept it.
      throw new NodeCommandError('unknown-command', `Unknown command type: ${type.slice(0, 64)}`)
  }

  return value as NodeCommand
}

function fieldPath(path: string, name: string): string {
  return path === '' ? name : `${path}.${name}`
}

function invalid(message: string): never {
  throw new NodeCommandError('invalid-command', message)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${path} must be a JSON object`)
  return value as Record<string, unknown>
}

function stringField(fields: Record<string, unknown>, name: string, path: string): string {
  const value = fields[name]
  if (typeof value !== 'string') invalid(`${fieldPath(path, name)} must be a string`)
  return value
}

/** A string that identifies something: an empty one names nothing and is refused. */
function identifier(fields: Record<string, unknown>, name: string, path: string): string {
  const value = stringField(fields, name, path)
  if (value === '') invalid(`${fieldPath(path, name)} must not be empty`)
  return value
}

function optionalString(fields: Record<string, unknown>, name: string, path: string): void {
  if (fields[name] !== undefined) stringField(fields, name, path)
}

function stringArray(fields: Record<string, unknown>, name: string, path: string): readonly string[] {
  const value = fields[name]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    invalid(`${fieldPath(path, name)} must be an array of strings`)
  }
  return value as string[]
}

function optionalStringArray(fields: Record<string, unknown>, name: string, path: string): void {
  if (fields[name] !== undefined) stringArray(fields, name, path)
}

function booleanField(fields: Record<string, unknown>, name: string, path: string): boolean {
  const value = fields[name]
  if (typeof value !== 'boolean') invalid(`${fieldPath(path, name)} must be a boolean`)
  return value
}

function backendField(fields: Record<string, unknown>, name: string, path: string): void {
  const value = fields[name]
  if (typeof value !== 'string' || !BACKENDS.has(value)) {
    invalid(`${fieldPath(path, name)} must be one of ${[...BACKENDS].join(', ')}`)
  }
}

function projectField(value: unknown, path: string): void {
  const project = record(value, path)
  identifier(project, 'id', path)
  stringField(project, 'title', path)
  stringField(project, 'goal', path)
}

function profileField(value: unknown, path: string): void {
  const profile = record(value, path)
  identifier(profile, 'name', path)
  stringField(profile, 'prompt', path)
  stringArray(profile, 'tools', path)
  stringArray(profile, 'deny', path)
  identifier(profile, 'permission', path)
  optionalString(profile, 'model', path)
}
