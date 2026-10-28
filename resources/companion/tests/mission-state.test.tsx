/* eslint-disable @typescript-eslint/no-explicit-any -- test code reads drawn trees and wire bodies loosely */
import { expect, test } from 'claude-code/testing'
import { CMD_TTL_MS, type MissionStateEntry } from '../hooks/contract'
import {
  changesBetween,
  parseMissionState,
  planTick,
  sameSnap,
  snapOf,
  tickCard,
  type TickLedger
} from '../hooks/lib/mission-state'
import { judgeCommand } from '../hooks/lib/commands'
import {
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
const seeded = (e: MissionStateEntry[] = [entry()]) => ({
  missions: { v: 1, n: 1, at: NOW, missions: e }
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
  return rig
}
const textOf = async (ui: any, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text

test('a tick that names a mission with pushed state draws the live card', async ($, on) => {
  const rig = await rigWith($, on)
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
  const one = await mountTick($, on, rig, 'row-1')
  expect(await textOf(one, /tick #1/)).toBeTruthy()
  const two = await mountTick($, on, rig, 'row-2')
  expect(
    await textOf(two, /tick #2 · Acme content migration · Step 3 of 5 · no change since #1/)
  ).toBeTruthy()
  expect(await two.find({ type: 'Box', props: { borderColor: 'claude' } })).toBeUndefined()
  expect(await textOf(two, /executor card-acme/)).toBeUndefined()
  rig.state.set('missions', { v: 1, n: 2, at: NOW, missions: [moved()] })
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
  const one = await mountTick($, on, rig, 'row-1')
  const two = await mountTick($, on, rig, 'row-2')
  rig.state.set('missions', { v: 1, n: 2, at: NOW, missions: [moved()] })
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

test('a ledger that is not one reads as empty; the row still draws its card', async ($, on) => {
  const rig = await rigWith($, on, { ...seeded(), tickRows: 'garbage' })
  const ui = await mountTick($, on, rig, 'row-1')
  expect(await textOf(ui, /tick #1/)).toBeTruthy()
  await ui.unmount()
})

test('pushed state that is not one never throws: the tick falls back to the chip', async ($, on) => {
  const rig = await rigWith($, on, { missions: { v: 1, missions: 'x' } })
  const ui = await mountTick($, on, rig, 'row-1')
  expect(await textOf(ui, /tick · mnt-7be1529e/)).toBeTruthy()
  await ui.unmount()
})
