import { join } from 'node:path'
import { readdir, realpath } from 'node:fs/promises'
import { IMAGE_NAME_RE, UUID_RE, matchTmpImagePath } from './claude-tmp-images-core'

export { IMAGE_NAME_RE, UUID_RE, matchTmpImagePath } from './claude-tmp-images-core'
export type { TmpImageMatch } from './claude-tmp-images-core'

/**
 * Pasted-image location used by newer Claude Code CLIs (BUG-149):
 *
 *   `<os.tmpdir()>/claude-<uid>/<project-slug>/<session-uuid>/images/<n>.png`
 *
 * Older CLIs wrote `~/.claude/image-cache/<session-uuid>/<n>.png` (see
 * `image-cache.ts`); Harnu reads BOTH.
 *
 * SECURITY: `<tmpdir>/claude-<uid>` is shared with every session's scratchpad
 * (`…/<slug>/<uuid>/scratchpad/…`), so nothing here ever opens the whole tree.
 * Only the exact shape `<root>/<slug>/<uuid>/images/<digits>.png` is accepted,
 * checked on the realpath (lesson security/001 — traversal, symlink escape).
 *
 * The pure shape matcher lives in `claude-tmp-images-core.ts` (importable from
 * the pure board/canvas cores); this file adds the thin `fs` half. Electron-free.
 *
 * The slug is NOT re-derived from a cwd: the session uuid is globally unique, so
 * the session's `images/` dir is found by scanning the (few) slug dirs. That
 * keeps the lookup lossless (the cwd→slug encode is many-to-one) and needs no
 * cwd threaded through IPC.
 */

/**
 * `<tmp>/claude-<uid>`. Injectable for tests. `null` when the platform has no
 * uid (win32) — the tmp location is then simply not consulted.
 */
export function claudeTmpRoot(
  tmp: string,
  uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null
): string | null {
  return uid === null ? null : join(tmp, `claude-${uid}`)
}

/**
 * Realpath-confine a candidate: both the root and the candidate are
 * `realpath`ed, and the REAL candidate must still match the exact shape under
 * the REAL root. Refuses a symlinked file/`images` dir/slug dir pointing outside
 * (or into the scratchpad) and a missing file. Returns the real path to read, or
 * null. Never throws.
 */
export async function confirmTmpImageSource(abs: string, root: string): Promise<string | null> {
  try {
    const [realAbs, realRoot] = await Promise.all([realpath(abs), realpath(root)])
    return matchTmpImagePath(realAbs, realRoot) ? realAbs : null
  } catch {
    return null
  }
}

/**
 * The `images/` dir(s) holding `uuid`'s pastes — one per slug dir that has the
 * session (normally exactly one). A dir whose realpath is not exactly
 * `<realRoot>/<slug>/<uuid>/images` (symlink escape) is dropped. Never throws.
 */
export async function findTmpImageDirs(root: string, uuid: string): Promise<string[]> {
  if (!UUID_RE.test(uuid)) return []
  let slugs: string[]
  let realRoot: string
  try {
    realRoot = await realpath(root)
    slugs = await readdir(root)
  } catch {
    return []
  }
  const found = await Promise.all(
    slugs.map(async (slug): Promise<string | null> => {
      const dir = join(root, slug, uuid, 'images')
      try {
        const real = await realpath(dir)
        return real === join(realRoot, slug, uuid, 'images') ? dir : null
      } catch {
        return null
      }
    })
  )
  return found.filter((d): d is string => d !== null).sort()
}

/**
 * Resolve `<uuid>/<name>` to a real, confined file under the tmp root, or null.
 * `name` must be `<digits>.png` (no separators) before any fs touch.
 */
export async function resolveTmpImageFile(
  root: string,
  uuid: string,
  name: string
): Promise<string | null> {
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) return null
  if (typeof name !== 'string' || !IMAGE_NAME_RE.test(name)) return null
  for (const dir of await findTmpImageDirs(root, uuid)) {
    const real = await confirmTmpImageSource(join(dir, name), root)
    if (real !== null) return real
  }
  return null
}
