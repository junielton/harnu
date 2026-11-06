/* eslint-disable @typescript-eslint/no-explicit-any -- test code reads drawn trees and wire bodies loosely */
import { expect, test } from 'claude-code/testing'
import { CMD_TTL_MS, type MissionStateEntry } from '../hooks/contract'
import {
  changesBetween,
  fitHeader,
  fitNoChange,
  parseMissionState,
  planTick,
  sameSnap,
  snapOf,
  tickCard,
  type TickLedger
} from '../hooks/lib/mission-state'
import { judgeCommand } from '../hooks/lib/commands'
import {
  BOOT,
  START,
  defaultScript,
  helloOk,
  installRig,
  type Answer,
  type Rig,
  type Script
} from './support/rig'

/**
 * T589 AC-2 and AC-3: the host pushes the state of the missions a session owns or is linked to
 * (`mission.state`); the mod keeps it in `$.state` and draws a loop tick as the live card of mock 02,
 * or as one "no change" line when nothing moved since the tick before. The fixture is a five-step
 * mission with one executor running step 3, the shape of the approved mock.
 */

const NOW = 1_790_000_000_000
const MIN = 60_000
const ENABLE = ['sense.identity', 'act.channel', 'ui.quietRows']

const entry = (over: Partial<MissionStateEntry> = {}): MissionStateEntry => ({
  id: 'mnt-7be1529e',
  title: 'Acme content migration',
  role: 'owner',
  progress: { total: 5, current: { from: 3, to: 3 }, done: 2, verified: 1, allDone: false },
  steps: [
    { id: 'stp-1', title: 'inventory', state: 'verified', children: [], prs: [] },
    { id: 'stp-2', title: 'schema', state: 'done', children: [], prs: [] },
    {
      id: 'stp-3',
      title: 'phase A',
      state: 'running',
      card: 'card-acme',
      children: [{ taskState: 'working', lastTransitionAt: NOW - 12 * MIN }],
      prs: [
        { number: 264, state: 'OPEN' },
        { number: 266, state: 'OPEN' }
      ]
    },
    { id: 'stp-4', title: 'phase B', state: 'todo', children: [], prs: [] },
    { id: 'stp-5', title: 'delivered and verified', state: 'todo', children: [], prs: [] }
  ],
  blockers: [],
  you: [{ kind: 'blocker', text: 'cloud credentials (stp-4)' }],
  ...over
})

/** The same mission a tick later: stp-3 verified, PR #264 merged, the executor idle. */
const moved = (): MissionStateEntry =>
  entry({
    progress: { total: 5, current: { from: 4, to: 4 }, done: 3, verified: 2, allDone: false },
    steps: entry().steps.map((s) =>
      s.id === 'stp-3'
        ? { ...s, state: 'verified', prs: [{ number: 264, state: 'MERGED' }, ...s.prs.slice(1)] }
        : s.id === 'stp-4'
          ? { ...s, state: 'running' }
          : s
    )
  })

// ---- the pure core -------------------------------------------------------------------------------

test('a well-formed push parses; every cap, shape and control character is refused whole', () => {
  expect(parseMissionState({ missions: [entry()] })).toEqual({ missions: [entry()] })
  expect(parseMissionState({ missions: [] })).toEqual({ missions: [] })
  const bad: unknown[] = [
    null,
    { missions: 'x' },
    { missions: [], extra: 1 },
    { missions: [entry({ id: 'mnt-xyz' })] },
    { missions: [entry({ title: '' })] },
    { missions: [entry({ title: 'a\nb' })] },
    { missions: [entry(), entry()] }, // one id twice
    { missions: [1, 2, 3, 4, 5].map((i) => entry({ id: 'mnt-0000000' + i })) },
    { missions: [entry({ role: 'x' as never })] },
    {
      missions: [
        entry({
          progress: { total: 5, current: { from: 4, to: 3 }, done: 0, verified: 0, allDone: false }
        })
      ]
    },
    { missions: [entry({ steps: [{ ...entry().steps[0], state: 'nope' as never }] })] },
    { missions: [entry({ you: [{ kind: 'x', text: 'y'.repeat(121) }] })] },
    { missions: [{ ...entry(), surprise: true }] }
  ]
  for (const b of bad) expect(parseMissionState(b)).toBeNull()
  const many = Array.from({ length: 41 }, (_, i) => ({ ...entry().steps[0], id: 'stp-' + i }))
  expect(parseMissionState({ missions: [entry({ steps: many })] })).toBeNull()
})

