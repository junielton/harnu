// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { computed, nextTick, ref } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { registerWriter, unregisterWriter } from '../src/renderer/src/lib/terminal-bus'
import {
  formatLinkTime,
  isRawLabel,
  linkHost,
  referenceLink
} from '../src/renderer/src/composables/useSessionLinks'
import FooterLinksPopover from '../src/renderer/src/components/FooterLinksPopover.vue'
import StatusFooter from '../src/renderer/src/components/StatusFooter.vue'
import type { FolderLinkGroup, SessionLink } from '../src/preload'

/**
 * Links shelf (T617) — the renderer half: the Reference gating (AC-8), the popover anatomy (AC-6/7),
 * the pill's placement and the footer popover mutex (AC-5). Expected values are hand-written literals.
 */

vi.mock('../src/renderer/src/lib/notification-sound', () => ({ playNotificationSound: vi.fn() }))

// The footer's links pill reads its list from `useSessionLinks`; the test owns it so the pill can be
// shown and hidden at will (the same device the pasted-images pill test uses). The pure helpers stay real.
const links = vi.hoisted(() => ({
  entries: null as unknown as import('vue').Ref<unknown[]>,
  groups: null as unknown as import('vue').Ref<unknown[] | null>,
  refresh: null as unknown as ReturnType<typeof vi.fn>,
  refreshFolder: null as unknown as ReturnType<typeof vi.fn>
}))
vi.mock('../src/renderer/src/composables/useSessionLinks', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/renderer/src/composables/useSessionLinks')>()
  return {
    ...actual,
    useSessionLinks: () => ({
      count: computed(() => links.entries.value.length),
      entries: links.entries,
      folderGroups: links.groups,
      folderCount: computed(() =>
        (links.groups.value ?? []).reduce((n, g) => n + (g as FolderLinkGroup).count, 0)
      ),
      refresh: links.refresh,
      refreshFolder: links.refreshFolder
    })
  }
})
const images = vi.hoisted(() => ({
  entries: null as unknown as import('vue').Ref<Array<{ name: string; path: string }>>
}))
vi.mock('../src/renderer/src/composables/useSessionImages', () => ({
  useSessionImages: () => ({
    count: computed(() => images.entries.value.length),
    entries: images.entries,
    refresh: vi.fn(async () => {}),
    loadThumbs: vi.fn(async () => {}),
    clearThumbs: vi.fn()
  })
}))

const SID = '11111111-2222-4333-8444-555555555555'

const link = (over: Partial<SessionLink> = {}): SessionLink => ({
  url: 'https://github.com/acme/web/pull/183',
  kind: 'pr',
  label: 'acme/web #183',
  detail: 'GitHub PR',
  source: 'agent',
  at: '2026-11-03T14:32:00.000Z',
  excerpt: 'Opened https://github.com/acme/web/pull/183 — footer pill.',
  ...over
})

