/**
 * The scale-fixture perf suite (T697, performance contract P1/P4/P8).
 *
 * Runs every case in `cases.ts` against the reference fleet at two sizes and fails when a task is
 * over 50 ms or when cost grows faster than the fixture. Known offenders (`known-offenders.ts`)
 * report instead of failing, and fail the moment they stop violating, so an exemption cannot
 * outlive its fix. `PERF_STRICT=1` turns the exemptions off (that is the red run).
 */

import { afterAll, describe, expect, it } from 'vitest'
import { ALL_CASES, restoreHome } from './cases'
import { describeResult, measureCase, violations } from './support/harness'
import { KNOWN_OFFENDERS, isStrict } from './support/known-offenders'

afterAll(restoreHome)

describe('scale fixture: no job or computed breaks the typing path', () => {
  for (const c of ALL_CASES) {
    it(`${c.id}: ${c.describes}`, { timeout: 60_000 }, async () => {
      const result = await measureCase(c)
      const found = violations(result)
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
