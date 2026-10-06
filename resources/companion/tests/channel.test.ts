/* eslint-disable @typescript-eslint/no-explicit-any -- test code reads wire bodies loosely */
import { expect, test } from 'claude-code/testing'
import { CMD_TTL_MS, CONFIG_BOUNDS, FETCH_HARD_CAP_MS, POLL_HOLD_MS } from '../hooks/contract'
import {
  classifyCommand,
  compactData,
  EMPTY_CHANNEL,
  mapEngineRejection,
  parseCommands,
  parseConfigUpdate
} from '../hooks/lib/command-core'
import { FIXTURE_CONN } from './fixtures/hello'
import {
  BOOT,
  START,
  defaultScript,
  helloOk,
  installRig,
  must,
  type Answer,
  type Rig,
  type Script
} from './support/rig'

const NOW = 1_790_000_000_000
const ENABLE = ['sense.identity', 'act.channel', 'act.turn', 'act.compact', 'act.ui']

let seq = 0
const mk = (name: string, args: unknown = {}, over: Record<string, unknown> = {}) => ({
  cmd: `cmd_${++seq}`,
  n: seq,
  name,
  args,
  issuedAt: NOW,
  expiresAt: NOW + CMD_TTL_MS,
  ...over
})
const withCommands = (...commands: unknown[]): Answer => ({
  kind: 'body',
  body: { ok: true, commands }
})

/** Hello enables the whole actuator set; the n-th poll answers `polls[n-1]`, then the host parks. */
const channelScript =
  (polls: Answer[] = [], over: Script | null = null): Script =>
  (route, body, n) => {
    if (route === 'hello') return helloOk(ENABLE)
    if (route === 'poll') return polls[n - 1] ?? defaultScript(route, body, n)
    return over?.(route, body, n) ?? defaultScript(route, body, n)
  }

const results = (rig: Rig): any[] =>
  rig
    .events()
    .filter((e) => e.t === 'command.result')
    .map((e) => e.d)
const modErrors = (rig: Rig): any[] => rig.events().filter((e) => e.t === 'mod.error')

const boot = async ($: any, rig: Rig): Promise<void> => {
  await $.session.start(START)
  await rig.clock.settle()
}

test('dedupes on cmd (conformance row 10)', async ($, on) => {
  const c = mk('ui.toast', { text: 'Harnu mod channel check' })
  const rig = installRig(on, { script: channelScript([withCommands(c), withCommands(c)]) })
  let shown = 0
  on('ui.toast', async () => {
    shown++
    return { value: undefined }
  })
  await boot($, rig)
  await rig.clock.advance(10)
  expect(shown).toBe(1)
  expect(results(rig).filter((r) => r.cmd === c.cmd)).toEqual([{ cmd: c.cmd, ok: true }])
  expect(rig.of('poll').length).toBeGreaterThanOrEqual(3) // the loop kept going past the repeat
})

test('writes the cursor and the started id before the $ call', async ($, on) => {
  const c = mk('ui.toast', { text: 'Harnu mod channel check' })
  const rig = installRig(on, { script: channelScript([withCommands(c)]) })
  let seen: any = null
  on('ui.toast', async () => {
    seen = structuredClone(rig.state.get('channel'))
    return {}
  })
  await boot($, rig)
  expect(seen).toMatchObject({ bootId: BOOT, cursor: c.n, started: [c.cmd], resulted: [] })
  const done = rig.state.get('channel') as any
  expect(done.resulted).toEqual([c.cmd])
})

test('never re-runs an interrupted command', async ($, on) => {
  const c = mk('ui.toast', { text: 'Harnu mod channel check' })
  // A previous load recorded the command as started and never finished it.
  const rig = installRig(on, {
    script: channelScript([withCommands(c)]),
    savedState: {
      channel: { bootId: BOOT, cursor: 0, started: [c.cmd], resulted: [], turnId: null }
    }
  })
  let shown = 0
  on('ui.toast', async () => {
    shown++
    return { value: undefined }
  })
  await boot($, rig)
  expect(shown).toBe(0)
  expect(results(rig)).toEqual([
    { cmd: c.cmd, ok: false, code: 'CMD_FAILED', message: 'interrupted by reload' }
  ])
})

