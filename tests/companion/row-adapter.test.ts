import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EventPayloads } from '../../resources/companion/hooks/contract'
import { helloSpawnRequest } from '../../resources/companion/tests/fixtures/hello'
import { __scrapeHeaderWithStatForTests } from '../../src/main/claude-reader'
import type { Conn, EndpointFile } from '../../src/main/companion/contract'
import { createIdentityAdapter } from '../../src/main/companion/identity-adapter'
import { createRowAdapter } from '../../src/main/companion/ingest/row-adapter'
import { createRowLegacySource } from '../../src/main/companion/ingest/row-legacy'
import { createParityLedger } from '../../src/main/companion/parity-ledger'
import { post } from './support/client'
import { createCompanionHost, fakeMode, shortTmp, tick } from './support/host-rig'

/**
 * T455 W2 AC-2 (the row adapter) and the end-to-end half of AC-7: a real host, the real identity
 * adapter, the real reader as the legacy twin and the real ledger, over a SYNTHETIC transcript.
 */

type Row = EventPayloads['session.row']
const S1 = helloSpawnRequest.sid
const S2 = '22222222-2222-4222-8222-222222222222'
/** Words that appear only in the synthetic texts: none may reach a file the host writes. */
const WORDS = ['zephyrine', 'quokkalith', 'marmoset-ledger']

const dirs: string[] = []
const closers: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const row = (over: Partial<Row> = {}): Row => ({
  fold: 1,
  firstPrompt: `plan the ${WORDS[0]} migration`,
  lastPrompt: `plan the ${WORDS[0]} migration`,
  lastAssistant: `The ${WORDS[1]} plan is ready.`,
  title: null,
  toolCalls: 0,
  subagentToolCalls: 0,
  userRows: 1,
  lastRowAt: 1_790_000_000_000,
  lastUuid: 'aaaaaaaa-0000-4000-8000-000000000002',
  ...over
})

function allFiles(d: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) out.push(...allFiles(p))
    else out.push(p)
  }
  return out
}

async function rig(opts: { declared?: string[]; legacy?: boolean; isInteractive?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ra-')))
  dirs.push(base)
  const root = join(base, 'projects')
  const slug = join(root, '-tmp-example-project')
  mkdirSync(slug, { recursive: true })
  const dir = join(shortTmp('hc-ra-'), 'companion')
  dirs.push(join(dir, '..'))
  const m = fakeMode('shadow')
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
  const identity = createIdentityAdapter({
    host: host.facade,
    getMode: m.mode.getMode,
    gateOf: () => 'ok',
    push: () => undefined,
    spawnKind: () => 'claude-new',
    projectsRoot: () => root
  })
  closers.push(() => identity.dispose())
  const ledger = createParityLedger({
    dir,
    now: () => 1_790_000_100_000,
    cli: () => '2.1.296',
    modVersion: () => '0.1.0',
    context: () => ({ owner: 'legacy', reason: 'mode-shadow', mode: 'shadow' })
  })
  closers.push(() => ledger.dispose())
  const pending: (() => void)[] = []
  const adapter = createRowAdapter({
    host: host.facade,
    transcriptPathOf: (b) => identity.transcriptPathOf(b),
    lineageOf: (b) => identity.lineageOf(b),
    legacy:
      opts.legacy === false
        ? null
        : createRowLegacySource({
            header: async (p) => __scrapeHeaderWithStatForTests(p, statSync(p))
          }),
    recordFact: (sid, k, d, ts) => ledger.recordFact('row', 'companion', sid, k, d, { ts }),
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
    body: {
      ...helloSpawnRequest,
      spawn: token,
      isInteractive: opts.isInteractive ?? true,
      declared: opts.declared ?? ['sense.identity', 'sense.row', 'sense.turn']
    }
  })
  const conn = hello.json.conn as Conn
  let seq = 0
  const sendEv = (sid: string, ev: { t: string; d: unknown; agentId?: string }) =>
    post(ep, 'events', {
      body: { v: 1, sid, conn, sentAt: 1, events: [{ seq: ++seq, ts: seq, ...ev }] }
    })
  const send = (sid: string, t: string, d: unknown) => sendEv(sid, { t, d })
  const transcript = join(slug, `${S1}.jsonl`)
  const start = () =>
    send(S1, 'session.snapshot', {
      reason: 'probe',
      activeTurnId: null,
      openAttention: [],
      runningSubagents: 0,
      probes: { classic: true, toolCheck: false },
      start: { source: 'startup', transcriptPath: transcript }
    })
  /** Runs the comparisons the adapter scheduled for +2 s, and waits for them. */
  const settle = async () => {
    for (const fn of pending.splice(0)) fn()
    await adapter.idle()
    ledger.flush()
  }
  return {
    dir,
    root,
    slug,
    transcript,
    host,
    identity,
    adapter,
    ledger,
    send,
    sendEv,
    start,
    settle
  }
}

/** A synthetic transcript the way the CLI stores it: one typed prompt, one answer. */
function writeTranscript(path: string, mtimeMs: number): void {
  const lines = [
    {
      type: 'user',
      uuid: 'aaaaaaaa-0000-4000-8000-000000000001',
      sessionId: S1,
      cwd: '/tmp/example-project',
      timestamp: new Date(mtimeMs - 2_000).toISOString(),
      origin: { kind: 'human' },
      promptSource: 'typed',
      message: { role: 'user', content: `plan the ${WORDS[0]} migration` }
    },
    {
      type: 'assistant',
      uuid: 'aaaaaaaa-0000-4000-8000-000000000002',
      sessionId: S1,
      timestamp: new Date(mtimeMs - 500).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `The ${WORDS[1]} plan is ready.` }]
      }
    },
    { type: 'last-prompt', lastPrompt: `plan the ${WORDS[0]} migration`, sessionId: S1 }
  ]
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
}

