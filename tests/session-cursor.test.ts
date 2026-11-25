import { describe, it, expect, vi } from 'vitest'
import { ref, computed } from 'vue'
import { useSidebarCursor, type SidebarCursorDeps } from '../src/renderer/src/stores/session-cursor'
import type { Folder, Session } from '../src/renderer/src/stores/sessions'
import type { FolderGroup } from '../src/renderer/src/stores/folder-zones'

import { buildSidebarTree, flattenSidebarTree } from '../src/renderer/src/lib/sidebar-tree'

function sess(id: string): Session {
  return { sessionId: id } as Session
}

function folder(over: Partial<Folder> & { path: string }): Folder {
  return { alias: over.path, expanded: false, sessions: [], ...over } as Folder
}

function build(visible: Array<Folder | FolderGroup<Folder>>) {
  const changed = ref(0)
  const folded = new Set<string>()
  const idleOpen = new Set<string>()
  const select = vi.fn()
  const selectFolder = vi.fn()
  const hasRows = (folder: Folder) => folder.sessions.length > 0
  const tree = computed(() => {
    void changed.value
    const order = visible.flatMap((n) => ('folders' in n ? n.folders : [n]))
    return buildSidebarTree(visible, { order, aliasFromBranchPaths: new Set(), hasRows })
  })
  const toggleTreeFolder = vi.fn((key: string) => {
    const node = tree.value.find((folder) => folder.key === key)!
    if (node.group) node.group.expanded = !node.open
    else node.primary.expanded = !node.open
    changed.value++
  })
  const setCheckoutFolded = vi.fn((path: string, fold: boolean) => {
    if (fold) folded.add(path)
    else folded.delete(path)
    changed.value++
  })
  const toggleIdleWorktrees = vi.fn((key: string) => {
    if (idleOpen.has(key)) idleOpen.delete(key)
    else idleOpen.add(key)
    changed.value++
  })
  const deps: SidebarCursorDeps = {
    rows: computed(() =>
      flattenSidebarTree(tree.value, {
        hasRows,
        sessionIds: (folder) => folder.sessions.map((s) => s.sessionId),
        checkoutFolded: (path) => folded.has(path),
        idleOpen: (key) => idleOpen.has(key)
      })
    ),
    select,
    selectFolder,
    toggleTreeFolder,
    setCheckoutFolded,
    toggleIdleWorktrees
  }
  return {
    cursor: useSidebarCursor(deps),
    select,
    selectFolder,
    toggleTreeFolder,
    setCheckoutFolded,
    toggleIdleWorktrees
  }
}

describe('useSidebarCursor — vertical nav', () => {
  it('cursorDown seeds to the first row then walks the flattened tree', () => {
    const a = folder({ path: '/a', expanded: true, sessions: [sess('s1'), sess('s2')] })
    const b = folder({ path: '/b', expanded: false, sessions: [sess('s3')] })
    const { cursor } = build([a, b])
    // Flattened: folder /a, session s1, session s2, folder /b (b collapsed).
    cursor.cursorDown()
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'folder', id: '/a' })
    cursor.cursorDown()
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'session', id: 's1' })
    cursor.cursorDown()
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'session', id: 's2' })
    cursor.cursorDown()
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'folder', id: '/b' })
    cursor.cursorDown() // clamps at the last row
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'folder', id: '/b' })
  })

  it('cursorUp walks back and clamps at the top', () => {
    const a = folder({ path: '/a', expanded: true, sessions: [sess('s1')] })
    const { cursor } = build([a])
    cursor.keyboardCursor.value = { kind: 'session', id: 's1' }
    cursor.cursorUp()
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'folder', id: '/a' })
    cursor.cursorUp() // clamps at the top
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'folder', id: '/a' })
  })

  it('a re-seed from an invisible cursor lands on the first row', () => {
    const a = folder({ path: '/a', expanded: false, sessions: [] })
    const { cursor } = build([a])
    cursor.keyboardCursor.value = { kind: 'session', id: 'ghost' } // not in the list
    cursor.cursorDown()
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'folder', id: '/a' })
  })
})

