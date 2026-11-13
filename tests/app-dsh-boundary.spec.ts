/** Phase 1B-3a: the control plane's resources, Session tools and archive reconciler name no DSH type or DSH executor. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', 'src')
/** The control-plane files this phase moved off DSH types and off `executor/dsh.ts`. */
const controlPlane = ['app/resources.ts', 'app/tools/main.ts', 'app/tools/executor.ts', 'app/archive-reconcile.ts']
/** The DSH-free helpers those files now share. */
const helpers = ['app/tool-messages.ts', 'app/session-view.ts']

describe('control-plane DSH boundary', () => {
  it('keeps the resources, Session tools and archive reconciler free of DSH imports', () => {
    for (const file of controlPlane) {
      const source = readFileSync(join(root, file), 'utf8')
      expect(source, file).not.toMatch(/@deepseek-ai\//)
      expect(source, file).not.toMatch(/executor\/dsh/)
    }
  })

  it('keeps the DSH-free helpers free of DSH imports', () => {
    for (const file of helpers) {
      const source = readFileSync(join(root, file), 'utf8')
      expect(source, file).not.toMatch(/@deepseek-ai\//)
      expect(source, file).not.toMatch(/executor\/dsh/)
    }
  })
})
