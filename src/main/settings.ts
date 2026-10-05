import { app, dialog, shell, BrowserWindow, ipcMain } from 'electron'
import { join, dirname, resolve, relative, isAbsolute } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { readFileSync, writeFileSync } from 'fs'
import chokidar, { type FSWatcher } from 'chokidar'

/**
 * Settings persistence + file-watch (terminal-font-settings spec §4).
 *
 * Owns the on-disk `settings.json` and the single chokidar watcher that
 * reloads it when an external editor saves a change. The renderer holds the
 * *location pointer* (`localStorage['om2tab.settingsPath']`), but every path it
 * hands us is confined to the allowed roots — `app.getPath('userData')` plus a
 * directory the user explicitly picked through the native relocation dialog
 * (persisted in `settings-location.json`). A renderer string can never point the
 * settings file at an arbitrary location on disk.
 *
 * Mirrors the handler-module shape of `src/main/dialog.ts` /
 * `src/main/pty.ts`: a single exported `registerSettingsHandlers(getWindow)`
 * that wires every `ipcMain.handle(...)` channel.
 */

/**
 * The on-disk schema. Read-modify-write preserves any unknown keys a user
 * hand-added, so this interface is intentionally open to extension without
 * clobbering forward-compatible files.
 *
 * - `terminalFontSize` — xterm font size (px).
 * - `uiZoom` — whole-UI zoom factor applied via `webFrame.setZoomFactor`
 *   (T54): scales typography *and* icons across the app. Distinct from
 *   `terminalFontSize`, which only tunes the terminal relative to that zoom.
 */
export interface SettingsData {
  terminalFontSize: number
  uiZoom: number
}

const DEFAULT_SETTINGS: SettingsData = {
  terminalFontSize: 13,
  uiZoom: 1
}

/**
 * Bounds, mirrored from the renderer store (`stores/settings.ts`). The renderer
 * already clamps before calling `settings:save`; this is defense-in-depth so a
 * malformed or out-of-range value can never reach disk through this module
 * regardless of caller. `uiZoom` bounds are wider than the discrete stepper
 * exposes (80–150%) so a hand-edited settings.json stays within a sane range.
 */
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 32
const MIN_UI_ZOOM = 0.5
const MAX_UI_ZOOM = 2

/**
 * Build a clean, known-shape patch from arbitrary renderer input: clamp/round the
 * known numeric keys, drop non-numeric garbage, and DROP any unknown keys entirely
 * (allowlist, not pass-through). Pure — exported for unit tests.
 */
export function sanitizePatch(patch: Record<string, unknown>): Partial<SettingsData> {
  const out: Partial<SettingsData> = {}
  if (patch && typeof patch === 'object' && 'terminalFontSize' in patch) {
    const v = patch.terminalFontSize
    if (typeof v === 'number' && Number.isFinite(v)) {
      out.terminalFontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(v)))
    }
  }
  if (patch && typeof patch === 'object' && 'uiZoom' in patch) {
    const v = patch.uiZoom
    if (typeof v === 'number' && Number.isFinite(v)) {
      // Clamp, then snap to 2 decimals so the stepper's 0.8/1.25/… land exact
      // and never accumulate float drift on disk.
      const clamped = Math.min(MAX_UI_ZOOM, Math.max(MIN_UI_ZOOM, v))
      out.uiZoom = Math.round(clamped * 100) / 100
    }
  }
  return out
}

/**
 * True when `target`, once resolved, lives inside `root` (or *is* `root`). Pure;
 * exported for unit tests. Uses `path.relative` so `..` traversal and absolute
 * re-roots are both rejected.
 */
