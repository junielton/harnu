// The Docker slot of the cleanup cycle (autonomous cleanup U3.1, design §4 U3, §5, C1).
//
// Every tick, after the clean and the shelve slot: plan what Docker could do on its own (pause idle
// stacks, remove empty compose networks and orphan stacks) and, once the operator has seen a report,
// do it. The slot has its OWN switch and its OWN report-only first cycle (`prefs.docker`), so an
// operator who already runs the autopilot or shelving gets nothing new until they have seen what it
// would take.
//
// THIS UNIT ONLY LAYS THE FOUNDATION: the planner is empty and plans nothing. U3.3 (garbage) and
// U3.5 (eligibility) fill `plan`; U3.4 fills `execute`. What is already real is everything around
// them (§5): the global pause, the report-only branch, a per-cycle cap, a failure-streak kill switch
// that says why, and one lock for the whole slot that holds across Harnu instances (Docker is one
// daemon per machine, so the lock is machine-wide, not per repository).
//
// Every effect is an injected dep, so the slot is unit-tested with fakes in
// tests/gc-docker-cycle.test.ts.

import type { CycleState } from './gc-cycle'
import type { GcPrefs } from './gc-prefs'
import type { DockerCycleRecord } from './gc-wire'
import type { RepoLockResult } from './repo-lock-shell'

const NOTICE_TITLE = 'Workspace cleanup'
const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many)

/** One thing Docker autonomy decided to do. "park" is the code word for what the UI calls "Paused". */
export interface DockerAction {
  kind: 'park' | 'prune-network' | 'remove-orphan'
  /** Stable id of the stack or network, the key the failure streak and the journal use. */
  id: string
  /** One sentence for the digest. */
  reason: string
}

/**
 * What running one action came to. A `refusal` is the world having moved since the decision (the
 * re-probe disagreed) or a limit being reached; it is not a failure of Docker autonomy.
 */
export type DockerOutcome = { ok: true } | { ok: false; reason: string; refusal?: boolean }

export interface DockerCycleDeps {
  prefs(): GcPrefs
  /** What Docker could do right now. Empty in U3.1. */
  plan(): Promise<DockerAction[]>
  /** Runs one decided action, bound to the facts it was decided on. Never throws. */
  execute(a: DockerAction): Promise<DockerOutcome>
  /** One Docker slot at a time on the machine, across Harnu instances (`--user-data-dir`). */
  lock<T>(work: () => Promise<T>): Promise<RepoLockResult<T>>
  /** The kill switch: persists `docker.enabled = false`. */
  disableDocker(): Promise<void>
  notify(n: { title: string; body: string }): void
  now(): number
}

const empty = (mode: DockerCycleRecord['mode']): DockerCycleRecord => ({
  mode,
  found: 0,
  acted: 0,
  refused: 0,
  failed: 0,
  deferred: 0,
  locked: false,
  paused: false,
  pausedReason: null
})

export async function runDockerCycle(
  deps: DockerCycleDeps,
  state: CycleState
): Promise<DockerCycleRecord> {
  const prefs = deps.prefs()
  // The global pause beats the switch: it acts on nothing and changes no acknowledgement.
  if (prefs.pauseAutonomous) return empty('paused')
  if (!prefs.docker.enabled) return empty('off')

  const locked = await deps.lock(() => runLocked(deps, state, prefs))
  if (!locked.ok)
    return { ...empty(prefs.docker.firstReportAcknowledged ? 'act' : 'report'), locked: true }
  return locked.value
}

async function runLocked(
  deps: DockerCycleDeps,
  state: CycleState,
  prefs: GcPrefs
): Promise<DockerCycleRecord> {
  const cfg = prefs.docker
  const actions = await deps.plan()

  if (!cfg.firstReportAcknowledged) {
    const key = String(actions.length)
    if (actions.length > 0 && key !== state.dockerReportKey) {
      deps.notify({
        title: NOTICE_TITLE,
        body: `${actions.length} Docker ${plural(actions.length, 'item')} would be cleaned (stacks paused, never removed with their volumes). Open Settings → Cleanup to review and acknowledge.`
      })
    }
    state.dockerReportKey = key
    return { ...empty('report'), found: actions.length }
  }
  state.dockerReportKey = null

  const record: DockerCycleRecord = {
    ...empty('act'),
    found: actions.length,
    deferred: Math.max(0, actions.length - cfg.maxPerCycle)
  }
  let lastFailure = ''
  for (const a of actions.slice(0, cfg.maxPerCycle)) {
    if (state.dockerStreak >= cfg.failureLimit) break
    const outcome = await deps.execute(a)
    if (outcome.ok) {
      state.dockerStreak = 0
      record.acted++
    } else if (outcome.refusal) {
      record.refused++
    } else {
      record.failed++
      state.dockerStreak++
      lastFailure = outcome.reason
      console.warn('[gc] docker action failed', a.kind, a.id, outcome.reason)
    }
  }

  if (state.dockerStreak >= cfg.failureLimit) {
    record.paused = true
    record.pausedReason = `${cfg.failureLimit} ${plural(cfg.failureLimit, 'failure')} in a row (last: ${lastFailure})`
    state.dockerStreak = 0
    try {
      await deps.disableDocker()
    } catch (err) {
      console.warn(
        '[gc] could not switch Docker autonomy off',
        err instanceof Error ? err.message : err
      )
    }
    deps.notify({
      title: NOTICE_TITLE,
      body: `Docker cleanup paused itself after ${record.pausedReason}. Nothing was lost: volumes are never removed. Turn it back on in Settings → Cleanup once the cause is fixed.`
    })
  }
  if (record.acted > 0) {
    deps.notify({
      title: NOTICE_TITLE,
      body: `Docker cleanup handled ${record.acted} ${plural(record.acted, 'item')}. Volumes were kept.`
    })
  }
  return record
}
