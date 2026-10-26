/* eslint-disable @typescript-eslint/no-explicit-any -- test code reads wire bodies loosely */
import { expect, test } from 'claude-code/testing'
import {
  BAND_DETAIL_MAX,
  BAND_HINT_MAX,
  BAND_LEAD_MAX,
  BAND_TTL_MS,
  CMD_TTL_MS,
  CONTEXT_MAX_CHARS
} from '../hooks/contract'
import {
  BAND_SWEEP_MS,
  BAND_MIN_COLUMNS,
  REVIEW_SELECTION_KEY,
  applyBand,
  bandFeatures,
  classifyCommand,
  fitBand,
  parseBandSet,
  parseContextAppend,
  type BandState
} from '../hooks/lib/command-core'
import { judgeCommand } from '../hooks/lib/commands'
import { FIXTURE_CONN } from './fixtures/hello'
import {
  BOOT,
  START,
  defaultScript,
  endpointText,
  helloOk,
  installRig,
  type Answer,
  type Rig,
  type Script
} from './support/rig'

const NOW = 1_790_000_000_000
const ENABLE = ['sense.identity', 'act.channel', 'act.context', 'ui.band']
const ROW = `⧉ speech.ts L85–92`

let seq = 100
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
const channelScript =
  (polls: Answer[] = [], enable: string[] = ENABLE): Script =>
  (route, body, n) => {
    if (route === 'hello') return helloOk(enable)
    if (route === 'poll') return polls[n - 1] ?? defaultScript(route, body, n)
    return defaultScript(route, body, n)
  }
const results = (rig: Rig): any[] =>
  rig
    .events()
    .filter((e) => e.t === 'command.result')
    .map((e) => e.d)
const boot = async ($: any, rig: Rig): Promise<void> => {
  await $.session.start(START)
  await rig.clock.settle()
}

const append = (text: string, over: Record<string, unknown> = {}) =>
  mk('context.append', { key: REVIEW_SELECTION_KEY, text, durable: false, ...over })
const band = (over: Record<string, unknown> = {}, n?: number) =>
  mk(
    'ui.band.set',
    { line: `${ROW} · src/main · ask your question below`, parts: { lead: ROW }, ...over },
    n === undefined ? {} : { n, cmd: `cmd_${n}` }
  )

// ---- context.append (U2a-ii-AC-1) ----------------------------------------------------------------

test('context.append appends one hidden user row through $.session.append and stores nothing', async ($, on) => {
  const c = append('the operator is looking at speech.ts L85-92')
  const rig = installRig(on, { script: channelScript([withCommands(c)]) })
  const rows: any[] = []
  on('session.append', { door: 'note' }, async (_$, e, next) => {
    rows.push(e)
    return next(e)
  })
  await boot($, rig)
  expect(results(rig)).toEqual([{ cmd: c.cmd, ok: true }])
  expect(rows).toHaveLength(1)
  expect(rows[0].message.type).toBe('user')
  expect(rows[0].message.content).toEqual([
    { type: 'text', text: 'the operator is looking at speech.ts L85-92' }
  ])
  // durable: false: the mod keeps no copy of the row, in any state key
  expect(JSON.stringify([...rig.state.entries()])).not.toContain('looking at speech.ts')
  const known = ['boot', 'bootId', 'channel', 'conn', 'fleet', 'sid']
  expect([...rig.state.keys()].filter((k) => !known.includes(k))).toEqual([])
})

test('context.append is never awaited by the poll loop: a later command answers first', async ($, on) => {
  const slow = append('slow row')
  const toast = mk('ui.toast', { text: 'later' })
  const rig = installRig(on, {
    script: channelScript(
      [withCommands(slow), { kind: 'after', ms: 1_000, body: { ok: true, commands: [toast] } }],
      [...ENABLE, 'act.ui']
    )
  })
  on('session.append', { door: 'note' }, async (_$, e, next) => {
    await rig.clock.sleep(20_000)
    return next(e)
  })
  on('ui.toast', async () => ({ value: undefined }))
  await boot($, rig)
  await rig.clock.advance(2_000)
  expect(results(rig).map((r) => r.cmd)).toEqual([toast.cmd]) // the toast, while the append runs
  await rig.clock.advance(20_000)
  expect(results(rig).map((r) => r.cmd)).toEqual([toast.cmd, slow.cmd])
  expect(results(rig)[1]).toMatchObject({ ok: true })
})

