// The prep journal (delta 2, delta 3): a guided prep (unlock, stop a stack) writes what it is about to
// change BEFORE changing it and clears the entry when the item ends (success, or rolled back). If Harnu
// quits or crashes in between, the entry is still there at the next boot.
//
// What the next boot does about it is deliberately cautious:
//  - a lock is put back only when the worktree is provably the same one (admin directory id, gitdir, HEAD,
//    and the admin directory itself, which a removed-and-added worktree does not keep);
//  - containers are never started on Harnu's own initiative: an interrupted stop is a notice that asks;
//  - everything that needs the operator stays as a notice until they answer or dismiss it, and is
//    announced once (an entry is kept until the renderer acknowledges the announcement, so it cannot be
//    lost between the boot and the first time Cleanup is open).
// Plain JSON in userData; every effect is injected for the boot.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { DockerBatchResult } from '../containers/containers-actions'
import type { GcRecoveryAction, GcRecoveryItem } from './gc-wire'

/** Who a locked worktree is: enough to tell it from a different worktree later created at the same path. */
export interface LockIdentity {
  adminId: string
  gitdir: string
  head: string | null
  /** The admin directory's inode and birth time: a worktree removed and added again gets a new one. */
  inode: number
  birth: number
}

export interface UnlockEntry {
  kind: 'unlock'
  at: number
  repoPath: string
  path: string
  /** What git recorded with the lock, exactly (null when it recorded none). */
  reason: string | null
  /** Null when it could not be read: a boot recovery then never trusts the entry. */
  identity: LockIdentity | null
}

export interface StopEntry {
  kind: 'stop-stack'
  at: number
  /** The worktree whose removal the stop was for. */
  path: string
  containerIds: string[]
  containerNames: string[]
  /** Every folder the stack's containers use. */
  bindSources: string[]
}

export type PrepEntryInput = UnlockEntry | StopEntry

export type NoticeKind = 'stack-stopped' | 'lock-skipped' | 'containers-gone'

export type PrepEntry = PrepEntryInput & {
  id: string
  /** The run (process) that wrote it: an entry of the running Harnu is a prep in flight, not an orphan. */
  run: string
  /** `pending`: never recovered; `notice`: needs the operator; `resolved`: put back, awaiting its announcement. */
  state: 'pending' | 'notice' | 'resolved'
  announced: boolean
  notice?: NoticeKind
  detail?: string
  outcome?: 'relocked'
}

export const PREP_JOURNAL_FILE = 'gc-prep-journal.json'

export interface PrepJournal {
  begin(entry: PrepEntryInput): Promise<string>
  end(id: string): Promise<void>
  update(id: string, patch: Partial<PrepEntry>): Promise<void>
  entries(): Promise<PrepEntry[]>
  /** The run this journal writes under. */
  readonly run: string
}

/** A journal in one JSON file. A missing or corrupt file reads as empty and never throws. */
export function createPrepJournal(file: string, run: string = randomUUID()): PrepJournal {
  // Writes are serialized: two preps may begin at once.
  let chain: Promise<unknown> = Promise.resolve()
  const read = async (): Promise<PrepEntry[]> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (!Array.isArray(parsed)) return []
      // An entry from before the states existed is a pending one from another run.
      return (parsed as Array<Partial<PrepEntry>>).map(
        (e) => ({ run: 'legacy', state: 'pending', announced: false, ...e }) as PrepEntry
      )
    } catch {
      return []
    }
  }
  const write = async (entries: PrepEntry[]): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(entries), 'utf8')
    await rename(tmp, file)
  }
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }
  return {
    run,
    begin: (entry) =>
      locked(async () => {
        const id = randomUUID()
        await write([
          ...(await read()),
          { ...entry, id, run, state: 'pending', announced: false } as PrepEntry
        ])
        return id
      }),
    end: (id) =>
      locked(async () => {
        await write((await read()).filter((e) => e.id !== id))
      }),
    update: (id, patch) =>
      locked(async () => {
        await write(
          (await read()).map((e) => (e.id === id ? ({ ...e, ...patch } as PrepEntry) : e))
        )
      }),
    entries: read
  }
}

