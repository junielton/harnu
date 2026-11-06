/**
 * The pause planner and executor behind the Docker slot (autonomous cleanup U3.5, design §4 U3
 * "Park", C1, §5). It gathers the facts the pure rules in `park-eligibility-core.ts` need, plans
 * the pauses, and runs each one through U3.4's `pauseStack` as the `autopilot`.
 *
 * Every effect is an injected dep (the containers service, U3.2's activity read, the browser
 * panes, the connection probe), so the planner is unit-tested with fakes in
 * tests/gc-park-cycle.test.ts. The slot's report-only first cycle, the per-cycle cap, the global
 * pause and the failure-streak kill switch belong to `docker-cycle.ts`; this file only says what
 * is a refusal (the world moved, a rule said no) and what is a failure (docker or the journal broke).
 */

import type { StackActivity } from '../containers/docker-activity-core'
import type { ContainersSnapshot, Tombstone } from '../containers/containers-wire'
import { isPausableVerdict, type PauseDecision, type PauseOutcome } from '../containers/park-core'
import { isProtectedNow } from './autopilot-core'
import type { WorktreeBundle } from './bundle-core'
import type { DockerAction, DockerOutcome, DockerPlanner } from './docker-cycle'
import type { GcPrefs } from './gc-prefs'
import { pauseActivityLine, planPauses, type ParkCandidate } from './park-eligibility-core'

export interface ParkPlannerDeps {
  prefs(): GcPrefs
  /** The latest gathered worktree bundles (sessions, Keep marks, shared stacks). */
  bundles(): readonly WorktreeBundle[]
  /** A fresh containers snapshot; null when the containers service is not running. */
  snapshot(): Promise<ContainersSnapshot | null>
  /** The containers journal, newest first; null when it could not be read. */
  journal(): Promise<Tombstone[] | null>
  /** U3.2's CPU/IO read per compose project; null when it could not be taken. */
  activity(): Promise<StackActivity[] | null>
  /** Addresses of the open Harnu browser panes. */
  paneUrls(): string[]
  /** Established host connections per local port; null when the probe could not tell. */
  established(): Promise<Map<number, number> | null>
  /** `getContainersService().pause`: serialized with every other docker action. */
  pause(decision: PauseDecision, actor: 'autopilot'): Promise<PauseOutcome>
  /** One line in the operator's Activity history. */
  activityLine(n: { title: string; body: string }): void
  now(): number
}

/** The two outcomes that mean docker or the journal broke; everything else is a refusal. */
const FAILURES = new Set(['DOWN_FAILED', 'JOURNAL_FAILED'])

/**
 * A refusal is the world having moved since the decision, or a rule saying no: it is reported and
 * never counts toward the kill switch. Only a failed `down` or a failed journal write is a failure.
 */
export function pauseOutcomeToDocker(o: PauseOutcome): DockerOutcome {
  if (o.ok) return { ok: true }
  if (FAILURES.has(o.code)) return { ok: false, reason: o.message }
  return { ok: false, reason: o.message, refusal: true }
}

interface Decided {
  decision: PauseDecision
  name: string
  idleMs: number
}

export function createParkPlanner(deps: ParkPlannerDeps): DockerPlanner {
  // What the last `plan()` decided. An action is executed from its own decision, once.
  let decided = new Map<string, Decided>()

  const plan = async (): Promise<DockerAction[]> => {
    decided = new Map()
    const cfg = deps.prefs().docker
    const snap = await deps.snapshot()
    if (!snap || !snap.dockerAvailable) return []
    const journal = await deps.journal()
    // Without the journal the hourly cap cannot be counted, so nothing is planned.
    if (journal === null) return []

    const bundles = deps.bundles()
    const linked = (stackId: string): WorktreeBundle[] =>
      bundles.filter((b) => b.stackIds.includes(stackId) || b.sharedStackIds.includes(stackId))
    // A stack with no gathered worktree behind it has marks Cleanup cannot see: it is left alone.
    const stacks = snap.stacks.filter(
      (s) =>
        s.kind === 'compose' && s.running && isPausableVerdict(s.verdict) && linked(s.id).length > 0
    )
    if (stacks.length === 0) return []

    const [activity, established] = await Promise.all([deps.activity(), deps.established()])
    const paneUrls = deps.paneUrls()
    const prefs = deps.prefs()

    const candidates: ParkCandidate[] = stacks.map((stack) => {
      const owners = linked(stack.id)
      return {
        stack,
        sessions: owners.map((b) => b.session),
        protectedMark: owners.some((b) => isProtectedNow(b, prefs)),
        activity:
          activity === null || stack.project === null
            ? null
            : (activity.find((a) => a.project === stack.project) ?? null),
        paneUrls,
        established:
          established === null
            ? null
            : stack.ports.reduce((sum, port) => sum + (established.get(port) ?? 0), 0),
        decision: {
          stack: stack.id,
          containerIds: stack.containers.map((c) => c.id),
          verdict: stack.verdict
        }
      }
    })

    const result = planPauses({
      candidates,
      journal,
      now: deps.now(),
      idleHours: cfg.idleHours,
      minAgeMinutes: cfg.minAgeMinutes,
      maxParksPerHour: cfg.maxParksPerHour
    })
    return result.pauses.map((p) => {
      const stack = stacks.find((s) => s.id === p.decision.stack)
      decided.set(p.decision.stack, {
        decision: { ...p.decision, idle: p.reason },
        name: stack?.name ?? p.decision.stack,
        idleMs: p.idleMs
      })
      return { kind: 'park', id: p.decision.stack, reason: p.reason }
    })
  }

  const execute = async (a: DockerAction): Promise<DockerOutcome> => {
    const d = decided.get(a.id)
    if (!d || a.kind !== 'park') {
      return { ok: false, reason: 'this stack was not planned for pausing', refusal: true }
    }
    decided.delete(a.id)
    let outcome: PauseOutcome
    try {
      outcome = await deps.pause(d.decision, 'autopilot')
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    // The stack is down in both cases below: the way back is told even when the journal failed.
    const record = outcome.ok
      ? outcome.record
      : outcome.code === 'JOURNAL_FAILED'
        ? outcome.record
        : undefined
    if (record) {
      deps.activityLine(
        pauseActivityLine({
          name: d.name,
          idleMs: d.idleMs,
          restoreCommand: record.restoreCommand
        })
      )
    }
    return pauseOutcomeToDocker(outcome)
  }

  return { owns: (kind) => kind === 'park', plan, execute }
}
