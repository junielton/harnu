/**
 * Terminal lifecycle, pure core (T474 unit B2): what the renderer is told about a terminal.
 *
 * No electron and no node-pty, so the reload-recovery and tombstone rules are testable
 * without either (ADR-0001). `terminal-ipc.ts` binds these to IPC.
 */
import type { TerminalRecord, TerminalRegistry } from './terminal-registry'

/** What `terminal:status` tells the renderer. */
export type TerminalStatus =
  | { known: false }
  | {
      known: true
      state: 'running' | 'exited'
      /** Epoch ms the PTY was spawned (the 2 s stale window is measured from here). */
      spawnedAt: number
      exit?: { code: number | null; at: number; reason: 'natural' | 'closed' }
      /** Last raw output of an exited terminal, for the pane to paint on mount. */
      snapshot?: string
    }

/** The `pane.split` payload that (re)creates an agent terminal's pane in the renderer. */
export interface TerminalPaneSplit {
  target: 'split'
  worktreePath: string
  cwd: string
  kind: 'shell'
  paneId: string
  ptyId: string
  ownerSessionId: string | null
  spawnedAt: number
  /** Present on a re-announcement after a reload: the operator may already know this pane. */
  redispatch?: true
}

/** The `pane.split` payload for one terminal. Shared with the `spawn_terminal` handler's shape. */
export function paneSplitFor(rec: TerminalRecord): TerminalPaneSplit {
  return {
    target: 'split',
    worktreePath: rec.folder,
    cwd: rec.folder,
    kind: 'shell',
    paneId: rec.terminalId,
    ptyId: rec.ptyId,
    ownerSessionId: rec.ownerSessionId,
    spawnedAt: rec.createdAt
  }
}

export function terminalStatus(registry: TerminalRegistry, terminalId: unknown): TerminalStatus {
  const rec = typeof terminalId === 'string' ? registry.get(terminalId) : undefined
  if (!rec) return { known: false }
  return {
    known: true,
    state: rec.state,
    spawnedAt: rec.createdAt,
    ...(rec.exit ? { exit: { ...rec.exit } } : {}),
    ...(rec.state === 'exited' && rec.finalSnapshot !== undefined
      ? { snapshot: rec.finalSnapshot }
      : {})
  }
}

/**
 * Re-announce every live agent terminal to a freshly loaded renderer. `dispatch` is the command
 * bridge; a rejected dispatch (the renderer reloaded again mid-flight) is swallowed — the next
 * `renderer:ready` repeats the whole announcement, and the store ignores a pane it already has.
 */
export async function redispatchLiveTerminals(
  registry: TerminalRegistry,
  dispatch: (command: string, payload: unknown) => Promise<unknown>
): Promise<number> {
  const live = registry.liveAgentTerminals()
  await Promise.all(
    live.map((rec) =>
      dispatch('pane.split', { ...paneSplitFor(rec), redispatch: true }).catch(() => undefined)
    )
  )
  return live.length
}
