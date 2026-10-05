import type { Session } from './sessions'

/**
 * Haiku auto-name (T25 wave 3) — extracted from the `sessions.ts` god-store as
 * an injectable composable. A cheap-AI background enricher keyed off the
 * `onSessionUpdated` stream. (T177 retired the live-session-pulse half this
 * module used to share a home with; this file is now auto-name only.)
 *
 * Impure orchestration (owns `window.api.haikuAutoname`, its own in-flight
 * state) — a composable factory, not a pure core. Cross-cutting state is
 * injected (DI): `findSessionById` (to write `aiSummary` onto the live row)
 * and the store-owned `bornSyntheticIds` set (auto-name only fires for
 * born-synthetic rows and clears the mark on success). The read-fresh
 * `haikuAutoname` toggle stays read-fresh here (a T24 follow-up, per that
 * plan's exclusions).
 */

/** localStorage key for the Haiku auto-name toggle. Default OFF (absent → false). */
const HAIKU_AUTONAME_KEY = 'om2tab.haikuAutoname'
function loadAutonameEnabled(): boolean {
  try {
    return localStorage.getItem(HAIKU_AUTONAME_KEY) === 'true'
  } catch {
    return false
  }
}

/** The cross-cutting store state the auto-name concern needs (injected). */
export interface SessionAutonameDeps {
  /** The session row by id, or null — mutated in place (`aiSummary`). */
  findSessionById: (sessionId: string) => Session | null
  /** Store-owned set of ids that were born synthetic (shared by reference). */
  bornSyntheticIds: Set<string>
}

/** The auto-name surface {@link useSessionAutoname} returns. */
export interface SessionAutoname {
  maybeAutoname: (s: Session) => void
}

/** Build the Haiku auto-name concern over injected store state. */
export function useSessionAutoname(deps: SessionAutonameDeps): SessionAutoname {
  const { findSessionById, bornSyntheticIds } = deps

  const autonameInFlight = new Set<string>()

  /**
   * Auto-name a freshly-real synthetic from its first prompt via Haiku (cheap-AI
   * substrate). Fires once per session, only for born-synthetic rows, only when
   * the global toggle is on and there is no custom/ai title yet. `autonameInFlight`
   * stops a burst of `onSessionUpdated` events from double-spawning. Writes
   * `aiSummary` (never `summary`, which a `/rename` owns); no-op + retry-later
   * while `firstPrompt` is still empty. Never gates on age (lesson 001).
   */
  function maybeAutoname(s: Session): void {
    if (autonameInFlight.has(s.sessionId)) return
    if (!loadAutonameEnabled()) return
    if (!bornSyntheticIds.has(s.sessionId)) return
    if (s.summary) return
    if (s.aiSummary) return
    const firstUserText = s.firstPrompt.trim()
    if (!firstUserText) return

    const id = s.sessionId
    autonameInFlight.add(id)
    void window.api
      .haikuAutoname({ sessionId: id, firstUserText })
      .then((r) => {
        if (r.ok && (r.title || r.summary)) {
          const cur = findSessionById(id)
          if (cur) cur.aiSummary = { title: r.title ?? '', summary: r.summary ?? '' }
          bornSyntheticIds.delete(id)
        }
      })
      .catch(() => {
        /* never-throw service; row keeps the firstPrompt fallback */
      })
      .finally(() => autonameInFlight.delete(id))
  }

  return { maybeAutoname }
}
