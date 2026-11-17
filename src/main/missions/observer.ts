/**
 * Missions v4 S-3, S-40 (R-25, AC-4) — the observer's trigger: the one place a mission read is allowed to
 * cause a write, and never a read itself.
 *
 * What a pass does with a mission is the caller's (`mission-ipc.ts`: the v4 leg reads each record's facts
 * and stores the pull request, CI and session rows it saw beside the mission). This module only decides
 * WHEN a pass runs: shortly after start, every minute, and a few seconds after a linked session ends.
 * The v3 half of the observer (it derived a v3 mission and woke its steward) went with the v3 view and
 * the steward.
 */

/** `taskState`s of a session whose process has ended — they start an early pass. */
const SESSION_DEATH_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped'])

// ---- What drives the observer (S-3 delta 1) ------------------------------------------------

/** How often the observer looks at the open missions: the pull request cache's own lifetime. */
export const OBSERVER_INTERVAL_MS = 60_000
/** The first pass after start, so `mission_list` has progress soon after boot. */
export const OBSERVER_FIRST_PASS_MS = 10_000
/** A burst of ending sessions starts one pass, this long after the first of them. */
export const OBSERVER_EVENT_DEBOUNCE_MS = 3_000

export interface MissionObserverDeps {
  /** The folders whose open missions are observed; empty = nothing to do. */
  folders: () => Promise<readonly string[]>
  /**
   * One pass over the open missions of `folders` (only the ones linking `onlySessions`, when
   * given): derive each, then {@link observeMission}. Returns how many it observed.
   */
  pass: (
    folders: readonly string[],
    opts: { onlySessions?: ReadonlySet<string> }
  ) => Promise<number>
  /** The task-state hook events Harnu already receives; returns the unsubscribe. */
  onTaskEvent: (cb: (ev: { sessionId: string; taskState: string }) => void) => () => void
  intervalMs?: number
  firstPassMs?: number
  eventDebounceMs?: number
}

export interface MissionObserver {
  start(): void
  stop(): void
}

/**
 * The observer's trigger — never a read. One pass shortly after start, then one every
 * {@link OBSERVER_INTERVAL_MS}, and one a few seconds after a linked session ends (the task-state
 * events Harnu already receives; a burst coalesces into one pass for the sessions in it).
 * Passes never overlap: a tick that finds one running is dropped, the next tick covers it. With
 * no folder known nothing runs; a pass that finds no open mission reads the mission files and
 * stops there (no fleet scan, no derive).
 */
export function createMissionObserver(deps: MissionObserverDeps): MissionObserver {
  const intervalMs = deps.intervalMs ?? OBSERVER_INTERVAL_MS
  const firstPassMs = deps.firstPassMs ?? OBSERVER_FIRST_PASS_MS
  const debounceMs = deps.eventDebounceMs ?? OBSERVER_EVENT_DEBOUNCE_MS
  let interval: ReturnType<typeof setInterval> | null = null
  let first: ReturnType<typeof setTimeout> | null = null
  let soon: ReturnType<typeof setTimeout> | null = null
  let unsubscribe: (() => void) | null = null
  let running = false
  let stopped = true
  const ended = new Set<string>()

  async function run(onlySessions?: ReadonlySet<string>): Promise<void> {
    if (running || stopped) return
    running = true
    try {
      const folders = await deps.folders()
      if (folders.length === 0) return
      await deps.pass(folders, onlySessions ? { onlySessions } : {})
    } catch (err) {
      console.warn('[mission-observer] pass failed:', err)
    } finally {
      running = false
    }
  }

  return {
    start(): void {
      if (!stopped) return
      stopped = false
      first = setTimeout(() => void run(), firstPassMs)
      first.unref?.()
      interval = setInterval(() => void run(), intervalMs)
      interval.unref?.()
      unsubscribe = deps.onTaskEvent((ev) => {
        if (!SESSION_DEATH_STATES.has(ev.taskState)) return
        ended.add(ev.sessionId)
        if (soon) return
        soon = setTimeout(() => {
          soon = null
          const sessions = new Set(ended)
          ended.clear()
          void run(sessions)
        }, debounceMs)
        soon.unref?.()
      })
    },
    stop(): void {
      stopped = true
      if (first) clearTimeout(first)
      if (interval) clearInterval(interval)
      if (soon) clearTimeout(soon)
      first = interval = soon = null
      unsubscribe?.()
      unsubscribe = null
      ended.clear()
    }
  }
}
