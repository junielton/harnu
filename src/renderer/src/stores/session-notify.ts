import type { TaskState } from '../../../preload'
import type { SoundFamily } from '../lib/notification-sound'

/**
 * Pure decision logic for OS notifications (os-notifications spec §4).
 *
 * The store routes every task-state transition through `decideNotification`,
 * which is the single place that decides whether a native notification fires
 * and of what kind. No electron, no i18n, no localStorage — just the truth
 * table — so it is trivially unit-testable and the imperative shell (store +
 * `src/main/notifications.ts`) stays thin.
 */

/** The three meaningful end-states worth a notification (never working/idle/stopped). */
export type NotifyKind = 'needs-input' | 'completed' | 'failed'

/**
 * Where a fired notification is shown. Focus-aware (os-notifications spec §4):
 * `toast` when the Harnu window is focused (the user is *in* the app, so an
 * in-app toast is the right, non-intrusive surface), `os` when it is not (a
 * native OS notification to pull the user back to a background session).
 */
export type NotifyChannel = 'toast' | 'os'

/**
 * The outcome of `decideNotification`: WHICH kind, on WHICH channel, and whether
 * to also play the chime. `null` (from `decideNotification`) means "stay quiet".
 */
export interface NotifyDecision {
  kind: NotifyKind
  channel: NotifyChannel
  /** Play the packaged chime? Suppressed for the session you're staring at. */
  sound: boolean
}

/** User preferences: a master switch plus a per-state opt-out, plus the usage-reset opt-in. */
export interface NotifyPrefs {
  enabled: boolean
  needsInput: boolean
  completed: boolean
  failed: boolean
  /**
   * Play a sound when a notification is shown. Orthogonal to the per-state flags. The master for EVERY
   * sound call site (session events, the Approval Inbox, the mission cue, the changelog): off means silent.
   */
  sound: boolean
  /**
   * Per-family mutes under the `sound` master (T154), default all on. A muted family stays silent
   * everywhere it would have played: `ask` (needs input, an approval, a blocking mission cue), `done`
   * (a turn ended), `fail` (a session failed, `main` is red), `info` (reviews, usage, budget, a new version).
   */
  soundAsk: boolean
  soundDone: boolean
  soundFail: boolean
  soundInfo: boolean
  /**
   * Notify when the fleet-wide 5h rate-limit window resets (usage-reset-notify
   * spec). Opt-IN — unlike the other flags, default false: this fires roughly
   * every 5h once enabled, more ambient/recurring than a per-session alert.
   */
  usageReset: boolean
  /**
   * Notify when the daily budget crosses 80% / 100% (daily-budget spec).
   * Default ON — unlike `usageReset` this fires at most twice a day, and the
   * alert is the whole point of the feature rather than an ambient status ping.
   */
  dailyBudget: boolean
}

/**
 * Maps each notify-kind to its per-state preference flag. As a
 * `Record<NotifyKind, …>` it is exhaustive by construction — adding a
 * `NotifyKind` forces an entry here (and so into `NOTIFY_STATES` below).
 */
const PREF_KEY: Record<NotifyKind, keyof NotifyPrefs> = {
  'needs-input': 'needsInput',
  completed: 'completed',
  failed: 'failed'
}

/**
 * The notify-states, DERIVED from `PREF_KEY` so completeness is enforced by the
 * compiler: a new `NotifyKind` can never silently fall out of this set (which
 * would make it never notify). Order is `PREF_KEY` insertion order.
 */
export const NOTIFY_STATES: readonly NotifyKind[] = Object.keys(PREF_KEY) as NotifyKind[]

/** Opt-out defaults — everything on, except usageReset (opt-in, see its doc comment). */
export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  enabled: true,
  needsInput: true,
  completed: true,
  failed: true,
  sound: true,
  soundAsk: true,
  soundDone: true,
  soundFail: true,
  soundInfo: true,
  usageReset: false,
  dailyBudget: true
}

/** The sound family a session notify-kind plays (T154): it asks, it finished, it broke. */
export const NOTIFY_KIND_FAMILY: Record<NotifyKind, SoundFamily> = {
  'needs-input': 'ask',
  completed: 'done',
  failed: 'fail'
}

