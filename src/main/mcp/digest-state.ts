/**
 * The digest engine's persisted state (memory U1 S-4; spec
 * `docs/specs/2026-11-04-memory-u1-capture/spec.md`, "The persisted state", and D-9). What each
 * session's last digest saw (`last`) and where its transcript read stopped (`scan`) survive a
 * restart, so a reloaded engine neither digests an unchanged session again nor re-reads a
 * transcript from its first line. The catch-up selection picks the quiet, undigested sessions a
 * hook never reached (Harnu closed, a crash, the hook bridge off).
 *
 * Pure: parse, serialize, prune and select take their inputs and the clock as arguments; the
 * selection's two probes are injected.
 */

import type { TranscriptFacts } from './digest-transcript'

/** The file's version; any other version reads as empty. */
export const DIGEST_STATE_VERSION = 1
/** The file name under Electron's `userData`. */
export const DIGEST_STATE_FILE = 'memory-digest-state.json'

const DAY_MS = 86_400_000
/** An entry whose last digest is older than this is pruned on load. */
export const DIGEST_STATE_TTL_MS = 30 * DAY_MS
/** How far back the catch-up sweep looks (D-9). */
export const CATCH_UP_MAX_AGE_MS = 7 * DAY_MS
/** At most this many sessions are caught up per pass. */
export const CATCH_UP_LIMIT = 10

/** One session's record. */
export interface DigestStateEntry {
  /** Epoch ms of the last successful digest. */
  lastDigestAt: number
  /** What that digest saw. */
  last: { head: string | null; userTurns: number }
  /** Where the transcript read stopped, and the facts folded so far. */
  scan: { offset: number; facts: TranscriptFacts }
}

export interface DigestState {
  version: typeof DIGEST_STATE_VERSION
  sessions: Record<string, DigestStateEntry>
}

export function emptyDigestState(): DigestState {
  return { version: DIGEST_STATE_VERSION, sessions: {} }
}

/**
 * Reads the file's text. Text that does not parse, or has another version, is the empty state
 * with a `problem` for the caller to log once; a malformed entry is dropped. Entries older than
 * {@link DIGEST_STATE_TTL_MS} are pruned. Never throws.
 */
export function parseDigestState(
  raw: string,
  nowMs: number
): { state: DigestState; problem: string | null } {
  void raw
  void nowMs
  throw new Error('not implemented')
}

/** The file's text. */
export function serializeDigestState(state: DigestState): string {
  void state
  throw new Error('not implemented')
}

/** A copy without the entries whose last digest is older than {@link DIGEST_STATE_TTL_MS}. */
export function pruneDigestState(state: DigestState, nowMs: number): DigestState {
  void state
  void nowMs
  throw new Error('not implemented')
}

/**
 * Whether a `sessions/` directory listing holds a digest of `sessionId` (spec "Has a digest":
 * a name matching `^\d{4}-\d{2}-\d{2}-<id8>\.md$`).
 */
export function hasDigestFile(names: readonly string[], sessionId: string): boolean {
  void names
  void sessionId
  throw new Error('not implemented')
}

/** A session the sweep may catch up. */
export interface CatchUpCandidate {
  sessionId: string
  /** The transcript's mtime, epoch ms. */
  mtimeMs: number
}

/** The selection's I/O, injected. */
export interface CatchUpProbe<C extends CatchUpCandidate> {
  /** Whether the session already has a digest in its memory dir. */
  hasDigest(c: C): Promise<boolean>
  /** The session's user-turn count. */
  userTurns(c: C): Promise<number>
}

export interface CatchUpOptions {
  /** A session modified more recently than this is still live (`LONG_IDLE_MS`). */
  minQuietMs: number
  minUserTurns: number
  maxAgeMs?: number
  limit?: number
}

/**
 * The catch-up selection: sessions whose transcript was modified within
 * {@link CATCH_UP_MAX_AGE_MS} and at least `minQuietMs` ago, with no state entry, no digest and at
 * least `minUserTurns` user turns; oldest mtime first; at most {@link CATCH_UP_LIMIT}. The probes
 * run only for sessions that pass the cheap checks, in order, until the limit is reached.
 */
export async function selectCatchUp<C extends CatchUpCandidate>(
  candidates: readonly C[],
  state: DigestState,
  nowMs: number,
  probe: CatchUpProbe<C>,
  opts: CatchUpOptions
): Promise<C[]> {
  void candidates
  void state
  void nowMs
  void probe
  void opts
  throw new Error('not implemented')
}
