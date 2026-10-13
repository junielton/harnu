// Pure archive planner for the Reaper cleanup engine: decides WHAT a sweep must
// preserve, and under which ref names, before anything is deleted. No imports
// with I/O, no git calls — every decision here is unit-tested in
// tests/reaper-archive-core.test.ts (ADR-0001: pure cores, env-bound shells).
//
// Two refs are planned, never one. `refs/archive/.../tip` alone preserves the
// branch tip, which is not what the motivating losses hold: the documented
// near-miss was an 87-line ADR that existed nowhere else, and a real corpus
// carried a worktree with 15 tracked-dirty files and zero commits ahead of the
// default branch. A tip ref preserves none of that — the working state needs
// its own ref.

import type { ReapItem, ReapItemKind } from './reaper-core'

export type ArchiveRole = 'tip' | 'wip'

export interface ArchiveRefPlan {
  role: ArchiveRole
  /** Full ref name the preserved object is written to. */
  ref: string
  /** Revision the tip is resolved from — `tip` only. */
  rev?: string
  /** Worktree whose tracked + untracked working state is captured — `wip` only. */
  worktreePath?: string
}

export interface ArchivePlan {
  /**
   * `refs/archive/<branch>/<stamp>`, or `refs/archive/detached/<stamp>/<folder>-<shortsha>` for a
   * detached worktree, or null when nothing can be archived.
   */
  namespace: string | null
  tip: ArchiveRefPlan | null
  wip: ArchiveRefPlan | null
  /** Every planned ref, in write order. Empty when there is nothing to preserve. */
  refs: ArchiveRefPlan[]
}

/**
 * Compact ISO-8601 basic stamp (`20260828T182233Z`).
 *
 * Ref names cannot contain `:`, so the extended form is out. The stamp makes
 * each sweep of the same branch name its own namespace: this repo re-uses
 * `card/T###-slug` branch names, and a fixed name would let the second sweep
 * clobber the first sweep's only recoverable copy.
 */
export function formatArchiveStamp(at: number): string {
  return new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
}

/**
 * `refs/archive/<branch>/<stamp>` — the per-branch, per-sweep namespace holding
 * both refs.
 *
 * NOTE the shape. The obvious naming (`refs/archive/<branch>` for the tip and
 * `refs/archive/<branch>/wip` for the working state) is *impossible* in git: a
 * ref and a directory of refs cannot share a path, so the second update-ref
 * fails with `'refs/archive/<branch>' exists; cannot create`. It also collides
 * whenever one branch name is a path prefix of another (`feat/x` vs
 * `feat/x/y`). Both leaves living under a shared namespace avoids each.
 */
export function archiveNamespace(branch: string, at: number): string {
  return `refs/archive/${branch}/${formatArchiveStamp(at)}`
}

/** Where every detached worktree's archive lives: no branch name exists to key it by. */
export const DETACHED_ARCHIVE_PREFIX = 'refs/archive/detached/'

/** Characters of the HEAD sha that go into the namespace: short enough to read, long enough not to collide. */
const SHORT_SHA_LENGTH = 12

/** The folder's own name as one legal ref component: no spaces, no `..`, no `.lock`, no leading dot or dash. */
function folderSlug(path: string): string {
  const base = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? ''
  const slug = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/\.lock$/, '-lock')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[.-]+$/, '')
  return slug === '' ? 'worktree' : slug
}

/**
 * `refs/archive/detached/<stamp>/<folder>-<shortsha>` — the namespace of a detached worktree: WHEN it
 * was archived, then what identifies it, the folder it lived in and the commit it was on. The stamp
 * is what dates the archive (a ref's own commit date says when the commit was made, not when it was
 * archived), so Cleanup can group every ref of one removal under it, show its age, and expire it with
 * the retention like any other archive. One removal is one stamp: the forced reprobe and the executor
 * share the run's time, so they write the very same refs. The same folder at the same commit removed
 * on another day is a separate archive (`archiveWip` still keeps an earlier working state under a
 * sibling ref when one run writes the same name twice).
 *
 * Before unit E the namespace was `refs/archive/detached/<folder>-<shortsha>`, with no time in it;
 * those refs are still listed, as one archive of unknown age.
 */
export function detachedArchiveNamespace(path: string, headSha: string, at: number): string {
  return `${DETACHED_ARCHIVE_PREFIX}${formatArchiveStamp(at)}/${detachedArchiveKey(path, headSha)}`
}

/** `<folder>-<sha12>`: what identifies one detached removal's archive under its time stamp. */
export function detachedArchiveKey(path: string, headSha: string): string {
  return `${folderSlug(path)}-${headSha.slice(0, SHORT_SHA_LENGTH)}`
}

