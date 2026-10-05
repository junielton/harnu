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
  /** `refs/archive/<branch>/<stamp>`, or null when nothing can be archived. */
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
 * checkout, so there is no working state to lose. A folder item plans both.
 */
export function planArchive(
  item: Pick<ReapItem, 'kind' | 'branch' | 'path'>,
  at: number
): ArchivePlan {
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
