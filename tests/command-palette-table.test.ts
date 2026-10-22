// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import CommandPalette from '../src/renderer/src/components/CommandPalette.vue'
import ActivityBell from '../src/renderer/src/components/ActivityBell.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useKeybindingsStore } from '../src/renderer/src/stores/keybindings'
import {
  useShortcuts,
  resetScopesForTests,
  pushScope,
  popScope,
  type ShortcutBinding
} from '../src/renderer/src/composables/useShortcuts'
import { DESCRIPTOR_BY_ID, KEYBINDINGS, type ShortcutActionId } from '../src/main/keybindings-core'

/**
 * T486 U6 — the command palette's Actions section is generated from the
 * keybindings table (`docs/specs/T486-keybindings-coverage-pass.md` §9.1).
 *
 *  - AC-38: every eligible action is listed when its label is typed, bound or
 *    unbound, even when its `keysGuard` would block a key press from the
 *    palette's own input; Enter runs the registered handler.
 *  - AC-39: each row shows its resolved chord, live after a rebind.
 *  - AC-40: an empty query lists only the featured actions; Recents, Folders
 *    and Sessions behave as before.
 *  - AC-41: an action whose `enabled()` is false is not listed.
 *  - Forward risk (U4a): a popover action chosen by mouse click opens and stays
 *    open — the click must not reach the popover's own click-outside.
 */

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

const none = (): (() => void) => () => {}
function stubApi(): void {
  ;(window as unknown as { api: unknown }).api = new Proxy(
    { keybindingsSave: vi.fn(async () => undefined) } as Record<string, unknown>,
    {
      get: (target, key: string) => {
        if (key in target) return target[key]
        return key.startsWith('on') ? none : vi.fn(async () => null)
      }
    }
  )
}

const label = (id: ShortcutActionId): string => i18n.global.t(DESCRIPTOR_BY_ID[id].labelKey)

/** Ids the palette may list: `palette !== false`. */
const ELIGIBLE = KEYBINDINGS.filter((d) => d.palette !== false).map((d) => d.id)
const FEATURED = KEYBINDINGS.filter((d) => d.paletteFeatured).map((d) => d.id)

let wrapper: VueWrapper | null = null
const handlers = new Map<string, ReturnType<typeof vi.fn>>()
const enabledFlags = new Map<string, ReturnType<typeof ref<boolean>>>()

/**
 * Mount the palette next to a host that registers one `'global'` binding per id.
 * Every binding carries a `keysGuard` that would block a key press (the palette
 * input is a text field), so a listed + runnable row proves the guard is not
 * consulted for the palette.
 */
/**
 * The one host component every test mounts: it registers `bindings()` in its
 * setup (so they unregister on unmount) and renders the palette, plus the
 * Activity bell when `withBell` is set.
 */
function mountHost(bindings: () => ShortcutBinding[], withBell = false): VueWrapper {
  const keybindings = useKeybindingsStore()
  const Host = defineComponent({
    setup() {
      useShortcuts(bindings(), () => keybindings.resolved)
      return () => (withBell ? h('div', [h(ActivityBell), h(CommandPalette)]) : h(CommandPalette))
    }
  })
  wrapper = mount(Host, { attachTo: document.body, global: { plugins: [i18n] } })
  return wrapper
}

function mountPalette(ids: readonly ShortcutActionId[] = ELIGIBLE): VueWrapper {
  handlers.clear()
  enabledFlags.clear()
  return mountHost(() =>
    ids.map((id) => {
      const handler = vi.fn()
      const flag = ref(true)
      handlers.set(id, handler)
      enabledFlags.set(id, flag)
      return {
        id,
        scope: 'global',
        enabled: () => flag.value === true,
        keysGuard: () => false,
        handler
      }
    })
  )
}

async function openPalette(): Promise<void> {
  const ui = useUiStore()
  ui.openPalette()
  // The palette pushes no scope itself (App's watcher does); mirror App.
  pushScope('modal')
  await flushPromises()
}

