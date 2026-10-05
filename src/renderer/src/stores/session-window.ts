import type { TaskState } from '../../../preload'

/**
 * Pure session-age filter for the sidebar (session-age-filter spec §3-§4).
 *
 * Decides whether one session row stays visible inside an expanded folder,
 * given a global age window. Mirrors the structure of `session-sort.ts` and
 * `folder-zones.ts`: no I/O, no Pinia, no mutation — just a predicate plus the
 * preset/clamp helpers the store persists against.
 *
 * The window is the SESSION-level analogue of the folder-level
 * "Active-elsewhere window" (`activeWindowMs`); the two axes are independent.
 */

/** Default session-age window — 48h (spec §3). */
export const DEFAULT_SESSION_WINDOW_MS = 48 * 60 * 60 * 1000

/**
 * Allowed presets. `0` means "All" (no filtering); the rest mirror the
 * Active-elsewhere window presets (24h / 48h / 7d).
 */
export const SESSION_WINDOW_PRESETS = [
  0,
  24 * 60 * 60 * 1000,
  48 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000
] as const

/** Snap an arbitrary value to a known preset; unknown → 48h default. */
export function clampSessionWindow(ms: number): number {
  return (SESSION_WINDOW_PRESETS as readonly number[]).includes(ms) ? ms : DEFAULT_SESSION_WINDOW_MS
}

/** The thin slice of a session the window filter inspects. */
export interface WindowSession {
  sessionId: string
  status: 'active' | 'idle' | 'archived'
  taskState?: TaskState
  modified: string
  synthetic?: boolean
}

/** Everything `keepSession` needs, supplied by the store per folder. */
export interface WindowCtx {
  nowMs: number
  /** Active window in ms; `0` disables filtering ("All"). */
  windowMs: number
  /** A text search is active — span the full history regardless of age. */
  searchActive: boolean
  /** This folder's older sessions are temporarily revealed. */
  revealed: boolean
  /** The currently-selected session id (never hide what's on screen). */
  selectedId: string | null
  livePtySessionIds: Set<string>
}

/**
 * A session is "live" iff it has a running PTY, is mid-task
 * (`working` / `needs-input`), or is `active`. Mirrors `isLiveFolder`'s
 * per-session predicate in `folder-zones.ts`.
 */
function isLive(s: WindowSession, livePtySessionIds: Set<string>): boolean {
  return (
    livePtySessionIds.has(s.sessionId) ||
    s.taskState === 'working' ||
    s.taskState === 'needs-input' ||
    s.status === 'active'
  )
}

/**
 * Whether a session row stays visible. Returns `true` (keep) when ANY guard
 * fires, else falls back to the within-window test. Guards, in order:
 *   1. window is "All" (0)
 *   2. a text search is active
 *   3. the folder is revealed
 *   4. it is the selected session
 *   5. it is live (PTY / working / needs-input / active)
 *   6. it is synthetic (may have no on-disk mtime yet)
 * Otherwise keep iff `now - modified <= window`. An unparseable `modified`
 * fails OPEN (kept) — never silently swallow a real session.
 */
export function keepSession(s: WindowSession, ctx: WindowCtx): boolean {
  if (ctx.windowMs === 0) return true
  if (ctx.searchActive) return true
  if (ctx.revealed) return true
  if (s.sessionId === ctx.selectedId) return true
  if (isLive(s, ctx.livePtySessionIds)) return true
  if (s.synthetic === true) return true

  const t = Date.parse(s.modified)
  if (!Number.isFinite(t)) return true
  return ctx.nowMs - t <= ctx.windowMs
}
