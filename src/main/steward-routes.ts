/**
 * Campaign ch.5a (T597, spec §3.7 + Amendment b) — what the steward's three installed hooks do when
 * Claude Code fires them. Pure: the mission store, the gate derive, the ledger writer and the
 * steward wake are all injected (`steward-bridge.ts` supplies the real ones), so the rules — who
 * gets a brief, who wakes whom — are plain tests.
 *
 * Every route fails soft. A hook runs inside someone's Claude session; the worst it may ever do is
 * print nothing.
 */

import { buildMissionBrief } from './steward-hooks'
import type { WakeReason } from './steward-core'
import type { Mission } from './mission-core'

export type StewardRoute = 'brief' | 'precompact' | 'wake'
export const STEWARD_ROUTES: readonly StewardRoute[] = ['brief', 'precompact', 'wake']

export interface StewardRouteDeps {
  /** Open missions (with a steward) of the repo `cwd` belongs to, with their titles. */
  stewardedMissions(cwd: string): Promise<Array<{ mission: Mission; title: string }>>
  /** Best-effort gates per step id; may throw or return `undefined` (the brief prints without them). */
  gatesFor(mission: Mission): Promise<Record<string, Record<string, string>> | undefined>
  /** The compaction ledger row (Amendment b): `recordMissionCompaction`. */
  recordCompaction(folder: string, sessionId: string): Promise<void>
  wake(missionId: string, reason: WakeReason): Promise<unknown>
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Run one hook route. Returns the text the hook prints (empty for every route but `brief`). */
export async function handleStewardRoute(
  route: StewardRoute,
  body: Record<string, unknown>,
  deps: StewardRouteDeps
): Promise<string> {
  const sessionId = str(body.session_id ?? body.sessionId)
  const cwd = str(body.cwd)
  try {
    switch (route) {
      case 'brief': {
        // SessionStart fires for every start; only a compaction needs the brief, and only for a
        // session that OWNS a stewarded mission (a child must not be handed its owner's state).
        if (!sessionId || !cwd || str(body.source) !== 'compact') return ''
        const owned = (await deps.stewardedMissions(cwd)).filter(
          (m) => m.mission.owner.sessionId === sessionId && m.mission.status !== 'closed'
        )
        const briefs: string[] = []
        for (const { mission, title } of owned) {
          const gates = await deps.gatesFor(mission).catch(() => undefined)
          briefs.push(buildMissionBrief({ mission, title, ...(gates ? { gates } : {}) }))
        }
        return briefs.join('\n\n')
      }
      case 'precompact': {
        if (sessionId && cwd) await deps.recordCompaction(cwd, sessionId)
        return ''
      }
      case 'wake': {
        if (!sessionId || !cwd) return ''
        for (const { mission } of await deps.stewardedMissions(cwd)) {
          if (mission.status === 'closed') continue
          const isChild = mission.steps.some((s) =>
            s.links.some((l) => l.kind === 'session' && l.ref === sessionId)
          )
          if (isChild) await deps.wake(mission.id, 'child-idle')
        }
        return ''
      }
    }
  } catch (err) {
    console.warn(`[steward] ${route} hook failed (printing nothing):`, err)
  }
  return ''
}
