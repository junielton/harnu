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

export function registerCompanionIpc(
  host: Pick<CompanionHostFacade, 'diagnostics' | 'mintSpawnToken'>
): void {
  ipcMain.handle('companion:diagnostics', () => host.diagnostics())

  // The dev mint hands a spawn token to the renderer, so it is registered only in an unpackaged
  // run. A packaged build has no handler at all: the preload call rejects.
  if (!app.isPackaged) {
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
