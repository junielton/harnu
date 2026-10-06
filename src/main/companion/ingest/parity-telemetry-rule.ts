/**
 * The `telemetry` parity rule (T389 P1W6 §13). Pure.
 *
 * Input: one session's ledger rows, oldest first. Each statusLine blob (`source: legacy`) and
 * each `usage.measured` (`source: companion`) is a `reading` row carrying
 * `{ pct, window, usd, h5, d7, r5, r7 }` (context percent and window, cost, the two windows'
 * percents and their reset times in epoch ms). Each statusLine sample is paired with the nearest
 * companion sample of the session within PAIR_WINDOW_MS and judged by the tolerances below.
 *
 * Explained classes: T1 no pair in the window (the statusLine renders more often, measures fold
 * bursts); T2 the companion's context is missing right after an aborted turn (needs
 * `d.afterAbort`, which only the turn sensor of P1W5 can set: until then a missing context is
 * unexplained); T3 the first reading of a resumed session carries no windows (`rateLimits: []`).
 * Everything else is unexplained, and the flip gate wants zero of those.
 */

import {
  registerParityRule,
  type Divergence,
  type DetailValue,
  type ParityRecord
} from '../parity-core'

export const PAIR_WINDOW_MS = 5_000
const PCT_TOLERANCE = 1
const USD_TOLERANCE = 0.01
const RATE_TOLERANCE = 1
const RESET_TOLERANCE_MS = 60_000

const num = (r: ParityRecord, key: string): number | null => {
  const v: DetailValue | undefined = r.d?.[key]
  return typeof v === 'number' ? v : null
}

/** `null` on both sides is equal; a figure on one side only is a difference. */
function close(a: number | null, b: number | null, tolerance: number): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a - b) <= tolerance
}

function describe(r: ParityRecord): string {
  const parts = ['pct', 'usd', 'h5', 'd7'].map((k) => `${k}=${num(r, k) ?? '-'}`)
  return parts.join(' ')
}

type Why = 'context' | 'cost' | 'windows' | 'resets'

/** What differs between a statusLine sample and its companion twin. Empty means equal. */
function differences(legacy: ParityRecord, companion: ParityRecord): Why[] {
  const out: Why[] = []
  if (
    !close(num(legacy, 'pct'), num(companion, 'pct'), PCT_TOLERANCE) ||
    (num(legacy, 'window') !== null &&
      num(companion, 'window') !== null &&
      num(legacy, 'window') !== num(companion, 'window'))
  ) {
    out.push('context')
  }
  if (!close(num(legacy, 'usd'), num(companion, 'usd'), USD_TOLERANCE)) out.push('cost')
  if (
    !close(num(legacy, 'h5'), num(companion, 'h5'), RATE_TOLERANCE) ||
    !close(num(legacy, 'd7'), num(companion, 'd7'), RATE_TOLERANCE)
  ) {
    out.push('windows')
  }
  if (
    !close(num(legacy, 'r5'), num(companion, 'r5'), RESET_TOLERANCE_MS) ||
    !close(num(legacy, 'r7'), num(companion, 'r7'), RESET_TOLERANCE_MS)
  ) {
    out.push('resets')
  }
  return out
}

export function compareTelemetryRows(rows: ParityRecord[]): Divergence[] {
  const readings = rows.filter((r) => r.k === 'reading')
  const legacy = readings.filter((r) => r.source === 'legacy')
  const companion = readings.filter((r) => r.source === 'companion')
  const firstCompanion = companion[0]
  const out: Divergence[] = []

  for (const l of legacy) {
    let twin: ParityRecord | null = null
    for (const c of companion) {
      if (Math.abs(c.t - l.t) > PAIR_WINDOW_MS) continue
      if (twin === null || Math.abs(c.t - l.t) < Math.abs(twin.t - l.t)) twin = c
    }
    if (twin === null) {
      out.push({ sk: l.sk, at: l.t, legacy: describe(l), companion: null, class: 'T1' })
      continue
    }
    const why = differences(l, twin)
    if (why.length === 0) continue
    const noWindows = num(twin, 'h5') === null && num(twin, 'd7') === null
    let cls: string | null = null
    if (
      why.every((w) => w === 'windows' || w === 'resets') &&
      noWindows &&
      twin === firstCompanion
    ) {
      cls = 'T3'
    } else if (
      why.includes('context') &&
      num(twin, 'pct') === null &&
      twin.d?.afterAbort === true
    ) {
      cls = 'T2'
    }
    out.push({ sk: l.sk, at: l.t, legacy: describe(l), companion: describe(twin), class: cls })
  }
  return out
}

export function registerTelemetryParityRule(): void {
  registerParityRule({ stream: 'telemetry', compare: compareTelemetryRows })
}
registerTelemetryParityRule()
