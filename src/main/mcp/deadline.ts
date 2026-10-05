/**
 * Pure server-side deadline race for one MCP tool-call handler (T123 W5 —
 * AC12/AC13). The 2026-07-14 incident's failure pattern: a handler outlived
 * the CLIENT's 300 s timeout with no SERVER-side bound, so stuck handlers
 * piled up and each retained its own copy of the fleet model until the main
 * process OOM'd. Node cannot force-cancel a pending promise — the underlying
 * work keeps running until it settles on its own — so the guarantee here is
 * narrower and achievable: the RESPONSE resolves at the deadline, and this
 * module's own promise chain drops its reference to the winner immediately,
 * so nothing HERE retains the handler's scope past the deadline. (The caller,
 * `server.ts`'s `actuate`, is what stops holding `folders`/`policy`/etc. once
 * this settles and its `await` returns.)
 *
 * Framework-free + side-effect-free: the timer is INJECTED (mirrors
 * `audit-persist.ts`'s `AuditPersisterDeps` pattern), so this lands in the
 * pure-core coverage surface (ADR-0001) and tests use a small injected delay
 * instead of fake-timer gymnastics.
 */

/** Server-side per-tool-call deadline (AC12): 120 seconds. */
export const TOOL_CALL_DEADLINE_MS = 120_000

/** An opaque timer handle — whatever the injected `setTimer` returns. */
export type DeadlineTimerHandle = ReturnType<typeof setTimeout>

/** The outcome of racing `work` against the deadline. */
export type DeadlineResult<T> = { timedOut: false; value: T } | { timedOut: true }

/**
 * A mutable flag a caller can hand to {@link withDeadline} and later read from
 * inside the raced `work` itself (this card, BUG-33 §3.3). `withDeadline` sets
 * `fired` the instant its timer wins the race — synchronously, before the
 * `{timedOut:true}` result is even returned — so a handler still running past
 * the deadline can poll `flag.fired` before its own final commit step and
 * abort instead of applying a mutation the caller already gave up on. Node
 * cannot cancel the handler's promise (see the module doc); this is the
 * cooperative alternative.
 */
export interface DeadlineFlag {
  fired: boolean
}

/** A fresh, unfired {@link DeadlineFlag}. */
export function createDeadlineFlag(): DeadlineFlag {
  return { fired: false }
}

/**
 * Race `work` against a `deadlineMs` timer.
 *
 * - If `work` settles (resolves OR rejects) before the timer fires, that
 *   settlement propagates as-is: `{timedOut:false, value}` on resolve, or a
 *   rejection on reject — the caller sees exactly what `work` would have
 *   produced without the wrapper.
 * - If the timer fires first, resolves `{timedOut:true}` immediately —
 *   WITHOUT waiting for `work`. `work`'s eventual settlement (if any) is
 *   still consumed internally (so it never surfaces as an unhandled
 *   rejection) but its result is discarded. If a `flag` was passed, it is
 *   set `fired:true` at the same moment (before the promise resolves).
 *
 * The pending timer is always cleared once the race is decided, whichever
 * side wins.
 */
export function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  setTimer: (callback: () => void, ms: number) => DeadlineTimerHandle = setTimeout,
  clearTimer: (handle: DeadlineTimerHandle) => void = clearTimeout,
  flag?: DeadlineFlag
): Promise<DeadlineResult<T>> {
  let timer: DeadlineTimerHandle | undefined
  const timeout = new Promise<DeadlineResult<T>>((resolve) => {
    timer = setTimer(() => {
      if (flag) flag.fired = true
      resolve({ timedOut: true })
    }, deadlineMs)
  })
  const settled = work.then((value): DeadlineResult<T> => ({ timedOut: false, value }))
  return Promise.race([settled, timeout]).finally(() => {
    if (timer !== undefined) clearTimer(timer)
  })
}
