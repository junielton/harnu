/**
 * Campaign ch.5b (T609, spec §4) — Merge batch: "merge #A → #B → #C in order". Harnu merges one, lets
 * the steward rebase and re-check the gates, stops on any red and asks again for the rest. Pure
 * sequencing, driven through a fake `gh` (the injected `readPr` / `merge`) and a fake clock.
 */
import { describe, it, expect } from 'vitest'
import {
  ciOfRollup,
  pickMergeMethod,
  runMergeBatch,
  type BatchPrFacts,
  type MergeBatchDeps
} from '../src/main/merge-batch-core'

type Ci = BatchPrFacts['ci']

/** A fake GitHub: PR facts by number, a merge log, and a steward that can flip a later PR's CI. */
function world(initial: Record<number, Partial<BatchPrFacts>>) {
  const prs = new Map<number, BatchPrFacts>(
    Object.entries(initial).map(([n, f]) => [
      Number(n),
      { state: 'OPEN', ci: 'passing', draft: false, ...f }
    ])
  )
  const calls: string[] = []
  let clock = 0
  const stewardEffects: Array<(afterMerged: number) => void> = []
  let stewardResult: 'ran' | 'skipped' | 'timeout' = 'ran'
  const mergeFails = new Set<number>()
  const deps: MergeBatchDeps = {
    readPr: async (n) => {
      calls.push(`read #${n}`)
      return prs.get(n) ?? null
    },
    merge: async (n) => {
      calls.push(`merge #${n}`)
      if (mergeFails.has(n)) return { ok: false, error: 'GraphQL: Pull Request is not mergeable' }
      const p = prs.get(n)!
      prs.set(n, { ...p, state: 'MERGED' })
      return { ok: true }
    },
    afterMerge: async ({ merged }) => {
      calls.push(`steward after #${merged}`)
      for (const fx of stewardEffects) fx(merged)
      return { steward: stewardResult }
    },
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock
  }
  return {
    deps,
    calls,
    prs,
    mergeFails,
    onSteward: (fx: (afterMerged: number) => void) => stewardEffects.push(fx),
    setSteward: (r: 'ran' | 'skipped' | 'timeout') => (stewardResult = r),
    setCi: (n: number, ci: Ci) => prs.set(n, { ...prs.get(n)!, ci })
  }
}

const OPTS = { settleTimeoutMs: 10_000, pollMs: 1000 }

describe('runMergeBatch — in order, one at a time', () => {
  it('merges A → B → C in the order given, running the steward between merges but not after the last', async () => {
    const w = world({ 305: {}, 306: {}, 308: {} })
    const out = await runMergeBatch([305, 306, 308], w.deps, OPTS)
    expect(out).toMatchObject({ merged: [305, 306, 308], remaining: [], stop: null })
    expect(w.calls.filter((c) => c.startsWith('merge') || c.startsWith('steward'))).toEqual([
      'merge #305',
      'steward after #305',
      'merge #306',
      'steward after #306',
      'merge #308'
    ])
  })

  it('merges nothing and says why when a PR is not ready up front (CI red / not open / draft / unknown)', async () => {
    for (const [facts, reason] of [
      [{ ci: 'failing' as Ci }, 'red'],
      [{ ci: 'pending' as Ci }, 'not-ready'],
      [{ ci: 'unknown' as Ci }, 'not-ready'],
      [{ draft: true }, 'not-ready'],
      [{ state: 'CLOSED' as const }, 'closed'],
      [{ state: 'MERGED' as const }, 'closed']
    ] as const) {
      const w = world({ 305: {}, 306: facts })
      const out = await runMergeBatch([305, 306], w.deps, OPTS)
      expect(out.merged).toEqual([])
      expect(out.remaining).toEqual([305, 306])
      expect(out.stop).toMatchObject({ at: 306, reason })
      expect(w.calls.some((c) => c.startsWith('merge'))).toBe(false)
    }
  })

  it('an unknown PR number is refused up front', async () => {
    const w = world({ 305: {} })
    const out = await runMergeBatch([305, 999], w.deps, OPTS)
    expect(out.stop).toMatchObject({ at: 999, reason: 'closed' })
    expect(out.merged).toEqual([])
  })
})

