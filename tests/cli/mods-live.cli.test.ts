import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import surface from '../../resources/companion/api-surface.json'
import { prefsKey } from '../../src/main/companion/companion-prefs'
import { WITH_CLI, claudeVersion } from './support/run-claude'
import {
  admissionOrder,
  claudeCli,
  debugLines,
  hermeticEnv,
  provenanceKind,
  startLiveSession,
  startModsHost,
  stageWorld,
  stripSenseMods,
  writeMod,
  type LiveSession,
  type ModsHost,
  type World
} from './support/live-session'

// P4W1 part B against a real `claude` (2.1.290 is the tested ceiling; the run records which one it
// was): AC-P4W1-16 (the reload cost of the `plugin.register` hook, contract CQ21) and AC-P4W1-20
// (the load order by provenance, master Q3). Hermetic, zero model turns, gated by
// `HARNU_WITH_CLI=1` like every real-CLI suite. With `HARNU_EVIDENCE_DIR` set, each test writes
// its measurement there as JSON (the committed copies live under
// `docs/specs/T389-companion-mod/evidence/`).

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function evidence(name: string, data: unknown): void {
  const text = `${JSON.stringify(data, null, 2)}\n`
  console.info(`[P4W1 evidence] ${name} ${JSON.stringify(data)}`)
  const dir = process.env.HARNU_EVIDENCE_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), text)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface World3 {
  world: World
  host: ModsHost
  session: LiveSession
  mods: { a: { dir: string; source: string }; b: { dir: string; source: string } }
}

/** The companion first, then two plain mods, a real host with `modsLive` on, one live session. */
async function startWorld(variant: 'with-hook' | 'without-hook'): Promise<World3> {
  const host = await startModsHost()
  cleanups.push(() => host.close())
  const world = await stageWorld({
    rendezvous: host.endpoint,
    transform: variant === 'without-hook' ? stripSenseMods : undefined
  })
  cleanups.push(() => world.cleanup())
  const a = await writeMod(join(world.work, 'mods', 'live-a'), 'live-a')
  const b = await writeMod(join(world.work, 'mods', 'live-b'), 'live-b')
  const session = startLiveSession(world, {
    pluginDirs: [world.companionDir, a.dir, b.dir],
    env: { HARNU_SPAWN_TOKEN: host.mint() }
  })
  cleanups.push(() => session.stop())
  return { world, host, session, mods: { a, b } }
}

/** What one save of the second mod caused, read from the CLI's debug file and the host. */
async function measureSave(w: World3): Promise<Record<string, unknown>> {
  const r0 = await w.session.send('/ping-live-a')
  expect(r0.total_cost_usd ?? 0).toBe(0)
  expect(r0.num_turns ?? 0).toBe(0)
  const sid = w.host.seen.hellos[0]?.sid
  const hellosBefore = w.host.seen.hellos.length
  const admittedBefore = w.host.seen.events.filter((e) => e.t === 'mod.admitted').length

  const t0 = Date.now()
  appendFileSync(w.mods.b.source, '\n// saved by the P4W1 reload-cost test\n')
  // wait for the reload, then for a quiet period: the burst is over when nothing new shows up
  await w.session.waitDebug(
    (d) =>
      debugLines(d).some((l) => l.at >= t0 && /hooks module \S*live-b\S* reloaded in/.test(l.text)),
    20_000
  )
  let last = 0
  let quietSince = Date.now()
  while (Date.now() - quietSince < 2_500 && Date.now() - t0 < 25_000) {
    const n = debugLines(await w.session.debug()).filter(
      (l) =>
        l.at >= t0 && /reloaded in|session\.start settled|plugin\.register:|loaded \(/.test(l.text)
    ).length
    if (n !== last) {
      last = n
      quietSince = Date.now()
    }
    await sleep(250)
  }
  const after = debugLines(await w.session.debug()).filter((l) => l.at >= t0)
  const reloaded = after
    .map((l) => /^hooks module (\S+) reloaded in ([\d.]+)ms/.exec(l.text))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m, i) => ({
      module: m[1]!,
      ms: Number(m[2]),
      atMs: after.filter((l) => /reloaded in/.test(l.text))[i]!.at - t0
    }))
  const sessionStarts = after.filter((l) => /session\.start settled/.test(l.text))
  const freshLoads = after.filter((l) => /^hooks module \S+ loaded \(/.test(l.text))
  const burst = after.filter((l) =>
    /reloaded in|session\.start settled|\$\.ui\.log: reloaded/.test(l.text)
  )
  const hellos = w.host.seen.hellos.slice(hellosBefore).filter((h) => h.sid === sid)
  const readmitted =
    w.host.seen.events.filter((e) => e.t === 'mod.admitted').length - admittedBefore

  const r1 = await w.session.send('/ping-live-b')
  expect(r1.total_cost_usd ?? 0).toBe(0)
  expect(r1.result ?? '').toContain('pong-live-b') // the saved mod runs after the reload

  return {
    reloaded,
    sessionStartRefires: sessionStarts.length,
    sessionStartModules: sessionStarts.map((l) =>
      l.text.replace(/^hooks module (.*) session\.start settled.*$/, '$1')
    ),
    freshLoadsAfterSave: freshLoads.length,
    companionReloaded: reloaded.some((r) => /harnu-companion/.test(r.module)),
    companionRehellos: hellos.length,
    modAdmittedAfterSave: readmitted,
    saveToFirstReloadMs: reloaded.length ? Math.min(...reloaded.map((r) => r.atMs)) : null,
    saveToSettledMs: burst.length ? Math.max(...burst.map((l) => l.at)) - t0 : null
  }
}

