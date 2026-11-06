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
 * action and raises no notice. The Docker switch and the global pause stop every ACTION (nothing is
 * planned or run), but the out-of-capacity heads-up is a warning, not an action: it still reads
 * capacity and raises the same notices with the same no-repeat rule, saying that Cleanup is not
 * acting. It shares the machine-wide lock and the failure-streak kill switch with the hourly cycle.
 */

import type { BridgeCapacity } from '../containers/docker-capacity-core'
import type { DockerFactsResult } from '../containers/docker-facts-shell'
import {
  heldDockerReport,
  reportItemsOf,
  type DockerAction,
  type DockerOutcome
} from './docker-cycle'
import type { CycleState } from './gc-cycle'
import type { DockerAutonomyPrefs, GcPrefs } from './gc-prefs'
import type {
  CapacityNoticeState,
  DockerCapacityNotice,
  DockerCapacityView,
  DockerWatchRecord
} from './gc-wire'
import type { RepoLockResult } from './repo-lock-shell'

const NOTICE_TITLE = 'Workspace cleanup'

/**
 * While capacity sits at or below the mark and a full plan found nothing to free, the 30 s timer
 * does not plan again for this long: the planner's inputs (how long a stack has been idle) move with
 * the clock, so it is re-checked now and then, but a network event, a change in the free slots or in
 * the settings plans at once.
 */
export const WATCH_BACKOFF_MS = 10 * 60_000

/** What the planner would see: the free slots and every setting that changes its answer. */
function planKeyOf(free: number, cfg: DockerAutonomyPrefs, mark: number, prefs: GcPrefs): string {
  // The pause planner protects a worktree by its Keep mark or a never-clean path (`isProtectedNow`):
  // clearing either changes its answer, so both are part of the key (presence and path, not fate).
  const marks = [Object.keys(prefs.keep).sort().join('\n'), [...prefs.neverClean].sort().join('\n')]
  return [
    free,
    cfg.firstReportAcknowledged,
    mark,
    cfg.maxPerCycle,
    cfg.idleHours,
    cfg.minAgeMinutes,
    cfg.maxParksPerHour,
    cfg.failureLimit,
    ...marks
  ].join('|')
}

/** Drops the notices the renderer has recorded; the rest keep waiting for it. */
export function ackWatchNotices(state: CycleState, ats: readonly number[]): void {
  const gone = new Set(ats)
  state.dockerNoticesPending = state.dockerNoticesPending.filter((r) => !gone.has(r.at))
}
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

function noticeBody(
  level: 'low' | 'zero',
  free: number,
  total: number,
  autonomyOff: 'off' | 'paused' | undefined
): string {
  const why = autonomyOff
    ? ` Automatic cleanup is ${autonomyOff}, so nothing will be freed on its own.`
    : ' Nothing is left for Cleanup to free on its own.'
  if (level === 'zero') {
    return `Docker has no free network slot left (0 of ${total}).${why} The next compose up will fail with "could not find an available, non-overlapping IPv4 address pool". Stop a stack you do not need.`
  }
  return `Docker is nearly out of network slots: ${free} of ${total} free.${why} Stop a stack you do not need before starting another.`
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
    notice: null,
    report: null
  }
  const done = (): DockerWatchRecord => {
    record.report = heldDockerReport(state, prefs)
    state.dockerWatch = record
    return record
  }

  // The global pause beats the switch, like the cycle. Either one stops every action, but not the
  // heads-up: the mode stays `paused`/`off` while capacity and the notice are still filled.
  const autonomyOff: 'off' | 'paused' | undefined = prefs.pauseAutonomous
    ? 'paused'
    : !cfg.enabled
      ? 'off'
      : undefined
  if (autonomyOff) record.mode = autonomyOff

  let now = reading(await deps.readCapacity())
  record.capacity = now.view
  // Unknown is not "recovered": no action, no notice, and a notice already given stays given.
  if (now.free === null) return done()
  if (now.free > mark) {
    state.dockerCapacityNotice = 'none'
    state.dockerWatchIdle = null
    return done()
  }
  record.pressure = true

  // Not acting: nothing is planned, locked or run, so nothing is left that Cleanup will free.
  if (autonomyOff) record.nothingLeft = true
  // Back-off: a timer pass that would plan the very same thing as the last pass that found nothing
  // to free repeats that pass's answer without planning, locking or running anything.
  const idle = state.dockerWatchIdle
  const backedOff =
    !autonomyOff &&
    trigger === 'timer' &&
    idle !== null &&
    idle.key === planKeyOf(now.free, cfg, mark, prefs) &&
    deps.now() - idle.at < WATCH_BACKOFF_MS
  if (backedOff && idle) {
    record.found = idle.found
    record.refused = idle.refused
    record.failed = idle.failed
    record.items = idle.items
    record.nothingLeft = true
  }
  const locked: RepoLockResult<void> =
    autonomyOff || backedOff
      ? { ok: true, value: undefined }
      : await deps.lock(async () => {
          const actions = await deps.plan()
          record.found = actions.length

          if (!cfg.firstReportAcknowledged) {
            record.items = reportItemsOf(actions)
            // This pass planned: it is the newest list the operator acknowledges.
            state.dockerReport = {
              at: deps.now(),
              source: 'watcher',
              found: actions.length,
              items: record.items
            }
            record.nothingLeft = actions.length === 0
            return
          }

          state.dockerReport = null // acknowledged: the list it showed is spent
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
              console.warn(
                '[gc] capacity watcher: docker action failed',
                a.kind,
                a.id,
                outcome.reason
              )
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
    state.dockerWatchIdle = null
    return done()
  }
  if (!backedOff) {
    // A pass that planned and found nothing left starts the back-off; anything else ends it.
    state.dockerWatchIdle =
      !autonomyOff && now.free !== null && record.nothingLeft && !record.paused
        ? {
            key: planKeyOf(now.free, cfg, mark, prefs),
            at: deps.now(),
            found: record.found,
            refused: record.refused,
            failed: record.failed,
            items: record.items
          }
        : null
  }
  if (now.free !== null && record.nothingLeft) {
    const { next, level } = nextCapacityNotice(state.dockerCapacityNotice, now.free, mark, true)
    state.dockerCapacityNotice = next
    if (level) {
      const notice: DockerCapacityNotice = {
        level,
        free: now.free,
        total: now.total,
        mark,
        ...(autonomyOff ? { autonomyOff } : {})
      }
      record.notice = notice
      // The window may not exist yet (the boot pass): the notice waits until a renderer says it has it.
      state.dockerNoticesPending = [...state.dockerNoticesPending, record].slice(-10)
      deps.notify({
        title: NOTICE_TITLE,
        body: noticeBody(level, now.free, now.total, autonomyOff)
      })
    }
  }
  return done()
}
