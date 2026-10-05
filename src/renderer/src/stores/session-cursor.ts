import { ref, type Ref, type ComputedRef } from 'vue'
import { isFolderGroup, type FolderGroup } from './folder-zones'
import type { Folder, Session, SidebarCursor } from './sessions'

/** One entry of the sidebar list: a bare folder, or a group header. */
type ZoneNode = Folder | FolderGroup<Folder>

/**
 * Sidebar keyboard-navigation cursor (T25 wave 4) — extracted from the
 * `sessions.ts` god-store as an injectable composable. The largest leaf: it
 * walks the visible tree (groups → folders → sessions/terminals) and moves
 * a cursor over it, flipping `folder.expanded`, selecting sessions, and toggling
 * groups on activate.
 *
 * High READ-coupling but strictly one-directional: it reads the `visibleFolders`
 * computed + display helpers and calls `select`/`toggleFolder`/`toggleGroup`,
 * all injected (DI) so nothing imports the store back (plan risk #4). It owns
 * only the `keyboardCursor` ref. `folder.expanded` writes go through the same
 * reactive folder objects the store owns (the `folders` ref surfaces them).
 */

/** The cross-cutting store surface the cursor walks + acts on (all injected). */
export interface SidebarCursorDeps {
  /** The single flat sidebar list (folders + group headers), display order. */
  visibleFolders: ComputedRef<ZoneNode[]>
  /** Sessions shown under a folder, in display order (age filter + sort applied). */
  sessionsForDisplay: (folder: Folder) => Session[]
  /** Folder terminals shown under a folder (their own sub-group). */
  terminalsForFolder: (folder: Folder) => Session[]
  /** A folder by path, or null. */
  findFolderByPath: (path: string) => Folder | null
  /** The folder owning a session UUID, or null. */
  findFolderBySessionId: (sessionId: string) => Folder | null
  /** Select (mount) a session. */
  select: (id: string) => void
  /** Select a FOLDER, opening its `FolderView` (T212). */
  selectFolder: (path: string) => void
  /** Is this folder the currently selected one? (T212 — click parity.) */
  isFolderSelected: (path: string) => boolean
  /** Toggle a folder's expansion. */
  toggleFolder: (path: string) => void
  /** Toggle a group's expansion, by namespaced group key. */
  toggleGroup: (key: string) => void
}

/** The sidebar-cursor surface {@link useSidebarCursor} returns. */
export interface SidebarCursorApi {
  keyboardCursor: Ref<SidebarCursor | null>
  cursorDown: () => void
  cursorUp: () => void
  cursorRight: () => void
  cursorLeft: () => void
  cursorActivate: () => void
  setCursorToSession: (sessionId: string) => void
}