test('the first tick of a mission is a card with its position, executor and what it waits on', () => {
  const c = tickCard(entry(), 1, null, NOW)
  expect(c.kind).toBe('card')
  expect(c.title).toBe('Acme content migration')
  expect(c.detail).toBe('Step 3 of 5 · 1 verified')
  expect(c.bar).toEqual({ filled: 3, total: 5 })
  expect(c.tone).toBe('claude')
  expect(c.rows).toEqual([
    { label: 'now', text: 'stp-3 · executor card-acme working 12 min' },
    { label: 'waits', text: 'PRs #264 #266' }
  ])
  expect(c.you).toEqual(['cloud credentials (stp-4)'])
})

test('a tick that finds the same state is one line naming the tick it equals', () => {
  const prev = { n: 14, snap: snapOf(entry(), NOW - 20 * MIN) }
  const c = tickCard(entry(), 15, prev, NOW)
  expect(c.kind).toBe('nochange')
  expect(c.sinceN).toBe(14)
  expect(c.rows).toEqual([])
})

test('a tick that finds a change lists it: a step verified, a PR merged', () => {
  const prev = { n: 15, snap: snapOf(entry(), NOW - 20 * MIN) }
  const c = tickCard(moved(), 16, prev, NOW)
  expect(c.kind).toBe('card')
  expect(c.detail).toBe('Step 4 of 5 · 2 verified')
  expect(c.rows).toEqual([
    { label: 'changed', text: 'stp-3 verified · stp-4 running · PR #264 merged' }
  ])
  expect(sameSnap(snapOf(entry(), 1), snapOf(entry(), 2))).toBe(true) // the clock is not a change
  expect(sameSnap(snapOf(entry(), 1), snapOf(moved(), 1))).toBe(false)
})

test('more than three changes are cut to three and a count; a new blocker and a new ⚑ are named', () => {
  const was = snapOf(entry(), NOW)
  const now = snapOf(
    entry({
      blockers: [{ reason: 'waiting for the vendor export', owner: 'agent' }],
      you: [{ kind: 'blocker', text: 'sign the DPA' }],
      steps: entry().steps.map((s) => ({ ...s, state: 'done' as const }))
    }),
    NOW
  )
  const list = changesBetween(was, now)
  expect(list).toHaveLength(4)
  expect(list[3]).toMatch(/^\+\d+$/)
  expect(
    changesBetween(
      was,
      snapOf(entry({ blockers: [{ reason: 'vendor export', owner: 'agent' }] }), NOW)
    )
  ).toEqual(['blocked: vendor export'])
  expect(
    changesBetween(was, snapOf(entry({ you: [{ kind: 'x', text: 'sign the DPA' }] }), NOW))
  ).toEqual(['⚑ sign the DPA'])
})

test('a finished mission draws green and "Step 5 of 5 ✓"; a long one scales its bar', () => {
  const done = entry({
    progress: { total: 5, current: null, done: 5, verified: 5, allDone: true },
    you: []
  })
  const c = tickCard(done, 3, null, NOW)
  expect(c.tone).toBe('success')
  expect(c.detail).toBe('Step 5 of 5 ✓ · 5 verified')
  expect(c.bar).toEqual({ filled: 5, total: 5 })
  const long = entry({
    progress: { total: 24, current: { from: 12, to: 14 }, done: 11, verified: 11, allDone: false }
  })
  const l = tickCard(long, 1, null, NOW)
  expect(l.detail).toBe('Steps 12–14 of 24 · 11 verified')
  expect(l.bar).toEqual({ filled: 6, total: 12 })
})

test('a tick row keeps its number when it is drawn again; a new row takes the next one', () => {
  let ledger: TickLedger = { v: 1, byMission: {} }
  const a = planTick(ledger, entry(), 'row-a', NOW)
  ledger = a.ledger ?? ledger
  expect(a.row.n).toBe(1)
  const b = planTick(ledger, entry(), 'row-b', NOW + MIN)
  ledger = b.ledger ?? ledger
  expect(b.row.n).toBe(2)
  expect(b.row.card.kind).toBe('nochange')
  const again = planTick(ledger, moved(), 'row-a', NOW + 2 * MIN)
  expect(again.ledger).toBeNull() // already known: nothing to write
  expect(again.row.n).toBe(1)
  expect(again.latest).toBe(false)
  expect(planTick(ledger, moved(), 'row-b', NOW + 2 * MIN).latest).toBe(true)
})

