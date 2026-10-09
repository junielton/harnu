# T454 — Prototype tests (round 2)

The prototype's kit tests and its type-check config, split out for length. The mod they test is
in [`03-prototype-source.md`](03-prototype-source.md); their output is in
[`01-prototype.md`](01-prototype.md) §3. Part of the [T454 spec](00-spec.md).

### `tests/rail.test.ts`

```ts
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
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

const BLOCKED = {
  ...CHILD,
  step: {
    ...CHILD.step,
    state: 'todo',
    blocker: { reason: 'needs the staging API key', owner: 'operator' }
  },
  staleMin: 135,
  actions: ['unblock', 'log']
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
type Band = Mounted<'terminal', 'AbovePrompt'>
// The kit's environment prints `console.log`; the hooks-module types declare no `console`.
declare const console: { log: (...a: unknown[]) => void }

/** A scripted host behind `$.http.fetch`: records the events, answers the current band. */
function host(on: On, start: unknown) {
  const s = { band: start as unknown, sent: [] as Sent[], down: false }
  on('http.fetch', (_$, e) => {
    if (s.down) throw new Error('connect ECONNREFUSED')
    const body = JSON.parse(String(e.init?.body ?? '{}')) as { events?: Sent[] }
    s.sent.push(...(body.events ?? []))
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ band: s.band }) } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // The engine beneath every plugin: its own (empty) band.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'engine' }) as JSX.Element
  })
  return s
}

/** The rail's row as drawn: its text, its keys, and the cells they take (text, two spaces, keys). */
async function row(ui: Band) {
  const text = (await ui.find({ type: 'Text', text: /^◆/ }))?.text
  // A plain Button with a hotkey draws `c: Claim` (live run); `text` holds the label alone.
  const buttons = (await ui.findAll({ type: 'Button' })).map(
    (b) => `${String(b.props.hotkey)}: ${b.text}`
  )
  const inputs = (await ui.findAll({ type: 'Input' })).map((i) => i.key ?? '')
  const cells = text === undefined ? 0 : text.length + buttons.reduce((w, b) => w + 2 + b.length, 0)
  return { text, buttons, inputs, cells, focusable: buttons.length + inputs.length }
}

async function start($: Engine, on: On, first: unknown) {
  const clock = mock.clock(on, { now: 1_000 })
  const h = host(on, first)
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, h }
}

test('fits the child row to bodyColumns and cuts in the declared order', async ($, on) => {
  await start($, on, CHILD)
  const at = async (cols: number) => {
    const ui = await $.ui.mount(band(cols))
    const r = await row(ui)
    await ui.unmount()
    return r
  }
  expect((await at(39)).text).toBeUndefined()
  expect(await at(40)).toMatchObject({ text: '◆ Step 3 of 7 · Running', buttons: ['c: Claim'] })
  expect(await at(75)).toMatchObject({
    text: '◆ Step 3 of 7 · Wire the rail IPC ch… · Running',
    buttons: ['c: Claim', 'b: Block', 'l: Log']
  })
  expect((await at(115)).text).toBe(
    '◆ Step 3 of 7 · Wire the rail IPC channel · Running · Verifier'
  )
})

test('claim is two presses and sends the action and revision, never a step id', async ($, on) => {
  const { h } = await start($, on, CHILD)
  const ui = await $.ui.mount(band(115))
  await ui.press({ key: 'rail-claim' })
  expect(h.sent).toEqual([])
  expect((await row(ui)).text).toBe('◆ Claim step 3 as done? A verifier still checks it.')

  h.band = {
    ...CHILD,
    rev: 6,
    step: { ...CHILD.step, proof: 'claimed', state: 'done' },
    actions: ['block', 'log']
  }
  await ui.press({ key: 'rail-yes' })
  expect(h.sent).toEqual([{ t: 'ui.action', d: { name: 'step.claim', rev: 5 } }])
  expect((await row(ui)).text).toBe(
    '◆ Step 3 of 7 · Wire the rail IPC channel · Claimed · Verifier'
  )
  expect(await ui.find({ key: 'rail-claim' })).toBeUndefined()
})

test('a blocker reason is typed into the band; an empty one cancels', async ($, on) => {
  const { h } = await start($, on, CHILD)
  const ui = await $.ui.mount(band(115))
  await ui.press({ key: 'rail-log' })
  await ui.input({ key: 'rail-log', text: '   ' })
  expect(h.sent).toEqual([])
  expect(await ui.find({ key: 'rail-claim' })).toBeDefined()

  await ui.press({ key: 'rail-block' })
  await ui.input({ key: 'rail-block', text: '  needs the staging API key ' })
  expect(h.sent).toEqual([
    { t: 'ui.action', d: { name: 'step.block', rev: 5, text: 'needs the staging API key' } }
  ])
})

test('Harnu unreachable: nothing was saved, Retry and Dismiss, fitted at every width', async ($, on) => {
  const { h, clock } = await start($, on, CHILD)
  const ui = await $.ui.mount(band(115))
  h.down = true
  await ui.press({ key: 'rail-claim' })
  await ui.press({ key: 'rail-yes' })
  for (const cols of [115, 75, 40]) {
    const u = await $.ui.mount(band(cols))
    const r = await row(u)
    expect(r.text).toMatch(/Nothing was saved\.$/)
    expect(r.buttons).toContain('x: Dismiss')
    expect(r.cells).toBeLessThanOrEqual(cols)
    await u.unmount()
  }
  // Retry reaches the host again once it is back; the claim lands with the same revision.
  h.down = false
  await ui.press({ key: 'rail-retry' })
  expect(h.sent).toEqual([{ t: 'ui.action', d: { name: 'step.claim', rev: 5 } }])

  // Idle, keys drawn, Harnu goes down with no press: past the TTL the row turns final, a key kept.
  h.down = true
  await clock.advance(92_000)
  expect(await row(ui)).toMatchObject({
    text: '◆ Harnu is not reachable.',
    buttons: ['x: Dismiss']
  })
})

test('F-1: an open field or confirm outlives every push, expiry and width; an idle row keeps a key', async ($, on) => {
  const { clock, h } = await start($, on, CHILD)
  const ui = await $.ui.mount(band(115))
  const focusable = async () => (await row(ui)).focusable

  // 1. The blocker Input is open; the mission closes (the host pushes null). The field stays;
  //    finishing it sends nothing and says so.
  await ui.press({ key: 'rail-block' })
  h.band = null
  await clock.advance(2_100)
  expect((await row(ui)).inputs).toEqual(['rail-block'])
  await ui.input({ key: 'rail-block', text: 'needs the staging API key' })
  expect(h.sent).toEqual([])
  expect(await row(ui)).toMatchObject({
    text: '◆ Mission closed or step unlinked. Nothing was saved.',
    buttons: ['x: Dismiss']
  })
  await ui.press({ key: 'rail-dismiss' })
  expect((await row(ui)).text).toBeUndefined() // the person dismissed it: now it may go

  // 2. The log Input is open; Harnu goes down; the line expires. The field stays at every tick.
  h.band = CHILD
  await clock.advance(2_100)
  await ui.press({ key: 'rail-log' })
  h.down = true
  for (let t = 0; t < 46; t++) {
    await clock.advance(2_000)
    expect(await focusable()).toBeGreaterThan(0)
  }
  expect((await row(ui)).inputs).toEqual(['rail-log'])
  await ui.input({ key: 'rail-log', text: 'tried the fixture again' })
  expect((await row(ui)).text).toBe('◆ Harnu is not reachable. Nothing was saved.')
  await ui.press({ key: 'rail-dismiss' })

  // 3. Idle with keys drawn; the host turns the actions off (Ask mode): a Dismiss replaces them.
  h.down = false
  h.band = { ...CHILD, rev: 7 }
  await clock.advance(2_100)
  expect(await focusable()).toBe(3)
  h.band = { ...CHILD, rev: 8, actions: [] }
  await clock.advance(2_100)
  expect((await row(ui)).buttons).toEqual(['x: Dismiss'])

  // 4. The claim confirm is open; the host drops Claim and the width falls to 59 and 39. The
  //    confirm stays with both keys; `y` then sends nothing and says the step changed.
  h.band = { ...CHILD, rev: 9 }
  await clock.advance(2_100)
  await ui.press({ key: 'rail-claim' })
  h.band = { ...CHILD, rev: 10, actions: ['block', 'log'] }
  await clock.advance(2_100)
  for (const cols of [59, 39]) {
    const u = await $.ui.mount(band(cols))
    const r = await row(u)
    expect(r.buttons.length).toBe(2)
    expect(r.cells).toBeLessThanOrEqual(cols)
    await u.unmount()
  }
  await ui.press({ key: 'rail-yes' })
  expect(h.sent).toEqual([])
  expect((await row(ui)).text).toBe('◆ The step changed. Nothing was saved.')
})

test('a refused press says so once, inside the width', async ($, on) => {
  const { h, clock } = await start($, on, CHILD)
  const ui = await $.ui.mount(band(115))
  h.band = { ...CHILD, rev: 6, result: { action: 'claim', ok: false, code: 'MISSION_CLOSED' } }
  await clock.advance(2_100)
  expect((await row(ui)).text).toBe(
    '◆ Step 3 of 7 · Wire the rail IPC channel · Not saved: mission closed. · Verifier'
  )
  for (const cols of [75, 40]) {
    const u = await $.ui.mount(band(cols))
    const r = await row(u)
    expect(r.text).toMatch(/Not saved/)
    expect(r.cells).toBeLessThanOrEqual(cols)
    await u.unmount()
  }
})

test('blocked: the reason outranks the title, the level goes first', async ($, on) => {
  await start($, on, BLOCKED)
  const text = async (cols: number) => {
    const ui = await $.ui.mount(band(cols))
    const t = (await row(ui)).text
    await ui.unmount()
    return t
  }
  expect(await text(139)).toBe(
    '◆ Step 3 of 7 · Wire the rail IPC channel · Blocked: needs the staging API key · Verifier · mission stale 2h 15m'
  )
  expect(await text(115)).toBe(
    '◆ Step 3 of 7 · Wire the rail IPC channel · Blocked: needs the staging API key'
  )
  expect(await text(75)).toBe('◆ Step 3 of 7 · Blocked: needs the staging API key')
  expect(await text(40)).toBe('◆ Step 3 of 7 · Blocked')
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
    await start($, on, CHILD)
    const ui = await $.ui.mount(band(115))
    expect(await ui.find({ type: 'Text', text: /^◆ Step 3 of 7/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'other mod row' })).toBeDefined()
    await ui.unmount()
    const survey = await $.ui.mount(band(115, true))
    expect(await survey.find({ type: 'Text', text: /^◆/ })).toBeUndefined()
  }
)

/** Every state of spec §6.3–§6.4 at 115, 75 and 40: printed for the spec, and none overflows. */
test('every state fits at 115, 75 and 40 (printed)', async ($, on) => {
  const { h, clock } = await start($, on, CHILD)
  const states: [string, unknown][] = [
    ['S3 running', CHILD],
    ['S4 blocked, stale', BLOCKED],
    [
      'S5 claimed',
      {
        ...CHILD,
        step: { ...CHILD.step, proof: 'claimed', state: 'done' },
        actions: ['block', 'log']
      }
    ],
    [
      'S5 self-verified',
      {
        ...CHILD,
        step: { ...CHILD.step, proof: 'self-verified', state: 'done' },
        actions: ['block', 'log']
      }
    ],
    [
      'S5 verified',
      { ...CHILD, step: { ...CHILD.step, proof: 'verified', state: 'verified' }, actions: ['log'] }
    ],
    [
      'S5 done (needs-human)',
      { ...CHILD, step: { ...CHILD.step, proof: 'verified', state: 'done' }, actions: ['log'] }
    ],
    ['S6 stale', { ...CHILD, step: { ...CHILD.step, state: 'waiting' }, staleMin: 135 }],
    [
      'S2 owner',
      {
        v: 1,
        rev: 5,
        role: 'owner',
        headline: { kind: 'range', n: 3, to: 4, m: 7 },
        state: 'blocked',
        actions: []
      }
    ],
    [
      'S7 refused, mission closed',
      { ...CHILD, result: { action: 'claim', ok: false, code: 'MISSION_CLOSED' } }
    ],
    ['logged', { ...CHILD, result: { action: 'log', ok: true } }]
  ]
  const out: string[] = []
  for (const [name, b] of states) {
    h.band = { ...(b as object), rev: 100 + out.length }
    await clock.advance(2_100)
    for (const cols of [115, 75, 40]) {
      const u = await $.ui.mount(band(cols))
      const r = await row(u)
      expect(r.cells).toBeLessThanOrEqual(cols)
      out.push(
        `${name} @${cols}: ${r.text ?? '(no row)'}${r.buttons.map((k) => `  ${k}`).join('')}`
      )
      await u.unmount()
    }
  }
  const main = await $.ui.mount(band(115))
  h.band = { ...CHILD, rev: 500 }
  await clock.advance(2_100)
  await main.press({ key: 'rail-claim' })
  for (const cols of [115, 75, 40, 30]) {
    const u = await $.ui.mount(band(cols))
    const r = await row(u)
    expect(r.cells).toBeLessThanOrEqual(cols)
    out.push(`claim confirm @${cols}: ${r.text}${r.buttons.map((k) => `  ${k}`).join('')}`)
    await u.unmount()
  }
  await main.press({ key: 'rail-no' })
  h.down = true
  await main.press({ key: 'rail-claim' })
  await main.press({ key: 'rail-yes' })
  for (const cols of [115, 75, 40]) {
    const u = await $.ui.mount(band(cols))
    const r = await row(u)
    expect(r.cells).toBeLessThanOrEqual(cols)
    out.push(
      `S8 unreachable after a press @${cols}: ${r.text}${r.buttons.map((k) => `  ${k}`).join('')}`
    )
    await u.unmount()
  }
  const print = async (name: string, widths: number[]) => {
    for (const cols of widths) {
      const u = await $.ui.mount(band(cols))
      const r = await row(u)
      expect(r.cells).toBeLessThanOrEqual(cols)
      const field = (await u.findAll({ type: 'Input' }))[0]
      const shown = field
        ? `${String(field.props.label)}: [${String(field.props.placeholder ?? '')}] ⏎ ${String(field.props.submitLabel)}`
        : `${r.text ?? '(no row)'}${r.buttons.map((k) => `  ${k}`).join('')}`
      out.push(`${name} @${cols}: ${shown}`)
      await u.unmount()
    }
  }
  await main.press({ key: 'rail-dismiss' })
  h.down = false
  h.band = { ...CHILD, rev: 600 }
  await clock.advance(2_100)
  await main.press({ key: 'rail-block' })
  await print('blocker Input', [115, 75, 40])
  h.band = null
  await clock.advance(2_100)
  await main.input({ key: 'rail-block', text: 'needs the staging API key' })
  await print('final, mission closed, a press lost', [115, 75, 40])
  await main.press({ key: 'rail-dismiss' })
  h.band = { ...CHILD, rev: 700 }
  await clock.advance(2_100)
  await main.press({ key: 'rail-claim' })
  h.band = { ...CHILD, rev: 701, actions: ['block', 'log'] }
  await clock.advance(2_100)
  await main.press({ key: 'rail-yes' })
  await print('final, step changed, a press lost', [115, 75, 40])
  await main.press({ key: 'rail-dismiss' })
  h.band = { ...CHILD, rev: 800 }
  await clock.advance(2_100)
  h.band = null
  await clock.advance(2_100)
  // Held: the same band instance drew keys before the line went; it is redrawn at each width.
  for (const cols of [115, 75, 40]) {
    await main.redraw({ ...band(cols).props })
    const r = await row(main)
    expect(r.cells).toBeLessThanOrEqual(cols)
    out.push(
      `final, line gone while the band held keys (idle) @${cols}: ${r.text}${r.buttons.map((k) => `  ${k}`).join('')}`
    )
  }
  console.log(out.join('\n'))
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
