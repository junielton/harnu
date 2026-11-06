/* eslint-disable @typescript-eslint/no-explicit-any -- test code reads drawn trees loosely */
import { expect, test } from 'claude-code/testing'
import { helloOk, installRig, START, defaultScript, type Script } from './support/rig'

/**
 * T589 (T587 U2): the quiet rows. A `UserMessage` row the operator did not type is drawn as a one-line
 * chip (peer reports, task notices) or, for a loop tick that names a mission, as a live card. The
 * fixtures are real rows: a peer's report in the shape the executors send, the notification the
 * engine stores for a finished background command, and a teammate's idle notice.
 */

const ENABLE = ['sense.identity', 'ui.quietRows']
const scriptWith =
  (enable: string[]): Script =>
  (route, body, n) =>
    route === 'hello' ? helloOk(enable) : defaultScript(route, body, n)

const REPORT = [
  'Report for session 19cc0181-9f04-41a9-b93a-18231ee36b64 · mission mnt-7be1529e · step stp-1',
  'Branch feat/t587-u1-tick-line · head 4d3062ba (1 commit over feat/t587-quiet-rows, pushed, clean).',
  'Summary: mission/SKILL.md now mandates the first line on every armed tick prompt; two skills point at it.',
  'AC-1 met. AC-2 met.'
].join('\n')
const NOTICE = 'Background command "Wait for PR #151 CI checks to finish" completed (exit code 0)'
const IDLE = JSON.stringify({
  type: 'idle_notification',
  from: 'ideas-pm',
  timestamp: '2026-10-09T13:17:29.090Z',
  idleReason: 'available',
  result: 'done, 20 ideas — written to scratchpad/ideas/02-pm.md. The team lead has been told.'
})

const ROW = { plugin: 'harnu-companion', component: 'UserMessage' } as const
const SCREEN = { first: 0, last: 2, of: 6 }
const props = (
  text: string,
  origin: Record<string, unknown>,
  over: Record<string, unknown> = {}
) => ({
  text,
  origin,
  isExpanded: false,
  ...over
})

