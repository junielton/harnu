/**
 * Real (symlink-free) paths for the MCP handlers that compare folders. The pure listing core
 * takes the resulting lookup, so it never touches the disk itself.
 */

import { promises as fs } from 'node:fs'
import { normalizePath } from './permission-core'

/**
 * A lookup from any of `paths` to its real path. A path that does not resolve (gone, or
 * unreadable) falls back to its normalized spelling, so a comparison stays lexical for it.
 * Paths given to the lookup that were not pre-read are normalized only.
 */
export async function realPathLookup(
  paths: Iterable<string | undefined>,
  home: string
): Promise<(p: string) => string> {
  const real = new Map<string, string>()
  await Promise.all(
    [...new Set([...paths].filter((p): p is string => !!p))].map(async (p) => {
      const key = normalizePath(p, home)
      try {
        real.set(key, normalizePath(await fs.realpath(key), home))
      } catch {
        real.set(key, key)
      }
    })
  )
  return (p) => {
    const key = normalizePath(p, home)
    return real.get(key) ?? key
  }
}
