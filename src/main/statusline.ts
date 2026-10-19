import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile, mkdir, chmod, rm, unlink, stat } from 'node:fs/promises'
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import chokidar, { type FSWatcher } from 'chokidar'
import { updateClaudeSettings, claudeSettingsPath } from './claude-settings'
import { parseStatusLineBlob } from './statusline-parse'
import { readTranscriptFallback } from './statusline-fallback'
import {
  configureTelemetryStore,
  getTelemetryPayload,
  ingestStatusline,
  telemetryStore,
  type TelemetryPayload
} from './telemetry-store'
import {
  mergeStatusLine,
  stripStatusLine,
  buildWriterScript,
  isWriterStale
} from './statusline-install'
import {
  runHealTick,
  trimHealLog,
  type HealNotice,
  type HealNoticeState,
  type LiveClaudeProc
} from './statusline-heal-core'

/**
 * statusLine telemetry bridge (spec `2026-06-17-statusline-telemetry-design.md`).
 * Installs a `statusLine` command in `~/.claude/settings.json` that dumps the rich
 * per-turn JSON blob Claude Code pipes on stdin into `<userData>/statusline/inbox/`;
 * we tail that dir, parse each blob (pure `statusline-parse.ts`), keep a
 * per-session telemetry map, and push `{ perSession, fleet }` to the renderer —
 * zero API tokens, retiring the frequent `/usage` poll.
 *
 * Mirrors `hook-bridge.ts`: pure logic lives in `statusline-parse.ts` /
 * `statusline-install.ts` (unit-tested); this is the electron/chokidar shell
 * (register/close + opt-out + exit-cleanup), verified by build + e2e.
 *
 * T389 P1W6: the per-session map, the cache and the renderer push moved to the neutral
 * `telemetry-store.ts`, which this module and the companion adapter both write into. This file
 * keeps install, self-heal, exit cleanup and the inbox watcher, and imports nothing under
 * `src/main/companion`: install and cleanup cannot be conditioned on companion state
 * (lesson framework/005, `tests/companion/statusline-independence.test.ts`).
 */

export type { TelemetryPayload }
export { getTelemetryPayload }

export interface StatusLineOptions {
  /** The live `claude` processes Harnu owns (pid + spawn time), for the heal evidence and nudge. */
  liveProcs?: () => LiveClaudeProc[]
}

/**
 * Self-heal cadence. The installed `statusLine` key can vanish while we run —
 * historically another Harnu instance (dev / verify, different userData) quitting
 * stripped it via the loose exit cleanup, silently killing telemetry fleet-wide
 * until the next app restart. A cheap periodic read re-installs when the key is
 * MISSING (never fights a foreign statusLine, never reclaims another live Harnu
 * instance's writer).
 */
const SELF_HEAL_MS = 60_000

let watcher: FSWatcher | null = null
let healTimer: NodeJS.Timeout | null = null
let lastForeignPreserved = false
/** True once this run installed our statusLine, so a different value is a `replaced` finding. */
let installedByUs = false
let liveProcsProvider: () => LiveClaudeProc[] = () => []
/** De-dup state for the "statusLine removed" Activity notice; lives for the process lifetime. */
const healNoticeState: HealNoticeState = { lastKey: null, lastAtMs: 0 }
let sendHealNotice: (n: HealNotice) => void = () => {}

function statuslineDir(): string {
  return join(app.getPath('userData'), 'statusline')
}
function inboxDir(): string {
  return join(statuslineDir(), 'inbox')
}
function writerKind(): 'sh' | 'cmd' {
  return process.platform === 'win32' ? 'cmd' : 'sh'
}
function writerPath(): string {
  return join(statuslineDir(), `statusline-writer.${writerKind()}`)
}
/** The `command` string written into settings.json — points at our writer script. */
function ourCommand(): string {
  const p = writerPath()
  return process.platform === 'win32' ? `cmd /c "${p}"` : `sh "${p}"`
}
/** Evidence of every self-heal that found the statusLine key gone (bounded, ndjson). */
function healLogPath(): string {
  return join(statuslineDir(), 'heal-log.ndjson')
}
function prefsPath(): string {
  return join(app.getPath('userData'), 'statusline-prefs.json')
}
/** Last-known telemetry map, persisted so a restart doesn't blank every session's HUD. */
function cachePath(): string {
  return join(statuslineDir(), 'telemetry-cache.json')
}