test('an interrupted prompt.submit says it is unknown whether it was submitted', async ($, on) => {
  const c = mk('prompt.submit', { text: 'x', asUser: false, via: 'prompt' })
  const rig = installRig(on, {
    script: channelScript([withCommands(c)]),
    savedState: {
      channel: { bootId: BOOT, cursor: 0, started: [c.cmd], resulted: [], turnId: null }
    }
  })
  await boot($, rig)
  expect(results(rig)[0]).toMatchObject({
    code: 'CMD_FAILED',
    message: 'interrupted by reload',
    data: { submitted: 'unknown' }
  })
})

test('refuses expired and unknown (conformance row 11)', async ($, on) => {
  const expired = mk('ui.toast', { text: 'Harnu mod channel check' }, { expiresAt: NOW - 1 })
  const unknown = mk('rm.everything', {})
  const rig = installRig(on, { script: channelScript([withCommands(expired, unknown)]) })
  let shown = 0
  on('ui.toast', async () => {
    shown++
    return { value: undefined }
  })
  await boot($, rig)
  expect(shown).toBe(0)
  const byCmd = Object.fromEntries(results(rig).map((r) => [r.cmd, r]))
  expect(byCmd[expired.cmd]).toMatchObject({ ok: false, code: 'CMD_EXPIRED' })
  expect(byCmd[unknown.cmd]).toMatchObject({ ok: false, code: 'CMD_UNSUPPORTED' })
})

test('a command for a feature the host did not enable is FEATURE_DISABLED', async ($, on) => {
  const c = mk('ui.toast', { text: 'Harnu mod channel check' })
  const rig = installRig(on, {
    script: (route, body, n) =>
      route === 'hello'
        ? helloOk(['sense.identity', 'act.channel'])
        : route === 'poll' && n === 1
          ? withCommands(c)
          : defaultScript(route, body, n)
  })
  let shown = 0
  on('ui.toast', async () => {
    shown++
    return { value: undefined }
  })
  await boot($, rig)
  expect(shown).toBe(0)
  expect(results(rig)[0]).toMatchObject({ cmd: c.cmd, ok: false, code: 'FEATURE_DISABLED' })
})

test('no poll when headless (conformance row 14)', async ($, on) => {
  const rig = installRig(on, { script: channelScript() })
  await $.session.start({ ...START, isInteractive: false })
  await rig.clock.settle()
  await rig.clock.advance(POLL_HOLD_MS * 2)
  expect(rig.of('hello').length).toBe(1)
  expect(rig.of('poll').length).toBe(0)
})

test('no poll when act.channel is not enabled', async ($, on) => {
  const rig = installRig(on)
  await boot($, rig)
  await rig.clock.advance(POLL_HOLD_MS * 2)
  expect(rig.of('poll').length).toBe(0)
})

test('the loop never awaits a command', async ($, on) => {
  const compact = mk('session.compact', {})
  const toast = mk('ui.toast', { text: 'Harnu mod channel check' })
  const rig = installRig(on, {
    script: channelScript([
      withCommands(compact),
      { kind: 'after', ms: 1_000, body: { ok: true, commands: [toast] } }
    ])
  })
  on('session.messages', async () => ({ value: [] }))
  on('session.compact', async () => {
    await rig.clock.sleep(20_000)
    return { skip: 'a hook vetoed it' } as never
  })
  on('ui.toast', async () => ({ value: undefined }))
  await boot($, rig)
  await rig.clock.advance(2_000)
  const midway = results(rig).map((r) => r.cmd)
  expect(midway).toEqual([toast.cmd]) // the toast answered while the compaction still runs
  await rig.clock.advance(20_000)
  const all = results(rig)
  expect(all.map((r) => r.cmd)).toEqual([toast.cmd, compact.cmd])
  expect(all[1]).toMatchObject({ ok: true, data: { skipped: true } })
})

test('maps the no-turn rejection', async ($, on) => {
  const abort = mk('turn.abort', {})
  const rig = installRig(on, {
    script: channelScript([{ kind: 'after', ms: 1_000, body: { ok: true, commands: [abort] } }])
  })
  on('turn.abort', async () => ({ deny: 'no turn is running (asked for turn_1)' }))
  await $.session.start(START)
  await rig.clock.settle()
  await $.turn.start({ text: 'hi', turnId: 'turn_1' }) // stored, never cleared (the engine decides)
  await rig.clock.advance(1_100)
  expect(results(rig)[0]).toMatchObject({ cmd: abort.cmd, ok: false, code: 'CMD_PRECONDITION' })
})

