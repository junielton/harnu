import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useLayoutStore, helperPanelVisible } from '../src/renderer/src/stores/layout'

/**
 * Layout collapse state (feat/layout-collapse — design.md §6 "Colapsar
 * sidebars"). Two persisted booleans (`sidebarCollapsed` / `helperCollapsed`)
 * on the layout store + the pure `helperPanelVisible` predicate that gates the
 * right panel. `localStorage` is stubbed with `vi.stubGlobal` (same harness as
 * `persisted.test.ts`); the store persists via a Vue `watch`, so writes need an
 * `await nextTick()` to flush.
 */

function makeLocalStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    }
  } as Storage
}

describe('helperPanelVisible', () => {
  it('renders only when the worktree has panes AND is not collapsed', () => {
    expect(helperPanelVisible(true, false)).toBe(true)
  })

  it('collapsed hides the panel EVEN WHEN panes exist', () => {
    // The core rule of the feature: a manual collapse beats the auto-show.
    expect(helperPanelVisible(true, true)).toBe(false)
  })

  it('no panes → hidden regardless of the collapse flag', () => {
    expect(helperPanelVisible(false, false)).toBe(false)
    expect(helperPanelVisible(false, true)).toBe(false)
  })
})

describe('useLayoutStore collapse state', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    setActivePinia(createPinia())
  })

  it('both collapse flags default to false (nothing hidden until asked)', () => {
    const s = useLayoutStore()
    expect(s.sidebarCollapsed).toBe(false)
    expect(s.helperCollapsed).toBe(false)
  })

  it('toggleSidebar / toggleHelper flip the respective flags', () => {
    const s = useLayoutStore()
    s.toggleSidebar()
    expect(s.sidebarCollapsed).toBe(true)
    expect(s.helperCollapsed).toBe(false) // independent
    s.toggleSidebar()
    expect(s.sidebarCollapsed).toBe(false)

    s.toggleHelper()
    expect(s.helperCollapsed).toBe(true)
    s.toggleHelper()
    expect(s.helperCollapsed).toBe(false)
  })

  it('setSidebarCollapsed / setHelperCollapsed set the flags explicitly', () => {
    const s = useLayoutStore()
    s.setSidebarCollapsed(true)
    expect(s.sidebarCollapsed).toBe(true)
    s.setHelperCollapsed(true)
    expect(s.helperCollapsed).toBe(true)
    s.setHelperCollapsed(false) // idempotent set-false path (reveal-on-appear)
    expect(s.helperCollapsed).toBe(false)
  })

  it('does NOT write the default on init (absent key stays absent)', () => {
    useLayoutStore()
    expect(localStorage.getItem('om2tab.sidebarCollapsed')).toBeNull()
    expect(localStorage.getItem('om2tab.helperCollapsed')).toBeNull()
  })

  it('persists a toggle to localStorage as "true" / "false"', async () => {
    const s = useLayoutStore()
    s.toggleSidebar()
    await nextTick()
    expect(localStorage.getItem('om2tab.sidebarCollapsed')).toBe('true')
    s.toggleSidebar()
    await nextTick()
    expect(localStorage.getItem('om2tab.sidebarCollapsed')).toBe('false')

    s.toggleHelper()
    await nextTick()
    expect(localStorage.getItem('om2tab.helperCollapsed')).toBe('true')
  })

  it('reads a persisted collapsed=true on init (survives a restart)', () => {
    vi.stubGlobal(
      'localStorage',
      makeLocalStorage({ 'om2tab.sidebarCollapsed': 'true', 'om2tab.helperCollapsed': 'true' })
    )
    setActivePinia(createPinia())
    const s = useLayoutStore()
    expect(s.sidebarCollapsed).toBe(true)
    expect(s.helperCollapsed).toBe(true)
  })

  it('a non-"true" persisted value deserializes to false (corruption-safe)', () => {
    vi.stubGlobal('localStorage', makeLocalStorage({ 'om2tab.sidebarCollapsed': 'garbage' }))
    setActivePinia(createPinia())
    expect(useLayoutStore().sidebarCollapsed).toBe(false)
  })
})

/**
 * The sidebar's bottom dock (design.md §6 "Bottom dock"). Its contract is mostly about what it
 * refuses to do: nothing but an operator gesture opens Needs you, and that state is never stored.
 */
describe('useLayoutStore dock', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    setActivePinia(createPinia())
  })

  it('starts with both sections folded, whatever an earlier run left behind', async () => {
    const s = useLayoutStore()
    expect(s.needsYouOpen).toBe(false)
    expect(s.returnHereOpen).toBe(false)
    s.openNeedsYou()
    await nextTick()
    setActivePinia(createPinia())
    expect(useLayoutStore().needsYouOpen).toBe(false)
  })

  it('openNeedsYou expands a collapsed sidebar and asks the shell to show it', () => {
    const s = useLayoutStore()
    s.setSidebarCollapsed(true)
    const before = s.sidebarRevealRequest
    s.openNeedsYou()
    expect(s.sidebarCollapsed).toBe(false)
    expect(s.needsYouOpen).toBe(true)
    expect(s.sidebarRevealRequest).toBe(before + 1)
  })

  it('the chord folds an open section, and opens it when the sidebar hides it', () => {
    const s = useLayoutStore()
    s.toggleNeedsYou()
    expect(s.needsYouOpen).toBe(true)
    s.toggleNeedsYou()
    expect(s.needsYouOpen).toBe(false)

    s.openNeedsYou()
    s.setSidebarCollapsed(true)
    s.toggleNeedsYou()
    expect(s.sidebarCollapsed).toBe(false)
    expect(s.needsYouOpen).toBe(true)
  })

  it('Needs attention is open by default and remembers a fold', async () => {
    const s = useLayoutStore()
    expect(s.attentionOpen).toBe(true)
    s.attentionOpen = false
    await nextTick()
    expect(localStorage.getItem('om2tab.attentionOpen')).toBe('false')
    setActivePinia(createPinia())
    expect(useLayoutStore().attentionOpen).toBe(false)
  })
})
