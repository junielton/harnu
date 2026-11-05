// Shelves one worktree (autonomous cleanup U2.2, design §4 U2 "Remove", §5): preserve everything
// git does not hold, prove it is recoverable, THEN delete the folder for real and drop that
// worktree's own registration. The branch and every archive ref stay.
//
// The order is the safety argument:
//   1. the world is still what was decided on (HEAD, work fingerprint, newest edit), nobody is in
//      the folder, and the registration can be removed on its own (not locked, not ambiguous);
//   2. preserve with the repo's own dependency dirs, then verify against the live folder;
//   3. the world is still what was decided on, once more, right before the delete;
//   4. remember the shelve durably, so a crash mid-delete never reads as a removal;
//   5. delete the folder, then remove that worktree's admin entry (never a repo-wide cleanup).
// Any failure up to step 4 leaves the worktree exactly as it was.
//
// Nothing here pushes, fetches or collects garbage, and none of the sidebar/ghost/removal-ledger
// doors are called: a shelved worktree is not a removed one (design C3). The folder goes through
// the asar-safe `rawRm`; git is never asked to remove a worktree behind the repo's guards.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rawRm } from '../raw-fs'
import { canUnregister, removeWorktreeAdmin } from '../reaper/worktree-admin-shell'
import type { ShelveProbe } from './shelve-eligibility-core'
import { readShelveManifest } from './shelve-manifest-shell'
import { probeShelve, sameBinding, type ShelveBinding } from './shelve-probe-shell'
import type { ShelveRecord } from './shelve-core'
import {
  preserveWorktree,
  verifyPreservation,
  type PreserveInput,
  type PreserveResult,
  type VerifyResult
} from './shelve-shell'
import {
  readShelvedForUpdate,
  withShelved,
  withoutShelved,
  writeShelved,
  type ShelvedEntry
} from './shelve-store'

const run = promisify(execFile)

/** What the cycle decided: the worktree, and the facts that decision was made on. */
export interface ShelveDecision {
  /** The cleanup bundle id. */
  id: string
  repoPath: string
  worktreePath: string
  /** Null for a detached worktree. */
  branch: string | null
  binding: ShelveBinding
  /** The newest sign of life (epoch ms) the idle time was counted from. */
  since: number
  /** Whole days idle when decided; goes into the journal reason. */
  idleDays: number
  /** What the folder occupies, for the journal. */
  diskBytes: number | null
}

export type ShelveStep =
  'reprobe' | 'in-use' | 'preserve' | 'verify' | 'remember' | 'remove' | 'unregister'

export type ShelveOutcome =
  | { ok: true; entry: ShelvedEntry; record: ShelveRecord }
  | {
      ok: false
      step: ShelveStep
      reason: string
      message: string
      /** The folder is (at least partly) gone: the shelved entry was kept and needs attention. */
      folderRemoved: boolean
    }

