/**
 * Pure view logic of the Harnu mod surfaces (T389 P1W4 §7.6, §10): which words a state gets, which
 * single status line the settings block shows, and which sessions deserve the "unloaded" notice.
 * No Vue, no i18n runtime, no IPC: the store and the components feed it data and a translator.
 *
 * The wording rules are design.md §8: a cause is named only when it was observed, `legacy` is a
 * quiet fact and never a warning, and nothing here implies protection.
 */

import type { CompanionStatus } from '../../../main/companion/companion-status'
import type { CompanionState, LegacyReason } from '../../../main/companion/companion-state-core'

type Translate = (key: string, params?: Record<string, unknown>) => string

export interface StateLine {
  /** The visible text: `Harnu mod: live`. */
  text: string
  /** The reason alone (the tooltip of the monitor cell), or null for `live` and `off`. */
  reason: string | null
}

export function stateLine(state: CompanionState | null, t: Translate): StateLine | null {
  if (state === null) return null
  if (state.state === 'live') return { text: t('harnuMod.state.live'), reason: null }
  if (state.state === 'off') return { text: t('harnuMod.state.off'), reason: null }
  const reason = t(`harnuMod.reason.${state.reason}`)
  return { text: t('harnuMod.state.legacy', { reason }), reason }
}

/** The System Monitor cell: `Harnu mod live`, with the reason in the tooltip. */
export function monitorCell(
  state: CompanionState | null,
  t: Translate
): { text: string; title: string | undefined } | null {
  if (state === null) return null
  const word = state.state
  return {
    text: t('harnuMod.monitor.state', { state: word }),
    title: state.state === 'legacy' ? t(`harnuMod.reason.${state.reason}`) : undefined
  }
}

/**
 * The single status line under the settings block, or null. First match wins; none is a warning.
 * `policy` needs a session that was positively identified as blocked (DOC-8).
 */
export function settingsStatusKey(status: CompanionStatus | null): string | null {
  if (!status || !status.enabled) return null
  if (status.cliGate === 'below') return 'harnuMod.settings.cliTooOld'
  if (status.cliGate === 'above') return 'harnuMod.settings.cliUntested'
  const reasons = new Set<LegacyReason>()
  for (const s of Object.values(status.sessions)) {
    if (s.state?.state === 'legacy') reasons.add(s.state.reason)
  }
  if (reasons.has('policy')) return 'harnuMod.settings.policy'
  if (reasons.has('remoteOff')) return 'harnuMod.settings.remoteOff'
  if (reasons.has('modsOff')) return 'harnuMod.settings.modsOff'
  return null
}

/** Whether a session owns at least one fact family right now. */
export function ownsAnyFamily(s: CompanionStatus['sessions'][string] | undefined): boolean {
  return !!s && Object.values(s.ownership).some((o) => o.owner === 'companion')
}

/**
 * Sessions to tell the operator about: the mod was lost mid-session (`legacy / unloaded`) and the
 * session owned a family a moment ago. In plain `shadow` nothing owned anything, so nothing
 * changed for the operator and the state line changes silently. Once per session.
 */
export function unloadedNotices(
  prev: CompanionStatus | null,
  next: CompanionStatus,
  alreadyNotified: ReadonlySet<string>
): string[] {
  if (!prev) return []
  const out: string[] = []
  for (const [key, s] of Object.entries(next.sessions)) {
    if (alreadyNotified.has(key)) continue
    if (s.state?.state !== 'legacy' || s.state.reason !== 'unloaded') continue
    if (!ownsAnyFamily(prev.sessions[key])) continue
    out.push(key)
  }
  return out
}
