/**
 * T460 batch 0 — headless `SurfaceSpec`s for the five SPECIAL surfaces: the two
 * roadmap card modals (own `click.self` scrim, no focus trap, dirty guard), the
 * Command palette and the Image lightbox (the two shells that are NEVER
 * migrated, spec D6) and the MCP confirm gate (fail-closed: no Esc, no scrim
 * dismissal, by design).
 *
 * Each `open()` mounts the REAL component with a real pinia + the real i18n and
 * stubs only what its open path touches (`window.api.*`). Nothing in here asserts
 * anything; `probe()` in `harness.ts` measures, and the characterization table
 * compares.
 */
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { vi } from 'vitest'
import { i18n } from '@renderer/i18n'
import CardCreateModal from '../../src/renderer/src/components/CardCreateModal.vue'
import CardDetailModal from '../../src/renderer/src/components/CardDetailModal.vue'
import CommandPalette from '../../src/renderer/src/components/CommandPalette.vue'
import ImageLightbox from '../../src/renderer/src/components/ImageLightbox.vue'
import McpConfirmOverlay from '../../src/renderer/src/components/McpConfirmOverlay.vue'
import { useUiStore } from '../../src/renderer/src/stores/ui'
import type { RoadmapCard } from '../../src/main/roadmap-core'
import type { SessionImage } from '../../src/renderer/src/composables/useSessionImages'
import type { McpConfirmPending } from '../../src/preload'
import type { OpenedSurface, SurfaceSpec } from './harness'

/** `window.api` where every function the test does not name is an inert async no-op. */
function installApi(overrides: Record<string, unknown> = {}): void {
  ;(window as unknown as { api: unknown }).api = new Proxy(overrides, {
    get: (target, key: string) => (key in target ? target[key] : vi.fn(async () => undefined))
  })
}

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)

/** Text the harness greps for a height cap: the card's `class` + inline `style`. */
const classAndStyle = (sel: string) => (): string => {
  const el = q(sel)
  return `${el?.className ?? ''} ${el?.getAttribute('style') ?? ''}`
}

/** First focusable in the card — the harness's own notion, used for the `first` name. */
const FIRST_FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
const firstFocusable = (): HTMLElement | null =>
  q('[role="dialog"]')?.querySelector<HTMLElement>(FIRST_FOCUSABLE) ?? null

const emittedSignal = (w: VueWrapper): string =>
  Object.entries(w.emitted())
    .filter(([name]) => name === 'close')
    .map(([name, calls]) => `${name}[${calls.map((c) => JSON.stringify(c)).join(',')}]`)
    .join(';')

// ---------------------------------------------------------------------------
// CardCreateModal — `click.self` scrim, window-capture Esc, NO focus trap.
// Both close routes go through `attemptClose` → `withDiscardGuard`: while the
// draft is dirty (title typed / body edited) it shows a toast with a Discard
// action instead of emitting `close`. The probes never edit the draft, so the
// guard passes straight through and a close request really emits `close`.
// ---------------------------------------------------------------------------
const cardCreate: SurfaceSpec = {
  file: 'CardCreateModal.vue',
  async open(): Promise<OpenedSurface> {
    setActivePinia(createPinia())
    installApi({ roadmapCardTemplates: vi.fn(async () => ({})) })
    const w = mount(CardCreateModal, { attachTo: document.body, global: { plugins: [i18n] } })
    const card = (): HTMLElement | null => q('[role="dialog"]')
    return {
      card,
      // The scrim carries no role/handler attribute of its own: it is the card's parent.
      scrim: () => card()?.parentElement ?? null,
      isClosed: () => (w.emitted('close')?.length ?? 0) > 0,
      closeSignal: () => emittedSignal(w),
      teardown: () => {
        w.unmount()
      },
      named: {
        input: () => q('[role="dialog"] input[type="text"]'),
        close: () => q('[role="dialog"] button[aria-label="Close"]'),
        first: firstFocusable
      },
      capEvidence: classAndStyle('[role="dialog"]')
    }
  }
}

// ---------------------------------------------------------------------------
// CardDetailModal — same chrome as CardCreate. `attemptCloseModal` also commits
// a pending title edit and is guarded while the body editor is dirty; the probes
// stay in read mode (`editing=false`), so the guard is inert.
// ---------------------------------------------------------------------------
const CARD: RoadmapCard = {
  id: 'T1',
  slug: 'proj-231-sample-card',
  title: 'PROJ-231 sample card',
  status: 'backlog',
  rawStatus: 'backlog',
  column: 'backlog',
  blocked: false,
  evidence: [],
  deps: [],
  kind: 'feature',
  complexity: 'standard',
  provenance: { author: 'human', at: '2026-10-01T10:00:00.000Z', branch: 'main' },
  body: '## Objective\nA sample card for Acme.\n',
  malformed: false
} as unknown as RoadmapCard

const cardDetail: SurfaceSpec = {
  file: 'CardDetailModal.vue',
  async open(): Promise<OpenedSurface> {
    setActivePinia(createPinia())
    installApi()
    const w = mount(CardDetailModal, {
      props: { card: CARD, localBranches: [] },
      attachTo: document.body,
      global: { plugins: [i18n] }
    })
    const card = (): HTMLElement | null => q('[role="dialog"]')
    return {
      card,
      scrim: () => card()?.parentElement ?? null,
      isClosed: () => (w.emitted('close')?.length ?? 0) > 0,
      closeSignal: () => emittedSignal(w),
      teardown: () => {
        w.unmount()
      },
      named: {
        close: () => q('[role="dialog"] button[aria-label="Close"]'),
        first: firstFocusable
      },
      capEvidence: classAndStyle('[role="dialog"]')
    }
  }
}

