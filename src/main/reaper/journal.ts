// Tombstone journal for the Reaper cleanup engine: pure (de)serialization + a
// thin append/read shell backed by a JSONL file under userData.

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { MergeSignal } from './reaper-core'

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
    isOptionalRef(t.archiveWipRef)
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
