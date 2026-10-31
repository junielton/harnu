/**
 * Renderer-side ring buffer behind the System Monitor's 60 s sparklines (T591,
 * design.md "System Monitor (takeover)" → "Sparklines and the ring buffer").
 *
 * Pure: it turns the previous history plus a `monitor:sample` that ALREADY arrived
 * into the next history. It never samples anything itself, and it rebuilds the map
 * from the keys present in the new sample, so a key that vanished (a closed session,
 * a dead pid) is pruned in the same step and the buffer stays bounded by
 * (live keys × {@link HISTORY_LENGTH}).
 */

import type { MonitorSample } from '../../../preload'

/** ≈ 60 s at the sampler's 1.5 s cadence. */
export const HISTORY_LENGTH = 40

/** Series of RSS readings, oldest first; `null` = unknown (a parked session). */
export type MonitorHistory = ReadonlyMap<string, readonly (number | null)[]>

export const harnuHistoryKey = (pid: number): string => `harnu:${pid}`
export const sessionHistoryKey = (sessionKey: string): string => `session:${sessionKey}`

export function appendSample(prev: MonitorHistory, sample: MonitorSample): MonitorHistory {
  const next = new Map<string, readonly (number | null)[]>()
  const push = (key: string, rss: number | null): void => {
    const series = [...(prev.get(key) ?? []), rss]
    next.set(key, series.length > HISTORY_LENGTH ? series.slice(-HISTORY_LENGTH) : series)
  }
  for (const proc of sample.harnu) push(harnuHistoryKey(proc.pid), proc.rssBytes)
  for (const row of sample.sessions) push(sessionHistoryKey(row.sessionKey), row.rssBytes)
  return next
}
