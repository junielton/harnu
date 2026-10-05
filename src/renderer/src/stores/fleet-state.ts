import type { TaskState, TranscriptState, StagnationVerdict } from '../../../preload'
import type { SessionStatus } from './sessions'

/**
 * The canonical per-session fleet classifier (T67 §2 — Fleet glance ENGINE).
 *
 * Until now every surface derived "what is this session doing?" on its own from
 * the SAME two frail signals (`taskState` + the 5s activity `status`) and drifted:
 * `dotFor` ceded to `status` (mented DOWN on a long tool call → grey), while
 * `classifyBoardState` trusted `taskState` unconditionally (mented UP on a lost
 * Stop → stuck green). Same session, opposite verdicts — BUG-13. And neither
 * counted a quiet orchestrator's live sub-agents as activity — BUG-15.
 *
 * This module is the ONE derivation both surfaces (and the supervision-load
 * counter, and any future strip/tray) consume, so they agree by construction.
 * Pure, framework-free (no Pinia/DOM/`node:` — only a type-only `SessionStatus`
 * import, erased at compile), so it unit-tests in the `node` vitest env exactly
 * like `closure-core.ts` / `attention.ts` / `session-sort.ts`. The store injects
 * the clock, the thresholds, and the per-session signals it resolves from live
 * state (`agents`, `lastViewed`, the parked-approval set).
 *
 * Two axes are deliberately kept SEPARATE from this classifier and stay in each
 * surface, because the surfaces already AGREE on them (no bug) and folding them
 * in would regress presentation the PRD leaves alone:
 *  - terminal FSM states `failed` / `completed` (the dot's red-X / check, the
 *    board's `errored` / `done` sections). The PRD taxonomy folds `completed`
 *    into `idle` ("resto, inclui done"); `failed` is an already-notified edge, not
 *    a persistent actionable queue (same reasoning as `attention.ts#countNeedsInput`).
 *  - `archived` (a lifecycle flag the surfaces filter/branch on themselves).
 */

/** The five canonical states (PRD §2), in descending supervision urgency. */
export type FleetState = 'needs-you' | 'stuck' | 'working' | 'return-here' | 'idle'

/**
 * The contested tri-state both surfaces read via {@link resolveActivity} — the
 * live-activity axis where `dotFor` and `classifyBoardState` used to disagree.
 * Terminal / attention states are layered on top by each caller.
 */
export type FleetActivity = 'working' | 'stuck' | 'idle'

/**
 * N — how long a `working` session may go WITHOUT transcript growth before it is
 * `stuck`. Chosen at 3 min: comfortably above the 5s `status` relax and typical
 * tool-call latency (edits, greps, short tests finish well under it), so a long
 * legitimate operation still reads `working`; a genuine stall surfaces once the
 * silence is glance-worthy rather than crying wolf every few seconds (the PRD §6
 * "the strip becomes noise if it blinks too much" risk). Sidechain aggregation removes the
 * biggest false-positive (a quiet orchestrator with live sub-agents) BEFORE this
 * threshold is ever consulted, so what remains is a genuinely silent single
 * transcript. Tunable in one place.
 */
export const STUCK_AFTER_MS = 3 * 60_000

