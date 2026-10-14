import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EventPayloads } from '../../resources/companion/hooks/contract'
import { helloSpawnRequest } from '../../resources/companion/tests/fixtures/hello'
import type { Conn, EndpointFile } from '../../src/main/companion/contract'
import { createRowAdapter, ROW_MALFORMED_REVOKE } from '../../src/main/companion/ingest/row-adapter'
import { createSessionArbiter } from '../../src/main/companion/session-arbiter'
import {
  MAX_ROW_UUID_LEN,
  validateSessionRow,
  validateStartFacts
} from '../../src/main/companion/wire-core'
import { post } from './support/client'
import { createCompanionHost, fakeMode, shortTmp, tick } from './support/host-rig'

/**
 * T455 W2 AC-1: the field caps of `session.row` on top of the 1 MiB body cap (spec §5.3
 * host-side, §10.2). Every row below is synthetic.
 */

type Row = EventPayloads['session.row']

const row = (over: Partial<Row> = {}): Row => ({
  fold: 1,
  firstPrompt: 'list the files',
  lastPrompt: '/hello world',
  lastAssistant: 'Finished.',
  title: null,
  toolCalls: 1,
  subagentToolCalls: 0,
  userRows: 2,
  lastRowAt: 1_790_000_000_500,
  lastUuid: 'aaaaaaaa-0000-4000-8000-000000000001',
  ...over
})

