/**
 * Which unit of work a session's notice belongs to (T599). The Activity history
 * folds repeated idle / task-finished notices of one unit into a single row, so
 * every notice needs a stable unit key: a mission step the session is linked to,
 * else the roadmap card it is bound to. A session in neither has no unit and is
 * never folded.
 *
 * Pure and structural on purpose — it reads only the fields it needs, so the
 * stores stay out of it and tests need no store setup.
 */

export interface NoticeUnitSources {
  /** Open missions, as `mission:list` projects them (`MissionView` subset). */
  views: ReadonlyArray<{
    mission: {
      id: string
      steps: ReadonlyArray<{
        id: string
        links: ReadonlyArray<{ kind: string; ref: string }>
      }>
    }
  }>
  /** Roadmap cards of the loaded board (`RoadmapCard` subset). */
  cards: ReadonlyArray<{ slug: string; session?: string }>
}

/** `step:<missionId>/<stepId>` or `card:<slug>`; `undefined` when the session has no unit. */
export function noticeUnitFor(sessionId: string, sources: NoticeUnitSources): string | undefined {
  if (!sessionId) return undefined
  for (const { mission } of sources.views) {
    for (const step of mission.steps) {
      if (step.links.some((l) => l.kind === 'session' && l.ref === sessionId)) {
        return `step:${mission.id}/${step.id}`
      }
    }
  }
  const card = sources.cards.find((c) => c.session === sessionId)
  return card ? `card:${card.slug}` : undefined
}
