import { app, ipcMain, type BrowserWindow } from 'electron'
import * as path from 'node:path'
import {
  openSessionArchive,
  setSessionArchive,
  type SessionArchiveStore
} from './session-archive-core'

/**
 * IPC shell for the main-process archive store (T655). The renderer hydrates its archive
 * set from `sessionArchive:get`, writes menu actions through `sessionArchive:set`, sends its
 * old `localStorage` ids once to `sessionArchive:importLegacy`, and listens for
 * `sessionArchive:changed` (the FULL set, so a missed event can never leave it stale).
 * The `archive_session` MCP verb reaches the same store through `getSessionArchive()`.
 */

const FILE_NAME = 'archived-sessions.json'
/** A sane ceiling on one renderer payload: it comes from `localStorage`, never trusted. */
const MAX_IDS_PER_CALL = 50_000

function idsOf(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_IDS_PER_CALL) return null
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

export function registerSessionArchive(getWindow: () => BrowserWindow | null): void {
  const ready: Promise<SessionArchiveStore> = openSessionArchive(
    path.join(app.getPath('userData'), FILE_NAME)
  ).then((store) => {
    setSessionArchive(store)
    store.onChange(() => {
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('sessionArchive:changed', { ids: [...store.ids()] })
      }
    })
    return store
  })

  ipcMain.handle('sessionArchive:get', async () => {
    const store = await ready
    return { ids: [...store.ids()], legacyImported: store.legacyImported() }
  })

  ipcMain.handle('sessionArchive:set', async (_e, payload: unknown) => {
    const p = payload as { sessionIds?: unknown; archived?: unknown } | null
    const sessionIds = idsOf(p?.sessionIds)
    if (!sessionIds || typeof p?.archived !== 'boolean') return { ok: false as const }
    const store = await ready
    if (p.archived) await store.archive(sessionIds)
    else await store.unarchive(sessionIds)
    return { ok: true as const, ids: [...store.ids()] }
  })

  ipcMain.handle('sessionArchive:importLegacy', async (_e, payload: unknown) => {
    const p = payload as { sessionIds?: unknown } | null
    const sessionIds = idsOf(p?.sessionIds)
    if (!sessionIds) return { ok: false as const }
    const store = await ready
    const res = await store.importLegacy(sessionIds)
    return { ok: true as const, imported: res.imported, ids: [...store.ids()] }
  })
}
