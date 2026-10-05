/**
 * Pure correlated request/ack/timeout bridge for the Harnu MCP server (T2).
 *
 * The MCP server (main process) actuates renderer-owned operations — `create_session`,
 * `spawn_terminal` — that must round-trip through the window: dispatch a correlated
 * message, then wait for the renderer to echo the matching `requestId` back with a
 * result. This module owns that correlation table and its single hard-deadline timer.
 *
 * It is intentionally FRAMEWORK-FREE (no `electron`/IPC import): the side-effecting
 * collaborators (`send` over the contextBridge, the clock, the timer) are injected via
 * {@link CommandBridgeDeps}, so the core is deterministic under `vi.useFakeTimers()`
 * and lands in the pure-core coverage surface (ADR-0001). The thin shell (the
 * command-bridge IPC registrar, T21) wires `send` to `webContents.send`, `now` to
 * `Date.now`, and the timer to `setTimeout`/`clearTimeout`.
 *
 * Correlation guarantees (spec §Actuation): every dispatch gets a UNIQUE token, an
 * ack settles AT MOST ONCE, a late/duplicate/unknown ack is dropped, and the deadline
 * is the only fail-safe that evicts an orphaned request.
 */

/** An opaque timer handle: whatever {@link CommandBridgeDeps.setTimer} returns. */
export type TimerHandle = ReturnType<typeof setTimeout>

/** A correlated command handed to the renderer; the renderer echoes `requestId` on ack. */
export interface CommandMessage {
  /** Unique per-dispatch correlation token the renderer must echo back on ack. */
  requestId: string
  /** The command verb (e.g. `create_session`, `spawn_terminal`). */
  command: string
  /** The command arguments; opaque to the bridge. */
  payload: unknown
}

/** Side-effecting collaborators injected into {@link CommandBridge} (pure-core seam). */
export interface CommandBridgeDeps {
  /** Deliver a correlated message to the renderer; `false` ⇒ no window to send to. */
  send: (message: CommandMessage) => boolean
  /** Wall clock; used only to salt the requestId (uniqueness is guaranteed by a seq). */
  now: () => number
  /** Arm a one-shot timer; returns a handle for {@link clearTimer}. */
  setTimer: (callback: () => void, ms: number) => TimerHandle
  /** Cancel a timer previously armed by {@link setTimer}. */
  clearTimer: (handle: TimerHandle) => void
}

/** A typed rejection carrying a stable, machine-readable `code`. */
export class CommandBridgeError extends Error {
  /** Stable failure code: `NO_WINDOW`, `TIMEOUT`, or a {@link CommandBridge.rejectAll} reason. */
  readonly code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'CommandBridgeError'
    this.code = code
  }
}

/**
 * The in-UI confirm window for a gated MCP mutation (human-in-the-loop). The
 * confirm overlay's own timeout = DENY, so a slow human still resolves the
 * dispatch via an ack — the bridge must not time out underneath it.
 */
export const CONFIRM_WINDOW_MS = 30_000

/**
 * Hard deadline for a correlated dispatch before it rejects with `TIMEOUT` and
 * evicts the request. Intentionally GREATER THAN {@link CONFIRM_WINDOW_MS}: the
 * renderer may have to run the full in-UI confirm (whose own timeout = DENY)
 * before it can ack, so the bridge must outlive the confirm window or it would
 * orphan a request the user was still deciding on.
 */
export const DEADLINE = CONFIRM_WINDOW_MS + 15_000

/** One in-flight dispatch: how to settle it and the timer guarding it. */
interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: CommandBridgeError) => void
  timer: TimerHandle
}

/**
 * The renderer's report that a synthetic id migrated to a real, on-disk
 * session (this card / ADR-0003) — a receipt for OUTCOME, not intent.
 */
export interface Materialization {
  syntheticId: string
  sessionId: string
  folder: string
}

/** One parked `awaitMaterialization` wait: how to settle it and its deadline timer. */
interface MaterializationWaiter {
  resolve: (value: Materialization | null) => void
  timer: TimerHandle
}

/**
 * A headless, selection-independent bridge that correlates a renderer-bound
 * command with its eventual ack. One instance owns the whole pending table.
 */
export class CommandBridge {
  private readonly deps: CommandBridgeDeps
  private readonly pending = new Map<string, Pending>()
  private readonly materializationWaiters = new Map<string, MaterializationWaiter>()
  private seq = 0

