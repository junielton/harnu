import { app, ipcMain, type BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import {
  installHooks,
  uninstallHooks,
  pruneHooks,
  removeOwnHooksSync,
  harnuPorts
} from './hook-installer'
import { readClaudeSettings, claudeSettingsPath } from './claude-settings'
import {
  constantTimeEqual,
  hostnameOfAuthority,
  isLoopbackHostname,
  isAllowedOrigin
} from './mcp/http-guard'
import { classifyFailure, type FailureReason } from './hook-state'
import { buildHookSettingsBlobJson } from './hook-settings-blob'
import { getTaskState, ingest, type BridgeEvent as HubBridgeEvent } from './detect/task-state-hub'
import {
  isDispatchable,
  parseHookRequest,
  runResolvers,
  serializeDecision,
  describeDecision,
  type ResponderMode,
  type Resolver
} from './responder-dispatch'
import {
  responderRegistry,
  echoNoopResolver,
  readMode,
  writeMode,
  getMode,
  getShadowLog,
  pushShadowEntry,
  getTrustAll,
  writeTrustAll,
  setInterceptFolders
} from './responder-registry'
import { interceptActivePaths } from './user-projects'
import { registerApprovalResolver, closeApprovals } from './approval-resolver'
import { registerSentinel } from './sentinel-resolver'

// The public surface moved to the hub; re-exported so no importer changes (ARB-5).
export {
  addTaskEventObserver,
  getTaskStates,
  pruneTaskState,
  type HookTaskEvent
} from './detect/task-state-hub'

/** Internal dispatch deadline. STRICTLY < HOOK_TIMEOUT_S*1000 (hook-installer.ts:22 = 5s). */
const RESPONDER_DEADLINE_MS = 3500

/**
 * Hook Bridge (session-state real-state spec §4.1). A loopback HTTP server in
 * main that receives Claude Code's hook POSTs and forwards them to the renderer
 * as `claude:hook` events. It is a PURE OBSERVER: every request is answered
 * `200 {}` with no decision field, so Harnu can never block or alter a session.
 *
 * `startHookServer` is the testable core (unit-tested with real localhost POSTs);
 * `registerHookBridge` is the imperative shell that wires it to the window, the
 * installer, and the opt-out preference.
 */

/**
 * The event as the hook server emits it: no `source` yet. `handleBridgeEvent` stamps
 * `source: 'hook'` and hands it to the task-state hub (T389 P1W4 §7.4).
 */
export type BridgeEvent = Omit<HubBridgeEvent, 'source'> & { source?: HubBridgeEvent['source'] }

interface StartedServer {
  port: number
  close: () => Promise<void>
}

/**
 * Bind an `http` server to an ephemeral loopback port. On every
 * `POST /hook/<token>/<event>/<tag>` it validates the token, derives the
 * semantic matcher (URL tag, else the body's `reason`/`source`), reads
 * `session_id` from the body, fires `onEvent`, and answers `200 {}`.
 */
export function startHookServer(
  onEvent: (ev: BridgeEvent) => void,
  token: string,
  opts: {
    getMode?: () => ResponderMode
    registry?: { list: () => readonly Resolver[] }
    deadlineMs?: number
  } = {}
): Promise<StartedServer> {
  // Defaults preserve pure-observer behavior, so existing call-sites/tests that
  // pass no opts keep answering 200 {} with no decision.
  const getMode = opts.getMode ?? ((): ResponderMode => 'off')
  const registry = opts.registry
  const listResolvers = registry
    ? (): readonly Resolver[] => registry.list() // keep `this` bound to the registry
    : (): readonly Resolver[] => []
  const deadlineMs = opts.deadlineMs ?? RESPONDER_DEADLINE_MS
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const respond = (code: number, body = '{}'): void => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(body)
      }
      const parts = (req.url ?? '').split('/').filter(Boolean) // ['hook', token, event, tag]
      if (req.method !== 'POST' || parts[0] !== 'hook') return respond(404)
      // http-guard parity (lesson 004): DNS-rebind guard on Host + Origin, and a
      // constant-time token compare (no early-exit timing side-channel). The
      // token is a per-boot 122-bit randomUUID in the path, so this is
      // defense-in-depth over an already-ephemeral loopback secret.
      const host = typeof req.headers.host === 'string' ? req.headers.host : undefined
      if (host === undefined || !isLoopbackHostname(hostnameOfAuthority(host))) return respond(403)
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
      if (origin !== undefined && !isAllowedOrigin(origin)) return respond(403)
      if (!constantTimeEqual(parts[1] ?? '', token)) return respond(403)

      const event = parts[2] ?? ''
      const tag = parts[3] ?? '_'
      let raw = ''
      req.on('data', (c) => {
        raw += c
        if (raw.length > 1 << 20) req.destroy()
      })
      req.on('end', async () => {
        let body: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(raw || '{}')
          if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>
        } catch {
          body = {}
        }

        const sessionId = String(body.session_id ?? body.sessionId ?? '')
        let matcher: string | undefined = tag && tag !== '_' ? tag : undefined
        if (!matcher) {
          if (event === 'SessionEnd' && typeof body.reason === 'string') matcher = body.reason
          else if (event === 'SessionStart' && typeof body.source === 'string')
            matcher = body.source
        }
        // StopFailure carries WHY it stopped — classify it (and its reset) for the
        // badge. Cheap + scoped to StopFailure so other events pay nothing.
        let failureReason: FailureReason | undefined
        let resetsAt: number | undefined // epoch-ms
        if (event === 'StopFailure') {
          failureReason = classifyFailure(body.error_type)
          const r = body.resets_at
          if (typeof r === 'number') resetsAt = r
          else if (typeof r === 'string') {
            const t = Date.parse(r)
            if (Number.isFinite(t)) resetsAt = t
          }
        }
        // `agent_id` marks a subagent's own tool call; the main thread never sends one.
        const agentId =
          typeof body.agent_id === 'string' && body.agent_id !== '' ? body.agent_id : undefined
        if (sessionId && event)
          onEvent({
            sessionId,
            event,
            matcher,
            ts: Date.now(),
            failureReason,
            resetsAt,
            ...(agentId !== undefined ? { agentId } : {})
          })

        // ---- Dispatch branch (responder spec §4.3) — fail-open in EVERYTHING ----
        // The observation above is byte-for-byte unchanged; this only runs for a
        // dispatchable event when the responder is on, and always answers within
        // the internal deadline (< the CC hook timeout) so a request never orphans.
        const mode = getMode()
        if (mode === 'off' || !sessionId || !isDispatchable(event, matcher))
          return respond(200, '{}') // observer / non-dispatchable / no session id → fast path

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), deadlineMs)
        try {
          const reqObj = parseHookRequest(event, matcher, body, sessionId)
          const decision = await runResolvers(
            reqObj,
            listResolvers(),
            controller.signal,
            (by, err) => console.error(`[responder] resolver ${by} threw`, err)
          )
          if (mode === 'shadow') {
            if (decision) {
              const summary = describeDecision(event, decision)
              console.info(`[responder] shadow: would ${summary} for ${sessionId}`)
              pushShadowEntry({ sessionId, event, by: decision.by, summary, ts: Date.now() })
            }
            return respond(200, '{}') // shadow NEVER decides
          }
          return respond(200, serializeDecision(event, decision)) // active
        } catch (err) {
          console.error('[responder] dispatch failed (fail-open):', err)
          return respond(200, '{}') // fail-open universal
        } finally {
          clearTimeout(timer)
        }
      })
      req.on('error', () => respond(400))
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) })
    })
  })
}

