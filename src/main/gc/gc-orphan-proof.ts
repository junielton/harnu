// Positive proof that a folder is gone (delta-2 item 1). "Not found" is not proof: a project on an
// sshfs share, a USB disk or a network drive that is not mounted right now is not found either, and
// its transcripts must not be offered as orphans on that basis. A folder counts as gone only when
//   (a) Harnu's own record says it removed that folder (or a folder above it);
//   (b) git lists it as prunable: its worktree registration outlived the folder, in a repo that still
//       exists; or
//   (c) it sits under a known worktrees parent (`<repo>/.claude/worktrees`, `<repo>-worktrees`
//       beside a known repo) that exists and can be read.
// Everything else is "not found", offered apart with a stronger confirm. Pure over the evidence;
// the evidence is gathered by gc-orphan-shell.

import { posix } from 'node:path'
import { parseWorktreeList } from '../worktree-core'
import { canonicalPathKey } from './bundle-core'

export interface RemovalEvidence {
  /** Folders Harnu itself removed (its own ledger). */
  removed: readonly string[]
  /** Worktrees of repos that still exist which git lists as prunable (the folder is gone). */
  prunable: readonly string[]
  /** Known worktrees parents, and whether each exists and can be read now. */
  worktreeParents: ReadonlyArray<{ parent: string; readable: boolean }>
}

export type GoneProof = 'removed-by-harnu' | 'git-prunable' | 'under-worktrees-parent'

const isUnder = (key: string, base: string): boolean =>
  base !== '' && (key === base || key.startsWith(base === '/' ? '/' : `${base}/`))

/** The proof that `folder` is gone, or null when it is merely not found. */
export function provenGone(
  folder: string,
  ev: RemovalEvidence,
  platform: string = process.platform
): GoneProof | null {
  const key = canonicalPathKey(folder, platform)
  if (!key) return null
  const k = (p: string): string => canonicalPathKey(p, platform)
  if (ev.removed.some((r) => isUnder(key, k(r)))) return 'removed-by-harnu'
  if (ev.prunable.some((p) => isUnder(key, k(p)))) return 'git-prunable'
  if (
    ev.worktreeParents.some((w) => w.readable && key !== k(w.parent) && isUnder(key, k(w.parent)))
  ) {
    return 'under-worktrees-parent'
  }
  return null
}

/** The worktrees parents a known repo implies: `<repo>/.claude/worktrees` and `<repo>-worktrees`. */
export function worktreeParentsOf(
  repoPaths: readonly string[],
  platform: string = process.platform
): string[] {
  void platform
  const out = new Set<string>()
  for (const repo of repoPaths) {
    const r = repo.replace(/[\\/]+$/, '')
    if (!r) continue
    out.add(posix.join(r, '.claude', 'worktrees'))
    out.add(`${r}-worktrees`)
  }
  return [...out]
}

export interface GitEvidenceDeps {
  /** Every repo Harnu knows (main checkouts). */
  repoPaths: readonly string[]
  /** Whether the repo's folder still exists. */
  repoExists(repo: string): Promise<boolean>
  /** `git worktree list --porcelain` for a repo; rejects when git fails. */
  worktreeList(repo: string): Promise<string>
  /** Whether a folder exists and can be listed. */
  readable(p: string): Promise<boolean>
  /** Harnu's own ledger of removed folders. */
  removed: readonly string[]
}

/** What proves a folder gone, from the repos that still exist. A git that fails proves nothing. */
export async function evidenceFromGit(deps: GitEvidenceDeps): Promise<RemovalEvidence> {
  const existing: string[] = []
  for (const repo of deps.repoPaths) {
    if (await deps.repoExists(repo).catch(() => false)) existing.push(repo)
  }
  const prunable: string[] = []
  for (const repo of existing) {
    try {
      for (const w of parseWorktreeList(await deps.worktreeList(repo))) {
        if (w.prunable) prunable.push(w.path)
      }
    } catch {
      // git could not say: no proof from this repo
    }
  }
  const worktreeParents = await Promise.all(
    worktreeParentsOf(existing).map(async (parent) => ({
      parent,
      readable: await deps.readable(parent).catch(() => false)
    }))
  )
  return { removed: deps.removed, prunable, worktreeParents }
}
