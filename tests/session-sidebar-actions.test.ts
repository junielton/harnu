// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useLayoutStore } from '../src/renderer/src/stores/layout'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import {
  useSessionActions,
  sessionActionVisible,
  forkKeysGuard,
  type SessionAction
} from '../src/renderer/src/composables/useSessionActions'
import { useSidebarActions } from '../src/renderer/src/composables/useSidebarActions'
import type { FolderEntry } from '../src/preload'

/**
 * T486 U2 — the session and sidebar actions the new keybindings run
 * (`docs/specs/T486-keybindings-coverage-pass.md` §3.2, §3.3, §3.10, §8.3).
 * The composables are the SAME functions the Session menu and the sidebar
 * header buttons call (AC-37), so these tests cover both entry points.
 */

function session(id: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId: id,
    summary: id,
    firstPrompt: '',
    modified: '2026-10-20T10:00:00.000Z',
    status: 'idle',
    taskState: 'idle',
    fullPath: `/home/u/.claude/projects/x/${id}.jsonl`,
    resumable: true,
    ...extra
  }
}

const DISK = [
  {
    path: '/repos/alpha',
    alias: 'alpha',
    gitBranch: 'main',
    sessions: [session('s-a', { projectPath: '/repos/alpha' })]
  },
  {
    path: '/repos/beta',
    alias: 'beta',
    gitBranch: 'main',
    sessions: [session('s-b', { projectPath: '/repos/beta' })]
  }
] as unknown as FolderEntry[]

function installWindow(): void {
  ;(window as unknown as { api: unknown }).api = {
    foldersLoad: vi.fn(async () => DISK),
    userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
    orchestratorListArmed: vi.fn(async () => []),
    probeGit: vi.fn(async () => []),
    getPathForFile: vi.fn(() => null)
  }
}

/** Run a composable inside a real component setup (it calls `useI18n`). */
function withSetup<T>(fn: () => T): T {
  let out!: T
  mount(
    defineComponent({
      setup() {
        out = fn()
        return () => h('div')
      }
    }),
    { global: { plugins: [i18n] } }
  )
  return out
}

/** A sidebar row the anchor lookup can find, at a fixed rect. */
function row(attr: string, rect: { left: number; top: number; bottom: number }): HTMLElement {
  const el = document.createElement('button')
  el.setAttribute('data-sidebar-row', attr)
  el.getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + 200, width: 200, height: rect.bottom - rect.top }) as DOMRect
  document.body.appendChild(el)
  return el
}

beforeEach(async () => {
  setActivePinia(createPinia())
  localStorage.clear()
  installWindow()
  await useSessionsStore().reloadModel()
})

afterEach(() => {
  ;(document.activeElement as HTMLElement | null)?.blur()
  document.body.innerHTML = ''
})

describe('sessionActionVisible — the Session menu rule the bindings share (§3.10)', () => {
  const real = { synthetic: false, live: true, taskState: undefined, shellTerminal: false }
  const synth = { ...real, synthetic: true, live: false }
  const fileBacked: SessionAction[] = [
    'fork',
    'openToSide',
    'copyId',
    'copyTranscriptPath',
    'copyResumeCommand',
    'copyContextDigest',
    'toggleArchived',
    'delete'
  ]

  it('a real session gets the file-backed actions, not Retry / Dismiss', () => {
    for (const a of fileBacked) expect(sessionActionVisible(a, real), a).toBe(true)
    expect(sessionActionVisible('retryBoot', real)).toBe(false)
    expect(sessionActionVisible('dismiss', real)).toBe(false)
  })

  it('a synthetic loses them; a failed or completed one gets Retry / Dismiss', () => {
    for (const a of [...fileBacked, 'restart' as const])
      expect(sessionActionVisible(a, synth), a).toBe(false)
    expect(sessionActionVisible('toggleNoFlicker', synth)).toBe(true)
    expect(sessionActionVisible('retryBoot', synth)).toBe(false)
    for (const taskState of ['failed', 'completed'] as const) {
      expect(sessionActionVisible('retryBoot', { ...synth, taskState })).toBe(true)
      expect(sessionActionVisible('dismiss', { ...synth, taskState })).toBe(true)
    }
  })

  it('a folder terminal has no Session menu, so no session action', () => {
    expect(sessionActionVisible('toggleNoFlicker', { ...real, shellTerminal: true })).toBe(false)
  })
})

