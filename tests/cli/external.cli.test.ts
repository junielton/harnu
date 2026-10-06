import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createExternalInstall } from '../../src/main/companion/external-install'
import { createExternalBinding } from '../../src/main/companion/external-binding'
import { createCompanionHost } from '../../src/main/companion/host-core'
import type { BindingView } from '../../src/main/companion/session-table'
import { fakeMode, shortTmp } from '../companion/support/host-rig'
import { WITH_CLI, runClaude } from './support/run-claude'
import {
  assertThrowaway,
  claudeVersionOn,
  hasTmux,
  startInteractive,
  type Interactive
} from './support/run-interactive'

// P4W3 L4 and live-verify: a real interactive `claude` (in tmux, hermetic HOME, no credentials)
// against the REAL host. Gated like every real-CLI suite: `HARNU_WITH_CLI=1`. The CLI under test
// comes from `HARNU_CLI_PATH` (a directory holding `claude`) or the PATH. `HARNU_LV_LOG` appends
// one line per recorded fact for the evidence file.

const CLI_PATH = process.env.HARNU_CLI_PATH
  ? `${process.env.HARNU_CLI_PATH}:${process.env.PATH ?? ''}`
  : (process.env.PATH ?? '')
const LOADED = /hooks module harnu-companion@inline loaded/g
// A hook that was skipped or threw; the mod's own `$.fs.read ... ENOENT` (no host) is not one.
const BAD_HOOK = /hook(s module)?\b.*\b(skipped|failed|threw|error)|did not load/i

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

function log(line: string): void {
  if (process.env.HARNU_LV_LOG) appendFileSync(process.env.HARNU_LV_LOG, line + '\n')
}

interface RealHost {
  endpoint: string
  hellos: { kind: string; sid: string; profile: string; cwd: string }[]
  asks: string[]
  views(): BindingView[]
  mintSpawn(): string
  stats(): { helloOk: number; helloRefused: Record<string, number> }
}

/** A real host with the external binding on top of it, in a temp directory. */
async function realHost(over: { corroborates?: (sid: string) => boolean } = {}): Promise<RealHost> {
  const dir = join(shortTmp('hc-x4-'), 'companion')
  const host = createCompanionHost({ dir, mode: fakeMode('shadow').mode, log: () => undefined })
  await host.register()
  const ext = createExternalBinding({
    host: host.facade,
    isOn: () => true,
    mode: () => 'shadow',
    sessionOwnedByHarnu: () => false,
    corroborates: async (sid) => over.corroborates?.(sid) ?? false,
    now: () => performance.now()
  })
  host.facade.setEnablePolicy(
    ext.wrapPolicy((b) => b.declared.filter((f) => f === 'sense.identity'))
  )
  const hellos: RealHost['hellos'] = []
  const asks: string[] = []
  host.facade.bus.on('hello', (b, kind) =>
    hellos.push({ kind, sid: b.sid, profile: b.profile, cwd: b.cwd })
  )
  for (const kind of ['permission', 'status', 'sentinel'] as const) {
    host.facade.registerAskKind(kind, (_b, req, reply) => {
      asks.push(req.kind)
      reply({ ok: true, state: 'released', reason: 'abstain' } as never)
    })
  }
  cleanups.push(async () => {
    ext.dispose()
    await host.close()
    rmSync(join(dir, '..'), { recursive: true, force: true })
  })
  return {
    endpoint: join(dir, 'endpoint.json'),
    hellos,
    asks,
    views: () => host.facade.diagnostics().bindings as unknown as BindingView[],
    mintSpawn: () =>
      host.facade.mintSpawnToken({
        owner: { kind: 'pty', ptyId: 'pty-lv' },
        trust: 'operator',
        cwd: '/tmp/example-project'
      }) as string,
    stats: () => {
      const t = host.facade.diagnostics().totals
      return { helloOk: t.helloOk, helloRefused: t.helloRefused }
    }
  }
}

/** The install shell pointed at one throwaway HOME: every path comes from the run's own context. */
function installFor(
  ctx: { settingsPath: string; work: string; companionDir: string },
  claudePath: string
): ReturnType<typeof createExternalInstall> {
  assertThrowaway(ctx.settingsPath)
  return createExternalInstall({
    settingsPath: () => ctx.settingsPath,
    recordPath: () => join(ctx.work, 'userData', 'external-install.json'),
    managedPaths: () => [],
    ensureStaged: async () => ctx.companionDir,
    ensureProbe: async () => null,
    // The real post-install check, against the real CLI, in the throwaway HOME.
    postInstallCheck: () =>
      new Promise((resolve) => {
        execFile(
          'claude',
          ['plugin', 'list', '--json'],
          {
            cwd: ctx.work,
            timeout: 10_000,
            env: {
              PATH: claudePath,
              HOME: join(ctx.work, 'home'),
              CLAUDE_CONFIG_DIR: join(ctx.work, 'home', '.claude')
            }
          },
          (err, stdout, stderr) =>
            resolve({
              exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
              output: String(stdout) + String(stderr)
            })
        )
      }),
    modVersion: () => 'lv',
    now: () => Date.now()
  })
}

