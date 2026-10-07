/**
 * The command channel's shell (T389 P2W1 §7.4, §7.5): the order of the checks, the audit before the
 * queue, `command.result` intake, proof and failed proof, and what the lease, the rebound and the
 * kill switch do to a queue.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuditRecord, CommandAuditRecord } from '../../src/main/companion/audit-core'
import { createCommandChannel } from '../../src/main/companion/command-channel'
import { registerGateRow, uiText } from '../../src/main/companion/command-gate-core'
import type { CommandCause } from '../../src/main/companion/command-types'
import { CMD_TTL_MS, LEASE_TTL_MS } from '../../src/main/companion/contract'
import {
  computeEnable,
  registerP1FeaturePolicies,
  resetFeaturePoliciesForTests
} from '../../src/main/companion/feature-policy'
import { registerChannelPolicies } from '../../src/main/companion/command-channel'
import {
  registerPrefsKey,
  resetPrefsKeysForTests,
  setCompanionCliGate,
  setPrefsKey,
  setCompanionPrefsPath
} from '../../src/main/companion/companion-prefs'
import type { BindingView } from '../../src/main/companion/session-table'
import { channelRig, sleep } from './support/channel-rig'

const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const r of open.splice(0)) await r.close()
})
const rig = async (o: Parameters<typeof channelRig>[0] = {}) => {
  const r = await channelRig(o)
  open.push(r)
  return r
}

const internal = (subsystem = 'arbitration'): CommandCause => ({ kind: 'internal', subsystem })
const cmdRows = (rows: AuditRecord[]): CommandAuditRecord[] =>
  rows.filter((r): r is CommandAuditRecord => r.kind === 'command')

type Rig = Awaited<ReturnType<typeof rig>>
const flush = (r: Rig) =>
  r.channel.enqueue({ sessionKey: 'key:pty-1', name: 'flush', args: {}, cause: internal() })
const toast = (r: Rig, cause: CommandCause = { kind: 'operator', gesture: 'diagnostics.ping' }) =>
  r.channel.enqueue({
    sessionKey: 'key:pty-1',
    name: 'ui.toast',
    args: { text: uiText('channel-ok') },
    cause
  })

describe('refusals, in the order of the spec', () => {
  it('mod absent refuses at once', async () => {
    const r = await rig()
    // no hello: no binding
    const out = flush(r)
    expect(out).toEqual({ ok: false, reason: 'NO_BINDING' })
    // a refusal is audited, with no cmd
    const rows = cmdRows(r.rows)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ decision: 'NO_BINDING', name: 'flush', phase: 'decision' })
    expect('cmd' in (rows[0] as object)).toBe(false)
    // an unnamed binding is NO_BINDING too
    expect(
      r.channel.enqueue({ sessionKey: null, name: 'flush', args: {}, cause: internal() })
    ).toEqual({ ok: false, reason: 'NO_BINDING' })
  })

  it('NO_LEASE, STICKY_LEGACY, FEATURE_OFF and the channel key', async () => {
    const r = await rig()
    await r.hello()
    r.state.sticky.add('key:pty-1')
    expect(flush(r)).toEqual({ ok: false, reason: 'STICKY_LEGACY' })
    r.state.sticky.clear()
    r.state.mode = 'off'
    expect(flush(r)).toEqual({ ok: false, reason: 'FEATURE_OFF' })
    r.state.mode = 'active'
    r.clock.lease += LEASE_TTL_MS + 1
    expect(flush(r)).toEqual({ ok: false, reason: 'NO_LEASE' })
  })

  it('a feature the binding was not enabled for is FEATURE_OFF', async () => {
    const r = await rig({ enable: ['sense.identity', 'act.channel'] })
    await r.hello()
    expect(flush(r).ok).toBe(true)
    expect(toast(r)).toEqual({ ok: false, reason: 'FEATURE_OFF' })
  })

  it('shadow admits the observe-only set', async () => {
    const r = await rig({ mode: 'shadow' })
    await r.hello()
    expect(flush(r).ok).toBe(true)
    const out = toast(r)
    expect(out).toEqual({ ok: false, reason: 'MODE_SHADOW' })
    const last = cmdRows(r.rows).at(-1)
    expect(last).toMatchObject({ decision: 'MODE_SHADOW', name: 'ui.toast' })
  })

  it('an external binding refuses ui.toast, audited', async () => {
    const rows: AuditRecord[] = []
    const view = {
      key: 1,
      owner: null,
      trust: 'read-only',
      sid: 'sid-ext',
      sessionKey: null,
      cwd: '/work/ext',
      profile: 'external',
      cliVersion: '2.1.290',
      modVersion: '0.1.0',
      declared: [],
      enabled: ['act.channel', 'act.ui'],
      proven: [],
      lease: 'live',
      state: 'bound',
      helloAfterSpawnMs: 0
    } as BindingView
    const channel = createCommandChannel({
      host: {
        bindingForSession: () => null,
        bindingForSid: (sid) => (sid === 'sid-ext' ? view : null),
        bus: { on: () => () => undefined },
        hold: () => () => undefined,
        markProven: () => undefined,
        onBindingChange: () => () => undefined,
        registerEventTypes: () => undefined,
        setCommandSource: () => undefined,
        setPollHandler: () => undefined
      },
      bootId: () => 'b_x',
      channelMode: () => 'active',
      appendAudit: (rec) => void rows.push(rec),
      isStickyLegacy: () => false,
      reportFailedProof: () => undefined
    })
    const out = channel.enqueue({
      sessionKey: null,
      sid: 'sid-ext',
      name: 'ui.toast',
      args: { text: uiText('channel-ok') },
      cause: { kind: 'operator', gesture: 'diagnostics.ping' }
    })
    channel.dispose()
    expect(out).toEqual({ ok: false, reason: 'EXTERNAL' })
    expect(cmdRows(rows)[0]).toMatchObject({ decision: 'EXTERNAL', name: 'ui.toast' })
  })

  it('origin: abort and compact have no caller but the debug gesture', async () => {
    const r = await rig()
    await r.hello()
    for (const cause of [
      internal(),
      { kind: 'verb', verb: 'message_session' } as const,
      { kind: 'operator', gesture: 'anything' } as const,
      { kind: 'operator', gesture: 'debug' } as const // the route is not registered
    ]) {
      expect(
        r.channel.enqueue({ sessionKey: 'key:pty-1', name: 'turn.abort', args: {}, cause })
      ).toEqual({
        ok: false,
        reason: 'ORIGIN_DENIED'
      })
      expect(
        r.channel.enqueue({ sessionKey: 'key:pty-1', name: 'session.compact', args: {}, cause })
      ).toEqual({ ok: false, reason: 'ORIGIN_DENIED' })
    }
  })

  it('the debug gesture opens only with the route registered', async () => {
    const r = await rig({ debug: true })
    await r.hello()
    const out = r.channel.enqueue({
      sessionKey: 'key:pty-1',
      name: 'turn.abort',
      args: {},
      cause: { kind: 'operator', gesture: 'debug' }
    })
    expect(out.ok).toBe(true)
  })

  it('target: a verb needs a Harnu-spawned session and an unblocked folder', async () => {
    registerGateRow('sentinel.set', {
      feature: 'gate.sentinel',
      verb: ['unit_test_verb'],
      validate: () => true
    })
    const r = await rig({
      enable: ['sense.identity', 'act.channel', 'gate.sentinel'],
      declared: ['sense.identity', 'act.channel', 'gate.sentinel']
    })
    await r.hello()
    const ask = () =>
      r.channel.enqueue({
        sessionKey: 'key:pty-1',
        name: 'sentinel.set',
        args: { tools: [] },
        cause: { kind: 'verb', verb: 'unit_test_verb' }
      })
    r.state.verbTarget = 'operator_owned'
    expect(ask()).toEqual({ ok: false, reason: 'TARGET_DENIED' })
    r.state.verbTarget = 'ok'
    r.state.blockedFolders.add('/work/example-web')
    expect(ask()).toEqual({ ok: false, reason: 'FOLDER_BLOCKED' })
    r.state.blockedFolders.clear()
    expect(ask().ok).toBe(true)
  })

  it('arguments: BAD_ARGS, never queued', async () => {
    const r = await rig()
    await r.hello()
    const out = r.channel.enqueue({
      sessionKey: 'key:pty-1',
      name: 'session.compact',
      args: { instructions: 'be brief' } as never,
      cause: { kind: 'operator', gesture: 'debug' }
    })
    // origin is checked first: the debug route is off, so this is refused there
    expect(out).toEqual({ ok: false, reason: 'ORIGIN_DENIED' })
    const bad = r.channel.enqueue({
      sessionKey: 'key:pty-1',
      name: 'config.update',
      args: { config: { pollHoldMs: 999_999 } },
      cause: internal('prefs')
    })
    expect(bad).toEqual({ ok: false, reason: 'BAD_ARGS' })
    expect(r.channel.inspect().live).toBe(0)
  })

  it('QUEUE_FULL is audited', async () => {
    const r = await rig()
    await r.hello()
    for (let i = 0; i < 64; i++) {
      // distinct texts do not matter: ui.toast never coalesces
      expect(toast(r).ok).toBe(true)
    }
    expect(toast(r)).toEqual({ ok: false, reason: 'QUEUE_FULL' })
    expect(cmdRows(r.rows).at(-1)).toMatchObject({ decision: 'QUEUE_FULL' })
  })
})

describe('audit before the queue (SEC-6)', () => {
  it('no audit, no command', async () => {
    const r = await rig()
    await r.hello()
    r.state.auditFails = true
    const out = flush(r)
    expect(out).toEqual({ ok: false, reason: 'AUDIT_FAILED' })
    expect(r.channel.inspect().live).toBe(0)
    r.state.auditFails = false
    expect(flush(r).ok).toBe(true)
  })

  it('a decision row, then an outcome row sharing the cmd', async () => {
    const r = await rig()
    const { conn } = await r.hello()
    const out = flush(r)
    if (!out.ok) throw new Error('refused')
    await r.poll(conn)
    await r.result(conn, { cmd: out.cmd, ok: true })
    expect(await out.settled).toEqual({ state: 'resulted', ok: true })
    const rows = cmdRows(r.rows).filter((x) => x.cmd === out.cmd)
    expect(rows.map((x) => x.phase)).toEqual(['decision', 'outcome'])
    expect(rows[0]).toMatchObject({
      decision: 'queued',
      n: 1,
      folder: '/work/example-web',
      sessionKey: 'key:pty-1'
    })
    expect(rows[1]).toMatchObject({ outcome: { state: 'resulted', ok: true } })
    expect(rows[0]?.cause).toEqual(internal())
  })

  it('rows carry no conn, no token and no text', async () => {
    const r = await rig()
    const { conn } = await r.hello()
    toast(r)
    flush(r)
    const text = JSON.stringify(r.rows)
    expect(text).not.toContain(conn)
    expect(text).not.toContain(uiText('channel-ok'))
    expect(text).not.toMatch(/sp_[0-9a-f-]{36}/)
  })
})

describe('results, proof and failed proof', () => {
  it('a successful result proves the feature', async () => {
    const r = await rig()
    const { conn } = await r.hello()
    expect(r.view().proven).not.toContain('act.channel')
    const out = flush(r)
    if (!out.ok) throw new Error('refused')
    await r.poll(conn)
    await r.result(conn, { cmd: out.cmd, ok: true })
    await out.settled
    expect(r.view().proven).toContain('act.channel')
  })

  it('a failed result is neither a proof nor a failed proof', async () => {
    const r = await rig()
    const { conn } = await r.hello()
    const out = toast(r)
    if (!out.ok) throw new Error('refused')
    await r.poll(conn)
    await r.result(conn, {
      cmd: out.cmd,
      ok: false,
      code: 'CMD_PRECONDITION',
      message: 'a turn is running'
    })
    expect(await out.settled).toMatchObject({
      state: 'resulted',
      ok: false,
      code: 'CMD_PRECONDITION'
    })
    expect(r.view().proven).not.toContain('act.ui')
    expect(r.state.failedProofs).toEqual([])
  })

  it('a delivered command with no result is lost: a failed proof', async () => {
    const r = await rig()
    const { conn } = await r.hello()
    const out = flush(r)
    if (!out.ok) throw new Error('refused')
    await r.poll(conn)
    r.channel.pendingFor(r.view(), 1) // the cursor now covers it
    r.clock.epoch += CMD_TTL_MS + 5_000
    r.channel.pendingFor(r.view()) // any touch sweeps
    expect(await out.settled).toEqual({ state: 'lost' })
    expect(r.state.failedProofs).toEqual([{ key: 'key:pty-1', feature: 'act.channel' }])
  })

  it('an undelivered command expires and is not a failed proof', async () => {
    const r = await rig()
    await r.hello()
    const out = flush(r)
    if (!out.ok) throw new Error('refused')
    r.clock.epoch += CMD_TTL_MS
    r.channel.pendingFor(r.view())
    expect(await out.settled).toEqual({ state: 'expired' })
    expect(r.state.failedProofs).toEqual([])
  })

  it('a result for a command of another binding settles nothing', async () => {
    const r = await rig()
    const a = await r.hello('pty-1')
    const b = await r.hello('pty-2')
    const out = flush(r)
    if (!out.ok) throw new Error('refused')
    await r.result(b.conn, { cmd: out.cmd, ok: true }) // forged by the other session's mod
    expect(r.channel.inspect().live).toBe(1)
    expect(r.view('pty-1').proven).not.toContain('act.channel')
    await r.poll(a.conn)
    await r.result(a.conn, { cmd: out.cmd, ok: true })
    expect(await out.settled).toMatchObject({ state: 'resulted' })
  })

  it('malformed and duplicate results are ignored', async () => {
    const r = await rig()
    const { conn } = await r.hello()
    const out = flush(r)
    if (!out.ok) throw new Error('refused')
    await r.result(conn, { cmd: 5, ok: true })
    await r.result(conn, { cmd: out.cmd, ok: 'yes' })
    await r.result(conn, { cmd: 'cmd_unknown', ok: true })
    expect(r.channel.inspect().live).toBe(1)
    await r.result(conn, { cmd: out.cmd, ok: true, message: 'x'.repeat(5000), code: 'NOT_A_CODE' })
    const settled = await out.settled
    expect(settled).toMatchObject({ state: 'resulted', ok: true })
    expect((settled as { message: string }).message.length).toBe(512) // capped
    expect(settled).not.toHaveProperty('code') // an unknown code is dropped
    await r.result(conn, { cmd: out.cmd, ok: false })
    expect(await out.settled).toBe(settled) // the first wins
  })
})

describe('what ends a queue', () => {
  it('lease loss settles everything', async () => {
    const r = await rig()
    await r.hello()
    const a = flush(r)
    const b = toast(r)
    if (!a.ok || !b.ok) throw new Error('refused')
    r.channel.pendingFor(r.view(), 1) // the flush is delivered, the toast is not
    r.clock.lease += LEASE_TTL_MS + 1
    r.core.sweepNow() // one sweep
    expect(await a.settled).toEqual({ state: 'dropped', why: 'lease-lost', delivered: true })
    expect(await b.settled).toEqual({ state: 'dropped', why: 'lease-lost', delivered: false })
    expect(r.channel.inspect().live).toBe(0)
  })

  it('kill switch drops the queue', async () => {
    const r = await rig({ pollHoldMs: 5_000 })
    const { conn } = await r.hello()
    const parked = r.poll(conn)
    await sleep(40)
    const out = toast(r)
    expect(out.ok).toBe(true) // answers the parked poll
    await parked
    const second = r.poll(conn, { cursor: 1 })
    await sleep(40)
    const queued = r.channel.enqueue({
      sessionKey: 'key:pty-1',
      name: 'ui.status',
      args: { text: uiText('status-test') },
      cause: internal()
    })
    await second // the status answered the park
    const third = r.poll(conn, { cursor: 2 })
    await sleep(40)
    r.killSwitch()
    await sleep(40)
    expect((await third).json).toMatchObject({ ok: false, code: 'STALE_CONN' })
    if (!out.ok || !queued.ok) throw new Error('refused')
    expect(await queued.settled).toEqual({ state: 'dropped', why: 'revoked', delivered: true })
    expect(await out.settled).toEqual({ state: 'dropped', why: 'revoked', delivered: true })
    expect(r.channel.inspect()).toEqual({ parked: 0, live: 0 })
  })

  it('a bye ends the session and settles the queue', async () => {
    const r = await rig()
    const { conn } = await r.hello()
    const out = toast(r)
    if (!out.ok) throw new Error('refused')
    const { post } = await import('./support/client')
    await post(r.ep, 'bye', {
      body: { v: 1, sid: r.view().sid, conn, sentAt: 1, reason: 'other' }
    })
    await sleep(40)
    expect(await out.settled).toEqual({ state: 'dropped', why: 'session-end', delivered: false })
  })

  it('shutdown answers parked polls and drops the queues', async () => {
    const r = await rig({ pollHoldMs: 5_000 })
    const { conn } = await r.hello()
    const parked = r.poll(conn)
    await sleep(40)
    // a second binding keeps a queued command that nobody polls
    const b = await r.hello('pty-2')
    void b
    const out = r.channel.enqueue({
      sessionKey: 'key:pty-2',
      name: 'ui.toast',
      args: { text: uiText('channel-ok') },
      cause: { kind: 'operator', gesture: 'diagnostics.ping' }
    })
    if (!out.ok) throw new Error('refused')
    r.channel.shutdown()
    expect((await parked).json).toMatchObject({ ok: false, code: 'HOST_SHUTTING_DOWN' })
    expect(await out.settled).toEqual({ state: 'dropped', why: 'host-shutdown', delivered: false })
    expect(r.channel.inspect()).toEqual({ parked: 0, live: 0 })
    const last = cmdRows(r.rows).at(-1)
    expect(last).toMatchObject({
      phase: 'outcome',
      outcome: { state: 'dropped', why: 'host-shutdown' }
    })
  })

  it('cancelIfUndelivered cancels only an undelivered command', async () => {
    const r = await rig()
    await r.hello()
    const a = toast(r)
    const b = toast(r)
    if (!a.ok || !b.ok) throw new Error('refused')
    r.channel.pendingFor(r.view(), a.n) // a is delivered
    expect(r.channel.cancelIfUndelivered(a.cmd)).toBe(false)
    expect(r.channel.cancelIfUndelivered(b.cmd)).toBe(true)
    expect(await b.settled).toEqual({ state: 'dropped', why: 'cancelled', delivered: false })
  })
})

describe('coalescing through the shell', () => {
  it('a replaced ui.status settles as cancelled and a deduped flush shares one outcome', async () => {
    const r = await rig()
    await r.hello()
    const status = (text: 'status-test' | 'channel-ok') =>
      r.channel.enqueue({
        sessionKey: 'key:pty-1',
        name: 'ui.status',
        args: { text: uiText(text) },
        cause: internal()
      })
    const one = status('status-test')
    const two = status('channel-ok')
    if (!one.ok || !two.ok) throw new Error('refused')
    expect(await one.settled).toEqual({ state: 'dropped', why: 'cancelled', delivered: false })
    const f1 = flush(r)
    const f2 = flush(r)
    if (!f1.ok || !f2.ok) throw new Error('refused')
    expect(f2.cmd).toBe(f1.cmd)
    expect(f2.settled).toBe(f1.settled)
  })
})

describe('rollout rows', () => {
  it('act.channel follows the key; the other three need active', () => {
    resetPrefsKeysForTests()
    resetFeaturePoliciesForTests()
    registerP1FeaturePolicies()
    registerChannelPolicies()
    setCompanionPrefsPath(null)
    setCompanionCliGate('ok')
    const binding = {
      key: 1,
      owner: null,
      trust: 'operator',
      sid: 's',
      sessionKey: 'k',
      cwd: '/work/x',
      profile: 'interactive',
      cliVersion: '2.1.290',
      modVersion: '0.1.0',
      declared: [],
      enabled: [],
      proven: [],
      lease: 'live',
      state: 'bound',
      helloAfterSpawnMs: 0
    } as BindingView
    const declared = ['act.channel', 'act.turn', 'act.compact', 'act.ui']
    const rollout = {
      enabled: true,
      cliGate: 'ok',
      families: {},
      allFolders: true,
      rampFolders: new Set<string>()
    } as never
    const enable = (): string[] =>
      computeEnable(declared, {
        profile: 'interactive',
        folder: '/work/x',
        rollout,
        trust: 'operator',
        binding
      })
    // default key: shadow
    expect(enable()).toEqual(['act.channel'])
    setPrefsKey('channel', 'active')
    expect(enable()).toEqual(declared)
    setPrefsKey('channel', 'off')
    expect(enable()).toEqual([])
    // junk in the file reads as the default
    setPrefsKey('channel', 'nonsense')
    expect(enable()).toEqual(['act.channel'])
    resetPrefsKeysForTests()
    resetFeaturePoliciesForTests()
    registerP1FeaturePolicies()
    registerChannelPolicies()
    void registerPrefsKey
  })

  it('a CLI above the ceiling caps the key at shadow', () => {
    resetPrefsKeysForTests()
    registerChannelPolicies()
    setCompanionPrefsPath(null)
    setPrefsKey('channel', 'active')
    setCompanionCliGate('above')
    const spec = readFileSync(
      join(__dirname, '../../src/main/companion/command-channel.ts'),
      'utf8'
    )
    expect(spec).toContain("observeCap: 'shadow'")
    setCompanionCliGate('ok')
  })
})

describe('single entry point (SEC-5, SEC-9.1)', () => {
  const root = join(__dirname, '../../src/main')
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
    })
  const files = walk(root)

  it('nothing writes to a queue outside command-channel.ts', () => {
    const offenders = files.filter((f) => {
      if (f.endsWith('command-channel.ts') || f.endsWith('command-queue-core.ts')) return false
      return /\b(commitEnqueue|enqueueCommand|planEnqueue)\s*\(/.test(readFileSync(f, 'utf8'))
    })
    expect(offenders).toEqual([])
  })

  it('an operator cause is built only in files that register ipcMain handlers', () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8')
      const builds = /kind:\s*'operator'\s*,\s*gesture:/.test(src)
      return builds && !/ipcMain\.handle\(/.test(src)
    })
    expect(offenders).toEqual([])
  })

  it('a verb cause is built only in files under mcp/', () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8')
      return /kind:\s*'verb'\s*,\s*verb:/.test(src) && !f.includes('/mcp/')
    })
    expect(offenders).toEqual([])
  })
})
