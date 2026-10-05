import { ipcMain, type BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import chokidar, { type FSWatcher } from 'chokidar'
import type { TaskState } from '../hook-state'
import {
  reduceDetect,
  INITIAL_DETECT_STATE,
  type DetectExplain,
  type DetectState,
  type ScreenSnapshot
} from './detect-orchestrate-core'
import { buildRegistry } from './manifest-registry'
import type { RawManifest } from './manifest-load-core'
import type { CompiledManifest } from './screen-detect-core'
import { sanitizeShellSessions, type ShellSessionInfo } from './shell-session-core'

/**
 * Screen-detection IPC shell (A2 two-tier state detection — T7/T8/T9/T12 thin
 * half).
 *
 * The imperative casing around the pure orchestrator (`detect-orchestrate-core`)
 * + registry (`manifest-registry`). It owns everything env-bound — the
 * per-session {@link DetectState} map, the compiled registry + its chokidar
 * hot-reload, the resolved-state map the MCP fleet reads, and the window send —
 * and nothing the pure cores can't be tested without (ADR-0001). Mirrors the
 * registrar shape of `settings.ts` / `hook-bridge.ts`.
 *
 * Flow: the renderer emits `pane:screen-snapshot { sessionId, lines, title }`
 * for screen-mode panes ONLY (folder terminals — it gates on `isShellTerminal`,
 * so a hooked Claude pane is never scraped). We fold each snapshot through
 * `reduceDetect` and, when the resolved dot actually changes, push
 * `screen:state { sessionId, taskState }` back (`taskState: null` reverts to the
 * legacy activity heuristic) AND retain it in {@link getScreenStates} so the MCP
 * fleet sees cross-agent state. `pane:screen-detach` drops a closed pane's memory.
 *
 * Hot-reload (T9): `~/.claude/detectors/<agent>.json` overrides are watched +
 * recompiled live (chokidar + 100ms debounce, mirroring `settings.ts`) so a user
 * can tune a manifest without a restart. The `explain` trace (T12) is logged on
 * every state change to make that tuning observable.
 */

/** Per-session detector memory. Keyed by the renderer's `sessionId`. */
const states = new Map<string, DetectState>()

/**
 * The last resolved screen-derived `TaskState` per session — the MAIN-side
 * authority the MCP fleet snapshot merges (so `wait --status` is cross-agent).
 * Keyed by `sessionId`; an entry is deleted when the state reverts (`null`) or
 * the pane detaches. Disjoint from the hook FSM's `taskStates` by id space
 * (`shellterm-*` vs a Claude uuid), so a merge never collides.
 */
const screenStates = new Map<string, TaskState>()

/**
 * Read-only view of the screen-derived states for the MCP fleet snapshot
 * (`mcp/server.ts` `taskStateRecord`). Mirrors `hook-bridge.getTaskStates()`.
 */
export function getScreenStates(): ReadonlyMap<string, TaskState> {
  return screenStates
}

/**
 * Live folder terminals the renderer has reported (A2 W6.2). Replaced wholesale
 * on each `fleet:shell-sessions` report. The MCP fleet snapshot folds these in as
 * sessions so a non-Claude pane (codex/aider) shows up cross-agent with its
 * screen-derived `taskState` (from {@link getScreenStates}).
 */
let shellSessions: readonly ShellSessionInfo[] = []

/** Read-only view of the reported folder terminals for the MCP fleet snapshot. */
export function getShellSessions(): readonly ShellSessionInfo[] {
  return shellSessions
}

/** Compiled registry (builtins + hot-reloaded overrides). Rebuilt on reload. */
let manifests: readonly CompiledManifest[] = []

/** chokidar watch on the overrides dir + its debounce (mirrors `settings.ts`). */
let watcher: FSWatcher | null = null
const RELOAD_DEBOUNCE_MS = 100
let reloadTimer: NodeJS.Timeout | null = null

interface SnapshotMessage {
  sessionId: string
  lines: string[]
  title: string | null
}

/** Outbound wire: the resolved screen-derived dot, or `null` to revert it. */
export interface ScreenStateMessage {
  sessionId: string
  taskState: TaskState | null
}

/** `~/.claude/detectors` — where users drop `<agent>.json` manifest overrides. */
function detectorsDir(): string {
  return join(homedir(), '.claude', 'detectors')
}

/**
 * Read every `<agent>.json` override from the detectors dir into a raw map keyed
 * by agent id (the JSON's `agent`, else the filename stem). Best-effort: an
 * unreadable / non-JSON file is skipped, never fatal. Pure I/O — the merge +
 * compile is `buildRegistry`.
 */
async function loadOverrides(dir: string): Promise<Map<string, RawManifest>> {
  const out = new Map<string, RawManifest>()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return out // dir absent → no overrides
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = JSON.parse(await readFile(join(dir, name), 'utf8')) as RawManifest
      if (raw && typeof raw === 'object') {
        const agent = typeof raw.agent === 'string' && raw.agent ? raw.agent : name.slice(0, -5)
        out.set(agent, { ...raw, agent })
      }
    } catch {
      /* skip a malformed override file — the rest still load */
    }
  }
  return out
}

