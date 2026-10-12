/**
 * T460 batch 0 — headless `SurfaceSpec`s for the emit/local-driven confirm
 * dialogs (group B): CleanupBulkConfirm, ContainersRemove, DehydrateConfirm,
 * SweepConfirm, MissionBulkCloseConfirm, MissionCloseConfirm, MissionsReview
 * and HarnuModExternal's confirm.
 *
 * Each spec mounts the REAL component (real pinia stores, real i18n, real
 * Teleport into `document.body`) and exposes how the component reports being
 * closed: the `emit` it fires (name + payload), or — for the two surfaces that
 * own a local `open` / `confirming` ref — the disappearance of the dialog from
 * the DOM. Nothing here asserts; `probe()` in `harness.ts` measures.
 */
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { vi } from 'vitest'
import { i18n } from '@renderer/i18n'
import CleanupBulkConfirmDialog from '../../src/renderer/src/components/CleanupBulkConfirmDialog.vue'
import ContainersRemoveDialog from '../../src/renderer/src/components/ContainersRemoveDialog.vue'
import DehydrateConfirmDialog from '../../src/renderer/src/components/DehydrateConfirmDialog.vue'
import SweepConfirmDialog from '../../src/renderer/src/components/SweepConfirmDialog.vue'
import MissionBulkCloseConfirmDialog from '../../src/renderer/src/components/MissionBulkCloseConfirmDialog.vue'
import MissionCloseConfirmDialog from '../../src/renderer/src/components/MissionCloseConfirmDialog.vue'
import MissionsReviewDialog from '../../src/renderer/src/components/MissionsReviewDialog.vue'
import HarnuModExternal from '../../src/renderer/src/components/HarnuModExternal.vue'
import { useReaperStore } from '../../src/renderer/src/stores/reaper'
import { useMissionsStore } from '../../src/renderer/src/stores/missions'
import { useSessionsStore } from '../../src/renderer/src/stores/sessions'
import type { DialogRow } from '../../src/renderer/src/lib/gc-model'
import type { MissionView } from '../../src/main/mission-ipc'
import type { ReapItem, HydrationInfo, StackRow } from '../../src/preload'
import { stack as stackFixture } from '../helpers/containers-fixtures'
import type { OpenedSurface, SurfaceSpec } from './harness'

// ---- shared helpers -------------------------------------------------------------------------------

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)

/** A guarded `window.api`: anything not listed resolves to a no-op subscription / undefined. */
function installApi(api: Record<string, unknown>): void {
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => () => {})
  })
}

/** The card's own `class` + inline `style` — where a height cap lives for components that inline it. */
function cardEvidence(): string {
  const c = q('[role="dialog"]')
  return `${c?.className ?? ''} ${c?.getAttribute('style') ?? ''}`
}

/** How an emit-driven component reported closing: `name[payload,…]` of the last matching emit. */
function emitSignal(w: VueWrapper, names: string[]): string {
  const all = w.emitted()
  const last = names.flatMap((n) => (all[n] ?? []).map((args) => `${n}${JSON.stringify(args)}`))
  return last.at(-1) ?? ''
}

function emitted(w: VueWrapper, names: string[]): boolean {
  const all = w.emitted()
  return names.some((n) => (all[n] ?? []).length > 0)
}

/** Build an `OpenedSurface` for a component whose close mechanism is an emit. */
function emitSurface(
  w: VueWrapper,
  closeEmits: string[],
  named: OpenedSurface['named'],
  capEvidence: () => string = cardEvidence
): OpenedSurface {
  return {
    card: () => q('[role="dialog"]'),
    scrim: () => q('[role="presentation"]'),
    isClosed: () => emitted(w, closeEmits),
    closeSignal: () => emitSignal(w, closeEmits),
    teardown: () => w.unmount(),
    named,
    capEvidence
  }
}

// ---- CleanupBulkConfirmDialog -----------------------------------------------------------------------

function bulkRow(): DialogRow {
  return {
    id: 'r1',
    kind: 'worktree',
    repo: 'www',
    name: 'PROJ-231-feature',
    branch: 'feat/proj-231',
    bytes: 512_000_000,
    chips: ['stack', 'deps', 'checkout', 'branch'],
    stackCount: 1,
    reasonCode: null,
    reasonDetail: null,
    project: null,
    risk: false
  }
}

