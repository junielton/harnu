/**
 * The main-process archive store (T655).
 *
 * "Archive" (the sidebar's put-away action) used to be renderer-only state in
 * `localStorage`, which no MCP verb can write and which does not exist while the window
 * is closed. The authoritative set now lives here: one JSON file the main process owns,
 * `{ version: 1, ids, legacyImported }`, written atomically. The renderer hydrates from it,
 * writes through it and listens for {@link SessionArchiveStore.onChange}; the
 * `archive_session` verb is a second caller of the same store.
 *
 * Electron-free on purpose (node fs + the MCP layer's atomic writer only), so the store
 * runs in the plain `node` vitest env. `session-archive-ipc.ts` is the thin electron shell.
 * It never touches any file but its own: archiving a session leaves the transcript and the
 * worktree exactly where they were.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from './mcp/atomic-write'

/** On-disk shape. `legacyImported` marks the one-time `localStorage` import as done. */
interface ArchiveFile {
  version: 1
  ids: string[]
  legacyImported: boolean
}

/** What a {@link SessionArchiveStore.transact} callback decides from the archive set it was handed. */
export interface ArchiveTransaction<T> {
  /** Ids to add (those already archived are skipped). */
  archive?: readonly string[]
  /** Ids to drop (those not archived are skipped). */
  unarchive?: readonly string[]
  /** Handed back to the caller once the write (if any) is on disk. */
  result: T
}

export interface SessionArchiveStore {
  /**
   * The archived ids right now, as a COPY: a caller that mutates it (or casts away the
   * `ReadonlySet`) changes nothing the store, the file or the next ACK is built from.
   */
  ids(): ReadonlySet<string>
  has(sessionId: string): boolean
  /** Archive these ids. Resolves with the ids that were NOT archived before (empty when idempotent). */
  archive(sessionIds: readonly string[]): Promise<string[]>
  /** Restore these ids. Resolves with the ids that WERE archived before. */
  unarchive(sessionIds: readonly string[]): Promise<string[]>
  /**
   * Decide AND apply in one serialized step: `decide` runs inside the store's write queue,
   * against the set as it is after every earlier write has landed, and what it returns is
   * committed before the next job starts. A verb that must report what changed (the
   * `archive_session` ACK) plans here, never from a snapshot taken before it queued, so N
   * concurrent callers get outcomes consistent with one serial order. If `decide` throws or
   * the write fails, nothing changes and the promise rejects.
   */
  transact<T>(decide: (current: ReadonlySet<string>) => ArchiveTransaction<T>): Promise<T>
  /**
   * Merge the renderer's old `localStorage` ids, exactly once. The first call merges and
   * marks the import done (even for an empty list); every later call is ignored.
   */
  importLegacy(sessionIds: readonly string[]): Promise<{ imported: boolean; added: string[] }>
  legacyImported(): boolean
  /** Subscribe to changes; the callback gets the ids whose state flipped. Returns an unsubscribe. */
  onChange(cb: (changedIds: string[]) => void): () => void
}

const ARCHIVE_FILE_VERSION = 1

function cleanIds(input: readonly unknown[]): string[] {
  const out: string[] = []
  for (const v of input) if (typeof v === 'string' && v.length > 0 && !out.includes(v)) out.push(v)
  return out
}

async function readArchiveFile(filePath: string): Promise<ArchiveFile> {
  const empty: ArchiveFile = { version: ARCHIVE_FILE_VERSION, ids: [], legacyImported: false }
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    return empty
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ArchiveFile> | null
    if (!parsed || typeof parsed !== 'object' || parsed.version !== ARCHIVE_FILE_VERSION) {
      return empty
    }
    return {
      version: ARCHIVE_FILE_VERSION,
      ids: Array.isArray(parsed.ids) ? cleanIds(parsed.ids) : [],
      legacyImported: parsed.legacyImported === true
    }
  } catch {
    // Corrupt JSON: open empty; the next write repairs the file.
    return empty
  }
}

/** Open (or create lazily on first write) the archive store at `filePath`. */
export async function openSessionArchive(filePath: string): Promise<SessionArchiveStore> {
  const initial = await readArchiveFile(filePath)
  let set = new Set<string>(initial.ids)
  let imported = initial.legacyImported
  const listeners = new Set<(changed: string[]) => void>()
  // Writes are serialised: every mutation chains behind the previous one, so two
  // concurrent callers can never interleave a read-modify-write and drop an id.
  let queue: Promise<unknown> = Promise.resolve()

  /**
   * Write `nextIds` / `nextImported` to disk, and only then make them the in-memory state:
   * a failed write (disk full, EACCES) throws with the set, the import flag and the
   * listeners exactly as they were, so memory never runs ahead of the file.
   */
  async function commit(nextIds: Set<string>, nextImported: boolean): Promise<void> {
    const body: ArchiveFile = {
      version: ARCHIVE_FILE_VERSION,
      ids: [...nextIds],
      legacyImported: nextImported
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await atomicWriteFile(filePath, JSON.stringify(body, null, 2) + '\n', 0o600)
    set = nextIds
    imported = nextImported
  }

  function emit(changed: string[]): void {
    if (changed.length === 0) return
    for (const cb of listeners) {
      try {
        cb(changed)
      } catch {
        /* a broken listener must never block the others or the write */
      }
    }
  }

  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job, job)
    queue = run.catch(() => undefined)
    return run
  }

  return {
    ids: () => new Set(set),
    has: (id) => set.has(id),
    transact: (decide) =>
      enqueue(async () => {
        const tx = decide(new Set(set))
        const added = cleanIds(tx.archive ?? []).filter((id) => !set.has(id))
        const removed = cleanIds(tx.unarchive ?? []).filter(
          (id) => set.has(id) && !added.includes(id)
        )
        if (added.length > 0 || removed.length > 0) {
          await commit(new Set([...set, ...added].filter((id) => !removed.includes(id))), imported)
          emit([...added, ...removed])
        }
        return tx.result
      }),
    archive: (sessionIds) =>
      enqueue(async () => {
        const added = cleanIds(sessionIds).filter((id) => !set.has(id))
        if (added.length === 0) return []
        await commit(new Set([...set, ...added]), imported)
        emit(added)
        return added
      }),
    unarchive: (sessionIds) =>
      enqueue(async () => {
        const removed = cleanIds(sessionIds).filter((id) => set.has(id))
        if (removed.length === 0) return []
        await commit(new Set([...set].filter((id) => !removed.includes(id))), imported)
        emit(removed)
        return removed
      }),
    importLegacy: (sessionIds) =>
      enqueue(async () => {
        if (imported) return { imported: false, added: [] }
        const added = cleanIds(sessionIds).filter((id) => !set.has(id))
        await commit(new Set([...set, ...added]), true)
        emit(added)
        return { imported: true, added }
      }),
    legacyImported: () => imported,
    onChange: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}

// ---- process-wide handle ------------------------------------------------------------
// The MCP handler reaches the store through this registry (like `getGcService`), so it
// never imports electron. `registerSessionArchive` in `session-archive-ipc.ts` sets it.

let current: SessionArchiveStore | null = null

export function setSessionArchive(store: SessionArchiveStore | null): void {
  current = store
}

export function getSessionArchive(): SessionArchiveStore | null {
  return current
}
