import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  back,
  done,
  endRun,
  fail,
  followAnyway,
  newRun,
  report,
  skip,
  startRun,
  tryAgain,
  type Run
} from '../src/shared/walk-machine'
import { toMachineChecks, type WalkScript } from '../src/shared/walk-schema'
import {
  explainAction,
  freshUi,
  keyContext,
  paneView,
  sourceHeader,
  tickExtra,
  type T,
  type WalkData,
  type WalkUi
} from '../src/renderer/src/lib/walk-view'
import { closeOutText } from '../src/main/walk/walk-turn'
import { createWalkService, type WalkRuntime } from '../src/main/walk/walk-service'
import { createWalkProbe } from '../src/main/walk/walk-links'
import type { DeliveryOutcome, UserTurnPayload } from '../src/main/browser/page-delivery'

// the walk-ipc module imports electron for its handlers; only its pure functions are exercised here
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() },
  app: { isPackaged: false, getPath: () => tmpdir() }
}))
import { rerunSavedWalk } from '../src/main/walk/walk-ipc'

// ---- words: the real en.json, so a missing key fails here --------------------------------------

const en = JSON.parse(
  readFileSync(join(__dirname, '../src/renderer/src/i18n/en.json'), 'utf8')
) as Record<string, unknown>
const t: T = (key, params) => {
  const v = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en)
  if (typeof v !== 'string') throw new Error(`missing i18n key ${key}`)
  return v.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''))
}

// ---- fixtures ------------------------------------------------------------------------------------

const check = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `TITLE-${id}`,
  why: `why ${id}`,
  where: { text: `where-${id}`, links: [{ label: 'PR 101', kind: 'pr', target: '101' }] },
  do: [{ text: `Do the thing for ${id}. Type \`standup\`.`, see: `see-${id}` }],
  passes: `passes-${id}`,
  fails: `fails-${id}`,
  nothingFromHere: 'only eyes can tell',
  ...over
})

const baseScript = (over: Partial<WalkScript> = {}): WalkScript =>
  ({
    title: 'Search box on the notes list',
    purpose: 'check',
    source: { kind: 'feature', text: 'A search box on the notes list.' },
    checks: [
      check('c1'),
      check('c2', {
        nothingFromHere: undefined,
        check: { how: 'curl the preview and count rows' }
      }),
      check('c3', {
        nothingFromHere: undefined,
        check: { how: 'rg -l standup src' },
        blocks: ['c4'],
        blocksWhy: 'need the running app'
      }),
      check('c4')
    ],
    ...over
  }) as unknown as WalkScript

const dataFor = (script: WalkScript, run: Run, over: Partial<WalkData> = {}): WalkData => ({
  folder: '/home/user/example-web',
  walkDir: '/home/user/example-web/.harnu/walks/wlk-5d2e91ab',
  walkId: 'wlk-5d2e91ab',
  runId: 'run-81c0ffee',
  rev: 1,
  script,
  deepenings: [],
  simpler: [],
  added: [],
  run,
  closeOut: null,
  ownerSessionId: 'sess-owner',
  tick: { revealed: [], ticked: {} },
  held: false,
  waitMs: 30_000,
  now: 1_000,
  saved: null,
  criteria: [],
  mission: null,
  ...over
})

const ok = (r: { ok: true; run: Run } | { ok: false; error: { code: string } }): Run => {
  if (!r.ok) throw new Error(`refused ${r.error.code}`)
  return r.run
}
const ready = (script: WalkScript): Run => newRun(toMachineChecks(script), { n: 1 })
const live = (script: WalkScript): Run => ok(startRun(ready(script), 100))
const ui = (over: Partial<WalkUi> = {}): WalkUi => ({ ...freshUi(), ...over })
const ids = (v: { outcomes: { id: string }[] }): string[] => v.outcomes.map((o) => o.id)

// ---- AC-12 ---------------------------------------------------------------------------------------

