// Pure core of the shelve engine (autonomous cleanup U2.1,
// `docs/specs/2026-10-29-autonomous-cleanup-design.md` §4 U2). Shelving a worktree means preserving
// everything git does not already hold, proving it is recoverable, and later restoring it byte for
// byte. The git I/O lives in shelve-shell.ts; every decision that does not need git is here, so it
// is table-testable (ADR-0001).
//
// Where the data lives: in the repository's own object store, under the archive namespace of the
// worktree (`refs/archive/<branch>/<stamp>/…` or `refs/archive/detached/<stamp>/<key>/…`):
//
//   tip                 the branch tip / detached HEAD          (reaper archiveTip)
//   wip                 uncommitted + untracked working state   (reaper archiveWip)
//   shelve/ignored      gitignored files outside dependency dirs (a commit whose tree is the snapshot)
//   shelve/stash/<n>    copies of the stash commits that name the branch
//   shelve/record       a commit whose tree holds record.json — written LAST, it is the commit point
//
// Nothing here is pushed, fetched or garbage-collected, and the refs are plain `refs/archive/**`
// refs, so the Archives category lists them and `git gc` keeps their objects.

import { SHELVE_REF_DIR } from '../reaper/archive-core'

/**
 * The most bytes of gitignored files one worktree's snapshot may hold. Above it preservation is
 * refused, never truncated. Shelving exists to free disk (dependencies and build output are
 * hundreds of MB to GB); a snapshot larger than this would hand most of it back.
 */
export const DEFAULT_SNAPSHOT_CAP_BYTES = 256 * 1024 * 1024

/** The refs a shelve adds under an archive namespace. */
export function shelveRefs(
  namespace: string,
  stashCount: number
): { ignored: string; record: string; stashes: string[] } {
  const dir = `${namespace}/${SHELVE_REF_DIR}`
  return {
    ignored: `${dir}/ignored`,
    record: `${dir}/record`,
    stashes: Array.from({ length: stashCount }, (_, i) => `${dir}/stash/${i}`)
  }
}

// ---- the record --------------------------------------------------------------

export interface ShelveSnapshot {
  ref: string
  commit: string
  tree: string
  fileCount: number
  bytes: number
}

export interface ShelvedStash {
  ref: string
  sha: string
  subject: string
}

/** Everything restore and verify need to know about one preservation. Persisted as `record.json`. */
export interface ShelveRecord {
  version: 1
  createdAt: number
  repoPath: string
  worktreePath: string
  /** The branch the worktree was on, or null for a detached HEAD. */
  branch: string | null
  headSha: string
  /** `refs/archive/<branch>/<stamp>` or `refs/archive/detached/<stamp>/<key>`. */
  namespace: string
  tipRef: string
  wipRef: string
  wipCommit: string
  /** Tree of the wip commit: the whole tracked + untracked working state, as git hashes it. */
  wipTree: string
  /** The gitignored-files snapshot, or null when the worktree had none outside dependency dirs. */
  ignored: ShelveSnapshot | null
  stashes: ShelvedStash[]
  /** The dependency dirs the snapshot left out (regenerable by the worktree's own setup). */
  dependencyDirs: string[]
  snapshotCapBytes: number
}

export function serializeShelveRecord(record: ShelveRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v !== ''
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A ref name a record may carry: under `refs/archive/`, no `..`, no control characters. */
function isArchiveRef(v: unknown): v is string {
  return (
    isStr(v) &&
    v.startsWith('refs/archive/') &&
    !v.includes('..') &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x20\x7f~^:?*[\\]/.test(v)
  )
}

function parseSnapshot(v: unknown): ShelveSnapshot | null | undefined {
  if (v === null) return null
  if (!isObj(v)) return undefined
  if (!isArchiveRef(v.ref) || !isStr(v.commit) || !isStr(v.tree)) return undefined
  if (!isNum(v.fileCount) || !isNum(v.bytes)) return undefined
  return { ref: v.ref, commit: v.commit, tree: v.tree, fileCount: v.fileCount, bytes: v.bytes }
}

/**
 * The record in `json`, or null when it is not a version-1 record. Every ref it names must lie
 * under `refs/archive/`, so a forged or corrupted record can never aim a ref write elsewhere.
 */
export function parseShelveRecord(json: string): ShelveRecord | null {
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return null
  }
  if (!isObj(v) || v.version !== 1) return null
  if (!isNum(v.createdAt) || !isStr(v.repoPath) || !isStr(v.worktreePath)) return null
  if (v.branch !== null && !isStr(v.branch)) return null
  if (!isStr(v.headSha) || !isStr(v.namespace) || !v.namespace.startsWith('refs/archive/'))
    return null
  if (!isArchiveRef(v.tipRef) || !isArchiveRef(v.wipRef)) return null
  if (!isStr(v.wipCommit) || !isStr(v.wipTree)) return null
  const ignored = parseSnapshot(v.ignored)
  if (ignored === undefined) return null
  if (!Array.isArray(v.stashes)) return null
  const stashes: ShelvedStash[] = []
  for (const s of v.stashes) {
    if (!isObj(s) || !isArchiveRef(s.ref) || !isStr(s.sha) || typeof s.subject !== 'string')
      return null
    stashes.push({ ref: s.ref, sha: s.sha, subject: s.subject })
  }
  if (!Array.isArray(v.dependencyDirs) || !v.dependencyDirs.every(isStr)) return null
  if (!isNum(v.snapshotCapBytes)) return null
  return {
    version: 1,
    createdAt: v.createdAt,
    repoPath: v.repoPath,
    worktreePath: v.worktreePath,
    branch: v.branch,
    headSha: v.headSha,
    namespace: v.namespace,
    tipRef: v.tipRef,
    wipRef: v.wipRef,
    wipCommit: v.wipCommit,
    wipTree: v.wipTree,
    ignored,
    stashes,
    dependencyDirs: [...v.dependencyDirs],
    snapshotCapBytes: v.snapshotCapBytes
  }
}

