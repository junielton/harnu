/**
 * Imperative shell of the shelve engine (autonomous cleanup U2.1): preserves a worktree's state that
 * git does not hold, verifies it, and (restoreWorktree) brings it back. The decisions are in
 * shelve-core.ts; this file only asks and tells git.
 *
 * It removes nothing that existed before it ran, and writes only `refs/archive/**` refs and objects
 * (plus the new worktree a restore creates; a failed restore takes that one back out). It never pushes, fetches or
 * garbage-collects, and the repo-wide stash is only READ (`stash list`): `git stash push|pop|drop`
 * must not appear here, because the stash stack is shared with every worktree.
 *
 * Every public function fails closed: a git error becomes `{ ok: false, reason }`, never a throw and
 * never a silent pass.
 */

import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { planArchive } from '../reaper/archive-core'
import { ARCHIVE_IDENTITY, archiveTip, archiveWip } from '../reaper/archive-shell'
import { removeWorktreeAdmin } from '../reaper/worktree-admin-shell'
import { rawRm } from '../raw-fs'
import { runFile } from '../spawn-runner'
import {
  DEFAULT_SNAPSHOT_CAP_BYTES,
  decideRestoreBase,
  isDependencyPath,
  normalizeDependencyDir,
  parseShelveRecord,
  parseWorktreeList,
  type RestoreBaseReason,
  serializeShelveRecord,
  shelveRefs,
  stashesForBranch,
  type ShelveRecord
} from './shelve-core'
import { DEFAULT_EPHEMERAL } from '../worktree-manifest'

// ---- git ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 120_000
const GIT_MAX_BUFFER = 64 << 20
/** An all-zero object name: as the old value of `update-ref`, "this ref must not exist yet". */
const ZERO_OID = '0'.repeat(40)

interface GitOpts {
  env?: NodeJS.ProcessEnv
  input?: string
}

class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null
  ) {
    super(message)
  }
}

/** `git -C <cwd> <args>` → stdout. Rejects with a {@link GitError} (exit code kept) on any failure. */
async function git(cwd: string, args: string[], opts: GitOpts = {}): Promise<string> {
  try {
    const { stdout } = await runFile('git', ['-C', cwd, ...args], {
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdin: opts.input ?? ''
    })
    return stdout
  } catch (err) {
    const e = err as { code?: unknown; stderr?: string; message?: string }
    // A number is git's own exit code; a string (`ENOENT`, a buffer overflow) means it never produced one.
    if (typeof e.code !== 'number') throw new GitError(`git ${args[0]}: ${e.message}`, null)
    throw new GitError(`git ${args[0]} failed (${e.code}): ${(e.stderr ?? '').trim()}`, e.code)
  }
}