describe('referenceLink — AC-8 gating', () => {
  it('writes the URL as is, with a trailing space and no newline, into a live session', () => {
    const write = vi.fn(() => true)
    const url = 'https://example.com/a?x=1&y=(2)#frag'
    const done = referenceLink({ sessionId: 's1', isLive: () => true, write }, url)
    expect(done).toBe(true)
    // Not shell-escaped (a path would turn `?` into `\?`) and never submitted (no `\n` / `\r`).
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('s1', 'https://example.com/a?x=1&y=(2)#frag ')
  })

  it('writes nothing when the session has no live PTY', () => {
    const write = vi.fn(() => true)
    expect(
      referenceLink({ sessionId: 's1', isLive: () => false, write }, 'https://example.com')
    ).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('writes nothing when no session is selected', () => {
    const write = vi.fn(() => true)
    expect(
      referenceLink({ sessionId: null, isLive: () => true, write }, 'https://example.com')
    ).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('reports false when the writer bus refuses (the terminal went away)', () => {
    const write = vi.fn(() => false)
    expect(
      referenceLink({ sessionId: 's1', isLive: () => true, write }, 'https://example.com')
    ).toBe(false)
  })
})

describe('row helpers', () => {
  it('formatLinkTime: HH:MM for today, a short date for an older link, empty for garbage', () => {
    const now = new Date(2026, 10, 3, 18, 0, 0) // local time, 3 Nov 2026
    const today = new Date(2026, 10, 3, 9, 5, 0).toISOString()
    const older = new Date(2026, 10, 1, 9, 5, 0).toISOString()
    expect(formatLinkTime(today, now)).toMatch(/^\d{2}:\d{2}$/)
    expect(formatLinkTime(older, now)).not.toMatch(/^\d{2}:\d{2}$/)
    expect(formatLinkTime(older, now)).toMatch(/\d/)
    expect(formatLinkTime('', now)).toBe('')
    expect(formatLinkTime('not a date', now)).toBe('')
  })

  it('linkHost and isRawLabel', () => {
    expect(linkHost('https://github.com/acme/web/pull/183')).toBe('github.com')
    expect(linkHost('nope')).toBe('')
    expect(isRawLabel('web')).toBe(true)
    expect(isRawLabel('doc')).toBe(true)
    expect(isRawLabel('pr')).toBe(false)
    expect(isRawLabel('figma')).toBe(false)
  })
})

describe('ui store — AC-5 footer popover mutex', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('opening Links closes images, usage and GitHub — and vice versa', () => {
    const ui = useUiStore()
    for (const id of ['links', 'pastedImages', 'usagePanel', 'githubBudget'] as const) {
      ui.setPopoverAnchor(id, true)
    }
    for (const other of ['pastedImages', 'usagePanel', 'githubBudget'] as const) {
      ui.openPopover(other)
      expect(ui.popovers[other]).toBe(true)
      ui.openPopover('links')
      expect(ui.popovers.links).toBe(true)
      expect(ui.popovers[other]).toBe(false)
      ui.openPopover(other)
      expect(ui.popovers.links).toBe(false)
      expect(ui.popovers[other]).toBe(true)
      ui.closePopover(other)
    }
  })

  it('does not close an unrelated popover, and cannot open without its pill', () => {
    const ui = useUiStore()
    ui.setPopoverAnchor('activity', true)
    ui.openPopover('activity')
    expect(ui.openPopover('links')).toBe(false)
    ui.setPopoverAnchor('links', true)
    ui.openPopover('links')
    expect(ui.popovers.activity).toBe(true)
    expect(ui.popovers.links).toBe(true)
  })
})

describe('FooterLinksPopover — AC-6 / AC-7 / AC-8', () => {
  let wrapper: VueWrapper | null = null
  const writeText = vi.fn(async () => {})
  const shellOpenExternal = vi.fn(async () => {})

  function mountPopover(props: Record<string, unknown> = {}): VueWrapper {
    wrapper = mount(FooterLinksPopover, {
      attachTo: document.body,
      global: { plugins: [i18n] },
      props: {
        scope: 'session',
        entries: [],
        groups: null,
        folderAlias: 'harnu',
        count: 0,
        folderCount: 0,
        uuid: SID,
        canReference: true,
        ...props
      }
    })
    return wrapper
  }

  beforeEach(() => {
    i18n.global.locale.value = 'en'
    setActivePinia(createPinia())
    writeText.mockClear()
    shellOpenExternal.mockClear()
    ;(window as unknown as { api: unknown }).api = { shellOpenExternal }
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  const rows = (w: VueWrapper) => w.findAll('[data-testid="footer-links-row"]')

  it('renders the header, one row per link and the note', () => {
    const w = mountPopover({
      entries: [
        link(),
        link({
          url: 'https://keepachangelog.com/en/1.1.0/',
          kind: 'web',
          label: 'keepachangelog.com/en/1.1.0',
          detail: '',
          source: 'user',
          excerpt: ''
        }),
        link({
          url: 'https://www.figma.com/design/K/Harnu?node-id=812-4410',
          kind: 'figma',
          label: 'Harnu',
          detail: 'node 812-4410',
          source: 'user'
        })
      ],
      count: 3
    })
    expect(w.text()).toContain('Links')
    expect(w.get('[data-testid="footer-links-meta"]').text()).toBe('harnu · 3')
    expect(rows(w)).toHaveLength(3)
    const [pr, web, figma] = rows(w)
    // PR: label, kind name + host, the agent chip.
    expect(pr.text()).toContain('acme/web #183')
    expect(pr.text()).toContain('GitHub PR')
    expect(pr.text()).toContain('github.com')
    expect(pr.text()).toContain('agent')
    // Web: raw label in mono, kind name from i18n, the you chip.
    expect(web.find('.font-mono').text()).toBe('keepachangelog.com/en/1.1.0')
    expect(web.text()).toContain('Web')
    expect(web.text()).toContain('you')
    // Figma: file name + the node id.
    expect(figma.text()).toContain('Harnu')
    expect(figma.text()).toContain('Figma')
    expect(figma.text()).toContain('node 812-4410')
    // The excerpt is rendered (revealed on hover) only when there is one.
    expect(pr.find('[data-testid="footer-links-excerpt"]').text()).toBe(
      '“Opened https://github.com/acme/web/pull/183 — footer pill.”'
    )
    expect(web.find('[data-testid="footer-links-excerpt"]').exists()).toBe(false)
    expect(w.text()).toContain("Read from this session's transcript.")
  })

  it('Folder scope groups rows under each session, naming the active one "This session"', () => {
    const groups: FolderLinkGroup[] = [
      {
        sessionId: SID,
        title: 'Links shelf',
        count: 1,
        latestAt: '2026-11-03T14:32:00.000Z',
        links: [link()]
      },
      {
        sessionId: 'other',
        title: 'Older work',
        count: 2,
        latestAt: '2026-11-02T10:00:00.000Z',
        links: [
          link({ url: 'https://example.com/a', kind: 'web', label: 'example.com/a', detail: '' }),
          link({ url: 'https://example.com/b', kind: 'web', label: 'example.com/b', detail: '' })
        ]
      }
    ]
    const w = mountPopover({ scope: 'folder', groups, folderCount: 3 })
    const headers = w.findAll('[data-testid="footer-links-group"]')
    expect(headers.map((h) => h.text())).toEqual(['This session1', 'Older work2'])
    expect(rows(w)).toHaveLength(3)
    expect(w.get('[data-testid="footer-links-meta"]').text()).toBe('harnu · 3 in 2 sessions')
    expect(w.text()).toContain('Read from the transcripts of every session in this folder.')
    // A single session reads in the singular.
    const one = mountPopover({ scope: 'folder', groups: [groups[0]], folderCount: 1 })
    expect(one.get('[data-testid="footer-links-meta"]').text()).toBe('harnu · 1 in 1 session')
  })

  it('Folder scope shows a placeholder until the first read lands, then the empty line', async () => {
    const w = mountPopover({ scope: 'folder', groups: null })
    expect(w.find('.anim-shimmer-dot').exists()).toBe(true)
    expect(w.find('[data-testid="footer-links-empty"]').exists()).toBe(false)
    await w.setProps({ groups: [] })
    expect(w.find('.anim-shimmer-dot').exists()).toBe(false)
    expect(w.get('[data-testid="footer-links-empty"]').text()).toBe('No links in this folder yet.')
  })

  it('the toggle emits the scope and reflects the current one', async () => {
    const w = mountPopover({ entries: [link()], count: 1 })
    const session = w.get('[data-testid="footer-links-scope-session"]')
    const folder = w.get('[data-testid="footer-links-scope-folder"]')
    expect(session.attributes('aria-pressed')).toBe('true')
    expect(folder.attributes('aria-pressed')).toBe('false')
    await folder.trigger('click')
    expect(w.emitted('update:scope')).toEqual([['folder']])
  })

  it('Open hands the URL to the OS browser', async () => {
    const w = mountPopover({ entries: [link()], count: 1 })
    await w.get('[data-testid="footer-links-open"]').trigger('click')
    expect(shellOpenExternal).toHaveBeenCalledTimes(1)
    expect(shellOpenExternal).toHaveBeenCalledWith('https://github.com/acme/web/pull/183')
  })

  it('Copy writes the URL to the clipboard and shows the success toast', async () => {
    const w = mountPopover({ entries: [link()], count: 1 })
    const ui = useUiStore()
    await w.get('[data-testid="footer-links-copy"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('https://github.com/acme/web/pull/183')
    expect(ui.toasts.map((t) => [t.kind, t.title])).toEqual([['success', 'Link copied']])
  })

  it('Reference writes the URL into the selected live session and asks the footer to close', async () => {
    const w = mountPopover({ entries: [link()], count: 1 })
    const sessions = useSessionsStore()
    sessions.selectedId = 's1'
    sessions.registerLiveSession('s1')
    const write = vi.fn()
    registerWriter('s1', write)
    try {
      await w.get('[data-testid="footer-links-reference"]').trigger('click')
      expect(write).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledWith('https://github.com/acme/web/pull/183 ')
      expect(w.emitted('referenced')).toHaveLength(1)
    } finally {
      unregisterWriter('s1')
    }
  })

  it('Reference is disabled with an inline reason when the session has no live PTY', async () => {
    const w = mountPopover({ entries: [link()], count: 1, canReference: false })
    const btn = w.get('[data-testid="footer-links-reference"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(w.get('[data-testid="footer-links-reference-reason"]').text()).toBe(
      "Session isn't running — resume it to reference"
    )
    // Open and Copy stay active — they never depend on the PTY.
    expect(w.get('[data-testid="footer-links-open"]').attributes('disabled')).toBeUndefined()
    expect(w.get('[data-testid="footer-links-copy"]').attributes('disabled')).toBeUndefined()
    // A click on the disabled button writes nothing even if something forces it through.
    const write = vi.fn()
    registerWriter('s2', write)
    try {
      await btn.trigger('click')
      expect(write).not.toHaveBeenCalled()
      expect(w.emitted('referenced')).toBeUndefined()
    } finally {
      unregisterWriter('s2')
    }
  })
})

describe('StatusFooter — the links pill (AC-5)', () => {
  let wrapper: VueWrapper | null = null

  async function mountFooter(): Promise<VueWrapper> {
    wrapper = mount(StatusFooter, { attachTo: document.body, global: { plugins: [i18n] } })
    await flushPromises()
    return wrapper
  }
  const pill = (w: VueWrapper) => w.find('[data-testid="footer-links-pill"]')
  const imagesPill = (w: VueWrapper) =>
    w.findAll('button').find((b) => (b.attributes('aria-label') ?? '').startsWith('Pasted images'))

  beforeEach(() => {
    i18n.global.locale.value = 'en'
    localStorage.clear()
    setActivePinia(createPinia())
    links.entries = ref([])
    links.groups = ref(null)
    links.refresh = vi.fn(async () => {})
    links.refreshFolder = vi.fn(async () => {})
    images.entries = ref([])
    const none = (): (() => void) => () => {}
    ;(window as unknown as { api: unknown }).api = new Proxy(
      {},
      { get: (_t, key: string) => (key.startsWith('on') ? none : vi.fn(async () => null)) }
    )
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  const esc = async (): Promise<void> => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
  }

  it('hides at zero links and shows the count otherwise', async () => {
    const w = await mountFooter()
    expect(pill(w).exists()).toBe(false)
    links.entries.value = [link(), link({ url: 'https://example.com' })]
    await nextTick()
    expect(pill(w).exists()).toBe(true)
    expect(pill(w).text()).toBe('2')
    expect(pill(w).attributes('aria-label')).toBe('Links — 2')
    links.entries.value = []
    await nextTick()
    expect(pill(w).exists()).toBe(false)
  })

  it('sits immediately right of the pasted-images pill', async () => {
    const w = await mountFooter()
    images.entries.value = [{ name: '1.png', path: '/c/1.png' }]
    links.entries.value = [link()]
    await nextTick()
    const imageAnchor = imagesPill(w)!.element.parentElement!
    expect(imageAnchor.nextElementSibling).toBe(pill(w).element.parentElement)
  })

  it('opens and closes with its button and Esc, with the closed/open tokens', async () => {
    const w = await mountFooter()
    const ui = useUiStore()
    links.entries.value = [link()]
    await nextTick()
    expect(pill(w).classes()).toEqual(expect.arrayContaining(['bg-surface-2', 'text-text-2']))
    await pill(w).trigger('click')
    await flushPromises()
    expect(w.findComponent(FooterLinksPopover).exists()).toBe(true)
    expect(ui.popovers.links).toBe(true)
    expect(links.refresh).toHaveBeenCalledTimes(1)
    expect(pill(w).classes()).toEqual(
      expect.arrayContaining(['bg-accent-soft', 'text-accent', 'border-accent-line'])
    )
    await esc()
    expect(w.findComponent(FooterLinksPopover).exists()).toBe(false)
    await pill(w).trigger('click')
    await pill(w).trigger('click')
    expect(ui.popovers.links).toBe(false)
  })

  it('the Folder scope reads the folder list when chosen; reopening starts on Session again', async () => {
    const w = await mountFooter()
    const ui = useUiStore()
    links.entries.value = [link()]
    await nextTick()
    await pill(w).trigger('click')
    await flushPromises()
    await w.get('[data-testid="footer-links-scope-folder"]').trigger('click')
    await flushPromises()
    expect(links.refreshFolder).toHaveBeenCalledTimes(1)
    expect(w.get('[data-testid="footer-links-scope-folder"]').attributes('aria-pressed')).toBe(
      'true'
    )
    ui.closePopover('links')
    await nextTick()
    await pill(w).trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="footer-links-scope-session"]').attributes('aria-pressed')).toBe(
      'true'
    )
  })

  it('opening the images popover closes the links popover (and the other way round)', async () => {
    const w = await mountFooter()
    const ui = useUiStore()
    images.entries.value = [{ name: '1.png', path: '/c/1.png' }]
    links.entries.value = [link()]
    await nextTick()
    await pill(w).trigger('click')
    expect(ui.popovers.links).toBe(true)
    await imagesPill(w)!.trigger('click')
    expect(ui.popovers.links).toBe(false)
    expect(ui.popovers.pastedImages).toBe(true)
    await pill(w).trigger('click')
    expect(ui.popovers.pastedImages).toBe(false)
    expect(ui.popovers.links).toBe(true)
  })

  it('an outside click closes it', async () => {
    const w = await mountFooter()
    const ui = useUiStore()
    links.entries.value = [link()]
    await nextTick()
    await pill(w).trigger('click')
    expect(ui.popovers.links).toBe(true)
    // vueuse coalesces clicks within one tick, so let the pill's own click settle first.
    await new Promise((r) => setTimeout(r, 5))
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(ui.popovers.links).toBe(false)
  })
})
