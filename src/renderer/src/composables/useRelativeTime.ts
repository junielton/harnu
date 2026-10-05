/**
 * Tiny relative-time formatter for ISO timestamps coming out of
 * `sessions-index.json#entries[].modified` (and `created`). Renders as
 * `now`, `5m ago`, `2h ago`, `yesterday`, `3d ago`, `2w ago`, then falls
 * back to `YYYY-MM-DD` past 30 days. Returns `''` for invalid / empty input.
 *
 * Deliberately not internationalized via Intl.RelativeTimeFormat — vue-i18n's
 * datetime localization would be the right home for that once we want
 * culture-aware text. For v1 we mirror the design's terse English and let
 * the pt-BR locale wait (the strings live in i18n as `relativeTime.*`).
 *
 * Pure function — safe to call from any reactive scope. Re-evaluating every
 * Vue tick is cheap (no allocations after the Date parse) and keeps the
 * computed up-to-date as time passes.
 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''

  const diff = Date.now() - t
  if (diff < 0) return 'now' // clock skew safety net

  const sec = Math.floor(diff / 1000)
  if (sec < 45) return 'now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  // Past a month, calendar date carries more meaning than the relative span.
  return new Date(t).toISOString().slice(0, 10) // YYYY-MM-DD
}