test('maps other rejections', async ($, on) => {
  const abort = mk('turn.abort', {})
  const rig = installRig(on, {
    script: channelScript([{ kind: 'after', ms: 1_000, body: { ok: true, commands: [abort] } }])
  })
  on('turn.abort', async () => ({ deny: 'turn turn_0 is not turn_1' }))
  await $.session.start(START)
  await rig.clock.settle()
  await $.turn.start({ text: 'hi', turnId: 'turn_1' })
  await rig.clock.advance(1_100)
  const r = results(rig)[0]
  expect(r).toMatchObject({ ok: false, code: 'CMD_FAILED' })
  expect(r.message).toMatch(/turn turn_0 is not turn_1$/) // the engine's text, whatever frames it
})

test('turn.abort uses the id its own turn.start hook stored, and an explicit id wins', async ($, on) => {
  const a = mk('turn.abort', {})
  const b = mk('turn.abort', { turnId: 'turn_explicit' })
  const rig = installRig(on, {
    script: channelScript([{ kind: 'after', ms: 1_000, body: { ok: true, commands: [a, b] } }])
  })
  const asked: string[] = []
  on('turn.abort', async (_$, e) => {
    asked.push(e.turnId)
    return { value: undefined }
  })
  await $.session.start(START)
  await rig.clock.settle()
  await $.turn.start({ text: 'hi', turnId: 'turn_7' })
  await rig.clock.advance(1_200)
  expect(asked).toEqual(['turn_7', 'turn_explicit'])
  expect(results(rig).map((r) => r.ok)).toEqual([true, true])
  expect((rig.state.get('channel') as any).turnId).toBe('turn_7')
})

test('turn.abort with no turn id known is a precondition, without a $ call', async ($, on) => {
  const abort = mk('turn.abort', {})
  const rig = installRig(on, { script: channelScript([withCommands(abort)]) })
  let called = 0
  on('turn.abort', async () => {
    called++
    return { value: undefined }
  })
  await boot($, rig)
  expect(called).toBe(0)
  expect(results(rig)[0]).toMatchObject({ ok: false, code: 'CMD_PRECONDITION' })
})

test('session.compact is called with no instructions', async ($, on) => {
  const compact = mk('session.compact', {})
  const rig = installRig(on, { script: channelScript([withCommands(compact)]) })
  let seen: any = null
  on('session.messages', async () => ({ value: [] }))
  on('session.compact', async (_$, e) => {
    seen = e
    return { skip: 'a hook vetoed it' } as never
  })
  await boot($, rig)
  await rig.clock.advance(10)
  expect(seen).not.toBeNull() // the engine's own call: no `instructions` of ours rides on it
  expect(seen.instructions).toBeUndefined()
  expect(results(rig)[0]).toMatchObject({ ok: true, data: { skipped: true } })
})

test('the engine rejection texts map to a precondition, anything else to a failure', () => {
  expect(mapEngineRejection(new Error('no turn is running (asked for t1)'))).toEqual({
    code: 'CMD_PRECONDITION',
    message: 'no turn is running (asked for t1)'
  })
  expect(mapEngineRejection(new Error('a turn is running (t2)')).code).toBe('CMD_PRECONDITION')
  expect(mapEngineRejection(new Error('boom')).code).toBe('CMD_FAILED')
  expect(mapEngineRejection('plain string')).toEqual({
    code: 'CMD_FAILED',
    message: 'plain string'
  })
  expect(mapEngineRejection(new Error('x'.repeat(900))).message.length).toBe(512)
})

test('compaction data: counts when the engine has them, skipped for a veto', () => {
  expect(compactData({ messages: [], tokensBefore: 900, tokensAfter: 100 })).toEqual({
    tokensBefore: 900,
    tokensAfter: 100
  })
  expect(compactData({ messages: [] })).toEqual({})
  expect(compactData({ skip: 'why' })).toEqual({ skipped: true })
  expect(compactData({ tokensBefore: 'a lot' })).toEqual({})
})

