/**
 * Missions v4 S-4 (R-25, D-20, AC-5, AC-6) — the one ledger store.
 *
 * A mission's ledger used to live in two places: the rows Harnu WROTE (a dispatch, a worktree, a
 * verdict) in the mission file, and the rows Harnu OBSERVED while reading (a pull request opened
 * or merged, a CI change, a builder ending) in a machine-local userData cache. The close-out
 * consolidator saw only the first half, and the second did not follow the repo to another machine.
 *
 * Observed rows now live beside the mission, in the repo: `.harnu/missions/<id>.ledger.jsonl`,
 * one JSON row per line, append-only. This module is the only reader and writer of that file.
 *
 *  - The observer (`./observer.ts`) is synchronous and dedupes against what it has seen, so the
 *    rows of a mission are also kept in memory ({@link observedRows}, {@link recordObserved}) and
 *    persisted behind it, debounced. A row is never edited or removed once stored.
 *  - A READ ({@link readObservedLedger}, {@link missionLedgerCount}) binds nothing, loads nothing
 *    into memory and stores nothing. The observer pass's {@link hydrateMissionLedger} binds the
 *    mission to its repo, loads what the file holds and stores what only memory holds; that is
 *    also how the rows the old userData cache carries are copied in ({@link adoptCachedRows}),
 *    for open and closed missions alike. The cache itself is never edited, so an older build that
 *    still reads it keeps working.
 *  - Rows are told apart by their whole content, so copying the same row twice (two clones, a
 *    restart, a cache that is read on every boot) stores it once, and nothing else is dropped: every
 *    observed fact is stored, including a CI state that holds across two sightings or returns.
 *  - Accepted limits: two Harnu instances on one repo may each record the same change once (their
 *    clocks differ, so the rows differ), and a closed mission's row count is read once and kept, so
 *    another instance appending to its file shows in `mission_get` but not in `mission_list` until
 *    a restart.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { dataDirReady } from '../data-dir'
import {
  LEDGER_KINDS,
  MISSION_ID_RE,
  missionsDir,
  type LedgerRow,
  type Mission
} from '../mission-core'
import { mergeLedger } from '../mission-ledger'

/** Bound on one mission's rows held in memory; past it the oldest are dropped (the file keeps them). */
export const OBSERVED_LEDGER_MAX = 500
/** How long a burst of observations waits before one write. */
export const LEDGER_STORE_WRITE_DEBOUNCE_MS = 1000

const FILE_SUFFIX = '.ledger.jsonl'

/** The file holding `missionId`'s observed rows, beside the mission file. */
export function ledgerFilePath(root: string, missionId: string): string {
  if (!MISSION_ID_RE.test(missionId)) throw new Error(`invalid mission id: ${missionId}`)
  return path.join(missionsDir(root), `${missionId}${FILE_SUFFIX}`)
}

/** Is `v` a ledger row (the shape the mission file's own ledger holds)? */
export function isLedgerRow(v: unknown): v is LedgerRow {
  const r = v as Partial<LedgerRow> | null
  return (
    !!r &&
    typeof r === 'object' &&
    typeof r.at === 'string' &&
    typeof r.ref === 'string' &&
    (LEDGER_KINDS as readonly unknown[]).includes(r.kind)
  )
}

/** What tells two rows apart: all of their content, so the same fact copied twice is one row. */
function rowKey(r: LedgerRow): string {
  return JSON.stringify([
    r.at,
    r.kind,
    r.stepId,
    r.ref,
    r.sessionId,
    r.worktree,
    r.branch,
    r.pr,
    r.detail
  ])
}

/**
 * The rows of `rows` that `known` does not hold yet, and that do not repeat each other, in order.
 * Identity is the row's whole content: copying the same row twice (a second pass, a restart, a
 * cache read on every boot) stores it once, and nothing else is ever dropped — two rows that look
 * alike but were observed at different times are two facts (a CI state that returns, or holds
 * across two sightings, is every one of its rows).
 */
