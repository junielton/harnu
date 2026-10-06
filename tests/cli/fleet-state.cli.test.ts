import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WireEvent } from '../../src/main/companion/contract'
import { createTaskStateAdapter } from '../../src/main/companion/ingest/task-state-adapter'
import { createCompanionHost } from '../../src/main/companion/host-core'
import type { BindingView } from '../../src/main/companion/session-table'
import {
  configureHub,
  getTaskState,
  ingest,
  resetHubForTests
} from '../../src/main/detect/task-state-hub'
import { fakeMode, shortTmp } from '../companion/support/host-rig'
import {
  WITH_CLI,
  assertCleanLoad,
  assertNotBlockedByAuth,
  runClaude,
  type RunOptions,
  type RunResult
} from './support/run-claude'

// P1W5 L4: a real `claude` with the mod, against the real host server and the real task-state
// adapter over the real hub. Gated like every real-CLI suite (`HARNU_WITH_CLI=1`).
//
// The first block makes no model request (zero is the target, QA-8). The second needs real turns,
// so it is gated twice: `HARNU_CLI_LIVE=1`, and `HARNU_CLI_LIVE_CONFIG_DIR`, a throwaway
// CLAUDE_CONFIG_DIR that the OPERATOR signed in to beforehand (the harness never copies a
// credential, P1W2 section 7.9). Cap per run: haiku, three model calls, 0.05 USD (spec section 11).
// What each run observed is written as evidence JSON to `HARNU_EVIDENCE_DIR` (default: the temp
// dir) and printed, so the smoke addendum can quote it.

const LIVE_CONFIG = process.env.HARNU_CLI_LIVE_CONFIG_DIR
const LIVE = WITH_CLI && process.env.HARNU_CLI_LIVE === '1' && Boolean(LIVE_CONFIG)

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
  resetHubForTests()
})

const FEATURES = ['sense.identity', 'sense.turn', 'sense.attention', 'sense.subagent']

/** The real host, every declared feature enabled, and the real adapter over the real hub. */
async function realHost() {
  const dir = join(shortTmp('hc-fs-'), 'companion')
  const m = fakeMode('active')
  const host = createCompanionHost({
    dir,
    mode: m.mode,
    log: () => undefined,
    sessionKeyOf: (o) => (o.kind === 'pty' ? `row:${o.ptyId}` : null)
  })
  await host.register()
  host.facade.setEnablePolicy((b) => b.declared.filter((f) => FEATURES.includes(f)))
  // the identity adapter (P1W3) registers these four types in the app; this suite has no identity
  host.facade.registerEventTypes([
    'session.snapshot',
    'session.rebound',
    'session.end',
    'mod.error'
  ])
  const seen = { events: [] as { t: string; d: unknown; turnId?: string; agentId?: string }[] }
  const states: string[] = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (_c: string, p: { taskState: string }) => void states.push(p.taskState)
    }
  }
  // the companion owns everything in this suite: it is the adapter, not the arbiter, under test
  configureHub({ isHibernated: () => false, admit: () => 'apply' })
  const adapter = createTaskStateAdapter({
    host: host.facade,
    ingest: (ev) => ingest(ev, (() => win) as never),
    currentState: getTaskState,
    recordFact: () => undefined
  })
  host.facade.bus.on('event', (_b: BindingView, ev: WireEvent) =>
    seen.events.push({ t: ev.t, d: ev.d, turnId: ev.turnId, agentId: ev.agentId })
  )
  cleanups.push(async () => {
    adapter.dispose()
    await host.close()
    rmSync(join(dir, '..'), { recursive: true, force: true })
  })
  const out = join(mkdtempSync(join(tmpdir(), 'hc-fs-notes-')), 'raw.json')
  cleanups.push(() => rmSync(join(out, '..'), { recursive: true, force: true }))
  return {
    host,
    seen,
    states,
    out,
    endpoint: join(dir, 'endpoint.json'),
    mint: (id = 'pty-1') => {
      const t = host.facade.mintSpawnToken({
        owner: { kind: 'pty', ptyId: id },
        trust: 'operator',
        cwd: '/tmp/example-project'
      })
      if (!t) throw new Error('no token minted: the listener is not up')
      return t
    }
  }
}

async function run(opts: RunOptions): Promise<RunResult> {
  const r = await runClaude(opts)
  cleanups.push(() => r.cleanup())
  assertNotBlockedByAuth(r)
  return r
}

function evidence(name: string, body: unknown): void {
  const dir = process.env.HARNU_EVIDENCE_DIR ?? tmpdir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `p1w5-${name}.json`)
  writeFileSync(file, JSON.stringify(body, null, 2))
  console.info(`[evidence] ${name}: ${file}\n${JSON.stringify(body)}`)
}

