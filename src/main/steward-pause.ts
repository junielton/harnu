/**
 * Campaign ch.5b (T609, spec §3.4) — what the Scheduler asks before a steward ticks: has the
 * operator paused this mission's steward? The pause lives on the mission file (the operator's
 * "Pause steward…" door writes it), so the mission is the one source of truth and the You list,
 * the pill and the gate can never disagree.
 *
 * Imported lazily by `scheduler-shell.ts` (the mission store imports the Scheduler, not the other
 * way round), and only read: nothing here writes a mission.
 */

import { loadMission, missionRoot } from './mcp/tool-handlers'

/** The pause on `missionId` (read from the repo `folder` belongs to), or `null` when not paused / unreadable. */
export async function readStewardPause(
  folder: string,
  missionId: string
): Promise<{ reason: string } | null> {
  const loaded = await loadMission(missionRoot(folder), missionId)
  if (!loaded.ok) return null
  const pause = loaded.mission.stewardPause
  return pause ? { reason: pause.reason } : null
}
