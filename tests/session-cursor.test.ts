import { describe, it, expect, vi } from 'vitest'
import { ref, computed } from 'vue'
import { useSidebarCursor, type SidebarCursorDeps } from '../src/renderer/src/stores/session-cursor'
import type { Folder, Session } from '../src/renderer/src/stores/sessions'
import type { FolderGroup } from '../src/renderer/src/stores/folder-zones'

/**
 * T25 wave 4 — the sidebar keyboard cursor extracted from the sessions god-store.
 * The largest, most-coupled leaf, so it's pinned in isolation with a fabricated
 * flat list + stub actions (no Pinia). Mirrors the DOM traversal the arrow keys
 * walk. The list used to be two zones (pinned/active); BUG-39 flattened it to
 * one `visibleFolders` computed, and this harness follows suit.
 */

function sess(id: string): Session {
  return { sessionId: id } as Session
}

function folder(over: Partial<Folder> & { path: string }): Folder {
  return { expanded: false, sessions: [], ...over } as Folder
}

/** Build a cursor over a flat list of bare folders, everything else stubbed. */
function build(
  visible: Array<Folder | FolderGroup<Folder>>,
  over: Partial<SidebarCursorDeps> = {}
): {
  cursor: ReturnType<typeof useSidebarCursor>
  select: ReturnType<typeof vi.fn>
  selectFolder: ReturnType<typeof vi.fn>
  toggleFolder: ReturnType<typeof vi.fn>
  toggleGroup: ReturnType<typeof vi.fn>
  folders: ReturnType<typeof ref<Folder[]>>
} {
  // Flatten every folder (bare + group members) into the folders ref.
  const allFolders: Folder[] = []
  for (const n of visible) {
    if ('kind' in n && n.kind === 'folder-group') allFolders.push(...n.folders)
    else allFolders.push(n as Folder)
  }
  const folders = ref<Folder[]>(allFolders)
  const select = vi.fn()
  const selectFolder = vi.fn()
  const toggleFolder = vi.fn()
  const toggleGroup = vi.fn()
  const deps: SidebarCursorDeps = {
    visibleFolders: computed(() => visible),
    sessionsForDisplay: (f) => f.sessions,
    terminalsForFolder: () => [],
    findFolderByPath: (p) => folders.value.find((f) => f.path === p) ?? null,
    findFolderBySessionId: (id) =>
      folders.value.find((f) => f.sessions.some((s) => s.sessionId === id)) ?? null,
    select,
    selectFolder,
    isFolderSelected: () => false,
    toggleFolder,
    toggleGroup,
    ...over
  }
  return {
    cursor: useSidebarCursor(deps),
    select,
    selectFolder,
    toggleFolder,
    toggleGroup,
    folders
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
    const f1 = folder({ path: '/r/a', repoId: 'R', expanded: false, sessions: [] })
    const f2 = folder({ path: '/r/b', repoId: 'R', expanded: false, sessions: [] })
    const group = {
      kind: 'folder-group',
      source: 'repo',
      id: 'R',
      key: 'repo:R',
      expanded: false, // group collapsed → member rows hidden
      folders: [f1, f2]
    } as FolderGroup<Folder>
    const { cursor, toggleGroup } = build([group])
    cursor.keyboardCursor.value = { kind: 'group', id: 'repo:R' }
    cursor.cursorRight() // collapsed → expand the GROUP (not the members' sessions)
    expect(toggleGroup).toHaveBeenCalledWith('repo:R')
    expect(f1.expanded).toBe(false) // inner folders' session-list state untouched
    expect(f2.expanded).toBe(false)
    // Cursor stays on the group while it expands.
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'group', id: 'repo:R' })
  })

  it('right on an EXPANDED group descends into the first member', () => {
    const f1 = folder({ path: '/r/a', repoId: 'R', expanded: false, sessions: [] })
    const f2 = folder({ path: '/r/b', repoId: 'R', expanded: false, sessions: [] })
    const group = {
      kind: 'folder-group',
      source: 'repo',
      id: 'R',
      key: 'repo:R',
      expanded: true,
      folders: [f1, f2]
    } as FolderGroup<Folder>
    const { cursor, toggleGroup } = build([group])
    cursor.keyboardCursor.value = { kind: 'group', id: 'repo:R' }
    cursor.cursorRight() // expanded → descend into the first member folder
    expect(cursor.keyboardCursor.value).toEqual({ kind: 'folder', id: '/r/a' })
    expect(toggleGroup).not.toHaveBeenCalled()
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
    const { cursor, toggleGroup } = build([group])
    cursor.keyboardCursor.value = { kind: 'group', id: 'repo:R' }
    cursor.cursorLeft()
    expect(toggleGroup).toHaveBeenCalledWith('repo:R')
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
    const { cursor, toggleGroup } = build([group])
    cursor.keyboardCursor.value = { kind: 'group', id: 'repo:R' }
    cursor.cursorLeft()
    expect(toggleGroup).not.toHaveBeenCalled()
  })
})

describe('useSidebarCursor — activate', () => {
  // T212: the folder arm changed contract. Enter used to only expand/collapse,
  // which left the Folder View unreachable from the keyboard; it now mirrors a
  // click (select, and expand on the way in).
  it('activate routes session→select, folder→selectFolder, group→toggleGroup', () => {
    const a = folder({ path: '/a', expanded: true, sessions: [sess('s1')] })
    const { cursor, select, selectFolder, toggleFolder, toggleGroup } = build([a])

    cursor.keyboardCursor.value = { kind: 'session', id: 's1' }
    cursor.cursorActivate()
    expect(select).toHaveBeenCalledWith('s1')

    cursor.keyboardCursor.value = { kind: 'folder', id: '/a' }
    cursor.cursorActivate()
    expect(selectFolder).toHaveBeenCalledWith('/a')
    // Already expanded and not already selected → selection only, no collapse.
    expect(toggleFolder).not.toHaveBeenCalled()

    cursor.keyboardCursor.value = { kind: 'group', id: 'repo:R' }
    cursor.cursorActivate()
    expect(toggleGroup).toHaveBeenCalledWith('repo:R')
  })

  it('activate expands a collapsed folder on the way in', () => {
    const a = folder({ path: '/a', expanded: false, sessions: [sess('s1')] })
    const { cursor, selectFolder, toggleFolder } = build([a])

    cursor.keyboardCursor.value = { kind: 'folder', id: '/a' }
    cursor.cursorActivate()

    expect(selectFolder).toHaveBeenCalledWith('/a')
    expect(toggleFolder).toHaveBeenCalledWith('/a')
  })

  it('activate on the already-selected folder collapses it, selection kept', () => {
    const a = folder({ path: '/a', expanded: true, sessions: [sess('s1')] })
    const { cursor, selectFolder, toggleFolder } = build([a], { isFolderSelected: () => true })

    cursor.keyboardCursor.value = { kind: 'folder', id: '/a' }
    cursor.cursorActivate()

    expect(selectFolder).toHaveBeenCalledWith('/a')
    expect(toggleFolder).toHaveBeenCalledWith('/a')
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
