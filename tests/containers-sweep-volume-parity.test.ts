import { describe, it, expect, vi } from 'vitest'
import {
  runContainersAction,
  type ActionDeps,
  type DockerBatchResult
} from '../src/main/containers/containers-actions'
import { buildSnapshot, type InspectedContainer } from '../src/main/containers/containers-core'
import type { StackRow, Tombstone } from '../src/main/containers/containers-wire'
import { sweepPlan, type SweepSelection } from '../src/renderer/src/components/containers-format'
import { WT, WT2, composeContainer, scanInput, available, NOW } from './containers-fixtures'
import { stack } from './helpers/containers-fixtures'

/**
 * BUG-139 — one rule, two implementations.
 *
 * Main keeps a volume whenever any owner survives the sweep
 * (`planSweepVolumes`: `own.every(id => gone.has(id))`). The renderer treats a
 * non-shared volume as removable unconditionally (`sweepPlan`: `v.shared ? … :
 * true`). Different expressions, and they agree only because a third file —
 * `buildSnapshot` — flags every multi-owner volume `shared`.
 *
 * If that invariant drifts, the failure is not a wrong deletion. It is worse:
 * the renderer offers a volume main will not take, main refuses the whole sweep
 * `SWEEP_SET_CHANGED`, the dialog rescans, re-derives the same disagreeing set
 * and is refused again — a loop the operator cannot escape by retrying.
 *
 * So this file pins both halves of the coupling: the invariant itself, and the
 * agreement it buys, across every volume shape the two rules express
 * differently. Main is read here, never changed.
 */

function fakeDeps(snap: ReturnType<typeof available>): {
  deps: ActionDeps
  volumeCalls: string[][]
} {
  const volumeCalls: string[][] = []
  const ok = async (ids: string[]): Promise<DockerBatchResult> => ({ done: ids, error: null })
  const deps: ActionDeps = {
    scan: vi.fn(async () => snap),
    stop: ok,
    start: ok,
    removeContainers: ok,
    removeVolumes: async (names: string[]) => {
      volumeCalls.push(names)
      return { done: names, error: null }
    },
    appendTombstone: vi.fn(async (_t: Tombstone) => {}),
    now: () => NOW
  }
  return { deps, volumeCalls }
}

/** Multiset equality — the two rules may order their answers differently. */
function sorted(names: readonly string[]): string[] {
  return [...names].sort()
}

/**
 * The whole round trip for one snapshot: the renderer derives the offer, main
 * is handed that offer as the dialog's assertion, and what docker is actually
 * told to remove is main's own answer.
 */
async function offerAndTake(
  stacks: StackRow[],
  selection: SweepSelection = null
): Promise<{ offered: string[]; taken: string[]; error: string | null; ok: boolean }> {
  const plan = sweepPlan(stacks, selection)
  const { deps, volumeCalls } = fakeDeps(available(stacks))
  const res = await runContainersAction(
    {
      verb: 'sweep',
      removeVolumes: true,
      // The narrowing goes with the offer, or the two halves are judging
      // different sweeps and the agreement below would prove nothing (T342).
      ...(selection ? { only: selection } : {}),
      disclosed: { stacks: plan.stacks.map((s) => s.id), volumes: plan.volumes }
    },
    'operator',
    deps
  )
  return {
    offered: sorted(plan.volumes),
    taken: sorted(volumeCalls.flat()),
    error: res.error ?? null,
    ok: res.ok
  }
}

const vol = (
  name: string,
  shared: boolean,
  sizeBytes: number | null = 1_000_000
): {
  name: string
  sizeBytes: number | null
  shared: boolean
} => ({ name, sizeBytes, shared })

/**
 * Every shape the two expressions could disagree on, each one obeying the
 * snapshot invariant below — a volume more than one stack mounts is `shared`.
 */
const MATRIX: Array<{ name: string; stacks: () => StackRow[]; offered: string[] }> = [
  {
    name: 'a non-shared volume on a swept stack',
    stacks: () => [stack({ id: 'z-1', verdict: 'zombie', volumes: [vol('z1_data', false)] })],
    offered: ['z1_data']
  },
  {
    name: 'a shared volume a surviving stack still mounts',
    stacks: () => [
      stack({ id: 'z-1', verdict: 'zombie', volumes: [vol('shared_cache', true)] }),
      stack({ id: 'a-1', verdict: 'active', volumes: [vol('shared_cache', true)] })
    ],
    offered: []
  },
  {
    name: 'a shared volume every owner of which is swept',
    stacks: () => [
      stack({ id: 'z-1', verdict: 'zombie', volumes: [vol('both', true)] }),
      stack({ id: 'z-2', verdict: 'zombie', volumes: [vol('both', true)] })
    ],
    offered: ['both']
  },
  {
    name: 'a shared volume with exactly one owner — another compose project owns it',
    stacks: () => [stack({ id: 'z-1', verdict: 'zombie', volumes: [vol('other_proj', true)] })],
    offered: []
  },
  {
    name: 'a volume of unknown size',
    stacks: () => [stack({ id: 'z-1', verdict: 'zombie', volumes: [vol('no_size', false, null)] })],
    offered: ['no_size']
  },
  {
    name: 'all of them at once, across three swept stacks and a survivor',
    stacks: () => [
      stack({
        id: 'z-1',
        verdict: 'zombie',
        volumes: [vol('z1_data', false), vol('shared_cache', true), vol('both', true)]
      }),
      stack({
        id: 'z-2',
        verdict: 'zombie',
        volumes: [vol('both', true), vol('no_size', false, null)]
      }),
      stack({ id: 'o-1', verdict: 'orphan', volumes: [vol('other_proj', true)] }),
      stack({ id: 'a-1', verdict: 'active', volumes: [vol('shared_cache', true)] })
    ],
    offered: ['both', 'no_size', 'z1_data']
  }
]

