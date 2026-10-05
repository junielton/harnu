/**
 * Detector orchestrator core (A2 two-tier state detection — T8, pure half).
 *
 * The ONE place the leaf cores are fused into a per-session state machine for
 * inbound screen snapshots:
 *
 *   classify → matchManifest → mergeState → applyStickiness
 *
 * `reduceDetect` is a PURE reducer over a tiny {@link DetectState} (the prior
 * normalized lines + the last emitted `TaskState`) so the dangerous fusion —
 * which snapshot changes the dot, which holds blocked, which reverts an
 * un-recognized pane — is unit-testable / Stryker-reachable, exactly like
 * `mcp/plan-tool-call.ts`. The IPC shell (`screen-detect.ts`) owns the per-session
 * map + the window send; it only marshals effects.
 *
 * v1 scope: snapshots arrive ONLY for screen-mode panes (folder terminals — the
 * renderer gates on `isShellTerminal`), so the merge always runs with method
 * `'screen'` and a `null` hook signal. The two-tier hook-vs-screen precedence
 * lives in `state-merge-core` and is exercised there; here the hook tier is
 * dormant by construction (a hooked agent is never screen-scraped).
 */

import type { TaskState } from '../hook-state'
import { extractBottomLines, linesChanged } from './bottom-lines-core'
import {
  evaluateManifest,
  paneMatchesManifest,
  type CompiledManifest,
  type ManifestMatch,
  type ScreenState
} from './screen-detect-core'
import { mergeState } from './state-merge-core'
import { applyStickiness } from './stickiness-core'

/** The snapshot the shell folds per screen-mode pane (renderer lines/title + main-resolved process). */
export interface ScreenSnapshot {
  /** The pane's rendered grid lines, top-to-bottom (already string-translated). */
  lines: string[]
  /** The pane's current OSC title, or `null` if it never set one. */
  title: string | null
  /**
   * The pane's foreground process name, resolved in main from the pty pid
   * (`null` when unavailable). The strongest classifier signal — see
   * `paneMatchesManifest`. Optional so older call-sites/tests still type-check.
   */
  process?: string | null
}

/** Per-session detector memory the shell threads back into the next reduce. */
export interface DetectState {
  /** The normalized bottom lines from the last snapshot (change detection). */
  lines: string[]
  /** The last `TaskState` we emitted for this session, or `null` if reverted. */
  taskState: TaskState | null
  /** The agent the pane was last classified as, or `null` when unrecognized. */
  agent: string | null
}

/**
 * The outcome of one reduce: the next {@link DetectState} to remember, plus what
 * (if anything) to push to the renderer's `applyScreenState`.
 *
 * `emit` is a three-way signal — deliberately NOT just `TaskState`:
 *   - a `TaskState`  → set the session's dot to this;
 *   - `null`         → CLEAR the screen-derived state (revert the dot to the
 *                      legacy activity heuristic) — used when a recognized agent
 *                      exits back to a plain shell;
 *   - `undefined`    → no change worth sending (suppress IPC chatter).
 */
export interface DetectOutcome {
  state: DetectState
  emit: TaskState | null | undefined
  /**
   * The decision trace (T12 `explain`) — present whenever a manifest claimed the
   * pane, `undefined` for an unrecognized pane. Backs the tuning log: which agent,
   * which resolved screen state, and the exact rule/pattern/line that fired (or
   * `null` when only the manifest `fallback` applied).
   */
  explain?: DetectExplain
}

/** Why a recognized pane resolved to its screen state — the `explain` trace. */
export interface DetectExplain {
  agent: string
  screen: ScreenState
  /** The rule/pattern/line that fired, or `null` when the fallback applied. */
  match: ManifestMatch | null
}

/** A fresh, never-seen detector state. */
export const INITIAL_DETECT_STATE: DetectState = { lines: [], taskState: null, agent: null }

/**
 * Pick the first manifest (in registry order) that CLAIMS this pane, or `null`
 * when none recognize it (e.g. a plain bash shell). Registry order is the
 * precedence — builtins first, an override that re-declares an agent having
 * replaced the builtin upstream in `manifest-load-core`.
 */
export function classifyManifest(
  title: string | null,
  lines: string[],
  manifests: readonly CompiledManifest[],
  process: string | null = null
): CompiledManifest | null {
  for (const manifest of manifests) {
    if (paneMatchesManifest(title, lines, manifest, process)) return manifest
  }
  return null
}

/**
 * Fold one screen snapshot into the next detector state + the dot update to
 * emit. Pure + deterministic (clock injected as `now`).
 *
 * The order, and why each step is here:
 *  1. NORMALIZE — `extractBottomLines` gives a stable bottom slice so a spinner
 *     repaint doesn't read as a screen change.
 *  2. CLASSIFY — does any manifest claim this pane? An unrecognized pane that we
 *     PREVIOUSLY recognized reverts (emit `null`); one we never recognized is a
 *     silent no-op (don't touch a plain shell's heuristic dot).
 *  3. MATCH → MERGE → STICK — resolve the screen state, map it onto `TaskState`
 *     (`blocked → needs-input`), and hold a blocked pane until the screen really
 *     changes.
 *  4. DIFF — only emit when the resolved `TaskState` actually differs from what
 *     we last emitted, so identical frames cause no IPC.
 */
export function reduceDetect(
  prev: DetectState,
  snapshot: ScreenSnapshot,
  manifests: readonly CompiledManifest[],
  now: number
): DetectOutcome {
  const lines = extractBottomLines(snapshot.lines, BOTTOM_LINES)
  const manifest = classifyManifest(snapshot.title, lines, manifests, snapshot.process ?? null)

  // Unrecognized pane: revert a previously-set dot, else leave it alone.
  if (manifest === null) {
    if (prev.taskState !== null) {
      return { state: { lines, taskState: null, agent: null }, emit: null }
    }
    return { state: { lines, taskState: null, agent: null }, emit: undefined }
  }

  const screenChanged = linesChanged(prev.lines, lines)
  const ruleMatch = evaluateManifest(lines, manifest)
  const screen = ruleMatch?.state ?? manifest.fallback
  // method 'screen': folder terminals have no hooks — the scrape is sole truth.
  const merged = mergeState(null, screen, 'screen', now)
  const next = applyStickiness(prev.taskState ?? 'idle', merged, screenChanged)

  const state: DetectState = { lines, taskState: next, agent: manifest.agent }
  // Emit only on an actual change (covers a first sighting: prev.taskState null).
  const emit = next === prev.taskState ? undefined : next
  return { state, emit, explain: { agent: manifest.agent, screen, match: ruleMatch } }
}

/**
 * The bottom-N the renderer's snapshot is expected to carry / the orchestrator
 * re-clips to. Matches the default `scan.lines`; a manifest with a smaller
 * `scan.lines` clips further inside `matchManifest`.
 */
const BOTTOM_LINES = 30
