/* eslint-disable @typescript-eslint/no-explicit-any -- test code reads drawn trees loosely */
import { expect, test } from 'claude-code/testing'
import { cardTone, splitReports, type Report, type Segment } from '../hooks/lib/report-card'
import { helloOk, installRig, START, defaultScript, type Script } from './support/rig'

/**
 * T583 U2: the report card. The fixtures are the two bundled skills' own examples
 * (`status` and `report-back`), an English and a pt-BR report, and the shape of the T579 report.
 * A ledger row is built by `row` so the 2-wide gutter and the 9-wide label are never miscounted.
 */

const row = (gutter: string, label: string, value: string): string =>
  `${gutter.padEnd(2)}${label.padEnd(9)}${value}`
const fence = (...lines: string[]): string => ['```', ...lines, '```'].join('\n')

// ---- fixtures ------------------------------------------------------------------------------------

const REPORT_BACK_EN = fence(
  'avatar-cache  ▰▰▰▰▰▰▰▱▱▱ 70%',
  '│',
  '├─ ✓ review-local — 2 safe fixes',
  '├─ ✓ commit + push — 3 commits on PROJ-231-fix-avatar-cache',
  '├─ ✓ PR #142 opened',
  '├─ - reviewers — already assigned on the existing PR',
  '├─ ✓ CI green — 12/12 checks',
  '└─ ✗ Copilot — 1 CR needs a product decision',
  '',
  row('⚑', 'you', 'decide the retry config (3 attempts vs backoff)'),
  row('?', 'open', 'does the cache invalidate on logout?'),
  '',
  'PR #142 · diff + threads → https://github.com/org/repo/pull/142',
  'Green CI run → https://github.com/org/repo/actions/runs/9912',
  'Task PROJ-231 → https://tracker.example.com/t/PROJ-231',
  'review-local report → docs/reports/avatar-cache.md'
)
const EN_MESSAGE = `The avatar cache run stopped at one review decision.\n\n${REPORT_BACK_EN}\n\nShipped the fix; the retry config needs a decision before the merge.`

const STATUS_EN = fence(
  '  **T381** mission v3       ▰▰▰▱▱ Step 4 of 5 · 2 verified',
  row('', 'now', 'S4 skills · `8f2c11ab` · 25 min'),
  row('', 'done', 'S1 core · S2 reads · S3 renderer'),
  row('', 'next', 'S5 amendments'),
  row('⚑', 'you', 'tick the due check on S3 (designer sign-off)'),
  row('?', 'open', 'S3 is done, not yet verified')
)

const THREE_FRONTS = fence(
  '  **T215** message_session   spec ▰▰▰▱ 3/4 · impl ▱▱▱▱ 0/4',
  row('', 'now', 'gate decision → spec PR · `ab53791f` · 14 min'),
  row('', 'done', 'O-1 answered · gate decided · `#224` merged'),
  row('', 'next', 'predicate spec · implementation · live probe'),
  row('', 'you', "— nothing, you're clear"),
  row('?', 'open', '`--permission-mode auto` never probed'),
  '',
  '! **T216** delivery assurance  S1 ▰▰▱▱ 2/4 · S2–S4 ▱▱▱ 0/3',
  row('!', 'now', 'idle 3 h — waiting on `T215`'),
  row('', 'done', 'research · S0 skills · S1 spec (`#225` merged)'),
  row('', 'next', 'S1 implementation (needs `T215` for the send-back)'),
  row('⚑', 'you', 'decide whether S1 lands before `T215` or waits for it'),
  row('?', 'open', 'wave collision across worktrees (§11 Q4)'),
  '',
  'PR `#224` · spec merged → https://github.com/org/repo/pull/224',
  'PR `#225` · S1 spec → https://github.com/org/repo/pull/225'
)

// pt-BR labels, padded to the same 9 columns: the parser keys on shape, never on the words.
const T579_PT = fence(
  '**T579** aviso ao fechar o app  ▰▰ Passo 2 de 2 ✓',
  row('', 'agora', 'nada'),
  row('', 'feito', 'PR #149 aberto (`3794ae04`) · card em Review'),
  row('', 'próximo', 'você faz o merge do PR #149'),
  row('⚑', 'você', 'testar o teclado num build empacotado · fechar a mission'),
  '  '.padEnd(11) + 'Cancel mantém app e browser panes · Quit fecha',
  row('?', 'aberto', 'os ACs foram escritos por mim, não vieram de uma spec'),
  '',
  'PR #149 · aviso ao fechar → https://github.com/junielton/harnu/pull/149'
)
const T579_RAIL = fence(
  'T579',
  '│',
  '├─ ✓ Topologia — unidade única, PR direto para main',
  '├─ ✓ Heartbeat — loop parado · watchdog 76f16855 desligado',
  '├─ ! macOS — fechar a janela também avisa (mata os terminais)',
  '└─ ✓ Revisão — 1 bug (AC-3) corrigido + teste de regressão',
  '',
  row('⚑', 'você', 'fechar a mission'),
  '',
  'PR #149 → https://github.com/junielton/harnu/pull/149'
)

