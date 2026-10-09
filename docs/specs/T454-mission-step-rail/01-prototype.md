# T454 — Prototype: the mod half of the rail, and its runs

Part of the [T454 spec](00-spec.md) (AC C-5, and the "shown by a run" half of C-1). This file
holds the complete prototype mod, the real output of `claude plugin validate`, `claude plugin test`
and `tsc -p`, and the transcript of a live session that drove the same mod by key.

## 1. What the prototype is, and what it is not

It is the **mod half** of the design: the band above the prompt drawn from host-pushed state, the
fitting table of spec §6.2, the four actions with their confirm and input states, the press that
leaves as an event carrying the action and the revision only, the TTL, and the fail-open render
hook. It is a standalone plugin named `rail-proto` so it can run from the session scratchpad.

It is **not** the companion. In the spec the mod half lives in `resources/companion/` (spec §9)
and talks to Harnu over the companion's command channel: the host pushes the rail inside
`ui.band.set` and a press leaves as a `ui.action` edge event (spec §4, §7). The prototype replaces
that channel with one `$.http.fetch` POST to a stand-in host that carries both directions, so the
kit can script the host with one bottom hook. The host half (resolver, publisher, action executor
in Harnu main) is specified in spec §7–§8 and is not prototyped.

Files, as run (formatted with the repo's `.prettierrc.yaml`):

| File                         | Role                                                                     |
| ---------------------------- | ------------------------------------------------------------------------ |
| `.claude-plugin/plugin.json` | manifest, names the contract                                             |
| `hooks/hooks.json`           | one module, `./register.ts` (a `.ts` module, as the companion's is)      |
| `hooks/register.ts`          | owns `$`: the poll, the TTL, the press handlers, the `AbovePrompt` hook  |
| `hooks/rail-core.ts`         | pure and `$`-free: the status word and the fitting table                 |
| `hooks/rail-view.tsx`        | pure: the tree, built from the resolved elements and closures, never `$` |
| `types/index.d.ts`           | the contract: the pushed `RailView` and the local `RailMode`             |
| `tests/rail.test.ts`         | six kit tests, mounting the band on the `terminal` surface               |

The split `register.ts` + imported `rail-view.tsx` is the layout T389 P4W2 planned for the
companion (`surface.tsx` imported by `register.ts`, P4W2 §7.1), and P4W2 §7.4 left open whether
the engine accepts JSX in a file a `.ts` module imports. The runs below settle it on 2.1.295: it
validates, tests and draws in a live session.

## 2. Source

### `.claude-plugin/plugin.json`

```json
{
  "name": "rail-proto",
  "version": "0.1.0",
  "description": "T454 prototype: the mod half of the mission step rail above the prompt.",
  "author": {
    "name": "Harnu"
  },
  "types": "./types/index.d.ts"
}
```

### `hooks/hooks.json`

```json
{ "modules": ["./register.ts"] }
```

### `types/index.d.ts`

```ts
// T454 prototype contract. Self-contained (no import), as the engine requires.
export type RailStepState = 'verified' | 'done' | 'running' | 'waiting' | 'blocked' | 'todo'
export type RailAction = 'claim' | 'block' | 'unblock' | 'log'
/** What the host pushes (the proposed `ui.band.set` `rail` field). The mod never recounts. */
export type RailView = {
  v: 1
  /** The host's revision for this binding; a press names it and nothing else. */
  rev: number
  role: 'owner' | 'child'
  /** `progressHeadline(derived.progress)` for the owner; the child's own step position for a child. */
  headline: {
    kind: 'single' | 'range' | 'done' | 'empty'
    n: number
    to: number
    m: number
  }
  step?: {
    title: string
    level: 'existence' | 'verifier' | 'human'
    proof: 'unproven' | 'claimed' | 'self-verified' | 'verified'
    state: RailStepState
    blocker?: { reason: string; owner: 'agent' | 'operator' }
  }
  staleMin?: number
  actions: readonly RailAction[]
  result?: { action: RailAction; ok: boolean; code?: string }
  /** The mod's clock + TTL at apply time. */
  expiresAt: number
}
export type RailMode =
  | { kind: 'idle' }
  | { kind: 'confirm-claim' }
  | { kind: 'block' }
  | { kind: 'log' }
  | { kind: 'sent'; action: RailAction }
  | { kind: 'unreachable' }

declare module 'claude-code' {
  interface PluginState {
    'rail-proto': { rail: RailView | null; mode: RailMode }
  }
}
```

### `hooks/rail-core.ts`

```ts
import type { RailAction, RailView } from '../types'

/** Pure and `$`-free: what the row says at a given `bodyColumns`. */

export const RAIL_MIN_COLUMNS = 40
export const ACTIONS_MIN_COLUMNS = 60
export const TITLE_MIN_COLUMNS = 90
export const DETAIL_MIN_COLUMNS = 120
/** A title or reason shorter than this after truncation is dropped instead. */
export const PART_MIN = 12

export const HOTKEY: Record<RailAction, string> = {
  claim: 'c',
  block: 'b',
  unblock: 'u',
  log: 'l'
}
export const LABEL: Record<RailAction, string> = {
  claim: 'Claim',
  block: 'Block',
  unblock: 'Clear block',
  log: 'Log'
}
const LEVEL: Record<'existence' | 'verifier' | 'human', string> = {
  existence: 'Existence check',
  verifier: 'Verifier',
  human: 'Human'
}

export function headlineText(h: RailView['headline']): string {
  if (h.kind === 'empty') return ''
  if (h.kind === 'done') return `Step ${h.m} of ${h.m} ✓`
  if (h.kind === 'range') return `Steps ${h.n}–${h.to} of ${h.m}`
  return `Step ${h.n} of ${h.m}`
}

/**
 * The step's word, first match wins (spec §6.1). It reads the derived state the host sent and the
 * stored proof; it never decides which step is done.
 */
export function statusWord(step: NonNullable<RailView['step']>): string {
  if (step.state === 'verified') return '✓ Verified'
  if (step.state === 'done') {
    return step.proof === 'claimed' || step.proof === 'self-verified' ? 'Claimed' : 'Done'
  }
  if (step.blocker) return 'Blocked'
  if (step.state === 'running') return 'Running'
  if (step.state === 'waiting') return 'Waiting'
  return 'To do'
}

export function cut(text: string, max: number): string | null {
  if (max < PART_MIN) return null
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

export function formatStale(min: number): string {
  if (min < 60) return `${min}m`
  if (min < 24 * 60) return `${Math.floor(min / 60)}h ${min % 60}m`
  return `${Math.floor(min / 1440)}d ${Math.floor((min % 1440) / 60)}h`
}

export function actionsWidth(actions: readonly RailAction[]): number {
  return actions.reduce((w, a, i) => w + (i ? 2 : 0) + HOTKEY[a].length + 2 + LABEL[a].length, 0)
}

export interface RailRow {
  text: string
  actions: RailAction[]
}

/** The fitting table of spec §6.2. `null` = no row. */
export function fitRail(rail: RailView, columns: number): RailRow | null {
  const lead = headlineText(rail.headline)
  if (columns < RAIL_MIN_COLUMNS || lead === '') return null
  const head = `◆ ${lead}`
  const stale = rail.staleMin !== undefined ? `mission stale ${formatStale(rail.staleMin)}` : null
  if (rail.role === 'owner' || !rail.step) {
    const wide = stale && columns >= DETAIL_MIN_COLUMNS ? ` · ${stale}` : ''
    return { text: head + wide, actions: [] }
  }
  const step = rail.step
  const word = statusWord(step)
  const actions = columns >= ACTIONS_MIN_COLUMNS ? [...rail.actions] : []
  const reserve = actions.length ? 2 + actionsWidth(actions) : 0
  if (columns < TITLE_MIN_COLUMNS) {
    const text = `${head} · ${word}`
    return text.length + reserve <= columns ? { text, actions } : { text, actions: [] }
  }
  // Cut first: the verification level, then the stale age (spec §6.2).
  const tail: string[] = []
  if (columns >= DETAIL_MIN_COLUMNS) tail.push(LEVEL[step.level])
  if (stale) tail.push(stale)
  const tailText = tail.map((t) => ` · ${t}`).join('')
  let room = columns - reserve - head.length - tailText.length
  // Blocked: the reason outranks the title, so it is fitted first and the title takes what is left.
  let status = word
  if (step.blocker) {
    const reason = cut(step.blocker.reason, room - 3 - (word.length + 2))
    status = reason ? `${word}: ${reason}` : word
  }
  room -= 3 + status.length
  const title = cut(step.title, room - 3)
  const text = `${head}${title ? ` · ${title}` : ''} · ${status}${tailText}`
  return { text, actions }
}
```

### `hooks/rail-view.tsx`

```tsx
import type { Elements } from 'claude-code'

import type { RailAction, RailMode } from '../types'
import { HOTKEY, LABEL, type RailRow } from './rail-core'

/** The rail's tree. Pure: receives the resolved elements and closures, never `$` (MOD-1). */
export interface RailHandlers {
  press: (action: RailAction) => void
  confirmClaim: (yes: boolean) => void
  submit: (kind: 'block' | 'log', text: string) => void
}

const MODE_TEXT: Record<'sent' | 'unreachable', string> = {
  sent: 'Saving…',
  unreachable: 'Harnu is not reachable. Nothing was saved.'
}

export function railTree(
  els: Elements['terminal'],
  row: RailRow,
  mode: RailMode,
  stepLabel: string,
  confirmNote: string,
  on: RailHandlers
): JSX.Element {
  const { Box, Button, Input, Text } = els
  if (mode.kind === 'confirm-claim') {
    return (
      <Box>
        <Text>
          ◆ Claim {stepLabel} as done? {confirmNote}
          {'  '}
        </Text>
        <Button
          key="rail-yes"
          hotkey="y"
          plain
          label="Claim"
          onPress={() => on.confirmClaim(true)}
        />
        <Text>{'  '}</Text>
        <Button
          key="rail-no"
          hotkey="n"
          plain
          label="Cancel"
          onPress={() => on.confirmClaim(false)}
        />
      </Box>
    )
  }
  if (mode.kind === 'block' || mode.kind === 'log') {
    const kind = mode.kind
    return (
      <Box>
        <Input
          key={`rail-${kind}`}
          autoFocus
          label={kind === 'block' ? `◆ Blocker on ${stepLabel}` : `◆ Log on ${stepLabel}`}
          placeholder={
            kind === 'block'
              ? 'what blocks it (Enter on empty cancels)'
              : 'note (Enter on empty cancels)'
          }
          submitLabel={kind === 'block' ? 'raise' : 'log'}
          onSubmit={(value) => on.submit(kind, value)}
        />
      </Box>
    )
  }
  const suffix =
    mode.kind === 'sent' || mode.kind === 'unreachable' ? ` · ${MODE_TEXT[mode.kind]}` : ''
  // Every state keeps a focusable element: a band left with no Button drops the focus, and the
  // next letter the person types goes to the prompt instead (live check, spec §5.3).
  const live = row.actions
  return (
    <Box>
      <Text dimColor wrap="truncate-end">
        {row.text}
        {suffix}
      </Text>
      {live.map((a) => (
        <Box key={`gap-${a}`}>
          <Text>{'  '}</Text>
          <Button
            key={`rail-${a}`}
            hotkey={HOTKEY[a]}
            plain
            label={LABEL[a]}
            onPress={() => on.press(a)}
          />
        </Box>
      ))}
    </Box>
  )
}

/** The rail's row above whatever the plugins beneath drew: it wraps, never replaces (P4W2 §7.4). */
export function stack(
  els: Elements['terminal'],
  row: JSX.Element,
  below: JSX.Element
): JSX.Element {
  const { Box } = els
  return (
    <Box flexDirection="column">
      {row}
      {below}
    </Box>
  )
}
```

### `hooks/register.ts`

```ts
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RailAction, RailMode, RailView } from '../types'
import { fitRail } from './rail-core'
import { railTree, stack, type RailHandlers } from './rail-view'

/**
 * T454 prototype, the mod half. In the spec this lives in `harnu-companion`: the host pushes the
 * rail in `ui.band.set` over the command channel and a press leaves as a `ui.action` edge event.
 * Here one POST to a stand-in host carries both directions so `claude plugin test` can script it.
 */
const HOST = 'http://localhost:47999/rail'
const POLL_MS = 2_000
const TTL_MS = 90_000
const TEXT_MAX = 200

const railRef = atom({ plugin: 'rail-proto', key: 'rail' } as const, null)
const modeRef = atom({ plugin: 'rail-proto', key: 'mode' } as const, { kind: 'idle' } as RailMode)

type Pushed = Omit<RailView, 'expiresAt'>
type RailEvent = {
  t: 'ui.action'
  d: { name: `step.${RailAction}`; rev: number; text?: string }
}

/** One round trip: send queued events, apply the band the host answers. Never rejects. */
async function sync($: EngineInterface, events: RailEvent[]): Promise<boolean> {
  try {
    const res = await $.http.fetch(HOST, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events })
    })
    if (!res.ok) return false
    const body = JSON.parse(res.text) as { band?: Pushed | null }
    const now = await $.clock.now()
    if (body.band === null) await update($, railRef, () => null)
    else if (body.band) {
      const pushed = body.band
      // A lower revision never overwrites a higher one (P4W2 §7.4, `n`).
      await update($, railRef, (prev) =>
        prev && prev.rev > pushed.rev ? prev : { ...pushed, expiresAt: now + TTL_MS }
      )
    }
    return true
  } catch {
    return false
  }
}

async function tick($: EngineInterface): Promise<void> {
  const ok = await sync($, [])
  const now = await $.clock.now()
  // A dead host cannot leave a stale step on screen: the line lives TTL_MS past its last push.
  await update($, railRef, (prev) => (prev && prev.expiresAt <= now ? null : prev))
  if (ok)
    await update($, modeRef, (m): RailMode => (m.kind === 'unreachable' ? { kind: 'idle' } : m))
}

/** A press carries the action and the revision the operator saw. Never a step id (spec §7.3). */
async function send(
  $: EngineInterface,
  action: RailAction,
  rev: number,
  text?: string
): Promise<void> {
  await update($, modeRef, (): RailMode => ({ kind: 'sent', action }))
  const d = {
    name: `step.${action}` as const,
    rev,
    ...(text !== undefined ? { text } : {})
  }
  const ok = await sync($, [{ t: 'ui.action', d }])
  await update($, modeRef, (): RailMode => (ok ? { kind: 'idle' } : { kind: 'unreachable' }))
}

function handlers($: EngineInterface, rev: number): RailHandlers {
  return {
    press: (a) => {
      void pressWhenIdle($, a, rev)
    },
    confirmClaim: (yes) => {
      if (yes) void send($, 'claim', rev)
      else void update($, modeRef, (): RailMode => ({ kind: 'idle' }))
    },
    submit: (kind, value) => {
      const text = value.trim().slice(0, TEXT_MAX)
      if (text === '') void update($, modeRef, (): RailMode => ({ kind: 'idle' }))
      else void send($, kind, rev, text)
    }
  }
}

/** A press while a previous one is still being saved does nothing. */
async function pressWhenIdle($: EngineInterface, a: RailAction, rev: number): Promise<void> {
  const mode = await read($, modeRef)
  if (mode.kind !== 'idle' && mode.kind !== 'unreachable') return // unreachable: a press retries
  if (a === 'claim') await update($, modeRef, (): RailMode => ({ kind: 'confirm-claim' }))
  else if (a === 'block' || a === 'log') await update($, modeRef, (): RailMode => ({ kind: a }))
  else await send($, a, rev)
}

/** What a claim leaves undone, by the step's verification level (spec §6.4). */
function confirmNote(rail: RailView): string {
  return rail.step?.level === 'human'
    ? 'You still mark it verified in Harnu.'
    : 'A verifier still checks it.'
}

function stepLabel(rail: RailView): string {
  return rail.headline.kind === 'single' ? `step ${rail.headline.n}` : 'this step'
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    void tick($)
    $.clock.every(POLL_MS, () => {
      void tick($)
    })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    try {
      if (e.surface !== 'terminal' || e.props.hasSurvey) return below
      const rail = await read($, railRef)
      if (rail === null) return below
      const row = fitRail(rail, e.props.bodyColumns)
      if (row === null) return below
      const mode = await read($, modeRef)
      const els = $.ui.resolve(e)
      return stack(
        els,
        railTree(els, row, mode, stepLabel(rail), confirmNote(rail), handlers($, rail.rev)),
        below
      )
    } catch {
      return below // fail open: the band is never worse than without the rail
    }
  })
}
```

### `tests/rail.test.ts`

```ts
import { expect, mock, test } from 'claude-code/testing'
import type { On, Register } from 'claude-code'

// A child executor's step, as the host would push it in `ui.band.set` (`rail` field).
const CHILD = {
  v: 1,
  rev: 5,
  role: 'child',
  headline: { kind: 'single', n: 3, to: 3, m: 7 },
  step: {
    title: 'Wire the rail IPC channel',
    level: 'verifier',
    proof: 'unproven',
    state: 'running'
  },
  actions: ['claim', 'block', 'log']
} as const

const band = (bodyColumns: number, hasSurvey = false) =>
  ({
    plugin: 'rail-proto',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey,
      isWorking: true,
      maxRows: 12,
      bodyColumns,
      scroll: { offset: 0, bodyRows: 11 },
      view: {}
    }
  }) as const

type Sent = { t: string; d: Record<string, unknown> }

/** A scripted host behind `$.http.fetch`: records the events, answers the current band. */
function host(on: On, start: unknown) {
  const s = { band: start as unknown, sent: [] as Sent[], down: false }
  on('http.fetch', (_$, e) => {
    if (s.down) throw new Error('connect ECONNREFUSED')
    const body = JSON.parse(String(e.init?.body ?? '{}')) as {
      events?: Sent[]
    }
    s.sent.push(...(body.events ?? []))
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({ band: s.band })
      }
    }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // The engine beneath every plugin: its own (empty) band.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'engine' }) as JSX.Element
  })
  return s
}

test('fits the child row to bodyColumns and cuts in the declared order', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  host(on, CHILD)
  await $.session.start({
    cwd: '/work/repo',
    surface: 'terminal',
    isInteractive: true
  })
  await clock.settle()

  const rows: Record<number, { text: string | undefined; buttons: string[] }> = {}
  for (const cols of [39, 40, 60, 90, 120]) {
    const ui = await $.ui.mount(band(cols))
    const text = (await ui.find({ type: 'Text', text: /^◆/ }))?.text
    const buttons = (await ui.findAll({ type: 'Button' })).map((b) => b.key ?? '')
    rows[cols] = { text, buttons }
    await ui.unmount()
  }
  expect(rows[39]).toEqual({ text: undefined, buttons: [] })
  expect(rows[40]).toEqual({ text: '◆ Step 3 of 7 · Running', buttons: [] })
  expect(rows[60]).toEqual({
    text: '◆ Step 3 of 7 · Running',
    buttons: ['rail-claim', 'rail-block', 'rail-log']
  })
  expect(rows[90]?.text).toBe('◆ Step 3 of 7 · Wire the rail IPC channel · Running')
  expect(rows[120]?.text).toBe('◆ Step 3 of 7 · Wire the rail IPC channel · Running · Verifier')
})

test('claim is two presses and sends the action and revision, never a step id', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const h = host(on, CHILD)
  await $.session.start({
    cwd: '/work/repo',
    surface: 'terminal',
    isInteractive: true
  })
  await clock.settle()

  const ui = await $.ui.mount(band(120))
  await ui.press({ key: 'rail-claim' })
  expect(h.sent).toEqual([])
  expect((await ui.find({ type: 'Text', text: /Claim step 3 as done\?/ }))?.text).toBeDefined()

  // The host applies it and answers the next revision.
  h.band = {
    ...CHILD,
    rev: 6,
    step: { ...CHILD.step, proof: 'claimed', state: 'done' },
    actions: ['block', 'log']
  }
  await ui.press({ key: 'rail-yes' })
  expect(h.sent).toEqual([{ t: 'ui.action', d: { name: 'step.claim', rev: 5 } }])
  expect((await ui.find({ type: 'Text', text: /^◆/ }))?.text).toBe(
    '◆ Step 3 of 7 · Wire the rail IPC channel · Claimed · Verifier'
  )
  expect(await ui.find({ key: 'rail-claim' })).toBeUndefined()
})

test('a blocker reason is typed into the band; an empty one cancels', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const h = host(on, CHILD)
  await $.session.start({
    cwd: '/work/repo',
    surface: 'terminal',
    isInteractive: true
  })
  await clock.settle()

  const ui = await $.ui.mount(band(120))
  await ui.press({ key: 'rail-log' })
  await ui.input({ key: 'rail-log', text: '   ' })
  expect(h.sent).toEqual([])
  expect(await ui.find({ key: 'rail-claim' })).toBeDefined()

  await ui.press({ key: 'rail-block' })
  await ui.input({ key: 'rail-block', text: '  needs the staging API key ' })
  expect(h.sent).toEqual([
    {
      t: 'ui.action',
      d: { name: 'step.block', rev: 5, text: 'needs the staging API key' }
    }
  ])
})

test('Harnu unreachable: the press says nothing was saved and the line expires', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const h = host(on, CHILD)
  await $.session.start({
    cwd: '/work/repo',
    surface: 'terminal',
    isInteractive: true
  })
  await clock.settle()

  const ui = await $.ui.mount(band(120))
  h.down = true
  await ui.press({ key: 'rail-unblock' }).catch(() => undefined) // not offered: no such button
  await ui.press({ key: 'rail-claim' })
  await ui.press({ key: 'rail-yes' })
  expect((await ui.find({ type: 'Text', text: /^◆/ }))?.text).toMatch(
    /· Harnu is not reachable\. Nothing was saved\.$/
  )
  // The buttons stay: a band with nothing focusable hands the keys back to the prompt (§5.3).
  expect((await ui.findAll({ type: 'Button' })).map((b) => b.key)).toEqual([
    'rail-claim',
    'rail-block',
    'rail-log'
  ])

  await clock.advance(92_000)
  expect(await ui.find({ type: 'Text', text: /^◆/ })).toBeUndefined()
})

const otherBand: Register = (on) => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await next(e)
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'other mod row') as JSX.Element
  })
}

test(
  'wraps what another mod drew and yields to a survey',
  { plugins: [{ name: 'other', register: otherBand }] },
  async ($, on) => {
    const clock = mock.clock(on, { now: 1_000 })
    host(on, CHILD)
    await $.session.start({
      cwd: '/work/repo',
      surface: 'terminal',
      isInteractive: true
    })
    await clock.settle()

    const ui = await $.ui.mount(band(120))
    expect(await ui.find({ type: 'Text', text: /^◆ Step 3 of 7/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'other mod row' })).toBeDefined()
    await ui.unmount()

    const survey = await $.ui.mount(band(120, true))
    expect(await survey.find({ type: 'Text', text: /^◆/ })).toBeUndefined()
  }
)

test('blocked: the reason outranks the title, the level goes first', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  host(on, {
    ...CHILD,
    step: {
      ...CHILD.step,
      state: 'todo',
      blocker: { reason: 'needs the staging API key', owner: 'operator' }
    },
    staleMin: 135,
    actions: ['unblock', 'log']
  })
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const text = async (cols: number) => {
    const ui = await $.ui.mount(band(cols))
    const t = (await ui.find({ type: 'Text', text: /^◆/ }))?.text
    await ui.unmount()
    return t
  }
  expect(await text(139)).toBe(
    '◆ Step 3 of 7 · Wire the rail IPC channel · Blocked: needs the staging API key · Verifier · mission stale 2h 15m'
  )
  expect(await text(115)).toBe(
    '◆ Step 3 of 7 · Wire the rail… · Blocked: needs the staging API key · mission stale 2h 15m'
  )
  expect(await text(75)).toBe('◆ Step 3 of 7 · Blocked')
})
```

### The type-check config

Kept outside the mod folder, as the types file's header prescribes for a mod whose types the
engine has not laid yet. `<types>` is the `claude-code.d.ts` the `plugin-authoring` skill wrote
for 2.1.295.

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "types": [],
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "jsx": "react",
    "jsxFactory": "h",
    "jsxFragmentFactory": "Fragment"
  },
  "include": ["<types>", "../rail-proto/hooks", "../rail-proto/types", "../rail-proto/tests"]
}
```

## 3. Runs (2026-10-09)

Output pasted as printed; only the scratchpad path is shortened to `<scratchpad>`. The session's
own Claude Code was 2.1.295; the CLI on `PATH` updated itself to 2.1.296 during the session, so
the kit runs are shown on both binaries (the 2.1.295 one run by its versioned path).

```
$ claude plugin validate rail-proto   # Claude Code 2.1.295
Validating plugin manifest: <scratchpad>/rail-proto/.claude-plugin/plugin.json

  ❯ types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
  ❯ types ./types/index.d.ts declares state: rail-proto.rail, rail-proto.mode

