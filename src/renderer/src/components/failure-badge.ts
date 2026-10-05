import type { FailureReason } from '../../../preload'

/**
 * Pure presentational logic for the StopFailure badge (stopfailure-badges spec
 * §4.5). Framework-free so it's unit-testable in the `node` vitest env
 * (`tests/failure-badge.test.ts`), like `session-dot.ts` / `session-sort.ts`.
 *
 * Returns the i18n `labelKey` (NOT a resolved string — the component does `$t`,
 * lesson i18n/001) + a colour variant + the remaining countdown in ms (the
 * component formats it via the relative-time helper). `null` ⇒ no badge.
 */
export type FailureBadgeVariant = 'warning' | 'red'

export interface FailureBadge {
  labelKey: string
  variant: FailureBadgeVariant
  countdownMs: number | null
}

export function failureBadge(
  reason: FailureReason | undefined,
  resetsAt: number | undefined,
  nowMs: number
): FailureBadge | null {
  if (!reason || reason === 'unknown') return null
  if (reason === 'rate_limit') {
    const t = typeof resetsAt === 'number' ? resetsAt : NaN
    const countdownMs = Number.isFinite(t) && t > nowMs ? t - nowMs : null
    return { labelKey: 'session.failure.rateLimit', variant: 'warning', countdownMs }
  }
  if (reason === 'overloaded') {
    return { labelKey: 'session.failure.overloaded', variant: 'warning', countdownMs: null }
  }
  if (reason === 'billing_error') {
    return { labelKey: 'session.failure.billing', variant: 'red', countdownMs: null }
  }
  // BUG-23: a dropped background boot (reaper). Red like billing — it needs a look,
  // and the row action (Retry / Dismiss) lives in the session context menu.
  if (reason === 'boot_timeout') {
    return { labelKey: 'session.failure.bootTimeout', variant: 'red', countdownMs: null }
  }
  // Injection watchdog escalation (docs/specs/2026-07-15-preprompt-injection-
  // watchdog.md): the PTY is live but the queued pre-prompt was never delivered
  // within the retry budget. Distinct reason from `boot_timeout` — the row's
  // Retry action must call `retryPromptInjection`, not `retrySyntheticBoot`.
  if (reason === 'prompt_undelivered') {
    return { labelKey: 'session.failure.promptUndelivered', variant: 'red', countdownMs: null }
  }
  return null
}
