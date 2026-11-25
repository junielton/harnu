import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setActivePinia, createPinia } from 'pinia'
import { useUiStore } from '../src/renderer/src/stores/ui'

/**
 * T297 U2 (T299) — the `activeView` + registry refactor that replaces the six
 * hand-kept takeover refs. These tests cover the acceptance criteria that
 * T298's pre-existing tripwires (deliberately left untouched — see
 * `tests/folder-selection.test.ts`) don't already pin.
 */

const REPO = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

/** Prose ABOUT a rule (a comment) is not a violation of it. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    .join('\n')
}

// ── AC-3 — App.vue holds no per-takeover v-else-if chain ───────────────────

describe('AC-3: App.vue renders every takeover through one TakeoverHost, not a v-else-if chain', () => {
  it('the six takeover components are no longer imported or rendered in App.vue', () => {
    const app = codeOnly(read('src/renderer/src/App.vue'))
    // Neither the import nor the template tag survives — TakeoverHost.vue owns
    // them now. A future PR reintroducing e.g. `<RoadmapBoard v-else-if=…`
    // fails this the moment it re-adds either.
    for (const component of [
      'RoadmapBoard',
      'PrStackCanvas',
      'CleanupView',
      'UsageDashboard',
      'SystemMonitor',
      'ReviewPane'
    ]) {
      expect(app, `App.vue still imports ${component}`).not.toContain(
        `from './components/${component}.vue'`
      )
      expect(app, `App.vue still renders <${component}`).not.toMatch(
        new RegExp(`<${component}[\\s/>]`)
      )
    }
    expect(app).toContain('<TakeoverHost')
  })

  it('TakeoverHost is the only place the six takeover components are wired to a registry', () => {
    const host = codeOnly(read('src/renderer/src/components/TakeoverHost.vue'))
    for (const component of [
      'RoadmapBoard',
      'PrStackCanvas',
      'CleanupView',
      'UsageDashboard',
      'SystemMonitor',
      'ReviewPane'
    ]) {
      expect(host, `TakeoverHost is missing ${component}`).toContain(component)
    }
    expect(host).toContain('activeView')
  })
})

// ── AC-1/AC-2 — one state, one close path ───────────────────────────────────

describe('AC-1/AC-2: activeView is the one takeover ref, closeAllTakeovers is one assignment', () => {
  it('stores/ui.ts declares no ref for the six old flags — only `activeView`', () => {
    const store = codeOnly(read('src/renderer/src/stores/ui.ts'))
    for (const oldRef of [
      'const roadmap = ref',
      'const prStack = ref',
      'const review = ref',
      'const usageDashboardOpen = ref',
      'const systemMonitorOpen = ref',
      'const cleanupOpen = ref'
    ]) {
      expect(store, `stores/ui.ts still declares ${oldRef}`).not.toContain(oldRef)
    }
    expect(store).toContain('const activeView = ref')
  })

  it("closeAllTakeovers is a single assignment plus the leaving entry's onClose — no per-view list", () => {
    const store = codeOnly(read('src/renderer/src/stores/ui.ts'))
    const fn = store.slice(store.indexOf('function closeAllTakeovers'))
    const body = fn.slice(0, fn.indexOf('\n  }'))
    expect(body).toContain('activeView.value = null')
    // None of the six old per-view resets survive inside it.
    for (const stale of [
      'roadmap.value =',
      'prStack.value =',
      'review.value =',
      'usageDashboardOpen.value =',
      'systemMonitorOpen.value =',
      'cleanupOpen.value ='
    ]) {
      expect(body, `closeAllTakeovers still contains ${stale}`).not.toContain(stale)
    }
  })
})

// ── AC-5 — fireReviewClosed via the registry's onClose, on the close edge only ──

describe('AC-5: the review companion disposal hook fires on the close edge only, via the registry', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('open review -> open another view: fires exactly once', () => {
    const ui = useUiStore()
    const onClosed = vi.fn()
    ui.registerReviewClosedHandler(onClosed)

    ui.openReview('/repos/alpha', 'card-a')
    expect(onClosed).not.toHaveBeenCalled()

    ui.openRoadmap('/repos/alpha', 'alpha')
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('open review -> open review again (same or different folder): fires exactly once, not zero', () => {
    const ui = useUiStore()
    const onClosed = vi.fn()
    ui.registerReviewClosedHandler(onClosed)

    ui.openReview('/repos/alpha', 'card-a')
    ui.openReview('/repos/beta', 'card-b')

    // Re-opening the review IS a close of the previous one — the companion for
    // '/repos/alpha' must be disposed even though the newly active view is
    // also 'review'.
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('open review -> close it (X / Esc): fires exactly once', () => {
    const ui = useUiStore()
    const onClosed = vi.fn()
    ui.registerReviewClosedHandler(onClosed)

    ui.openReview('/repos/alpha', 'card-a')
    ui.closeReview()

    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('opening a non-review view never fires it', () => {
    const ui = useUiStore()
    const onClosed = vi.fn()
    ui.registerReviewClosedHandler(onClosed)

    ui.openRoadmap('/repos/alpha', 'alpha')
    ui.openPrStack('/repos/alpha', 'alpha')
    ui.openCleanup()
    ui.closeAllTakeovers()

    expect(onClosed).not.toHaveBeenCalled()
  })
})

// ── AC-7 — menu entries and notification navigation stay open-only ─────────

describe('AC-7: FolderMenu, SessionMenu, RepoGroupHeader and openNavigableView never toggle', () => {
  const TOGGLE_CALLS = [
    'ui.toggleRoadmap',
    'ui.togglePrStack',
    'ui.toggleReview',
    'ui.toggleCleanup',
    'ui.toggleUsageDashboard',
    'ui.toggleSystemMonitor'
  ]

  it.each([
    'src/renderer/src/components/FolderMenu.vue',
    'src/renderer/src/components/SessionMenu.vue',
    'src/renderer/src/components/RepoGroupHeader.vue'
  ])('%s calls no ui.toggle* for a main-pane view', (rel) => {
    const code = codeOnly(read(rel))
    for (const toggle of TOGGLE_CALLS) {
      expect(code, `${rel} calls ${toggle}`).not.toContain(toggle)
    }
  })

  it('openNavigableView (notification navigation) only ever opens, never toggles', () => {
    const store = codeOnly(read('src/renderer/src/stores/ui.ts'))
    const fn = store.slice(store.indexOf('function openNavigableView'))
    const body = fn.slice(
      0,
      fn.indexOf('\nfunction ') === -1 ? fn.length : fn.indexOf('\nfunction ')
    )
    for (const toggle of TOGGLE_CALLS) {
      expect(body, `openNavigableView calls ${toggle}`).not.toContain(toggle)
    }
  })
})
