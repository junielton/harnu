/**
 * Heap status classification (T127). PURE — no I/O, no clock. Feeds the always-on
 * heartbeat (`HeapSample.status`) and the footer gauge's color.
 *
 * Defaults per spec §6.1: warn at 70%, critical at 85% of the V8 heap limit — the
 * 2026-07-14 incident this feature exists to catch reached ~4 GB live heap with zero
 * warning surfaced anywhere in the product.
 *
 * Spec: docs/specs/T127-system-monitor.md §6.1.
 */

export const WARN_RATIO = 0.7
export const CRITICAL_RATIO = 0.85

/**
 * @returns `'ok'` below `WARN_RATIO`, `'warn'` at/above it, `'critical'` at/above
 *   `CRITICAL_RATIO`. A non-positive `limitBytes` (unavailable/bogus reading) is
 *   treated as `'ok'` rather than dividing by zero.
 */
export function heapStatus(usedBytes: number, limitBytes: number): 'ok' | 'warn' | 'critical' {
  if (limitBytes <= 0) return 'ok'
  const ratio = usedBytes / limitBytes
  if (ratio >= CRITICAL_RATIO) return 'critical'
  if (ratio >= WARN_RATIO) return 'warn'
  return 'ok'
}
