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
      {
        state: 'OPEN',
        ci: 'passing',
        draft: false,
        baseRef: 'main',
        mergeable: 'MERGEABLE',
        headOid: `sha${n}`,
        ...f
      }
    ])
  )
  const calls: string[] = []
  let clock = 0
  const stewardEffects: Array<(afterMerged: number) => void> = []
  let stewardResult: 'ran' | 'skipped' | 'timeout' = 'ran'
  const mergeFails = new Set<number>()
  let missionState: 'open' | 'closed' | 'paused' = 'open'
  const deps: MergeBatchDeps = {
    readPr: async (n) => {
      calls.push(`read #${n}`)
      return prs.get(n) ?? null
    },
    defaultBranch: async () => 'main',
    missionState: async () => missionState,
    merge: async (n, headOid) => {
      calls.push(`merge #${n}@${headOid}`)
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
    setMission: (m: 'open' | 'closed' | 'paused') => (missionState = m),
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
      'merge #305@sha305',
      'steward after #305',
      'merge #306@sha306',
      'steward after #306',
      'merge #308@sha308'
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
    expect(w.calls.some((c) => c.startsWith('merge #306'))).toBe(false)
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
    expect(w.calls.some((c) => c.startsWith('merge #308'))).toBe(false)
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

  it('a PR closed under the batch stops it', async () => {
    const w = world({ 305: {}, 306: {} })
    w.onSteward((merged) => {
      if (merged === 305) w.prs.set(306, { state: 'CLOSED', ci: 'passing', draft: false })
    })
    const out = await runMergeBatch([305, 306], w.deps, OPTS)
    expect(out.stop).toMatchObject({ at: 306, reason: 'closed' })
  })
})

