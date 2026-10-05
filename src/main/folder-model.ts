import { basename } from 'node:path'
import type { SessionEntry } from './claude-reader'

/**
 * Pure shaping helpers that turn a flat `SessionEntry[]` into the per-folder
 * model the sidebar consumes. This module does **no** git probing, fs, or
 * child_process work — git metadata is *injected* as plain data (`GitMeta`)
 * by the caller. Every function is pure: it reads its inputs, returns NEW
 * arrays/maps, and never mutates what it was handed.
 */

/**
 * Git metadata for one folder, supplied by the caller (e.g. a `worktree.ts`
 * probe). Every field is optional: a folder outside a repo, or one we haven't
 * probed yet, simply omits them. Only the fields that are actually present are
 * copied onto the resulting `FolderEntry` (see `buildFolderEntry`).
 */
export interface GitMeta {
  gitBranch?: string
  repoId?: string
  isMainWorktree?: boolean
}

/**
 * One folder row for the sidebar: its absolute `path`, a display `alias`
 * (the path basename), the optional git fields (present only when known —
 * never emitted as explicit `undefined`), and the sessions that live in it.
 */
export interface FolderEntry {
  path: string
  alias: string
  gitBranch?: string
  repoId?: string
  isMainWorktree?: boolean
  sessions: SessionEntry[]
  /**
   * BUG-56 D5: whether `path` is confirmed to exist on disk right now, injected
   * as plain data by the impure shell (`claude-reader.ts`'s `existsSync` probe)
   * — never computed here. Omitted (not `false`) when the caller didn't probe,
   * so an older/partial caller round-trips without implying "gone".
   */
  diskExists?: boolean
}

/**
 * Group sessions by their `projectPath`, preserving first-seen insertion order
 * for the keys and input order for the sessions within each group. Returns a
 * fresh `Map`; the session objects are referenced as-is (not cloned).
 */
export function groupSessionsByFolder(sessions: SessionEntry[]): Map<string, SessionEntry[]> {
  const groups = new Map<string, SessionEntry[]>()
  for (const session of sessions) {
    const existing = groups.get(session.projectPath)
    if (existing) existing.push(session)
    else groups.set(session.projectPath, [session])
  }
  return groups
}

/**
 * Build one `FolderEntry` for `path`. The `alias` is `basename(path)`. Only the
 * *defined* fields of `git` are spread onto the entry, so an omitted (or
 * `undefined`) `repoId`/`gitBranch`/`isMainWorktree` never appears as a key —
 * callers can rely on `'repoId' in entry === false` when it's absent.
 */
export function buildFolderEntry(
  path: string,
  sessions: SessionEntry[],
  git?: GitMeta,
  diskExists?: boolean
): FolderEntry {
  const entry: FolderEntry = {
    path,
    alias: basename(path),
    sessions
  }
  if (git) {
    if (git.gitBranch !== undefined) entry.gitBranch = git.gitBranch
    if (git.repoId !== undefined) entry.repoId = git.repoId
    if (git.isMainWorktree !== undefined) entry.isMainWorktree = git.isMainWorktree
  }
  if (diskExists !== undefined) entry.diskExists = diskExists
  return entry
}

/**
 * Group `sessions` by folder, then build a `FolderEntry` per path — attaching
 * `gitByPath.get(path)` when present, or no git fields when absent. The grouped
 * (first-seen) order is preserved. Returns a new array.
 */
export function buildFolderEntries(
  sessions: SessionEntry[],
  gitByPath: Map<string, GitMeta>,
  diskExistsByPath?: Map<string, boolean>
): FolderEntry[] {
  const groups = groupSessionsByFolder(sessions)
  const entries: FolderEntry[] = []
  for (const [path, group] of groups) {
    entries.push(buildFolderEntry(path, group, gitByPath.get(path), diskExistsByPath?.get(path)))
  }
  return entries
}
