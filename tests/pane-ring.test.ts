import { describe, it, expect, vi } from 'vitest'
import {
  MAIN_REGION,
  paneRing,
  stepRing,
  focusPaneStep,
  togglePaneMaximize,
  closeFocusedPane,
  toggleTerminal,
  type PaneRingState,
  type PaneCommandDeps
} from '../src/renderer/src/lib/pane-ring'

/**
 * T486 U5b — the pane ring (`docs/specs/T486-keybindings-coverage-pass.md` §8)
 * and the four pane commands built on it. Pure (node env): every effect goes
 * through `PaneCommandDeps`, so App.vue's wiring is the only untested glue.
 *
 *  - AC-22: F6 walks main → helper panes in stack order → wraps; Shift+F6 reverses.
 *  - AC-23: the ring drops a covered main terminal, a collapsed panel and the
 *    non-maximized panes; focus outside the ring goes to the first / last region;
 *    an empty ring is a no-op.
 *  - AC-26: `pane.toggleMaximize`.
 *  - AC-27: `pane.close` goes through the pane's own close path.
 *  - AC-29: `terminal.toggle`'s three states.
 */

const base: PaneRingState = {
  mainForeground: true,
  stackShown: true,
  helperCollapsed: false,
  paneIds: ['a', 'b', 'c'],
  maximizedId: null
}

describe('paneRing (AC-22, AC-23)', () => {
  it('is main, then the helper panes in stack order', () => {
    expect(paneRing(base)).toEqual([MAIN_REGION, 'a', 'b', 'c'])
  })

  it('drops a covered main terminal (a takeover or the Folder View is on top)', () => {
    expect(paneRing({ ...base, mainForeground: false })).toEqual(['a', 'b', 'c'])
  })

  it('drops the helper panes when the panel is collapsed', () => {
    expect(paneRing({ ...base, helperCollapsed: true })).toEqual([MAIN_REGION])
  })

  it('drops the helper panes when the stack is not shown', () => {
    expect(paneRing({ ...base, stackShown: false })).toEqual([MAIN_REGION])
  })

  it('keeps only the maximized pane while one is maximized', () => {
    expect(paneRing({ ...base, maximizedId: 'b' })).toEqual([MAIN_REGION, 'b'])
  })

  it('ignores a stale maximized id that names no pane in the stack', () => {
    expect(paneRing({ ...base, maximizedId: 'gone' })).toEqual([MAIN_REGION, 'a', 'b', 'c'])
  })

  it('is empty under a takeover with no helper stack', () => {
    expect(paneRing({ ...base, mainForeground: false, stackShown: false })).toEqual([])
  })
})

describe('stepRing (AC-22, AC-23)', () => {
  const ring = [MAIN_REGION, 'a', 'b']

  it('F6 moves to the next region and wraps', () => {
    expect(stepRing(ring, MAIN_REGION, 1)).toBe('a')
    expect(stepRing(ring, 'a', 1)).toBe('b')
    expect(stepRing(ring, 'b', 1)).toBe(MAIN_REGION)
  })

  it('Shift+F6 reverses and wraps', () => {
    expect(stepRing(ring, MAIN_REGION, -1)).toBe('b')
    expect(stepRing(ring, 'b', -1)).toBe('a')
    expect(stepRing(ring, 'a', -1)).toBe(MAIN_REGION)
  })

  it('focus outside the ring goes to the first region (F6) or the last (Shift+F6)', () => {
    expect(stepRing(ring, null, 1)).toBe(MAIN_REGION)
    expect(stepRing(ring, null, -1)).toBe('b')
    // A region that exists but is not in the ring (a non-maximized pane's header).
    expect(stepRing(ring, 'c', 1)).toBe(MAIN_REGION)
    expect(stepRing(ring, 'c', -1)).toBe('b')
  })

  it('an empty ring is a no-op', () => {
    expect(stepRing([], null, 1)).toBeNull()
    expect(stepRing([], 'a', -1)).toBeNull()
  })

  it('a ring of one re-focuses it', () => {
    expect(stepRing(['a'], 'a', 1)).toBe('a')
    expect(stepRing(['a'], 'a', -1)).toBe('a')
  })
})