const cleanupBulk: SurfaceSpec = {
  file: 'CleanupBulkConfirmDialog.vue',
  async open(): Promise<OpenedSurface> {
    const w = mount(CleanupBulkConfirmDialog, {
      props: { rows: [bulkRow()], mode: 'ready', stale: false },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    return emitSurface(w, ['cancel', 'confirm'], {
      // The ✕ is a `ui/Button` (data-testid on the root button); Cancel/confirm are footer buttons.
      close: () => q('[data-testid="bulk-close"]'),
      cancel: () => q('[data-testid="bulk-cancel"]'),
      confirm: () => q('[data-testid="bulk-confirm"]'),
      list: () => q('[data-testid="bulk-list"]')
    })
  }
}

// ---- ContainersRemoveDialog ---------------------------------------------------------------------------

const containersRemove: SurfaceSpec = {
  file: 'ContainersRemoveDialog.vue',
  async open(): Promise<OpenedSurface> {
    setActivePinia(createPinia())
    installApi({})
    const stack: StackRow = stackFixture({ id: 'proj-82', verdict: 'zombie', running: false })
    const w = mount(ContainersRemoveDialog, {
      props: { stack },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    return emitSurface(w, ['close'], {
      cancel: () => q('[role="dialog"] button:not([data-testid="containers-remove-confirm"])'),
      confirm: () => q('[data-testid="containers-remove-confirm"]'),
      volume: () => q('[data-testid="containers-remove-volume"]')
    })
  }
}

// ---- Dehydrate / Sweep (ReapItem-driven, reaper store) ----------------------------------------------------

function hydration(): HydrationInfo {
  return {
    state: 'hydrated',
    removable: ['node_modules'],
    skipped: [],
    reclaimableBytes: 1_900_000_000,
    canRehydrate: true,
    rehydrateChanged: []
  }
}

function reapItem(over: Partial<ReapItem> = {}): ReapItem {
  return {
    id: 'i1',
    repoPath: '/home/dev/org/proj/www',
    kind: 'worktree',
    branch: 'feat/proj-231',
    path: '/home/dev/org/proj/www/.claude/worktrees/feat-proj-231',
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
  } as ReapItem
}

async function reaperWorld(): Promise<void> {
  installApi({
    reaperDehydrate: vi.fn(async () => []),
    reaperSweep: vi.fn(async () => []),
    reaperSnapshot: vi.fn(async () => null),
    reaperJournal: vi.fn(async () => []),
    reaperPrefs: vi.fn(async () => ({ dehydrateIdleDays: 7 }))
  })
  setActivePinia(createPinia())
  await useReaperStore().init()
}

const dehydrateConfirm: SurfaceSpec = {
  file: 'DehydrateConfirmDialog.vue',
  async open(): Promise<OpenedSurface> {
    await reaperWorld()
    const w = mount(DehydrateConfirmDialog, {
      props: { items: [reapItem()] },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    // `data-testid="dehydrate-confirm"` is on the CARD, not the button. The confirm button has no
    // hook: it is the footer button with the `accent-soft` fill; Cancel is the other one.
    return emitSurface(w, ['close'], {
      cancel: () => q('[role="dialog"] footer button:not(.bg-accent-soft)'),
      confirm: () => q('[role="dialog"] footer button.bg-accent-soft'),
      close: () => q('[role="dialog"] header button')
    })
  }
}

const sweepConfirm: SurfaceSpec = {
  file: 'SweepConfirmDialog.vue',
  async open(): Promise<OpenedSurface> {
    await reaperWorld()
    const w = mount(SweepConfirmDialog, {
      props: { items: [reapItem({ kind: 'worktree' })] },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    // SweepConfirm's destructive button has no test hook: it is the footer button that
    // carries the `red-soft` fill. Cancel is the other footer button.
    const confirm = (): HTMLElement | null => q('[role="dialog"] footer button.bg-red-soft')
    return emitSurface(w, ['close'], {
      cancel: () => q('[role="dialog"] footer button:not(.bg-red-soft)'),
      confirm,
      close: () => q('[role="dialog"] header button')
    })
  }
}

// ---- Missions: bulk close + single close --------------------------------------------------------------------

function missionWorld(): void {
  // jsdom does not implement media playback; the dialogs call `playNotificationSound()` on mount.
  HTMLMediaElement.prototype.play = vi.fn(async () => undefined)
  setActivePinia(createPinia())
  installApi({ requestAttention: vi.fn(async () => undefined) })
}

const missionBulkClose: SurfaceSpec = {
  file: 'MissionBulkCloseConfirmDialog.vue',
  async open(): Promise<OpenedSurface> {
    missionWorld()
    const w = mount(MissionBulkCloseConfirmDialog, {
      props: {
        items: [{ id: 'm1', title: 'Mission one', warnings: [] }],
        busy: false,
        progress: null
      },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    return emitSurface(w, ['cancel', 'confirm'], {
      cancel: () => q('[data-test="bulk-close-cancel"]'),
      confirm: () => q('[data-test="bulk-close-go"]'),
      close: () => q('[role="dialog"] header button'),
      reason: () => q('[data-test="bulk-close-reason"]')
    })
  }
}

const missionClose: SurfaceSpec = {
  file: 'MissionCloseConfirmDialog.vue',
  async open(): Promise<OpenedSurface> {
    missionWorld()
    const w = mount(MissionCloseConfirmDialog, {
      props: { title: 'Mission one', busy: false },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    return emitSurface(w, ['cancel', 'confirm'], {
      cancel: () => q('[data-test="mission-close-cancel"]'),
      confirm: () => q('[data-test="mission-close-confirm-go"]'),
      close: () => q('[role="dialog"] header button'),
      reason: () => q('[data-test="mission-end-reason"]')
    })
  }
}

// ---- MissionsReviewDialog (local `open` ref, reflected in the DOM) -------------------------------------------

function reviewView(id: string): MissionView {
  return {
    root: '/repo',
    mission: {
      id,
      status: 'delivered',
      updatedAt: '2026-10-09T10:00:00.000Z',
      owner: { sessionId: `owner-${id}`, folder: '/repo' },
      pendingClose: { at: '2026-10-09T09:00:00.000Z', requestedBy: 'x' },
      blockers: [],
      steps: [{ id: 'stp-9', kind: 'fixed-end', title: 'Delivered and verified', blockers: [] }]
    },
    title: `Mission ${id}`,
    derived: { stale: false },
    progress: { allDone: true, leftBehind: [] },
    you: [{ kind: 'close' }],
    closeWarnings: []
  } as unknown as MissionView
}

const missionsReview: SurfaceSpec = {
  file: 'MissionsReviewDialog.vue',
  async open(): Promise<OpenedSurface> {
    i18n.global.locale.value = 'en'
    localStorage.setItem('om2tab.missionCues', JSON.stringify({ v: 1, owed: {} }))
    setActivePinia(createPinia())
    useSessionsStore().folders = [{ path: '/repo', sessions: [] }] as never
    installApi({
      missionList: vi.fn(async () => ({ views: [], unreadable: [] })),
      missionOperatorDoor: vi.fn(async () => ({ ok: true, view: null })),
      requestAttention: vi.fn(async () => undefined)
    })
    Element.prototype.scrollIntoView = vi.fn()
    HTMLMediaElement.prototype.play = vi.fn(async () => undefined)
    const store = useMissionsStore()
    store.views = [reviewView('r1')]
    const w = mount(MissionsReviewDialog, { attachTo: document.body, global: { plugins: [i18n] } })
    store.openReview()
    await nextTick()
    return {
      card: () => q('[role="dialog"]'),
      scrim: () => q('[role="presentation"]'),
      // The component keeps a local `open` ref; closing removes the card from the DOM.
      isClosed: () => q('[data-test="missions-review"]') === null,
      closeSignal: () => 'local open=false (card removed from DOM)',
      teardown: () => w.unmount(),
      named: {
        close: () => q('[data-test="review-dismiss"]'),
        cancel: () => q('footer button:not([data-test])'),
        confirmSelected: () => q('[data-test="review-close-selected"]')
      },
      capEvidence: cardEvidence
    }
  }
}

// ---- HarnuModExternal (confirm part; local `confirming` ref) ------------------------------------------------

const harnuModExternal: SurfaceSpec = {
  file: 'HarnuModExternal.vue',
  async open(): Promise<OpenedSurface> {
    setActivePinia(createPinia())
    installApi({
      companionExternalGet: vi.fn(async () => ({
        on: false,
        path: '/home/dev/.claude/settings.json',
        entry: null,
        candidate: '/home/dev/org/proj/mod',
        lastSeenAt: null,
        companionOn: true,
        live: 0
      })),
      companionExternalSet: vi.fn(async () => null),
      onCompanionUpdated: vi.fn(() => () => {})
    })
    const w = mount(HarnuModExternal, { attachTo: document.body, global: { plugins: [i18n] } })
    await vi.waitFor(() => {
      if (!q('[data-testid="mods-external-advanced"]')) throw new Error('pane not ready')
    })
    q('[data-testid="mods-external-advanced"]')!.click()
    await nextTick()
    q('[data-testid="mods-external-toggle"]')!.click()
    await nextTick()
    return {
      card: () => q('[role="dialog"]'),
      scrim: () => q('[role="presentation"]'),
      // `confirming` is a local ref: closing removes the dialog; the pane section stays.
      isClosed: () => q('[data-testid="mods-external-confirm"]') === null,
      closeSignal: () => 'local confirming=false (dialog removed from DOM)',
      teardown: () => w.unmount(),
      named: {
        cancel: () => q('[data-testid="mods-external-confirm"] footer button:not([data-testid])'),
        confirm: () => q('[data-testid="mods-external-accept"]'),
        close: () => q('[data-testid="mods-external-confirm"] header button')
      },
      capEvidence: cardEvidence
    }
  }
}

export const SURFACES_B: SurfaceSpec[] = [
  cleanupBulk,
  containersRemove,
  dehydrateConfirm,
  harnuModExternal,
  missionBulkClose,
  missionClose,
  missionsReview,
  sweepConfirm
]
