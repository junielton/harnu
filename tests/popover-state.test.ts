// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { computed, nextTick, ref } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import { useUiStore, POPOVER_IDS, type PopoverId } from '../src/renderer/src/stores/ui'
import { useLayoutStore } from '../src/renderer/src/stores/layout'
import { useMissionsStore } from '../src/renderer/src/stores/missions'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import ActivityBell from '../src/renderer/src/components/ActivityBell.vue'
import MissionPill from '../src/renderer/src/components/MissionPill.vue'
import StatusFooter from '../src/renderer/src/components/StatusFooter.vue'
import InboxRail from '../src/renderer/src/components/InboxRail.vue'
import ClaudeStatusPanel from '../src/renderer/src/components/ClaudeStatusPanel.vue'
import UsagePanel from '../src/renderer/src/components/UsagePanel.vue'
import FooterImagePopover from '../src/renderer/src/components/FooterImagePopover.vue'
import ImageLightbox from '../src/renderer/src/components/ImageLightbox.vue'
import { fixtureView } from './helpers/mission-v3-view'

/**
 * T486 U4a — the footer / Topbar / Fleet-rail popovers' open flags live in
 * `stores/ui.ts` (`docs/specs/T486-keybindings-coverage-pass.md` §3.5, §6.1).
 *
 *  - AC-54: each popover opens from its id (the store toggle its binding runs)
 *    and still opens / closes from its own button and Esc exactly as before;
 *    `ui.anyPopoverOpen` is true while any of them, or the image lightbox, is
 *    open. U4b's `view.closeTakeover` is disabled while it is true.
 *  - Anchors: a popover whose button is not rendered cannot be opened, and a
 *    button that disappears closes its popover — otherwise `anyPopoverOpen`
 *    would stay true with nothing on screen and swallow every later Esc.
 *  - AC-37: each binding runs the function its button runs.
 */

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

// The pasted-images pill reads its count from `useSessionImages`; the test owns
// the list so the pill can be shown and hidden at will.
const images = vi.hoisted(() => ({
  entries: null as unknown as import('vue').Ref<Array<{ name: string; path: string }>>,
  refresh: null as unknown as ReturnType<typeof vi.fn>,
  loadThumbs: null as unknown as ReturnType<typeof vi.fn>,
  clearThumbs: null as unknown as ReturnType<typeof vi.fn>
}))
vi.mock('../src/renderer/src/composables/useSessionImages', () => ({
  useSessionImages: () => ({
    count: computed(() => images.entries.value.length),
    entries: images.entries,
    refresh: images.refresh,
    loadThumbs: images.loadThumbs,
    clearThumbs: images.clearThumbs
  })
}))

/** A quiet `window.api`: any `on*` subscription is a no-op, any call resolves to nothing. */
function stubApi(extra: Record<string, unknown> = {}): void {
  const none = (): (() => void) => () => {}
  ;(window as unknown as { api: unknown }).api = new Proxy(extra, {
    get: (target, key: string) => {
      if (key in target) return target[key]
      return key.startsWith('on') ? none : vi.fn(async () => null)
    }
  })
}

const esc = async (): Promise<void> => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await nextTick()
}

let wrapper: VueWrapper | null = null