async function type(q: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>('input[type="text"]')
  if (!input) throw new Error('palette input not rendered')
  input.value = q
  input.dispatchEvent(new Event('input'))
  await flushPromises()
}

function actionRows(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[data-palette-item^="action:"]')]
}
const rowIds = (): string[] => actionRows().map((r) => r.dataset.paletteItem!.slice(7))
const row = (id: string): HTMLElement | null =>
  document.body.querySelector<HTMLElement>(`[data-palette-item="action:${id}"]`)
const accel = (id: string): string =>
  row(id)?.querySelector('[data-palette-accelerator]')?.textContent?.trim() ?? ''

async function pressEnter(): Promise<void> {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await flushPromises()
}

beforeEach(() => {
  i18n.global.locale.value = 'en'
  localStorage.clear()
  setActivePinia(createPinia())
  stubApi()
  resetScopesForTests()
})

afterEach(() => {
  popScope('modal')
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('AC-38 — actions come from the table', () => {
  it('lists every eligible action when its label is typed, bound or unbound', async () => {
    mountPalette()
    await openPalette()
    const missing: string[] = []
    for (const id of ELIGIBLE) {
      await type(label(id))
      if (!rowIds().includes(id)) missing.push(id)
    }
    expect(missing).toEqual([])
  })

  it('Enter on a typed label runs that action’s registered handler', async () => {
    mountPalette()
    const wrong: string[] = []
    for (const id of ELIGIBLE) {
      await openPalette()
      await type(label(id))
      expect(rowIds()[0], `first row for "${label(id)}"`).toBe(id)
      await pressEnter()
      if (handlers.get(id)!.mock.calls.length !== 1) wrong.push(id)
    }
    expect(wrong).toEqual([])
  })

  for (const id of [
    'session.openToSide',
    'folder.rename',
    'view.closeTakeover',
    'sidebar.rescan',
    'sidebar.jump',
    'session.fork'
  ] as const) {
    it(`${id}: listed and runnable although its keysGuard blocks the palette input`, async () => {
      mountPalette()
      await openPalette()
      await type(label(id))
      expect(rowIds()).toContain(id)
      await pressEnter()
      expect(handlers.get(id)).toHaveBeenCalledTimes(1)
      expect(useUiStore().palette.open).toBe(false)
    })
  }

  it('never lists a palette: false action, even when registered', async () => {
    const hidden = KEYBINDINGS.filter((d) => d.palette === false).map((d) => d.id)
    mountPalette(KEYBINDINGS.map((d) => d.id))
    await openPalette()
    for (const id of hidden) {
      await type(label(id))
      expect(rowIds(), id).not.toContain(id)
    }
  })

  it('never lists an action with no renderer registration', async () => {
    mountPalette(['session.new'])
    await openPalette()
    await type(label('folder.rename'))
    expect(rowIds()).not.toContain('folder.rename')
  })
})

describe('AC-41 — enabled() gates the listing', () => {
  it('hides an action while enabled() is false and lists it again when true', async () => {
    mountPalette()
    enabledFlags.get('session.restart')!.value = false
    await openPalette()
    await type(label('session.restart'))
    expect(rowIds()).not.toContain('session.restart')
    enabledFlags.get('session.restart')!.value = true
    await nextTick()
    expect(rowIds()).toContain('session.restart')
  })

  it('a disabled featured action is absent from the empty palette', async () => {
    mountPalette()
    enabledFlags.get('session.resumeLast')!.value = false
    await openPalette()
    expect(rowIds()).not.toContain('session.resumeLast')
  })
})

describe('AC-39 — each row shows its resolved chord', () => {
  it('renders the platform chord, and nothing for an unbound action', async () => {
    mountPalette()
    await openPalette()
    expect(accel('session.new')).toBe('Ctrl+N')
    await type(label('session.fork'))
    expect(row('session.fork')).not.toBeNull()
    expect(accel('session.fork')).toBe('')
  })

  it('updates live after a rebind', async () => {
    mountPalette()
    await openPalette()
    await useKeybindingsStore().setBinding('session.new', 'Cmd+Shift+Y')
    await flushPromises()
    expect(accel('session.new')).toBe('Ctrl+Shift+Y')
    await useKeybindingsStore().setBinding('session.new', null)
    await flushPromises()
    expect(accel('session.new')).toBe('')
  })
})

describe('AC-40 — the empty palette', () => {
  function seed(): void {
    const sessions = useSessionsStore()
    const mk = (id: string, modified: string, summary: string) => ({
      sessionId: id,
      projectPath: '/repo/alpha',
      summary,
      firstPrompt: '',
      modified,
      resumable: true
    })
    sessions.folders.push({
      path: '/repo/alpha',
      alias: 'alpha',
      expanded: true,
      sessions: [
        mk('s1', '2026-10-01T00:00:00Z', 'one'),
        mk('s2', '2026-10-02T00:00:00Z', 'two'),
        mk('s3', '2026-10-03T00:00:00Z', 'three'),
        mk('s4', '2026-10-04T00:00:00Z', 'four')
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  }

  it('lists only the featured actions, in table order', async () => {
    mountPalette()
    await openPalette()
    expect(rowIds()).toEqual(FEATURED)
  })

  it('keeps Recents (top 3), Folders and Sessions as before', async () => {
    seed()
    mountPalette()
    await openPalette()
    const ids = [...document.body.querySelectorAll<HTMLElement>('[data-palette-item]')].map(
      (r) => r.dataset.paletteItem
    )
    expect(ids.filter((i) => i!.startsWith('recent:'))).toEqual([
      'recent:s4',
      'recent:s3',
      'recent:s2'
    ])
    expect(ids).toContain('folder:/repo/alpha')
    expect(ids.filter((i) => i!.startsWith('session:'))).toHaveLength(4)
    await type('four')
    const typed = [...document.body.querySelectorAll<HTMLElement>('[data-palette-item]')].map(
      (r) => r.dataset.paletteItem
    )
    expect(typed.some((i) => i!.startsWith('recent:'))).toBe(false)
    expect(typed).toContain('session:s4')
  })
})

describe('Forward risk — a popover action chosen by mouse click stays open', () => {
  /** Press and click like a mouse: pointerdown → mousedown → mouseup → click. */
  async function realClick(el: HTMLElement): Promise<void> {
    const opts = { bubbles: true, cancelable: true, composed: true, detail: 1, button: 0 }
    el.dispatchEvent(new PointerEvent('pointerdown', opts))
    el.dispatchEvent(new MouseEvent('mousedown', opts))
    el.dispatchEvent(new MouseEvent('mouseup', opts))
    el.dispatchEvent(new MouseEvent('click', opts))
    await flushPromises()
    // vueuse's click-outside resets its re-entry guard on a 0 ms timer.
    await new Promise((r) => setTimeout(r, 5))
    await flushPromises()
  }

  /** The Activity bell's toggle, enabled once the bell has registered its anchor. */
  function activityBinding(): ShortcutBinding {
    const ui = useUiStore()
    return {
      id: 'view.activity',
      scope: 'global',
      enabled: () => ui.popoverAnchors.activity,
      handler: () => ui.togglePopover('activity')
    }
  }

  it('view.activity: the bell popover opens and is still open after the click', async () => {
    const ui = useUiStore()
    mountHost(() => [activityBinding()], true)
    await flushPromises()
    await openPalette()
    await type(label('view.activity'))
    const el = row('view.activity')
    expect(el).not.toBeNull()
    await realClick(el!)
    expect(ui.palette.open).toBe(false)
    expect(ui.popovers.activity).toBe(true)
    expect(document.body.querySelector('[data-dsqa="activity-popover"]')).not.toBeNull()
  })

  it('Enter on the same row opens it too', async () => {
    const ui = useUiStore()
    mountHost(() => [activityBinding()], true)
    await flushPromises()
    await openPalette()
    await type(label('view.activity'))
    await pressEnter()
    expect(ui.popovers.activity).toBe(true)
  })
})