describe('AC-32 — session.fork', () => {
  it('targets the selected session, and is unavailable with none selected', () => {
    const sessions = useSessionsStore()
    const actions = withSetup(() => useSessionActions())
    expect(actions.selectedFor('fork')).toBeNull()
    sessions.select('s-a')
    expect(actions.selectedFor('fork')).toBe('s-a')
  })

  it('forks through createForkedSession and toasts when it fails', () => {
    const sessions = useSessionsStore()
    const ui = useUiStore()
    const actions = withSetup(() => useSessionActions())
    const spy = vi.spyOn(sessions, 'createForkedSession').mockReturnValue(null)
    actions.run.fork('s-a')
    expect(spy).toHaveBeenCalledWith('s-a')
    expect(ui.toasts.at(-1)?.kind).toBe('danger')
  })

  it('its key guard yields in a text field and inside the Diagram pane', () => {
    expect(forkKeysGuard()).toBe(true)

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(forkKeysGuard()).toBe(false)

    const pane = document.createElement('div')
    pane.setAttribute('data-testid', 'diagram-pane')
    const body = document.createElement('div')
    body.tabIndex = -1
    pane.appendChild(body)
    document.body.appendChild(pane)
    body.focus()
    expect(forkKeysGuard()).toBe(false)
  })
})

describe('AC-33 — session.openToSide', () => {
  it('opens the cursor session beside the selected one through addResumeHelper', () => {
    const sessions = useSessionsStore()
    const helpers = useHelpersStore()
    const actions = withSetup(() => useSessionActions())
    const add = vi.spyOn(helpers, 'addResumeHelper').mockImplementation(() => null as never)
    sessions.select('s-a')
    sessions.keyboardCursor = { kind: 'session', id: 's-b' }
    expect(actions.openToSideTarget()).toBe('s-b')
    actions.run.openToSide(actions.openToSideTarget()!)
    expect(add).toHaveBeenCalledWith('/repos/alpha', 's-b', '/repos/beta')
  })

  it('falls back to the selected session, where the no-op rule holds', () => {
    const sessions = useSessionsStore()
    const helpers = useHelpersStore()
    const actions = withSetup(() => useSessionActions())
    const add = vi.spyOn(helpers, 'addResumeHelper')
    sessions.select('s-a')
    sessions.keyboardCursor = { kind: 'folder', id: '/repos/beta' }
    expect(actions.openToSideTarget()).toBe('s-a')
    actions.run.openToSide('s-a')
    expect(add).not.toHaveBeenCalled()
  })

  it('ignores the cursor in drill mode', () => {
    const sessions = useSessionsStore()
    const actions = withSetup(() => useSessionActions())
    sessions.select('s-a')
    sessions.keyboardCursor = { kind: 'session', id: 's-b' }
    sessions.drillDepth = 1
    expect(actions.openToSideTarget()).toBe('s-a')
  })
})

