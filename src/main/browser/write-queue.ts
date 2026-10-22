/**
 * The per-pane write queue (T564 U4, spec §6.4): what makes several agents driving one pane orderly.
 *
 * Writes to one pane run FIFO in arrival order; a call that is not at the head of the line within 10 s gives up
 * with `BROWSER_BUSY` (nothing done); more than 60 writes per rolling minute is `BROWSER_RATE_LIMIT`. Different
 * panes never wait on each other. The mechanics are exactly those of the terminal queue (ticket on entry, the
 * lowest ticket first, admission rate-limited before it queues), so this wraps that class rather than copying it
 * and only renames the two refusals. Pure (ADR-0001): the clock and the timer are injected.
 */
import {
  QUEUE_WAIT_MS,
  RATE_LIMIT_PER_MIN,
  TerminalWriteQueue,
  type WriteQueueDeps
} from '../terminal-write-queue'

export { QUEUE_WAIT_MS, RATE_LIMIT_PER_MIN }

export type BrowserQueueError = 'BROWSER_BUSY' | 'BROWSER_RATE_LIMIT'

/** What a queued write reports besides its own result. */
export interface QueuedWriteScope {
  /** Another write ran on this pane while this one was open. */
  othersWrote: boolean
}

export type QueuedResult<T> =
  { ok: true; value: T; othersWrote: boolean } | { ok: false; error: BrowserQueueError }

export class BrowserWriteQueue {
  private readonly queue: TerminalWriteQueue

  constructor(deps?: WriteQueueDeps, opts: { queueWaitMs?: number; ratePerMin?: number } = {}) {
    this.queue = new TerminalWriteQueue(deps, opts)
  }

  /**
   * Take the next place in `paneId`'s line for the call identified by `key` (its args object). Synchronous by
   * contract: call it on entry, before any `await`, so the place reflects when the call ARRIVED. The call must
   * either run through {@link run} or {@link drop} the reservation.
   */
  reserve(key: object, paneId: string): void {
    this.queue.reserve(key, paneId)
  }

  /** Give up a reservation nobody claimed (the call was refused or parked before the handler). */
  drop(key: object): void {
    this.queue.drop(key)
  }

  /**
   * Run `write` as the head of `paneId`'s line. `key` is the args object the call reserved with (a call that did
   * not come through the server's entry point takes its place now). The line is held only while `write` runs.
   */
  async run<T>(paneId: string, key: object, write: () => Promise<T>): Promise<QueuedResult<T>> {
    const ticket = this.queue.claim(key, paneId)
    const admitted = this.queue.admit(paneId, ticket)
    if (!admitted.ok) {
      this.queue.abandonTicket(paneId, ticket)
      return { ok: false, error: 'BROWSER_RATE_LIMIT' }
    }
    const scope = admitted.scope
    try {
      if (!(await this.queue.acquire(paneId, scope))) return { ok: false, error: 'BROWSER_BUSY' }
      try {
        this.queue.noteWrite(paneId, scope)
        const value = await write()
        return { ok: true, value, othersWrote: scope.othersWrote }
      } finally {
        this.queue.release(paneId, scope)
      }
    } finally {
      this.queue.finish(paneId, scope)
    }
  }

  /** Calls waiting behind the head of `paneId`'s line. */
  waiting(paneId: string): number {
    return this.queue.waiting(paneId)
  }

  /** Drop the lines of panes the registry no longer knows. */
  prune(isKnown: (paneId: string) => boolean): void {
    this.queue.prune(isKnown)
  }
}

/** The app-wide queue. */
export const browserWriteQueue = new BrowserWriteQueue()
