/**
 * Mission progress store (T370; Mission v3 S3 — design.md §6 "Mission progress").
 *
 * Holds every open mission of the repos the sidebar knows, as `mission:list`
 * projects it, and derives one {@link MissionModel} per mission so the Topbar
 * pill, the popover and the sidebar chip read the same answer. Read-only
 * except {@link runDoor} — the operator's doors, the only writes the mission UI
 * makes.
 *
 * Polled, not pushed: the derived block (live children, the stall verdict) is
 * time-dependent, so a file watcher alone would still leave it stale. One poll
 * every {@link POLL_MS}, plus an immediate refresh on demand (popover open).
 *
 * Doors answer with the view they changed (Mission v3 §3.2): the store patches
 * that one mission, or removes it when an end returns `view: null` — at once,
 * with nothing waiting on a list refresh. A refresh still follows in the
 * background, and a poll that STARTED before a door landed is discarded, so a
 * stale list can never resurrect an ended mission or undo a tick.
 *
 * Each poll also decides the owed-to-operator cue (Mission v3 §3.12,
 * `lib/mission-cue.ts`): chime + OS attention + one Activity entry when a
 * mission's owed list gains a kind or a count grows, re-nudged every 30 min.
 * The poll is its only clock — no per-mission timer.
 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { MissionDoor, MissionDoorResult, MissionView } from '../../../main/mission-ipc'
import { i18n } from '../i18n'
import { decideCue, firstOwed, type CueMemory } from '../lib/mission-cue'
import { buildMissionModel, missionForSession, type MissionModel } from '../lib/mission-view'
import { playNotificationSound } from '../lib/notification-sound'
import { useNotificationsStore } from './notifications'
import { useSessionsStore } from './sessions'
import { useUiStore } from './ui'

const POLL_MS = 20_000

/** What the operator owes, as the cue's `{what}`: the first owed item in words. */
function owedWhat(view: MissionView): string {
  const { t } = i18n.global
  const item = firstOwed(view)
  switch (item?.kind) {
    case 'blocker':
      return item.reason
    case 'rescope':
      return t('mission.state.rescopePending')
    case 'close':
      return t('mission.state.delivered')
    case 'checks':
      return t(
        'mission.you.checks',
        { count: item.count, steps: stepTitles(view, item.stepIds) },
        item.count
      )
    case 'human-steps':
      return t(
        'mission.you.humanSteps',
        { steps: stepTitles(view, item.stepIds) },
        item.stepIds.length
      )
    case 'review-import':
      return t('mission.you.reviewImport')
    default:
      return t('mission.state.needsYou')
  }
}

function stepTitles(view: MissionView, ids: readonly string[]): string {
  return ids.map((id) => view.mission.steps.find((s) => s.id === id)?.title || id).join(', ')
}

/** The cue's one Activity entry — one mission names itself and opens its owner session. */
function postMissionActivity(missionIds: readonly string[], views: readonly MissionView[]): void {
  const { t } = i18n.global
  const cued = views.filter((v) => missionIds.includes(v.mission.id))
  if (cued.length === 0) return
  const [only] = cued
  useNotificationsStore().notify(
    cued.length === 1
      ? {
          ts: Date.now(),
          source: 'app',
          kind: 'warning',
          title: t('mission.cue.one', { title: only.title, what: owedWhat(only) }),
          sessionId: only.mission.owner.sessionId
        }
      : {
          ts: Date.now(),
          source: 'app',
          kind: 'warning',
          title: t('mission.cue.many', { n: cued.length }),
          description: cued.map((v) => v.title).join(' · ')
        }
  )
}