// ---- Imperative shell: wiring to the window, installer, and opt-out pref ----

let serverClose: (() => Promise<void>) | null = null
let currentPort = 0
let currentToken = ''
function prefsPath(): string {
  return join(app.getPath('userData'), 'hook-prefs.json')
}

/**
 * Persisted hook opt-outs (both default ON):
 *  - `enabled` — the GLOBAL observer install into `~/.claude/settings.json`.
 *  - `injectPerSession` — the T92 per-session `--settings` injection (independent:
 *    a user can keep injection ON while opting out of touching settings.json, or
 *    vice-versa). Read-modify-write preserves the other key on every toggle.
 */
interface HookPrefs {
  enabled?: boolean
  injectPerSession?: boolean
}

async function readPrefs(): Promise<HookPrefs> {
  try {
    const p = JSON.parse(await readFile(prefsPath(), 'utf8'))
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as HookPrefs) : {}
  } catch {
    return {} // no file → first run → every opt-out defaults ON
  }
}

async function writePrefs(patch: HookPrefs): Promise<void> {
  const cur = await readPrefs()
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(prefsPath(), JSON.stringify({ ...cur, ...patch }, null, 2) + '\n', 'utf8')
}

/** Opt-out model: hooks are ON unless the user explicitly disabled them. */
async function readEnabled(): Promise<boolean> {
  return (await readPrefs()).enabled !== false
}

