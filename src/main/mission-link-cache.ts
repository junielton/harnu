/**
 * Mission v3 S2 (§3.7) — sticky proof: the last-known resolution of each
 * mission link, so a read that cannot reach GitHub (or a PR that aged out of
 * `gh pr list --limit 100`) does not un-prove a step that was proven a minute
 * ago.
 *
 * It lives OUTSIDE the mission file — in memory, and in a userData sidecar,
 * `mission-link-cache.json` — because reads never write the mission file: its
 * `updatedAt` stays a pure evidence signal for the stall rule and for ordering.
 *
 * Keyed by `repoRoot + linkKind + ref`. Only positive observations are
 * remembered (a PR seen OPEN or MERGED, a worktree whose branch has a merged
 * PR); `forgetResolved` is the one downgrade, for a contrary observation (a PR
 * closed unmerged). An unreachable GitHub never writes here. Writes are
 * debounced and atomic; a corrupt sidecar reads as empty.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { atomicWriteFile } from './mcp/atomic-write'
import type { LedgerRow } from './mission-core'
import {
  OBSERVED_LEDGER_MAX,
  adoptCachedRows,
  isLedgerRow,
  observedRows,
  recordObserved
} from './missions/ledger-store'

/**
 * `pr` / `worktree` — the link's own state. `pr-ci` — the last CI state of a PR's head
 * (`passing` / `failing`), `pr-main` — the last CI state of its merge commit on the
 * default branch (campaign spec §3.2 gates).
 */
export type LinkCacheKind = 'pr' | 'worktree' | 'pr-ci' | 'pr-main'

/** One remembered resolution. `at` is when this state was first seen. */
export interface LinkResolution {
  /** `OPEN` / `MERGED` for a PR; `MERGED` for a worktree whose branch has a merged PR. */
  state: string
  prNumber?: number
  mergedAt?: string
  /** A worktree link's branch, kept for when its path is gone. */
  branch?: string
  /** A PR link's URL and base branch, so a stale read still renders the link. */
  url?: string
  baseRefName?: string
  at: string
}

/** How long a burst of sightings waits before one write. */
export const LINK_CACHE_WRITE_DEBOUNCE_MS = 1000
/** Bound on the cache; past it the oldest sightings are dropped. */
export const LINK_CACHE_MAX_ENTRIES = 2000

const FILE_NAME = 'mission-link-cache.json'
const VERSION = 1

const entries = new Map<string, LinkResolution>()
/**
 * Missions v4 S-4 — ledger rows Harnu OBSERVED while reading a mission (a PR opened / merged, a
 * CI change, a linked session ending) now live beside the mission, in the repo
 * (`missions/ledger-store.ts`). The functions below keep their names and shapes and hand over to
 * it.
 *
 * What an older build kept in this file's `ledger` key is still here and still written back
 * exactly as it was read: it is copied into the repo store (AC-6) and never edited or dropped, so
 * the cache stays a valid fallback for a build that reads it.
 */
const legacyLedger = new Map<string, LedgerRow[]>()
/** Bound on one mission's observed rows held in memory; past it the oldest are dropped. */
export { OBSERVED_LEDGER_MAX }
let loading: Promise<void> | null = null
let dirty = false
let timer: ReturnType<typeof setTimeout> | null = null
let writing: Promise<void> = Promise.resolve()
/** Bound once, on first use: every write goes where the cache was read from. */
let file: string | null = null

function keyOf(root: string, kind: LinkCacheKind, ref: string): string {
  return `${root}\u0000${kind}\u0000${ref}`
}

function sidecarPath(): string {
  if (file === null) file = path.join(app.getPath('userData'), FILE_NAME)
  return file
}

function isResolution(v: unknown): v is LinkResolution {
  const r = v as Partial<LinkResolution> | null
  return (
    !!r &&
    typeof r === 'object' &&
    typeof r.state === 'string' &&
    typeof r.at === 'string' &&
    (r.prNumber === undefined || typeof r.prNumber === 'number')
  )
}

