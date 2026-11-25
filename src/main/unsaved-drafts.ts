import { ipcMain } from 'electron'

/**
 * The renderer's list of markdown panes with unsaved edits, as human labels
 * (`2026-11-24.md (repo)`), pushed on every change. Main only holds it so the quit
 * guard can name what a quit would lose; the renderer owns the truth.
 */
const MAX_LABELS = 100
const MAX_LABEL_LENGTH = 200

let unsaved: string[] = []

/** Sanitize an untrusted payload: strings only, ≤ 100 of them, each ≤ 200 chars. */
function sanitize(payload: unknown): string[] {
  if (!Array.isArray(payload)) return []
  return payload
    .filter((x): x is string => typeof x === 'string')
    .slice(0, MAX_LABELS)
    .map((s) => s.trim().slice(0, MAX_LABEL_LENGTH))
}

/** Test seam: replace the held list from a raw (untrusted) payload. */
export function setUnsavedFiles(payload: unknown): void {
  unsaved = sanitize(payload)
}

export function getUnsavedFiles(): string[] {
  return [...unsaved]
}

/**
 * Forget the held list. A reloaded or crashed renderer starts with an empty registry and
 * pushes nothing until something changes, so without this the quit dialog could name files
 * that no longer exist (and a dead renderer would leave a quit that asks about nothing).
 */
export function clearUnsavedFiles(): void {
  unsaved = []
}

/** The slice of `WebContents` {@link watchRendererReset} listens on. */
interface RendererEvents {
  on(event: 'render-process-gone', listener: () => void): unknown
  on(
    event: 'did-start-navigation',
    listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void
  ): unknown
}

/**
 * Drop the held list whenever the window's renderer dies or starts loading a new document.
 * `did-start-navigation` filtered to main-frame, cross-document navigations fires on a reload
 * but not on an in-page (hash / pushState) navigation or a sub-frame load.
 */
export function watchRendererReset(webContents: RendererEvents): void {
  webContents.on('render-process-gone', clearUnsavedFiles)
  webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) clearUnsavedFiles()
  })
}

export function registerUnsavedDraftsIpc(): void {
  ipcMain.on('unsavedDrafts:set', (_e, payload: unknown) => {
    setUnsavedFiles(payload)
  })
}
