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
import { computed, ref, shallowRef, watch } from 'vue'
import type {
  MissionDoor,
  MissionDoorResult,
  MissionV4ViewReply,
  MissionView
} from '../../../main/mission-ipc'
import { i18n } from '../i18n'
import { progressHeadline } from '../../../main/mission-progress'
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
import { isStaleNamedRead, v4MissionOf, type MissionV4Reply } from '../lib/mission-pane-view'
import {
  buildMissionModel,
  headlineText,
  missionForSession,
  youItemText,
  type MissionModel
} from '../lib/mission-view'
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

/** What the view channel last answered for one session (Missions v4, S-17). */
export interface V4Entry {
  sessionId: string
  reply: MissionV4ViewReply
  /** Wall clock of the answer. */
  at: number
}

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

/**
 * What the operator owes, as the cue's `{what}`: the first owed item in the one wording the You lane
 * uses ({@link youItemText}), or where a finished mission nobody asked to close stands.
 */
function owedWhat(view: MissionView): string {
  const { t } = i18n.global
  const item = firstOwed(view)
  return item === null
    ? headlineText(t, progressHeadline(view.progress))
    : youItemText(t, view, item)
}

/** Upsert key of the cue's one Activity entry — at most one mission record in the bell. */
const CUE_GROUP = 'mission-cue'

