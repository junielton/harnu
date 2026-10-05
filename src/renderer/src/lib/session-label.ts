/**
 * The one name a session shows on every surface (BUG-78 slice 2, spec §5.3).
 *
 * Before this module ~20 call sites each built a session's name with their own
 * cascade — only some included the Haiku title, one the teammate rule, three
 * resolved the fork placeholder independently — and the topbar/sidebar split
 * is what hid BUG-78 for two months. Every surface now calls `sessionTitle`
 * and appends only its own empty fallback:
 *
 *   sessionTitle(s, sessions.allSessions, t) || <surface fallback>
 *
 * `tests/session-label-guard.test.ts` fails when a new surface hand-rolls a
 * cascade instead. Pure: `t` is injected (components pass `useI18n().t`, the
 * store passes `i18n.global.t`) and nothing is imported from `stores/` — the
 * sessions store imports this module, so the reverse would be a cycle.
 */

/** The structural subset of a renderer `Session` that naming reads. */
export interface SessionLike {
  sessionId: string
  summary?: string
  firstPrompt?: string
  aiSummary?: { title: string }
  teamName?: string
  agentName?: string
  synthetic?: boolean
  forkSourceId?: string
}

export type Translate = (key: string, params?: Record<string, unknown>) => string

/** Fork-synthetic predicate; generic so the store's wrapper keeps its narrowing. */
export function isForkSyntheticLike<T extends SessionLike>(
  s: T
): s is T & { synthetic: true; forkSourceId: string } {
  return s.synthetic === true && typeof s.forkSourceId === 'string' && s.forkSourceId.length > 0
}

/** Trimmed value, or '' for absent / whitespace-only. */
function clean(v: string | undefined): string {
  return v?.trim() ?? ''
}

/**
 * The name a session has of its own: a teammate's agent name (only when
 * `teamName` is set — BUG-78: the CLI's `agent-name` rename line is not
 * teammate identity), else `summary` → Haiku `aiSummary.title` → first prompt.
 */
function ownName(s: SessionLike): string {
  return teammateName(s) || clean(s.summary) || clean(s.aiSummary?.title) || clean(s.firstPrompt)
}

/** A T99 teammate's agent name, or '' for anything that is not a teammate. */
function teammateName(s: SessionLike): string {
  return clean(s.teamName) ? clean(s.agentName) : ''
}

/**
 * The name a session shows everywhere, or '' when it has none yet.
 *
 * 1. teammate (`teamName` + `agentName`) → `agentName`;
 * 2. fork synthetic → "Fork of <source's own name>" — depth 1: the source is
 *    named by rule 1/4 only, never by its own fork branch — else "Untitled";
 * 3. plain synthetic → "New session" (returned here, not '', so a surface can
 *    tell a fresh synthetic from a real but nameless session);
 * 4. `summary` → `aiSummary.title` → `firstPrompt`, each trimmed.
 *
 * Never returns the session id: a surface that wants it as a fallback appends
 * it itself (the spoken notification must never read it out — BUG-129).
 */
export function sessionTitle(
  s: SessionLike,
  sessions: readonly SessionLike[],
  t: Translate
): string {
  const mate = teammateName(s)
  if (mate) return mate
  if (isForkSyntheticLike(s)) {
    const source = sessions.find((x) => x.sessionId === s.forkSourceId)
    const summary = (source && ownName(source)) || t('session.unnamed')
    return t('session.forkPlaceholder', { summary })
  }
  if (s.synthetic === true) return t('session.newPlaceholder')
  return ownName(s)
}
