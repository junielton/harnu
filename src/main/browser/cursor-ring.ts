/**
 * A bounded ring of entries with `read_terminal`-style cursors (T564 U3, spec §6.2): the shared core of the
 * console buffer and the network capture store.
 *
 * Every entry gets a monotonically growing `seq`. A cursor names the last entry a reader has seen, so a
 * `since` read returns what came after it. When the ring evicts entries a cursor still points before, that
 * cursor is **expired** (the reader missed entries and must re-read with `tail`), exactly as a terminal cursor
 * expires once its line left the scrollback. `clear` is the reader's own choice, not a loss, so it never
 * expires a cursor. Pure (ADR-0001): no clock, no I/O.
 */

export interface RingLimits {
  /** Most entries held. */
  maxEntries: number
  /** Most `sizeOf` bytes held across all entries. */
  maxBytes: number
}

export interface RingEntry<T> {
  seq: number
  value: T
  bytes: number
}

export type CursorRead<T> =
  | { ok: true; entries: Array<RingEntry<T>>; cursor: string; droppedEntries: number }
  | { ok: false; error: 'CURSOR_EXPIRED' }

export interface CursorRing<T> {
  /** Append one entry; evicts the oldest while a limit is exceeded. Returns the entry's `seq`. */
  push(value: T): number
  /** The newest `limit` entries (after `keep`), oldest first, plus a cursor naming the newest one held. */
  tail(limit: number, keep?: (value: T) => boolean): CursorRead<T>
  /** Entries newer than `cursor`, oldest first, at most `limit`; `CURSOR_EXPIRED` if entries were evicted. */
  since(cursor: string, limit: number, keep?: (value: T) => boolean): CursorRead<T>
  /** Drop every entry the reader has seen. Cursors stay valid. */
  clear(): void
  /** Entries evicted by the limits since creation (never reset by `clear`). */
  readonly droppedEntries: number
  readonly size: number
}

const CURSOR_PREFIX = 'k'

export function encodeCursor(seq: number): string {
  return `${CURSOR_PREFIX}${seq}`
}

export function decodeCursor(cursor: string): number | null {
  const m = /^k(\d{1,15})$/.exec(cursor)
  return m ? Number(m[1]) : null
}

export function createCursorRing<T>(
  limits: RingLimits,
  sizeOf: (value: T) => number
): CursorRing<T> {
  let entries: Array<RingEntry<T>> = []
  let totalBytes = 0
  let nextSeq = 1
  /** Highest `seq` removed by a limit (not by `clear`): a cursor below it has missed entries. */
  let evictedThrough = 0
  let dropped = 0

  function evict(): void {
    while (
      entries.length > 0 &&
      (entries.length > limits.maxEntries || totalBytes > limits.maxBytes)
    ) {
      const old = entries.shift()!
      totalBytes -= old.bytes
      evictedThrough = old.seq
      dropped++
    }
  }

  const newestSeq = (): number => nextSeq - 1

  return {
    push(value) {
      const bytes = Math.max(0, sizeOf(value))
      const seq = nextSeq++
      entries.push({ seq, value, bytes })
      totalBytes += bytes
      evict()
      return seq
    },
    tail(limit, keep) {
      const matching = keep ? entries.filter((e) => keep(e.value)) : entries
      const picked = limit >= matching.length ? matching : matching.slice(matching.length - limit)
      return {
        ok: true,
        entries: picked,
        cursor: encodeCursor(newestSeq()),
        droppedEntries: dropped
      }
    },
    since(cursor, limit, keep) {
      const seq = decodeCursor(cursor)
      // An unknown or future cursor cannot be honoured: the reader must start over with `tail`.
      if (seq === null || seq > newestSeq() || seq < evictedThrough) {
        return { ok: false, error: 'CURSOR_EXPIRED' }
      }
      const newer = entries.filter((e) => e.seq > seq && (keep ? keep(e.value) : true))
      const picked = newer.slice(0, limit)
      // The cursor moves to the last entry returned; if the page was cut by `limit`, the rest is next time.
      const next =
        picked.length > 0 && picked.length < newer.length
          ? picked[picked.length - 1]!.seq
          : newestSeq()
      return { ok: true, entries: picked, cursor: encodeCursor(next), droppedEntries: dropped }
    },
    clear() {
      entries = []
      totalBytes = 0
    },
    get droppedEntries() {
      return dropped
    },
    get size() {
      return entries.length
    }
  }
}
