/**
 * Sidebar folder label derivation (T52). Precedence, first match wins:
 *   1. custom alias — the user's explicit rename (any `alias` that isn't just the
 *      directory basename).
 *   2. branch — when auto-alias (`preferBranch`) is on, the folder has a
 *      `gitBranch`, and that branch differs from the basename (so a worktree
 *      whose dir-name lies about its branch reads as the branch).
 *   3. basename — the directory name (the default).
 *
 * `folder.alias` (from `mergeFolders`) is ALWAYS populated (defaults to the
 * basename), so "no custom override" can only be detected structurally, as
 * `alias === basename(path)`. That also makes the rename-reset flow work: resetting
 * writes the basename back as the alias, which this reads as "no override" — so
 * the folder falls back to basename (or its branch when auto-alias is on).
 *
 * Pure + framework-free → unit-tested in isolation.
 */

/** Cross-platform basename (renderer may run on Linux / macOS / Windows). */
export function basename(p: string): string {
  if (!p) return ''
  return (
    p
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? ''
  )
}

/** The minimal folder shape `displayAlias` reads. */
export interface AliasFolder {
  path: string
  alias: string
  gitBranch?: string
}

export function displayAlias(folder: AliasFolder, preferBranch: boolean): string {
  const base = basename(folder.path)
  if (folder.alias && folder.alias !== base) return folder.alias
  if (preferBranch && folder.gitBranch && folder.gitBranch !== base) return folder.gitBranch
  return folder.alias || base
}