describe('Delta 1 — what a merge batch must not do', () => {
  it('a steward turn that did not run (skipped) STOPS the batch after the merge — nothing further is merged', async () => {
    const w = world({ 305: {}, 306: {} })
    w.setSteward('skipped')
    const out = await runMergeBatch([305, 306], w.deps, OPTS)
    expect(out.merged).toEqual([305])
    expect(out.remaining).toEqual([306])
    expect(out.stop).toMatchObject({ at: 306, reason: 'steward-skipped' })
    expect(out.steward).toEqual(['skipped'])
    expect(w.calls.some((c) => c.startsWith('merge #306'))).toBe(false)
  })

  it('a steward turn that timed out STOPS the batch too', async () => {
    const w = world({ 305: {}, 306: {} })
    w.setSteward('timeout')
    const out = await runMergeBatch([305, 306], w.deps, OPTS)
    expect(out.stop).toMatchObject({ at: 306, reason: 'steward-timeout' })
    expect(out.merged).toEqual([305])
  })

  it('the first PR must target the default branch, or nothing is merged', async () => {
    const w = world({ 305: { baseRef: 'feat/parent' }, 306: {} })
    const out = await runMergeBatch([305, 306], w.deps, OPTS)
    expect(out.merged).toEqual([])
    expect(out.stop).toMatchObject({ at: 305, reason: 'wrong-base' })
    expect(w.calls.some((c) => c.startsWith('merge'))).toBe(false)
  })

  it('before each merge the NEXT PR must target the default branch: still on the parent branch → stop', async () => {
    const w = world({ 305: {}, 306: { baseRef: 'feat/305' } })
    const out = await runMergeBatch([305, 306], w.deps, OPTS)
    // a stacked PR is fine up front (the steward retargets/rebases it), but not at its turn
    expect(out.merged).toEqual([305])
    expect(out.stop).toMatchObject({ at: 306, reason: 'wrong-base' })
    expect(w.calls.some((c) => c.startsWith('merge #306'))).toBe(false)
  })

  it('a PR retargeted to main by the steward turn is merged', async () => {
    const w = world({ 305: {}, 306: { baseRef: 'feat/305' } })
    w.onSteward((merged) => {
      if (merged === 305) w.prs.set(306, { ...w.prs.get(306)!, baseRef: 'main' })
    })
    const out = await runMergeBatch([305, 306], w.deps, OPTS)
    expect(out).toMatchObject({ merged: [305, 306], stop: null })
  })

  it('merges the commit the gates were read at: the head sha goes to merge()', async () => {
    const w = world({ 305: { headOid: 'abc123' } })
    await runMergeBatch([305], w.deps, OPTS)
    expect(w.calls).toContain('merge #305@abc123')
  })

  it('a head that moves between the gate read and the merge is the merge’s refusal, not ours to hide', async () => {
    const w = world({ 305: {}, 306: {} })
    w.mergeFails.add(306)
    const out = await runMergeBatch([305, 306], w.deps, OPTS)
    expect(out.stop).toMatchObject({ at: 306, reason: 'merge-failed' })
  })

  it('a conflicting PR stops the batch, up front and after a merge; unknown mergeability does not', async () => {
    const up = world({ 305: {}, 306: { mergeable: 'CONFLICTING' } })
    const first = await runMergeBatch([305, 306], up.deps, OPTS)
    expect(first.merged).toEqual([])
    expect(first.stop).toMatchObject({ at: 306, reason: 'conflict' })

    const late = world({ 305: {}, 306: {} })
    late.onSteward((merged) => {
      if (merged === 305) late.prs.set(306, { ...late.prs.get(306)!, mergeable: 'CONFLICTING' })
    })
    const second = await runMergeBatch([305, 306], late.deps, OPTS)
    expect(second.merged).toEqual([305])
    expect(second.stop).toMatchObject({ at: 306, reason: 'conflict' })

    const unknown = world({ 305: { mergeable: 'UNKNOWN' }, 306: { mergeable: 'UNKNOWN' } })
    expect(await runMergeBatch([305, 306], unknown.deps, OPTS)).toMatchObject({ stop: null })
  })

  it('after a merge, CI `unknown` (checks not reported yet) is PENDING: it waits, it does not stop as not-ready', async () => {
    const w = world({ 305: {}, 306: {} })
    w.onSteward((merged) => {
      if (merged === 305) w.setCi(306, 'unknown')
    })
    let reads = 0
    const base = w.deps.readPr
    w.deps.readPr = async (n) => {
      const r = await base(n)
      if (n === 306 && r?.ci === 'unknown' && ++reads >= 4) w.setCi(306, 'passing')
      return r
    }
    const out = await runMergeBatch([305, 306], w.deps, OPTS)
    expect(out).toMatchObject({ merged: [305, 306], stop: null })
  })

  it('…and if it never settles it stops as `pending` at the timeout', async () => {
    const w = world({ 305: {}, 306: {} })
    w.onSteward((merged) => {
      if (merged === 305) w.setCi(306, 'unknown')
    })
    const out = await runMergeBatch([305, 306], w.deps, OPTS)
    expect(out.stop).toMatchObject({ at: 306, reason: 'pending' })
  })

  it('up front, `unknown` CI is still not-ready (nothing merges on a PR with no checks)', async () => {
    const w = world({ 305: { ci: 'unknown' } })
    const out = await runMergeBatch([305], w.deps, OPTS)
    expect(out.stop).toMatchObject({ at: 305, reason: 'not-ready' })
  })

  it('the mission being closed between merges stops the batch before the next merge', async () => {
    const w = world({ 305: {}, 306: {} })
    w.onSteward(() => w.setMission('closed'))
    const out = await runMergeBatch([305, 306], w.deps, OPTS)
    expect(out.merged).toEqual([305])
    expect(out.stop).toMatchObject({ at: 306, reason: 'mission-closed' })
  })

  it('the steward being paused between merges stops the batch before the next merge', async () => {
    const w = world({ 305: {}, 306: {} })
    w.onSteward(() => w.setMission('paused'))
    const out = await runMergeBatch([305, 306], w.deps, OPTS)
    expect(out.merged).toEqual([305])
    expect(out.stop).toMatchObject({ at: 306, reason: 'paused' })
  })

  it('a mission already closed or paused merges nothing at all', async () => {
    for (const [state, reason] of [
      ['closed', 'mission-closed'],
      ['paused', 'paused']
    ] as const) {
      const w = world({ 305: {} })
      w.setMission(state)
      const out = await runMergeBatch([305], w.deps, OPTS)
      expect(out.merged).toEqual([])
      expect(out.stop).toMatchObject({ at: 305, reason })
      expect(w.calls.some((c) => c.startsWith('merge'))).toBe(false)
    }
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