/** Build the sidebar keyboard cursor over the injected tree + actions. */
export function useSidebarCursor(deps: SidebarCursorDeps): SidebarCursorApi {
  const {
    visibleFolders,
    sessionsForDisplay,
    terminalsForFolder,
    findFolderByPath,
    findFolderBySessionId,
    select,
    selectFolder,
    isFolderSelected,
    toggleFolder,
    toggleGroup
  } = deps

  /**
   * The current cursor position, or null (unset). Separate from `selectedId` —
   * the cursor flips selection only on `cursorActivate()` (Enter). T-4.6.
   */
  const keyboardCursor = ref<SidebarCursor | null>(null)

  /**
   * Flatten the visible sidebar tree into an ordered list of cursor positions.
   *
   * Walks `visibleFolders`. A `FolderGroup` emits a `group` row, then (if
   * expanded) its member folders (each a plain `folder` row, one indent level);
   * a bare `Folder` emits a `folder` row, then (if its own `expanded` flag is
   * set) its sessions. Mirrors the DOM the user sees, which is what the arrow
   * keys must traverse.
   */
  function flattenVisibleSidebar(): SidebarCursor[] {
    const out: SidebarCursor[] = []
    const pushFolder = (f: Folder): void => {
      out.push({ kind: 'folder', id: f.path })
      if (!f.expanded) return
      for (const s of sessionsForDisplay(f)) {
        out.push({ kind: 'session', id: s.sessionId })
      }
      // Folder terminals render in their own sub-group directly below the
      // sessions (same DOM order). They reuse the `'session'` cursor kind —
      // arrow nav and Enter (`cursorActivate` → `select`) behave identically for
      // a shell row, and no cursor action is session-specific (there is no
      // archive/delete bound to the cursor), so the kind carries no wrong
      // behaviour. Without this the keyboard cursor skipped over them entirely
      // (mouse-only).
      for (const term of terminalsForFolder(f)) {
        out.push({ kind: 'session', id: term.sessionId })
      }
    }
    const walk = (zone: ZoneNode[]): void => {
      for (const node of zone) {
        if (isFolderGroup(node)) {
          out.push({ kind: 'group', id: node.key })
          if (!node.expanded) continue
          for (const f of node.folders) pushFolder(f)
        } else {
          pushFolder(node)
        }
      }
    }
    walk(visibleFolders.value)
    return out
  }

  /** Find a group node by namespaced key in the visible list (for its `expanded` state). */
  function findGroup(key: string): FolderGroup<Folder> | null {
    for (const node of visibleFolders.value) {
      if (isFolderGroup(node) && node.key === key) return node
    }
    return null
  }

  /**
   * Index of the current cursor inside the visible list. Returns `-1` if the
   * cursor is `null` OR points at something no longer visible.
   */
  function cursorIndex(list: SidebarCursor[]): number {
    const cur = keyboardCursor.value
    if (!cur) return -1
    return list.findIndex((x) => x.kind === cur.kind && x.id === cur.id)
  }

  /** Move the cursor one row down. Seeds to the first row when unset. */
  function cursorDown(): void {
    const list = flattenVisibleSidebar()
    if (list.length === 0) return
    const i = cursorIndex(list)
    if (i === -1) {
      keyboardCursor.value = list[0]
      return
    }
    keyboardCursor.value = list[Math.min(i + 1, list.length - 1)]
  }

  /** Move the cursor one row up. Seeds to the first row when unset. */
  function cursorUp(): void {
    const list = flattenVisibleSidebar()
    if (list.length === 0) return
    const i = cursorIndex(list)
    if (i === -1) {
      keyboardCursor.value = list[0]
      return
    }
    keyboardCursor.value = list[Math.max(i - 1, 0)]
  }

  /**
   * Right-arrow behaviour:
   *  - group collapsed → expand it
   *  - group expanded  → move into first member folder
   *  - folder collapsed → expand it
   *  - folder expanded  → move into first session (if any)
   *  - session → no-op (leaves)
   */
  function cursorRight(): void {
    const list = flattenVisibleSidebar()
    if (list.length === 0) return
    if (!keyboardCursor.value) {
      keyboardCursor.value = list[0]
      return
    }
    const cur = keyboardCursor.value
    if (cur.kind === 'group') {
      const group = findGroup(cur.id)
      if (!group || group.folders.length === 0) return
      // Collapsed → expand the group (reveal its member rows). Expanded → step
      // into the first member. Uses the group's own collapse state, NOT the
      // members' `expanded` flags (those are each folder's session list).
      if (!group.expanded) {
        toggleGroup(cur.id)
        return
      }
      keyboardCursor.value = { kind: 'folder', id: group.folders[0].path }
      return
    }
    if (cur.kind === 'folder') {
      const f = findFolderByPath(cur.id)
      if (!f) return
      if (!f.expanded) {
        f.expanded = true
        return
      }
      const display = sessionsForDisplay(f)
      if (display.length > 0) {
        keyboardCursor.value = { kind: 'session', id: display[0].sessionId }
      }
      return
    }
    // session: leaves are inert under right-arrow.
  }

  /**
   * Left-arrow behaviour:
   *  - session → collapse parent folder, move cursor onto that folder
   *  - folder  → collapse it (stay on the folder)
   *  - group → collapse it (stay on the group)
   */
  function cursorLeft(): void {
    const cur = keyboardCursor.value
    if (!cur) {
      const list = flattenVisibleSidebar()
      if (list.length > 0) keyboardCursor.value = list[0]
      return
    }
    if (cur.kind === 'session') {
      const folder = findFolderBySessionId(cur.id)
      if (!folder) return
      folder.expanded = false
      keyboardCursor.value = { kind: 'folder', id: folder.path }
      return
    }
    if (cur.kind === 'folder') {
      const f = findFolderByPath(cur.id)
      if (f) f.expanded = false
      return
    }
    if (cur.kind === 'group') {
      // Collapse the group (hide its member rows) — leaves each inner folder's
      // session-list state untouched. No-op if already collapsed.
      const group = findGroup(cur.id)
      if (group?.expanded) toggleGroup(cur.id)
      return
    }
  }

  /**
   * Enter on the cursor. Sessions get selected (mounts the terminal); folders
   * and groups toggle their expansion. No-op when the cursor is unset.
   */
  function cursorActivate(): void {
    const cur = keyboardCursor.value
    if (!cur) return
    if (cur.kind === 'session') {
      select(cur.id)
      return
    }
    if (cur.kind === 'folder') {
      // T212: Enter must do exactly what a click does — open the folder's view.
      // Before this it only expanded/collapsed, so the whole feature was
      // unreachable from the arrow-key cursor (the sidebar's real keyboard nav).
      // Mirrors `SidebarFolder.onFolderClick`: select, and expand on the way in;
      // a second Enter on the already-selected folder collapses it, selection kept.
      const alreadySelected = isFolderSelected(cur.id)
      selectFolder(cur.id)
      if (!findFolderByPath(cur.id)?.expanded || alreadySelected) toggleFolder(cur.id)
      return
    }
    if (cur.kind === 'group') {
      toggleGroup(cur.id)
      return
    }
  }

  /**
   * Move the cursor directly onto a session row (BUG-31) — for a non-keyboard
   * "jump to session" affordance (OS-notification click, toast "Open", drill-in)
   * that must still paint the single accent-outline the arrow keys produce.
   * Unlike `cursorDown`/`cursorUp`/etc., this does not walk or validate the
   * visible tree — the caller is responsible for making the row visible first
   * (expanding its folder, teammate group, or bento idle reveal).
   */
  function setCursorToSession(sessionId: string): void {
    keyboardCursor.value = { kind: 'session', id: sessionId }
  }

  return {
    keyboardCursor,
    cursorDown,
    cursorUp,
    cursorRight,
    cursorLeft,
    cursorActivate,
    setCursorToSession
  }
}