describe('AC-34 — session.contextMenu (Shift+F10)', () => {
  it('opens the Session menu for a cursor session row, anchored at its bottom-left', () => {
    const sessions = useSessionsStore()
    const ui = useUiStore()
    const actions = withSetup(() => useSessionActions())
    row('session:s-b', { left: 12, top: 100, bottom: 126 })
    sessions.keyboardCursor = { kind: 'session', id: 's-b' }
    actions.openContextMenu()
    expect(ui.menu).toMatchObject({ open: true, sessionId: 's-b', x: 12, y: 126 })
    expect(ui.folderMenu.open).toBe(false)
  })

  it('opens the Folder menu for a cursor folder row', () => {
    const sessions = useSessionsStore()
    const ui = useUiStore()
    const actions = withSetup(() => useSessionActions())
    row('folder:/repos/beta', { left: 4, top: 40, bottom: 66 })
    sessions.keyboardCursor = { kind: 'folder', id: '/repos/beta' }
    actions.openContextMenu()
    expect(ui.folderMenu).toMatchObject({ open: true, projectPath: '/repos/beta', x: 4, y: 66 })
    expect(ui.menu.open).toBe(false)
  })

  it('does nothing on a repo-group cursor row', () => {
    const sessions = useSessionsStore()
    const ui = useUiStore()
    const actions = withSetup(() => useSessionActions())
    sessions.keyboardCursor = { kind: 'group', id: 'repo:/repos/alpha' }
    expect(actions.contextMenuTarget()).toBeNull()
    // Still owned by the binding, so Chromium's synthesized contextmenu for the
    // press cannot open the menu of whichever row holds DOM focus instead.
    expect(actions.contextMenuEnabled()).toBe(true)
    actions.openContextMenu()
    const synthesized = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    window.dispatchEvent(synthesized)
    expect(synthesized.defaultPrevented).toBe(true)
    expect(ui.menu.open || ui.folderMenu.open).toBe(false)
  })

  it('falls back to the selected session, then to the active folder', () => {
    const sessions = useSessionsStore()
    const actions = withSetup(() => useSessionActions())
    sessions.select('s-a')
    expect(actions.contextMenuTarget()).toEqual({ kind: 'session', id: 's-a' })
    sessions.clearSelection()
    sessions.selectFolder('/repos/beta')
    expect(actions.contextMenuTarget()).toEqual({ kind: 'folder', id: '/repos/beta' })
  })

  it("swallows Chromium's synthesized contextmenu for the same press — one menu", () => {
    const sessions = useSessionsStore()
    const ui = useUiStore()
    const actions = withSetup(() => useSessionActions())
    // Focus sits on a DIFFERENT row than the cursor: its own contextmenu handler
    // would reopen the menu on itself.
    const focused = row('session:s-a', { left: 0, top: 0, bottom: 26 })
    const reopen = vi.fn(() => ui.openMenu({ sessionId: 's-a', x: 0, y: 0 }))
    focused.addEventListener('contextmenu', reopen)
    row('session:s-b', { left: 12, top: 100, bottom: 126 })
    sessions.keyboardCursor = { kind: 'session', id: 's-b' }

    actions.openContextMenu()
    const synthesized = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    focused.dispatchEvent(synthesized)
    expect(synthesized.defaultPrevented).toBe(true)
    expect(reopen).not.toHaveBeenCalled()
    expect(ui.menu).toMatchObject({ open: true, sessionId: 's-b' })

    // Only that one event: a later right-click works as before.
    focused.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    expect(reopen).toHaveBeenCalledTimes(1)
  })

  it('never swallows a mouse right-click, even inside the window (no synthesized event on macOS)', () => {
    const sessions = useSessionsStore()
    const ui = useUiStore()
    const actions = withSetup(() => useSessionActions())
    const focused = row('session:s-a', { left: 0, top: 0, bottom: 26 })
    const reopen = vi.fn(() => ui.openMenu({ sessionId: 's-a', x: 0, y: 0 }))
    focused.addEventListener('contextmenu', reopen)
    row('session:s-b', { left: 12, top: 100, bottom: 126 })
    sessions.keyboardCursor = { kind: 'session', id: 's-b' }

    actions.openContextMenu()
    // A real right-click right after the press: button 2, not keyboard-made.
    const click = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    focused.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
    expect(reopen).toHaveBeenCalledTimes(1)

    // The keyboard-made twin (button -1) is still swallowed if it arrives late.
    const synthesized = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: -1
    })
    focused.dispatchEvent(synthesized)
    expect(synthesized.defaultPrevented).toBe(true)
    expect(reopen).toHaveBeenCalledTimes(1)
  })
})

describe('sidebar.hiddenFolders', () => {
  it('is unavailable while the filter bar replaces the header toolbar (no button to anchor to)', () => {
    const sessions = useSessionsStore()
    const sidebar = withSetup(() => useSidebarActions())
    expect(sidebar.hiddenFoldersAvailable()).toBe(true)
    sessions.setFilterActive(true)
    expect(sidebar.hiddenFoldersAvailable()).toBe(false)
    sessions.setFilterActive(false)
    expect(sidebar.hiddenFoldersAvailable()).toBe(true)
  })

  it('is the enabled() of its App.vue registration', () => {
    const src = readFileSync(resolve(__dirname, '../src/renderer/src/App.vue'), 'utf8')
    const start = src.indexOf("id: 'sidebar.hiddenFolders'")
    const reg = src.slice(start, src.indexOf("id: '", start + 5))
    expect(reg).toContain('enabled: sidebarActions.hiddenFoldersAvailable')
  })
})

describe('AC-15 — sidebar.jump', () => {
  it('toggles the jump palette like the search button', () => {
    const ui = useUiStore()
    const sidebar = withSetup(() => useSidebarActions())
    sidebar.toggleJump()
    expect(ui.sidebarJumpPalette.open).toBe(true)
    sidebar.toggleJump()
    expect(ui.sidebarJumpPalette.open).toBe(false)
  })

  it('expands a collapsed sidebar first, and closing does not re-collapse it', () => {
    const ui = useUiStore()
    const layout = useLayoutStore()
    const sidebar = withSetup(() => useSidebarActions())
    layout.setSidebarCollapsed(true)
    sidebar.toggleJump()
    expect(layout.sidebarCollapsed).toBe(false)
    expect(ui.sidebarJumpPalette.open).toBe(true)
    sidebar.toggleJump()
    expect(layout.sidebarCollapsed).toBe(false)
  })

  it('has no keysGuard, so the second press closes it from the palette input', () => {
    const src = readFileSync(resolve(__dirname, '../src/renderer/src/App.vue'), 'utf8')
    const start = src.indexOf("id: 'sidebar.jump'")
    const reg = src.slice(start, src.indexOf("id: '", start + 5))
    expect(reg).toContain('sidebarActions.toggleJump()')
    expect(reg).not.toContain('keysGuard')
  })
})