function freshAgainst(known: readonly LedgerRow[], rows: readonly LedgerRow[]): LedgerRow[] {
  const seen = new Set(known.map(rowKey))
  const out: LedgerRow[] = []
  for (const row of rows) {
    const key = rowKey(row)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

function dedupe(rows: readonly LedgerRow[]): LedgerRow[] {
  return freshAgainst([], rows)
}

/** The rows a ledger file's text holds; a line that is not a row (a torn write) is skipped. */
function parseLedgerText(text: string): LedgerRow[] {
  const rows: LedgerRow[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isLedgerRow(parsed)) rows.push(parsed)
    } catch {
      // A partial line from an interrupted append: the rows around it still count.
    }
  }
  return rows
}

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return '' // missing or unreadable: no rows yet
  }
}

/** Every row stored for `missionId` in `root`; `[]` when there is none (or the id is not one). */
export async function readLedgerFile(root: string, missionId: string): Promise<LedgerRow[]> {
  if (!MISSION_ID_RE.test(missionId)) return []
  return parseLedgerText(await readText(ledgerFilePath(root, missionId)))
}

/** Appends to one file are serialised, so two flushes never interleave their lines. */
const chains = new Map<string, Promise<unknown>>()

/**
 * Append the rows the file does not hold yet. Returns how many were written. Nothing already
 * stored is touched: the file only ever grows.
 */
async function appendNew(
  root: string,
  missionId: string,
  rows: readonly LedgerRow[]
): Promise<number> {
  const file = ledgerFilePath(root, missionId)
  const run = (chains.get(file) ?? Promise.resolve()).then(async () => {
    const text = await readText(file)
    const fresh = freshAgainst(parseLedgerText(text), rows)
    if (fresh.length === 0) return 0
    await dataDirReady(root)
    await fs.mkdir(path.dirname(file), { recursive: true })
    // An interrupted earlier append can leave the last line without its newline.
    const lead = text !== '' && !text.endsWith('\n') ? '\n' : ''
    await fs.appendFile(file, lead + fresh.map((r) => `${JSON.stringify(r)}\n`).join(''), {
      mode: 0o644
    })
    return fresh.length
  })
  chains.set(
    file,
    run.catch(() => undefined)
  )
  return run
}

// ── what this process holds ──────────────────────────────────────────────────

/** Rows per mission, oldest first: what the observer dedupes against and what is yet to be stored. */
const memory = new Map<string, LedgerRow[]>()
/** The repo root each mission was last read from; a mission with none has nowhere to be stored. */
const roots = new Map<string, string>()
/** Missions whose file this process has loaded (`root` + id), so a poll loads it once. */
const hydrated = new Set<string>()
/** Missions whose memory may hold a row the file does not. */
const unsaved = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null

function keep(rows: LedgerRow[]): LedgerRow[] {
  return rows.length > OBSERVED_LEDGER_MAX ? rows.slice(-OBSERVED_LEDGER_MAX) : rows
}

function scheduleWrite(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void flushLedgerStore()
  }, LEDGER_STORE_WRITE_DEBOUNCE_MS)
  timer.unref?.()
}

function markUnsaved(missionId: string): void {
  unsaved.add(missionId)
  scheduleWrite()
}

/** The rows held in memory for a mission, oldest first. Synchronous: the observer's dedupe reads it. */
export function observedRows(missionId: string): readonly LedgerRow[] {
  return memory.get(missionId) ?? []
}

/** Append rows the observer saw (the only operation on them). They are stored once the repo is known. */
export function recordObserved(missionId: string, rows: readonly LedgerRow[]): void {
  if (rows.length === 0) return
  memory.set(missionId, keep([...(memory.get(missionId) ?? []), ...rows]))
  markUnsaved(missionId)
}

/**
 * Take in rows the userData cache holds (AC-6): they go in front of what was observed since
 * (they are older) and are stored with it. The cache itself is left exactly as it was.
 */
export function adoptCachedRows(missionId: string, rows: readonly LedgerRow[]): void {
  if (rows.length === 0) return
  memory.set(missionId, keep(dedupe([...rows, ...(memory.get(missionId) ?? [])])))
  markUnsaved(missionId)
}

