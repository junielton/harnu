import { ref, type Ref, type ComputedRef } from 'vue'
import type { TreeCursorRow } from '../lib/sidebar-tree'
import type { SidebarCursor } from './sessions'

export interface SidebarCursorDeps {
  rows: ComputedRef<TreeCursorRow[]>
  select: (id: string) => void
  selectFolder: (path: string) => void
  toggleTreeFolder: (key: string) => void
  setCheckoutFolded: (path: string, folded: boolean) => void
  toggleIdleWorktrees: (key: string) => void
}

export interface SidebarCursorApi {
  keyboardCursor: Ref<SidebarCursor | null>
  cursorDown: () => void
  cursorUp: () => void
  cursorRight: () => void
  cursorLeft: () => void
  cursorActivate: () => void
  setCursorToSession: (sessionId: string) => void
}

export function useSidebarCursor(deps: SidebarCursorDeps): SidebarCursorApi {
  const keyboardCursor = ref<SidebarCursor | null>(null)

  function cursorIndex(): number {
    const cursor = keyboardCursor.value
    return deps.rows.value.findIndex(
      ({ cursor: row }) => row.kind === cursor?.kind && row.id === cursor.id
    )
  }

  function move(offset: number): void {
    const list = deps.rows.value
    if (!list.length) return
    const index = cursorIndex()
    keyboardCursor.value =
      list[index < 0 ? 0 : Math.max(0, Math.min(index + offset, list.length - 1))].cursor
  }

  function setOpen(row: TreeCursorRow, open: boolean): void {
    if (row.open === undefined || row.open === open) return
    const id = row.cursor.id
    if (row.role === 'header') deps.toggleTreeFolder(id)
    if (row.role === 'checkout') deps.setCheckoutFolded(id, !open)
    if (row.role === 'idle') deps.toggleIdleWorktrees(id.slice('idle:'.length))
  }

  function cursorRight(): void {
    const index = cursorIndex()
    const list = deps.rows.value
    const row = list[index]
    if (!keyboardCursor.value) keyboardCursor.value = list[0]?.cursor ?? null
    else if (row?.open === false) setOpen(row, true)
    else if (row?.open && list[index + 1]?.parent === row) {
      keyboardCursor.value = list[index + 1].cursor
    }
  }

  function cursorLeft(): void {
    const row = deps.rows.value[cursorIndex()]
    if (!keyboardCursor.value) keyboardCursor.value = deps.rows.value[0]?.cursor ?? null
    else if (row?.role === 'session' && row.parent) {
      setOpen(row.parent, false)
      keyboardCursor.value = row.parent.cursor
    } else if (row) setOpen(row, false)
  }

  function cursorActivate(): void {
    const row = deps.rows.value[cursorIndex()]
    if (!row) return
    const { id } = row.cursor
    switch (row.role) {
      case 'header':
        setOpen(row, true)
        if (row.path) deps.selectFolder(row.path)
        break
      case 'idle-worktree':
        deps.selectFolder(id)
        break
      case 'session':
        deps.select(id)
        break
      case 'checkout':
      case 'idle':
        setOpen(row, !row.open)
        break
    }
  }

  return {
    keyboardCursor,
    cursorDown: () => move(1),
    cursorUp: () => move(-1),
    cursorRight,
    cursorLeft,
    cursorActivate,
    setCursorToSession: (id) => {
      keyboardCursor.value = { kind: 'session', id }
    }
  }
}
