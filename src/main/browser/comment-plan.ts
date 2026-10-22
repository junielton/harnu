/**
 * The decisions behind point-and-comment (T564 U6, spec §8.1, §8.6, §8.7), pure over injected facts.
 *
 *  - {@link evaluatePickGate}: may a guest's pick open a composer? A pick is accepted only if no agent INPUT verb
 *    ran on the pane within the `agentInputAt` window of §5.4 (or overlapped the click), so an agent cannot use a
 *    `click` to open a composer on a node of its choosing. (U0 A1: `before-mouse-event` fires for real, CDP and
 *    `sendInputEvent` mouse input alike, so unlike a key it cannot tell the operator's click from a driven one;
 *    the `agentInputAt` window the input verbs open is the mechanism.)
 *  - {@link evaluateSubmitGate}: may `comment:submit` go through? Only a DISCONNECTED pane refuses (the operator
 *    cut it off from agents). The agent-input window is NOT part of it: the composer is renderer code an agent
 *    cannot drive (§8.6), so only a pick needs that window. A PAUSED pane still takes comments: pause stops the
 *    agent driving the page, a comment does not (amended 2026-10-22 by the orchestrator, pending operator
 *    confirmation).
 *  - {@link selectPins} / {@link resolveDestination}: which pins a submit sends, and to whom.
 */
import type { PinRecord } from './comment-pins'

export interface AgentInputFacts {
  /**
   * An agent input verb ran on the pane within the window of §5.4 around this pick (or is running now): the verdict of
   * `agentInputBlocksEmit` (`agent-input-gate.ts`), the one implementation shared with `harnu.emit`.
   */
  agentInputBlocked: boolean
}

export interface PickGateInput extends AgentInputFacts {
  /** The overlay is switched on for this pane (a pick while it is off is stale or forged). */
  overlayActive: boolean
  /** The operator cut this pane off from agents: no comments on it. */
  disconnected: boolean
}

export type PickGateVerdict =
  { ok: true } | { ok: false; reason: 'OVERLAY_OFF' | 'DISCONNECTED' | 'AGENT_INPUT' }

export function evaluatePickGate(i: PickGateInput): PickGateVerdict {
  if (!i.overlayActive) return { ok: false, reason: 'OVERLAY_OFF' }
  if (i.disconnected) return { ok: false, reason: 'DISCONNECTED' }
  if (i.agentInputBlocked) return { ok: false, reason: 'AGENT_INPUT' }
  return { ok: true }
}

export interface SubmitGateInput {
  disconnected: boolean
}

export type SubmitGateVerdict = { ok: true } | { ok: false; error: 'BROWSER_DISCONNECTED' }

export function evaluateSubmitGate(i: SubmitGateInput): SubmitGateVerdict {
  if (i.disconnected) return { ok: false, error: 'BROWSER_DISCONNECTED' }
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
