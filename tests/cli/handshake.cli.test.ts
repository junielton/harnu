import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import surface from '../../resources/companion/api-surface.json'
import type { WireEvent } from '../../src/main/companion/contract'
import { identityEnablePolicy } from '../../src/main/companion/enable-policy'
import { createIdentityAdapter } from '../../src/main/companion/identity-adapter'
import type { IdentityClaim } from '../../src/main/companion/identity-core'
import { createCompanionHost } from '../../src/main/companion/host-core'
import type { BindingView } from '../../src/main/companion/session-table'
import { fakeMode, shortTmp } from '../companion/support/host-rig'
import { startFakeHost, type FakeHost, type FakeScript } from './support/fake-host'
import {
  WITH_CLI,
  assertCleanLoad,
  assertNotBlockedByAuth,
  runClaude,
  type RunOptions,
  type RunResult
} from './support/run-claude'

// P1W3 L4: a real `claude` against the REAL host server (no stand-in), hermetic, zero model turns.
// Gated like every real-CLI suite: `HARNU_WITH_CLI=1` (local-pipeline.sh --with-cli sets it).

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

/** A real companion host in a temp directory, the first policy and an identity adapter on it. */
async function realHost() {
  const dir = join(shortTmp('hc-hs-'), 'companion')
  const m = fakeMode('shadow')
  const host = createCompanionHost({
    dir,
    mode: m.mode,
    log: () => undefined,
    sessionKeyOf: (o) => (o.kind === 'pty' ? `row:${o.ptyId}` : null)
  })
  await host.register()
  host.facade.setEnablePolicy(
    identityEnablePolicy({ getMode: () => 'shadow', ceiling: surface.lastVerifiedCli })
  )
  const pushes: IdentityClaim[][] = []
  const adapter = createIdentityAdapter({
    host: host.facade,
    getMode: () => 'shadow',
    gateOf: () => 'ok',
    push: (c) => void pushes.push(c)
  })
  const seen = {
    events: [] as { t: string; d: unknown; atMs: number; view: BindingView }[],
    hellos: [] as { kind: string; sid: string; atMs: number }[],
    helloEnv: [] as { sid: string }[]
  }
  const t0 = Date.now()
  host.facade.bus.on('event', (view, ev: WireEvent) =>
    seen.events.push({ t: ev.t, d: ev.d, atMs: Date.now() - t0, view })
  )
  host.facade.bus.on('hello', (b, kind) =>
    seen.hellos.push({ kind, sid: b.sid, atMs: Date.now() - t0 })
  )
  const notes = join(mkdtempSync(join(tmpdir(), 'hc-notes-')), 'probe-notes.json')
  cleanups.push(async () => {
    await host.close()
    rmSync(join(dir, '..'), { recursive: true, force: true })
    rmSync(join(notes, '..'), { recursive: true, force: true })
  })
  return {
    host,
    dir,
    adapter,
    pushes,
    seen,
    notes,
    endpoint: join(dir, 'endpoint.json'),
    mint(owner: 'pty' | 'tick' = 'pty', id = 'pty-1') {
      const token =
        owner === 'pty'
          ? host.facade.mintSpawnToken({
              owner: { kind: 'pty', ptyId: id },
              trust: 'operator',
              cwd: '/tmp/example-project'
            })
          : host.facade.mintSpawnToken({
              owner: { kind: 'tick', workerId: 'w-hs', runId: id },
              trust: 'tick',
              cwd: '/tmp/example-project'
            })
      if (!token) throw new Error('no token minted: the listener is not up')
      return token
    }
  }
}

function readNotes(path: string): {
  classic: { source: string; sessionId: string; keys: string[] }[]
  endBudgetMs: number | null
} | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

async function run(opts: RunOptions): Promise<RunResult> {
  const r = await runClaude(opts)
  cleanups.push(() => r.cleanup())
  assertNotBlockedByAuth(r)
  return r
}

