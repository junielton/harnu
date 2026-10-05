/**
 * Live-reload for markdown panes (T171). Two pure, testable pieces of
 * bookkeeping live here, independent of any real chokidar instance:
 *
 *  - a ref count per absolute path (how many mounted MarkdownPanes have this
 *    file open right now) — `update_file`'s "is this even open" check reuses
 *    this SAME map instead of round-tripping to the renderer, and the watcher
 *    (Task 2) only subscribes chokidar to paths with a ref > 0.
 *  - a one-shot self-write suppression flag per path — `markdown-write.ts`
 *    (Task 4) arms it immediately before its atomic rename, so the chokidar
 *    `change` event that same rename fires doesn't loop back to the pane that
 *    just saved as a false "changed on disk" push.
 */

import chokidar, { type FSWatcher } from 'chokidar'
import { ipcMain, type BrowserWindow } from 'electron'
import { resolve } from 'node:path'
import { checkMarkdownReadAllowed, markdownKnownRoots } from './markdown-read'

const refCounts = new Map<string, number>()
const suppressed = new Set<string>()

/** Current ref count for `path` (0 if never registered). */
export function refCount(path: string): number {
  return refCounts.get(path) ?? 0
}

/** Register one more interest in `path`. Returns 'first' when this is the
 *  transition from 0→1 refs (the caller should start watching), else 'more'. */
export function addRef(path: string): 'first' | 'more' {
  const next = (refCounts.get(path) ?? 0) + 1
  refCounts.set(path, next)
  return next === 1 ? 'first' : 'more'
}

/** Release one interest in `path`. Returns 'last' on the 1→0 transition (the
 *  caller should stop watching), 'more' if refs remain, 'none' if `path` had
 *  no refs to begin with (defensive — never goes negative). */
export function removeRef(path: string): 'last' | 'more' | 'none' {
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
export function suppressNextChange(path: string): void {
  suppressed.add(path)
}

/** Consume (and clear) the suppression flag for `path`. True at most once per `suppressNextChange` call. */
export function consumeSuppression(path: string): boolean {
  if (!suppressed.has(path)) return false
  suppressed.delete(path)
  return true
}

/** Test-only: reset all module state between test cases. */
export function __resetMarkdownWatchStateForTests(): void {
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
  watcher.on('change', (p) => void notifyMarkdownChanged(p))
  watcher.on('unlink', (p) => void notifyMarkdownChanged(p))
  return watcher
}

/**
 * Re-read-and-push for `resolvedPath` — the ONE function both the chokidar
 * `change`/`unlink` handlers and the `update_file` MCP handler call. Confines
 * against the live known roots (same gate `open_file`/`markdown:read` use),
 * then checks the ref map (Task 1) as the sole "is this open anywhere" source
 * of truth — `update_file` never has to ask the renderer. On a real, non-
 * suppressed, in-root, reffed change it broadcasts `{path: resolvedPath}` —
 * content is deliberately NOT included; the renderer re-reads via the
 * existing confined `markdown:read` IPC (one containment/size-cap/binary-
 * sniff/image-fast-path implementation, not two).
 */
export async function notifyMarkdownChanged(
  resolvedPath: string
): Promise<'ok' | 'not-open' | 'outside-roots'> {
  const gate = checkMarkdownReadAllowed(resolve(resolvedPath), await markdownKnownRoots())
  if (!gate.ok) return 'outside-roots'
  if (refCount(resolvedPath) <= 0) return 'not-open'
  if (consumeSuppression(resolvedPath)) return 'ok' // self-write: swallow, still "ok" (no error to the caller)
  const win = windowGetter?.()
  if (win && !win.isDestroyed()) win.webContents.send('markdown:changed', { path: resolvedPath })
  return 'ok'
}

/**
 * Wire the two per-pane lifecycle IPC handlers a mounted `MarkdownPane` calls,
 * and stash the window getter `notifyMarkdownChanged` broadcasts through. Call
 * ONCE from `src/main/index.ts`, mirroring every other `register*Handlers`.
 */
export function registerMarkdownWatchHandlers(getWindow: () => BrowserWindow | null): void {
  windowGetter = getWindow
  ipcMain.handle('markdown:watchStart', async (_e, args: { path: string }) => {
    const raw = args?.path
    if (typeof raw !== 'string' || raw.length === 0) return
    const p = resolve(raw)
    // IPC payloads cross the trust boundary (renderer is untrusted from main's
    // perspective) — confine against the SAME known roots as markdown:read
    // before ever subscribing chokidar to a renderer-supplied path.
    const gate = checkMarkdownReadAllowed(p, await markdownKnownRoots())
    if (!gate.ok) return
    if (addRef(p) === 'first') ensureWatcher().add(p)
  })
  ipcMain.handle('markdown:watchStop', (_e, args: { path: string }) => {
    const raw = args?.path
    if (typeof raw !== 'string' || raw.length === 0) return
    const p = resolve(raw)
    if (removeRef(p) === 'last' && watcher) watcher.unwatch(p)
  })
}

/** Close the shared watcher and clear all refs — call from `before-quit`. */
export async function closeAllMarkdownWatchers(): Promise<void> {
  const w = watcher
  watcher = null
  __resetMarkdownWatchStateForTests()
  if (w) {
    try {
      await w.close()
    } catch {
      /* best effort */
    }
  }
}
