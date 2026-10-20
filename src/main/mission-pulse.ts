/**
 * T547 — the step "pulse": a live sign of movement INSIDE a step, derived from
 * facts Harnu already holds, so a healthy long step no longer looks like a
 * stalled one. Pure; `now` is injected. "Step N of M" is untouched — this is a
 * detail beside the position, never part of it.
 */
import type { MissionChildState } from './mcp/fleet-snapshot'
import type { MissionLinkSignal } from './mcp/tool-handlers'

/** A subagent hook this recent keeps its idle parent "working" (it is waiting on its helpers). */
export const HELPER_ACTIVE_WINDOW_MS = 2 * 60 * 1000

/**
 * AC-2 — a child whose main thread is idle only because its own subagents are
 * still calling tools is `working`, flagged `waitingOnHelpers`. Only a plain
 * idle child is promoted: one that needs input, failed, holds a parked approval
 * or is parked keeps what it says, and an unknown id has nothing to promote.
 */
export function withHelperActivity(
  child: MissionChildState,
  helperAtMs: number | undefined,
  now: number
): MissionChildState {
  if (helperAtMs === undefined || !Number.isFinite(helperAtMs)) return child
  const out: MissionChildState = { ...child, helperActivityAt: new Date(helperAtMs).toISOString() }
  const idle = child.known && !child.hibernated && child.pendingApprovals === 0
  if (idle && child.taskState === 'idle' && now - helperAtMs <= HELPER_ACTIVE_WINDOW_MS) {
    out.taskState = 'working'
    out.waitingOnHelpers = true
  }
  return out
}

/** What the popover shows as "this step is moving" (`derived.steps[].pulse`). */
export interface MissionStepPulse {
  /** Commits on the step's linked worktree branches since their base; `null` = none could be counted. */
  commits: number | null
  /** ISO time of the newest commit on those worktrees. */
  lastCommitAt: string | null
  /**
   * ISO time of the newest sign of life: a commit, the child's last transition,
   * a write to its transcript, or its subagents' last hook. `null` = no sign at all.
   */
  lastActivityAt: string | null
}

function newest(stamps: readonly (string | undefined | null)[]): string | null {
  let best: number | null = null
  for (const s of stamps) {
    const t = Date.parse(s ?? '')
    if (Number.isFinite(t) && (best === null || t > best)) best = t
  }
  return best === null ? null : new Date(best).toISOString()
}

export function buildStepPulse(
  links: readonly MissionLinkSignal[],
  children: readonly MissionChildState[]
): MissionStepPulse {
  const worktrees = links.flatMap((l) => (l.kind === 'worktree' ? [l] : []))
  const counted = worktrees.flatMap((w) => (typeof w.commits === 'number' ? [w.commits] : []))
  const lastCommitAt = newest(worktrees.map((w) => w.head?.at))
  const lastActivityAt = newest([
    lastCommitAt,
    ...children.flatMap((c) => [c.lastTransitionAt, c.modified, c.helperActivityAt])
  ])
  return {
    commits: counted.length > 0 ? counted.reduce((a, b) => a + b, 0) : null,
    lastCommitAt,
    lastActivityAt
  }
}