/** The sha `rev` resolves to (as a commit), or null when it does not exist; any other failure throws. */
async function resolveCommit(repo: string, rev: string): Promise<string | null> {
  try {
    return (await git(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim()
  } catch (err) {
    if (err instanceof GitError && err.code === 1) return null
    throw err
  }
}

const treeOfCommit = async (repo: string, commit: string): Promise<string> =>
  (await git(repo, ['rev-parse', '--verify', `${commit}^{tree}`])).trim()

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Runs `fn` with a throwaway index file path, removed afterwards (the worktree's real index is never touched). */
async function withTempIndex<T>(fn: (indexEnv: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const tmp = path.join(
    os.tmpdir(),
    `harnu-shelve-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  try {
    return await fn({ GIT_INDEX_FILE: tmp })
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
  }
}

/**
 * The tree git would write for the worktree's tracked + untracked working state: the same recipe as
 * `archiveWip` (seed a throwaway index with HEAD, `add -A`, `write-tree`). Equal trees mean equal
 * bytes and modes for every file git tracks or would track, and the same set of deleted files.
 */
async function workingTree(worktreePath: string): Promise<string> {
  return withTempIndex(async (env) => {
    await git(worktreePath, ['read-tree', 'HEAD'], { env })
    await git(worktreePath, ['add', '-A'], { env })
    return (await git(worktreePath, ['write-tree'], { env })).trim()
  })
}

// ---- the gitignored-files snapshot -----------------------------------------------------

type SnapshotListing =
  | { ok: true; paths: string[]; bytes: number }
  | { ok: false; reason: 'snapshot-too-large' | 'nested-repository'; bytes: number }

const nulList = (s: string): string[] => s.split('\0').filter(Boolean)

/**
 * The gitignored files outside the dependency dirs, with their total size. Ignored directories are
 * listed collapsed first so a `node_modules` is never walked; the rest are expanded to files. Stops
 * the moment the total passes `capBytes` (never truncates: the caller refuses). A directory that is
 * itself a git repository cannot be captured file by file, and is refused too.
 */
async function listIgnored(
  worktreePath: string,
  dependencyDirs: readonly string[],
  capBytes: number
): Promise<SnapshotListing> {
  const collapsed = nulList(
    await git(worktreePath, [
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory'
    ])
  )
  const paths = new Set<string>()
  let bytes = 0
  const add = async (rel: string): Promise<boolean> => {
    if (paths.has(rel)) return true
    paths.add(rel)
    bytes += (await fs.lstat(path.join(worktreePath, rel))).size
    return bytes <= capBytes
  }
  for (const entry of collapsed) {
    if (isDependencyPath(entry, dependencyDirs)) continue
    if (!entry.endsWith('/')) {
      if (!(await add(entry))) return { ok: false, reason: 'snapshot-too-large', bytes }
      continue
    }
    if (
      await fs.lstat(path.join(worktreePath, entry, '.git')).then(
        () => true,
        () => false
      )
    ) {
      return { ok: false, reason: 'nested-repository', bytes }
    }
    const inside = nulList(
      await git(worktreePath, [
        '--literal-pathspecs',
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--',
        entry
      ])
    )
    for (const file of inside) {
      if (isDependencyPath(file, dependencyDirs)) continue
      if (file.endsWith('/')) return { ok: false, reason: 'nested-repository', bytes }
      if (!(await add(file))) return { ok: false, reason: 'snapshot-too-large', bytes }
    }
  }
  return { ok: true, paths: [...paths].sort(), bytes }
}

/** The tree of `paths` (worktree-relative) as git would store them, via a throwaway index. */
async function ignoredTree(worktreePath: string, paths: readonly string[]): Promise<string> {
  return withTempIndex(async (env) => {
    await git(worktreePath, ['update-index', '--add', '-z', '--stdin'], {
      env,
      input: paths.map((p) => `${p}\0`).join('')
    })
    return (await git(worktreePath, ['write-tree'], { env })).trim()
  })
}

// ---- preserve --------------------------------------------------------------------------

export type PreserveRefusal =
  | 'worktree-missing'
  | 'head-unresolvable'
  | 'snapshot-too-large'
  | 'nested-repository'
  | 'probe-failed'
  | 'verification-failed'
  | 'ref-exists'

export interface PreserveInput {
  repoPath: string
  worktreePath: string
  /** The branch the worktree is on, or null for a detached HEAD. */
  branch: string | null
  now: number
  /** Worktree-relative regenerable dirs left out of the snapshot; default = the manifest default list. */
  dependencyDirs?: readonly string[]
  /** Size cap of the gitignored-files snapshot. */
  capBytes?: number
}

export type PreserveResult =
  | { ok: true; record: ShelveRecord }
  | { ok: false; reason: PreserveRefusal; message: string; bytes?: number; capBytes?: number }

const refuse = (
  reason: PreserveRefusal,
  message: string,
  extra: { bytes?: number; capBytes?: number } = {}
): PreserveResult => ({ ok: false, reason, message, ...extra })

/** Gitlinks (mode 160000) in a commit's tree: `git add -A` records an untracked nested repo as one, with no files. */
async function gitlinks(repo: string, commit: string): Promise<Set<string>> {
  const out = await git(repo, ['ls-tree', '-r', '-z', commit])
  const set = new Set<string>()
  for (const line of nulList(out)) {
    const tab = line.indexOf('\t')
    if (line.startsWith('160000 ')) set.add(line.slice(tab + 1))
  }
  return set
}

async function commitTree(repo: string, tree: string, message: string): Promise<string> {
  return (
    await git(repo, ['commit-tree', tree, '-m', message], { env: { ...ARCHIVE_IDENTITY } })
  ).trim()
}

/**
 * Preserves everything in the worktree that git does not already hold, verifies it, and returns the
 * record that restores it. Writes only `refs/archive/**`; on any refusal or failure it deletes the
 * refs THIS call created (a ref that already existed is never touched) and leaves the worktree as
 * it was. The record ref is written last: its presence is what marks the archive as a shelve.
 */
export async function preserveWorktree(input: PreserveInput): Promise<PreserveResult> {
  const created: string[] = []
  try {
    return await preserve(input, created)
  } catch (err) {
    await rollback(input.repoPath, created)
    return refuse('probe-failed', messageOf(err))
  }
}

async function rollback(repo: string, refs: readonly string[]): Promise<void> {
  for (const ref of [...refs].reverse()) {
    await git(repo, ['update-ref', '-d', ref]).catch(() => undefined)
  }
}

async function preserve(input: PreserveInput, created: string[]): Promise<PreserveResult> {
  const { repoPath, worktreePath, branch, now } = input
  const capBytes = input.capBytes ?? DEFAULT_SNAPSHOT_CAP_BYTES
  const dependencyDirs = (input.dependencyDirs ?? DEFAULT_EPHEMERAL)
    .map(normalizeDependencyDir)
    .filter((d): d is string => d !== null)

  if (
    !(await fs.stat(worktreePath).then(
      (s) => s.isDirectory(),
      () => false
    ))
  ) {
    return refuse('worktree-missing', `${worktreePath} is not a folder on disk`)
  }
  const head = await resolveCommit(worktreePath, 'HEAD')
  if (!head) return refuse('head-unresolvable', 'the worktree has no commit to preserve')

  // The caller's facts must still hold: a record that names the wrong branch would restore onto it.
  const onBranch = await git(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(
    (s) => s.trim(),
    () => null
  )
  if (onBranch !== branch) {
    return refuse(
      'probe-failed',
      `the worktree is on ${onBranch ?? 'a detached HEAD'}, not ${branch ?? 'a detached HEAD'}`
    )
  }

  const listing = await listIgnored(worktreePath, dependencyDirs, capBytes)
  if (!listing.ok) {
    return refuse(
      listing.reason,
      listing.reason === 'snapshot-too-large'
        ? `gitignored files outside dependency dirs pass ${capBytes} bytes (counted ${listing.bytes} so far)`
        : 'a gitignored folder is itself a git repository and cannot be captured file by file',
      { bytes: listing.bytes, capBytes }
    )
  }

  const plan = planArchive(
    {
      kind: branch ? 'worktree' : 'detached-worktree',
      branch: branch ?? undefined,
      path: worktreePath,
      headSha: head
    },
    now
  )
  if (!plan.namespace || !plan.tip || !plan.wip)
    return refuse('probe-failed', 'no archive namespace for this worktree')
  const namespace = plan.namespace

  const stashes = await listStashes(repoPath, branch)
  const refs = shelveRefs(namespace, stashes.length)
  if (await resolveCommit(repoPath, refs.record)) {
    return refuse('ref-exists', `${refs.record} already exists; nothing was written`)
  }

  // Refs written below are rolled back on failure only when this call created them.
  const write = async (
    ref: string,
    sha: string,
    writer?: () => Promise<unknown>
  ): Promise<void> => {
    const existed = (await resolveCommit(repoPath, ref)) !== null
    if (writer) await writer()
    else await git(repoPath, ['update-ref', ref, sha])
    if (!existed) created.push(ref)
  }

  await write(plan.tip.ref, head, () => archiveTip(repoPath, plan.tip!.ref, head))
  let wipCommit = ''
  await write(plan.wip.ref, '', async () => {
    wipCommit = await archiveWip(repoPath, plan.wip!.ref, worktreePath)
  })
  const wipTree = await treeOfCommit(repoPath, wipCommit)

  // `add -A` turned any untracked nested repository into an empty pointer: refuse rather than call that preserved.
  const known = await gitlinks(repoPath, head)
  for (const link of await gitlinks(repoPath, wipCommit)) {
    if (!known.has(link)) {
      await rollback(repoPath, created)
      return refuse(
        'nested-repository',
        `${link} is a git repository inside the worktree; its files cannot be preserved`
      )
    }
  }

  let ignored: ShelveRecord['ignored'] = null
  if (listing.paths.length > 0) {
    const tree = await ignoredTree(worktreePath, listing.paths)
    const commit = await commitTree(
      repoPath,
      tree,
      `harnu-shelve: gitignored files of ${worktreePath}`
    )
    await write(refs.ignored, commit)
    ignored = {
      ref: refs.ignored,
      commit,
      tree,
      fileCount: listing.paths.length,
      bytes: listing.bytes
    }
  }

  const kept: ShelveRecord['stashes'] = []
  for (const [i, s] of stashes.entries()) {
    await write(refs.stashes[i]!, s.sha)
    kept.push({ ref: refs.stashes[i]!, sha: s.sha, subject: s.subject })
  }

  const record: ShelveRecord = {
    version: 1,
    createdAt: now,
    repoPath,
    worktreePath,
    branch,
    headSha: head,
    namespace,
    tipRef: plan.tip.ref,
    wipRef: plan.wip.ref,
    wipCommit,
    wipTree,
    ignored,
    stashes: kept,
    dependencyDirs,
    snapshotCapBytes: capBytes
  }
  const blob = (
    await git(repoPath, ['hash-object', '-w', '--stdin'], { input: serializeShelveRecord(record) })
  ).trim()
  const recordTree = (
    await git(repoPath, ['mktree'], { input: `100644 blob ${blob}\trecord.json\n` })
  ).trim()
  const recordCommit = await commitTree(
    repoPath,
    recordTree,
    `harnu-shelve: record of ${worktreePath}`
  )
  // Zero old value: git itself refuses to move a record that appeared since the check above.
  try {
    await git(repoPath, ['update-ref', refs.record, recordCommit, ZERO_OID])
  } catch (err) {
    await rollback(repoPath, created)
    return refuse('ref-exists', messageOf(err))
  }
  created.push(refs.record)

  const verdict = await verifyPreservation(record, { mode: 'live' })
  if (!verdict.ok) {
    await rollback(repoPath, created)
    return refuse('verification-failed', `${verdict.reason}: ${verdict.message}`)
  }
  return { ok: true, record }
}

/** The stash entries that name `branch`, newest first; none for a detached HEAD. */
async function listStashes(
  repoPath: string,
  branch: string | null
): Promise<Array<{ sha: string; subject: string }>> {
  if (branch === null) return []
  const out = await git(repoPath, ['stash', 'list', '--format=%H%x09%gs'])
  const entries = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) }
    })
  return stashesForBranch(entries, branch)
}

// ---- reading records -------------------------------------------------------------------

/** The record stored under `namespace`, or null when there is none or it does not parse. */
export async function readShelveRecord(
  repoPath: string,
  namespace: string
): Promise<ShelveRecord | null> {
  try {
    const json = await git(repoPath, ['show', `${namespace}/shelve/record:record.json`])
    const record = parseShelveRecord(json)
    return record && record.namespace === namespace ? record : null
  } catch {
    return null
  }
}

/** Every shelve record in the repository (newest first). Unreadable or forged ones are skipped. */
export async function listShelveRecords(repoPath: string): Promise<ShelveRecord[]> {
  let refs: string[]
  try {
    // for-each-ref's `*` stops at a `/`, and a branch name has slashes: list the prefix, filter here.
    refs = (await git(repoPath, ['for-each-ref', '--format=%(refname)', 'refs/archive/']))
      .split('\n')
      .filter((r) => r.endsWith('/shelve/record'))
  } catch {
    return []
  }
  const out: ShelveRecord[] = []
  for (const ref of refs) {
    const record = await readShelveRecord(repoPath, ref.slice(0, -'/shelve/record'.length))
    if (record) out.push(record)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

// ---- verify ----------------------------------------------------------------------------

export type VerifyMode = 'live' | 'archive'

export type VerifyFailure =
  | 'ref-missing'
  | 'ref-moved'
  | 'object-missing'
  | 'worktree-missing'
  | 'worktree-changed'
  | 'head-moved'
  | 'probe-failed'

export type VerifyResult =
  | { ok: true; mode: VerifyMode }
  | { ok: false; reason: VerifyFailure; message: string; detail?: string }

const bad = (reason: VerifyFailure, message: string, detail?: string): VerifyResult => ({
  ok: false,
  reason,
  message,
  ...(detail ? { detail } : {})
})

/** Every blob and tree of `tree` exists in the object store. Returns the first missing oid, or null. */
async function missingObject(repo: string, tree: string): Promise<string | null> {
  let listing: string
  try {
    listing = await git(repo, ['ls-tree', '-r', '-z', tree])
  } catch {
    return tree
  }
  const oids: string[] = []
  for (const line of nulList(listing)) {
    const [meta] = line.split('\t')
    const [mode, , oid] = meta!.split(' ')
    if (mode !== '160000' && oid) oids.push(oid)
  }
  if (oids.length === 0) return null
  const checked = await git(repo, ['cat-file', '--batch-check'], { input: `${oids.join('\n')}\n` })
  const gone = checked.split('\n').find((l) => l.endsWith(' missing'))
  return gone ? gone.split(' ')[0]! : null
}

async function checkRef(repo: string, ref: string, expected: string): Promise<VerifyResult | null> {
  const actual = await resolveCommit(repo, ref)
  if (actual === null) return bad('ref-missing', `${ref} no longer exists`)
  if (actual !== expected)
    return bad('ref-moved', `${ref} points at ${actual}, not the recorded ${expected}`)
  return null
}

/**
 * Proves the record's archive can restore the worktree. Fails closed: any mismatch or probe error is
 * `ok: false`.
 *
 * `archive` mode checks the archive itself: every recorded ref still points at the recorded commit,
 * the trees are the recorded ones, and every blob and tree under them exists.
 *
 * `live` mode (the default, what shelving asks before it removes a folder) adds the worktree: the
 * folder exists, still stands on the recorded commit, and git hashes its tracked + untracked state and
 * its gitignored files outside the dependency dirs to exactly the archived trees. A file edited,
 * added or deleted since the preservation is `worktree-changed`. Staging, mtimes and the dependency
 * dirs are not part of the comparison: git does not hold them, and the dependencies are regenerable.
 */
export async function verifyPreservation(
  record: ShelveRecord,
  opts: { mode?: VerifyMode } = {}
): Promise<VerifyResult> {
  const mode = opts.mode ?? 'live'
  try {
    const repo = record.repoPath
    const refChecks: Array<[string, string]> = [
      [record.tipRef, record.headSha],
      [record.wipRef, record.wipCommit],
      [`${record.namespace}/shelve/record`, ''],
      ...(record.ignored
        ? ([[record.ignored.ref, record.ignored.commit]] as Array<[string, string]>)
        : []),
      ...record.stashes.map((s): [string, string] => [s.ref, s.sha])
    ]
    for (const [ref, expected] of refChecks) {
      if (expected === '') {
        if ((await resolveCommit(repo, ref)) === null)
          return bad('ref-missing', `${ref} no longer exists`)
        continue
      }
      const failure = await checkRef(repo, ref, expected)
      if (failure) return failure
    }
    if ((await treeOfCommit(repo, record.wipCommit)) !== record.wipTree) {
      return bad('ref-moved', 'the wip commit no longer has the recorded tree')
    }
    const trees = [record.wipTree, ...(record.ignored ? [record.ignored.tree] : [])]
    if (
      record.ignored &&
      (await treeOfCommit(repo, record.ignored.commit)) !== record.ignored.tree
    ) {
      return bad('ref-moved', 'the snapshot commit no longer has the recorded tree')
    }
    for (const tree of trees) {
      const gone = await missingObject(repo, tree)
      if (gone) return bad('object-missing', `object ${gone} is missing from the repository`)
    }
    if (mode === 'archive') return { ok: true, mode }
    return await verifyLive(record)
  } catch (err) {
    return bad('probe-failed', messageOf(err))
  }
}

// ---- restore ---------------------------------------------------------------------------

export type RestoreFailure =
  | 'archive-unverified'
  | 'path-exists'
  | 'worktree-add-failed'
  | 'apply-failed'
  | 'snapshot-failed'
  | 'verification-failed'

export type RestoreResult =
  | {
      ok: true
      path: string
      /** True when the worktree is back on its branch; false when it stands detached at the archived HEAD. */
      attached: boolean
      /** Why it could not be re-attached; null when it was. */
      reason: RestoreBaseReason
      /** Stash copies the record keeps; restore does not re-create stash entries (`git stash apply <sha>` does). */
      stashes: ShelveRecord['stashes']
    }
  | { ok: false; reason: RestoreFailure; message: string }

const failRestore = (reason: RestoreFailure, message: string): RestoreResult => ({
  ok: false,
  reason,
  message
})

/** `p` with its parent directory resolved through symlinks, as git prints worktree paths. */
async function canonicalPath(p: string): Promise<string> {
  const parent = await fs.realpath(path.dirname(p)).catch(() => path.dirname(p))
  return path.join(parent, path.basename(p))
}

/**
 * Recreates the worktree at `record.worktreePath`: a new worktree on the branch (or detached at the
 * archived HEAD when the branch cannot be re-attached, see `decideRestoreBase`), the archived working
 * state applied over it, the gitignored snapshot unpacked, and the result verified against the record.
 *
 * Never overwrites: an existing path is refused. Dependencies and Docker stacks are not restored (the
 * session's own setup does that). If anything fails after the worktree was added, the worktree THIS
 * call created is removed again, so a retry starts clean and no half-restored folder is ever offered
 * to a session; the archive is untouched either way.
 */
export async function restoreWorktree(record: ShelveRecord): Promise<RestoreResult> {
  const repo = record.repoPath
  const target = record.worktreePath
  let added = false
  try {
    const archive = await verifyPreservation(record, { mode: 'archive' })
    if (!archive.ok)
      return failRestore('archive-unverified', `${archive.reason}: ${archive.message}`)

    if (
      await fs.lstat(target).then(
        () => true,
        () => false
      )
    ) {
      return failRestore('path-exists', `${target} already exists; nothing was changed`)
    }
    await fs.mkdir(path.dirname(target), { recursive: true })

    const canon = await canonicalPath(target)
    const listed = parseWorktreeList(await git(repo, ['worktree', 'list', '--porcelain']))
    const ownStale = listed.some((w) => w.path === canon)
    const holder = record.branch ? listed.find((w) => w.branch === record.branch) : undefined
    const branchTip = record.branch
      ? await resolveCommit(repo, `refs/heads/${record.branch}`)
      : null
    const base = decideRestoreBase({
      record,
      branchTip,
      checkedOutAt: holder?.path ?? null,
      targetPath: canon
    })

    const addArgs = ['worktree', 'add', '-q']
    // A registration left by the folder this record came from (it was removed without `worktree prune`)
    // is replaced; any other registration is left alone.
    if (ownStale) addArgs.push('--force')
    if (base.mode === 'branch') addArgs.push(target, record.branch!)
    else addArgs.push('--detach', target, record.headSha)
    try {
      await git(repo, addArgs)
    } catch (err) {
      return failRestore('worktree-add-failed', messageOf(err))
    }
    added = true

    try {
      // Two-tree merge from HEAD to the archived state: files appear, change and (for a tracked file
      // deleted before the shelve) disappear, with modes and symlinks. The reset then puts the index
      // back on HEAD, so the work is uncommitted again exactly as git sees uncommitted work.
      await git(target, ['read-tree', '-m', '-u', 'HEAD', record.wipCommit])
      await git(target, ['reset', '-q'])
    } catch (err) {
      await removeCreated(repo, target)
      return failRestore('apply-failed', messageOf(err))
    }

    if (record.ignored) {
      try {
        const prefix = `${await fs.realpath(target)}${path.sep}`
        await withTempIndex(async (env) => {
          await git(target, ['read-tree', record.ignored!.commit], { env })
          await git(target, ['checkout-index', '-a', `--prefix=${prefix}`], { env })
        })
      } catch (err) {
        await removeCreated(repo, target)
        return failRestore('snapshot-failed', messageOf(err))
      }
    }

    const verdict = await verifyPreservation(record, { mode: 'live' })
    if (!verdict.ok) {
      await removeCreated(repo, target)
      return failRestore('verification-failed', `${verdict.reason}: ${verdict.message}`)
    }
    return {
      ok: true,
      path: target,
      attached: base.mode === 'branch',
      reason: base.reason,
      stashes: record.stashes
    }
  } catch (err) {
    if (added) await removeCreated(repo, target)
    return failRestore('worktree-add-failed', messageOf(err))
  }
}

/**
 * Takes the worktree this restore just added back out: it holds nothing that is not in the archive.
 * Only this worktree's own registration is dropped (never a repo-wide `worktree prune`), and git is
 * never asked to remove a worktree (it would delete the folder behind the repo's guards).
 */
async function removeCreated(repo: string, target: string): Promise<void> {
  await rawRm(target, { recursive: true, force: true }).catch(() => undefined)
  await removeWorktreeAdmin(repo, target, (r, args) => git(r, args)).catch(() => undefined)
}

/** The live half of {@link verifyPreservation}: the worktree on disk hashes to the archived trees. */
async function verifyLive(record: ShelveRecord): Promise<VerifyResult> {
  const wt = record.worktreePath
  if (
    !(await fs.stat(wt).then(
      (s) => s.isDirectory(),
      () => false
    ))
  ) {
    return bad('worktree-missing', `${wt} is not a folder on disk`)
  }
  const head = await resolveCommit(wt, 'HEAD')
  if (head !== record.headSha) {
    return bad(
      'head-moved',
      `the worktree is on ${head ?? 'no commit'}, not the recorded ${record.headSha}`
    )
  }
  if ((await workingTree(wt)) !== record.wipTree) {
    return bad(
      'worktree-changed',
      'tracked or untracked files differ from the archived working state'
    )
  }
  const listing = await listIgnored(wt, record.dependencyDirs, record.snapshotCapBytes)
  if (!listing.ok) {
    return bad(
      'worktree-changed',
      'the gitignored files outside dependency dirs no longer fit the snapshot'
    )
  }
  const tree = listing.paths.length > 0 ? await ignoredTree(wt, listing.paths) : null
  if (tree !== (record.ignored?.tree ?? null)) {
    return bad('worktree-changed', 'gitignored files differ from the archived snapshot')
  }
  return { ok: true, mode: 'live' }
}
