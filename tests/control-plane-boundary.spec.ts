import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { Runtime } from '../src/app/runtime.ts'
import type { ControlPlaneHost } from '../src/control/host.ts'
import type { NodeHost } from '../src/node/host.ts'

const root = join(import.meta.dirname, '..', 'src')

describe('in-process Phase 1B boundary', () => {
  it('makes the control plane own Store and Engine, and Runtime only attach them', () => {
    const source = readFileSync(join(root, 'app/runtime.ts'), 'utf8')
    expect(source).toMatch(/new ControlPlaneOwner\(/)
    expect(source).not.toMatch(/new Store\(/)
    expect(source).not.toMatch(/new Engine\(/)
  })

  it('keeps every other domain constructor out of the node side', () => {
    for (const file of ['app/sessions.ts', 'executor/dsh.ts']) {
      const source = readFileSync(join(root, file), 'utf8')
      expect(source, file).not.toMatch(/new Store\(/)
      expect(source, file).not.toMatch(/new Engine\(/)
    }
  })

  it('has Runtime implement both sides of the boundary', () => {
    expectTypeOf<Runtime>().toMatchTypeOf<ControlPlaneHost & NodeHost>()
  })
})
