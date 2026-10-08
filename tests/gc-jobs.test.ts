import { describe, it, expect } from 'vitest'
import {
  applyDone,
  applyProgress,
  attachJobs,
  blockStates,
  dropFinished,
  doneSummary,
  emptyJobs,
  failureFor,
  pillState,
  runningJob,
  haltOf,
  needsAction,
  CHANGED_SINCE_CONFIRM,
  REFUSAL_CODES,
  refusalOf
} from '../src/renderer/src/lib/gc-jobs'
import type { GcJobDone, GcJobInfo, GcJobProgress, GcItemResult } from '../src/main/gc/gc-wire'

const ok = (id: string, freedBytes = 100): GcItemResult => ({
  id,
  ok: true,
  haltedAt: null,
  freedBytes
})
const bad = (id: string, haltedAt: GcItemResult['haltedAt'], error = 'boom'): GcItemResult => ({
  id,
  ok: false,
  haltedAt,
  error,
  freedBytes: 0
})
const progress = (over: Partial<GcJobProgress> = {}): GcJobProgress => ({
  jobId: 'j1',
  done: 0,
  total: 3,
  freedBytes: 0,
  current: null,
  results: [],
  ...over
})
const done = (over: Partial<GcJobDone> = {}): GcJobDone => ({
  jobId: 'j1',
  kind: 'manual',
  done: 3,
  total: 3,
  freedBytes: 300,
  results: [ok('a'), ok('b'), ok('c')],
  error: null,
  ...over
})
const info = (over: Partial<GcJobInfo> = {}): GcJobInfo => ({
  jobId: 'j1',
  kind: 'manual',
  state: 'running',
  done: 1,
  total: 3,
  freedBytes: 100,
  current: 'b',
  results: [ok('a')],
  error: null,
  ...over
})

describe('progress reduction', () => {
  it('a progress event creates a running job and updates it item by item', () => {
    let s = applyProgress(emptyJobs(), progress({ done: 0, current: 'a' }))
    expect(runningJob(s)).toMatchObject({ jobId: 'j1', done: 0, total: 3, freedBytes: 0 })
    s = applyProgress(s, progress({ done: 1, freedBytes: 100, current: 'b', results: [ok('a')] }))
    expect(runningJob(s)).toMatchObject({ done: 1, freedBytes: 100 })
  })

  it('a done event ends the job: no running job, results kept for the toast and failed blocks', () => {
    let s = applyProgress(emptyJobs(), progress({ done: 1, current: 'b', results: [ok('a')] }))
    s = applyDone(s, done())
    expect(runningJob(s)).toBeNull()
  })

  it('a late progress event never reopens a finished job', () => {
    let s = applyDone(emptyJobs(), done())
    s = applyProgress(s, progress({ done: 2 }))
    expect(runningJob(s)).toBeNull()
  })

  it('re-attach from gc:jobs rebuilds the chip after a reload', () => {
    const s = attachJobs(emptyJobs(), [
      info(),
      info({ jobId: 'j0', state: 'done', done: 2, total: 2 })
    ])
    expect(runningJob(s)).toMatchObject({ jobId: 'j1', done: 1, total: 3 })
  })

  it('a queued job shows 0/N until it starts; a running one wins over a queued one', () => {
    const s = attachJobs(emptyJobs(), [
      info({ jobId: 'q', state: 'queued', done: 0, total: 5, current: null, results: [] }),
      info({ jobId: 'r', state: 'running' })
    ])
    expect(runningJob(s)?.jobId).toBe('r')
    const only = attachJobs(emptyJobs(), [
      info({ jobId: 'q', state: 'queued', done: 0, total: 5, current: null, results: [] })
    ])
    expect(runningJob(only)).toMatchObject({ jobId: 'q', done: 0, total: 5 })
  })

  it('attach does not downgrade a job that already finished', () => {
    let s = applyDone(emptyJobs(), done())
    s = attachJobs(s, [info()])
    expect(runningJob(s)).toBeNull()
  })

  it('dropFinished forgets ended jobs and keeps running ones', () => {
    let s = applyDone(emptyJobs(), done({ jobId: 'old' }))
    s = applyProgress(s, progress({ jobId: 'live', done: 1 }))
    s = dropFinished(s)
    expect(runningJob(s)?.jobId).toBe('live')
    expect(Object.keys(s.jobs)).toEqual(['live'])
  })
})

