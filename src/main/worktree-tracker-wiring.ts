/**
 * Production wiring of the worktree tracker (T388 / sidebar-liveness U4b, spec
 * §4.B B2): the real `fs`/Electron deps for `createWorktreeTracker` and the IPC
 * pair the sidebar uses — `worktrees:track` (renderer → main, the known-repo
 * set) and the `worktrees:changed` push (`{ repoId, entries }`).
 *
 * Kept out of `index.ts` so the deps are testable without booting the app:
 * the focus fallback (AC-13) only works if `watch` forwards the watcher's async
 * `'error'` event to `onError` — a bare `fs.watch` has no `'error'` listener,
 * so a later `ENOSPC`/`EPERM` would throw in main instead of degrading.
 */
import { app, ipcMain } from 'electron'
import { watch, promises as fsp } from 'node:fs'
import {
  createWorktreeTracker,
  type TrackedRepo,
  type WorktreeTrackerDeps
} from './worktree-tracker'
import { listWorktrees } from './worktree-ipc'
import { normalizePath } from './user-projects'

/** The slice of `BrowserWindow` the push needs (a test can pass a double). */
interface PushTarget {
  isDestroyed(): boolean
  webContents: { send(channel: string, payload: unknown): void }
}

/** Real deps: git via `listWorktrees`, `normalizePath` for D9, `fs.watch`, app focus. */
export function productionWorktreeTrackerDeps(): WorktreeTrackerDeps {
  return {
    listWorktrees,
    canonicalize: normalizePath,
    // `persistent: false` so a watch never keeps the process alive at quit.
    watch: (dir, onEvent, onError) =>
      watch(dir, { persistent: false }, (event, filename) =>
        onEvent(event, filename === null ? null : String(filename))
      ).on('error', (err) => onError?.(err)),
    stat: (dir) =>
      fsp.stat(dir).then(
        (s) => ({ mtimeMs: s.mtimeMs }),
        () => null
      ),
    onFocus: (cb) => {
      app.on('browser-window-focus', cb)
      return () => {
        app.off('browser-window-focus', cb)
      }
    },
    now: Date.now
  }
}

/** Keep only well-formed `TrackedRepo` records from an untrusted IPC payload. */
function sanitizeRepos(input: unknown): TrackedRepo[] {
  if (!Array.isArray(input)) return []
  const out: TrackedRepo[] = []
  for (const r of input) {
    if (!r || typeof r !== 'object') continue
    const { repoId, probePath, memberPaths } = r as Record<string, unknown>
    if (typeof repoId !== 'string' || typeof probePath !== 'string' || !repoId || !probePath)
      continue
    out.push({
      repoId,
      probePath,
      memberPaths: Array.isArray(memberPaths)
        ? memberPaths.filter((p): p is string => typeof p === 'string')
        : []
    })
  }
  return out
}

/**
 * Build the single tracker instance and register `worktrees:track`. Emits go
 * to whatever window `getWindow` returns at send time, so a recreated window is
 * served. Returns the close function for the quit path.
 */
export function registerWorktreeTracker(getWindow: () => PushTarget | null): () => void {
  const tracker = createWorktreeTracker(productionWorktreeTrackerDeps(), (repoId, entries) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('worktrees:changed', { repoId, entries })
  })
  ipcMain.handle('worktrees:track', (_e, repos: unknown) => {
    tracker.track(sanitizeRepos(repos))
  })
  return () => tracker.close()
}