test("config.update bounds are the contract's", () => {
  expect(parseConfigUpdate({ config: { pollHoldMs: 25_000, flushMs: 50 } })).toEqual({
    pollHoldMs: 25_000,
    flushMs: 50
  })
  expect(parseConfigUpdate({ config: { pollHoldMs: 25_001 } })).toBeNull()
  expect(parseConfigUpdate({ config: { pollHoldMs: 1.5 } })).toBeNull()
  expect(parseConfigUpdate({ config: { nope: 5 } })).toBeNull()
  expect(parseConfigUpdate({ config: {} })).toBeNull()
  expect(parseConfigUpdate(null)).toBeNull()
})

test('the commands of a response are structurally checked', () => {
  const good = mk('flush', {})
  const parsed = parseCommands([
    { ...good, n: 2 },
    null,
    5,
    { ...good, cmd: 'not_a_cmd' },
    { ...good, n: 0 },
    { ...good, name: 7 },
    { ...good, expiresAt: 'soon' },
    { ...good, cmd: 'cmd_first', n: 1, args: [1, 2] }
  ])
  expect(parsed.map((p) => [p.cmd, p.n])).toEqual([
    ['cmd_first', 1],
    [good.cmd, 2]
  ])
  expect(parsed[0]?.args).toEqual({})
  expect(parseCommands('nope')).toEqual([])
  expect(
    parseCommands(Array.from({ length: 200 }, (_, i) => ({ ...good, cmd: `cmd_${i}`, n: i + 1 })))
      .length
  ).toBe(64)
})

test('config.update applies all or none', async ($, on) => {
  const bad = mk('config.update', { config: { heartbeatMs: 3_000, pollHoldMs: 99_999 } })
  const good = mk('config.update', { config: { heartbeatMs: 3_000, batchMaxEvents: 8 } })
  const rig = installRig(on, { script: channelScript([withCommands(bad, good)]) })
  await boot($, rig)
  await rig.clock.advance(10)
  const [r1, r2] = results(rig)
  expect(r1).toMatchObject({ cmd: bad.cmd, ok: false, code: 'CMD_PRECONDITION' })
  expect(r2).toMatchObject({ cmd: good.cmd, ok: true })
  // the new heartbeat applies: a beat is sent every 3 s from now on
  const before = rig.of('events').length
  await rig.clock.advance(9_500)
  expect(rig.of('events').length).toBeGreaterThan(before + 1)
  expect(CONFIG_BOUNDS.pollHoldMs[1]).toBe(25_000)
})