describe('walk view', () => {
  it('roadmap first, one check, a bare count and a source header', () => {
    const script = baseScript({
      checks: [
        check('c0', { status: 'verified', evidence: 'vitest 4 passed' }),
        ...(baseScript().checks as unknown as Record<string, unknown>[])
      ] as never
    })
    // the pane opens on the roadmap: every row, pre-closed ones drawn but not numbered
    const rm = paneView(dataFor(script, ready(script)), ui(), t)
    expect(rm.mode).toBe('roadmap')
    expect(rm.progress).toBeNull()
    expect(rm.roadmap?.rows.map((r) => r.n)).toEqual([null, 1, 2, 3, 4])
    expect(rm.roadmap?.rows[0]).toMatchObject({ glyph: '✓', how: { kind: 'earlier' } })
    expect(rm.roadmap?.sub).toBe('4 checks · 1 already verified')
    expect(rm.primary).toBe('start')
    expect(rm.outcomes.map((o) => o.label)).toEqual(['Start with 1'])

    // Start with 1: exactly one check is rendered, and nothing of the next
    let run = ok(startRun(ready(script), 100))
    const v1 = paneView(dataFor(script, run), ui(), t)
    expect(v1.mode).toBe('check')
    expect(v1.check?.checkId).toBe('c1')
    const wire = JSON.stringify(v1)
    expect(wire).toContain('TITLE-c1')
    for (const next of ['TITLE-c2', 'TITLE-c3', 'TITLE-c4', 'passes-c2', 'where-c2', 'see-c2'])
      expect(wire).not.toContain(next)
    // a check that blocks later ones says so quietly, with the numbers of those checks
    run = ok(done(run, 200))
    run = ok(done(run, 300)) // c2 has an agent check: awaiting
    expect(run.checks.find((c) => c.id === 'c2')?.state).toBe('awaiting')

    // the progress: `Check n of N`, one 4 px cell per check to walk, no other text
    const p = v1.progress!
    expect(Object.keys(p).sort()).toEqual(['cells', 'label', 'n', 'total'])
    expect(p.label).toBe('Check 1 of 4')
    expect(p.cells).toEqual(['current', 'rest', 'rest', 'rest'])
    const r2 = ok(report(run, { checkId: 'c2', result: 'pass', evidence: '12 rows', now: 400 }))
    const v3 = paneView(dataFor(script, r2), ui(), t)
    expect(v3.progress?.label).toBe('Check 3 of 4')
    expect(v3.progress?.cells).toEqual(['closed', 'closed', 'current', 'rest'])
    expect(v3.check?.blocksLine).toEqual({ from: 4, to: 4, why: 'need the running app' })

    // the source header, one reading per kind
    const hdr = (source: WalkScript['source'], extra = {}): ReturnType<typeof sourceHeader> =>
      sourceHeader(source, t, extra)
    expect(
      hdr({
        kind: 'pr',
        number: 48,
        title: 'Add CSV export',
        author: 'alex',
        url: 'https://example.org/pull/48'
      })
    ).toMatchObject({
      icon: 'git-pull-request',
      text: 'PR #48 · Add CSV export · alex',
      link: 'pr',
      copy: 'https://example.org/pull/48'
    })
    expect(hdr({ kind: 'pr', number: 7, title: 'A', author: 'b' }).copy).toBeNull()
    expect(hdr({ kind: 'feature', text: 'The CSV export' })).toMatchObject({
      icon: 'lightbulb',
      text: 'The CSV export',
      link: null,
      copy: null
    })
    expect(hdr({ kind: 'branch', branch: 'card/dark-theme', base: 'main' })).toMatchObject({
      text: 'card/dark-theme → main',
      link: null
    })
    expect(hdr({ kind: 'card', slug: 'release-0-14' }).text).toBe('Card · release-0-14')
    const mission = {
      title: 'Redesign the Mission view',
      stepTitle: 'Build the dropdown',
      milestoneTitle: 'Dropdown and library'
    }
    expect(
      hdr({ kind: 'mission', missionId: 'mnt-1', scope: 'step', id: 'stp-1' }, { mission })
    ).toMatchObject({
      icon: 'target',
      text: 'Mission · Redesign the Mission view · step “Build the dropdown”',
      link: 'mission'
    })
    expect(
      hdr({ kind: 'mission', missionId: 'mnt-1', scope: 'milestone', id: 'mls-1' }, { mission })
        .text
    ).toBe('Mission · Redesign the Mission view · milestone “Dropdown and library”')
    expect(hdr({ kind: 'mission', missionId: 'mnt-1', scope: 'mission' }, { mission }).text).toBe(
      'Mission · Redesign the Mission view · the whole mission'
    )
    // a re-run carries its chip
    expect(hdr({ kind: 'feature', text: 'x' }, { runN: 4 }).runChip).toBe('Re-run · run 4')
    expect(hdr({ kind: 'feature', text: 'x' }, { runN: 1 }).runChip).toBeNull()
  })

  // ---- AC-13 -------------------------------------------------------------------------------------

  it('five outcomes whenever a check asks for an answer', () => {
    const script = baseScript()
    const FIVE = ['done', 'failed', 'back', 'skip', 'explain']

    // a fresh check: the five, Done first and primary with its Enter chip, none a dialog
    const run = live(script)
    const v = paneView(dataFor(script, run), ui(), t)
    expect(ids(v)).toEqual(FIVE)
    expect(v.outcomes[0]).toMatchObject({ look: 'primary', chip: 'Enter', label: 'Done' })
    expect(v.outcomes.every((o) => o.dialog === false)).toBe(true)
    expect(v.outcomes.filter((o) => o.chip).length).toBe(1) // the Enter chip is on the primary only
    expect([...keyContext(v, ui()).available]).toEqual(FIVE)

    // after Failed the same check asks again: Try again takes Done's slot, the other four stay
    const failed = ok(fail(run, { line: 'the box is empty', now: 150 }))
    const vf = paneView(dataFor(script, failed), ui(), t)
    expect(vf.check?.phase).toBe('failed')
    expect(ids(vf)).toEqual(['try-again', 'failed', 'back', 'skip', 'explain'])
    expect(vf.primary).toBe('try-again')
    // Failed itself opens one line and a paste target: the form, with Send and a way back, and nothing else
    // Failed pressed on a fresh check opens the same form before anything is sent
    expect(paneView(dataFor(script, run), ui({ formOpen: true }), t).mode).toBe('failed-form')
    const form = paneView(dataFor(script, failed), ui({ formOpen: true }), t)
    expect(form.mode).toBe('failed-form')
    expect(ids(form)).toEqual(['send', 'cancel-form'])

    // a check with an agent check, once Done: the pane shows one quiet line and NO actions
    let aw = ok(tryAgain(failed))
    aw = ok(skip(aw, 160)) // c1 skipped, c2 served
    aw = ok(done(aw, 1_000))
    const wait = paneView(dataFor(script, aw, { now: 1_500 }), ui(), t)
    expect(wait.check?.phase).toBe('awaiting')
    expect(wait.check?.quiet).toBe('awaiting')
    expect(wait.outcomes).toEqual([])
    expect(wait.primary).toBeNull()
    // the wait runs from delivery: Continue without the check appears after it, and only it
    const late = paneView(dataFor(script, aw, { now: 1_000 + 30_000 }), ui(), t)
    expect(ids(late)).toEqual(['continue-without'])

    // the agent disagrees: the evidence card and only what the rules call for
    const dis = ok(
      report(aw, { checkId: 'c2', result: 'fail', evidence: 'found 14 rows', now: 1_100 })
    )
    const vd = paneView(dataFor(script, dis), ui(), t)
    expect(vd.check?.phase).toBe('disagrees')
    expect(vd.check?.evidence).toMatchObject({
      ran: 'curl the preview and count rows',
      found: 'found 14 rows'
    })
    expect(ids(vd)).toEqual(['try-again', 'follow-anyway', 'back']) // a non-blocking check may follow anyway
    // a blocking check holds: no Follow anyway, Treat as failed instead
    let blocking = ok(done(live(script), 150)) // c1 verified, c2 served
    blocking = ok(done(blocking, 160)) // c2 awaiting
    blocking = ok(report(blocking, { checkId: 'c2', result: 'pass', evidence: 'ok', now: 180 }))
    blocking = ok(done(blocking, 190)) // c3 awaiting (it blocks c4)
    blocking = ok(
      report(blocking, { checkId: 'c3', result: 'fail', evidence: 'no file', now: 200 })
    )
    const vb = paneView(dataFor(script, blocking), ui(), t)
    expect(vb.check?.checkId).toBe('c3')
    expect(vb.check?.blocking).toBe(true)
    expect(ids(vb)).toEqual(['try-again', 'treat-as-failed', 'back'])
    // none of them is Done, and Back is always there to return
    expect(ids(vb)).not.toContain('done')
  })

  // ---- AC-16 -------------------------------------------------------------------------------------

  it('close-out rail, you block and summary', async () => {
    // four independent checks, walked to four different ends
    const script = baseScript({
      checks: ['c1', 'c2', 'c3', 'c4'].map((id) =>
        check(id, {
          ...(id === 'c2' ? { nothingFromHere: undefined, check: { how: 'curl it' } } : {}),
          ...(id === 'c1'
            ? {
                edge: [
                  { id: 'e1', text: 'Narrow the window.', see: 'It fits.' },
                  { id: 'e2', text: 'Switch to dark.', see: 'Readable.' }
                ]
              }
            : {})
        })
      ) as never
    })
    let run = live(script)
    run = ok(done(run, 200)) // c1 verified (eyes)
    run = ok(done(run, 210)) // c2 awaiting
    run = ok(
      report(run, { checkId: 'c2', result: 'fail', evidence: 'MissionDropdown.vue', now: 220 })
    )
    run = ok(followAnyway(run, 230)) // c2 caveat
    run = ok(skip(run, 240)) // c3 skipped
    run = ok(fail(run, { line: 'the header row is missing', now: 250 })) // c4 failed
    run = ok(endRun(run, 260))
    expect(run.state).toBe('ended')
    const closeOut = closeOutText(run, script)

    const tick = { revealed: ['c1'], ticked: { c1: ['e1'] } }
    const v = paneView(dataFor(script, run, { closeOut, tick }), ui(), t)
    expect(v.mode).toBe('closeout')
    const co = v.closeout!
    // one row per check, each with how it was verified
    expect(co.rows.map((r) => r.glyph)).toEqual(['✓', '!', '-', '✗'])
    expect(co.rows[0].how).toBe('you confirmed · nothing to check from here')
    expect(co.rows[1].how).toBe('followed anyway · my check found MissionDropdown.vue')
    expect(co.rows[2].how).toBe('skipped')
    expect(co.rows[3].how).toBe('failed · “the header row is missing”')
    // the unticked extra checks (of a check whose card was opened)
    expect(co.unticked).toEqual([
      { checkId: 'c1', n: 1, title: 'TITLE-c1', items: ['Switch to dark.'] }
    ])
    // Still yours: drawn because something is owed; no mission means no criteria and no link
    expect(co.owed).not.toBeNull()
    expect(co.owed?.parts).toBe(
      '1 skipped check, 1 failed check and 1 unverified check are listed above.'
    )
    expect(co.owed?.criteria).toEqual([])
    expect(co.owed?.link).toBeNull()
    // no footer button, and no control that settles anything
    expect(v.outcomes).toEqual([])
    expect(JSON.stringify(v)).not.toMatch(/settle/i)
    // a Saved in Walks card on every source
    expect(co.saved).toBeDefined()
    // the copyable summary: a counts line, then one line per check that did not pass
    expect(co.summary).toBe(closeOut)
    const lines = co.summary.split('\n')
    expect(lines[0]).toBe('1 verified · 1 unverified · 1 skipped · 1 failed')
    expect(lines).toHaveLength(1 + 3)
    expect(co.sub).toBe('1 verified · 1 unverified · 1 skipped · 1 failed')

    // a mission source: the open criteria, read live, and the link to the operator's own door
    const mScript = baseScript({
      source: { kind: 'mission', missionId: 'mnt-1', scope: 'step', id: 'stp-1' }
    })
    const mv = paneView(
      dataFor(mScript, run, {
        closeOut,
        criteria: [
          { id: 'ac-1', text: 'Check the scores by hand', state: 'open' },
          { id: 'ac-2', text: 'Types and build pass', state: 'settled' }
        ]
      }),
      ui(),
      t
    )
    expect(mv.closeout?.owed?.link).toBe('mission')
    expect(mv.closeout?.owed?.note).toBe('I never tick it for you.')
    expect(mv.closeout?.owed?.criteria.map((c) => [c.id, c.state, c.open])).toEqual([
      ['ac-1', 'criterion open', true],
      ['ac-2', 'criterion settled', false]
    ])
    expect(mv.outcomes).toEqual([]) // still nothing that settles
    // a mission that is gone
    const gone = paneView(
      dataFor(mScript, run, {
        closeOut,
        criteria: [{ id: 'ac-1', text: 'x y z', state: 'unavailable' }]
      }),
      ui(),
      t
    )
    expect(gone.closeout?.owed?.criteria[0].state).toBe('mission not available')

    // nothing owed: no card, one quiet line
    const allDone = baseScript({ checks: [check('c1')] as never })
    let r1 = live(allDone)
    r1 = ok(done(r1, 200))
    expect(r1.state).toBe('ended')
    const nv = paneView(dataFor(allDone, r1, { closeOut: closeOutText(r1, allDone) }), ui(), t)
    expect(nv.closeout?.owed).toBeNull()
    expect(nv.closeout?.nothingOwed).toBe(true)

    // the SAME text goes to the session as one `closed` turn
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'walk-view-')))
    try {
      const turns: UserTurnPayload[] = []
      const runtime: WalkRuntime = {
        async deliver(turn): Promise<DeliveryOutcome> {
          turns.push(turn)
          return { status: 'delivered', sessionId: 'sess-owner', woke: false }
        },
        async openPane() {
          return false
        }
      }
      const svc = createWalkService(root, { runtime: () => runtime })
      const opened = await svc.open({
        sessionId: 'sess-owner',
        script: {
          title: 'Search box',
          purpose: 'check',
          source: { kind: 'feature', text: 'A search box.' },
          checks: [check('c1'), check('c2')]
        },
        probe: createWalkProbe({
          folder: root,
          knownFolders: [root],
          cardSlugs: () => [],
          mission: () => null
        })
      })
      if (!opened.ok) throw new Error(JSON.stringify(opened))
      const a = { walkId: opened.walkId, runId: opened.runId }
      await svc.operate({ ...a, op: 'start' })
      await svc.operate({ ...a, op: 'done' })
      await svc.operate({ ...a, op: 'skip' })
      await svc.operate({ ...a, op: 'close-out-with-skipped' })
      await svc.idle()
      const rec = await svc.store.readRun(a.walkId, a.runId)
      const walk = await svc.store.readWalk(a.walkId)
      expect(rec?.run.state).toBe('ended')
      const pane = paneView(dataFor(walk!.script, rec!.run, { closeOut: rec!.closeOut }), ui(), t)
      const closed = turns.filter(
        (x) => x.text.startsWith('[harnu-walk]') && x.text.includes('closed')
      )
      expect(closed).toHaveLength(1)
      expect(pane.closeout?.summary).toBeTruthy()
      expect(closed[0].text).toContain(pane.closeout!.summary)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // ---- AC-17 -------------------------------------------------------------------------------------

  it('explain more reveals teach and edge, folds back and ticks never block Done', () => {
    const edge = [
      { text: 'Narrow the window to 375 px.', see: 'The two rows still fit.' },
      { text: 'Switch to the dark theme.', see: 'The text stays readable.' }
    ].map((e, i) => ({ ...e, id: `e${i + 1}` }))
    const teach = {
      what: 'The box filters on every keystroke.',
      where: [
        { label: 'filter-notes.ts', kind: 'file', target: 'src/notes/filter-notes.ts', line: 18 }
      ],
      idea: {
        text: 'A debounced filter.',
        link: { label: 'debounce', kind: 'url', target: 'https://example.org/debounce' }
      },
      why: 'The list is small.'
    }
    const learn = baseScript({
      purpose: 'learn',
      checks: [
        check('c1', { more: 'It is the feature.', teach, edge }),
        check('c2'),
        check('c3')
      ] as never
    })
    const run = live(learn)
    const closed = paneView(dataFor(learn, run), ui(), t)
    const open = paneView(dataFor(learn, run), ui({ explainOpen: true }), t)

    // a walk-through teaches first and folds the edge checks under it
    expect(open.check?.explain.open).toBe(true)
    expect(open.check?.explain.order).toEqual(['teach', 'more', 'edge'])
    expect(open.check?.explain.foldEdge).toBe(true)
    expect(open.check?.explain.teach).toMatchObject({
      what: 'The box filters on every keystroke.',
      why: 'The list is small.'
    })
    expect(open.check?.explain.teach?.where[0]).toMatchObject({
      label: 'filter-notes.ts',
      line: 18
    })
    expect(open.check?.explain.more).toEqual(['It is the feature.'])
    expect(open.check?.explain.extras.map((e) => [e.id, e.ticked])).toEqual([
      ['e1', false],
      ['e2', false]
    ])
    // a QA walk shows `more` and the edge checks first
    const qa = baseScript({ checks: [check('c1', { more: 'x'.repeat(10), teach, edge })] as never })
    expect(
      paneView(dataFor(qa, live(qa)), ui({ explainOpen: true }), t).check?.explain
    ).toMatchObject({
      order: ['more', 'edge', 'teach'],
      foldEdge: false
    })

    // it never moves the cursor or the count
    const pos = (v: ReturnType<typeof paneView>): unknown => [
      v.check?.checkId,
      v.check?.n,
      v.check?.total,
      v.progress
    ]
    expect(pos(open)).toEqual(pos(closed))
    // the button is a toggle: a press reveals, a second press folds back
    expect(explainAction(dataFor(learn, run), ui(), 'c1')).toBe('reveal')
    expect(explainAction(dataFor(learn, run), ui({ explainOpen: true }), 'c1')).toBe('fold')
    expect(open.outcomes.find((o) => o.id === 'explain')?.pressed).toBe(true)
    expect(closed.outcomes.find((o) => o.id === 'explain')?.pressed).toBe(false)

    // ticks are saved per run and never block Done
    let tick = tickExtra({ revealed: [], ticked: {} }, 'c1', 'e1')
    expect(tick).toEqual({ revealed: ['c1'], ticked: { c1: ['e1'] } })
    const ticked = paneView(dataFor(learn, run, { tick }), ui({ explainOpen: true }), t)
    expect(ticked.check?.explain.extras.map((e) => e.ticked)).toEqual([true, false])
    expect(ids(ticked)).toEqual(ids(open))
    expect(ticked.primary).toBe('done')
    tick = tickExtra(tick, 'c1', 'e1') // a second tick unticks
    expect(tick.ticked.c1).toEqual([])
    // and Done closes the check with the extras unticked, ending in the close-out list
    const after = ok(done(run, 500))
    expect(after.checks.find((c) => c.id === 'c1')?.state).toBe('verified')

    // when nothing is prepared a press asks the session; deepenings then accumulate
    const bare = baseScript({ checks: [check('c1'), check('c2')] as never })
    const bareRun = live(bare)
    expect(explainAction(dataFor(bare, bareRun), ui(), 'c1')).toBe('ask')
    const d1 = {
      checkId: 'c1',
      more: 'Why it matters, once.',
      extra: [{ id: 'e1', text: 'First extra.', see: 'Seen.' }],
      addedInRun: 1,
      at: 10
    }
    const d2 = {
      checkId: 'c1',
      more: 'And a second paragraph.',
      extra: [{ id: 'e2', text: 'Second extra.', see: 'Seen too.' }],
      addedInRun: 1,
      at: 20
    }
    expect(explainAction(dataFor(bare, bareRun, { deepenings: [d1] }), ui(), 'c1')).toBe('reveal')
    const both = paneView(
      dataFor(bare, bareRun, { deepenings: [d1, d2] }),
      ui({ explainOpen: true }),
      t
    )
    expect(both.check?.explain.more).toEqual(['Why it matters, once.', 'And a second paragraph.'])
    expect(both.check?.explain.extras.map((e) => e.id)).toEqual(['e1', 'e2'])
    // while the session answers: a quiet "asking", and every other outcome stays live
    const asking = paneView(
      dataFor(bare, bareRun),
      ui({ asking: { explain: ['c1'], simpler: [] } }),
      t
    )
    expect(asking.check?.asking.explain).toBe(true)
    expect(ids(asking)).toEqual(['done', 'failed', 'back', 'skip', 'explain'])
    // a deepening a later run added is hidden from an earlier run
    const later = { ...d2, addedInRun: 2 }
    expect(
      paneView(dataFor(bare, bareRun, { deepenings: [later] }), ui({ explainOpen: true }), t).check
        ?.explain.extras
    ).toEqual([])
  })

  // ---- AC-46 -------------------------------------------------------------------------------------

  it('the simpler card keeps the position and the door shows from the second failure', () => {
    const script = baseScript()
    const run = live(script)
    const plain = paneView(dataFor(script, run), ui(), t)
    const card = {
      checkId: 'c1',
      text: 'There is a box. Type in it.',
      do: [{ text: 'Click the box.', see: 'A caret blinks.' }],
      addedInRun: 1,
      at: 50
    }
    const withCard = paneView(dataFor(script, run, { simpler: [card] }), ui(), t)
    // same check, same position, same actions
    expect(withCard.check?.checkId).toBe(plain.check?.checkId)
    expect([withCard.check?.n, withCard.check?.total, withCard.progress]).toEqual([
      plain.check?.n,
      plain.check?.total,
      plain.progress
    ])
    expect(ids(withCard)).toEqual(ids(plain))
    expect(withCard.check?.simpler).toEqual({ text: 'There is a box. Type in it.' })
    expect(withCard.check?.do.map((d) => d.n)).toEqual([1])
    expect(withCard.check?.lost).toBe(true) // the link stays: a later press replaces the card
    // a later press replaces the card (the log keeps the earlier one)
    const second = { ...card, text: 'Even simpler: click and type.', at: 90 }
    expect(
      paneView(dataFor(script, run, { simpler: [card, second] }), ui(), t).check?.simpler?.text
    ).toBe('Even simpler: click and type.')
    // a card a later run added is not shown to an earlier run
    expect(
      paneView(dataFor(script, run, { simpler: [{ ...card, addedInRun: 2 }] }), ui(), t).check
        ?.simpler
    ).toBeNull()
    // while the session answers
    expect(
      paneView(dataFor(script, run), ui({ asking: { explain: [], simpler: ['c1'] } }), t).check
        ?.asking.simpler
    ).toBe(true)

    // the escalation door: not after the first failure, from the second
    const f1 = ok(fail(run, { line: 'nothing happens', now: 100 }))
    expect(paneView(dataFor(script, f1), ui(), t).check?.door).toBeNull()
    const f2 = ok(fail(ok(tryAgain(f1)), { line: 'still nothing', now: 200 }))
    expect(paneView(dataFor(script, f2), ui(), t).check?.door).toEqual({ kind: 'feature' })
    // the door names the source: a PR walk drafts a comment, a mission walk goes to the builder
    const pr = baseScript({ source: { kind: 'pr', number: 48, title: 'A', author: 'b' } })
    expect(paneView(dataFor(pr, f2), ui(), t).check?.door).toEqual({ kind: 'pr' })
    const ms = baseScript({
      source: { kind: 'mission', missionId: 'mnt-1', scope: 'step', id: 'stp-1' }
    })
    expect(paneView(dataFor(ms, f2), ui(), t).check?.door).toEqual({ kind: 'mission' })
    // Back leads with the check's undo
    const undo = baseScript({
      checks: [check('c1', { undo: 'Clear the search box.' }), check('c2')] as never
    })
    let ur = live(undo)
    ur = ok(done(ur, 100))
    expect(paneView(dataFor(undo, ok(back(ur))), ui(), t).check?.undo).toBe('Clear the search box.')
  })

  // ---- AC-49 -------------------------------------------------------------------------------------

  describe('re-run offer', () => {
    let root: string
    beforeEach(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), 'walk-rerun-')))
    })
    afterEach(() => rmSync(root, { recursive: true, force: true }))

    it('the roadmap offers to re-run a saved walk and discards the unstarted one', async () => {
      const script = baseScript()
      // one line, only on the roadmap of a walk that has not started
      const saved = { walkId: 'wlk-aaaaaaaa', lastRun: { verified: 4, total: 6 } }
      const offer = paneView(dataFor(script, ready(script), { saved }), ui(), t)
      expect(offer.roadmap?.rerunOffer).toEqual({
        walkId: 'wlk-aaaaaaaa',
        text: 'Re-run the saved walk (4 of 6 passed)?'
      })
      expect(paneView(dataFor(script, ready(script)), ui(), t).roadmap?.rerunOffer).toBeNull()
      const started = paneView(
        dataFor(script, live(script), { saved }),
        ui({ roadmapOpen: true }),
        t
      )
      expect(started.roadmap?.readOnly).toBe(true)
      expect(started.roadmap?.rerunOffer).toBeNull() // read-only mid-walk: no offer, no primary action
      expect(started.primary).toBeNull()

      // accepting: a re-run of the saved walk starts, and the new walk (never started) is discarded
      const svc = createWalkService(root, {
        runtime: () => ({
          deliver: async () => ({ status: 'delivered', sessionId: 's', woke: false }),
          openPane: async () => false
        })
      })
      const probe = createWalkProbe({
        folder: root,
        knownFolders: [root],
        cardSlugs: () => [],
        mission: () => null
      })
      const src = { kind: 'feature', text: 'A search box.' }
      const mk = async (): Promise<{ walkId: string; runId: string }> => {
        const r = await svc.open({
          sessionId: 'sess-owner',
          script: { title: 'Search box', purpose: 'check', source: src, checks: [check('c1')] },
          probe
        })
        if (!r.ok) throw new Error(JSON.stringify(r))
        return { walkId: r.walkId, runId: r.runId }
      }
      const first = await mk()
      await svc.operate({ ...first, op: 'start' })
      await svc.operate({ ...first, op: 'done' }) // c1 has nothing to check from here: verified, the run ends
      expect((await svc.store.readRun(first.walkId, first.runId))?.run.state).toBe('ended')
      const second = await mk() // the same source again: a new walk, ready

      const res = await rerunSavedWalk(svc.store, {
        newWalkId: second.walkId,
        newRunId: second.runId,
        savedWalkId: first.walkId
      })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.walkId).toBe(first.walkId)
      const runs = await svc.store.listRuns(first.walkId)
      expect(runs.map((r) => [r.run.n, r.run.state])).toEqual([
        [1, 'ended'],
        [2, 'ready']
      ])
      expect(res.runId).toBe(runs[1].runId)
      // the new walk never started: it is gone, folder and all
      expect(await svc.store.readWalk(second.walkId)).toBeNull()
      expect(existsSync(svc.store.walkDir(second.walkId))).toBe(false)

      // a walk that was started is never discarded
      const third = await mk()
      await svc.operate({ ...third, op: 'start' })
      // (the saved walk already has a ready run 2, which the store hands back as live-free: refuse on the new walk)
      const refused = await rerunSavedWalk(svc.store, {
        newWalkId: third.walkId,
        newRunId: third.runId,
        savedWalkId: first.walkId
      })
      expect(refused.ok).toBe(false)
      expect(await svc.store.readWalk(third.walkId)).not.toBeNull()
    })
  })
})