async function session(opts: Parameters<typeof startInteractive>[0]): Promise<Interactive> {
  const s = await startInteractive({ claudePath: CLI_PATH, ...opts })
  cleanups.push(() => s.stop())
  // The settings path of the run, printed before anything reads or writes it (P4W3 safety rule).
  assertThrowaway(s.settingsPath)
  log(`settings path (throwaway): ${s.settingsPath}`)
  return s
}

const tmuxOk = await hasTmux()
const suite = describe.skipIf(!WITH_CLI || !tmuxOk)

suite('an outside session against the real host (P4W3 L4, live-verify)', () => {
  it('LV-P4W3-a (a): a plain terminal loads the mod from the settings env alone and says one external hello', async () => {
    const h = await realHost()
    const s = await session({ rendezvous: h.endpoint, viaSettingsEnv: true })
    await s.waitDebug(/harnu-companion@inline session\.start settled/)
    const deadline = Date.now() + 15_000
    while (h.hellos.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 150))
    const debug = await s.debug()
    const loaded = debug.match(LOADED)?.length ?? 0
    log(`claude --version: ${await claudeVersionOn(CLI_PATH)}`)
    log(
      `LV-a(a): loaded lines=${loaded}, hellos=${JSON.stringify(h.hellos.map((x) => [x.kind, x.profile]))}`
    )
    expect(loaded).toBe(1)
    expect(h.hellos).toHaveLength(1)
    expect(h.hellos[0]).toMatchObject({ kind: 'external', profile: 'external', cwd: s.cwd })
    expect(h.stats().helloRefused).toEqual({})
    // The mod is the external one: no actuator, no gate.approval, nothing but identity enabled.
    const view = h.views().find((v) => v.sid === h.hellos[0].sid)!
    expect(view.enabled).toEqual(['sense.identity'])
  }, 60_000)

  it('LV-P4W3-a (b): a Harnu-spawned session with the flag AND the env key loads one module and says one spawned hello', async () => {
    const h = await realHost()
    const token = h.mintSpawn()
    const s = await session({
      rendezvous: h.endpoint,
      viaSettingsEnv: true,
      viaFlag: true,
      env: { HARNU_SPAWN_TOKEN: token }
    })
    await s.waitDebug(/harnu-companion@inline session\.start settled/)
    const deadline = Date.now() + 15_000
    while (h.hellos.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 150))
    // A second instance would hello a second time within a heartbeat: wait past one.
    await new Promise((r) => setTimeout(r, 3_000))
    const debug = await s.debug()
    const loaded = debug.match(LOADED)?.length ?? 0
    const stats = h.stats()
    log(
      `LV-a(b): loaded lines=${loaded}, hellos=${JSON.stringify(h.hellos.map((x) => [x.kind, x.profile]))}, helloOk=${stats.helloOk}, refused=${JSON.stringify(stats.helloRefused)}`
    )
    expect(loaded).toBe(1)
    expect(h.hellos.map((x) => x.kind)).toEqual(['spawn'])
    expect(stats.helloRefused.UNAUTHORIZED ?? 0).toBe(0)
  }, 60_000)

  it('approvals are not held by default (AC-P4W3-14)', async () => {
    const h = await realHost({ corroborates: () => true })
    const s = await session({ rendezvous: h.endpoint, viaSettingsEnv: true })
    await s.waitDebug(/harnu-companion@inline session\.start settled/)
    const deadline = Date.now() + 15_000
    while (h.hellos.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 150))
    // A prompt attempt without a sign-in is the nearest a hermetic run gets to a turn: the CLI
    // answers at the terminal and no model is reached (so no permission dialog can open here).
    await s.type('write a file called x.txt')
    await s.press('Enter')
    await new Promise((r) => setTimeout(r, 3_000))
    const view = h.views().find((v) => v.sid === h.hellos[0]?.sid)
    log(`AC-14: asks=${h.asks.length}, enabled=${JSON.stringify(view?.enabled)}`)
    expect(h.asks).toEqual([]) // no `ask` request of any kind reached the host
    expect(view?.enabled ?? []).not.toContain('gate.approval')
  }, 60_000)

  it('Harnu absent is a no-op (AC-P4W3-15)', async () => {
    // The switch is on and Harnu is not running: the rendezvous file does not exist.
    const s = await session({
      rendezvous: join(mkdtempSync(join(tmpdir(), 'harnu-absent-')), 'endpoint.json'),
      viaSettingsEnv: true
    })
    await s.waitDebug(/harnu-companion@inline session\.start settled/)
    await s.type('hello there')
    await s.press('Enter')
    await new Promise((r) => setTimeout(r, 3_000))
    const debug = await s.debug()
    const ours = debug
      .split('\n')
      .filter((l) => /harnu-companion/.test(l) && !/\$\.fs\.read/.test(l))
    const bad = ours.filter((l) => BAD_HOOK.test(l))
    log(`AC-15: harnu-companion debug lines=${ours.length}, skipped-or-failed=${bad.length}`)
    expect(bad).toEqual([])
    expect(ours.some((l) => /session\.start settled/.test(l))).toBe(true)
    // The session is alive and usable: the prompt box is still on screen.
    expect(await s.pane()).toMatch(/❯/)
  }, 60_000)

  it('LV-P4W3-c: on then off restores the settings, and a new outside session says nothing', async () => {
    const h = await realHost()
    // The settings the "operator" had before: other keys, the CLI's own formatting.
    const before =
      JSON.stringify(
        { permissions: { allow: ['Read'] }, cleanupPeriodDays: 30, tui: 'fullscreen' },
        null,
        2
      ) + '\n'
    let pre = ''
    let claudeOnPath = CLI_PATH
    const s1 = await session({
      rendezvous: h.endpoint,
      settings: JSON.parse(before),
      prepare: async (ctx) => {
        assertThrowaway(ctx.settingsPath)
        writeFileSync(ctx.settingsPath, before)
        pre = readFileSync(ctx.settingsPath, 'utf8')
        const install = installFor(ctx, claudeOnPath)
        log(`LV-c: before ${JSON.stringify(JSON.parse(pre))}`)
        expect(await install.install()).toEqual({ ok: true, installed: true })
        const after = readFileSync(ctx.settingsPath, 'utf8')
        log(`LV-c: on    ${JSON.stringify(JSON.parse(after))}`)
        expect(JSON.parse(after).env.CLAUDE_CODE_PLUGIN_DIRS).toBe(ctx.companionDir)
      }
    })
    // On: a plain terminal session loads the mod and says an external hello.
    await s1.waitDebug(/harnu-companion@inline session\.start settled/)
    const t0 = Date.now()
    while (h.hellos.length === 0 && Date.now() - t0 < 15_000)
      await new Promise((r) => setTimeout(r, 150))
    expect(h.hellos.map((x) => x.kind)).toEqual(['external'])
    await s1.stop({ keep: true })

    // Off: the exact undo.
    const install = installFor(s1, claudeOnPath)
    expect(await install.uninstall()).toEqual({ ok: true, installed: false })
    const restored = readFileSync(s1.settingsPath, 'utf8')
    log(`LV-c: off   ${JSON.stringify(JSON.parse(restored))}`)
    expect(JSON.parse(restored)).toEqual(JSON.parse(pre))
    expect(restored).toBe(pre) // byte-equal for a CLI-formatted file
    cleanups.push(async () => {
      const { rm } = await import('node:fs/promises')
      await rm(s1.work, { recursive: true, force: true })
    })

    // A new outside session after the undo: no mod, no hello.
    const before2 = h.hellos.length
    const s2 = await startInteractive({
      claudePath: claudeOnPath,
      rendezvous: h.endpoint,
      reuseWork: s1.work
    })
    cleanups.push(() => s2.stop({ keep: true }))
    await s2.waitPane(/❯/)
    await new Promise((r) => setTimeout(r, 2_500))
    const debug = await s2.debug()
    log(
      `LV-c: second session: harnu-companion lines=${debug.split('\n').filter((l) => /harnu-companion/.test(l)).length}, new hellos=${h.hellos.length - before2}`
    )
    expect(debug).not.toMatch(/harnu-companion/)
    expect(h.hellos.length).toBe(before2)
    claudeOnPath = ''
  }, 90_000)

  it('probes stay silent (AC-P4W3-16)', async () => {
    // Harnu's own `claude -p` probes (usage, the policy probe, the post-install check) run with the
    // settings env key active and no spawn token: the mod is dormant, so no hello reaches the host.
    const h = await realHost()
    const timed = async (withEnv: boolean): Promise<number> => {
      const t0 = performance.now()
      const r = await runClaude({
        order: ['probe'],
        rendezvous: h.endpoint,
        env: { PATH: CLI_PATH },
        prepare: async ({ work, configDir }) => {
          if (!withEnv) return
          const settings = join(configDir, 'settings.json')
          assertThrowaway(settings)
          mkdirSync(configDir, { recursive: true })
          writeFileSync(
            settings,
            JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: join(work, 'harnu-companion') } })
          )
        }
      })
      cleanups.push(() => r.cleanup())
      const ms = performance.now() - t0
      if (withEnv) {
        expect(r.debug).toMatch(/harnu-companion@inline loaded/) // the env key really loaded it
      }
      return ms
    }
    const median = (xs: number[]): number =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    const base: number[] = []
    const withKey: number[] = []
    for (let i = 0; i < 3; i++) {
      base.push(await timed(false))
      withKey.push(await timed(true))
    }
    const b = median(base)
    const w = median(withKey)
    log(
      `AC-16: baseline median=${Math.round(b)}ms, with key median=${Math.round(w)}ms, hellos=${h.hellos.length}`
    )
    expect(h.hellos).toEqual([])
    expect(h.stats().helloOk).toBe(0)
    expect(h.stats().helloRefused).toEqual({})
    // Within 10% of the baseline, with 250 ms of slack for scheduler noise on a short run.
    expect(w).toBeLessThanOrEqual(Math.max(b * 1.1, b + 250))
  }, 120_000)
})