Validating hooks: <scratchpad>/rail-proto/hooks/hooks.json

  ❯ ./register.ts hooks: session.start, ui.render{component=AbovePrompt}
  ❯ ./register.ts calls: $.clock.every, $.clock.now (via sync, tick), $.http.fetch (via sync), $.state.get, $.state.set, $.ui.resolve
  ❯ ./register.ts state writes: rail-proto.mode, rail-proto.rail
  ❯ ./register.ts state reads: rail-proto.mode, rail-proto.rail

✔ Validation passed
(exit 0)

$ claude plugin test rail-proto   # Claude Code 2.1.295

tests/rail.test.ts:
(pass) fits the child row to bodyColumns and cuts in the declared order [44.69ms]
(pass) claim is two presses and sends the action and revision, never a step id [19.18ms]
(pass) a blocker reason is typed into the band; an empty one cancels [20.78ms]
(pass) Harnu unreachable: the press says nothing was saved and the line expires [83.01ms]
(pass) wraps what another mod drew and yields to a survey [19.94ms]
(pass) blocked: the reason outranks the title, the level goes first [19.12ms]

 6 pass
 0 fail
Ran 6 tests across 1 file. [0.31s]
(exit 0)

$ claude plugin test rail-proto   # Claude Code 2.1.296 (the CLI updated during the session)
 6 pass
 0 fail
