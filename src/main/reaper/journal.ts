// Tombstone journal for the Reaper cleanup engine: pure (de)serialization + a
// thin append/read shell backed by a JSONL file under userData.

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { MergeSignal } from './reaper-core'
import type { TrashEntryRecord } from '../gc/trash-core'

export interface Tombstone {
  at: number
  repoPath: string
  kind: string
  branch: string | null
  sha: string | null
  deleted: string[]
  justifiedBy: MergeSignal | null
  restoreHint: string | null
  /**
   * T254 — the refs written before this sweep, so the deletion is recoverable
   * rather than merely justified. `archiveTipRef` holds the branch tip;
   * `archiveWipRef` holds the working state (tracked modifications AND
   * untracked files) that the tip does not carry. Null when the item had no
   * such thing to preserve (a branch with no checkout has no working state) —
   * or, on a pre-T254 journal line, when the field simply did not exist yet.
   */
  archiveTipRef: string | null
  archiveWipRef: string | null
  /**
   * Who ran the cleanup. Absent on every line written before the workspace GC, and then it
   * was an operator click; `autopilot` marks an unattended cycle on the Reaper timer.
   */
  actor?: 'operator' | 'autopilot'
  /**
   * Where the folder stood when Harnu moved it to the OS trash, absent when nothing was trashed
   * (and on every line written before the trash was recorded). The Cleanup screen reads these to
   * tell what Harnu itself put in the trash from whatever else the user keeps there, so it can
   * empty only the former. The timestamp narrows a match against the OS trash to this very move.
   */
  trashedPath?: string | null
  trashedBytes?: number | null
  trashedAt?: number | null
  /**
   * The exact entry the move created in the OS trash, identified at trash time (the trash listing
   * before and after, plus a fingerprint). Null or absent when it could not be told; such an entry
   * is never emptied by Harnu.
   */
  trashEntry?: TrashEntryRecord | null
}

/** Serializes a tombstone to a single JSON line (with trailing newline). */
export function serializeTombstone(t: Tombstone): string {
  return JSON.stringify(t) + '\n'
}

function isTombstone(v: unknown): v is Tombstone {
  if (!v || typeof v !== 'object') return false
  const t = v as Record<string, unknown>
  return (
    typeof t.at === 'number' &&
    typeof t.repoPath === 'string' &&
    typeof t.kind === 'string' &&
    (typeof t.branch === 'string' || t.branch === null) &&
    (typeof t.sha === 'string' || t.sha === null) &&
    Array.isArray(t.deleted) &&
    (typeof t.justifiedBy === 'string' || t.justifiedBy === null) &&
    (typeof t.restoreHint === 'string' || t.restoreHint === null) &&
    isOptionalRef(t.archiveTipRef) &&
    isOptionalRef(t.archiveWipRef) &&
    (t.actor === undefined || t.actor === 'operator' || t.actor === 'autopilot') &&
    isOptional(t.trashedPath, 'string') &&
    isOptional(t.trashedBytes, 'number') &&
    isOptional(t.trashedAt, 'number') &&
    (t.trashEntry === undefined || t.trashEntry === null || isTrashEntry(t.trashEntry))
  )
}

/** A field that older lines lack: absent, null or the expected type. */
function isOptional(v: unknown, type: 'string' | 'number'): boolean {
  return v === undefined || v === null || typeof v === type
}

/** The shape of a recorded trash entry; anything else is treated as not recorded at all. */
function isTrashEntry(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  const num = (k: string): boolean => typeof e[k] === 'number' && Number.isFinite(e[k] as number)
  if (typeof e.trashDir !== 'string' || typeof e.name !== 'string') return false
  if (!num('dev') || !num('ino') || !num('ctimeMs')) return false
  if (e.kind === 'macos') return true
  return (
    e.kind === 'freedesktop' &&
    typeof e.deletionDate === 'string' &&
    num('infoIno') &&
    num('infoMtimeMs')
  )
}

/** Archive refs are absent on journal lines written before T254; treat that as null. */
function isOptionalRef(v: unknown): boolean {
  return typeof v === 'string' || v === null || v === undefined
}

/** Parses journal JSONL content, newest first (by `at` descending), skipping malformed lines. */
export function parseJournal(content: string, limit: number): Tombstone[] {
  const out: Tombstone[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isTombstone(parsed)) continue
    // Normalize pre-T254 lines so consumers never see `undefined` here.
    out.push({
      ...parsed,
      archiveTipRef: parsed.archiveTipRef ?? null,
      archiveWipRef: parsed.archiveWipRef ?? null
    })
  }
  out.sort((a, b) => b.at - a.at)
  return out.slice(0, limit)
}

// Values that are already safe as a bare shell word (branch names cannot
// contain most of these, but the SHA and branch both flow into a command a
// human copies into a terminal — so anything outside this set gets quoted).
const SHELL_SAFE = /^[A-Za-z0-9,._+:@%/-]+$/

/** Single-quotes a value for POSIX shells unless it is already a safe bare word. */
function shellQuote(value: string): string {
  if (SHELL_SAFE.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * `git branch <branch> <sha>` restore hint, or null when either half is unknown.
 * Both halves are shell-quoted so a hostile branch name (e.g. `feat/x;rm -rf .`
 * or `feat/$(id)`) stays literal when the hint is pasted into a terminal.
 */
export function restoreHintFor(branch: string | null, sha: string | null): string | null {
  if (!branch || !sha) return null
  return `git branch ${shellQuote(branch)} ${shellQuote(sha)}`
}

export function journalPath(): string {
  return path.join(app.getPath('userData'), 'reaper-log.jsonl')
}

export async function appendTombstone(t: Tombstone): Promise<void> {
  try {
    await fs.appendFile(journalPath(), serializeTombstone(t), 'utf8')
  } catch (err) {
    // Surface the failure to the caller so the cleanup pipeline can mark the
    // journal step failed — a silent swallow would lose the restore record.
    console.warn('[reaper] failed to append tombstone', err)
    throw err
  }
}

export async function readJournal(limit = 50): Promise<Tombstone[]> {
  try {
    const content = await fs.readFile(journalPath(), 'utf8')
    return parseJournal(content, limit)
  } catch {
    return []
  }
}