const TREE = fence('src', '├── main', '│   └── index.ts', '├── preload', '└── renderer')

// ---- the parser (AC-1, AC-2, AC-3) ---------------------------------------------------------------

const reports = (segments: Segment[] | null): Report[] =>
  (segments ?? []).flatMap((s) => (s.kind === 'report' ? [s.report] : []))

test('a reply with no report is left alone', () => {
  expect(splitReports('Just a sentence.')).toBeNull()
  expect(splitReports('Some code:\n\n```ts\nconst a = 1\n```\n')).toBeNull()
  expect(splitReports('')).toBeNull()
})

test('an English report-back splits into the sentence, the card and the summary', () => {
  const segments = splitReports(EN_MESSAGE)
  expect(segments?.map((s) => s.kind)).toEqual(['text', 'report', 'text'])
  expect((segments?.[0] as { text: string }).text).toContain('stopped at one review decision')
  expect((segments?.[2] as { text: string }).text).toContain('needs a decision')
  const [r] = reports(segments)
  expect(r.header).toMatchObject({ title: 'avatar-cache', bar: { filled: 7, total: 10 } })
  expect(r.header?.detail).toBe('70%')
  expect(r.rail.map((x) => x.glyph)).toEqual(['✓', '✓', '✓', '-', '✓', '✗'])
  expect(r.rail[0]).toEqual({ glyph: '✓', text: 'review-local — 2 safe fixes' })
  expect(r.ledger).toEqual([
    { gutter: 'owed', label: 'you', lines: ['decide the retry config (3 attempts vs backoff)'] },
    { gutter: 'open', label: 'open', lines: ['does the cache invalidate on logout?'] }
  ])
  expect(r.links).toHaveLength(4)
  expect(r.links[0]).toEqual({
    label: 'PR #142 · diff + threads',
    target: 'https://github.com/org/repo/pull/142'
  })
  expect(r.links[3]).toEqual({
    label: 'review-local report',
    target: 'docs/reports/avatar-cache.md'
  })
})

test('a status glance card parses: bold id, bar, gutter rows', () => {
  const [r] = reports(splitReports(`Status.\n\n${STATUS_EN}`))
  expect(r.header).toMatchObject({
    mark: null,
    title: 'T381 mission v3',
    bar: { filled: 3, total: 5 },
    detail: 'Step 4 of 5 · 2 verified'
  })
  expect(r.ledger.map((x) => [x.gutter, x.label])).toEqual([
    ['none', 'now'],
    ['none', 'done'],
    ['none', 'next'],
    ['owed', 'you'],
    ['open', 'open']
  ])
  expect(r.rail).toEqual([])
})

test('three fronts in one fence become three reports', () => {
  const rs = reports(splitReports(THREE_FRONTS))
  expect(rs).toHaveLength(2) // the two with a header; the links belong to the last
  expect(rs[0].header?.title).toBe('T215 message_session')
  expect(rs[1].header).toMatchObject({ mark: '!', title: 'T216 delivery assurance' })
  expect(rs[1].ledger[0]).toMatchObject({ gutter: 'warn', label: 'now' })
  expect(rs[1].links).toHaveLength(2)
})

test('pt-BR labels and a ledger continuation line parse by shape', () => {
  const [r] = reports(splitReports(`Pronto.\n\n${T579_PT}`))
  expect(r.header).toMatchObject({
    title: 'T579 aviso ao fechar o app',
    bar: { filled: 2, total: 2 }
  })
  expect(r.header?.detail).toBe('Passo 2 de 2 ✓')
  const owed = r.ledger.find((x) => x.gutter === 'owed')
  expect(owed?.label).toBe('você')
  expect(owed?.lines).toEqual([
    'testar o teclado num build empacotado · fechar a mission',
    'Cancel mantém app e browser panes · Quit fecha'
  ])
  expect(r.ledger.find((x) => x.gutter === 'open')?.label).toBe('aberto')
  expect(r.links[0].label).toBe('PR #149 · aviso ao fechar')
})

