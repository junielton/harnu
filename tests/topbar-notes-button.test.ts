// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import Topbar from '../src/renderer/src/components/Topbar.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useKeybindingsStore } from '../src/renderer/src/stores/keybindings'
import { i18n } from '@renderer/i18n'
import en from '../src/renderer/src/i18n/en.json'

/**
 * Quick notes (spec G1, G3, §6.3) — one notebook button beside Browse files. A click is today's note;
 * a right-click is the "All notes…" picker. Its tooltip carries the CURRENT binding of both commands.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const folder: any = {
  path: '/repo/alpha',
  alias: 'alpha',
  expanded: true,
  gitBranch: 'main',
  sessions: []
}

function mountTopbar() {
  return mount(Topbar, { attachTo: document.body, global: { plugins: [i18n] } })
}

describe('topbar notes button', () => {
  const notesOpen = vi.fn()

  beforeEach(() => {
    document.body.innerHTML = ''
    i18n.global.locale.value = 'en'
    localStorage.clear()
    setActivePinia(createPinia())
    const store = useSessionsStore()
    store.folders.splice(0, store.folders.length, folder)
    store.selectFolder('/repo/alpha')
    notesOpen
      .mockReset()
      .mockResolvedValue({ ok: true, filePath: '/repo/.harnu/notes/x.md', created: false })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = {
      openPath: vi.fn(),
      openInEditor: vi.fn(),
      githubPullsUrl: vi.fn().mockResolvedValue(null),
      shellOpenExternal: vi.fn(),
      keybindingsSave: vi.fn(async () => undefined),
      notesOpen
    }
  })

  it('sits right after Browse files, labelled and carrying both chords in its tooltip', () => {
    const wrapper = mountTopbar()
    const button = wrapper.get('[data-test="topbar-notes"]')
    expect(wrapper.get('[data-test="topbar-explorer"]').element.nextElementSibling).toBe(
      button.element
    )
    expect(button.attributes('aria-label')).toBe(en.topbar.notes)
    const title = button.attributes('title')!
    expect(title).toContain(`${en.topbar.notes} (Ctrl+Shift+N)`)
    expect(title).toContain('(Ctrl+Alt+N)')
    expect(title).toContain(en.topbar.notesAll)
  })

  it('shows the CURRENT binding after a rebind, and none once unbound', async () => {
    const kb = useKeybindingsStore()
    const wrapper = mountTopbar()
    await kb.setBinding('notes.openToday', 'Cmd+Alt+J')
    await flushPromises()
    expect(wrapper.get('[data-test="topbar-notes"]').attributes('title')).toContain(
      `${en.topbar.notes} (Ctrl+Alt+J)`
    )
    expect(wrapper.get('[data-test="topbar-notes"]').attributes('title')).not.toContain(
      'Ctrl+Shift+N'
    )
    await kb.setBinding('notes.openToday', null)
    await flushPromises()
    expect(wrapper.get('[data-test="topbar-notes"]').attributes('title')).not.toContain(
      `${en.topbar.notes} (`
    )
  })

  it("a click opens today's note in the helper stack", async () => {
    const add = vi.spyOn(useHelpersStore(), 'addMarkdownHelper').mockReturnValue('h-1')
    const wrapper = mountTopbar()
    await wrapper.get('[data-test="topbar-notes"]').trigger('click')
    await flushPromises()
    expect(notesOpen).toHaveBeenCalledWith('/repo/alpha', undefined)
    expect(add).toHaveBeenCalledTimes(1)
  })

  it('a right-click opens the All notes picker for the folder, without opening today’s note', async () => {
    const ui = useUiStore()
    const open = vi.spyOn(ui, 'openNotesPicker')
    const wrapper = mountTopbar()
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    wrapper.get('[data-test="topbar-notes"]').element.dispatchEvent(ev)
    await flushPromises()
    expect(ev.defaultPrevented).toBe(true)
    expect(open).toHaveBeenCalledWith('/repo/alpha')
    expect(notesOpen).not.toHaveBeenCalled()
  })
})
