import type { TaskState, TranscriptState } from '../../../preload'
import type { SessionStatus } from '../stores/sessions'
import { isNeedsInput, type FleetActivity } from '../stores/fleet-state'

/**
 * The single visible sidebar dot for a session (design.md §6 — Session status).
 *
 * Hook-only sticky states (needs-input, failed, completed) and the archived
 * lifecycle flag override the live-activity axis. The working/stuck/idle decision
 * is NO LONGER made here from `status` alone — it comes from the canonical
 * `resolveActivity` (`fleet-state.ts`), the SAME derivation the Fleet board reads,
 * so the two surfaces can never disagree again (the BUG-13 grey-vs-green split).
 * `stuck` is the state that used to have no name: a `working` session gone quiet
 * past the threshold (`resolveActivity` returns it; the old code turned it grey).
 * `needs-input` is the headline — sticky, never auto-relaxed.
 */
export type Dot = 'working' | 'stuck' | 'needs-input' | 'failed' | 'completed' | 'archived' | 'idle'

/**
 * Project the (taskState, transcriptState, status, resolved activity) tuple onto
 * one dot. The caller resolves `activity` via `resolveActivity(...)` so the dot
 * and the board agree by construction. Terminal / lifecycle states win first;
 * then the activity axis paints working / stuck / idle. `needs-input` comes from
 * the canonical {@link isNeedsInput} so a session blocked on an
 * `AskUserQuestion`/`ExitPlanMode` — read from its transcript, no hook needed —
 * still shows the amber dot (T91).
 */
export function dotFor(
  taskState: TaskState | undefined,
  status: SessionStatus,
  activity: FleetActivity,
  transcriptState?: TranscriptState
): Dot {
  if (isNeedsInput({ taskState, transcriptState })) return 'needs-input'
  if (taskState === 'failed') return 'failed'
  if (taskState === 'completed') return 'completed'
  if (status === 'archived') return 'archived'
  if (activity === 'stuck') return 'stuck'
  if (activity === 'working') return 'working'
  return 'idle'
}
