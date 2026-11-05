/**
 * The capacity watcher's decisions (autonomous cleanup U3.6), with every side effect injected.
 *
 * Docker hands out a bounded number of bridge-network address slots. When few are left, waiting for
 * the hourly cycle is too slow: one pass reads the free slots, and at or below the low-water mark
 * it frees capacity at once, one action at a time, re-reading after each — garbage first (empty
 * networks, orphan stacks), then the longest-idle eligible stacks, as `plan()` orders them — until
 * the free slots are above the mark. The planner's own rules (hourly pause cap, minimum age, idle
 * floor, Keep marks) are not bypassed here: when they leave nothing to free, that IS "nothing left
 * to free" and the operator is told, once per level, until capacity has recovered.
 *
 * Capacity that cannot be known (Docker Desktop, rootless, remote, an unreachable daemon) takes no
 * action and raises no notice. The Docker switch and the global pause make the pass do nothing at
 * all. It shares the machine-wide lock and the failure-streak kill switch with the hourly cycle.
 */

import type { BridgeCapacity } from '../containers/docker-capacity-core'
import type { DockerFactsResult } from '../containers/docker-facts-shell'
import { reportItemsOf, type DockerAction, type DockerOutcome } from './docker-cycle'
import type { CycleState } from './gc-cycle'
import type { GcPrefs } from './gc-prefs'
import type {
  CapacityNoticeState,
  DockerCapacityNotice,
  DockerCapacityView,
  DockerWatchRecord
} from './gc-wire'
import type { RepoLockResult } from './repo-lock-shell'

const NOTICE_TITLE = 'Workspace cleanup'
const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many)

/**
 * Which out-of-capacity notice, if any, this reading raises. `prev` is what was already said since
 * capacity was last above the mark: neither level repeats until it has recovered above it.
 */
export function nextCapacityNotice(
  prev: CapacityNoticeState,
  free: number,
  mark: number,
  nothingLeft: boolean
): { next: CapacityNoticeState; level: 'low' | 'zero' | null } {
  if (free > mark) return { next: 'none', level: null }
  if (!nothingLeft) return { next: prev, level: null }
  if (free === 0)
    return prev === 'zero' ? { next: prev, level: null } : { next: 'zero', level: 'zero' }
  return prev === 'none' ? { next: 'low', level: 'low' } : { next: prev, level: null }
}

export interface CapacityPassDeps {
  prefs(): GcPrefs
  /** `readBridgeCapacity` over the real docker. */
  readCapacity(): Promise<DockerFactsResult<BridgeCapacity>>
  /** The composed Docker planners: garbage first, then pauses. Never throws. */
  plan(): Promise<DockerAction[]>
  /** Runs one planned action. Never throws. */
  execute(a: DockerAction): Promise<DockerOutcome>
  /** One Docker slot at a time on the machine, across Harnu instances. */
  lock<T>(work: () => Promise<T>): Promise<RepoLockResult<T>>
  /** The kill switch: persists `docker.enabled = false`. */
  disableDocker(): Promise<void>
  /** The OS notification. */
  notify(n: { title: string; body: string }): void
  now(): number
}

type Reading = { view: DockerCapacityView; free: number | null; total: number }

function reading(r: DockerFactsResult<BridgeCapacity>): Reading {
  if (!r.ok) {
    const reason =
      r.error.kind === 'docker-unavailable'
        ? 'Docker is not reachable.'
        : `Docker capacity could not be read (${r.error.message}).`
    return { view: { known: false, reason }, free: null, total: 0 }
  }
  const c = r.value
  if (!c.known) return { view: { known: false, reason: c.reason }, free: null, total: 0 }
  return {
    view: { known: true, total: c.total, used: c.used, free: c.free, source: c.source },
    free: c.free,
    total: c.total
  }
}

