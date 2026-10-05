import type { TaskState } from '../../../preload'

/**
 * Pure zone classification + repo grouping for the sidebar folder list.
 *
 * These helpers decide which "zone" a folder belongs to (pinned / active /
 * stale / hidden) and how same-repo worktrees collapse into a single
 * `RepoGroup` header. Everything here is a pure function: no I/O, no Pinia,
 * no mutation of the inputs — every grouping returns NEW arrays/objects so
 * the caller's source data stays untouched.
 *
 * Renderer code is sandbox-isolated, so we can't reach for `node:path`; the
 * `basename`/`dirname` helpers below are tiny `'/'`-split string ops mirroring
 * `AddFolderDialog.vue`'s `basename`.
 */

/** The four sidebar buckets a folder can land in. */
export type Zone = 'pinned' | 'active' | 'stale' | 'hidden'

/** One session as far as zoning cares — a thin slice of the real entry. */
interface ZoneSession {
  sessionId: string
  status: 'active' | 'idle' | 'archived'
  taskState?: TaskState
  modified: string
}

/** One folder/worktree as far as zoning cares. */
interface ZoneFolder {
  path: string
  pinned: boolean
  repoId?: string
  isMainWorktree?: boolean
  expanded?: boolean
  /** Custom sidebar label (T52). Lets a renamed MAIN worktree relabel its group. */
  alias?: string
  sessions: ZoneSession[]
  /**
   * BUG-56 D5: whether this folder's directory is confirmed to exist on disk
   * right now (mirrors `FolderEntry.diskExists`, main-process-probed).
   * `undefined` when not probed — never treated as gone.
   */
  diskExists?: boolean
  /**
   * T191: the folder whose session cut this worktree — the orchestrator.
   * Absolute path. Consumed by {@link nestByLineage}; absent means no mother.
   */
  bornFrom?: string
  /**
   * T388: `git worktree list` of a repo the sidebar shows reported this path
   * (sidebar-liveness spec §4.B B2/B3). Set by `mergeFolders` on every listed
   * folder, with or without sessions; such a folder always classifies active.
   */
  gitListed?: boolean
}

/**
 * Where a group's membership came from. `repo` — 2+ worktrees sharing a git
 * `repoId`; `path` — 2+ folders sharing a DIRECT parent directory. The two are
 * one node type on purpose: header rendering, the keyboard cursor, collapse
 * persistence, aliases, and drill-in all take a single code path (T182).
 */
export type GroupSource = 'repo' | 'path'

/**
 * Namespaced key for a group — what collapse state and aliases are stored under.
 * Repo and path keys are both absolute-ish paths, so the prefix is what keeps
 * them from colliding in the one persisted `Set`/record they share.
 */
export function groupKey(source: GroupSource, id: string): string {
  return `${source}:${id}`
}

/**
 * A synthetic header standing in for 2+ folders that belong together. Inserted
 * by `groupByRepo` (git worktrees of one repo) or `groupByParentDir` (folders
 * sharing a direct parent dir) at the position of the group's first member,
 * carrying the member folders so the sidebar can render them nested under it.
 *
 * The members are always plain folders — a group is never a member of another
 * group, which is what caps the sidebar at ONE level of indentation (T70's
 * anti-VS-Code rule, preserved).
 */
export interface FolderGroup<F extends ZoneFolder = ZoneFolder> {
  kind: 'folder-group'
  source: GroupSource
  /** The group key: the `repoId` for `repo`, the parent directory for `path`. */
  id: string
  /** `groupKey(source, id)` — the namespaced id for collapse state and aliases. */
  key: string
  /** Displayed label: the group alias, else the main worktree's, else derived. */
  label: string
  /** The basename-derived fallback label (no alias applied) — reset target + subtitle. */
  derivedLabel: string
  /**
   * A dim parent-dir cue set ONLY when 2+ groups in the same zone resolve to the
   * SAME `label` (T88) — e.g. two repos named `www` show `www · org-a` / `www · org-b`
   * so a collision is distinguishable. `undefined` when the label is unique.
   */
  parentHint?: string
  expanded: boolean
  folders: F[]
}

