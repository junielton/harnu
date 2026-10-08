import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  ContainersActErrorCode,
  ContainersActRequest,
  ContainersActResult,
  ContainersNewZombiesAlert,
  ContainersSnapshot,
  ContainersTombstone,
  StackRow
} from '../../../preload'
import { i18n } from '../i18n'
import { toIpc } from '../lib/to-ipc'
import { useNotificationsStore } from './notifications'
import { isNeedsYou, sweepTargets } from '../components/containers-format'

/**
 * Containers takeover — renderer store (T331). A thin cache over U1's
 * `window.api.containers*` IPC (T330): the last snapshot, the one action in
 * flight, and the per-stack failures the detail pane shows. It never derives a
 * verdict or decides what an action may touch — the main process owns both
 * (PRD §5, §7.4) and refuses anything its tiers forbid.
 */

type ActVerb = ContainersActRequest['verb']

/** The action in flight. The main process serializes actions, so there is one at a time. */
export interface PendingAction {
  verb: ActVerb
  bulk: boolean
  /** Stacks the action targets (for a bulk stop: every running "Needs you" stack). */
  stacks: string[]
  /** Per stack: the containers the action has to move ("Stopping… N of M"). */
  baseline: Record<string, string[]>
}

/** Why the last action on a stack did not fully succeed (the detail's error note). */
export interface ActFailure {
  verb: ActVerb
  /** `failed` = docker itself failed; `refused` = a tier refused it; `request` = it never ran. */
  kind: 'failed' | 'refused' | 'request'
  code: ContainersActErrorCode | null
  /** Docker's own error text, or main's message. */
  message: string | null
  /** Containers the action did move before it failed, of `total`. */
  done: number
  total: number
}

/** How long after a progress scan resolves the next one starts, while an action runs. */
export const PROGRESS_POLL_MS = 1500

/** How many stack names the new-zombie entry spells out before "+N more". */
const ALERT_NAMES = 3

/**
 * T332: a quiet notification-center entry (no toast, no sound), like the
 * Reaper's harvestable alert. Main decides WHEN — once per stack, only while
 * the pref is on; this only words it. A click opens the takeover.
 */
function recordNewZombies(alert: ContainersNewZombiesAlert): void {
  const { t } = i18n.global
  const extra = alert.names.length - ALERT_NAMES
  const names =
    alert.names.slice(0, ALERT_NAMES).join(', ') +
    (extra > 0 ? ` ${t('containers.newZombies.more', { n: extra })}` : '')
  useNotificationsStore().notify({
    ts: Date.now(),
    source: 'app',
    kind: 'info',
    title: t('containers.newZombies.title', alert.count),
    description: t('containers.newZombies.body', { names }),
    target: { view: 'containers' }
  })
}

function baselineFor(verb: ActVerb, stack: StackRow): string[] {
  if (verb === 'stop') return stack.containers.filter((c) => c.running).map((c) => c.id)
  if (verb === 'start') return stack.containers.filter((c) => !c.running).map((c) => c.id)
  // remove and sweep both take every container the stack has: a sweep stops the
  // running ones first, so none of them survives it either (T341).
  return stack.containers.map((c) => c.id)
}

/** A stack's containers and their run state; a recorded failure goes stale once this moves. */
function stateKey(stack: StackRow | null): string {
  if (!stack) return ''
  return stack.containers
    .map((c) => `${c.id}:${c.running ? 1 : 0}`)
    .sort()
    .join('|')
}

function targetsOf(req: ContainersActRequest, snap: ContainersSnapshot | null): string[] {
  if (req.verb === 'remove') return [req.stack]
  if (req.verb === 'sweep') {
    // Display only: main picks the real set — every zombie and orphan, running
    // or exited — and a sweep request carries no stack list at all (T340). The
    // operator's selection narrows it (T342), so the progress count covers what
    // was ticked and nothing else.
    if (!snap?.dockerAvailable) return []
    const eligible = sweepTargets(snap.stacks).map((s) => s.id)
    return req.only ? eligible.filter((id) => req.only!.includes(id)) : eligible
  }
  if (req.verb === 'stop' && req.bulk) {
    // Display only: main picks the real set and ignores `stacks` under `bulk`.
    if (!snap?.dockerAvailable) return []
    return snap.stacks.filter((s) => s.running && isNeedsYou(s.verdict)).map((s) => s.id)
  }
  return [...(req.stacks ?? [])]
}

