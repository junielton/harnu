import { describe, it, expect } from 'vitest'
import { withActor } from '../src/main/gc/gc-actor'
import { createGcOps } from '../src/main/gc/gc-shell'
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
    isProtectedNow: () => false,
    realpath: async (p: string) => p
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

describe('the live protection check resolves real paths (delta 3b, item 12)', () => {
  const link = async (p: string): Promise<string | null> =>
    p.startsWith('/link/') ? `/real/${p.slice('/link/'.length)}` : p

  it('a never-clean entry added under a symlinked spelling is honored', async () => {
    const { deps } = base()
    const wrapped = withActor({ ...deps, realpath: link }, 'autopilot', () => ({
      ...defaultGcPrefs(),
      neverClean: ['/link/wt']
    }))
    expect(await wrapped.isProtectedNow(bundle('/real/wt', 'ready'))).toBe(true)
    expect(await wrapped.isProtectedNow(bundle('/real/other', 'ready'))).toBe(false)
  })

  it('refuses the reprobe on it, before anything is probed', async () => {
    const { deps } = base()
    const ops = createGcOps(
      withActor({ ...deps, realpath: link } as GcShellDeps, 'autopilot', () => ({
        ...defaultGcPrefs(),
        neverClean: ['/link/wt']
      }))
    )
    expect(await ops.reprobe(bundle('/real/wt', 'ready'))).toEqual({
      ok: false,
      reason: 'protected-now'
    })
  })

  it('a stale never-clean entry that no longer resolves matches by spelling only, not everything', async () => {
    const { deps } = base()
    const gone = async (p: string): Promise<string | null> => (p === '/old/folder' ? null : p)
    const wrapped = withActor({ ...deps, realpath: gone }, 'autopilot', () => ({
      ...defaultGcPrefs(),
      neverClean: ['/old/folder']
    }))
    expect(await wrapped.isProtectedNow(bundle('/real/wt', 'ready'))).toBe(false)
    expect(await wrapped.isProtectedNow(bundle('/old/folder', 'ready'))).toBe(true)
  })

  it("a bundle path that cannot be resolved is protected: it may be anyone's", async () => {
    const { deps } = base()
    const wrapped = withActor({ ...deps, realpath: async () => null }, 'autopilot', () =>
      defaultGcPrefs()
    )
    expect(await wrapped.isProtectedNow(bundle('/real/wt', 'ready'))).toBe(true)
  })
})
