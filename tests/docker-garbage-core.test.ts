// U3.3 AC-1 (and the sentences AC-5 reads): the pure garbage planner. U3.2's facts and the stack
// verdicts go in; a plan comes out. One case per exclusion.

import { describe, expect, it } from 'vitest'
import {
  garbageActions,
  networkReasonLine,
  orphanChangedSince,
  orphanReasonLine,
  planDockerGarbage,
  type GarbageStack
} from '../src/main/gc/docker-garbage-core'
import type {
  DockerNetworkFact,
  EmptyNetworkPlan
} from '../src/main/containers/docker-networks-core'
import type { StackRow, Verdict } from '../src/main/containers/containers-wire'
import { containerRow, stackRow, GONE, WT } from './containers-fixtures'

const net = (name: string, project: string | null = 'proj'): DockerNetworkFact => ({
  id: `id-${name}`,
  name,
  driver: 'bridge',
  project,
  subnets: []
})

const NO_NETWORKS: EmptyNetworkPlan = { garbage: [], held: [] }

const plan = (
  over: {
    networks?: EmptyNetworkPlan
    stacks?: StackRow[]
    shelvedPaths?: readonly string[] | null
  } = {}
): ReturnType<typeof planDockerGarbage> =>
  planDockerGarbage({
    networks: over.networks ?? NO_NETWORKS,
    stacks: over.stacks ?? [],
    shelvedPaths: over.shelvedPaths === undefined ? [] : over.shelvedPaths
  })

const orphan = (id: string, over: Partial<StackRow> = {}): StackRow =>
  stackRow({ id, verdict: 'orphan', running: false, ...over })

describe('planDockerGarbage: networks (C8)', () => {
  it('plans exactly the garbage networks, sorted as given', () => {
    const p = plan({ networks: { garbage: [net('a_default'), net('b_default')], held: [] } })
    expect(p.networks.map((n) => n.name)).toEqual(['a_default', 'b_default'])
    expect(p.networks[0]).toMatchObject({ id: 'id-a_default', project: 'proj' })
  })

  it('reports held networks with their reason and never plans them', () => {
    const held = [
      { network: net('shared'), reason: 'external' as const },
      { network: net('maybe'), reason: 'externals-unresolved' as const }
    ]
    const p = plan({ networks: { garbage: [], held } })
    expect(p.networks).toEqual([])
    expect(p.held).toEqual(held)
    expect(garbageActions(p)).toEqual([])
  })
})

describe('planDockerGarbage: orphan stacks', () => {
  it('plans an orphan with its containers, project, worktree path and volume names', () => {
    const c1 = containerRow({ id: 'c1', running: false })
    const c2 = containerRow({ id: 'c2', running: true })
    const s = orphan('proj-13', {
      containers: [c1, c2],
      volumes: [
        { name: 'proj-13_data', sizeBytes: 10, shared: false },
        { name: 'proj-13_cache', sizeBytes: null, shared: true }
      ]
    })
    const p = plan({ stacks: [s] })
    expect(p.stacks).toEqual([
      {
        stack: 'proj-13',
        name: 'proj-13',
        project: 'proj-13',
        kind: 'compose',
        containerIds: ['c1', 'c2'],
        running: true,
        worktreePath: GONE,
        volumes: ['proj-13_data', 'proj-13_cache']
      }
    ])
  })

  it.each<Verdict>(['unknown', 'protected', 'active', 'pending', 'zombie'])(
    'never plans a stack whose verdict is %s',
    (verdict) => {
      const p = plan({ stacks: [stackRow({ id: 'x', verdict })] })
      expect(p.stacks).toEqual([])
      expect(p.excluded).toEqual([])
    }
  )

  it('excludes an orphan whose folder is a shelved worktree (C3 analogue)', () => {
    const p = plan({ stacks: [orphan('shelved-app')], shelvedPaths: [GONE] })
    expect(p.stacks).toEqual([])
    expect(p.excluded).toEqual([{ stack: 'shelved-app', why: 'shelved' }])
  })

  it('excludes an orphan attributed to a subfolder of a shelved worktree', () => {
    const s = orphan('sub', {
      attribution: {
        rung: 'compose-label',
        path: `${GONE}/api`,
        folderPath: null,
        folderKind: 'gone'
      }
    })
    expect(plan({ stacks: [s], shelvedPaths: [GONE] }).excluded).toHaveLength(1)
  })

  it('keeps an orphan that merely sits next to a shelved worktree', () => {
    const p = plan({ stacks: [orphan('other')], shelvedPaths: [WT] })
    expect(p.stacks.map((s) => s.stack)).toEqual(['other'])
  })

  it('plans no orphan at all when the shelved list could not be read', () => {
    const p = plan({ stacks: [orphan('a'), orphan('b')], shelvedPaths: null })
    expect(p.stacks).toEqual([])
    expect(p.excluded).toEqual([
      { stack: 'a', why: 'store-unreadable' },
      { stack: 'b', why: 'store-unreadable' }
    ])
  })

  it('still plans empty networks when the shelved list could not be read', () => {
    const p = plan({ networks: { garbage: [net('n')], held: [] }, shelvedPaths: null })
    expect(p.networks).toHaveLength(1)
  })
})

