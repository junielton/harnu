// The one door that brings a shelved worktree back (autonomous cleanup U2.3a, design §4 U2
// "Restore", C3). Callers: a PTY about to start in a shelved folder (resume, new session,
// terminal, MCP `create_session` / `spawn_terminal`) and Cleanup's Restore button. The Scheduler
// never calls it: its ticks spawn `claude` directly and never reach a PTY.
//
// It wraps U2.1's `restoreWorktree` with what a caller needs around it:
//   - one restore per worktree at a time (a resume and a terminal asking together share it);
//   - the per-repository lock the shelve cycle takes, so the two never run in the same repo at once;
//   - a folder already standing at the path is never overwritten and never deleted: if it is the
//     restored worktree it is accepted, otherwise it is moved aside to `<path>.leftover-<stamp>`;
//   - the shelved entry is forgotten only after the folder is whole again.
// Every effect is an injected dep, so the rules are unit-tested with fakes
// (tests/gc-shelve-restore-shell.test.ts).

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { leftoverPathFor, shelvedEntryFor } from './shelve-restore-core'
import type { ShelveRecord } from './shelve-core'
import {
  readShelveRecord,
  restoreWorktree,
  verifyPreservation,
  type RestoreFailure,
  type RestoreResult,
  type VerifyResult
} from './shelve-shell'
import {
  SHELVED_FILE,
  readShelved,
  updateShelved,
  withoutShelved,
  type ShelvedEntry,
  type ShelvedFile
} from './shelve-store'
import { withRepoLock, type RepoLockResult } from './repo-lock-shell'

export type ShelvedRestoreFailure =
  RestoreFailure | 'record-missing' | 'repo-busy' | 'in-use' | 'move-aside-failed'

export type ShelvedRestoreOutcome =
  | { status: 'not-shelved' }
  /** The folder was already whole (an earlier restore could not forget the entry); the entry is dropped. */
  | { status: 'present'; entry: ShelvedEntry }
  | {
      status: 'restored'
      entry: ShelvedEntry
      /** True when the worktree is back on its branch; false when detached at the archived HEAD. */
      attached: boolean
      /** Where a folder that was in the way went, or null when nothing was. */
      movedAside: string | null
    }
  | {
      status: 'failed'
      entry: ShelvedEntry
      reason: ShelvedRestoreFailure
      message: string
    }

export interface ShelveRestoreDeps {
  readStore(): Promise<ShelvedFile>
  forget(id: string): Promise<void>
  readRecord(repoPath: string, namespace: string): Promise<ShelveRecord | null>
  restore(record: ShelveRecord): Promise<RestoreResult>
  verifyLive(record: ShelveRecord): Promise<VerifyResult>
  exists(p: string): Promise<boolean>
  /** A session is, or may be, working in the folder. A throw counts as yes. */
  inUse(p: string): Promise<boolean>
  moveAside(from: string, to: string): Promise<void>
  lock<T>(repoPath: string, work: () => Promise<T>): Promise<RepoLockResult<T>>
  sleep(ms: number): Promise<void>
  now(): number
  /** The shelved set changed (a worktree came back); tells open Cleanup screens to refresh. */
  changed(): void
}

/** The repo lock is a try-lock; a restore waits a few seconds for a shelve or a clean to finish. */
const LOCK_ATTEMPTS = 5
const LOCK_WAIT_MS = 500

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export interface ShelveRestorer {
  /** Restores the shelved worktree `folder` belongs to, if any. Never throws. */
  ensure(folder: string): Promise<ShelvedRestoreOutcome>
  /** Restores the shelved entry with this id (Cleanup's button). Never throws. */
  restoreById(id: string): Promise<ShelvedRestoreOutcome>
}

