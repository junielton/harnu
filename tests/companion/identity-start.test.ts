import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { helloSpawnRequest } from '../../resources/companion/tests/fixtures/hello'
import type { Conn, EndpointFile } from '../../src/main/companion/contract'
import { createIdentityAdapter } from '../../src/main/companion/identity-adapter'
import { checkTranscriptPath, type PathFs } from '../../src/main/companion/transcript-path'
import { post } from './support/client'
import { createCompanionHost, fakeMode, shortTmp, tick } from './support/host-rig'

/**
 * T455 W2 AC-5 / AC-6: the claim's `transcriptPath` (validated by the host, never trusted from the
 * mod) and `lineage` (from Harnu's PTY record, never from the mod). Hostile paths included.
 */

const S1 = helloSpawnRequest.sid
const S2 = '22222222-2222-4222-8222-222222222222'
const SRC = '33333333-3333-4333-8333-333333333333'
const dirs: string[] = []
const closers: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A temp `~/.claude/projects` with one slug dir; the realpath, since tmpdir may be a link. */
function projectsRoot(): { root: string; slug: string; outside: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tp-')))
  dirs.push(base)
  const root = join(base, 'projects')
  const slug = join(root, '-tmp-example-project')
  const outside = join(base, 'elsewhere')
  mkdirSync(slug, { recursive: true })
  mkdirSync(outside, { recursive: true })
  return { root, slug, outside }
}

/** An fs double that records every path touched. */
function spyFs(): PathFs & { touched: string[] } {
  const touched: string[] = []
  return {
    touched,
    realpath: (p) => {
      touched.push(p)
      return realpathSync(p)
    },
    exists: (p) => {
      touched.push(p)
      try {
        realpathSync(p)
        return true
      } catch {
        return false
      }
    }
  }
}

describe('checkTranscriptPath (AC-5)', () => {
  it('keeps <root>/<slug>/<sid>.jsonl, whether or not the file exists yet', () => {
    const { root, slug } = projectsRoot()
    const p = join(slug, `${S1}.jsonl`)
    expect(checkTranscriptPath(p, S1, root)).toEqual({ ok: true, path: p })
    writeFileSync(p, '')
    expect(checkTranscriptPath(p, S1, root)).toEqual({ ok: true, path: p })
  })

  const hostile = (root: string, slug: string, outside: string): [string, unknown, string][] => [
    ['not a string', 42, 'type'],
    ['empty', '', 'length'],
    ['over 4,096 chars', `${slug}/${'a'.repeat(4096)}/${S1}.jsonl`, 'length'],
    ['a NUL byte', `${slug}/${S1}.jsonl\u0000.txt`, 'nul'],
    ['relative', `-tmp-example-project/${S1}.jsonl`, 'relative'],
    ['.. traversal out of the root', `${slug}/../../elsewhere/${S1}.jsonl`, 'traversal'],
    ['.. traversal that stays inside', `${slug}/../-tmp-example-project/${S1}.jsonl`, 'traversal'],
    ['a . segment', `${slug}/./${S1}.jsonl`, 'traversal'],
    ['outside the root', `${outside}/${S1}.jsonl`, 'outside-root'],
    ['a sibling dir sharing the prefix', `${root}-evil/x/${S1}.jsonl`, 'outside-root'],
    ['the root itself', `${root}/${S1}.jsonl`, 'depth'],
    ['too deep', `${slug}/${S1}/subagents/${S1}.jsonl`, 'depth'],
    ['another sid', `${slug}/${S2}.jsonl`, 'basename'],
    ['not a jsonl', `${slug}/${S1}.json`, 'basename'],
    ['double slashes', `${slug}//${S1}.jsonl`, 'traversal']
  ]

  it('drops every hostile shape, with the reason', () => {
    const { root, slug, outside } = projectsRoot()
    for (const [name, raw, why] of hostile(root, slug, outside)) {
      expect({ name, r: checkTranscriptPath(raw, S1, root) }).toEqual({
        name,
        r: { ok: false, why }
      })
    }
  })

  it('never touches the file system for a path the lexical checks refuse', () => {
    const { root, slug, outside } = projectsRoot()
    for (const [, raw] of hostile(root, slug, outside)) {
      const fs = spyFs()
      checkTranscriptPath(raw, S1, root, fs)
      expect(fs.touched).toEqual([])
    }
    // and a kept path touches only the root and paths under it
    const fs = spyFs()
    checkTranscriptPath(join(slug, `${S1}.jsonl`), S1, root, fs)
    expect(fs.touched.length).toBeGreaterThan(0)
    for (const p of fs.touched) expect(p === root || p.startsWith(`${root}/`)).toBe(true)
  })

  it('drops a slug dir that is a symlink escaping the root', () => {
    const { root, outside } = projectsRoot()
    symlinkSync(outside, join(root, '-tmp-linked'))
    const p = join(root, '-tmp-linked', `${S1}.jsonl`)
    expect(checkTranscriptPath(p, S1, root)).toEqual({ ok: false, why: 'symlink-escape' })
  })

  it('drops a transcript that is a symlink escaping the root, or naming another file', () => {
    const { root, slug, outside } = projectsRoot()
    writeFileSync(join(outside, 'target.jsonl'), '')
    symlinkSync(join(outside, 'target.jsonl'), join(slug, `${S1}.jsonl`))
    expect(checkTranscriptPath(join(slug, `${S1}.jsonl`), S1, root)).toEqual({
      ok: false,
      why: 'symlink-escape'
    })
    writeFileSync(join(slug, `${S2}.jsonl`), '')
    symlinkSync(join(slug, `${S2}.jsonl`), join(slug, `${SRC}.jsonl`))
    expect(checkTranscriptPath(join(slug, `${SRC}.jsonl`), SRC, root)).toEqual({
      ok: false,
      why: 'symlink-escape'
    })
  })

  it('refuses a sid that cannot be a file name', () => {
    const { root, slug } = projectsRoot()
    expect(checkTranscriptPath(join(slug, '..jsonl'), '.', root)).toEqual({
      ok: false,
      why: 'bad-sid'
    })
  })
})

