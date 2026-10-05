// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import SidebarHiddenPopover from '../src/renderer/src/components/SidebarHiddenPopover.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'

// The popover template is a `<Teleport to="body">` (same idiom as the deleted
// `SidebarSectionMenu.vue` and every other floating surface in App.vue's
// Teleport group) — its rendered content lives outside the mounted
// component's own DOM subtree, so `wrapper.text()`/`wrapper.get()` can't see
// it (the wrapper's root is just the teleport's comment anchor). The tests
// below mount with `attachTo: document.body` and assert against `document`
// directly, mirroring the established pattern for other Teleported components
// in this repo (see `tests/new-worktree-dialog-escape.test.ts`).

let mounted: ReturnType<typeof mount>[] = []

/** A hidden-folder fixture — only the fields the popover actually reads. */
function folder(
  path: string,
  alias: string,
  extra: {
    gitBranch?: string
    repoId?: string
    isMainWorktree?: boolean
    sessionCount?: number
  } = {}
): unknown {
  return {
    path,
    alias,
    gitBranch: extra.gitBranch ?? '',
    repoId: extra.repoId,
    isMainWorktree: extra.isMainWorktree,
    sessions: Array.from({ length: extra.sessionCount ?? 0 }, (_, i) => ({
      sessionId: `${path}-s${i}`,
      status: 'idle',
      modified: new Date(0).toISOString()
    })),
    expanded: false,
    pinned: false
  }
}

/**
 * Two worktrees of one repo (so `groupByRepo` forms a group) plus a
 * standalone folder that never groups — the shape AC-2 describes.
 */
function seedHiddenFolders(): ReturnType<typeof useSessionsStore> {
  const sessionsStore = useSessionsStore()
  const folders = [
    folder('/repos/www', 'www', { repoId: 'repo-www', isMainWorktree: true, sessionCount: 2 }),
    folder('/repos/www-wave-1', 'PROJ-347-wave-1', {
      repoId: 'repo-www',
      gitBranch: 'card/PROJ-347',
      sessionCount: 1
    }),
    folder('/repos/api-gateway', 'api-gateway', { gitBranch: 'main', sessionCount: 0 })
  ]
  sessionsStore.folders.push(...(folders as never[]))
  sessionsStore.manuallyHiddenPaths = new Set(folders.map((f) => (f as { path: string }).path))
  return sessionsStore
}

/** Mount closed, then open — so the `open` watcher runs (listeners + focus). */
async function openPopover(): Promise<ReturnType<typeof mount>> {
  const ui = useUiStore()
  const w = mount(SidebarHiddenPopover, { global: { plugins: [i18n] }, attachTo: document.body })
  mounted.push(w)
  ui.openSidebarHiddenPopover({ left: 0, top: 0, right: 0, bottom: 0 })
  await w.vm.$nextTick()
  await w.vm.$nextTick()
  return w
}

function searchInput(): HTMLInputElement {
  const el = document.querySelector('[data-testid="hidden-search"]') as HTMLInputElement | null
  expect(el).not.toBeNull()
  return el!
}

async function type(w: ReturnType<typeof mount>, value: string): Promise<void> {
  const input = searchInput()
  input.value = value
  input.dispatchEvent(new Event('input'))
  await w.vm.$nextTick()
}

function rows(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll('[role="dialog"] button[role="option"]')
  ) as HTMLButtonElement[]
}