test('context.append: text over CONTEXT_MAX_CHARS is CMD_PRECONDITION, at the cap it runs', async ($, on) => {
  const over = append('x'.repeat(CONTEXT_MAX_CHARS + 1))
  const at = append('y'.repeat(CONTEXT_MAX_CHARS))
  const rig = installRig(on, { script: channelScript([withCommands(over, at)]) })
  let calls = 0
  on('session.append', { door: 'note' }, async (_$, e, next) => {
    calls++
    return next(e)
  })
  await boot($, rig)
  const byCmd = Object.fromEntries(results(rig).map((r) => [r.cmd, r]))
  expect(byCmd[over.cmd]).toMatchObject({ ok: false, code: 'CMD_PRECONDITION' })
  expect(byCmd[at.cmd]).toMatchObject({ ok: true })
  expect(calls).toBe(1)
})

test('context.append: another key, a durable row and an extra argument are CMD_PRECONDITION', async ($, on) => {
  const cs = [
    append('t', { key: 'harnu.mission' }),
    append('t', { durable: true }),
    append('t', { retainOnly: true }),
    append('')
  ]
  const rig = installRig(on, { script: channelScript([withCommands(...cs)]) })
  let calls = 0
  on('session.append', { door: 'note' }, async (_$, e, next) => {
    calls++
    return next(e)
  })
  await boot($, rig)
  expect(results(rig).map((r) => [r.ok, r.code])).toEqual(cs.map(() => [false, 'CMD_PRECONDITION']))
  expect(calls).toBe(0)
})

test('context.append: a plugin that refuses the row is CMD_FAILED, not ok', async ($, on) => {
  const c = append('refused')
  const rig = installRig(on, { script: channelScript([withCommands(c)]) })
  on('session.append', { door: 'note' }, () => ({ deny: 'policy says no' }) as never)
  await boot($, rig)
  expect(results(rig)[0]).toMatchObject({ cmd: c.cmd, ok: false, code: 'CMD_FAILED' })
  expect(results(rig)[0].message).toContain('policy says no')
})

test('context.append: a feature the host did not enable is FEATURE_DISABLED', async ($, on) => {
  const c = append('x')
  const rig = installRig(on, {
    script: channelScript([withCommands(c)], ['sense.identity', 'act.channel'])
  })
  let calls = 0
  on('session.append', { door: 'note' }, async (_$, e, next) => {
    calls++
    return next(e)
  })
  await boot($, rig)
  expect(results(rig)[0]).toMatchObject({ ok: false, code: 'FEATURE_DISABLED' })
  expect(calls).toBe(0)
})

test('parseContextAppend: the second lock, case by case', () => {
  const ok = { key: REVIEW_SELECTION_KEY, text: 'a', durable: false }
  expect(parseContextAppend(ok)).toEqual({ ok: true, text: 'a' })
  for (const bad of [
    null,
    [],
    { ...ok, key: 'harnu.orchestrator' },
    { ...ok, durable: true },
    { ...ok, durable: undefined },
    { ...ok, text: 7 },
    { ...ok, text: '' },
    { ...ok, text: 'x'.repeat(CONTEXT_MAX_CHARS + 1) },
    { ...ok, retainOnly: false }
  ]) {
    expect(parseContextAppend(bad)).toMatchObject({ ok: false })
  }
})

// ---- the tokenless second lock (U2a-ii-AC-4) -----------------------------------------------------

test('tokenless: context.append is CMD_UNSUPPORTED and enable is never read', () => {
  const c = {
    cmd: 'cmd_1',
    n: 1,
    name: 'context.append',
    args: {},
    issuedAt: NOW,
    expiresAt: NOW + 1
  } as any
  const ctx = {
    state: { bootId: null, cursor: 0, started: [], resulted: [], turnId: null },
    inFlight: new Set<string>(),
    now: NOW,
    tokenBacked: false,
    featureEnabled: () => {
      throw new Error('enable must not be read')
    }
  }
  expect(classifyCommand(c, ctx)).toEqual({ kind: 'answer', code: 'CMD_UNSUPPORTED' })
  expect(classifyCommand({ ...c, name: 'ui.band.set' }, ctx)).toEqual({ kind: 'run' })
  expect(judgeCommand(c, true, NOW)).toMatchObject({ run: false, code: 'CMD_UNSUPPORTED' })
  expect(judgeCommand({ ...c, name: 'ui.band.set' }, true, NOW)).toEqual({ run: true })
  expect(judgeCommand(c, false, NOW)).toEqual({ run: true })
})

