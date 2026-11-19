/**
 * The Your move store: one JSON file the main process owns, written atomically.
 *
 * Same discipline as the session archive store: writes are queued, and a write lands on
 * disk before it becomes the in-memory state, so a failed write (disk full, EACCES) leaves
 * the state and the listeners exactly as they were. An unreadable file is never overwritten
 * unseen: only a missing file opens empty, a corrupt or unknown-version file is copied aside
 * first, and any other read error rejects. Electron-free on purpose.
 */

import { constants as fsConstants, promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from '../mcp/atomic-write'
import { emptyState, type YourMoveState } from './core'

export interface YourMoveStore {
  /** A deep copy: mutating it changes nothing the store or the file holds. */
  state(): YourMoveState
  /**
   * Decide and commit in one serialized step. `decide` sees the state as it is after every
   * earlier write; what it returns is written, then swapped in, then announced. If `decide`
   * throws or the write fails, nothing changes and the promise rejects.
   */
  transact<T>(decide: (s: YourMoveState) => { next: YourMoveState; result: T }): Promise<T>
  onChange(cb: (s: YourMoveState) => void): () => void
}

/** Only a missing file means first run; anything else must never be read as "empty". */
const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOENT'

/**
 * Copy the unreadable bytes next to the file BEFORE the store opens empty, so the first write
 * cannot destroy unanswered cards (or a newer version's file after a downgrade). If the copy
 * cannot be made this throws and the store does not open: losing the evidence silently is
 * the anti-goal of this feature. Returns the path of the copy.
 */
async function keepAside(filePath: string, why: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (let n = 0; ; n++) {
    const dest = `${filePath}.unreadable-${stamp}${n === 0 ? '' : `-${n}`}`
    try {
      await fs.copyFile(filePath, dest, fsConstants.COPYFILE_EXCL)
      console.warn(`[your-move] ${why}: kept the file aside at ${dest} and starting empty`)
      return dest
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
}

async function readState(filePath: string): Promise<YourMoveState> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (e) {
    if (isMissing(e)) return emptyState()
    throw e // EACCES, EIO, EISDIR…: the file is left exactly as it is
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    await keepAside(filePath, 'state file is not valid JSON')
    return emptyState()
  }
  const o = parsed as Partial<YourMoveState> | null
  if (!o || typeof o !== 'object' || Array.isArray(o) || o.version !== 1) {
    await keepAside(filePath, 'state file has an unknown version')
    return emptyState()
  }
  const cursorsOk =
    o.cursors === undefined ||
    (typeof o.cursors === 'object' && o.cursors !== null && !Array.isArray(o.cursors))
  if ((o.cards !== undefined && !Array.isArray(o.cards)) || !cursorsOk) {
    await keepAside(filePath, 'state file has an unexpected shape')
    return emptyState()
  }
  return { version: 1, cards: o.cards ?? [], cursors: o.cursors ?? {} }
}

export async function openYourMoveStore(filePath: string): Promise<YourMoveStore> {
  let current = await readState(filePath)
  const listeners = new Set<(s: YourMoveState) => void>()
  let queue: Promise<unknown> = Promise.resolve()

  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job, job)
    queue = run.catch(() => undefined)
    return run
  }

  return {
    state: () => structuredClone(current),
    transact: (decide) =>
      enqueue(async () => {
        const { next, result } = decide(structuredClone(current))
        if (next !== current && JSON.stringify(next) !== JSON.stringify(current)) {
          await fs.mkdir(path.dirname(filePath), { recursive: true })
          await atomicWriteFile(filePath, JSON.stringify(next, null, 2) + '\n', 0o600)
          current = structuredClone(next)
          for (const cb of listeners) {
            try {
              cb(structuredClone(current))
            } catch {
              /* a broken listener must never block the others or the write */
            }
          }
        }
        return result
      }),
    onChange: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}

// ---- process-wide handle ------------------------------------------------------------

let handle: YourMoveStore | null = null

export function setYourMoveStore(s: YourMoveStore | null): void {
  handle = s
}

export function getYourMoveStore(): YourMoveStore | null {
  return handle
}
