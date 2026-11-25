/**
 * Registers one vitest `it` per perf case with the suite's reporting contract (T697): a case listed in
 * `KNOWN_OFFENDERS` reports instead of failing and fails the moment it stops violating; `PERF_STRICT=1`
 * ignores the list. Shared by the runners that cannot live in `scale.perf.ts` (they need a `window`, a
 * Pinia store or a jsdom environment of their own).
 */

import { describe, expect, it } from 'vitest'
import { describeResult, measureCase, violations, type PerfCase } from './harness'
import { KNOWN_OFFENDERS, isStrict } from './known-offenders'

export function registerCases(title: string, cases: PerfCase[]): void {
  describe(title, () => {
    for (const c of cases) {
      it(`${c.id}: ${c.describes}`, { timeout: 120_000 }, async () => {
        const result = await measureCase(c)
        const found = violations(result, c.readsBudget)
        const owner = KNOWN_OFFENDERS[c.id]
        const detail = `${describeResult(result)}\n  ${found.join('\n  ') || 'within budget'}`
        if (owner && !isStrict()) {
          if (found.length === 0) {
            throw new Error(
              `${c.id} is within budget now: delete it from KNOWN_OFFENDERS (${owner} fixed it).\n${detail}`
            )
          }
          console.warn(`[perf] known offender (${owner}), not failing:\n${detail}`)
          return
        }
        console.info(`[perf] ${detail}`)
        expect(found, detail).toEqual([])
      })
    }
  })
}
