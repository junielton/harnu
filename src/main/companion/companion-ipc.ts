/**
 * IPC of the companion host (T389 P1W1 §7.8): `companion:diagnostics`, plus the dev-only
 * `companion:devMintSpawn` that exists so the live-verify recipes and the L4 harness can exercise
 * the real server before `pty.ts` mints spawn tokens.
 *
 * Diagnostics carries no endpoint token, spawn token, `conn`, socket path or port (SEC-8).
 */

import { randomUUID } from 'node:crypto'
import { app, ipcMain, shell } from 'electron'
import { markDisclosureShown, setCompanionEnabled, setRampFolders } from './companion-prefs'
import type { ExternalPaneState, ExternalSetResult } from './external-host'
import type { CompanionHostFacade } from './host-core'
import type { IdentityClaim, IdentityOutcome } from './identity-core'
import type { CompanionStatus } from './companion-status'
import { parityReport, type ParityReport, type ParityStream } from './parity-core'
import { parityLedger } from './parity-ledger'
import { enqueue, type EnqueueResult } from './command-channel'
import { COMMAND_NAMES, UI_TEXTS, type UiTextId } from './command-gate-core'
import type { CommandOutcome, EnqueueRefusal } from './command-types'
import type { CommandName } from './contract'

export interface CompanionIpcExtras {
  /** The renderer pulls the claim list at store init, so a window reload loses nothing (P1W3). */
  identityClaims(): IdentityClaim[]
  /** The renderer's report after a migration (`fireMigrate`): parity evidence only. */
  identityOutcome(o: IdentityOutcome): void
  /** Developer aid (LV-P1W3-g): stops and starts the listener. */
  restartListener(): Promise<void>
  /** P1W4: the Harnu mod status the settings block, the hover preview and the monitor read. */
  status(): CompanionStatus
  /** P1W4: the directory the sessions load the mod from, staged on demand (the reveal button). */
  stagedDir(): Promise<string | null>
  /** P2W1: `HARNU_COMPANION_DEBUG=1`, read once by `host.ts`; registers `companion:debug:enqueue`. */
  debug?: boolean
  /** P4W3: the "Harnu mod outside Harnu" switch, its path line and the last outside session seen. */
  externalGet(): Promise<ExternalPaneState>
  /** P4W3: turns it on (the settings write, after the renderer's confirm) or off (the exact undo). */
  externalSet(on: boolean): Promise<ExternalSetResult>
}

/** What `companion:diagnostics:ping` answers (P2W1 §7.6). */
export interface PingResult {
  ok: boolean
  roundTripMs: number
  refusal?: EnqueueRefusal | 'AUDIT_FAILED'
  outcomes: CommandOutcome[]
}

export const PING_WAIT_MS = 5_000
/** A compaction answers after 14 to 37 s on an idle session (smoke C2); the route waits this long. */
export const DEBUG_WAIT_MAX_MS = 150_000

const timeoutAfter = (ms: number): Promise<null> =>
  new Promise((resolve) => setTimeout(() => resolve(null), ms).unref?.())

/**
 * "Test Harnu mod channel": a `flush` and a `ui.toast` to one session, the round trip measured to
 * the `flush` result. The cause is built here, inside an `ipcMain` handler, and nowhere else.
 */
export async function pingSession(
  sessionKey: unknown,
  send: typeof enqueue = enqueue,
  now: () => number = Date.now
): Promise<PingResult> {
  if (typeof sessionKey !== 'string' || sessionKey === '') {
    return { ok: false, roundTripMs: 0, refusal: 'NO_BINDING', outcomes: [] }
  }
  const cause = { kind: 'operator', gesture: 'diagnostics.ping' } as const
  const started = now()
  const flush = send({ sessionKey, name: 'flush', args: {}, cause })
  if (!flush.ok) return { ok: false, roundTripMs: 0, refusal: flush.reason, outcomes: [] }
  const toast = send({
    sessionKey,
    name: 'ui.toast',
    args: { text: UI_TEXTS['channel-ok'] },
    cause
  })
  const flushDone = flush.settled.then((o) => ({ o, at: now() }))
  const both = Promise.all([flushDone, toast.ok ? toast.settled : Promise.resolve(null)])
  const got = await Promise.race([both, timeoutAfter(PING_WAIT_MS)])
  if (got === null) return { ok: false, roundTripMs: 0, outcomes: [] }
  const [first, second] = got
  const outcomes = [first.o, ...(second ? [second] : [])]
  const good = (o: CommandOutcome | null): boolean => o?.state === 'resulted' && o.ok
  return {
    ok: good(first.o) && good(second),
    roundTripMs: Math.max(0, first.at - started),
    ...(toast.ok ? {} : { refusal: toast.reason }),
    outcomes
  }
}

export interface DebugEnqueueRequest {
  sessionKey?: unknown
  name?: unknown
  args?: unknown
  textId?: unknown
  waitMs?: unknown
}

export interface DebugEnqueueResult {
  ok: boolean
  reason?: EnqueueRefusal | 'AUDIT_FAILED' | 'BAD_REQUEST'
  cmd?: string
  n?: number
  /** Null when the wait ran out before the command settled. */
  outcome?: CommandOutcome | null
}

