// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-empty-function -- ResizeObserver stub is intentionally a no-op */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import { beforeAll, afterAll } from 'vitest'

/**
 * T790 — the tuck seen through the App shell: dragging the divider past the floor, the edge strip,
 * the chord, and what the layout does while the session is tucked. jsdom has no layout engine, so
 * the pixel behaviour is proven by captures in the real app; here the interaction contract and the
 * DOM hooks it is built from are asserted.
 */

interface CapturedBinding {
  id: string
  handler: () => void
  enabled?: () => boolean
}
vi.mock('../src/renderer/src/composables/useShortcuts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/renderer/src/composables/useShortcuts')>()
  return {
    ...actual,
    useShortcuts: (bindings: CapturedBinding[], ...rest: unknown[]) => {
      ;(globalThis as unknown as { __bindings: CapturedBinding[] }).__bindings = bindings
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.useShortcuts as any)(bindings, ...rest)
    }
  }
})
const binding = (id: string): CapturedBinding => {
  const found = (globalThis as unknown as { __bindings: CapturedBinding[] }).__bindings.find(
    (b) => b.id === id
  )
  expect(found, `${id} is registered`).toBeDefined()
  return found as CapturedBinding
}

import { i18n } from '@renderer/i18n'
import App from '../src/renderer/src/App.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useSettingsStore } from '../src/renderer/src/stores/settings'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { SPLIT_RATIO_MIN } from '../src/renderer/src/lib/split-orientation'

// jsdom's CSS parser drops a unitless-zero flex basis (`1 1 0`), which is what the helper column carries
// while the session is tucked; remember the raw string Vue assigns so the test can read it back.
const rawFlex = new WeakMap<object, string>()
let flexDescriptor: PropertyDescriptor | undefined
beforeAll(() => {
  const proto = Object.getPrototypeOf(document.createElement('div').style) as object
  flexDescriptor = Object.getOwnPropertyDescriptor(proto, 'flex')
  if (!flexDescriptor?.get || !flexDescriptor.set) return
  const { get, set } = flexDescriptor
  Object.defineProperty(proto, 'flex', {
    configurable: true,
    get() {
      return rawFlex.get(this) ?? get.call(this)
    },
    set(v: string) {
      rawFlex.set(this, String(v))
      set.call(this, v)
    }
  })
})
afterAll(() => {
  const proto = Object.getPrototypeOf(document.createElement('div').style) as object
  if (flexDescriptor) Object.defineProperty(proto, 'flex', flexDescriptor)
})

const none = (): (() => void) => () => {}
function stubApi(): void {
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      settingsDefaultPath: vi.fn(async () => '/default/settings.json'),
      settingsLoad: vi.fn(async (path: string) => ({
        path,
        data: { terminalFontSize: 13, uiZoom: 1 }
      })),
      settingsSave: vi.fn(async () => undefined),
      uiZoomApply: vi.fn(),
      claudeChangelogGet: vi.fn(async () => ({
        releases: [],
        lastReadVersion: '',
        lastFetchedAt: 0
      })),
      helpersGet: vi.fn(async () => null),
      helpersSet: vi.fn(async () => undefined)
    } as Record<string, unknown>,
    {
      get: (target, key: string) => {
        if (key in target) return target[key]
        return key.startsWith('on') ? none : vi.fn(async () => null)
      }
    }
  )
}

const FOLDER = '/repo/alpha'
const OTHER = '/repo/beta'
let wrapper: VueWrapper | null = null

