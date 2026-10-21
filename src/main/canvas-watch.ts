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
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { markdownKnownRoots } from './markdown-read'
import { checkCanvasPathAllowed } from './canvas-read'

const refCounts = new Map<string, number>()
/** Of those refs, how many each identified pane holds (`paneId` = the pane's `writerId`). */
const paneRefs = new Map<string, Map<string, number>>()
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
 *  (the caller should start watching), else 'more'. `paneId` names the pane
 *  holding the ref, so a Save echo can tell whether anyone else is listening. */
export function addCanvasRef(path: string, paneId?: string): 'first' | 'more' {
  const next = (refCounts.get(path) ?? 0) + 1
  refCounts.set(path, next)
  if (paneId !== undefined) {
    const panes = paneRefs.get(path) ?? new Map<string, number>()
    panes.set(paneId, (panes.get(paneId) ?? 0) + 1)
    paneRefs.set(path, panes)
  }
  return next === 1 ? 'first' : 'more'
}

/** Release one interest in `path`. Returns 'last' on the 1→0 transition (the
 *  caller should stop watching), 'more' if refs remain, 'none' if `path` had no
 *  refs to begin with (defensive — never goes negative). */
export function removeCanvasRef(path: string, paneId?: string): 'last' | 'more' | 'none' {
  const current = refCounts.get(path) ?? 0
  if (current <= 0) return 'none'
  const panes = paneRefs.get(path)
  const held = paneId === undefined ? 0 : (panes?.get(paneId) ?? 0)
  if (panes && paneId !== undefined && held > 0) {
    if (held === 1) panes.delete(paneId)
    else panes.set(paneId, held - 1)
    if (panes.size === 0) paneRefs.delete(path)
  }
  const next = current - 1
  if (next === 0) {
    refCounts.delete(path)
    paneRefs.delete(path)
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

/**
 * Is anybody other than `writerId` watching `path`? When the panes on the path
 * named themselves, the writer's own refs are subtracted from the total, so a
 * writer that has already closed leaves every remaining ref belonging to somebody
 * else. Without names (an older caller on either side) only the ref count can
 * answer, and a lone ref is taken to be the writer's.
 */
function othersWatching(path: string, writerId: string | undefined): boolean {
  const total = canvasRefCount(path)
  const panes = paneRefs.get(path)
  if (writerId === undefined || panes === undefined) return total > 1
  return total - (panes.get(writerId) ?? 0) > 0
}

/** Test-only: reset all module state between test cases. */
export function __resetCanvasWatchStateForTests(): void {
  refCounts.clear()
  paneRefs.clear()
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
  // An OS that refuses the watch (inotify limit, ENOSPC) surfaces here, after
  // chokidar already lists the file: the open wait cannot tell, so say so.
  watcher.on('error', (err) =>
    console.warn('[canvas-watch] watcher error; changes may be missed:', err)
  )
  return watcher
}

/**
 * Re-check-and-push for `resolvedPath` — the ONE function the chokidar
 * `change`/`unlink` handlers call. Confines against the live known roots (the
 * same gate `canvas:read` uses), then checks the ref map as the sole "is this
 * open anywhere" source of truth. On a real, non-suppressed, in-root, reffed
 * change it broadcasts `{ path: resolvedPath }`.
 *
 * A pane's own Save echo is swallowed outright only while no OTHER pane is on
 * the file — judged by pane identity, not the ref count, so a writer that closed
 * before its echo arrived does not hide the Save from the pane left open. When
 * another pane is listening, the echo is broadcast with the writer's id: the
 * writer drops it, the rest reload (clean) or show the stale banner (dirty) —
 * BUG-209.
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
    writerId = canvasSelfWriter(resolvedPath)
    if (!othersWatching(resolvedPath, writerId)) return 'ok' // our own Save, nobody else listening: swallow
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

/** How long `startCanvasWatch` waits for chokidar before giving up and resolving anyway. */
const WATCH_READY_TIMEOUT_MS = 3000
const WATCH_READY_POLL_MS = 5
/** After a missed deadline, how long the background re-check keeps waiting for the watch. */
const WATCH_LATE_LIMIT_MS = 60_000
const WATCH_LATE_POLL_MS = 50

let watchReadyTimeoutMs = WATCH_READY_TIMEOUT_MS

/** Test-only: shorten the readiness deadline (`undefined` restores the default). */
export function __setWatchReadyTimeoutForTests(ms: number | undefined): void {
  watchReadyTimeoutMs = ms ?? WATCH_READY_TIMEOUT_MS
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Does a `getWatched()` listing include `path`? `FSWatcher.add` returns at once
 * and its `ready` event fires only for the FIRST batch of paths, so there is no
 * per-path signal to await. chokidar lists a file under its directory in the
 * same synchronous step that attaches the OS watch, which is the moment a write
 * starts producing events. chokidar keys directories with forward slashes on
 * every platform, so a Windows `C:\…` path is matched in that form too.
 */
export function isCanvasWatched(watched: Record<string, string[]>, path: string): boolean {
  if ((watched[dirname(path)] ?? []).includes(basename(path))) return true
  const unix = path.replace(/\\/g, '/')
  const cut = unix.lastIndexOf('/')
  return (watched[unix.slice(0, cut)] ?? []).includes(unix.slice(cut + 1))
}

function isWatching(w: FSWatcher, path: string): boolean {
  return isCanvasWatched(w.getWatched(), path)
}

async function whenWatching(w: FSWatcher, path: string): Promise<void> {
  // A file that does not exist is never watched; the pane shows its own error.
  if (
    !(await stat(path).then(
      () => true,
      () => false
    ))
  )
    return
  const deadline = Date.now() + watchReadyTimeoutMs
  while (watcher === w && !isWatching(w, path) && Date.now() < deadline) {
    await sleep(WATCH_READY_POLL_MS)
  }
  if (watcher !== w || isWatching(w, path)) return
  // The deadline passed: the pane reads now rather than hang, which reopens the
  // gap a write can fall into. Remember the bytes it is about to read and
  // compare once the watch is live, so such a write still reaches the panes.
  console.warn(
    `[canvas-watch] watch on ${path} not live after ${watchReadyTimeoutMs} ms; reading anyway`
  )
  const before = await readFile(path).then(fingerprint, () => null)
  void recheckOnceWatching(w, path, before)
}

async function recheckOnceWatching(
  w: FSWatcher,
  path: string,
  before: string | null
): Promise<void> {
  const deadline = Date.now() + WATCH_LATE_LIMIT_MS
  while (watcher === w && canvasRefCount(path) > 0 && !isWatching(w, path)) {
    if (Date.now() >= deadline) {
      console.warn(`[canvas-watch] watch on ${path} never went live; changes may be missed`)
      return
    }
    await sleep(WATCH_LATE_POLL_MS)
  }
  if (watcher !== w || canvasRefCount(path) <= 0) return
  const now = await readFile(path).then(fingerprint, () => null)
  if (now !== before) await notifyCanvasChanged(path)
}

/**
 * Register one pane's interest in `rawPath` and resolve only once the file is
 * being watched (BUG-210). The pane reads the canvas AFTER this resolves, so a
 * write can no longer fall between its read and the watch going live: it is
 * either in the read or produces an event. Resolving early used to leave that
 * gap, and the operator's next Save reverted the write that fell into it.
 */
export async function startCanvasWatch(rawPath: unknown, paneId?: string): Promise<void> {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return
  const p = resolve(rawPath)
  // IPC payloads cross the trust boundary — confine against the SAME gate as
  // canvas:read before ever subscribing chokidar to a renderer-supplied path.
  const gate = checkCanvasPathAllowed(p, await markdownKnownRoots())
  if (!gate.ok) return
  const first = addCanvasRef(p, paneId) === 'first'
  const w = ensureWatcher()
  if (first) w.add(p)
  // A second pane on the file waits too: the first pane's add may still be pending.
  await whenWatching(w, p)
}

/**
 * Wire the two per-pane lifecycle IPC handlers a mounted `DiagramPane` calls,
 * and stash the window getter `notifyCanvasChanged` broadcasts through. Call
 * ONCE from `src/main/index.ts`, mirroring every other `register*Handlers`.
 */
export function registerCanvasWatchHandlers(getWindow: () => BrowserWindow | null): void {
  windowGetter = getWindow
  ipcMain.handle('canvas:watchStart', (_e, args: { path: string; paneId?: unknown }) =>
    startCanvasWatch(args?.path, paneIdOf(args))
  )
  ipcMain.handle('canvas:watchStop', (_e, args: { path: string; paneId?: unknown }) => {
    const raw = args?.path
    if (typeof raw !== 'string' || raw.length === 0) return
    const p = resolve(raw)
    if (removeCanvasRef(p, paneIdOf(args)) === 'last' && watcher) watcher.unwatch(p)
  })
}

/** The renderer-supplied pane id — untrusted, so only a string counts. */
function paneIdOf(args: { paneId?: unknown } | undefined): string | undefined {
  return typeof args?.paneId === 'string' ? args.paneId : undefined
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