/** Remember which repo a mission belongs to, so its rows can be stored beside it. */
export function bindMissionRoot(missionId: string, root: string): void {
  if (roots.get(missionId) === root) return
  roots.set(missionId, root)
  if ((memory.get(missionId)?.length ?? 0) > 0) markUnsaved(missionId)
}

/**
 * Read what the repo holds for a mission and merge it with what this process saw: the whole file,
 * not the tail memory keeps. A READ — it binds nothing, loads nothing into memory and stores
 * nothing, so looking at a mission leaves the world as it found it (AC-4). What only memory holds
 * is stored by {@link hydrateMissionLedger}, which the observer pass calls.
 */
export async function readObservedLedger(root: string, missionId: string): Promise<LedgerRow[]> {
  if (!MISSION_ID_RE.test(missionId)) return []
  return dedupe([...(await readLedgerFile(root, missionId)), ...(memory.get(missionId) ?? [])])
}

/**
 * The observer pass's first move on a mission, once per process: bind it to its repo, load the
 * stored rows into memory before the observer dedupes against it, and store whatever only memory
 * holds — which is how the rows the userData cache carries are copied in (AC-6). It is a write,
 * so no read calls it.
 */
export async function hydrateMissionLedger(root: string, missionId: string): Promise<void> {
  if (!MISSION_ID_RE.test(missionId)) return
  const key = `${root}\u0000${missionId}`
  if (hydrated.has(key)) return
  hydrated.add(key)
  bindMissionRoot(missionId, root)
  const stored = await readLedgerFile(root, missionId)
  const all = dedupe([...stored, ...(memory.get(missionId) ?? [])])
  memory.set(missionId, keep(all))
  if (all.length > stored.length) markUnsaved(missionId)
}

/**
 * The ledger as a reader sees it: the rows written into the mission file and the rows observed,
 * from the repo store, in time order. This is what `mission_get`, `mission_list` and the
 * close-out consolidator read.
 */
export async function readMissionLedger(
  root: string,
  mission: Pick<Mission, 'id' | 'ledger'>
): Promise<LedgerRow[]> {
  return mergeLedger(mission.ledger, await readObservedLedger(root, mission.id))
}

/** Closed missions' row counts: a closed mission's ledger no longer changes, so it is counted once. */
const closedCounts = new Map<string, number>()
const CLOSED_COUNTS_MAX = 5000

/**
 * How many rows a mission's ledger holds, for the list verb. An open mission is counted from the
 * repo store each time; a CLOSED one is read once and remembered, so a polled list does not read
 * one ledger file per closed mission on every tick.
 */
export async function missionLedgerCount(
  root: string,
  mission: Pick<Mission, 'id' | 'ledger' | 'status'>
): Promise<number> {
  const key = `${root}\u0000${mission.id}`
  const closed = mission.status === 'closed'
  if (closed) {
    const hit = closedCounts.get(key)
    if (hit !== undefined) return hit
  }
  const count = (await readMissionLedger(root, mission)).length
  if (closed) {
    closedCounts.set(key, count)
    if (closedCounts.size > CLOSED_COUNTS_MAX) {
      const oldest = closedCounts.keys().next().value
      if (oldest !== undefined) closedCounts.delete(oldest)
    }
  }
  return count
}

/** Store every row not yet stored (tests; a debounced write calls this too). */
export async function flushLedgerStore(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const ids = [...unsaved]
  unsaved.clear()
  await Promise.all(
    ids.map(async (id) => {
      const root = roots.get(id)
      const rows = memory.get(id)
      if (!root || !rows) return // nowhere to store them yet; they stay in memory
      try {
        await appendNew(root, id, rows)
      } catch (err) {
        // Best effort: memory still serves this process, and the next observation retries.
        unsaved.add(id)
        console.error('[mission-ledger-store] write failed', err)
      }
    })
  )
  await Promise.all([...chains.values()])
}