test('tokenless end to end: no append, but the band is allowed', async ($, on) => {
  const a = append('x')
  const b = band()
  const rig = installRig(on, {
    token: false,
    script: channelScript([withCommands(a, b)], ['sense.identity', 'act.channel', 'act.context'])
  })
  let calls = 0
  on('session.append', { door: 'note' }, async (_$, e, next) => {
    calls++
    return next(e)
  })
  await $.session.start(START)
  await rig.clock.settle()
  await rig.clock.advance(20_000)
  const byCmd = Object.fromEntries(results(rig).map((r) => [r.cmd, r]))
  expect(byCmd[a.cmd]).toMatchObject({ ok: false, code: 'CMD_UNSUPPORTED' })
  expect(byCmd[b.cmd]).toMatchObject({ ok: true })
  expect(calls).toBe(0)
  expect((rig.state.get('band') as any).lead).toBe(ROW)
})

// ---- ui.band.set (U2a-ii-AC-2, AC-5) ---------------------------------------------------------------

test('ui.band.set stores the band with n and expiresAt, and clears with line: null', async ($, on) => {
  const set = band({}, 201)
  const clear = mk('ui.band.set', { line: null }, { n: 202, cmd: 'cmd_202' })
  const rig = installRig(on, {
    script: channelScript([
      withCommands(set),
      { kind: 'after', ms: 1_000, body: { ok: true, commands: [clear] } }
    ])
  })
  await boot($, rig)
  expect(results(rig)).toEqual([{ cmd: 'cmd_201', ok: true }])
  expect(rig.state.get('band')).toEqual({
    v: 1,
    lead: ROW,
    n: 201,
    expiresAt: NOW + BAND_TTL_MS
  })
  await rig.clock.advance(1_100)
  expect(results(rig).map((r) => r.ok)).toEqual([true, true])
  expect(rig.state.get('band')).toBeNull()
})

test('ui.band.set: a lower n never overwrites a higher one, also after a clear', async ($, on) => {
  const high = band({ parts: { lead: '⧉ new.ts L2' } }, 305)
  const low = band({ parts: { lead: '⧉ old.ts L1' } }, 303)
  const rig = installRig(on, {
    script: channelScript([
      withCommands(high),
      { kind: 'after', ms: 1_000, body: { ok: true, commands: [low] } }
    ])
  })
  await boot($, rig)
  await rig.clock.advance(1_100)
  expect(results(rig).map((r) => r.cmd)).toEqual(['cmd_305', 'cmd_303'])
  expect((rig.state.get('band') as any).lead).toBe('⧉ new.ts L2')
  expect((rig.state.get('band') as any).n).toBe(305)
})

test('ui.band.set: the line expires at BAND_TTL_MS and the sweep clears it', async ($, on) => {
  const rig = installRig(on, { script: channelScript([withCommands(band({}, 401))]) })
  await boot($, rig)
  expect(rig.state.get('band')).not.toBeNull()
  await rig.clock.advance(BAND_TTL_MS - BAND_SWEEP_MS)
  expect(rig.state.get('band')).not.toBeNull() // 60 s in: still standing
  await rig.clock.advance(BAND_SWEEP_MS + 1)
  expect(rig.state.get('band')).toBeNull()
})

test('ui.band.set: parts are re-checked, control characters stripped, a link dropped not the line', async ($, on) => {
  const dirty = band(
    {
      parts: { lead: '⧉ a\u0007b.ts\n L1', detail: 'src/\u202emain', hint: 'ask\u0000 below' },
      link: { label: 'Open', href: 'http://localhost:1/o/o_x' }
    },
    501
  )
  const long = band({ parts: { lead: 'x'.repeat(BAND_LEAD_MAX + 1) } }, 502)
  const noParts = mk('ui.band.set', { line: 'only a line' }, { n: 503, cmd: 'cmd_503' })
  const rig = installRig(on, {
    script: channelScript([
      withCommands(dirty),
      { kind: 'after', ms: 500, body: { ok: true, commands: [long, noParts] } }
    ])
  })
  await boot($, rig)
  await rig.clock.advance(600)
  const byCmd = Object.fromEntries(results(rig).map((r) => [r.cmd, r]))
  expect(byCmd.cmd_501).toMatchObject({ ok: true })
  expect(byCmd.cmd_502).toMatchObject({ ok: false, code: 'CMD_PRECONDITION' })
  expect(byCmd.cmd_503).toMatchObject({ ok: false, code: 'CMD_PRECONDITION' })
  expect(rig.state.get('band')).toEqual({
    v: 1,
    lead: '⧉ ab.ts L1',
    detail: 'src/main',
    hint: 'ask below',
    n: 501,
    expiresAt: NOW + BAND_TTL_MS
  })
})

