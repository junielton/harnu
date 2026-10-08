import { describe, it, expect } from 'vitest'
import { withActor } from '../src/main/gc/gc-actor'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { GcShellDeps } from '../src/main/gc/gc-shell'
import type { Tombstone } from '../src/main/reaper/journal'
import { bundle } from './gc-fixtures'

const tombstone: Tombstone = {
  at: 1,
  repoPath: '/repo',
  kind: 'worktree',
  branch: 'feat/x',
  sha: 'abc',
  deleted: ['trash-folder'],
  justifiedBy: 'ancestor',
  restoreHint: 'git branch feat/x abc',
  archiveTipRef: null,
  archiveWipRef: null
}

function base() {
  const written: Tombstone[] = []
  const deps = {
    executor: {
      appendTombstone: async (t: Tombstone) => {
        written.push(t)
      }
    },
    isProtectedNow: () => false
  } as unknown as GcShellDeps
  return { deps, written }
}

describe('withActor marks the journal lines of a run (AC-3)', () => {
  it.each(['autopilot', 'operator'] as const)('stamps %s on every tombstone', async (actor) => {
    const { deps, written } = base()
    await withActor(deps, actor, () => defaultGcPrefs()).executor.appendTombstone(tombstone)
    expect(written).toEqual([{ ...tombstone, actor }])
  })

  it('does not change the base deps', async () => {
    const { deps, written } = base()
    withActor(deps, 'autopilot', () => defaultGcPrefs())
    await deps.executor.appendTombstone(tombstone)
    expect(written[0]!.actor).toBeUndefined()
  })

  it('reads protection from the prefs at the moment of the question', async () => {
    const { deps } = base()
    let prefs = defaultGcPrefs()
    const wrapped = withActor(deps, 'autopilot', () => prefs)
    const b = bundle('/ws/wt/a', 'ready')
    expect(await wrapped.isProtectedNow(b)).toBe(false)
    prefs = { ...prefs, neverClean: ['/ws/wt/a'] }
    expect(await wrapped.isProtectedNow(b)).toBe(true)
    prefs = { ...defaultGcPrefs(), keep: { [b.item.id]: 'merged' } }
    expect(await wrapped.isProtectedNow(b)).toBe(true)
  })
})