describe('garbageActions', () => {
  it('lists networks first, then orphan stacks, each with its reason', () => {
    const p = plan({
      networks: { garbage: [net('n1_default')], held: [] },
      stacks: [orphan('o1', { volumes: [{ name: 'v', sizeBytes: 1, shared: false }] })]
    })
    expect(garbageActions(p)).toEqual([
      {
        kind: 'prune-network',
        id: 'net:id-n1_default',
        reason: 'Removed empty network `n1_default` — no containers'
      },
      {
        kind: 'remove-orphan',
        id: 'stack:o1',
        reason: 'Removed orphan stack `o1` — worktree gone, volumes kept: v'
      }
    ])
  })
})

describe('reason lines (AC-5)', () => {
  it('names the network and says why it went', () => {
    expect(networkReasonLine('p_default')).toBe('Removed empty network `p_default` — no containers')
  })
  it('names the project and lists the volumes it kept', () => {
    expect(orphanReasonLine('p', ['a', 'b'])).toBe(
      'Removed orphan stack `p` — worktree gone, volumes kept: a, b'
    )
    expect(orphanReasonLine('p', [])).toBe(
      'Removed orphan stack `p` — worktree gone, volumes kept: none'
    )
  })
})

describe('orphanChangedSince (AC-2)', () => {
  const target = (): GarbageStack =>
    plan({ stacks: [orphan('s', { containers: [containerRow({ id: 'c1', running: false })] })] })
      .stacks[0]!

  it('is null when nothing moved', () => {
    const fresh = orphan('s', { containers: [containerRow({ id: 'c1', running: false })] })
    expect(orphanChangedSince(target(), fresh, [])).toBeNull()
  })

  it('is null when the stack only lost containers', () => {
    expect(orphanChangedSince(target(), orphan('s', { containers: [] }), [])).toBeNull()
  })

  it('refuses a verdict that is no longer orphan', () => {
    const fresh = stackRow({ id: 's', verdict: 'active', running: false })
    expect(orphanChangedSince(target(), fresh, [])).toMatch(/^changed since decided: .*active/)
  })

  it('refuses a container that was not there when the plan was made', () => {
    const fresh = orphan('s', {
      containers: [
        containerRow({ id: 'c1', running: false }),
        containerRow({ id: 'c9', running: true })
      ]
    })
    expect(orphanChangedSince(target(), fresh, [])).toMatch(/^changed since decided: .*container/)
  })

  it('refuses a stack whose worktree has been shelved since', () => {
    const fresh = orphan('s', { containers: [containerRow({ id: 'c1', running: false })] })
    expect(orphanChangedSince(target(), fresh, [GONE])).toMatch(/^changed since decided: .*shelved/)
  })

  it('refuses when the shelved list cannot be read', () => {
    const fresh = orphan('s', { containers: [containerRow({ id: 'c1', running: false })] })
    expect(orphanChangedSince(target(), fresh, null)).toMatch(/^changed since decided: .*shelved/)
  })
})