function seedFolder(path: string, sessionId: string, taskState?: string): void {
  useSessionsStore().folders.push({
    path,
    alias: path.split('/').pop(),
    expanded: true,
    sessions: [
      {
        sessionId,
        projectPath: path,
        summary: 'Walk the CMS editor',
        firstPrompt: '',
        modified: new Date().toISOString(),
        resumable: true,
        taskState
      }
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

const APP_STUBS = Object.fromEntries(
  [
    'Sidebar',
    'Topbar',
    'StatusFooter',
    'EmptyState',
    'FolderView',
    'CloudSessionPanel',
    'Onboarding',
    'TakeoverHost',
    'InboxRail',
    'HelperStack',
    'TerminalPane',
    'SessionPreview',
    'FolderPreview',
    'SessionMenu',
    'FolderMenu',
    'SidebarHiddenPopover',
    'AddFolderDialog',
    'SettingsDialog',
    'ClaudeBootDialog',
    'NewSessionDialog',
    'RemoveWorktreeDialog',
    'NewWorktreeDialog',
    'NewFolderDialog',
    'OpenSubfolderDialog',
    'RenameFolderDialog',
    'RenameRepoDialog',
    'MemoryLocationDialog',
    'CommandPalette',
    'McpConfirmOverlay',
    'ToastStack'
  ].map((n) => [n, true])
)

async function mountApp(taskState?: string): Promise<VueWrapper> {
  seedFolder(FOLDER, 's1', taskState)
  useSessionsStore().select('s1')
  const helpers = useHelpersStore()
  helpers.addShellHelper(FOLDER, FOLDER)
  helpers.addShellHelper(FOLDER, FOLDER)
  wrapper = mount(App, { attachTo: document.body, global: { plugins: [i18n], stubs: APP_STUBS } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  i18n.global.locale.value = 'en'
  localStorage.clear()
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  setActivePinia(createPinia())
  stubApi()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

// The main divider is the separator right after the session island.
const divider = (w: VueWrapper) => w.get('[data-island="session"] + [role="separator"]')
const mouse = (type: string, x: number, y = 0): void => {
  document.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }))
}
// jsdom has no layout: the drag falls back to window.innerWidth - 250 (side by side) or
// window.innerHeight - 100 (stacked) as the row's size.
const SIDE_TOTAL = (): number => window.innerWidth - 250
const STACK_TOTAL = (): number => window.innerHeight - 100
const FLOOR_GAP = (total: number): number => (0.65 - SPLIT_RATIO_MIN) * total

describe('dragging the divider past the floor', () => {
  it('springs back to 0.4 when released short of the threshold (side by side)', async () => {
    const w = await mountApp()
    const helpers = useHelpersStore()
    await divider(w).trigger('mousedown', { clientX: 1000 })
    mouse('mousemove', 1000 - FLOOR_GAP(SIDE_TOTAL()) - 79)
    await nextTick()
    expect(w.find('[data-test="session-tuck-armed"]').exists()).toBe(false)
    mouse('mouseup', 0)
    await flushPromises()
    expect(helpers.sessionTucked(FOLDER)).toBe(false)
    expect(helpers.splitRatioFor(FOLDER, 'side-by-side')).toBe(SPLIT_RATIO_MIN)
  })

  it('arms past the threshold (accent divider, dimmed session, floor marker) and tucks on release', async () => {
    const w = await mountApp()
    const helpers = useHelpersStore()
    await divider(w).trigger('mousedown', { clientX: 1000 })
    mouse('mousemove', 1000 - FLOOR_GAP(SIDE_TOTAL()) - 80)
    await nextTick()
    expect(w.find('[data-test="session-tuck-armed"]').text()).toContain('Release to tuck')
    expect(w.find('[data-test="session-tuck-floor"]').exists()).toBe(true)
    expect(divider(w).attributes('data-armed')).toBeDefined()
    expect(helpers.sessionTucked(FOLDER)).toBe(false)
    mouse('mouseup', 0)
    await flushPromises()
    expect(helpers.sessionTucked(FOLDER)).toBe(true)
    expect(w.find('[data-test="session-tuck-armed"]').exists()).toBe(false)
    expect(w.find('[data-test="session-tuck-strip"]').exists()).toBe(true)
  })

  it('pulling back under the threshold disarms before the release', async () => {
    const w = await mountApp()
    const helpers = useHelpersStore()
    await divider(w).trigger('mousedown', { clientX: 1000 })
    mouse('mousemove', 1000 - FLOOR_GAP(SIDE_TOTAL()) - 120)
    await nextTick()
    mouse('mousemove', 1000 - FLOOR_GAP(SIDE_TOTAL()) - 30)
    await nextTick()
    expect(w.find('[data-test="session-tuck-armed"]').exists()).toBe(false)
    mouse('mouseup', 0)
    await flushPromises()
    expect(helpers.sessionTucked(FOLDER)).toBe(false)
  })

  it('works on the Y axis when stacked', async () => {
    useSettingsStore().setSplitLayout('stacked')
    const w = await mountApp()
    const helpers = useHelpersStore()
    expect(
      w.get('[data-island="session"] + [role="separator"]').attributes('aria-orientation')
    ).toBe('horizontal')
    await divider(w).trigger('mousedown', { clientY: 700 })
    mouse('mousemove', 0, 700 - FLOOR_GAP(STACK_TOTAL()) - 79)
    await nextTick()
    mouse('mouseup', 0)
    await flushPromises()
    expect(helpers.sessionTucked(FOLDER)).toBe(false)
    expect(helpers.splitRatioFor(FOLDER, 'stacked')).toBe(SPLIT_RATIO_MIN)

    await divider(w).trigger('mousedown', { clientY: 700 })
    mouse('mousemove', 0, 700 - 0 - 80)
    await nextTick()
    expect(w.find('[data-test="session-tuck-armed"]').exists()).toBe(true)
    mouse('mouseup', 0)
    await flushPromises()
    expect(helpers.sessionTucked(FOLDER)).toBe(true)
    expect(w.get('[data-test="session-tuck-strip"]').attributes('data-orientation')).toBe(
      'horizontal'
    )
  })
})

describe('the terminal while the divider is pulled past the floor (delta 1)', () => {
  // The island is 650px wide at the stored ratio 0.65, so the area it shares with the stack is 1000px
  // and the floor (0.4) is 400px. jsdom has no layout: the island's box is what we say it is.
  const sizeIsland = (w: VueWrapper): void => {
    ;(w.get('[data-island="session"]').element as HTMLElement).getBoundingClientRect = () =>
      ({ width: 650, height: 480 }) as DOMRect
  }
  const hostStyle = (w: VueWrapper): CSSStyleDeclaration =>
    (w.get('[data-test="terminal-pane-host"]').element as HTMLElement).style

  it('pins the terminal host at the floor size as soon as the pull passes the floor, so the PTY never reflows', async () => {
    const w = await mountApp()
    sizeIsland(w)
    expect(hostStyle(w).width).toBe('')
    await divider(w).trigger('mousedown', { clientX: 1000 })
    mouse('mousemove', 1000 - FLOOR_GAP(SIDE_TOTAL()) - 30) // past the floor, short of the threshold
    await nextTick()
    expect(hostStyle(w).width).toBe('400px')
    expect(hostStyle(w).height).toBe('480px')
    mouse('mousemove', 1000 - FLOOR_GAP(SIDE_TOTAL()) - 90) // armed
    await nextTick()
    expect(w.find('[data-test="session-tuck-armed"]').exists()).toBe(true)
    expect(hostStyle(w).width).toBe('400px')
    mouse('mouseup', 0)
    await flushPromises()
    // Tucked: still the floor size, not the narrower drawn size and not the size before the pull.
    expect(useHelpersStore().sessionTucked(FOLDER)).toBe(true)
    expect(hostStyle(w).width).toBe('400px')
  })

  it('pins at the floor even when one move jumps from well above it to far past it', async () => {
    const w = await mountApp()
    sizeIsland(w)
    await divider(w).trigger('mousedown', { clientX: 1000 })
    mouse('mousemove', 1000 - 5000)
    await nextTick()
    expect(hostStyle(w).width).toBe('400px')
    mouse('mouseup', 0)
    await flushPromises()
    expect(hostStyle(w).width).toBe('400px')
  })

  it('does not pin while the divider stays inside the normal range', async () => {
    const w = await mountApp()
    sizeIsland(w)
    await divider(w).trigger('mousedown', { clientX: 1000 })
    mouse('mousemove', 1000 - 60)
    await nextTick()
    expect(hostStyle(w).width).toBe('')
    mouse('mouseup', 0)
  })

  it('lets go of the pin when the pull comes back inside the floor', async () => {
    const w = await mountApp()
    sizeIsland(w)
    await divider(w).trigger('mousedown', { clientX: 1000 })
    mouse('mousemove', 1000 - FLOOR_GAP(SIDE_TOTAL()) - 30)
    await nextTick()
    expect(hostStyle(w).width).toBe('400px')
    mouse('mousemove', 1000 - 60)
    await nextTick()
    expect(hostStyle(w).width).toBe('')
    mouse('mouseup', 0)
  })
})

describe('the armed divider (delta 1)', () => {
  const armIt = async (w: VueWrapper, stacked: boolean): Promise<void> => {
    if (stacked) {
      await divider(w).trigger('mousedown', { clientY: 700 })
      mouse('mousemove', 0, 700 - FLOOR_GAP(STACK_TOTAL()) - 90)
    } else {
      await divider(w).trigger('mousedown', { clientX: 1000 })
      mouse('mousemove', 1000 - FLOOR_GAP(SIDE_TOTAL()) - 90)
    }
    await nextTick()
  }

  it('side by side: the line sits 2px into the hit area, and the halo is layered above the pane and the scrim', async () => {
    const w = await mountApp()
    await armIt(w, false)
    const line = w.get('[data-test="session-tuck-line"]')
    expect(line.classes()).toEqual(expect.arrayContaining(['left-0.5', 'w-0.5', 'bg-accent']))
    expect(line.classes()).not.toContain('relative')
    const halo = w.get('[data-test="session-tuck-halo"]')
    expect(halo.classes()).toEqual(expect.arrayContaining(['bg-accent-soft', '-inset-x-1.5']))
    // The scrim is z-10 and the helper column is a later sibling: the divider outranks both.
    expect(divider(w).classes()).toContain('z-20')
    mouse('mouseup', 0)
  })

  it('stacked: the same on the Y axis', async () => {
    useSettingsStore().setSplitLayout('stacked')
    const w = await mountApp()
    await armIt(w, true)
    const line = w.get('[data-test="session-tuck-line"]')
    expect(line.classes()).toEqual(expect.arrayContaining(['top-0.5', 'h-0.5', 'bg-accent']))
    const halo = w.get('[data-test="session-tuck-halo"]')
    expect(halo.classes()).toEqual(expect.arrayContaining(['bg-accent-soft', '-inset-y-1.5']))
    expect(divider(w).classes()).toContain('z-20')
    mouse('mouseup', 0)
  })

  it('at rest the divider is the plain 1px line and sits below the neighbours', async () => {
    const w = await mountApp()
    expect(w.find('[data-test="session-tuck-halo"]').exists()).toBe(false)
    expect(divider(w).classes()).not.toContain('z-20')
  })
})

describe('dragging the strip out hands setSplitRatio a ratio already inside [0.4, 0.8] (delta 1)', () => {
  it('never asks the store for less than the floor or more than the ceiling', async () => {
    const w = await mountApp()
    const helpers = useHelpersStore()
    const row = w.get('[data-island="session"]').element.parentElement as HTMLElement
    row.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600 }) as DOMRect
    helpers.tuckSession(FOLDER)
    await flushPromises()
    const spy = vi.spyOn(helpers, 'setSplitRatio')
    await w.get('[data-test="session-tuck-strip"]').trigger('mousedown', { clientX: 7, button: 0 })
    for (const x of [600, 950, 100, -300, 1400]) mouse('mousemove', x)
    mouse('mouseup', 0)
    const asked = spy.mock.calls.map((c) => c[1])
    expect(asked.length).toBeGreaterThanOrEqual(5)
    for (const r of asked) {
      expect(r).toBeGreaterThanOrEqual(SPLIT_RATIO_MIN)
      expect(r).toBeLessThanOrEqual(0.8)
    }
    expect(asked).toContain(SPLIT_RATIO_MIN)
    expect(asked).toContain(0.8)
  })
})

describe('the tucked layout', () => {
  it('collapses the session area, gives the stack the whole row, keeps the terminal host its size', async () => {
    const w = await mountApp()
    const helpers = useHelpersStore()
    const island = w.get('[data-island="session"]').element as HTMLElement
    island.getBoundingClientRect = () => ({ width: 640, height: 480 }) as DOMRect
    helpers.tuckSession(FOLDER)
    await flushPromises()
    expect(w.get('[data-island="session"]').classes()).toContain('lm-collapse')
    expect(w.get('[data-island="session"]').attributes('inert')).toBeDefined()
    expect(divider(w).classes()).toContain('lm-collapse-w')
    const host = w.get('[data-test="terminal-pane-host"]').element as HTMLElement
    expect(host.style.width).toBe('640px')
    expect(host.style.height).toBe('480px')
    const helperCol = w.get('[data-island="session"]').element.parentElement!
      .lastElementChild as HTMLElement
    expect(helperCol.style.flex).toBe('1 1 0')
  })

  it('shows the session again, normal arrangement back, when restored', async () => {
    const w = await mountApp()
    const helpers = useHelpersStore()
    ;(w.get('[data-island="session"]').element as HTMLElement).getBoundingClientRect = () =>
      ({ width: 640, height: 480 }) as DOMRect
    helpers.tuckSession(FOLDER)
    await flushPromises()
    await w.get('[data-test="session-tuck-strip"]').trigger('click')
    await flushPromises()
    expect(helpers.sessionTucked(FOLDER)).toBe(false)
    expect(w.get('[data-island="session"]').classes()).not.toContain('lm-collapse')
    expect(w.find('[data-test="session-tuck-strip"]').exists()).toBe(false)
  })

  it('is per worktree: the other folder shows its session', async () => {
    const w = await mountApp()
    seedFolder(OTHER, 's2')
    useHelpersStore().addShellHelper(OTHER, OTHER)
    useHelpersStore().tuckSession(FOLDER)
    await flushPromises()
    expect(w.find('[data-test="session-tuck-strip"]').exists()).toBe(true)
    useSessionsStore().select('s2')
    await flushPromises()
    expect(w.find('[data-test="session-tuck-strip"]').exists()).toBe(false)
    expect(w.get('[data-island="session"]').classes()).not.toContain('lm-collapse')
  })

  it('shows the session when the last pane is closed', async () => {
    const w = await mountApp()
    const helpers = useHelpersStore()
    helpers.tuckSession(FOLDER)
    await flushPromises()
    for (const p of [...helpers.panesForCurrentWorktree]) helpers.removeHelper(FOLDER, p.id)
    await flushPromises()
    expect(helpers.sessionTucked(FOLDER)).toBe(false)
    expect(w.find('[data-test="session-tuck-strip"]').exists()).toBe(false)
  })
})

describe('the edge strip', () => {
  it('is a focusable button labelled with the session, and Enter / Space restore at 0.4', async () => {
    const w = await mountApp()
    const helpers = useHelpersStore()
    helpers.setSplitRatio(FOLDER, 0.7)
    helpers.tuckSession(FOLDER)
    await flushPromises()
    const strip = w.get('[data-test="session-tuck-strip"]')
    expect(strip.element.tagName).toBe('BUTTON')
    expect(strip.attributes('aria-label')).toBe('Show session Walk the CMS editor')
    // A <button> turns Enter and Space into a click; jsdom does the same for the click we fire.
    await strip.trigger('click')
    await flushPromises()
    expect(helpers.sessionTucked(FOLDER)).toBe(false)
    expect(helpers.splitRatioFor(FOLDER, 'side-by-side')).toBe(SPLIT_RATIO_MIN)
  })

  it('shows the hint chip on hover and on keyboard focus, with the chord', async () => {
    const w = await mountApp()
    useHelpersStore().tuckSession(FOLDER)
    await flushPromises()
    const strip = w.get('[data-test="session-tuck-strip"]')
    expect(w.find('[data-test="session-tuck-chip"]').exists()).toBe(false)
    await strip.trigger('mouseenter')
    const chip = w.get('[data-test="session-tuck-chip"]')
    expect(chip.text()).toContain('Walk the CMS editor')
    expect(chip.text()).toContain('Click or drag to bring it back')
    expect(chip.text()).toContain('Ctrl')
    expect(chip.text()).toContain('J')
    await strip.trigger('mouseleave')
    expect(w.find('[data-test="session-tuck-chip"]').exists()).toBe(false)
    await strip.trigger('focus')
    expect(w.find('[data-test="session-tuck-chip"]').exists()).toBe(true)
  })

  it('dragging it out restores and follows the pointer, clamped to [0.4, 0.8]', async () => {
    const w = await mountApp()
    const helpers = useHelpersStore()
    const row = w.get('[data-island="session"]').element.parentElement as HTMLElement
    row.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600 }) as DOMRect
    helpers.tuckSession(FOLDER)
    await flushPromises()
    await w.get('[data-test="session-tuck-strip"]').trigger('mousedown', { clientX: 7, button: 0 })
    mouse('mousemove', 9) // under the slop: nothing happens
    expect(helpers.sessionTucked(FOLDER)).toBe(true)
    mouse('mousemove', 600)
    await flushPromises()
    expect(helpers.sessionTucked(FOLDER)).toBe(false)
    expect(helpers.splitRatioFor(FOLDER, 'side-by-side')).toBeCloseTo(0.6, 10)
    mouse('mousemove', 950)
    expect(helpers.splitRatioFor(FOLDER, 'side-by-side')).toBe(0.8)
    mouse('mousemove', 100)
    expect(helpers.splitRatioFor(FOLDER, 'side-by-side')).toBe(SPLIT_RATIO_MIN)
    mouse('mouseup', 100)
    // The drag is over: further movement changes nothing.
    mouse('mousemove', 700)
    expect(helpers.splitRatioFor(FOLDER, 'side-by-side')).toBe(SPLIT_RATIO_MIN)
  })

  it('needs-you: amber strip, a blinking dot and the "Needs you" tag, and the session stays tucked', async () => {
    const w = await mountApp('needs-input')
    useHelpersStore().tuckSession(FOLDER)
    await flushPromises()
    const strip = w.get('[data-test="session-tuck-strip"]')
    expect(strip.attributes('data-state')).toBe('needs')
    expect(strip.classes()).toContain('bg-warning-soft')
    expect(w.get('[data-test="session-tuck-dot"]').classes()).toContain('anim-attention-dot')
    expect(w.get('[data-test="session-tuck-tag"]').text()).toBe('Needs you')
    // No auto-restore: it is still tucked after the state arrived.
    expect(useHelpersStore().sessionTucked(FOLDER)).toBe(true)
  })

  it('an idle session shows a plain dot and no tag', async () => {
    const w = await mountApp()
    useHelpersStore().tuckSession(FOLDER)
    await flushPromises()
    expect(w.get('[data-test="session-tuck-strip"]').attributes('data-state')).toBe('idle')
    expect(w.find('[data-test="session-tuck-tag"]').exists()).toBe(false)
    expect(w.get('[data-test="session-tuck-dot"]').classes()).not.toContain('anim-attention-dot')
  })
})