// ---- what the snapshot leaves out ---------------------------------------------

/**
 * Whether `rel` is one of the dependency dirs or lies under one. Compared by whole path
 * segments (`node_modules_x` is not `node_modules`) and only from the worktree root, exactly the
 * set dehydrate removes: a nested `packages/a/node_modules` is NOT regenerable by that rule, so it
 * counts toward the snapshot.
 */
export function isDependencyPath(rel: string, dependencyDirs: readonly string[]): boolean {
  const p = rel.replace(/\/+$/, '')
  return dependencyDirs.some((d) => p === d || p.startsWith(`${d}/`))
}

// ---- stashes --------------------------------------------------------------------

/**
 * The stash entries made on `branch`. A stash subject reads `On <branch>: <message>` or
 * `WIP on <branch>: <sha> <subject>`; the branch must be followed by the colon, so `feat/x-2` is
 * never mistaken for `feat/x`. Matched as plain text, never as a pattern.
 */
export function stashesForBranch<T extends { subject: string }>(
  entries: readonly T[],
  branch: string
): T[] {
  if (branch === '') return []
  const on = `On ${branch}:`
  const wip = `WIP on ${branch}:`
  return entries.filter((e) => e.subject.startsWith(on) || e.subject.startsWith(wip))
}

// ---- worktrees ------------------------------------------------------------------

export interface ListedWorktree {
  path: string
  branch: string | null
  head: string | null
  prunable: boolean
}

/** `git worktree list --porcelain` → one row per worktree. */
export function parseWorktreeList(porcelain: string): ListedWorktree[] {
  const out: ListedWorktree[] = []
  let cur: ListedWorktree | null = null
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: null, head: null, prunable: false }
      out.push(cur)
    } else if (cur) {
      if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length)
      else if (line.startsWith('branch '))
        cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
      else if (line.startsWith('prunable')) cur.prunable = true
    }
  }
  return out
}

export type RestoreBaseReason =
  null | 'branch-missing' | 'branch-moved' | 'branch-checked-out-elsewhere' | 'no-branch'

/**
 * What the restored worktree starts on. The branch is re-attached only when it still points at
 * the commit the worktree was shelved on and no OTHER worktree has it checked out: the archived
 * working state is absolute bytes, so applying it on a moved branch would silently revert the
 * newer commits' content. Anything else restores detached at the archived HEAD, and says why.
 */
export function decideRestoreBase(input: {
  record: { branch: string | null; headSha: string }
  /** The branch's current tip, or null when it does not exist. */
  branchTip: string | null
  /** The path where the branch is checked out now, or null. */
  checkedOutAt: string | null
  targetPath: string
}): { mode: 'branch' | 'detached'; reason: RestoreBaseReason } {
  const { record, branchTip, checkedOutAt, targetPath } = input
  if (record.branch === null) return { mode: 'detached', reason: 'no-branch' }
  if (branchTip === null) return { mode: 'detached', reason: 'branch-missing' }
  if (branchTip !== record.headSha) return { mode: 'detached', reason: 'branch-moved' }
  if (checkedOutAt !== null && checkedOutAt !== targetPath) {
    return { mode: 'detached', reason: 'branch-checked-out-elsewhere' }
  }
  return { mode: 'branch', reason: null }
}
