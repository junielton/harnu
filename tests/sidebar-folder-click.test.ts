// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import SidebarFolder from '../src/renderer/src/components/SidebarFolder.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { i18n } from '@renderer/i18n'

/**
 * T212 — clicking a folder row is symmetric with clicking a session row: it
 * SELECTS (opening `FolderView`). It also expands on the way in, so the click
 * keeps its old meaning too; a second click only collapses and never drops the
 * selection.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const folder: any = {
  path: '/repo/alpha',
  alias: 'alpha',
  expanded: false,
  sessions: []
}

function mountRow() {
  return mount(SidebarFolder, {
    props: { folder },
    global: { plugins: [i18n] }
  })
}

describe('sidebar folder row click', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    folder.expanded = false
    const store = useSessionsStore()
    store.folders.splice(0, store.folders.length, folder)
  })

  it('first click selects the folder and expands it', async () => {
    const store = useSessionsStore()
    const wrapper = mountRow()

    await wrapper.get('button').trigger('click')

    expect(store.selectedFolderPath).toBe('/repo/alpha')
    expect(folder.expanded).toBe(true)
  })

  it('second click collapses but keeps the folder selected', async () => {
    const store = useSessionsStore()
    const wrapper = mountRow()

    await wrapper.get('button').trigger('click')
    await wrapper.get('button').trigger('click')

    expect(folder.expanded).toBe(false)
    expect(store.selectedFolderPath).toBe('/repo/alpha')
  })
})
