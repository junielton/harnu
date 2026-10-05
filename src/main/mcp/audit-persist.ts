/**
 * Trailing-coalesce debouncer for the MCP audit-ring persist (T26 part 2).
 *
 * `handleToolCall` used to `fs.writeFile` the ENTIRE serialized ring on every
 * tool call (and again on an operator-denied mutation). Under a burst of reads
 * that is one full-ring rewrite per call — disk thrash on the request path. This
 * wraps the persist in a debouncer: the first `schedule()` arms a timer, further
 * `schedule()` calls while it is pending are absorbed (the timer is NOT re-armed),
 * and the timer's fire coalesces the burst into ONE write. `flush()` cancels a
 * pending timer and writes immediately — call it on teardown so the tail of the
 * ring is never lost on disable/quit.
 *
 * Framework-free + side-effect-free: the persist fn and the timer are INJECTED,
 * so it is deterministic and lands in the pure-core coverage surface (ADR-0001).
 * The env-bound shell (`server.ts`) wires `persist` to the real `fs.writeFile`
 * and the timer to `setTimeout`/`clearTimeout`.
 */

/** An opaque timer handle — whatever the injected `setTimer` returns. */
export type TimerHandle = ReturnType<typeof setTimeout>

/** Injected collaborators for {@link createAuditPersister}. */
export interface AuditPersisterDeps {
  /** The actual persist (best-effort; MUST NOT throw — the shell's has a try/catch). */
  persist: () => Promise<void>
  /** Trailing coalesce window in ms (~500–1000). */
  delayMs: number
  /** Arm a one-shot timer; returns a handle for {@link clearTimer}. */
  setTimer: (callback: () => void, ms: number) => TimerHandle
  /** Cancel a timer previously armed by {@link setTimer}. */
  clearTimer: (handle: TimerHandle) => void
}

/** The debounced persister {@link createAuditPersister} returns. */
export interface AuditPersister {
  /** Request a persist; coalesced into one write per {@link AuditPersisterDeps.delayMs} window. */
  schedule: () => void
  /** Cancel any pending timer and persist NOW (awaitable) — call on teardown. */
  flush: () => Promise<void>
}

/** Build a trailing-coalesce audit persister over injected timer + persist fn. */
export function createAuditPersister(deps: AuditPersisterDeps): AuditPersister {
  let timer: TimerHandle | null = null
  // Serialize writes onto a chain so two persists can never interleave. `persist`
  // never throws (the shell guards it), so the chain never rejects.
  let inFlight: Promise<void> = Promise.resolve()

  function persistChained(): Promise<void> {
    inFlight = inFlight.then(() => deps.persist())
    return inFlight
  }

  function schedule(): void {
    if (timer !== null) return // already pending — coalesce, do not re-arm
    timer = deps.setTimer(() => {
      timer = null
      void persistChained()
    }, deps.delayMs)
  }

  async function flush(): Promise<void> {
    if (timer !== null) {
      deps.clearTimer(timer)
      timer = null
    }
    await persistChained()
  }

  return { schedule, flush }
}