/** A fake world for the commands: a stack, a focused region, a collapsed flag. */
function world(init: {
  panes?: Array<{ id: string; type: string }>
  current?: string | null
  maximizedId?: string | null
  collapsed?: boolean
  mainForeground?: boolean
  worktree?: string | null
  /** Panes whose close path refuses (a dirty Markdown / Diagram pane). */
  guarded?: string[]
}) {
  const s = {
    panes: init.panes ?? [],
    current: init.current ?? null,
    maximizedId: init.maximizedId ?? null,
    collapsed: init.collapsed ?? false,
    mainForeground: init.mainForeground ?? true,
    worktree: init.worktree === undefined ? '/wt' : init.worktree,
    guarded: new Set(init.guarded ?? [])
  }
  const calls = {
    focus: vi.fn((id: string) => {
      s.current = id
    }),
    close: vi.fn((id: string) => {
      if (id === MAIN_REGION) return false
      if (!s.guarded.has(id)) s.panes = s.panes.filter((p) => p.id !== id)
      return true
    }),
    toggleMaximize: vi.fn((_wt: string, id: string) => {
      s.maximizedId = s.maximizedId === id ? null : id
    }),
    addShell: vi.fn((_wt: string) => {
      s.panes = [...s.panes, { id: 'new-shell', type: 'shell' }]
      s.collapsed = false
    }),
    setHelperCollapsed: vi.fn((c: boolean) => {
      s.collapsed = c
    }),
    closeCoveringTakeover: vi.fn(),
    blur: vi.fn(() => {
      s.current = null
    })
  }
  const deps: PaneCommandDeps = {
    ring: () =>
      paneRing({
        mainForeground: s.mainForeground,
        stackShown: s.panes.length > 0,
        helperCollapsed: s.collapsed,
        paneIds: s.panes.map((p) => p.id),
        maximizedId: s.maximizedId
      }),
    current: () => s.current,
    worktree: () => s.worktree,
    panes: () => s.panes,
    maximizedId: () => s.maximizedId,
    afterRender: (fn) => fn(),
    ...calls
  }
  return { s, calls, deps }
}

const STACK = [
  { id: 'md', type: 'markdown' },
  { id: 'sh', type: 'shell' },
  { id: 'sh2', type: 'shell' }
]

describe('focusPaneStep (AC-22, AC-23)', () => {
  it('walks the ring from the focused region', () => {
    const { s, deps } = world({ panes: STACK, current: MAIN_REGION })
    focusPaneStep(deps, 1)
    expect(s.current).toBe('md')
    focusPaneStep(deps, 1)
    focusPaneStep(deps, 1)
    focusPaneStep(deps, 1)
    expect(s.current).toBe(MAIN_REGION)
    focusPaneStep(deps, -1)
    expect(s.current).toBe('sh2')
  })

  it('does nothing on an empty ring', () => {
    const { calls, deps } = world({ panes: [], mainForeground: false })
    focusPaneStep(deps, 1)
    expect(calls.focus).not.toHaveBeenCalled()
  })
})

describe('togglePaneMaximize (AC-26)', () => {
  it('toggles maximize on the focused helper pane; focus stays in it', () => {
    const { s, calls, deps } = world({ panes: STACK, current: 'sh' })
    togglePaneMaximize(deps)
    expect(calls.toggleMaximize).toHaveBeenCalledWith('/wt', 'sh')
    expect(s.maximizedId).toBe('sh')
    expect(s.current).toBe('sh')
    togglePaneMaximize(deps)
    expect(s.maximizedId).toBeNull()
  })

  it('with no helper pane focused, restores a maximized pane', () => {
    const { s, calls, deps } = world({ panes: STACK, current: MAIN_REGION, maximizedId: 'md' })
    togglePaneMaximize(deps)
    expect(calls.toggleMaximize).toHaveBeenCalledWith('/wt', 'md')
    expect(s.maximizedId).toBeNull()
  })

  it('otherwise does nothing', () => {
    const onMain = world({ panes: STACK, current: MAIN_REGION })
    togglePaneMaximize(onMain.deps)
    expect(onMain.calls.toggleMaximize).not.toHaveBeenCalled()
    const outside = world({ panes: STACK, current: null })
    togglePaneMaximize(outside.deps)
    expect(outside.calls.toggleMaximize).not.toHaveBeenCalled()
  })

  it('does nothing without a current worktree', () => {
    const { calls, deps } = world({ panes: STACK, current: 'sh', worktree: null })
    togglePaneMaximize(deps)
    expect(calls.toggleMaximize).not.toHaveBeenCalled()
  })
})

