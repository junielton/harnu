import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWalkStore, walksDir } from '../src/main/walk/walk-store'
import type { WalkScript } from '../src/shared/walk-schema'
import {
  WALK_WAIT_MS,
  newRun,
  startRun,
  view,
  ordinalOf,
  totalChecks,
  done,
  fail,
  skip,
  back,
  tryAgain,
  followAnyway,
  treatAsFailed,
  report,
  continueWithout,
  pickSkipped,
  closeOutWithSkipped,
  endRun,
  appendChecks,
  counts,
  canEscalate,
  lastTimeHints,
  type MachineCheck,
  type Run
} from '../src/shared/walk-machine'

const plain = (id: string, over: Partial<MachineCheck> = {}): MachineCheck => ({
  id,
  hasAgentCheck: false,
  blocks: [],
  ...over
})
const agent = (id: string, over: Partial<MachineCheck> = {}): MachineCheck =>
  plain(id, { hasAgentCheck: true, ...over })

/** Unwrap a machine result or fail the test with its refusal. */
function ok(r: { ok: true; run: Run } | { ok: false; error: { code: string } }): Run {
  if (!r.ok) throw new Error(`refused ${r.error.code}`)
  return r.run
}
const code = (r: { ok: boolean; error?: { code: string } }): string | undefined =>
  r.ok ? undefined : r.error?.code
const at = (r: Run): string | null => {
  const v = view(r)
  return v.mode === 'check' ? v.checkId : null
}
const live = (checks: MachineCheck[], n = 1): Run => ok(startRun(newRun(checks, { n })))