/** What the engine's own drawing, beneath the mod, is handed. */
const mountRow = async ($: any, on: any, enable: string[], p: Record<string, unknown>) => {
  const rig = installRig(on, { script: scriptWith(enable) })
  const seen: unknown[] = []
  on('ui.render', ($: any, e: any) => {
    seen.push(e.props.onScreen)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start(START)
  await rig.clock.settle()
  const ui = await $.ui.mount({ ...ROW, surface: 'terminal', requestId: 'm1', props: p } as never)
  return { ui, seen, rig }
}
const textOf = async (ui: any, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text

// ---- AC-1: only the four origins, never an expanded row ------------------------------------------

const UNTOUCHED: Record<string, unknown>[] = [
  { kind: 'composer' },
  { kind: 'bridge' },
  { kind: 'sdk' },
  { kind: 'unclassified' },
  { kind: 'slack-ping' },
  { kind: 'channel', server: 'slack' },
  { kind: 'coordinator' },
  { kind: 'projects-relay' },
  { kind: 'auto-continuation' }
]
for (const origin of UNTOUCHED) {
  test(`a ${origin.kind} row is never touched, whatever it says`, async ($, on) => {
    const { ui } = await mountRow($, on, ENABLE, props(REPORT, origin, { from: { name: 'u1' } }))
    expect(await textOf(ui, /^engine$/)).toBe('engine')
    expect(await ui.find({ type: 'Text', text: /✉/ })).toBeUndefined()
    await ui.unmount()
  })
}

for (const kind of ['peer', 'peer-send-message', 'task-notification', 'scheduled-trigger']) {
  test(`an expanded ${kind} row (ctrl+o) is the engine's, untouched`, async ($, on) => {
    const { ui } = await mountRow(
      $,
      on,
      ENABLE,
      props(REPORT, { kind }, { isExpanded: true, from: { name: 'u1' } })
    )
    expect(await textOf(ui, /^engine$/)).toBe('engine')
    await ui.unmount()
  })
}

test('with the feature not enabled by the host, no row is drawn', async ($, on) => {
  const { ui } = await mountRow($, on, ['sense.identity'], props(REPORT, { kind: 'peer' }))
  expect(await textOf(ui, /^engine$/)).toBe('engine')
  await ui.unmount()
})

test('onScreen reaches the engine unchanged when the mod steps aside', async ($, on) => {
  const { ui, seen } = await mountRow(
    $,
    on,
    ENABLE,
    props(REPORT, { kind: 'composer' }, { onScreen: SCREEN })
  )
  expect(seen.length).toBeGreaterThan(0)
  for (const s of seen) expect(s).toEqual(SCREEN)
  await ui.unmount()
})

test('a chip is drawn for a row on screen; the props are never rewritten', async ($, on) => {
  const { ui } = await mountRow(
    $,
    on,
    ENABLE,
    props(REPORT, { kind: 'peer' }, { onScreen: SCREEN, from: { name: 'u1-tick-line' } })
  )
  expect(await textOf(ui, /u1-tick-line/)).toBeTruthy()
  expect(await textOf(ui, /^engine$/)).toBeUndefined() // a refused rewrite would show the engine's
  await ui.unmount()
})

// ---- AC-4: the chips -----------------------------------------------------------------------------

test('a peer report is one chip: sender, mission and step, first sentence of the summary', async ($, on) => {
  const { ui } = await mountRow(
    $,
    on,
    ENABLE,
    props(REPORT, { kind: 'peer' }, { from: { name: 'feat-t587-u1-tick-line-c6' } })
  )
  expect(await textOf(ui, /^✉/)).toBeTruthy()
  const line = await ui.find({ type: 'Text', text: /feat-t587-u1-tick-line-c6/ })
  expect(line.text).toMatch(/report · mnt-7be1529e stp-1/)
  expect(line.text).toMatch(/mission\/SKILL\.md now mandates the first line/)
  expect(line.text).not.toMatch(/AC-2/)
  expect(line.props.wrap).toBe('truncate-end') // one line; the full text stays in ctrl+o
  await ui.unmount()
})

test('a peer-send-message without the report header is a chip with the first sentence', async ($, on) => {
  const { ui } = await mountRow(
    $,
    on,
    ENABLE,
    props(
      'Rebased onto main.\nNothing else changed.',
      { kind: 'peer-send-message' },
      { from: { name: 'u2' } }
    )
  )
  const line = await ui.find({ type: 'Text', text: /u2/ })
  expect(line.text).toMatch(/u2 · Rebased onto main\./)
  expect(line.text).not.toMatch(/Nothing else/)
  await ui.unmount()
})

test('a finished background command is a one-line notice with its exit code', async ($, on) => {
  const { ui } = await mountRow(
    $,
    on,
    ENABLE,
    props(NOTICE, { kind: 'task-notification' }, { task: { id: 'b89do1o1o', status: 'completed' } })
  )
  expect(await textOf(ui, /^✓/)).toBeTruthy()
  expect(await textOf(ui, /bg task Wait for PR #151 CI checks to finish · exit 0/)).toBeTruthy()
  await ui.unmount()
})

test('a failed task reads ✗ and carries how long it ran', async ($, on) => {
  const { ui } = await mountRow(
    $,
    on,
    ENABLE,
    props(
      'Agent "review pass" failed',
      { kind: 'task-notification' },
      { task: { status: 'failed', durationMs: 122_000 } }
    )
  )
  expect(await textOf(ui, /^✗/)).toBeTruthy()
  expect(await textOf(ui, /review pass.* · 2m 2s/)).toBeTruthy()
  await ui.unmount()
})

test("a teammate's idle notice is one line with who, when and what they said, no framing", async ($, on) => {
  const { ui } = await mountRow(
    $,
    on,
    ENABLE,
    props(IDLE, { kind: 'peer' }, { from: { name: 'ideas-pm' } })
  )
  expect(await textOf(ui, /^◌/)).toBeTruthy()
  const line = await ui.find({ type: 'Text', text: /ideas-pm idle/ })
  expect(line.text).toMatch(/ideas-pm idle \d\d:\d\d · «done, 20 ideas/)
  expect(line.text).not.toMatch(/idle_notification|not typed by your user/)
  await ui.unmount()
})

// ---- AC-5: fallbacks never throw and never hide text ---------------------------------------------

test('a peer row with nothing parseable draws what the engine draws', async ($, on) => {
  const { ui } = await mountRow($, on, ENABLE, props('   \n  ', { kind: 'peer' }))
  expect(await textOf(ui, /^engine$/)).toBe('engine')
  await ui.unmount()
})

test('a malformed from or task never throws: the chip falls back to the text', async ($, on) => {
  const { ui } = await mountRow(
    $,
    on,
    ENABLE,
    props('All good here.', { kind: 'peer' }, { from: { name: 5 }, task: 'x' })
  )
  expect(await textOf(ui, /All good here\./)).toBeTruthy()
  await ui.unmount()
})

test('a loop tick with no pushed mission state is a plain chip with its first line', async ($, on) => {
  const { ui } = await mountRow(
    $,
    on,
    ENABLE,
    props('/harnu:mission tick · mnt-0a1b2c3d\nread the mission, act, report', {
      kind: 'scheduled-trigger'
    })
  )
  const line = await ui.find({ type: 'Text', text: /mnt-0a1b2c3d/ })
  expect(line.text).toMatch(/tick/)
  expect(await textOf(ui, /^⟳/)).toBeTruthy()
  await ui.unmount()
})

test('a scheduled prompt that names no mission is a plain chip, a long one is cut', async ($, on) => {
  const text = `check the deploy ${'and then some more words '.repeat(40)}`
  const { ui } = await mountRow($, on, ENABLE, props(text, { kind: 'scheduled-trigger' }))
  const line = await ui.find({ type: 'Text', text: /check the deploy/ })
  expect(line.props.wrap).toBe('truncate-end')
  expect(line.text.length).toBeLessThanOrEqual(305)
  await ui.unmount()
})

test('a task notice with no task and odd text still draws a chip', async ($, on) => {
  const { ui } = await mountRow(
    $,
    on,
    ENABLE,
    props('something happened', { kind: 'task-notification' })
  )
  expect(await textOf(ui, /something happened/)).toBeTruthy()
  await ui.unmount()
})

// ---- the idle notice as it really arrives: framed (T589 delta 3, AC-4) ---------------------------

const TEAMMATE = (body: string) =>
  `Another Claude session sent a message:\n<teammate-message teammate_id="ideas-pm" color="purple">\n${body}\n</teammate-message>`
const CROSS = (body: string) =>
  `Another Claude session sent a message:\n<cross-session-message from="uds:/run/user/1000/cc-socks/1.sock" from-name="ideas-pm" from-mode="prompting">\n${body}\n</cross-session-message>`

const FRAMED: [string, string, Record<string, unknown>, Record<string, unknown>][] = [
  [
    'a peer row in a teammate-message wrapper',
    TEAMMATE(IDLE),
    { kind: 'peer' },
    { from: { name: 'ideas-pm' } }
  ],
  [
    'a peer row in a cross-session-message wrapper',
    CROSS(IDLE),
    { kind: 'peer' },
    { from: { name: 'ideas-pm' } }
  ],
  [
    'a peer-send-message row in a wrapper',
    TEAMMATE(IDLE),
    { kind: 'peer-send-message' },
    { from: { name: 'ideas-pm' } }
  ],
  [
    'a task-notification under the idle notice marker, JSON on the same line',
    `[Cross-session idle notice] ${IDLE}`,
    { kind: 'task-notification' },
    {}
  ],
  [
    'a task-notification under the idle notice marker, JSON on the next line',
    `[Cross-session idle notice]\n${IDLE}`,
    { kind: 'task-notification' },
    {}
  ],
  [
    'a task-notification with the marker and a wrapper',
    `[Cross-session idle notice]\n${TEAMMATE(IDLE)}`,
    { kind: 'task-notification' },
    {}
  ]
]
for (const [name, text, origin, over] of FRAMED) {
  test(`${name} is the idle chip, with no framing and no raw JSON`, async ($, on) => {
    const { ui } = await mountRow($, on, ENABLE, props(text, origin, over))
    const line = await ui.find({ type: 'Text', text: /idle/ })
    expect(line.text).toMatch(/^ideas-pm idle \d\d:\d\d · «done, 20 ideas/)
    expect(await textOf(ui, /^◌/)).toBeTruthy()
    for (const t of await ui.findAll({ type: 'Text' })) {
      expect(String(t.text)).not.toMatch(
        /idle_notification|\{"|Cross-session|teammate-message|sent a message/
      )
    }
    await ui.unmount()
  })
}

test('an idle notice marker with plain words is an idle chip of those words, without the marker', async ($, on) => {
  const { ui } = await mountRow(
    $,
    on,
    ENABLE,
    props('[Cross-session idle notice] acme-phase-a is now idle.', { kind: 'task-notification' })
  )
  expect(await textOf(ui, /^◌/)).toBeTruthy()
  expect(await textOf(ui, /^acme-phase-a is now idle\.$/)).toBeTruthy()
  await ui.unmount()
})