/** Type guard for a `FolderGroup` node in a mixed folder/group list. */
export function isFolderGroup<F extends ZoneFolder>(
  node: F | FolderGroup<F>
): node is FolderGroup<F> {
  return 'kind' in node && node.kind === 'folder-group'
}

/** Everything `classifyFolder` needs to decide a zone, supplied by the store. */
export interface ClassifyCtx {
  nowMs: number
  activeWindowMs: number
  hiddenPaths: Set<string>
  livePtySessionIds: Set<string>
}

/** Last `'/'`-delimited segment, trailing slashes stripped. */
function basename(p: string): string {
  if (!p) return ''
  return p.replace(/\/+$/, '').split('/').pop() ?? ''
}

/** Everything before the last `'/'` segment, trailing slashes stripped. */
function dirname(p: string): string {
  if (!p) return ''
  const trimmed = p.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx < 0) return ''
  if (idx === 0) return '/'
  return trimmed.slice(0, idx)
}

/**
 * A folder is "live" iff any of its sessions is currently doing something:
 * has a running PTY, is mid-task (`working` / `needs-input`), or is `active`.
 */
export function isLiveFolder(folder: ZoneFolder, livePtySessionIds: Set<string>): boolean {
  return folder.sessions.some(
    (s) =>
      livePtySessionIds.has(s.sessionId) ||
      s.taskState === 'working' ||
      s.taskState === 'needs-input' ||
      s.status === 'active'
  )
}

/**
 * Assign a folder to its zone — FIRST match wins, in this order:
 *   1. empty + not pinned + not git-listed -> stale  (nothing to keep around)
 *   2. path is hidden        -> hidden
 *   3. pinned                -> pinned
 *   4. git-listed (T388)     -> active (a worktree of a repo the list shows)
 *   5. confirmed gone from disk (not pinned) -> stale (BUG-56 D5)
 *   6. live OR a recently-modified session within the active window -> active
 *   7. otherwise             -> stale
 */
export function classifyFolder(folder: ZoneFolder, ctx: ClassifyCtx): Zone {
  if (folder.sessions.length === 0 && !folder.pinned && !folder.gitListed) return 'stale'
  if (ctx.hiddenPaths.has(folder.path)) return 'hidden'
  if (folder.pinned) return 'pinned'
  // T388: git just listed this worktree for a repo the sidebar shows — fresher
  // evidence than a session's age or a stale disk probe. The known-repo set that
  // decides which repos get listed ignores this flag (D3), so it never keeps a
  // repo alive on its own.
  if (folder.gitListed) return 'active'

  // BUG-56 D5: a folder whose directory is CONFIRMED gone can never classify
  // as 'active' — belt-and-suspenders alongside the explicit `removeGhostFolder`
  // callers (Reaper, manual Remove-worktree, the `remove_folder` MCP verb), so a
  // ghost can't resurface as active after an app restart re-scans
  // `~/.claude/projects/` before one of those callers gets to clean it up. Only
  // an EXPLICIT `false` counts — `undefined` (not probed) falls through
  // unaffected, and a PINNED folder already returned above regardless.
  if (folder.diskExists === false) return 'stale'

  if (isLiveFolder(folder, ctx.livePtySessionIds)) return 'active'

  const hasRecent = folder.sessions.some((s) => {
    const t = Date.parse(s.modified)
    return Number.isFinite(t) && ctx.nowMs - t <= ctx.activeWindowMs
  })
  if (hasRecent) return 'active'

  return 'stale'
}

/**
 * Give every group whose `label` collides with another group's a dim parent-dir
 * cue (T88) — two repos named `www` render `www · org-a` / `www · org-b` so the
 * collision stays readable before anyone renames either. Runs over ALL groups in
 * a list, repo and path alike, and CLEARS a stale hint when a label no longer
 * collides (a folder leaving the list can un-collide it).
 *
 * Mutates the group objects in place; they're freshly built by the grouping
 * functions and never shared with the caller's input.
 */