export interface ShelveExecDeps {
  probe(d: ShelveDecision): Promise<ShelveProbe>
  /** A session is, or may be, working in the folder right now. A throw counts as yes. */
  inUse(worktreePath: string): Promise<boolean>
  /** The worktree's own registration can be removed on its own (not locked, not ambiguous). */
  canUnregister(repoPath: string, worktreePath: string): Promise<boolean>
  manifest(repoPath: string): Promise<{ dependencyDirs: string[]; delegates: boolean }>
  preserve(input: PreserveInput): Promise<PreserveResult>
  verify(record: ShelveRecord): Promise<VerifyResult>
  remember(entry: ShelvedEntry): Promise<void>
  forget(id: string): Promise<void>
  removeFolder(worktreePath: string): Promise<void>
  unregister(repoPath: string, worktreePath: string): Promise<boolean>
  now(): number
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The one sentence the journal and the Activity line carry. */
export function shelveReason(
  d: Pick<ShelveDecision, 'branch' | 'idleDays'>,
  headSha: string
): string {
  return d.branch
    ? `Shelved \`${d.branch}\` — idle ${d.idleDays} d, branch kept`
    : `Shelved detached HEAD ${headSha.slice(0, 7)} — idle ${d.idleDays} d, archive kept`
}

export async function shelveWorktree(
  d: ShelveDecision,
  deps: ShelveExecDeps
): Promise<ShelveOutcome> {
  const fail = (
    step: ShelveStep,
    reason: string,
    message: string,
    folderRemoved = false
  ): ShelveOutcome => ({ ok: false, step, reason, message, folderRemoved })

  /** Steps 1 and 3: still what was decided, and nobody is in there. */
  const stillHolds = async (): Promise<ShelveOutcome | null> => {
    const probe = await deps.probe(d)
    if (probe.manifestDelegates) {
      return fail('reprobe', 'delegated-manifest', 'the repo’s WORKTREE.md delegates create/remove')
    }
    if (!sameBinding(d.binding, probe)) {
      return fail(
        'reprobe',
        'changed-since-decided',
        'the worktree changed since the shelve was decided (HEAD, uncommitted work or an edited file)'
      )
    }
    const busy = await deps.inUse(d.worktreePath).catch(() => true)
    if (busy) return fail('in-use', 'in-use', 'a session is, or may be, working in this folder')
    return null
  }

  let record: ShelveRecord
  try {
    const first = await stillHolds()
    if (first) return first
    if (!(await deps.canUnregister(d.repoPath, d.worktreePath).catch(() => false))) {
      return fail(
        'unregister',
        'not-unregisterable',
        'git’s registration of this worktree cannot be removed on its own (locked, or not uniquely found)'
      )
    }

    const manifest = await deps.manifest(d.repoPath)
    const preserved = await deps.preserve({
      repoPath: d.repoPath,
      worktreePath: d.worktreePath,
      branch: d.branch,
      now: deps.now(),
      dependencyDirs: manifest.dependencyDirs
    })
    if (!preserved.ok) return fail('preserve', preserved.reason, preserved.message)
    record = preserved.record

    const verified = await deps.verify(record)
    if (!verified.ok) return fail('verify', verified.reason, verified.message)

    const last = await stillHolds()
    if (last) return last
  } catch (err) {
    return fail('preserve', 'probe-failed', messageOf(err))
  }

  const entry: ShelvedEntry = {
    id: d.id,
    repoPath: d.repoPath,
    worktreePath: d.worktreePath,
    branch: d.branch,
    headSha: record.headSha,
    namespace: record.namespace,
    shelvedAt: deps.now(),
    idleDays: d.idleDays,
    reason: shelveReason(d, record.headSha),
    freedBytes: d.diskBytes
  }
  // Remembered BEFORE the delete: a crash halfway reads as "shelved, finish or restore", never as
  // a worktree that vanished.
  try {
    await deps.remember(entry)
  } catch (err) {
    return fail('remember', 'store-failed', messageOf(err))
  }

  let removeError: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await deps.removeFolder(d.worktreePath)
      removeError = null
      break
    } catch (err) {
      removeError = err
    }
  }
  if (removeError !== null) {
    // Still whole (the live check passes against the very record)? Then nothing was lost: take the
    // entry back. Otherwise it is partly gone and the entry stays, so it is never silently lost.
    const intact = await deps.verify(record).catch(() => ({ ok: false }) as VerifyResult)
    if (intact.ok) {
      await deps.forget(d.id).catch(() => undefined)
      return fail('remove', 'remove-failed', messageOf(removeError))
    }
    return fail('remove', 'remove-partial', messageOf(removeError), true)
  }

  try {
    if (!(await deps.unregister(d.repoPath, d.worktreePath))) {
      return fail(
        'unregister',
        'not-unregistered',
        'the folder is gone but git still lists the worktree',
        true
      )
    }
  } catch (err) {
    return fail('unregister', 'unregister-failed', messageOf(err), true)
  }
  return { ok: true, entry, record }
}

// ---- the real dependencies ---------------------------------------------------------------------

const gitOut = async (repo: string, args: string[]): Promise<string> =>
  (
    await run('git', ['-C', repo, ...args], {
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 8 << 20
    })
  ).stdout

/**
 * The real dependencies. `file` is the shelved store (`gc-shelved.json`); reads and writes of it
 * are serialised so two shelves never overwrite each other. `inUse` asks the Reaper's live-session
 * sets, loaded lazily because they live behind electron.
 */
export function defaultShelveExecDeps(
  file: string,
  over: Partial<ShelveExecDeps> = {}
): ShelveExecDeps {
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work)
    chain = next.catch(() => undefined)
    return next
  }
  return {
    probe: (d) => probeShelve({ item: { repoPath: d.repoPath, path: d.worktreePath } }),
    inUse: async (p) => (await import('../reaper/scanner-shell')).isFolderInUse(p),
    canUnregister: (repo, p) => canUnregister(repo, p, gitOut),
    manifest: (repo) => readShelveManifest(repo),
    preserve: preserveWorktree,
    verify: (record) => verifyPreservation(record),
    remember: (entry) =>
      serial(async () => writeShelved(file, withShelved(await readShelvedForUpdate(file), entry))),
    forget: (id) =>
      serial(async () =>
        writeShelved(file, withoutShelved(await readShelvedForUpdate(file), [id]))
      ),
    removeFolder: (p) => rawRm(p, { recursive: true, force: true }),
    unregister: (repo, p) => removeWorktreeAdmin(repo, p, gitOut),
    now: () => Date.now(),
    ...over
  }
}
