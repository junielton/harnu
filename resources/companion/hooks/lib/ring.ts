import type { EventName, WireEvent } from '../contract'

/**
 * The mod's event ring (contract §6): at-least-once delivery. Events stay here until a response
 * acknowledges them; a `$` call in flight dies with an aborted turn (smoke A4), so nothing is
 * removed on send. Pure and `$`-free.
 *
 * Over `max` the ring drops coalescable events first (`usage.measured`: keep the newest, every
 * figure in it is cumulative), then the oldest, and counts what it dropped.
 */

/** Event types whose newest instance supersedes every older one. */
const COALESCABLE: ReadonlySet<EventName> = new Set<EventName>(['usage.measured'])

export type NewEvent = Omit<WireEvent, 'seq'>

export interface Ring {
  /** Assigns the next `seq`, stores the event, enforces `max`. */
  push(ev: NewEvent): WireEvent
  /** The oldest unacknowledged events, within both limits, always at least one if any exist. */
  batch(maxEvents: number, maxBytes: number): WireEvent[]
  /** Removes every event whose `seq` is at or below `seq`. */
  ack(seq: number): void
  /** Events dropped by `overflow` and not yet reported as accepted. */
  dropped(): number
  /** A batch carrying `n` was accepted: those drops are reported. */
  settleDropped(n: number): void
  /** Number of unacknowledged events. */
  size(): number
  /** A new `conn` restarts `seq` at 1: renumber what is left, in order. */
  renumber(): void
  /** Forget everything (inert, dormant). */
  clear(): void
  /** Drops until `size() <= max`: coalescable first, then the oldest. Returns the count dropped. */
  overflow(): number
}

export function createRing(max: number): Ring {
  let events: WireEvent[] = []
  let nextSeq = 1
  let droppedCount = 0

  function overflow(): number {
    let n = 0
    while (events.length > max) {
      // keep the newest coalescable event, drop an older one of the same type
      let victim = -1
      const seen = new Set<EventName>()
      for (let i = events.length - 1; i >= 0; i--) {
        const t = events[i]?.t
        if (t === undefined || !COALESCABLE.has(t)) continue
        if (seen.has(t)) {
          victim = i
          break
        }
        seen.add(t)
      }
      if (victim < 0) victim = 0
      events.splice(victim, 1)
      n++
    }
    droppedCount += n
    return n
  }

  return {
    push(ev) {
      const full: WireEvent = { ...ev, seq: nextSeq++ }
      events.push(full)
      overflow()
      return full
    },
    batch(maxEvents, maxBytes) {
      const out: WireEvent[] = []
      let bytes = 0
      for (const e of events) {
        if (out.length >= Math.max(1, maxEvents)) break
        const size = JSON.stringify(e).length
        if (out.length > 0 && bytes + size > maxBytes) break
        out.push(e)
        bytes += size
      }
      return out
    },
    ack(seq) {
      events = events.filter((e) => e.seq > seq)
    },
    dropped: () => droppedCount,
    settleDropped(n) {
      droppedCount = Math.max(0, droppedCount - n)
    },
    size: () => events.length,
    renumber() {
      events = events.map((e, i) => ({ ...e, seq: i + 1 }))
      nextSeq = events.length + 1
    },
    clear() {
      events = []
      nextSeq = 1
      droppedCount = 0
    },
    overflow
  }
}
