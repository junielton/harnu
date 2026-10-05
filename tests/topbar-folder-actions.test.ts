// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import Topbar from '../src/renderer/src/components/Topbar.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { i18n } from '@renderer/i18n'

/**
 * T212 — the Topbar's folder-scoped actions (Roadmap, PR Stack, Open folder, VS
 * Code, Browse files, shell) used to be gated behind a SELECTED SESSION even
 * though every one of them only needs a folder path. With a folder selected and
 * no session, they must be present and must act on that folder.
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
  return mount(Topbar, { global: { plugins: [i18n] } })
}

describe('topbar with a folder selected', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const store = useSessionsStore()
    store.folders.splice(0, store.folders.length, folder)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = {
      openPath: vi.fn(),
      openInVSCode: vi.fn(),
      githubPullsUrl: vi.fn().mockResolvedValue(null),
      shellOpenExternal: vi.fn()
    }
  })

  it('shows the roadmap button and opens the board for that folder', async () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    store.selectFolder('/repo/alpha')

    const wrapper = mountTopbar()
    await wrapper.get('[data-test="topbar-roadmap"]').trigger('click')

    expect(ui.roadmap.open).toBe(true)
    expect(ui.roadmap.folderPath).toBe('/repo/alpha')
  })

  it('opens the folder in the OS file manager', async () => {
    const store = useSessionsStore()
    store.selectFolder('/repo/alpha')

    const wrapper = mountTopbar()
    await wrapper.get('[data-test="topbar-open-folder"]').trigger('click')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).api.openPath).toHaveBeenCalledWith('/repo/alpha')
  })

  it('shows the folder name in the breadcrumb and no editable session title', () => {
    const store = useSessionsStore()
    store.selectFolder('/repo/alpha')

    const wrapper = mountTopbar()

    expect(wrapper.text()).toContain('alpha')
    expect(wrapper.find('[contenteditable="true"]').exists()).toBe(false)
  })

  it('offers a new-session button only in the folder branch', async () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    store.selectFolder('/repo/alpha')

    const wrapper = mountTopbar()
    await wrapper.get('[data-test="topbar-new-session"]').trigger('click')

    expect(ui.dialog).toBe('newSession')
    expect(ui.newSessionPath).toBe('/repo/alpha')
  })

  it('opens the GitHub pull requests page when origin is on GitHub', async () => {
    const store = useSessionsStore()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).api
    api.githubPullsUrl.mockResolvedValue('https://github.com/acme/alpha/pulls')
    store.selectFolder('/repo/alpha')

    const wrapper = mountTopbar()
    await flushPromises()
    await wrapper.get('[data-test="topbar-github-pulls"]').trigger('click')

    expect(api.githubPullsUrl).toHaveBeenCalledWith('/repo/alpha')
    expect(api.shellOpenExternal).toHaveBeenCalledWith('https://github.com/acme/alpha/pulls')
  })

  it('hides the GitHub pull requests button without a GitHub origin', async () => {
    const store = useSessionsStore()
    store.selectFolder('/repo/alpha')

    const wrapper = mountTopbar()
    await flushPromises()

    expect(wrapper.find('[data-test="topbar-github-pulls"]').exists()).toBe(false)
  })

  it('shows no folder actions when nothing at all is selected', () => {
    const wrapper = mountTopbar()
    expect(wrapper.find('[data-test="topbar-roadmap"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="topbar-review"]').exists()).toBe(false)
  })
})

describe('topbar takeover active state with a folder selected', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const store = useSessionsStore()
    store.folders.splice(0, store.folders.length, folder)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = {
      openPath: vi.fn(),
      openInVSCode: vi.fn(),
      githubPullsUrl: vi.fn().mockResolvedValue(null),
      shellOpenExternal: vi.fn()
    }
  })

  /**
   * T212 regression: the active-state computeds must resolve from the ACTIVE
   * FOLDER. Keyed off `selectedSession` they stay false whenever a folder (not a
   * session) is selected — the button would sit dark while its own board is open.
   */
  it('lights the roadmap button when the board is open for the selected folder', async () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    store.selectFolder('/repo/alpha')

    const wrapper = mountTopbar()
    await wrapper.get('[data-test="topbar-roadmap"]').trigger('click')

    expect(ui.roadmap.open).toBe(true)
    expect(wrapper.get('[data-test="topbar-roadmap"]').attributes('aria-pressed')).toBe('true')
  })

  it('lights the PR stack button when its canvas is open for the selected folder', async () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    store.selectFolder('/repo/alpha')

    const wrapper = mountTopbar()
    await wrapper.get('[data-test="topbar-pr-stack"]').trigger('click')

    expect(ui.prStack.open).toBe(true)
    expect(wrapper.get('[data-test="topbar-pr-stack"]').attributes('aria-pressed')).toBe('true')
  })

  /**
   * T164 / PRD §9 Q3 — the review pane's topbar entry point. Same three
   * properties as its two neighbours: it TOGGLES (a button that opens a view
   * closes it), it carries `aria-pressed`, and its active state resolves from
   * the ACTIVE FOLDER so it lights with a folder — not a session — selected.
   */
  it('toggles the review pane for the selected folder and lights while open', async () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    store.selectFolder('/repo/alpha')

    const wrapper = mountTopbar()
    const button = (): ReturnType<typeof wrapper.get> => wrapper.get('[data-test="topbar-review"]')

    expect(button().attributes('aria-pressed')).toBe('false')

    await button().trigger('click')
    expect(ui.review.open).toBe(true)
    expect(ui.review.folderPath).toBe('/repo/alpha')
    // No card slug from here: the topbar knows a folder, not a binding.
    expect(ui.review.cardSlug).toBe(null)
    expect(button().attributes('aria-pressed')).toBe('true')

    await button().trigger('click')
    expect(ui.review.open).toBe(false)
    expect(button().attributes('aria-pressed')).toBe('false')
  })

  it('stays dark while ANOTHER folder is under review, and switches to this one', async () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    store.selectFolder('/repo/alpha')
    ui.openReview('/repo/beta')

    const wrapper = mountTopbar()
    const button = (): ReturnType<typeof wrapper.get> => wrapper.get('[data-test="topbar-review"]')
    expect(button().attributes('aria-pressed')).toBe('false')

    await button().trigger('click')
    expect(ui.review.folderPath).toBe('/repo/alpha')
    expect(button().attributes('aria-pressed')).toBe('true')
  })

  it('closes any other takeover when the review pane opens', async () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    store.selectFolder('/repo/alpha')

    const wrapper = mountTopbar()
    await wrapper.get('[data-test="topbar-pr-stack"]').trigger('click')
    await wrapper.get('[data-test="topbar-review"]').trigger('click')

    expect(ui.review.open).toBe(true)
    expect(ui.prStack.open).toBe(false)
  })
})