/** Kinds an agent or a later step waits on — they sort ahead of standing to-dos. */
const BLOCKING_KINDS: ReadonlySet<string> = new Set(['rescope', 'blocker', 'decide', 'human-steps'])

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
  /**
   * Bumped by every successful list read (T596): the campaigns store watches it, so a campaign
   * refreshes whenever the missions it rolls up have just been re-read — `refreshedAt` alone can
   * repeat within one millisecond.
   */
  const refreshSeq = ref(0)
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

  // ---- Missions v4 (S-17): the view of the SELECTED session's mission ------------------------------
  /**
   * What `mission:v4View` last answered for the selected session. The pill and the pane both read it.
   * There is no push event: it is asked when the selected session changes and on the same 20 s clock as
   * the list above. Asking has a side effect (it adds the folder to the observer's list), so this store
   * is the one loop that asks.
   */
  const v4 = shallowRef<V4Entry | null>(null)
  /** The `missionId` each session's last answer carried: sent back so the next call reads one record. */
  const v4Ids = new Map<string, string>()
  let v4Seq = 0
  let v4Flight: { sessionId: string; promise: Promise<void> } | null = null
  let started = false

  /** One call of the view; `null` when the build has no such channel or it threw. */
  async function askV4(
    sessionId: string,
    folder: string,
    missionId?: string
  ): Promise<MissionV4ViewReply | null> {
    const ask = window.api.missionV4View
    if (typeof ask !== 'function') return null
    try {
      return await ask({ folder, sessionId, ...(missionId ? { missionId } : {}) })
    } catch {
      return null
    }
  }

  async function loadV4(): Promise<void> {
    const selected = sessions.selectedSession
    // A synthetic session has no id the record can know yet.
    if (!selected || selected.sessionId.startsWith('synthetic-')) {
      v4.value = null
      return
    }
    const sessionId = selected.sessionId
    const folder = selected.projectPath
    const seq = ++v4Seq
    const named = v4Ids.get(sessionId)
    let reply = await askV4(sessionId, folder, named)
    // The id read back may no longer be this session's (a hand-off closed its row, the operator closed
    // the mission): ask by session again, so the view never shows another session's mission.
    if (named && reply && isStaleNamedRead(reply, sessionId)) {
      v4Ids.delete(sessionId)
      reply = await askV4(sessionId, folder)
    }
    // The selected session changed while this was in flight: its answer is not news.
    if (seq !== v4Seq) return
    if (reply && reply.state === 'mission') v4Ids.set(sessionId, reply.missionId)
    else v4Ids.delete(sessionId)
    if (reply) v4.value = { sessionId, reply, at: Date.now() }
    else if (v4.value?.sessionId !== sessionId) v4.value = null
  }

  /** Ask the view for the selected session now; concurrent callers for one session share a round-trip. */
  function refreshV4(): Promise<void> {
    const id = sessions.selectedSession?.sessionId ?? null
    if (v4Flight && v4Flight.sessionId === id) return v4Flight.promise
    const flight = {
      sessionId: id ?? '',
      promise: loadV4().finally(() => {
        if (v4Flight === flight) v4Flight = null
      })
    }
    v4Flight = flight
    return flight.promise
  }

  watch(
    () => sessions.selectedSession?.sessionId ?? null,
    () => {
      if (started) void refreshV4()
    }
  )

  /** What the view last answered for `sessionId`, or `null` while it has not answered for it yet. */
  function v4ReplyForSession(sessionId: string | null | undefined): MissionV4ViewReply | null {
    const entry = v4.value
    return entry && sessionId && entry.sessionId === sessionId ? entry.reply : null
  }

  /** The v4 mission this session is attached to, or `null` (none, v3, refused, closed or not answered yet). */
  function v4MissionForSession(sessionId: string | null | undefined): MissionV4Reply | null {
    return sessionId ? v4MissionOf(v4ReplyForSession(sessionId), sessionId) : null
  }

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
      refreshSeq.value++
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
   * mission. `MissionsReviewDialog` consumes it.
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
    started = true
    void refresh()
    void refreshV4()
    timer = setInterval(() => {
      void refresh()
      void refreshV4()
    }, POLL_MS)
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
      // Campaign spec §4: Choose has its own channel; every other door shares one.
      res =
        door.door === 'chooseDecision'
          ? await window.api.missionChoose(door)
          : await window.api.missionOperatorDoor(door)
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      doorsInFlight.value--
    }
    if (res.ok) {
      writeSeq++
      applyDoorResult(door, res.view)
      void refreshAfterWrite()
      // Campaign ch.6: the mission closed, but the memory write refused some ticked drafts.
      if (res.recorded?.failed.length) {
        useUiStore().pushToast({
          kind: 'warning',
          title: i18n.global.t('mission.recordFailedTitle'),
          description: i18n.global.t('mission.recordFailed', {
            drafts: res.recorded.failed.map((f) => `${f.id} (${f.error})`).join(', ')
          })
        })
      }
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

  /**
   * Close several missions through the EXISTING end door, one after another
   * (BUG-173 S5, spec §3.5). Never aborts on a failure: each door answers on its
   * own. The in-flight counter is raised once for the batch, each answer is
   * applied as it lands (rows vanish one by one), and ONE refresh follows at the
   * end. `MISSION_CLOSED` counts as closed, as {@link runDoor} treats it. No
   * toast here — the caller reports the batch once.
   */
  async function runDoors(
    doors: readonly Extract<MissionDoor, { door: 'end' }>[],
    onProgress?: (done: number, total: number) => void
  ): Promise<{ closed: number; failed: { missionId: string; error: string }[] }> {
    const failed: { missionId: string; error: string }[] = []
    let closed = 0
    doorsInFlight.value++
    try {
      for (const [i, door] of doors.entries()) {
        let res: MissionDoorResult
        try {
          res = await window.api.missionOperatorDoor(door)
        } catch (err) {
          res = { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        if (res.ok) {
          writeSeq++
          applyDoorResult(door, res.view)
          closed++
        } else if (res.error.startsWith('MISSION_CLOSED')) {
          writeSeq++
          applyDoorResult(door, null)
          closed++
        } else {
          failed.push({ missionId: door.missionId, error: res.error })
        }
        onProgress?.(i + 1, doors.length)
      }
    } finally {
      doorsInFlight.value--
    }
    if (closed > 0) void refreshAfterWrite()
    return { closed, failed }
  }

  return {
    views,
    refreshedAt,
    refreshSeq,
    doorInFlight,
    refresh,
    ensureStarted,
    viewForSession,
    modelForSession,
    refreshV4,
    v4ReplyForSession,
    v4MissionForSession,
    runDoor,
    runDoors,
    popoverRequest,
    requestPopover,
    consumePopoverRequest,
    reviewRequest,
    openReview,
    consumeReviewRequest
  }
})
