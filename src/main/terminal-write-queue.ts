/**
 * Terminal write queue, pure (T474 unit B5, spec §4.4 "Concurrency and the total time bound"):
 * what makes several agents typing into one terminal orderly.
 *
 *  - **FIFO per terminal.** Writes to one terminal are serialised in arrival order; different
 *    terminals do not wait on each other. "Arrival" is the moment the call reached the server, not
 *    the moment it reached the queue: a call takes a TICKET synchronously on entry
 *    ({@link reserve}), before any `await`, and the line honours ticket order. A call that did
 *    async I/O (prefs, project file) on its way here can therefore never overtake an earlier one.
 *  - **Bounded wait.** A send that is not at the head of the line within {@link QUEUE_WAIT_MS}
 *    gives up with `TERMINAL_BUSY` and leaves the queue, so a stuck write cannot hold the
 *    120 s tool deadline hostage (queue ≤ 10 s + barrier ≤ 2 s + settle fits well inside it).
 *  - **Rate limit.** At most {@link RATE_LIMIT_PER_MIN} sends per terminal in any rolling minute
 *    (`TERMINAL_RATE_LIMIT`). The limit is checked when a call is admitted, before it queues, so a
 *    refused call costs nothing and a flood cannot fill the line.
 *  - **Who else wrote.** Every admitted call is a scope; a write by one scope marks every OTHER
 *    scope open on that terminal `othersWrote`, which is what the result reports.
 *  - **One send, one write** — except the `Esc` gap: {@link writeSegments} writes a send's pieces
 *    {@link ESC_GAP_MS} apart (an `Esc` straight into text reads as Meta+key).
 *
 * The queue holds the line only while bytes are being written. A call that is settling or
 * waiting on output has already released it (spec §4.4: a waiting call does not hold the queue).
 *
 * Pure (ADR-0001): the clock and the timer are injected.
 */
import { ESC_GAP_MS } from './terminal-keys'

/** Longest a send waits behind others before `TERMINAL_BUSY` (spec §4.4). */
export const QUEUE_WAIT_MS = 10_000
/** Sends per terminal per rolling minute (spec §4.4). */
export const RATE_LIMIT_PER_MIN = 60
const RATE_WINDOW_MS = 60_000

export type WriteQueueError = 'TERMINAL_BUSY' | 'TERMINAL_RATE_LIMIT'

export interface WriteQueueDeps {
  now: () => number
  /** `setTimeout` look-alike; returns a cancel function. */
  startTimer: (fn: () => void, ms: number) => () => void
}

const realDeps: WriteQueueDeps = {
  now: () => Date.now(),
  startTimer: (fn, ms) => {
    const t = setTimeout(fn, ms)
    return () => clearTimeout(t)
  }
}

/** One admitted call. Its flags are read when the call finishes. */
export interface WriteScope {
  /** Another call wrote to this terminal while this one was open. */
  othersWrote: boolean
  /** Epoch ms the call was admitted — what "during the call" is measured from. */
  readonly startedAt: number
  /** Arrival order on this terminal: the line serves the lowest ticket first. */
  readonly ticket: number
}

interface TerminalLine {
  /** The scope currently at the head of the line, writing. */
  holder: WriteScope | null
  waiters: { scope: WriteScope; grant: () => void }[]
  /** Scopes admitted and not yet finished, queued or not. */
  open: Set<WriteScope>
  /** Admission times within the rolling window. */
  admitted: number[]
  /** Last ticket handed out. */
  lastTicket: number
  /** Tickets taken whose call has not reached {@link TerminalWriteQueue.acquire} (or given up) yet. */
  unarrived: Set<number>
}

export class TerminalWriteQueue {
  private readonly lines = new Map<string, TerminalLine>()
  private readonly reserved = new WeakMap<object, { terminalId: string; ticket: number }>()

  constructor(
    private readonly deps: WriteQueueDeps = realDeps,
    private readonly opts: { queueWaitMs?: number; ratePerMin?: number } = {}
  ) {}

  private line(terminalId: string): TerminalLine {
    let l = this.lines.get(terminalId)
    if (!l) {
      l = {
        holder: null,
        waiters: [],
        open: new Set(),
        admitted: [],
        lastTicket: 0,
        unarrived: new Set()
      }
      this.lines.set(terminalId, l)
    }
    return l
  }

