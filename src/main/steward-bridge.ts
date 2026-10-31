/**
 * Campaign ch.5a (T597) — the real dependencies of the steward's hook routes, and the two pieces
 * of boot wiring: answering the hook bridge's `/steward/…` endpoint, and reconciling stewards
 * once the bridge is up.
 *
 * Kept apart from `hook-bridge.ts` (which imports no mission code) and `steward-shell.ts` (which
 * `mcp/tool-handlers.ts` imports): this file may import both, so there is no cycle.
 */

import * as path from 'node:path'
import { addTaskEventObserver, setStewardRouteHandler } from './hook-bridge'
import {
  deriveMissionSignals,
  loadMission,
  missionRoot,
  missionTitle,
  readAllMissions,
  recordMissionCompaction
} from './mcp/tool-handlers'
import { listStewards, wakeStewardForMission } from './scheduler-shell'
import { reconcileStewards } from './steward-shell'
import { handleStewardRoute, type StewardRouteDeps } from './steward-routes'

const GATES_WAIT_MS = 4000

/** The real deps: stewarded missions come from the store, gates from the same derive the pill reads. */
export function stewardRouteDeps(): StewardRouteDeps {
  return {
    stewardedMissions: async (cwd) => {
      const root = missionRoot(cwd)
      const stewarded = new Set(listStewards().map((s) => s.missionId))
      return (await readAllMissions(root)).missions
        .filter((m) => stewarded.has(m.mission.id))
        .map((m) => ({ mission: m.mission, title: missionTitle(m.log, m.mission.slug) }))
    },
    gatesFor: async (mission) => {
      const root = missionRoot(mission.folder)
      const loaded = await loadMission(root, mission.id)
      if (!loaded.ok) return undefined
      const derive = deriveMissionSignals(
        root,
        loaded.mission,
        loaded.log,
        { folder: root, folders: [], denyFolders: [], bridge: undefined },
        Date.now(),
        { prWaitMs: 1500, mainCiWaitMs: 1500 }
      )
      // A SessionStart hook must come back fast: the brief prints without gates if the derive is slow.
      const { derived } = await Promise.race([
        derive,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('gates timed out')), GATES_WAIT_MS)
        )
      ])
      return Object.fromEntries(
        derived.steps.map((s) => {
          const { pr, ci, main, verifier, checks } = s.gates
          return [s.stepId, { pr, ci, main, verifier, checks }]
        })
      )
    },
    recordCompaction: recordMissionCompaction,
    wake: wakeStewardForMission
  }
}

/**
 * Answer the hook bridge's steward routes, and wake a steward when a session it supervises goes
 * idle. The per-folder `Stop`/`SubagentStop` hooks cover the folder they are installed in (the
 * owner's); this observer covers a child running in ANOTHER worktree, where no steward hook is
 * installed, from the global observer hooks every session already has.
 */
export function registerStewardWiring(): () => void {
  const deps = stewardRouteDeps()
  setStewardRouteHandler((route, body) => handleStewardRoute(route, body, deps))
  const off = addTaskEventObserver((ev) => {
    if (ev.event !== 'Stop') return
    const roots = [...new Set(listStewards().map((s) => path.resolve(s.folder)))]
    for (const cwd of roots) {
      void handleStewardRoute('wake', { session_id: ev.sessionId, cwd }, deps)
    }
  })
  return () => {
    off()
    setStewardRouteHandler(null)
  }
}

/** Boot: re-point every steward's hooks at the live bridge and retire the ones whose mission closed. */
export function reconcileStewardsOnBoot(): Promise<void> {
  return reconcileStewards(async (folder, missionId) => {
    const loaded = await loadMission(missionRoot(folder), missionId)
    if (!loaded.ok) return 'unknown'
    return loaded.mission.status === 'closed' ? 'closed' : 'open'
  })
}
