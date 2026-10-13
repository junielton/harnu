import {
  PARK_TYPES_MAX,
  type ParkBusyReason,
  type ParkQueryData,
  type ParkSurface
} from '../contract'
import type { FleetSensorState } from './fleet-sensor'

/**
 * T456: the answer to `park.query` (spec §5.2), ported from `01-prototype.md` §P1. Pure and
 * `$`-free (MOD-1): `register.ts` reads `$.session.surfaces()` at ask time and hands it here with
 * the fleet sensor's kept state. Counts and type labels only (SEC-8).
 *
 * Every fact fails toward "less busy": a sensor that missed an event makes Harnu park as it does
 * today, never pins a session (spec §9.2).
 */

/** Hints, not orders: the host clamps every value (spec §6.2). */
export const RETRY_TURN_MS = 120_000
export const RETRY_PERMISSION_MS = 300_000

const SURFACES: ReadonlySet<string> = new Set<ParkSurface>([
  'terminal',
  'desktop',
  'mobile',
  'vscode'
])

export function answerParkQuery(
  fleet: FleetSensorState,
  surfaces: readonly unknown[]
): ParkQueryData {
  const busy: ParkBusyReason[] = []
  const hints: number[] = []
  if (fleet.activeTurnId !== null) {
    busy.push({ kind: 'turn' })
    hints.push(RETRY_TURN_MS)
  }
  // A dialog put to a person (`classic.PermissionRequest`), until its tool settles or the turn ends.
  const asks = fleet.open.filter((o) => o.kind === 'permission' && o.asked === true).length
  if (asks > 0) {
    busy.push({ kind: 'permission', count: asks })
    hints.push(RETRY_PERMISSION_MS)
  }
  // The CLI keeps a finished subagent listed as running in the next Stop: subtract the stopped ids,
  // including the ones that stopped after that Stop.
  const tasks = (fleet.idle?.tasks ?? []).filter(
    (t) => !(t.type === 'subagent' && fleet.stopped.includes(t.id))
  )
  const agents = tasks.filter((t) => t.type === 'subagent').length
  const others = tasks.filter((t) => t.type !== 'subagent')
  if (others.length > 0) {
    const types = [...new Set(others.map((t) => t.type))].slice(0, PARK_TYPES_MAX)
    busy.push({ kind: 'background-task', count: others.length, types })
  }
  if (agents > 0) busy.push({ kind: 'background-subagent', count: agents })
  const crons = fleet.idle?.crons ?? []
  if (crons.length > 0) {
    const recurring = crons.filter((c) => c.recurring).length
    busy.push({ kind: 'scheduled-wakeup', count: crons.length, recurring })
  }
  const remote = surfaces.filter(
    (s): s is ParkSurface => typeof s === 'string' && SURFACES.has(s) && s !== 'terminal'
  )
  if (remote.length > 0) busy.push({ kind: 'remote-surface', surfaces: [...new Set(remote)] })
  return hints.length > 0 ? { busy, retryAfterMs: Math.min(...hints) } : { busy }
}
