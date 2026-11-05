// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-empty-function -- xterm / ResizeObserver stubs are intentionally no-ops */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import * as os from 'node:os'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'

/**
 * T628 (floating layout S-7) — expand a helper pane to the window, and animate the layout.
 *
 *  - AC-26 enter and exit: the header button, Esc and ⌘⇧M (the existing maximize chord) exit; the
 *    `pane.expandToWindow` action exists and shares no chord with another action.
 *  - AC-27 variants: the `expandHides` setting (`everything` default | `session-only`).
 *  - AC-28 no remount: the expanded pane is never moved; its xterm and PTY are the same objects.
 *  - AC-29 ephemeral and focus ring: per worktree, never persisted, reset on a worktree switch, and
 *    the F6 ring holds only the expanded pane.
 *  - AC-31 single reflow after motion: an xterm refits once, after the last frame of a motion.
 *  - AC-33 reduced motion: no layout transition, no flag, no browser freeze.
 *
 * jsdom has no layout engine, so the motion itself (AC-30, AC-32) is proven by captures in the real
 * app; here the controller, the CSS contract and the DOM hooks it is built from are asserted.
 */

// `src/main/settings.ts` imports `electron` at module top; stub it so its pure
// `sanitizePatch` is importable without an Electron runtime.
vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir() },
  dialog: {},
  shell: {},
  ipcMain: { handle: (): void => {} }
}))

// ── Leaf mocks for the REAL HelperPane (xterm + pty at the leaves) ─────────────
const hoisted = vi.hoisted(() => {
  const terminals: Array<{
    element: HTMLElement | null
    disposed: boolean
    cols: number
    rows: number
    resizes: number
  }> = []
  class FakeTerminal {
    options: Record<string, unknown>
    cols = 80
    rows = 24
    resizes = 0
    element: HTMLElement | null = null
    disposed = false
    constructor(opts: Record<string, unknown>) {
      this.options = opts ?? {}
      terminals.push(this)
    }
    loadAddon(): void {}
    attachCustomKeyEventHandler(): void {}
    open(host: HTMLElement): void {
      this.element = document.createElement('div')
      this.element.className = 'xterm-fake'
      host.appendChild(this.element)
    }
    onData(): { dispose(): void } {
      return { dispose() {} }
    }
    onResize(): { dispose(): void } {
      return { dispose() {} }
    }
    write(): void {}
    resize(c: number, r: number): void {
      this.cols = c
      this.rows = r
      this.resizes++
    }
    focus(): void {}
    refresh(): void {}
    registerLinkProvider(): { dispose(): void } {
      return { dispose() {} }
    }
    dispose(): void {
      this.disposed = true
    }
  }
  const dims = { cols: 80, rows: 24 }
  const observers: Array<{ cb: () => void }> = []
  const mode = { real: false }
  return { terminals, FakeTerminal, dims, observers, mode }
})