// ---- the identity adapter: start, rebound, claim facts and lineage ------------------------------

async function rig(opts: { kind?: string | (() => string); source?: string | null } = {}) {
  const { root, slug, outside } = projectsRoot()
  const dir = join(shortTmp('hc-is-'), 'companion')
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
  host.facade.setEnablePolicy((b) => b.declared.filter((f) => f === 'sense.identity'))
  const lineage: unknown[] = []
  const pushes: unknown[] = []
  const adapter = createIdentityAdapter({
    host: host.facade,
    getMode: m.mode.getMode,
    gateOf: () => 'ok',
    push: (c) => void pushes.push(c),
    spawnKind: () => (typeof opts.kind === 'function' ? opts.kind() : (opts.kind ?? 'claude-new')),
    spawnSource: () => opts.source ?? null,
    projectsRoot: () => root,
    onLineage: (e) => void lineage.push(e)
  })
  closers.push(() => adapter.dispose())
  const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
  const token = host.facade.mintSpawnToken({
    owner: { kind: 'pty', ptyId: 'p1' },
    trust: 'operator',
    cwd: '/tmp/example-project'
  })!
  const hello = await post(ep, 'hello', { body: { ...helloSpawnRequest, spawn: token } })
  const conn = hello.json.conn as Conn
  let seq = 0
  const send = (sid: string, t: string, d: unknown) =>
    post(ep, 'events', {
      body: { v: 1, sid, conn, sentAt: 1, events: [{ seq: ++seq, t, ts: seq, d }] }
    })
  const snapshot = (start?: unknown) => ({
    reason: 'probe',
    activeTurnId: null,
    openAttention: [],
    runningSubagents: 0,
    probes: { classic: true, toolCheck: false },
    ...(start === undefined ? {} : { start })
  })
  const binding = () => host.facade.getBinding('synthetic-aaaa')!
  return { root, slug, outside, host, adapter, send, snapshot, lineage, pushes, binding }
}