describe('walk machine: serving', () => {
  it('serves one check, resurfaces skips, defers blocked ones and numbers stably', () => {
    // first run: the pre-closed row is neither counted nor served
    const checks = [
      plain('p', { preClosed: { status: 'verified' } }),
      plain('a'),
      plain('b', { blocks: ['c'] }),
      plain('c'),
      plain('d')
    ]
    let run = newRun(checks, { n: 1 })
    expect(view(run)).toEqual({ mode: 'roadmap' })
    expect(totalChecks(run)).toBe(4)
    expect(ordinalOf(run, 'p')).toBeNull()
    expect(counts(run).verified).toBe(0) // pre-closed rows are not part of "N passed"

    run = ok(startRun(run))
    expect(view(run)).toMatchObject({ mode: 'check', checkId: 'a', n: 1, total: 4 })

    run = ok(skip(run)) // a skipped
    expect(view(run)).toMatchObject({ checkId: 'b', n: 2 })
    run = ok(skip(run)) // b skipped, and it blocks c
    // c is blocked by a skipped check: d is served, with its own fixed ordinal
    expect(view(run)).toMatchObject({ checkId: 'd', n: 4 })
    run = ok(done(run, 0))
    // no to-do check can be served: the skipped ones are offered, c is not among them
    expect(view(run)).toEqual({ mode: 'skipped-list', ids: ['a', 'b'] })
    expect(code(closeOutWithSkipped(live(checks)))).toBe('NOT_AT_SKIP_LIST')

    // retrying the blocker releases c
    run = ok(pickSkipped(run, 'b'))
    expect(view(run)).toMatchObject({ checkId: 'b', n: 2 })
    run = ok(done(run, 0))
    expect(view(run)).toMatchObject({ checkId: 'c', n: 3 })
    run = ok(done(run, 0))
    expect(view(run)).toEqual({ mode: 'skipped-list', ids: ['a'] })
    expect(code(pickSkipped(run, 'c'))).toBe('NOT_SKIPPED')

    // the operator can close out with the skipped one owed
    const closed = ok(closeOutWithSkipped(run))
    expect(closed.state).toBe('ended')
    expect(view(closed)).toEqual({ mode: 'closeout' })
    expect(counts(closed)).toMatchObject({ verified: 3, skipped: 1, todo: 0, total: 4 })

    // ...or retry it and finish with nothing owed
    run = ok(pickSkipped(run, 'a'))
    run = ok(done(run, 0))
    expect(view(run)).toEqual({ mode: 'closeout' })
    expect(counts(run)).toMatchObject({ verified: 4, skipped: 0 })

    // re-run: nothing is pre-answered and every check counts, pre-closed rows included
    const again = ok(startRun(newRun(checks, { n: 2 })))
    expect(totalChecks(again)).toBe(5)
    expect(view(again)).toMatchObject({ checkId: 'p', n: 1, total: 5 })
    expect(ordinalOf(again, 'd')).toBe(5)

    // append grows N at the end and never renumbers
    const grown = ok(appendChecks(live(checks), [plain('e')]))
    expect(totalChecks(grown)).toBe(5)
    expect(ordinalOf(grown, 'a')).toBe(1)
    expect(ordinalOf(grown, 'e')).toBe(5)
    expect(code(appendChecks(live(checks), [plain('a')]))).toBe('DUPLICATE_CHECK')
  })

  it('serves nothing before Start, and a to-do pre-closed `caveat` is never served in the first run', () => {
    const run = newRun([plain('p', { preClosed: { status: 'caveat' } }), plain('a')], { n: 1 })
    expect(view(run)).toEqual({ mode: 'roadmap' })
    expect(code(done(run, 0))).toBe('RUN_NOT_LIVE')
    expect(view(ok(startRun(run)))).toMatchObject({ checkId: 'a', n: 1, total: 1 })
    expect(counts(run).caveat).toBe(0)
  })

  it('Back returns to the previous served check whatever state it closed in', () => {
    const checks = [plain('a'), plain('b'), plain('c'), agent('d')]
    let run = live(checks)
    expect(code(back(run))).toBe('NO_PREVIOUS')

    // after a verified check
    run = ok(done(run, 0))
    expect(at(run)).toBe('b')
    run = ok(back(run))
    expect(view(run)).toMatchObject({ checkId: 'a', n: 1 })
    expect(run.checks[0].state).toBe('todo')
    run = ok(done(run, 0)) // a again
    expect(at(run)).toBe('b')

    // after a skipped one: the skip is undone
    run = ok(skip(run)) // b skipped
    expect(at(run)).toBe('c')
    run = ok(back(run))
    expect(view(run)).toMatchObject({ checkId: 'b', n: 2 })
    expect(run.checks[1].state).toBe('todo')

    // after a failed one: attempts are kept
    run = ok(fail(run, { line: 'It did nothing.' }))
    run = ok(skip(run)) // failed -> skip
    expect(at(run)).toBe('c')
    run = ok(back(run))
    expect(run.checks[1].attempts).toBe(1)
    expect(run.checks[1].state).toBe('todo')

    // after a check that closed on the agent's report: the report is cleared (the log keeps it)
    run = ok(done(run, 0)) // b
    run = ok(done(run, 0)) // c
    run = ok(done(run, 1000)) // d awaits the agent
    expect(code(back(run))).toBe('AWAITING_AGENT') // no actions while the agent checks
    run = ok(report(run, { checkId: 'd', result: 'pass', evidence: 'ok', now: 2000 }))
    expect(view(run)).toEqual({ mode: 'closeout' })
    // a run that ended on its last check cannot go back; mid-run it can:
    let mid = live([agent('x'), plain('y')])
    mid = ok(done(mid, 10))
    mid = ok(report(mid, { checkId: 'x', result: 'pass', evidence: 'seen', now: 20 }))
    expect(at(mid)).toBe('y')
    mid = ok(back(mid))
    expect(at(mid)).toBe('x')
    expect(mid.checks[0].state).toBe('todo')
    expect(mid.checks[0].report).toBeNull()
    expect(mid.checks[0].reportLog).toHaveLength(1)
    expect(view(mid)).toMatchObject({ checkId: 'x', n: 1, total: 2 })
  })
})

