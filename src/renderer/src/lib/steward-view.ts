/**
 * Campaign ch.5b (T609, spec §3.4) — what the renderer shows of a mission's steward. A steward is a
 * SYSTEM worker (`category: 'steward'`, bound to a mission): it never lives among the user's workers,
 * and every number here is read off the runs the Scheduler recorded — nothing is estimated.
 *
 * Pure (no Vue), so it unit-tests in the node environment like `scheduler-list.ts`.
 */
import type { Run, Worker } from '../../../preload'

/** A steward worker: the category AND its mission binding (the store keeps them together). */
export function isSteward(w: Worker): boolean {
  return w.category === 'steward' && typeof w.missionId === 'string'
}

/** User workers on one side, mission stewards on the other. */
export function splitWorkers(workers: readonly Worker[]): { users: Worker[]; stewards: Worker[] } {
  const users: Worker[] = []
  const stewards: Worker[] = []
  for (const w of workers) (isSteward(w) ? stewards : users).push(w)
  return { users, stewards }
}

/** The steward bound to `missionId`, if the Scheduler has one. */
export function stewardForMission(
  workers: readonly Worker[],
  missionId: string
): Worker | undefined {
  return workers.find((w) => isSteward(w) && w.missionId === missionId)
}

/** The first non-empty line of `text`, cut to `max` characters with an ellipsis; `null` for nothing. */
export function firstLine(text: string, max = 140): string | null {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '')
  if (!line) return null
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

export interface StewardSummary {
  workerId: string
  missionId: string
  folder: string
  /** Epoch ms the last tick started; `null` before the first one. */
  lastWakeAt: number | null
  /** The last tick's one-line result; `null` when it had none (no run, or it failed). */
  lastAction: string | null
  running: boolean
}

/** One steward as its row and its line draw it. `runs` arrive oldest-first, as the store keeps them. */
export function summarizeSteward(
  worker: Worker,
  runs: readonly Run[],
  running: boolean
): StewardSummary {
  const last = runs[runs.length - 1]
  return {
    workerId: worker.id,
    missionId: worker.missionId ?? '',
    folder: worker.folder,
    lastWakeAt: last ? last.startedAt : null,
    lastAction: last && last.status === 'ok' ? firstLine(last.result) : null,
    running
  }
}