async function writeEnabled(enabled: boolean): Promise<void> {
  await writePrefs({ enabled })
}

/** Opt-out model for the T92 per-session `--settings` injection (default ON). */
async function readInjectEnabled(): Promise<boolean> {
  return (await readPrefs()).injectPerSession !== false
}

async function writeInjectEnabled(enabled: boolean): Promise<void> {
  injectEnabledCache = enabled // update the sync mirror first, then persist
  await writePrefs({ injectPerSession: enabled })
}

/**
 * In-memory mirror of the injection opt-out, so the argv-build step (`pty.ts`)
 * can read it synchronously via {@link hookSettingsBlobJson} without awaiting I/O
 * on the spawn hot path. Hydrated on register; updated on toggle. Defaults ON.
 */
let injectEnabledCache = true

/**
 * The per-session hook `--settings` blob JSON pointing at THIS bridge, or `null`
 * when injection is opted out or the bridge isn't listening yet. Sync (reads the
 * cached opt-out + the live port/token) so it can be a spawn-time provider. The
 * blob carries the bridge token — never log the return value.
 */
export function hookSettingsBlobJson(): string | null {
  if (!injectEnabledCache || !currentPort || !currentToken) return null
  return buildHookSettingsBlobJson(currentPort, currentToken)
}

/** True if something is accepting TCP connections on a loopback port. */
function probePort(port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port })
    const finish = (alive: boolean): void => {
      sock.destroy()
      resolve(alive)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

/**
 * Reconcile the global hooks on boot (and on enable): probe every PEER Harnu
 * port and prune the DEAD ones — stale entries from crashed/killed instances
 * stop causing `ECONNREFUSED` in later Claude Code sessions — while keeping LIVE
 * peers (a second instance must not clobber a running one). Install our fresh
 * entry when enabled, else just prune. Best-effort: an unwritable settings.json
 * degrades to the watcher heuristic (spec §5), never fatal.
 */
async function reconcileBootHooks(enabled: boolean): Promise<void> {
  let deadPorts = new Set<number>()
  try {
    const settings = await readClaudeSettings(claudeSettingsPath())
    const peers = harnuPorts(settings).filter((p) => p !== currentPort)
    const probes = await Promise.all(peers.map(async (p) => [p, await probePort(p)] as const))
    deadPorts = new Set(probes.filter(([, alive]) => !alive).map(([p]) => p))
  } catch {
    /* probe failure → empty deadPorts → no peer pruning this boot */
  }
  if (enabled) await installHooks(currentPort, currentToken, { deadPorts })
  else await pruneHooks({ ourToken: currentToken, deadPorts })
}

/**
 * Remove our own hooks on process exit so a clean quit / SIGTERM never leaves a
 * stale entry POSTing to a dead port. The removal is synchronous (exit handlers
 * can't await I/O) and token-scoped (a live peer's hooks are preserved). SIGKILL
 * can't be caught — the next boot's `reconcileBootHooks` prunes that orphan.
 */
let exitCleanupArmed = false
function registerExitCleanup(): void {
  if (exitCleanupArmed) return
  exitCleanupArmed = true
  process.once('exit', () => removeOwnHooksSync(currentToken))
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      removeOwnHooksSync(currentToken) // sync first — gone even if the quit hangs
      app.quit()
    })
  }
}

/**
 * A raw hook POST enters the task-state hub stamped `source: 'hook'`. The fold, the T178 row #8
 * `isHibernated` guard and the fan-out live in `detect/task-state-hub.ts` (T389 P1W4); this stays
 * exported so `registerHookBridge`'s wiring is unit-testable without the HTTP server or a
 * `BrowserWindow`, and so every importer keeps its import.
 */
export function handleBridgeEvent(ev: BridgeEvent, getWindow: () => BrowserWindow | null): void {
  ingest({ ...ev, source: 'hook' }, getWindow)
}