describe('blockStates', () => {
  it('marks the item in flight busy, finished ones done, failed ones failed', () => {
    const s = applyProgress(
      emptyJobs(),
      progress({ done: 2, current: 'c', results: [ok('a'), bad('b', 'rm-volumes')] })
    )
    const m = blockStates(s)
    expect(m.get('a')).toBe('done')
    expect(m.get('b')).toBe('failed')
    expect(m.get('c')).toBe('busy')
    expect(m.has('d')).toBe(false)
  })

  it('keeps failed and done states after the job ends, until dropFinished', () => {
    const s = applyDone(emptyJobs(), done({ results: [ok('a'), bad('b', 'trash')], done: 1 }))
    expect(blockStates(s).get('b')).toBe('failed')
    expect(blockStates(dropFinished(s)).size).toBe(0)
  })
})

describe('doneSummary', () => {
  it('all ok → success with the freed total and cleaned count', () => {
    expect(doneSummary(done())).toEqual({
      tone: 'success',
      cleaned: 3,
      failed: 0,
      freedBytes: 300,
      refusals: {},
      refused: 0
    })
  })

  it('partial failure → warning, counting what needs the operator', () => {
    const d = done({
      results: [ok('a'), ok('b'), bad('c', 'rm-volumes')],
      done: 2,
      freedBytes: 200
    })
    expect(doneSummary(d)).toMatchObject({
      tone: 'warning',
      cleaned: 2,
      failed: 1,
      freedBytes: 200
    })
  })

  it('counts items the engine refused because their facts changed since the confirm', () => {
    const d = done({
      results: [ok('a'), bad('b', 'reprobe', CHANGED_SINCE_CONFIRM)],
      done: 1,
      total: 2
    })
    expect(doneSummary(d)).toMatchObject({
      failed: 1,
      refused: 1,
      refusals: { 'changed-since-confirm': 1 }
    })
  })

  it('a thrown run is a warning even with no per-item failure', () => {
    expect(doneSummary(done({ results: [], done: 0, error: 'docker is down' })).tone).toBe(
      'warning'
    )
  })

  it('an empty job produces no toast', () => {
    expect(doneSummary(done({ results: [], done: 0, total: 0, freedBytes: 0 })).tone).toBe('none')
  })
})