test('parseBandSet: limits per part, link dropped, controls stripped', () => {
  const lead = 'l'.repeat(BAND_LEAD_MAX)
  const detail = 'd'.repeat(BAND_DETAIL_MAX)
  const hint = 'h'.repeat(BAND_HINT_MAX)
  expect(parseBandSet({ line: 'x', parts: { lead, detail, hint } })).toEqual({
    kind: 'set',
    lead,
    detail,
    hint
  })
  expect(parseBandSet({ line: 'x', parts: { lead: lead + 'l' } })).toBeNull()
  expect(parseBandSet({ line: 'x', parts: { lead, detail: detail + 'd' } })).toBeNull()
  expect(parseBandSet({ line: 'x', parts: { lead, hint: hint + 'h' } })).toBeNull()
  expect(parseBandSet({ line: 'x', parts: { lead: '\u0001\u0002' } })).toBeNull() // empty once cleaned
  expect(parseBandSet({ line: 'x', parts: { lead: 7 } })).toBeNull()
  expect(parseBandSet({ line: 'x' })).toBeNull()
  expect(parseBandSet({ line: null })).toEqual({ kind: 'clear' })
  expect(
    parseBandSet({
      line: 'x',
      parts: { lead: 'a', detail: '\u0007' },
      link: { label: 'o', href: 'h' }
    })
  ).toEqual({ kind: 'set', lead: 'a' }) // an emptied optional part is left out, the link is not kept
})

test('applyBand: n ordering is a pure rule', () => {
  const stored: BandState = { v: 1, lead: 'a', n: 10, expiresAt: NOW + 1 }
  const set = { kind: 'set', lead: 'b' } as const
  expect(applyBand(set, 9, NOW, stored, 0)).toEqual({ apply: false })
  expect(applyBand(set, 11, NOW, null, 12)).toEqual({ apply: false }) // this load already applied 12
  expect(applyBand({ kind: 'clear' }, 9, NOW, stored, 0)).toEqual({ apply: false })
  expect(applyBand(set, 10, NOW, stored, 0)).toMatchObject({ apply: true })
})

// ---- the view (U2a-ii-AC-2) ----------------------------------------------------------------------

const STORED: BandState = {
  v: 1,
  lead: ROW,
  detail: '…src/main',
  hint: 'ask your question below',
  n: 1,
  expiresAt: NOW + BAND_TTL_MS
}
const props = (over: Record<string, unknown> = {}) => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 144,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
  ...over
})
const ABOVE = { plugin: 'harnu-companion', component: 'AbovePrompt' } as const

const textsOf = async (ui: any, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text

test('the band row fits bodyColumns and wraps another plugin’s tree without replacing it', async ($, on) => {
  installRig(on, { savedState: { band: STORED } })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other plugin</Text>
  })
  const rows: Record<number, string | undefined> = {}
  for (const bodyColumns of [39, 40, 79, 80, 109, 110, 143, 144]) {
    const ui = await $.ui.mount({
      ...ABOVE,
      surface: 'terminal',
      props: props({ bodyColumns })
    } as never)
    expect(await textsOf(ui, /other plugin/)).toBe('other plugin') // wrapped, never replaced
    rows[bodyColumns] = await textsOf(ui, /Harnu|⧉/)
    await ui.unmount()
  }
  expect(rows[39]).toBe('⧉ L85–92') // below 40: the compact line, no mark, no file name
  expect(rows[40]).toBe(`◆ Harnu ${ROW}`)
  expect(rows[109]).toBe(`◆ Harnu ${ROW}`)
  expect(rows[110]).toBe(`◆ Harnu ${ROW} · …src/main`)
  expect(rows[143]).toBe(`◆ Harnu ${ROW} · …src/main`)
  expect(rows[144]).toBe(`◆ Harnu ${ROW} · …src/main · ask your question below`)
})

