/**
 * Quick notes core — one scratch markdown note per repo per local day, stored at
 * `<main checkout>/.harnu/notes/YYYY-MM-DD.md` so every worktree of a repo shares
 * the same notes. Pure-ish fs logic with no `electron` import (the known-roots
 * policy is loaded lazily, and only when a caller does not supply `roots`), so it
 * is unit-testable without an app.
 */

import { lstat, open, readdir } from 'node:fs/promises'
import * as path from 'node:path'
import { mkdirDataDir, repoDataDir } from './data-dir'

export const NOTE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/

export interface NoteEntry {
  date: string
  filePath: string
}

export type NotesErrorCode =
  'invalid-args' | 'folder-not-allowed' | 'not-found' | 'symlink' | 'io-failed'

type NotesErr = { ok: false; code: NotesErrorCode }

/** `YYYY-MM-DD` that is a real calendar date (rejects `2026-02-30`). */
export function isValidNoteDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

/** The LOCAL calendar date as `YYYY-MM-DD`. */
export function localDateStamp(d: Date = new Date()): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${String(d.getFullYear()).padStart(4, '0')}-${mm}-${dd}`
}

/** The title a freshly created note starts with. */
export function noteHeader(date: string): string {
  return `# ${date} Notes\n\n`
}

/** The repo-level notes directory for `folder` (the main checkout's, shared by worktrees). */
export function notesDirFor(folder: string): string {
  return path.join(repoDataDir(folder), 'notes')
}

/**
 * True iff `resolved` is a dated note file (`YYYY-MM-DD.md`, a real calendar date)
 * directly inside the notes directory of some root in `roots` — i.e. the MAIN
 * checkout's `.harnu/notes/`, even when only a worktree of that repo is a root.
 * The cheap basename checks run first; roots are resolved (which may probe the
 * disk) only for a name that could be a note.
 */
export function isNotesFilePath(resolved: string, roots: readonly string[]): boolean {
  const m = NOTE_FILE_RE.exec(path.basename(resolved))
  if (!m || !isValidNoteDate(m[1])) return false
  const dir = path.dirname(resolved)
  return roots.some((r) => notesDirFor(r) === dir)
}

/** True when the note file (if it exists) or its parent directory is a symlink. */
export async function isNotesSymlink(resolved: string): Promise<boolean> {
  for (const p of [resolved, path.dirname(resolved)]) {
    try {
      if ((await lstat(p)).isSymbolicLink()) return true
    } catch {
      // Absent / unreadable: the normal open path reports that.
    }
  }
  return false
}

/** Validate `folder` and confine it to the known roots (`roots` is a test seam). */
async function gate(folder: unknown, roots?: readonly string[]): Promise<NotesErr | null> {
  if (typeof folder !== 'string' || folder.length === 0) return { ok: false, code: 'invalid-args' }
  const [{ isPathAllowed }, known] = await Promise.all([
    import('./settings'),
    roots ? Promise.resolve(roots) : import('./markdown-read').then((m) => m.markdownKnownRoots())
  ])
  if (!isPathAllowed(path.resolve(folder), [...known])) {
    return { ok: false, code: 'folder-not-allowed' }
  }
  return null
}

type Probe = 'missing' | 'symlink' | 'present'

async function probe(p: string): Promise<Probe> {
  try {
    return (await lstat(p)).isSymbolicLink() ? 'symlink' : 'present'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw err
  }
}

export async function listNotes(
  folder: string,
  roots?: readonly string[]
): Promise<{ ok: true; notesDir: string; today: string; notes: NoteEntry[] } | NotesErr> {
  const denied = await gate(folder, roots)
  if (denied) return denied
  const notesDir = notesDirFor(folder)
  const today = localDateStamp()
  try {
    const dirState = await probe(notesDir)
    if (dirState === 'symlink') return { ok: false, code: 'symlink' }
    if (dirState === 'missing') return { ok: true, notesDir, today, notes: [] }
    const entries = await readdir(notesDir, { withFileTypes: true })
    const notes: NoteEntry[] = []
    for (const e of entries) {
      if (!e.isFile()) continue
      const m = NOTE_FILE_RE.exec(e.name)
      if (m && isValidNoteDate(m[1])) {
        notes.push({ date: m[1], filePath: path.join(notesDir, e.name) })
      }
    }
    notes.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    return { ok: true, notesDir, today, notes }
  } catch {
    return { ok: false, code: 'io-failed' }
  }
}

/**
 * Resolve a note file. With no `date`, today's note (created with its header when
 * missing); with a `date`, that existing note only. Never follows a symlink at the
 * notes dir or the note file.
 */
export async function openNote(
  folder: string,
  date?: string,
  roots?: readonly string[]
): Promise<{ ok: true; filePath: string; created: boolean } | NotesErr> {
  if (date !== undefined && !isValidNoteDate(date)) return { ok: false, code: 'invalid-args' }
  const denied = await gate(folder, roots)
  if (denied) return denied
  const notesDir = notesDirFor(folder)
  const day = date ?? localDateStamp()
  const filePath = path.join(notesDir, `${day}.md`)
  try {
    const dirState = await probe(notesDir)
    if (dirState === 'symlink') return { ok: false, code: 'symlink' }
    if (date !== undefined && dirState === 'missing') return { ok: false, code: 'not-found' }
    if (dirState === 'missing') await mkdirDataDir(notesDir)

    const fileState = await probe(filePath)
    if (fileState === 'symlink') return { ok: false, code: 'symlink' }
    if (fileState === 'present') return { ok: true, filePath, created: false }
    if (date !== undefined) return { ok: false, code: 'not-found' }

    try {
      // `wx` makes the create atomic: of two racing first opens exactly one writes
      // the header and the other sees EEXIST.
      const fh = await open(filePath, 'wx')
      try {
        await fh.writeFile(noteHeader(day), 'utf8')
      } finally {
        await fh.close()
      }
      return { ok: true, filePath, created: true }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return { ok: true, filePath, created: false }
      }
      throw err
    }
  } catch {
    return { ok: false, code: 'io-failed' }
  }
}