/** Opt-out model: telemetry is ON unless the user explicitly disabled it. */
async function readEnabled(): Promise<boolean> {
  try {
    const p = JSON.parse(await readFile(prefsPath(), 'utf8'))
    return p?.enabled !== false
  } catch {
    return true
  }
}
async function writeEnabled(enabled: boolean): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(prefsPath(), JSON.stringify({ enabled }, null, 2) + '\n', 'utf8')
}

/** Materialize the writer script (idempotent, versioned) so updates propagate. */
async function ensureWriterScript(): Promise<void> {
  await mkdir(inboxDir(), { recursive: true })
  let existing: string | null = null
  try {
    existing = await readFile(writerPath(), 'utf8')
  } catch {
    existing = null
  }
  if (isWriterStale(existing)) {
    await writeFile(writerPath(), buildWriterScript(writerKind(), inboxDir()), 'utf8')
    if (process.platform !== 'win32') await chmod(writerPath(), 0o755)
  }
}

async function installStatusLine(): Promise<void> {
  await updateClaudeSettings(claudeSettingsPath(), (settings) => {
    const { next, foreignPreserved } = mergeStatusLine(settings, ourCommand())
    lastForeignPreserved = foreignPreserved
    if (!foreignPreserved) installedByUs = true
    return next
  })
}

async function appendHealLog(line: string): Promise<void> {
  let existing = ''
  try {
    existing = await readFile(healLogPath(), 'utf8')
  } catch {
    /* first entry */
  }
  await mkdir(statuslineDir(), { recursive: true })
  await writeFile(healLogPath(), trimHealLog(existing + line), 'utf8')
}

async function uninstallStatusLine(): Promise<void> {
  installedByUs = false
  await updateClaudeSettings(claudeSettingsPath(), (settings) => stripStatusLine(settings))
}

/**
 * Synchronous mirror of `claude-settings.ts`'s `atomicWrite` for exit handlers:
 * back up the prior bytes to `<path>.backup` (best-effort), write a `*.tmp`
 * sibling, then `renameSync` it over the target so a SIGKILL mid-write can never
 * truncate the co-owned settings.json.
 */