describe('BUG-139 AC-4: the offered volume set is the set main takes', () => {
  it.each(MATRIX)('$name', async ({ stacks, offered }) => {
    const r = await offerAndTake(stacks())
    // The renderer's rule, stated outright so a drift names itself.
    expect(r.offered).toEqual(sorted(offered))
    // Main's rule, read off what docker was actually told to remove.
    expect(r.taken).toEqual(r.offered)
    // And main never saw the two disagree — the loop the operator cannot escape.
    expect(r.error).toBeNull()
    expect(r.ok).toBe(true)
  })
})

/**
 * T342 — the same coupling, under a selection.
 *
 * Unticking a stack makes it a SURVIVOR: the renderer must stop offering what it
 * still mounts, and main must keep it for exactly the same reason it keeps an
 * `active` stack's volume. The two rules are expressed differently (see the file
 * header), so a selection is a fresh chance for them to drift — and a drift here
 * is the inescapable refusal loop, not a wrong deletion.
 */
const SUBSETS: Array<{
  name: string
  stacks: () => StackRow[]
  only: string[]
  offered: string[]
}> = [
  {
    name: 'an unticked eligible stack keeps the volume it shares with a ticked one',
    stacks: () => [
      stack({ id: 'z-1', verdict: 'zombie', volumes: [vol('both', true)] }),
      stack({ id: 'z-2', verdict: 'zombie', volumes: [vol('both', true)] })
    ],
    only: ['z-1'],
    offered: []
  },
  {
    name: 'a subset whose shared volume has every owner ticked still offers it',
    stacks: () => [
      stack({ id: 'z-1', verdict: 'zombie', volumes: [vol('both', true)] }),
      stack({ id: 'z-2', verdict: 'zombie', volumes: [vol('both', true)] }),
      stack({ id: 'z-3', verdict: 'zombie', volumes: [vol('z3_data', false)] })
    ],
    only: ['z-1', 'z-2'],
    offered: ['both']
  },
  {
    name: "a ticked stack's own volume still goes, with its sibling left out",
    stacks: () => [
      stack({ id: 'z-1', verdict: 'zombie', volumes: [vol('z1_data', false)] }),
      stack({ id: 'z-2', verdict: 'zombie', volumes: [vol('z2_data', false)] })
    ],
    only: ['z-1'],
    offered: ['z1_data']
  },
  {
    name: 'a selection of one out of three, with a survivor and another project in the mix',
    stacks: () => [
      stack({
        id: 'z-1',
        verdict: 'zombie',
        volumes: [vol('z1_data', false), vol('shared_cache', true), vol('both', true)]
      }),
      stack({
        id: 'z-2',
        verdict: 'zombie',
        volumes: [vol('both', true), vol('no_size', false, null)]
      }),
      stack({ id: 'o-1', verdict: 'orphan', volumes: [vol('other_proj', true)] }),
      stack({ id: 'a-1', verdict: 'active', volumes: [vol('shared_cache', true)] })
    ],
    only: ['z-1'],
    // `both` now has a surviving owner (unticked z-2), so only z-1's own volume goes.
    offered: ['z1_data']
  },
  {
    name: 'ticking every eligible stack explicitly is the same offer as ticking none of them off',
    stacks: () => [
      stack({ id: 'z-1', verdict: 'zombie', volumes: [vol('both', true)] }),
      stack({ id: 'z-2', verdict: 'zombie', volumes: [vol('both', true)] })
    ],
    only: ['z-1', 'z-2'],
    offered: ['both']
  }
]

describe('T342 AC-2: the offered set is the set main takes, under a selection too', () => {
  it.each(SUBSETS)('$name', async ({ stacks, only, offered }) => {
    const r = await offerAndTake(stacks(), only)
    expect(r.offered).toEqual(sorted(offered))
    expect(r.taken).toEqual(r.offered)
    // The refusal loop: main and the renderer must never disagree about this.
    expect(r.error).toBeNull()
    expect(r.ok).toBe(true)
  })
})

describe('BUG-139 AC-4: the snapshot invariant the agreement rests on', () => {
  const mount = (name: string): InspectedContainer['mounts'][number] => ({
    type: 'volume',
    source: `/var/lib/docker/volumes/${name}/_data`,
    name
  })

  it('flags every volume more than one stack mounts as shared', () => {
    const snap = buildSnapshot(
      scanInput({
        containers: [
          composeContainer('p-1', WT, { mounts: [mount('two_owners'), mount('p1_only')] }),
          composeContainer('p-2', WT2, { mounts: [mount('two_owners')] })
        ],
        volumes: new Map([
          ['two_owners', { sizeBytes: 100, project: null }],
          ['p1_only', { sizeBytes: 50, project: 'p-1' }]
        ])
      })
    )
    // Without this, `sweepPlan` would call `two_owners` removable on sight while
    // main kept it for its surviving owner, and every sweep would be refused.
    for (const s of snap.stacks) {
      const shared = s.volumes.find((v) => v.name === 'two_owners')
      expect(shared, s.id).toBeDefined()
      expect(shared!.shared, s.id).toBe(true)
    }
    const only = snap.stacks.find((s) => s.id === 'p-1')!.volumes.find((v) => v.name === 'p1_only')
    expect(only!.shared).toBe(false)
  })
})
