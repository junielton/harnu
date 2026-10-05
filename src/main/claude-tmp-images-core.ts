import { resolve, sep } from 'node:path'

/**
 * PURE shape matcher for Claude CLI's tmp pasted-image location (BUG-149):
 * `<os.tmpdir()>/claude-<uid>/<slug>/<session-uuid>/images/<n>.png`. No fs, no
 * electron — importable from the pure board/canvas cores (ADR-0001). The
 * realpath/symlink half lives in `claude-tmp-images.ts`.
 */

/** A session uuid: also the filename of the JSONL transcript (`sessions.ts`). */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Claude's sequential image filename: `1.png`, `2.png`, … — digits only. */
export const IMAGE_NAME_RE = /^\d+\.png$/i

export interface TmpImageMatch {
  slug: string
  uuid: string
  name: string
}

/**
 * Pure shape check: is `abs` exactly `<root>/<slug>/<uuid>/images/<digits>.png`?
 * `abs` is resolved first (collapses `..`), so an escape never matches. Does not
 * touch the filesystem — {@link confirmTmpImageSource} adds the realpath check.
 */
export function matchTmpImagePath(abs: string, root: string): TmpImageMatch | null {
  const normRoot = resolve(root)
  const normAbs = resolve(abs)
  if (!normAbs.startsWith(normRoot + sep)) return null
  const parts = normAbs.slice(normRoot.length + 1).split(sep)
  if (parts.length !== 4) return null
  const [slug, uuid, images, name] = parts
  if (!slug || slug === '.' || slug === '..') return null
  if (!UUID_RE.test(uuid)) return null
  if (images !== 'images') return null
  if (!IMAGE_NAME_RE.test(name)) return null
  return { slug, uuid, name }
}
