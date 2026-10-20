// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setActivePinia, createPinia } from 'pinia'
import { useUiStore, POPOVER_IDS, type ViewId } from '../src/renderer/src/stores/ui'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { pushScope, resetScopesForTests } from '../src/renderer/src/composables/useShortcuts'
import { DESCRIPTOR_BY_ID } from '../src/main/keybindings-core'
import { mountCloseTakeover, pressEsc } from './helpers/close-takeover-harness'

/**
 * T486 §6.1 — `view.closeTakeover`: Esc closes the open takeover through the
 * X's own door, one layer at a time.
 *
 * Everything here goes through the real `useShortcuts` + `useMagicKeys` window
 * listener (`helpers/close-takeover-harness.ts`), with a real key event on the
 * focused element. jsdom does NOT run Chromium's microtask checkpoint between
 * listeners, so the popover cases test the gate (the popover flag is still true
 * when the binding runs, which is what Chromium guarantees); the live pass
 * proves the ordering (AC-17, AC-20).
 */

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8')

let harness: { unmount: () => void } | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  resetScopesForTests()
  ;(window as unknown as { api: unknown }).api = new Proxy(
    { helpersGet: async () => null, helpersSet: async () => {} } as Record<string, unknown>,
    { get: (t, p: string) => (p in t ? t[p] : () => () => {}) }
  )
  harness = mountCloseTakeover()
})

afterEach(() => {
  harness?.unmount()
  harness = null
  document.body.innerHTML = ''
  resetScopesForTests()
})

/** Opens `id` through its public opener. */
function open(ui: ReturnType<typeof useUiStore>, id: ViewId): void {
  const openers: Record<ViewId, () => void> = {
    roadmap: () => ui.openRoadmap('/repos/alpha', 'alpha'),
    prStack: () => ui.openPrStack('/repos/alpha', 'alpha'),
    cleanup: () => ui.openCleanup(),
    usageDashboard: () => ui.openUsageDashboard(),
    systemMonitor: () => ui.openSystemMonitor(),
    scheduler: () => ui.openScheduler(),
    containers: () => ui.openContainers(),
    review: () => ui.openReview('/repos/alpha', null)
  }
  openers[id]()
}

const VIEWS: ViewId[] = [
  'roadmap',
  'prStack',
  'cleanup',
  'usageDashboard',
  'systemMonitor',
  'scheduler',
  'containers',
  'review'
]

describe('the view.closeTakeover row', () => {
  it('ships Esc, not menu-backed, in the Takeovers group', () => {
    const d = DESCRIPTOR_BY_ID['view.closeTakeover']
    expect(d.defaultKeys).toBe('Escape')
    // An Esc accelerator in the native menu would take Esc from every terminal.
    expect(d.menu).toBe(false)
    expect(d.group).toBe('takeovers')
  })

  it('App.vue registers it with the shared binding parts and installs the key-origin recorder', () => {
    const app = read('src/renderer/src/App.vue')
    const start = app.indexOf("id: 'view.closeTakeover'")
    expect(start).toBeGreaterThan(-1)
    const reg = app.slice(start, app.indexOf("id: '", start + 5))
    expect(reg).toContain("keys: kb('view.closeTakeover')")
    expect(reg).toContain('...closeTakeoverBinding(ui)')
    expect(app).toMatch(/installKeyOrigin\(\)/)
    // §6.1: `skipIfDefaultPrevented` cannot work for real key presses.
    expect(app).not.toContain('skipIfDefaultPrevented')
  })

  it('ui.closeAll() is gone — Esc reaches a takeover only through the binding', () => {
    expect(read('src/renderer/src/stores/ui.ts')).not.toMatch(/function closeAll\(\)/)
  })
})

describe('AC-16 — Esc closes the open takeover like the X', () => {
  for (const id of VIEWS) {
    it(id, async () => {
      const ui = useUiStore()
      open(ui, id)
      expect(ui.activeView?.id).toBe(id)
      await pressEsc(document.body)
      expect(ui.activeView).toBeNull()
    })
  }

  it('disposes the Review companion pane, as the X does', async () => {
    const ui = useUiStore()
    const helpers = useHelpersStore()
    ui.openReview('/repos/harnu', null)
    helpers.addReviewCompanionHelper('/repos/harnu', '/repos/harnu')
    expect(helpers.byWorktree.get('/repos/harnu')!.panes).toHaveLength(1)
    await pressEsc(document.body)
    expect(ui.review.open).toBe(false)
    expect(helpers.byWorktree.get('/repos/harnu')!.panes).toHaveLength(0)
  })

  it('does nothing with no takeover open', async () => {
    const ui = useUiStore()
    ui.openSettings('general')
    ui.closeDialog()
    await pressEsc(document.body)
    expect(ui.activeView).toBeNull()
  })

  it('the X runs the same door — TakeoverHost closes through closeAllTakeovers', () => {
    expect(read('src/renderer/src/components/TakeoverHost.vue')).toContain(
      '@close="ui.closeAllTakeovers()"'
    )
    expect(read('src/renderer/src/lib/takeover-esc.ts')).toContain(
      'handler: () => ui.closeAllTakeovers()'
    )
  })
})