function applyParentHints<F extends ZoneFolder>(groups: Array<FolderGroup<F>>): void {
  const labelCounts = new Map<string, number>()
  for (const g of groups) labelCounts.set(g.label, (labelCounts.get(g.label) ?? 0) + 1)
  for (const g of groups) {
    if ((labelCounts.get(g.label) ?? 0) < 2) {
      delete g.parentHint
      continue
    }
    // For a repo group, the main worktree best represents "where this lives";
    // for a path group the id IS the directory, so hint with ITS parent.
    const hint =
      g.source === 'path'
        ? basename(dirname(g.id))
        : (() => {
            const rep = g.folders.find((m) => m.isMainWorktree === true) ?? g.folders[0]
            return rep ? basename(dirname(rep.path)) : ''
          })()
    if (hint) g.parentHint = hint
  }
}

/**
 * Collapse same-repo worktrees into `FolderGroup` headers (`source: 'repo'`).
 *
 * Input is the ALREADY-VISIBLE folders — this function never filters or drops
 * anything. A repoId (defined and non-empty) shared by 2+ folders forms one
 * group, placed at the position of its FIRST member. Folders with no repoId, or
 * a repoId held by only one folder, pass through unchanged at their original
 * position.
 *
 * Within a group the `isMainWorktree` folder comes first, the rest sorted
 * stably by path. The label resolves (T88) in order: the group alias
 * (`aliases['repo:<repoId>']`), else the MAIN worktree's own alias (so renaming the
 * main folder relabels the group for free), else the derived basename — the main
 * worktree's basename if present, else the basename of `dirname(repoId)`, else the
 * raw repoId. The un-aliased derived label is kept on `derivedLabel` (reset target).
 *
 * A group's `expanded` flag controls whether its member-folder ROWS are shown
 * (independent of each member's own session-list `expanded`). It is `true`
 * unless the group's NAMESPACED key is in `collapsedKeys` — a group is collapsed
 * ONLY by explicit user choice, so hiding the whole group is a distinct gesture
 * from expanding/collapsing an inner folder's sessions.
 */
export function groupByRepo<F extends ZoneFolder>(
  folders: F[],
  collapsedKeys?: ReadonlySet<string>,
  aliases?: Readonly<Record<string, string>>
): Array<F | FolderGroup<F>> {
  // Count members per defined, non-empty repoId.
  const counts = new Map<string, number>()
  for (const f of folders) {
    if (f.repoId) counts.set(f.repoId, (counts.get(f.repoId) ?? 0) + 1)
  }

  const out: Array<F | FolderGroup<F>> = []
  const emitted = new Set<string>()

  for (const f of folders) {
    const repoId = f.repoId
    const isGrouped = repoId !== undefined && repoId !== '' && (counts.get(repoId) ?? 0) >= 2

    if (!isGrouped) {
      out.push(f)
      continue
    }

    if (emitted.has(repoId)) continue
    emitted.add(repoId)

    const members = folders.filter((m) => m.repoId === repoId)
    const main = members.find((m) => m.isMainWorktree === true)
    const ordered = [...members].sort((a, b) => {
      if (a.isMainWorktree === true && b.isMainWorktree !== true) return -1
      if (b.isMainWorktree === true && a.isMainWorktree !== true) return 1
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    })

    const key = groupKey('repo', repoId)
    const derivedLabel = main ? basename(main.path) : basename(dirname(repoId)) || repoId
    const label = aliases?.[key]?.trim() || main?.alias?.trim() || derivedLabel

    out.push({
      kind: 'folder-group',
      source: 'repo',
      id: repoId,
      key,
      label,
      derivedLabel,
      expanded: !collapsedKeys?.has(key),
      folders: ordered
    })
  }

  applyParentHints(out.filter((n): n is FolderGroup<F> => isFolderGroup(n)))

  return out
}

