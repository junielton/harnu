import type { TaskState, TranscriptState } from '../../../preload'
import type { SessionStatus } from '../stores/sessions'
import { isNeedsInput, type FleetActivity } from '../stores/fleet-state'

/**
 * Pure core for the Fleet status board.
 * Framework-free — no Pinia, no DOM, no `node:` — so it unit-tests in the
 * `node` vitest env exactly like `session-sort.ts` / `failure-badge.ts`.
 *
 * `classifyBoardState` no longer re-derives activity from `taskState`/`status` on
 * its own (the source of BUG-13, where it drifted from the sidebar dot). The
 * working / stuck / idle decision now comes from the canonical `resolveActivity`
 * (`fleet-state.ts`) — resolved by the store and passed in as `activity` — the
 * SAME derivation `dotFor` reads, so the two surfaces agree by construction.
 */

/** The six board buckets, in urgency order (index = priority). `stuck` is new (T67). */
export type BoardState = 'needs-input' | 'errored' | 'stuck' | 'working' | 'idle' | 'done'

/** Canonical urgency order — single source so the eyebrow/walk never drifts. */
export const BOARD_STATES: readonly BoardState[] = [
  'needs-input',
  'errored',
  'stuck',
  'working',
  'idle',
  'done'
] as const

/** Minimal slice of a session the board needs (resolved by the store). */
export interface BoardSession {
  sessionId: string
  taskState?: TaskState
  /** Transcript ground truth (T91) — drives needs-input when no live hook exists. */
  transcriptState?: TranscriptState
  status: SessionStatus
  isSidechain: boolean
  modified: string
  /**
   * Live-activity verdict from the canonical `resolveActivity`, resolved by the
   * store (it owns the clock, `agents`, and the quiet threshold). Drives the
   * working / stuck / idle bucketing so the board matches the sidebar dot.
   */
  activity: FleetActivity
  /** alias of the owning folder (resolved by the store before calling). */
  folderAlias: string
}

/** A renderable bucket: a state + its already-ordered cards (recent desc). */
export interface BoardBucket {
  state: BoardState
  sessions: BoardSession[]
}

/**
 * Project a session onto one of the 6 board buckets. Terminal FSM states win
 * first (needs-input sticky + prioritised; failed → errored; completed → done),
 * exactly as `dotFor` renders them. Everything else defers to the canonical
 * `activity` verdict (`working` / `stuck` / `idle`) the store resolved via
 * `resolveActivity` — the SAME source the sidebar dot reads, so board and dot can
 * never disagree (BUG-13) and a quiet orchestrator with live sub-agents lands in
 * `working`, not `idle` (BUG-15). The caller filters sidechains before this.
 */
export function classifyBoardState(
  s: Pick<BoardSession, 'taskState' | 'transcriptState' | 'activity'>
): BoardState {
  if (isNeedsInput(s)) return 'needs-input'
  if (s.taskState === 'failed') return 'errored'
  if (s.taskState === 'completed') return 'done'
  return s.activity
}

/** Parse `modified` to a sortable number; invalid/empty sinks to the end. */
function recentKey(modified: string): number {
  const ms = Date.parse(modified)
  return Number.isFinite(ms) ? ms : -Infinity
}

/**
 * Group sessions into buckets in BOARD_STATES order, sort each bucket by
 * `modified` desc (stable: equal keys keep input order, via index tiebreak),
 * and DROP empty buckets. Pure + stable; never mutates the input. Sidechains
 * are assumed pre-filtered by the caller.
 */
export function buildBoard(sessions: readonly BoardSession[]): BoardBucket[] {
  const buckets: BoardBucket[] = []
  for (const state of BOARD_STATES) {
    const decorated = sessions
      .map((s, i) => ({ s, i }))
      .filter((d) => classifyBoardState(d.s) === state)
    if (decorated.length === 0) continue
    decorated.sort((a, b) => recentKey(b.s.modified) - recentKey(a.s.modified) || a.i - b.i)
    buckets.push({ state, sessions: decorated.map((d) => d.s) })
  }
  return buckets
}

// Strip, in priority order: OSC (ESC ] … BEL/ST, e.g. window-title), CSI
// (ESC [ … ), nF escapes incl. charset designation (ESC ( B / ESC ) 0 / ESC # 8),
// 2-char Fe escapes (ESC @-_), then any remaining lone control byte. The nF
// branch is what removes the `(B` residue a bare ESC-strip used to leave behind.
const ANSI_AND_CONTROL =
  // eslint-disable-next-line no-control-regex -- intentional: strip raw ANSI/CR from PTY output
  /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[ -/]+[0-~]|\x1b[@-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/**
 * Last NON-empty line of a raw PTY snapshot, sanitised of ANSI escapes / CR
 * rewrites / control bytes, trimmed and truncated to `maxLen` (default 80) with
 * an ellipsis. Returns '' for an empty / whitespace-only snapshot. Pure — the
 * caller passes a `ptyReplay().data` string; never throws.
 */
export function lastPtyLine(snapshot: string, maxLen = 80): string {
  if (!snapshot) return ''
  const lines = snapshot.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    // A CR rewrites the line in place — keep only the final segment.
    const raw = lines[i].includes('\r') ? lines[i].slice(lines[i].lastIndexOf('\r') + 1) : lines[i]
    const clean = raw.replace(ANSI_AND_CONTROL, '').trim()
    if (clean === '') continue
    return clean.length > maxLen ? clean.slice(0, Math.max(0, maxLen - 1)) + '…' : clean
  }
  return ''
}