export const useContainersStore = defineStore('containers', () => {
  const snapshot = ref<ContainersSnapshot | null>(null)
  const scanning = ref(false)
  const pending = ref<PendingAction | null>(null)
  const failures = ref<Record<string, ActFailure>>({})
  /** Per failed stack: its `stateKey` when the failure was recorded. */
  const failedAt = new Map<string, string>()

  let unsubUpdate: (() => void) | null = null
  let unsubNewZombies: (() => void) | null = null
  let polling = false

  const available = computed(() => (snapshot.value?.dockerAvailable ? snapshot.value : null))
  const stacks = computed<StackRow[]>(() => available.value?.stacks ?? [])
  const needsYou = computed(() => stacks.value.filter((s) => isNeedsYou(s.verdict)))
  const leaveAlone = computed(() => stacks.value.filter((s) => !isNeedsYou(s.verdict)))
  const recent = computed<ContainersTombstone[]>(() => snapshot.value?.recent ?? [])
  /** The footer pill's count: zombie + orphan stacks. 0 before the first scan. */
  const needsYouCount = computed(() => available.value?.totals.needsYou ?? 0)

  function stackById(id: string): StackRow | null {
    return stacks.value.find((s) => s.id === id) ?? null
  }

  /**
   * A failure describes its stack as it was when the action failed. Once a
   * scan shows the stack moved (a container started, stopped or went), the
   * note and its "Try again" no longer describe it, so they go.
   */
  function dropMovedFailures(): void {
    const stale = Object.keys(failures.value).filter(
      (id) => stateKey(stackById(id)) !== failedAt.get(id)
    )
    if (stale.length === 0) return
    const next = { ...failures.value }
    for (const id of stale) {
      delete next[id]
      failedAt.delete(id)
    }
    failures.value = next
  }

  function setSnapshot(snap: ContainersSnapshot): void {
    snapshot.value = snap
    dropMovedFailures()
  }

  /** Idempotent: re-subscribes instead of double-subscribing (the footer and the view both call it). */
  async function init(): Promise<void> {
    unsubUpdate?.()
    unsubUpdate = window.api.onContainersUpdate(setSnapshot)
    unsubNewZombies?.()
    unsubNewZombies = window.api.onContainersNewZombies(recordNewZombies)
    const snap = await window.api.containersSnapshot()
    // A push that landed while the request was in flight is at least as fresh.
    if (snap && !snapshot.value) setSnapshot(snap)
  }

  async function scanNow(): Promise<void> {
    if (scanning.value) return
    scanning.value = true
    try {
      setSnapshot(await window.api.containersScan())
    } finally {
      scanning.value = false
    }
  }

  /** The view's open: scan once when no background scan has produced a snapshot yet. */
  async function ensureScanned(): Promise<void> {
    if (!snapshot.value) await scanNow()
  }

  /**
   * Rescans while a stop/start runs, so the detail can show which containers
   * are already down. Each scan starts after the previous one resolves; the
   * pushed snapshot (`containers:update`) is what updates the view.
   */
  async function pollProgress(): Promise<void> {
    if (polling) return
    polling = true
    try {
      // A stop, a start and a sweep all move while they run; a single removal
      // resolves in one docker call, so there is nothing to watch.
      while (pending.value && pending.value.verb !== 'remove') {
        await new Promise((resolve) => setTimeout(resolve, PROGRESS_POLL_MS))
        if (!pending.value) break
        await window.api.containersScan().catch(() => undefined)
      }
    } finally {
      polling = false
    }
  }

  function recordFailures(
    req: ContainersActRequest,
    targets: string[],
    result: ContainersActResult,
    baseline: Record<string, string[]>
  ): void {
    const next = { ...failures.value }
    const put = (id: string, failure: ActFailure): void => {
      next[id] = failure
      failedAt.set(id, stateKey(stackById(id)))
    }
    if (result.error) {
      for (const id of targets) {
        put(id, {
          verb: req.verb,
          kind: 'request',
          code: result.error,
          message: result.message ?? null,
          done: 0,
          total: baseline[id]?.length ?? 0
        })
      }
    }
    for (const r of result.results) {
      if (r.ok) continue
      put(r.stack, {
        verb: req.verb,
        kind: r.error === 'DOCKER_FAILED' ? 'failed' : 'refused',
        code: r.error ?? null,
        message: r.message ?? null,
        done: r.containerIds.length,
        total: baseline[r.stack]?.length ?? r.containerIds.length
      })
    }
    failures.value = next
  }

  /**
   * THE action entry point for the view. Returns null when another action is
   * still in flight (main would queue it; the UI does not let it pile up).
   */
  async function act(req: ContainersActRequest): Promise<ContainersActResult | null> {
    if (pending.value) return null
    const snap = available.value
    const targets = targetsOf(req, snapshot.value)
    const baseline: Record<string, string[]> = {}
    for (const id of targets) {
      const stack = snap?.stacks.find((s) => s.id === id)
      if (stack) baseline[id] = baselineFor(req.verb, stack)
    }

    const cleared = { ...failures.value }
    for (const id of targets) {
      delete cleared[id]
      failedAt.delete(id)
    }
    failures.value = cleared

    pending.value = {
      verb: req.verb,
      bulk: req.verb === 'stop' && req.bulk === true,
      stacks: targets,
      baseline
    }
    void pollProgress()
    try {
      // Plain data only past this line: the IPC clones it (BUG-141).
      const result = await window.api.containersAct(toIpc(req))
      recordFailures(req, targets, result, baseline)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const next = { ...failures.value }
      for (const id of targets) {
        next[id] = {
          verb: req.verb,
          kind: 'request',
          code: null,
          message,
          done: 0,
          total: baseline[id]?.length ?? 0
        }
        failedAt.set(id, stateKey(stackById(id)))
      }
      failures.value = next
      return null
    } finally {
      pending.value = null
    }
  }

  return {
    snapshot,
    scanning,
    pending,
    failures,
    available,
    stacks,
    needsYou,
    leaveAlone,
    recent,
    needsYouCount,
    stackById,
    init,
    scanNow,
    ensureScanned,
    act
  }
})
