// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import App from '../src/renderer/src/App.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { i18n } from '@renderer/i18n'

/**
 * BUG-103 — a queued agent boot can only drain while `TerminalPane` is
 * mounted, and every one of the seven main-pane takeovers used to outrank it
 * in an `App.vue` `v-else-if` chain: opening one (with nothing selected, or
 * even with a session selected) made the component — and the background
 * `sessions.agentBootQueue` / `sessions.sessionWakeQueue` watchers it owns —
 * cease to exist until the operator dismissed the takeover.
 *
 * The fix renders `TerminalPane` UNCONDITIONALLY in `App.vue`, absolutely
 * positioned behind whichever view is foreground (`showTerminalForeground`).
 * `TerminalPane.vue` itself needed no change — its own `onMounted`/`watch`
 * pair (BUG-23) already exist; the bug was purely that App.vue tore the whole
 * component down before those had a chance to run. `TerminalPane.vue`'s own
 * PTY-spawning internals are env-bound (xterm + `ptyCreate`) and stay outside
 * unit-test scope per this repo's pure-core/thin-shell convention (see
 * `tests/agent-boot-queue.test.ts`'s own docblock) — these tests instead pin
 * the actual root cause: whether the component is mounted at all.
 */

function on(): () => (cb: (...a: unknown[]) => void) => () => void {
  return () => () => () => {}
}

function mockApi(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = {
    setAttentionBadge: vi.fn(),
    onUpdateDownloaded: on(),
    onUpdateError: on(),
    onUpdateManualAvailable: on(),
    onClaudeChangelogActivate: on(),
    onClaudeChangelogUpdated: on(),
    onClaudeChangelogNewVersion: on(),
    claudeChangelogGet: vi
      .fn()
      .mockResolvedValue({ releases: [], lastReadVersion: '', lastFetchedAt: 0 }),
    claudeChangelogMarkRead: vi.fn(),
    claudeChangelogRefresh: vi.fn(),
    claudeChangelogOpenExternal: vi.fn(),
    shellOpenExternal: vi.fn(),
    updaterInstallAndRestart: vi.fn(),
    onShortcut: on(),
    helpersGet: vi.fn().mockResolvedValue(null)
  }
}

// Stub every child so only App.vue's own template/computed logic runs for
// real. `TerminalPane` is stubbed too — these tests are about whether Vue
// renders it at all and how App.vue's wrapper marks its visibility, not about
// its xterm/PTY internals (out of scope here, see the file docblock above).
const STUB_ALL = {
  Sidebar: true,
  Topbar: true,
  StatusFooter: true,
  EmptyState: true,
  FolderView: true,
  CloudSessionPanel: true,
  Onboarding: true,
  TakeoverHost: true,
  InboxRail: true,
  HelperStack: true,
  TerminalPane: true,
  SessionPreview: true,
  FolderPreview: true,
  SessionMenu: true,
  FolderMenu: true,
  SidebarHiddenPopover: true,
  AddFolderDialog: true,
  SettingsDialog: true,
  ClaudeBootDialog: true,
  NewSessionDialog: true,
  RemoveWorktreeDialog: true,
  NewWorktreeDialog: true,
  NewFolderDialog: true,
  OpenSubfolderDialog: true,
  RenameFolderDialog: true,
  RenameRepoDialog: true,
  MemoryLocationDialog: true,
  CommandPalette: true,
  McpConfirmOverlay: true,
  ToastStack: true
}

function mountApp() {
  return mount(App, { global: { plugins: [i18n], stubs: STUB_ALL } })
}

