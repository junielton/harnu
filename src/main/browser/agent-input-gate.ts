/**
 * THE agent-input gate (T564 U7, merging U2's emit gate, U4's `agentInputBlocksEmit` and U6's pick gate; spec §5.4
 * condition 2 and §8.6): one pure question over the registry's record of agent input runs.
 *
 * A page event (`harnu.emit`) or a comment pick is rejected when an agent INPUT verb (`click`, `type`, `fill`,
 * `press`, `upload`, `eval`) was running, or ran at any moment between the user activation it rides on (less
 * {@link ACTIVATION_PADDING_MS}) and the call itself. The page's activation timestamp is the PRIMARY anchor: it is
 * what tells the operator's own click from an agent click that a page script spends later (`setTimeout(emit, 1600)`
 * lands on the agent's activation and overlaps the run). Only when the timestamp is missing or not believable (see
 * {@link ACTIVATION_MAX_AGE_MS}) is the window measured back from the call by {@link AGENT_INPUT_WINDOW_MS}, as long as
 * a user activation lives. Both call sites (`page-service.ts` for the emit, `overlay-bridge.ts` for the pick) call
 * {@link agentInputBlocksEmit}; the pure gates only receive its verdict.
 */
import { AGENT_INPUT_WINDOW_MS, type BrowserRegistry } from './registry'

export { AGENT_INPUT_WINDOW_MS }

/** An activation timestamp older than this (a transient activation lasts about 5 s) or in the future is not trusted. */
export const ACTIVATION_MAX_AGE_MS = 6000
/** How far into the future a preload timestamp may be before it is not believed (clock skew between worlds). */
export const ACTIVATION_FUTURE_SLACK_MS = 1000
/** An agent run that ended this long before the activation still counts (event delivery is not instantaneous). */
export const ACTIVATION_PADDING_MS = 100

/** The activation to anchor on when it is believable, else `null` (use the fallback window from the call). */
export function believableActivation(emitAt: number, activationAt?: number | null): number | null {
  if (activationAt == null) return null
  const believable =
    activationAt <= emitAt + ACTIVATION_FUTURE_SLACK_MS &&
    emitAt - activationAt <= ACTIVATION_MAX_AGE_MS
  return believable ? Math.min(activationAt, emitAt) : null
}

/** The start of the interval an agent input run must not overlap, for a call at `emitAt`. */
export function agentInputWindowStart(emitAt: number, activationAt?: number | null): number {
  const activation = believableActivation(emitAt, activationAt)
  return activation === null ? emitAt - AGENT_INPUT_WINDOW_MS : activation - ACTIVATION_PADDING_MS
}

export function agentInputBlocksEmit(
  registry: Pick<BrowserRegistry, 'agentInputOverlaps'>,
  paneId: string,
  emitAt: number,
  activationAt?: number | null
): boolean {
  return registry.agentInputOverlaps(paneId, agentInputWindowStart(emitAt, activationAt), emitAt)
}