/** Which `NotifyPrefs` flag mutes each family. */
const SOUND_PREF_KEY: Record<SoundFamily, keyof NotifyPrefs> = {
  ask: 'soundAsk',
  done: 'soundDone',
  fail: 'soundFail',
  info: 'soundInfo'
}

/**
 * May this family play? The `sound` master AND the family's own mute (T154). Every sound call site asks
 * this, so with the master off nothing anywhere plays and a muted family is silent at every call site.
 */
export function soundAllowed(prefs: NotifyPrefs, family: SoundFamily): boolean {
  return prefs.sound && prefs[SOUND_PREF_KEY[family]]
}

/** Everything `decideNotification` needs beyond the transition itself. */
export interface NotifyDecisionCtx {
  prefs: NotifyPrefs
  /** Is the transitioning session the currently-selected one? */
  isSelected: boolean
  /** Is the app window currently focused? */
  windowFocused: boolean
}

function isNotifyKind(s: TaskState): s is NotifyKind {
  return (NOTIFY_STATES as readonly string[]).includes(s)
}

/**
 * Decide whether a task-state transition should raise a notification, on what
 * channel, and whether to chime. First falsy condition wins → `null`. See spec
 * §4 + the task-complete spec §4 for the rules:
 *   1. edge only (prev === next never fires),
 *   2. classify the kind: a genuine turn-end (`working → idle`) is a `completed`
 *      notification (the `Stop` hook keeps the FSM resting state at `idle`, so the
 *      sidebar dot / attentionCount / badge stay unchanged); every other edge keeps
 *      its own target state as the kind. Non-notify targets ⇒ `null`,
 *   3. master + per-state prefs,
 *   4. route by focus: focused → in-app `toast`, not focused → native `os`
 *      notification. We no longer *suppress* the selected session (it still gets
 *      a toast so you know its turn ended) — but we skip the CHIME when you're
 *      focused AND it's the selected session, so the thing in front of you
 *      doesn't beep on every turn. Background sessions still chime.
 */
export function decideNotification(
  prev: TaskState,
  next: TaskState,
  ctx: NotifyDecisionCtx
): NotifyDecision | null {
  if (prev === next) return null
  const kind: NotifyKind | null =
    prev === 'working' && next === 'idle' ? 'completed' : isNotifyKind(next) ? next : null
  if (!kind) return null
  if (!ctx.prefs.enabled) return null
  if (!ctx.prefs[PREF_KEY[kind]]) return null
  const channel: NotifyChannel = ctx.windowFocused ? 'toast' : 'os'
  const staringAtIt = ctx.windowFocused && ctx.isSelected
  return {
    kind,
    channel,
    sound: soundAllowed(ctx.prefs, NOTIFY_KIND_FAMILY[kind]) && !staringAtIt
  }
}

/**
 * Parse a stored `NotifyPrefs` blob (localStorage `om2tab.notify`). Missing /
 * corrupt / non-object input falls back to `DEFAULT_NOTIFY_PREFS`; a partial
 * object fills the rest from defaults (forward-compatible); values are coerced
 * to booleans so a stray `1`/`0` can't poison the prefs.
 */
export function parseNotifyPrefs(raw: string | null): NotifyPrefs {
  if (!raw) return { ...DEFAULT_NOTIFY_PREFS }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_NOTIFY_PREFS }
  }
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_NOTIFY_PREFS }
  const o = parsed as Record<string, unknown>
  const pick = (key: keyof NotifyPrefs): boolean =>
    key in o ? Boolean(o[key]) : DEFAULT_NOTIFY_PREFS[key]
  return {
    enabled: pick('enabled'),
    needsInput: pick('needsInput'),
    completed: pick('completed'),
    failed: pick('failed'),
    sound: pick('sound'),
    soundAsk: pick('soundAsk'),
    soundDone: pick('soundDone'),
    soundFail: pick('soundFail'),
    soundInfo: pick('soundInfo'),
    usageReset: pick('usageReset'),
    dailyBudget: pick('dailyBudget')
  }
}