describe('useSidebarCursor — horizontal nav', () => {
  it('cursorRight expands a collapsed folder, then descends into its first session', () => {
    const a = folder({ path: '/a', expanded: false, sessions: [sess('s1')] })
    const { cursor } = build([a])
    cursor.keyboardCursor.value = { kind: 'folder', id: '/a' }
    cursor.cursorRight() // collapsed → expand (cursor stays on the folder)
    expect(a.expanded).toBe(true)
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'folder', id: '/a' })
    cursor.cursorRight() // expanded → descend into first session
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'session', id: 's1' })
  })

  it('cursorLeft collapses the parent folder and moves the cursor onto it', () => {
    const a = folder({ path: '/a', expanded: true, sessions: [sess('s1')] })
    const { cursor } = build([a])
    cursor.keyboardCursor.value = { kind: 'session', id: 's1' }
    cursor.cursorLeft()
    expect(a.expanded).toBe(false)
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'folder', id: '/a' })
  })

  it('cursorLeft on a folder collapses it in place', () => {
    const a = folder({ path: '/a', expanded: true, sessions: [] })
    const { cursor } = build([a])
    cursor.keyboardCursor.value = { kind: 'folder', id: '/a' }
    cursor.cursorLeft()
    expect(a.expanded).toBe(false)
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'folder', id: '/a' })
  })
})

describe('useSidebarCursor — repo groups', () => {
  it('right on a COLLAPSED group expands the group, leaving member sessions untouched', () => {
    const f1 = folder({
      path: '/r/a',
      repoId: 'R',
      isMainWorktree: true,
      expanded: false,
      sessions: []
    })
    const f2 = folder({ path: '/r/b', repoId: 'R', expanded: false, sessions: [] })
    const group = {
      kind: 'folder-group',
      source: 'repo',
      id: 'R',
      key: 'repo:R',
      expanded: false, // group collapsed → member rows hidden
      folders: [f1, f2]
    } as FolderGroup<Folder>
    const { cursor, toggleTreeFolder } = build([group])
    cursor.keyboardCursor.value = { kind: 'group', id: 'repo:R' }
    cursor.cursorRight() // collapsed → expand the GROUP (not the members' sessions)
    expect(toggleTreeFolder).toHaveBeenCalledWith('repo:R')
    expect(f1.expanded).toBe(false) // inner folders' session-list state untouched
    expect(f2.expanded).toBe(false)
    // Cursor stays on the group while it expands.
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'group', id: 'repo:R' })
  })

  it('right on an EXPANDED group descends into the first member', () => {
    const f1 = folder({
      path: '/r/a',
      repoId: 'R',
      isMainWorktree: true,
      expanded: false,
      sessions: []
    })
    const f2 = folder({ path: '/r/b', repoId: 'R', expanded: false, sessions: [] })
    const group = {
      kind: 'folder-group',
      source: 'repo',
      id: 'R',
      key: 'repo:R',
      expanded: true,
      folders: [f1, f2]
    } as FolderGroup<Folder>
    const { cursor, toggleTreeFolder } = build([group])
    cursor.keyboardCursor.value = { kind: 'group', id: 'repo:R' }
    cursor.cursorRight() // expanded → descend into the first member folder
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'folder', id: '/r/a' })
    expect(toggleTreeFolder).not.toHaveBeenCalled()
  })

  it('left on an EXPANDED group collapses the group, leaving member sessions untouched', () => {
    const f1 = folder({ path: '/r/a', repoId: 'R', expanded: true, sessions: [] })
    const group = {
      kind: 'folder-group',
      source: 'repo',
      id: 'R',
      key: 'repo:R',
      expanded: true,
      folders: [f1]
    } as FolderGroup<Folder>
    const { cursor, toggleTreeFolder } = build([group])
    cursor.keyboardCursor.value = { kind: 'group', id: 'repo:R' }
    cursor.cursorLeft()
    expect(toggleTreeFolder).toHaveBeenCalledWith('repo:R')
    expect(f1.expanded).toBe(true) // inner folder's session-list state untouched
  })

  it('left on an already-COLLAPSED group is a no-op', () => {
    const f1 = folder({ path: '/r/a', repoId: 'R', expanded: false, sessions: [] })
    const group = {
      kind: 'folder-group',
      source: 'repo',
      id: 'R',
      key: 'repo:R',
      expanded: false,
      folders: [f1]
    } as FolderGroup<Folder>
    const { cursor, toggleTreeFolder } = build([group])
    cursor.keyboardCursor.value = { kind: 'group', id: 'repo:R' }
    cursor.cursorLeft()
    expect(toggleTreeFolder).not.toHaveBeenCalled()
  })
})