describe('AC-17 — a surface open over the takeover takes Esc first', () => {
  for (const id of POPOVER_IDS) {
    it(`the ${id} popover: the binding steps aside while it is open`, async () => {
      const ui = useUiStore()
      open(ui, 'cleanup')
      ui.setPopoverAnchor(id, true)
      ui.openPopover(id)
      expect(ui.anyPopoverOpen).toBe(true)
      // The popover's own bubble listener (not mounted here) is what closes it;
      // in Chromium it runs after the binding, so the flag is still true now.
      await pressEsc(document.body)
      expect(ui.activeView?.id).toBe('cleanup')
      ui.closePopover(id)
      await pressEsc(document.body)
      expect(ui.activeView).toBeNull()
    })
  }

  it('the image lightbox: the binding steps aside while it is open', async () => {
    const ui = useUiStore()
    open(ui, 'scheduler')
    ui.openImageLightbox(0)
    await pressEsc(document.body)
    expect(ui.activeView?.id).toBe('scheduler')
    ui.closeImageLightbox()
    await pressEsc(document.body)
    expect(ui.activeView).toBeNull()
  })

  it("a dialog, palette or menu (the 'modal' scope) keeps the takeover", async () => {
    const ui = useUiStore()
    open(ui, 'systemMonitor')
    pushScope('modal')
    await pressEsc(document.body)
    expect(ui.activeView?.id).toBe('systemMonitor')
  })

  it('a capture listener that consumes Esc (the dialog pattern) keeps the takeover', async () => {
    const ui = useUiStore()
    open(ui, 'usageDashboard')
    const consume = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') e.stopPropagation()
    }
    window.addEventListener('keydown', consume, true)
    await pressEsc(document.body)
    window.removeEventListener('keydown', consume, true)
    expect(ui.activeView?.id).toBe('usageDashboard')
  })
})

describe('AC-19 — Esc in a text field inside a takeover never closes it', () => {
  function field(tag: 'input' | 'textarea'): HTMLElement {
    const el = document.createElement(tag)
    document.body.appendChild(el)
    el.focus()
    return el
  }

  for (const tag of ['input', 'textarea'] as const) {
    it(`an ${tag}`, async () => {
      const ui = useUiStore()
      open(ui, 'scheduler')
      await pressEsc(field(tag))
      expect(ui.activeView?.id).toBe('scheduler')
    })
  }

  it('a field that blurs itself on Esc (the Topbar title rename) still keeps it', async () => {
    const ui = useUiStore()
    open(ui, 'roadmap')
    const el = field('input')
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') el.blur()
    })
    await pressEsc(el)
    expect(document.activeElement).toBe(document.body)
    expect(ui.activeView?.id).toBe('roadmap')
    // The next Esc, pressed outside any field, closes it.
    await pressEsc(document.body)
    expect(ui.activeView).toBeNull()
  })
  // A focused control that types nothing (Cleanup's Needs-review checkbox keeps
  // focus after a click) is not a text field: Esc still closes the takeover.
  for (const type of ['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']) {
    it(`an <input type="${type}"> does not hold the takeover`, async () => {
      const ui = useUiStore()
      open(ui, 'cleanup')
      const el = document.createElement('input')
      el.type = type
      document.body.appendChild(el)
      el.focus()
      await pressEsc(el)
      expect(ui.activeView).toBeNull()
    })
  }

  for (const type of ['text', 'search', 'number', 'email', 'password', 'url', 'date']) {
    it(`an <input type="${type}"> keeps it`, async () => {
      const ui = useUiStore()
      open(ui, 'cleanup')
      const el = document.createElement('input')
      el.type = type
      document.body.appendChild(el)
      el.focus()
      await pressEsc(el)
      expect(ui.activeView?.id).toBe('cleanup')
    })
  }
})