/** Recompile the registry from builtins + the current overrides on disk. */
async function reloadRegistry(getWindow: () => BrowserWindow | null): Promise<void> {
  const overrides = await loadOverrides(detectorsDir())
  manifests = buildRegistry(overrides)
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('detectors:changed')
}

/** Log the `explain` trace on a state change so manifest tuning is observable (T12). */
function logExplain(sessionId: string, taskState: TaskState | null, explain?: DetectExplain): void {
  if (!explain) return
  const where = explain.match
    ? `rule#${explain.match.ruleIndex} /${explain.match.pattern}/ ⇐ "${explain.match.line}"`
    : 'fallback'
  console.info(
    `[detect] ${explain.agent} ${sessionId} → ${taskState ?? 'cleared'} (${explain.screen}: ${where})`
  )
}

/**
 * @param resolveProcess - resolves a session's pty foreground process name (A2
 *   `match.process`, W6.1). Injected (from `pty.foregroundProcessForSession`) so
 *   the detect shell stays decoupled from the pty module; defaults to `null`.
 */
export function registerScreenDetect(
  getWindow: () => BrowserWindow | null,
  resolveProcess: (sessionKey: string) => string | null = () => null
): void {
  // Compile builtins synchronously so detection works immediately; then fold in
  // any on-disk overrides + start watching for live edits (best-effort).
  manifests = buildRegistry()
  void (async () => {
    const dir = detectorsDir()
    try {
      await mkdir(dir, { recursive: true })
    } catch {
      /* can't create the dir — overrides just won't be available */
    }
    await reloadRegistry(getWindow)
    watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 }
    })
    const onChange = (): void => {
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => {
        reloadTimer = null
        void reloadRegistry(getWindow)
      }, RELOAD_DEBOUNCE_MS)
    }
    watcher.on('add', onChange).on('change', onChange).on('unlink', onChange)
  })().catch((err) => console.error('[detect] override watch setup failed:', err))

  ipcMain.on('pane:screen-snapshot', (_e, msg: SnapshotMessage) => {
    if (!msg || typeof msg.sessionId !== 'string' || !Array.isArray(msg.lines)) return
    const snapshot: ScreenSnapshot = {
      lines: msg.lines,
      title: typeof msg.title === 'string' ? msg.title : null,
      process: resolveProcess(msg.sessionId)
    }
    const prev = states.get(msg.sessionId) ?? INITIAL_DETECT_STATE
    const { state, emit, explain } = reduceDetect(prev, snapshot, manifests, Date.now())
    states.set(msg.sessionId, state)
    if (emit === undefined) return // no change worth sending
    // Retain the main-side authority for the MCP fleet (null clears it).
    if (emit === null) screenStates.delete(msg.sessionId)
    else screenStates.set(msg.sessionId, emit)
    logExplain(msg.sessionId, emit, explain)
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('screen:state', {
        sessionId: msg.sessionId,
        taskState: emit
      } satisfies ScreenStateMessage)
    }
  })

  // A pane closed: drop its detector memory so the map can't grow unbounded and
  // a reused session id never inherits a stale blocked state.
  ipcMain.on('pane:screen-detach', (_e, msg: { sessionId?: unknown }) => {
    if (msg && typeof msg.sessionId === 'string') {
      states.delete(msg.sessionId)
      screenStates.delete(msg.sessionId)
    }
  })

  // The renderer reports its live folder terminals (A2 W6.2) so the MCP fleet can
  // disclose them cross-agent. Untrusted input → sanitized; whole-set replace.
  ipcMain.on('fleet:shell-sessions', (_e, list: unknown) => {
    shellSessions = sanitizeShellSessions(list)
  })
}

/** Drop all detector memory + close the override watcher on quit/teardown. */
export function closeScreenDetect(): void {
  if (reloadTimer) {
    clearTimeout(reloadTimer)
    reloadTimer = null
  }
  states.clear()
  screenStates.clear()
  shellSessions = []
  if (watcher) {
    const w = watcher
    watcher = null
    void w.close().catch(() => {})
  }
}
