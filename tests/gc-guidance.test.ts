// "No dead ends" (unit B): what the selection can and cannot lose, grouped by reason, and which guided
// action clears each group. Everything here is derived from `removability()`: the guidance never
// hard-codes a refusal of its own (AC-B8), so a refusal main stops making simply stops showing.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { bundle, NOW, reapItem } from './gc-fixtures'
import { buildGcModel, type GcModel } from '../src/renderer/src/lib/gc-model'
import { removalSummary } from '../src/renderer/src/lib/gc-guidance'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { GcSnapshot } from '../src/main/gc/gc-wire'
import type { BundleFacts, ReviewCode } from '../src/main/gc/bundle-core'
import type { ReapItem } from '../src/main/reaper/reaper-core'

const GIB = 1024 ** 3

function wt(
  name: string,
  over: Partial<BundleFacts> = {},
  item: Partial<ReapItem> = {},
  code: ReviewCode = 'dirty'
): ReturnType<typeof bundle> {
  const b = bundle(`/ws/${name}`, 'review', { reason: { code, detail: 'x' }, ...over })
  b.item = reapItem(`/ws/${name}`, { diskBytes: GIB, ...item })
  b.item.id = `${b.item.repoPath}::${b.item.kind}::/ws/${name}`
  return b
}

const detached = (name: string, deps = 1_000_000_000) =>
  wt(
    name,
    { depsBytes: deps },
    {
      kind: 'detached-worktree',
      branch: null,
      hydration:
        deps > 0
          ? ({
              state: 'hydrated',
              removable: ['node_modules'],
              reclaimableBytes: deps,
              canRehydrate: true
            } as never)
          : null
    },
    'unknown-fate'
  )

function modelOf(bundles: ReturnType<typeof bundle>[]): GcModel {
  const snap: GcSnapshot = {
    scannedAt: NOW,
    bundles,
    orphanVolumes: [],
    docker: { buildCacheReclaimableBytes: null, danglingImages: null },
    prefs: defaultGcPrefs(),
    lastCycle: null,
    nextCycleAt: null,
    nextClean: null,
    backgroundScan: true
  }
  return buildGcModel(snap)
}

afterEach(() => vi.doUnmock('../src/renderer/src/lib/gc-removability'))

describe('removalSummary (AC-B1)', () => {
  it('names every refusal of a selection that cannot be removed at all, with its count', () => {
    const bs = Array.from({ length: 11 }, (_, i) => detached(`d${i}`))
    const m = modelOf(bs)
    const s = removalSummary(m, [...m.byId.keys()], NOW)
    expect(s.removable).toEqual([])
    expect(s.refused).toHaveLength(1)
    expect(s.refused[0]).toMatchObject({ reason: 'unsupported-kind', count: 11 })
    expect(s.refused[0].ids).toHaveLength(11)
  })

  it('splits a partial selection into what goes and what is refused, biggest group first', () => {
    const ok = [wt('a'), wt('b'), wt('c')]
    const locked = [wt('l1', { locked: true }, {}, 'locked')]
    const det = [detached('d1'), detached('d2'), detached('d3')]
    const m = modelOf([...ok, ...locked, ...det])
    const s = removalSummary(m, [...m.byId.keys()], NOW)
    expect(s.removable).toHaveLength(3)
    expect(s.refused.map((g) => [g.reason, g.count])).toEqual([
      ['unsupported-kind', 3],
      ['locked', 1]
    ])
  })

  it('ignores ids the model does not know', () => {
    const m = modelOf([wt('a')])
    expect(removalSummary(m, ['nope'], NOW)).toMatchObject({ removable: [], refused: [] })
  })
})

