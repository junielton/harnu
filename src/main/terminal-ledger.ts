/**
 * Terminal-state ledger (BUG-54, spec `docs/specs/2026-07-19-terminal-ledger.md`,
 * ADR-0006). Persists the `failed`/`completed` EDGES that `hook-bridge.ts` folds
 * in memory only — restart loses them today, so the rail's `errored`/`done`
 * tiers silently empty (see the spec's root cause section).
 *
 * Pure/thin-shell split (ADR-0001), mirroring `reaper/journal.ts`:
 *  - pure core: `emptyLedger`/`recordTerminal`/`clearTerminalEntry`/
 *    `recordShutdown`/`restorable`/`evictStale`/`serializeLedger`/`parseLedger` —
 *    no electron/fs, fully unit-tested (`tests/terminal-ledger.test.ts`).
 *  - I/O shell: `loadLedgerFile`/`saveLedgerFile`, via the same `atomicWriteFile`
 *    helper `mcp/server.ts` uses, so a crash mid-write can never corrupt the file.
 *  - orchestration: a module-level in-memory ledger, subscribed to
 *    `hook-bridge.addTaskEventObserver` (D3) — no second hook path.
 *
 * D5's safety property (a stale entry must never pin a resumed, healthy session
 * to `failed`): ANY new hook edge for a session — terminal or not — supersedes
 * its prior ledger entry (`handleHookTaskEvent`'s else-branch), and `restorable`
 * additionally refuses to surface an entry the caller's freshness signal marks
 * as superseded (new life this run, or a newer clean end-of-turn on disk).
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from './mcp/atomic-write'
import { addTaskEventObserver, type HookTaskEvent } from './hook-bridge'
import type { FailureReason } from './hook-state'

export type TerminalState = 'failed' | 'completed'

export interface TerminalEntry {
  state: TerminalState
  failureReason?: FailureReason
  /** Absolute epoch-ms — survives a restart by construction (D4). */
  resetsAt?: number
  /** Epoch-ms of the edge that produced this entry. */
  at: number
}

export interface LastShutdown {
  at: number
  sessionIds: string[]
}

export interface TerminalLedgerState {
  version: 1
  terminal: Record<string, TerminalEntry>
  lastShutdown: LastShutdown | null
}

export interface SessionFreshness {
  /** Set when ANY hook/PTY event for this session has been observed this run. */
  lastEventMs?: number
  /** The transcript's last clean end-of-turn, if newer than the ledger entry. */
  cleanEndOfTurnMs?: number
}

export interface RestorableEntry extends TerminalEntry {
  sessionId: string
}

const MAX_AGE_MS = 72 * 60 * 60 * 1000
const MAX_ENTRIES = 200

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

export function emptyLedger(): TerminalLedgerState {
  return { version: 1, terminal: {}, lastShutdown: null }
}

/** Record a terminal edge for `sessionId`. Last write wins (D5's rule c). */
export function recordTerminal(
  ledger: TerminalLedgerState,
  sessionId: string,
  entry: TerminalEntry
): TerminalLedgerState {
  return { ...ledger, terminal: { ...ledger.terminal, [sessionId]: entry } }
}

/** Drop a session's entry — the "any sign of life" supersede (D5 rule a). */
export function clearTerminalEntry(
  ledger: TerminalLedgerState,
  sessionId: string
): TerminalLedgerState {
  if (!(sessionId in ledger.terminal)) return ledger
  const terminal = { ...ledger.terminal }
  delete terminal[sessionId]
  return { ...ledger, terminal }
}

/** Replace (never append) the shutdown set — bounds it for free (D6). */
export function recordShutdown(
  ledger: TerminalLedgerState,
  sessionIds: string[],
  at: number
): TerminalLedgerState {
  return { ...ledger, lastShutdown: { at, sessionIds: [...sessionIds] } }
}

/**
 * Which entries are still safe to restore/rebroadcast, given what the caller
 * currently knows about each session's freshness (D5). A session absent from
 * `freshness` is treated as having no fresher signal — its entry restores.
 */
export function restorable(
  ledger: TerminalLedgerState,
  freshness: Record<string, SessionFreshness>
): RestorableEntry[] {
  const out: RestorableEntry[] = []
  for (const [sessionId, entry] of Object.entries(ledger.terminal)) {
    const fresh = freshness[sessionId]
    if (fresh?.lastEventMs !== undefined) continue // new life this run
    if (fresh?.cleanEndOfTurnMs !== undefined && fresh.cleanEndOfTurnMs > entry.at) continue
    out.push({ sessionId, ...entry })
  }
  return out
}