// ---------------------------------------------------------------------------
// CommandPalette — owns its backdrop (`role=presentation`, `mousedown`), a
// window-capture Esc and a focus trap, but never migrates (spec D6). It has no
// Teleport of its own (App.vue teleports it); mounted attached to <body> here.
// Open state = `ui.palette.open`; closing = `ui.closePalette()`.
// ---------------------------------------------------------------------------
const commandPalette: SurfaceSpec = {
  file: 'CommandPalette.vue',
  async open(): Promise<OpenedSurface> {
    setActivePinia(createPinia())
    installApi()
    const ui = useUiStore()
    const w = mount(CommandPalette, { attachTo: document.body, global: { plugins: [i18n] } })
    ui.openPalette()
    const card = (): HTMLElement | null => q('[role="dialog"]')
    return {
      card,
      scrim: () => q('[role="presentation"]'),
      isClosed: () => !ui.palette.open,
      closeSignal: () => `ui.palette.open=${String(ui.palette.open)}`,
      teardown: () => {
        w.unmount()
      },
      named: {
        input: () => q('[role="dialog"] input[type="text"]')
      },
      capEvidence: classAndStyle('[role="dialog"]')
    }
  }
}

// ---------------------------------------------------------------------------
// ImageLightbox — full-viewport; the `role=dialog` IS the scrim (`click.self`),
// Esc is VueUse `onKeyStroke` (window, bubbling — not capture), no trap.
// ---------------------------------------------------------------------------
const IMAGES: SessionImage[] = ['shot-1.png', 'shot-2.png'].map((name, i) => ({
  name,
  path: `/img/${name}`,
  bytes: 10 * (i + 1),
  mtimeMs: i + 1,
  dataUrl: `data:image/png;base64,${name}`
}))

const imageLightbox: SurfaceSpec = {
  file: 'ImageLightbox.vue',
  async open(): Promise<OpenedSurface> {
    setActivePinia(createPinia())
    installApi({ imageCacheCopy: vi.fn(async () => ({ ok: true })) })
    const w = mount(ImageLightbox, {
      props: {
        entries: IMAGES,
        index: 0,
        uuid: '11111111-2222-4333-8444-555555555555',
        folderAlias: 'www',
        canReattach: true
      },
      attachTo: document.body,
      global: { plugins: [i18n] }
    })
    const card = (): HTMLElement | null => q('[role="dialog"]')
    return {
      card,
      // The root element is both the dialog and the scrim.
      scrim: card,
      isClosed: () => (w.emitted('close')?.length ?? 0) > 0,
      closeSignal: () => emittedSignal(w),
      teardown: () => {
        w.unmount()
      },
      named: {
        close: () => q('[role="dialog"] button[aria-label="Close"]'),
        first: firstFocusable
      },
      // Full-viewport (`fixed inset-0`): no card box, therefore no height cap by construction.
      capEvidence: classAndStyle('[role="dialog"]')
    }
  }
}

// ---------------------------------------------------------------------------
// McpConfirmOverlay — fail-closed gate. Mounted empty; a `mode:'modal'` confirm
// is pushed through the REAL `window.api.onMcpConfirmPending` subscription the
// component installs in `onMounted`. There is no Esc and no scrim handler, so
// the only way the surface closes is a verdict or the non-verdict "Dismiss":
// `isClosed()` is therefore "the row left the overlay's local queue", and the
// probes (Esc / scrim) must leave it open for the table to read 'ignored'.
// ---------------------------------------------------------------------------
const CONFIRM: McpConfirmPending = {
  id: 'confirm-1',
  mode: 'modal',
  prompt: 'Create a session in org/proj/www',
  commands: [],
  permissionMode: 'default',
  nonDefaultFlags: [],
  deadline: Date.now() + 60 * 60_000
} as unknown as McpConfirmPending

const mcpConfirm: SurfaceSpec = {
  file: 'McpConfirmOverlay.vue',
  async open(): Promise<OpenedSurface> {
    setActivePinia(createPinia())
    let push: ((p: McpConfirmPending) => void) | null = null
    const dismiss = vi.fn(async () => undefined)
    const respond = vi.fn(async () => undefined)
    installApi({
      onMcpConfirmPending: (cb: (p: McpConfirmPending) => void) => {
        push = cb
        return () => {
          push = null
        }
      },
      mcpConfirmDismiss: dismiss,
      mcpConfirmRespond: respond
    })
    const w = mount(McpConfirmOverlay, { attachTo: document.body, global: { plugins: [i18n] } })
    // A fresh deadline per open: the 500ms ticker prunes rows past it.
    push!({ ...CONFIRM, deadline: Date.now() + 60 * 60_000 })
    await w.vm.$nextTick()
    const card = (): HTMLElement | null => q('[role="dialog"]')
    return {
      card,
      // No handler is bound to it (the point of the gate) — it is still the backdrop element.
      scrim: () => q('[role="presentation"]'),
      isClosed: () => card() === null,
      closeSignal: () =>
        `dismiss×${dismiss.mock.calls.length};respond×${respond.mock.calls.length}`,
      teardown: () => {
        w.unmount()
      },
      named: {
        // Buttons in DOM order: Dismiss, Allow, Deny.
        dismiss: () => document.body.querySelectorAll<HTMLElement>('[role="dialog"] button')[0],
        allow: () => document.body.querySelectorAll<HTMLElement>('[role="dialog"] button')[1],
        deny: () => document.body.querySelectorAll<HTMLElement>('[role="dialog"] button')[2]
      },
      capEvidence: classAndStyle('[role="dialog"]')
    }
  }
}

export const SURFACES_C: SurfaceSpec[] = [
  cardCreate,
  cardDetail,
  commandPalette,
  imageLightbox,
  mcpConfirm
]
