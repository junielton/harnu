// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import * as os from 'node:os'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import App from '../src/renderer/src/App.vue'
import HelperStack from '../src/renderer/src/components/HelperStack.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useSettingsStore } from '../src/renderer/src/stores/settings'
import { useLayoutStore } from '../src/renderer/src/stores/layout'
import { useHelpersStore, HELPER_SPLIT_RATIO_DEFAULT } from '../src/renderer/src/stores/helpers'
import {
  resolveSplitOrientation,
  nextSplitLayout,
  sanitizeSplitLayout,
  SPLIT_AUTO_ENTER_RATIO,
  SPLIT_AUTO_EXIT_RATIO
} from '../src/renderer/src/lib/split-orientation'
import { KEYBINDINGS } from '../src/main/keybindings-core'

/**
 * T627 (floating layout S-5) — configurable split orientation.
 *
 *  - AC-11: the `splitLayout` setting (auto | side-by-side | stacked) persists.
 *  - AC-12: the pure `auto` resolver, with hysteresis.
 *  - AC-13 (structural half): the stacked divider is horizontal.
 *  - AC-14: the helper stack lays its panes out per orientation.
 *  - AC-15: one split ratio per orientation, per worktree.
 *  - AC-16: the keybinding row exists (the Topbar control is covered in design.md).
 */

// `src/main/settings.ts` imports `electron` at module top; stub it so its pure
// `sanitizePatch` is importable without an Electron runtime.
vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir() },
  dialog: {},
  shell: {},
  ipcMain: { handle: (): void => {} }
}))

// The pane components pull in xterm / webviews; HelperStack's job under test is
// the LAYOUT around them, so every pane type renders this probe instead.
vi.mock('../src/renderer/src/lib/pane-components', async () => {
  const { defineComponent, h } = await import('vue')
  const Probe = defineComponent({
    props: { pane: { type: Object, required: true }, worktreePath: String, resizable: Boolean },
    emits: ['header-mouse-down', 'open-file'],
    setup(props, { emit }) {
      return () =>
        h('div', { class: 'probe-pane', 'data-pane-id': (props.pane as { id: string }).id }, [
          h('div', {
            class: 'probe-header' + (props.resizable ? ' cursor-row-resize' : ''),
            'data-resizable': String(props.resizable),
            onMousedown: (ev: MouseEvent) => emit('header-mouse-down', ev)
          })
        ])
    }
  })
  return { paneComponents: new Proxy({}, { get: () => Probe }) }
})

import { sanitizePatch } from '../src/main/settings'

const none = (): (() => void) => () => {}

type SavedPatch = { splitLayout?: unknown }
let saved: SavedPatch[] = []

