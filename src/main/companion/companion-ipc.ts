/**
 * IPC of the companion host (T389 P1W1 §7.8): `companion:diagnostics`, plus the dev-only
 * `companion:devMintSpawn` that exists so the live-verify recipes and the L4 harness can exercise
 * the real server before `pty.ts` mints spawn tokens.
 *
 * Diagnostics carries no endpoint token, spawn token, `conn`, socket path or port (SEC-8).
 */

import { randomUUID } from 'node:crypto'
import { app, ipcMain } from 'electron'
import type { CompanionHostFacade } from './host-core'
import type { IdentityClaim, IdentityOutcome } from './identity-core'

export interface CompanionIpcExtras {
  /** The renderer pulls the claim list at store init, so a window reload loses nothing (P1W3). */
  identityClaims(): IdentityClaim[]
  /** The renderer's report after a migration (`fireMigrate`): parity evidence only. */
  identityOutcome(o: IdentityOutcome): void
  /** Developer aid (LV-P1W3-g): stops and starts the listener. */
  restartListener(): Promise<void>
}

export function registerCompanionIpc(
  host: Pick<CompanionHostFacade, 'diagnostics' | 'mintSpawnToken'>,
  extras: CompanionIpcExtras
): void {
  ipcMain.handle('companion:diagnostics', () => host.diagnostics())
  ipcMain.handle('companion:identityClaims', () => ({ claims: extras.identityClaims() }))
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
