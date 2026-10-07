/**
 * The `identity` parity rule (T389 P1W4 §7.5), hosted here; its flip gate is P1W3 §13's
 * (per-shape minimums, bind rate, latency) and is not defined in this file. Pure.
 *
 * Input: one ledger row per Harnu-spawned session, built from P1W3's `IdentityParityRecord`
 * (`k` is `bind:<verdict>`, `d.verdict` repeats it). A second row for one session is unexplained,
 * and so is a `mismatch`: it is explained only by transcript evidence the rule does not have.
 */

import { registerParityRule, type Divergence, type ParityRecord } from './parity-core'

const verdictOf = (r: ParityRecord): string =>
  typeof r.d?.verdict === 'string' ? r.d.verdict : r.k.replace(/^bind:/, '')

/** The explained classes: named so a report can say how the facts divide. */
const EXPLAINED: Record<string, string> = {
  conflict: 'conflict', // the sid is live under another row: the companion made no claim
  'companion-only': 'legacy-unbound', // the legacy binders never ran or bound nothing
  'legacy-only': 'no-hello' // the mod never reached the host (policy, old CLI, off)
}

export function compareIdentityRows(rows: ParityRecord[]): Divergence[] {
  const out: Divergence[] = []
  const [first, ...rest] = rows
  if (!first) return out
  for (const dup of rest) {
    out.push({
      sk: dup.sk,
      at: dup.t,
      legacy: first.k,
      companion: dup.k,
      class: null
    })
  }
  const verdict = verdictOf(first)
  if (verdict === 'match') return out
  out.push({
    sk: first.sk,
    at: first.t,
    legacy: typeof first.d?.via === 'string' ? first.d.via : null,
    companion: first.k,
    class: EXPLAINED[verdict] ?? null // `mismatch` and anything unknown: unexplained
  })
  return out
}

export function registerIdentityParityRule(): void {
  registerParityRule({ stream: 'identity', compare: compareIdentityRows })
}
registerIdentityParityRule()
