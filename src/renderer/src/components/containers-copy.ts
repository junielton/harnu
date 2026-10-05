import { useI18n } from 'vue-i18n'
import type { ContainersActErrorCode } from '../../../preload'
import type { ActFailure } from '../stores/containers'
import { agoParts, durationParts } from './containers-format'

/**
 * The Containers takeover's shared wording (T331): relative times, durations
 * and the failure sentences, used by the view, the detail pane and the remove
 * dialog. Every string goes through `containers.*` i18n keys.
 */
export function useContainersCopy(): {
  t: ReturnType<typeof useI18n>['t']
  ago: (ms: number) => string
  agoLong: (ms: number) => string
  agoShort: (ms: number) => string
  duration: (ms: number) => string
  refusalReason: (code: ContainersActErrorCode | null) => string
  failureText: (f: ActFailure) => string
  failureDetail: (f: ActFailure) => string | null
} {
  const { t } = useI18n()

  /** "2m ago", "1d ago", "just now" (master list, scan meta). */
  function ago(ms: number): string {
    const p = agoParts(ms)
    return p.unit === 'justNow'
      ? t('containers.ago.justNow')
      : t(`containers.ago.${p.unit}`, { n: p.n })
  }

  /** "1 day ago", "just now" (detail "when" lines). */
  function agoLong(ms: number): string {
    const p = agoParts(ms)
    return p.unit === 'justNow'
      ? t('containers.agoLong.justNow')
      : t(`containers.agoLong.${p.unit}`, p.n, { named: { n: p.n } })
  }

  /** "3d", "5h" (the remove dialog's container list). */
  function agoShort(ms: number): string {
    const p = agoParts(ms)
    return p.unit === 'justNow'
      ? t('containers.short.justNow')
      : t(`containers.short.${p.unit}`, { n: p.n })
  }

  /** "2 days", "5 hours". */
  function duration(ms: number): string {
    const p = durationParts(ms)
    return t(`containers.duration.${p.unit}`, p.n, { named: { n: p.n } })
  }

  function refusalReason(code: ContainersActErrorCode | null): string {
    return code ? t(`containers.refusal.${code}`) : t('containers.refusal.unknown')
  }

  /** The sentence of a failed action's error note. */
  function failureText(f: ActFailure): string {
    if (f.kind === 'refused') {
      return t(`containers.failed.refused.${f.verb}`, { reason: refusalReason(f.code) })
    }
    if (f.kind === 'request') {
      return t('containers.failed.request', { reason: refusalReason(f.code) })
    }
    const partial = f.done > 0
    if (f.verb === 'stop') {
      return partial
        ? t('containers.failed.stopPartial', { done: f.done, total: f.total })
        : t('containers.failed.stopNone', Math.max(1, f.total), {
            named: { n: Math.max(1, f.total) }
          })
    }
    if (f.verb === 'start') {
      return partial
        ? t('containers.failed.startPartial', { done: f.done, total: f.total })
        : t('containers.failed.startNone')
    }
    return partial
      ? t('containers.failed.removePartial', { done: f.done, total: f.total })
      : t('containers.failed.removeNone')
  }

  /** Docker's own error text, shown on the mono line under the sentence. */
  function failureDetail(f: ActFailure): string | null {
    if (f.kind === 'refused') return null
    return f.message?.trim() || null
  }

  return { t, ago, agoLong, agoShort, duration, refusalReason, failureText, failureDetail }
}