export interface RecoveryDeps {
  exists(path: string): Promise<boolean>
  /** `undefined` when the worktree is not locked now. */
  lockReason(repoPath: string, path: string): Promise<string | null | undefined>
  /** Who the worktree at `path` is now; null when git has no (single) registration for it. */
  identityOf(repoPath: string, path: string): Promise<LockIdentity | null>
  lock(repoPath: string, path: string, reason: string | null): Promise<void>
  /** Of these container ids, the ones that still exist. */
  containersPresent(ids: string[]): Promise<string[]>
  start(ids: string[]): Promise<DockerBatchResult>
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Whether two readings are provably the same worktree. A creation time of 0 means the filesystem did not
 * say, which proves nothing: without it the admin directory cannot be told from a re-created one.
 */
const sameIdentity = (a: LockIdentity | null, b: LockIdentity | null): boolean =>
  !!a &&
  !!b &&
  a.birth !== 0 &&
  b.birth !== 0 &&
  a.adminId === b.adminId &&
  a.gitdir === b.gitdir &&
  a.head === b.head &&
  a.inode === b.inode &&
  a.birth === b.birth

/**
 * Boot recovery for the entries a previous run left `pending`. A lock goes back only when the worktree is
 * provably the same one; containers are never started here. Whatever needs the operator becomes a notice
 * (kept until answered, announced once); a folder that is gone is dropped silently. Entries of THIS run
 * are preps in flight and are left alone; entries already turned into notices are not touched again.
 */
export async function recoverPrepJournal(journal: PrepJournal, deps: RecoveryDeps): Promise<void> {
  for (const e of await journal.entries()) {
    if (e.state !== 'pending' || e.run === journal.run) continue
    try {
      if (!(await deps.exists(e.path))) {
        await journal.end(e.id)
      } else if (e.kind === 'unlock') {
        if ((await deps.lockReason(e.repoPath, e.path)) !== undefined) {
          await journal.end(e.id) // locked again already (by hand, or by the rollback): nothing to do
        } else if (sameIdentity(e.identity, await deps.identityOf(e.repoPath, e.path))) {
          try {
            await deps.lock(e.repoPath, e.path, e.reason)
            await journal.update(e.id, { state: 'resolved', outcome: 'relocked' })
          } catch (err) {
            await journal.update(e.id, {
              state: 'notice',
              notice: 'lock-skipped',
              detail: messageOf(err)
            })
          }
        } else {
          await journal.update(e.id, { state: 'notice', notice: 'lock-skipped', detail: '' })
        }
      } else {
        const present = await deps.containersPresent(e.containerIds)
        await journal.update(e.id, {
          state: 'notice',
          notice: present.length === 0 ? 'containers-gone' : 'stack-stopped',
          detail: e.containerNames.join(', ')
        })
      }
    } catch (err) {
      // Whatever could not even be judged waits for the operator rather than being retried silently.
      await journal.update(e.id, {
        state: 'notice',
        notice: e.kind === 'unlock' ? 'lock-skipped' : 'stack-stopped',
        detail: messageOf(err)
      })
    }
  }
}

/**
 * Why containers must not be started again, or null when they may: starting them with a folder or a
 * bind source gone makes docker recreate those as empty folders.
 */
async function cannotStart(
  e: StopEntry,
  deps: Pick<RecoveryDeps, 'exists'>
): Promise<string | null> {
  for (const p of [e.path, ...e.bindSources]) {
    if (!(await deps.exists(p))) {
      return `its folder is gone (${p}); starting it would recreate empty folders`
    }
  }
  return null
}

/**
 * What the renderer shows: notices (until answered) and put-back reports (until acknowledged). With
 * `deps`, a stack notice also says whether starting it again is possible right now.
 */
export async function listRecovery(
  journal: PrepJournal,
  deps?: Pick<RecoveryDeps, 'exists'>
): Promise<GcRecoveryItem[]> {
  const out: GcRecoveryItem[] = []
  for (const e of await journal.entries()) {
    if (!(e.state === 'notice' || (e.state === 'resolved' && !e.announced))) continue
    const why =
      deps && e.kind === 'stop-stack' && e.notice === 'stack-stopped'
        ? await cannotStart(e, deps)
        : undefined
    out.push({
      id: e.id,
      state: e.state as 'notice' | 'resolved',
      kind: e.kind,
      ...(e.notice ? { notice: e.notice } : {}),
      ...(e.outcome ? { outcome: e.outcome } : {}),
      path: e.path,
      detail: e.detail ?? '',
      announced: e.announced,
      ...(why !== undefined ? { canStart: why === null, ...(why ? { cannotStart: why } : {}) } : {})
    })
  }
  return out
}

/** The renderer showed these in Activity: they are not announced again, and a put-back report is done. */
export async function ackRecovery(journal: PrepJournal, ids: readonly string[]): Promise<void> {
  for (const e of await journal.entries()) {
    if (!ids.includes(e.id)) continue
    if (e.state === 'resolved') await journal.end(e.id)
    else await journal.update(e.id, { announced: true })
  }
}

/** The operator's answer to a notice. A failed action keeps the notice and says why. */
export async function actOnRecovery(
  journal: PrepJournal,
  id: string,
  action: GcRecoveryAction,
  deps: RecoveryDeps
): Promise<{ ok: true } | { ok: false; error: string }> {
  const e = (await journal.entries()).find((x) => x.id === id && x.state === 'notice')
  if (!e) return { ok: false, error: 'no such notice' }
  if (action === 'dismiss') {
    await journal.end(id)
    return { ok: true }
  }
  try {
    if (action === 'start' && e.kind === 'stop-stack') {
      // Checked again NOW: a folder may have gone since the notice was listed.
      const why = await cannotStart(e, deps)
      if (why) return { ok: false, error: why }
      const r = await deps.start(e.containerIds)
      if (r.error || r.done.length < e.containerIds.length) {
        return { ok: false, error: r.error ?? 'not every container started' }
      }
    } else if (action === 'lock' && e.kind === 'unlock') {
      await deps.lock(e.repoPath, e.path, e.reason)
    } else {
      return { ok: false, error: 'that answer does not fit this notice' }
    }
  } catch (err) {
    return { ok: false, error: messageOf(err) }
  }
  await journal.end(id)
  return { ok: true }
}
