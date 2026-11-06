// The containers journal tells automatic actions apart from operator and agent ones (U3.1 AC-5):
// actor `autopilot` is accepted by the wire, the journal and `list_containers.recent`, and the
// agent doc says so.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { computeTotals } from '../src/main/containers/containers-core'
import {
  isTombstone,
  parseJournal,
  serializeTombstone
} from '../src/main/containers/containers-journal'
import {
  ACTORS,
  type ContainersSnapshotAvailable,
  type Tombstone
} from '../src/main/containers/containers-wire'
import { containersListing } from '../src/main/mcp/containers-listing'
import { available, HOUR, NOW, stackRow } from './containers-fixtures'

const tomb = (at: number, actor: string): Tombstone =>
  ({
    at,
    actor,
    verb: 'stop',
    stacks: [
      {
        stack: 'proj-12',
        name: 'proj-12',
        path: null,
        containerIds: ['a'.repeat(64)],
        freed: { ramBytes: 10, ports: [8012], volumes: [], volumeBytes: 0 }
      }
    ],
    restoreHint: 'docker compose -p proj-12 --project-directory /ws/wt up -d'
  }) as unknown as Tombstone

describe('autopilot journal actor', () => {
  it('the wire lists operator, agent and autopilot', () => {
    expect([...ACTORS]).toEqual(['operator', 'agent', 'autopilot'])
  })

  it('a tombstone written by the autopilot round-trips through the journal', () => {
    const t = tomb(NOW, 'autopilot')
    expect(isTombstone(t)).toBe(true)
    expect(parseJournal(serializeTombstone(t))).toEqual([t])
  })

  it('an actor nobody knows is still dropped', () => {
    expect(isTombstone(tomb(NOW, 'robot'))).toBe(false)
    expect(parseJournal(serializeTombstone(tomb(NOW, 'robot')))).toEqual([])
  })

  it('list_containers.recent keeps the autopilot apart from the operator and agent entries', () => {
    const stacks = [stackRow({ id: 'wave-1', verdict: 'zombie' })]
    const snap: ContainersSnapshotAvailable = {
      ...available(stacks),
      totals: computeTotals(stacks),
      recent: [tomb(NOW, 'autopilot'), tomb(NOW - HOUR, 'agent'), tomb(NOW - 2 * HOUR, 'operator')]
    }
    const out = containersListing(snap, { denyFolders: [], home: '/home/dev' })
    expect(out.recent.map((t) => t.actor)).toEqual(['autopilot', 'agent', 'operator'])
  })

  it('the agent doc names the three actors and the marker was bumped', () => {
    const doc = readFileSync(resolve(__dirname, '..', 'docs/harnu-features.md'), 'utf8')
    expect(doc.split('\n')[0]).toMatch(/^<!-- harnu-features v127 /)
    expect(doc).toMatch(/`actor` is `operator`, `agent` or `autopilot`/)
    expect(doc).toMatch(/`autopilot` is Harnu acting on its own/)
  })
})