describe.skipIf(!WITH_CLI)('fleet sensors against a real claude, no model turn (L4)', () => {
  it('classic events without settings hooks', async () => {
    const h = await realHost()
    const r = await run({
      env: { HARNU_SPAWN_TOKEN: h.mint(), HARNU_PROBE_OUT: h.out },
      rendezvous: h.endpoint
    })
    expect(r.code, r.stderr).toBe(0)
    assertCleanLoad(r.debug)
    expect(r.json?.num_turns).toBe(0)
    const binding = h.host.facade.bindingForSid(r.probe!.sessionId)
    // the real CLI accepted every hook of the fleet sensors: all three features were declared
    expect(binding?.declared).toEqual(expect.arrayContaining(FEATURES))
    expect(h.seen.events.filter((e) => e.t === 'mod.error')).toEqual([])
    // CQ13: the temp config dir has no settings hook at all, and `classic.*` still reached the
    // module: the snapshot after the probe flip says so
    const snaps = h.seen.events.filter((e) => e.t === 'session.snapshot')
    const probed = snaps.find((s) => (s.d as { probes: { classic: boolean } }).probes.classic)
    expect(probed, JSON.stringify(snaps)).toBeDefined()
    expect(binding?.proven).toContain('sense.attention')
    expect(binding?.proven).toContain('sense.subagent')
    evidence('cq13-classic-without-settings-hooks', {
      claudeVersion: r.claudeVersion,
      declared: binding?.declared,
      proven: binding?.proven,
      snapshotReasons: snaps.map((s) => (s.d as { reason: string }).reason)
    })
  })

  it('the debug file shows no skipped fleet hook and no registration error', async () => {
    const h = await realHost()
    const r = await run({
      env: { HARNU_SPAWN_TOKEN: h.mint() },
      rendezvous: h.endpoint
    })
    expect(r.code, r.stderr).toBe(0)
    expect(r.debug).not.toMatch(/hook skipped/i)
    expect(r.debug).not.toMatch(/harnu-companion[^\n]*(did not load|refused)/i)
  })
})

/** A throwaway mod that records field NAMES and the `type`/`status` values of background tasks. */
function writeRawProbe(root: string): string {
  const dir = join(root, 'fleet-raw-probe')
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'fleet-raw-probe', version: '0.0.1', description: 'test-only probe' })
  )
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
  writeFileSync(
    join(dir, 'hooks', 'register.ts'),
    `import type { Register } from 'claude-code'
const rows: unknown[] = []
const t0 = Date.now()
async function save($: any): Promise<void> {
  const out = await $.env.get('HARNU_PROBE_OUT')
  if (typeof out === 'string' && out !== '') await $.fs.write(out, JSON.stringify(rows))
}
const keys = (o: unknown): string[] => (o && typeof o === 'object' ? Object.keys(o as object).sort() : [])
export const register: Register = (on) => {
  const names = [
    'classic.Stop', 'classic.StopFailure', 'classic.SubagentStart', 'classic.SubagentStop',
    'classic.PostToolUseFailure', 'classic.PostToolUse', 'classic.PermissionRequest'
  ] as const
  for (const name of names) {
    on(name as any, async ($: any, e: any, next: any) => {
      const row: any = { name, ms: Date.now() - t0, keys: keys(e) }
      if (Array.isArray(e.background_tasks)) {
        row.tasks = e.background_tasks.map((t: any) => ({ keys: keys(t), type: t.type, status: t.status }))
      }
      if (name === 'classic.SubagentStart' || name === 'classic.SubagentStop') {
        row.agent = { hasId: typeof e.agent_id === 'string' && e.agent_id !== '', agent_type: e.agent_type }
      }
      rows.push(row)
      try { await save($) } catch {}
      return next(e)
    })
  }
  on('turn.start' as any, async ($: any, e: any, next: any) => {
    rows.push({ name: 'turn.start', ms: Date.now() - t0, turnId: e.turnId })
    try { await save($) } catch {}
    return next(e)
  })
  on('turn.complete' as any, async ($: any, e: any, next: any) => {
    rows.push({ name: 'turn.complete', ms: Date.now() - t0, reason: e.reason, agentId: e.agentId ?? null, turnId: e.turnId })
    try { await save($) } catch {}
    return next(e)
  })
}
`
  )
  return dir
}

const readRows = (path: string): Record<string, any>[] => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

