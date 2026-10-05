/**
 * Claude PID session-registry watcher (T92 §3 — the cheap third signal source).
 *
 * The `claude` CLI writes a per-process registry file `~/.claude/sessions/<pid>.json`
 * (this backs `claude ps`). Beyond the always-written `pid`/`sessionId`/`cwd`, a
 * shipped build with the `BG_SESSIONS` feature ALSO writes a live `status`
 * (`busy` | `idle` | `waiting`) and, when waiting, a `waitingFor` string. That is
 * ground truth for the fleet dot at near-zero cost: one chokidar on ONE directory,
 * no transcript parsing.
 *
 * It is an ADDITIONAL overlay, layered BELOW the injected per-session hooks: for a
 * Harnu-spawned session the hook FSM is richer (carries last_assistant_message,
 * exact notification_type) and wins; the registry's value is for EXTERNAL sessions
 * (Claude run in a plain terminal) Harnu never injected hooks into — there it beats
 * the transcript heuristic. Precedence lives in the pure fleet classifier
 * (`stores/fleet-state.ts`): hook taskState > registry status > transcript.
 *
 * Feature-gated & fail-open: if `~/.claude/sessions/` doesn't exist (older CLI /
 * BG_SESSIONS off), we skip silently. A file without a `status` field maps to
 * `undefined` and emits nothing — the session just falls through to its other
 * signals. The parse/map core is PURE (unit-tested); this module is the effect.
 *
 * Channel emitted (payload matches the preload's inline interface):
 *   - claude:sessionRegistry  { sessionId, taskState, waitingFor?, updatedAt }
 */

import { existsSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { TaskState } from './hook-state'

/** `~/.claude/sessions` — hardcoded like every other `~/.claude` path in the app
 *  (no `CLAUDE_CONFIG_DIR` support today; see `image-cache.ts`). */
export function sessionsRegistryDir(): string {
  return path.join(homedir(), '.claude', 'sessions')
}

/** The subset of a `<pid>.json` registry entry the fleet overlay reads. */
export interface RegistryEntry {
  sessionId: string
  /** `busy` | `idle` | `waiting` when the build emits it; else undefined. */
  status?: string
  /** Present (with `status: 'waiting'`) — e.g. `approve <tool>`, `input needed`. */
  waitingFor?: string
  /** `statusUpdatedAt` (epoch ms) for freshness; falls back to `updatedAt`. */
  updatedAt?: number
}

/**
 * Parse one registry file's raw JSON into the fields we consume. Returns `null`
 * unless it is an object carrying a non-empty `sessionId` (the key the fleet
 * store joins on) — anything else (unparseable, array, missing id) is ignored.
 * Pure; never throws.
 */
export function parseRegistryEntry(raw: string): RegistryEntry | null {
  let obj: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    obj = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : ''
  if (!sessionId) return null
  const status = typeof obj.status === 'string' ? obj.status : undefined
  const waitingFor = typeof obj.waitingFor === 'string' ? obj.waitingFor : undefined
  const updatedAt =
    typeof obj.statusUpdatedAt === 'number'
      ? obj.statusUpdatedAt
      : typeof obj.updatedAt === 'number'
        ? obj.updatedAt
        : undefined
  return { sessionId, status, waitingFor, updatedAt }
}

/**
 * Map a registry `status` to a fleet task-state. `busy` → working · `waiting`
 * (a permission/input prompt) → needs-input · `idle` → idle. Anything else
 * (absent field, unknown value) → `undefined`, i.e. no override — the session
 * keeps whatever its other signals say. Pure, exhaustive.
 */
export function registryStatusToTaskState(status: string | undefined): TaskState | undefined {
  switch (status) {
    case 'busy':
      return 'working'
    case 'waiting':
      return 'needs-input'
    case 'idle':
      return 'idle'
    default:
      return undefined
  }
}

/** The renderer-facing event shape (mirrors the preload interface). */
export interface SessionRegistryWire {
  sessionId: string
  /** Mapped task-state, or `null` to CLEAR the registry override (file removed). */
  taskState: TaskState | null
  waitingFor?: string
  /** Freshness anchor (epoch ms) — the classifier uses it to time `stuck`. */
  updatedAt?: number
}

export interface SessionRegistryWatcherHandle {
  close(): Promise<void>
}

/** Coalesce the rapid add→change bursts a status write produces. */
const REGISTRY_DEBOUNCE_MS = 60

function isRegistryFile(p: string): boolean {
  const base = path.basename(p)
  return base.endsWith('.json') && !base.startsWith('.')
}

/**
 * Start the registry watcher. Returns a handle (with a no-op `close` when the
 * feature is gated off / the dir is absent). `send` is the window `webContents.send`
 * shim; injected so this module stays testable without electron.
 */
export function startSessionRegistryWatcher(
  send: (channel: string, payload: SessionRegistryWire) => void,
  opts: { dir?: string } = {}
): SessionRegistryWatcherHandle {
  const dir = opts.dir ?? sessionsRegistryDir()
  if (!existsSync(dir)) {
    console.info(`[session-registry] ${dir} absent — skipping (older CLI / BG_SESSIONS off)`)
    return { close: async () => {} }
  }

  // pid-file path → sessionId, so an unlink (process exit) can CLEAR the override
  // for the right session even though the filename is the pid, not the uuid.
  const pathToSession = new Map<string, string>()
  const debounce = new Map<string, NodeJS.Timeout>()
  let sawStatus = false

  function emitFor(absPath: string): void {
    void fs
      .readFile(absPath, 'utf8')
      .then((raw) => {
        const entry = parseRegistryEntry(raw)
        if (!entry) return
        pathToSession.set(absPath, entry.sessionId)
        const taskState = registryStatusToTaskState(entry.status)
        if (taskState === undefined) return // no usable status → no override
        if (!sawStatus) {
          sawStatus = true
          console.info('[session-registry] live status present — using registry as a fleet signal')
        }
        send('claude:sessionRegistry', {
          sessionId: entry.sessionId,
          taskState,
          waitingFor: entry.waitingFor,
          updatedAt: entry.updatedAt
        })
      })
      .catch(() => {
        /* file vanished mid-read / unreadable — ignore */
      })
  }

  function schedule(absPath: string): void {
    const prev = debounce.get(absPath)
    if (prev) clearTimeout(prev)
    debounce.set(
      absPath,
      setTimeout(() => {
        debounce.delete(absPath)
        emitFor(absPath)
      }, REGISTRY_DEBOUNCE_MS)
    )
  }

  const watcher: FSWatcher = chokidar.watch(dir, {
    ignoreInitial: false, // seed from the sessions already registered on boot
    persistent: true,
    depth: 0,
    followSymlinks: false,
    ignorePermissionErrors: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
    ignored: (p: string, stats?: { isDirectory(): boolean }) => {
      if (path.resolve(p) === path.resolve(dir)) return false
      if (stats?.isDirectory()) return true
      return !isRegistryFile(p)
    }
  })

  watcher.on('add', schedule)
  watcher.on('change', schedule)
  watcher.on('unlink', (absPath) => {
    const t = debounce.get(absPath)
    if (t) {
      clearTimeout(t)
      debounce.delete(absPath)
    }
    const sessionId = pathToSession.get(absPath)
    pathToSession.delete(absPath)
    // Clear the registry override so the session falls back to its other signals.
    if (sessionId) send('claude:sessionRegistry', { sessionId, taskState: null })
  })
  watcher.on('error', () => {
    /* a watcher error must never crash main — the other overlays still work */
  })

  return {
    async close() {
      for (const t of debounce.values()) clearTimeout(t)
      debounce.clear()
      try {
        await watcher.close()
      } catch {
        /* best effort */
      }
    }
  }
}

/** Register the registry watcher against the main window. Best-effort, fail-open. */
export function registerSessionRegistryWatcher(
  getWindow: () => import('electron').BrowserWindow | null
): SessionRegistryWatcherHandle {
  return startSessionRegistryWatcher((channel, payload) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  })
}
