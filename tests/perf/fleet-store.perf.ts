/**
 * The renderer computeds that read the fleet, against one session event (BUG-265).
 *
 * Same contract and same reporting as `scale.perf.ts` (a case may be listed in `KNOWN_OFFENDERS`, and
 * `PERF_STRICT=1` ignores that list). Kept in its own file because it builds the real sessions store,
 * which needs a `window` stub; the pure cases do not.
 */

import { describe, expect, it } from 'vitest'
import { STORE_CASES } from './store-cases'
import { describeResult, measureCase, violations } from './support/harness'
import { KNOWN_OFFENDERS, isStrict } from './support/known-offenders'

describe('fleet store: one session event does not re-read the fleet', () => {
  for (const c of STORE_CASES) {
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
      expect(found, detail).toEqual([])
    })
  }
})
