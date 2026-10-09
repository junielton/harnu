import { describe, it, expect } from 'vitest'
import {
  isNeverClean,
  FAILURE_TTL_MS,
  applyFailures,
  isProtectedNow,
  planCycle,
  pruneFailures,
  refusalFor
} from '../src/main/gc/autopilot-core'
import { defaultGcPrefs, type GcPrefs } from '../src/main/gc/gc-prefs'
import { bundle, DAY, NOW, reapItem } from './gc-fixtures'

const prefs = (over: Partial<GcPrefs> = {}): GcPrefs => ({
  ...defaultGcPrefs(),
  autopilot: true,
  firstReportAcknowledged: true,
  ...over
})

const ready = (name: string, daysAgo: number, bytes = 1_000_000) =>
  bundle(`/ws/wt/${name}`, 'ready', {
    lastSignOfLifeAt: NOW - daysAgo * DAY,
    item: reapItem(`/ws/wt/${name}`, { diskBytes: bytes })
  })

describe('planCycle: mode', () => {
  it('is off when the autopilot is off, and plans nothing', () => {
    const plan = planCycle([ready('a', 5)], prefs({ autopilot: false }))
    expect(plan.mode).toBe('off')
    expect(plan.toClean).toEqual([])
    expect(plan.deferred).toBe(0)
  })

  it('is off when the worktrees category is off, even with the autopilot on', () => {
    const plan = planCycle(
      [ready('a', 5)],
      prefs({ categories: { worktrees: false, dockerCache: true } })
    )
    expect(plan.mode).toBe('off')
    expect(plan.toClean).toEqual([])
  })

  it('is report until the first report is acknowledged', () => {
    const plan = planCycle([ready('a', 5)], prefs({ firstReportAcknowledged: false }))
    expect(plan.mode).toBe('report')
  })

  it('is clean once the first report is acknowledged', () => {
    expect(planCycle([ready('a', 5)], prefs()).mode).toBe('clean')
  })
})

describe('planCycle: report mode never cleans', () => {
  it('returns nothing to clean but counts what it found', () => {
    const plan = planCycle(
      [ready('a', 5, 2_000), ready('b', 6, 3_000)],
      prefs({ firstReportAcknowledged: false })
    )
    expect(plan.toClean).toEqual([])
    expect(plan.found).toBe(2)
    expect(plan.reportBytes).toBe(5_000)
    expect(plan.deferred).toBe(0)
  })

  it('does not count neverClean ready items in the report', () => {
    const plan = planCycle(
      [ready('a', 5), ready('b', 6)],
      prefs({ firstReportAcknowledged: false, neverClean: ['/ws/wt/a'] })
    )
    expect(plan.found).toBe(1)
  })

  it('counts a missing size as zero bytes', () => {
    const b = bundle('/ws/wt/a', 'ready', { item: reapItem('/ws/wt/a', { diskBytes: null }) })
    expect(planCycle([b], prefs({ firstReportAcknowledged: false })).reportBytes).toBe(0)
  })
})

