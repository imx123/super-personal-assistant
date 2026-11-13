/** Standalone control-plane entry point. It knows nothing about DSH. */
import { startControlPlane } from './start.ts'

async function main(): Promise<void> {
  const started = await startControlPlane()
  const stop = async () => {
    await started.close()
  }
  process.once('SIGINT', () => { void stop().then(() => process.exit(0)) })
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)) })
  process.stdout.write(`superagent control plane listening on ${started.address.url}\n`)
  await new Promise<void>(() => {})
}

main().catch(error => {
  process.stderr.write(`superagent control plane failed: ${error instanceof Error ? error.message : String(error)}\n`,
    () => process.exit(1))
  process.exitCode = 1
  // A broken stderr pipe must not leave a failed startup alive; an unref'd timer only fires if a handle remains.
  setTimeout(() => process.exit(1), 500).unref()
})
