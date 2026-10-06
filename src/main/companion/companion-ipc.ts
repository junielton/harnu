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
import type { CompanionHostFacade } from './host-core'
import type { IdentityClaim, IdentityOutcome } from './identity-core'
import type { CompanionStatus } from './companion-status'
import { parityReport, type ParityReport, type ParityStream } from './parity-core'
import { parityLedger } from './parity-ledger'

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
