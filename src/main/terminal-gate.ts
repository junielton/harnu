/**
 * Terminal gate, shell half (T474 B4): resolves the {@link TerminalGateState} that the pure
 * `terminal-gate-core` judges, from the registry and the operator's per-folder opt-in.
 *
 * Used twice and deliberately identically: `server.ts` resolves it BEFORE planning so a refused
 * read never raises a confirm (spec §6.2), and the verb handler resolves it again as the last
 * line of defence, because what it judged can change between the plan and the dispatch.
 */
import { readAgentTerminalWrites } from './mcp/prefs'
import { resolveTerminalGateState, type TerminalGateState } from './terminal-gate-core'
import { terminalRegistry, type TerminalRecord } from './terminal-registry'
import { terminalLeases } from './terminal-lease'
import { readUserProjects, terminalReadOptIns, type UserProjectsFile } from './user-projects'

export interface ResolvedTerminalGate {
  /** The registry record, when the id is known. */
  rec: TerminalRecord | undefined
  state: TerminalGateState
}

/**
 * Resolve the gate state of `terminalId`. `file` is the already-read projects file when the
 * caller has one; otherwise it is read here.
 */
export async function resolveTerminalGate(
  terminalId: string,
  file?: UserProjectsFile
): Promise<ResolvedTerminalGate> {
  const rec = terminalRegistry.get(terminalId)
  // The kill-switch (spec §6.5) is read live, so flipping it takes effect on the very next call.
  const writesEnabled = await readAgentTerminalWrites()
  // Switching typing off ends every lease. The Settings toggle does that itself; doing it here
  // too covers a pref flipped some other way, and costs nothing while the switch is on.
  if (!writesEnabled) terminalLeases.revokeAll()
  const readOptIn = rec
    ? (await terminalReadOptIns(file ?? (await readUserProjects()), [rec.folder])).has(rec.folder)
    : false
  // A write lease on an operator terminal rides on the folder's read opt-in. Whenever the opt-in
  // is seen OFF the lease is ended, whatever turned it off, so turning it back on later cannot
  // revive an old approval.
  if (rec && rec.origin === 'operator' && !readOptIn) terminalLeases.revoke(rec.terminalId)
  return {
    rec,
    state: resolveTerminalGateState(
      rec,
      { readOptIn, writesEnabled },
      rec
        ? {
            active: terminalLeases.isActive(rec.terminalId, rec.ptyId),
            denied: terminalLeases.isDenied(rec.terminalId)
          }
        : undefined
    )
  }
}

/**
 * The operator's Disconnect (spec §6.4), main side: permanent, for that terminal and every agent,
 * and it stops reads AND writes. Marks the record, ends its lease and wakes any call waiting on
 * the terminal (its wait ends at once). The PTY, its output and the screen model are untouched:
 * the operator keeps their shell. There is no inverse — no verb and no IPC reconnects.
 * Returns whether the terminal exists (an already-disconnected one is a harmless no-op).
 */
export function disconnectTerminal(terminalId: string): boolean {
  if (!terminalRegistry.disconnect(terminalId)) return false
  terminalLeases.revoke(terminalId)
  return true
}
