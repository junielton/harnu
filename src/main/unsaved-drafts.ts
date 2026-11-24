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

export function registerUnsavedDraftsIpc(): void {
  ipcMain.on('unsavedDrafts:set', (_e, payload: unknown) => {
    setUnsavedFiles(payload)
  })
}
