// U3.3 Task 1: the containers journal carries WHY an automatic action happened (`reason`, the
// sentence the U4 digest reads) and who the volumes a removal kept belonged to
// (`keptVolumeOwner`, what U3.7's stale-volume warning reads). Both are optional, so every line
// written before this unit still parses.

import { describe, expect, it } from 'vitest'
import { parseJournal, serializeTombstone } from '../src/main/containers/containers-journal'
import type { Tombstone, TombstoneStack } from '../src/main/containers/containers-wire'

const stack = (over: Partial<TombstoneStack> = {}): TombstoneStack => ({
  stack: 'u33fixture-app',
  name: 'u33fixture-app',
  path: '/tmp/wt',
  containerIds: ['c1'],
  freed: { ramBytes: 0, ports: [], volumes: [], volumeBytes: 0 },
  ...over
})

const tomb = (over: Partial<Tombstone> = {}): Tombstone => ({
  at: 1_000,
  actor: 'autopilot',
  verb: 'remove',
  stacks: [stack()],
  restoreHint: null,
  ...over
})

const line = (t: unknown): string => JSON.stringify(t) + '\n'

describe('containers journal: reason and kept-volume owner (U3.3)', () => {
  it('round-trips a reason and a kept-volume owner', () => {
    const t = tomb({
      reason: 'Removed orphan stack `u33fixture-app` — worktree gone, volumes kept: data',
      stacks: [
        stack({
          keptVolumes: ['data'],
          keptVolumeOwner: {
            reason: 'worktree-removed',
            project: 'u33fixture-app',
            worktreePath: '/tmp/wt'
          }
        })
      ]
    })
    expect(parseJournal(serializeTombstone(t))).toEqual([t])
  })

  it('round-trips a network removal: no stacks, a reason', () => {
    const t = tomb({ stacks: [], reason: 'Removed empty network `x` — no containers' })
    expect(parseJournal(serializeTombstone(t))).toEqual([t])
  })

  it('still reads a line written before these fields existed', () => {
    expect(parseJournal(line(tomb()))).toHaveLength(1)
  })

  it('skips a line whose reason is not a string', () => {
    expect(parseJournal(line({ ...tomb(), reason: 5 }))).toEqual([])
  })

  it('skips a line whose kept-volume owner is malformed', () => {
    const bad = (owner: unknown): string =>
      line(tomb({ stacks: [stack({ keptVolumeOwner: owner as never })] }))
    expect(
      parseJournal(bad({ reason: 'something-else', project: null, worktreePath: null }))
    ).toEqual([])
    expect(
      parseJournal(bad({ reason: 'worktree-removed', project: 3, worktreePath: null }))
    ).toEqual([])
    expect(parseJournal(bad('nope'))).toEqual([])
  })
})