function stubApi(persisted: Record<string, unknown> = {}): void {
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      settingsDefaultPath: vi.fn(async () => '/default/settings.json'),
      settingsLoad: vi.fn(async (path: string) => ({
        path,
        data: { terminalFontSize: 13, uiZoom: 1, ...persisted }
      })),
      settingsSave: vi.fn(async (_path: string, data: SavedPatch) => {
        saved.push(data)
      }),
      uiZoomApply: vi.fn(),
      claudeChangelogGet: vi.fn(async () => ({
        releases: [],
        lastReadVersion: '',
        lastFetchedAt: 0
      })),
      helpersGet: vi.fn(async () => null)
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
let wrapper: VueWrapper | null = null

function seedSession(): void {
  const sessions = useSessionsStore()
  sessions.folders.push({
    path: FOLDER,
    alias: 'alpha',
    expanded: true,
    sessions: [
      {
        sessionId: 's1',
        projectPath: FOLDER,
        summary: '',
        firstPrompt: '',
        modified: new Date().toISOString(),
        resumable: true
      }
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  sessions.select('s1')
}

// jsdom's CSS parser drops a unitless-zero flex basis (`1 1 0`), which is exactly what the panes
// carry; remember the raw string Vue assigns so the tests can read back what the layout asked for.
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  i18n.global.locale.value = 'en'
  localStorage.clear()
  saved = []
  setActivePinia(createPinia())
  stubApi()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('setting persists', () => {
  it('defaults to auto, adopts a saved value and falls back to auto on junk', async () => {
    const settings = useSettingsStore()
    expect(settings.splitLayout).toBe('auto')
    await settings.init()
    expect(settings.splitLayout).toBe('auto')
    settings.dispose()

    setActivePinia(createPinia())
    stubApi({ splitLayout: 'stacked' })
    const second = useSettingsStore()
    await second.init()
    expect(second.splitLayout).toBe('stacked')
    second.dispose()

    setActivePinia(createPinia())
    stubApi({ splitLayout: 'diagonal' })
    const third = useSettingsStore()
    await third.init()
    expect(third.splitLayout).toBe('auto')
    third.dispose()
  })

  it('writes the choice to settings.json after the debounce, like the other settings', async () => {
    const settings = useSettingsStore()
    await settings.init()
    settings.setSplitLayout('side-by-side')
    expect(settings.splitLayout).toBe('side-by-side')
    await vi.advanceTimersByTimeAsync(400)
    expect(saved).toEqual([{ splitLayout: 'side-by-side' }])
    settings.dispose()
  })

  it('cycles auto → side-by-side → stacked → auto', async () => {
    expect(nextSplitLayout('auto')).toBe('side-by-side')
    expect(nextSplitLayout('side-by-side')).toBe('stacked')
    expect(nextSplitLayout('stacked')).toBe('auto')
    const settings = useSettingsStore()
    settings.cycleSplitLayout()
    expect(settings.splitLayout).toBe('side-by-side')
  })

  it('the main-process patch allowlist keeps a valid value and drops an invalid one', () => {
    expect(sanitizePatch({ splitLayout: 'stacked' })).toEqual({ splitLayout: 'stacked' })
    expect(sanitizePatch({ splitLayout: 'diagonal' })).toEqual({})
    expect(sanitizePatch({ splitLayout: 3 })).toEqual({})
    expect(sanitizeSplitLayout('stacked')).toBe('stacked')
    expect(sanitizeSplitLayout(undefined)).toBe('auto')
  })
})

describe('auto threshold with hysteresis', () => {
  const size = (width: number, height: number) => ({ width, height })

  it('an explicit setting ignores the measurement', () => {
    expect(resolveSplitOrientation('stacked', size(1600, 600), 'side-by-side')).toBe('stacked')
    expect(resolveSplitOrientation('side-by-side', size(600, 1600), 'stacked')).toBe('side-by-side')
  })

  it('auto goes stacked once the area is clearly taller than wide, side by side otherwise', () => {
    expect(resolveSplitOrientation('auto', size(1200, 700), 'side-by-side')).toBe('side-by-side')
    expect(resolveSplitOrientation('auto', size(700, 1200), 'side-by-side')).toBe('stacked')
    expect(resolveSplitOrientation('auto', size(700, 1200), 'stacked')).toBe('stacked')
    expect(resolveSplitOrientation('auto', size(1200, 700), 'stacked')).toBe('side-by-side')
  })

  it('holds the previous result inside the hysteresis band', () => {
    const enter = SPLIT_AUTO_ENTER_RATIO
    const exit = SPLIT_AUTO_EXIT_RATIO
    expect(exit).toBeLessThan(1)
    expect(enter).toBeGreaterThan(1)
    // A square area is inside the band: whichever layout it had, it keeps.
    expect(resolveSplitOrientation('auto', size(1000, 1000), 'side-by-side')).toBe('side-by-side')
    expect(resolveSplitOrientation('auto', size(1000, 1000), 'stacked')).toBe('stacked')
    // Just inside each edge of the band: still held.
    expect(resolveSplitOrientation('auto', size(1000, 1000 * enter - 1), 'side-by-side')).toBe(
      'side-by-side'
    )
    expect(resolveSplitOrientation('auto', size(1000, 1000 * exit + 1), 'stacked')).toBe('stacked')
    // Just past each edge: it switches.
    expect(resolveSplitOrientation('auto', size(1000, 1000 * enter + 1), 'side-by-side')).toBe(
      'stacked'
    )
    expect(resolveSplitOrientation('auto', size(1000, 1000 * exit - 1), 'stacked')).toBe(
      'side-by-side'
    )
  })

  it('a window dragged across the diagonal flips once each way, not on every pixel', () => {
    let current: 'side-by-side' | 'stacked' = 'side-by-side'
    let flips = 0
    for (let h = 800; h <= 1200; h += 10) {
      const next = resolveSplitOrientation('auto', size(1000, h), current)
      if (next !== current) flips++
      current = next
    }
    for (let h = 1200; h >= 800; h -= 10) {
      const next = resolveSplitOrientation('auto', size(1000, h), current)
      if (next !== current) flips++
      current = next
    }
    expect(flips).toBe(2)
  })

  it('degenerate sizes keep the previous result', () => {
    expect(resolveSplitOrientation('auto', size(0, 0), 'stacked')).toBe('stacked')
    expect(resolveSplitOrientation('auto', size(0, 500), 'side-by-side')).toBe('side-by-side')
  })

  it('the layout store resolves auto from the measured main area, with memory', () => {
    const layout = useLayoutStore()
    const settings = useSettingsStore()
    expect(layout.splitOrientation).toBe('side-by-side')
    layout.setMainAreaSize(700, 1200)
    expect(layout.splitOrientation).toBe('stacked')
    layout.setMainAreaSize(1000, 1000)
    expect(layout.splitOrientation).toBe('stacked')
    layout.setMainAreaSize(1200, 700)
    expect(layout.splitOrientation).toBe('side-by-side')
    settings.setSplitLayout('stacked')
    expect(layout.splitOrientation).toBe('stacked')
  })
})

describe('ratio per orientation', () => {
  it('keeps one ratio per orientation and never touches the other', () => {
    const helpers = useHelpersStore()
    helpers.addShellHelper(FOLDER, FOLDER)
    expect(helpers.splitRatioFor(FOLDER, 'side-by-side')).toBe(HELPER_SPLIT_RATIO_DEFAULT)
    expect(helpers.splitRatioFor(FOLDER, 'stacked')).toBe(HELPER_SPLIT_RATIO_DEFAULT)

    helpers.setSplitRatio(FOLDER, 0.5, 'stacked')
    expect(helpers.splitRatioFor(FOLDER, 'stacked')).toBe(0.5)
    expect(helpers.splitRatioFor(FOLDER, 'side-by-side')).toBe(HELPER_SPLIT_RATIO_DEFAULT)

    helpers.setSplitRatio(FOLDER, 0.75, 'side-by-side')
    expect(helpers.splitRatioFor(FOLDER, 'side-by-side')).toBe(0.75)
    expect(helpers.splitRatioFor(FOLDER, 'stacked')).toBe(0.5)

    // Omitting the orientation keeps the old side-by-side contract.
    helpers.setSplitRatio(FOLDER, 0.6)
    expect(helpers.splitRatioFor(FOLDER, 'side-by-side')).toBe(0.6)
    expect(helpers.splitRatioFor(FOLDER, 'stacked')).toBe(0.5)
  })

  it('clamps each orientation to [0.4, 0.8] and is keyed per worktree', () => {
    const helpers = useHelpersStore()
    helpers.setSplitRatio(FOLDER, 0.05, 'stacked')
    helpers.setSplitRatio(FOLDER, 0.99, 'side-by-side')
    expect(helpers.splitRatioFor(FOLDER, 'stacked')).toBe(0.4)
    expect(helpers.splitRatioFor(FOLDER, 'side-by-side')).toBe(0.8)
    expect(helpers.splitRatioFor('/repo/beta', 'stacked')).toBe(HELPER_SPLIT_RATIO_DEFAULT)
  })

  it('the stacked ratio survives a store rebuild (persisted per worktree)', async () => {
    const helpers = useHelpersStore()
    helpers.setSplitRatio(FOLDER, 0.55, 'stacked')
    await flushPromises()
    setActivePinia(createPinia())
    expect(useHelpersStore().splitRatioFor(FOLDER, 'stacked')).toBe(0.55)
  })

  describe('in the App shell', () => {
    const STUBS = Object.fromEntries(
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

    async function mountApp(): Promise<VueWrapper> {
      seedSession()
      useHelpersStore().addShellHelper(FOLDER, FOLDER)
      wrapper = mount(App, { attachTo: document.body, global: { plugins: [i18n], stubs: STUBS } })
      await flushPromises()
      return wrapper
    }

    const dividers = (w: VueWrapper, axis: 'vertical' | 'horizontal') =>
      w.findAll(`[role="separator"][aria-orientation="${axis}"]`)

    function dragAxis(el: Element, axis: 'x' | 'y', from: number, to: number): void {
      const at = (v: number) => (axis === 'x' ? { clientX: v } : { clientY: v })
      el.dispatchEvent(
        new MouseEvent('mousedown', { ...at(from), bubbles: true, cancelable: true })
      )
      document.dispatchEvent(new MouseEvent('mousemove', { ...at(to), bubbles: true }))
      document.dispatchEvent(new MouseEvent('mouseup', { ...at(to), bubbles: true }))
    }

    it('side by side keeps the vertical divider; stacked swaps it for a horizontal one', async () => {
      const w = await mountApp()
      const settings = useSettingsStore()
      expect(dividers(w, 'horizontal')).toHaveLength(0)
      expect(dividers(w, 'vertical')).toHaveLength(3)

      settings.setSplitLayout('stacked')
      await flushPromises()
      const horizontal = dividers(w, 'horizontal')
      expect(horizontal).toHaveLength(1)
      expect(horizontal[0].classes()).toEqual(
        expect.arrayContaining(['h-1.5', 'cursor-row-resize', 'shrink-0', 'group'])
      )
      expect(horizontal[0].get('div').classes()).toEqual(
        expect.arrayContaining(['h-px', 'w-full', 'bg-border-2', 'group-hover:bg-accent-line'])
      )
      // The sidebar and Fleet-rail dividers stay vertical.
      expect(dividers(w, 'vertical')).toHaveLength(2)
    })

    it('stacked: dragging on Y changes only the stacked ratio; double-click resets it', async () => {
      const w = await mountApp()
      const helpers = useHelpersStore()
      useSettingsStore().setSplitLayout('stacked')
      await flushPromises()
      const divider = dividers(w, 'horizontal')[0]
      const sideBefore = helpers.splitRatioFor(FOLDER, 'side-by-side')

      dragAxis(divider.element, 'y', 500, 400)
      expect(helpers.splitRatioFor(FOLDER, 'stacked')).toBeLessThan(HELPER_SPLIT_RATIO_DEFAULT)
      expect(helpers.splitRatioFor(FOLDER, 'side-by-side')).toBe(sideBefore)

      await divider.trigger('dblclick')
      expect(helpers.splitRatioFor(FOLDER, 'stacked')).toBe(HELPER_SPLIT_RATIO_DEFAULT)
    })

    it('side by side: dragging on X changes only the side-by-side ratio', async () => {
      const w = await mountApp()
      const helpers = useHelpersStore()
      helpers.setSplitRatio(FOLDER, 0.5, 'stacked')
      const divider = dividers(w, 'vertical')[1]
      dragAxis(divider.element, 'x', 900, 800)
      expect(helpers.splitRatioFor(FOLDER, 'side-by-side')).toBeLessThan(HELPER_SPLIT_RATIO_DEFAULT)
      expect(helpers.splitRatioFor(FOLDER, 'stacked')).toBe(0.5)
    })

    it('the session area takes the stacked ratio when stacked and the other one when not', async () => {
      const w = await mountApp()
      const helpers = useHelpersStore()
      helpers.setSplitRatio(FOLDER, 0.7, 'side-by-side')
      helpers.setSplitRatio(FOLDER, 0.45, 'stacked')
      await flushPromises()
      const host = () =>
        w.get('[data-test="terminal-pane-host"]').element.parentElement as HTMLElement
      expect(host().style.flex).toContain('0.7')
      useSettingsStore().setSplitLayout('stacked')
      await flushPromises()
      expect(host().style.flex).toContain('0.45')
    })
  })
})

describe('helper panes follow orientation', () => {
  async function mountStack(): Promise<{ w: VueWrapper; ids: string[] }> {
    seedSession()
    const helpers = useHelpersStore()
    const a = helpers.addShellHelper(FOLDER, FOLDER)
    const b = helpers.addShellHelper(FOLDER, FOLDER)
    wrapper = mount(HelperStack, { attachTo: document.body, global: { plugins: [i18n] } })
    await flushPromises()
    return { w: wrapper, ids: [a, b] }
  }

  function setBox(el: Element, width: number, height: number): void {
    Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width })
    Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height })
  }

  function dragHeader(el: Element, axis: 'x' | 'y', from: number, to: number): void {
    const at = (v: number) => (axis === 'x' ? { clientX: v } : { clientY: v })
    el.dispatchEvent(new MouseEvent('mousedown', { ...at(from), bubbles: true, cancelable: true }))
    document.dispatchEvent(new MouseEvent('mousemove', { ...at(to), bubbles: true }))
    document.dispatchEvent(new MouseEvent('mouseup', { ...at(to), bubbles: true }))
  }

  it('side by side stacks the panes top to bottom with no splitter rows', async () => {
    const { w } = await mountStack()
    const stack = w.get('#helper-stack-host')
    expect(stack.classes()).toContain('flex-col')
    expect(stack.classes()).not.toContain('flex-row')
    expect(stack.attributes('data-orientation')).toBe('side-by-side')
    expect(w.findAll('[role="separator"]')).toHaveLength(0)
  })

  it('stacked lays the panes out left to right with a width splitter between them', async () => {
    const { w } = await mountStack()
    useSettingsStore().setSplitLayout('stacked')
    await flushPromises()
    const stack = w.get('#helper-stack-host')
    expect(stack.classes()).toContain('flex-row')
    expect(stack.classes()).not.toContain('flex-col')
    expect(stack.attributes('data-orientation')).toBe('stacked')
    const splitters = w.findAll('[role="separator"]')
    expect(splitters).toHaveLength(1)
    expect(splitters[0].attributes('aria-orientation')).toBe('vertical')
    expect(splitters[0].classes()).toEqual(
      expect.arrayContaining(['w-1.5', 'cursor-col-resize', 'shrink-0'])
    )
  })

  it('the pane header is the resize handle in both: Y when side by side, X when stacked', async () => {
    const { w, ids } = await mountStack()
    const helpers = useHelpersStore()
    const stack = w.get('#helper-stack-host').element
    const ratios = () => helpers.panesForCurrentWorktree.map((p) => p.ratio)
    const headers = () => w.findAll('.probe-header')
    expect(ratios()).toEqual([0.5, 0.5])
    // The first pane's header is inert; the second one is the handle.
    expect(headers()[0].attributes('data-resizable')).toBe('false')
    expect(headers()[1].attributes('data-resizable')).toBe('true')

    setBox(stack, 600, 800)
    dragHeader(headers()[1].element, 'y', 400, 480) // +80px of 800 → +0.1
    expect(ratios()[0]).toBeCloseTo(0.6, 5)
    expect(ratios()[1]).toBeCloseTo(0.4, 5)

    useSettingsStore().setSplitLayout('stacked')
    await flushPromises()
    helpers.setPaneRatios(FOLDER, [0.5, 0.5])
    dragHeader(headers()[1].element, 'x', 300, 360) // +60px of 600 → +0.1
    expect(ratios()[0]).toBeCloseTo(0.6, 5)
    expect(ratios()[1]).toBeCloseTo(0.4, 5)
    expect(helpers.panesForCurrentWorktree.map((p) => p.id)).toEqual(ids)
  })

  it('a width splitter drags the boundary on X and respects the 5% floor', async () => {
    const { w } = await mountStack()
    const helpers = useHelpersStore()
    useSettingsStore().setSplitLayout('stacked')
    await flushPromises()
    setBox(w.get('#helper-stack-host').element, 1000, 500)
    const splitter = w.get('[role="separator"]').element
    dragHeader(splitter, 'x', 500, 600)
    expect(helpers.panesForCurrentWorktree[0].ratio).toBeCloseTo(0.6, 5)
    helpers.setPaneRatios(FOLDER, [0.5, 0.5])
    dragHeader(splitter, 'x', 500, 1500) // would push the second pane below 5%
    expect(helpers.panesForCurrentWorktree[1].ratio).toBeGreaterThanOrEqual(0.05)
  })

  it('maximize collapses the other panes to a 24px strip along the stack axis, in both', async () => {
    const { w, ids } = await mountStack()
    const helpers = useHelpersStore()
    helpers.maximizePane(FOLDER, ids[0])
    await flushPromises()
    const cells = () =>
      w.findAll('.probe-pane').map((p) => (p.element.parentElement as HTMLElement).style.flex)
    expect(cells()).toEqual(['1 1 0', '0 0 24px'])
    // No drag handle while a pane is maximized.
    expect(
      w.findAll('.probe-header').every((h) => h.attributes('data-resizable') === 'false')
    ).toBe(true)

    useSettingsStore().setSplitLayout('stacked')
    await flushPromises()
    expect(cells()).toEqual(['1 1 0', '0 0 24px'])
    expect(w.findAll('[role="separator"]')).toHaveLength(0)

    helpers.toggleMaximizePane(FOLDER, ids[0])
    await flushPromises()
    expect(cells()).toEqual(['0.5 1 0', '0.5 1 0'])
    expect(w.findAll('[role="separator"]')).toHaveLength(1)
  })

  it('closing a pane works in both and drops the splitter with the last neighbour', async () => {
    const { w, ids } = await mountStack()
    const helpers = useHelpersStore()
    useSettingsStore().setSplitLayout('stacked')
    await flushPromises()
    expect(w.findAll('[role="separator"]')).toHaveLength(1)
    helpers.removeHelper(FOLDER, ids[1])
    await flushPromises()
    expect(w.findAll('.probe-pane')).toHaveLength(1)
    expect(w.findAll('[role="separator"]')).toHaveLength(0)
  })
})

describe('the shortcut', () => {
  it('layout.cycleSplitOrientation is a bindable, unbound row in the keybindings table', () => {
    const row = KEYBINDINGS.find((d) => d.id === 'layout.cycleSplitOrientation')
    expect(row).toBeDefined()
    expect(row?.defaultKeys).toBeNull()
    expect(row?.reserved).toBe(false)
    expect(row?.labelKey).toBe('keybindings.actions.layout_cycleSplitOrientation')
  })
})
