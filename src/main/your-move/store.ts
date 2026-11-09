/**
 * The Your move store: one JSON file the main process owns, written atomically.
 *
 * Same discipline as the session archive store: writes are queued, and a write lands on
 * disk before it becomes the in-memory state, so a failed write (disk full, EACCES) leaves
 * the state and the listeners exactly as they were. Electron-free on purpose.
 */

import { promises as fs } from 'node:fs'
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

async function readState(filePath: string): Promise<YourMoveState> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    return emptyState()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<YourMoveState> | null
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return emptyState()
    return {
      version: 1,
      cards: Array.isArray(parsed.cards) ? parsed.cards : [],
      cursors:
        parsed.cursors && typeof parsed.cursors === 'object' && !Array.isArray(parsed.cursors)
          ? parsed.cursors
          : {}
    }
  } catch {
    // Corrupt JSON: open empty; the next write repairs the file.
    return emptyState()
  }
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