describe('walk machine: the agent check and the late report', () => {
  it('a check with an agent check closes only on the report', () => {
    const checks = [agent('x'), agent('y', { blocks: ['z'] }), plain('z')]
    let run = live(checks)

    // Done on a check with an agent check stays awaiting, and no actions are on offer
    run = ok(done(run, 1000))
    expect(run.checks[0]).toMatchObject({ state: 'awaiting', deliveredAt: 1000 })
    expect(view(run)).toMatchObject({ mode: 'check', checkId: 'x', phase: 'awaiting' })
    expect(code(done(run, 1500))).toBe('AWAITING_AGENT')
    expect(code(skip(run))).toBe('AWAITING_AGENT')
    expect(code(fail(run, { line: 'x' }))).toBe('AWAITING_AGENT')

    // no report never closes it: time alone changes nothing
    expect(run.checks[0].state).toBe('awaiting')
    expect(code(continueWithout(run, 1000 + WALK_WAIT_MS - 1))).toBe('TOO_EARLY')

    // after the wait from delivery, Continue without the check closes it as a caveat
    const continued = ok(continueWithout(run, 1000 + WALK_WAIT_MS))
    expect(continued.checks[0]).toMatchObject({ state: 'caveat', closedHow: 'continued' })
    expect(at(continued)).toBe('y')

    // a late report upgrades it...
    const upgraded = ok(
      report(continued, { checkId: 'x', result: 'pass', evidence: 'ok', now: 9e4 })
    )
    expect(upgraded.checks[0]).toMatchObject({ state: 'verified', closedHow: 'done-check' })
    expect(at(upgraded)).toBe('y') // the cursor does not move

    // ...or fails it: it disagrees and is served again before anything new
    const failed = ok(
      report(continued, { checkId: 'x', result: 'fail', evidence: 'saw 3 rows', now: 9e4 })
    )
    expect(failed.checks[0].state).toBe('disagrees')
    expect(view(failed)).toMatchObject({ checkId: 'x', phase: 'disagrees' })

    // a pass on the awaiting check verifies it and advances
    const passed = ok(report(run, { checkId: 'x', result: 'pass', evidence: 'ok', now: 2000 }))
    expect(passed.checks[0]).toMatchObject({ state: 'verified', closedHow: 'done-check' })
    expect(at(passed)).toBe('y')

    // a check with nothing from here closes on Done
    const z = live([plain('z')])
    expect(ok(done(z, 0)).checks[0]).toMatchObject({ state: 'verified', closedHow: 'done-nothing' })

    // a report for a check that is not awaiting, and never was, is refused
    expect(
      code(report(live(checks), { checkId: 'x', result: 'pass', evidence: 'e', now: 1 }))
    ).toBe('NOT_AWAITING')
    expect(
      code(report(live(checks), { checkId: 'nope', result: 'pass', evidence: 'e', now: 1 }))
    ).toBe('CHECK_NOT_FOUND')
    const verified = ok(done(live([plain('z'), plain('w')]), 0))
    expect(code(report(verified, { checkId: 'z', result: 'fail', evidence: 'e', now: 1 }))).toBe(
      'NOT_AWAITING'
    )

    // a failing report on a blocking check holds it: Follow anyway is refused, later checks wait
    let blocking = live(checks)
    blocking = ok(skip(blocking)) // x skipped
    expect(at(blocking)).toBe('y')
    blocking = ok(done(blocking, 100))
    blocking = ok(report(blocking, { checkId: 'y', result: 'fail', evidence: 'found 3', now: 200 }))
    expect(blocking.checks[1].state).toBe('disagrees')
    expect(at(blocking)).toBe('y')
    expect(view(blocking)).toMatchObject({ phase: 'disagrees', blocking: true })
    expect(code(followAnyway(blocking))).toBe('BLOCKING_CHECK')
    const treated = ok(treatAsFailed(blocking))
    expect(treated.checks[1]).toMatchObject({ state: 'failed', attempts: 1 })
    expect(treated.checks[1].failures[0].line).toBe('found 3') // the agent's evidence is the symptom
    expect(at(treated)).toBe('y') // z is still held back
    // Try again returns to the same check with its outcomes
    expect(ok(tryAgain(blocking)).checks[1].state).toBe('todo')

    // a non-blocking check can be followed anyway, as a caveat
    let soft = live([agent('s'), plain('t')])
    soft = ok(done(soft, 0))
    soft = ok(report(soft, { checkId: 's', result: 'fail', evidence: 'saw 3', now: 1 }))
    expect(view(soft)).toMatchObject({ phase: 'disagrees', blocking: false })
    soft = ok(followAnyway(soft))
    expect(soft.checks[0]).toMatchObject({ state: 'caveat', closedHow: 'follow-anyway' })
    expect(at(soft)).toBe('t')

    // ending the walk while the agent is still checking records a caveat
    const ending = ok(endRun(ok(done(live([agent('e')]), 0)), 5))
    expect(ending.state).toBe('ended')
    expect(ending.checks[0]).toMatchObject({ state: 'caveat', closedHow: 'ended-before-agent' })
    // a report for an ended run is refused
    expect(code(report(ending, { checkId: 'e', result: 'pass', evidence: 'e', now: 6 }))).toBe(
      'RUN_ENDED'
    )
  })

  it('the failure loop: one correction per failure, an escalation door from the second failure', () => {
    let run = live([plain('a'), plain('b')])
    expect(code(fail(run, {}))).toBe('FAILURE_NEEDS_LINE')
    expect(code(report(run, { checkId: 'a', kind: 'correction', text: 'Try X.' }))).toBe(
      'NO_FAILURE'
    )

    run = ok(fail(run, { line: 'Nothing happened.' }))
    expect(run.checks[0]).toMatchObject({ state: 'failed', attempts: 1 })
    expect(view(run)).toMatchObject({ checkId: 'a', phase: 'failed' })
    expect(canEscalate(run, 'a')).toBe(false)

    run = ok(report(run, { checkId: 'a', kind: 'correction', text: 'Press Save first.' }))
    expect(run.checks[0].correction?.text).toBe('Press Save first.')
    expect(code(report(run, { checkId: 'a', kind: 'correction', text: 'Another.' }))).toBe(
      'CORRECTION_PENDING'
    )

    run = ok(tryAgain(run)) // same check, outcomes again
    expect(run.checks[0]).toMatchObject({ state: 'todo', correction: null })
    expect(at(run)).toBe('a')
    run = ok(fail(run, { shot: '/tmp/shot.png' }))
    expect(run.checks[0].attempts).toBe(2)
    expect(canEscalate(run, 'a')).toBe(true)
    // Done is still possible after failures, and clears the failed state
    run = ok(tryAgain(run))
    expect(ok(done(run, 0)).checks[0].state).toBe('verified')
  })
})

