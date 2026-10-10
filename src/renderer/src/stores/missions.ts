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
 * mission's owed list gains a kind or a count grows; blocking kinds are
 * re-nudged on a back-off, standing kinds never (BUG-173 S3, spec §3.2). The
 * cue memory is persisted (`om2tab.missionCues`), so a restart does not
 * re-announce the backlog. The poll is its only clock — no per-mission timer.
 *
 * The cue's Activity entry is ONE grouped record (`'mission-cue'`, BUG-173 S4):
 * a snapshot of every mission owed right now, one clickable row each. A poll that
 * cues replaces it in place and moves its `ts`; every other poll only syncs it
 * quietly ({@link syncMissionActivity}).
 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { MissionDoor, MissionDoorResult, MissionView } from '../../../main/mission-ipc'
import { i18n } from '../i18n'
import {
  decideCue,
  deserializeCueMemory,
  firstOwed,
  isPersistedCueMemory,
  owedKeys,
  seedCueMemory,
  serializeCueMemory,
  type CueMemory,
  type PersistedCueMemory
} from '../lib/mission-cue'
import { buildMissionModel, missionForSession, type MissionModel } from '../lib/mission-view'
import { playNotificationSound } from '../lib/notification-sound'
import {
  useNotificationsStore,
  type NotificationItem,
  type NotificationRecord
} from './notifications'
import { persistedRef } from './persisted'
import { useSessionsStore } from './sessions'
import { useUiStore } from './ui'

const POLL_MS = 20_000

/** How long an open-the-popover request stays claimable (BUG-173, spec §3.4). */
export const POPOVER_REQUEST_TTL_MS = 5_000

/** "Open this mission's popover" — set by `openNavigableView('mission')`, consumed by `MissionPill`. */
export interface PopoverRequest {
  missionId: string
  at: number
}

/** "Open the Missions review" — set by {@link useMissionsStore}`.openReview`, consumed by the review dialog (S5). */
export interface ReviewRequest {
  /** The mission the review opens focused on, or `null` for the whole pile. */
  missionId: string | null
  at: number
}

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

/** Upsert key of the cue's one Activity entry — at most one mission record in the bell. */
const CUE_GROUP = 'mission-cue'

/** Kinds an agent or a later step waits on — they sort ahead of standing to-dos. */
const BLOCKING_KINDS: ReadonlySet<string> = new Set(['rescope', 'blocker', 'human-steps'])

/** Every mission that owes the operator something the cue speaks about, once per id. */
function owedViews(views: readonly MissionView[]): MissionView[] {
  const seen = new Set<string>()
  return views.filter((v) => {
    if (seen.has(v.mission.id) || owedKeys(v).size === 0) return false
    seen.add(v.mission.id)
    return true
  })
}

/** Cued this poll first, then blocking kinds, then newest `updatedAt` (spec §3.3). */
function orderOwed(owed: MissionView[], cuedIds: ReadonlySet<string>): MissionView[] {
  const cued = (v: MissionView): number => (cuedIds.has(v.mission.id) ? 0 : 1)
  const blocking = (v: MissionView): number =>
    BLOCKING_KINDS.has(firstOwed(v)?.kind ?? '') ? 0 : 1
  const updated = (v: MissionView): number => Date.parse(v.mission.updatedAt) || 0
  return [...owed].sort(
    (a, b) => cued(a) - cued(b) || blocking(a) - blocking(b) || updated(b) - updated(a)
  )
}

/** One mission's row in the grouped entry: names itself, says what it owes, opens its owner. */
function activityItem(view: MissionView): NotificationItem {
  return {
    id: view.mission.id,
    title: view.title,
    description: owedWhat(view),
    sessionId: view.mission.owner.sessionId,
    target: { view: 'mission', missionId: view.mission.id }
  }
}

/** The entry's headline and rows for what is owed right now. */
function cueEntry(owed: readonly MissionView[]): Pick<NotificationRecord, 'title' | 'items'> {
  const { t } = i18n.global
  return {
    title:
      owed.length === 1
        ? t('mission.cue.one', { title: owed[0].title, what: owedWhat(owed[0]) })
        : t('mission.cue.many', { n: owed.length }),
    items: owed.map(activityItem)
  }
}

/**
 * The cue's one Activity entry: replaces the `'mission-cue'` record in place (or
 * appends it) with everything owed now, and moves its `ts` — this poll is news.
 */
