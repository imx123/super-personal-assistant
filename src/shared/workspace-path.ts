import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

function within(root: string, path: string): boolean {
  const difference = relative(root, path)
  return difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)
}

/** Resolves links in the existing part of a directory path, including Windows junctions. */
function resolveDirectory(path: string): string {
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    const parent = dirname(path)
    if (parent === path) throw new Error('The workspace drive is not available')
    return join(resolveDirectory(parent), basename(path))
  }
  const canonical = realpathSync.native(path)
  if (!statSync(canonical).isDirectory()) throw new Error('The workspace path must point to a directory')
  return canonical
}

/** Checks the local filesystem without creating anything, and keeps the configured directory name on the wire. */
export function workspaceDirectory(root: string, workspace: string, outside: string): string {
  const base = resolve(root)
  const target = resolve(base, workspace)
  if (!within(base, target) || !within(resolveDirectory(base), resolveDirectory(target))) throw new Error(outside)
  return target
}