  constructor(deps: CommandBridgeDeps) {
    this.deps = deps
  }

  /** Count of in-flight (un-acked, un-timed-out) requests. */
  get size(): number {
    return this.pending.size
  }

  /**
   * Send `command`+`payload` to the renderer and return a promise that settles
   * when the matching {@link ack} arrives, the {@link DEADLINE} fires, or
   * {@link rejectAll} is called.
   *
   * If `send` reports no window, the promise rejects IMMEDIATELY with code
   * `NO_WINDOW` and no timer is armed (nothing is parked).
   *
   * @typeParam R - The expected ack result type (caller-narrowed; defaults to `unknown`).
   */
  dispatch<R = unknown>(command: string, payload: unknown): Promise<R> {
    const requestId = this.mintId()
    return new Promise<R>((resolve, reject) => {
      const delivered = this.deps.send({ requestId, command, payload })
      if (!delivered) {
        reject(new CommandBridgeError('NO_WINDOW', `no window to dispatch "${command}"`))
        return
      }
      const timer = this.deps.setTimer(() => {
        this.settle(
          requestId,
          'reject',
          new CommandBridgeError('TIMEOUT', `dispatch "${command}" timed out`)
        )
      }, DEADLINE)
      this.pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })
    })
  }

  /**
   * Settle the dispatch correlated to `requestId` with `result`. Returns `true`
   * if a matching pending request was resolved, `false` if the id is unknown or
   * was already settled (a duplicate or post-timeout ack is dropped).
   */
  ack(requestId: string, result: unknown): boolean {
    return this.settle(requestId, 'resolve', result)
  }

  /**
   * Reject every pending request with `reason` as the error code and clear the
   * table — used on window teardown / server shutdown so no dispatch orphans.
   */
  rejectAll(reason: string): void {
    for (const requestId of [...this.pending.keys()]) {
      this.settle(requestId, 'reject', new CommandBridgeError(reason))
    }
  }

  /**
   * Internal: settle a request exactly once. Evicts the entry and disarms its
   * deadline before invoking the resolver, so re-entrant calls (a late ack
   * racing the timeout) find nothing and return `false`.
   */
  private settle(requestId: string, kind: 'resolve' | 'reject', value: unknown): boolean {
    const entry = this.pending.get(requestId)
    if (!entry) return false
    this.pending.delete(requestId)
    this.deps.clearTimer(entry.timer)
    if (kind === 'resolve') entry.resolve(value)
    else entry.reject(value as CommandBridgeError)
    return true
  }

  /** Mint a unique correlation token: a seq guarantees uniqueness, `now()` salts it. */
  private mintId(): string {
    this.seq += 1
    return `cmd-${this.deps.now()}-${this.seq}`
  }

  /**
   * Wait up to `timeoutMs` for the renderer to report that `syntheticId`
   * materialized into a real, on-disk session (this card / ADR-0003 §2). This
   * is NOT a correlated `dispatch` — it's a separate out-of-band signal the
   * renderer emits on its own schedule, so it is tracked in its own table.
   * Resolves `null` on timeout rather than rejecting, so a caller can turn a
   * bounded wait directly into a steerable `ok:false` instead of catching an
   * exception.
   */
  awaitMaterialization(syntheticId: string, timeoutMs: number): Promise<Materialization | null> {
    return new Promise((resolve) => {
      const timer = this.deps.setTimer(() => {
        this.materializationWaiters.delete(syntheticId)
        resolve(null)
      }, timeoutMs)
      this.materializationWaiters.set(syntheticId, { resolve, timer })
    })
  }

  /**
   * The renderer's report that `info.syntheticId` materialized into
   * `info.sessionId`. Settles the matching {@link awaitMaterialization} wait,
   * if one is still parked. Returns `false` for a late notify (the wait
   * already timed out and was evicted) — the caller (the IPC shell) reads
   * this to know the materialization arrived too late to attach to its
   * original `create_session` ACK, which already resolved `ok:false` (AC4).
   */
  notifyMaterialized(info: Materialization): boolean {
    const waiter = this.materializationWaiters.get(info.syntheticId)
    if (!waiter) return false
    this.materializationWaiters.delete(info.syntheticId)
    this.deps.clearTimer(waiter.timer)
    waiter.resolve(info)
    return true
  }
}