describe('row adapter (AC-2)', () => {
  it('keeps only the latest values: absent keeps, null clears, counts replace', async () => {
    const x = await rig({ legacy: false })
    await x.send(S1, 'session.row', row())
    await x.send(S1, 'session.row', {
      fold: 1,
      lastPrompt: null,
      toolCalls: 2,
      subagentToolCalls: 1,
      userRows: 3,
      lastRowAt: 1_790_000_001_000,
      lastUuid: 'aaaaaaaa-0000-4000-8000-000000000009'
    })
    await tick()
    expect(x.adapter.latest(S1)).toMatchObject({
      firstPrompt: `plan the ${WORDS[0]} migration`, // absent: kept
      lastPrompt: null, // null: none seen
      lastAssistant: `The ${WORDS[1]} plan is ready.`,
      toolCalls: 2,
      subagentToolCalls: 1,
      userRows: 3,
      lastRowAt: 1_790_000_001_000
    })
    expect(x.host.facade.getBinding(S1)?.proven).toContain('sense.row')
  })

  it('a lost or coalesced row is harmless: the last one alone gives the same state', async () => {
    const a = await rig({ legacy: false })
    for (let i = 1; i <= 5; i++) await a.send(S1, 'session.row', row({ userRows: i, toolCalls: i }))
    await tick()
    const b = await rig({ legacy: false })
    await b.send(S1, 'session.row', row({ userRows: 5, toolCalls: 5 }))
    await tick()
    expect(a.adapter.latest(S1)).toEqual(b.adapter.latest(S1))
  })

  it('a row from a binding without sense.row enabled is ignored and proves nothing', async () => {
    const x = await rig({ legacy: false, declared: ['sense.identity'] })
    await x.send(S1, 'session.row', row())
    await tick()
    expect(x.adapter.latest(S1)).toBeNull()
    expect(x.adapter.diagnostics().notEnabled).toBe(1)
    expect(x.host.facade.getBinding(S1)?.proven ?? []).not.toContain('sense.row')
  })

  it('a /clear starts a fresh row under the new sid; the old one is forgotten', async () => {
    const x = await rig({ legacy: false })
    await x.send(S1, 'session.row', row({ userRows: 7 }))
    await x.send(S1, 'session.rebound', { prevSid: S1, sid: S2, cause: 'clear' })
    await tick()
    expect(x.adapter.latest(S1)).toBeNull()
    expect(x.adapter.latest(S2)).toBeNull()
    await x.send(S2, 'session.row', row({ userRows: 1, firstPrompt: null }))
    await tick()
    expect(x.adapter.latest(S2)?.userRows).toBe(1)
  })

  it('the end of the binding drops its values', async () => {
    const x = await rig({ legacy: false })
    await x.send(S1, 'session.row', row())
    await x.send(S1, 'session.end', { reason: 'exit' })
    await tick()
    expect(x.adapter.latest(S1)).toBeNull()
  })

  it('no text at rest: diagnostics and every file the host wrote carry none', async () => {
    const x = await rig()
    writeTranscript(x.transcript, 1_790_000_000_000)
    await x.start()
    for (let i = 0; i < 20; i++) await x.send(S1, 'session.row', row({ toolCalls: i }))
    await x.send(S1, 'turn.completed', { reason: 'answer', backgroundSubagents: 0 })
    await tick()
    await x.settle()
    const diag = JSON.stringify(x.adapter.diagnostics())
    for (const w of WORDS) expect(diag).not.toContain(w)
    const files = allFiles(x.dir)
    expect(files.some((f) => f.endsWith(join('parity', 'row.ndjson')))).toBe(true)
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      for (const w of WORDS) expect({ f, has: text.includes(w) }).toEqual({ f, has: false })
    }
  })
})

