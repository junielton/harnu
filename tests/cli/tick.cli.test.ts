import { describe, expect, it } from 'vitest'
import {
  COMPANION_LOADED,
  WITH_CLI,
  assertCleanLoad,
  assertNotBlockedByAuth,
  runClaude
} from './support/run-claude'

// A scheduler tick runs with `--setting-sources ''`, `--strict-mcp-config` and
// `--no-session-persistence` (scheduler-core.ts tickArgv). Does a mod still load? (Q2)
describe.skipIf(!WITH_CLI)('a tick-shaped run', () => {
  it("a mod loads under --setting-sources ''", async () => {
    const r = await runClaude({ tick: true })
    try {
      assertNotBlockedByAuth(r)
      expect(r.code, r.stderr).toBe(0)
      expect(r.debug).toMatch(COMPANION_LOADED)
      assertCleanLoad(r.debug)
      expect(r.probe, r.stdout).not.toBeNull()
    } finally {
      await r.cleanup()
    }
  })
})