function atomicWriteSync(path: string, content: string): void {
  try {
    copyFileSync(path, `${path}.backup`)
  } catch {
    /* best-effort backup: source may not exist yet */
  }
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

/**
 * Synchronous, best-effort removal of our statusLine on process exit. STRICT
 * identity (exact `command` string): a second instance (dev / verify — different
 * userData, so a different writer path) quitting must leave a still-running
 * instance's statusLine alone. The loose basename match here used to strip it,
 * killing telemetry for the surviving instance until its next restart.
 */
function removeOwnStatusLineSync(): void {
  try {
    const path = claudeSettingsPath()
    const settings = JSON.parse(readFileSync(path, 'utf8'))
    if (!settings || typeof settings !== 'object') return
    const stripped = stripStatusLine(settings, ourCommand())
    if (JSON.stringify(stripped) === JSON.stringify(settings)) return
    atomicWriteSync(path, JSON.stringify(stripped, null, 2) + '\n')
  } catch {
    /* best-effort: never block exit on an unwritable settings.json */
  }
}

/**
 * Re-install the statusLine when the key has VANISHED (another instance's exit
 * cleanup, a manual edit, a tool rewriting settings.json). Deliberately narrow:
 * a present-but-different statusLine is either a foreign one (preserved, never
 * fought) or another live Harnu instance's (last-boot-wins, same as install).
 */
async function selfHealTick(): Promise<void> {
  try {
    await runHealTick({
      now: () => Date.now(),
      enabled: readEnabled,
      readSettings: async () => {
        const path = claudeSettingsPath()
        try {
          const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
          if (!parsed || typeof parsed !== 'object') return { kind: 'unreadable' } // corrupt
          const mtimeMs = await stat(path).then(
            (st) => st.mtimeMs,
            () => null
          )
          return {
            kind: 'ok',
            statusLine: (parsed as Record<string, unknown>).statusLine,
            mtimeMs
          }
        } catch (err) {
          // Missing file → heal (install recreates it); unreadable/corrupt → leave it.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'unreadable' }
          return { kind: 'ok', statusLine: undefined, mtimeMs: null }
        }
      },
      reinstall: async () => {
        await ensureWriterScript()
        await installStatusLine()
        console.error('[statusline] self-heal: statusLine key was missing — re-installed')
      },
      appendLog: appendHealLog,
      liveProcs: () => {
        try {
          return liveProcsProvider()
        } catch {
          return []
        }
      },
      notice: (n) => sendHealNotice(n),
      wasOurs: () => installedByUs,
      ourCommand,
      noticeState: healNoticeState
    })
  } catch (err) {
    console.error('[statusline] self-heal failed:', err)
  }
}

async function processInboxFile(path: string): Promise<void> {
  try {
    const t = parseStatusLineBlob(await readFile(path, 'utf8'), Date.now())
    // The store composes, persists, feeds usage history and schedules the renderer push.
    if (t) ingestStatusline(t)
  } catch {
    /* unreadable/partial blob — skip; the next turn rewrites it */
  } finally {
    void unlink(path).catch(() => {})
  }
}

function startWatcher(): void {
  watcher = chokidar.watch(inboxDir(), { ignoreInitial: true, depth: 0 })
  watcher.on('add', (p) => {
    void processInboxFile(p)
  })
}

let exitCleanupArmed = false
function registerExitCleanup(): void {
  if (exitCleanupArmed) return
  exitCleanupArmed = true
  process.once('exit', () => removeOwnStatusLineSync())
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => removeOwnStatusLineSync())
  }
}

export async function registerStatusLineHandlers(
  getWindow: () => BrowserWindow | null,
  options: StatusLineOptions = {}
): Promise<void> {
  if (options.liveProcs) liveProcsProvider = options.liveProcs
  sendHealNotice = (n) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('statusline:healed', n)
  }
  configureTelemetryStore({
    cachePath,
    send: (payload) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('telemetry:updated', payload)
    }
  })
  try {
    await rm(inboxDir(), { recursive: true, force: true }) // drop stale blobs from a prior run
    await ensureWriterScript()
    if (await readEnabled()) await installStatusLine()
  } catch (err) {
    console.error('[statusline] setup failed (degrading to /usage):', err)
  }
  await telemetryStore().hydrate() // last-known HUD data survives the restart (TTL-filtered)
  startWatcher()
  registerExitCleanup()
  healTimer = setInterval(() => void selfHealTick(), SELF_HEAL_MS)

  ipcMain.handle('telemetry:get', (): TelemetryPayload => getTelemetryPayload())
  ipcMain.handle('telemetry:transcriptFallback', (_e, sessionId: string, fullPath: string) =>
    readTranscriptFallback(sessionId, fullPath)
  )
  ipcMain.handle('statusline:status', async () => ({
    enabled: await readEnabled(),
    foreignPreserved: lastForeignPreserved
  }))
  ipcMain.handle('statusline:setEnabled', async (_e, enabled: boolean) => {
    await writeEnabled(enabled)
    try {
      if (enabled) {
        await ensureWriterScript()
        await installStatusLine()
      } else {
        await uninstallStatusLine()
      }
    } catch (err) {
      console.error('[statusline] toggle failed:', err)
    }
    return { enabled }
  })
}

/** Close the watcher and remove our statusLine on quit (sync, best-effort). */
export async function closeStatusLine(): Promise<void> {
  removeOwnStatusLineSync()
  if (healTimer) {
    clearInterval(healTimer)
    healTimer = null
  }
  // Flush the last-known telemetry synchronously so the next launch restores it.
  telemetryStore().flushSync()
  telemetryStore().close()
  if (watcher) {
    const w = watcher
    watcher = null
    await w.close()
  }
}
