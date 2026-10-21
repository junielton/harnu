/**
 * Live-reload for canvas panes (T218 U1). Mirrors `markdown-watch.ts` piece for
 * piece — the same two pieces of pure, testable bookkeeping, independent of any
 * real chokidar instance:
 *
 *  - a ref count per absolute path (how many mounted DiagramPanes have this
 *    canvas open right now); the watcher only subscribes chokidar to paths with
 *    a ref > 0.
 *  - a self-write fingerprint per path — when the PANE's own Save writes a
 *    canvas, `canvas-write.ts` records a hash of the exact bytes it wrote, so the
 *    `change` event that same rename fires does not loop back to the pane that
 *    just saved as a false "changed on disk" push. Only the pane's own Save
 *    records one; an agent's `draw_canvas` never does, so an open pane always
 *    hears about it (BUG-202). The fingerprint also names the WRITING pane
 *    (`writerId`): when another pane has the same file open, the echo is still
 *    broadcast — tagged with that id — so the writer ignores it and every other
 *    pane reloads or goes stale (BUG-209).
 *
 * The state is deliberately SEPARATE from the markdown watcher's rather than
 * shared: the two panes have different channels and different reload semantics
 * (§7.3's clean/dirty cases), and a shared ref map would let a markdown pane's
 * unwatch silently stop a canvas pane's watch on the same path.
 *
 * The broadcast carries the path, plus the `writerId` of a Save echo another
 * pane must still hear. The renderer re-reads through the
 * confined `canvas:read` IPC, so there is one containment/size-cap/validation
 * implementation, not two — and the pane decides what to do with the news
 * based on whether it is dirty (§7.3 cases A and B).
 */

import chokidar, { type FSWatcher } from 'chokidar'
import { ipcMain, type BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { markdownKnownRoots } from './markdown-read'
import { checkCanvasPathAllowed } from './canvas-read'

const refCounts = new Map<string, number>()
/** Hash of the bytes a pane's own last Save wrote, per path, and which pane wrote them. */
const selfWrites = new Map<string, { hash: string; writerId?: string }>()

function fingerprint(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

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
    // Nothing watches the path any more, so changes made from now on are never
    // seen — a fingerprint kept past this point could later swallow somebody
    // else's write that happens to restore the same bytes.
    selfWrites.delete(path)
    return 'last'
  }
  refCounts.set(path, next)
  return 'more'
}

/**
 * Record that the pane itself is about to write `body` to `path`, so the change
 * event that write fires can be recognised as the pane's own and swallowed.
 *
 * This is a CONTENT fingerprint, not a one-shot flag, on purpose. chokidar's
 * `awaitWriteFinish` folds writes that land inside its settle window into one
 * event, and a flag armed by the Save would swallow that merged event even when
 * an agent's write was part of it — silently losing the agent's change. Judging
 * by what is actually on disk when the event is handled cannot make that mistake.
 */
export function recordCanvasSelfWrite(path: string, body: string, writerId?: string): void {
  selfWrites.set(path, { hash: fingerprint(body), writerId })
}

/**
 * Is `current` — what is on disk right now — exactly what the pane last wrote to
 * `path`? True means the event is the pane's own echo and should be swallowed.
 * Anything else (including a missing file) is somebody else's change, and it
 * clears the fingerprint: from then on the pane's last write is history.
 */
export function consumeCanvasSuppression(path: string, current: Buffer | null): boolean {
  const mine = selfWrites.get(path)
  if (mine === undefined) return false
  if (current !== null && fingerprint(current) === mine.hash) return true
  selfWrites.delete(path)
  return false
}

/** The pane that wrote the bytes `consumeCanvasSuppression` last matched on `path`. */
export function canvasSelfWriter(path: string): string | undefined {
  return selfWrites.get(path)?.writerId
}

/** Test-only: reset all module state between test cases. */
export function __resetCanvasWatchStateForTests(): void {
  refCounts.clear()
  selfWrites.clear()
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
 *
 * A pane's own Save echo is swallowed outright only while that pane is the sole
 * one on the file. With two or more open, the other panes have not seen the
 * Save, so the echo is broadcast with the writer's id: the writer drops it, the
 * rest reload (clean) or show the stale banner (dirty) — BUG-209.
 */
export async function notifyCanvasChanged(
  resolvedPath: string
): Promise<'ok' | 'not-open' | 'outside-roots' | 'invalid-path'> {
  const gate = checkCanvasPathAllowed(resolve(resolvedPath), await markdownKnownRoots())
  if (!gate.ok) return gate.code
  if (canvasRefCount(resolvedPath) <= 0) return 'not-open'
  // Read what is on disk NOW: the event is the pane's own echo only if it is
  // still exactly the bytes the pane's Save wrote. A file that has since
  // vanished (or been replaced) is somebody else's change.
  const onDisk = await readFile(resolvedPath).catch(() => null)
  let writerId: string | undefined
  if (consumeCanvasSuppression(resolvedPath, onDisk)) {
    if (canvasRefCount(resolvedPath) <= 1) return 'ok' // our own Save, nobody else listening: swallow
    writerId = canvasSelfWriter(resolvedPath)
  }
  const win = windowGetter?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send(
      'canvas:changed',
      writerId === undefined ? { path: resolvedPath } : { path: resolvedPath, writerId }
    )
  }
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
