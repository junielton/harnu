import { ipcMain } from 'electron'
import { listNotes, openNote } from './notes-core'

/**
 * Quick notes IPC. The handlers only validate the payload shape; confinement to the
 * known folders, symlink refusal and the day-file logic live in `notes-core.ts`.
 * `notes:open` without a `date` means "today" — the date is computed in main.
 */
export function registerNotesHandlers(): void {
  ipcMain.handle('notes:list', (_e, args: { folder?: unknown } | undefined) => {
    const folder = args?.folder
    if (typeof folder !== 'string') return { ok: false, code: 'invalid-args' } as const
    return listNotes(folder)
  })
  ipcMain.handle('notes:open', (_e, args: { folder?: unknown; date?: unknown } | undefined) => {
    const { folder, date } = args ?? {}
    if (typeof folder !== 'string' || (date !== undefined && typeof date !== 'string')) {
      return { ok: false, code: 'invalid-args' } as const
    }
    return openNote(folder, date)
  })
}
