/** The package manifest: the build hooks that make a clean clone loadable, and the files a pack must contain. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
interface Manifest {
  main: string
  types: string
  bin: Record<string, string>
  exports: Record<string, string | { types?: string; default?: string }>
  files: string[]
  scripts: Record<string, string>
}
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest
const built = ['lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'lib/github-watch.js', 'lib/github-watch.d.ts',
  'lib/feishu-watch.js', 'lib/feishu-watch.d.ts']
const shipped = ['cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'LICENSE', 'LICENSE-MIT', 'NOTICE',
  'README.md', 'scripts/dsh-superagent', 'examples/profile.cordis.patch.yml']

describe('package', () => {
  it('builds before packing and installing from source', () => {
    expect(manifest.scripts.build).toBe('tsdown')
    // `prepare` builds a clone or a git dependency after its dev dependencies are installed; `prepack` builds a `pnpm pack`/`pnpm publish` tarball.
    expect(manifest.scripts.prepare).toBe(manifest.scripts.build)
    expect(manifest.scripts.prepack).toBe(manifest.scripts.build)
  })
  it('keeps the deployment files the documentation tells an operator to run', () => {
    expect(manifest.files).toEqual(expect.arrayContaining(['scripts', 'examples']))
    // Package managers mark `bin` entries executable in the tarball; other files stay 0644.
    expect(manifest.bin).toEqual({ 'dsh-superagent': './scripts/dsh-superagent' })
  })
  it('ships the built entry points and the static files a package needs', () => {
    for (const path of [...built, ...shipped]) expect(existsSync(join(ROOT, path)), path).toBe(true)
  })
  it('has every declared entry point resolve to a shipped file', () => {
    const targets = (value: Manifest['exports'][string]): string[] => typeof value === 'string'
      ? [value] : [value.types, value.default].filter((path): path is string => Boolean(path))
    const paths = [manifest.main, manifest.types, ...Object.values(manifest.exports).flatMap(targets)]
    for (const path of paths.filter(path => !path.includes('*'))) expect(existsSync(join(ROOT, path)), path).toBe(true)
    // The one wildcard export: every locale file it names must exist.
    expect(readdirSync(join(ROOT, 'locale')).filter(name => name.endsWith('.json')).length).toBeGreaterThan(0)
  })
  it('keeps the service script executable in a Unix checkout', () => {
    // Windows does not carry the mode bits; the git index mode is what a Unix clone restores.
    if (process.platform === 'win32') return
    expect(statSync(join(ROOT, 'scripts/dsh-superagent')).mode & 0o111).not.toBe(0)
  })
})
