import type { UserConfig } from 'vitest/config'
// `threads` avoids the Windows `spawn EPERM` failure of the default forks pool; `resolve.dedupe` shares one React instance.
export default { resolve: { dedupe: ['react', 'react-dom'] }, test: { pool: 'threads', include: ['tests/**/*.spec.{ts,tsx}'] } } satisfies UserConfig