describe.skipIf(!WITH_CLI)('P4W1 part B against a real claude', () => {
  it('reload cost of a plugin.register hook', async () => {
    const results: Record<string, Record<string, unknown>> = {}
    for (const variant of ['with-hook', 'without-hook'] as const) {
      const w = await startWorld(variant)
      results[variant] = await measureSave(w)
      for (const c of cleanups.splice(0).reverse()) await c() // this variant's session, host, world
    }
    const withHook = results['with-hook']!
    const without = results['without-hook']!
    // the reload happened at all, and cost the host at most what is recorded
    expect((withHook.reloaded as unknown[]).length).toBeGreaterThan(0)
    expect((without.reloaded as unknown[]).length).toBeGreaterThan(0)
    const rehellos = withHook.companionRehellos as number
    evidence('P4W1B-reload-cost.json', {
      claude: await claudeVersion(),
      testedCeiling: surface.lastVerifiedCli,
      question: 'CQ21: a mod saved while the companion hooks plugin.register',
      saved:
        'the second of two plain user mods, in a headless session that watches --plugin-dir folders',
      results,
      companionRehellosPerSave: rehellos,
      // the spec's rule (P4W1 §7.6): it stays off if the companion re-hellos more than once per save
      specRuleKeepsItOff: rehellos > 1,
      // this suite never turns the key on for a user: it ships `false`, and a flip is its own change
      shippedDefault: prefsKey<boolean>('modsLive')
    })
    // the key is not turned on by this suite or by any measurement: it ships off
    expect(prefsKey<boolean>('modsLive')).toBe(false)
  }, 180_000)

  it('records the load order by provenance', async () => {
    const host = await startModsHost()
    cleanups.push(() => host.close())
    const world = await stageWorld({ rendezvous: host.endpoint })
    cleanups.push(() => world.cleanup())
    const env = hermeticEnv(world.home)
    // one `--plugin-dir` mod, one `skills-dir` mod, one installed (a local marketplace)
    const inline = await writeMod(join(world.work, 'mods', 'live-inline'), 'live-inline')
    await writeMod(join(world.home, '.claude', 'skills', 'live-skills'), 'live-skills')
    const mkt = join(world.work, 'mkt')
    await writeMod(join(mkt, 'plugins', 'live-installed'), 'live-installed')
    mkdirSync(join(mkt, '.claude-plugin'), { recursive: true })
    writeFileSync(
      join(mkt, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'live-mkt',
        owner: { name: 'test' },
        plugins: [
          { name: 'live-installed', source: './plugins/live-installed', description: 'test' }
        ]
      })
    )
    const add = await claudeCli(['plugin', 'marketplace', 'add', mkt], env, world.cwd)
    expect(add.code, add.stdout + add.stderr).toBe(0)
    const install = await claudeCli(
      ['plugin', 'install', 'live-installed@live-mkt'],
      env,
      world.cwd
    )
    expect(install.code, install.stdout + install.stderr).toBe(0)

    const session = startLiveSession(world, {
      pluginDirs: [world.companionDir, inline.dir],
      env: { HARNU_SPAWN_TOKEN: host.mint() }
    })
    cleanups.push(() => session.stop())
    const r = await session.send('/ping-live-inline')
    expect(r.total_cost_usd ?? 0).toBe(0)
    // the three mods the companion can see were reported after the hello
    const until = Date.now() + 8_000
    while (
      host.seen.events.filter((e) => e.t === 'mod.admitted').length < 3 &&
      Date.now() < until
    ) {
      await sleep(200)
    }
    const sid = host.seen.hellos[0]?.sid
    expect(sid, 'the companion said hello').toBeDefined()
    const companionSaw = host.observed.loadOrder(sid!).map((m) => ({
      order: m.order,
      name: m.name,
      tier: m.tier,
      provenance: m.provenance,
      kind: provenanceKind(m.provenance)
    }))
    const cliOrder = admissionOrder(await session.debug()).map((m) => ({
      ...m,
      kind: provenanceKind(m.provenance)
    }))
    const companionAt = cliOrder.findIndex((m) => m.name === 'harnu-companion')
    const admittedAfter = cliOrder
      .slice(companionAt + 1)
      .filter((m) => m.name !== 'harnu-companion')
    const admittedBefore = cliOrder.slice(0, companionAt)

    evidence('P4W1B-load-order.json', {
      claude: await claudeVersion(),
      testedCeiling: surface.lastVerifiedCli,
      loadedWith: {
        order:
          '--plugin-dir companion, --plugin-dir inline mod; plus a user-scope installed mod and a skills-dir mod',
        companionFirstAmongPluginDirs: true
      },
      // what the CLI itself logged, every module in the order its `plugin.register` judged it
      cliDebugOrder: cliOrder,
      // what the companion's hook reported, in the order the host received it
      companionSaw,
      // modules admitted before the companion: invisible to its hook, by construction
      admittedBeforeTheCompanion: admittedBefore.map((m) => m.provenance),
      kindsInOrder: [...new Set(admittedAfter.map((m) => m.kind))]
    })

    // the companion reported the three kinds of mod, and in the order the CLI admitted them
    const kinds = new Set(companionSaw.map((m) => m.kind))
    expect([...kinds].sort()).toEqual(expect.arrayContaining(['inline', 'installed', 'skills-dir']))
    expect(companionSaw.map((m) => m.provenance)).toEqual(
      admittedAfter.filter((m) => m.tier !== 'builtin').map((m) => m.provenance)
    )
  }, 120_000)
})