/**
 * Group bare folders under their DIRECT parent directory, as a synthetic
 * `FolderGroup` (`source: 'path'`) — the non-git counterpart of `groupByRepo`
 * (T182, supersedes T70 Fix B's `nestByPath`).
 *
 * Runs AFTER `groupByRepo` on its output. Existing `FolderGroup` nodes pass
 * through UNTOUCHED at their positions: a group is never a member of another
 * group and never becomes one's parent, which is what keeps the sidebar capped
 * at ONE level of indentation (T70's anti-VS-Code rule).
 *
 * Bare folders bucket by `dirname(path)`. A bucket holding 2+ folders emits a
 * group at the position of its FIRST member; a bucket holding one emits that
 * folder unchanged, by identity, in its original slot.
 *
 * Two rules make the buckets unambiguous:
 *
 *   - **Member #0.** When a visible bare folder's own `path` IS a bucket key,
 *     it joins that bucket as the first member instead of being bucketed by its
 *     own `dirname` — the same role `isMainWorktree` plays inside a repo group.
 *     It keeps its sessions and its row; only its position changes.
 *   - **Deepest key first.** Being a group's parent beats being another group's
 *     member. Given `/a`, `/a/b`, `/a/b/c`, the `/a/b` bucket claims `b` as
 *     member #0, which leaves bucket `/a` too small to form — so `a` renders
 *     loose and the result is `a` + group `b` = `{b, c}`, never a 3-level
 *     staircase.
 *
 * The deliberate consequence: a folder pinned near the filesystem root (say
 * `$HOME`) only ever groups its DIRECT children, so it can no longer swallow
 * every descendant in the list the way the old shallowest-ancestor rule did.
 */
export function groupByParentDir<F extends ZoneFolder>(
  nodes: Array<F | FolderGroup<F>>,
  collapsedKeys?: ReadonlySet<string>,
  aliases?: Readonly<Record<string, string>>
): Array<F | FolderGroup<F>> {
  const bare = nodes.filter((n): n is F => !isFolderGroup(n))

  // Bucket by direct parent dir, skipping folders with no usable parent.
  const buckets = new Map<string, F[]>()
  for (const f of bare) {
    const dir = dirname(f.path)
    if (!dir || dir === '/') continue
    const list = buckets.get(dir)
    if (list) list.push(f)
    else buckets.set(dir, [f])
  }

  // Deepest key first, so a folder that is itself a bucket key is claimed as
  // that bucket's member #0 before a shallower bucket can claim it as a member.
  const keysDeepestFirst = [...buckets.keys()].sort(
    (a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : a > b ? 1 : 0)
  )
  const byPath = new Map<string, F>()
  for (const f of bare) byPath.set(f.path.replace(/\/+$/, ''), f)

  const claimed = new Set<F>()
  const groups = new Map<string, F[]>()
  for (const dir of keysDeepestFirst) {
    const members = (buckets.get(dir) ?? []).filter((f) => !claimed.has(f))
    const parent = byPath.get(dir)
    const ordered = parent && !claimed.has(parent) ? [parent, ...members] : members
    if (ordered.length < 2) continue
    for (const f of ordered) claimed.add(f)
    groups.set(dir, ordered)
  }

  // Emit: each group at its first member's original position, everything else
  // by identity in its own slot.
  const groupOfMember = new Map<F, string>()
  for (const [dir, members] of groups) for (const m of members) groupOfMember.set(m, dir)

  const out: Array<F | FolderGroup<F>> = []
  const emitted = new Set<string>()
  for (const node of nodes) {
    if (isFolderGroup(node)) {
      out.push(node)
      continue
    }
    const dir = groupOfMember.get(node)
    if (dir === undefined) {
      out.push(node)
      continue
    }
    if (emitted.has(dir)) continue
    emitted.add(dir)

    const key = groupKey('path', dir)
    const derivedLabel = basename(dir) || dir
    out.push({
      kind: 'folder-group',
      source: 'path',
      id: dir,
      key,
      label: aliases?.[key]?.trim() || derivedLabel,
      derivedLabel,
      expanded: !collapsedKeys?.has(key),
      folders: groups.get(dir) ?? []
    })
  }

  applyParentHints(out.filter((n): n is FolderGroup<F> => isFolderGroup(n)))

  return out
}