/** The dev route's body, exported so a test can call it without Electron (SEC-5: same gate). */
export async function debugEnqueue(
  req: DebugEnqueueRequest,
  send: (r: {
    sessionKey: string
    name: CommandName
    args: never
    cause: { kind: 'operator'; gesture: 'debug' }
  }) => EnqueueResult = enqueue as never
): Promise<DebugEnqueueResult> {
  if (typeof req?.sessionKey !== 'string' || req.sessionKey === '') {
    return { ok: false, reason: 'BAD_REQUEST' }
  }
  if (typeof req.name !== 'string' || !(COMMAND_NAMES as readonly string[]).includes(req.name)) {
    return { ok: false, reason: 'BAD_REQUEST' }
  }
  // Text never travels: a text id names a line of the constant table.
  let args: unknown = req.args ?? {}
  if (req.textId !== undefined) {
    if (typeof req.textId !== 'string' || !(req.textId in UI_TEXTS)) {
      return { ok: false, reason: 'BAD_REQUEST' }
    }
    args = { text: UI_TEXTS[req.textId as UiTextId] }
  }
  const out = send({
    sessionKey: req.sessionKey,
    name: req.name as CommandName,
    args: args as never,
    cause: { kind: 'operator', gesture: 'debug' }
  })
  if (!out.ok) return { ok: false, reason: out.reason }
  const wait = Math.min(
    DEBUG_WAIT_MAX_MS,
    typeof req.waitMs === 'number' && req.waitMs > 0 ? req.waitMs : PING_WAIT_MS
  )
  const outcome = await Promise.race([out.settled, timeoutAfter(wait)])
  return { ok: true, cmd: out.cmd, n: out.n, outcome }
}

/** The streams `companionParityReport` answers for: a fact family, or a feature key. */
export const PARITY_STREAMS: readonly ParityStream[] = [
  'identity',
  'taskState',
  'telemetry',
  'planUsage',
  'approval',
  'guard',
  'startPrompt',
  'message',
  'channel',
  'stamp',
  'sentinel',
  'external'
]

export function registerCompanionIpc(
  host: Pick<CompanionHostFacade, 'diagnostics' | 'mintSpawnToken'>,
  extras: CompanionIpcExtras
): void {
  ipcMain.handle('companion:diagnostics', () => host.diagnostics())
  ipcMain.handle('companion:identityClaims', () => ({ claims: extras.identityClaims() }))
  // P1W4: the kill switch, the one-time disclosure and the per-folder ramp. Renderer IPC only: no
  // MCP verb reaches any of them (SEC-9).
  ipcMain.handle('companion:setEnabled', async (_e, on: unknown) => {
    await setCompanionEnabled(on === true)
    return { enabled: on === true }
  })
  ipcMain.handle('companion:disclosureShown', async () => {
    await markDisclosureShown()
  })
  ipcMain.handle('companion:setFolderActive', async (_e, path: unknown, on: unknown) => {
    if (typeof path !== 'string' || path === '') return { ok: false }
    // Lazy for the same reason as in `host.ts`: `user-projects` pulls the git probe in.
    const projects = await import('../user-projects')
    await projects.setCompanionActive(path, on === true)
    setRampFolders(await projects.companionActivePaths())
    return { ok: true }
  })
  ipcMain.handle('companion:status', () => extras.status())
  ipcMain.handle('companion:diagnostics:ping', (_e, sessionKey: unknown) => pingSession(sessionKey))
  // Developer aid for the live-verify recipes: registered only when Harnu main started with
  // `HARNU_COMPANION_DEBUG=1`. It admits the `debug` gesture of the origin gate, nothing more.
  if (extras.debug === true) {
    ipcMain.handle('companion:debug:enqueue', (_e, req: DebugEnqueueRequest) => debugEnqueue(req))
  }
  // P4W3: renderer IPC only; no MCP verb reaches the switch (SEC-9). The renderer shows the
  // disclosure before it calls `externalSet(true)`; main refuses anything but a boolean.
  ipcMain.handle('companion:externalGet', () => extras.externalGet())
  ipcMain.handle('companion:externalSet', (_e, on: unknown) =>
    typeof on === 'boolean'
      ? extras.externalSet(on)
      : ({ ok: false, reason: 'failed' } satisfies ExternalSetResult)
  )
  ipcMain.handle('companion:reveal', async () => {
    const dir = await extras.stagedDir()
    if (dir) shell.showItemInFolder(dir)
    return { ok: dir !== null }
  })
  ipcMain.handle('companion:parityReport', (_e, stream: unknown): ParityReport | null => {
    if (typeof stream !== 'string' || !PARITY_STREAMS.includes(stream as ParityStream)) return null
    return parityReport(stream as ParityStream, parityLedger()?.read(stream as ParityStream) ?? [])
  })
  ipcMain.on('companion:identityOutcome', (_e, o: unknown) => {
    const r = o as Partial<IdentityOutcome> | null
    if (!r || typeof r.fromKey !== 'string' || typeof r.sid !== 'string') return
    if (
      !['companion', 'agent-correlation', 'collapse', 'resolved-window'].includes(String(r.via))
    ) {
      return
    }
    extras.identityOutcome({ fromKey: r.fromKey, sid: r.sid, via: r.via as IdentityOutcome['via'] })
  })

  // The dev mint hands a spawn token to the renderer, so it is registered only in an unpackaged
  // run. A packaged build has no handler at all: the preload call rejects.
  if (!app.isPackaged) {
    // Not the kill switch: that revokes `conn`s and leaves the listener up (contract §3 item 9).
    ipcMain.handle('companion:devRestartListener', () => extras.restartListener())
    ipcMain.handle('companion:devMintSpawn', () => {
      const runId = randomUUID()
      const spawnToken = host.mintSpawnToken({
        owner: { kind: 'tick', workerId: 'dev', runId },
        trust: 'tick',
        cwd: app.getPath('temp')
      })
      return spawnToken === null ? null : { spawnToken, runId }
    })
  }
}
