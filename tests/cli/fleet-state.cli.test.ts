import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { startFakeApi, type ApiScript } from './support/fake-anthropic'
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
// The first block makes no model request. The second runs real turns against a SCRIPTED endpoint
// (`support/fake-anthropic.ts`, loopback, fake key): no login, no cost, no credential anywhere.
// What it can say is therefore about the CLI's own hooks and the sensors, not about Anthropic's
// service: a real rate-limit body is LV-P1W5-d. What each run observed is written as evidence JSON
// to `HARNU_EVIDENCE_DIR` (default: the temp dir) and printed, so the smoke addendum can quote it.

// real turns take seconds, and a failing turn waits out the CLI's own retries
vi.setConfig({ testTimeout: 120_000 })

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
  // the engine reads `on()` calls from the source: every event name has to be a literal
  const classic = [
    'Stop',
    'StopFailure',
    'SubagentStart',
    'SubagentStop',
    'PostToolUseFailure',
    'PostToolUse',
    'PermissionRequest'
  ]
  const hooks = classic
    .map(
      (n) => `  on('classic.${n}', async ($: any, e: any, next: any) => {
    await note($, 'classic.${n}', e)
    return next(e)
  })`
    )
    .join('\n')
  writeFileSync(
    join(dir, 'hooks', 'register.ts'),
    `import type { Register } from 'claude-code'
const rows: unknown[] = []
const t0 = Date.now()
async function save($: any): Promise<void> {
  const out = await $.env.get('HARNU_RAW_OUT')
  if (typeof out === 'string' && out !== '') await $.fs.write(out, JSON.stringify(rows))
}
const keys = (o: unknown): string[] => (o && typeof o === 'object' ? Object.keys(o as object).sort() : [])
async function note($: any, name: string, e: any): Promise<void> {
  const row: any = { name, ms: Date.now() - t0, keys: keys(e) }
  if (name === 'classic.StopFailure') row.error = typeof e.error === 'string' ? e.error.slice(0, 40) : null
  if (Array.isArray(e.background_tasks)) {
    row.tasks = e.background_tasks.map((t: any) => ({ keys: keys(t), type: t.type, status: t.status, id: t.id }))
  }
  if (name === 'classic.SubagentStart' || name === 'classic.SubagentStop') {
    row.agent = { hasId: typeof e.agent_id === 'string' && e.agent_id !== '', agent_type: e.agent_type, id: e.agent_id }
  }
  rows.push(row)
  try { await save($) } catch {}
}
export const register: Register = (on) => {
${hooks}
  on('turn.start', async ($: any, e: any, next: any) => {
    rows.push({ name: 'turn.start', ms: Date.now() - t0, turnId: e.turnId })
    try { await save($) } catch {}
    return next(e)
  })
  on('turn.complete', async ($: any, e: any, next: any) => {
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

const SUBAGENT_MARK = 'SUBAGENT_TASK_MARK'
const sawToolResult = (r: { body: { messages?: { content: unknown }[] } }): boolean =>
  JSON.stringify(r.body.messages ?? []).includes('tool_result')

/** One real `-p` run against the scripted endpoint, with the raw probe beside the companion. */
async function turn(
  h: Awaited<ReturnType<typeof realHost>>,
  script: ApiScript,
  prompt: string,
  extra: string[] = [],
  more: { env?: Record<string, string>; prepare?: RunOptions['prepare'] } = {}
) {
  const api = await startFakeApi(script)
  cleanups.push(() => api.stop())
  const root = mkdtempSync(join(tmpdir(), 'hc-fs-turn-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const r = await run({
    prompt,
    env: {
      HARNU_SPAWN_TOKEN: h.mint(),
      HARNU_RAW_OUT: h.out,
      ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_KEY: 'sk-ant-fake-key-for-tests',
      ...more.env
    },
    prepare: more.prepare,
    rendezvous: h.endpoint,
    timeoutMs: 90_000,
    extraArgs: [
      '--model',
      'haiku',
      '--allowedTools',
      'Read,Agent',
      '--plugin-dir',
      writeRawProbe(root),
      ...extra
    ]
  })
  const sid = h.host.facade.diagnostics().bindings[0]?.sid as string
  // `-p` says goodbye on exit: the folded state then reads `completed`, so the turn's own last
  // state is the one before it
  const beforeEnd = h.states.filter((x) => x !== 'completed').at(-1)
  return { api, r, sid, rows: readRows(h.out), wire: h.seen.events, states: h.states, beforeEnd }
}

describe.skipIf(!WITH_CLI)(
  'fleet sensors against a real claude, real turns, scripted endpoint (L4)',
  () => {
    it('classic events without settings hooks (a turn with a tool call)', async () => {
      const h = await realHost()
      const { r, beforeEnd, wire, api } = await turn(
        h,
        (q) =>
          sawToolResult(q)
            ? { kind: 'text', text: 'done' }
            : { kind: 'tool', name: 'Read', input: { file_path: '/etc/hostname' } },
        'read the file'
      )
      expect(r.code, r.stderr).toBe(0)
      assertCleanLoad(r.debug)
      const snaps = wire.filter((e) => e.t === 'session.snapshot')
      expect(snaps.some((s) => (s.d as { probes: { classic: boolean } }).probes.classic)).toBe(true)
      expect(snaps.some((s) => (s.d as { probes: { toolCheck: boolean } }).probes.toolCheck)).toBe(
        true
      )
      expect(wire.map((e) => e.t).filter((t) => t.startsWith('turn.'))).toEqual([
        'turn.started',
        'turn.completed'
      ])
      expect(beforeEnd).toBe('idle')
      evidence('ac16-turn-with-tool-call', {
        claudeVersion: r.claudeVersion,
        apiRequests: api.requests.length,
        wire: wire.map((e) => [e.t, e.turnId ?? null])
      })
    })

    it('failing tool settles the turn', async () => {
      const h = await realHost()
      const { r, beforeEnd, wire, rows } = await turn(
        h,
        (q) =>
          sawToolResult(q)
            ? { kind: 'text', text: 'done' }
            : {
                kind: 'tool',
                name: 'Read',
                input: { file_path: '/nonexistent/harnu-p1w5-missing.txt' }
              },
        'read the file'
      )
      expect(r.code, r.stderr).toBe(0)
      expect(beforeEnd).toBe('idle')
      // CQ12: did classic.PostToolUseFailure fire, and did any wire event follow from it?
      evidence('cq12-post-tool-use-failure', {
        claudeVersion: r.claudeVersion,
        postToolUseFailureFired: rows.some((x) => x.name === 'classic.PostToolUseFailure'),
        postToolUseFired: rows.some((x) => x.name === 'classic.PostToolUse'),
        attentionEvents: wire.filter((e) => e.t.startsWith('attention.')).map((e) => e.t),
        finalState: beforeEnd
      })
    })

    it('background_tasks shape', async () => {
      const h = await realHost()
      const { r, rows, wire, beforeEnd } = await turn(
        h,
        (q) =>
          q.lastUserText.includes(SUBAGENT_MARK)
            ? { kind: 'text', text: 'ok' }
            : sawToolResult(q)
              ? { kind: 'text', text: 'done' }
              : {
                  kind: 'tool',
                  name: 'Agent',
                  input: {
                    description: 'helper',
                    prompt: SUBAGENT_MARK,
                    subagent_type: 'general-purpose',
                    run_in_background: true
                  }
                },
        'start a helper'
      )
      expect(r.code, r.stderr).toBe(0)
      const stops = rows.filter((x) => x.name === 'classic.Stop')
      const allowed = ['agent_type', 'command', 'description', 'id', 'server', 'status', 'type']
      const tasks = stops.flatMap(
        (x) => (x.tasks ?? []) as { keys: string[]; type: string; status: string }[]
      )
      for (const t of tasks) for (const k of t.keys) expect(allowed, k).toContain(k)
      evidence('q12-background-tasks', {
        claudeVersion: r.claudeVersion,
        stopCount: stops.length,
        types: [...new Set(tasks.map((t) => t.type))],
        statuses: [...new Set(tasks.map((t) => t.status))],
        keys: [...new Set(tasks.flatMap((t) => t.keys))],
        taskIds: stops.flatMap((x) => ((x.tasks ?? []) as { id: string }[]).map((t) => t.id)),
        subagentHooks: rows
          .filter((x) => /^classic\.Subagent/.test(x.name))
          .map((x) => [x.name, x.agent]),
        wire: wire
          .filter((e) => /^(turn|subagent)\./.test(e.t))
          .map((e) => [e.t, e.turnId ?? null, e.agentId ?? null, e.d]),
        finalState: beforeEnd
      })
    })

    it('notice turn has an abortable turnId', async () => {
      const h = await realHost()
      const { r, rows, wire } = await turn(
        h,
        (q) =>
          q.lastUserText.includes(SUBAGENT_MARK)
            ? { kind: 'text', text: 'ok' }
            : sawToolResult(q)
              ? { kind: 'text', text: 'done' }
              : {
                  kind: 'tool',
                  name: 'Agent',
                  input: {
                    description: 'helper',
                    prompt: SUBAGENT_MARK,
                    subagent_type: 'general-purpose',
                    run_in_background: true
                  }
                },
        'start a helper'
      )
      expect(r.code, r.stderr).toBe(0)
      // Q24: how many turns the run had, and whether each announced itself with a turnId. The abort
      // half (`$.turn.abort` with that id) belongs to P2W1: this wave sends no command.
      evidence('q24-notice-turn', {
        claudeVersion: r.claudeVersion,
        turnStarts: rows
          .filter((x) => x.name === 'turn.start')
          .map((x) => ({ ms: x.ms, hasId: Boolean(x.turnId) })),
        turnCompletes: rows
          .filter((x) => x.name === 'turn.complete')
          .map((x) => ({ ms: x.ms, agent: x.agentId, reason: x.reason })),
        wireTurns: wire.filter((e) => e.t.startsWith('turn.')).map((e) => [e.t, e.turnId ?? null])
      })
      expect(wire.filter((e) => e.t === 'turn.started').every((e) => Boolean(e.turnId))).toBe(true)
    })

    it('teammate is not a subagent', async () => {
      const h = await realHost()
      const { r, rows, wire } = await turn(
        h,
        (q) =>
          q.lastUserText.includes(SUBAGENT_MARK)
            ? { kind: 'text', text: 'ok' }
            : sawToolResult(q)
              ? { kind: 'text', text: 'done' }
              : {
                  kind: 'tool',
                  name: 'Agent',
                  input: {
                    description: 'helper',
                    prompt: SUBAGENT_MARK,
                    subagent_type: 'general-purpose'
                  }
                },
        'run a helper'
      )
      expect(r.code, r.stderr).toBe(0)
      const sub = rows.filter((x) => /^classic\.Subagent/.test(x.name))
      // OQ-c, the plain-subagent half: the payload facts the sensor counts on. The teammate half
      // needs an agent-teams session and is recorded by the live recipe, not by `-p`.
      evidence('oq-c-subagent-payloads', {
        claudeVersion: r.claudeVersion,
        subagentHooks: sub.map((x) => ({ name: x.name, keys: x.keys, agent: x.agent })),
        wire: wire
          .filter((e) => /^(turn|subagent)\./.test(e.t))
          .map((e) => [e.t, e.turnId ?? null, e.agentId ?? null, e.d])
      })
      expect(
        wire
          .filter((e) => e.t === 'turn.completed' && !e.agentId)
          .every((e) => (e.d as { backgroundSubagents?: number }).backgroundSubagents === 0)
      ).toBe(true)
    })

    /** A loopback sink that keeps only the KEY NAMES of the POST bodies it receives. */
    async function hookSink() {
      const bodies: { path: string; keys: string[] }[] = []
      const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          try {
            const o = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
            bodies.push({ path: req.url ?? '', keys: Object.keys(o).sort() })
          } catch {
            bodies.push({ path: req.url ?? '', keys: [] })
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      cleanups.push(() => new Promise<void>((resolve) => void server.close(() => resolve())))
      const port = (server.address() as { port: number }).port
      return { bodies, port }
    }

    const failures: [string, number, string][] = [
      ['overloaded', 529, 'overloaded_error'],
      ['rate-limit', 429, 'rate_limit_error'],
      ['server-error', 500, 'api_error']
    ]
    for (const [name, status, type] of failures) {
      it(`a failed turn: ${name}`, async () => {
        const h = await realHost()
        const sink = await hookSink()
        const { r, rows, wire, beforeEnd } = await turn(
          h,
          () => ({ kind: 'error', status, type, message: 'scripted failure' }),
          'say hello',
          ['--max-turns', '1'],
          {
            env: { CLAUDE_CODE_MAX_RETRIES: '0' },
            // the HTTP hook of the legacy bridge, pointed at the sink: the raw body's key names
            prepare: async ({ configDir }) => {
              mkdirSync(configDir, { recursive: true })
              writeFileSync(
                join(configDir, 'settings.json'),
                JSON.stringify({
                  hooks: {
                    StopFailure: [
                      {
                        hooks: [{ type: 'http', url: `http://127.0.0.1:${sink.port}/stop-failure` }]
                      }
                    ]
                  }
                })
              )
            }
          }
        )
        const stopFailure = rows.find((x) => x.name === 'classic.StopFailure')
        const order = rows
          .filter((x) => x.name === 'classic.StopFailure' || x.name === 'turn.complete')
          .map((x) => x.name)
        evidence(`lv-d-stopfailure-${name}`, {
          claudeVersion: r.claudeVersion,
          exitCode: r.code,
          stopFailureFired: stopFailure !== undefined,
          moduleKeys: stopFailure?.keys ?? null,
          errorValue: stopFailure?.error ?? null,
          httpHookBodyKeys: sink.bodies.map((b) => b.keys),
          orderAgainstTurnComplete: order,
          wire: wire.filter((e) => e.t.startsWith('turn.')).map((e) => [e.t, e.d]),
          finalState: beforeEnd
        })
        expect(order.length).toBeGreaterThan(0)
      })
    }
  }
)
