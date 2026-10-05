import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile, mkdir, chmod, rm, unlink } from 'node:fs/promises'
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import chokidar, { type FSWatcher } from 'chokidar'
import { updateClaudeSettings, claudeSettingsPath } from './claude-settings'
import {
  parseStatusLineBlob,
  foldFleetTelemetry,
  TELEMETRY_TTL_MS,
  type SessionTelemetry,
  type FleetTelemetry
} from './statusline-parse'
import { captureFleet } from './usage-history'
import {
  mergeStatusLine,
  stripStatusLine,
  buildWriterScript,
  isWriterStale
} from './statusline-install'

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
 */

export interface TelemetryPayload {
  perSession: SessionTelemetry[]
  fleet: FleetTelemetry
}

const DEBOUNCE_MS = 150
/**
 * Self-heal cadence. The installed `statusLine` key can vanish while we run —
 * historically another Harnu instance (dev / verify, different userData) quitting
 * stripped it via the loose exit cleanup, silently killing telemetry fleet-wide
 * until the next app restart. A cheap periodic read re-installs when the key is
 * MISSING (never fights a foreign statusLine, never reclaims another live Harnu
 * instance's writer).
 */
const SELF_HEAL_MS = 60_000
/** Debounce for persisting the telemetry map to disk (survives app restarts). */
const CACHE_WRITE_MS = 1_000

const telemetry = new Map<string, SessionTelemetry>()
let watcher: FSWatcher | null = null
let debounceTimer: NodeJS.Timeout | null = null
let healTimer: NodeJS.Timeout | null = null
let cacheTimer: NodeJS.Timeout | null = null
let lastForeignPreserved = false

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
    return next
  })
}

async function uninstallStatusLine(): Promise<void> {
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
    if (!(await readEnabled())) return
    let statusLine: unknown = null
    try {
      const parsed: unknown = JSON.parse(await readFile(claudeSettingsPath(), 'utf8'))
      if (!parsed || typeof parsed !== 'object') return // corrupt — never RMW over it
      statusLine = (parsed as Record<string, unknown>).statusLine
    } catch (err) {
      // Missing file → heal (install recreates it); unreadable/corrupt → leave it.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return
    }
    if (statusLine != null) return
    await ensureWriterScript()
    await installStatusLine()
    console.error('[statusline] self-heal: statusLine key was missing — re-installed')
  } catch (err) {
    console.error('[statusline] self-heal failed:', err)
  }
}

function payload(): TelemetryPayload {
  return { perSession: [...telemetry.values()], fleet: foldFleetTelemetry(telemetry, Date.now()) }
}

/**
 * Read-only accessor for the live telemetry payload, for modules that need
 * "right now" fleet state without going through IPC (e.g. `usage-bi.ts`'s
 * `now` block, T47 P6 S1). Same data `telemetry:get` returns.
 */
export function getTelemetryPayload(): TelemetryPayload {
  return payload()
}

/**
 * Seed the in-memory map from the persisted cache (TTL-filtered). Without this,
 * every restart blanked the per-session HUD until each session's NEXT turn — a
 * session idle since app launch showed only its name in the footer.
 */
async function loadTelemetryCache(): Promise<void> {
  try {
    const arr: unknown = JSON.parse(await readFile(cachePath(), 'utf8'))
    if (!Array.isArray(arr)) return
    const now = Date.now()
    for (const entry of arr) {
      if (!entry || typeof entry !== 'object') continue
      const t = entry as SessionTelemetry
      if (typeof t.sessionId !== 'string' || typeof t.updatedAtMs !== 'number') continue
      if (now - t.updatedAtMs > TELEMETRY_TTL_MS) continue
      telemetry.set(t.sessionId, t)
    }
  } catch {
    /* no/unreadable cache — cold start */
  }
}

function serializeCache(): string {
  return JSON.stringify([...telemetry.values()])
}

function scheduleCacheWrite(): void {
  if (cacheTimer) clearTimeout(cacheTimer)
  cacheTimer = setTimeout(() => {
    cacheTimer = null
    void writeFile(cachePath(), serializeCache(), 'utf8').catch(() => {})
  }, CACHE_WRITE_MS)
}

async function processInboxFile(path: string): Promise<void> {
  try {
    const t = parseStatusLineBlob(await readFile(path, 'utf8'), Date.now())
    if (t) {
      telemetry.set(t.sessionId, t)
      scheduleCacheWrite()
      // Persist the fleet aggregate for the usage-history / BI feature (issue
      // #19). Fire-and-forget + fail-safe: the capture layer swallows its own
      // errors so it can never block or break the statusLine ingest.
      const now = Date.now()
      void captureFleet(foldFleetTelemetry(telemetry, now), now)
    }
  } catch {
    /* unreadable/partial blob — skip; the next turn rewrites it */
  } finally {
    void unlink(path).catch(() => {})
  }
}

function scheduleEmit(getWindow: () => BrowserWindow | null): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('telemetry:updated', payload())
  }, DEBOUNCE_MS)
}

function startWatcher(getWindow: () => BrowserWindow | null): void {
  watcher = chokidar.watch(inboxDir(), { ignoreInitial: true, depth: 0 })
  watcher.on('add', (p) => {
    void processInboxFile(p).then(() => scheduleEmit(getWindow))
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
  getWindow: () => BrowserWindow | null
): Promise<void> {
  try {
    await rm(inboxDir(), { recursive: true, force: true }) // drop stale blobs from a prior run
    await ensureWriterScript()
    if (await readEnabled()) await installStatusLine()
  } catch (err) {
    console.error('[statusline] setup failed (degrading to /usage):', err)
  }
  await loadTelemetryCache() // last-known HUD data survives the restart (TTL-filtered)
  startWatcher(getWindow)
  registerExitCleanup()
  healTimer = setInterval(() => void selfHealTick(), SELF_HEAL_MS)

  ipcMain.handle('telemetry:get', (): TelemetryPayload => payload())
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
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (healTimer) {
    clearInterval(healTimer)
    healTimer = null
  }
  if (cacheTimer) {
    clearTimeout(cacheTimer)
    cacheTimer = null
  }
  // Flush the last-known telemetry synchronously so the next launch restores it.
  try {
    writeFileSync(cachePath(), serializeCache(), 'utf8')
  } catch {
    /* best-effort cache */
  }
  if (watcher) {
    const w = watcher
    watcher = null
    await w.close()
  }
}
