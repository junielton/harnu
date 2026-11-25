/**
 * The Your move store: one JSON file the main process owns, written atomically.
 *
 * Same discipline as the session archive store: writes are queued, and a write lands on
 * disk before it becomes the in-memory state, so a failed write (disk full, EACCES) leaves
 * the state and the listeners exactly as they were. An unreadable file is never overwritten
 * unseen: only a missing file opens empty, a corrupt or unknown-version file is copied aside
 * first, and any other read error rejects. Electron-free on purpose.
 *
 * Cost model (BUG-277): the file holds thousands of cards and the main thread reads it on every
 * hook event, so nothing here may cost O(store) per call.
 *
 * - The committed state is an immutable snapshot: every card and cursor in it is deep-frozen and
 *   owned by the store, so `state()` and every listener share it without a copy. A mutation
 *   throws (modules are strict) instead of silently corrupting what the file will hold.
 * - A commit adopts only what it has not seen: a card the store already owns is reused, a new or
 *   changed one is copied once (so a caller cannot keep a handle into the snapshot) and frozen.
 * - "Did anything change?" compares references first and falls back to a field-by-field compare
 *   of only the cards whose reference moved. No whole-state serialization, no whole-state clone.
 * - The file is built from a per-card serialization cache, so a one-card commit re-serializes
 *   one card and joins the rest.
 */

import { constants as fsConstants, promises as fs } from 'node:fs'
import * as path from 'node:path'
import { atomicWriteFile } from '../mcp/atomic-write'
import { emptyState, type SessionCursor, type YourMoveCard, type YourMoveState } from './core'

export interface YourMoveStore {
  /**
   * The committed snapshot, shared and deeply frozen: reading it costs nothing and mutating it
   * throws. Build a new state with the reducers in `core.ts` and commit it with `transact`.
   */
  state(): YourMoveState
  /**
   * Decide and commit in one serialized step. `decide` sees the state as it is after every
   * earlier write; what it returns is written, then swapped in, then announced. If `decide`
   * throws or the write fails, nothing changes and the promise rejects. A `next` with the same
   * content as the current state (even as a new object) is a no-op: no write, no announcement.
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

// ---- snapshot ownership -------------------------------------------------------------

/** Cards and cursors the store itself froze: safe to share, and keys of the serialization cache. */
const owned = new WeakSet<object>()
/** One card's JSON, computed once per owned (immutable) object. */
const serialized = new WeakMap<object, string>()

function freezeDeep(v: unknown): void {
  if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return
  Object.freeze(v)
  for (const k of Object.keys(v)) freezeDeep((v as Record<string, unknown>)[k])
}

/** Take one card or cursor into the snapshot: reuse what is ours, copy and freeze what is not. */
function own<T extends object>(v: T, fresh: boolean): T {
  if (owned.has(v)) return v
  // `fresh` values came straight out of JSON.parse and nothing else holds them.
  const mine = fresh ? v : structuredClone(v)
  freezeDeep(mine)
  owned.add(mine)
  return mine
}

function adopt(s: YourMoveState, fresh: boolean): YourMoveState {
  const cards = s.cards.map((c) => own(c, fresh))
  const cursors: Record<string, SessionCursor> = {}
  for (const k of Object.keys(s.cursors)) cursors[k] = own(s.cursors[k], fresh)
  return Object.freeze({
    version: 1 as const,
    cards: Object.freeze(cards) as YourMoveCard[],
    cursors: Object.freeze(cursors)
  })
}

/** JSON equality of two values, treating an `undefined` property as absent, as the file does. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined)
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!sameJson(ra[k], rb[k])) return false
  return true
}

/** Whether `next` would write a different file than `cur`: O(cards) reference checks, no JSON. */
function differs(cur: YourMoveState, next: YourMoveState): boolean {
  if (next.cards.length !== cur.cards.length) return true
  for (let i = 0; i < cur.cards.length; i++) {
    if (cur.cards[i] !== next.cards[i] && !sameJson(cur.cards[i], next.cards[i])) return true
  }
  const ck = Object.keys(cur.cursors)
  if (ck.length !== Object.keys(next.cursors).length) return true
  for (const k of ck) {
    const n = next.cursors[k]
    if (n === undefined || (cur.cursors[k] !== n && !sameJson(cur.cursors[k], n))) return true
  }
  return false
}

const cardJson = (c: YourMoveCard): string => {
  let line = serialized.get(c)
  if (line === undefined) {
    line = JSON.stringify(c)
    serialized.set(c, line)
  }
  return line
}

/** The file body: one card per line so it stays greppable, still plain JSON for any reader. */
function serialize(s: YourMoveState): string {
  const cards = s.cards.map(cardJson).join(',\n')
  return `{"version":1,"cards":[\n${cards}\n],"cursors":${JSON.stringify(s.cursors)}}\n`
}

export async function openYourMoveStore(filePath: string): Promise<YourMoveStore> {
  let current = adopt(await readState(filePath), true)
  const listeners = new Set<(s: YourMoveState) => void>()
  let queue: Promise<unknown> = Promise.resolve()

  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = queue.then(job, job)
    queue = run.catch(() => undefined)
    return run
  }

  return {
    state: () => current,
    transact: (decide) =>
      enqueue(async () => {
        const { next, result } = decide(current)
        if (next !== current && differs(current, next)) {
          const adopted = adopt(next, false)
          await fs.mkdir(path.dirname(filePath), { recursive: true })
          await atomicWriteFile(filePath, serialize(adopted), 0o600)
          current = adopted
          for (const cb of listeners) {
            try {
              cb(current)
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
