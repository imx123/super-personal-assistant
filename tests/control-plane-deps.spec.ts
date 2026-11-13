import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', 'src')

function files(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : [])
}

describe('control-plane kernel dependency boundary', () => {
  it('does not import DSH or the plugin runtime from the kernel or the FakeNode', () => {
    // `node/host.ts` is the typed in-process boundary and may name the node classes; the fake must not.
    const kernel = [...files('control'), 'node/fake-node.ts']
    for (const file of kernel) {
      const source = readFileSync(join(root, file), 'utf8')
      expect(source, file).not.toMatch(/@deepseek-ai\//)
      expect(source, file).not.toMatch(/from '\.\.\/(app\/runtime|app\/sessions|executor|index)\.ts'/)
    }
  })

  it('keeps the FakeNode free of domain and app imports', () => {
    const source = readFileSync(join(root, 'node/fake-node.ts'), 'utf8')
    expect(source, 'node/fake-node.ts').not.toMatch(/from '\.\.\/(core|app|executor)\//)
  })
})