export function isPathWithinRoot(target: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** True when `target` is contained by at least one of the allowed roots. */
export function isPathAllowed(target: string, roots: string[]): boolean {
  return roots.some((root) => isPathWithinRoot(target, root))
}

/**
 * Single module-scoped watcher. Closed + recreated whenever the active path
 * changes (`settings:load` / `settings:changeLocation`). Held here rather than
 * per-call so we never leak inotify registrations across relocations.
 */
let watcher: FSWatcher | null = null
let watchedPath: string | null = null

/** Debounce for the `change` event — chokidar can emit several per save. */
const CHANGE_DEBOUNCE_MS = 100
let changeTimer: NodeJS.Timeout | null = null

function defaultSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * User-chosen relocation directory, or `null` when the settings file lives in the
 * default `userData` location. Set only via `settings:changeLocation` (native
 * dialog) and persisted to a pointer file so the relocated path stays an allowed
 * root across restarts — the renderer can never make an arbitrary directory
 * "allowed" by passing a string; only a real dialog pick does.
 */
let relocationDir: string | null = null
let relocationLoaded = false

function relocationPointerPath(): string {
  return join(app.getPath('userData'), 'settings-location.json')
}

/** Lazily load the persisted relocation directory (sync, once). */
function loadRelocationDir(): void {
  if (relocationLoaded) return
  relocationLoaded = true
  try {
    const parsed = JSON.parse(readFileSync(relocationPointerPath(), 'utf8')) as { dir?: unknown }
    if (typeof parsed.dir === 'string' && parsed.dir.length > 0) {
      relocationDir = resolve(parsed.dir)
    }
  } catch {
    /* no relocation pointer — stay on the default location */
  }
}

/** Record + persist the user's dialog-picked relocation directory. */
function setRelocationDir(dir: string): void {
  relocationDir = resolve(dir)
  relocationLoaded = true
  try {
    writeFileSync(
      relocationPointerPath(),
      JSON.stringify({ dir: relocationDir }, null, 2) + '\n',
      'utf8'
    )
  } catch {
    /* best effort — relocation still works for this session */
  }
}

/**
 * The directories the settings file is allowed to live in: always `userData`,
 * plus the persisted dialog-picked relocation dir (if any).
 */
function allowedRoots(): string[] {
  loadRelocationDir()
  const roots = [resolve(app.getPath('userData'))]
  if (relocationDir) roots.push(relocationDir)
  return roots
}

/** The app's own current settings.json path (default or relocated). */
function currentSettingsPath(): string {
  loadRelocationDir()
  return relocationDir ? join(relocationDir, 'settings.json') : defaultSettingsPath()
}

/**
 * Resolve a renderer-supplied path and confine it to the allowed roots. Throws
 * (rejecting the IPC) when the path escapes — legitimate paths handed back by
 * `settings:defaultPath` / `settings:changeLocation` always pass.
 */
function resolveAllowedPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('settings: invalid path')
  }
  const resolved = resolve(path)
  if (!isPathAllowed(resolved, allowedRoots())) {
    throw new Error('settings: path escapes the allowed settings location')
  }
  return resolved
}

/** Serialize with 2-space indent + trailing newline, VSCode-style. */
function serialize(data: SettingsData): string {
  return JSON.stringify(data, null, 2) + '\n'
}

/**
 * Read + parse the file at `path`, creating it with defaults if absent. On a
 * parse error returns `{ data: defaults, invalid: true }` rather than throwing
 * — the renderer keeps its last-good value and surfaces a toast.
 */
async function readSettings(path: string): Promise<{ data: SettingsData; invalid: boolean }> {
  await mkdir(dirname(path), { recursive: true })
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    // Missing file: create it with defaults so first run never blocks the user.
    await writeFile(path, serialize(DEFAULT_SETTINGS), 'utf8')
    return { data: { ...DEFAULT_SETTINGS }, invalid: false }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SettingsData>
    return { data: { ...DEFAULT_SETTINGS, ...parsed }, invalid: false }
  } catch {
    return { data: { ...DEFAULT_SETTINGS }, invalid: true }
  }
}

/**
 * Read-modify-write merge: parse the existing file, overlay the changed keys,
 * and write back so any unknown/future keys a user hand-added are preserved.
 */