describe.skipIf(!WITH_CLI)('the handshake against the real host (L4)', () => {
  it('binds the real id', async () => {
    const h = await realHost()
    const token = h.mint()
    const r = await run({
      env: { HARNU_SPAWN_TOKEN: token, HARNU_PROBE_OUT: h.notes },
      rendezvous: h.endpoint
    })
    expect(r.code, r.stderr).toBe(0)
    assertCleanLoad(r.debug)
    expect(r.probe, r.stdout).not.toBeNull()
    expect(r.json?.num_turns).toBe(0)
    // the binding's sid is the id the probe printed, and the hello was the first thing it said
    const binding = h.host.facade.bindingForSid(r.probe!.sessionId)
    expect(binding, JSON.stringify(h.host.facade.diagnostics().bindings)).not.toBeNull()
    expect(binding?.sessionKey).toBe('row:pty-1')
    // P1W5 added the three fleet sensors to what the mod declares, P1W6 `sense.usage`
    expect(binding?.declared).toEqual([
      'sense.identity',
      'sense.turn',
      'sense.attention',
      'sense.subagent',
      'sense.usage'
    ])
    expect(h.seen.hellos[0]).toMatchObject({ kind: 'spawn', sid: r.probe!.sessionId })
    expect(binding?.proven).toContain('sense.identity')
    // the hello landed before the engine finished `session.start`, which runs before any command
    const helloAnswered = r.debug.search(/\$\.http\.fetch \(harnu-companion\): 200 in/)
    const startSettled = r.debug.search(/session\.start settled in/)
    expect(helloAnswered).toBeGreaterThan(-1)
    expect(helloAnswered).toBeLessThan(startSettled)
    expect(binding?.helloAfterSpawnMs).toBeLessThan(2_000)
  })

  describe('host failures never surface in the session', () => {
    const cases: [string, FakeScript | null][] = [
      ['garbage', () => ({ kind: 'garbage' })],
      ['a closed socket', () => ({ kind: 'close' })],
      ['a host that answers never', () => ({ kind: 'hang' })],
      ['nothing at all (no rendezvous file)', null]
    ]
    for (const [name, script] of cases) {
      it(`host failures never surface in the session: ${name}`, async () => {
        let fake: FakeHost | null = null
        if (script) {
          fake = await startFakeHost(script)
          cleanups.push(() => fake?.stop())
        }
        const missing = join(tmpdir(), `hc-no-endpoint-${process.pid}`, 'endpoint.json')
        const r = await run({
          env: { HARNU_SPAWN_TOKEN: 'sp_00000000-0000-4000-8000-0000000000aa' },
          rendezvous: fake ? fake.endpointPath : missing,
          timeoutMs: 30_000
        })
        expect(r.code, r.stderr).toBe(0)
        expect(r.probe, r.stdout).not.toBeNull()
        assertCleanLoad(r.debug)
        expect(r.debug).not.toMatch(/hook skipped/i)
        expect(r.stderr).not.toMatch(/harnu-companion/i)
        // the token is never written to the debug file or to the output
        expect(r.debug).not.toContain('sp_00000000-0000-4000-8000-0000000000aa')
        expect(r.stdout).not.toContain('sp_00000000-0000-4000-8000-0000000000aa')
        if (fake) expect(fake.requests.length).toBeGreaterThan(0) // it did try
      })
    }
  })

  it('records CQ1, CQ2 and the startup permission_mode', async () => {
    const h = await realHost()
    const r = await run({
      env: { HARNU_SPAWN_TOKEN: h.mint(), HARNU_PROBE_OUT: h.notes },
      rendezvous: h.endpoint
    })
    expect(r.code, r.stderr).toBe(0)
    const notes = readNotes(h.notes)
    expect(notes, 'the probe wrote its notes').not.toBeNull()
    const hello = h.seen.events.find((e) => e.t === 'session.snapshot')
    expect(hello, 'the hello snapshot reached the host').toBeDefined()
    const startup = notes!.classic.find((c) => c.source === 'startup')
    const evidence = {
      claude: r.claudeVersion,
      surface: 'claude -p',
      // CQ2: did `classic.SessionStart {source: startup}` fire at a fresh start, and was
      // `probes.classic` already true when the hello snapshot was built?
      cq2_startupClassicFired: startup !== undefined,
      cq2_probesClassicAtHello: (hello!.d as { probes: { classic: boolean } }).probes.classic,
      classicSources: notes!.classic.map((c) => c.source),
      // P2W3, P2W5: does the startup payload carry a `permission_mode`?
      startupHasPermissionMode: startup?.keys.includes('permission_mode') ?? null,
      startupKeys: startup?.keys ?? null,
      // CQ1: the budget `session.end` reads (types say 1 500 ms; smoke C2 read 5 000 ms)
      cq1_sessionEndBudgetMs: notes!.endBudgetMs
    }
    console.info(`[P1W3 evidence] ${JSON.stringify(evidence)}`)
    // The mod's own events are in the right order and the bye carried `session.end`
    expect(h.seen.events.map((e) => e.t)).toEqual(['session.snapshot', 'session.end'])
    expect(notes!.endBudgetMs).not.toBeNull()
  })

  it('tick binds without a row', async () => {
    const h = await realHost()
    const token = h.mint('tick', 'run-1')
    const r = await run({
      tick: true,
      env: { HARNU_SPAWN_TOKEN: token },
      rendezvous: h.endpoint
    })
    expect(r.code, r.stderr).toBe(0)
    const view = h.host.facade.getBinding('tick:w-hs:run-1')
    expect(view, JSON.stringify(h.host.facade.diagnostics().bindings)).not.toBeNull()
    expect(view?.profile).toBe('headless')
    expect(h.adapter.claims()).toEqual([])
    expect(h.pushes).toEqual([]) // no identity push for a tick
  })

  it('fork id at hello', async () => {
    const SRC = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a'
    const h = await realHost()
    const r = await run({
      env: { HARNU_SPAWN_TOKEN: h.mint(), HARNU_PROBE_OUT: h.notes },
      rendezvous: h.endpoint,
      extraArgs: ['--resume', SRC, '--fork-session'],
      async prepare({ configDir, cwd }) {
        const dir = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
        mkdirSync(dir, { recursive: true })
        const base = { sessionId: SRC, cwd, version: '2.1.290', isSidechain: false }
        const u1 = '00000000-0000-4000-8000-0000000000a1'
        const u2 = '00000000-0000-4000-8000-0000000000a2'
        writeFileSync(
          join(dir, `${SRC}.jsonl`),
          [
            {
              ...base,
              type: 'user',
              uuid: u1,
              parentUuid: null,
              timestamp: '2026-10-01T10:00:00.000Z',
              message: { role: 'user', content: 'hello' }
            },
            {
              ...base,
              type: 'assistant',
              uuid: u2,
              parentUuid: u1,
              timestamp: '2026-10-01T10:00:01.000Z',
              message: {
                id: 'msg_fixture',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-5-5',
                content: [{ type: 'text', text: 'hi' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 }
              }
            }
          ]
            .map((l) => JSON.stringify(l))
            .join('\n') + '\n'
        )
      }
    })
    const hello = h.seen.hellos[0]
    const evidence = {
      claude: r.claudeVersion,
      exit: r.code,
      sourceId: SRC,
      helloSid: hello?.sid ?? null,
      probeSessionId: r.probe?.sessionId ?? null,
      helloIsSource: hello ? hello.sid === SRC : null,
      resumeFailed: r.probe === null,
      stderr: r.stderr.slice(0, 200)
    }
    console.info(`[P1W3 evidence] fork ${JSON.stringify(evidence)}`)
    // Either answer settles OQ-1; what must hold is that the hello's sid IS the id `$.session`
    // reports in the same process (the probe), so the claim names the transcript that gets written.
    if (r.probe && hello) expect(hello.sid).toBe(r.probe.sessionId)
  })
})