export const useMissionsStore = defineStore('missions', () => {
  const sessions = useSessionsStore()
  const views = shallowRef<MissionView[]>([])
  /** Wall clock of the last refresh — the stale callout's "now". */
  const refreshedAt = ref(Date.now())
  /** Doors awaiting their answer — a count, so overlapping doors keep the controls disabled. */
  const doorsInFlight = ref(0)
  const doorInFlight = computed(() => doorsInFlight.value > 0)
  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<void> | null = null
  let cueMemory: CueMemory = { owed: new Map(), primed: false }
  /** Bumped by every door that took effect: a list read started before it is stale. */
  let writeSeq = 0

  async function load(): Promise<void> {
    const folders = sessions.folders.map((f) => f.path)
    const startedAt = writeSeq
    try {
      const res = await window.api.missionList(folders)
      // A door landed while this read was in flight: its list predates the
      // write. The read the door scheduled supplies the truth.
      if (startedAt !== writeSeq) return
      views.value = res.views
      refreshedAt.value = Date.now()
      const decision = decideCue(res.views, cueMemory, Date.now())
      cueMemory = decision.memory
      if (decision.cue) {
        playNotificationSound()
        void window.api.requestAttention()
        postMissionActivity(decision.missionIds, res.views)
      }
    } catch {
      // A failed read keeps the last good list — the surfaces never flash empty.
    }
  }

  /** Refresh now; concurrent callers share one round-trip. */
  function refresh(): Promise<void> {
    inFlight ??= load().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  /**
   * A read that STARTS after this call — joining a poll already in flight would
   * hand back the list read before the write landed.
   */
  async function refreshAfterWrite(): Promise<void> {
    if (inFlight) await inFlight
    await refresh()
  }

  /** Start polling once; later calls are no-ops. */
  function ensureStarted(): void {
    if (timer) return
    void refresh()
    timer = setInterval(() => void refresh(), POLL_MS)
  }

  const models = computed(() => {
    const out = new Map<string, MissionModel>()
    for (const v of views.value) out.set(v.mission.id, buildMissionModel(v, refreshedAt.value))
    return out
  })

  /** The open mission this session owns, or `null` (no-mission — nothing renders). */
  function viewForSession(sessionId: string | null | undefined): MissionView | null {
    return missionForSession(views.value, sessionId)
  }

  function modelForSession(sessionId: string | null | undefined): MissionModel | null {
    const v = viewForSession(sessionId)
    return v ? (models.value.get(v.mission.id) ?? null) : null
  }

  /**
   * Apply a door's answer to the mission it changed — only if the store still
   * holds it (a slow re-derive may land after a concurrent end removed it).
   */
  function applyDoorResult(door: MissionDoor, view: MissionView | null): void {
    const i = views.value.findIndex((v) => v.mission.id === door.missionId)
    if (i === -1) return
    if (view) {
      if (view.mission.id !== door.missionId) return
      views.value = views.value.map((v, k) => (k === i ? view : v))
    } else if (door.door === 'end') {
      views.value = views.value.filter((_, k) => k !== i)
    }
    // Any other door answering `view: null` means its re-derive failed after the
    // write landed — keep the old view; the background refresh brings the new one.
  }

  /**
   * Run one operator door. The answer patches (or removes) that one mission at
   * once; a refusal or an IPC failure raises a danger toast and comes back as
   * `{ ok: false }` — never a throw. An end refused `MISSION_CLOSED` is silent:
   * the mission is closed, as asked. A background refresh follows; nothing waits on it.
   */
  async function runDoor(door: MissionDoor): Promise<MissionDoorResult> {
    doorsInFlight.value++
    let res: MissionDoorResult
    try {
      res = await window.api.missionOperatorDoor(door)
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      doorsInFlight.value--
    }
    if (res.ok) {
      writeSeq++
      applyDoorResult(door, res.view)
      void refreshAfterWrite()
    } else if (door.door === 'end' && res.error.startsWith('MISSION_CLOSED')) {
      // Ending a mission that is already closed (a double Close, or another
      // window got there first) is what the operator asked for: drop it if it
      // is still held, and stay silent — no red toast for a done deed.
      writeSeq++
      applyDoorResult(door, null)
      void refreshAfterWrite()
    } else {
      useUiStore().pushToast({
        kind: 'danger',
        title: i18n.global.t('mission.doorFailed'),
        description: res.error
      })
    }
    return res
  }

  return {
    views,
    refreshedAt,
    doorInFlight,
    refresh,
    ensureStarted,
    viewForSession,
    modelForSession,
    runDoor
  }
})
