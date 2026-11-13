// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  useSidebarSection,
  resetSidebarSectionsForTests
} from '../src/renderer/src/composables/useSidebarSections'

const KEY = 'om2tab.sidebarSection.return'

describe('useSidebarSection', () => {
  beforeEach(() => {
    localStorage.clear()
    resetSidebarSectionsForTests()
    vi.restoreAllMocks()
  })

  it('starts content-sized and expanded, and writes nothing until something changes', () => {
    const s = useSidebarSection('return')
    expect(s.height.value).toBeNull()
    expect(s.collapsed.value).toBe(false)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('persists height and collapsed state per section id', () => {
    const s = useSidebarSection('return')
    s.setHeight(240)
    s.toggleCollapsed()
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toEqual({
      height: 240,
      collapsed: true
    })
    // another section does not share it
    expect(useSidebarSection('other').height.value).toBeNull()
    expect(localStorage.getItem('om2tab.sidebarSection.other')).toBeNull()
  })

  it('survives a reload: a fresh module state reads what was stored', () => {
    const s = useSidebarSection('return')
    s.setHeight(180)
    s.toggleCollapsed()
    resetSidebarSectionsForTests() // what a page reload does to module state
    const again = useSidebarSection('return')
    expect(again.height.value).toBe(180)
    expect(again.collapsed.value).toBe(true)
  })

  it('survives the zone hiding and reappearing: two handles for one id share one state', () => {
    const first = useSidebarSection('return')
    first.setHeight(200)
    first.toggleCollapsed()
    // the section component unmounts (the zone is empty), then mounts again later
    const second = useSidebarSection('return')
    expect(second.height.value).toBe(200)
    expect(second.collapsed.value).toBe(true)
    second.toggleCollapsed()
    expect(first.collapsed.value).toBe(false)
  })

  it('reset() clears the height (the double-click) and keeps the collapsed flag', () => {
    const s = useSidebarSection('return')
    s.setHeight(300)
    s.toggleCollapsed()
    s.reset()
    expect(s.height.value).toBeNull()
    expect(s.collapsed.value).toBe(true)
    expect(JSON.parse(localStorage.getItem(KEY) as string).height).toBeNull()
  })

  it('reads a corrupt stored value as the default', () => {
    localStorage.setItem(KEY, '{{{ nope')
    const s = useSidebarSection('return')
    expect(s.height.value).toBeNull()
    expect(s.collapsed.value).toBe(false)
  })

  it('keeps working in memory when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const s = useSidebarSection('return')
    expect(s.collapsed.value).toBe(false)
    expect(() => s.toggleCollapsed()).not.toThrow()
    expect(s.collapsed.value).toBe(true)
    expect(() => s.setHeight(222)).not.toThrow()
    expect(s.height.value).toBe(222)
  })
})