describe('guided action per refusal (AC-B3 … B8)', () => {
  const actionOf = (b: ReturnType<typeof bundle>) => {
    const m = modelOf([b])
    return removalSummary(m, [...m.byId.keys()], NOW).refused[0]?.action
  }

  it('locked → unlock and remove', () => {
    expect(actionOf(wt('l', { locked: true }, {}, 'locked'))).toBe('unlock-remove')
  })
  it('an open session → close the idle session and remove', () => {
    expect(actionOf(wt('s', { session: 'open-idle' }, {}, 'open-idle-session'))).toBe(
      'close-session-remove'
    )
  })
  it('a shared stack → choose between stopping it and leaving it', () => {
    expect(actionOf(wt('x', { sharedStackIds: ['web'] }, {}, 'shared-stack'))).toBe('shared-stack')
  })
  it('an unreadable folder → fix the permission, then check again', () => {
    expect(actionOf(wt('u', { nestedWorktrees: undefined as never }, {}, 'check-failed'))).toBe(
      'fix-unreadable'
    )
  })
  it('a scan that was blind to Docker → scan again', () => {
    expect(actionOf(wt('b', { dockerBlind: true }))).toBe('scan-again')
  })
  it('a detached worktree → dehydrate, plus the manual command', () => {
    const s = (() => {
      const m = modelOf([detached('d')])
      return removalSummary(m, [...m.byId.keys()], NOW).refused[0]
    })()
    expect(s.action).toBe('dehydrate')
    expect(s.hint).toContain('git worktree remove')
  })
  it('a Keep mark → remove the mark', () => {
    expect(actionOf(wt('k', { keep: true }))).toBe('unkeep')
  })
  it('a never-clean path → open the setting', () => {
    expect(actionOf(wt('n', { neverClean: true }))).toBe('open-settings')
  })
  it('every refusal main can make has a guided action (no dead ends)', async () => {
    const { removability } = await import('../src/renderer/src/lib/gc-removability')
    const reasons = [
      'main-checkout',
      'never-clean',
      'kept',
      'in-use',
      'unsupported-kind',
      'shared-stack',
      'nested-worktree',
      'check-failed',
      'folder-gone',
      'tip-unknown',
      'grace-not-elapsed',
      'path-unresolved',
      'session-open',
      'locked',
      'cannot-unregister',
      'protected-now',
      'stack-present',
      'scan-blind'
    ] as const
    const { guidedActionFor } = await import('../src/renderer/src/lib/gc-guidance')
    for (const r of reasons) expect(guidedActionFor(r, { hasDeps: false }), r).toBeTruthy()
    expect(removability).toBeTypeOf('function')
  })
})

describe('the best partial win (AC-B2)', () => {
  it('promotes dehydrate with the real bytes of what the refused items carry', () => {
    const deps = [detached('d1', 6_000_000_000), detached('d2', 5_700_000_000)]
    const m = modelOf(deps)
    const s = removalSummary(m, [...m.byId.keys()], NOW)
    expect(s.dehydrate).toEqual({ count: 2, bytes: 11_700_000_000, ids: expect.any(Array) })
  })

  it('offers nothing when no refused item carries deps', () => {
    const m = modelOf([detached('d1', 0)])
    expect(removalSummary(m, [...m.byId.keys()], NOW).dehydrate).toBeNull()
  })
})

describe('refusals come only from removability() (AC-B8)', () => {
  it('a detached worktree that main takes simply stops being a group', async () => {
    vi.resetModules()
    vi.doMock('../src/renderer/src/lib/gc-removability', async (orig) => ({
      ...(await orig<typeof import('../src/renderer/src/lib/gc-removability')>()),
      removability: () => ({ ok: true })
    }))
    const { buildGcModel: build } = await import('../src/renderer/src/lib/gc-model')
    const { removalSummary: summary } = await import('../src/renderer/src/lib/gc-guidance')
    const m = build({
      scannedAt: NOW,
      bundles: [detached('d1'), detached('d2')],
      orphanVolumes: [],
      docker: { buildCacheReclaimableBytes: null, danglingImages: null },
      prefs: defaultGcPrefs(),
      lastCycle: null,
      nextCycleAt: null,
      nextClean: null,
      backgroundScan: true
    })
    const s = summary(m, [...m.byId.keys()], NOW)
    expect(s.removable).toHaveLength(2)
    expect(s.refused).toEqual([])
  })
})

describe('the copy tells the truth about what a failed prep left behind (delta 1)', () => {
  it('a stack that could not be stopped says what was started again', async () => {
    const { i18n } = await import('@renderer/i18n')
    const en = i18n.global.t('cleanup.gc.refusal.stackStopFailed') as string
    expect(en).toMatch(/restart|started again/i)
    // True after a partial stop whose restart failed too: it must not claim the restart worked.
    expect(en).not.toMatch(/started again what it had stopped and/i)
    expect(en).not.toMatch(
      /^Docker could not stop the shared stack, so the worktree was left alone\.$/
    )
  })
})

describe('what a guided action reports when its prep fails (AC-B9)', () => {
  it('every prep failure is a refusal the screen can word', async () => {
    const { refusalOf } = await import('../src/renderer/src/lib/gc-jobs')
    const { refusalKey } = await import('../src/renderer/src/components/cleanup-gc-copy')
    const { i18n } = await import('@renderer/i18n')
    const errors = [
      'unlock-failed: fatal: not locked',
      'session-busy',
      'session-not-closable',
      'stack-stop-failed: daemon gone',
      'stack-binds-folder',
      'prep-not-applicable'
    ]
    for (const error of errors) {
      const code = refusalOf({ ok: false, error })
      expect(code, error).not.toBeNull()
      expect(i18n.global.te(refusalKey(code!)), `${code} has a sentence`).toBe(true)
    }
  })
})