  /**
   * Take the next place in `terminalId`'s line for the call identified by `key` (its args object).
   * Synchronous by contract: call it on entry, before any `await`, so the place reflects when the
   * call ARRIVED. The call must {@link claim} it, or {@link drop} it if it never gets that far.
   */
  reserve(key: object, terminalId: string): void {
    this.reserved.set(key, { terminalId, ticket: this.takeTicket(terminalId) })
  }

  /**
   * The ticket reserved for `key`, or a fresh one when none was (a call that did not come through
   * the server's entry point, e.g. an operator Allow actuating a parked call). Either way the
   * caller owns it from here and must {@link abandonTicket} it when done (a no-op once used).
   */
  claim(key: object, terminalId: string): number {
    const r = this.reserved.get(key)
    if (r && r.terminalId === terminalId) {
      this.reserved.delete(key)
      return r.ticket
    }
    return this.takeTicket(terminalId)
  }

  /** Give up a reservation nobody claimed (the call was refused or parked before the handler). */
  drop(key: object): void {
    const r = this.reserved.get(key)
    if (!r) return
    this.reserved.delete(key)
    this.abandonTicket(r.terminalId, r.ticket)
  }

  private takeTicket(terminalId: string): number {
    const l = this.line(terminalId)
    const ticket = ++l.lastTicket
    l.unarrived.add(ticket)
    return ticket
  }

  /**
   * A ticket that will not reach {@link acquire}: stop holding the calls behind it back.
   * Idempotent, and a no-op for a ticket that already arrived.
   */
  abandonTicket(terminalId: string, ticket: number): void {
    const l = this.lines.get(terminalId)
    if (!l) return
    l.unarrived.delete(ticket)
    this.pump(l)
  }

  /**
   * Admit one call to `terminalId`: rate-limit it, then open its scope. `ticket` is the one
   * {@link claim} returned; without it the call takes its place now. Returns the scope, or
   * `TERMINAL_RATE_LIMIT`. Every successful admit must be paired with one {@link finish}.
   */
  admit(
    terminalId: string,
    ticket?: number
  ): { ok: true; scope: WriteScope } | { ok: false; error: 'TERMINAL_RATE_LIMIT' } {
    const l = this.line(terminalId)
    const now = this.deps.now()
    const cutoff = now - RATE_WINDOW_MS
    l.admitted = l.admitted.filter((t) => t > cutoff)
    if (l.admitted.length >= (this.opts.ratePerMin ?? RATE_LIMIT_PER_MIN)) {
      return { ok: false, error: 'TERMINAL_RATE_LIMIT' }
    }
    l.admitted.push(now)
    const scope: WriteScope = {
      othersWrote: false,
      startedAt: now,
      ticket: ticket ?? ++l.lastTicket
    }
    l.open.add(scope)
    return { ok: true, scope }
  }

  /**
   * Wait for the head of the line on `terminalId`: the lowest ticket, once no earlier ticket is
   * still on its way. Resolves `true` once the caller holds it (it must {@link release}), or
   * `false` when {@link QUEUE_WAIT_MS} passed first (`TERMINAL_BUSY`; the caller is no longer
   * queued).
   */
  acquire(terminalId: string, scope: WriteScope): Promise<boolean> {
    const l = this.line(terminalId)
    l.unarrived.delete(scope.ticket)
    if (l.holder === null && l.waiters.length === 0 && !this.earlierOnItsWay(l, scope.ticket)) {
      l.holder = scope
      return Promise.resolve(true)
    }
    return new Promise<boolean>((resolve) => {
      let settled = false
      const entry = {
        scope,
        grant: (): void => {
          if (settled) return
          settled = true
          cancel()
          l.holder = scope
          resolve(true)
        }
      }
      const cancel = this.deps.startTimer(() => {
        if (settled) return
        settled = true
        l.waiters = l.waiters.filter((w) => w !== entry)
        resolve(false)
      }, this.opts.queueWaitMs ?? QUEUE_WAIT_MS)
      // Sorted by ticket: the line serves arrival order, whatever order the calls got here in.
      const at = l.waiters.findIndex((w) => w.scope.ticket > scope.ticket)
      if (at === -1) l.waiters.push(entry)
      else l.waiters.splice(at, 0, entry)
      this.pump(l)
    })
  }

  /** Give the head of the line to the next waiter. */
  release(terminalId: string, scope: WriteScope): void {
    const l = this.lines.get(terminalId)
    if (!l || l.holder !== scope) return
    l.holder = null
    this.pump(l)
  }

