/**
 * The decisions behind point-and-comment (T564 U6, spec §8.1, §8.6, §8.7), pure over injected facts.
 *
 *  - {@link evaluatePickGate}: may a guest's pick open a composer? A pick is accepted only if no agent INPUT verb
 *    ran on the pane within the previous 1500 ms (the `agentInputAt` window of §5.4), so an agent cannot use a
 *    `click` to open a composer on a node of its choosing; and only if a REAL mouse press was seen on the pane.
 *  - {@link evaluateSubmitGate}: may `comment:submit` go through? The same agent-input window, plus the pane's
 *    `paused` and `disconnected` state (spec §8.6).
 *  - {@link selectPins} / {@link resolveDestination}: which pins a submit sends, and to whom.
 */
import type { PinRecord } from './comment-pins'
import { AGENT_INPUT_WINDOW_MS } from './emit-gate'

/** A pick needs a real mouse press this recent on the pane (`before-mouse-event`); a long press is still one. */
export const REAL_MOUSEDOWN_WINDOW_MS = 10_000
/**
 * Stricter than the spec's text, in the same spirit as the emit gate's condition 4: the guest says it saw a
 * trusted click, main wants the OS to have said so too (a script-driven CDP click does not pass through
 * `before-mouse-event`). ONE named switch, so it can be dropped with a one-line change.
 */
export const REQUIRE_REAL_MOUSEDOWN_FOR_PICK = true

export interface AgentInputFacts {
  now: number
  /** An agent input verb is running on the pane right now. */
  agentInputInFlight: boolean
  /** When the last agent input verb finished on the pane, or `null`. */
  agentInputAt: number | null
}

function agentInputRecent(i: AgentInputFacts): boolean {
  return (
    i.agentInputInFlight ||
    (i.agentInputAt !== null && i.now - i.agentInputAt < AGENT_INPUT_WINDOW_MS)
  )
}

export interface PickGateInput extends AgentInputFacts {
  /** The overlay is switched on for this pane (a pick while it is off is stale or forged). */
  overlayActive: boolean
  /** When `before-mouse-event` last saw a real `mouseDown` on the pane, or `null`. */
  lastRealMouseDownAt: number | null
}

export type PickGateVerdict =
  { ok: true } | { ok: false; reason: 'OVERLAY_OFF' | 'AGENT_INPUT' | 'NO_REAL_MOUSE' }

export function evaluatePickGate(i: PickGateInput): PickGateVerdict {
  if (!i.overlayActive) return { ok: false, reason: 'OVERLAY_OFF' }
  if (agentInputRecent(i)) return { ok: false, reason: 'AGENT_INPUT' }
  if (REQUIRE_REAL_MOUSEDOWN_FOR_PICK) {
    const real =
      i.lastRealMouseDownAt !== null && i.now - i.lastRealMouseDownAt <= REAL_MOUSEDOWN_WINDOW_MS
    if (!real) return { ok: false, reason: 'NO_REAL_MOUSE' }
  }
  return { ok: true }
}

export interface SubmitGateInput extends AgentInputFacts {
  paused: boolean
  disconnected: boolean
}

export type SubmitGateVerdict =
  | { ok: true }
  | { ok: false; error: 'BROWSER_DISCONNECTED' | 'BROWSER_PAUSED' | 'COMMENT_AGENT_INPUT' }

/** Refusal order mirrors the catalogue (spec §6.3): disconnected, then paused, then the agent-input window. */
export function evaluateSubmitGate(i: SubmitGateInput): SubmitGateVerdict {
  if (i.disconnected) return { ok: false, error: 'BROWSER_DISCONNECTED' }
  if (i.paused) return { ok: false, error: 'BROWSER_PAUSED' }
  if (agentInputRecent(i)) return { ok: false, error: 'COMMENT_AGENT_INPUT' }
  return { ok: true }
}

/**
 * The pins a submit sends, in pin order: the named ones, or every draft that has text. Pins that are already
 * sent, unknown, or empty are skipped (an empty comment is not a request). `[]` = nothing to send.
 */
export function selectPins(all: PinRecord[], which: string[] | 'drafts'): PinRecord[] {
  const wanted = which === 'drafts' ? null : new Set(which)
  return all
    .filter((p) => p.state === 'draft' && p.comment.trim() !== '')
    .filter((p) => wanted === null || wanted.has(p.id))
    .sort((a, b) => a.n - b.n)
}

/**
 * Where a comment goes (spec §8.7 step 2): the composer's picker choice, else the pane's owner session, else
 * `null` — which the renderer reads as "the folder's selected session", and, with none, "nowhere".
 */
export function resolveDestination(requested: string | null, owner: string | null): string | null {
  return requested ?? owner
}
