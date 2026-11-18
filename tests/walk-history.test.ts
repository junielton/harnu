import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWalkService, type WalkRuntime } from '../src/main/walk/walk-service'
import {
  closeOutWithSkipped,
  done,
  endRun,
  newRun,
  report,
  skip,
  startRun,
  type Run
} from '../src/shared/walk-machine'
import { toMachineChecks, type WalkScript } from '../src/shared/walk-schema'
import { createWalkProbe } from '../src/main/walk/walk-links'
import { walkLinkKey } from '../src/shared/walk-schema'
import { mapWalkKey } from '../src/renderer/src/lib/walk-keys'
import {
  freshUi,
  keyContext,
  paneView,
  shotLightbox,
  type T,
  type WalkData,
  type WalkUi
} from '../src/renderer/src/lib/walk-view'

// the walk-ipc module imports electron for its handlers; only its pure functions are exercised here
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() },
  app: { isPackaged: false, getPath: () => tmpdir() }
}))
import {
  HELD_AFTER_MS,
  WAKING_AFTER_MS,
  heldAfterMs,
  loadWalk,
  rerunWalk,
  saveShot
} from '../src/main/walk/walk-ipc'

// ---- words: the real en.json, so a missing key fails here --------------------------------------

const en = JSON.parse(
  readFileSync(join(__dirname, '../src/renderer/src/i18n/en.json'), 'utf8')
) as Record<string, unknown>
const words =
  (dict: Record<string, unknown>): T =>
  (key, params) => {
    const v = key
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], dict)
    if (typeof v !== 'string') throw new Error(`missing i18n key ${key}`)
    return v.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''))
  }
const t: T = words(en)
// the second locale: a plural pinned only in English could drift in pt-BR with every test still green (P15)
const ptBR = JSON.parse(
  readFileSync(join(__dirname, '../src/renderer/src/i18n/pt-BR.json'), 'utf8')
) as Record<string, unknown>
const tPt: T = words(ptBR)