export function createShelveRestorer(deps: ShelveRestoreDeps): ShelveRestorer {
  const inflight = new Map<string, Promise<ShelvedRestoreOutcome>>()

  const failed = (
    entry: ShelvedEntry,
    reason: ShelvedRestoreFailure,
    message: string
  ): ShelvedRestoreOutcome => ({ status: 'failed', entry, reason, message })

  /** Forgetting is bookkeeping: if it fails the folder is still real, and the next call sees it. */
  const forgetQuietly = async (entry: ShelvedEntry): Promise<void> => {
    try {
      await deps.forget(entry.id)
    } catch (err) {
      console.warn('[gc] could not forget a restored shelved entry', entry.id, messageOf(err))
    }
  }

  async function underLock(entry: ShelvedEntry): Promise<ShelvedRestoreOutcome> {
    const record = await deps.readRecord(entry.repoPath, entry.namespace)
    if (!record) {
      return failed(
        entry,
        'record-missing',
        `the shelve record under ${entry.namespace} cannot be read`
      )
    }
    let movedAside: string | null = null
    if (await deps.exists(entry.worktreePath)) {
      if ((await deps.verifyLive(record)).ok) {
        await forgetQuietly(entry)
        deps.changed()
        return { status: 'present', entry }
      }
      if (await deps.inUse(entry.worktreePath).catch(() => true)) {
        return failed(
          entry,
          'in-use',
          'a session is, or may be, working in the folder at that path'
        )
      }
      const aside = leftoverPathFor(entry.worktreePath, deps.now())
      try {
        await deps.moveAside(entry.worktreePath, aside)
      } catch (err) {
        return failed(entry, 'move-aside-failed', messageOf(err))
      }
      movedAside = aside
    }
    const result = await deps.restore(record)
    if (!result.ok) return failed(entry, result.reason, result.message)
    await forgetQuietly(entry)
    deps.changed()
    return { status: 'restored', entry, attached: result.attached, movedAside }
  }

  async function run(entry: ShelvedEntry): Promise<ShelvedRestoreOutcome> {
    try {
      for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
        const locked = await deps.lock(entry.repoPath, () => underLock(entry))
        if (locked.ok) return locked.value
        if (locked.reason === 'unavailable') return failed(entry, 'repo-busy', locked.message)
        if (attempt < LOCK_ATTEMPTS - 1) await deps.sleep(LOCK_WAIT_MS)
      }
      return failed(
        entry,
        'repo-busy',
        'another Harnu job is working in this repository; try again in a moment'
      )
    } catch (err) {
      return failed(entry, 'worktree-add-failed', messageOf(err))
    }
  }

  function single(entry: ShelvedEntry): Promise<ShelvedRestoreOutcome> {
    const running = inflight.get(entry.id)
    if (running) return running
    const started = run(entry).finally(() => inflight.delete(entry.id))
    inflight.set(entry.id, started)
    return started
  }

  return {
    async ensure(folder) {
      const entry = shelvedEntryFor(await deps.readStore(), folder)
      return entry ? single(entry) : { status: 'not-shelved' }
    },
    async restoreById(id) {
      const entry = (await deps.readStore()).entries.find((e) => e.id === id)
      return entry ? single(entry) : { status: 'not-shelved' }
    }
  }
}

// ---- the real dependencies --------------------------------------------------------------------

const listeners = new Set<() => void>()

/** Subscribes to "a shelved worktree came back". Returns the unsubscribe. */
export function onShelvedChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

const storeFile = (): string => path.join(app.getPath('userData'), SHELVED_FILE)

export function defaultShelveRestoreDeps(over: Partial<ShelveRestoreDeps> = {}): ShelveRestoreDeps {
  return {
    readStore: () => readShelved(storeFile()),
    forget: (id) => updateShelved(storeFile(), (current) => withoutShelved(current, [id])),
    readRecord: readShelveRecord,
    restore: restoreWorktree,
    verifyLive: (record) => verifyPreservation(record, { mode: 'live' }),
    exists: (p) =>
      fs.lstat(p).then(
        () => true,
        () => false
      ),
    inUse: async (p) => (await import('../reaper/scanner-shell')).isFolderInUse(p),
    moveAside: (from, to) => fs.rename(from, to),
    lock: (repoPath, work) => withRepoLock(repoPath, work),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    changed: () => {
      for (const cb of [...listeners]) {
        try {
          cb()
        } catch (err) {
          console.warn('[gc] shelved-changed listener failed', messageOf(err))
        }
      }
    },
    ...over
  }
}

let shared: ShelveRestorer | null = null
const restorer = (): ShelveRestorer => (shared ??= createShelveRestorer(defaultShelveRestoreDeps()))

/** The default restorer: what a PTY about to start in `folder` calls first. */
export const ensureShelvedRestored = (folder: string): Promise<ShelvedRestoreOutcome> =>
  restorer().ensure(folder)

export const restoreShelvedById = (id: string): Promise<ShelvedRestoreOutcome> =>
  restorer().restoreById(id)
