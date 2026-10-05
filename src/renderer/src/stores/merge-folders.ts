import type { FolderEntry, GitMeta, TrackedWorktreeWire, UserProject } from '../../../preload'
import type { Folder } from './sessions'

/**
 * A `UserProject` that may additionally carry persisted git metadata
 * (`repoId` / `gitBranch` / `isMainWorktree`).
 *
 * The on-disk schema (`user-projects.ts`) doesn't declare these fields yet, but
 * a future writer can stamp them onto the record so a pinned folder's repo
 * grouping survives a reload WITHOUT depending on the volatile per-cwd probe Map
 * (which only covers paths Claude has actually written a `sessions-index.json`
 * under). Reading them here is defensive: an absent field simply doesn't enrich
 * the resulting folder. The git fields are all optional, so a plain
 * `UserProject` is assignable to this type.
 */
export type PersistedUserProject = UserProject & GitMeta

/**
 * Copy only the DEFINED git fields off a source into a fresh `GitMeta`, mirroring
 * `buildFolderEntry` in `folder-model.ts`: an omitted field never lands as an
 * explicit `undefined` key, so callers can rely on `'repoId' in folder === false`
 * when it's absent. Returns `undefined` when no git field is present at all.
 */
export function pickGitMeta(src: GitMeta): GitMeta | undefined {
  const meta: GitMeta = {}
  if (src.repoId !== undefined) meta.repoId = src.repoId
  if (src.gitBranch !== undefined) meta.gitBranch = src.gitBranch
  if (src.isMainWorktree !== undefined) meta.isMainWorktree = src.isMainWorktree
  return meta.repoId !== undefined ||
    meta.gitBranch !== undefined ||
    meta.isMainWorktree !== undefined
    ? meta
    : undefined
}

/**
 * Map a `UserProject` (the on-disk user-intent record) into a sidebar-shaped
 * pinned `Folder`. Used when there is no disk-derived counterpart for the
 * path (added but Claude hasn't written here yet). Sessions start empty —
 * they arrive once Claude writes a `sessions-index.json`, at which point the
 * disk side of `mergeFolders()` takes over.
 *
 * `up.worktrees` is vestigial in the folder model (spec §4.3) — never read.
 *
 * Git enrichment (folder-first repo grouping): a placeholder is normally
 * un-grouped because the per-folder git probe never ran for a path Claude
 * hasn't written under — so it can't collapse with its sibling worktrees. We
 * close that gap from two sources, in order:
 *   1. the optional `gitByPath` probe Map (volatile, this-run only); then
 *   2. git meta PERSISTED on the record itself (so grouping survives a reload
 *      WITHOUT the Map).
 * When neither yields git fields the folder stays an ungrouped standalone.
 */
export function userProjectToFolder(
  up: PersistedUserProject,
  gitByPath?: Map<string, GitMeta>
): Folder {
  const folder: Folder = {
    path: up.path,
    alias: up.alias,
    sessions: [],
    expanded: false,
    pinned: true,
    ...(up.bornFrom ? { bornFrom: up.bornFrom } : {})
  }
  const fromMap = gitByPath?.get(up.path)
  // Volatile probe wins when it has git fields; otherwise fall back to whatever
  // git meta was persisted on the record.
  const git = (fromMap && pickGitMeta(fromMap)) ?? pickGitMeta(up)
  if (git) {
    if (git.repoId !== undefined) folder.repoId = git.repoId
    if (git.gitBranch !== undefined) folder.gitBranch = git.gitBranch
    if (git.isMainWorktree !== undefined) folder.isMainWorktree = git.isMainWorktree
  }
  return folder
}

/** One tracked repo's current `git worktree list` (T388), as the store keeps it. */
export interface GitListing {
  repoId: string
  worktrees: TrackedWorktreeWire[]
}

