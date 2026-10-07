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
  stepProgress,
  CHANGED_SINCE_CONFIRM
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
      changedSinceConfirm: 0
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
    expect(doneSummary(d)).toMatchObject({ failed: 1, changedSinceConfirm: 1 })
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

describe('failureFor and stepProgress', () => {
  it('finds the failure of an item with the step it halted at', () => {
    const s = applyDone(emptyJobs(), done({ results: [bad('b', 'rm-volumes', 'volume in use')] }))
    expect(failureFor(s, 'b')).toEqual({
      step: 'rm-volumes',
      error: 'volume in use',
      changedSinceConfirm: false
    })
    expect(failureFor(s, 'zzz')).toBeNull()
  })

  it('recognizes a changed-since-confirm refusal', () => {
    const s = applyDone(
      emptyJobs(),
      done({ results: [bad('b', 'reprobe', CHANGED_SINCE_CONFIRM)] })
    )
    expect(failureFor(s, 'b')?.changedSinceConfirm).toBe(true)
  })

  it('lists which steps ran, which failed and which never started', () => {
    const steps = stepProgress('rm-volumes')
    const by = Object.fromEntries(steps.map((x) => [x.step, x.state]))
    expect(by['stop-stack']).toBe('ok')
    expect(by['rm-containers']).toBe('ok')
    expect(by['rm-volumes']).toBe('failed')
    expect(by['archive']).toBe('todo')
    expect(by['trash']).toBe('todo')
  })

  it('has nothing to say when the halt step is unknown', () => {
    expect(stepProgress(null)).toEqual([])
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