/** Reads the sidecar once. A sighting made before it lands wins over the disk copy. */
export function ensureLinkCacheLoaded(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(await fs.readFile(sidecarPath(), 'utf8'))
      } catch {
        return // missing or corrupt: start empty
      }
      const body = parsed as { version?: unknown; entries?: unknown; ledger?: unknown } | null
      if (!body || body.version !== VERSION || typeof body.entries !== 'object' || !body.entries) {
        return
      }
      const fromDisk = new Map<string, LinkResolution>()
      for (const [k, v] of Object.entries(body.entries as Record<string, unknown>)) {
        if (isResolution(v)) fromDisk.set(k, v)
      }
      // Disk first, then whatever was seen in memory meanwhile (newer).
      const merged = new Map([...fromDisk, ...entries])
      entries.clear()
      for (const [k, v] of merged) entries.set(k, v)
      trim()
      if (body.ledger && typeof body.ledger === 'object') {
        for (const [missionId, rows] of Object.entries(body.ledger as Record<string, unknown>)) {
          if (!Array.isArray(rows)) continue
          const valid = rows.filter(isLedgerRow)
          if (valid.length === 0) continue
          legacyLedger.set(missionId, valid)
          // Copied into the repo store, which puts them in front of anything observed meanwhile.
          adoptCachedRows(missionId, valid)
        }
      }
    })()
  }
  return loading
}

function trim(): void {
  while (entries.size > LINK_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

function scheduleWrite(): void {
  dirty = true
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void flushLinkCache()
  }, LINK_CACHE_WRITE_DEBOUNCE_MS)
  timer.unref?.()
}

/** The last-known resolution of a link, or `null` when it never resolved. */
export function getLastKnown(
  root: string,
  kind: LinkCacheKind,
  ref: string
): LinkResolution | null {
  return entries.get(keyOf(root, kind, ref)) ?? null
}

/**
 * Remember a positive observation. The same state seen again is not a change:
 * `at` keeps the first sighting, and nothing is rewritten unless its details
 * (url, base branch, branch) moved.
 */
export function rememberResolved(
  root: string,
  kind: LinkCacheKind,
  ref: string,
  seen: Omit<LinkResolution, 'at'>,
  at: string = new Date().toISOString()
): void {
  const key = keyOf(root, kind, ref)
  const prev = entries.get(key)
  if (prev && prev.state === seen.state && prev.prNumber === seen.prNumber) {
    // Same state: `at` keeps the first sighting, but the details a stale read
    // renders (a retargeted PR's base, its url) follow the latest one.
    if (
      prev.url === seen.url &&
      prev.baseRefName === seen.baseRefName &&
      prev.branch === seen.branch
    ) {
      return
    }
    entries.set(key, { ...seen, at: prev.at })
    scheduleWrite()
    return
  }
  entries.delete(key) // re-insert last: Map order = recency
  entries.set(key, { ...seen, at })
  trim()
  scheduleWrite()
}

/** The rows observed so far for a mission, oldest first (held by the repo ledger store). */
export function getObservedLedger(missionId: string): readonly LedgerRow[] {
  return observedRows(missionId)
}

/** Append observed rows for a mission (the only operation on them). */
export function addObservedLedger(missionId: string, rows: readonly LedgerRow[]): void {
  recordObserved(missionId, rows)
}

/** Drop a link's last-known state — only on a contrary observation (a PR closed unmerged). */
export function forgetResolved(root: string, kind: LinkCacheKind, ref: string): void {
  if (entries.delete(keyOf(root, kind, ref))) scheduleWrite()
}

/** Write any pending change now (tests; a debounced write calls this too). */
export async function flushLinkCache(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  await ensureLinkCacheLoaded()
  writing = writing.then(async () => {
    if (!dirty) return
    dirty = false
    const body = JSON.stringify(
      {
        version: VERSION,
        entries: Object.fromEntries(entries),
        // What an older build kept here, written back as it was read (AC-6: the cache stays).
        ...(legacyLedger.size > 0 ? { ledger: Object.fromEntries(legacyLedger) } : {})
      },
      null,
      1
    )
    try {
      await fs.mkdir(path.dirname(sidecarPath()), { recursive: true })
      await atomicWriteFile(sidecarPath(), body, 0o600)
    } catch (err) {
      // Best effort: the in-memory copy still serves this process.
      console.error('[mission-link-cache] write failed', err)
    }
  })
  return writing
}