/** Last path segment, either separator (a listing may carry a Windows path). */
function basenameAny(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

/**
 * Overlay worktree listings onto a folder list (T388, sidebar-liveness spec
 * §4.B B2). Every folder whose path is listed comes back as a copy with
 * `gitListed: true` — including folders that already have sessions — and gains
 * the listing's `repoId`/`isMainWorktree` when it had none, so it groups under
 * its repo. Each listed path with no folder becomes a sessionless placeholder.
 * Paths are already reconciled by main (D9), so matching is exact-string.
 * Never mutates the input; returns it as-is when there is nothing to apply.
 */
export function applyGitListings(
  folders: Folder[],
  listed: ReadonlyArray<GitListing> | undefined
): Folder[] {
  if (!listed || listed.length === 0) return folders
  const byPath = new Map<string, { repoId: string; wt: TrackedWorktreeWire }>()
  for (const l of listed) {
    for (const wt of l.worktrees)
      if (!byPath.has(wt.path)) byPath.set(wt.path, { repoId: l.repoId, wt })
  }
  if (byPath.size === 0) return folders
  const out = folders.map((f) => {
    const hit = byPath.get(f.path)
    if (!hit) return f
    const flagged: Folder = { ...f, gitListed: true }
    if (flagged.repoId === undefined) {
      flagged.repoId = hit.repoId
      flagged.isMainWorktree = hit.wt.isMainWorktree
    }
    return flagged
  })
  const present = new Set(folders.map((f) => f.path))
  for (const [path, { repoId, wt }] of byPath) {
    if (present.has(path)) continue
    const placeholder: Folder = {
      path,
      alias: basenameAny(path),
      sessions: [],
      expanded: false,
      pinned: false,
      repoId,
      isMainWorktree: wt.isMainWorktree,
      gitListed: true
    }
    if (wt.branch) placeholder.gitBranch = wt.branch
    out.push(placeholder)
  }
  return out
}

/**
 * Undo {@link applyGitListings} on a live folder list before re-applying newer
 * listings: drops the sessionless placeholders it injected (a git-listed,
 * unpinned, sessionless folder whose path is not in `basePaths` — the disk and
 * user-project paths of the last merge) and returns every other flagged folder
 * as a copy without `gitListed`. Never mutates the input.
 */
export function stripGitListings(folders: Folder[], basePaths: ReadonlySet<string>): Folder[] {
  const out: Folder[] = []
  for (const f of folders) {
    if (!f.gitListed) {
      out.push(f)
      continue
    }
    if (f.sessions.length === 0 && !f.pinned && !basePaths.has(f.path)) continue
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { gitListed, ...rest } = f
    out.push(rest)
  }
  return out
}

/**
 * Merge disk-derived `FolderEntry[]` (from `~/.claude/projects/`) with the
 * user-intent `UserProject[]` (from `<userData>/projects.json`). The union is
 * keyed by literal `path` equality.
 *
 * - A disk entry becomes a `Folder` with `pinned` = whether the user added
 *   its path, and `alias` = the user's alias override (if any) else the
 *   entry's basename alias.
 * - A user path with NO disk counterpart becomes an empty placeholder pinned
 *   `Folder` (never reads `up.worktrees`), enriched with git meta from the
 *   optional `gitByPath` probe Map or the persisted record (see
 *   `userProjectToFolder`) so it can group with its sibling worktrees.
 *
 * `gitByPath` is optional — omitting it preserves the legacy behavior exactly
 * (placeholders fall back to any git meta persisted on their record).
 *
 * `listed` (T388) is optional too: the current worktree listings of the repos
 * the sidebar shows, applied last through {@link applyGitListings}. Omitted,
 * no folder carries a `gitListed` key.
 *
 * Order: user-not-in-disk first, then disk (already activity-sorted), then
 * git-listed placeholders.
 */
export function mergeFolders(
  disk: FolderEntry[],
  userList: PersistedUserProject[],
  hiddenPaths: string[],
  gitByPath?: Map<string, GitMeta>,
  listed?: ReadonlyArray<GitListing>
): Folder[] {
  void hiddenPaths // hidden state is mirrored separately into manuallyHiddenPaths
  const userPaths = new Set(userList.map((u) => u.path))
  const userAlias = new Map(userList.map((u) => [u.path, u.alias]))
  // T191: `bornFrom` has no disk/git-probe counterpart — the on-disk `FolderEntry`
  // never carries it, so a disk-backed folder can only learn its lineage edge
  // from the matching `UserProject` record, keyed by path (mirrors `userAlias`).
  const userBornFrom = new Map(
    userList.filter((u) => u.bornFrom).map((u) => [u.path, u.bornFrom as string])
  )
  const diskByPath = new Map<string, FolderEntry>()
  for (const e of disk) diskByPath.set(e.path, e)

  const out: Folder[] = []

  // 1. User-added paths with no disk counterpart (placeholders), in order.
  for (const up of userList) {
    if (diskByPath.has(up.path)) continue
    out.push(userProjectToFolder(up, gitByPath))
  }

  // 2. Disk entries (activity-sorted), tagging pinned + alias override.
  for (const entry of disk) {
    const bornFrom = userBornFrom.get(entry.path)
    out.push({
      ...entry,
      expanded: false,
      pinned: userPaths.has(entry.path),
      alias: userAlias.get(entry.path) ?? entry.alias,
      ...(bornFrom ? { bornFrom } : {})
    })
  }

  // 3. Git-listed worktrees (T388): flag listed folders, inject placeholders.
  return applyGitListings(out, listed)
}
