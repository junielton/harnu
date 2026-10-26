/**
 * The boot-time restore, with its collaborators injected (T564 U7, spec §10.3, Delta 2). It runs BEFORE the window is
 * created, so it must be cheap: with no browser pane saved it does nothing at all, and with some it reads only the
 * pinned-project list and checks each pane's own folder on disk. It never scans the fleet (450 folders took 10 s).
 *
 * A folder may come back when it exists and is either a pinned project (or one of its worktrees) or a git checkout
 * (it has a `.git` entry), which covers the worktrees and repos the operator works in without scanning for sessions. A
 * folder the operator blocked for agents drops an agent-opened pane there but keeps an operator-opened one (the block
 * only limits agents, and page files of a blocked folder are refused by the jail anyway).
 */
import { planRestore, type PersistedPaneInput, type RestoredPane } from './restore-plan'

export interface RestoreProject {
  path: string
  worktrees: ReadonlyArray<{ path: string }>
  agentDenied?: boolean
}

export interface RestoreDeps {
  /** Every stack in `helpers.json`: the worktree path and its saved panes. */
  readStacks(): Promise<
    Array<{
      worktreePath: string
      panes: ReadonlyArray<{ id: unknown; type: unknown; payload?: unknown }>
    }>
  >
  /** The pinned projects; may throw (then only the on-disk rule applies). */
  readProjects(): Promise<RestoreProject[]>
  isDirectory(path: string): boolean
  hasGit(path: string): boolean
  /** Whether `folder` is under a path the operator blocked for agents. */
  isBlocked(folder: string, deniedPaths: readonly string[]): boolean
  now(): number
  /** Register one restored pane (record, access state, pins, host placeholder). */
  apply(restored: RestoredPane): void
}

export async function runRestore(deps: RestoreDeps): Promise<number> {
  let stacks: Awaited<ReturnType<RestoreDeps['readStacks']>>
  try {
    stacks = await deps.readStacks()
  } catch {
    return 0
  }
  const inputs: PersistedPaneInput[] = []
  for (const stack of stacks) {
    for (const pane of stack.panes ?? []) {
      if (pane.type === 'browser') {
        inputs.push({
          id: pane.id,
          type: pane.type,
          worktreePath: stack.worktreePath,
          payload: pane.payload
        })
      }
    }
  }
  // The common case, for every user without a browser pane: nothing to read, nothing to check.
  if (inputs.length === 0) return 0

  let known = new Set<string>()
  let denied: string[] = []
  try {
    const projects = await deps.readProjects()
    known = new Set(projects.flatMap((p) => [p.path, ...p.worktrees.map((w) => w.path)]))
    denied = projects.filter((p) => p.agentDenied === true).map((p) => p.path)
  } catch {
    // A project list that cannot be read must not drop every pane: fall back to the on-disk rule alone.
  }
  const allowed = (folder: string, openedBy: 'agent' | 'operator'): boolean => {
    if (!deps.isDirectory(folder)) return false
    if (!known.has(folder) && !deps.hasGit(folder)) return false
    return openedBy === 'operator' || !deps.isBlocked(folder, denied)
  }
  let restored = 0
  for (const r of planRestore(inputs, deps.now(), allowed)) {
    deps.apply(r)
    restored++
  }
  return restored
}
