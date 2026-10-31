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
import { LEDGER_KINDS, type LedgerRow } from './mission-core'

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
 * Campaign spec §3.2 — ledger rows Harnu OBSERVED while reading a mission (a PR
 * opened / merged, a CI change, a linked session ending), per mission id. They live
 * here, beside the other last-known facts, and not in the mission file: a read never
 * rewrites it (Mission v3 §3.7), so `updatedAt` stays a pure evidence signal.
 */
const observedLedger = new Map<string, LedgerRow[]>()
/** Bound on one mission's observed rows; past it the oldest are dropped. */
export const OBSERVED_LEDGER_MAX = 500
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

function isLedgerRow(v: unknown): v is LedgerRow {
  const r = v as Partial<LedgerRow> | null
  return (
    !!r &&
    typeof r === 'object' &&
    typeof r.at === 'string' &&
    typeof r.ref === 'string' &&
    (LEDGER_KINDS as readonly unknown[]).includes(r.kind)
  )
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
          // Disk first, then what was observed in memory meanwhile (newer).
          const memory = observedLedger.get(missionId) ?? []
          observedLedger.set(
            missionId,
            [...rows.filter(isLedgerRow), ...memory].slice(-OBSERVED_LEDGER_MAX)
          )
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

/** The rows observed so far for a mission, oldest first. */
export function getObservedLedger(missionId: string): readonly LedgerRow[] {
  return observedLedger.get(missionId) ?? []
}

/** Append observed rows for a mission (the only operation on them). */
export function addObservedLedger(missionId: string, rows: readonly LedgerRow[]): void {
  if (rows.length === 0) return
  const next = [...(observedLedger.get(missionId) ?? []), ...rows].slice(-OBSERVED_LEDGER_MAX)
  observedLedger.set(missionId, next)
  scheduleWrite()
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
        ...(observedLedger.size > 0 ? { ledger: Object.fromEntries(observedLedger) } : {})
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