test('a rail report without a bar still draws when it has a ledger', () => {
  const [r] = reports(splitReports(T579_RAIL))
  expect(r.header).toMatchObject({ title: 'T579', bar: null })
  expect(r.rail).toHaveLength(4)
  expect(r.ledger).toHaveLength(1)
})

test('only the report fence is replaced; a tree block beside it stays text', () => {
  const segments = splitReports(`Layout:\n\n${TREE}\n\n${REPORT_BACK_EN}\n\nDone.`)
  expect(segments?.filter((s) => s.kind === 'report')).toHaveLength(1)
  const first = segments?.[0] as { kind: 'text'; text: string }
  expect(first.text).toContain('├── main')
})

test('the card tone follows the markers: all ✓ green, any ✗ red, else accent', () => {
  const tone = (...rail: string[]) =>
    cardTone(reports(splitReports(fence('x  ▰▰ 1/2', ...rail, '', row('', 'you', '—'))))[0])
  expect(tone('├─ ✓ a — b', '└─ ✓ c — d')).toBe('ok')
  expect(tone('├─ ✓ a — b', '└─ ✗ c — d')).toBe('fail')
  expect(tone('├─ ✓ a — b', '└─ ! c — d')).toBe('accent')
  expect(tone('├─ ✓ a — b', '└─ - c — d')).toBe('accent')
})

// ---- malformed and partial reports fall back (AC-3) ----------------------------------------------

const FALLBACKS: [string, string][] = [
  ['no closing fence', `Report:\n\n${REPORT_BACK_EN.split('\n').slice(0, 8).join('\n')}`],
  ['a rail without a ledger', fence('x  ▰▰ 1/2', '│', '├─ ✓ a — b', '└─ ✓ c — d')],
  ['a ledger without a header or a rail', fence(row('⚑', 'you', 'merge it'))],
  ['a tree output', TREE],
  [
    'a bare URL beside the card',
    REPORT_BACK_EN.replace('```\n', '```\nhttps://github.com/org/repo/pull/142\n')
  ],
  ['a bare URL', 'https://github.com/org/repo/pull/142'],
  [
    'an unknown line inside the block',
    fence('x  ▰▰ 1/2', row('', 'you', 'a'), 'something else entirely')
  ],
  ['a row far past any sane length', fence('x  ▰▰ 1/2', row('', 'you', 'x'.repeat(5000)))],
  [
    'a label wider than its column',
    fence('x  ▰▰ 1/2', '  Em andamento nothing here', row('', 'you', '—'))
  ]
]
for (const [name, text] of FALLBACKS) {
  test(`falls back untouched: ${name}`, () => {
    expect(splitReports(text)).toBeNull()
  })
}

test('the parser never throws on hostile input', () => {
  const nasty = [
    '```',
    '```\n```',
    '```\n\n```',
    '├─ ✓',
    '⚑ ',
    '▰'.repeat(10_000),
    '```\n' + '├─ ✓ a\n'.repeat(5000) + '```'
  ]
  for (const text of nasty) {
    let out: unknown = 'threw'
    try {
      out = splitReports(text)
    } catch {
      out = 'threw'
    }
    expect(out === 'threw').toBe(false)
  }
})

// ---- the hook (AC-1, AC-2, AC-3, AC-4) -----------------------------------------------------------

const ENABLE = ['sense.identity', 'ui.reportCard']
const scriptWith =
  (enable: string[]): Script =>
  (route, body, n) =>
    route === 'hello' ? helloOk(enable) : defaultScript(route, body, n)

const ASSISTANT = { plugin: 'harnu-companion', component: 'AssistantMessage' } as const
const props = (text: string, over: Record<string, unknown> = {}) => ({
  text,
  isFirstOfReply: true,
  ...over
})

const mountWith = async ($: any, on: any, enable: string[], text: string, over = {}) => {
  const rig = installRig(on, { script: scriptWith(enable) })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start(START)
  await rig.clock.settle()
  return $.ui.mount({ ...ASSISTANT, surface: 'terminal', props: props(text, over) } as never)
}