describe('claim facts (AC-5)', () => {
  it('a snapshot `start` gives the claim its validated transcriptPath', async () => {
    const x = await rig()
    const p = join(x.slug, `${S1}.jsonl`)
    await x.send(S1, 'session.snapshot', x.snapshot({ source: 'startup', transcriptPath: p }))
    await tick()
    expect(x.adapter.claimFacts()).toEqual([
      {
        key: 'synthetic-aaaa',
        sid: S1,
        cause: 'spawn',
        act: false,
        transcriptPath: p,
        lineage: { kind: 'new', from: null }
      }
    ])
    expect(x.adapter.transcriptPathOf(x.binding())).toBe(p)
    expect(x.adapter.startOf(x.binding())).toEqual({ source: 'startup', transcriptPath: p })
  })

  it('keeps the last start on a snapshot without one (a mod hot reload)', async () => {
    const x = await rig()
    const p = join(x.slug, `${S1}.jsonl`)
    await x.send(S1, 'session.snapshot', x.snapshot({ source: 'startup', transcriptPath: p }))
    await x.send(S1, 'session.snapshot', x.snapshot())
    await x.send(S1, 'session.snapshot', { reason: 'hello' })
    await tick()
    expect(x.adapter.transcriptPathOf(x.binding())).toBe(p)
  })

  it('a hostile path is dropped and counted; the watcher stays the only proof', async () => {
    const x = await rig()
    const hostile = [
      `${x.outside}/${S1}.jsonl`,
      `${x.slug}/../../elsewhere/${S1}.jsonl`,
      `relative/${S1}.jsonl`,
      `${x.slug}/${S2}.jsonl`,
      `${x.slug}/${S1}.jsonl\u0000`
    ]
    for (const transcriptPath of hostile) {
      await x.send(S1, 'session.snapshot', x.snapshot({ source: 'startup', transcriptPath }))
    }
    await tick()
    expect(x.adapter.transcriptPathOf(x.binding())).toBeNull()
    expect(x.adapter.claimFacts()[0]?.transcriptPath).toBeNull()
    const drops = x.adapter.pathDrops()
    expect(Object.values(drops).reduce((a, b) => a + (b ?? 0), 0)).toBe(hostile.length)
    // a good start after the bad ones is still taken; a bad one never clears a good one
    const p = join(x.slug, `${S1}.jsonl`)
    await x.send(S1, 'session.snapshot', x.snapshot({ source: 'startup', transcriptPath: p }))
    await x.send(
      S1,
      'session.snapshot',
      x.snapshot({ source: 'startup', transcriptPath: hostile[0] })
    )
    await tick()
    expect(x.adapter.transcriptPathOf(x.binding())).toBe(p)
  })

  it('a malformed `start` (wrong type, long path) is ignored, never fatal', async () => {
    const x = await rig()
    await x.send(S1, 'session.snapshot', x.snapshot({ source: 'nope', transcriptPath: '/x' }))
    await x.send(S1, 'session.snapshot', x.snapshot({ source: 'startup', transcriptPath: 7 }))
    await tick()
    expect(x.adapter.transcriptPathOf(x.binding())).toBeNull()
    expect(x.adapter.claims()).toHaveLength(1)
  })

  it('the renderer push keeps its P1W3 shape in shadow: no path, no lineage', async () => {
    const x = await rig()
    const before = JSON.stringify(x.pushes.at(-1))
    await x.send(
      S1,
      'session.snapshot',
      x.snapshot({ source: 'startup', transcriptPath: join(x.slug, `${S1}.jsonl`) })
    )
    await tick()
    expect(JSON.stringify(x.pushes.at(-1))).toBe(before)
    expect(x.adapter.claims()).toEqual([
      { key: 'synthetic-aaaa', sid: S1, cause: 'spawn', act: false }
    ])
  })

  it('a /clear rebound carries the new conversation path, validated for the new sid', async () => {
    const x = await rig()
    await x.send(S1, 'session.rebound', {
      prevSid: S1,
      sid: S2,
      cause: 'clear',
      transcriptPath: join(x.slug, `${S2}.jsonl`)
    })
    await tick()
    const facts = x.adapter.claimFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({
      sid: S2,
      cause: 'clear',
      transcriptPath: join(x.slug, `${S2}.jsonl`),
      lineage: { kind: 'new', from: S1 }
    })
    expect(x.lineage).toEqual([{ sid: S2, kind: 'new', from: S1 }])
  })

  it('a rebound path naming the OLD sid is dropped', async () => {
    const x = await rig()
    await x.send(S1, 'session.rebound', {
      prevSid: S1,
      sid: S2,
      cause: 'resume',
      transcriptPath: join(x.slug, `${S1}.jsonl`)
    })
    await tick()
    expect(x.adapter.claimFacts()[0]).toMatchObject({
      sid: S2,
      transcriptPath: null,
      lineage: { kind: 'resume', from: S1 }
    })
  })
})

describe('lineage from the PTY record, never from the mod (AC-6)', () => {
  it('a fork names its source; it is persisted once', async () => {
    const x = await rig({ kind: 'claude-fork', source: SRC })
    await tick()
    expect(x.adapter.lineageOf(x.binding())).toEqual({ kind: 'fork', from: SRC })
    await x.send(S1, 'session.snapshot', x.snapshot({ source: 'fork', transcriptPath: '/x' }))
    await tick()
    expect(x.lineage).toEqual([{ sid: S1, kind: 'fork', from: SRC }])
  })

  it('a new session has no parent and persists nothing', async () => {
    const x = await rig({ kind: 'claude-new' })
    await tick()
    expect(x.adapter.lineageOf(x.binding())).toEqual({ kind: 'new', from: null })
    expect(x.lineage).toEqual([])
  })

  it("the mod's `start.source` never sets the lineage", async () => {
    const x = await rig({ kind: 'claude-new' })
    await x.send(
      S1,
      'session.snapshot',
      x.snapshot({ source: 'fork', transcriptPath: join(x.slug, `${S1}.jsonl`) })
    )
    await tick()
    expect(x.adapter.lineageOf(x.binding())).toEqual({ kind: 'new', from: null })
    expect(x.lineage).toEqual([])
  })
})

describe('lineage is frozen at the first sight of a conversation (AC-6)', () => {
  it('a migration that rewrites the PTY kind (fork → resume) does not turn a fork into a resume', async () => {
    const kind = { value: 'claude-fork' }
    const x = await rig({ kind: () => kind.value, source: SRC })
    await tick()
    expect(x.adapter.lineageOf(x.binding())).toEqual({ kind: 'fork', from: SRC })
    kind.value = 'claude-resume' // what `pty.ts` does to the record at the synth→real re-key
    expect(x.adapter.lineageOf(x.binding())).toEqual({ kind: 'fork', from: SRC })
    expect(x.lineage).toEqual([{ sid: S1, kind: 'fork', from: SRC }])
  })
})
