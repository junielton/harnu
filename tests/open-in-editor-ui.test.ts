// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import Topbar from '../src/renderer/src/components/Topbar.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useSettingsStore } from '../src/renderer/src/stores/settings'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { resolveSpawnSpec } from '../src/renderer/src/components/spawn-spec'
import { i18n } from '@renderer/i18n'

/**
 * T581 — the Topbar "Open in {editor}" button: its icon, tooltip and aria label
 * follow the configured editor (AC-1, AC-2), a missing binary is a toast (AC-5)
 * and a terminal editor lands in a shell pane running the command (AC-3).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const folder: any = {
  path: '/repo/alpha',
  alias: 'alpha',
  expanded: true,
  gitBranch: 'main',
  sessions: []
}

const openInEditor = vi.fn()

function mountTopbar() {
  return mount(Topbar, { global: { plugins: [i18n] } })
}

beforeEach(() => {
  setActivePinia(createPinia())
  useSessionsStore().folders.splice(0, 1e6, folder)
  folder.sessions = []
  openInEditor.mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = {
    openPath: vi.fn(),
    openInEditor,
    githubPullsUrl: vi.fn().mockResolvedValue(null),
    shellOpenExternal: vi.fn()
  }
  useSessionsStore().selectFolder('/repo/alpha')
})

describe('editor button', () => {
  it('defaults to VS Code: its mark, "Open in VS Code" tooltip and label (AC-1)', () => {
    const btn = mountTopbar().get('[data-test="topbar-editor"]')
    expect(btn.attributes('aria-label')).toBe('Open in VS Code')
    expect(btn.attributes('title')).toContain('Open in VS Code')
    expect(btn.get('[data-test="editor-mark"]').attributes('data-editor')).toBe('vscode')
    expect(btn.get('path').attributes('d')?.length).toBeGreaterThan(20)
  })

  it('a different preset changes the mark, tooltip and label (AC-2)', async () => {
    const wrapper = mountTopbar()
    useSettingsStore().setEditor({ id: 'cursor' })
    await flushPromises()
    const btn = wrapper.get('[data-test="topbar-editor"]')
    expect(btn.attributes('aria-label')).toBe('Open in Cursor')
    expect(btn.get('[data-test="editor-mark"]').attributes('data-editor')).toBe('cursor')
  })

  it('every preset renders its own mark', async () => {
    const wrapper = mountTopbar()
    const seen = new Set<string>()
    for (const id of ['vscode', 'cursor', 'zed', 'sublime', 'jetbrains', 'neovim', 'helix']) {
      useSettingsStore().setEditor({ id })
      await flushPromises()
      const path = wrapper.get('[data-test="topbar-editor"] [data-test="editor-mark"] path')
      seen.add(path.attributes('d') ?? '')
    }
    expect(seen.size).toBe(7)
  })

  it('a custom editor keeps the generic <> icon and reads "Open in editor"', async () => {
    const wrapper = mountTopbar()
    useSettingsStore().setEditor({ id: 'custom', customCommand: 'foo {path}' })
    await flushPromises()
    const btn = wrapper.get('[data-test="topbar-editor"]')
    expect(btn.attributes('aria-label')).toBe('Open in editor')
    expect(btn.find('[data-test="editor-mark"]').exists()).toBe(false)
    expect(btn.find('[data-test="editor-mark-generic"]').exists()).toBe(true)
  })

  it('clicking launches the active folder through the editor channel', async () => {
    openInEditor.mockResolvedValue({ ok: true, mode: 'gui' })
    await mountTopbar().get('[data-test="topbar-editor"]').trigger('click')
    expect(openInEditor).toHaveBeenCalledWith('/repo/alpha')
  })
})

describe('failures and terminal mode', () => {
  it('a missing binary shows an actionable toast naming the command and the setting (AC-5)', async () => {
    openInEditor.mockResolvedValue({
      ok: false,
      code: 'not-found',
      name: 'Cursor',
      editorId: 'cursor',
      command: 'cursor',
      error: 'x'
    })
    await mountTopbar().get('[data-test="topbar-editor"]').trigger('click')
    await flushPromises()
    const toast = useUiStore().toasts[0]
    expect(toast.kind).toBe('danger')
    expect(toast.title).toBe("Couldn't open Cursor")
    expect(toast.description).toContain('`cursor` not found on PATH')
    expect(toast.description).toContain('Settings → General → Editor')
  })

  it('VS Code keeps its "Install code command" hint (AC-5)', async () => {
    openInEditor.mockResolvedValue({
      ok: false,
      code: 'not-found',
      name: 'VS Code',
      editorId: 'vscode',
      command: 'code',
      error: 'x'
    })
    await mountTopbar().get('[data-test="topbar-editor"]').trigger('click')
    await flushPromises()
    expect(useUiStore().toasts[0].description).toContain("Install 'code' command in PATH")
  })

  it('a terminal editor opens a shell pane running the command in the folder stack (AC-3)', async () => {
    openInEditor.mockResolvedValue({
      ok: true,
      mode: 'terminal',
      name: 'Neovim',
      cmd: 'nvim',
      args: ['/repo/alpha']
    })
    const sessions = useSessionsStore()
    const entry = {
      sessionId: 's1',
      fullPath: '/x/s1.jsonl',
      projectPath: '/repo/alpha',
      status: 'active'
    }
    // Through the store, so the push is reactive (the raw `folder` is not).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessions.folders[0].sessions = [entry as any]
    sessions.select('s1')
    await mountTopbar().get('[data-test="topbar-editor"]').trigger('click')
    await flushPromises()
    const panes = useHelpersStore().byWorktree.get('/repo/alpha')?.panes ?? []
    expect(panes).toHaveLength(1)
    expect(panes[0]).toMatchObject({
      type: 'shell',
      cwd: '/repo/alpha',
      payload: { cmd: 'nvim', args: ['/repo/alpha'] }
    })
  })

  it('with only a folder selected, the terminal editor opens as a folder terminal (AC-3)', async () => {
    openInEditor.mockResolvedValue({
      ok: true,
      mode: 'terminal',
      name: 'Helix',
      cmd: 'hx',
      args: ['/repo/alpha']
    })
    await mountTopbar().get('[data-test="topbar-editor"]').trigger('click')
    await flushPromises()
    const term = folder.sessions.find((s: { isShellTerminal?: boolean }) => s.isShellTerminal)
    expect(term?.shellCommand).toEqual({ cmd: 'hx', args: ['/repo/alpha'] })
    expect(resolveSpawnSpec(term, term.sessionId)).toEqual({
      kind: 'shell',
      cmd: 'hx',
      args: ['/repo/alpha']
    })
  })
})