function seedFolder(store: ReturnType<typeof useSessionsStore>): void {
  store.folders.push({
    path: '/repo/alpha',
    alias: 'alpha',
    expanded: false,
    sessions: [
      {
        sessionId: 's1',
        projectPath: '/repo/alpha',
        summary: 'First',
        firstPrompt: 'First',
        modified: new Date().toISOString()
      }
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
}

function terminalHost(wrapper: ReturnType<typeof mountApp>) {
  return wrapper.find('[data-test="terminal-pane-host"]')
}

/**
 * jsdom does not implement the `inert` IDL property at all (verified: it's
 * `undefined` on every element, and `.focus()` on a descendant of an inert
 * ancestor is NOT blocked) — so Vue's runtime falls back to its generic
 * attribute-patching path here instead of the native boolean-property path a
 * real Chromium takes, and always renders the attribute with a literal
 * `"true"`/`"false"` string value rather than adding/removing it. `isInert`
 * reads that string, which is the only signal jsdom actually gives us; it is
 * NOT proof that jsdom enforces the Tab-exclusion or focus/AT-tree removal
 * `inert` provides — only that `App.vue` asks for it. The real enforcement
 * is Chromium-native behavior, out of unit-test scope for the same reason
 * ADR-0001 keeps xterm/PTY specifics e2e-only (see this file's docblock).
 */
function isInert(host: ReturnType<typeof terminalHost>): boolean {
  return host.attributes('inert') === 'true'
}

function isHidden(host: ReturnType<typeof terminalHost>): boolean {
  return host.classes('invisible') && host.classes('pointer-events-none') && isInert(host)
}

type UiStore = ReturnType<typeof useUiStore>

const TAKEOVERS: { name: string; open: (ui: UiStore) => void }[] = [
  { name: 'roadmap board', open: (ui) => ui.openRoadmap('/repo/alpha', 'alpha') },
  { name: 'PR Stack canvas', open: (ui) => ui.openPrStack('/repo/alpha', 'alpha') },
  { name: 'cleanup', open: (ui) => ui.openCleanup() },
  { name: 'usage dashboard', open: (ui) => ui.openUsageDashboard() },
  { name: 'system monitor', open: (ui) => ui.openSystemMonitor() },
  { name: 'review', open: (ui) => ui.openReview('/repo/alpha') },
  { name: 'scheduler', open: (ui) => ui.openScheduler() }
]

describe('BUG-103: TerminalPane renders unconditionally regardless of the active view', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockApi()
  })

  it.each(TAKEOVERS)(
    'AC-1: the $name takeover still mounts TerminalPane, merely hidden',
    async ({ open }) => {
      const store = useSessionsStore()
      const ui = useUiStore()
      seedFolder(store)
      const wrapper = mountApp()

      open(ui)
      await wrapper.vm.$nextTick()

      const host = terminalHost(wrapper)
      expect(host.exists()).toBe(true)
      expect(isHidden(host)).toBe(true)
    }
  )

  it.each(TAKEOVERS)(
    'AC-1: the $name takeover hides TerminalPane even with a session already selected',
    async ({ open }) => {
      const store = useSessionsStore()
      const ui = useUiStore()
      seedFolder(store)
      store.select('s1')
      const wrapper = mountApp()

      open(ui)
      await wrapper.vm.$nextTick()

      const host = terminalHost(wrapper)
      expect(host.exists()).toBe(true)
      expect(isHidden(host)).toBe(true)
    }
  )

  it('with no takeover, no folder, and a session selected, TerminalPane is the visible foreground', async () => {
    const store = useSessionsStore()
    seedFolder(store)
    store.select('s1')
    const wrapper = mountApp()
    await wrapper.vm.$nextTick()

    const host = terminalHost(wrapper)
    expect(host.exists()).toBe(true)
    expect(isHidden(host)).toBe(false)
  })

  it('the Folder View also hides TerminalPane without unmounting it', async () => {
    const store = useSessionsStore()
    seedFolder(store)
    store.select('s1')
    const wrapper = mountApp()

    store.selectFolder('/repo/alpha')
    await wrapper.vm.$nextTick()

    const host = terminalHost(wrapper)
    expect(host.exists()).toBe(true)
    expect(isHidden(host)).toBe(true)
  })

  it('TerminalPane is mounted (hidden) even during Onboarding, with zero folders', async () => {
    const wrapper = mountApp()
    await wrapper.vm.$nextTick()

    const host = terminalHost(wrapper)
    expect(host.exists()).toBe(true)
    expect(isHidden(host)).toBe(true)
  })

  /**
   * AC-4 — the exact reported regression: a takeover is open, nothing is
   * selected, and an MCP `create_session` (`insertAgentSession`) lands. Before
   * BUG-103, `TerminalPane` (and the `agentBootQueue` watcher it owns) simply
   * didn't exist in this state, so the boot it queues could never drain. Now
   * the host stays mounted throughout, so the watcher is there to consume it.
   */
  it('AC-4: takeover open + nothing selected + insertAgentSession — TerminalPane stays mounted to drain the queued boot', async () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)
    const wrapper = mountApp()

    ui.openCleanup()
    await wrapper.vm.$nextTick()
    expect(store.selectedId).toBeNull()

    store.insertAgentSession({
      syntheticId: 'synthetic-agent-1',
      correlationId: 'corr-1',
      folderPath: '/repo/alpha'
    })
    await wrapper.vm.$nextTick()

    // T78: idle selection is grabbed so the queue has a mounted consumer.
    expect(store.selectedId).toBe('synthetic-agent-1')
    // Still queued and untouched by the host being covered/inert —
    // `drainBgBoot` (tests/agent-boot-queue.test.ts) reads only
    // `sessions.agentBootQueue` / `termEl.value`, never `document.activeElement`
    // or any focus/visibility state, so a covered, inert host cannot block it.
    expect(store.agentBootQueue).toEqual(['synthetic-agent-1'])
    // AC-3: the grab must never close the takeover the operator is looking at.
    expect(ui.anyTakeoverOpen).toBe(true)
    // The actual fix: the host — and therefore the watcher draining the
    // queue — is still in the tree, merely hidden behind the open takeover.
    const host = terminalHost(wrapper)
    expect(host.exists()).toBe(true)
    expect(isHidden(host)).toBe(true)
  })

  it('AC-3: insertAgentSession with a session already selected never moves selection or closes the takeover', async () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)
    store.select('s1')
    const wrapper = mountApp()

    ui.openRoadmap('/repo/alpha', 'alpha')
    await wrapper.vm.$nextTick()

    store.insertAgentSession({
      syntheticId: 'synthetic-agent-2',
      correlationId: 'corr-2',
      folderPath: '/repo/alpha'
    })
    await wrapper.vm.$nextTick()

    expect(store.selectedId).toBe('s1')
    expect(ui.anyTakeoverOpen).toBe(true)
    const host = terminalHost(wrapper)
    expect(host.exists()).toBe(true)
    expect(isHidden(host)).toBe(true)
  })

  /**
   * A focused xterm helper textarea used to lose DOM focus for free whenever
   * `TerminalPane` unmounted (opening a takeover). Now that it merely goes
   * invisible instead, App.vue's own `watch(showTerminalForeground, …)` has
   * to blur it explicitly — otherwise a covered-but-still-mounted terminal
   * would keep receiving keystrokes the operator thinks are going to the
   * takeover on top of it.
   */
  it('opening a takeover blurs a focused xterm element instead of leaving it silently focused', async () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)
    store.select('s1')
    const wrapper = mount(App, {
      attachTo: document.body,
      global: {
        plugins: [i18n],
        stubs: {
          ...STUB_ALL,
          TerminalPane: {
            template: '<div class="xterm"><textarea class="xterm-helper-textarea" /></div>'
          }
        }
      }
    })
    await wrapper.vm.$nextTick()

    const textarea = wrapper.find('.xterm-helper-textarea')
    ;(textarea.element as HTMLTextAreaElement).focus()
    expect(document.activeElement).toBe(textarea.element)

    ui.openCleanup()
    await wrapper.vm.$nextTick()

    expect(document.activeElement).not.toBe(textarea.element)
    wrapper.unmount()
  })

  /**
   * Tab-order exclusion (companion to the AC-1 hidden-layer assertions
   * above). Before BUG-103, a covered terminal was unmounted, so Tab could
   * never reach it at all. `invisible pointer-events-none aria-hidden` alone
   * would NOT have closed that gap — none of the three affects sequential
   * focus navigation — which is why the host also carries `:inert`. See
   * `isInert`'s docblock: jsdom doesn't implement `inert` at all, so this
   * asserts the attribute App.vue actually sets (the real enforcement
   * mechanism), not a simulated Tab press — a jsdom keypress-based test
   * would pass unconditionally here regardless of whether `inert` were wired
   * up correctly, which is exactly the false-green failure mode ADR-0001
   * warns about.
   */
  it.each(TAKEOVERS)(
    'the $name takeover makes the covered terminal inert, not just invisible',
    async ({ open }) => {
      const store = useSessionsStore()
      const ui = useUiStore()
      seedFolder(store)
      store.select('s1')
      const wrapper = mountApp()

      expect(isInert(terminalHost(wrapper))).toBe(false)

      open(ui)
      await wrapper.vm.$nextTick()

      expect(isInert(terminalHost(wrapper))).toBe(true)
    }
  )

  it('dismissing the takeover lifts inert and restores the terminal as the interactive foreground', async () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    seedFolder(store)
    store.select('s1')
    const wrapper = mountApp()

    ui.openCleanup()
    await wrapper.vm.$nextTick()
    let host = terminalHost(wrapper)
    expect(isHidden(host)).toBe(true)
    expect(isInert(host)).toBe(true)

    ui.closeAllTakeovers()
    await wrapper.vm.$nextTick()

    // Same host element throughout — App.vue never re-mounts TerminalPane to
    // cover/uncover it, only this wrapper's `:inert`/visibility attributes
    // flip. Nothing about TerminalPane's own xterm/PTY lifecycle is touched
    // by the transition, so there is no teardown-and-rebuild step here for
    // the terminal to recover from.
    host = terminalHost(wrapper)
    expect(host.exists()).toBe(true)
    expect(isHidden(host)).toBe(false)
    expect(isInert(host)).toBe(false)
  })
})