describe('the parity stream end to end (AC-7)', () => {
  it('at a main-loop turn end, one record per group, all matching the real reader', async () => {
    const x = await rig()
    writeTranscript(x.transcript, 1_790_000_000_000)
    await x.start()
    await x.send(S1, 'session.row', row())
    await x.send(S1, 'turn.completed', { reason: 'answer', backgroundSubagents: 0 })
    await tick()
    await x.settle()
    const recs = x.ledger.read('row')
    expect(recs.map((r) => r.k)).toEqual([
      'group:prompt',
      'group:count',
      'group:activity',
      'group:assistant',
      'group:title',
      'group:tools'
    ])
    for (const r of recs) {
      expect(Object.keys(r.d ?? {}).sort()).toEqual([
        'cls',
        'group',
        'lenLegacy',
        'lenPush',
        'verdict'
      ])
      expect({ k: r.k, v: r.d?.verdict, c: r.d?.cls }).toEqual({ k: r.k, v: 'match', c: 'none' })
    }
  })

  it("a subagent's turn end writes nothing", async () => {
    const x = await rig()
    writeTranscript(x.transcript, 1_790_000_000_000)
    await x.start()
    await x.send(S1, 'session.row', row())
    await x.sendEv(S1, {
      t: 'turn.completed',
      agentId: 'agent-1',
      d: { reason: 'answer', backgroundSubagents: 0 }
    })
    await tick()
    await x.settle()
    expect(x.ledger.read('row')).toEqual([])
  })

  it('with no validated transcript path, every group is recorded `no-legacy`', async () => {
    const x = await rig()
    writeTranscript(x.transcript, 1_790_000_000_000)
    await x.send(S1, 'session.row', row())
    await x.send(S1, 'turn.completed', { reason: 'answer', backgroundSubagents: 0 })
    await tick()
    await x.settle()
    const recs = x.ledger.read('row')
    expect(recs).toHaveLength(6)
    for (const r of recs) expect(r.d?.verdict).toBe('no-legacy')
  })

  it('a headless session (claude -p) with no pushed last prompt is the named class', async () => {
    const x = await rig({ isInteractive: false })
    writeTranscript(x.transcript, 1_790_000_000_000)
    await x.start()
    await x.send(S1, 'session.row', row({ lastPrompt: null }))
    await x.send(S1, 'turn.completed', { reason: 'answer', backgroundSubagents: 0 })
    await tick()
    await x.settle()
    const prompt = x.ledger.read('row').find((r) => r.k === 'group:prompt')
    expect(prompt?.d).toMatchObject({ verdict: 'diverge', cls: 'last:E-HEADLESS' })
  })
})
