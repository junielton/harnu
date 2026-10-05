// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import DehydrateConfirmDialog from '../src/renderer/src/components/DehydrateConfirmDialog.vue'
import { useReaperStore } from '../src/renderer/src/stores/reaper'
import { i18n } from '@renderer/i18n'
import en from '../src/renderer/src/i18n/en.json'
import type { ReapItem, HydrationInfo, DehydrateResult } from '../src/preload'

/**
 * T250 AC-7 — the dehydrate confirm is honest on three points: nothing removed
 * is work; nothing goes to the trash, so there is no undo there; a worktree with
 * no `setup` cannot be rehydrated by Harnu. And it borrows SweepConfirmDialog's
 * shape, never its copy: a dialog that never sweeps must not say "never swept".
 */

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

function item(over: Partial<ReapItem> = {}): ReapItem {
  return {
    id: 'i1',
    repoPath: '/repo',
    kind: 'worktree',
    branch: 'feat/x',
    path: '/repo/.claude/worktrees/feat-x',
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

let reaperDehydrate: ReturnType<typeof vi.fn>

beforeEach(async () => {
  reaperDehydrate = vi.fn(async (): Promise<DehydrateResult[]> => [
    {
      itemId: 'i1',
      ok: true,
      removed: ['node_modules'],
      skipped: [],
      failed: [],
      trackedChanged: []
    }
  ])
  const api = {
    reaperDehydrate,
    reaperSnapshot: vi.fn(async () => null),
    reaperJournal: vi.fn(async () => []),
    reaperPrefs: vi.fn(async () => ({ dehydrateIdleDays: 7 }))
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => () => {})
  })
  setActivePinia(createPinia())
  await useReaperStore().init()
})

function mountDialog(items: ReapItem[]) {
  return mount(DehydrateConfirmDialog, {
    props: { items },
    global: { plugins: [i18n], stubs: { teleport: true } }
  })
}

describe('DehydrateConfirmDialog — honest on three points (AC-7)', () => {
  it('1: says nothing removed is work, and which guards decide that', () => {
    const text = mountDialog([item()]).text()
    expect(text).toContain('Nothing removed is work')
    expect(text).toContain('git ignores it')
    expect(text).toContain('git tracks no file inside it')
    expect(text).toContain('uncommitted edit stay exactly as they are')
  })

  it('2: says the folders are deleted outright — no undo in the trash', () => {
    const text = mountDialog([item()]).text()
    expect(text).toContain('not moved to the trash')
    expect(text).toContain('There is no undo in the trash')
  })

  it('3: says Harnu cannot rehydrate a worktree with no setup — per item and for the batch', () => {
    const text = mountDialog([
      item(),
      item({ id: 'i2', branch: 'feat/y', hydration: hydration({ canRehydrate: false }) })
    ]).text()
    expect(text).toContain('No setup in WORKTREE.md — Harnu cannot rehydrate this one')
    expect(text).toContain('1 of these has no setup')
  })

  it('never borrows sweep copy', () => {
    const text = mountDialog([item()]).text()
    expect(text).not.toContain('never swept')
    expect(text).not.toContain('system trash')
    expect(text).not.toContain('reflog')
  })

  it('owns its keys under cleanup.dehydrateConfirm.* — none mirrored from sweepConfirm.what.*', () => {
    const keys = Object.keys(en.cleanup.dehydrateConfirm)
    expect(keys).not.toContain('what')
    expect(keys).toEqual(
      expect.arrayContaining([
        'title',
        'permanentTitle',
        'permanentBody',
        'noSetup',
        'regenerableBody'
      ])
    )
  })
})

describe('DehydrateConfirmDialog — disclosure', () => {
  // AC-3 surfaced: the kept path is named with its reason before anything runs.
  it('names a committed vendor/ as kept, with the guard that kept it', () => {
    const text = mountDialog([
      item({ hydration: hydration({ skipped: [{ path: 'vendor', reason: 'tracked' }] }) })
    ]).text()
    expect(text).toContain('Kept')
    expect(text).toContain('vendor — tracked by git — never removed')
  })

  it('lists what goes, with its size — or says the size is unknown', () => {
    const text = mountDialog([
      item(),
      item({ id: 'i2', branch: 'feat/y', hydration: hydration({ reclaimableBytes: null }) })
    ]).text()
    expect(text).toContain('node_modules · 1.90 GB')
    expect(text).toContain('node_modules · size unknown')
    expect(text).toContain('1 not measured')
  })

  it('confirms through the store and closes on success', async () => {
    const w = mountDialog([item()])
    await w.get('button.bg-accent-soft').trigger('click')
    await flushPromises()
    expect(reaperDehydrate).toHaveBeenCalledWith({ itemIds: ['i1'] })
    expect(w.emitted('close')?.[0]).toEqual([true])
  })

  it('keeps a per-path failure visible instead of closing', async () => {
    reaperDehydrate.mockImplementation(async () => {
      const r: DehydrateResult = {
        itemId: 'i1',
        ok: false,
        removed: [],
        skipped: [],
        failed: [{ path: 'node_modules', error: 'EPERM: operation not permitted' }],
        trackedChanged: []
      }
      useReaperStore().dehydrateProgress.push(r)
      return [r]
    })
    const w = mountDialog([item()])
    await w.get('button.bg-accent-soft').trigger('click')
    await flushPromises()
    expect(w.emitted('close')).toBeUndefined()
    expect(w.text()).toContain('node_modules: EPERM: operation not permitted')
  })
})
