import { ipcMain } from 'electron'
import { promises as fs, type Dirent } from 'node:fs'
import * as path from 'node:path'
import { normalizePath } from './user-projects'

/**
 * Folder-creation + subfolder-enumeration IPC (T69). Backs the FolderMenu's
 * "New folder…" (create a subfolder inside a pinned folder and pin it) and
 * "Open subfolder…" (recursively list subfolders → in-app picker → pin) flows,
 * replacing the "leave Harnu and run `harnu .`" round-trip.
 *
 * Both handlers are read-only-safe against traversal: `createSubfolder`
 * validates the requested name resolves to a path *contained* within its
 * parent, and `listSubfolders` walks a bounded depth, skipping heavy build/vcs
 * dirs. Neither ever throws across the IPC boundary in a way that crashes the
 * renderer — errors are surfaced as rejected invokes the caller toasts.
 */

/** Directory names never descended into (build output / vendored deps / VCS). */
const IGNORE_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'target', '.svn', '.hg'])

/** Max recursion depth for `listSubfolders` (a direct child is depth 1). */
const MAX_DEPTH = 4

/** Hard cap on returned rows so a giant tree can't flood the renderer. */
const MAX_RESULTS = 2000

/** One subfolder row for the "Open subfolder" picker. */
export interface SubfolderEntry {
  /** Absolute path of the subfolder. */
  path: string
  /** Path relative to the scanned root (always forward-slash separated). */
  relativePath: string
  /** Depth below the root (a direct child is 1). */
  depth: number
}

/** Result of a subfolder scan — `truncated` flags that `MAX_RESULTS` was hit. */
export interface SubfolderScan {
  entries: SubfolderEntry[]
  truncated: boolean
}

/** Per-level cap for the lazy "Open subfolder" tree (T73). Real directories
 *  rarely hold this many subfolders; beyond it we truncate + flag. */
const MAX_CHILDREN = 1000

/** One direct-child directory for the lazy "Open subfolder" tree (T73). */
export interface ChildFolderEntry {
  /** Absolute path of the child directory. */
  path: string
  /** Directory name (last path segment) — the tree row label. */
  name: string
  /** True when the child itself holds ≥1 non-ignored subdirectory. Drives the
   *  expand chevron so we never render one that reveals nothing. */
  hasChildren: boolean
}

/** Result of a single-level child scan — `truncated` flags {@link MAX_CHILDREN}. */
export interface ChildFolderScan {
  entries: ChildFolderEntry[]
  truncated: boolean
}

/**
 * Validate a user-supplied folder name and resolve it against `parentPath`.
 * Rejects empty / whitespace-only names, absolute paths, and any name whose
 * resolved target escapes the parent (`..` traversal, symlink-free string
 * check). Allows nested segments (`a/b`) as long as the result stays inside the
 * parent. Returns the absolute target path. Throws `Error` on any violation.
 */
export function resolveSubfolderTarget(parentPath: string, name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('empty folder name')
  if (path.isAbsolute(trimmed)) throw new Error('folder name must be relative')
  const parent = path.resolve(parentPath)
  const target = path.resolve(parent, trimmed)
  // Containment: the resolved target must be strictly inside the parent.
  const rel = path.relative(parent, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('folder name escapes its parent directory')
  }
  return target
}

/**
 * Create a subfolder `name` inside `parentPath` (recursive mkdir) and return
 * its normalized absolute path. Idempotent — an existing directory is returned
 * as-is (so re-creating just pins it). Throws when the parent is not an existing
 * directory, when the name is invalid (see {@link resolveSubfolderTarget}), or
 * when a NON-directory already occupies the target.
 */
export async function createSubfolder(parentPath: string, name: string): Promise<string> {
  const parentStat = await fs.stat(parentPath).catch(() => null)
  if (!parentStat || !parentStat.isDirectory()) {
    throw new Error(`parent is not a directory: ${parentPath}`)
  }
  const target = resolveSubfolderTarget(parentPath, name)
  const existing = await fs.stat(target).catch(() => null)
  if (existing && !existing.isDirectory()) {
    throw new Error(`a file already exists at ${target}`)
  }
  await fs.mkdir(target, { recursive: true })
  return normalizePath(target)
}

