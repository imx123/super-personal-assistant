/** Standalone execution-node entry point. It hosts a FakeNode until the real DSH adapter lands in Phase 2. */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { FakeNode } from './fake-node.ts'
import { startNodeHttpServer } from './http-server.ts'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function port(): number {
  const value = process.env.SUPERAGENT_NODE_PORT
  if (value === undefined || value === '') return 0
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('SUPERAGENT_NODE_PORT is invalid')
  return port
}

async function main(): Promise<void> {
  const token = required('SUPERAGENT_NODE_TOKEN')
  const nodeId = process.env.SUPERAGENT_NODE_ID ?? 'local'
  const root = resolve(process.env.SUPERAGENT_NODE_ROOT ?? join(process.cwd(), '.superagent-node'))
  const host = process.env.SUPERAGENT_NODE_HOST ?? '127.0.0.1'
  mkdirSync(root, { recursive: true, mode: 0o700 })

  const node = new FakeNode({ nodeId, root })
  const server = await startNodeHttpServer({ node, token, host, port: port() })

  const stop = async () => {
    await server.close().catch(() => {})
  }
  process.once('SIGINT', () => { void stop().then(() => process.exit(0)) })
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)) })
  process.stdout.write(`superagent node ${nodeId} listening on ${server.url}\n`)
  await new Promise<void>(() => {})
}

main().catch(error => {
  process.stderr.write(`superagent node failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
