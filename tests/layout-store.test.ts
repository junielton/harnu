import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import {
  useLayoutStore,
  helperPanelVisible,
  inboxRailWidthFor,
  nextInboxRailStateOnToggle,
  INBOX_RAIL_MINIMIZED_WIDTH,
  INBOX_RAIL_WIDTH_DEFAULT,
  INBOX_RAIL_WIDTH_MIN,
  INBOX_RAIL_WIDTH_MAX
} from '../src/renderer/src/stores/layout'

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
 * Inbox rail (T83 S0 — the Approval Inbox as a fourth column instead of a modal).
 * The rail's contract is mostly about what it REFUSES to do: minimizing must not
 * hide the badge (that's a width, not a state, so it's asserted in the width
 * helper), toggling must never hide the queue, and an incoming actionable item
 * must be able to break a `hidden` rail open (`summon`).
 */
describe('inboxRailWidthFor', () => {
  it('hidden renders nothing', () => {
    expect(inboxRailWidthFor('hidden', 300)).toBeNull()
  })

  it('minimized is the fixed strip width — NOT the expanded width', () => {
    // The strip still renders the badge; it just costs 44px instead of 300.
    expect(inboxRailWidthFor('minimized', 300)).toBe(INBOX_RAIL_MINIMIZED_WIDTH)
    expect(inboxRailWidthFor('minimized', 440)).toBe(INBOX_RAIL_MINIMIZED_WIDTH)
  })

  it('expanded clamps the persisted width into [260, 440]', () => {
    expect(inboxRailWidthFor('expanded', 300)).toBe(300)
    expect(inboxRailWidthFor('expanded', 10)).toBe(INBOX_RAIL_WIDTH_MIN)
    expect(inboxRailWidthFor('expanded', 9999)).toBe(INBOX_RAIL_WIDTH_MAX)
  })
})

describe('nextInboxRailStateOnToggle', () => {
  it('expanded collapses to the strip', () => {
    expect(nextInboxRailStateOnToggle('expanded')).toBe('minimized')
  })

  it('minimized and hidden both OPEN — a toggle never hides the queue', () => {
    expect(nextInboxRailStateOnToggle('minimized')).toBe('expanded')
    expect(nextInboxRailStateOnToggle('hidden')).toBe('expanded')
  })
})

describe('useLayoutStore inbox rail', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    setActivePinia(createPinia())
  })

  it('defaults to expanded at the default width (the queue is visible out of the box)', () => {
    const s = useLayoutStore()
    expect(s.inboxRailState).toBe('expanded')
    expect(s.inboxRailWidth).toBe(INBOX_RAIL_WIDTH_DEFAULT)
  })

  it('setInboxRailWidth clamps; reset restores the default', () => {
    const s = useLayoutStore()
    s.setInboxRailWidth(9999)
    expect(s.inboxRailWidth).toBe(INBOX_RAIL_WIDTH_MAX)
    s.setInboxRailWidth(0)
    expect(s.inboxRailWidth).toBe(INBOX_RAIL_WIDTH_MIN)
    s.resetInboxRailWidth()
    expect(s.inboxRailWidth).toBe(INBOX_RAIL_WIDTH_DEFAULT)
  })

  it('summon expands a hidden rail — `hidden` is soft, an actionable item breaks it', () => {
    const s = useLayoutStore()
    s.setInboxRailState('hidden')
    s.summonInboxRail()
    expect(s.inboxRailState).toBe('expanded')
  })

  it('summon expands a minimized rail (this is what replaces the modal)', () => {
    const s = useLayoutStore()
    s.setInboxRailState('minimized')
    s.summonInboxRail()
    expect(s.inboxRailState).toBe('expanded')
  })

  it('summon is idempotent on an already-expanded rail', () => {
    const s = useLayoutStore()
    s.summonInboxRail()
    expect(s.inboxRailState).toBe('expanded')
  })

  it('persists the state, and rejects a corrupt persisted value', async () => {
    const s = useLayoutStore()
    s.setInboxRailState('minimized')
    await nextTick()
    expect(localStorage.getItem('om2tab.inboxRailState')).toBe('minimized')

    vi.stubGlobal('localStorage', makeLocalStorage({ 'om2tab.inboxRailState': 'garbage' }))
    setActivePinia(createPinia())
    expect(useLayoutStore().inboxRailState).toBe('expanded')
  })
})