  private earlierOnItsWay(l: TerminalLine, ticket: number): boolean {
    for (const t of l.unarrived) if (t < ticket) return true
    return false
  }

  /** Grant the line to its first waiter when it is free and no earlier ticket is still coming. */
  private pump(l: TerminalLine): void {
    if (l.holder !== null) return
    const head = l.waiters[0]
    if (!head || this.earlierOnItsWay(l, head.scope.ticket)) return
    l.waiters.shift()
    head.grant()
  }

  /**
   * `scope` handed bytes to the PTY: every other call open on this terminal now knows somebody
   * else wrote during it.
   */
  noteWrite(terminalId: string, scope: WriteScope): void {
    const l = this.lines.get(terminalId)
    if (!l) return
    for (const other of l.open) if (other !== scope) other.othersWrote = true
  }

  /** The call is over (success, refusal or failure): close its scope. */
  finish(terminalId: string, scope: WriteScope): void {
    const l = this.lines.get(terminalId)
    if (!l) return
    l.open.delete(scope)
    // A scope that finished while still holding the line must not wedge it, and a ticket that
    // never reached the line (refused before it queued) must not hold the calls behind it.
    l.unarrived.delete(scope.ticket)
    if (l.holder === scope) this.release(terminalId, scope)
    else this.pump(l)
  }

  /** Calls waiting behind the head of `terminalId`'s line. */
  waiting(terminalId: string): number {
    return this.lines.get(terminalId)?.waiters.length ?? 0
  }

  /** Drop the lines of terminals the registry no longer knows (a swept tombstone). */
  prune(isKnown: (terminalId: string) => boolean): void {
    for (const [id, l] of [...this.lines]) {
      if (!isKnown(id) && l.open.size === 0 && l.unarrived.size === 0) this.lines.delete(id)
    }
  }
}

/**
 * Write a send's pieces in order, {@link ESC_GAP_MS} apart (spec §4.4). `write` returns whether
 * the bytes reached the PTY (it may check the terminal's state first, and so be async); the first failure stops the send. Returns how many pieces were
 * written, and whether all of them were.
 */
export async function writeSegments(
  segments: readonly string[],
  io: {
    write: (data: string) => boolean | Promise<boolean>
    sleep: (ms: number) => Promise<void>
  }
): Promise<{ written: number; complete: boolean }> {
  let written = 0
  for (let i = 0; i < segments.length; i++) {
    if (i > 0) await io.sleep(ESC_GAP_MS)
    if (!(await io.write(segments[i]!))) return { written, complete: false }
    written++
  }
  return { written, complete: true }
}

/** A send with no `waitFor` returns after this much quiet (spec §4.4, `wait.reason: 'none'`). */
export const SETTLE_QUIET_MS = 150
/** …and never waits longer than this in total. */
export const SETTLE_CAP_MS = 1000

/**
 * Wait for the terminal to go quiet after a send: {@link SETTLE_QUIET_MS} with no output, capped
 * at {@link SETTLE_CAP_MS}. `lastOutputAt` is read fresh each turn (the registry stamps it as
 * bytes arrive); the quiet clock never starts before `sentAt`. Returns how long it waited.
 *
 * `abort` ends the wait AT ONCE when it fires — the operator pressed Disconnect (spec §6.4):
 * `is()` is checked every turn and `wake()` resolves the moment it fires, so a sleep in progress
 * is cut short instead of running out its timer.
 */
export async function settleAfterSend(io: {
  now: () => number
  sleep: (ms: number) => Promise<void>
  lastOutputAt: () => number
  sentAt: number
  abort?: { is: () => boolean; wake: () => Promise<void> }
}): Promise<number> {
  const started = io.now()
  for (;;) {
    const now = io.now()
    const elapsed = now - started
    if (io.abort?.is()) return elapsed
    const quiet = now - Math.max(io.lastOutputAt(), io.sentAt)
    if (quiet >= SETTLE_QUIET_MS || elapsed >= SETTLE_CAP_MS) return elapsed
    const nap = io.sleep(Math.min(SETTLE_QUIET_MS - quiet, SETTLE_CAP_MS - elapsed, 50))
    await (io.abort ? Promise.race([nap, io.abort.wake()]) : nap)
  }
}

/** The app-wide queue. */
export const terminalWriteQueue = new TerminalWriteQueue()
