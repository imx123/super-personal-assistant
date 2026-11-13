import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KernelOutbox, kernelAssessor, kernelExecutor, kernelPolicy, kernelScope } from '../src/control/domain.ts'
import { ControlPlaneOwner } from '../src/control/owner.ts'

let directory: string
let owner: ControlPlaneOwner | undefined

afterEach(() => {
  owner?.close()
  owner = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
})

describe('ControlPlaneOwner', () => {
  it('opens the Store before the Engine and attaches exactly one Engine', () => {
    directory = mkdtempSync(join(tmpdir(), 'superagent-owner-'))
    const control = owner = new ControlPlaneOwner({ dbPath: join(directory, 'orchestrator.sqlite') })
    expect(control.store).toBeTruthy()
    expect(() => control.engine).toThrow(/not attached/)

    const engine = control.attach({ policy: () => kernelPolicy, scope: kernelScope, assessor: kernelAssessor,
      executor: kernelExecutor, outbox: new KernelOutbox() })
    expect(control.engine).toBe(engine)
    expect(() => control.attach({ policy: () => kernelPolicy, scope: kernelScope, assessor: kernelAssessor,
      executor: kernelExecutor, outbox: new KernelOutbox() })).toThrow(/already has an Engine/)
  })
})