function pressKey(key: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('SidebarHiddenPopover', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    mounted.forEach((w) => w.unmount())
    mounted = []
    document.body.innerHTML = ''
  })

  it('renders nothing when the popover is closed', () => {
    const w = mount(SidebarHiddenPopover, { global: { plugins: [i18n] } })
    mounted.push(w)
    expect(w.find('[role="dialog"]').exists()).toBe(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('lists dismissed folders when open and unhides on click', async () => {
    const sessionsStore = useSessionsStore()
    const ui = useUiStore()
    sessionsStore.manuallyHiddenPaths = new Set(['/repos/alpha'])
    sessionsStore.folders.push(folder('/repos/alpha', 'alpha') as never)
    const unhideSpy = vi.spyOn(sessionsStore, 'unhideFolder').mockResolvedValue()

    ui.openSidebarHiddenPopover({ left: 0, top: 0, right: 0, bottom: 0 })
    const w = mount(SidebarHiddenPopover, { global: { plugins: [i18n] }, attachTo: document.body })
    mounted.push(w)
    await w.vm.$nextTick()

    expect(document.body.textContent).toContain('alpha')
    // Scoped to the unhide button specifically — the popover's first focusable
    // element is now the search input (T290), not a folder row.
    const button = document.querySelector(
      '[role="dialog"] button[aria-label*="alpha"]'
    ) as HTMLButtonElement | null
    expect(button).not.toBeNull()
    button!.click()
    await w.vm.$nextTick()
    expect(unhideSpy).toHaveBeenCalledWith('/repos/alpha')
  })

  // ── AC-1 — search input ───────────────────────────────────────────────────

  it('AC-1: autofocuses the search input and filters by alias, branch and path', async () => {
    seedHiddenFolders()
    const w = await openPopover()

    expect(document.activeElement).toBe(searchInput())
    expect(rows()).toHaveLength(3)

    // By alias.
    await type(w, 'wave')
    expect(rows().map((r) => r.textContent?.trim())).toHaveLength(1)
    expect(document.body.textContent).toContain('PROJ-347-wave-1')

    // By branch — the alias does NOT contain "card/".
    await type(w, 'card/')
    expect(rows()).toHaveLength(1)

    // By path — only the standalone folder lives under `/repos/api-`.
    await type(w, '/repos/api-')
    expect(rows()).toHaveLength(1)
    expect(document.body.textContent).toContain('api-gateway')

    // Case-insensitive.
    await type(w, 'WAVE')
    expect(rows()).toHaveLength(1)
  })

  it('AC-1: shows an "N of M" counter that tracks the filter', async () => {
    seedHiddenFolders()
    const w = await openPopover()

    const counter = (): string =>
      document.querySelector('[data-testid="hidden-counter"]')?.textContent?.trim() ?? ''
    expect(counter()).toBe('3 of 3')

    // `www` matches the main worktree's alias AND both worktree paths.
    await type(w, 'www')
    expect(counter()).toBe('2 of 3')

    await type(w, 'api')
    expect(counter()).toBe('1 of 3')

    await type(w, 'zzz-no-match')
    expect(counter()).toBe('0 of 3')
  })

  // ── AC-2 — grouping, session counts, match highlighting ───────────────────

  it('AC-2: groups rows under repo eyebrows and gives ungrouped folders their own', async () => {
    seedHiddenFolders()
    await openPopover()

    const sections = Array.from(document.querySelectorAll('[data-testid="hidden-section"]'))
    expect(sections).toHaveLength(2)

    // The repo group resolves its label the way `RepoGroupHeader` does: the
    // main worktree's basename, and the member count on the right.
    const repoEyebrow = sections[0].firstElementChild as HTMLElement
    expect(repoEyebrow.textContent).toContain('www')
    expect(repoEyebrow.textContent).toContain('2')
    expect(sections[0].querySelectorAll('button[role="option"]')).toHaveLength(2)

    // The standalone folder falls under its own alias.
    const loneEyebrow = sections[1].firstElementChild as HTMLElement
    expect(loneEyebrow.textContent).toContain('api-gateway')
    expect(sections[1].querySelectorAll('button[role="option"]')).toHaveLength(1)
  })

  it('AC-2: shows a session-count hint per row and bolds the matched substring', async () => {
    seedHiddenFolders()
    const w = await openPopover()

    const hints = Array.from(document.querySelectorAll('[data-testid="hidden-session-hint"]')).map(
      (n) => n.textContent?.trim()
    )
    expect(hints).toEqual(['2 sessions', '1 session', 'no sessions'])

    await type(w, 'wave')
    const bold = document.querySelector('[role="dialog"] button[role="option"] b')
    expect(bold).not.toBeNull()
    expect(bold!.textContent).toBe('wave')
  })

  // ── AC-3 — selection, chip, keyboard ──────────────────────────────────────

  it('AC-3: the selected row carries an Unhide chip, ↑/↓ move it, ↵ unhides', async () => {
    const sessionsStore = seedHiddenFolders()
    const unhideSpy = vi.spyOn(sessionsStore, 'unhideFolder').mockResolvedValue()
    const w = await openPopover()

    // The first row starts selected and is the only one with the chip.
    let chips = document.querySelectorAll('[data-testid="hidden-unhide-chip"]')
    expect(chips).toHaveLength(1)
    expect(rows()[0].contains(chips[0])).toBe(true)

    pressKey('ArrowDown')
    await w.vm.$nextTick()
    chips = document.querySelectorAll('[data-testid="hidden-unhide-chip"]')
    expect(rows()[1].contains(chips[0])).toBe(true)

    pressKey('ArrowUp')
    await w.vm.$nextTick()
    chips = document.querySelectorAll('[data-testid="hidden-unhide-chip"]')
    expect(rows()[0].contains(chips[0])).toBe(true)

    pressKey('Enter')
    await w.vm.$nextTick()
    expect(unhideSpy).toHaveBeenCalledWith('/repos/www')

    // Unhiding keeps the popover open (existing behavior).
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('AC-3: moving the cursor scrolls the selected row into view', async () => {
    seedHiddenFolders()
    const w = await openPopover()

    // jsdom doesn't implement scrollIntoView; the component optional-calls it.
    const scrollSpy = vi.fn()
    ;(Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollSpy

    pressKey('ArrowDown')
    await w.vm.$nextTick()
    await w.vm.$nextTick()

    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrollSpy.mock.instances[0]).toBe(rows()[1])

    delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
  })

  it('AC-3: hovering a row moves the cursor but never scrolls the list', async () => {
    seedHiddenFolders()
    const w = await openPopover()

    const scrollSpy = vi.fn()
    ;(Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollSpy

    rows()[2].dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    await w.vm.$nextTick()
    await w.vm.$nextTick()

    // The cursor followed the pointer...
    expect(rows()[2].getAttribute('aria-selected')).toBe('true')
    // ...but the list did NOT scroll under it.
    expect(scrollSpy).not.toHaveBeenCalled()

    // A keyboard move still scrolls, so the guard didn't disable the feature.
    pressKey('ArrowDown')
    await w.vm.$nextTick()
    await w.vm.$nextTick()
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })

    delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView
  })

  it('AC-3: clicking the chip unhides that row and keeps the popover open', async () => {
    const sessionsStore = seedHiddenFolders()
    const unhideSpy = vi.spyOn(sessionsStore, 'unhideFolder').mockResolvedValue()
    const w = await openPopover()

    const chip = document.querySelector('[data-testid="hidden-unhide-chip"]') as HTMLElement
    chip.click()
    await w.vm.$nextTick()

    expect(unhideSpy).toHaveBeenCalledWith('/repos/www')
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  })

  // ── AC-4 — bulk unhide footer ─────────────────────────────────────────────

  it('AC-4: "Unhide all N" appears only while a filter narrows the list to 2+', async () => {
    seedHiddenFolders()
    const w = await openPopover()

    const bulk = (): HTMLElement | null =>
      document.querySelector('[data-testid="hidden-unhide-all"]')

    // No filter — the footer carries only the kbd hint.
    expect(bulk()).toBeNull()
    expect(document.body.textContent).toContain('↵')

    // A filter matching one row is not a bulk opportunity.
    await type(w, 'api-gateway')
    expect(bulk()).toBeNull()

    // A filter matching two rows is — `www` hits both worktrees of the repo.
    await type(w, 'www')
    expect(bulk()?.textContent?.trim()).toBe('Unhide all 2')
  })

  it('AC-4: "Unhide all N" unhides every listed folder', async () => {
    const sessionsStore = seedHiddenFolders()
    const unhideSpy = vi.spyOn(sessionsStore, 'unhideFolder').mockResolvedValue()
    const w = await openPopover()

    await type(w, 'www')
    const bulk = document.querySelector('[data-testid="hidden-unhide-all"]') as HTMLElement
    bulk.click()
    await w.vm.$nextTick()
    await w.vm.$nextTick()

    expect(unhideSpy).toHaveBeenCalledWith('/repos/www')
    expect(unhideSpy).toHaveBeenCalledWith('/repos/www-wave-1')
    expect(unhideSpy).toHaveBeenCalledTimes(2)
  })

  it('AC-4: "Unhide all N" reports a batch failure once, not once per folder', async () => {
    const sessionsStore = seedHiddenFolders()
    vi.spyOn(sessionsStore, 'unhideFolder').mockRejectedValue(new Error('EACCES'))
    const ui = useUiStore()
    const toastSpy = vi.spyOn(ui, 'pushToast')
    const w = await openPopover()

    await type(w, 'www')
    const bulk = document.querySelector('[data-testid="hidden-unhide-all"]') as HTMLElement
    bulk.click()
    await new Promise((r) => setTimeout(r, 0))
    await w.vm.$nextTick()

    // Both folders failed, but the operator gets ONE toast, not two.
    expect(toastSpy).toHaveBeenCalledTimes(1)
    expect(toastSpy.mock.calls[0][0].description).toContain('2')
    expect(toastSpy.mock.calls[0][0].description).toContain('EACCES')
  })

  // ── AC-5 — empty results ──────────────────────────────────────────────────

  it('AC-5: a filter with no matches renders the empty copy, not an empty list', async () => {
    seedHiddenFolders()
    const w = await openPopover()

    await type(w, 'nothing-matches-this')
    expect(rows()).toHaveLength(0)
    const empty = document.querySelector('[data-testid="hidden-empty"]')
    expect(empty).not.toBeNull()
    expect(empty!.textContent?.trim()).toBe('No hidden folder matches this search.')
  })
})