function postMissionActivity(missionIds: readonly string[], views: readonly MissionView[]): void {
  const cued = new Set(missionIds)
  const owed = orderOwed(owedViews(views), cued)
  if (owed.length === 0) return
  useNotificationsStore().notify({
    ts: Date.now(),
    source: 'app',
    kind: 'warning',
    group: CUE_GROUP,
    ...cueEntry(owed)
  })
}

/**
 * The quiet sync after every poll (spec §3.3): rewrite the entry's title and rows
 * from what is owed now WITHOUT touching its `ts`, and remove it when nothing is.
 * `updateGroup` finds nothing for an entry the operator dismissed, so a sync can
 * never bring it back.
 */
export function syncMissionActivity(views: readonly MissionView[]): void {
  const activity = useNotificationsStore()
  const owed = orderOwed(owedViews(views), new Set())
  if (owed.length === 0) activity.removeGroup(CUE_GROUP)
  else activity.updateGroup(CUE_GROUP, cueEntry(owed))
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
  /**
   * What the cue has already told the operator, mirrored to `localStorage` so a
   * restart continues instead of starting over. `null` = no usable memory (first
   * run, or a corrupt value): the first real poll seeds it silently.
   */
  const storedCues = persistedRef<PersistedCueMemory | null>('om2tab.missionCues', null, {
    validate: (v) => isPersistedCueMemory(v)
  })
  let cueMemory: CueMemory | null = storedCues.value ? deserializeCueMemory(storedCues.value) : null
  /**
   * A pending request to open a mission's popover. It lives for
   * {@link POPOVER_REQUEST_TTL_MS}, so one that never finds a pill (owner not
   * shown) cannot pop a popover open later at a surprising moment.
   */
  const popoverRequest = ref<PopoverRequest | null>(null)
  let popoverTimer: ReturnType<typeof setTimeout> | null = null
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
      // Main lists each mission once; drop a repeated id anyway (BUG-173 defence in depth).
      const list = res.views.filter(
        (v, i, all) => all.findIndex((x) => x.mission.id === v.mission.id) === i
      )
      views.value = list
      refreshedAt.value = Date.now()
      // Sidebar folders not loaded yet: the list says nothing about reality, and a
      // decision now would rebuild the memory empty and re-cue the backlog later.
      if (folders.length === 0) return
      const now = Date.now()
      if (!cueMemory) {
        // No memory: the backlog the operator already has on screen is not news.
        cueMemory = seedCueMemory(list, now)
        storedCues.value = serializeCueMemory(cueMemory)
        syncMissionActivity(res.views)
        return
      }
      const decision = decideCue(list, cueMemory, now)
      cueMemory = decision.memory
      storedCues.value = serializeCueMemory(cueMemory)
      if (decision.cue) {
        playNotificationSound()
        void window.api.requestAttention()
        postMissionActivity(decision.missionIds, list)
      } else {
        syncMissionActivity(list)
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

  function clearPopoverRequest(): void {
    if (popoverTimer) clearTimeout(popoverTimer)
    popoverTimer = null
    popoverRequest.value = null
  }

  /** Ask the pill that owns `missionId` to open its popover; a newer request replaces an older one. */
  function requestPopover(missionId: string): void {
    clearPopoverRequest()
    popoverRequest.value = { missionId, at: Date.now() }
    popoverTimer = setTimeout(clearPopoverRequest, POPOVER_REQUEST_TTL_MS)
  }

  /**
   * Claim the pending request: returns it and clears it, or `null` when there is
   * none or it is older than the TTL (a throttled timer must not revive it).
   */
  function consumePopoverRequest(): PopoverRequest | null {
    const req = popoverRequest.value
    clearPopoverRequest()
    return req && Date.now() - req.at < POPOVER_REQUEST_TTL_MS ? req : null
  }

  /**
   * A pending request to open the Missions review, optionally focused on one
   * mission. S5's dialog consumes it; until then nothing renders it.
   */
  const reviewRequest = ref<ReviewRequest | null>(null)

  /** Ask for the Missions review — focused on `missionId`, or the whole pile when omitted. */
  function openReview(missionId?: string): void {
    reviewRequest.value = { missionId: missionId ?? null, at: Date.now() }
  }

  /** Claim the pending review request: returns it and clears it, or `null` when there is none. */
  function consumeReviewRequest(): ReviewRequest | null {
    const req = reviewRequest.value
    reviewRequest.value = null
    return req
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
    runDoor,
    popoverRequest,
    requestPopover,
    consumePopoverRequest,
    reviewRequest,
    openReview,
    consumeReviewRequest
  }
})
