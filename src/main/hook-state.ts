/**
 * Hook-driven task-state reducer (session-state real-state spec §3.3/§3.4).
 *
 * Pure FSM — no electron/node deps — so it is unit-testable in isolation, like
 * `claude-reader-derive.ts`. It is the heart of the "stop guessing, listen to
 * Claude" model: instead of inferring lifecycle from JSONL file activity (which
 * cannot tell blocked-on-approval from finished), we fold the actual Claude Code
 * hook events into a real task-state.
 *
 * Process-liveness (pty:exit → completed/failed, user-close → stopped) is a
 * SEPARATE axis applied by the store on top of this hook reducer (§3.1).
 */

export type TaskState = 'working' | 'needs-input' | 'idle' | 'completed' | 'failed' | 'stopped'

export interface HookEvent {
  /** e.g. 'Notification' | 'Stop' | 'StopFailure' | 'UserPromptSubmit' | ... */
  hookEventName: string
  /**
   * Normalized discriminator: the Notification type (`permission_prompt` /
   * `idle_prompt`), the SessionStart `source`, the SessionEnd `reason`, or a
   * PreToolUse tool matcher. Optional — most events don't need it.
   */
  matcher?: string
  sessionId: string
}

/**
 * Fold one hook event into the next task-state. Unknown / informational events
 * (`SubagentStop`, `PreCompact`, `PostCompact`, anything unrecognized) leave the
 * state untouched — crucially, `needs-input` does NOT decay here; it only leaves
 * on a real subsequent transition (`Stop`, a `Working` event, etc.). That is the
 * fix for the original sin (a 20-minute blocked session stays visibly blocked).
 */
export function reduceTaskState(current: TaskState, ev: HookEvent): TaskState {
  switch (ev.hookEventName) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working'
    case 'PermissionRequest':
      return 'needs-input'
    case 'Notification':
      // Blocked-on-you notification types → needs-input (T92 §4). `permission_prompt`
      // is the headline; `worker_permission_prompt` (a sub-agent needs approval) and
      // `elicitation_dialog` (a structured prompt awaiting your answer) are equally
      // blocking. `idle_prompt` is the 60s "still there?" nudge — genuinely idle, NOT
      // a block — so it relaxes to idle (deliberate divergence from the raw research
      // list, which lumped it under needs-you; a merely-idle session must not scream).
      if (ev.matcher === 'permission_prompt') return 'needs-input'
      if (ev.matcher === 'worker_permission_prompt') return 'needs-input'
      if (ev.matcher === 'elicitation_dialog') return 'needs-input'
      if (ev.matcher === 'idle_prompt') return 'idle'
      return current
    case 'Stop':
      return 'idle'
    case 'StopFailure':
      return 'failed'
    case 'SessionStart':
      return 'idle'
    case 'SessionEnd':
      return ev.matcher === 'clear' ? 'idle' : 'completed'
    default:
      return current
  }
}

/**
 * Why a session failed — a parallel axis to `taskState`, not a new state.
 * `reduceTaskState` stays pure over `hookEventName` and still returns `'failed'`;
 * this classifies the StopFailure body's `error_type` for the badge.
 *
 * `boot_timeout` is NOT a StopFailure `error_type` (it never comes from a hook):
 * it is set renderer-side by the dead-synthetic reaper (BUG-23) when a background
 * agent-synthetic boot produced no PTY within the deadline. Sharing the
 * `failureReason` axis lets a dropped boot reuse the existing red `failed` dot +
 * board `errored` bucket instead of inventing a parallel visual state.
 *
 * `prompt_undelivered` is likewise never a StopFailure `error_type` — it is set
 * renderer-side by the injection watchdog when a synthetic's PTY came up live but
 * its queued pre-prompt was never acquired within the retry budget (a DISTINCT
 * failure from `boot_timeout`: the PTY here is genuinely alive).
 */
export type FailureReason =
  'rate_limit' | 'overloaded' | 'billing_error' | 'boot_timeout' | 'prompt_undelivered' | 'unknown'

/**
 * Normalize the raw `error_type` from a StopFailure hook body into the reasons the
 * UI distinguishes. Anything unrecognized or absent degrades to `'unknown'` (the
 * UI keeps today's plain "failed" dot, no badge). Pure, exhaustive, never throws.
 */
export function classifyFailure(errorType: unknown): FailureReason {
  switch (errorType) {
    case 'rate_limit':
    case 'overloaded':
    case 'billing_error':
      return errorType
    default:
      return 'unknown'
  }
}
