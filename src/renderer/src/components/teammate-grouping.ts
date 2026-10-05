/**
 * Agent-teams teammate grouping (T99 — design.md "Teammate group (sidebar)").
 * A teammate session carries `teamName`/`agentName` (from claude-reader) and, on
 * its own, would show up in the flat session list with a garbled raw label. This
 * module pulls teammates out of an already-sorted session list and re-attaches
 * them under their team LEAD's row (found by sessionId prefix). When no lead is
 * found anywhere in the folder, the group is orphaned and its teammates are
 * hidden — except one currently selected, which stays visible as a flat row so
 * an open session never disappears out from under the operator (T168).
 *
 * The lead lookup deliberately searches a WIDER pool than the rows being built
 * (`leaderCandidates`, defaults to `sorted`): a lead's own activity typically
 * goes idle the moment it dispatches its team, so if the lookup were confined to
 * the display-filtered `sorted` list, the lead would drop out from under its own
 * team as soon as it aged past the sidebar's session window — even though its
 * session still exists, in the same folder, right where its teammates are. When
 * a lead is found only in the wider pool (not already a row in `sorted`), its
 * row is INJECTED at its first teammate's position so the group still has
 * something to nest under.
 *
 * Pure + framework-free — `sortSessions` stays untouched; this runs on its
 * output, never inside it, so the sidebar's sort preference and the teammate
 * grouping are two independent, individually-testable concerns.
 */

type TeamSession = {
  sessionId: string
  teamName?: string
}

/** One flat row the sidebar renders. */
export interface SidebarSessionRow<T extends TeamSession> {
  session: T
}

export interface SessionRows<T extends TeamSession> {
  /** In display order — teammates with a present lead are omitted (nested instead);
   *  teammates with no lead anywhere are omitted too, unless selected (T168). */
  rows: SidebarSessionRow<T>[]
  /** Lead sessionId -> its teammates, for rendering nested under that lead's row. */
  teammatesByLeader: Map<string, T[]>
}

/**
 * `session-<8 hex>` -> the bare hex, or `''` for an unrecognized shape.
 * Exported: `sessions.ts#activateSession` (BUG-31) needs the same lead-hex
 * derivation to find a teammate's group key — importing this keeps the two
 * lookups from silently diverging (`docs/lessons/code-patterns/003`).
 */
export function teamHex(teamName: string): string {
  return teamName.startsWith('session-') ? teamName.slice('session-'.length) : teamName
}

/**
 * Re-shape an already-sorted session list into display rows, pulling teammates
 * out of the flat run and attaching them to their lead.
 *
 * A team's lead is the first non-teammate session in `leaderCandidates` whose
 * `sessionId` starts with the team's hex suffix — i.e. a session in the SAME
 * folder. `leaderCandidates` defaults to `sorted` but is normally passed
 * separately (the full, non-age-filtered folder session list) so a lead that
 * has aged out of the display window is still found. Three outcomes:
 *   - Lead found IN `sorted` — unchanged: teammates nest under its existing row.
 *   - Lead found only in `leaderCandidates` — its row is INJECTED into `rows`
 *     at the position of its first teammate, so the group still has a home.
 *   - Lead not found anywhere — the group is orphaned and its teammates are
 *     hidden from `rows`, except one whose `sessionId` matches `selectedId`
 *     (T168 — a selected session must never vanish from the sidebar).
 */
export function buildSessionRows<T extends TeamSession>(
  sorted: T[],
  leaderCandidates: T[] = sorted,
  selectedId?: string | null
): SessionRows<T> {
  const teammatesByTeam = new Map<string, T[]>()
  for (const s of sorted) {
    if (!s.teamName) continue
    const arr = teammatesByTeam.get(s.teamName)
    if (arr) arr.push(s)
    else teammatesByTeam.set(s.teamName, [s])
  }

  const leaderByTeam = new Map<string, T>()
  for (const teamName of teammatesByTeam.keys()) {
    const hex = teamHex(teamName)
    const leader = leaderCandidates.find(
      (s) => !s.teamName && hex.length > 0 && s.sessionId.startsWith(hex)
    )
    if (leader) leaderByTeam.set(teamName, leader)
  }

  const sortedIds = new Set(sorted.map((s) => s.sessionId))
  const rows: SidebarSessionRow<T>[] = []
  const teammatesByLeader = new Map<string, T[]>()
  const injectedLeaderForTeam = new Set<string>()

  for (const s of sorted) {
    if (s.teamName) {
      const leader = leaderByTeam.get(s.teamName)
      if (leader) {
        // Lead exists but sat outside `sorted` (aged out of the display
        // window) — inject its row here, at its first teammate's position,
        // so the group has somewhere to nest.
        if (!sortedIds.has(leader.sessionId) && !injectedLeaderForTeam.has(s.teamName)) {
          injectedLeaderForTeam.add(s.teamName)
          rows.push({ session: leader })
        }
        continue // rendered nested under the lead row (existing or injected)
      }
      // Orphaned group (no lead anywhere in the folder) — hide the teammate,
      // unless it's the one currently selected. `labelFor` already resolves
      // `agentName` for a teammate rendered as a flat row (T99), so this reads
      // fine outside its usual nested/grouped zones.
      if (s.sessionId === selectedId) rows.push({ session: s })
      continue
    }
    rows.push({ session: s })
  }

  // Second pass: attach each lead's teammates (done separately from the loop
  // above so a lead can be found regardless of where it sits relative to its
  // teammates in `sorted`).
  for (const [teamName, leader] of leaderByTeam) {
    teammatesByLeader.set(leader.sessionId, teammatesByTeam.get(teamName) ?? [])
  }

  return { rows, teammatesByLeader }
}

/**
 * Teammate-select guard (T99 — design.md "Active teammate guard"). A
 * teammate whose live activity is `working` may be under the team lead's
 * direction right now; a `claude --resume` opened on it locally would be a
 * second writer on the same JSONL. Only `working` warrants the friction —
 * `stuck`/`idle` (and anything else) open straight through.
 */
export function shouldConfirmTeammateSelect(activity: 'working' | 'stuck' | 'idle'): boolean {
  return activity === 'working'
}
