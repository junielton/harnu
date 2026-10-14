/**
 * Terminal gate, shell half (T474 B4): resolves the {@link TerminalGateState} that the pure
 * `terminal-gate-core` judges, from the registry and the operator's per-folder opt-in.
 *
 * Used twice and deliberately identically: `server.ts` resolves it BEFORE planning so a refused
 * read never raises a confirm (spec §6.2), and the verb handler resolves it again as the last
 * line of defence, because what it judged can change between the plan and the dispatch.
 */
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
  const readOptIn = rec
    ? (await terminalReadOptIns(file ?? (await readUserProjects()), [rec.folder])).has(rec.folder)
    : false
  return {
    rec,
    // The kill-switch (B7) does not exist yet; its default is on, and a read ignores it anyway.
    state: resolveTerminalGateState(
      rec,
      { readOptIn, writesEnabled: true },
      rec
        ? {
            active: terminalLeases.isActive(rec.terminalId, rec.ptyId),
            denied: terminalLeases.isDenied(rec.terminalId)
          }
        : undefined
    )
  }
}
