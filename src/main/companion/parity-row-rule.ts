/**
 * The `row` parity rule (T455 spec §7.3), hosted here like the `taskState` rule; the ledger
 * framework is `parity-core.ts`. Pure.
 *
 * The comparison itself happens when the record is written (`ingest/row-parity-core.ts`): the texts
 * it needs exist only in memory, and the ledger keeps no text. Each record is one group at one
 * main-loop turn end, with `d = { group, verdict, cls, lenPush, lenLegacy }`. This rule turns the
 * records back into divergences:
 *
 *  - only the four companion-owned groups (`prompt`, `count`, `activity`, `assistant`) can diverge;
 *    `title` and `tools` are legacy-owned, recorded for a later partition change, never gating;
 *  - a `diverge` record yields one divergence per part of its class (`last:…+first:…` for the
 *    prompt group), explained as `<group>:<part>` when the part names a class, `unexplained`
 *    (class `null`) otherwise;
 *  - `match` yields nothing; `unaligned`, `unknown` and `no-legacy` are not comparisons at all.
 *
 * `rowGateRecords` is the gate's input: the companion-owned comparisons only, so the gate's fact
 * count is the number of real comparisons. The gate's thresholds and its tolerance for
 * `unexplained` are the operator's decision (spec §7.3, the open blocker on W0), not this file's.
 */

import type { RowGroup } from './arbitration-core'
import { ROW_PARTITION } from './arbitration-core'
import { registerParityRule, type Divergence, type ParityRecord } from './parity-core'

const COMPARED: ReadonlySet<string> = new Set(['match', 'diverge'])
const gated = (r: ParityRecord): boolean =>
  r.stream === 'row' &&
  typeof r.d?.group === 'string' &&
  ROW_PARTITION[r.d.group as RowGroup] === 'companion'

export function compareRowRecords(rows: ParityRecord[]): Divergence[] {
  const out: Divergence[] = []
  for (const r of rows) {
    if (!gated(r) || r.d?.verdict !== 'diverge') continue
    const group = String(r.d.group)
    const cls = typeof r.d.cls === 'string' && r.d.cls !== '' ? r.d.cls : 'unexplained'
    for (const part of cls.split('+')) {
      const name = part.split(':').at(-1)
      out.push({
        sk: r.sk,
        at: r.ts ?? r.t,
        legacy: group,
        companion: part,
        class: name === 'unexplained' || name === 'none' ? null : `${group}:${part}`
      })
    }
  }
  return out
}

/** The records the flip gate counts: comparisons of the companion-owned groups. */
export function rowGateRecords(records: readonly ParityRecord[]): ParityRecord[] {
  return records.filter((r) => gated(r) && COMPARED.has(String(r.d?.verdict)))
}

export function registerRowParityRule(): void {
  registerParityRule({ stream: 'row', compare: compareRowRecords })
}
registerRowParityRule()
