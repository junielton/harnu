/**
 * Pure view logic of the "Harnu mod outside Harnu" block (T389 P4W3 §10): which sentence a
 * refusal gets, how the last-seen time reads. No Vue, no i18n runtime, no IPC.
 *
 * The wording rules are design.md §8: a managed cause is named only when one was found
 * (`policy`); when only the probe shows mods are off the sentence is the neutral one (`modsOff`).
 */

import type { ExternalSetResult } from '../../../main/companion/external-host'

type Translate = (key: string, params?: Record<string, unknown>) => string

const REFUSAL_KEY = {
  unparseable: 'unparseable',
  occupied: 'occupied',
  symlink: 'symlink',
  policy: 'policy',
  'mods-off': 'modsOff',
  'no-companion': 'noCompanion',
  failed: 'failed'
} as const

export interface ExternalToast {
  title: string
  description?: string
}

/** The toast of a refused switch, or null when the result was a success. */
export function refusalToast(r: ExternalSetResult, t: Translate): ExternalToast | null {
  if (r.ok) return null
  const title = t(`harnuMod.external.refused.${REFUSAL_KEY[r.reason]}`)
  // The one case that leaves something behind: name the single path to remove by hand.
  if (r.manualPath !== undefined) {
    return { title, description: t('harnuMod.external.manualRemove', { path: r.manualPath }) }
  }
  return { title }
}

/** `2 min ago` style, in the app locale; null `ts` reads as "never". */
export function lastSeenText(ts: number | null, now: number, t: Translate, locale: string): string {
  if (ts === null) return t('harnuMod.external.neverSeen')
  const seconds = Math.round((ts - now) / 1000)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const abs = Math.abs(seconds)
  const time =
    abs < 60
      ? rtf.format(seconds, 'second')
      : abs < 3600
        ? rtf.format(Math.round(seconds / 60), 'minute')
        : abs < 86400
          ? rtf.format(Math.round(seconds / 3600), 'hour')
          : rtf.format(Math.round(seconds / 86400), 'day')
  return t('harnuMod.external.lastSeen', { time })
}
