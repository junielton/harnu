import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import surface from '../../resources/companion/api-surface.json'
import { claudeVersionSync, resolveClaudeVersion } from '../../src/main/claude-cli'
import { buildCompanionStatus } from '../../src/main/companion/companion-status'
import {
  rolloutView,
  setCompanionCliGate,
  setCompanionPrefsPath
} from '../../src/main/companion/companion-prefs'
import { createEnablePolicy } from '../../src/main/companion/feature-policy'
import { createCompanionHost } from '../../src/main/companion/host-core'
import {
  getCompanionMode,
  hydrateCompanionMode,
  listenerWanted,
  onModeChange
} from '../../src/main/companion/mode'
import { createSessionArbiter } from '../../src/main/companion/session-arbiter'
import { cliGate } from '../../src/main/companion/version-gate'
import { shortTmp } from '../companion/support/host-rig'
import {
  WITH_CLI,
  assertCleanLoad,
  assertNotBlockedByAuth,
  runClaude,
  type RunOptions,
  type RunResult
} from './support/run-claude'

// P1W4 L4: a real `claude` with the mod, against the real host, the real enable policy, the real
// arbiter and the real status assembly. Gated like every real-CLI suite (`HARNU_WITH_CLI=1`).

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
  setCompanionPrefsPath(null)
})

async function run(opts: RunOptions): Promise<RunResult> {
  const r = await runClaude(opts)
  cleanups.push(() => r.cleanup())
  assertNotBlockedByAuth(r)
  return r
}

describe.skipIf(!WITH_CLI)('Harnu mod state against a real claude (L4)', () => {
  it('live after hello', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'hc-cs-'))
    cleanups.push(() => rmSync(userData, { recursive: true, force: true }))
    setCompanionPrefsPath(join(userData, 'companion-prefs.json'))
    // The kill switch is on (the default) and the disclosure was shown: the injection decision.
    await hydrateCompanionMode()
    await resolveClaudeVersion()
    setCompanionCliGate(cliGate(claudeVersionSync(), surface.lastVerifiedCli))
    expect(getCompanionMode()).not.toBe('off')

    const dir = join(shortTmp('hc-cs-'), 'companion')
    const owner = { kind: 'pty', ptyId: 'pty-1' } as const
    const host = createCompanionHost({
      dir,
      mode: {
        getMode: getCompanionMode,
        listenerWanted,
        hydrate: hydrateCompanionMode,
        onChange: onModeChange,
        enabled: () => rolloutView().enabled
      },
      log: () => undefined,
      sessionKeyOf: (o) => (o.kind === 'pty' ? `row:${o.ptyId}` : null)
    })
    cleanups.push(async () => {
      await host.close()
      rmSync(join(dir, '..'), { recursive: true, force: true })
    })
    await host.register()
    host.facade.setEnablePolicy(
      createEnablePolicy({ rollout: rolloutView, ceiling: surface.lastVerifiedCli })
    )
    const arbiter = createSessionArbiter({ host: host.facade, rollout: rolloutView })
    arbiter.recordInjectDecision(owner, { inject: true })

    const statusNow = () =>
      buildCompanionStatus({
        enabled: () => rolloutView().enabled,
        disclosureShownAt: () => 1,
        stagedDir: () => null,
        modVersion: () => '0.1.0',
        rollout: rolloutView,
        arbiter,
        host: host.facade,
        sessionKeyOf: (o) => (o.kind === 'pty' ? `row:${o.ptyId}` : null),
        kindOf: () => 'claude-new',
        now: () => Date.now(),
        probe: () => null,
        requestProbe: () => undefined,
        refusalTexts: []
      })

    // Read the status the moment the hello lands, and again when the next event arrives: the
    // probe session exits at once, so this is the window in which the line is on screen.
    const observed: { at: string; ms: number; state: unknown }[] = []
    let helloAt = 0
    host.facade.bus.on('hello', () => {
      helloAt = Date.now()
      observed.push({ at: 'hello', ms: 0, state: statusNow().sessions['row:pty-1']?.state })
    })
    host.facade.bus.on('event', () => {
      observed.push({
        at: 'event',
        ms: Date.now() - helloAt,
        state: statusNow().sessions['row:pty-1']?.state
      })
    })

    const token = host.facade.mintSpawnToken({
      owner,
      trust: 'operator',
      cwd: '/tmp/example-project'
    })
    expect(token).not.toBeNull()
    arbiter.noteMinted(owner)
    const r = await run({
      env: { HARNU_SPAWN_TOKEN: token!, HARNU_PROBE_OUT: join(userData, 'notes.json') },
      rendezvous: join(dir, 'endpoint.json')
    })
    expect(r.code, r.stderr).toBe(0)
    assertCleanLoad(r.debug)

    expect(observed[0], JSON.stringify(observed)).toMatchObject({
      at: 'hello',
      state: { state: 'live' }
    })
    for (const o of observed) {
      if (o.state !== null) expect(o.ms).toBeLessThan(2_000)
    }
    arbiter.dispose()
  })
})