describe('planCycle: clean mode', () => {
  it('takes ready items only, never review or in-use', () => {
    const plan = planCycle(
      [ready('a', 5), bundle('/ws/wt/d', 'review'), bundle('/ws/wt/l', 'in-use')],
      prefs()
    )
    expect(plan.toClean.map((b) => b.item.path)).toEqual(['/ws/wt/a'])
  })

  it('cleans the oldest sign of life first', () => {
    const plan = planCycle([ready('new', 3), ready('old', 30), ready('mid', 10)], prefs())
    expect(plan.toClean.map((b) => b.item.path)).toEqual(['/ws/wt/old', '/ws/wt/mid', '/ws/wt/new'])
  })

  it('caps at maxItemsPerCycle and reports the remainder as deferred', () => {
    const many = Array.from({ length: 5 }, (_, i) => ready(`w${i}`, 10 + i))
    const plan = planCycle(many, prefs({ maxItemsPerCycle: 2 }))
    expect(plan.toClean).toHaveLength(2)
    expect(plan.deferred).toBe(3)
    expect(plan.toClean.map((b) => b.item.path)).toEqual(['/ws/wt/w4', '/ws/wt/w3'])
  })

  it('skips a neverClean path', () => {
    const plan = planCycle([ready('a', 5), ready('b', 6)], prefs({ neverClean: ['/ws/wt/a'] }))
    expect(plan.toClean.map((b) => b.item.path)).toEqual(['/ws/wt/b'])
    expect(plan.deferred).toBe(0)
  })

  it('skips a ready item inside a neverClean repo', () => {
    const b = bundle('/ws/wt/a', 'ready', {
      item: reapItem('/ws/wt/a', { repoPath: '/ws/org/keep' })
    })
    expect(planCycle([b], prefs({ neverClean: ['/ws/org/keep'] })).toClean).toEqual([])
  })

  it('never takes a ready item flagged neverClean or keep by the bundle itself', () => {
    const plan = planCycle(
      [
        bundle('/ws/wt/a', 'ready', { neverClean: true }),
        bundle('/ws/wt/b', 'ready', { keep: true })
      ],
      prefs()
    )
    expect(plan.toClean).toEqual([])
  })

  it('never takes a main checkout', () => {
    const plan = planCycle([bundle('/ws/wt/a', 'ready', { isMainCheckout: true })], prefs())
    expect(plan.toClean).toEqual([])
  })

  it('puts a ready item without a sign of life last', () => {
    const noSign = bundle('/ws/wt/z', 'ready', { lastSignOfLifeAt: null })
    const plan = planCycle([noSign, ready('a', 5)], prefs())
    expect(plan.toClean.map((b) => b.item.path)).toEqual(['/ws/wt/a', '/ws/wt/z'])
  })

  it('returns an empty plan for no bundles', () => {
    const plan = planCycle([], prefs())
    expect(plan).toMatchObject({
      mode: 'clean',
      toClean: [],
      deferred: 0,
      found: 0,
      reportBytes: 0
    })
  })

  it('does not mutate its input order', () => {
    const input = [ready('new', 3), ready('old', 30)]
    planCycle(input, prefs())
    expect(input.map((b) => b.item.path)).toEqual(['/ws/wt/new', '/ws/wt/old'])
  })
})

describe('refusalFor: what a manual clean may take (AC-8)', () => {
  const confirm = { confirmed: true }
  const none = { confirmed: false }

  it('lets a ready item through without a confirmation', () => {
    expect(refusalFor(ready('a', 5), prefs(), none)).toBeNull()
  })

  it('refuses a review item until the operator confirms', () => {
    const d = bundle('/ws/wt/d', 'review')
    expect(refusalFor(d, prefs(), none)).toBe('needs-confirmation')
    expect(refusalFor(d, prefs(), confirm)).toBeNull()
  })

  it('refuses an in-use bundle, confirmed or not', () => {
    const l = bundle('/ws/wt/l', 'in-use')
    expect(refusalFor(l, prefs(), none)).toBe('in-use')
    expect(refusalFor(l, prefs(), confirm)).toBe('in-use')
  })

  it('refuses a main checkout, even a confirmed review item', () => {
    const m = bundle('/ws/wt/m', 'review', { isMainCheckout: true })
    expect(refusalFor(m, prefs(), confirm)).toBe('main-checkout')
  })

  it('refuses a neverClean path by the CURRENT prefs, not the ones at scan time', () => {
    const b = ready('a', 5)
    expect(refusalFor(b, prefs({ neverClean: ['/ws/wt/a'] }), confirm)).toBe('never-clean')
    expect(refusalFor(bundle('/ws/wt/b', 'review', { neverClean: true }), prefs(), confirm)).toBe(
      'never-clean'
    )
  })

  it('refuses a kept bundle until it is un-kept', () => {
    expect(refusalFor(bundle('/ws/wt/k', 'in-use', { keep: true }), prefs(), confirm)).toBe('kept')
  })

  it('refuses a detached worktree: the executor cannot clean one', () => {
    const d = bundle('/ws/wt/x', 'review', {
      item: reapItem('/ws/wt/x', { kind: 'detached-worktree' })
    })
    expect(refusalFor(d, prefs(), confirm)).toBe('unsupported-kind')
  })
})