describe.skipIf(!LIVE)('fleet sensors against a real claude, real turns (L4, live)', () => {
  const live = async (prompt: string, h: Awaited<ReturnType<typeof realHost>>, root: string) =>
    run({
      prompt,
      env: {
        HARNU_SPAWN_TOKEN: h.mint(),
        HARNU_PROBE_OUT: h.out,
        CLAUDE_CONFIG_DIR: LIVE_CONFIG as string
      },
      rendezvous: h.endpoint,
      timeoutMs: 120_000,
      extraArgs: [
        '--model',
        'haiku',
        '--max-budget-usd',
        '0.05',
        '--allowedTools',
        'Read,Agent',
        '--plugin-dir',
        writeRawProbe(root)
      ]
    })

  it('classic events without settings hooks (a turn with a tool call)', async () => {
    const h = await realHost()
    const root = mkdtempSync(join(tmpdir(), 'hc-fs-live-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    writeFileSync(join(root, 'note.txt'), 'hello')
    const r = await live(
      `Read the file ${join(root, 'note.txt')} and answer with one word.`,
      h,
      root
    )
    expect(r.code, r.stderr).toBe(0)
    assertCleanLoad(r.debug)
    const snaps = h.seen.events.filter((e) => e.t === 'session.snapshot')
    expect(snaps.some((s) => (s.d as { probes: { classic: boolean } }).probes.classic)).toBe(true)
    expect(snaps.some((s) => (s.d as { probes: { toolCheck: boolean } }).probes.toolCheck)).toBe(
      true
    )
    expect(h.seen.events.some((e) => e.t === 'turn.completed')).toBe(true)
    evidence('ac16-turn', { claudeVersion: r.claudeVersion, wire: h.seen.events.map((e) => e.t) })
  })

  it('failing tool settles the turn', async () => {
    const h = await realHost()
    const root = mkdtempSync(join(tmpdir(), 'hc-fs-live-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const r = await live(
      `Read the file ${join(root, 'does-not-exist.txt')} and report the outcome in one word.`,
      h,
      root
    )
    expect(r.code, r.stderr).toBe(0)
    const sid = h.host.facade.diagnostics().bindings[0]?.sid as string
    expect(getTaskState(sid)).toBe('idle')
    const rows = readRows(h.out)
    // CQ12: did classic.PostToolUseFailure fire, and did any wire event follow from it?
    evidence('cq12-post-tool-use-failure', {
      claudeVersion: r.claudeVersion,
      postToolUseFailureFired: rows.some((x) => x.name === 'classic.PostToolUseFailure'),
      postToolUseFired: rows.some((x) => x.name === 'classic.PostToolUse'),
      attentionEvents: h.seen.events.filter((e) => e.t.startsWith('attention.')).map((e) => e.t),
      finalState: getTaskState(sid)
    })
  })

  it('background_tasks shape', async () => {
    const h = await realHost()
    const root = mkdtempSync(join(tmpdir(), 'hc-fs-live-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const r = await live(
      'Start one background subagent with the Agent tool (run_in_background true) that only replies ok, then answer done without waiting for it.',
      h,
      root
    )
    expect(r.code, r.stderr).toBe(0)
    const rows = readRows(h.out)
    const stops = rows.filter((x) => x.name === 'classic.Stop')
    const allowed = ['agent_type', 'command', 'description', 'id', 'server', 'status', 'type']
    const tasks = stops.flatMap(
      (s) => (s.tasks ?? []) as { keys: string[]; type: string; status: string }[]
    )
    for (const t of tasks) for (const k of t.keys) expect(allowed, k).toContain(k)
    // Q12: the live values
    evidence('q12-background-tasks', {
      claudeVersion: r.claudeVersion,
      types: [...new Set(tasks.map((t) => t.type))],
      statuses: [...new Set(tasks.map((t) => t.status))],
      keys: [...new Set(tasks.flatMap((t) => t.keys))],
      wireBackground: h.seen.events
        .filter((e) => e.t === 'turn.completed')
        .map((e) => [
          (e.d as { backgroundTasks?: number }).backgroundTasks,
          (e.d as { backgroundSubagents?: number }).backgroundSubagents
        ])
    })
  })

  it('notice turn has an abortable turnId', async () => {
    const h = await realHost()
    const root = mkdtempSync(join(tmpdir(), 'hc-fs-live-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const r = await live(
      'Start one background subagent with the Agent tool (run_in_background true) that only replies ok, then answer done.',
      h,
      root
    )
    expect(r.code, r.stderr).toBe(0)
    const rows = readRows(h.out)
    // Q24: how many turns the run had, and whether each one announced itself with a turnId. The
    // abort half (`$.turn.abort` with that id, P2W1) is not exercised here: this wave sends none.
    evidence('q24-notice-turn', {
      claudeVersion: r.claudeVersion,
      turnStarts: rows
        .filter((x) => x.name === 'turn.start')
        .map((x) => ({ ms: x.ms, hasId: Boolean(x.turnId) })),
      turnCompletes: rows
        .filter((x) => x.name === 'turn.complete')
        .map((x) => ({ ms: x.ms, agent: x.agentId, reason: x.reason })),
      wireTurns: h.seen.events
        .filter((e) => e.t.startsWith('turn.'))
        .map((e) => [e.t, e.turnId ?? null])
    })
  })

  it('teammate is not a subagent', async () => {
    const h = await realHost()
    const root = mkdtempSync(join(tmpdir(), 'hc-fs-live-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const r = await live(
      'Use the Agent tool once to run a subagent that only replies ok, then answer done.',
      h,
      root
    )
    expect(r.code, r.stderr).toBe(0)
    const rows = readRows(h.out)
    const sub = rows.filter(
      (x) => x.name === 'classic.SubagentStart' || x.name === 'classic.SubagentStop'
    )
    // OQ-c, the plain-subagent half: the payload facts the sensor counts on. The teammate half
    // needs an agent-teams session and is recorded by the live recipe, not by `-p`.
    evidence('oq-c-subagent-payloads', {
      claudeVersion: r.claudeVersion,
      subagentHooks: sub.map((x) => ({ name: x.name, keys: x.keys, agent: x.agent })),
      wire: h.seen.events.filter((e) => e.t.startsWith('subagent.')).map((e) => [e.t, e.d])
    })
  })
})