test('with no band state, an expired band, a survey or another surface the view is next(e)', async ($, on) => {
  const rig = installRig(on, { savedState: { band: { ...STORED, expiresAt: NOW - 1 } } })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const draw = async (surface: 'terminal' | 'desktop', over: Record<string, unknown> = {}) => {
    const ui = await $.ui.mount({ ...ABOVE, surface, props: props(over) } as never)
    const out = [await textsOf(ui, /engine/), await textsOf(ui, /Harnu/)]
    await ui.unmount()
    return out
  }
  expect(await draw('terminal')).toEqual(['engine', undefined]) // expired
  rig.state.set('band', STORED)
  expect(await draw('terminal')).toEqual(['engine', expect.stringContaining('Harnu')])
  expect(await draw('terminal', { hasSurvey: true })).toEqual(['engine', undefined])
  expect(await draw('terminal', { maxRows: 0 })).toEqual(['engine', undefined])
  expect(await draw('desktop')).toEqual(['engine', undefined])
  rig.state.set('band', null)
  expect(await draw('terminal')).toEqual(['engine', undefined])
  rig.state.set('band', { v: 1, lead: 5 }) // another plugin wrote junk under the key
  expect(await draw('terminal')).toEqual(['engine', undefined])
})

test('fitBand: a part that is absent leaves no separator, and the row is never wider than the body', () => {
  const lone: BandState = { v: 1, lead: ROW, n: 1, expiresAt: NOW + 1 }
  expect(fitBand(lone, 144)).toBe(`◆ Harnu ${ROW}`)
  expect(fitBand({ ...lone, hint: 'h' }, 144)).toBe(`◆ Harnu ${ROW} · h`)
  const wide: BandState = { ...STORED, lead: 'x'.repeat(60) } // another plugin wrote the key
  expect(fitBand(wide, 44)?.length).toBe(44)
  expect(fitBand(wide, 44)).toMatch(/…$/)
  expect(fitBand(STORED, Number.NaN)).toBeNull()
})

// ---- declaring the features (U2a-ii-AC-3) ------------------------------------------------------------

test('the hello declares act.context and ui.band once the band hook registered', async ($, on) => {
  const rig = installRig(on, { script: channelScript() })
  await boot($, rig)
  const declared = rig.of('hello')[0]!.body.declared
  expect(declared).toEqual(expect.arrayContaining(['act.context', 'ui.band']))
  expect(declared.at(-1)).toBe('sense.mods')
  expect(FIXTURE_CONN).toBeDefined()
})

test('bandFeatures: neither feature without the hook or without the base set', () => {
  expect(bandFeatures({ 'ui.render': true }, true)).toEqual(['act.context', 'ui.band'])
  expect(bandFeatures({}, true)).toEqual([])
  expect(bandFeatures({ 'ui.render': false }, true)).toEqual([])
  expect(bandFeatures({ 'ui.render': true }, false)).toEqual([])
})

// ---- band delta: a restarted host, the truth of the result, the redraw (U2d) ----------------------

const NEW_BOOT = 'b_00000000-0000-4000-8000-0000000000b2'

/** Records every `$.ui.invalidate` the mod makes, and answers like the engine would. */
const watchInvalidate = (on: any): any[] => {
  const calls: any[] = []
  on('ui.invalidate', async (_$: any, e: any) => {
    calls.push(e)
    return { value: undefined }
  })
  return calls
}

test('a band set after the host restarted is applied: a new boot restarts n, so the mod forgets the old one', async ($, on) => {
  const old = band({ parts: { lead: '⧉ before.ts L1' } }, 50)
  const fresh = mk(
    'ui.band.set',
    { line: `⧉ after.ts L2 · ask`, parts: { lead: '⧉ after.ts L2' } },
    {
      n: 1,
      cmd: 'cmd_fresh_1'
    }
  )
  let restarted = false
  const rig = installRig(on, {
    script: (route, body, n) => {
      if (route === 'hello') {
        const base = helloOk(ENABLE)
        return restarted && base.kind === 'body'
          ? { kind: 'body', body: { ...(base.body as object), bootId: NEW_BOOT } }
          : base
      }
      if (route === 'poll' && n === 1) return withCommands(old)
      if (route === 'poll' && n === 2)
        return { kind: 'after', ms: 5_000, body: { ok: true, commands: [], resync: true } }
      if (route === 'poll' && body.bootId === NEW_BOOT && n === 3) return withCommands(fresh)
      return defaultScript(route, body, n)
    }
  })
  await boot($, rig)
  expect((rig.state.get('band') as any).n).toBe(50)
  // the host restarts: its queue numbers from 1 again
  restarted = true
  rig.endpoint.text = endpointText({ bootId: NEW_BOOT })
  await rig.clock.advance(6_000)
  expect(rig.of('hello').length).toBe(2)
  expect(results(rig).map((r) => [r.cmd, r.ok])).toEqual([
    ['cmd_50', true],
    ['cmd_fresh_1', true]
  ])
  expect(rig.state.get('band')).toMatchObject({ lead: '⧉ after.ts L2', n: 1 })
})