/**
 * How long after a detached archive was made a removal of the same folder at the same commit still
 * counts as a retry of it. A removal that stopped partway is retried within minutes or hours; one
 * made days later is a new removal and gets its own date (so its refs do not expire with the old one).
 */
export const DETACHED_REUSE_WINDOW_MS = 24 * 3_600_000

/**
 * The stamp of the newest detached archive of this folder and commit that a retry should write
 * into, from the `<stamp>/<key>/tip` refs that exist: only one made by Harnu (its tip is the commit
 * the key names), not in the future, and within {@link DETACHED_REUSE_WINDOW_MS}. Null when there is
 * none, and a new archive is made.
 */
export function newestReusableStamp(
  tips: ReadonlyArray<{ ref: string; sha: string }>,
  key: string,
  now: number
): number | null {
  const hex = /-([0-9a-f]{12})$/.exec(key)?.[1]
  if (!hex) return null
  let best: number | null = null
  for (const t of tips) {
    const m = /^refs\/archive\/detached\/(\d{8}T\d{6}Z)\/(.+)\/tip$/.exec(t.ref)
    if (!m || m[2] !== key || !t.sha.startsWith(hex)) continue
    const at = parseStamp(m[1]!)
    if (at === null || at > now || now - at > DETACHED_REUSE_WINDOW_MS) continue
    if (best === null || at > best) best = at
  }
  return best
}

/** `20260828T182233Z` → ms, or null when it is not the compact stamp this file writes. */
function parseStamp(stamp: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number
  ]
  const at = Date.UTC(y, mo - 1, d, h, mi, s)
  return formatArchiveStamp(at) === stamp ? at : null
}

/**
 * The time a removal's archive is stamped with: now, or — for a detached worktree whose folder and
 * commit already have a recent archive — that archive's own stamp, so a retried removal writes into
 * the same group instead of leaving a second one. `find` is the lookup of existing refs (git).
 */
export async function archiveAtFor(
  item: Pick<ReapItem, 'kind' | 'path' | 'headSha' | 'repoPath'>,
  now: number,
  find:
    | ((repoPath: string, path: string, headSha: string, now: number) => Promise<number | null>)
    | undefined
): Promise<number> {
  if (item.kind !== 'detached-worktree' || !item.path || !item.headSha || !find) return now
  try {
    return (await find(item.repoPath, item.path, item.headSha, now)) ?? now
  } catch {
    return now
  }
}

/** The revision a kind's tip is resolved from, or null when the kind has no local tip. */
function tipRevFor(kind: ReapItemKind, branch: string): string | null {
  // A remote-branch item has no local branch: its only local copy of the tip is
  // the remote-tracking ref. If that does not resolve, the executor aborts the
  // item rather than dropping a branch it cannot preserve.
  if (kind === 'remote-branch') return `refs/remotes/origin/${branch}`
  return branch
}

/** True for the kinds that own a folder on disk, and therefore a working state. */
function hasWorkingTree(kind: ReapItemKind): boolean {
  return kind === 'worktree' || kind === 'hidden-folder'
}

/**
 * Plan the refs that must exist before this item may be swept.
 *
 * A branch-only item (`local-branch`) plans a tip and no wip — it owns no
 * checkout, so there is no working state to lose. A folder item plans both,
 * and so does a detached worktree, keyed by its HEAD sha instead of a branch.
 */
export function planArchive(
  item: Pick<ReapItem, 'kind' | 'branch' | 'path' | 'headSha'>,
  at: number
): ArchivePlan {
  // A detached worktree has no branch to name its refs after: its checked-out commit and its folder
  // do. Without either, nothing can be named or resolved, and the executor halts at the archive.
  if (item.kind === 'detached-worktree') {
    if (!item.path || !item.headSha) return { namespace: null, tip: null, wip: null, refs: [] }
    const namespace = detachedArchiveNamespace(item.path, item.headSha, at)
    const tip: ArchiveRefPlan = { role: 'tip', ref: `${namespace}/tip`, rev: item.headSha }
    const wip: ArchiveRefPlan = { role: 'wip', ref: `${namespace}/wip`, worktreePath: item.path }
    return { namespace, tip, wip, refs: [tip, wip] }
  }

  const branch = item.branch
  if (!branch) return { namespace: null, tip: null, wip: null, refs: [] }

  const namespace = archiveNamespace(branch, at)
  const rev = tipRevFor(item.kind, branch)
  const tip: ArchiveRefPlan | null = rev ? { role: 'tip', ref: `${namespace}/tip`, rev } : null
  const wip: ArchiveRefPlan | null =
    hasWorkingTree(item.kind) && item.path
      ? { role: 'wip', ref: `${namespace}/wip`, worktreePath: item.path }
      : null

  const refs: ArchiveRefPlan[] = []
  if (tip) refs.push(tip)
  if (wip) refs.push(wip)
  return { namespace, tip, wip, refs }
}