function noticeBody(level: 'low' | 'zero', free: number, total: number): string {
  if (level === 'zero') {
    return `Docker has no free network slot left (0 of ${total}) and nothing is left for Cleanup to free on its own. The next compose up will fail with "could not find an available, non-overlapping IPv4 address pool". Stop a stack you do not need.`
  }
  return `Docker is nearly out of network slots: ${free} of ${total} free, and nothing is left for Cleanup to free on its own. Stop a stack you do not need before starting another.`
}

export async function runCapacityPass(
  deps: CapacityPassDeps,
  state: CycleState,
  trigger: DockerWatchRecord['trigger']
): Promise<DockerWatchRecord> {
  const prefs = deps.prefs()
  const cfg = prefs.docker
  const mark = cfg.lowWaterSlots
  const record: DockerWatchRecord = {
    at: deps.now(),
    trigger,
    mode: cfg.firstReportAcknowledged ? 'act' : 'report',
    mark,
    capacity: null,
    pressure: false,
    found: 0,
    acted: 0,
    refused: 0,
    failed: 0,
    deferred: 0,
    locked: false,
    paused: false,
    pausedReason: null,
    nothingLeft: false,
    items: [],
    notice: null
  }
  const done = (): DockerWatchRecord => {
    state.dockerWatch = record
    return record
  }

  // The global pause beats the switch, like the cycle: both act on, and read, nothing.
  if (prefs.pauseAutonomous) {
    record.mode = 'paused'
    return done()
  }
  if (!cfg.enabled) {
    record.mode = 'off'
    return done()
  }

  let now = reading(await deps.readCapacity())
  record.capacity = now.view
  // Unknown is not "recovered": no action, no notice, and a notice already given stays given.
  if (now.free === null) return done()
  if (now.free > mark) {
    state.dockerCapacityNotice = 'none'
    return done()
  }
  record.pressure = true

  const locked = await deps.lock(async () => {
    const actions = await deps.plan()
    record.found = actions.length

    if (!cfg.firstReportAcknowledged) {
      record.items = reportItemsOf(actions)
      record.nothingLeft = actions.length === 0
      return
    }

    const allowed = actions.slice(0, cfg.maxPerCycle)
    record.deferred = actions.length - allowed.length
    let lastFailure = ''
    let attempted = 0
    let recovered = false
    let unreadable = false
    for (const a of allowed) {
      if (state.dockerStreak >= cfg.failureLimit) break
      attempted++
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
        console.warn('[gc] capacity watcher: docker action failed', a.kind, a.id, outcome.reason)
      }
      now = reading(await deps.readCapacity())
      record.capacity = now.view
      if (now.free === null) {
        unreadable = true
        break
      }
      if (now.free > mark) {
        recovered = true
        break
      }
    }

    const killed = state.dockerStreak >= cfg.failureLimit
    if (!recovered && !unreadable) record.deferred += allowed.length - attempted
    if (killed) {
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
    // Nothing left that Cleanup may free: the whole plan was tried (or the kill switch stopped
    // the pass) and capacity is still at or below the mark. A pass the cap cut short is not that.
    record.nothingLeft =
      !recovered &&
      !unreadable &&
      (killed || (attempted === allowed.length && record.deferred === 0))
    if (record.acted > 0) {
      deps.notify({
        title: NOTICE_TITLE,
        body: `Docker was low on network slots: Cleanup handled ${record.acted} ${plural(record.acted, 'item')} right away. Volumes were kept.`
      })
    }
  })

  if (!locked.ok) {
    record.locked = true
    return done()
  }

  if (now.free !== null && now.free > mark) {
    state.dockerCapacityNotice = 'none'
    return done()
  }
  if (now.free !== null && record.nothingLeft) {
    const { next, level } = nextCapacityNotice(state.dockerCapacityNotice, now.free, mark, true)
    state.dockerCapacityNotice = next
    if (level) {
      const notice: DockerCapacityNotice = { level, free: now.free, total: now.total, mark }
      record.notice = notice
      deps.notify({ title: NOTICE_TITLE, body: noticeBody(level, now.free, now.total) })
    }
  }
  return done()
}
