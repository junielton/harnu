/**
 * keybindings.ts — the electron glue for Harnu's `keybindings.json` override
 * layer (T1 P2).
 *
 * Main owns the file (Q3): it resolves the path (next to `settings.json`,
 * following its relocation), reads + resolves it, chokidar-watches it so a
 * hand-edit applies without a restart, and exposes `keybindings:load` /
 * `keybindings:save` + a `keybindings:changed` event over IPC.
 *
 * The pure read/parse/write lives in `keybindings-file.ts`; the resolution
 * (defaults ← overrides, warnings, conflicts) in `keybindings-core.ts`. This
 * module is the only piece that touches `electron`.
 *
 * P3 scope: the resolved table is also cached here (seeded synchronously at
 * startup) and handed to `menu.ts` so the native accelerators track the user's
 * overrides — `registerKeybindings` takes an `onChange` hook that `index.ts`
 * wires to a menu rebuild, fired on every `keybindings:changed`.
 *
 * See `docs/specs/T1-customizable-keybindings.md`.
 */

import { BrowserWindow, ipcMain } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import { settingsDir } from './settings'
import type { ResolvedKeybindings } from './keybindings-core'
import {
  keybindingsPathIn,
  loadResolvedKeybindings,
  loadResolvedKeybindingsSync,
  writeKeybindingsBody
} from './keybindings-file'

/**
 * The active `keybindings.json` path — recomputed each call so a mid-session
 * settings relocation is picked up on the next `keybindings:load`.
 *
 * Exported (T1 P5) so the three confined markdown channels the editor pane uses
 * (`markdown:read` / `markdown:write` / `markdown:watch`) can grant this one
 * path an exact-path exception to the known-roots gate — the file lives beside
 * `settings.json`, outside every known Harnu root. The MCP `open_file` validator
 * deliberately does not take the exception.
 */
export function keybindingsFilePath(): string {
  return keybindingsPathIn(settingsDir())
}

/** Single module-scoped watcher, mirroring `settings.ts`. */
let watcher: FSWatcher | null = null
let watchedPath: string | null = null

/** Debounce for the watch event — chokidar emits several per save. */
const CHANGE_DEBOUNCE_MS = 100
let changeTimer: NodeJS.Timeout | null = null

/**
 * The last resolved table (built-in defaults ← `keybindings.json`). Seeded
 * synchronously by `registerKeybindings` so `registerAppMenu` can build the
 * native menu from it at startup (Q3), then kept current by the
 * `keybindings:load` handler and the chokidar watch.
 */
let currentResolved: ResolvedKeybindings | null = null

/**
 * Called with the fresh table on every change. `index.ts` wires this to a
 * native-menu rebuild (P3) so its accelerators follow the user's overrides.
 */
let onResolved: ((resolved: ResolvedKeybindings) => void) | null = null

/** The resolved table as of the last load — `null` only before `registerKeybindings`. */
export function getResolvedKeybindings(): ResolvedKeybindings | null {
  return currentResolved
}

/** Cheap structural equality — `list` fully determines `byId`, so compare that + warnings. */
function sameResolved(a: ResolvedKeybindings | null, b: ResolvedKeybindings): boolean {
  if (!a) return false
  return (
    JSON.stringify(a.list) === JSON.stringify(b.list) &&
    JSON.stringify(a.warnings) === JSON.stringify(b.warnings)
  )
}

/**
 * Re-read + re-resolve the file, refresh the cache, optionally push the change
 * to the renderer, and notify the menu-rebuild hook — but only when the table
 * actually changed, so the renderer's boot `keybindings:load` (which runs after
 * `registerAppMenu` already built from the sync seed) doesn't trigger a
 * pointless second `Menu.setApplicationMenu`, and a no-op save doesn't either.
 * A relocation still rebuilds: the new directory's file resolves differently.
 */
async function refresh(
  path: string,
  getWindow: () => BrowserWindow | null,
  notifyRenderer: boolean
): Promise<ResolvedKeybindings> {
  let resolved: ResolvedKeybindings
  try {
    resolved = await loadResolvedKeybindings(path)
  } catch (err) {
    // A non-ENOENT read fault (EACCES / EISDIR, or the file swapped mid-read)
    // must not surface as an unhandled rejection from the chokidar
    // `void refresh(...)` call, nor stop live rebinding. Match the sync startup
    // loader, which the "can't brick the app" guarantee (Q5) already relies on:
    // fall back to the built-in defaults and carry on.
    console.warn('[keybindings] refresh read failed, falling back to defaults:', err)
    resolved = loadResolvedKeybindingsSync(path)
  }
  const changed = !sameResolved(currentResolved, resolved)
  currentResolved = resolved
  if (!changed) return resolved
  if (notifyRenderer) getWindow()?.webContents.send('keybindings:changed', { resolved })
  onResolved?.(resolved)
  return resolved
}

/**
 * (Re)start the chokidar watch on `path`. Closes the prior watcher first so a
 * relocation never stacks two. Watches `add` / `change` / `unlink` — deleting
 * the file is a valid "reset to defaults" gesture and must re-resolve too.
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
  const reresolve = (): void => {
    if (changeTimer) clearTimeout(changeTimer)
    changeTimer = setTimeout(() => {
      changeTimer = null
      void refresh(path, getWindow, true)
    }, CHANGE_DEBOUNCE_MS)
  }
  watcher.on('add', reresolve)
  watcher.on('change', reresolve)
  watcher.on('unlink', reresolve)
}

export function registerKeybindings(
  getWindow: () => BrowserWindow | null,
  onChange?: (resolved: ResolvedKeybindings) => void
): void {
  onResolved = onChange ?? null

  // Seed the cache synchronously so `registerAppMenu` — later in the same
  // startup sequence — can build the menu straight from the resolved table
  // (Q3). The watch + the renderer's `keybindings:load` keep it current after.
  const initialPath = keybindingsFilePath()
  currentResolved = loadResolvedKeybindingsSync(initialPath)
  watchPath(initialPath, getWindow)

  ipcMain.handle(
    'keybindings:load',
    async (): Promise<{ path: string; resolved: ResolvedKeybindings }> => {
      const path = keybindingsFilePath()
      const resolved = await refresh(path, getWindow, false)
      watchPath(path, getWindow)
      return { path, resolved }
    }
  )

  ipcMain.handle('keybindings:save', async (_e, { body }: { body: string }): Promise<void> => {
    if (typeof body !== 'string') throw new Error('keybindings: invalid body')
    await writeKeybindingsBody(keybindingsFilePath(), body)
  })
}

/** Close the watcher on quit so chokidar's file descriptors are released. */
export async function closeKeybindingsWatcher(): Promise<void> {
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