/**
 * A mother folder with the worktrees it cut nested one level beneath it
 * (T191). Unlike `FolderGroup` (a synthetic header standing in for its
 * members), the `mother` here is a REAL folder row with its own sessions —
 * the children render indented directly under it with a guide line down their
 * column. A mother with no live children is never wrapped — it stays a bare
 * `F` (identity preserved), the same convention `FolderGroup`'s members use.
 */
export interface LineageNode<F extends ZoneFolder = ZoneFolder> {
  kind: 'lineage-nest'
  mother: F
  children: F[]
  /** `false` when the mother's path is in the collapsed set (D5). */
  expanded: boolean
}

/**
 * Nest each folder under its `bornFrom` mother, within ONE call's worth of
 * candidates — appended to the `classify → sort → groupByRepo → groupByParentDir`
 * chain (T191). Callers apply this to a single group's worktree list (a
 * `FolderGroup.folders` array, `source: 'repo'`): since a valid `bornFrom` edge
 * is only ever recorded between two worktrees of the SAME repo (write-time
 * guard in `user-projects.ts`), any two folders sharing a real edge are always
 * already inside the same `FolderGroup` — a mother in a different zone, a
 * different repo, hidden, or removed simply won't be present in `folders`,
 * which is exactly how D4 ("zone wins over lineage") falls out for free
 * without this function needing to know about zones or repos at all.
 *
 * Rules enforced, pure (same input ⇒ same output, no I/O):
 *   - A child whose `bornFrom` doesn't resolve to another folder IN `folders`
 *     stays flat (covers: missing, deleted, hidden, cross-zone, cross-group —
 *     D4/D8, "never orphaned, never hidden").
 *   - A grandchild (or any deeper descendant) is re-parented to its ROOT
 *     mother, so depth never exceeds one (D3).
 *   - A cycle (A born from B, B born from A, ...) is detected by revisiting a
 *     path already walked; every folder on that cycle renders flat — no partial
 *     nesting either direction.
 *   - Sibling order is preserved exactly as given (this fn never sorts).
 *
 * `collapsedMotherPaths` mirrors `groupByRepo`'s `collapsedRepoIds` parameter:
 * a mother's `LineageNode.expanded` is `true` unless its path is in the set —
 * collapsed ONLY by explicit user choice (D5).
 */
export function nestByLineage<F extends ZoneFolder>(
  folders: readonly F[],
  collapsedMotherPaths?: ReadonlySet<string>
): Array<F | LineageNode<F>> {
  const byPath = new Map(folders.map((f) => [f.path, f]))

  /**
   * Climb `f`'s `bornFrom` chain to its ROOT mother, tracking visited paths so
   * a cycle is detected (a mother we've already walked through) rather than
   * looping forever. Returns `undefined` when `f` has no resolvable mother at
   * all (no `bornFrom`, a missing/foreign mother, or the chain closes a cycle).
   */
  function resolveRoot(f: F): F | undefined {
    const visited = new Set<string>([f.path])
    let last: F | undefined
    let current: F = f
    for (;;) {
      const bornFrom = current.bornFrom
      if (!bornFrom) break
      const mother = byPath.get(bornFrom)
      if (!mother) break // missing / hidden / cross-zone / cross-group mother
      if (visited.has(mother.path)) return undefined // cycle — drop the closing edge, both flat
      visited.add(mother.path)
      last = mother
      current = mother
    }
    return last
  }

  const rootOf = new Map<F, F>()
  for (const f of folders) {
    const root = resolveRoot(f)
    if (root) rootOf.set(f, root)
  }

  const childrenOf = new Map<F, F[]>()
  for (const f of folders) {
    const root = rootOf.get(f)
    if (!root) continue
    const list = childrenOf.get(root)
    if (list) list.push(f)
    else childrenOf.set(root, [f])
  }

  const out: Array<F | LineageNode<F>> = []
  for (const f of folders) {
    if (rootOf.has(f)) continue // a child — emitted under its mother below
    const kids = childrenOf.get(f)
    if (kids && kids.length > 0) {
      out.push({
        kind: 'lineage-nest',
        mother: f,
        children: kids,
        expanded: !collapsedMotherPaths?.has(f.path)
      })
    } else {
      out.push(f) // plain folder, no lineage children.
    }
  }
  return out
}
