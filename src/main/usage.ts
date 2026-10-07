import { app, BrowserWindow, ipcMain } from 'electron'
import { execFile, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { buildSnapshot, type UsageSnapshot, type UsageRunOutcome } from './usage-parse'
import { resolveClaudePath } from './claude-cli'
import { sanitizeSpawnEnv } from './appimage-env'
import { planUsagePollAllowed, reportPlanUsagePoll } from './companion/ingest/plan-usage-gate'

/**
 * Plan-usage poller (plan-usage-widget spec). Spawns the official Claude Code
 * client headless — `claude -p "/usage"` — and parses its stdout into a
 * {@link UsageSnapshot}. This is the sanctioned data path: no credential
 * handling, no undocumented endpoints. The pure parse/fold logic lives in
 * `usage-parse.ts` (unit-tested); this module is the imperative shell (spawn,
 * single-flight, focus-gated polling, IPC) verified end-to-end.
 *
 * Mirrors the handler-module shape of `settings.ts`: one exported
 * `registerUsageHandlers(getWindow)` plus a `closeUsagePoller()` for quit.
 */

const POLL_INTERVAL_MS = 90_000
const SPAWN_TIMEOUT_MS = 20_000

let lastSnapshot: UsageSnapshot | null = null
let inFlight: Promise<UsageSnapshot> | null = null
let pollTimer: NodeJS.Timeout | null = null
let inFlightChild: ChildProcess | null = null
let onFocus: (() => void) | null = null
let onBlur: (() => void) | null = null

/**
 * Run `claude -p "/usage"` once. Neutral cwd (homedir) so a project's
 * CLAUDE.md / hooks aren't loaded. NOT `--bare` (that forces API-key auth and
 * ignores subscription OAuth, breaking `/usage`); `--model haiku` caps any
 * incidental cost. Never rejects — failure (ENOENT, timeout, non-zero) maps to
 * `{ ok: false }` so the snapshot layer can keep last-good data.
 */
async function runUsageOnce(): Promise<UsageRunOutcome> {
  // Resolve the `claude` binary explicitly and sanitize the spawn env — same as
  // haiku.ts / usage-history.ts. A macOS Dock launch strips PATH to
  // /usr/bin:/bin (bare `claude` → ENOENT), and an AppImage leaks $APPDIR-rooted
  // LD_LIBRARY_PATH/PATH into the child unless scrubbed.
  const bin = (await resolveClaudePath()) ?? 'claude'
  return new Promise((resolve) => {
    inFlightChild = execFile(
      bin,
      ['-p', '/usage', '--model', 'haiku'],
      {
        cwd: homedir(),
        env: sanitizeSpawnEnv(process.env, { execPath: process.execPath }),
        timeout: SPAWN_TIMEOUT_MS,
        maxBuffer: 1 << 20,
        encoding: 'utf8'
      },
      (err, stdout) => {
        inFlightChild = null
        resolve(err ? { ok: false } : { ok: true, stdout })
      }
    )
  })
}

/**
 * Single-flight refresh: concurrent callers share one in-flight spawn. We do NOT
 * retry incomplete (preamble-only) results: `/usage` has a ~20–40s cooldown after
 * a recent call during which it returns only the preamble, so rapid retries land
 * inside that window and reliably fail. The 90s poll interval is comfortably past
 * the cooldown, so spaced polls land complete; an incomplete poll meanwhile just
 * keeps the last-good snapshot (`buildSnapshot`).
 */
function refresh(getWindow: () => BrowserWindow | null): Promise<UsageSnapshot> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    const outcome = await runUsageOnce()
    lastSnapshot = buildSnapshot(lastSnapshot, outcome, Date.now())
    // Only a poll that produced its own figures is a comparison point for the `planUsage` parity
    // rule; a failed or incomplete one only kept the last-good snapshot.
    if (outcome.ok && !lastSnapshot.stale && lastSnapshot.available) {
      reportPlanUsagePoll({ session: lastSnapshot.session, weekAll: lastSnapshot.weekAll })
    }
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('usage:updated', lastSnapshot)
    return lastSnapshot
  })()
  return inFlight.finally(() => {
    inFlight = null
  })
}

/**
 * The timer tick and the refresh on focus (T389 P1W6): a session whose binding owns `planUsage`
 * reported a window within `PLAN_USAGE_STALE_MS`, so the spawn would only repeat it. The timer,
 * `refresh`, single-flight and `buildSnapshot` are unchanged; `usage:refresh` and the cold-start
 * `usage:get` never come through here and always spawn.
 */
function refreshIfDue(getWindow: () => BrowserWindow | null): void {
  if (!planUsagePollAllowed()) return
  void refresh(getWindow)
}

function startPolling(getWindow: () => BrowserWindow | null): void {
  stopPolling()
  refreshIfDue(getWindow) // immediate refresh on focus
  pollTimer = setInterval(() => refreshIfDue(getWindow), POLL_INTERVAL_MS)
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

export function registerUsageHandlers(getWindow: () => BrowserWindow | null): void {
  // `usage:get` returns the cached snapshot, fetching once if none exists yet —
  // this is what the renderer store calls on init. `usage:refresh` always
  // forces a fresh spawn.
  ipcMain.handle(
    'usage:get',
    async (): Promise<UsageSnapshot> => lastSnapshot ?? (await refresh(getWindow))
  )
  ipcMain.handle('usage:refresh', (): Promise<UsageSnapshot> => refresh(getWindow))

  // Focus-gated polling: the window doesn't exist yet at registration time
  // (registered before createWindow), so we hang off the app-level focus/blur
  // events rather than a specific BrowserWindow. Zero spawns while backgrounded.
  onFocus = (): void => startPolling(getWindow)
  onBlur = (): void => stopPolling()
  app.on('browser-window-focus', onFocus)
  app.on('browser-window-blur', onBlur)
}

/** Stop the poll timer, kill any in-flight spawn, and detach focus listeners on quit. */
export function closeUsagePoller(): void {
  stopPolling()
  if (inFlightChild) {
    inFlightChild.kill()
    inFlightChild = null
  }
  if (onFocus) {
    app.removeListener('browser-window-focus', onFocus)
    onFocus = null
  }
  if (onBlur) {
    app.removeListener('browser-window-blur', onBlur)
    onBlur = null
  }
}
