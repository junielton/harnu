import { describe, it, expect } from 'vitest'
import {
  canDehydrate,
  canRehydrate,
  isIdleDehydratable,
  hydrationMarker,
  reasonLine
} from '../src/renderer/src/components/cleanup-row'
import type { ReapItem, HydrationInfo } from '../src/preload'

/**
 * T250 — the row's legality rules (design.md "The action cluster") and its
 * hydration/reason text. Every renderer consumer of hydration reads through
 * these helpers, so this is where a wrong value would first push a button onto
 * a row that must not have one.
 */

const t = (key: string, params?: Record<string, unknown>): string =>
  params ? `${key}:${JSON.stringify(params)}` : key

function hydration(over: Partial<HydrationInfo> = {}): HydrationInfo {
  return {
    state: 'hydrated',
    removable: ['node_modules'],
    skipped: [],
    reclaimableBytes: 1_900_000_000,
    canRehydrate: true,
    rehydrateChanged: [],
    ...over
  }
}

function row(over: Partial<ReapItem> = {}): ReapItem {
  return {
    id: 'r',
    repoPath: '/repo',
    kind: 'worktree',
    branch: 'feat/x',
    path: '/repo/wt',
    hidden: false,
    ageDays: 30,
    diskBytes: 2_000_000_000,
    checkpoints: [],
    verdict: 'blocked',
    blockers: ['dirty'],
    needsRemoteDelete: false,
    untracked: [],
    justifiedBy: null,
    hydration: hydration(),
    ...over
  }
}

describe('canDehydrate — rank 6', () => {
  it('is legal on a blocked, hydrated worktree with something removable', () => {
    expect(canDehydrate(row())).toBe(true)
  })

  it('is legal on a detached worktree — the largest pool on the measured corpus', () => {
    expect(canDehydrate(row({ kind: 'detached-worktree', blockers: ['detached-head'] }))).toBe(true)
  })

  it.each<[string, Partial<ReapItem>]>([
    ['nothing removable (committed vendor/ only)', { hydration: hydration({ removable: [] }) }],
    ['already dehydrated', { hydration: hydration({ state: 'dehydrated' }) }],
    ['no hydration facts', { hydration: null }],
    ['a live session', { verdict: 'active' }],
    ['a branch with no checkout', { kind: 'local-branch', path: undefined }],
    ['a hidden folder', { kind: 'hidden-folder' }]
  ])('is absent for %s', (_label, over) => {
    expect(canDehydrate(row(over))).toBe(false)
  })
})

describe('canRehydrate — rank 5', () => {
  it('is legal on a dehydrated worktree whose manifest has setup', () => {
    expect(canRehydrate(row({ hydration: hydration({ state: 'dehydrated' }) }))).toBe(true)
  })

  it('is absent when the manifest has no setup — Harnu cannot rehydrate it', () => {
    expect(
      canRehydrate(row({ hydration: hydration({ state: 'dehydrated', canRehydrate: false }) }))
    ).toBe(false)
  })

  it('is never legal together with Dehydrate — opposite ends of one axis', () => {
    for (const state of ['hydrated', 'dehydrated'] as const) {
      const r = row({ hydration: hydration({ state }) })
      expect(canDehydrate(r) && canRehydrate(r)).toBe(false)
    }
  })
})

describe('isIdleDehydratable', () => {
  it('counts a row old enough', () => {
    expect(isIdleDehydratable(row({ ageDays: 7 }), 7)).toBe(true)
    expect(isIdleDehydratable(row({ ageDays: 6 }), 7)).toBe(false)
  })

  it('never counts an unknown age as idle', () => {
    expect(isIdleDehydratable(row({ ageDays: null }), 0)).toBe(false)
  })
})

describe('hydrationMarker', () => {
  it('renders nothing for a plain hydrated row — no key for the absence of a marker', () => {
    expect(hydrationMarker(row(), undefined, t)).toBeNull()
  })

  it('in flight wins over the at-rest state', () => {
    expect(
      hydrationMarker(row({ hydration: hydration({ state: 'dehydrated' }) }), 'rehydrating', t)
        ?.text
    ).toBe('cleanup.state.rehydrating')
  })

  it('folds "no setup" into the dehydrated marker instead of adding a fragment', () => {
    expect(
      hydrationMarker(
        row({ hydration: hydration({ state: 'dehydrated', canRehydrate: false }) }),
        undefined,
        t
      )?.text
    ).toBe('cleanup.state.dehydratedNoRehydrate')
  })

  // AC-2 — the row names the files the install modified.
  it('names the files a rehydrate changed, with every one in the tooltip list', () => {
    const m = hydrationMarker(
      row({ hydration: hydration({ rehydrateChanged: ['package-lock.json', 'composer.lock'] }) }),
      undefined,
      t
    )
    expect(m?.tone).toBe('warning')
    expect(m?.text).toBe(
      'cleanup.state.rehydrateChangedMore:{"file":"package-lock.json","count":1}'
    )
    expect(m?.files).toEqual(['package-lock.json', 'composer.lock'])
  })
})

describe('reasonLine', () => {
  it('shows the first blocker and counts the rest, with all of them in the title', () => {
    const r = reasonLine(row({ blockers: ['dirty', 'unpushed'] }), t)
    expect(r?.text).toBe('cleanup.blocker.dirty cleanup.reason.more:{"count":1}')
    expect(r?.title).toBe('cleanup.blocker.dirty; cleanup.blocker.unpushed')
  })

  it('never leaves an unknown row bare', () => {
    expect(reasonLine(row({ verdict: 'unknown', blockers: [] }), t)?.text).toBe(
      'cleanup.reason.noProbe'
    )
    expect(
      reasonLine(
        row({
          verdict: 'unknown',
          blockers: [],
          checkpoints: [{ id: 'pr', state: 'unknown', detail: 'PR list was capped' }]
        }),
        t
      )?.text
    ).toBe('PR list was capped')
  })

  it('has nothing to say for a harvestable row', () => {
    expect(reasonLine(row({ verdict: 'harvestable', blockers: [] }), t)).toBeNull()
  })
})
