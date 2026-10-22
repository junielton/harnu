import { describe, it, expect, vi } from 'vitest'
import { afterJob, cleanedIds, withoutItems } from '../src/main/gc/gc-ghosts'
import { createGatherer } from '../src/main/gc/gc-gatherer'
import { createCycleState } from '../src/main/gc/gc-cycle'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { GcGathered } from '../src/main/gc/gc-scan-shell'
import type { GcJobDone } from '../src/main/gc/gc-jobs-core'
import type { ReaperSnapshot } from '../src/main/reaper/scan-core'
import type { ReapItem } from '../src/main/reaper/reaper-core'
import type { GcItemResult } from '../src/main/gc/pipeline-core'

/**
 * F0 — after a clean, the cleaned items must leave the Reaper snapshot the next gather reads.
 * The snapshot is the Reaper's last scan and does not know a job just removed them, so without
 * this they came back as hatched "Needs review" ghosts until a manual Scan now.
 */

const stub = (id: string, repoPath: string): ReapItem => ({ id, repoPath }) as unknown as ReapItem

const result = (id: string, ok: boolean): GcItemResult => ({
  id,
  ok,
  haltedAt: ok ? null : 'drop-deps',
  freedBytes: 0
})

const snapshot = (): ReaperSnapshot => ({
  scannedAt: 1,
  repos: [
    { repoPath: '/r/a', items: [stub('a1', '/r/a'), stub('a2', '/r/a'), stub('a3', '/r/a')] },
    { repoPath: '/r/b', items: [stub('b1', '/r/b')] }
  ]
})

describe('cleanedIds', () => {
  it('keeps only the items that were cleaned all the way', () => {
    const ids = cleanedIds([result('a1', true), result('a2', false), result('b1', true)])
    expect([...ids].sort()).toEqual(['a1', 'b1'])
  })

  it('is empty when nothing succeeded', () => {
    expect(cleanedIds([result('a1', false)]).size).toBe(0)
    expect(cleanedIds([]).size).toBe(0)
  })
})

describe('withoutItems', () => {
  it('drops the named items from every repo and keeps the rest in order', () => {
    const next = withoutItems(snapshot(), new Set(['a1', 'a3', 'b1']))
    expect(next.repos.map((r) => r.items.map((i) => i.id))).toEqual([['a2'], []])
  })

  it('keeps a repo whose items all went, so the repo still reads as scanned', () => {
    const next = withoutItems(snapshot(), new Set(['b1']))
    expect(next.repos.map((r) => r.repoPath)).toEqual(['/r/a', '/r/b'])
  })

  it('does not change the snapshot it was given', () => {
    const before = snapshot()
    withoutItems(before, new Set(['a1']))
    expect(before).toEqual(snapshot())
  })

  it('returns the same snapshot when there is nothing to drop', () => {
    const before = snapshot()
    expect(withoutItems(before, new Set())).toBe(before)
    expect(withoutItems(before, new Set(['nope']))).toEqual(before)
  })

  it('keeps scannedAt', () => {
    expect(withoutItems(snapshot(), new Set(['a1'])).scannedAt).toBe(1)
  })
})

describe('afterJob: forget what the job cleaned, then refresh from a gather that starts now', () => {
  const done = (results: GcItemResult[]): GcJobDone => ({
    jobId: 'j',
    kind: 'manual',
    done: results.length,
    total: results.length,
    freedBytes: 0,
    results,
    error: null
  })

  it('forgets only the ok ids, invalidates, and only then refreshes', () => {
    const calls: string[] = []
    afterJob(done([result('a1', true), result('a2', false)]), {
      forgetItems: (ids) => calls.push(`forget:${[...ids].join(',')}`),
      invalidate: () => calls.push('invalidate'),
      refresh: async () => void calls.push('refresh')
    })
    expect(calls).toEqual(['forget:a1', 'invalidate', 'refresh'])
  })

  it('a failing refresh is logged, never thrown', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    afterJob(done([]), {
      forgetItems: () => {},
      invalidate: () => {},
      refresh: async () => {
        throw new Error('boom')
      }
    })
    await new Promise((r) => setTimeout(r, 0))
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('end to end: a gather in flight when the job ends leaves no cleaned id in the final snapshot', async () => {
    // The Reaper's last scan, as the shell's gather reads it.
    let snapshot = snapshotOf(['a1', 'a2', 'a3'])
    const gate = { release: null as null | (() => void) }
    let calls = 0
    const gatherer = createGatherer({
      prefs: () => defaultGcPrefs(),
      persistPrefs: async () => {},
      state: createCycleState(),
      leftovers: { get: () => ({ version: 1, projects: {} }), set: () => {} },
      feed: () => {},
      now: () => 1,
      gatherGc: async () => {
        const seen = snapshot // what this gather reads, when it starts
        if (++calls === 1) await new Promise<void>((r) => (gate.release = r))
        return {
          bundles: seen.repos.flatMap((r) => r.items).map((i) => ({ item: i })),
          dockerAvailable: false,
          staleKeeps: [],
          staleReleases: [],
          goneItemIds: []
        } as never
      }
    })

    const inFlight = gatherer.gather() // started before the trash, e.g. by Keep or opening Cleanup
    afterJob(done([result('a1', true), result('a2', true)]), {
      forgetItems: (ids) => (snapshot = withoutItems(snapshot, ids)),
      invalidate: () => gatherer.invalidate(),
      refresh: () => gatherer.gather()
    })
    gate.release?.()
    await inFlight
    await new Promise((r) => setTimeout(r, 0))

    const finalIds = (gatherer.cached() as GcGathered).bundles.map((b) => b.item.id)
    expect(finalIds).toEqual(['a3'])
  })
})

function snapshotOf(ids: string[]): ReaperSnapshot {
  return { scannedAt: 1, repos: [{ repoPath: '/r/a', items: ids.map((id) => stub(id, '/r/a')) }] }
}
