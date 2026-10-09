import { describe, it, expect } from 'vitest'
import { cleanedIds, withoutItems } from '../src/main/gc/gc-ghosts'
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