/** Per-session signals the classifier reads. Resolved by the store (keeps it pure). */
export interface FleetSignals {
  /** Hook FSM truth; undefined until the first hook arrives. */
  taskState?: TaskState
  /**
   * Transcript ground truth (T91) read from the session's JSONL by the reader/
   * watcher. Consulted ONLY when there is no live hook/screen `taskState` — hooks
   * are the freshest signal for a session running inside Harnu, but a session with
   * no hooks (running externally, or before its first hook) has no `taskState`,
   * and its own transcript is far better than the legacy 5s `status` guess.
   * `'unknown'` / undefined means the tail carried no marker → fall to the timer.
   */
  transcriptState?: TranscriptState
  /**
   * Stagnation verdict (T175/T176): a pure fold over the transcript tail that
   * flags a session repeating the same tool targets with no mutation between
   * them — the "noisy stall" `workingOrStuck`'s silence-only timer cannot see
   * on its own, since a repeating-but-busy session keeps advancing
   * `modifiedMs`. `undefined` until the reader/watcher has determined it.
   */
  stagnation?: StagnationVerdict
  /**
   * PID-registry truth (T92 §3): the `busy|waiting|idle` from
   * `~/.claude/sessions/<pid>.json`, mapped to a task-state. Layered BELOW
   * `taskState` — it only decides for sessions WITHOUT injected hooks (external
   * sessions), where it beats the transcript heuristic. `undefined` when the
   * registry is unavailable / carries no usable status.
   */
  registryState?: TaskState
  /** Legacy 5s activity heuristic: `active` = transcript grew within `ACTIVE_TO_IDLE_MS`. */
  status: SessionStatus
  /** `Date.parse(session.modified)` — last transcript growth (ms). NaN when unknown. */
  modifiedMs: number
  /**
   * Epoch ms of the last hook/registry EVENT for this session (T92 freshness). The
   * stuck timer anchors to the most recent sign of life — `max(modifiedMs,
   * lastEventMs)` — so a working session whose transcript hasn't grown YET (just
   * got its `UserPromptSubmit` hook) isn't misread as stalled, and a live
   * event resets the clock even if transcript parsing lags. `undefined` when no
   * event has arrived (pure transcript sessions fall back to `modifiedMs` alone).
   */
  lastEventMs?: number
  /**
   * Count of nested sub-agents (sidechains) still RUNNING (BUG-15 aggregation).
   * A parent with a live child is working even while its OWN transcript is quiet
   * — the orchestrator is waiting on the sub-agents, not stalled. Resolved from
   * `session.agents` filtered to `status === 'running'`.
   */
  liveAgentCount: number
  /**
   * A parked hook approval (S4) is owned by this session — a needs-you source
   * per the PRD. In practice redundant with `taskState === 'needs-input'` (a
   * `PermissionRequest` hook drives the FSM there), kept explicit so the engine
   * matches the taxonomy and a future approval path that skips the FSM still counts.
   */
  hasParkedApproval: boolean
  /** T37 closure — epoch ms you last looked at this session (`lastViewedAt`). */
  lastViewedMs: number
  /** True when this is the session you're viewing right now (never nag/de-escalate). */
  isViewing: boolean
  /**
   * Proof of life (BUG-53): a live Harnu PTY ∪ a PID-registry entry ∪ a hook event
   * received THIS app run. A dead session's transcript tail describes how its last
   * turn ENDED, not what it is doing NOW — a `working`/`needs-input` tail is stale
   * forever once the process is gone (the tail never changes again), so no "alive"
   * state (`working`/`stuck`/`needs-you`) may be derived from it without this proof.
   * Levels 1–2 of {@link resolveActivity} (`taskState`/`registryState` defined) need
   * no guard — their presence already IS proof of life.
   */
  isLive: boolean
}

/** Clock + thresholds, injected so the classifier stays pure/deterministic. */
export interface FleetCtx {
  /** Wall clock (ms). */
  nowMs: number
  /** {@link STUCK_AFTER_MS} unless overridden. */
  stuckAfterMs: number
  /** Closure "forgotten" threshold (T37 `FORGOTTEN_THRESHOLD_MS`, 10 min). */
  forgottenAfterMs: number
}

/**
 * The signals `resolveActivity` reads — a subset of {@link FleetSignals}. The
 * T92 overlay adds `registryState` (fallback signal) and `lastEventMs` (freshness).
 */
type ActivitySignals = Pick<
  FleetSignals,
  | 'taskState'
  | 'registryState'
  | 'transcriptState'
  | 'stagnation'
  | 'status'
  | 'modifiedMs'
  | 'liveAgentCount'
  | 'lastEventMs'
  | 'isLive'
>

/**
 * `working` vs `stuck` for a session known to be actively working: `stuck` iff it
 * has shown no sign of life for `stuckAfterMs`, OR (T175/T176) the transcript
 * itself says it's stagnant — busy but repeating the same tool targets with no
 * mutation between them. This second branch is what catches the "noisy stall"
 * the silence timer alone cannot see: a session retrying the same failing
 * command keeps `modifiedMs` advancing, so it would otherwise never age past
 * the quiet threshold (docs/specs/T175-session-stagnation-detector.md).
 *
 * The freshness anchor for the silence branch is the MOST RECENT of transcript
 * growth (`modifiedMs`) and the last hook/registry event (`lastEventMs`) — T92:
 * a session that just got its `UserPromptSubmit` hook but hasn't written to the
 * transcript yet is fresh, not stalled. NaN/absent-safe: if neither anchor is
 * known, it counts as freshly active (never stuck).
 */
function workingOrStuck(
  sig: ActivitySignals,
  ctx: Pick<FleetCtx, 'nowMs' | 'stuckAfterMs'>
): FleetActivity {
  if (sig.stagnation?.stagnant === true) return 'stuck'
  const anchor = Math.max(
    Number.isFinite(sig.modifiedMs) ? sig.modifiedMs : -Infinity,
    sig.lastEventMs ?? -Infinity
  )
  const quietMs = Number.isFinite(anchor) ? ctx.nowMs - anchor : 0
  return quietMs >= ctx.stuckAfterMs ? 'stuck' : 'working'
}

