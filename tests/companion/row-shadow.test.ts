import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { helloSpawnRequest } from '../../resources/companion/tests/fixtures/hello'
import { __scrapeHeaderWithStatForTests } from '../../src/main/claude-reader'
import type { CompanionMode } from '../../src/main/companion/mode'
import type { Conn, EndpointFile } from '../../src/main/companion/contract'
import { createIdentityAdapter } from '../../src/main/companion/identity-adapter'
import { createRowAdapter } from '../../src/main/companion/ingest/row-adapter'
import { createRowLegacySource } from '../../src/main/companion/ingest/row-legacy'
import { createParityLedger } from '../../src/main/companion/parity-ledger'
import { createSessionArbiter } from '../../src/main/companion/session-arbiter'
import { getTaskStates } from '../../src/main/detect/task-state-hub'
import {
  __resetFleetModelForTests,
  __setRootDirForTests,
  getFleetFolders,
  requestFullRescan
} from '../../src/main/fleet-model'
import { post } from './support/client'
import { createCompanionHost, fakeMode, shortTmp, tick } from './support/host-rig'

/**
 * T455 W2 AC-4: SHADOW IS INVISIBLE. A burst of rows and turn ends goes through the real host, the
 * real identity and row adapters, the real reader (as the parity twin) and the real ledger, and
 * afterwards the fleet model (what `get_fleet`, `get_session` and a renderer reload read), the
 * task-state hub (the other input of `get_fleet` and the status dot) and the identity push to the
 * renderer are exactly what they are with no mod at all (`off`). `active` is tested too: in W2 it
 * only makes the arbiter report the family owned; no consumer reads that answer yet (W3).
 */

const S1 = helloSpawnRequest.sid
const dirs: string[] = []
const closers: (() => Promise<void> | void)[] = []
let root: string
let transcript: string

beforeEach(async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'rs-')))
  dirs.push(base)
  root = join(base, 'projects')
  const slug = join(root, '-tmp-example-project')
  mkdirSync(slug, { recursive: true })
  transcript = join(slug, `${S1}.jsonl`)
  const at = 1_790_000_000_000
  const lines = [
    {
      type: 'user',
      uuid: 'aaaaaaaa-0000-4000-8000-000000000001',
      sessionId: S1,
      cwd: '/tmp/example-project',
      gitBranch: '',
      isSidechain: false,
      timestamp: new Date(at - 2_000).toISOString(),
      origin: { kind: 'human' },
      message: { role: 'user', content: 'summarise the synthetic notes' }
    },
    {
      type: 'assistant',
      uuid: 'aaaaaaaa-0000-4000-8000-000000000002',
      sessionId: S1,
      isSidechain: false,
      timestamp: new Date(at - 500).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'Summary ready.' }] }
    },
    { type: 'last-prompt', lastPrompt: 'summarise the synthetic notes', sessionId: S1 }
  ]
  writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  utimesSync(transcript, at / 1000, at / 1000)
  await __resetFleetModelForTests()
  __setRootDirForTests(root)
})

afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  await __resetFleetModelForTests()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** One live session through the whole W2 pipeline, `rows` rows and three turn ends. */
async function runMod(mode: CompanionMode, rows: number) {
  const dir = join(shortTmp('hc-rs-'), 'companion')
  dirs.push(join(dir, '..'))
  const m = fakeMode(mode)
  const host = createCompanionHost({
    dir,
    mode: m.mode,
    log: () => undefined,
    sessionKeyOf: (o) => (o.kind === 'pty' ? 'synthetic-aaaa' : null)
  })
  closers.push(() => host.close())
  await host.register()
  host.facade.setEnablePolicy((b) =>
    b.declared.filter((f) => ['sense.identity', 'sense.row', 'sense.turn'].includes(f))
  )
  const arbiter = createSessionArbiter({
    host: host.facade,
    rollout: () => ({
      enabled: true,
      cliGate: 'ok',
      families: { row: mode, identity: mode },
      allFolders: true,
      rampFolders: new Set()
    })
  })
  closers.push(() => arbiter.dispose())
  const pushes: string[] = []
  const identity = createIdentityAdapter({
    host: host.facade,
    getMode: m.mode.getMode,
    gateOf: () => 'ok',
    push: (c) => void pushes.push(JSON.stringify(c)),
    spawnKind: () => 'claude-new',
    projectsRoot: () => root
  })
  closers.push(() => identity.dispose())
  const ledger = createParityLedger({
    dir,
    now: () => Date.now(),
    cli: () => '2.1.296',
    modVersion: () => '0.1.0',
    context: () => ({ owner: 'legacy', reason: 'mode-shadow', mode })
  })
  closers.push(() => ledger.dispose())
  const pending: (() => void)[] = []
  const adapter = createRowAdapter({
    host: host.facade,
    transcriptPathOf: (b) => identity.transcriptPathOf(b),
    lineageOf: (b) => identity.lineageOf(b),
    legacy: createRowLegacySource({
      header: async (p) => __scrapeHeaderWithStatForTests(p, statSync(p))
    }),
    recordFact: (sid, k, d, ts) =>
      ledger.recordFact('row', 'companion', sid, k, d, { ts, disposition: 'record-only' }),
    schedule: (fn) => {
      pending.push(fn)
      return () => undefined
    }
  })
  closers.push(() => adapter.dispose())
  const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
  const token = host.facade.mintSpawnToken({
    owner: { kind: 'pty', ptyId: 'p1' },
    trust: 'operator',
    cwd: '/tmp/example-project'
  })!
  const hello = await post(ep, 'hello', {
    body: { ...helloSpawnRequest, spawn: token, declared: ['sense.identity', 'sense.row'] }
  })
  const conn = hello.json.conn as Conn
  let seq = 0
  const send = (t: string, d: unknown) =>
    post(ep, 'events', {
      body: { v: 1, sid: S1, conn, sentAt: 1, events: [{ seq: ++seq, t, ts: seq, d }] }
    })
  if (rows > 0) {
    await send('session.snapshot', {
      reason: 'probe',
      activeTurnId: null,
      openAttention: [],
      runningSubagents: 0,
      probes: { classic: true, toolCheck: false },
      start: { source: 'startup', transcriptPath: transcript }
    })
  }
  for (let i = 1; i <= rows; i++) {
    await send('session.row', {
      fold: 1,
      firstPrompt: 'summarise the synthetic notes',
      lastPrompt: 'summarise the synthetic notes',
      lastAssistant: i % 2 ? 'Summary ready.' : 'Working on it.',
      title: null,
      toolCalls: i,
      subagentToolCalls: 0,
      userRows: 1,
      lastRowAt: 1_790_000_000_000,
      lastUuid: 'aaaaaaaa-0000-4000-8000-000000000002'
    })
    if (i % 20 === 0) await send('turn.completed', { reason: 'answer', backgroundSubagents: 0 })
  }
  await tick()
  for (const fn of pending.splice(0)) fn()
  await adapter.idle()
  ledger.flush()
  return { arbiter, identity, adapter, ledger, pushes }
}