test('the ledger keeps the newest 50 rows of a mission', () => {
  let ledger: TickLedger = { v: 1, byMission: {} }
  for (let i = 0; i < 60; i++) ledger = planTick(ledger, entry(), 'r' + i, NOW + i).ledger ?? ledger
  const rows = ledger.byMission['mnt-7be1529e'].rows
  expect(rows).toHaveLength(50)
  expect(rows[0].n).toBe(11)
  expect(rows[49].n).toBe(60)
})

// ---- the command (AC-2, mod side) ----------------------------------------------------------------

let seq = 200
const mk = (name: string, args: unknown = {}) => ({
  cmd: `cmd_${++seq}`,
  n: seq,
  name,
  args,
  issuedAt: NOW,
  expiresAt: NOW + CMD_TTL_MS
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

test('mission.state is stored under $.state.missions and answered ok', async ($, on) => {
  const c = mk('mission.state', { missions: [entry()] })
  const rig = installRig(on, { script: channelScript([withCommands(c)]) })
  await boot($, rig)
  expect(results(rig)).toEqual([{ cmd: c.cmd, ok: true }])
  const stored: any = rig.state.get('missions')
  expect(stored.v).toBe(1)
  expect(stored.n).toBe(c.n)
  expect(stored.missions).toEqual([entry()])
})

test('a push out of shape is CMD_PRECONDITION and stores nothing', async ($, on) => {
  const c = mk('mission.state', { missions: [entry({ id: 'not-a-mission' })] })
  const rig = installRig(on, { script: channelScript([withCommands(c)]) })
  await boot($, rig)
  expect(results(rig)).toEqual([
    { cmd: c.cmd, ok: false, code: 'CMD_PRECONDITION', message: expect.any(String) }
  ])
  expect(rig.state.has('missions')).toBe(false)
})

test('without the feature the command is FEATURE_DISABLED; outside Harnu it is unsupported', async ($, on) => {
  const c = mk('mission.state', { missions: [entry()] })
  const rig = installRig(on, {
    script: channelScript([withCommands(c)], ['sense.identity', 'act.channel'])
  })
  await boot($, rig)
  expect(results(rig)[0]).toMatchObject({ cmd: c.cmd, ok: false, code: 'FEATURE_DISABLED' })
  expect(rig.state.has('missions')).toBe(false)
  expect(judgeCommand(c as never, true, NOW)).toMatchObject({ run: false, code: 'CMD_UNSUPPORTED' })
})

// ---- the tick card on the row (AC-3) -------------------------------------------------------------

const ROW = { plugin: 'harnu-companion', component: 'UserMessage' } as const
const TICK =
  '/harnu:mission tick · mnt-7be1529e\nread the mission, act on what is unblocked, report'
const tickProps = (text = TICK, over: Record<string, unknown> = {}) => ({
  text,
  origin: { kind: 'scheduled-trigger' },
  isExpanded: false,
  ...over
})
/** State from this boot: a hello under another boot starts the pushes over (it clears them). */
const seeded = (e: MissionStateEntry[] = [entry()]) => ({
  missions: { v: 1, n: 1, at: NOW, missions: e },
  channel: { bootId: BOOT, cursor: 0, started: [], resulted: [], turnId: null }
})
const mountTick = async (
  $: any,
  on: any,
  rig: Rig,
  rid: string,
  p: Record<string, unknown> = tickProps()
) => $.ui.mount({ ...ROW, surface: 'terminal', requestId: rid, props: p } as never)
const rigWith = async ($: any, on: any, saved: Record<string, unknown> = seeded()) => {
  const rig = installRig(on, { savedState: saved, script: channelScript() })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await boot($, rig)
  currentRig = rig
  return rig
}
const textOf = async (ui: any, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text

test('a tick that names a mission with pushed state draws the live card', async ($, on) => {
  const rig = await rigWith($, on)
  await appendTick($, 'row-1')
  const ui = await mountTick($, on, rig, 'row-1')
  expect(await textOf(ui, /^engine$/)).toBeUndefined()
  expect(await textOf(ui, /tick #1 · Acme content migration/)).toBeTruthy()
  expect(await textOf(ui, /Step 3 of 5 · 1 verified/)).toBeTruthy()
  expect(await textOf(ui, /stp-3 · executor card-acme working 12 min/)).toBeTruthy()
  expect(await textOf(ui, /PRs #264 #266/)).toBeTruthy()
  expect(await textOf(ui, /cloud credentials \(stp-4\)/)).toBeTruthy()
  expect(await textOf(ui, /⚑/)).toBeTruthy()
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.map((b: any) => b.props.borderColor)).toContain('claude')
  await ui.unmount()
})

test('the bar follows the position and the card goes green when the mission is done', async ($, on) => {
  const done = entry({
    progress: { total: 5, current: null, done: 5, verified: 5, allDone: true },
    you: []
  })
  const rig = await rigWith($, on, seeded([done]))
  const ui = await mountTick($, on, rig, 'row-1')
  expect(await textOf(ui, /▰▰▰▰▰/)).toBeTruthy()
  expect(await textOf(ui, /Step 5 of 5 ✓/)).toBeTruthy()
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.map((b: any) => b.props.borderColor)).toContain('success')
  await ui.unmount()
})

test('the second tick over the same state is one line; a later change is a card with what changed', async ($, on) => {
  const rig = await rigWith($, on)
  await appendTick($, 'row-1')
  await appendTick($, 'row-2')
  const one = await mountTick($, on, rig, 'row-1')
  expect(await textOf(one, /tick #1/)).toBeTruthy()
  const two = await mountTick($, on, rig, 'row-2')
  expect(
    await textOf(two, /tick #2 · Acme content migration · Step 3 of 5 · no change since #1/)
  ).toBeTruthy()
  const boxes = await two.findAll({ type: 'Box' })
  expect(boxes.map((b: any) => b.props.borderColor).filter(Boolean)).toEqual([]) // no card, one line
  expect(await textOf(two, /executor card-acme/)).toBeUndefined()
  rig.state.set('missions', { v: 1, n: 2, at: NOW, missions: [moved()] })
  await appendTick($, 'row-3')
  const three = await mountTick($, on, rig, 'row-3')
  expect(await textOf(three, /tick #3/)).toBeTruthy()
  expect(await textOf(three, /changed/)).toBeTruthy()
  expect(await textOf(three, /stp-3 verified · stp-4 running · PR #264 merged/)).toBeTruthy()
  await one.unmount()
  await two.unmount()
  await three.unmount()
})

test('a row drawn again keeps its number and, once a later tick exists, its own words', async ($, on) => {
  const rig = await rigWith($, on)
  await appendTick($, 'row-1')
  await appendTick($, 'row-2')
  const one = await mountTick($, on, rig, 'row-1')
  const two = await mountTick($, on, rig, 'row-2')
  rig.state.set('missions', { v: 1, n: 2, at: NOW, missions: [moved()] })
  await appendTick($, 'row-3')
  await mountTick($, on, rig, 'row-3')
  await one.unmount()
  await two.unmount()
  const again = await mountTick($, on, rig, 'row-2')
  // still "no change since #1": the state moved on, this row's own tick did not
  expect(await textOf(again, /tick #2 .* no change since #1/)).toBeTruthy()
  await again.unmount()
})

test('a tick whose mission is not in the pushed state is the plain chip, never hidden', async ($, on) => {
  const rig = await rigWith($, on, seeded([entry({ id: 'mnt-00000000' })]))
  const ui = await mountTick($, on, rig, 'row-1')
  expect(await textOf(ui, /^engine$/)).toBeUndefined()
  expect(await textOf(ui, /^⟳/)).toBeTruthy()
  expect(await textOf(ui, /tick · mnt-7be1529e/)).toBeTruthy()
  await ui.unmount()
})

test('with no state pushed at all the tick is the plain chip', async ($, on) => {
  const rig = await rigWith($, on, {})
  const ui = await mountTick($, on, rig, 'row-1')
  expect(await textOf(ui, /tick · mnt-7be1529e/)).toBeTruthy()
  await ui.unmount()
})

test('a tick whose first line is not the fixed shape is a chip, even with a mission id inside', async ($, on) => {
  const rig = await rigWith($, on)
  const ui = await mountTick($, on, rig, 'row-1', tickProps('please tick mnt-7be1529e now'))
  expect(await textOf(ui, /Step 3 of 5/)).toBeUndefined()
  expect(await textOf(ui, /please tick mnt-7be1529e now/)).toBeTruthy()
  await ui.unmount()
})

test('an expanded tick (ctrl+o) is the engine row, untouched', async ($, on) => {
  const rig = await rigWith($, on)
  const ui = await mountTick($, on, rig, 'row-1', tickProps(TICK, { isExpanded: true }))
  expect(await textOf(ui, /^engine$/)).toBe('engine')
  await ui.unmount()
})

test('a ledger that is not one reads as empty; a tick appended after it is numbered from 1', async ($, on) => {
  const rig = await rigWith($, on, { ...seeded(), tickRows: 'garbage' })
  await appendTick($, 'row-1')
  const ui = await mountTick($, on, rig, 'row-1')
  expect(await textOf(ui, /tick #1/)).toBeTruthy()
  await ui.unmount()
})

test('pushed state that is not one never throws: the tick falls back to the chip', async ($, on) => {
  const rig = await rigWith($, on, {
    ...seeded(),
    missions: { v: 1, n: 1, at: NOW, missions: 'x' }
  })
  const ui = await mountTick($, on, rig, 'row-1')
  expect(await textOf(ui, /tick · mnt-7be1529e/)).toBeTruthy()
  await ui.unmount()
})

// ---- a host boot is a new world ------------------------------------------------------------------

test('a mod reloaded under a new boot does not keep the missions of the old one', async ($, on) => {
  const rig = installRig(on, {
    script: channelScript(),
    savedState: {
      ...seeded(),
      channel: { bootId: 'b_an-older-boot', cursor: 41, started: [], resulted: [], turnId: null }
    }
  })
  await boot($, rig)
  expect(rig.state.get('missions')).toBeNull()
})

test('the same boot keeps them: a re-hello is not a restart', async ($, on) => {
  const rig = installRig(on, {
    script: channelScript(),
    savedState: {
      ...seeded(),
      channel: { bootId: BOOT, cursor: 3, started: [], resulted: [], turnId: null }
    }
  })
  await boot($, rig)
  expect(rig.state.get('missions')).toMatchObject({ v: 1, n: 1 })
})

// ---- a tick is numbered when it is appended, in the order it arrived -----------------------------

/** What the engine raises when a scheduled prompt fires: the row, its id, who caused it. */
/** The rig of the running test: a fired tick's ledger write is a timer, and the held clock must move for it. */
let currentRig: Rig | null = null
const rawAppend = ($: any, uuid: string, text = TICK, over: Record<string, unknown> = {}) =>
  $.session.append({
    message: { type: 'user', isMeta: true, content: [{ type: 'text', text }] },
    door: 'prompt',
    origin: { kind: 'scheduled-trigger' },
    uuid,
    ...over
  })
/*
 * There is no test for "a row the engine refused is not numbered" (a repro was written and then
 * removed, T589 review #9): the engine refuses only a plugin's own append, and the test harness fails
 * any test in which a hook is skipped ("returned a deny of a row the engine appends"), so a refusal of
 * a prompt or delivery row cannot be staged. The hooks guard it anyway: a row is numbered only when
 * `next` returned a stored row (`kept.uuid`).
 */
/** A fired tick, and the moment the mod's timer takes to write its ledger. */
const appendTick = async (
  $: any,
  uuid: string,
  text = TICK,
  over: Record<string, unknown> = {}
) => {
  const kept = await rawAppend($, uuid, text, over)
  await currentRig?.clock.advance(1)
  return kept
}

test('ticks appended live are numbered and compared in arrival order, whatever order they are drawn', async ($, on) => {
  const rig = await rigWith($, on)
  await appendTick($, 'u-1')
  await appendTick($, 'u-2') // same state: "no change since #1"
  rig.state.set('missions', { v: 1, n: 2, at: NOW, missions: [moved()] })
  await appendTick($, 'u-3') // the mission moved: a card with what changed
  // the engine may draw the newest row first (a resumed session did): the numbers do not follow it
  const three = await mountTick($, on, rig, 'u-3')
  const one = await mountTick($, on, rig, 'u-1')
  const two = await mountTick($, on, rig, 'u-2')
  expect(await textOf(three, /tick #3 · Acme content migration/)).toBeTruthy()
  expect(await textOf(three, /stp-3 verified · stp-4 running · PR #264 merged/)).toBeTruthy()
  expect(await textOf(one, /tick #1 · Acme content migration/)).toBeTruthy()
  expect(await textOf(one, /executor card-acme working/)).toBeTruthy()
  expect(await textOf(two, /tick #2 .* no change since #1/)).toBeTruthy()
  for (const ui of [one, two, three]) await ui.unmount()
})

test('the tick line is found after a framing line; other origins, doors and missions are not ticks', async ($, on) => {
  const rig = await rigWith($, on)
  await appendTick($, 'u-1', 'Scheduled task fired:\n' + TICK)
  await appendTick($, 'u-2', TICK, { origin: { kind: 'composer' } })
  await appendTick($, 'u-3', '/harnu:mission tick · mnt-00000000\nsomething else')
  await appendTick($, 'u-4', 'please tick mnt-7be1529e')
  const ledger: any = rig.state.get('tickRows')
  expect(ledger.byMission['mnt-7be1529e'].rows.map((r: any) => r.rid)).toEqual(['u-1'])
  expect(Object.keys(ledger.byMission)).toEqual(['mnt-7be1529e'])
})

test('without the feature, or without pushed state, a fired tick writes nothing', async ($, on) => {
  const off = installRig(on, {
    savedState: seeded(),
    script: channelScript([], ['sense.identity', 'act.channel'])
  })
  await boot($, off)
  currentRig = off
  await appendTick($, 'u-1')
  expect(off.state.has('tickRows')).toBe(false)
})

test('a row never appended in this process is an unnumbered card, with no comparison, and writes nothing', async ($, on) => {
  // a resumed transcript: the engine draws its rows in an order of its own (bottom-up in 2.1.312),
  // so a number taken from the draw order would put #2 above #1. Such a row says what is true now.
  const rig = await rigWith($, on)
  const a = await mountTick($, on, rig, 'old-1')
  const b = await mountTick($, on, rig, 'old-2')
  for (const ui of [a, b]) {
    expect(await textOf(ui, /^⟳ tick · Acme content migration$/)).toBeTruthy()
    expect(await textOf(ui, /tick #/)).toBeUndefined()
    expect(await textOf(ui, /no change since/)).toBeUndefined()
    expect(await textOf(ui, /stp-3 · executor card-acme working 12 min/)).toBeTruthy()
    expect(await textOf(ui, /Step 3 of 5 · 1 verified/)).toBeTruthy()
  }
  await rig.clock.settle()
  expect(rig.state.has('tickRows')).toBe(false)
  await a.unmount()
  await b.unmount()
})

test('a tick appended before anything was pushed is an unnumbered card once the state arrives', async ($, on) => {
  const rig = await rigWith($, on, {})
  await appendTick($, 'u-1') // nothing pushed yet: not numbered at append
  expect(rig.state.has('tickRows')).toBe(false)
  rig.state.set('missions', seeded().missions)
  const ui = await mountTick($, on, rig, 'u-1')
  expect(await textOf(ui, /^⟳ tick · Acme content migration$/)).toBeTruthy()
  await ui.unmount()
})

// ---- the header fits inside the border, at any width ---------------------------------------------

/** The cells a header draws: its left text, the two-cell gap, the bar and its detail, one spare cell. */
const headerCells = (h: NonNullable<ReturnType<typeof fitHeader>>) =>
  [...h.left].length + 2 + (h.bar ? h.bar.total + 1 : 0) + [...h.detail].length

test('a header that fits is left alone; at exactly its width one spare cell is still kept free', () => {
  const card = tickCard(entry(), 1, null, NOW)
  const full = fitHeader(card, 200)
  expect(full.left).toBe('⟳ tick #1 · Acme content migration')
  expect(full.detail).toBe('Step 3 of 5 · 1 verified')
  expect(full.bar).toEqual({ filled: 3, total: 5 })
  const need = headerCells(full)
  expect(fitHeader(card, need + 1)).toEqual(full) // the inner width with its spare cell
  const tight = fitHeader(card, need) // one cell narrower than that: the title gives way first
  expect(tight.left.endsWith('…')).toBe(true)
  expect(tight.detail).toBe('Step 3 of 5 · 1 verified')
  expect(headerCells(tight)).toBeLessThanOrEqual(need - 1)
})

test('narrower still: the title shrinks to a floor, then "· V verified" goes, then the bar', () => {
  const card = tickCard(
    entry({ title: 'A very long mission title that needs room' }),
    14,
    null,
    NOW
  )
  // at every width a card is fitted or there is none (null: the caller draws the plain chip)
  for (let inner = 120; inner >= 16; inner--) {
    const h = fitHeader(card, inner)
    if (h !== null) expect(headerCells(h), 'inner ' + inner).toBeLessThanOrEqual(inner - 1)
  }
  expect(fitHeader(card, 20)).toBeNull()
  expect(fitHeader(card, 16)).toBeNull()
  expect(fitHeader(card, 40)).not.toBeNull()
  const mid = fitHeader(card, 60)
  expect(mid.detail).toBe('Step 3 of 5 · 1 verified')
  expect(mid.left.endsWith('…')).toBe(true)
  const narrow = fitHeader(card, 45)
  expect(narrow.detail).toBe('Step 3 of 5')
  expect(narrow.bar).not.toBeNull()
  const tiny = fitHeader(card, 40)
  expect(tiny.bar).toBeNull()
  expect(tiny.detail).toBe('Step 3 of 5')
})

test('a tick card at 60 columns keeps its header inside the border', async ($, on) => {
  const rig = await rigWith($, on)
  await appendTick($, 'row-1')
  const ui = await $.ui.mount({
    ...ROW,
    surface: 'terminal',
    requestId: 'row-1',
    viewport: { columns: 60, rows: 40 },
    props: tickProps(TICK.replace('mnt-7be1529e', 'mnt-7be1529e'))
  } as never)
  const rows = await ui.findAll({ type: 'Text', text: /tick #1|Step 3 of 5|▰|▱/ })
  const cells = rows
    .map((r: any) => [...String(r.text)].length)
    .reduce((a: number, b: number) => a + b, 0)
  expect(rows.length).toBeGreaterThan(0)
  expect(cells + 2).toBeLessThanOrEqual(60 - 4 - 1) // border, padding and the spare cell
  await ui.unmount()
  void rig
})

// ---- the code review: ledger races, key, refused rows, window, no-change fit ---------------------

const ledgerOf = (rig: Rig): any => rig.state.get('tickRows')

test('ticks appended at the same moment are each kept and numbered once, in order of arrival', async ($, on) => {
  const rig = await rigWith($, on)
  await Promise.all([appendTick($, 'c-1'), appendTick($, 'c-2'), appendTick($, 'c-3')])
  const rows = ledgerOf(rig).byMission['mnt-7be1529e'].rows
  expect(rows.map((r: any) => r.rid).sort()).toEqual(['c-1', 'c-2', 'c-3'])
  expect(rows.map((r: any) => r.n)).toEqual([1, 2, 3]) // no two ticks share a number, none is lost
  expect(ledgerOf(rig).byMission['mnt-7be1529e'].next).toBe(4)
})

test('a held write never leaves the stored ledger short of a row once it lands', async ($, on) => {
  let writes = 0
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  // sees every write of the ledger and holds the first one back (a matcher: the rig answers the rest)
  on('state.set', { key: 'tickRows' }, async (_$: any, e: any, next: any) => {
    if (writes++ === 0) await gate
    return next(e)
  })
  const rig = await rigWith($, on)
  await Promise.all([appendTick($, 'w-1'), appendTick($, 'w-2')])
  await appendTick($, 'w-3') // arrives while the first write is held
  release()
  await rig.clock.advance(1)
  await rig.clock.settle()
  const rows = ledgerOf(rig).byMission['mnt-7be1529e'].rows
  expect(rows.map((r: any) => r.rid)).toEqual(['w-1', 'w-2', 'w-3'])
})

test('the ledger is keyed by the id the engine kept the row under, the one a draw reads as requestId', async ($, on) => {
  const rig = await rigWith($, on)
  const kept = await appendTick($, 'k-1')
  expect(kept.uuid).toBe('k-1')
  expect(ledgerOf(rig).byMission['mnt-7be1529e'].rows[0].rid).toBe(kept.uuid)
  const same = await mountTick($, on, rig, kept.uuid)
  expect(await textOf(same, /^⟳ tick #1 · /)).toBeTruthy()
  // a draw under any other id is visibly a loose card: no number, never a wrong one
  const other = await mountTick($, on, rig, 'not-the-row')
  expect(await textOf(other, /^⟳ tick · Acme content migration$/)).toBeTruthy()
  expect(await textOf(other, /tick #/)).toBeUndefined()
  await same.unmount()
  await other.unmount()
})

test('a mission with more than 40 steps carries a window of them and the offset of its first', async ($, on) => {
  const steps = Array.from({ length: 40 }, (_, i) => ({
    id: 'stp-' + (i + 21),
    title: 'step ' + (i + 21),
    state: i + 21 < 50 ? ('verified' as const) : ('todo' as const),
    children: [] as { taskState: string; lastTransitionAt: number | null }[],
    prs: [] as { number: number; state: string }[]
  }))
  steps[29] = {
    ...steps[29],
    state: 'running',
    children: [{ taskState: 'working', lastTransitionAt: NOW - 3 * MIN }]
  }
  const big = entry({
    progress: { total: 60, current: { from: 50, to: 50 }, done: 49, verified: 49, allDone: false },
    steps,
    offset: 20
  } as never)
  expect(parseMissionState({ missions: [big] })).not.toBeNull()
  expect(parseMissionState({ missions: [{ ...big, offset: -1 }] })).toBeNull()
  expect(parseMissionState({ missions: [{ ...big, offset: 1.5 }] })).toBeNull()
  const c = tickCard(big, 1, null, NOW)
  expect(c.rows[0]).toEqual({ label: 'now', text: 'stp-50 · executor working 3 min' })
  void on
})

test('the "no change" line keeps its tail on a narrow terminal: the title gives way, then the count', () => {
  const card = tickCard(
    entry({ title: 'A very long mission title that needs room' }),
    15,
    { n: 14, snap: snapOf(entry(), NOW) },
    NOW
  )
  expect(card.kind).toBe('nochange')
  const wide = fitNoChange(card, 200)
  expect(wide).toBe(
    '⟳ tick #15 · A very long mission title that needs room · Step 3 of 5 · no change since #14'
  )
  for (let avail = 80; avail >= 16; avail--) {
    const line = fitNoChange(card, avail)
    if (line === null) continue // too narrow for the tick label: the plain chip is drawn
    expect([...line].length, 'avail ' + avail).toBeLessThanOrEqual(avail)
    expect(line.endsWith('no change since #14'), 'avail ' + avail).toBe(true)
  }
  expect(fitNoChange(card, 20)).toBeNull()
  expect(fitNoChange(card, 36)).not.toBeNull()
  expect(fitNoChange(card, 60)).toMatch(/^⟳ tick #15 · .*… · Step 3 of 5 · no change since #14$/)
  expect(fitNoChange(card, 45)).toMatch(/^⟳ tick #15 · .*… · no change since #14$/)
})

test('a "no change" tick at 60 columns keeps "no change since" on its line', async ($, on) => {
  const rig = await rigWith($, on)
  await appendTick($, 'n-1')
  await appendTick($, 'n-2')
  const ui = await $.ui.mount({
    ...ROW,
    surface: 'terminal',
    requestId: 'n-2',
    viewport: { columns: 60, rows: 40 },
    props: tickProps()
  } as never)
  expect(await textOf(ui, /no change since #1$/)).toBeTruthy()
  await ui.unmount()
  void rig
})

test('a mission with no steps has no bar, and so no stray space in front of its count', () => {
  const none = entry({
    progress: { total: 0, current: null, done: 0, verified: 0, allDone: false },
    steps: []
  })
  const h = fitHeader(tickCard(none, 1, null, NOW), 80)
  expect(h.bar).toBeNull()
  expect(h.detail).toBe('0 steps · 0 verified')
})

// ---- narrower than a card can be: the plain one-line chip (T589 delta 3, AC-3) -------------------

test('at 30 columns a tick is a one-line chip that never exceeds the width, card or no change alike', async ($, on) => {
  const rig = await rigWith($, on)
  await appendTick($, 't-1')
  await appendTick($, 't-2')
  for (const rid of ['t-1', 't-2']) {
    const ui = await $.ui.mount({
      ...ROW,
      surface: 'terminal',
      requestId: rid,
      viewport: { columns: 30, rows: 40 },
      props: tickProps()
    } as never)
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.map((b: any) => b.props.borderColor).filter(Boolean)).toEqual([]) // no card
    const line = await ui.find({ type: 'Text', text: /tick/ })
    expect(line.props.wrap).toBe('truncate-end')
    expect(await textOf(ui, /^⟳$/)).toBeTruthy()
    await ui.unmount()
  }
  void rig
})

// ---- the append path does not wait for the display-only write (T589 delta 3) ---------------------

test('the session.append hook resolves without waiting for the ledger write, and the write still lands', async ($, on) => {
  let writes = 0
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  on('state.set', { key: 'tickRows' }, async (_$: any, e: any, next: any) => {
    writes++
    await gate // a slow store
    return next(e)
  })
  const rig = await rigWith($, on)
  const kept = await rawAppend($, 'h-1') // no clock movement at all: it must come back
  expect(kept.uuid).toBe('h-1')
  expect(writes).toBe(0) // the write has not even started: it is a timer, after the row is kept
  // the draw already has its number (planned in memory), before the write lands
  const ui = await mountTick($, on, rig, 'h-1')
  expect(await textOf(ui, /^⟳ tick #1 · /)).toBeTruthy()
  await ui.unmount()
  await rig.clock.advance(1)
  expect(writes).toBe(1) // started, and held
  expect(rig.state.has('tickRows')).toBe(false)
  release()
  await rig.clock.settle()
  expect(ledgerOf(rig).byMission['mnt-7be1529e'].rows.map((r: any) => r.rid)).toEqual(['h-1'])
})