/**
 * Resolve the live-activity tri-state — the SINGLE source both `dotFor` and
 * `classifyBoardState` consume so they can never disagree again (BUG-13). The T92
 * OVERLAY PRECEDENCE, top signal wins:
 *
 *  0. A live sub-agent means the session is `working`, full stop — even if its
 *     own transcript is silent (BUG-15: the orchestrator is awaiting its children).
 *  1. **Injected hooks** (`taskState` defined) — the richest, event-driven truth.
 *     `working` → `working`/`stuck` (freshness-anchored); everything else → `idle`
 *     (needs-input is layered to needs-you by `classifyFleetState`).
 *  2. **PID registry** (`registryState` defined, no hooks) — the cheap ground
 *     truth for external sessions Harnu never injected hooks into. Same shape.
 *  3. **Transcript turn-over truth** (T91, neither of the above) — the JSONL's own
 *     end-of-turn/tool-pending markers; `working` still ages through the timer —
 *     but ONLY when {@link FleetSignals.isLive} is true (BUG-53): a dead process's
 *     tail describes how its last turn ended, not what it's doing now, so a
 *     `working` tail with no proof of life reads `idle`, never `working`/`stuck`.
 *  4. **Legacy heuristic** (no markers at all) — the last-resort fallback: `active`
 *     (grew within 5s) → `working`, else `idle`; gated by `isLive` identically.
 *
 * Pure; NaN-safe (an unparseable `modifiedMs` counts as freshly active, never stuck).
 */
export function resolveActivity(
  sig: ActivitySignals,
  ctx: Pick<FleetCtx, 'nowMs' | 'stuckAfterMs'>
): FleetActivity {
  if (sig.liveAgentCount > 0) return 'working'
  // 1. Injected-hook FSM wins whenever it exists (freshest in-process truth).
  if (sig.taskState !== undefined) {
    return sig.taskState === 'working' ? workingOrStuck(sig, ctx) : 'idle'
  }
  // 2. No hooks → PID registry status (live process-level truth, external sessions).
  if (sig.registryState !== undefined) {
    return sig.registryState === 'working' ? workingOrStuck(sig, ctx) : 'idle'
  }
  // 3. No hooks, no registry → the transcript's own turn-over state (T91). A
  // `working` tail describes how the last turn ENDED, not what is happening NOW
  // (BUG-53) — without proof of life it means "died mid-turn", never `working`/
  // `stuck`. With proof of life it still passes the quiet/stuck timer so a
  // silent long tool-call surfaces as `stuck`. `idle`/`needs-input` land as idle
  // here either way (the attention layer in `classifyFleetState` adds needs-you,
  // itself gated on `isLive` via `isNeedsInput`).
  if (sig.transcriptState === 'working') return sig.isLive ? workingOrStuck(sig, ctx) : 'idle'
  if (sig.transcriptState === 'idle' || sig.transcriptState === 'needs-input') return 'idle'
  // 4. Transcript lacking markers (`unknown`/undefined): legacy 5s heuristic —
  // gated identically (BUG-53): without proof of life the heuristic isn't trusted.
  if (!sig.isLive) return 'idle'
  return sig.status === 'active' ? 'working' : 'idle'
}

/**
 * Whether a session is blocked on YOU (T91). `needs-input` from the live hook FSM
 * or a parked approval, OR — when there is no live hook truth — the transcript's
 * own `needs-input` (an unresolved `AskUserQuestion`/`ExitPlanMode`), gated on
 * {@link FleetSignals.isLive} (BUG-53): a dead session cannot be blocked on you,
 * its tail just describes where it died. `isLive` is OPTIONAL here (unlike
 * {@link FleetSignals}) — callers that don't resolve it (e.g. `fleet-board.ts`,
 * `session-dot.ts`) keep their prior behaviour; only `undefined !== false`, so
 * omitting it never newly suppresses a needs-you. The single source every surface
 * reads so the sidebar dot and the board agree on "asking for me".
 */
export function isNeedsInput(sig: {
  taskState?: TaskState
  transcriptState?: TranscriptState
  registryState?: TaskState
  hasParkedApproval?: boolean
  isLive?: boolean
}): boolean {
  if (sig.taskState === 'needs-input' || sig.hasParkedApproval) return true
  // A defined hook state that moved past the block is never overridden.
  if (sig.taskState !== undefined) return false
  if (sig.registryState === 'needs-input') return true
  // Registry defined (and not waiting) outranks the transcript tail.
  return (
    sig.registryState === undefined && sig.transcriptState === 'needs-input' && sig.isLive !== false
  )
}

/**
 * The full canonical classification (PRD §2). Layers the two attention states on
 * top of {@link resolveActivity}:
 *
 *  - `needs-you` — blocked on you (`needs-input` ∪ a parked approval), the moment
 *    it fires. Maximum urgency.
 *  - `return-here` — the SAME block after you've ignored it past the forgotten
 *    threshold (and aren't looking at it): it de-escalates from the urgent
 *    `needs-you` to the calmer T37 "return here" nudge, so a stale block stops
 *    screaming at max priority (matches the board ordering, where return-here
 *    sits far below needs-you).
 *  - otherwise the activity axis decides `working` / `stuck` / `idle`.
 *
 * `failed` / `completed` / `stopped` fold into `idle` here (see the module
 * header) — the terminal presentation lives in the surfaces, not the taxonomy.
 */
export function classifyFleetState(sig: FleetSignals, ctx: FleetCtx): FleetState {
  if (isNeedsInput(sig)) {
    const forgotten = !sig.isViewing && ctx.nowMs - sig.lastViewedMs >= ctx.forgottenAfterMs
    return forgotten ? 'return-here' : 'needs-you'
  }
  return resolveActivity(sig, ctx)
}
