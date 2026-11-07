// U3.7 AC-4: the pure stale-volume detector. A live compose project that mounts a volume Harnu kept
// when it removed an orphan stack on its own inherits a removed worktree's data; the detector says so
// once per (volume, removed worktree, mounting worktree).

import { describe, expect, it } from 'vitest'
import { findStaleVolumes } from '../src/main/gc/stale-volume-core'
import type { StackRow, Tombstone, TombstoneStack } from '../src/main/containers/containers-wire'
import { stackRow, WT, WT2 } from './containers-fixtures'

const REMOVED = '/home/dev/org/proj/www/.claude/worktrees/feat-old'

/** The journal line U3.3 writes when it removes an orphan stack on its own (newest-first lists). */
function orphanRemoval(
  over: {
    at?: number
    volumes?: string[]
    worktreePath?: string | null
    project?: string | null
  } = {}
): Tombstone {
  const stack: TombstoneStack = {
    stack: 'ext-12',
    name: 'ext-12',
    path: REMOVED,
    containerIds: ['c1'],
    freed: { ramBytes: 0, ports: [], volumes: [], volumeBytes: 0 },
    keptVolumes: over.volumes ?? ['ext-12_mysql'],
    keptVolumeOwner: {
      reason: 'worktree-removed',
      project: over.project === undefined ? 'ext-12' : over.project,
      worktreePath: over.worktreePath === undefined ? REMOVED : over.worktreePath
    }
  }
  return {
    at: over.at ?? 1000,
    actor: 'autopilot',
    verb: 'remove',
    stacks: [stack],
    restoreHint: null,
    reason: 'Removed orphan stack `ext-12` — worktree gone, volumes kept: ext-12_mysql'
  }
}

const volumeRemoval = (volume: string, at: number): Tombstone => ({
  at,
  actor: 'operator',
  verb: 'remove',
  stacks: [
    {
      stack: 'x',
      name: 'x',
      path: null,
      containerIds: [],
      freed: { ramBytes: 0, ports: [], volumes: [volume], volumeBytes: 10 }
    }
  ],
  restoreHint: null
})

const live = (id: string, volumes: string[], over: Partial<StackRow> = {}): StackRow =>
  stackRow({
    id,
    verdict: 'active',
    volumes: volumes.map((name) => ({ name, sizeBytes: 1, shared: false })),
    ...over
  })

const find = (
  journal: Tombstone[],
  stacks: StackRow[],
  seen: ReadonlySet<string> = new Set()
): ReturnType<typeof findStaleVolumes> => findStaleVolumes({ journal, stacks, seen })

describe('findStaleVolumes', () => {
  it('warns once when a live project mounts a volume kept for a removed worktree', () => {
    const r = find([orphanRemoval()], [live('ext-12', ['ext-12_mysql'])])
    expect(r.fresh).toHaveLength(1)
    expect(r.fresh[0]).toMatchObject({
      volume: 'ext-12_mysql',
      project: 'ext-12',
      worktree: 'feat-old'
    })
    // The same scan again, with the returned ledger, says nothing new.
    expect(find([orphanRemoval()], [live('ext-12', ['ext-12_mysql'])], r.seen).fresh).toEqual([])
  })

  it('a stack in an orphan or unknown verdict never warns', () => {
    for (const verdict of ['orphan', 'unknown'] as const) {
      const r = find([orphanRemoval()], [live('ext-12', ['ext-12_mysql'], { verdict })])
      expect(r.fresh).toEqual([])
    }
  })

  it('every other verdict is a live project', () => {
    for (const verdict of ['active', 'protected', 'pending', 'zombie'] as const) {
      const r = find([orphanRemoval()], [live('ext-12', ['ext-12_mysql'], { verdict })])
      expect(r.fresh).toHaveLength(1)
    }
  })

  it('a later removal of the volume voids the owner (fresh data, not stale)', () => {
    // Journals read newest first.
    const journal = [volumeRemoval('ext-12_mysql', 2000), orphanRemoval({ at: 1000 })]
    expect(find(journal, [live('ext-12', ['ext-12_mysql'])]).fresh).toEqual([])
  })

  it('a volume kept again after that removal is stale again', () => {
    const journal = [
      orphanRemoval({ at: 3000 }),
      volumeRemoval('ext-12_mysql', 2000),
      orphanRemoval({ at: 1000 })
    ]
    expect(find(journal, [live('ext-12', ['ext-12_mysql'])]).fresh).toHaveLength(1)
  })

  it('the same volume mounted by a different worktree warns again', () => {
    const first = find([orphanRemoval()], [live('ext-12', ['ext-12_mysql'])])
    const moved = live('ext-12', ['ext-12_mysql'], {
      attribution: { rung: 'compose-label', path: WT2, folderPath: WT2, folderKind: 'worktree' }
    })
    const second = find([orphanRemoval()], [moved], first.seen)
    expect(second.fresh).toHaveLength(1)
    expect(second.fresh[0]!.key).not.toBe(first.fresh[0]!.key)
  })

  it('the same volume, same mounting worktree, never warns twice', () => {
    const stacks = [live('ext-12', ['ext-12_mysql'], { attribution: attr(WT) })]
    const first = find([orphanRemoval()], stacks)
    expect(find([orphanRemoval()], stacks, first.seen).fresh).toEqual([])
  })

  it('a volume with no keptVolumeOwner never warns', () => {
    const plain = orphanRemoval()
    delete plain.stacks[0]!.keptVolumeOwner
    expect(find([plain], [live('ext-12', ['ext-12_mysql'])]).fresh).toEqual([])
  })

  it('a volume the project does not mount never warns', () => {
    expect(find([orphanRemoval()], [live('ext-12', ['ext-12_redis'])]).fresh).toEqual([])
  })

  it('worktree is the folder name of the removed path, falling back to the owner project', () => {
    const named = find([orphanRemoval()], [live('proj-34', ['ext-12_mysql'])]).fresh[0]!
    expect(named.worktree).toBe('feat-old')
    const noPath = find(
      [orphanRemoval({ worktreePath: null })],
      [live('proj-34', ['ext-12_mysql'])]
    ).fresh[0]!
    expect(noPath.worktree).toBe('ext-12')
    const nothing = find(
      [orphanRemoval({ worktreePath: null, project: null })],
      [live('proj-34', ['ext-12_mysql'])]
    ).fresh[0]!
    expect(nothing.worktree).toBe('')
  })

  it('the returned seen set keeps every key already seen', () => {
    const r = find([orphanRemoval()], [live('ext-12', ['ext-12_mysql'])], new Set(['older-key']))
    expect(r.seen.has('older-key')).toBe(true)
    expect(r.seen.size).toBe(2)
  })

  it('a standalone container never warns', () => {
    const r = find(
      [orphanRemoval()],
      [live('ext-12', ['ext-12_mysql'], { kind: 'container', project: null })]
    )
    expect(r.fresh).toEqual([])
  })
})

function attr(path: string): StackRow['attribution'] {
  return { rung: 'compose-label', path, folderPath: path, folderKind: 'worktree' }
}