describe('validateSessionRow (AC-1)', () => {
  it('accepts the W1 shape and copies only the fields it knows', () => {
    const r = validateSessionRow({ ...row(), extra: 'ignored', nested: { a: 1 } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual(row())
    expect(Object.keys(r.value)).not.toContain('extra')
    expect(Object.keys(r.value)).not.toContain('nested')
  })

  it('keeps an ABSENT text absent and a null text null', () => {
    const { firstPrompt: _f, lastAssistant: _a, ...rest } = row()
    const r = validateSessionRow({ ...rest, lastPrompt: null })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect('firstPrompt' in r.value).toBe(false)
    expect('lastAssistant' in r.value).toBe(false)
    expect(r.value.lastPrompt).toBeNull()
  })

  it('accepts a text of exactly 240 chars and the counts at zero', () => {
    const r = validateSessionRow(
      row({
        lastAssistant: 'a'.repeat(240),
        toolCalls: 0,
        userRows: 0,
        lastRowAt: null,
        lastUuid: null
      })
    )
    expect(r.ok).toBe(true)
  })

  const bad: [string, unknown][] = [
    ['not an object', 'session.row'],
    ['an array', [row()]],
    ['fold is not 1', { ...row(), fold: 2 }],
    ['fold missing', (({ fold: _x, ...rest }) => rest)(row())],
    ['a text over 240 chars', row({ firstPrompt: 'a'.repeat(241) })],
    ['a text over 300 UTF-8 bytes', row({ lastPrompt: '中'.repeat(120) })],
    ['a text of the wrong type', { ...row(), lastPrompt: 42 }],
    ['a title of the wrong type', { ...row(), title: ['x'] }],
    ['a negative count', row({ userRows: -1 })],
    ['a fractional count', row({ toolCalls: 1.5 })],
    ['a count as a string', { ...row(), subagentToolCalls: '3' }],
    ['a count missing', (({ userRows: _x, ...rest }) => rest)(row())],
    ['lastRowAt as a string', { ...row(), lastRowAt: '1790000000500' }],
    ['lastRowAt negative', row({ lastRowAt: -5 })],
    ['lastRowAt not finite', { ...row(), lastRowAt: Number.POSITIVE_INFINITY }],
    ['lastUuid too long', row({ lastUuid: 'u'.repeat(MAX_ROW_UUID_LEN + 1) })],
    ['lastUuid empty', row({ lastUuid: '' })],
    ['lastUuid of the wrong type', { ...row(), lastUuid: 7 }]
  ]
  for (const [name, value] of bad) {
    it(`refuses ${name}`, () => {
      const r = validateSessionRow(value)
      expect(r.ok).toBe(false)
    })
  }
})

describe('validateStartFacts (AC-1, the snapshot `start`)', () => {
  it('accepts every source with a path of at most 4,096 chars', () => {
    for (const source of ['startup', 'resume', 'clear', 'compact', 'fork'] as const) {
      expect(validateStartFacts({ source, transcriptPath: '/x/y.jsonl' })).toEqual({
        source,
        transcriptPath: '/x/y.jsonl'
      })
    }
    expect(validateStartFacts({ source: 'startup', transcriptPath: 'a'.repeat(4096) })).not.toBe(
      null
    )
  })

  it('refuses a bad source, a long path, a wrong type, and drops unknown fields', () => {
    expect(validateStartFacts({ source: 'boot', transcriptPath: '/x' })).toBeNull()
    expect(validateStartFacts({ source: 'startup', transcriptPath: 'a'.repeat(4097) })).toBeNull()
    expect(validateStartFacts({ source: 'startup', transcriptPath: 5 })).toBeNull()
    expect(validateStartFacts({ source: 'startup', transcriptPath: '' })).toBeNull()
    expect(validateStartFacts(null)).toBeNull()
    expect(validateStartFacts({ source: 'fork', transcriptPath: '/x', more: 1 })).toEqual({
      source: 'fork',
      transcriptPath: '/x'
    })
  })
})

// ---- the adapter: three malformed rows revoke `sense.row` for the binding -----------------------

const SID = helloSpawnRequest.sid
const dirs: string[] = []
const closers: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function rig() {
  const dir = join(shortTmp('hc-rw-'), 'companion')
  dirs.push(join(dir, '..'))
  const m = fakeMode('shadow')
  const host = createCompanionHost({
    dir,
    mode: m.mode,
    log: () => undefined,
    sessionKeyOf: (o) => (o.kind === 'pty' ? `synthetic-${o.ptyId}` : null)
  })
  closers.push(() => host.close())
  await host.register()
  host.facade.setEnablePolicy((b) =>
    b.declared.filter((f) => f === 'sense.identity' || f === 'sense.row')
  )
  const arbiter = createSessionArbiter({
    host: host.facade,
    rollout: () => ({
      enabled: true,
      cliGate: 'ok',
      families: { row: 'active', identity: 'active' },
      allFolders: true,
      rampFolders: new Set()
    })
  })
  closers.push(() => arbiter.dispose())
  const adapter = createRowAdapter({
    host: host.facade,
    transcriptPathOf: () => null,
    lineageOf: () => null,
    legacy: null,
    recordFact: () => undefined
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
  // the identity adapter's proof (a redeemed spawn token), done by hand: it is not wired here
  host.facade.markProven(host.facade.getBinding(SID)!, 'sense.identity')
  let seq = 0
  const send = (d: unknown) =>
    post(ep, 'events', {
      body: {
        v: 1,
        sid: SID,
        conn,
        sentAt: 1,
        events: [{ seq: ++seq, t: 'session.row', ts: seq, d }]
      }
    })
  return { host, arbiter, adapter, send }
}

describe('malformed rows (AC-1, spec §10.2)', () => {
  it('a malformed row is counted and dropped; the last good values stay', async () => {
    const x = await rig()
    await x.send(row({ userRows: 3 }))
    await x.send(row({ userRows: 4, lastPrompt: 'x'.repeat(241) }))
    await tick()
    expect(x.adapter.latest(SID)?.userRows).toBe(3)
    expect(x.adapter.diagnostics().malformed).toBe(1)
    expect(x.host.facade.getBinding(SID)?.proven).toContain('sense.row')
    expect(x.arbiter.ownerFor(SID, 'row').reason).not.toBe('revoked')
  })

  it(`${ROW_MALFORMED_REVOKE} malformed rows in one binding revoke sense.row; legacy wins`, async () => {
    const x = await rig()
    await x.send(row())
    await tick()
    expect(x.arbiter.ownerFor(SID, 'row')).toEqual({ owner: 'companion', reason: 'owned' })
    for (let i = 0; i < ROW_MALFORMED_REVOKE - 1; i++) await x.send({ ...row(), userRows: -1 })
    await tick()
    expect(x.arbiter.ownerFor(SID, 'row').owner).toBe('companion')
    await x.send({ ...row(), fold: 7 })
    await tick()
    expect(x.arbiter.ownerFor(SID, 'row')).toEqual({ owner: 'legacy', reason: 'revoked' })
    expect(x.host.facade.getBinding(SID)?.proven).not.toContain('sense.row')
    // sticky: a good row afterwards is dropped and proves nothing again
    await x.send(row({ userRows: 9 }))
    await tick()
    expect(x.adapter.latest(SID)?.userRows).not.toBe(9)
    expect(x.arbiter.ownerFor(SID, 'row').reason).toBe('revoked')
    // identity is not revoked by a bad row
    expect(x.arbiter.ownerFor(SID, 'identity').reason).not.toBe('revoked')
  })

  it('unknown fields are ignored, never counted as malformed', async () => {
    const x = await rig()
    for (let i = 0; i < 5; i++) await x.send({ ...row(), future: { a: i } })
    await tick()
    expect(x.adapter.diagnostics().malformed).toBe(0)
    expect(x.arbiter.ownerFor(SID, 'row').reason).toBe('owned')
  })
})
