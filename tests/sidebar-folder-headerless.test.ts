// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import SidebarFolder from '../src/renderer/src/components/SidebarFolder.vue'
import type { Folder } from '../src/renderer/src/stores/sessions'

function makeFolder(over: Partial<Folder> = {}): Folder {
  return {
    path: '/repos/alpha',
    alias: 'alpha',
    gitBranch: '',
    sessions: [],
    expanded: false,
    pinned: false,
    ...over
  } as Folder
}

describe('SidebarFolder headerless prop', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders no folder-row button when headerless, even while folder.expanded is false', () => {
    const folder = makeFolder({ expanded: false })
    const w = mount(SidebarFolder, {
      props: { folder, headerless: true },
      global: { plugins: [i18n] }
    })
    expect(w.find('button.sidebar-row').exists()).toBe(false)
  })

  it('still renders the folder-row button when headerless is unset (default false)', () => {
    const folder = makeFolder({ expanded: false })
    const w = mount(SidebarFolder, {
      props: { folder },
      global: { plugins: [i18n] }
    })
    expect(w.find('button.sidebar-row').exists()).toBe(true)
  })

  it('renders its session rows when headerless, even though folder.expanded is false', () => {
    const folder = makeFolder({
      expanded: false,
      sessions: [
        {
          sessionId: 's1',
          summary: 'one',
          firstPrompt: '',
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          status: 'idle',
          isSidechain: false,
          resumable: true,
          bridged: false,
          synthetic: false,
          isShellTerminal: false
        } as Folder['sessions'][number]
      ]
    })
    const w = mount(SidebarFolder, {
      props: { folder, headerless: true },
      global: { plugins: [i18n] }
    })
    expect(w.find('[data-session-id="s1"]').exists()).toBe(true)
  })
})