Ran 6 tests across 1 file. [0.32s]

$ tsc -p tsc-rail   # TypeScript 5.6.3 against the 2.1.295 claude-code.d.ts
(exit 0, no output)
```

The tests were checked against two deliberate breakages before they were trusted: dropping
`{below}` from `stack` fails "wraps what another mod drew…", and adding a `stepId` to the press
event fails both press tests. Both were reverted.

## 4. Live session (2026-10-09, Claude Code 2.1.295, tmux 3.4)

`tsc` and the kit exercise the hooks and the tree, never a surface's key routing or paint
(`TYPES:15584`, and the header at `TYPES:41-44`). The design hinges on three things only a live session shows: that the
band draws inside a real terminal, which keys reach a band Button, and what happens to the keys
after a press. So the same mod ran in a real interactive session:

1. A stand-in host (`node host.mjs`, 23 lines) on `127.0.0.1:47999` answered every POST with the
   child band of the tests and logged every event; on `step.claim` it bumped `rev` and set the
   step to `claimed`/`done`.
2. `claude --plugin-dir <scratchpad>/rail-proto` in a detached tmux session, 120 × 30, in an empty
   folder. No prompt was submitted in the final run.
3. Keys sent with `tmux send-keys`; after each, the rows holding `◆` and `❯` were captured with
   `tmux capture-pane`. The engine pads the band row to the `[-]` mark at the right edge; that
   padding is collapsed to two spaces below.

```
== start, 120 columns
◆ Step 3 of 7 · Wire the rail IPC channel · Running  c: Claim  b: Block  l: Log  [-]
❯ Try "how does <filepath> work?"
== c typed with the prompt focused
◆ Step 3 of 7 · Wire the rail IPC channel · Running  c: Claim  b: Block  l: Log  [-]
❯ c
== ctrl+x tab, then c
◆ Claim step 3 as done? A verifier still checks it.  y: Claim  n: Cancel  [-]
❯ Try "how does <filepath> work?"
== y
◆ Step 3 of 7 · Wire the rail IPC channel · Claimed  b: Block  l: Log  [-]
❯ Try "how does <filepath> work?"
== b
◆ Blocker on step 3: what blocks it (Enter on empty cancels) ⏎ raise  [-]
❯ Try "how does <filepath> work?"
== reason typed, Enter
◆ Step 3 of 7 · Wire the rail IPC channel · Claimed  b: Block  l: Log  [-]
❯ Try "how does <filepath> work?"
== Esc, then 1 typed into the empty prompt
◆ Step 3 of 7 · Wire the rail IPC channel · Claimed  b: Block  l: Log  [-]
❯ 1
== terminal width 144
◆ Step 3 of 7 · Wire the rail IPC channel · Claimed · Verifier  b: Block  l: Log  [-]
❯ Try "how does <filepath> work?"
== terminal width 80
◆ Step 3 of 7 · Claimed  b: Block  l: Log  [-]
❯ Try "how does <filepath> work?"
== terminal width 62
◆ Step 3 of 7 · Claimed  [-]
❯ Try "how does <filepath> work?"
== terminal width 45
◆ Step 3 of 7 · Claimed  [-]
❯ Try "how does <filepath> work?"
== terminal width 38
❯ Try "how does <filepath> work?"
== host log
{"listening":47999}
{"at":1791575769735,"ev":{"t":"ui.action","d":{"name":"step.claim","rev":5}}}
{"at":1791575772049,"ev":{"t":"ui.action","d":{"name":"step.block","rev":6,"text":"needs the staging API key"}}}
```

A separate run with the host killed: pressing `l`, typing a note and Enter drew
`◆ Step 3 of 7 · Wire the rail IPC channel · Claimed · Harnu is not reachable. Nothing was saved.  b: Block  l: Log`,
and 95 s later the band row was gone (TTL 90 s, poll 2 s): the capture held no `◆` row.

### Finding F-1: a band with nothing focusable hands the keys back to the prompt

The first live run used a build whose "saving" state drew no Button. After `ctrl+x tab`, `c`, `y`,
the confirm row's buttons unmounted, nothing in the band could hold the focus, and the keys
returned to the prompt. The next `b` and the typed blocker reason went into the prompt, and Enter
**submitted them to the model as a user turn** (`❯ bneeds the staging API key`; the turn was
interrupted with Esc before any tool ran). In an executor's session that is operator text
delivered to the executor's model, the very thing the rail must never do.

The fix, kept in the source above and required by spec §7.5: every rail state draws at least one
focusable element (the action buttons stay drawn while saving and while Harnu is unreachable; a
press in those states is ignored or retries). With it, the final run above kept the focus across
the claim and the blocker input, and `Enter` in the band's `Input` sent the event and submitted
nothing.

## 5. What the runs prove, and what they do not

| Claim                                                                                        | Shown by                            |
| -------------------------------------------------------------------------------------------- | ----------------------------------- |
| The row is fitted to `bodyColumns` and cut in the order of spec §6.2                         | kit test 1 and 6; live, five widths |
| `bodyColumns` is the terminal width less 5 (120 columns draw the 90–119 tier)                | live, 120 and 144 columns           |
| The rail wraps what plugins beneath it drew and yields to a survey                           | kit test 5                          |
| A press leaves with the action and the revision, never a step id                             | kit tests 2 and 3; live host log    |
| Claim is two presses; an empty blocker or note cancels                                       | kit tests 2 and 3; live             |
| Letters reach a band Button only after `ctrl+x tab`; with the prompt focused they are typed  | live (`c` typed into the prompt)    |
| A digit typed into an empty prompt stays in the prompt when no band Button holds a digit     | live (`1`)                          |
| The focus survives a press only while the band keeps a focusable element (F-1)               | live, both builds                   |
| Harnu unreachable: the press says nothing was saved; the line expires after the TTL          | kit test 4; live, host killed       |
| A `.ts` hooks module may import a `.tsx` view (P4W2 §7.4's open risk)                        | validate, kit, live                 |
| **Not shown:** the companion channel, the host half, Harnu's xterm.js, the fullscreen layout | spec §12 W0, LV-T454-a/b            |
