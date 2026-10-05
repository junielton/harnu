/**
 * Pure decision core for the dead-synthetic reaper (BUG-23, extended to every
 * creation path by BUG-37).
 *
 * Any unbooted synthetic — regardless of how it was created ("+ New session",
 * a roadmap-card dispatch, or an MCP `create_session`/`insertAgentSession`) —
 * boots its PTY decoupled from selection (see the boot queue in
 * `TerminalPane.vue` for the MCP path; selection-driven boots for the other
 * two). Almost always that boot lands within a couple of seconds. But if a boot
 * is dropped (the historical BUG-23 race, or a hard `ptyCreate` failure) the row
 * would otherwise linger FOREVER as `synthetic:true` + `status:'active'` — which
 * `resolveActivity` paints as `working` — polluting the fleet board's WORKING
 * section with a session that will never do anything.
 *
 * This module is the framework-free verdict the store consults at the boot
 * deadline: did a PTY ever come up? It has no Pinia / DOM / `node:` dependency, so
 * it unit-tests in the `node` vitest env exactly like `fleet-state.ts` /
 * `closure-core.ts`. The store injects the live probe (present? live PTY?) and the
 * clock; this file owns only the timeout arithmetic and the three-way verdict.
 */

/**
 * How long a synthetic's boot may take before it is declared dead, whichever
 * path created it. 120s is deliberately generous: a real `claude` spawn (font
 * load + PTY + REPL up) completes in low single-digit seconds, and a
 * healthy-but-slow boot registers a live PTY (`registerLiveSession`) the instant
 * `ptyCreate` resolves — long before this ceiling — so the reaper only ever
 * fires on a boot that truly never started.
 */
export const AGENT_BOOT_TIMEOUT_MS = 120_000

/** The reaper's three-way verdict for a tracked synthetic at a given instant. */
export type BootVerdict = 'pending' | 'booted' | 'failed'

/** The live signals the store resolves for a tracked synthetic. */
export interface BootProbe {
  /**
   * The row is STILL an unbooted synthetic we own: present in the model AND
   * `synthetic === true`. `false` once it migrated to a real uuid (Claude wrote
   * its JSONL — the boot plainly succeeded) or was dismissed/removed.
   */
  present: boolean
  /** A live PTY is registered for the synthetic id — the boot produced a process. */
  isLive: boolean
  /** Milliseconds since the boot was armed (`now - startedMs`). */
  elapsedMs: number
  /** Timeout ceiling; defaults to {@link AGENT_BOOT_TIMEOUT_MS} at the callsite. */
  timeoutMs: number
}

/**
 * Decide a tracked synthetic's boot fate. Pure + monotonic in `elapsedMs`:
 *
 *  - `booted` — the row migrated away or a live PTY exists. Either way the boot is
 *    not dropped, so there is nothing to reap (checked FIRST so a slow-to-write
 *    but live session is never falsely failed).
 *  - `failed` — still an unbooted synthetic with no PTY once `elapsedMs` crosses
 *    the ceiling: a dropped boot. The store surfaces this as a visible FAILED
 *    state (never `working`).
 *  - `pending` — still within the window; keep waiting.
 */
export function bootVerdict(p: BootProbe): BootVerdict {
  if (!p.present || p.isLive) return 'booted'
  if (p.elapsedMs >= p.timeoutMs) return 'failed'
  return 'pending'
}

/**
 * The decision the store makes AT the boot deadline (its per-synthetic timer has
 * already elapsed, so `elapsedMs >= timeoutMs` by construction): reap iff the row
 * is still an unbooted, PTY-less synthetic. A thin convenience over
 * {@link bootVerdict} that keeps the timeout arithmetic in one tested place.
 */
export function shouldReapAtDeadline(present: boolean, isLive: boolean): boolean {
  return bootVerdict({ present, isLive, elapsedMs: 1, timeoutMs: 1 }) === 'failed'
}

/**
 * BUG-60: `bootVerdict` reads a live PTY as unconditional success — correct for
 * "did the boot produce a process", blind to whether that process ever received
 * its queued pre-prompt. A session that boots a live REPL and is never spoken to
 * sits invisible to {@link bootVerdict} forever. This is the sibling verdict the
 * boot-deadline reaper also consults on its live-PTY branch: it needs the SAME
 * delivery signal BUG-61's watchdog reads (T172's injection ledger), not a new
 * notion of "delivered" — see `injection-ledger.ts`'s `InjectionLedgerStatus`.
 */
export interface UndeliveredPromptProbe {
  /** Is a pre-prompt still queued, unconsumed (`sessions.hasAgentPrompt`)? True
   * means delivery was never even attempted yet — still a failure this far past
   * the boot deadline, since the injection watchdog's own retry budget (a few
   * seconds from PTY-live) is dwarfed by {@link AGENT_BOOT_TIMEOUT_MS}. */
  promptQueued: boolean
  /** T172's `injectionLedger.statusFor(id)` — the injected/dequeued/cancelled/
   * escalated/none verdict for whatever delivery activity was recorded. */
  ledgerStatus: 'none' | 'dequeued' | 'injected' | 'cancelled' | 'escalated'
}

/**
 * Reap iff a prompt was genuinely expected for this session (still queued, or the
 * ledger recorded any activity at all) and it was never confirmed injected.
 * `ledgerStatus: 'none'` + `promptQueued: false` means no prompt was ever queued
 * for this session — the common, promptless case — and must never be flagged: a
 * plain "+ New session" synthetic with a live PTY is exactly what a HEALTHY
 * booted session looks like, not a failure.
 */
export function shouldReapUndeliveredPrompt(p: UndeliveredPromptProbe): boolean {
  if (p.ledgerStatus === 'injected') return false
  return p.promptQueued || p.ledgerStatus !== 'none'
}
