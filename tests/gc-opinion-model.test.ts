import { describe, it, expect } from 'vitest'
import { bundle, NOW, reapItem } from './gc-fixtures'
import { buildGcModel, type GcModel } from '../src/renderer/src/lib/gc-model'
import {
  clearPending,
  dropUnconfirmed,
  fingerprintOf,
  markPending,
  opinionOf,
  pruneOpinions,
  recordOpinion,
  safeIds,
  type OpinionMap
} from '../src/renderer/src/lib/gc-opinion'
import type { GcOpinion, GcSnapshot } from '../src/main/gc/gc-wire'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { Bucket, ReviewReason } from '../src/main/gc/bundle-core'

const MIB = 1024 ** 2

function wt(
  name: string,
  bucket: Bucket,
  bytes: number,
  over: { reason?: ReviewReason; tip?: string } = {}
): ReturnType<typeof bundle> {
  const b = bundle(`/ws/${name}`, bucket, {
    ...(over.reason ? { reason: over.reason } : {}),
    ...(over.tip ? { localTip: over.tip } : {})
  })
  b.item = reapItem(`/ws/${name}`, { diskBytes: bytes })
  b.item.id = `${b.item.repoPath}::worktree::/ws/${name}`
  return b
}

const snap = (bundles: ReturnType<typeof bundle>[], volumes = false): GcSnapshot => ({
  scannedAt: NOW,
  bundles,
  orphanVolumes: volumes
    ? [
        {
          id: 'volume:pgdata',
          name: 'pgdata',
          sizeBytes: 50 * MIB,
          project: 'www',
          reason: { code: 'no-known-worktree', detail: 'x' }
        }
      ]
    : [],
  docker: { buildCacheReclaimableBytes: null, danglingImages: null },
  prefs: defaultGcPrefs(),
  lastCycle: null,
  nextCycleAt: null
})

const op = (id: string, verdict: GcOpinion['verdict']): GcOpinion => ({
  id,
  verdict,
  reason: 'r',
  evidence: 'e'
})

function model(): { m: GcModel; ids: Record<string, string> } {
  const a = wt('a', 'review', 900 * MIB)
  const b = wt('b', 'review', 500 * MIB)
  const c = wt('c', 'review', 300 * MIB)
  const ready = wt('r', 'ready', 100 * MIB)
  const m = buildGcModel(snap([a, b, c, ready], true))
  return { m, ids: { a: a.item.id, b: b.item.id, c: c.item.id, r: ready.item.id } }
}

describe('recordOpinion', () => {
  it('stores an opinion for a Needs review block with its fingerprint', () => {
    const { m, ids } = model()
    const map = recordOpinion(new Map(), op(ids.a, 'safe'), m)
    expect(opinionOf(map, ids.a)).toEqual(op(ids.a, 'safe'))
    expect(map.get(ids.a)?.fingerprint).toBe(fingerprintOf(m.byId.get(ids.a)!))
  })

  it('ignores an opinion for an id the model does not hold or that is not Needs review', () => {
    const { m, ids } = model()
    expect(recordOpinion(new Map(), op('ghost', 'safe'), m).size).toBe(0)
    expect(recordOpinion(new Map(), op(ids.r, 'safe'), m).size).toBe(0)
  })

  it('keeps an orphan volume opinion', () => {
    const { m } = model()
    expect(recordOpinion(new Map(), op('volume:pgdata', 'keep'), m).size).toBe(1)
  })

  it('replaces an earlier opinion for the same id', () => {
    const { m, ids } = model()
    let map: OpinionMap = recordOpinion(new Map(), op(ids.a, 'safe'), m)
    map = recordOpinion(map, op(ids.a, 'keep'), m)
    expect(opinionOf(map, ids.a)?.verdict).toBe('keep')
  })

  it('does not mutate the map it was given', () => {
    const { m, ids } = model()
    const before: OpinionMap = new Map()
    recordOpinion(before, op(ids.a, 'safe'), m)
    expect(before.size).toBe(0)
  })
})

describe('pruneOpinions', () => {
  it('drops an opinion once the item head changed', () => {
    const { m, ids } = model()
    const map = recordOpinion(new Map(), op(ids.a, 'safe'), m)
    const moved = buildGcModel(
      snap([
        wt('a', 'review', 900 * MIB, { tip: 'b'.repeat(40) }),
        wt('b', 'review', 500 * MIB),
        wt('c', 'review', 300 * MIB),
        wt('r', 'ready', 100 * MIB)
      ])
    )
    expect(pruneOpinions(map, moved).size).toBe(0)
  })

  it('drops an opinion once the reason changed', () => {
    const { m, ids } = model()
    const map = recordOpinion(new Map(), op(ids.a, 'safe'), m)
    const changed = buildGcModel(
      snap([
        wt('a', 'review', 900 * MIB, { reason: { code: 'unpushed', detail: 'x' } }),
        wt('b', 'review', 500 * MIB),
        wt('c', 'review', 300 * MIB),
        wt('r', 'ready', 100 * MIB)
      ])
    )
    expect(pruneOpinions(map, changed).size).toBe(0)
  })

  it('drops an opinion once the item is gone or no longer Needs review', () => {
    const { m, ids } = model()
    let map: OpinionMap = recordOpinion(new Map(), op(ids.a, 'safe'), m)
    map = recordOpinion(map, op(ids.b, 'keep'), m)
    const next = buildGcModel(
      snap([wt('b', 'in-use', 500 * MIB), wt('c', 'review', 300 * MIB), wt('r', 'ready', 1)])
    )
    expect(pruneOpinions(map, next).size).toBe(0)
  })

  it('keeps an opinion whose item did not change, and returns the same map when nothing dropped', () => {
    const { m, ids } = model()
    const map = recordOpinion(new Map(), op(ids.a, 'safe'), m)
    expect(pruneOpinions(map, m)).toBe(map)
  })

  it('keeps a size change: bytes drift without the item changing', () => {
    const { m, ids } = model()
    const map = recordOpinion(new Map(), op(ids.a, 'safe'), m)
    const grown = buildGcModel(
      snap([
        wt('a', 'review', 1200 * MIB),
        wt('b', 'review', 500 * MIB),
        wt('c', 'review', 300 * MIB),
        wt('r', 'ready', 100 * MIB)
      ])
    )
    expect(pruneOpinions(map, grown).size).toBe(1)
  })
})

