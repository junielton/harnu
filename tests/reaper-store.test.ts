import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useReaperStore } from '../src/renderer/src/stores/reaper'
import type { ReaperSnapshot, ReapItem, ReapVerdict, CleanResult, Tombstone } from '../src/preload'

/**
 * Store regression net for the Reaper cleanup engine's renderer cache (plan
 * Task 8, `docs/plans/2026-07-15-reaper-cleanup.md`). Stubs `window.api`
 * following the `tests/session-presence.test.ts` pattern — a captured
 * `onReaperUpdate`/`onReaperProgress` subscription so a test can fire it
 * directly instead of going through real IPC.
 */

function item(over: Partial<ReapItem> & { id: string; verdict: ReapVerdict }): ReapItem {
  return {
    repoPath: '/repo',
    kind: 'worktree',
    branch: 'feat/x',
    path: '/repo/.claude/worktrees/feat-x',
    hidden: false,
    ageDays: 5,
    diskBytes: null,
    checkpoints: [],
    blockers: [],
    needsRemoteDelete: false,
    justifiedBy: null,
    ...over
  }
}

function snapshotOf(items: ReapItem[]): ReaperSnapshot {
  return { scannedAt: 1_800_000_000_000, repos: [{ repoPath: '/repo', items }] }
}

function installApi(): {
  handlers: Record<string, ((p: unknown) => void) | undefined>
  reaperScan: ReturnType<typeof vi.fn>
  reaperClean: ReturnType<typeof vi.fn>
  reaperSweep: ReturnType<typeof vi.fn>
  reaperJournal: ReturnType<typeof vi.fn>
} {
  const handlers: Record<string, ((p: unknown) => void) | undefined> = {}
  const capture =
    (name: string) =>
    (cb: (p: unknown) => void): (() => void) => {
      handlers[name] = cb
      return () => {
        handlers[name] = undefined
      }
    }

  const reaperScan = vi.fn(async () => snapshotOf([]))
  const reaperClean = vi.fn(async (): Promise<CleanResult> => ({
    itemId: 'x',
    ok: true,
    steps: []
  }))
  const reaperSweep = vi.fn(async (): Promise<CleanResult[]> => [])
  const reaperJournal = vi.fn(async (): Promise<Tombstone[]> => [])

  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      reaperSnapshot: vi.fn(async () => null),
      reaperScan,
      reaperClean,
      reaperSweep,
      reaperJournal,
      onReaperUpdate: capture('update'),
      onReaperProgress: capture('progress'),
      onReaperHarvestable: capture('harvestable')
    }
  }

  return { handlers, reaperScan, reaperClean, reaperSweep, reaperJournal }
}

describe('reaper store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('init loads the last snapshot and journal, and subscribes to updates', async () => {
    const harvestableItem = item({ id: 'a', verdict: 'harvestable', diskBytes: 100 })
    const snap = snapshotOf([harvestableItem])
    const api = installApi()
    ;(window.api.reaperSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap)
    api.reaperJournal.mockResolvedValue([
      {
        at: 1,
        repoPath: '/repo',
        kind: 'worktree',
        branch: 'x',
        sha: null,
        deleted: [],
        justifiedBy: null,
        restoreHint: null
      }
    ])

    const store = useReaperStore()
    await store.init()

    expect(store.snapshot).toEqual(snap)
    expect(store.journal.length).toBe(1)
    expect(api.handlers.update).toBeTypeOf('function')
    expect(api.handlers.progress).toBeTypeOf('function')
  })

  it('scanNow sets scanning while in flight and clears it after, forcing a bypass', async () => {
    const api = installApi()
    let resolveScan: (v: ReaperSnapshot) => void
    api.reaperScan.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve
        })
    )

    const store = useReaperStore()
    const p = store.scanNow()
    expect(store.scanning).toBe(true)
    resolveScan!(snapshotOf([]))
    await p
    expect(store.scanning).toBe(false)
    expect(api.reaperScan).toHaveBeenCalledWith(true)
  })

  it('sweepAll passes only currently-harvestable ids and forwards deleteRemote', async () => {
    const api = installApi()
    const snap = snapshotOf([
      item({ id: 'harvest-1', verdict: 'harvestable' }),
      item({ id: 'blocked-1', verdict: 'blocked' }),
      item({ id: 'harvest-2', verdict: 'harvestable' })
    ])
    ;(window.api.reaperSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap)
    const store = useReaperStore()
    await store.init()

    await store.sweepAll(true)

    expect(api.reaperSweep).toHaveBeenCalledWith({
      itemIds: ['harvest-1', 'harvest-2'],
      deleteRemote: true
    })
  })

  it('sweepAll is a no-op when nothing is harvestable', async () => {
    const api = installApi()
    const store = useReaperStore()
    const results = await store.sweepAll(false)
    expect(results).toEqual([])
    expect(api.reaperSweep).not.toHaveBeenCalled()
  })

  it('sweepItems passes exactly the caller-supplied ids, ignoring the rest of harvestable', async () => {
    const api = installApi()
    const snap = snapshotOf([
      item({ id: 'harvest-1', verdict: 'harvestable' }),
      item({ id: 'harvest-2', verdict: 'harvestable' }),
      item({ id: 'harvest-3', verdict: 'harvestable' })
    ])
    ;(window.api.reaperSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap)
    const store = useReaperStore()
    await store.init()

    await store.sweepItems(['harvest-2'], false)

    expect(api.reaperSweep).toHaveBeenCalledWith({
      itemIds: ['harvest-2'],
      deleteRemote: false
    })
  })

  it('onReaperUpdate replaces the snapshot', async () => {
    const api = installApi()
    const store = useReaperStore()
    await store.init()

    const next = snapshotOf([item({ id: 'a', verdict: 'harvestable' })])
    api.handlers.update?.(next)

    expect(store.snapshot).toEqual(next)
    expect(store.totals.harvestable).toBe(1)
  })

  it('repoGroups filters out active-verdict items and drops now-empty groups', async () => {
    installApi()
    const snap: ReaperSnapshot = {
      scannedAt: 1,
      repos: [
        { repoPath: '/repo-a', items: [item({ id: 'a', verdict: 'active' })] },
        { repoPath: '/repo-b', items: [item({ id: 'b', verdict: 'harvestable' })] }
      ]
    }
    ;(window.api.reaperSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snap)
    const store = useReaperStore()
    await store.init()

    expect(store.repoGroups.map((g) => g.repoPath)).toEqual(['/repo-b'])
  })
})