// ---- fixtures: a neutral CSV-export walk, run through the real service ---------------------------

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082',
  'hex'
)
const check = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Check ${id}`,
  why: 'why',
  where: { text: 'the page' },
  do: [{ text: 'Do it.', see: 'It works.' }],
  passes: 'It works.',
  fails: 'It does not.',
  nothingFromHere: 'Only eyes can tell.',
  ...over
})
const DAY1 = Date.parse('2026-11-16T12:00:00Z')
const NOW = Date.parse('2026-11-18T12:00:00Z')

let root: string
let clock = DAY1
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'walk-history-')))
  clock = DAY1
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const runtime: WalkRuntime = {
  deliver: async () => ({ status: 'delivered', sessionId: 's', woke: false }),
  openPane: async () => false
}
const probe = () =>
  createWalkProbe({ folder: root, knownFolders: [root], cardSlugs: () => [], mission: () => null })

/** The walk the tests share, opened through the service: five checks, two with the agent's check. */
async function openWalk() {
  const svc = createWalkService(root, { runtime: () => runtime, now: () => clock })
  const opened = await svc.open({
    sessionId: 'sess-owner',
    script: {
      title: 'Add CSV export',
      purpose: 'check',
      source: { kind: 'pr', number: 48, title: 'Add CSV export', author: 'alex' },
      checks: [
        check('c1'),
        check('c2', { nothingFromHere: undefined, check: { how: 'count the rows' } }),
        check('c3'),
        check('c4'),
        check('c5')
      ]
    },
    probe: probe()
  })
  if (!opened.ok) throw new Error(JSON.stringify(opened))
  return { svc, walkId: opened.walkId, runId: opened.runId }
}

/** Run 1, walked: c1 passes, c2 passes with the agent's evidence, c3 skipped, c4 fails with a note and a shot. */
async function walkedOnce() {
  const w = await openWalk()
  const a = { walkId: w.walkId, runId: w.runId }
  const shotDir = w.svc.store.shotsDir(w.walkId, w.runId)
  mkdirSync(shotDir, { recursive: true })
  const shot = join(shotDir, 'shot-1.png')
  writeFileSync(shot, PNG)
  const op = (o: Parameters<typeof w.svc.operate>[0]['op'], x: object = {}) =>
    w.svc.operate({ ...a, op: o, ...x })
  await op('start')
  await op('done') // c1
  await op('done') // c2 awaits the agent...
  await w.svc.report({ ...a, checkId: 'c2', result: 'pass', evidence: 'found 12 rows' })
  await op('skip') // c3
  await op('fail', { line: 'Header row missing when the table is empty.', shot }) // c4
  await w.svc.report({ ...a, checkId: 'c4', kind: 'correction', text: 'Open the filter first.' })
  clock = DAY1 + 3_600_000
  await op('end') // c5 is never reached
  await w.svc.idle()
  return { ...w, shot }
}

const dataOf = async (
  svc: ReturnType<typeof createWalkService>,
  walkId: string,
  runId: string,
  over: Partial<WalkData> = {}
): Promise<WalkData> => {
  const load = await loadWalk(svc, { walkId, runId }, { now: () => NOW })
  if (!load.ok) throw new Error(JSON.stringify(load))
  return { ...(load as unknown as WalkData), ...over }
}
const ui = (over: Partial<WalkUi> = {}): WalkUi => ({ ...freshUi(), ...over })

describe('walk history', () => {
  it('opens a past run read-only with its notes and screenshots', async () => {
    const { svc, walkId, runId, shot } = await walkedOnce()
    // the walk grows after run 1 ended: a deepening and a check that only run 2 has
    await svc.store.updateWalk(walkId, (w) => ({
      ok: true,
      walk: {
        ...w,
        script: { ...w.script, checks: [...w.script.checks, check('c6') as never] },
        deepenings: [{ checkId: 'c1', more: 'ADDED-LATER', addedInRun: 2, at: 1 }],
        added: [{ checkId: 'c6', addedInRun: 2 }]
      }
    }))
    // run 2 is live, so the selector has something else to list
    const again = await svc.store.newRun(walkId)
    if (!again.ok) throw new Error('refused')
    await svc.operate({ walkId, runId: again.runId, op: 'start' })

    const data = await dataOf(svc, walkId, runId)
    // the load carries every run of the walk, oldest first, for the one control
    expect(data.runs?.map((r) => [r.n, r.state])).toEqual([
      [1, 'ended'],
      [2, 'live']
    ])

    const v = paneView(data, ui({ past: true }), t)
    expect(v.mode).toBe('past')
    const past = v.past!
    // read-only: no outcome of a live check, only Re-run (primary) and Export markdown
    expect(v.outcomes.map((o) => o.id)).toEqual(['rerun', 'export'])
    expect(v.primary).toBe('rerun')
    expect(mapWalkKey({ key: 'Enter', target: null }, keyContext(v, ui({ past: true })))).toEqual({
      action: 'rerun'
    })
    expect(past.readOnly).toBe('Read-only')
    expect(past.back).toBe('Walks')
    expect(past.title).toBe('Add CSV export')
    expect(past.sub).toBe('2 passed · 1 failed · 1 skipped · 1 not reached')

    // the run selector names this run and lists the walk's other runs
    expect(past.run.label).toBe('Run 1 · Nov 16')
    expect(past.run.options).toEqual([
      { runId, n: 1, label: 'Run 1 · Nov 16', current: true, live: false },
      { runId: again.runId, n: 2, label: 'Run 2 · in progress', current: false, live: true }
    ])

    // the rail: one row per check THE RUN HAD (c6 was added later and is hidden), as it was when it ended
    expect(past.rows.map((r) => [r.n, r.glyph, r.title, r.how])).toEqual([
      [1, '✓', 'Check c1', 'you confirmed · nothing to check from here'],
      [2, '✓', 'Check c2', 'you confirmed · my check agreed'],
      [3, '-', 'Check c3', 'skipped'],
      [4, '✗', 'Check c4', 'failed · “Header row missing when the table is empty.”'],
      [5, '-', 'Check c5', 'not reached']
    ])
    expect(JSON.stringify(v)).not.toContain('ADDED-LATER')
    expect(JSON.stringify(v)).not.toContain('Check c6')

    // notes: the agent's evidence, then the operator's failure line, its screenshot and the one correction
    const by = (id: string) => past.rows.find((r) => r.id === id)!
    expect(by('c1').notes).toBeNull()
    expect(by('c2').notes).toEqual({
      lines: [],
      shots: [],
      correction: null,
      evidence: 'found 12 rows'
    })
    expect(by('c4').notes).toEqual({
      lines: ['Header row missing when the table is empty.'],
      shots: [{ path: shot, name: 'shot-1.png' }],
      correction: 'Open the filter first.',
      evidence: null
    })

    // Open on a live run continues it: past is ignored for a run that is not ended
    const liveData = await dataOf(svc, walkId, again.runId)
    const lv = paneView(liveData, ui({ past: true }), t)
    expect(lv.mode).toBe('check')
    expect(lv.past).toBeNull()
    // and an ended run opened without `past` is the close-out the walk ended on, as before
    expect(paneView(data, ui(), t).mode).toBe('closeout')
  })

  it("shows an agent-written failure line as the symptom and as evidence, never as the operator's note (P19)", async () => {
    const w = await openWalk()
    const a = { walkId: w.walkId, runId: w.runId }
    const op = (o: Parameters<typeof w.svc.operate>[0]['op']) => w.svc.operate({ ...a, op: o })
    await op('start')
    await op('done') // c1
    await op('done') // c2 awaits the agent...
    // ...which disagrees; the operator accepts its evidence as the symptom, so the failure line is the AGENT's
    await w.svc.report({ ...a, checkId: 'c2', result: 'fail', evidence: 'found 0 rows' })
    await op('treat-as-failed')
    await op('end')
    await w.svc.idle()

    const data = await dataOf(w.svc, w.walkId, w.runId)
    const failures = data.run.checks.find((c) => c.id === 'c2')!.failures
    expect(failures.map((f) => [f.from, f.line])).toEqual([['agent', 'found 0 rows']])

    const row = paneView(data, ui({ past: true }), t).past!.rows.find((r) => r.id === 'c2')!
    // the rail row quotes the last failure line, whoever wrote it: it is the symptom the operator accepted
    expect(row.glyph).toBe('✗')
    expect(row.how).toBe('failed · “found 0 rows”')
    // the note lists what the OPERATOR wrote (nothing) and keeps the agent's line as the evidence, once
    expect(row.notes).toEqual({ lines: [], shots: [], correction: null, evidence: 'found 0 rows' })
  })

  it('a re-run draws a quiet last time on the roadmap and on each check', async () => {
    const { svc, walkId } = await walkedOnce()
    const again = await svc.store.newRun(walkId)
    if (!again.ok) throw new Error('refused')

    const data = await dataOf(svc, walkId, again.runId)
    // the load reads the hints from the run it follows
    expect(data.lastTime).toEqual({
      c1: { result: 'passed' },
      c2: { result: 'passed' },
      c3: { result: 'skipped' },
      c4: { result: 'failed', line: 'Header row missing when the table is empty.' }
    })
    const rm = paneView(data, ui(), t)
    expect(rm.mode).toBe('roadmap')
    expect(rm.source?.runChip).toBe('Re-run · run 2')
    expect(rm.roadmap?.sub).toBe('Same 5 checks · run 2')
    expect(rm.roadmap?.rows.map((r) => r.lastTime?.text ?? null)).toEqual([
      'last time: passed',
      'last time: passed',
      'last time: skipped',
      'last time: failed',
      null // c5 was never reached
    ])
    expect(rm.roadmap?.rows.map((r) => r.glyph)).toEqual(['-', '-', '-', '-', '-']) // nothing pre-answered
    expect(rm.roadmap?.rerunOffer).toBeNull()
    expect(rm.outcomes.map((o) => o.label)).toEqual(['Start with 1'])

    // started: the check shows what it said last time, and a failed one what was written then
    await svc.operate({ walkId, runId: again.runId, op: 'start' })
    await svc.operate({ walkId, runId: again.runId, op: 'done' }) // c1
    await svc.operate({ walkId, runId: again.runId, op: 'done' }) // c2 awaits the agent
    await svc.report({ walkId, runId: again.runId, checkId: 'c2', result: 'pass', evidence: 'ok' })
    await svc.operate({ walkId, runId: again.runId, op: 'skip' }) // c3
    const at4 = paneView(await dataOf(svc, walkId, again.runId), ui(), t)
    expect(at4.check?.checkId).toBe('c4')
    expect(at4.check?.lastTime).toEqual({
      tone: 'warn',
      text: 'Last time: failed · “Header row missing when the table is empty.”'
    })
    // a first run has no hint at all
    const firstLoad = await dataOf(svc, walkId, (await svc.store.listRuns(walkId))[0].runId)
    expect(firstLoad.lastTime).toEqual({})
  })

  it('Re-run opens the live run instead of starting a second, and reuses a run nobody opened', async () => {
    const { svc, walkId, runId } = await walkedOnce()
    const before = readFileSync(join(svc.store.walkDir(walkId), 'runs', `${runId}.json`), 'utf8')

    const a = await rerunWalk(svc.store, walkId)
    if (!a.ok) throw new Error(a.error.code)
    expect(a).toMatchObject({ walkId, n: 2, kind: 'rerun' })
    // pressing it again before anything started reuses that run: no pile of empty runs
    const b = await rerunWalk(svc.store, walkId)
    expect(b).toMatchObject({ ok: true, runId: a.runId, kind: 'reused' })
    expect(await svc.store.listRuns(walkId)).toHaveLength(2)

    // once it is live, a re-run is refused and the live run opens
    await svc.operate({ walkId, runId: a.runId, op: 'start' })
    const c = await rerunWalk(svc.store, walkId)
    expect(c).toMatchObject({ ok: true, runId: a.runId, n: 2, kind: 'live' })
    expect(await svc.store.listRuns(walkId)).toHaveLength(2)

    // run 1 never changed
    expect(readFileSync(join(svc.store.walkDir(walkId), 'runs', `${runId}.json`), 'utf8')).toBe(
      before
    )
    expect(await rerunWalk(svc.store, 'wlk-00000000')).toMatchObject({
      ok: false,
      error: { code: 'WALK_NOT_FOUND' }
    })
  })
})

// ---- stp-19: the gaps the smoke test found ------------------------------------------------------------

describe('walk smoke fixes (stp-19)', () => {
  it('a link whose target is gone is not drawn, at render time (AC-25, W-9)', async () => {
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'sub'), { recursive: true })
    writeFileSync(join(root, 'docs', 'keep.md'), 'keep')
    writeFileSync(join(root, 'docs', 'gone.md'), 'gone')
    const svc = createWalkService(root, { runtime: () => runtime, now: () => clock })
    const opened = await svc.open({
      sessionId: 'sess-owner',
      script: {
        title: 'Links',
        purpose: 'check',
        source: { kind: 'pr', number: 48, title: 'Links', author: 'alex' },
        checks: [
          check('c1', {
            where: {
              text: 'the page',
              links: [
                { label: 'Keep', kind: 'file', target: 'docs/keep.md' },
                { label: 'Gone', kind: 'file', target: 'docs/gone.md' },
                { label: 'Other', kind: 'folder', target: join(root, 'sub') },
                { label: 'PR', kind: 'pr', target: '48' }
              ]
            }
          })
        ]
      },
      probe: createWalkProbe({
        folder: root,
        knownFolders: [root, join(root, 'sub')],
        cardSlugs: () => [],
        mission: () => null
      })
    })
    if (!opened.ok) throw new Error(JSON.stringify(opened))
    const drawn = async () => {
      await svc.operate({ walkId: opened.walkId, runId: opened.runId, op: 'start' })
      const data = await dataOf(svc, opened.walkId, opened.runId)
      return {
        data,
        labels: paneView(data, ui(), t).check?.where?.links.map((l) => l.label) ?? []
      }
    }
    // everything exists: every link is drawn
    const first = await drawn()
    expect(first.data.goneLinks ?? []).toEqual([])
    expect(first.labels).toEqual(['Keep', 'Gone', 'Other', 'PR'])
    // the targets disappear after the walk was accepted: the next read does not draw them
    rmSync(join(root, 'docs', 'gone.md'))
    rmSync(join(root, 'sub'), { recursive: true })
    const after = await drawn()
    expect(new Set(after.data.goneLinks)).toEqual(
      new Set([
        walkLinkKey({ kind: 'file', target: 'docs/gone.md' }),
        walkLinkKey({ kind: 'folder', target: join(root, 'sub') })
      ])
    )
    expect(after.labels).toEqual(['Keep', 'PR'])
  })

  it('a past run still shows the agent correction after Try again (AC-31, W-16)', async () => {
    const w = await openWalk()
    const a = { walkId: w.walkId, runId: w.runId }
    const op = (o: Parameters<typeof w.svc.operate>[0]['op'], x: object = {}) =>
      w.svc.operate({ ...a, op: o, ...x })
    await op('start')
    await op('fail', { line: 'It broke.' }) // c1
    await w.svc.report({ ...a, checkId: 'c1', kind: 'correction', text: 'Open the filter first.' })
    await op('try-again')
    await op('done') // c1 passes now
    await op('end')
    await w.svc.idle()
    const row = paneView(await dataOf(w.svc, w.walkId, w.runId), ui({ past: true }), t).past!
      .rows[0]
    expect(row.notes?.correction).toBe('Open the filter first.')
    expect(row.notes?.lines).toEqual(['It broke.'])
  })

  it('a screenshot of a past run opens the pane lightbox, not the viewer (AC-31, W-16)', () => {
    expect(shotLightbox({ path: '/w/runs/r/shots/shot-1.png', name: 'shot-1.png' })).toEqual({
      src: '/w/runs/r/shots/shot-1.png',
      alt: 'shot-1.png',
      caption: 'shot-1.png'
    })
  })
})

// ---- carried fix from S-3 (outbox wait) -----------------------------------------------------------

describe('carried fix from S-3 (outbox wait)', () => {
  it('shows a quiet "Waking the session…" first and the error only after 45 s', async () => {
    const { svc, walkId, runId } = await openWalk()
    await svc.operate({ walkId, runId, op: 'start' })
    // a turn no session takes stays in the outbox
    const sent = clock
    await svc.store.enqueue(walkId, runId, { kind: 'failed', text: 'a turn', checkId: 'c1' })
    const at = (ms: number) => loadWalk(svc, { walkId, runId }, { now: () => sent + ms })
    const get = async (ms: number) => {
      const l = await at(ms)
      if (!l.ok) throw new Error('refused')
      return l
    }

    expect(HELD_AFTER_MS).toBe(45_000)
    expect(WAKING_AFTER_MS).toBe(6_000)
    expect(await get(3_000)).toMatchObject({ waking: false, held: false })
    // a parked session takes up to ~40 s to wake: the pane says so, quietly, and stays on the check
    expect(await get(10_000)).toMatchObject({ waking: true, held: false })
    expect(await get(40_000)).toMatchObject({ waking: true, held: false })
    expect(await get(50_000)).toMatchObject({ waking: false, held: true })

    const waking = paneView((await get(10_000)) as unknown as WalkData, ui(), t)
    expect(waking.mode).toBe('check')
    expect(waking.waking).toBe('Waking the session…')
    expect(paneView((await get(3_000)) as unknown as WalkData, ui(), t).waking).toBeNull()
    expect(paneView((await get(50_000)) as unknown as WalkData, ui(), t).mode).toBe('error')
  })

  it('keeps a dev override of the 45 s, ignored in a packaged build', () => {
    expect(heldAfterMs({}, false)).toBe(45_000)
    expect(heldAfterMs({ HARNU_WALK_HELD_AFTER_MS: '1500' }, false)).toBe(1500)
    expect(heldAfterMs({ HARNU_WALK_HELD_AFTER_MS: '1500' }, true)).toBe(45_000)
    expect(heldAfterMs({ HARNU_WALK_HELD_AFTER_MS: 'soon' }, false)).toBe(45_000)
  })
})

// ---- carried fix from S-3 (close-out plural) ------------------------------------------------------

describe('carried fix from S-3 (close-out plural)', () => {
  const script = (n: number, agent: number[] = []): WalkScript =>
    ({
      title: 'Plural walk',
      purpose: 'check',
      source: { kind: 'feature', text: 'x' },
      checks: Array.from({ length: n }, (_, i) =>
        check(
          `c${i + 1}`,
          agent.includes(i + 1) ? { nothingFromHere: undefined, check: { how: 'look' } } : {}
        )
      )
    }) as unknown as WalkScript
  const ok = (r: { ok: true; run: Run } | { ok: false; error: { code: string } }): Run => {
    if (!r.ok) throw new Error(r.error.code)
    return r.run
  }
  const owed = (sc: WalkScript, steps: (r: Run) => Run, tr: T = t): string => {
    const run = steps(ok(startRun(newRun(toMachineChecks(sc), { n: 1 }), 1)))
    const v = paneView({ ...(dataStub(sc, run) as WalkData) }, ui(), tr)
    return v.closeout?.owed?.parts ?? ''
  }
  const dataStub = (sc: WalkScript, run: Run): object => ({
    folder: root,
    walkDir: root,
    walkId: 'wlk-00000000',
    runId: 'run-00000000',
    rev: 1,
    script: sc,
    deepenings: [],
    simpler: [],
    added: [],
    run,
    closeOut: '',
    ownerSessionId: null,
    tick: { revealed: [], ticked: {} },
    held: false,
    waitMs: 30_000,
    now: NOW,
    saved: null,
    criteria: [],
    mission: null
  })

  // one skipped check; and two skipped plus one unverified (a check ended before the agent answered)
  const oneSkipped = (r: Run): Run => ok(closeOutWithSkipped(ok(done(ok(skip(r, 2)), 3)), 4))
  const mixed = (r: Run): Run => {
    let x = ok(skip(r, 2))
    x = ok(skip(x, 3))
    x = ok(done(x, 4)) // c3 verified
    x = ok(done(x, 5)) // c4 awaits the agent
    return ok(endRun(x, 6))
  }

  it('reads "1 skipped check is listed above" and "2 skipped checks and 1 unverified check are listed above"', () => {
    expect(owed(script(2), oneSkipped)).toBe('1 skipped check is listed above.')
    expect(owed(script(4, [4]), mixed)).toBe(
      '2 skipped checks and 1 unverified check are listed above.'
    )
    void report
  })

  it('reads the same two sentences in pt-BR, singular and plural (P15)', () => {
    // the expected text comes from the pt-BR catalog, never typed here: the English-only gate forbids a
    // translated literal in a test, and the catalog is the one place the wording lives
    const k = (key: string, params: Record<string, string | number> = {}): string =>
      tPt(`testWalk.closeout.${key}`, params)
    const one = k('part.skipped.one', { n: 1 })
    const two = k('part.skipped.other', { n: 2 })
    const unverified = k('part.unverified.one', { n: 1 })
    expect(owed(script(2), oneSkipped, tPt)).toBe(k('owedMore.one', { parts: one }))
    expect(owed(script(4, [4]), mixed, tPt)).toBe(
      k('owedMore.other', { parts: `${two}${k('partAnd')}${unverified}` })
    )
    // and the catalog really has two forms: a plural that says the singular, or a count noun that does not
    // agree, would still be "correct" against itself, so pin that the forms differ
    expect(k('owedMore.other', { parts: 'x' })).not.toBe(k('owedMore.one', { parts: 'x' }))
    expect(k('part.skipped.other', { n: 2 })).not.toBe(k('part.skipped.one', { n: 2 }))
    expect(k('part.unverified.other', { n: 2 })).not.toBe(k('part.unverified.one', { n: 2 }))
  })
})

describe('a failed check with a pasted screenshot (AC-15)', () => {
  it('saves the image inside the run folder, refuses what is not an image, and keeps it in the past run', async () => {
    const { svc, walkId, runId } = await openWalk()
    await svc.operate({ walkId, runId, op: 'start' })
    const saved = await saveShot(svc.store, { walkId, runId, data: PNG })
    if (!saved.ok) throw new Error(saved.error.code)
    expect(saved.path.startsWith(svc.store.shotsDir(walkId, runId))).toBe(true)
    expect(saved.name).toMatch(/^shot-.*\.png$/)
    expect(
      await saveShot(svc.store, { walkId, runId, data: Buffer.from('not an image at all') })
    ).toMatchObject({
      ok: false,
      error: { code: 'NOT_AN_IMAGE' }
    })
    expect(await saveShot(svc.store, { walkId, runId, data: new Uint8Array(0) })).toMatchObject({
      ok: false,
      error: { code: 'SHOT_TOO_LARGE' }
    })
    // Failed needs a line or an image: the image alone is enough, and it shows in the ended run's notes
    await svc.operate({ walkId, runId, op: 'fail', shot: saved.path })
    await svc.operate({ walkId, runId, op: 'end' })
    const v = paneView(await dataOf(svc, walkId, runId), ui({ past: true }), t)
    const row = v.past!.rows.find((r) => r.notes?.shots.length)
    expect(row?.notes?.shots).toEqual([{ path: saved.path, name: saved.name }])
  })
})
