import { displayAlias } from '../components/folder-alias'
import { basename, dirname, isFolderGroup, type FolderGroup } from '../stores/folder-zones'
import type { Folder, SidebarCursor } from '../stores/sessions'

export interface TreeFolder {
  key: string
  group: FolderGroup<Folder> | null
  label: string
  parentHint?: string
  open: boolean
  git: boolean
  primary: Folder
  checkouts: Folder[]
  idle: Folder[]
  checkoutCount: number
  paths: string[]
}

interface TreeOptions {
  /** Every listed folder in the folder sort order: a repo's checkouts are drawn in it. */
  order: readonly Folder[]
  aliasFromBranchPaths: ReadonlySet<string>
  hasRows: (folder: Folder) => boolean
  /** Repo folders closed while a text filter holds them open (their group reads `expanded`). */
  closed?: ReadonlySet<string>
}

export function buildSidebarTree(
  nodes: Array<Folder | FolderGroup<Folder>>,
  opts: TreeOptions
): TreeFolder[] {
  const labels = new Map<string, number>()
  const rank = new Map(opts.order.map((folder, index) => [folder.path, index]))
  const at = (folder: Folder): number => rank.get(folder.path) ?? rank.size
  const tree = nodes.map((node): TreeFolder => {
    const group = isFolderGroup(node) ? node : null
    const members = isFolderGroup(node) ? [...node.folders].sort((a, b) => at(a) - at(b)) : [node]
    const main = members.find((folder) => folder.isMainWorktree)
    const primary = main ?? members[0]
    const ordered = main ? [main, ...members.filter((folder) => folder !== main)] : members
    const git = Boolean(primary.repoId || primary.gitBranch)
    const label = group?.label ?? displayAlias(primary, opts.aliasFromBranchPaths.has(primary.path))
    labels.set(label, (labels.get(label) ?? 0) + 1)
    const checkouts: Folder[] = []
    const idle: Folder[] = []
    if (git) {
      for (const folder of ordered) {
        const listed = !group || folder === main || opts.hasRows(folder)
        if (listed) checkouts.push(folder)
        else idle.push(folder)
      }
    }
    return {
      key: group?.key ?? primary.path,
      group,
      label,
      open: group ? group.expanded && !opts.closed?.has(group.key) : primary.expanded,
      git,
      primary,
      checkouts,
      idle,
      checkoutCount: checkouts.length + idle.length,
      paths: ordered.map((folder) => folder.path)
    }
  })
  for (const folder of tree) {
    if ((labels.get(folder.label) ?? 0) > 1) {
      folder.parentHint = basename(dirname(folder.primary.path))
    }
  }
  return tree
}

function same<T>(a: readonly T[] = [], b: readonly T[] = []): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

function sameTreeFolder(a: TreeFolder, b: TreeFolder): boolean {
  return (
    a.label === b.label &&
    a.parentHint === b.parentHint &&
    a.open === b.open &&
    a.git === b.git &&
    a.primary === b.primary &&
    a.checkoutCount === b.checkoutCount &&
    !a.group === !b.group &&
    same(a.group?.folders, b.group?.folders) &&
    same(a.group?.shelved, b.group?.shelved) &&
    same(a.checkouts, b.checkouts) &&
    same(a.idle, b.idle) &&
    same(a.paths, b.paths)
  )
}

/**
 * `next`, with every folder that draws the same as before kept as the previous
 * object, and the previous array itself when none changed.
 */
export function reuseTree(previous: TreeFolder[] | undefined, next: TreeFolder[]): TreeFolder[] {
  if (!previous) return next
  const byKey = new Map(previous.map((folder) => [folder.key, folder]))
  const tree = next.map((folder) => {
    const old = byKey.get(folder.key)
    return old && sameTreeFolder(old, folder) ? old : folder
  })
  return same(previous, tree) ? previous : tree
}

export type RailState = 'working' | 'failed' | 'needs-input'

/**
 * The group rail of one checkout (design.md "Group rail"), read from the same
 * per-checkout level the folder ring takes its hottest session from.
 */
export function railState(level: number): RailState | undefined {
  return ([undefined, 'working', 'failed', 'needs-input'] as const)[level]
}

export function checkoutLabel(folder: Folder): string {
  return folder.gitBranch || folder.alias
}

export function treeHeaderCursor(folder: TreeFolder): SidebarCursor {
  return { kind: folder.git ? 'group' : 'folder', id: folder.key }
}

export interface TreeCursorRow {
  cursor: SidebarCursor
  role: 'header' | 'checkout' | 'idle' | 'idle-worktree' | 'session'
  parent?: TreeCursorRow
  open?: boolean
  path?: string
}

interface CursorOptions {
  hasRows: (folder: Folder) => boolean
  sessionIds: (folder: Folder) => string[]
  checkoutFolded: (path: string) => boolean
  idleOpen: (key: string) => boolean
}

export function flattenSidebarTree(tree: TreeFolder[], opts: CursorOptions): TreeCursorRow[] {
  const rows: TreeCursorRow[] = []

  function appendSessions(folder: Folder, parent: TreeCursorRow): void {
    for (const id of opts.sessionIds(folder)) {
      rows.push({ cursor: { kind: 'session', id }, role: 'session', parent })
    }
  }

  for (const folder of tree) {
    const header: TreeCursorRow = {
      cursor: treeHeaderCursor(folder),
      role: 'header',
      path: folder.primary.path,
      open: folder.open
    }
    rows.push(header)
    if (!folder.open) continue
    if (!folder.git) {
      appendSessions(folder.primary, header)
      continue
    }
    for (const checkout of folder.checkouts) {
      const row: TreeCursorRow = {
        cursor: { kind: 'folder', id: checkout.path },
        role: 'checkout',
        open: opts.hasRows(checkout) ? !opts.checkoutFolded(checkout.path) : undefined,
        parent: header
      }
      rows.push(row)
      if (row.open) appendSessions(checkout, row)
    }
    if (folder.idle.length) {
      const idle: TreeCursorRow = {
        cursor: { kind: 'group', id: `idle:${folder.key}` },
        role: 'idle',
        open: opts.idleOpen(folder.key),
        parent: header
      }
      rows.push(idle)
      if (idle.open) {
        for (const worktree of folder.idle) {
          rows.push({
            cursor: { kind: 'folder', id: worktree.path },
            role: 'idle-worktree',
            parent: idle
          })
        }
      }
    }
  }
  return rows
}

export type CollapseLevel = 0 | 1 | 2

export function treeCollapseLevel(
  tree: TreeFolder[],
  hasRows: (folder: Folder) => boolean,
  checkoutFolded: (path: string) => boolean
): CollapseLevel {
  let level: CollapseLevel = 0
  for (const folder of tree) {
    if (!folder.open) continue
    level = 1
    if (
      folder.git
        ? folder.checkouts.some((checkout) => !checkoutFolded(checkout.path) && hasRows(checkout))
        : hasRows(folder.primary)
    ) {
      return 2
    }
  }
  return level
}
