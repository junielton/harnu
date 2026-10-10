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
   * Session creation time (ISO) — the board's ONLY ordering key (T459). Unlike
   * `modified` it never changes with activity, so cards do not reshuffle as
   * transcripts grow. Optional: a slice without a parseable value is the
   * "missing" case and sorts after every valid one.
   */
  created?: string
  /**
   * Live-activity verdict from the canonical `resolveActivity`, resolved by the
   * store (it owns the clock, `agents`, and the quiet threshold). Drives the
   * working / stuck / idle bucketing so the board matches the sidebar dot.
   */
  activity: FleetActivity
  /** alias of the owning folder (resolved by the store before calling). */
  folderAlias: string
}

/**
 * Direction of the creation-order sort inside every bucket (T459). The bucket
 * (tier) order itself is fixed by `BOARD_STATES` and never inverts.
 */
export type BoardOrder = 'newest-first' | 'oldest-first'

/** The rail's default direction — newest session on top. */
export const DEFAULT_BOARD_ORDER: BoardOrder = 'newest-first'

/** A renderable bucket: a state + its already-ordered cards (creation order). */
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

/** Parse `created` to a sortable number; missing/invalid → `null`. */
function createdKey(created: string | undefined): number | null {
  if (!created) return null
  const ms = Date.parse(created)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Total order for cards inside one bucket (T459): by creation time in the
 * requested direction; a missing/invalid `created` sorts AFTER every valid one
 * in BOTH directions (inverting must not promote bad data to the top); ties —
 * including two invalid values — break on `sessionId` ascending, so the result
 * never depends on input order and refreshes can never shuffle equal cards.
 */
function compareCreated(a: BoardSession, b: BoardSession, order: BoardOrder): number {
  const ak = createdKey(a.created)
  const bk = createdKey(b.created)
  if (ak !== null && bk !== null && ak !== bk) {
    return order === 'newest-first' ? bk - ak : ak - bk
  }
  if (ak === null && bk !== null) return 1
  if (ak !== null && bk === null) return -1
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0
}

/**
 * Group sessions into buckets in BOARD_STATES order, sort each bucket by
 * creation time (T459 — stable, activity never moves a card; `order` picks the
 * direction, default newest first), and DROP empty buckets. Pure; never
 * mutates the input. Sidechains are assumed pre-filtered by the caller.
 */
export function buildBoard(
  sessions: readonly BoardSession[],
  order: BoardOrder = DEFAULT_BOARD_ORDER
): BoardBucket[] {
  const buckets: BoardBucket[] = []
  for (const state of BOARD_STATES) {
    const inState = sessions.filter((s) => classifyBoardState(s) === state)
    if (inState.length === 0) continue
    inState.sort((a, b) => compareCreated(a, b, order))
    buckets.push({ state, sessions: inState })
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