vi.mock('@xterm/xterm', () => ({ Terminal: hoisted.FakeTerminal }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-image', () => ({ ImageAddon: class {} }))
vi.mock('@renderer/lib/terminalMetrics', () => ({
  ensureTerminalFontLoaded: () => Promise.resolve(),
  measureCells: () => ({ ...hoisted.dims }),
  measureXtermCells: () => ({ ...hoisted.dims })
}))
vi.mock('../src/renderer/src/lib/terminalMetrics', () => ({
  ensureTerminalFontLoaded: () => Promise.resolve(),
  measureCells: () => ({ ...hoisted.dims }),
  measureXtermCells: () => ({ ...hoisted.dims })
}))

// HelperStack's job under test is the LAYOUT around the panes: every pane type renders a probe,
// except when a test asks for the real xterm-backed HelperPane.
vi.mock('../src/renderer/src/lib/pane-components', async () => {
  const { defineComponent, h } = await import('vue')
  const actual = await vi.importActual<typeof import('../src/renderer/src/lib/pane-components')>(
    '../src/renderer/src/lib/pane-components'
  )
  const probe = { mounted: 0, unmounted: 0 }
  ;(globalThis as unknown as { __probe: typeof probe }).__probe = probe
  const Probe = defineComponent({
    props: { pane: { type: Object, required: true }, worktreePath: String, resizable: Boolean },
    emits: ['header-mouse-down', 'open-file'],
    setup(props) {
      return () =>
        h('div', { class: 'probe-pane', 'data-pane-id': (props.pane as { id: string }).id })
    },
    mounted() {
      probe.mounted++
    },
    unmounted() {
      probe.unmounted++
    }
  })
  return {
    paneComponents: new Proxy(
      {},
      {
        get: (_t, type: string) =>
          hoisted.mode.real ? (actual.paneComponents as Record<string, unknown>)[type] : Probe
      }
    )
  }
})

// useShortcuts matches chords through useMagicKeys, which jsdom cannot drive faithfully; capture the
// binding list App registers and call a binding's handler as the chord would.
interface CapturedBinding {
  id: string
  handler: () => void
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
import HelperStack from '../src/renderer/src/components/HelperStack.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import SettingsDialog from '../src/renderer/src/components/SettingsDialog.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useSettingsStore } from '../src/renderer/src/stores/settings'
import * as layoutModule from '../src/renderer/src/stores/layout'
import { useLayoutStore } from '../src/renderer/src/stores/layout'
import * as helpersModule from '../src/renderer/src/stores/helpers'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { paneRing } from '../src/renderer/src/lib/pane-ring'
import { KEYBINDINGS } from '../src/main/keybindings-core'
import { sanitizePatch } from '../src/main/settings'

const none = (): (() => void) => () => {}
type SavedPatch = Record<string, unknown>
let saved: SavedPatch[] = []
let helpersSets: unknown[] = []
let ptyCounter = 0
let browserDrag: ReturnType<typeof vi.fn>
let ptyResize: ReturnType<typeof vi.fn>

function stubApi(persisted: Record<string, unknown> = {}): void {
  browserDrag = vi.fn()
  ptyResize = vi.fn()
  ptyCounter = 0
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
      helpersGet: vi.fn(async () => null),
      helpersSet: vi.fn(async (...args: unknown[]) => {
        helpersSets.push(args)
      }),
      ptyCreate: vi.fn(async () => `pty-${++ptyCounter}`),
      ptyDestroy: vi.fn(),
      ptyWrite: vi.fn(),
      ptyResize,
      browserDrag,
      // The file-backed panes read through these; a refusal renders their own error state.
      markdownRead: vi.fn(async () => ({ ok: false, code: 'not-found' })),
      canvasRead: vi.fn(async () => ({ ok: false, code: 'not-found' })),
      explorerListDir: vi.fn(async () => ({ entries: [], error: 'read-failed' })),
      explorerSearch: vi.fn(async () => ({ results: [], truncated: false }))
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

function seedFolder(path: string, sessionId: string): void {
  const sessions = useSessionsStore()
  sessions.folders.push({
    path,
    alias: path.split('/').pop(),
    expanded: true,
    sessions: [
      {
        sessionId,
        projectPath: path,
        summary: '',
        firstPrompt: '',
        modified: new Date().toISOString(),
        resumable: true
      }
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

const ROOT = resolve(__dirname, '..')
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8')

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
  helpersSets = []
  hoisted.terminals.length = 0
  hoisted.observers.length = 0
  hoisted.dims.cols = 80
  hoisted.dims.rows = 24
  hoisted.mode.real = false
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    cb: () => void
    constructor(cb: () => void) {
      this.cb = cb
      hoisted.observers.push(this)
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  const probe = (globalThis as unknown as { __probe?: { mounted: number; unmounted: number } })
    .__probe
  if (probe) {
    probe.mounted = 0
    probe.unmounted = 0
  }
  setActivePinia(createPinia())
  stubApi()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-floating')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/* ---------------------------------------------------------------------------------------------- */

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

/** Mount the App shell with one folder, one session and two shell helper panes; returns the pane ids. */
async function mountApp(): Promise<{ w: VueWrapper; ids: string[] }> {
  seedFolder(FOLDER, 's1')
  useSessionsStore().select('s1')
  const helpers = useHelpersStore()
  const a = helpers.addShellHelper(FOLDER, FOLDER)
  const b = helpers.addShellHelper(FOLDER, FOLDER)
  wrapper = mount(App, {
    attachTo: document.body,
    global: { plugins: [i18n], stubs: APP_STUBS }
  })
  await flushPromises()
  return { w: wrapper, ids: [a, b] }
}

async function mountStack(real = false): Promise<{ w: VueWrapper; ids: string[] }> {
  hoisted.mode.real = real
  seedFolder(FOLDER, 's1')
  useSessionsStore().select('s1')
  const helpers = useHelpersStore()
  const a = helpers.addShellHelper(FOLDER, FOLDER)
  const b = helpers.addShellHelper(FOLDER, FOLDER)
  wrapper = mount(HelperStack, { attachTo: document.body, global: { plugins: [i18n] } })
  for (let i = 0; i < 6; i++) {
    await flushPromises()
    await nextTick()
  }
  return { w: wrapper, ids: [a, b] }
}

const panes = (w: VueWrapper) => w.findAll('[data-island="helper-pane"]')

/* ---------------------------------------------------------------------------------------------- */

describe('enter and exit', () => {
  it('the store enters, toggles off, re-targets and exits explicitly', async () => {
    const helpers = useHelpersStore()
    expect(typeof helpers.toggleExpandPane, 'toggleExpandPane exists').toBe('function')
    expect(typeof helpers.exitExpand, 'exitExpand exists').toBe('function')
    seedFolder(FOLDER, 's1')
    useSessionsStore().select('s1')
    const a = helpers.addShellHelper(FOLDER, FOLDER)
    const b = helpers.addShellHelper(FOLDER, FOLDER)

    expect(helpers.expandedPaneIdForCurrentWorktree).toBeNull()
    helpers.toggleExpandPane(FOLDER, a)
    expect(helpers.expandedPaneIdForCurrentWorktree).toBe(a)
    // Another pane's button re-targets directly, no exit first.
    helpers.toggleExpandPane(FOLDER, b)
    expect(helpers.expandedPaneIdForCurrentWorktree).toBe(b)
    // The same pane again exits.
    helpers.toggleExpandPane(FOLDER, b)
    expect(helpers.expandedPaneIdForCurrentWorktree).toBeNull()

    helpers.toggleExpandPane(FOLDER, a)
    helpers.exitExpand(FOLDER)
    expect(helpers.expandedPaneIdForCurrentWorktree).toBeNull()
  })

  it('closing the expanded pane clears the expanded state', async () => {
    const helpers = useHelpersStore()
    seedFolder(FOLDER, 's1')
    useSessionsStore().select('s1')
    const a = helpers.addShellHelper(FOLDER, FOLDER)
    helpers.addShellHelper(FOLDER, FOLDER)
    expect(typeof helpers.toggleExpandPane).toBe('function')
    helpers.toggleExpandPane(FOLDER, a)
    helpers.removeHelper(FOLDER, a)
    expect(helpers.expandedPaneIdForCurrentWorktree).toBeNull()
  })

  it('each xterm pane header has an Expand to window button before maximize; clicking toggles', async () => {
    const { w, ids } = await mountStack(true)
    const helpers = useHelpersStore()
    const header = w.get(`[data-focus-region="${ids[0]}"] header`)
    const buttons = header.findAll('button')
    const labels = buttons.map((b) => b.attributes('aria-label'))
    const expandAt = labels.indexOf('Expand to window')
    const maximizeAt = labels.indexOf('Maximize')
    expect(expandAt, 'an Expand to window button exists').toBeGreaterThanOrEqual(0)
    expect(maximizeAt, 'the Maximize button is still there').toBeGreaterThan(expandAt)
    expect(expandAt).toBe(maximizeAt - 1)

    await buttons[expandAt].trigger('click')
    expect(helpers.expandedPaneIdForCurrentWorktree).toBe(ids[0])
    const pressed = w.get(`[data-focus-region="${ids[0]}"] header [aria-pressed="true"]`)
    expect(pressed.attributes('aria-label')).toBe('Exit expanded view')
    await pressed.trigger('click')
    expect(helpers.expandedPaneIdForCurrentWorktree).toBeNull()
  })

  it('every helper pane kind has the Expand to window button, in the same place, and it toggles', async () => {
    hoisted.mode.real = true
    seedFolder(FOLDER, 's1')
    useSessionsStore().select('s1')
    const helpers = useHelpersStore()
    expect(typeof helpers.toggleExpandPane).toBe('function')
    const ids: Record<string, string> = {
      shell: helpers.addShellHelper(FOLDER, FOLDER),
      markdown: helpers.addMarkdownHelper(FOLDER, `${FOLDER}/README.md`, FOLDER),
      memory: helpers.addMemoryHelper(FOLDER, FOLDER),
      explorer: helpers.addExplorerHelper(FOLDER, FOLDER),
      canvas: helpers.addCanvasHelper(FOLDER, `${FOLDER}/board.harnucanvas.json`, FOLDER),
      browser: helpers.addBrowserHelper(FOLDER, {
        paneId: 'bp-test',
        name: '',
        url: 'about:blank',
        openedBy: 'operator',
        partition: 'operator',
        ownerSessionId: null
      })
    }
    wrapper = mount(HelperStack, { attachTo: document.body, global: { plugins: [i18n] } })
    for (let i = 0; i < 8; i++) {
      await flushPromises()
      await nextTick()
    }
    const wrappers = wrapper.findAll('[data-island="helper-pane"]')
    expect(wrappers).toHaveLength(Object.keys(ids).length)
    for (const [index, [kind, id]] of Object.entries(ids).entries()) {
      const wrap = wrappers[index]
      expect(wrap, `${kind}: pane is rendered`).toBeDefined()
      const header = wrap!.get('header')
      const buttons = header.findAll('button')
      const labels = buttons.map((b) => b.attributes('aria-label'))
      const at = labels.indexOf('Expand to window')
      const maximizeAt = labels.findIndex((l) => l === 'Maximize')
      expect(at, `${kind}: has an Expand to window button`).toBeGreaterThanOrEqual(0)
      expect(at, `${kind}: right before Maximize`).toBe(maximizeAt - 1)
      const button = buttons[at]
      expect(button.attributes('aria-pressed')).toBe('false')
      await button.trigger('click')
      expect(helpers.expandedPaneIdForCurrentWorktree, `${kind}: click expands it`).toBe(id)
      const pressed = wrap!.get('header [aria-pressed="true"]')
      expect(pressed.attributes('aria-label')).toBe('Exit expanded view')
      expect(pressed.classes(), `${kind}: accent ink while expanded`).toContain('text-accent')
      await pressed.trigger('click')
      expect(helpers.expandedPaneIdForCurrentWorktree, `${kind}: click exits it`).toBeNull()
    }
  })

  it('Esc exits the expanded view', async () => {
    const { ids } = await mountApp()
    const helpers = useHelpersStore()
    expect(typeof helpers.toggleExpandPane).toBe('function')
    helpers.toggleExpandPane(FOLDER, ids[0])
    await flushPromises()
    expect(helpers.expandedPaneIdForCurrentWorktree).toBe(ids[0])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(helpers.expandedPaneIdForCurrentWorktree).toBeNull()
  })

  it('Esc does nothing when no pane is expanded and leaves a terminal its own Esc', async () => {
    const { w, ids } = await mountApp()
    const helpers = useHelpersStore()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(helpers.expandedPaneIdForCurrentWorktree).toBeNull()

    helpers.toggleExpandPane(FOLDER, ids[0])
    await flushPromises()
    const xterm = document.createElement('textarea')
    xterm.className = 'xterm-helper-textarea'
    const host = document.createElement('div')
    host.className = 'xterm'
    host.appendChild(xterm)
    w.element.appendChild(host)
    xterm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(helpers.expandedPaneIdForCurrentWorktree, 'a terminal keeps its Esc').toBe(ids[0])
  })

  it('the maximize chord (⌘⇧M) exits an expanded view instead of toggling maximize', async () => {
    const { ids } = await mountApp()
    const helpers = useHelpersStore()
    expect(typeof helpers.toggleExpandPane).toBe('function')
    helpers.toggleExpandPane(FOLDER, ids[0])
    await flushPromises()
    binding('pane.toggleMaximize').handler()
    await flushPromises()
    expect(helpers.expandedPaneIdForCurrentWorktree).toBeNull()
    expect(helpers.maximizedPaneIdForCurrentWorktree, 'maximize was not toggled').toBeNull()
  })

  it('pane.expandToWindow is a bindable action with no default chord, and no chord is shared', () => {
    const row = KEYBINDINGS.find((k) => k.id === 'pane.expandToWindow')
    expect(row, 'pane.expandToWindow is in the keybindings table').toBeDefined()
    expect(row?.defaultKeys).toBeNull()
    const maximize = KEYBINDINGS.find((k) => k.id === 'pane.toggleMaximize')
    expect(maximize?.defaultKeys).toBe('Cmd+Shift+M')
    const sharing = KEYBINDINGS.filter((k) => k.defaultKeys === 'Cmd+Shift+M')
    expect(
      sharing.map((k) => k.id),
      'the maximize chord belongs to one action'
    ).toEqual(['pane.toggleMaximize'])
  })
})

/* ---------------------------------------------------------------------------------------------- */

describe('variants', () => {
  it('variant setting: defaults to everything, adopts a saved value, falls back on junk', async () => {
    const settings = useSettingsStore()
    expect(settings.expandHides).toBe('everything')
    await settings.init()
    expect(settings.expandHides).toBe('everything')
    settings.dispose()

    setActivePinia(createPinia())
    stubApi({ expandHides: 'session-only' })
    const second = useSettingsStore()
    await second.init()
    expect(second.expandHides).toBe('session-only')
    second.dispose()

    setActivePinia(createPinia())
    stubApi({ expandHides: 'nothing' })
    const third = useSettingsStore()
    await third.init()
    expect(third.expandHides).toBe('everything')
    third.dispose()
  })

  it('writes the choice to settings.json after the debounce; the main allowlist keeps valid values only', async () => {
    const settings = useSettingsStore()
    await settings.init()
    expect(typeof settings.setExpandHides).toBe('function')
    settings.setExpandHides('session-only')
    await vi.advanceTimersByTimeAsync(400)
    expect(saved).toEqual([{ expandHides: 'session-only' }])
    settings.dispose()

    expect(sanitizePatch({ expandHides: 'everything' })).toEqual({ expandHides: 'everything' })
    expect(sanitizePatch({ expandHides: 'session-only' })).toEqual({ expandHides: 'session-only' })
    expect(sanitizePatch({ expandHides: 'sidebar' })).toEqual({})
    expect(sanitizePatch({ expandHides: 1 })).toEqual({})
  })

  it('Settings → Appearance has an Expand hides control that sets and persists the choice', async () => {
    const settings = useSettingsStore()
    await settings.init()
    wrapper = mount(SettingsDialog, { global: { plugins: [i18n], stubs: { teleport: true } } })
    useUiStore().openSettings('appearance')
    await flushPromises()
    const row = wrapper.get('#set-expandHides')
    expect(row.text()).toContain('Expand hides')
    const group = row.get('[aria-label="Expand hides"]')
    const options = group.findAll('button')
    expect(options.map((b) => b.text())).toEqual(['Everything', 'Session only'])
    // The default is Everything.
    expect(options[0].attributes('aria-checked') ?? options[0].attributes('aria-pressed')).toBe(
      'true'
    )
    await options[1].trigger('click')
    expect(settings.expandHides).toBe('session-only')
    await vi.advanceTimersByTimeAsync(400)
    expect(saved).toContainEqual({ expandHides: 'session-only' })
    await wrapper
      .get('#set-expandHides [aria-label="Expand hides"]')
      .findAll('button')[0]
      .trigger('click')
    await flushPromises()
    expect(settings.expandHides).toBe('everything')
    settings.dispose()
  })

  it('the Expand hides strings exist in both locales', async () => {
    const en = JSON.parse(read('src/renderer/src/i18n/en.json'))
    const pt = JSON.parse(read('src/renderer/src/i18n/pt-BR.json'))
    for (const [name, msgs] of [
      ['en', en],
      ['pt-BR', pt]
    ] as const) {
      const block = msgs.settings.appearance.expandHides
      for (const key of ['label', 'hint', 'everything', 'sessionOnly']) {
        expect(block?.[key], `${name} settings.appearance.expandHides.${key}`).toBeTruthy()
      }
      expect(msgs.keybindings.actions.pane_expandToWindow, `${name} action label`).toBeTruthy()
      expect(msgs.helperPane.expand, `${name} helperPane.expand`).toBeTruthy()
      expect(msgs.helperPane.exitExpand, `${name} helperPane.exitExpand`).toBeTruthy()
    }
  })

  it('everything: the sidebar, the session area and the Fleet rail collapse', async () => {
    const { w, ids } = await mountApp()
    const helpers = useHelpersStore()
    expect(typeof helpers.toggleExpandPane).toBe('function')
    const session = () => w.get('[data-island="session"]')
    expect(session().classes()).not.toContain('lm-collapse')
    helpers.toggleExpandPane(FOLDER, ids[0])
    await flushPromises()
    expect(w.get('[data-app-shell]').attributes('data-expand')).toBe('everything')
    expect(session().classes()).toContain('lm-collapse')
    expect(w.get('sidebar-stub').classes()).toContain('lm-collapse-w')
    expect(w.get('[data-rail-column]').classes()).toContain('lm-collapse-w')
    // The dividers that touched a collapsed column collapse with it.
    const dividers = w.findAll('[role="separator"]')
    expect(dividers.length).toBeGreaterThanOrEqual(3)
    expect(dividers.every((d) => /lm-collapse/.test(d.classes().join(' ')))).toBe(true)
    // Topbar and footer are never collapsed.
    expect(w.findAll('[data-app-shell] > :last-child.lm-collapse')).toHaveLength(0)

    helpers.exitExpand(FOLDER)
    await flushPromises()
    expect(w.get('[data-app-shell]').attributes('data-expand')).toBeUndefined()
    expect(session().classes()).not.toContain('lm-collapse')
    expect(w.get('[data-rail-column]').classes()).not.toContain('lm-collapse-w')
  })

  it('session-only: only the session area collapses; the sidebar and the Fleet rail stay', async () => {
    const { w, ids } = await mountApp()
    const helpers = useHelpersStore()
    expect(typeof useSettingsStore().setExpandHides).toBe('function')
    useSettingsStore().setExpandHides('session-only')
    helpers.toggleExpandPane(FOLDER, ids[0])
    await flushPromises()
    expect(w.get('[data-app-shell]').attributes('data-expand')).toBe('session-only')
    expect(w.get('[data-island="session"]').classes()).toContain('lm-collapse')
    expect(w.get('[data-rail-column]').classes()).not.toContain('lm-collapse-w')
    expect(w.get('sidebar-stub').classes()).not.toContain('lm-collapse-w')
  })

  it('the helper stack: the expanded pane takes the room and the others collapse to nothing', async () => {
    const { w, ids } = await mountStack()
    const helpers = useHelpersStore()
    expect(typeof helpers.toggleExpandPane).toBe('function')
    helpers.toggleExpandPane(FOLDER, ids[1])
    await nextTick()
    const [first, second] = panes(w)
    expect(second.classes()).not.toContain('lm-collapse')
    expect((second.element as HTMLElement).style.flex).toContain('1 1 0')
    expect(first.classes()).toContain('lm-collapse')
    expect((first.element as HTMLElement).style.flex).toContain('0 0 0')
    // Not the 24px header strip a maximize leaves.
    expect((first.element as HTMLElement).style.flex).not.toContain('24px')
  })
})

/* ---------------------------------------------------------------------------------------------- */

describe('no remount', () => {
  it('the expanded pane keeps its DOM node and its component instance across enter and exit', async () => {
    const { w, ids } = await mountStack()
    const helpers = useHelpersStore()
    expect(typeof helpers.toggleExpandPane).toBe('function')
    const probe = (globalThis as unknown as { __probe: { mounted: number; unmounted: number } })
      .__probe
    const node = panes(w)[0].element
    const inner = node.firstElementChild
    const mountedBefore = probe.mounted

    helpers.toggleExpandPane(FOLDER, ids[0])
    await nextTick()
    expect(panes(w)[0].element).toBe(node)
    expect(node.firstElementChild).toBe(inner)
    helpers.toggleExpandPane(FOLDER, ids[0])
    await nextTick()
    expect(panes(w)[0].element).toBe(node)
    expect(node.firstElementChild).toBe(inner)
    expect(probe.mounted).toBe(mountedBefore)
    expect(probe.unmounted).toBe(0)
  })

  it('an xterm pane keeps the same Terminal and the same PTY across enter and exit', async () => {
    const { w, ids } = await mountStack(true)
    const helpers = useHelpersStore()
    expect(typeof helpers.toggleExpandPane).toBe('function')
    const created = (window.api.ptyCreate as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    expect(created).toBe(2)
    const [term] = hoisted.terminals
    const termElement = term.element

    helpers.toggleExpandPane(FOLDER, ids[0])
    for (let i = 0; i < 4; i++) {
      await flushPromises()
      await nextTick()
    }
    helpers.toggleExpandPane(FOLDER, ids[0])
    for (let i = 0; i < 4; i++) {
      await flushPromises()
      await nextTick()
    }

    expect(hoisted.terminals).toHaveLength(2)
    expect(hoisted.terminals[0]).toBe(term)
    expect(term.disposed).toBe(false)
    expect(term.element).toBe(termElement)
    expect(document.body.contains(termElement)).toBe(true)
    expect((window.api.ptyCreate as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      created
    )
    expect(window.api.ptyDestroy as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    expect(w.findAll('[data-island="helper-pane"]')).toHaveLength(2)
  })
})

/* ---------------------------------------------------------------------------------------------- */

describe('ephemeral and focus ring', () => {
  it('never reaches helpers.json', async () => {
    const helpers = useHelpersStore()
    seedFolder(FOLDER, 's1')
    useSessionsStore().select('s1')
    const a = helpers.addShellHelper(FOLDER, FOLDER)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2000)
    helpersSets = []
    expect(typeof helpers.toggleExpandPane).toBe('function')
    helpers.toggleExpandPane(FOLDER, a)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2000)
    expect(JSON.stringify(helpersSets)).not.toMatch(/expand/i)
    expect(localStorage.length === 0 || !/expand/i.test(JSON.stringify({ ...localStorage }))).toBe(
      true
    )
  })

  it('resets on a worktree switch, and is per worktree', async () => {
    const helpers = useHelpersStore()
    const sessions = useSessionsStore()
    seedFolder(FOLDER, 's1')
    seedFolder(OTHER, 's2')
    sessions.select('s1')
    const a = helpers.addShellHelper(FOLDER, FOLDER)
    const b = helpers.addShellHelper(OTHER, OTHER)
    expect(typeof helpers.toggleExpandPane).toBe('function')

    helpers.toggleExpandPane(FOLDER, a)
    expect(helpers.expandedPaneIdForCurrentWorktree).toBe(a)
    sessions.select('s2')
    await flushPromises()
    expect(helpers.expandedPaneIdForCurrentWorktree).toBeNull()
    // Expanding in the other worktree does not touch the first one…
    helpers.toggleExpandPane(OTHER, b)
    expect(helpers.expandedPaneIdForCurrentWorktree).toBe(b)
    // …and coming back finds the first worktree back in its normal layout.
    sessions.select('s1')
    await flushPromises()
    expect(helpers.expandedPaneIdForCurrentWorktree).toBeNull()
    expect(helpers.expandedPaneId(FOLDER)).toBeNull()
  })

  it('the F6 ring holds only the expanded pane (no main terminal, no other pane)', () => {
    expect(typeof helpersModule.applyExpandToRing, 'applyExpandToRing exists').toBe('function')
    const state = {
      mainForeground: true,
      stackShown: true,
      helperCollapsed: false,
      paneIds: ['p1', 'p2', 'p3'],
      maximizedId: null as string | null
    }
    expect(paneRing(helpersModule.applyExpandToRing(state, 'p2'))).toEqual(['p2'])
    // Expanded wins over a maximized pane; with none expanded the ring is untouched.
    expect(
      paneRing(helpersModule.applyExpandToRing({ ...state, maximizedId: 'p1' }, 'p3'))
    ).toEqual(['p3'])
    expect(paneRing(helpersModule.applyExpandToRing(state, null))).toEqual(paneRing(state))
    expect(paneRing(state)).toEqual(['main', 'p1', 'p2', 'p3'])
  })
})

/* ---------------------------------------------------------------------------------------------- */

describe('single reflow after motion', () => {
  const frames = (n: number, step: number, fn: () => void) => {
    for (let i = 0; i < n; i++) {
      fn()
      vi.advanceTimersByTime(step)
    }
  }

  it('the reflow gate refits once, after the last frame of a motion', () => {
    expect(typeof layoutModule.createReflowGate, 'createReflowGate exists').toBe('function')
    let motion = true
    const fit = vi.fn()
    const gate = layoutModule.createReflowGate({
      isMotion: () => motion,
      fit,
      delayMs: layoutModule.REFLOW_DELAY_MS,
      setTimer: (cb, ms) => setTimeout(cb, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
    })
    // ~220ms of animation observed at 60fps: a resize observation every frame.
    frames(14, 16, () => gate.observe())
    expect(fit, 'never per frame').not.toHaveBeenCalled()
    motion = false
    vi.advanceTimersByTime(layoutModule.REFLOW_DELAY_MS + 5)
    expect(fit).toHaveBeenCalledTimes(1)
  })

  it('outside a motion every observation refits at once (a drag stays live)', () => {
    expect(typeof layoutModule.createReflowGate).toBe('function')
    const fit = vi.fn()
    const gate = layoutModule.createReflowGate({
      isMotion: () => false,
      fit,
      delayMs: layoutModule.REFLOW_DELAY_MS,
      setTimer: (cb, ms) => setTimeout(cb, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
    })
    frames(5, 16, () => gate.observe())
    expect(fit).toHaveBeenCalledTimes(5)
  })

  it('a real xterm pane resizes its grid once for a whole animated expand', async () => {
    const { ids } = await mountStack(true)
    const layout = useLayoutStore()
    const helpers = useHelpersStore()
    expect(typeof layout.beginLayoutMotion).toBe('function')
    const term = hoisted.terminals[0]
    expect(hoisted.observers.length).toBeGreaterThan(0)
    const observer = hoisted.observers[hoisted.observers.length - 2] // the first pane's observer
    const before = term.resizes

    layout.beginLayoutMotion()
    helpers.toggleExpandPane(FOLDER, ids[0])
    await nextTick()
    // The grid takes 18 different sizes over the animation; the pane must not follow them.
    for (let i = 0; i < 18; i++) {
      hoisted.dims.cols = 80 + i * 3
      hoisted.dims.rows = 24 + i
      observer.cb()
      vi.advanceTimersByTime(12)
    }
    expect(term.resizes - before, 'no refit while the motion runs').toBe(0)
    vi.advanceTimersByTime(2000)
    expect(layout.layoutMotion).toBe(false)
    expect(term.resizes - before, 'one refit after it').toBe(1)
    expect(term.cols).toBe(80 + 17 * 3)
  })
})

/* ---------------------------------------------------------------------------------------------- */

describe('motion controller', () => {
  function controller(opts: { reduced?: boolean } = {}) {
    const log: string[] = []
    const motion = layoutModule.createLayoutMotion({
      durationMs: () => 220,
      reduced: () => opts.reduced === true,
      onChange: (on: boolean) => log.push(on ? 'flag-on' : 'flag-off'),
      freeze: (on: boolean) => log.push(on ? 'freeze' : 'thaw'),
      setTimer: (cb: () => void, ms: number) => setTimeout(cb, ms),
      clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)
    })
    return { motion, log }
  }

  it('freezes browser panes and sets the flag for one duration plus slack, then releases both once', () => {
    expect(typeof layoutModule.createLayoutMotion, 'createLayoutMotion exists').toBe('function')
    const { motion, log } = controller()
    expect(motion.begin()).toBe(true)
    expect(log).toEqual(['flag-on', 'freeze'])
    vi.advanceTimersByTime(200)
    expect(log).toEqual(['flag-on', 'freeze'])
    vi.advanceTimersByTime(220 - 200 + layoutModule.LAYOUT_MOTION_SLACK_MS + 1)
    expect(log).toEqual(['flag-on', 'freeze', 'flag-off', 'thaw'])
  })

  it('reads --dur-slow in either unit (220ms or 0.22s), and falls back when it is missing', () => {
    expect(typeof layoutModule.slowDurationMs, 'slowDurationMs exists').toBe('function')
    const root = document.documentElement
    root.style.setProperty('--dur-slow', '220ms')
    expect(layoutModule.slowDurationMs()).toBe(220)
    root.style.setProperty('--dur-slow', '0.22s')
    expect(layoutModule.slowDurationMs()).toBe(220)
    root.style.removeProperty('--dur-slow')
    expect(layoutModule.slowDurationMs()).toBe(220)
  })

  it('a second change during a motion extends it without freezing twice', () => {
    expect(typeof layoutModule.createLayoutMotion).toBe('function')
    const { motion, log } = controller()
    motion.begin()
    vi.advanceTimersByTime(150)
    motion.begin()
    vi.advanceTimersByTime(150)
    expect(log).toEqual(['flag-on', 'freeze'])
    vi.advanceTimersByTime(400)
    expect(log).toEqual(['flag-on', 'freeze', 'flag-off', 'thaw'])
  })

  it('does not end while a layout transition is still running, then ends once it is done', () => {
    expect(typeof layoutModule.createLayoutMotion).toBe('function')
    let running = true
    const log: string[] = []
    const motion = layoutModule.createLayoutMotion({
      durationMs: () => 220,
      reduced: () => false,
      onChange: (on: boolean) => log.push(on ? 'flag-on' : 'flag-off'),
      freeze: (on: boolean) => log.push(on ? 'freeze' : 'thaw'),
      setTimer: (cb: () => void, ms: number) => setTimeout(cb, ms),
      clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
      busy: () => running
    })
    motion.begin()
    vi.advanceTimersByTime(220 + layoutModule.LAYOUT_MOTION_SLACK_MS + 200)
    expect(log, 'still frozen while a transition runs').toEqual(['flag-on', 'freeze'])
    running = false
    vi.advanceTimersByTime(120)
    expect(log).toEqual(['flag-on', 'freeze', 'flag-off', 'thaw'])
  })

  it('the layout store drives it: an expand starts a motion that freezes browser panes, then ends', async () => {
    const { ids } = await mountApp()
    const layout = useLayoutStore()
    const helpers = useHelpersStore()
    expect(typeof helpers.toggleExpandPane).toBe('function')
    expect(layout.layoutMotion).toBe(false)
    helpers.toggleExpandPane(FOLDER, ids[0])
    await flushPromises()
    expect(layout.layoutMotion).toBe(true)
    expect(document.querySelector('[data-app-shell]')?.getAttribute('data-layout-motion')).toBe(
      'on'
    )
    expect(browserDrag).toHaveBeenCalledWith(true)
    await vi.advanceTimersByTimeAsync(1500)
    expect(layout.layoutMotion).toBe(false)
    expect(document.querySelector('[data-app-shell]')?.hasAttribute('data-layout-motion')).toBe(
      false
    )
    expect(browserDrag).toHaveBeenLastCalledWith(false)
    expect(browserDrag).toHaveBeenCalledTimes(2)
  })

  it('maximize, sidebar collapse and Fleet rail minimize start a motion too; a divider drag does not', async () => {
    const { w, ids } = await mountApp()
    const layout = useLayoutStore()
    const helpers = useHelpersStore()
    const motionAfter = async (fn: () => void): Promise<boolean> => {
      await vi.advanceTimersByTimeAsync(1500)
      fn()
      await flushPromises()
      const on = layout.layoutMotion
      await vi.advanceTimersByTimeAsync(1500)
      return on
    }
    expect(await motionAfter(() => helpers.toggleMaximizePane(FOLDER, ids[0]))).toBe(true)
    expect(await motionAfter(() => layout.setSidebarCollapsed(true))).toBe(true)
    expect(await motionAfter(() => layout.setInboxRailState('minimized'))).toBe(true)
    expect(await motionAfter(() => layout.setInboxRailState('expanded'))).toBe(true)

    // Dragging the Fleet rail divider changes its width on every move and never animates.
    const divider = w.findAll('[role="separator"][aria-orientation="vertical"]').pop()!
    const move = async (): Promise<boolean> => {
      divider.element.dispatchEvent(
        new MouseEvent('mousedown', { clientX: 1000, bubbles: true, cancelable: true })
      )
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 960, bubbles: true }))
      document.dispatchEvent(new MouseEvent('mouseup', { clientX: 960, bubbles: true }))
      await flushPromises()
      return layout.layoutMotion
    }
    expect(await move()).toBe(false)
  })
})

/* ---------------------------------------------------------------------------------------------- */

describe('reduced motion', () => {
  /** The motion block of main.css, between its two marker comments. */
  function motionCss(): string {
    const css = read('src/renderer/src/styles/main.css')
    const start = css.indexOf('/* layout-motion:start */')
    const end = css.indexOf('/* layout-motion:end */')
    expect(start, 'main.css has the layout-motion:start marker').toBeGreaterThanOrEqual(0)
    expect(end, 'main.css has the layout-motion:end marker').toBeGreaterThan(start)
    return css.slice(start, end)
  }

  it('transitions exist only under the transient flag and use --dur-slow and --ease', () => {
    const css = motionCss()
    const transitions = [...css.matchAll(/([^{}]+)\{([^{}]*transition[^{}]*)\}/g)]
    expect(transitions.length).toBeGreaterThan(0)
    for (const [, selector, body] of transitions) {
      expect(selector, 'a transition is scoped to the motion flag').toContain(
        '[data-layout-motion]'
      )
      expect(body).toContain('var(--dur-slow)')
      expect(body).toContain('var(--ease)')
    }
    // Nothing outside the flag animates, so a divider drag (which never sets it) is never eased.
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(
      /(^|\})\s*\[data-lm\][^{]*\{[^}]*transition/
    )
  })

  it('the existing reduce block turns every layout transition off', () => {
    const css = read('src/renderer/src/styles/main.css')
    const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
    const joined = blocks.map((b) => b[1]).join('\n')
    expect(joined).toMatch(/\[data-layout-motion\][^{]*\{[^}]*transition:\s*none\s*!important/)
    expect(css.match(/\/\* layout-motion:start \*\//g)).toHaveLength(1)
  })

  it('under prefers-reduced-motion the controller never sets the flag or freezes a browser pane', () => {
    expect(typeof layoutModule.createLayoutMotion).toBe('function')
    const log: string[] = []
    const motion = layoutModule.createLayoutMotion({
      durationMs: () => 220,
      reduced: () => true,
      onChange: (on: boolean) => log.push(`flag-${on}`),
      freeze: (on: boolean) => log.push(`freeze-${on}`),
      setTimer: (cb: () => void, ms: number) => setTimeout(cb, ms),
      clearTimer: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)
    })
    expect(motion.begin()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(log).toEqual([])
  })

  it('the store honours the media query: no flag and no freeze when the OS asks for reduced motion', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {}
    })) as unknown as typeof window.matchMedia
    const { ids } = await mountApp()
    const layout = useLayoutStore()
    const helpers = useHelpersStore()
    expect(typeof helpers.toggleExpandPane).toBe('function')
    helpers.toggleExpandPane(FOLDER, ids[0])
    await flushPromises()
    // The layout still changes (the pane is expanded), it just snaps.
    expect(helpers.expandedPaneIdForCurrentWorktree).toBe(ids[0])
    expect(layout.layoutMotion).toBe(false)
    expect(browserDrag).not.toHaveBeenCalled()
  })
})
