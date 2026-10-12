// The prep journal (delta 2): a guided prep (unlock, stop a stack) writes what it is about to change
// BEFORE changing it and clears the entry when the item ends (success, or rolled back). If Harnu quits or
// crashes in between, the entry is still there at the next boot, and an orphaned one whose worktree folder
// still exists is put back: the lock returns with its original reason, the stopped containers start again
// if their bind sources are still there. Plain JSON in userData; every effect is injected for the boot.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { DockerBatchResult } from '../containers/containers-actions'

export interface UnlockEntry {
  kind: 'unlock'
  at: number
  repoPath: string
  path: string
  /** What git recorded with the lock, exactly (null when it recorded none). */
  reason: string | null
}

export interface StopEntry {
  kind: 'stop-stack'
  at: number
  /** The worktree whose removal the stop was for. */
  path: string
  containerIds: string[]
  containerNames: string[]
  /** Every bind-mount source of the stack: the containers are started again only if these still exist. */
  bindSources: string[]
}

export type PrepEntryInput = UnlockEntry | StopEntry
export type PrepEntry = PrepEntryInput & { id: string }

export const PREP_JOURNAL_FILE = 'gc-prep-journal.json'

export interface PrepJournal {
  begin(entry: PrepEntryInput): Promise<string>
  end(id: string): Promise<void>
  entries(): Promise<PrepEntry[]>
}

/** A journal in one JSON file. A missing or corrupt file reads as empty and never throws. */
export function createPrepJournal(file: string): PrepJournal {
  // Writes are serialized: two preps may begin at once.
  let chain: Promise<unknown> = Promise.resolve()
  const read = async (): Promise<PrepEntry[]> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
      return Array.isArray(parsed) ? (parsed as PrepEntry[]) : []
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
    begin: (entry) =>
      locked(async () => {
        const id = randomUUID()
        await write([...(await read()), { ...entry, id }])
        return id
      }),
    end: (id) =>
      locked(async () => {
        await write((await read()).filter((e) => e.id !== id))
      }),
    entries: read
  }
}

export interface RecoveryDeps {
  exists(path: string): Promise<boolean>
  /** `undefined` when the worktree is not locked now. */
  lockReason(repoPath: string, path: string): Promise<string | null | undefined>
  lock(repoPath: string, path: string, reason: string | null): Promise<void>
  start(ids: string[]): Promise<DockerBatchResult>
}

export interface RecoveryReport {
  outcome: 'relocked' | 'restarted' | 'left' | 'dropped' | 'failed'
  kind: PrepEntry['kind']
  path: string
  /** Container names for a stack entry. */
  detail: string
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Boot recovery: puts back what a prep changed when Harnu stopped before it could. An entry whose
 * worktree folder is gone is dropped (nothing to roll back to). A rollback that fails keeps its entry for
 * the next boot. Returns one report per entry, for Activity.
 */
export async function recoverPrepJournal(
  journal: PrepJournal,
  deps: RecoveryDeps
): Promise<RecoveryReport[]> {
  const out: RecoveryReport[] = []
  for (const e of await journal.entries()) {
    const base = { kind: e.kind, path: e.path }
    try {
      if (!(await deps.exists(e.path))) {
        out.push({ ...base, outcome: 'dropped', detail: '' })
      } else if (e.kind === 'unlock') {
        if ((await deps.lockReason(e.repoPath, e.path)) === undefined) {
          await deps.lock(e.repoPath, e.path, e.reason)
          out.push({ ...base, outcome: 'relocked', detail: e.reason ?? '' })
        }
      } else {
        const sourcesThere = (await Promise.all(e.bindSources.map((p) => deps.exists(p)))).every(
          Boolean
        )
        if (sourcesThere) {
          const r = await deps.start(e.containerIds)
          if (r.error || r.done.length < e.containerIds.length) {
            throw new Error(r.error ?? 'not every container started')
          }
          out.push({ ...base, outcome: 'restarted', detail: e.containerNames.join(', ') })
        } else {
          out.push({ ...base, outcome: 'left', detail: e.containerNames.join(', ') })
        }
      }
      await journal.end(e.id)
    } catch (err) {
      // Kept: the next boot tries again.
      out.push({ ...base, outcome: 'failed', detail: messageOf(err) })
    }
  }
  return out
}
