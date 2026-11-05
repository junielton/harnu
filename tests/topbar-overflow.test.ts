// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import Topbar from '../src/renderer/src/components/Topbar.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useKeybindingsStore } from '../src/renderer/src/stores/keybindings'
import { i18n } from '@renderer/i18n'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'
import {
  TOPBAR_BAR_ORDER,
  TOPBAR_MIN_TITLE_PX,
  type TopbarActionId
} from '../src/renderer/src/lib/topbar-overflow'

/**
 * BUG-252 — the Topbar overflow menu (design.md §6 "Topbar overflow"). jsdom has no layout, so the
 * header's width is a number this test owns and a fake ResizeObserver delivers it.
 *
 * In the folder view with no branch badge the cluster budget is `headerWidth − 200`, and one slot
 * (an action, or the `…` button) takes 28px: `widthFor(n)` is the header width that holds n slots.
 */

const widthFor = (slots: number): number => 200 + slots * 28

let headerWidth = 1400
const observers: Array<() => void> = []

class FakeResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    observers.push(() => cb([], this as unknown as ResizeObserver))
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

async function resizeTo(width: number): Promise<void> {
  headerWidth = width
  observers.forEach((fire) => fire())
  await nextTick()
  await flushPromises()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const folder: any = {
  path: '/repo/alpha',
  alias: 'alpha',
  expanded: true,
  gitBranch: '',
  sessions: []
}

const TEST_ID: Record<TopbarActionId, string> = {
  'new-session': 'topbar-new-session',
  roadmap: 'topbar-roadmap',
  'pr-stack': 'topbar-pr-stack',
  review: 'topbar-review',
  'open-folder': 'topbar-open-folder',
  editor: 'topbar-editor',
  'github-pulls': 'topbar-github-pulls',
  explorer: 'topbar-explorer',
  terminal: 'topbar-split',
  browser: 'topbar-browser',
  'split-layout': 'topbar-split-layout',
  'panel-right': 'topbar-panel-right'
}

const inBar = (w: VueWrapper, id: TopbarActionId): boolean =>
  w.find(`[data-test="${TEST_ID[id]}"]`).exists()
const barIds = (w: VueWrapper): TopbarActionId[] => TOPBAR_BAR_ORDER.filter((id) => inBar(w, id))
const menuIds = (w: VueWrapper): string[] =>
  w
    .findAll('[data-test^="topbar-overflow-item-"]')
    .map((el) => el.attributes('data-test')!.replace('topbar-overflow-item-', ''))

/** Mounted at full width with every action present: folder view, GitHub origin, helper panes. */
async function mountFull(): Promise<VueWrapper> {
  const wrapper = mount(Topbar, { attachTo: document.body, global: { plugins: [i18n] } })
  await flushPromises()
  // A browser pane makes `hasHelpersForCurrentWorktree` true: the split-layout toggle and the panel toggle appear.
  await wrapper.get('[data-test="topbar-browser"]').trigger('click')
  await flushPromises()
  await resizeTo(1400)
  return wrapper
}

describe('topbar overflow menu', () => {
  const openPath = vi.fn()

  beforeEach(() => {
    document.body.innerHTML = ''
    observers.length = 0
    headerWidth = 1400
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.tagName === 'HEADER' ? headerWidth : 0
      }
    })
    setActivePinia(createPinia())
    const store = useSessionsStore()
    store.folders.splice(0, store.folders.length, folder)
    store.selectFolder('/repo/alpha')
    openPath.mockReset()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).api = {
      openPath,
      openInEditor: vi.fn(),
      githubPullsUrl: vi.fn().mockResolvedValue('https://github.com/acme/alpha/pulls'),
      shellOpenExternal: vi.fn(),
      browserOpen: vi.fn().mockResolvedValue({ ok: true, paneId: 'pane-1' })
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    // @ts-expect-error restore the jsdom default
    delete HTMLElement.prototype.clientWidth
  })

  it('shows every action and no `…` button when the bar is wide enough', async () => {
    const wrapper = await mountFull()
    expect(barIds(wrapper)).toEqual([...TOPBAR_BAR_ORDER])
    expect(wrapper.find('[data-test="topbar-more"]').exists()).toBe(false)
  })

  it('AC-2: moves the lowest-priority actions into `…`, one at a time, as the bar narrows', async () => {
    const wrapper = await mountFull()
    // 12 actions need 12 slots. 11 slots: one action has to leave and the `…` button takes a slot, so two go.
    await resizeTo(widthFor(11))
    expect(barIds(wrapper)).toEqual(
      TOPBAR_BAR_ORDER.filter((id) => id !== 'github-pulls' && id !== 'open-folder')
    )
    expect(wrapper.find('[data-test="topbar-more"]').exists()).toBe(true)

    await resizeTo(widthFor(10)) // one more slot short: one more action goes, in priority order
    expect(inBar(wrapper, 'editor')).toBe(false)
    expect(inBar(wrapper, 'explorer')).toBe(true)

    await resizeTo(widthFor(8))
    expect(barIds(wrapper)).toEqual(
      TOPBAR_BAR_ORDER.filter(
        (id) => !['github-pulls', 'open-folder', 'editor', 'explorer', 'split-layout'].includes(id)
      )
    )
    // The `…` button is the last thing in the cluster.
    const cluster = wrapper.get('[data-test="topbar-more"]').element.parentElement!
    expect(cluster.lastElementChild).toBe(wrapper.get('[data-test="topbar-more"]').element)
  })

  it('AC-2: brings them back as space returns, and the `…` button goes with the last one', async () => {
    const wrapper = await mountFull()
    await resizeTo(widthFor(5))
    expect(barIds(wrapper).length).toBe(4)
    await resizeTo(widthFor(14))
    expect(barIds(wrapper)).toEqual([...TOPBAR_BAR_ORDER])
    expect(wrapper.find('[data-test="topbar-more"]').exists()).toBe(false)
  })

  it('AC-2: does not oscillate when the width jitters on the boundary', async () => {
    const wrapper = await mountFull()
    await resizeTo(widthFor(11)) // two hidden
    const settled = barIds(wrapper)
    // 12 slots would show everything; coming back needs 8px to spare, so jitter below that changes nothing.
    for (const w of [widthFor(12), widthFor(12) + 3, widthFor(12) - 2, widthFor(12) + 7]) {
      await resizeTo(w)
      expect(barIds(wrapper)).toEqual(settled)
    }
    await resizeTo(widthFor(12) + 8)
    expect(barIds(wrapper)).toEqual([...TOPBAR_BAR_ORDER])
  })

  it('AC-3: the menu holds exactly the hidden actions, in bar order, with label, icon and shortcut', async () => {
    const wrapper = await mountFull()
    const labels = new Map<TopbarActionId, string>(
      TOPBAR_BAR_ORDER.map((id) => [
        id,
        wrapper.get(`[data-test="${TEST_ID[id]}"]`).attributes('aria-label')!
      ])
    )
    await resizeTo(widthFor(8))
    const hidden = TOPBAR_BAR_ORDER.filter((id) => !inBar(wrapper, id))
    expect(hidden).toEqual(['open-folder', 'editor', 'github-pulls', 'explorer', 'split-layout'])

    await wrapper.get('[data-test="topbar-more"]').trigger('click')
    expect(menuIds(wrapper)).toEqual(hidden)

    const keybindings = useKeybindingsStore()
    for (const id of hidden) {
      const item = wrapper.get(`[data-test="topbar-overflow-item-${id}"]`)
      expect(item.text()).toContain(labels.get(id)!)
      expect(item.find('svg').exists()).toBe(true)
    }
    const chord = keybindings.chordLabel('folder.openInFileManager')
    expect(chord).not.toBe('')
    expect(wrapper.get('[data-test="topbar-overflow-item-open-folder"]').text()).toContain(chord)
  })

  it('AC-3: an action in the menu runs the same handler as its button, then the menu closes', async () => {
    const wrapper = await mountFull()
    await resizeTo(widthFor(8))
    await wrapper.get('[data-test="topbar-more"]').trigger('click')
    await wrapper.get('[data-test="topbar-overflow-item-open-folder"]').trigger('click')
    expect(openPath).toHaveBeenCalledWith('/repo/alpha')
    expect(wrapper.find('[data-test="topbar-overflow-menu"]').exists()).toBe(false)
  })

  it('AC-3: keeps the active state of a toggle that moved into the menu', async () => {
    const wrapper = await mountFull()
    await resizeTo(widthFor(1)) // everything is in the menu
    const ui = useUiStore()
    await wrapper.get('[data-test="topbar-more"]').trigger('click')
    const row = (): ReturnType<typeof wrapper.get> =>
      wrapper.get('[data-test="topbar-overflow-item-roadmap"]')
    expect(row().attributes('aria-checked')).toBe('false')
    ui.toggleRoadmap('/repo/alpha', 'alpha')
    await nextTick()
    expect(row().attributes('aria-checked')).toBe('true')
    expect(row().classes()).toContain('text-accent')
  })

  it('AC-3: opens from the keyboard, arrows move, Enter activates, Esc closes and returns focus', async () => {
    const wrapper = await mountFull()
    await resizeTo(widthFor(8))
    const more = wrapper.get('[data-test="topbar-more"]')
    expect(more.attributes('aria-haspopup')).toBe('menu')
    expect(more.attributes('aria-expanded')).toBe('false')
    ;(more.element as HTMLElement).focus()

    await more.trigger('keydown', { key: 'ArrowDown' })
    await nextTick()
    expect(more.attributes('aria-expanded')).toBe('true')
    const item = (id: string): HTMLElement =>
      wrapper.get(`[data-test="topbar-overflow-item-${id}"]`).element as HTMLElement
    expect(document.activeElement).toBe(item('open-folder'))

    await wrapper.get('[data-test="topbar-overflow-menu"]').trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('editor'))
    await wrapper.get('[data-test="topbar-overflow-menu"]').trigger('keydown', { key: 'ArrowUp' })
    await wrapper.get('[data-test="topbar-overflow-menu"]').trigger('keydown', { key: 'ArrowUp' })
    expect(document.activeElement).toBe(item('split-layout')) // wraps to the last
    await wrapper.get('[data-test="topbar-overflow-menu"]').trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(item('open-folder'))

    await wrapper.get('[data-test="topbar-overflow-menu"]').trigger('keydown', { key: 'Escape' })
    await nextTick()
    expect(wrapper.find('[data-test="topbar-overflow-menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(more.element)

    await more.trigger('keydown', { key: 'Enter' })
    await nextTick()
    await wrapper.get('[data-test="topbar-overflow-menu"]').trigger('keydown', { key: 'Enter' })
    expect(openPath).toHaveBeenCalledWith('/repo/alpha')
    expect(document.activeElement).toBe(more.element)
  })

  it('AC-1: the title is a truncating span with a 96px floor and never a shrinkable overlap', async () => {
    const wrapper = await mountFull()
    const title = wrapper.get('[data-test="topbar-title"]')
    expect(title.classes()).toContain('truncate')
    expect(title.attributes('style')).toContain(`min-width: ${TOPBAR_MIN_TITLE_PX}px`)
    // The region around it may not shrink below its content, or the floor would poke out over the cluster.
    expect(title.element.parentElement!.classList.contains('min-w-0')).toBe(false)
  })

  it('keeps the 42px band and the island markers with Floating panels off and on', async () => {
    for (const floating of [undefined, 'on']) {
      if (floating) document.documentElement.setAttribute('data-floating', floating)
      else document.documentElement.removeAttribute('data-floating')
      const wrapper = await mountFull()
      const header = wrapper.get('header')
      expect(header.attributes('data-island')).toBe('topbar')
      expect(header.attributes('data-island-band')).toBeDefined()
      expect((header.element as HTMLElement).style.height).toBe('42px')
      wrapper.unmount()
    }
    document.documentElement.removeAttribute('data-floating')
  })

  it('has its label in both locales', () => {
    expect(en.topbar.moreActions).toBe('More actions')
    expect(ptBR.topbar.moreActions).toBeTruthy()
  })
})