describe('runMergeBatch — stops on any red and asks again for the rest', () => {
  it('a later PR whose gates go red after the steward ran stops the batch; the rest are returned', async () => {
    const w = world({ 305: {}, 306: {}, 308: {} })
    w.onSteward((merged) => {
      if (merged === 305) w.setCi(306, 'failing')
    })
    const out = await runMergeBatch([305, 306, 308], w.deps, OPTS)
    expect(out.merged).toEqual([305])
    expect(out.remaining).toEqual([306, 308])
    expect(out.stop).toMatchObject({ at: 306, reason: 'red' })
    expect(w.calls).not.toContain('merge #306')
  })

  it('red on ANY remaining PR stops, not only the next one', async () => {
    const w = world({ 305: {}, 306: {}, 308: {} })
    w.onSteward((merged) => {
      if (merged === 305) w.setCi(308, 'failing')
    })
    const out = await runMergeBatch([305, 306, 308], w.deps, OPTS)
    expect(out.merged).toEqual([305])
    expect(out.stop).toMatchObject({ at: 308, reason: 'red' })
  })

  it('a merge refused by GitHub stops the batch and nothing after it is attempted', async () => {
    const w = world({ 305: {}, 306: {}, 308: {} })
    w.mergeFails.add(306)
    const out = await runMergeBatch([305, 306, 308], w.deps, OPTS)
    expect(out.merged).toEqual([305])
    expect(out.remaining).toEqual([306, 308])
    expect(out.stop).toMatchObject({ at: 306, reason: 'merge-failed' })
    expect(out.stop?.detail).toMatch(/not mergeable/)
    expect(w.calls).not.toContain('merge #308')
  })
})

describe('runMergeBatch — waits for gates to settle after the steward', () => {
  it('re-checks a pending PR until it goes green, then continues', async () => {
    const w = world({ 305: {}, 306: {} })
    w.onSteward((merged) => {
      if (merged === 305) w.setCi(306, 'pending')
    })
    // CI finishes 3 polls later
    let reads = 0
    const base = w.deps.readPr
    w.deps.readPr = async (n) => {
      const r = await base(n)
      if (n === 306 && r?.ci === 'pending' && ++reads >= 3) w.setCi(306, 'passing')
      return r
    }
    const out = await runMergeBatch([305, 306], w.deps, OPTS)
    expect(out).toMatchObject({ merged: [305, 306], stop: null })
  })

  it('stops with `pending` when the gates have not settled by the timeout', async () => {
    const w = world({ 305: {}, 306: {} })
    w.onSteward((merged) => {
      if (merged === 305) w.setCi(306, 'pending')
    })
    const out = await runMergeBatch([305, 306], w.deps, OPTS)
    expect(out.merged).toEqual([305])
    expect(out.remaining).toEqual([306])
    expect(out.stop).toMatchObject({ at: 306, reason: 'pending' })
  })

  it('a paused or absent steward does not block the batch: the gates are still re-checked', async () => {
    const w = world({ 305: {}, 306: {} })
    w.setSteward('skipped')
    const out = await runMergeBatch([305, 306], w.deps, OPTS)
    expect(out).toMatchObject({ merged: [305, 306], stop: null })
    expect(out.steward).toEqual(['skipped'])
  })

  it('a PR closed under the batch stops it', async () => {
    const w = world({ 305: {}, 306: {} })
    w.onSteward((merged) => {
      if (merged === 305) w.prs.set(306, { state: 'CLOSED', ci: 'passing', draft: false })
    })
    const out = await runMergeBatch([305, 306], w.deps, OPTS)
    expect(out.stop).toMatchObject({ at: 306, reason: 'closed' })
  })
})

describe('guards', () => {
  it('refuses an empty list, a duplicate and a non-positive number', async () => {
    const w = world({ 305: {} })
    await expect(runMergeBatch([], w.deps, OPTS)).rejects.toThrow(/^BAD_ARGS/)
    await expect(runMergeBatch([305, 305], w.deps, OPTS)).rejects.toThrow(/^BAD_ARGS/)
    await expect(runMergeBatch([0], w.deps, OPTS)).rejects.toThrow(/^BAD_ARGS/)
    await expect(runMergeBatch([1.5], w.deps, OPTS)).rejects.toThrow(/^BAD_ARGS/)
  })
})

describe('ciOfRollup / pickMergeMethod', () => {
  it('failing beats pending beats passing; no checks is unknown', () => {
    expect(ciOfRollup([])).toBe('unknown')
    expect(ciOfRollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('passing')
    expect(
      ciOfRollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }])
    ).toBe('pending')
    expect(
      ciOfRollup([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }])
    ).toBe('failing')
    expect(ciOfRollup([{ state: 'SUCCESS' }])).toBe('passing')
  })

  it('prefers squash, then merge, then rebase, as the repo allows', () => {
    expect(
      pickMergeMethod({
        squashMergeAllowed: true,
        mergeCommitAllowed: true,
        rebaseMergeAllowed: true
      })
    ).toBe('--squash')
    expect(
      pickMergeMethod({
        squashMergeAllowed: false,
        mergeCommitAllowed: true,
        rebaseMergeAllowed: true
      })
    ).toBe('--merge')
    expect(
      pickMergeMethod({
        squashMergeAllowed: false,
        mergeCommitAllowed: false,
        rebaseMergeAllowed: true
      })
    ).toBe('--rebase')
    expect(pickMergeMethod(null)).toBe('--squash')
  })
})