describe('closeFocusedPane (AC-27)', () => {
  it('closes the focused pane through its own close path, then focuses the next region', () => {
    const { s, calls, deps } = world({ panes: STACK, current: 'md' })
    closeFocusedPane(deps)
    expect(calls.close).toHaveBeenCalledWith('md')
    expect(s.panes.map((p) => p.id)).toEqual(['sh', 'sh2'])
    expect(s.current).toBe('sh')
  })

  it('closing the last region of the ring wraps focus to main', () => {
    const { s, deps } = world({ panes: STACK, current: 'sh2' })
    closeFocusedPane(deps)
    expect(s.current).toBe(MAIN_REGION)
  })

  it("leaves focus alone when the pane's discard guard keeps it open", () => {
    const { s, calls, deps } = world({ panes: STACK, current: 'md', guarded: ['md'] })
    closeFocusedPane(deps)
    expect(calls.close).toHaveBeenCalledWith('md')
    expect(s.panes.map((p) => p.id)).toEqual(['md', 'sh', 'sh2'])
    expect(calls.focus).not.toHaveBeenCalled()
  })

  it('does nothing when no pane holds focus, or the main terminal does', () => {
    const none = world({ panes: STACK, current: null })
    closeFocusedPane(none.deps)
    expect(none.calls.close).not.toHaveBeenCalled()
    const main = world({ panes: STACK, current: MAIN_REGION })
    closeFocusedPane(main.deps)
    expect(main.s.panes).toHaveLength(3)
    expect(main.calls.focus).not.toHaveBeenCalled()
  })
})

describe('toggleTerminal (AC-29)', () => {
  it('no shell pane → adds one in the current worktree, and never a second', () => {
    const { s, calls, deps } = world({ panes: [{ id: 'md', type: 'markdown' }], current: null })
    toggleTerminal(deps)
    expect(calls.addShell).toHaveBeenCalledWith('/wt')
    expect(calls.closeCoveringTakeover).toHaveBeenCalled()
    // The next press finds that shell instead of appending another.
    s.current = 'md'
    toggleTerminal(deps)
    expect(calls.addShell).toHaveBeenCalledTimes(1)
    expect(s.panes.filter((p) => p.type === 'shell')).toHaveLength(1)
  })

  it('a shell pane that is not focused → reveals the panel and focuses it', () => {
    const { s, calls, deps } = world({ panes: STACK, current: MAIN_REGION, collapsed: true })
    toggleTerminal(deps)
    expect(calls.addShell).not.toHaveBeenCalled()
    expect(calls.closeCoveringTakeover).toHaveBeenCalled()
    expect(s.collapsed).toBe(false)
    expect(s.current).toBe('sh') // the FIRST shell pane
  })

  it('restores another maximized pane so the shell is visible', () => {
    const { s, calls, deps } = world({ panes: STACK, current: MAIN_REGION, maximizedId: 'md' })
    toggleTerminal(deps)
    expect(calls.toggleMaximize).toHaveBeenCalledWith('/wt', 'md')
    expect(s.maximizedId).toBeNull()
    expect(s.current).toBe('sh')
  })

  it('leaves the shell maximized when it is the maximized pane', () => {
    const { s, calls, deps } = world({ panes: STACK, current: MAIN_REGION, maximizedId: 'sh' })
    toggleTerminal(deps)
    expect(calls.toggleMaximize).not.toHaveBeenCalled()
    expect(s.maximizedId).toBe('sh')
  })

  it('the shell pane already holds focus → collapses the panel and focuses main', () => {
    const { s, calls, deps } = world({ panes: STACK, current: 'sh' })
    toggleTerminal(deps)
    expect(s.collapsed).toBe(true)
    expect(s.current).toBe(MAIN_REGION)
    expect(calls.addShell).not.toHaveBeenCalled()
  })

  it('collapsing with the main terminal covered leaves focus on <body>', () => {
    const { s, calls, deps } = world({ panes: STACK, current: 'sh', mainForeground: false })
    toggleTerminal(deps)
    expect(s.collapsed).toBe(true)
    expect(calls.blur).toHaveBeenCalled()
    expect(calls.focus).not.toHaveBeenCalled()
  })

  it('does nothing without a current worktree', () => {
    const { calls, deps } = world({ panes: [], worktree: null })
    toggleTerminal(deps)
    expect(calls.addShell).not.toHaveBeenCalled()
    expect(calls.setHelperCollapsed).not.toHaveBeenCalled()
    expect(calls.closeCoveringTakeover).not.toHaveBeenCalled()
  })
})