const textOf = async (ui: any, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text

test('a reply with no report draws exactly what the engine draws', async ($, on) => {
  const ui = await mountWith($, on, ENABLE, 'Just a sentence, no report.')
  expect(await textOf(ui, /^engine$/)).toBe('engine')
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  await ui.unmount()
})

test('a recognized report draws as the card, and text around it stays Markdown', async ($, on) => {
  const ui = await mountWith($, on, ENABLE, EN_MESSAGE)
  expect(await textOf(ui, /^engine$/)).toBeUndefined() // the engine drawing is replaced
  expect(
    (await ui.find({ type: 'Markdown', text: /stopped at one review decision/ }))?.text
  ).toBeTruthy()
  expect((await ui.find({ type: 'Markdown', text: /needs a decision/ }))?.text).toBeTruthy()
  expect(await textOf(ui, /avatar-cache/)).toBeTruthy()
  // the owed row sits in its own box, not in the card
  expect(await textOf(ui, /you · 1/)).toBeTruthy()
  expect(await textOf(ui, /decide the retry config/)).toBeTruthy()
  // PR numbers and URLs are links
  const link = await ui.find({ type: 'Link', text: /#142|pull\/142/ })
  expect(link?.props.href).toBe('https://github.com/org/repo/pull/142')
  await ui.unmount()
})

test('long rows truncate at the edge; the card border follows the state', async ($, on) => {
  const ui = await mountWith($, on, ENABLE, EN_MESSAGE)
  const rows = await ui.findAll({ type: 'Text', text: /commit \+ push|Copilot/ })
  expect(rows.length).toBeGreaterThan(0)
  for (const r of rows) expect(r.props.wrap).toBe('truncate-end')
  const boxes = await ui.findAll({ type: 'Box' })
  const borders = boxes.map((b: any) => b.props.borderColor).filter(Boolean)
  expect(borders).toContain('error') // the report has a ✗
  expect(borders).toContain('warning') // and an owed row
  await ui.unmount()
})

test('the whole-green card is green', async ($, on) => {
  const green = `Done.\n\n${fence('x  ▰▰ 2/2', '├─ ✓ a — b', '└─ ✓ c — d', '', row('', 'you', "— nothing, you're clear"))}`
  const ui = await mountWith($, on, ENABLE, green)
  const borders = (await ui.findAll({ type: 'Box' })).map((b: any) => b.props.borderColor)
  expect(borders).toContain('success')
  expect(borders).not.toContain('warning') // nothing owed: no yellow box
  await ui.unmount()
})

const HOOK_FALLBACKS: [string, string][] = [
  ['an unterminated fence', 'Report:\n\n```\nx  ▰▰ 1/2\n' + row('', 'you', 'a')],
  ['a tree output', `Layout:\n\n${TREE}`],
  ['a rail without a ledger', fence('x  ▰▰ 1/2', '│', '├─ ✓ a — b')],
  ['a bare URL', 'See https://github.com/org/repo/pull/142 for details.']
]
for (const [name, text] of HOOK_FALLBACKS) {
  test(`${name} draws what the engine draws, with no failure`, async ($, on) => {
    const ui = await mountWith($, on, ENABLE, text)
    expect(await textOf(ui, /^engine$/)).toBe('engine')
    await ui.unmount()
  })
}

test('with the feature not enabled by the host, nothing is drawn', async ($, on) => {
  const ui = await mountWith($, on, ['sense.identity'], EN_MESSAGE)
  expect(await textOf(ui, /^engine$/)).toBe('engine')
  await ui.unmount()
})

test('a summary block is never redrawn', async ($, on) => {
  const ui = await mountWith($, on, ENABLE, EN_MESSAGE, { isSummary: true })
  expect(await textOf(ui, /^engine$/)).toBe('engine')
  await ui.unmount()
})

test('onScreen is carried: a drawn card does not touch it', async ($, on) => {
  const rig = installRig(on, { script: scriptWith(ENABLE) })
  const seen: unknown[] = []
  on('ui.render', ($: any, e: any) => {
    seen.push(e.props.onScreen)
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start(START)
  await rig.clock.settle()
  const ui = await $.ui.mount({
    ...ASSISTANT,
    surface: 'terminal',
    props: props(EN_MESSAGE, { onScreen: 'full' })
  } as never)
  // the hook never rewrites props, so what the engine below sees is what the engine sent
  expect(seen.every((s) => s === 'full')).toBe(true)
  expect(await textOf(ui, /avatar-cache/)).toBeTruthy()
  await ui.unmount()
})

test('another component is not touched', async ($, on) => {
  const rig = installRig(on, { script: scriptWith(ENABLE) })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start(START)
  await rig.clock.settle()
  const ui = await $.ui.mount({
    plugin: 'harnu-companion',
    component: 'UserMessage',
    surface: 'terminal',
    props: { text: EN_MESSAGE }
  } as never)
  expect(await textOf(ui, /^engine$/)).toBe('engine')
  await ui.unmount()
})
