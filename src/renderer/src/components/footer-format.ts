/**
 * Pure chip-selection for the footer status bar.
 *
 * Decides WHICH telemetry chips render for the active session, in what order,
 * with their pre-formatted display value — so `StatusFooter.vue` stays dumb and
 * the additive null/empty rules (a chip is omitted when its datum is absent, so
 * the bar never flashes a blank chip) can't regress. Framework-free (type-only
 * imports + the pure `usage-format` helpers) → unit-testable in the node vitest
 * env (`tests/footer-format.test.ts`).
 */
import type { SessionTelemetry } from '../../../preload'
import type { Session } from '../stores/sessions'
import { formatCostUsd, formatLines } from './usage-format'

export type FooterChipKey = 'model' | 'context' | 'branch' | 'effort' | 'cost' | 'lines'

export interface FooterChip {
  key: FooterChipKey
  /** Pre-formatted display string (icon is chosen by `key` in the SFC). */
  value: string
}

/**
 * Ordered chips for the active session: model · context · branch · effort ·
 * cost · lines. A chip is dropped when its field is null/empty (context is null
 * early in a session and post-`/compact`; branch is empty on non-git folders;
 * lines are dropped when both counts are 0).
 */
export function footerSessionChips(
  tele: SessionTelemetry | null,
  session: Pick<Session, 'gitBranch'> | null
): FooterChip[] {
  const chips: FooterChip[] = []
  if (!tele) return chips
  if (tele.modelName) chips.push({ key: 'model', value: tele.modelName })
  if (tele.contextPercent != null) chips.push({ key: 'context', value: `${tele.contextPercent}%` })
  if (session?.gitBranch) chips.push({ key: 'branch', value: session.gitBranch })
  if (tele.effortLevel) chips.push({ key: 'effort', value: tele.effortLevel })
  if (tele.costUsd != null) chips.push({ key: 'cost', value: formatCostUsd(tele.costUsd) })
  if ((tele.linesAdded ?? 0) !== 0 || (tele.linesRemoved ?? 0) !== 0)
    chips.push({ key: 'lines', value: formatLines(tele.linesAdded, tele.linesRemoved) })
  return chips
}

/**
 * Which `/compact`-proximity condition fired for the active session, or `null`
 * when none did:
 * - `'pct'`  — context ≥ 95%, genuinely near the window ceiling (red signal).
 * - `'over200k'` — `exceeds200k`: crossed the 200k-token tier (relevant on a 1M
 *   context window, so it can fire at a *low* `contextPercent`, e.g. 53%; accent
 *   signal).
 *
 * `'pct'` takes precedence over `'over200k'` when both are true, so the
 * higher-urgency red "near /compact" wins. Drives the `triangle-alert` chip's
 * label + color in the footer.
 */
export type NearCompactReason = 'over200k' | 'pct' | null

export function nearCompactReason(tele: SessionTelemetry | null): NearCompactReason {
  if (!tele) return null
  if ((tele.contextPercent ?? 0) >= 95) return 'pct'
  if (tele.exceeds200k === true) return 'over200k'
  return null
}

/**
 * True when the active session is at/over the `/compact` threshold — context
 * ≥ 95% or `exceeds200k`. Derived from {@link nearCompactReason} so the two
 * never drift. Drives the `triangle-alert` chip.
 */
export function nearCompact(tele: SessionTelemetry | null): boolean {
  return nearCompactReason(tele) !== null
}