test('ui.toast and ui.status', async ($, on) => {
  const long = mk('ui.toast', { text: 'x'.repeat(201) })
  const toast = mk('ui.toast', { text: 'Harnu mod channel check' })
  const status = mk('ui.status', { text: 'Harnu mod status test' })
  const clear = mk('ui.status', { text: null })
  const rig = installRig(on, {
    script: channelScript([withCommands(long, toast, status, clear)])
  })
  const shown: string[] = []
  const lines: (string | undefined)[] = []
  on('ui.toast', async (_$, e) => {
    shown.push(e.text)
    return { value: undefined }
  })
  on('ui.status', async (_$, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  await boot($, rig)
  await rig.clock.advance(10)
  expect(shown).toEqual(['Harnu mod channel check'])
  expect(lines).toEqual(['Harnu mod status test', undefined])
  expect(results(rig).map((r) => r.ok)).toEqual([false, true, true, true])
  expect(results(rig)[0]).toMatchObject({ code: 'CMD_PRECONDITION' })
})

test('flush sends a snapshot, then the result', async ($, on) => {
  const c = mk('flush', {})
  const rig = installRig(on, { script: channelScript([withCommands(c)]) })
  await boot($, rig)
  await rig.clock.advance(10)
  const evs = rig.events()
  const snap = evs.filter((e) => e.t === 'session.snapshot').map((e) => e.d.reason)
  expect(snap).toEqual(['hello', 'flush'])
  expect(evs.findIndex((e) => e.t === 'command.result')).toBeGreaterThan(
    evs.map((e) => e.t).lastIndexOf('session.snapshot') - 1
  )
  expect(results(rig)).toEqual([{ cmd: c.cmd, ok: true }])
})

test('a hard-cap abort is a reconnect', async ($, on) => {
  const rig = installRig(on, {
    script: channelScript([{ kind: 'abort' }, { kind: 'abort' }])
  })
  await boot($, rig)
  expect(rig.of('poll').length).toBe(1)
  await rig.clock.advance(FETCH_HARD_CAP_MS)
  // the next poll is issued at once: no backoff sleep, no rendezvous re-read failure, no error
  expect(rig.of('poll').length).toBe(2)
  await rig.clock.advance(FETCH_HARD_CAP_MS)
  expect(rig.of('poll').length).toBe(3)
  expect(modErrors(rig)).toEqual([])
})

test('another transport failure backs off', async ($, on) => {
  const rig = installRig(on, { script: channelScript([{ kind: 'throw' }, { kind: 'throw' }]) })
  await boot($, rig)
  expect(rig.of('poll').length).toBe(1)
  await rig.clock.advance(100)
  expect(rig.of('poll').length).toBe(1) // still waiting out the backoff
  await rig.clock.advance(1_000)
  expect(rig.of('poll').length).toBe(2)
})

test('resync resets the cursor and sends a snapshot', async ($, on) => {
  const c = mk('ui.toast', { text: 'Harnu mod channel check' })
  const rig = installRig(on, {
    script: channelScript([
      withCommands(c),
      { kind: 'body', body: { ok: true, commands: [], resync: true } }
    ])
  })
  on('ui.toast', async () => ({ value: undefined }))
  await boot($, rig)
  await rig.clock.advance(1_500) // the host answered at once with a resync: the loop waits a second
  expect(must(rig.of('poll')[1]).body.cursor).toBe(c.n)
  expect(
    rig
      .events()
      .filter((e) => e.t === 'session.snapshot')
      .map((e) => e.d.reason)
  ).toContain('resync')
  expect(must(rig.of('poll')[2]).body.cursor).toBe(0)
})

test('a poll carries the bound sid, the boot id and the cursor', async ($, on) => {
  const rig = installRig(on, { script: channelScript() })
  await boot($, rig)
  const p = must(rig.of('poll')[0])
  expect(p.body).toMatchObject({ v: 1, conn: FIXTURE_CONN, bootId: BOOT, cursor: 0 })
  expect(typeof p.body.sid).toBe('string')
})

test('STALE_CONN on a poll resumes the hello and polls again', async ($, on) => {
  const rig = installRig(on, {
    script: (route, body, n) => {
      if (route === 'hello') return helloOk(ENABLE, 'c_00000000000000000000000000000009')
      if (route === 'poll' && n === 1)
        return { kind: 'body', body: { ok: false, code: 'STALE_CONN' } }
      return defaultScript(route, body, n)
    }
  })
  await boot($, rig)
  await rig.clock.advance(10)
  const hellos = rig.of('hello')
  expect(hellos.length).toBe(2)
  expect(must(hellos[1]).body.resume).toBeDefined()
  expect(rig.of('poll').length).toBeGreaterThanOrEqual(2)
})

test('FEATURE_DISABLED ends the loop until the next hello', async ($, on) => {
  const rig = installRig(on, {
    script: channelScript([{ kind: 'body', body: { ok: false, code: 'FEATURE_DISABLED' } }])
  })
  await boot($, rig)
  await rig.clock.advance(POLL_HOLD_MS * 2)
  expect(rig.of('poll').length).toBe(1)
})

test('a new host boot resets the cursor', async ($, on) => {
  const rig = installRig(on, {
    script: channelScript(),
    savedState: {
      channel: { bootId: 'b_an-older-boot', cursor: 41, started: [], resulted: [], turnId: null }
    }
  })
  await boot($, rig)
  expect(must(rig.of('poll')[0]).body.cursor).toBe(0)
})

test('the two classes of command that need no token', () => {
  const base = {
    state: { ...EMPTY_CHANNEL },
    inFlight: new Set<string>(),
    now: NOW,
    tokenBacked: false,
    featureEnabled: () => true
  }
  const c = (name: string) => mk(name, {}) as never
  expect(classifyCommand(c('ui.toast'), base)).toMatchObject({
    kind: 'answer',
    code: 'CMD_UNSUPPORTED'
  })
  expect(classifyCommand(c('turn.abort'), base)).toMatchObject({
    kind: 'answer',
    code: 'CMD_UNSUPPORTED'
  })
  expect(classifyCommand(c('flush'), base)).toEqual({ kind: 'run' })
  expect(classifyCommand(c('config.update'), base)).toEqual({ kind: 'run' })
  expect(classifyCommand(c('ui.band.set'), { ...base, tokenBacked: true })).toEqual({ kind: 'run' })
})