describe('shadow is invisible (AC-4)', () => {
  it('the model, the hub and the identity push are identical to a run without the mod', async () => {
    // `off`: no mod at all; this is what Harnu shows today
    const offModel = JSON.stringify(await getFleetFolders())
    expect(offModel).toContain(S1) // the session is in the model: the comparison means something
    const offHub = JSON.stringify([...getTaskStates()])
    const quiet = await runMod('shadow', 0)

    const x = await runMod('shadow', 60)
    expect(x.adapter.diagnostics()).toMatchObject({ rows: 60, comparisons: 3, malformed: 0 })
    expect(x.ledger.read('row').length).toBe(18) // the stream IS written: 3 turn ends × 6 groups
    expect(JSON.stringify(await getFleetFolders())).toBe(offModel)
    expect(JSON.stringify(await requestFullRescan())).toBe(offModel)
    expect(JSON.stringify([...getTaskStates()])).toBe(offHub)
    // the renderer's identity channel gets the same payloads with and without rows and a start
    expect(x.pushes).toEqual(quiet.pushes)
    expect(x.arbiter.ownerFor(S1, 'row')).toEqual({ owner: 'legacy', reason: 'mode-shadow' })
  })

  it('`active` in W2 makes the arbiter report the family owned, and still changes nothing', async () => {
    const offModel = JSON.stringify(await getFleetFolders())
    const offHub = JSON.stringify([...getTaskStates()])
    const quiet = await runMod('active', 0)
    const x = await runMod('active', 60)
    expect(x.arbiter.ownerFor(S1, 'row')).toEqual({ owner: 'companion', reason: 'owned' })
    expect(JSON.stringify(await getFleetFolders())).toBe(offModel)
    expect(JSON.stringify(await requestFullRescan())).toBe(offModel)
    expect(JSON.stringify([...getTaskStates()])).toBe(offHub)
    expect(x.pushes).toEqual(quiet.pushes)
    // every record says so: nothing is applied in W2, whatever the mode
    for (const r of x.ledger.read('row')) expect(r.disposition).toBe('record-only')
  })
})

describe('the W2 row path has no way to reach a consumer (AC-4)', () => {
  const FILES = [
    'src/main/companion/ingest/row-adapter.ts',
    'src/main/companion/ingest/row-legacy.ts',
    'src/main/companion/ingest/row-parity-core.ts',
    'src/main/companion/parity-row-rule.ts',
    'src/main/companion/lineage-store.ts',
    'src/main/companion/transcript-path.ts'
  ]
  it('imports no renderer channel, fleet model, watcher, hub or Electron, and sends nothing', () => {
    for (const f of FILES) {
      const src = readFileSync(join(__dirname, '..', '..', f), 'utf8')
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1])
      for (const i of imports) {
        expect({
          f,
          i,
          bad: /electron|fleet-model|claude-watcher|task-state-hub|renderer|preload/.test(i!)
        }).toEqual({ f, i, bad: false })
      }
      expect(src).not.toMatch(/webContents|claude:session:updated|\.send\(/)
    }
  })
})