describe('the chord', () => {
  it('session.toggleTuck tucks, then brings the session back', async () => {
    await mountApp()
    const helpers = useHelpersStore()
    binding('session.toggleTuck').handler()
    expect(helpers.sessionTucked(FOLDER)).toBe(true)
    binding('session.toggleTuck').handler()
    expect(helpers.sessionTucked(FOLDER)).toBe(false)
  })

  it('while a pane is expanded it leaves the expanded view and does nothing else', async () => {
    await mountApp()
    const helpers = useHelpersStore()
    const id = helpers.panesForCurrentWorktree[0].id
    helpers.tuckSession(FOLDER)
    helpers.toggleExpandPane(FOLDER, id)
    binding('session.toggleTuck').handler()
    expect(helpers.expandedPaneIdForCurrentWorktree).toBeNull()
    expect(helpers.sessionTucked(FOLDER)).toBe(true)
  })

  it('a tuck survives an expand: the strip collapses with the session area and returns after', async () => {
    const w = await mountApp()
    const helpers = useHelpersStore()
    const id = helpers.panesForCurrentWorktree[0].id
    helpers.tuckSession(FOLDER)
    helpers.toggleExpandPane(FOLDER, id)
    await flushPromises()
    expect(w.get('[data-test="session-tuck-strip"]').classes()).toContain('lm-collapse-w')
    helpers.exitExpand(FOLDER)
    await flushPromises()
    expect(w.get('[data-test="session-tuck-strip"]').classes()).not.toContain('lm-collapse-w')
    expect(helpers.sessionTucked(FOLDER)).toBe(true)
  })
})
