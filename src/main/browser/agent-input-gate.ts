/**
 * The agent-input half of the emit gate (T564 U4, spec §5.4 condition 2 and §8.6): one pure question, shared by
 * `harnu.emit` (U2) and the overlay's comment pick (U6). A page event or a pick is rejected when an agent input
 * verb (`click`, `type`, `fill`, `press`, `upload`, `eval`) ran at any moment from `AGENT_INPUT_WINDOW_MS` before
 * the user activation it rides on up to the emit itself. The page's activation timestamp is not always known, so
 * without one the window is measured back from the emit.
 */
import { AGENT_INPUT_WINDOW_MS, type BrowserRegistry } from './registry'

export { AGENT_INPUT_WINDOW_MS }

export function agentInputBlocksEmit(
  registry: Pick<BrowserRegistry, 'agentInputOverlaps'>,
  paneId: string,
  emitAt: number,
  activationAt?: number
): boolean {
  const anchor = activationAt !== undefined && activationAt <= emitAt ? activationAt : emitAt
  return registry.agentInputOverlaps(paneId, anchor - AGENT_INPUT_WINDOW_MS, emitAt)
}