describe('applyFailures / pruneFailures (spec §4)', () => {
  const failure = { step: 'trash', error: 'EBUSY', at: NOW }

  it('turns a failed ready item into a cleanup-failed decision', () => {
    const [b] = applyFailures([ready('a', 5)], new Map([[ready('a', 5).item.id, failure]]))
    expect(b).toMatchObject({
      bucket: 'review',
      reason: { code: 'cleanup-failed', detail: 'Cleanup stopped at trash: EBUSY' }
    })
  })

  it('leaves other bundles and items that are not ready alone', () => {
    const a = ready('a', 5)
    const d = bundle('/ws/wt/d', 'review')
    const failures = new Map([
      [d.item.id, failure],
      ['unrelated', failure]
    ])
    expect(applyFailures([a, d], failures)).toEqual([a, d])
  })

  it('a halted item whose folder is already gone reads cleanup-failed whatever its bucket', () => {
    // The trash ran, then prune or branch-delete halted: the folder is gone, so the probes
    // fail and the bundle is review (or anything), never ready. It must still say what stopped.
    const d = bundle('/ws/wt/d', 'review')
    const [out] = applyFailures(
      [d],
      new Map([[d.item.id, { step: 'prune', error: 'index.lock exists', at: NOW }]]),
      new Set([d.item.id])
    )
    expect(out).toMatchObject({ bucket: 'review', reason: { code: 'cleanup-failed' } })
  })

  it('a gone-folder id with no failure note, or a failure on a live folder, is left alone', () => {
    const d = bundle('/ws/wt/d', 'review')
    const e = bundle('/ws/wt/e', 'review')
    const notes = new Map([[e.item.id, failure]])
    expect(applyFailures([d, e], notes, new Set([d.item.id]))).toEqual([d, e])
  })

  it('prunes missing worktrees and failures older than a day', () => {
    const a = ready('a', 5)
    const b = ready('b', 5)
    const failures = new Map([
      [a.item.id, { ...failure, at: NOW - FAILURE_TTL_MS - 1 }],
      [b.item.id, failure],
      ['gone', failure]
    ])
    pruneFailures(failures, [a, b], NOW)
    expect([...failures.keys()]).toEqual([b.item.id])
  })
})

describe('isProtectedNow: the live-prefs answer the reprobe asks (AC-8)', () => {
  it('protects a bundle marked Keep after the scan', () => {
    const b = ready('a', 5)
    expect(isProtectedNow(b, prefs({ keep: { [b.item.id]: 'merged' } }))).toBe(true)
  })

  it('protects a path added to neverClean after the scan, by worktree or by repo', () => {
    const b = ready('a', 5)
    expect(isProtectedNow(b, prefs({ neverClean: ['/ws/wt/a'] }))).toBe(true)
    expect(isProtectedNow(b, prefs({ neverClean: [b.item.repoPath] }))).toBe(true)
  })

  it('protects a main checkout', () => {
    expect(isProtectedNow(bundle('/ws/wt/m', 'ready', { isMainCheckout: true }), prefs())).toBe(
      true
    )
  })

  it('protects nothing else', () => {
    expect(isProtectedNow(ready('a', 5), prefs())).toBe(false)
  })
})

describe('never-clean is judged on real paths (delta 3b, item 12)', () => {
  const canonical = (p: string) => ({
    path: p.startsWith('/link/') ? `/real/${p.slice('/link/'.length)}` : p,
    resolved: true
  })

  it('honors an entry spelled through a symlink', () => {
    const b = ready('a', 5)
    const here = bundle('/real/wt', 'ready')
    expect(isNeverClean(here, prefs({ neverClean: ['/link/wt'] }), canonical)).toBe(true)
    expect(isNeverClean(b, prefs({ neverClean: ['/link/wt'] }), canonical)).toBe(false)
  })

  it('honors an entry for the repo spelled through a symlink', () => {
    const b = bundle('/real/repo/wt', 'ready', {
      item: reapItem('/real/repo/wt', { repoPath: '/real/repo' })
    })
    expect(isNeverClean(b, prefs({ neverClean: ['/link/repo'] }), canonical)).toBe(true)
  })

  it('still matches plain spellings with no resolver', () => {
    expect(isNeverClean(ready('a', 5), prefs({ neverClean: ['/ws/wt/a'] }))).toBe(true)
  })

  it('isProtectedNow passes the resolver on', () => {
    const here = bundle('/real/wt', 'ready')
    expect(isProtectedNow(here, prefs({ neverClean: ['/link/wt'] }), canonical)).toBe(true)
    expect(isProtectedNow(here, prefs({ neverClean: ['/link/wt'] }))).toBe(false)
  })
})
