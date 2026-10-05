import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import {
  buildSnapshot,
  diffStatus,
  type ClaudeStatusSnapshot,
  type StatusRunOutcome,
  type StatusNotification
} from './claude-status-parse'
import { buildNotificationOptions } from './notifications'

/**
 * Claude service-status poller (issue #17). Polls the Atlassian Statuspage
 * summary for `status.claude.com` from the main process (the renderer can't —
 * cross-origin CORS), folds it into a {@link ClaudeStatusSnapshot}, pushes the
 * footer dot, and fires native notifications on meaningful transitions.
 *
 * Pure parse + transition logic lives in `claude-status-parse.ts` (unit-tested);
 * this module is the imperative shell (fetch, single-flight, focus-gated poll
 * rate, Notification, IPC). Mirrors the handler-module shape of `usage.ts`
 * (`register*` + `close*`) and the fetch/Notification shape of `claude-changelog.ts`.
 *
 * Polling diverges from `usage.ts` on purpose: `usage` is focus-gated (spawning
 * `claude -p` is expensive), but the core value here — "alert me even when I'm
 * not looking" — needs background polling. A summary GET is tiny, so we poll 60s
 * focused / 5min backgrounded and refetch immediately on focus.
 */

const SUMMARY_URL = 'https://status.claude.com/api/v2/summary.json'
const HISTORY_URL = 'https://status.claude.com'
const FOCUS_INTERVAL_MS = 60_000
const BLUR_INTERVAL_MS = 5 * 60_000
const INITIAL_DELAY_MS = 4_000
const FETCH_TIMEOUT_MS = 8_000

let lastSnapshot: ClaudeStatusSnapshot | null = null
let inFlight: Promise<ClaudeStatusSnapshot> | null = null
let pollTimer: NodeJS.Timeout | null = null
let initialTimer: NodeJS.Timeout | null = null
let onFocus: (() => void) | null = null
let onBlur: (() => void) | null = null
let registered = false

/**
 * Renderer-pushed mute (`om2tab.claudeStatusNotify`). Default ON. main can't
 * read localStorage, so the store mirrors the flag here via `claudeStatus:setNotify`.
 */
let notifyEnabled = true

/**
 * Fetch the summary once. Per-request `AbortController` timeout so a hung
 * connection can't pin the single-flight. Never rejects — any failure maps to
 * `{ ok: false }` so the snapshot layer keeps last-good and shows a grey dot.
 */
async function fetchSummaryOnce(): Promise<StatusRunOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(SUMMARY_URL, { signal: controller.signal })
    if (!res.ok) return { ok: false }
    return { ok: true, json: await res.json() }
  } catch {
    return { ok: false }
  } finally {
    clearTimeout(timer)
  }
}

function fireNotification(
  getWindow: () => BrowserWindow | null,
  iconPath: string
): (note: StatusNotification) => void {
  return (note) => {
    if (!Notification.isSupported()) return
    try {
      const n = new Notification(
        buildNotificationOptions({ title: note.title, body: note.body }, iconPath)
      )
      n.on('click', () => {
        const win = getWindow()
        if (!win || win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        // Tell the renderer to open the status panel (footer popover).
        win.webContents.send('claude-status:activate')
      })
      n.show()
    } catch (err) {
      console.error('[claude-status] notification failed', err)
    }
  }
}

/** Single-flight refresh: concurrent callers share one in-flight fetch. */
function refresh(
  getWindow: () => BrowserWindow | null,
  iconPath: string
): Promise<ClaudeStatusSnapshot> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    const outcome = await fetchSummaryOnce()
    const next = buildSnapshot(lastSnapshot, outcome, Date.now())
    // Decide BEFORE replacing lastSnapshot — `prev === null` (cold start) yields
    // a silent baseline (dot only, no notification).
    const notes = diffStatus(lastSnapshot, next, { notify: notifyEnabled })
    lastSnapshot = next
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('claude-status:updated', next)
    notes.forEach(fireNotification(getWindow, iconPath))
    return next
  })()
  return inFlight.finally(() => {
    inFlight = null
  })
}

function startPolling(
  getWindow: () => BrowserWindow | null,
  iconPath: string,
  intervalMs: number,
  immediate: boolean
): void {
  stopPolling()
  if (immediate) void refresh(getWindow, iconPath)
  pollTimer = setInterval(() => void refresh(getWindow, iconPath), intervalMs)
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

export function registerClaudeStatus(
  getWindow: () => BrowserWindow | null,
  iconPath: string
): void {
  // Single registration for the process lifetime (ipcMain.handle throws on a
  // duplicate channel) — guards against main-process HMR re-entry.
  if (registered) return
  registered = true

  ipcMain.handle(
    'claude-status:get',
    async (): Promise<ClaudeStatusSnapshot> => lastSnapshot ?? (await refresh(getWindow, iconPath))
  )
  ipcMain.handle('claude-status:refresh', () => refresh(getWindow, iconPath))
  ipcMain.handle('claude-status:history', () => HISTORY_URL)
  ipcMain.handle('claude-status:setNotify', (_e, enabled: boolean) => {
    notifyEnabled = enabled !== false
  })

  // Focus upgrades to the fast rate (+ immediate refetch); blur drops to the
  // slow background rate but never stops — the alert must fire while backgrounded.
  onFocus = (): void => startPolling(getWindow, iconPath, FOCUS_INTERVAL_MS, true)
  onBlur = (): void => startPolling(getWindow, iconPath, BLUR_INTERVAL_MS, false)
  app.on('browser-window-focus', onFocus)
  app.on('browser-window-blur', onBlur)

  // Kick off shortly after boot at the background rate; a focus event upgrades it.
  initialTimer = setTimeout(
    () => startPolling(getWindow, iconPath, BLUR_INTERVAL_MS, true),
    INITIAL_DELAY_MS
  )
}

/** Stop timers + detach focus listeners on quit. */
export function closeClaudeStatus(): void {
  stopPolling()
  if (initialTimer) {
    clearTimeout(initialTimer)
    initialTimer = null
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
