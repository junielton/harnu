import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import surface from '../../resources/companion/api-surface.json'
import type { RolloutView } from '../../src/main/companion/arbitration-core'
import type { WireEvent } from '../../src/main/companion/contract'
import { createCompanionHost } from '../../src/main/companion/host-core'
import { createTelemetryAdapter } from '../../src/main/companion/ingest/telemetry-adapter'
import { createSessionArbiter } from '../../src/main/companion/session-arbiter'
import { createTelemetryStore } from '../../src/main/telemetry-store'
import { fakeMode, shortTmp } from '../companion/support/host-rig'
import {
  WITH_CLI,
  assertCleanLoad,
  assertNotBlockedByAuth,
  runClaude,
  type RunOptions,
  type RunResult
} from './support/run-claude'

// P1W6 L4: a real `claude` against the REAL host, the real arbiter and the real telemetry store.
// Gated like every real-CLI suite by `HARNU_WITH_CLI=1`. The turn test spends tokens, so it also
// needs `HARNU_CLI_LIVE=1` (QA-8): haiku, one prompt, `--max-turns 1`, a 0.03 USD cap.

const LIVE = Boolean(process.env.HARNU_CLI_LIVE)
const CAP_USD = 0.03

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

const ROLLOUT: RolloutView = {
  enabled: true,
  cliGate: 'ok',
  families: { telemetry: 'active', planUsage: 'active' },
  allFolders: true,
  rampFolders: new Set()
}

async function realHost() {
  const dir = join(shortTmp('hc-us-'), 'companion')
  const host = createCompanionHost({
    dir,
    mode: fakeMode('active').mode,
    log: () => undefined,
    sessionKeyOf: (o) => (o.kind === 'pty' ? `row:${o.ptyId}` : null)
  })
  await host.register()
  host.facade.setEnablePolicy((b) =>
    b.declared.filter((f) => f === 'sense.identity' || f === 'sense.usage')
  )
  const arbiter = createSessionArbiter({ host: host.facade, rollout: () => ROLLOUT })
  const store = createTelemetryStore({
    now: () => Date.now(),
    captureFleet: () => undefined,
    cachePath: () => null,
    send: () => undefined
  })
  const adapter = createTelemetryAdapter({
    host: host.facade,
    owns: (sid, family) => arbiter.owns(sid, family),
    onOwnershipChange: (fn) => arbiter.onOwnershipChange(fn),
    onModeChange: () => () => undefined,
    store
  })
  const events: { t: string; d: Record<string, unknown> }[] = []
  /** What the store served for the session right after each usage event (the adapter ran first). */
  const served: (number | null)[] = []
  host.facade.bus.on('event', (_b, ev: WireEvent) => {
    events.push({ t: ev.t, d: ev.d as Record<string, unknown> })
    if (ev.t === 'usage.measured') {
      served.push(store.getTelemetryPayload().perSession[0]?.costUsd ?? null)
    }
  })
  cleanups.push(async () => {
    adapter.dispose()
    arbiter.dispose()
    await host.close()
    rmSync(join(dir, '..'), { recursive: true, force: true })
  })
  return {
    host,
    store,
    events,
    served,
    endpoint: join(dir, 'endpoint.json'),
    usage: () => events.filter((e) => e.t === 'usage.measured'),
    mint: () =>
      host.facade.mintSpawnToken({
        owner: { kind: 'pty', ptyId: 'pty-1' },
        trust: 'operator',
        cwd: '/tmp/example-project'
      })!
  }
}

async function run(opts: RunOptions): Promise<RunResult> {
  const r = await runClaude(opts)
  cleanups.push(() => r.cleanup())
  assertNotBlockedByAuth(r)
  return r
}

describe.skipIf(!WITH_CLI)('usage against the real host (L4)', () => {
  it('a zero-model run reads the session once and proves sense.usage', async () => {
    const h = await realHost()
    const r = await run({ env: { HARNU_SPAWN_TOKEN: h.mint() }, rendezvous: h.endpoint })
    expect(r.code, r.stderr).toBe(0)
    assertCleanLoad(r.debug)
    const binding = h.host.facade.bindingForSid(r.probe!.sessionId)
    expect(binding?.declared).toContain('sense.usage')
    expect(binding?.enabled).toContain('sense.usage')
    const reads = h.usage().filter((e) => e.d.source === 'read')
    console.info(
      `[P1W6 evidence] ${JSON.stringify({
        claude: r.claudeVersion,
        zeroModel: true,
        reads: reads.length,
        events: h.usage().map((e) => e.d),
        sessionModel: reads[0]?.d.model ?? null,
        provenAfterRun: binding?.proven
      })}`
    )
    expect(reads.length).toBeGreaterThanOrEqual(1)
    expect(typeof reads[0]!.d.startedAt).toBe('number')
    // nothing but figures leaves the mod
    expect(JSON.stringify(h.usage())).not.toMatch(/sp_[0-9a-f-]{20,}|"prompt"|"text"|breakdown/i)
    expect(surface.hooks).toContain('session.measure')
  })

  describe.skipIf(!LIVE)('with one real model turn (HARNU_CLI_LIVE=1)', () => {
    it('measure equals the CLI total', async () => {
      const h = await realHost()
      const home = mkdtempSync(join(tmpdir(), 'hc-cred-'))
      cleanups.push(() => rmSync(home, { recursive: true, force: true }))
      const r = await run({
        env: { HARNU_SPAWN_TOKEN: h.mint() },
        rendezvous: h.endpoint,
        extraArgs: ['--model', 'haiku', '--max-turns', '1'],
        prompt: 'Reply with the single word: ok',
        timeoutMs: 90_000,
        // The live run needs a signed-in CLI. The throwaway HOME gets a 0600 file holding ONLY the
        // account's OAuth block, for this run only; it is deleted with the HOME. A token close to
        // expiry is refused: the copy would refresh it and rotate the refresh token under the
        // original.
        async prepare({ configDir }) {
          mkdirSync(configDir, { recursive: true })
          const all = JSON.parse(
            readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8')
          )
          const oauth = all?.claudeAiOauth
          if (!oauth || !(oauth.expiresAt > Date.now() + 30 * 60_000)) {
            throw new Error('the OAuth token expires within 30 minutes: sign in again, then re-run')
          }
          writeFileSync(
            join(configDir, '.credentials.json'),
            JSON.stringify({ claudeAiOauth: oauth }),
            { mode: 0o600 }
          )
        }
      })
      expect(r.code, r.stderr).toBe(0)
      assertCleanLoad(r.debug)
      const total = r.json?.total_cost_usd
      expect(typeof total, r.stdout).toBe('number')
      expect(total as number).toBeLessThanOrEqual(CAP_USD)
      const measures = h.usage()
      const last = [...measures].reverse().find((e) => typeof e.d.costUsd === 'number')
      console.info(
        `[P1W6 evidence] ${JSON.stringify({
          claude: r.claudeVersion,
          resultTotalCostUsd: total,
          events: measures.length,
          sources: measures.map((e) => e.d.source),
          lastCostUsd: last?.d.costUsd ?? null,
          sessionModel: measures.find((e) => e.d.source === 'read')?.d.model ?? null
        })}`
      )
      expect(last, 'the host received a usage.measured with a cost').toBeDefined()
      expect(last!.d.costUsd).toBeCloseTo(total as number, 6)
      // and the store served the same figure while the session was live (its end drops the part)
      expect(h.served.at(-1)).toBeCloseTo(total as number, 6)
    })
  })
})
