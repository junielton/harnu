/**
 * The `planUsage` parity rule (T389 P1W6 §13). Pure.
 *
 * Input: one ledger row per poll result (`k: 'poll'`), recorded by the host when a
 * `claude -p "/usage"` run produced its own figures and a session whose binding owns `planUsage`
 * had a reading. The row carries the poll's two windows (`s` session, `w` week, with their
 * `rs`/`rw` reset times in epoch ms) and the freshest owned reading (`h5`, `d7`, `r5`, `r7` and
 * its `age` in ms at poll time). A poll with no reading is no comparison and is not recorded.
 *
 * Equal: both percents within a point, resets within 5 minutes. Explained: P1 the reading was
 * older than 90 s; P2 the pair straddles a window reset. Anything else is unexplained, and the
 * flip gate wants zero of those.
 */

import {
  registerParityRule,
  type DetailValue,
  type Divergence,
  type ParityRecord
} from '../parity-core'
import { PLAN_USAGE_STALE_MS } from '../contract'

const PCT_TOLERANCE = 1
const RESET_TOLERANCE_MS = 5 * 60_000

const num = (r: ParityRecord, key: string): number | null => {
  const v: DetailValue | undefined = r.d?.[key]
  return typeof v === 'number' ? v : null
}

/** `null` on both sides is equal; a figure on one side only is a difference. */
function close(a: number | null, b: number | null, tolerance: number): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a - b) <= tolerance
}

const describe = (r: ParityRecord): string =>
  ['s', 'w', 'h5', 'd7', 'age'].map((k) => `${k}=${num(r, k) ?? '-'}`).join(' ')

export function comparePlanUsageRows(rows: ParityRecord[]): Divergence[] {
  const out: Divergence[] = []
  for (const r of rows) {
    if (r.k !== 'poll') continue
    const h5 = num(r, 'h5')
    const d7 = num(r, 'd7')
    if (h5 === null && d7 === null) continue // no owned reading: nothing to compare
    const equal =
      close(num(r, 's'), h5, PCT_TOLERANCE) &&
      close(num(r, 'w'), d7, PCT_TOLERANCE) &&
      close(num(r, 'rs'), num(r, 'r5'), RESET_TOLERANCE_MS) &&
      close(num(r, 'rw'), num(r, 'r7'), RESET_TOLERANCE_MS)
    if (equal) continue
    const age = num(r, 'age')
    const readAt = age === null ? null : r.t - age
    const straddles = (reset: number | null): boolean =>
      reset !== null && readAt !== null && reset > readAt && reset <= r.t
    let cls: string | null = null
    if (age !== null && age > PLAN_USAGE_STALE_MS) cls = 'P1'
    else if (straddles(num(r, 'r5')) || straddles(num(r, 'r7'))) cls = 'P2'
    out.push({ sk: r.sk, at: r.t, legacy: describe(r), companion: describe(r), class: cls })
  }
  return out
}

export function registerPlanUsageParityRule(): void {
  registerParityRule({ stream: 'planUsage', compare: comparePlanUsageRows })
}
registerPlanUsageParityRule()