/** Drop entries older than 72h, then cap at 200 (oldest `at` evicted first). D6. */
export function evictStale(ledger: TerminalLedgerState, nowMs: number): TerminalLedgerState {
  const fresh = Object.entries(ledger.terminal).filter(([, e]) => nowMs - e.at <= MAX_AGE_MS)
  fresh.sort((a, b) => b[1].at - a[1].at) // newest first
  const capped = fresh.slice(0, MAX_ENTRIES)
  return { ...ledger, terminal: Object.fromEntries(capped) }
}

function isTerminalEntry(v: unknown): v is TerminalEntry {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return (e.state === 'failed' || e.state === 'completed') && typeof e.at === 'number'
}

function isLastShutdown(v: unknown): v is LastShutdown {
  if (v === null) return true
  if (typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  return typeof s.at === 'number' && Array.isArray(s.sessionIds)
}

export function serializeLedger(ledger: TerminalLedgerState): string {
  return JSON.stringify(ledger, null, 2) + '\n'
}

/** Never throws — any malformed/corrupt input degrades to `emptyLedger()`. */
export function parseLedger(raw: string): TerminalLedgerState {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed.version !== 1) return emptyLedger()
    const terminal = parsed.terminal
    if (typeof terminal !== 'object' || terminal === null || Array.isArray(terminal)) {
      return emptyLedger()
    }
    const entries = Object.entries(terminal as Record<string, unknown>)
    if (!entries.every(([, v]) => isTerminalEntry(v))) return emptyLedger()
    const lastShutdown = parsed.lastShutdown ?? null
    if (!isLastShutdown(lastShutdown)) return emptyLedger()
    return {
      version: 1,
      terminal: Object.fromEntries(entries) as Record<string, TerminalEntry>,
      lastShutdown: lastShutdown as LastShutdown | null
    }
  } catch {
    return emptyLedger()
  }
}

// ---------------------------------------------------------------------------
// I/O shell
// ---------------------------------------------------------------------------

function ledgerPath(): string {
  return join(app.getPath('userData'), 'terminal-ledger.json')
}

/** Absent or corrupt file loads as empty — never throws (AC). */
export async function loadLedgerFile(): Promise<TerminalLedgerState> {
  try {
    const raw = await fs.readFile(ledgerPath(), 'utf8')
    return evictStale(parseLedger(raw), Date.now())
  } catch {
    return emptyLedger()
  }
}

export async function saveLedgerFile(ledger: TerminalLedgerState): Promise<void> {
  const evicted = evictStale(ledger, Date.now())
  await atomicWriteFile(ledgerPath(), serializeLedger(evicted), 0o600)
}

// ---------------------------------------------------------------------------
// Orchestration — module-level in-memory ledger, wired to the hook bridge
// ---------------------------------------------------------------------------

let ledger: TerminalLedgerState = emptyLedger()

/** Load the persisted ledger into memory. Call once at boot, before restore. */
export async function initTerminalLedger(): Promise<void> {
  ledger = await loadLedgerFile()
}

function persist(): void {
  saveLedgerFile(ledger).catch((err) => {
    console.error('[terminal-ledger] persist failed', err)
  })
}

/**
 * The observer callback (D3): a `failed`/`completed` edge records a terminal
 * entry; ANY other edge is a sign of life and supersedes a stale entry for the
 * same session (D5 rule a). Exported directly so it's testable without the
 * full hook-bridge HTTP/electron plumbing (`tests/hook-bridge.test.ts`).
 */
export function handleHookTaskEvent(ev: HookTaskEvent): void {
  if (ev.taskState === 'failed') {
    ledger = recordTerminal(ledger, ev.sessionId, {
      state: 'failed',
      failureReason: ev.failureReason ?? 'unknown',
      resetsAt: ev.resetsAt,
      at: ev.ts
    })
  } else if (ev.taskState === 'completed') {
    ledger = recordTerminal(ledger, ev.sessionId, { state: 'completed', at: ev.ts })
  } else {
    ledger = clearTerminalEntry(ledger, ev.sessionId)
  }
  persist()
}

/** Subscribe to the hook bridge's in-main observer seam. Call once at boot. */
export function startTerminalLedgerObserver(): () => void {
  return addTaskEventObserver(handleHookTaskEvent)
}

/** `before-quit` (D7): replace `lastShutdown` with the sessions still working. */
export async function recordShutdownSnapshot(sessionIds: string[], atMs: number): Promise<void> {
  ledger = recordShutdown(ledger, sessionIds, atMs)
  await saveLedgerFile(ledger)
}

/** Boot restore (D8) — entries still valid to rebroadcast on `claude:hook`. */
export function getRestorableTerminalEntries(
  freshness: Record<string, SessionFreshness> = {}
): RestorableEntry[] {
  return restorable(ledger, freshness)
}

/** Backs the `fleet:lastShutdown` IPC handler (T167 will consume this). */
export function getLastShutdown(): LastShutdown | null {
  return ledger.lastShutdown
}
