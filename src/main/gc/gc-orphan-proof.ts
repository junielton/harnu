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

/**
 * Every way the evidence could prove `folder` gone, each with the ROOT it rests on: the exact
 * folder Harnu removed, the worktree git lists as prunable, or the segment directly under the known
 * worktrees parent. A proof stands only while its root is itself missing (see {@link proveGone}).
 */
export function proofRoots(
  folder: string,
  ev: RemovalEvidence,
  platform: string = process.platform
): Array<{ proof: GoneProof; root: string }> {
  const key = canonicalPathKey(folder, platform)
  if (!key) return []
  const k = (p: string): string => canonicalPathKey(p, platform)
  const out: Array<{ proof: GoneProof; root: string }> = []
  for (const r of ev.removed)
    if (isUnder(key, k(r))) out.push({ proof: 'removed-by-harnu', root: r })
  for (const p of ev.prunable) if (isUnder(key, k(p))) out.push({ proof: 'git-prunable', root: p })
  for (const w of ev.worktreeParents) {
    const base = k(w.parent)
    if (!w.readable || key === base || !isUnder(key, base)) continue
    // The worktree root is the segment directly under the parent, in the folder's own spelling.
    const depth = base.split('/').filter(Boolean).length + 1
    const segments = posix.resolve(folder).split('/').filter(Boolean)
    out.push({ proof: 'under-worktrees-parent', root: `/${segments.slice(0, depth).join('/')}` })
  }
  return out
}

/** The first proof the evidence offers for `folder`, or null when it is merely not found. */
export function provenGone(
  folder: string,
  ev: RemovalEvidence,
  platform: string = process.platform
): GoneProof | null {
  return proofRoots(folder, ev, platform)[0]?.proof ?? null
}

/**
 * Whether `folder` is positively gone: some proof applies AND the root it rests on is itself missing
 * right now. A dangling symlink or an empty mount point where the worktree was (its drive is not
 * mounted), or a folder that exists again, is not a missing root, so it proves nothing.
 */
export async function proveGone(
  folder: string,
  ev: RemovalEvidence,
  existence: (p: string) => Promise<'exists' | 'missing' | 'unknown'>,
  platform: string = process.platform
): Promise<boolean> {
  for (const { root } of proofRoots(folder, ev, platform)) {
    if ((await existence(root).catch(() => 'unknown' as const)) === 'missing') return true
  }
  return false
}

/** git's own words for a worktree whose directory is gone; any other reason is not proof. */
const PRUNABLE_GONE = 'gitdir file points to non-existent location'

/** The worktrees git lists as prunable for exactly that reason. */
function prunableWorktrees(porcelain: string): string[] {
  const out: string[] = []
  let current: string | null = null
  for (const raw of porcelain.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim()
    else if (current && (line === 'prunable' || line.startsWith('prunable '))) {
      if (line.includes(PRUNABLE_GONE)) out.push(current)
    }
  }
  return out
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
      prunable.push(...prunableWorktrees(await deps.worktreeList(repo)))
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