async function writeSettings(path: string, patch: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    if (typeof existing !== 'object' || existing === null) existing = {}
  } catch {
    // Missing or invalid — fall back to defaults as the merge base so we don't
    // drop the changed key on the floor.
    existing = { ...DEFAULT_SETTINGS }
  }
  const merged = { ...existing, ...sanitizePatch(patch) }
  await writeFile(path, JSON.stringify(merged, null, 2) + '\n', 'utf8')
}

/**
 * (Re)start the chokidar watch on `path`. Closes the prior watcher first so we
 * never stack two watchers across a relocation. `ignoreInitial` so the watch
 * doesn't fire on the file we just created/read.
 */
function watchPath(path: string, getWindow: () => BrowserWindow | null): void {
  if (watchedPath === path && watcher) return
  if (watcher) {
    void watcher.close()
    watcher = null
  }
  watchedPath = path
  watcher = chokidar.watch(path, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 }
  })
  watcher.on('change', () => {
    if (changeTimer) clearTimeout(changeTimer)
    changeTimer = setTimeout(async () => {
      changeTimer = null
      const win = getWindow()
      if (!win) return
      const { data, invalid } = await readSettings(path)
      if (invalid) {
        win.webContents.send('settings:changed', { error: true })
      } else {
        win.webContents.send('settings:changed', { data })
      }
    }, CHANGE_DEBOUNCE_MS)
  })
}

export function registerSettingsHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('settings:defaultPath', (): string => defaultSettingsPath())

  ipcMain.handle(
    'settings:load',
    async (_e, { path }: { path: string }): Promise<{ path: string; data: SettingsData }> => {
      const resolved = resolveAllowedPath(path)
      const { data } = await readSettings(resolved)
      watchPath(resolved, getWindow)
      return { path: resolved, data }
    }
  )

  ipcMain.handle(
    'settings:save',
    async (_e, { path, data }: { path: string; data: Record<string, unknown> }): Promise<void> => {
      const resolved = resolveAllowedPath(path)
      await writeSettings(resolved, data)
    }
  )

  ipcMain.handle(
    'settings:changeLocation',
    async (_e, { data }: { data: Record<string, unknown> }): Promise<{ path: string } | null> => {
      const win = getWindow()
      const result = win
        ? await dialog.showOpenDialog(win, {
            properties: ['openDirectory', 'createDirectory']
          })
        : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
      if (result.canceled || result.filePaths.length === 0) return null
      // The dialog pick is the *only* way to extend the allowed roots — record it
      // before validating so the new location is permitted.
      setRelocationDir(result.filePaths[0])
      const newPath = resolveAllowedPath(join(result.filePaths[0], 'settings.json'))
      await writeSettings(newPath, data)
      watchPath(newPath, getWindow)
      // NB: the previous settings.json is intentionally left on disk — it may
      // hold a backup or other keys the user wants, and the renderer's pointer
      // (`om2tab.settingsPath`) now points at `newPath`, so the old file is no
      // longer read. We don't delete user files on relocation.
      return { path: newPath }
    }
  )

  ipcMain.handle('settings:reveal', (): void => {
    // Reveal the app's own settings file — never a renderer-supplied path.
    shell.showItemInFolder(currentSettingsPath())
  })

  ipcMain.handle('settings:openExternal', async (): Promise<void> => {
    // Open the app's own resolved settings.json — never a renderer-supplied path.
    await shell.openPath(currentSettingsPath())
  })
}

/** Close the watcher on quit so chokidar's file descriptors are released. */
export async function closeSettingsWatcher(): Promise<void> {
  if (changeTimer) {
    clearTimeout(changeTimer)
    changeTimer = null
  }
  if (watcher) {
    const w = watcher
    watcher = null
    watchedPath = null
    try {
      await w.close()
    } catch {
      /* best effort */
    }
  }
}