beforeEach(() => {
  i18n.global.locale.value = 'en'
  localStorage.clear()
  setActivePinia(createPinia())
  images.entries = ref([])
  images.refresh = vi.fn(async () => {})
  images.loadThumbs = vi.fn(async () => {})
  images.clearThumbs = vi.fn()
  stubApi()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('ui store — popover state', () => {
  it('lists the six lifted popovers', () => {
    expect([...POPOVER_IDS].sort()).toEqual(
      [
        'activity',
        'claudeStatus',
        'inboxFilter',
        'missionProgress',
        'pastedImages',
        'usagePanel'
      ].sort()
    )
  })

  for (const id of POPOVER_IDS) {
    it(`${id}: toggles, and anyPopoverOpen follows it`, () => {
      const ui = useUiStore()
      ui.setPopoverAnchor(id, true)
      expect(ui.anyPopoverOpen).toBe(false)
      ui.togglePopover(id)
      expect(ui.popovers[id]).toBe(true)
      expect(ui.anyPopoverOpen).toBe(true)
      ui.togglePopover(id)
      expect(ui.popovers[id]).toBe(false)
      expect(ui.anyPopoverOpen).toBe(false)
    })

    it(`${id}: refuses to open while its button is not rendered`, () => {
      const ui = useUiStore()
      expect(ui.openPopover(id)).toBe(false)
      expect(ui.popovers[id]).toBe(false)
      expect(ui.anyPopoverOpen).toBe(false)
    })

    it(`${id}: closes when its button goes away`, () => {
      const ui = useUiStore()
      ui.setPopoverAnchor(id, true)
      expect(ui.openPopover(id)).toBe(true)
      ui.setPopoverAnchor(id, false)
      expect(ui.popovers[id]).toBe(false)
      expect(ui.anyPopoverOpen).toBe(false)
    })
  }

  it('the image lightbox alone makes anyPopoverOpen true', () => {
    const ui = useUiStore()
    ui.openImageLightbox(0)
    expect(ui.imageLightboxIndex).toBe(0)
    expect(ui.anyPopoverOpen).toBe(true)
    ui.closeImageLightbox()
    expect(ui.anyPopoverOpen).toBe(false)
  })

  it('closing the pasted-images popover closes its lightbox too', () => {
    const ui = useUiStore()
    ui.setPopoverAnchor('pastedImages', true)
    ui.openPopover('pastedImages')
    ui.openImageLightbox(2)
    ui.closePopover('pastedImages')
    expect(ui.imageLightboxIndex).toBeNull()
    expect(ui.anyPopoverOpen).toBe(false)
  })

  it('pasted images and plan usage close each other (the footer mutex)', () => {
    const ui = useUiStore()
    ui.setPopoverAnchor('pastedImages', true)
    ui.setPopoverAnchor('usagePanel', true)
    ui.openPopover('usagePanel')
    ui.openPopover('pastedImages')
    expect(ui.popovers.usagePanel).toBe(false)
    expect(ui.popovers.pastedImages).toBe(true)
    ui.openPopover('usagePanel')
    expect(ui.popovers.pastedImages).toBe(false)
    expect(ui.popovers.usagePanel).toBe(true)
  })

  it('any other pair can be open together, as with the buttons today', () => {
    const ui = useUiStore()
    ui.setPopoverAnchor('activity', true)
    ui.setPopoverAnchor('claudeStatus', true)
    ui.openPopover('activity')
    ui.openPopover('claudeStatus')
    expect(ui.popovers.activity).toBe(true)
    expect(ui.popovers.claudeStatus).toBe(true)
  })
})

describe('AC-54 — ActivityBell', () => {
  async function mountBell(): Promise<VueWrapper> {
    wrapper = mount(ActivityBell, { attachTo: document.body, global: { plugins: [i18n] } })
    await flushPromises()
    return wrapper
  }
  const popover = (w: VueWrapper) => w.find('[data-dsqa="activity-popover"]')

  it('its button opens and closes it, and Esc closes it', async () => {
    const w = await mountBell()
    const ui = useUiStore()
    await w.get('[data-dsqa="topbar-bell"]').trigger('click')
    expect(popover(w).exists()).toBe(true)
    expect(ui.popovers.activity).toBe(true)
    expect(ui.anyPopoverOpen).toBe(true)
    await w.get('[data-dsqa="topbar-bell"]').trigger('click')
    expect(popover(w).exists()).toBe(false)
    await w.get('[data-dsqa="topbar-bell"]').trigger('click')
    await esc()
    expect(popover(w).exists()).toBe(false)
    expect(ui.anyPopoverOpen).toBe(false)
  })

  it('opens from its id (the store toggle)', async () => {
    const w = await mountBell()
    useUiStore().togglePopover('activity')
    await nextTick()
    expect(popover(w).exists()).toBe(true)
    expect(w.get('[data-dsqa="topbar-bell"]').attributes('aria-expanded')).toBe('true')
  })

  it('its anchor follows the mount', async () => {
    const w = await mountBell()
    const ui = useUiStore()
    expect(ui.popoverAnchors.activity).toBe(true)
    ui.openPopover('activity')
    w.unmount()
    wrapper = null
    expect(ui.popoverAnchors.activity).toBe(false)
    expect(ui.anyPopoverOpen).toBe(false)
  })
})

describe('AC-54 — MissionPill', () => {
  async function mountPill(): Promise<VueWrapper> {
    const v = fixtureView('faq-like')
    stubApi({
      missionList: vi.fn(async () => ({ views: [v], unreadable: [] })),
      missionOperatorDoor: vi.fn()
    })
    useSessionsStore().folders = [{ path: '/repo', sessions: [] }] as never
    await useMissionsStore().refresh()
    wrapper = mount(MissionPill, {
      attachTo: document.body,
      props: { sessionId: v.mission.owner.sessionId },
      global: { plugins: [i18n] }
    })
    await flushPromises()
    return wrapper
  }
  const expanded = (w: VueWrapper) => w.get('button').attributes('aria-expanded')

  it('its button opens and closes it, and Esc closes it', async () => {
    const w = await mountPill()
    const ui = useUiStore()
    await w.get('button').trigger('click')
    expect(expanded(w)).toBe('true')
    expect(ui.popovers.missionProgress).toBe(true)
    await w.get('button').trigger('click')
    expect(expanded(w)).toBe('false')
    await w.get('button').trigger('click')
    await esc()
    expect(expanded(w)).toBe('false')
    expect(ui.anyPopoverOpen).toBe(false)
  })

  it('opens from its id and refreshes the mission like a click does', async () => {
    const w = await mountPill()
    const list = (window as unknown as { api: { missionList: ReturnType<typeof vi.fn> } }).api
      .missionList
    const before = list.mock.calls.length
    useUiStore().togglePopover('missionProgress')
    await flushPromises()
    expect(expanded(w)).toBe('true')
    expect(list.mock.calls.length).toBeGreaterThan(before)
  })

  it('has no anchor when the session owns no mission', async () => {
    wrapper = mount(MissionPill, {
      attachTo: document.body,
      props: { sessionId: 'no-such-session' },
      global: { plugins: [i18n] }
    })
    await flushPromises()
    const ui = useUiStore()
    expect(ui.popoverAnchors.missionProgress).toBe(false)
    expect(ui.openPopover('missionProgress')).toBe(false)
  })
})

describe('AC-54 — StatusFooter popovers', () => {
  async function mountFooter(): Promise<VueWrapper> {
    wrapper = mount(StatusFooter, { attachTo: document.body, global: { plugins: [i18n] } })
    await flushPromises()
    return wrapper
  }
  const button = (w: VueWrapper, label: string) =>
    w.findAll('button').find((b) => (b.attributes('aria-label') ?? '').startsWith(label))!

  it('Claude status: button, Esc, and its id', async () => {
    const w = await mountFooter()
    const ui = useUiStore()
    const dot = button(w, 'Claude service status')
    await dot.trigger('click')
    expect(w.findComponent(ClaudeStatusPanel).exists()).toBe(true)
    expect(ui.popovers.claudeStatus).toBe(true)
    await dot.trigger('click')
    expect(w.findComponent(ClaudeStatusPanel).exists()).toBe(false)
    await dot.trigger('click')
    await esc()
    expect(w.findComponent(ClaudeStatusPanel).exists()).toBe(false)
    ui.togglePopover('claudeStatus')
    await nextTick()
    expect(w.findComponent(ClaudeStatusPanel).exists()).toBe(true)
  })

  it('plan usage: button, Esc, and its id', async () => {
    const w = await mountFooter()
    const ui = useUiStore()
    const fleet = button(w, 'Plan usage')
    await fleet.trigger('click')
    expect(w.findComponent(UsagePanel).exists()).toBe(true)
    expect(ui.popovers.usagePanel).toBe(true)
    await fleet.trigger('click')
    expect(w.findComponent(UsagePanel).exists()).toBe(false)
    await fleet.trigger('click')
    await esc()
    expect(w.findComponent(UsagePanel).exists()).toBe(false)
    ui.togglePopover('usagePanel')
    await nextTick()
    expect(w.findComponent(UsagePanel).exists()).toBe(true)
  })

  it('pasted images: hidden pill has no anchor; button and id both list the images', async () => {
    const w = await mountFooter()
    const ui = useUiStore()
    expect(ui.popoverAnchors.pastedImages).toBe(false)
    images.entries.value = [{ name: '1.png', path: '/c/1.png' }]
    await nextTick()
    expect(ui.popoverAnchors.pastedImages).toBe(true)

    await button(w, 'Pasted images').trigger('click')
    await flushPromises()
    expect(w.findComponent(FooterImagePopover).exists()).toBe(true)
    expect(images.refresh).toHaveBeenCalledTimes(1)
    expect(images.loadThumbs).toHaveBeenCalledTimes(1)
    await esc()
    expect(w.findComponent(FooterImagePopover).exists()).toBe(false)
    expect(images.clearThumbs).toHaveBeenCalled()

    ui.togglePopover('pastedImages')
    await flushPromises()
    expect(w.findComponent(FooterImagePopover).exists()).toBe(true)
    expect(images.refresh).toHaveBeenCalledTimes(2)
    expect(images.loadThumbs).toHaveBeenCalledTimes(2)
  })

  it('pasted images: the pill disappearing closes the popover', async () => {
    const w = await mountFooter()
    const ui = useUiStore()
    images.entries.value = [{ name: '1.png', path: '/c/1.png' }]
    await nextTick()
    await button(w, 'Pasted images').trigger('click')
    await flushPromises()
    images.entries.value = []
    await nextTick()
    expect(ui.popovers.pastedImages).toBe(false)
    expect(ui.anyPopoverOpen).toBe(false)
  })

  it('the lightbox: Esc while it is open leaves the popover to the lightbox', async () => {
    const w = await mountFooter()
    const ui = useUiStore()
    images.entries.value = [{ name: '1.png', path: '/c/1.png' }]
    await nextTick()
    await button(w, 'Pasted images').trigger('click')
    await flushPromises()
    w.findComponent(FooterImagePopover).vm.$emit('open-lightbox', 0)
    await nextTick()
    expect(w.findComponent(ImageLightbox).exists()).toBe(true)
    expect(ui.imageLightboxIndex).toBe(0)
    expect(ui.anyPopoverOpen).toBe(true)
    // The lightbox's own Esc ends the whole image flow, as before.
    await esc()
    expect(w.findComponent(ImageLightbox).exists()).toBe(false)
    expect(ui.popovers.pastedImages).toBe(false)
    expect(ui.anyPopoverOpen).toBe(false)
  })

  it('opening plan usage from its button closes the pasted-images popover', async () => {
    const w = await mountFooter()
    const ui = useUiStore()
    images.entries.value = [{ name: '1.png', path: '/c/1.png' }]
    await nextTick()
    ui.togglePopover('pastedImages')
    await flushPromises()
    await button(w, 'Plan usage').trigger('click')
    expect(ui.popovers.pastedImages).toBe(false)
    expect(ui.popovers.usagePanel).toBe(true)
  })
})

describe('AC-54 — Fleet rail filter', () => {
  async function mountRail(): Promise<VueWrapper> {
    // The rail lists mission grants on mount; the quiet stub's `null` is not a list.
    stubApi({ mcpGrantsList: vi.fn(async () => []) })
    wrapper = mount(InboxRail, { attachTo: document.body, global: { plugins: [i18n] } })
    await flushPromises()
    return wrapper
  }
  const popover = (w: VueWrapper) => w.find('[data-dsqa="fleet-rail-filter-popover"]')
  const filterButton = (w: VueWrapper) => w.get('[data-dsqa="fleet-rail-filter-button"]')

  it('its button opens and closes it, and Esc closes it', async () => {
    const w = await mountRail()
    const ui = useUiStore()
    await filterButton(w).trigger('click')
    expect(popover(w).exists()).toBe(true)
    expect(ui.popovers.inboxFilter).toBe(true)
    await filterButton(w).trigger('click')
    expect(popover(w).exists()).toBe(false)
    await filterButton(w).trigger('click')
    await esc()
    expect(popover(w).exists()).toBe(false)
    expect(ui.anyPopoverOpen).toBe(false)
  })

  it('opens from its id', async () => {
    const w = await mountRail()
    useUiStore().togglePopover('inboxFilter')
    await nextTick()
    expect(popover(w).exists()).toBe(true)
  })

  it('minimizing the rail removes the anchor and closes the popover', async () => {
    await mountRail()
    const ui = useUiStore()
    ui.openPopover('inboxFilter')
    useLayoutStore().setInboxRailState('minimized')
    await nextTick()
    expect(ui.popoverAnchors.inboxFilter).toBe(false)
    expect(ui.popovers.inboxFilter).toBe(false)
  })
})

describe('AC-37 — each binding runs its button’s function', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8')
  const app = read('src/renderer/src/App.vue')

  /** The registration object in App.vue for `id` (up to the next `id: '`). */
  function registration(id: string): string {
    const start = app.indexOf(`id: '${id}'`)
    expect(start, `${id} is registered in App.vue`).toBeGreaterThan(-1)
    const next = app.indexOf("id: '", start + 5)
    return app.slice(start, next === -1 ? undefined : next)
  }

  const POPOVERS: Array<[string, PopoverId, string]> = [
    ['view.activity', 'activity', 'components/ActivityBell.vue'],
    ['view.missionProgress', 'missionProgress', 'components/MissionPill.vue'],
    ['view.pastedImages', 'pastedImages', 'components/StatusFooter.vue'],
    ['view.claudeStatus', 'claudeStatus', 'components/StatusFooter.vue'],
    ['view.usagePanel', 'usagePanel', 'components/StatusFooter.vue'],
    ['inbox.filter', 'inboxFilter', 'components/InboxRail.vue']
  ]
  for (const [id, popover, file] of POPOVERS) {
    it(`${id} toggles '${popover}', as its button does, and needs the button rendered`, () => {
      const reg = registration(id)
      expect(reg).toContain(`ui.togglePopover('${popover}')`)
      expect(reg).toContain(`ui.popoverAnchors.${popover}`)
      expect(read(`src/renderer/src/${file}`)).toContain(`@click="ui.togglePopover('${popover}')"`)
    })
  }

  const LAYOUT: Array<[string, string]> = [
    ['inbox.open', "layout.setInboxRailState('expanded')"],
    ['inbox.toggleOrder', 'layout.toggleInboxRailOrder()'],
    ['inbox.showAll', 'layout.clearInboxRailStateFilter()']
  ]
  const rail = read('src/renderer/src/components/InboxRail.vue')
  for (const [id, call] of LAYOUT) {
    it(`${id} calls ${call}, as its Fleet rail button does`, () => {
      expect(registration(id)).toContain(call)
      expect(rail).toContain(`@click="${call}"`)
    })
  }

  it('inbox.showAll is enabled only while a state is filtered out (its button shows then)', () => {
    expect(registration('inbox.showAll')).toContain('layout.inboxRailHiddenStates.size > 0')
  })
})
