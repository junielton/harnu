import { app, ipcMain, shell, Notification, type BrowserWindow } from 'electron'
import { join, dirname } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { parseClaudeChangelog, type ClaudeRelease } from './claude-changelog-parse'
import {
  type ClaudeChangelogState,
  EMPTY_STATE,
  applyFetched,
  markRead as markReadState
} from './claude-changelog-state'
import { buildNotificationOptions } from './notifications'

/**
 * Claude Code changelog watcher (spec 2026-06-18). Polls the Claude Code CLI's
 * CHANGELOG.md from GitHub raw, folds it into persisted state, and pushes a
 * persistent unread signal (gear dot) + one OS notification per new version to
 * the renderer. Pure logic lives in `claude-changelog-state.ts`; this module is
 * the fetch/fs/Notification/timer shell. Runs in dev too (harmless GitHub
 * fetch), unlike `updater.ts` which gates on `app.isPackaged`.
 */
const CHANGELOG_RAW_URL =
  'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md'
const CHANGELOG_WEB_URL = 'https://code.claude.com/docs/en/changelog'
const POLL_INTERVAL_MS = 30 * 60 * 1000
const INITIAL_DELAY_MS = 5_000

let state: ClaudeChangelogState = { ...EMPTY_STATE }
let pollTimer: NodeJS.Timeout | null = null
let initialTimer: NodeJS.Timeout | null = null
let registered = false

function statePath(): string {
  return join(app.getPath('userData'), 'claude-changelog.json')
}

async function loadState(): Promise<ClaudeChangelogState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8')) as Partial<ClaudeChangelogState>
    return {
      releases: Array.isArray(parsed.releases) ? parsed.releases : [],
      lastReadVersion: typeof parsed.lastReadVersion === 'string' ? parsed.lastReadVersion : '',
      lastFetchedAt: typeof parsed.lastFetchedAt === 'number' ? parsed.lastFetchedAt : 0
    }
  } catch {
    // Missing or corrupt — start clean. The next poll re-seeds silently.
    return { ...EMPTY_STATE }
  }
}

async function persist(): Promise<void> {
  try {
    const path = statePath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf8')
  } catch (err) {
    console.error('[claude-changelog] persist failed', err)
  }
}

async function fetchReleases(): Promise<ClaudeRelease[]> {
  try {
    const res = await fetch(CHANGELOG_RAW_URL)
    if (!res.ok) {
      console.warn('[claude-changelog] fetch failed', res.status)
      return []
    }
    return parseClaudeChangelog(await res.text())
  } catch (err) {
    console.warn('[claude-changelog] fetch error', String(err))
    return []
  }
}

function notifyNewVersion(
  getWindow: () => BrowserWindow | null,
  iconPath: string,
  version: string
): void {
  if (!Notification.isSupported()) return
  try {
    const n = new Notification(
      buildNotificationOptions(
        { title: 'Claude Code', body: `Version ${version} available` },
        iconPath
      )
    )
    n.on('click', () => {
      const win = getWindow()
      if (!win || win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('claude-changelog:activate')
    })
    n.show()
  } catch (err) {
    console.error('[claude-changelog] notification failed', err)
  }
}

async function poll(getWindow: () => BrowserWindow | null, iconPath: string): Promise<void> {
  const fetched = await fetchReleases()
  const prev = state
  const { next, hasNew } = applyFetched(prev, fetched, Date.now())
  state = next
  if (next !== prev) await persist()
  if (hasNew && next.releases[0]) {
    notifyNewVersion(getWindow, iconPath, next.releases[0].version)
    // Signal the renderer to play the notification sound (if enabled). Pairs
    // with the OS notification above (notification-sound spec §4.4).
    getWindow()?.webContents.send('claude-changelog:new-version')
  }
  getWindow()?.webContents.send('claude-changelog:updated', state)
}

export function registerClaudeChangelog(
  getWindow: () => BrowserWindow | null,
  iconPath: string
): void {
  // Single registration for the process lifetime — ipcMain.handle throws on a
  // duplicate channel, so this guards against main-process HMR re-entry (same
  // pattern as updater.ts `installHandlerRegistered`).
  if (registered) return
  registered = true

  ipcMain.handle('claude-changelog:get', () => state)

  ipcMain.handle('claude-changelog:markRead', async () => {
    state = markReadState(state)
    await persist()
    getWindow()?.webContents.send('claude-changelog:updated', state)
  })

  ipcMain.handle('claude-changelog:refresh', () => poll(getWindow, iconPath))

  ipcMain.handle('claude-changelog:openExternal', () => shell.openExternal(CHANGELOG_WEB_URL))

  void (async () => {
    state = await loadState()
    getWindow()?.webContents.send('claude-changelog:updated', state)
    initialTimer = setTimeout(() => void poll(getWindow, iconPath), INITIAL_DELAY_MS)
    pollTimer = setInterval(() => void poll(getWindow, iconPath), POLL_INTERVAL_MS)
  })()
}

/** Clear timers on quit so no poll fires during teardown. */
export function closeClaudeChangelog(): void {
  if (initialTimer) {
    clearTimeout(initialTimer)
    initialTimer = null
  }
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
