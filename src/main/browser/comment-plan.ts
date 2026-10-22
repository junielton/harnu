/**
 * The decisions behind point-and-comment (T564 U6, spec §8.1, §8.6, §8.7), pure over injected facts.
 *
 *  - {@link evaluatePickGate}: may a guest's pick open a composer? A pick is accepted only if no agent INPUT verb
 *    ran on the pane within the `agentInputAt` window of §5.4 (or overlapped the click), so an agent cannot use a
 *    `click` to open a composer on a node of its choosing. (U0 A1: `before-mouse-event` fires for real, CDP and
 *    `sendInputEvent` mouse input alike, so unlike a key it cannot tell the operator's click from a driven one;
 *    the `agentInputAt` window the input verbs open is the mechanism.)
 *  - {@link evaluateSubmitGate}: may `comment:submit` go through? The same agent-input window, plus the pane's
 *    `paused` and `disconnected` state (spec §8.6).
 *  - {@link selectPins} / {@link resolveDestination}: which pins a submit sends, and to whom.
 */
import type { PinRecord } from './comment-pins'
import { AGENT_INPUT_WINDOW_MS, agentInputBlocks, type AgentInputInterval } from './emit-gate'

export interface AgentInputFacts {
  now: number
  /** An agent input verb is running on the pane right now. */
  agentInputInFlight: boolean
  /** When the last agent input verb finished on the pane, or `null`. */
  agentInputAt: number | null
  /** Recent agent input runs on the pane, for the activation-overlap check (needs `activationAt`). */
  agentInputIntervals?: readonly AgentInputInterval[]
  /** Epoch ms of the trusted input that made this request, when the guest says (`null` = unknown). */
  activationAt?: number | null
}

function agentInputRecent(i: AgentInputFacts): boolean {
  // With a trustworthy activation time the emit gate's overlap check applies; without one, the plain window.
  if (i.activationAt != null && i.agentInputIntervals) {
    return agentInputBlocks({
      now: i.now,
      userActivationActive: true,
      activatedBy: 'pointer',
      agentInputInFlight: i.agentInputInFlight,
      agentInputAt: i.agentInputAt,
      agentInputIntervals: i.agentInputIntervals,
      activationAt: i.activationAt,
      paused: false,
      disconnected: false,
      lastRealKeyDownAt: null
    })
  }
  return (
    i.agentInputInFlight ||
    (i.agentInputAt !== null && i.now - i.agentInputAt < AGENT_INPUT_WINDOW_MS)
  )
}

export interface PickGateInput extends AgentInputFacts {
  /** The overlay is switched on for this pane (a pick while it is off is stale or forged). */
  overlayActive: boolean
}

export type PickGateVerdict = { ok: true } | { ok: false; reason: 'OVERLAY_OFF' | 'AGENT_INPUT' }

export function evaluatePickGate(i: PickGateInput): PickGateVerdict {
  if (!i.overlayActive) return { ok: false, reason: 'OVERLAY_OFF' }
  if (agentInputRecent(i)) return { ok: false, reason: 'AGENT_INPUT' }
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