describe('safeIds', () => {
  it('lists only current Needs review items marked safe, in the list order (biggest first)', () => {
    const { m, ids } = model()
    let map: OpinionMap = new Map()
    map = recordOpinion(map, op(ids.c, 'safe'), m)
    map = recordOpinion(map, op(ids.a, 'safe'), m)
    map = recordOpinion(map, op(ids.b, 'keep'), m)
    map = recordOpinion(map, op('volume:pgdata', 'unsure'), m)
    expect(safeIds(map, m)).toEqual([ids.a, ids.c])
  })

  it('is empty without opinions', () => {
    expect(safeIds(new Map(), model().m)).toEqual([])
  })

  it('leaves out an opinion whose item changed since', () => {
    const { m, ids } = model()
    const map = recordOpinion(new Map(), op(ids.a, 'safe'), m)
    const moved = buildGcModel(
      snap([
        wt('a', 'review', 900 * MIB, { tip: 'c'.repeat(40) }),
        wt('b', 'review', 500 * MIB),
        wt('c', 'review', 300 * MIB),
        wt('r', 'ready', 100 * MIB)
      ])
    )
    expect(safeIds(map, moved)).toEqual([])
  })
})

describe('pending bookkeeping', () => {
  it('marks ids pending without mutating and clears them one by one', () => {
    const empty: ReadonlySet<string> = new Set()
    const one = markPending(empty, ['a', 'b'])
    expect([...empty]).toEqual([])
    expect([...one]).toEqual(['a', 'b'])
    expect([...clearPending(one, ['a'])]).toEqual(['b'])
  })

  it('returns the same set when there is nothing to clear', () => {
    const s: ReadonlySet<string> = new Set(['a'])
    expect(clearPending(s, ['zzz'])).toBe(s)
  })
})

describe('an opinion belongs to the item as it was when asked', () => {
  it('stamps the fingerprint taken at ask time, not the one at arrival', () => {
    const { m, ids } = model()
    const asked = fingerprintOf(m.byId.get(ids.a)!)
    const map = recordOpinion(new Map(), op(ids.a, 'safe'), m, { askedFingerprint: asked })
    expect(map.get(ids.a)?.fingerprint).toBe(asked)
  })

  it('drops a result whose asked-for fingerprint no longer matches the current item', () => {
    const { m, ids } = model()
    const asked = fingerprintOf(m.byId.get(ids.a)!)
    const moved = buildGcModel(
      snap([
        wt('a', 'review', 900 * MIB, { tip: 'd'.repeat(40) }),
        wt('b', 'review', 500 * MIB),
        wt('c', 'review', 300 * MIB),
        wt('r', 'ready', 100 * MIB)
      ])
    )
    const before: OpinionMap = new Map()
    const after = recordOpinion(before, op(ids.a, 'safe'), moved, { askedFingerprint: asked })
    expect(after).toBe(before)
    expect(after.size).toBe(0)
  })

  it('records whether main cached the answer (durable) and defaults to durable', () => {
    const { m, ids } = model()
    expect(recordOpinion(new Map(), op(ids.a, 'safe'), m).get(ids.a)?.durable).toBe(true)
    expect(
      recordOpinion(new Map(), op(ids.a, 'unsure'), m, { durable: false }).get(ids.a)?.durable
    ).toBe(false)
  })

  it('dropUnconfirmed removes the durable opinions main no longer confirms, and only those asked about', () => {
    const { m, ids } = model()
    let map: OpinionMap = recordOpinion(new Map(), op(ids.a, 'safe'), m)
    map = recordOpinion(map, op(ids.b, 'keep'), m)
    map = recordOpinion(map, op(ids.c, 'unsure'), m, { durable: false })
    const next = dropUnconfirmed(map, [ids.a, ids.b, ids.c], new Set([ids.b]))
    expect([...next.keys()].sort()).toEqual([ids.b, ids.c].sort()) // a dropped; c is not durable
    // An id that was not part of the check is left alone.
    expect(dropUnconfirmed(map, [ids.b], new Set()).has(ids.a)).toBe(true)
  })

  it('dropUnconfirmed returns the same map when nothing dropped', () => {
    const { m, ids } = model()
    const map = recordOpinion(new Map(), op(ids.a, 'safe'), m)
    expect(dropUnconfirmed(map, [ids.a], new Set([ids.a]))).toBe(map)
  })
})