describe('useSidebarCursor — activate', () => {
  it('activate selects a session, opens the repo primary, and toggles a checkout or idle group', () => {
    const a = folder({ path: '/a', repoId: 'R', isMainWorktree: true, sessions: [sess('s1')] })
    const b = folder({ path: '/b', repoId: 'R' })
    const group: FolderGroup<Folder> = {
      kind: 'folder-group',
      source: 'repo',
      id: 'R',
      key: 'repo:R',
      label: 'R',
      derivedLabel: 'R',
      expanded: true,
      folders: [a, b]
    }
    const {
      cursor,
      select,
      selectFolder,
      toggleTreeFolder,
      setCheckoutFolded,
      toggleIdleWorktrees
    } = build([group])

    cursor.keyboardCursor.value = { kind: 'session', id: 's1' }
    cursor.cursorActivate()
    expect(select).toHaveBeenCalledWith('s1')
    cursor.cursorLeft()
    expect(setCheckoutFolded).toHaveBeenLastCalledWith('/a', true)
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'folder', id: '/a' })
    cursor.cursorActivate()
    expect(setCheckoutFolded).toHaveBeenLastCalledWith('/a', false)

    cursor.keyboardCursor.value = { kind: 'group', id: 'repo:R' }
    cursor.cursorActivate()
    expect(selectFolder).toHaveBeenLastCalledWith('/a')
    expect(toggleTreeFolder).not.toHaveBeenCalled()

    cursor.keyboardCursor.value = { kind: 'group', id: 'idle:repo:R' }
    cursor.cursorActivate()
    expect(toggleIdleWorktrees).toHaveBeenCalledWith('repo:R')
    cursor.cursorRight()
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'folder', id: '/b' })
    cursor.cursorActivate()
    expect(selectFolder).toHaveBeenLastCalledWith('/b')
  })

  it('activate expands a collapsed folder on the way in', () => {
    const a = folder({ path: '/a', expanded: false, sessions: [sess('s1')] })
    const { cursor, selectFolder, toggleTreeFolder } = build([a])

    cursor.keyboardCursor.value = { kind: 'folder', id: '/a' }
    cursor.cursorActivate()

    expect(selectFolder).toHaveBeenCalledWith('/a')
    expect(toggleTreeFolder).toHaveBeenCalledWith('/a')
  })

  it('repeated activation selects the folder without collapsing it', () => {
    const a = folder({ path: '/a', expanded: true, sessions: [sess('s1')] })
    const { cursor, selectFolder, toggleTreeFolder } = build([a])

    cursor.keyboardCursor.value = { kind: 'folder', id: '/a' }
    cursor.cursorActivate()
    cursor.cursorActivate()

    expect(selectFolder).toHaveBeenCalledWith('/a')
    expect(toggleTreeFolder).not.toHaveBeenCalled()
    expect(a.expanded).toBe(true)
  })

  it('activate is a no-op when the cursor is unset', () => {
    const { cursor, select } = build([folder({ path: '/a' })])
    cursor.cursorActivate()
    expect(select).not.toHaveBeenCalled()
  })

  it('an empty visible list contributes no cursor rows', () => {
    const { cursor } = build([])
    cursor.cursorDown() // nothing visible → cursor stays null
    expect(cursor.keyboardCursor.value).toBeNull()
  })
})

describe('useSidebarCursor — setCursorToSession (BUG-31)', () => {
  it('jumps the cursor directly onto a session, overriding wherever it was', () => {
    const a = folder({ path: '/a', expanded: true, sessions: [sess('s1'), sess('s2')] })
    const { cursor } = build([a])
    cursor.keyboardCursor.value = { kind: 'folder', id: '/a' }

    cursor.setCursorToSession('s2')

    expect(cursor.keyboardCursor.value).toEqual({ kind: 'session', id: 's2' })
  })

  it('does not walk or validate the tree — works even for a session outside it', () => {
    const { cursor } = build([folder({ path: '/a' })])
    cursor.setCursorToSession('not-in-any-visible-folder')
    expect(cursor.keyboardCursor.value).toEqual({
      kind: 'session',
      id: 'not-in-any-visible-folder'
    })
  })
})
