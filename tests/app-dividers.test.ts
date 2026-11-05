// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import App from '../src/renderer/src/App.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import {
  useLayoutStore,
  SIDEBAR_WIDTH_DEFAULT,
  INBOX_RAIL_WIDTH_DEFAULT
} from '../src/renderer/src/stores/layout'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'

/**
 * BUG-247 (floating layout S-2) — the vertical pane dividers.
 *
 *  - AC-3: the hit area stays 6px wide (`w-1.5`) with `cursor-col-resize`, drag
 *    resizes, double-click resets (sidebar, helper stack, Fleet rail), hover
 *    lights `--accent-line`.
 *  - AC-2 (structural half): the visible 1px line sits FLUSH against the side
 *    panel's edge instead of floating in the middle of the transparent hit
 *    column, so no strip of `--bg` separates the panel from the line (that strip
 *    is what read as a second bar). The visual half is a capture.
 *  - AC-4 (structural half): a collapsed sidebar / minimized Fleet rail renders
 *    no divider at all, so only the rail's own `border-l` remains.
 */

const none = (): (() => void) => () => {}
function stubApi(): void {
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
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

const FOLDER = '/repo/alpha'
let wrapper: VueWrapper | null = null

/** A session is selected and the folder's helper stack holds one pane. */
async function mountWithHelperStack(): Promise<VueWrapper> {
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
  useHelpersStore().addShellHelper(FOLDER, FOLDER)
  wrapper = mount(App, { attachTo: document.body, global: { plugins: [i18n], stubs: STUBS } })
  await flushPromises()
  return wrapper
}

const separators = (w: VueWrapper) => w.findAll('[role="separator"][aria-orientation="vertical"]')

function drag(el: Element, fromX: number, toX: number): void {
  el.dispatchEvent(new MouseEvent('mousedown', { clientX: fromX, bubbles: true, cancelable: true }))
  document.dispatchEvent(new MouseEvent('mousemove', { clientX: toX, bubbles: true }))
  document.dispatchEvent(new MouseEvent('mouseup', { clientX: toX, bubbles: true }))
}

beforeEach(() => {
  i18n.global.locale.value = 'en'
  localStorage.clear()
  setActivePinia(createPinia())
  stubApi()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('divider hit area and reset', () => {
  it('renders the sidebar, helper-stack and Fleet-rail dividers with a 6px col-resize hit area', async () => {
    const w = await mountWithHelperStack()
    const seps = separators(w)
    expect(seps).toHaveLength(3)
    for (const sep of seps) {
      expect(sep.classes()).toContain('w-1.5')
      expect(sep.classes()).toContain('cursor-col-resize')
      expect(sep.classes()).toContain('shrink-0')
    }
  })

  it('lights --accent-line on hover through the hit area (group-hover)', async () => {
    const w = await mountWithHelperStack()
    for (const sep of separators(w)) {
      expect(sep.classes()).toContain('group')
      const line = sep.get('div')
      expect(line.classes()).toEqual(
        expect.arrayContaining(['w-px', 'h-full', 'bg-border-2', 'group-hover:bg-accent-line'])
      )
    }
  })

  it('sidebar: drag resizes, double-click resets', async () => {
    const w = await mountWithHelperStack()
    const layout = useLayoutStore()
    const [sidebar] = separators(w)
    const start = layout.sidebarWidth
    drag(sidebar.element, 300, 340)
    expect(layout.sidebarWidth).toBe(start + 40)
    await sidebar.trigger('dblclick')
    expect(layout.sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT)
  })

  it('helper stack: drag resizes, double-click resets the split', async () => {
    const w = await mountWithHelperStack()
    const helpers = useHelpersStore()
    const seps = separators(w)
    const helper = seps[1]
    const start = helpers.splitRatioForCurrentWorktree
    drag(helper.element, 900, 800)
    expect(helpers.splitRatioForCurrentWorktree).toBeLessThan(start)
    await helper.trigger('dblclick')
    expect(helpers.splitRatioForCurrentWorktree).toBe(0.65)
  })

  it('Fleet rail: dragging left grows it, double-click resets', async () => {
    const w = await mountWithHelperStack()
    const layout = useLayoutStore()
    const rail = separators(w)[2]
    const start = layout.inboxRailWidth
    drag(rail.element, 1000, 960)
    expect(layout.inboxRailWidth).toBe(start + 40)
    await rail.trigger('dblclick')
    expect(layout.inboxRailWidth).toBe(INBOX_RAIL_WIDTH_DEFAULT)
  })

  it('a collapsed sidebar and a minimized Fleet rail render no divider (AC-4, structural)', async () => {
    const w = await mountWithHelperStack()
    const layout = useLayoutStore()
    layout.setSidebarCollapsed(true)
    layout.setInboxRailState('minimized')
    await flushPromises()
    // Only the helper-stack divider is left; the rail keeps its own border-l.
    expect(separators(w)).toHaveLength(1)
  })
})

describe('single edge at rest (AC-2, structural)', () => {
  it('puts the visible line flush against the side panel, never centered in the hit column', async () => {
    const w = await mountWithHelperStack()
    const [sidebar, helper, rail] = separators(w)
    // Sidebar is LEFT of its divider → the line hugs the divider's left edge.
    expect(sidebar.classes()).toContain('justify-start')
    // Helper stack and Fleet rail are RIGHT of theirs → the line hugs the right edge.
    expect(helper.classes()).toContain('justify-end')
    expect(rail.classes()).toContain('justify-end')
    for (const sep of [sidebar, helper, rail]) {
      expect(sep.classes()).not.toContain('justify-center')
    }
  })
})
