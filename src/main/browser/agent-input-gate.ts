/**
 * THE agent-input gate (T564 U7, merging U2's emit gate, U4's `agentInputBlocksEmit` and U6's pick gate; spec §5.4
 * condition 2 and §8.6): one pure question over the registry's record of agent input runs.
 *
 * A page event (`harnu.emit`) or a comment pick is rejected when an agent INPUT verb (`click`, `type`, `fill`,
 * `press`, `upload`, `eval`) was running, or ran at any moment from {@link AGENT_INPUT_WINDOW_MS} before the user
 * activation the call rides on up to the call itself. Chromium keeps a user activation alive for about 5 s, so a
 * CDP click can be spent by a `setTimeout(emit, 1600)` the page armed itself; a shorter window would let that
 * through. The page's activation timestamp is used only when it is believable (see {@link ACTIVATION_MAX_AGE_MS});
 * without one the window is measured back from the call. Both call sites (`page-service.ts` for the emit,
 * `overlay-bridge.ts` for the pick) call {@link agentInputBlocksEmit}; the pure gates only receive its verdict.
 */
import { AGENT_INPUT_WINDOW_MS, type BrowserRegistry } from './registry'

export { AGENT_INPUT_WINDOW_MS }

/** An activation timestamp older than this (a transient activation lasts about 5 s) or in the future is not trusted. */
export const ACTIVATION_MAX_AGE_MS = 6000
/** How far into the future a preload timestamp may be before it is not believed (clock skew between worlds). */
export const ACTIVATION_FUTURE_SLACK_MS = 1000

/** The moment the window is measured back from: the activation when it is believable, else the call itself. */
export function agentInputAnchor(emitAt: number, activationAt?: number | null): number {
  if (activationAt == null) return emitAt
  const believable =
    activationAt <= emitAt + ACTIVATION_FUTURE_SLACK_MS &&
    emitAt - activationAt <= ACTIVATION_MAX_AGE_MS
  return believable ? Math.min(activationAt, emitAt) : emitAt
}

export function agentInputBlocksEmit(
  registry: Pick<BrowserRegistry, 'agentInputOverlaps'>,
  paneId: string,
  emitAt: number,
  activationAt?: number | null
): boolean {
  const anchor = agentInputAnchor(emitAt, activationAt)
  return registry.agentInputOverlaps(paneId, anchor - AGENT_INPUT_WINDOW_MS, emitAt)
}
