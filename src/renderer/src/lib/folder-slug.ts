/**
 * Slug ⇄ folder resolution for the watcher's slug-keyed events.
 *
 * Claude stores each project under `~/.claude/projects/<slug>/` where `<slug>`
 * is the cwd with the leading separator stripped and every remaining `/`
 * replaced by `-`. The folder model, however, is keyed by the JSONL `cwd`
 * (finding 01 §2 — the slug derivation is lossy). Reversing a slug back to a
 * path is therefore unreliable: any path component containing a literal `-`
 * decodes to extra `/` segments and yields a path that does not exist.
 */

/**
 * Decode a Claude slug into the absolute path it was derived from. **Lossy**
 * whenever a path component contains a literal `-` — treat the result as a hint
 * and validate it against a known `folder.path` before acting on it. Returns
 * `null` for a slug that doesn't start with the leading-separator marker.
 */
export function decodeSlugToPath(slug: string): string | null {
  if (!slug.startsWith('-')) return null
  return '/' + slug.slice(1).replace(/-/g, '/')
}

/**
 * Encode an absolute path into the Claude project slug it is stored under
 * (`~/.claude/projects/<slug>/`). The **faithful forward direction** — unlike
 * {@link decodeSlugToPath}, which is irreversibly lossy.
 *
 * Claude derives the slug by replacing **every non-alphanumeric character** of
 * the cwd with `-`: `/`, `.`, `@`, spaces, underscores and any existing `-` all
 * collapse to `-`; case is preserved. Confirmed empirically against every real
 * slug dir on this machine — `/`, `.`, `@` and space were each observed mapping
 * to `-` (e.g. `/home/u/example.com.br/www` → `-home-u-example-com-br-www`,
 * `…/.claude/skills` → `…--claude-skills`), with zero mismatches across 49 dirs.
 *
 * Because the mapping is many-to-one (`a-b`, `a/b` and `a.b` all encode to
 * `a-b`), it can only be used to test a *known* candidate path against a slug —
 * never to recover the path from the slug.
 */
export function encodePathToSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Recover the owning slug from a session's JSONL `fullPath`
 * (`…/.claude/projects/<slug>/<sessionId>.jsonl`) — the parent directory name.
 * This is **lossless**: it reads the real on-disk slug rather than re-deriving
 * it. Returns `null` for an empty path (synthetic sessions carry `fullPath`
 * `''`). Tolerates both `/` and `\` separators.
 */
export function slugFromSessionPath(fullPath: string): string | null {
  if (!fullPath) return null
  const parts = fullPath.split(/[\\/]/).filter(Boolean)
  if (parts.length < 2) return null
  return parts[parts.length - 2] || null
}

/** Minimal structural shape this module needs from a folder. */
export interface SlugResolvableFolder {
  path: string
  sessions: ReadonlyArray<{ fullPath: string }>
}

/**
 * Resolve a watcher slug to the absolute path of the folder that owns it.
 *
 * Two **lossless** routes, in order:
 *  1. A folder holding any real session whose `fullPath` lives under `<slug>/`
 *     (all sessions in a folder share one slug, since they share one cwd).
 *  2. A folder whose path forward-encodes to the slug ({@link encodePathToSlug}).
 *     This resolves a brand-new folder that has no real session JSONL yet (only
 *     a synthetic placeholder) — **including dash-folders**, where the reverse
 *     {@link decodeSlugToPath} is lossy and used to leave a duplicated "New
 *     session" row (`docs/lessons/synthetic-sessions/003`). The forward encode
 *     mirrors Claude's exact rule, so a match means the folder genuinely owns
 *     the slug dir; it supersedes the old lossy-decode fallback.
 *
 * Returns `null` when no folder can be matched. (The encode is many-to-one, so
 * in the astronomically unlikely case of two candidate folders whose paths
 * differ only by `-` vs `/`/`.`, the first in iteration wins — route 1 already
 * disambiguates any folder that owns a real session.)
 */
export function resolveFolderPathBySlug(
  slug: string,
  folders: ReadonlyArray<SlugResolvableFolder>
): string | null {
  if (!slug) return null
  // Route 1 — match the folder whose real session JSONLs live under `<slug>/`.
  for (const f of folders) {
    for (const s of f.sessions) {
      if (s.fullPath && slugFromSessionPath(s.fullPath) === slug) return f.path
    }
  }
  // Route 2 — faithful forward-encode of each candidate folder's path.
  for (const f of folders) {
    if (encodePathToSlug(f.path) === slug) return f.path
  }
  return null
}