test('a mod reloaded under a new boot does not keep the line of the old one', async ($, on) => {
  const rig = installRig(on, {
    script: channelScript(),
    savedState: {
      band: { v: 1, lead: '⧉ stale.ts L9', n: 90, expiresAt: NOW + BAND_TTL_MS },
      channel: { bootId: 'b_an-older-boot', cursor: 41, started: [], resulted: [], turnId: null }
    }
  })
  const calls = watchInvalidate(on)
  await boot($, rig)
  expect(rig.state.get('band')).toBeNull()
  expect(calls.length).toBeGreaterThan(0)
})

test('the same boot keeps the band: a re-hello is not a restart', async ($, on) => {
  const rig = installRig(on, {
    script: channelScript(),
    savedState: {
      band: { v: 1, lead: ROW, n: 90, expiresAt: NOW + BAND_TTL_MS },
      channel: { bootId: BOOT, cursor: 3, started: [], resulted: [], turnId: null }
    }
  })
  await boot($, rig)
  expect(rig.state.get('band')).toMatchObject({ lead: ROW, n: 90 })
})

test('ui.band.set that is refused as older says so: CMD_PRECONDITION, not ok', async ($, on) => {
  const high = band({ parts: { lead: '⧉ new.ts L2' } }, 505)
  const low = band({ parts: { lead: '⧉ old.ts L1' } }, 503)
  const rig = installRig(on, {
    script: channelScript([
      withCommands(high),
      { kind: 'after', ms: 1_000, body: { ok: true, commands: [low] } }
    ])
  })
  await boot($, rig)
  await rig.clock.advance(1_100)
  const [first, second] = results(rig)
  expect(first).toMatchObject({ cmd: 'cmd_505', ok: true })
  expect(second).toMatchObject({ cmd: 'cmd_503', ok: false, code: 'CMD_PRECONDITION' })
  expect((rig.state.get('band') as any).lead).toBe('⧉ new.ts L2')
})

test('every band set, clear and expiry asks the engine to redraw ui.render', async ($, on) => {
  const set = band({}, 601)
  const clear = mk('ui.band.set', { line: null }, { n: 602, cmd: 'cmd_602' })
  const rig = installRig(on, {
    script: channelScript([
      withCommands(set),
      { kind: 'after', ms: 1_000, body: { ok: true, commands: [clear] } },
      { kind: 'after', ms: 1_000, body: { ok: true, commands: [band({}, 603)] } }
    ])
  })
  const calls = watchInvalidate(on)
  await boot($, rig)
  expect(calls).toHaveLength(1) // the set
  expect(JSON.stringify(calls[0])).toContain('ui.render')
  await rig.clock.advance(1_100)
  expect(calls).toHaveLength(2) // the clear
  await rig.clock.advance(1_100)
  expect(calls).toHaveLength(3) // a new set
  await rig.clock.advance(BAND_TTL_MS + BAND_SWEEP_MS)
  expect(rig.state.get('band')).toBeNull()
  expect(calls).toHaveLength(4) // the sweep clearing an expired line
})

test('a refused older set and a missing engine call never break the band', async ($, on) => {
  const rig = installRig(on, { script: channelScript([withCommands(band({}, 701))]) })
  on('ui.invalidate', async () => {
    throw new Error('not in this engine')
  })
  await boot($, rig)
  expect(results(rig)).toEqual([{ cmd: 'cmd_701', ok: true }])
  expect(rig.state.get('band')).not.toBeNull()
})

