// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import CleanupView from '../src/renderer/src/components/CleanupView.vue'
import { i18n } from '@renderer/i18n'
import type { ReapItem, HydrationInfo, ReaperSnapshot } from '../src/preload'

/**
 * T250 on the real row: design.md's worked examples for the hydration axis,
 * rendered by CleanupView itself — the action cluster, the meta-line marker,
 * the reason line that retired the padlock, and the repo-group pill.
 */

function hydration(over: Partial<HydrationInfo> = {}): HydrationInfo {
  return {
    state: 'hydrated',
    removable: ['node_modules'],
    skipped: [],
    reclaimableBytes: 480_000_000,
    canRehydrate: true,
    rehydrateChanged: [],
    ...over
  }
}

function row(id: string, over: Partial<ReapItem> = {}): ReapItem {
  return {
    id,
    repoPath: '/w/repo',
    kind: 'worktree',
    branch: id,
    path: `/w/repo/.claude/worktrees/${id}`,
    hidden: false,
    ageDays: 34,
    diskBytes: 1_200_000,
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

const ROWS: ReapItem[] = [
  // Worked example 7 — a detached Harnu worktree: Diagnose(T251) · Dehydrate.
  row('det', {
    kind: 'detached-worktree',
    branch: undefined,
    blockers: ['detached-head'],
    diskBytes: 480_000_000
  }),
  // Worked example 4 — dehydrated AND blocked, the contract's acceptance row.
  row('dry', { hydration: hydration({ state: 'dehydrated', removable: [] }) }),
  // Worked example 5 — dehydrated, manifest has no setup.
  row('nosetup', {
    blockers: ['unpushed'],
    hydration: hydration({ state: 'dehydrated', removable: [], canRehydrate: false })
  }),
  // Worked example 1 — harvestable with deps installed: Trash · Dehydrate.
  row('merged', { verdict: 'harvestable', blockers: [], justifiedBy: 'gh-merged' }),
  // Rehydrated, and the install rewrote a lockfile (AC-2).
  row('relock', {
    hydration: hydration({ removable: [], rehydrateChanged: ['package-lock.json'] })
  }),
  // A repo that commits vendor/ — nothing removable, so no Dehydrate at all.
  row('vendored', {
    hydration: hydration({ removable: [], skipped: [{ path: 'vendor', reason: 'tracked' }] })
  })
]

beforeEach(() => {
  const snapshot: ReaperSnapshot = {
    scannedAt: Date.now(),
    repos: [{ repoPath: '/w/repo', items: ROWS }]
  }
  const api = {
    reaperSnapshot: vi.fn(async () => snapshot),
    reaperJournal: vi.fn(async () => []),
    reaperPrefs: vi.fn(async () => ({ dehydrateIdleDays: 7 }))
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => () => {})
  })
  setActivePinia(createPinia())
})

async function mountView() {
  const w = mount(CleanupView, { global: { plugins: [i18n], stubs: { teleport: true } } })
  await flushPromises()
  return w
}

function rowOf(w: Awaited<ReturnType<typeof mountView>>, ident: string) {
  const found = w.findAll('[data-testid="cleanup-row"]').find((r) => r.text().includes(ident))
  if (!found) throw new Error(`no row for ${ident}`)
  return found
}

describe('CleanupView — hydration on the row', () => {
  // AC-6 — detached worktrees included: the reclaimable figure is on the button.
  it('offers Dehydrate on a detached worktree, with the bytes it frees', async () => {
    const r = rowOf(await mountView(), 'det')
    const btn = r.get('[data-testid="cleanup-dehydrate"]')
    // `{what}` is the row's visible identity (`identText`) — repo-relative for a
    // nested detached worktree on this base.
    expect(btn.attributes('aria-label')).toBe('Dehydrate .claude/worktrees/det — frees 480 MB')
    expect(r.get('[data-testid="cleanup-meta"]').text()).toContain('480 MB')
  })

  it('renders row 4: blocked chip, reason line, "dehydrated" marker, Rehydrate — no Trash, no padlock', async () => {
    const r = rowOf(await mountView(), 'dry')
    expect(r.text()).toContain('blocked')
    expect(r.get('[data-testid="cleanup-reason"]').text()).toBe('uncommitted changes')
    expect(r.get('[data-testid="cleanup-hydration"]').text()).toBe('dehydrated')
    expect(r.find('[data-testid="cleanup-rehydrate"]').exists()).toBe(true)
    expect(r.find('[data-testid="cleanup-dehydrate"]').exists()).toBe(false)
    expect(r.find('[data-testid="cleanup-trash"]').exists()).toBe(false)
    expect(r.find('.lucide-lock').exists()).toBe(false)
  })

  it('says "no setup" in the marker and offers no Rehydrate when Harnu cannot rehydrate', async () => {
    const r = rowOf(await mountView(), 'nosetup')
    expect(r.get('[data-testid="cleanup-hydration"]').text()).toBe('dehydrated · no setup')
    expect(r.find('[data-testid="cleanup-rehydrate"]').exists()).toBe(false)
  })

  it('puts the highest rank rightmost: Trash, then Dehydrate to its left', async () => {
    const r = rowOf(await mountView(), 'merged')
    const buttons = r.get('[data-testid="cleanup-actions"]').findAll('button')
    expect(buttons.map((b) => b.attributes('data-testid'))).toEqual([
      'cleanup-dehydrate',
      'cleanup-trash'
    ])
    expect(buttons[1].attributes('aria-label')).toBe('Clean up: merged')
  })

  // AC-2 — the row names the file the install modified.
  it('names the lockfile a rehydrate rewrote', async () => {
    const r = rowOf(await mountView(), 'relock')
    expect(r.get('[data-testid="cleanup-hydration"]').text()).toBe(
      'rehydrate changed package-lock.json'
    )
  })

  it('offers nothing to dehydrate on a repo that commits vendor/, and says why in the meta tooltip', async () => {
    const r = rowOf(await mountView(), 'vendored')
    expect(r.find('[data-testid="cleanup-dehydrate"]').exists()).toBe(false)
    expect(r.get('[data-testid="cleanup-meta"]').attributes('title')).toContain(
      'vendor — tracked by git — never removed'
    )
  })

  it('counts idle dehydratable rows in the repo-group pill (idle ≥ 7 days)', async () => {
    const w = await mountView()
    const pill = w.findAll('button').find((b) => b.text().startsWith('Dehydrate'))
    // det + merged are hydrated with something removable and 34 days old.
    expect(pill?.text()).toBe('Dehydrate 2 idle')
    expect(pill?.attributes('aria-label')).toBe('Dehydrate 2 idle worktrees in repo')
  })
})
