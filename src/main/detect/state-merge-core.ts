/**
 * Two-tier state merge core (A2 two-tier state detection — T2).
 *
 * The ONE place the hook FSM signal and the screen-scrape signal are fused into
 * a single `TaskState`, encoding the design's two-level precedence:
 *
 *   hook recent (< TTL)  →  the FSM `reduceTaskState` state is AUTHORITATIVE
 *   else                 →  the screen `matchManifest` state (best-effort)
 *
 * The per-provider {@link DetectionMethod} gates which tiers are even consulted
 * (design "capability matrix"):
 *
 *   - `hooks`  — Claude. The hook FSM is the SOLE authority; the screen is never
 *     scraped, so a perfect-precision agent never regresses. Screen is ignored
 *     even if somehow supplied.
 *   - `screen` — Codex/Aider/OpenCode (v1). No hooks exist; the screen is the
 *     sole authority.
 *   - `both`   — an agent that emits hooks AND can be scraped. Hook wins while
 *     recent; a stale hook channel yields to the screen. (Unused in v1, but the
 *     precedence is encoded + tested here so the tier is ready.)
 *
 * Pure + deterministic — the clock is injected as `now`, exactly like
 * `mcp/plan-tool-call.ts`, so the TTL decision lands in the coverage surface.
 * `blocked → needs-input` mapping happens here (the only place that knows the
 * screen vocabulary meets the `TaskState` vocabulary).
 */

import type { TaskState } from '../hook-state'
import type { ScreenState } from './screen-detect-core'

/** How a provider's live state is detected — the per-agent capability flag. */
export type DetectionMethod = 'hooks' | 'screen' | 'both'

/** The latest hook-FSM signal for a session: its state + when it was stamped. */
export interface HookSignal {
  state: TaskState
  /** epoch-ms the hook event arrived (compared against `now` for the TTL). */
  ts: number
}

/**
 * How long a hook signal stays AUTHORITATIVE since its last event, for the
 * `both` tier. Only governs `both` — `hooks` trusts the FSM unconditionally and
 * `screen` never consults a hook. Chosen conservatively longer than the idle
 * heuristic (5s) so a brief gap between tool-call hooks doesn't hand authority
 * to the screen mid-task; short enough that a genuinely dead hook channel yields
 * to the screen within a sensible window. The fallback is consistent anyway (a
 * blocked/working session reads the same on screen), so the exact value is not
 * load-bearing.
 */
export const HOOK_AUTHORITY_TTL_MS = 15_000

/** Map a screen state onto the shared `TaskState` vocabulary. */
function screenToTaskState(screen: ScreenState): TaskState {
  switch (screen) {
    case 'blocked':
      return 'needs-input'
    case 'working':
      return 'working'
    case 'idle':
      return 'idle'
  }
}

/**
 * Fuse the hook + screen signals into the resolved `TaskState` for a session.
 *
 * @param hook   - latest hook FSM signal, or `null` if none has ever arrived.
 * @param screen - latest screen scrape, or `null` if the pane wasn't scraped.
 * @param method - the provider's detection capability (gates the tiers).
 * @param now    - injected clock (epoch-ms) for the TTL comparison.
 * @param ttlMs  - hook authority window for the `both` tier (default
 *                 {@link HOOK_AUTHORITY_TTL_MS}).
 * @returns the merged `TaskState` (idle when neither tier yields a signal).
 */
export function mergeState(
  hook: HookSignal | null,
  screen: ScreenState | null,
  method: DetectionMethod,
  now: number,
  ttlMs: number = HOOK_AUTHORITY_TTL_MS
): TaskState {
  // `hooks`: the FSM is the sole authority; the screen is never consulted, so a
  // hook-precise agent (Claude) can never regress from a screen mis-read.
  if (method === 'hooks') {
    return hook ? hook.state : 'idle'
  }
  // `screen`: no hooks exist for this provider; the scrape is the sole truth.
  if (method === 'screen') {
    return screen ? screenToTaskState(screen) : 'idle'
  }
  // `both`: a RECENT hook wins; a stale hook yields to the screen.
  if (hook && now - hook.ts < ttlMs) {
    return hook.state
  }
  if (screen) return screenToTaskState(screen)
  // No usable screen — keep the last hook state if we have one, else idle.
  return hook ? hook.state : 'idle'
}