test('a render that returns early still reads the band, so the engine knows to redraw it later', async ($, on) => {
  const rig = installRig(on, { savedState: { band: STORED } })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  for (const over of [{ hasSurvey: true }, { maxRows: 0 }]) {
    rig.stateReads.length = 0
    const ui = await $.ui.mount({ ...ABOVE, surface: 'terminal', props: props(over) } as never)
    expect(rig.stateReads).toContain('band')
    expect(await textsOf(ui, /Harnu/)).toBeUndefined()
    await ui.unmount()
  }
})

// ---- the compact band, below BAND_MIN_COLUMNS (U2d) ----------------------------------------------

const bandOf = (lead: string, over: Partial<BandState> = {}): BandState => ({
  v: 1,
  lead,
  n: 1,
  expiresAt: NOW + BAND_TTL_MS,
  ...over
})

test('fitBand: every width boundary of the compact line, for every shape of range', () => {
  // [lead the host builds, the compact rows it may become from the widest down]
  const table: Array<[string, string[]]> = [
    ['⧉ speech.ts L21', ['⧉ L21']],
    ['⧉ speech.ts L21–24', ['⧉ L21–24']],
    ['⧉ speech.ts old L21', ['⧉ old L21']],
    ['⧉ speech.ts old L21–24', ['⧉ old L21–24']],
    ['⧉ speech.ts (file)', ['⧉ (file)']],
    ['⧉ …peech.ts old L85 – new L92', ['⧉ old L85 – new L92', '⧉ L85–L92']],
    ['⧉ old L85 – new L92', ['⧉ old L85 – new L92', '⧉ L85–L92']], // a lead with no name left
    ['⧉ new L3 – old L7', ['⧉ new L3 – old L7', '⧉ L3–L7']]
  ]
  for (const [lead, forms] of table) {
    const b = bandOf(lead, { detail: 'src/main', hint: 'ask your question below' })
    // from the narrowest form's width up to just below 40: the widest form that fits, no mark
    const narrowest = forms[forms.length - 1].length
    for (let columns = 0; columns < BAND_MIN_COLUMNS; columns++) {
      const want = columns < narrowest ? null : forms.find((f) => f.length <= columns)
      expect(fitBand(b, columns), `${lead} @ ${columns}`).toBe(want ?? null)
    }
    // never wider than the body, never a mark, a file name, a detail or a hint
    for (let columns = narrowest; columns < BAND_MIN_COLUMNS; columns++) {
      const row = fitBand(b, columns)!
      expect(row.length).toBeLessThanOrEqual(columns)
      expect(row).not.toMatch(/Harnu|speech|src|ask/)
    }
  }
})

test('fitBand: at BAND_MIN_COLUMNS and above the line is the full one, as before', () => {
  const b = bandOf(ROW, { detail: '…src/main', hint: 'ask your question below' })
  expect(BAND_MIN_COLUMNS).toBe(40)
  expect(fitBand(b, 39)).toBe('⧉ L85–92')
  expect(fitBand(b, 40)).toBe(`◆ Harnu ${ROW}`)
  expect(fitBand(b, 80)).toBe(`◆ Harnu ${ROW}`)
})

test('fitBand: a lead that carries no range the mod recognises shows nothing below 40, never a guess', () => {
  for (const lead of ['hello', '⧉ speech.ts', '⧉ speech.ts L', '⧉ speech.ts L21 and more', '']) {
    expect(fitBand(bandOf(lead || 'x'), 30), lead).toBeNull()
  }
  // another plugin's junk with a range-shaped tail is still only a range: no file name leaks
  expect(fitBand(bandOf('<script> L5'), 30)).toBe('⧉ L5')
})

test('the view draws the compact row in a narrow pane and nothing in a pane too narrow for it', async ($, on) => {
  installRig(on, { savedState: { band: { ...STORED, lead: '⧉ speech.ts L21–24' } } })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other plugin</Text>
  })
  const row = async (bodyColumns: number) => {
    const ui = await $.ui.mount({
      ...ABOVE,
      surface: 'terminal',
      props: props({ bodyColumns })
    } as never)
    expect(await textsOf(ui, /other plugin/)).toBe('other plugin') // wrapped, never replaced
    const out = await textsOf(ui, /⧉/)
    await ui.unmount()
    return out
  }
  expect(await row(31)).toBe('⧉ L21–24')
  expect(await row(20)).toBe('⧉ L21–24')
  expect(await row(8)).toBe('⧉ L21–24')
  expect(await row(7)).toBeUndefined()
  expect(await row(0)).toBeUndefined()
})
