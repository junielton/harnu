/**
 * Live-reload for canvas panes (T218 U1). Mirrors `markdown-watch.ts` piece for
 * piece — the same two pieces of pure, testable bookkeeping, independent of any
 * real chokidar instance:
 *
 *  - a ref count per absolute path (how many mounted DiagramPanes have this
 *    canvas open right now); the watcher only subscribes chokidar to paths with
 *    a ref > 0.
 *  - a one-shot self-write suppression flag per path — `canvas-write.ts` arms it
 *    immediately before its atomic rename, so the `change` event that same
 *    rename fires does not loop back to the pane that just saved as a false
 *    "changed on disk" push.
 *
 * The state is deliberately SEPARATE from the markdown watcher's rather than
 * shared: the two panes have different channels and different reload semantics
 * (§7.3's clean/dirty cases), and a shared ref map would let a markdown pane's
 * unwatch silently stop a canvas pane's watch on the same path.
 *
 * The broadcast carries the PATH ONLY. The renderer re-reads through the
 * confined `canvas:read` IPC, so there is one containment/size-cap/validation
 * implementation, not two — and the pane decides what to do with the news
 * based on whether it is dirty (§7.3 cases A and B).
 */

import chokidar, { type FSWatcher } from 'chokidar'
import { ipcMain, type BrowserWindow } from 'electron'
import { resolve } from 'node:path'
import { markdownKnownRoots } from './markdown-read'
import { checkCanvasPathAllowed } from './canvas-read'

const refCounts = new Map<string, number>()
const suppressed = new Set<string>()

/** Current ref count for `path` (0 if never registered). */
export function canvasRefCount(path: string): number {
  return refCounts.get(path) ?? 0
}

/** Register one more interest in `path`. Returns 'first' on the 0→1 transition
 *  (the caller should start watching), else 'more'. */
export function addCanvasRef(path: string): 'first' | 'more' {
  const next = (refCounts.get(path) ?? 0) + 1
  refCounts.set(path, next)
  return next === 1 ? 'first' : 'more'
}

/** Release one interest in `path`. Returns 'last' on the 1→0 transition (the
 *  caller should stop watching), 'more' if refs remain, 'none' if `path` had no
 *  refs to begin with (defensive — never goes negative). */
export function removeCanvasRef(path: string): 'last' | 'more' | 'none' {
  const current = refCounts.get(path) ?? 0
  if (current <= 0) return 'none'
  const next = current - 1
  if (next === 0) {
    refCounts.delete(path)
    return 'last'
  }
  refCounts.set(path, next)
  return 'more'
}

/** Arm a one-shot suppression for the NEXT change event on `path`. */
export function suppressNextCanvasChange(path: string): void {
  suppressed.add(path)
}

/** Consume (and clear) the suppression flag for `path`. True at most once per
 *  `suppressNextCanvasChange` call. */
export function consumeCanvasSuppression(path: string): boolean {
  if (!suppressed.has(path)) return false
  suppressed.delete(path)
  return true
}

/** Test-only: reset all module state between test cases. */
export function __resetCanvasWatchStateForTests(): void {
  refCounts.clear()
  suppressed.clear()
}

let watcher: FSWatcher | null = null
let windowGetter: (() => BrowserWindow | null) | null = null

function ensureWatcher(): FSWatcher {
  if (watcher) return watcher
  watcher = chokidar.watch([], {
    ignoreInitial: true,
    persistent: true,
    followSymlinks: false,
    ignorePermissionErrors: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
  })
  watcher.on('change', (p) => void notifyCanvasChanged(p))
  watcher.on('unlink', (p) => void notifyCanvasChanged(p))
  return watcher
}

/**
 * Re-check-and-push for `resolvedPath` — the ONE function the chokidar
 * `change`/`unlink` handlers call. Confines against the live known roots (the
 * same gate `canvas:read` uses), then checks the ref map as the sole "is this
 * open anywhere" source of truth. On a real, non-suppressed, in-root, reffed
 * change it broadcasts `{ path: resolvedPath }`.
 */
export async function notifyCanvasChanged(
  resolvedPath: string
): Promise<'ok' | 'not-open' | 'outside-roots' | 'invalid-path'> {
  const gate = checkCanvasPathAllowed(resolve(resolvedPath), await markdownKnownRoots())
  if (!gate.ok) return gate.code
  if (canvasRefCount(resolvedPath) <= 0) return 'not-open'
  if (consumeCanvasSuppression(resolvedPath)) return 'ok' // our own Save: swallow
  const win = windowGetter?.()
  if (win && !win.isDestroyed()) win.webContents.send('canvas:changed', { path: resolvedPath })
  return 'ok'
}

/**
 * Wire the two per-pane lifecycle IPC handlers a mounted `DiagramPane` calls,
 * and stash the window getter `notifyCanvasChanged` broadcasts through. Call
 * ONCE from `src/main/index.ts`, mirroring every other `register*Handlers`.
 */
export function registerCanvasWatchHandlers(getWindow: () => BrowserWindow | null): void {
  windowGetter = getWindow
  ipcMain.handle('canvas:watchStart', async (_e, args: { path: string }) => {
    const raw = args?.path
    if (typeof raw !== 'string' || raw.length === 0) return
    const p = resolve(raw)
    // IPC payloads cross the trust boundary — confine against the SAME gate as
    // canvas:read before ever subscribing chokidar to a renderer-supplied path.
    const gate = checkCanvasPathAllowed(p, await markdownKnownRoots())
    if (!gate.ok) return
    if (addCanvasRef(p) === 'first') ensureWatcher().add(p)
  })
  ipcMain.handle('canvas:watchStop', (_e, args: { path: string }) => {
    const raw = args?.path
    if (typeof raw !== 'string' || raw.length === 0) return
    const p = resolve(raw)
    if (removeCanvasRef(p) === 'last' && watcher) watcher.unwatch(p)
  })
}

/** Close the shared watcher and clear all refs — call from `before-quit`. */
export async function closeAllCanvasWatchers(): Promise<void> {
  const w = watcher
  watcher = null
  __resetCanvasWatchStateForTests()
  if (w) {
    try {
      await w.close()
    } catch {
      /* best effort */
    }
  }
}