describe('walk machine: re-run (AC-22)', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'walk-rerun-')))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

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
  const script = {
    title: 'Add CSV export',
    purpose: 'check',
    source: { kind: 'feature', text: 'An export button.' },
    checks: [
      check('c0', { status: 'verified', evidence: 'vitest 4 passed' }),
      check('c1'),
      check('c2'),
      check('c3'),
      check('c4')
    ]
  } as unknown as WalkScript

  it('a re-run is a fresh run with last-time hints and leaves earlier runs alone', async () => {
    const store = createWalkStore(root)
    const { walkId, runId } = await store.createWalk(script)
    const step = (fn: (r: Run) => ReturnType<typeof done>) =>
      store.updateRun(walkId, runId, (r) => fn(r))
    await step((r) => startRun(r, 100))
    await step((r) => done(r, 110)) // c1 passes (nothing to check from here)
    await step((r) => skip(r, 120)) // c2 is skipped
    await step((r) => fail(r, { line: 'Header row missing when the table is empty.', now: 130 })) // c3 fails
    await step((r) => endRun(r, 140)) // the walk ends with c3 failed and c4 never reached

    const before = readFileSync(join(walksDir(root), walkId, 'runs', `${runId}.json`), 'utf8')
    const first = (await store.readRun(walkId, runId))!.run
    expect(first.state).toBe('ended')

    // the hint is what the last run said, per check: the line the operator wrote, the pre-closed row's own
    // status, and nothing for a check the run never walked (the check that was not reached)
    expect(lastTimeHints(first)).toEqual({
      c0: { result: 'passed' },
      c1: { result: 'passed' },
      c2: { result: 'skipped' },
      c3: { result: 'failed', line: 'Header row missing when the table is empty.' }
    })

    // the re-run is run n + 1 of the same walk, every check to do, the pre-closed row included
    const again = await store.newRun(walkId)
    if (!again.ok) throw new Error(`refused ${again.error.code}`)
    expect(again.n).toBe(2)
    const second = (await store.readRun(walkId, again.runId))!.run
    expect(second.state).toBe('ready')
    expect(second.checks.map((c) => c.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
    expect(totalChecks(second)).toBe(5)
    for (const c of second.checks) {
      expect(c).toMatchObject({
        state: 'todo',
        closedHow: null,
        attempts: 0,
        failures: [],
        correction: null,
        report: null,
        reportLog: []
      })
    }
    // nothing from the old run is carried inside the new one: the hint is read from the old run, not copied
    expect(JSON.stringify(second)).not.toContain('Header row missing')

    // earlier runs are byte-identical
    expect(readFileSync(join(walksDir(root), walkId, 'runs', `${runId}.json`), 'utf8')).toBe(before)
    expect(readdirSync(join(walksDir(root), walkId, 'runs')).sort()).toEqual(
      [`${runId}.json`, `${again.runId}.json`].sort()
    )

    // a re-run is refused while a run of the walk is live, and says which one to open instead
    await store.updateRun(walkId, again.runId, (r) => startRun(r, 200))
    expect(await store.newRun(walkId)).toMatchObject({
      ok: false,
      error: { code: 'WALK_RUN_LIVE', runId: again.runId }
    })
  })

  it('a pre-closed row of the earlier run carries its own status as the last-time hint (AC-31, W-17)', () => {
    const checks = [
      plain('p', { preClosed: { status: 'verified' } }),
      plain('q', { preClosed: { status: 'caveat' } }),
      plain('a')
    ]
    let run = newRun(checks, { n: 1 })
    run = ok(startRun(run, 1))
    run = ok(done(run, 2)) // a: the last to-do check, so the run ends with it
    expect(run.state).toBe('ended')
    expect(lastTimeHints(run)).toEqual({
      p: { result: 'passed' },
      q: { result: 'unverified' },
      a: { result: 'passed' }
    })
  })

  it('the agent correction stays in the run record after Try again (AC-31, W-16)', () => {
    let run = live([plain('a')])
    run = ok(fail(run, { line: 'It broke.', now: 1 }))
    run = ok(report(run, { kind: 'correction', checkId: 'a', text: 'Open the filter first.' }))
    run = ok(tryAgain(run))
    // the live card no longer shows it, the record still holds it
    expect(run.checks[0].correction).toBeNull()
    expect(run.checks[0].correctionLog).toEqual([{ text: 'Open the filter first.' }])
    // a second failure and a second correction add to the log; the first stays
    run = ok(fail(run, { line: 'Still broke.', now: 2 }))
    run = ok(report(run, { kind: 'correction', checkId: 'a', text: 'Reload after it.' }))
    expect(run.checks[0].correctionLog).toEqual([
      { text: 'Open the filter first.' },
      { text: 'Reload after it.' }
    ])
  })

  it('last-time hints say passed, failed, skipped or unverified, and only for checks that were walked', () => {
    const checks = [plain('a'), plain('s'), agent('b'), plain('d')]
    let run = live(checks)
    run = ok(done(run, 1)) // a passes
    run = ok(skip(run, 2)) // s is skipped
    run = ok(done(run, 3)) // b awaits the agent...
    run = ok(endRun(run, 4)) // ...and the walk ends first: a caveat; d is never reached
    expect(lastTimeHints(run)).toEqual({
      a: { result: 'passed' },
      s: { result: 'skipped' },
      b: { result: 'unverified' }
    })
  })
})