export async function registerHookBridge(getWindow: () => BrowserWindow | null): Promise<void> {
  currentToken = randomUUID()
  // Register the zero-risk demo resolver + load the persisted mode before the
  // server starts. v1 ships only the noop resolver (always abstains), so the
  // dispatch branch is provable end-to-end with no observable effect.
  responderRegistry.register(echoNoopResolver)
  registerSentinel(getWindow) // T31: auto-deny catastrophic calls BEFORE the inbox (prio 20)
  registerApprovalResolver({ getWindow }) // Approval Inbox parking resolver + its IPC
  await readMode() // hydrate the registry's in-memory mode + trustAll (source of truth)
  // T30: hydrate the per-folder intercept ramp from projects.json (interceptActive).
  setInterceptFolders(await interceptActivePaths())
  const started = await startHookServer((ev) => handleBridgeEvent(ev, getWindow), currentToken, {
    getMode,
    registry: responderRegistry
  })
  serverClose = started.close
  currentPort = started.port
  // Hydrate the per-session-injection opt-out cache now the port/token are live,
  // so the very first `claude` spawn can read it synchronously (default ON).
  injectEnabledCache = await readInjectEnabled()

  // Reconcile observer hooks on boot: prune dead peers + (un)install ours per the
  // opt-out pref. Self-healing — clears stale ECONNREFUSED-causing orphans.
  try {
    await reconcileBootHooks(await readEnabled())
  } catch (err) {
    console.error('[hook-bridge] reconcile failed (degrading to heuristic):', err)
  }
  registerExitCleanup()

  ipcMain.handle('hooks:status', async () => ({
    enabled: await readEnabled(),
    injectPerSession: await readInjectEnabled(),
    port: currentPort
  }))
  // T92 opt-out for the per-session `--settings` injection (independent of the
  // global install toggle). Updates the sync cache so the next spawn honors it.
  ipcMain.handle('hooks:setInjectEnabled', async (_e, enabled: boolean) => {
    await writeInjectEnabled(enabled === true)
    return { injectPerSession: injectEnabledCache }
  })
  // Half (a) migration resync (T13): let the renderer pull main's current folded
  // state for a uuid, so a synthetic→real migrated row reflects the hooks that
  // fired while it was still keyed synthetic-<uuid> (and thus dropped by onHook).
  ipcMain.handle('hooks:stateFor', (_e, sessionId: string) => getTaskState(sessionId) ?? null)
  ipcMain.handle('hooks:setEnabled', async (_e, enabled: boolean) => {
    await writeEnabled(enabled)
    try {
      if (enabled) await reconcileBootHooks(true)
      else await uninstallHooks({ token: currentToken })
    } catch (err) {
      console.error('[hook-bridge] toggle failed:', err)
    }
    return { enabled }
  })

  // ---- Hook responder dispatch (hook-responder-dispatch spec §4.6) ----
  // The interceptor mode (off/shadow/active). `hooksEnabled` rides along because
  // the responder is inert when the hooks themselves are off (§3.5/§9).
  ipcMain.handle('responder:status', async () => ({
    mode: getMode(),
    trustAll: getTrustAll(), // T30: fleet-active escape hatch (additive)
    hooksEnabled: await readEnabled()
  }))
  ipcMain.handle('responder:setMode', async (_e, mode: ResponderMode) => {
    await writeMode(mode)
    return { mode }
  })
  // T30: the "Trust all folders" master switch (fleet-active escape hatch).
  ipcMain.handle('responder:setTrustAll', async (_e, enabled: boolean) => {
    await writeTrustAll(enabled === true)
    return { trustAll: getTrustAll() }
  })
  ipcMain.handle('responder:getShadowLog', () => getShadowLog())
}

/**
 * Close the bridge server on quit and remove OUR hook entry (token-scoped, sync)
 * so we don't leave a dead-port entry behind — those surface as `UserPromptSubmit
 * hook error / ECONNREFUSED` in every Claude Code session while Harnu is down.
 * Live peers' hooks are preserved; the next boot reinstalls ours with a fresh
 * port. (The `process.exit`/SIGTERM handlers in `registerExitCleanup` cover the
 * paths that bypass `before-quit`.)
 */
export async function closeHookBridge(): Promise<void> {
  closeApprovals() // settle any parked approvals (fail-open) + unregister
  responderRegistry.unregister('noop') // idempotent — never touches settings.json
  if (currentToken) removeOwnHooksSync(currentToken)
  if (serverClose) {
    const c = serverClose
    serverClose = null
    await c()
  }
}