/**
 * Recursively enumerate the directories under `rootPath`, up to {@link MAX_DEPTH}
 * levels deep, skipping {@link IGNORE_DIRS} and dot-directories. Returns rows
 * sorted by relative path, capped at {@link MAX_RESULTS} (with `truncated` set).
 * Never throws for a per-directory read error (unreadable dirs are skipped);
 * only a missing/`non-directory` root rejects.
 */
export async function listSubfolders(rootPath: string): Promise<SubfolderScan> {
  const rootStat = await fs.stat(rootPath).catch(() => null)
  if (!rootStat || !rootStat.isDirectory()) {
    throw new Error(`not a directory: ${rootPath}`)
  }
  const root = path.resolve(rootPath)
  const entries: SubfolderEntry[] = []
  let truncated = false

  // Iterative BFS so shallow folders surface first and depth is easy to bound.
  const queue: Array<{ abs: string; depth: number }> = [{ abs: root, depth: 0 }]
  while (queue.length > 0) {
    const { abs, depth } = queue.shift()!
    if (depth >= MAX_DEPTH) continue
    let dirents: Dirent[]
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      continue // unreadable directory — skip, don't fail the whole scan
    }
    for (const d of dirents) {
      if (!d.isDirectory()) continue
      if (d.name.startsWith('.') || IGNORE_DIRS.has(d.name)) continue
      const childAbs = path.join(abs, d.name)
      const relativePath = path.relative(root, childAbs).split(path.sep).join('/')
      if (entries.length >= MAX_RESULTS) {
        truncated = true
        break
      }
      entries.push({ path: childAbs, relativePath, depth: depth + 1 })
      queue.push({ abs: childAbs, depth: depth + 1 })
    }
    if (truncated) break
  }

  entries.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
  )
  return { entries, truncated }
}

/** Cheap probe: does `dir` hold at least one non-ignored, non-dot subdirectory?
 *  A read error (permissions) counts as "no children" — never throws. */
async function hasSubdirectory(dir: string): Promise<boolean> {
  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  return dirents.some((d) => d.isDirectory() && !d.name.startsWith('.') && !IGNORE_DIRS.has(d.name))
}

/**
 * Enumerate the DIRECT child directories of `dirPath` — one level only (T73's
 * lazy "Open subfolder" tree reads a level exactly when the user expands it,
 * instead of the eager depth-4 BFS that overwhelms a real repo). Skips
 * {@link IGNORE_DIRS} + dot-dirs, sorts by name, caps at {@link MAX_CHILDREN}
 * (with `truncated` set). Each row carries `hasChildren` (a shallow probe) so
 * the picker knows whether to draw an expand chevron. Never throws for a
 * per-child read error; only a missing / non-directory `dirPath` rejects.
 */
export async function listChildFolders(dirPath: string): Promise<ChildFolderScan> {
  const stat = await fs.stat(dirPath).catch(() => null)
  if (!stat || !stat.isDirectory()) {
    throw new Error(`not a directory: ${dirPath}`)
  }
  const base = path.resolve(dirPath)
  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(base, { withFileTypes: true })
  } catch {
    return { entries: [], truncated: false }
  }
  const dirs = dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !IGNORE_DIRS.has(d.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const truncated = dirs.length > MAX_CHILDREN
  const slice = truncated ? dirs.slice(0, MAX_CHILDREN) : dirs

  const entries = await Promise.all(
    slice.map(async (d) => {
      const childAbs = path.join(base, d.name)
      return { path: childAbs, name: d.name, hasChildren: await hasSubdirectory(childAbs) }
    })
  )
  return { entries, truncated }
}

/**
 * Register the folder-ops IPC handlers (T69). Request/response only — no
 * streaming, no window handle needed.
 */
export function registerFolderOpsHandlers(): void {
  ipcMain.handle(
    'folders:createSubfolder',
    (_e, { parentPath, name }: { parentPath: string; name: string }) =>
      createSubfolder(parentPath, name)
  )
  ipcMain.handle('folders:listSubfolders', (_e, { rootPath }: { rootPath: string }) =>
    listSubfolders(rootPath)
  )
  ipcMain.handle('folders:listChildFolders', (_e, { dirPath }: { dirPath: string }) =>
    listChildFolders(dirPath)
  )
}