describe('failureFor and haltOf', () => {
  it('finds the failure of an item with the step it halted at', () => {
    const s = applyDone(emptyJobs(), done({ results: [bad('b', 'rm-volumes', 'volume in use')] }))
    expect(failureFor(s, 'b')).toEqual({
      step: 'rm-volumes',
      error: 'volume in use',
      refusal: null
    })
    expect(failureFor(s, 'zzz')).toBeNull()
  })

  it('recognizes a changed-since-confirm refusal', () => {
    const s = applyDone(
      emptyJobs(),
      done({ results: [bad('b', 'reprobe', CHANGED_SINCE_CONFIRM)] })
    )
    expect(failureFor(s, 'b')?.refusal).toBe('changed-since-confirm')
  })

  it.each(REFUSAL_CODES)(
    'recognizes the %s refusal and counts it separately from a step failure',
    (code) => {
      const d = done({
        results: [bad('a', 'reprobe', code), bad('b', 'rm-volumes', 'volume in use')],
        done: 0,
        total: 2
      })
      const s = applyDone(emptyJobs(), d)
      expect(failureFor(s, 'a')?.refusal).toBe(code)
      expect(failureFor(s, 'b')?.refusal).toBeNull()
      expect(doneSummary(d)).toMatchObject({ failed: 2, refused: 1, refusals: { [code]: 1 } })
    }
  )

  it('an error that merely contains a code is not a refusal', () => {
    expect(refusalOf({ ok: false, error: 'docker said: kept alive' })).toBeNull()
    expect(refusalOf({ ok: true, error: 'kept' })).toBeNull()
  })

  it('reports only the step the engine halted at — never a reconstructed history', () => {
    const f = failureFor(
      applyDone(emptyJobs(), done({ results: [bad('b', 'drop-deps', 'EBUSY: node_modules')] })),
      'b'
    )!
    // Exactly the facts the engine gave: one step and its reason. No done-steps list, so "archive"
    // can never read as done and no volume step exists to be shown.
    expect(haltOf(f)).toEqual({
      kind: 'stopped',
      step: 'drop-deps',
      error: 'EBUSY: node_modules',
      refusal: null
    })
  })

  it('a pre-flight halt with a code the engine documents is a refusal: nothing was changed', () => {
    const f = failureFor(
      applyDone(emptyJobs(), done({ results: [bad('b', 'reprobe', 'tip-unknown')] })),
      'b'
    )!
    expect(haltOf(f)).toEqual({ kind: 'refused', refusal: 'tip-unknown' })
  })

  it('a pre-flight halt with free text (a thrown probe) still says nothing was changed', () => {
    const f = failureFor(
      applyDone(
        emptyJobs(),
        done({ results: [bad('b', 'reprobe', 'probe-failed: git exploded')] })
      ),
      'b'
    )!
    expect(haltOf(f)).toEqual({ kind: 'refused', refusal: 'probe-failed' })
  })

  it('a reason the engine reports mid-run is NOT "nothing was changed": earlier steps may have run', () => {
    const f = failureFor(
      applyDone(emptyJobs(), done({ results: [bad('b', 'drop-deps', 'changed-mid-run')] })),
      'b'
    )!
    expect(haltOf(f)).toEqual({
      kind: 'stopped',
      step: 'drop-deps',
      error: 'changed-mid-run',
      refusal: 'changed-mid-run'
    })
  })

  it('a refusal is reported as a refusal, not as a halted step', () => {
    const f = failureFor(
      applyDone(emptyJobs(), done({ results: [bad('b', 'reprobe', 'kept')] })),
      'b'
    )!
    expect(haltOf(f)).toEqual({ kind: 'refused', refusal: 'kept' })
  })

  it('with no step at all there is nothing to say about where it stopped', () => {
    expect(haltOf({ step: null, error: 'boom', refusal: null })).toEqual({
      kind: 'unknown',
      error: 'boom'
    })
  })

  it('no longer exposes a per-step history (the engine does not report one)', async () => {
    const mod = (await import('../src/renderer/src/lib/gc-jobs')) as Record<string, unknown>
    expect('stepProgress' in mod).toBe(false)
    expect('PIPELINE_STEPS' in mod).toBe(false)
  })
})

describe('every code the engine can refuse with is known', () => {
  it.each([
    'tip-unknown',
    'protected-now',
    'changed-since-scan',
    'grace-not-elapsed',
    'not-ready',
    'path-unresolved',
    'stack-present',
    'changed-mid-run',
    'docker-unavailable',
    'probe-failed',
    'nested-worktree',
    'shared-stack',
    'head-moved',
    'not-harvestable',
    'session-open',
    'unpushed',
    'volume-in-use',
    'dirty',
    'foreign-checkout',
    'cannot-unregister'
  ])('%s', (code) => {
    expect(REFUSAL_CODES).toContain(code)
    expect(refusalOf({ ok: false, error: code })).toBe(code)
  })

  it('a refusal code followed by engine text (cannot-unregister: …) is still that refusal', () => {
    expect(
      refusalOf({
        ok: false,
        error: 'cannot-unregister: no matching, unlocked registration for this worktree'
      })
    ).toBe('cannot-unregister')
  })

  it('a probe-failed reason carries the engine text after the code and is still the probe-failed refusal', () => {
    expect(refusalOf({ ok: false, error: 'probe-failed: ENOENT git' })).toBe('probe-failed')
  })
})

describe('needsAction — what the attention pill counts', () => {
  it("skips refusals that are the operator's own settings", () => {
    expect(needsAction('kept')).toBe(false)
    expect(needsAction('never-clean')).toBe(false)
  })
  it('counts every other refusal and every step failure', () => {
    expect(needsAction('changed-since-confirm')).toBe(true)
    expect(needsAction('docker-unavailable')).toBe(true)
    expect(needsAction(null)).toBe(true)
  })
})

describe('pillState', () => {
  it('running beats attention beats idle', () => {
    const running = applyProgress(emptyJobs(), progress({ done: 3, total: 12 }))
    expect(pillState(running, 2)).toEqual({ kind: 'running', done: 3, total: 12 })
    expect(pillState(emptyJobs(), 2)).toEqual({ kind: 'attention', count: 2 })
    expect(pillState(emptyJobs(), 0)).toEqual({ kind: 'idle' })
  })
})
