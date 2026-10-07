import { describe, expect, it } from 'vitest'
import {
  COMPANION_LOADED,
  WITH_CLI,
  assertCleanLoad,
  assertNotBlockedByAuth,
  runClaude
} from './support/run-claude'

// Real `claude` against the skeleton, hermetic (temp HOME, config dir, cwd), zero model turns.
// Gated: `HARNU_WITH_CLI=1` (local-pipeline.sh --with-cli sets it).
describe.skipIf(!WITH_CLI)('the companion loads in a real claude', () => {
  it('skeleton loads, zero model calls', async () => {
    const r = await runClaude()
    try {
      assertNotBlockedByAuth(r)
      expect(r.code, r.stderr).toBe(0)
      expect(r.debug).toMatch(COMPANION_LOADED)
      assertCleanLoad(r.debug)
      expect(r.debug).not.toMatch(/hook skipped/i)
      // the zero-model driver answered, and the run made no model request
      expect(r.probe, r.stdout).not.toBeNull()
      expect(r.json?.num_turns).toBe(0)
      expect(r.json?.total_cost_usd).toBe(0)
      // the token is read from env by a mod: with nothing minted it is simply absent
      expect(r.probe?.tokenReadable).toBe(false)
    } finally {
      await r.cleanup()
    }
  })

  it('the first plugin dir loads first', async () => {
    const first = await runClaude({ order: ['companion', 'probe'] })
    const swapped = await runClaude({ order: ['probe', 'companion'] })
    try {
      assertNotBlockedByAuth(first)
      assertNotBlockedByAuth(swapped)
      // The probe's plugin.register hook sees only the modules admitted after it.
      expect(first.probe?.pluginsRegisteredAfterProbe).not.toContain('harnu-companion')
      expect(swapped.probe?.pluginsRegisteredAfterProbe).toContain('harnu-companion')
      assertCleanLoad(first.debug)
      assertCleanLoad(swapped.debug)
    } finally {
      await first.cleanup()
      await swapped.cleanup()
    }
  })

  it('a spawn token in the environment is readable by a mod, and only by name', async () => {
    const r = await runClaude({ env: { HARNU_SPAWN_TOKEN: 'sp_test_not_a_secret' } })
    try {
      assertNotBlockedByAuth(r)
      expect(r.probe?.tokenReadable).toBe(true)
      // the probe reports presence only: the token is never printed
      expect(r.stdout).not.toContain('sp_test_not_a_secret')
      expect(r.debug).not.toContain('sp_test_not_a_secret')
    } finally {
      await r.cleanup()
    }
  })
})
