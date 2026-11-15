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
  MissionHandOffReply,
  MissionV4Door,
  MissionV4DoorReply,
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
import {
  attachRequestsOf,
  isStaleNamedRead,
  v4MissionOf,
  type MissionV4Reply
} from '../lib/mission-pane-view'
import {
  buildMissionModel,
  headlineText,
  missionForSession,
  youItemText,
  type MissionModel
} from '../lib/mission-view'
import { playNotificationSound } from '../lib/notification-sound'
import { sampleOf, type Sample, type SampleState } from '../lib/mission-sample'
import {
  useNotificationsStore,
  type NotificationItem,
  type NotificationRecord
} from './notifications'
import { persistedRef } from './persisted'
import { useSessionsStore } from './sessions'
import { useUiStore } from './ui'

const POLL_MS = 20_000

/** One of the operator's v4 doors as the pane calls it: the folder and the mission are the store's to add. */
export type V4DoorCall = MissionV4Door extends infer D
  ? D extends MissionV4Door
    ? Omit<D, 'folder' | 'missionId'>
    : never
  : never

/** A request to join that names a session with no mission: the mission it asked for, and what to answer. */
export interface AttachAsk {
  missionId: string
  /** The mission's title, as the view gave it. */
  title: string
  requestId: string
  /** The session that leads that mission now, or `null`. */
  leaderId: string | null
}

/** How many of the folder's open missions are read by name to find a request that names this session. */
const ASK_READS_MAX = 6

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
  /**
   * The requests to join that name the selected session while it has no mission (S-21). The session that
   * asked is not in the mission, so the view does not answer for it: the store reads the folder's open
   * missions by name (the same poll, at most {@link ASK_READS_MAX}) and keeps the requests that are its own.
   */
  const v4Asks = shallowRef<{ sessionId: string; asks: AttachAsk[] } | null>(null)
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
    const dismissed = missionId ? dismissedPercentFor(sessionId, missionId) : null
    try {
      return await ask({
        folder,
        sessionId,
        ...(missionId ? { missionId } : {}),
        ...(dismissed !== null ? { dismissedPercent: dismissed } : {})
      })
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
    if (reply && reply.state === 'mission') {
      v4Ids.set(sessionId, reply.missionId)
      forgetStaleDismissal(reply)
    } else v4Ids.delete(sessionId)
    const asks = reply && reply.state === 'none' ? await readAsks(sessionId, folder, reply) : []
    if (seq !== v4Seq) return
    if (reply) {
      v4.value = { sessionId, reply, at: Date.now() }
      v4Asks.value = asks.length > 0 ? { sessionId, asks } : null
    } else if (v4.value?.sessionId !== sessionId) {
      v4.value = null
      v4Asks.value = null
    }
  }

  /** The requests to join, in the folder's open missions, that name `sessionId` (a request is its own: never another's). */
  async function readAsks(
    sessionId: string,
    folder: string,
    reply: Extract<MissionV4ViewReply, { state: 'none' }>
  ): Promise<AttachAsk[]> {
    const read = await Promise.all(
      reply.missions.slice(0, ASK_READS_MAX).map(async (m) => ({
        m,
        named: await askV4(sessionId, folder, m.id)
      }))
    )
    return read.flatMap(({ m, named }) =>
      named && named.state === 'mission'
        ? attachRequestsOf(named.detail)
            .filter((r) => r.sessionId === sessionId)
            .map((r) => ({
              missionId: m.id,
              title: named.detail.title,
              requestId: r.id,
              leaderId: m.leads ?? null
            }))
        : []
    )
  }

  /** The requests to join that name `sessionId` while it has no mission, as the last read found them. */
  function attachAsksForSession(sessionId: string | null | undefined): AttachAsk[] {
    const entry = v4Asks.value
    return entry && sessionId && entry.sessionId === sessionId ? entry.asks : []
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

  // ---- Missions v4 (S-20): the hand-off ----------------------------------------------------------------
  /**
   * "Not now" on the hand-off offer: the context percentage it was dismissed at, per mission and per
   * leader. The view takes it back (`dismissedPercent`) and offers again only once the context has grown
   * five points, so a leader that is replaced starts with none. Kept across a restart: the operator said
   * "not now" to a session, and a restart is not a reason to ask again at the same number.
   */
  const handoffDismissed = persistedRef<Record<string, { leader: string; percent: number }>>(
    'om2tab.missionHandoffDismissed',
    {},
    {
      validate: (v) =>
        typeof v === 'object' &&
        v !== null &&
        Object.values(v).every(
          (e) => typeof e?.leader === 'string' && typeof e?.percent === 'number'
        )
    }
  )
  /** Whether a hand-off is waiting for the door (it awaits up to 90 s): a second click starts nothing. */
  const handOffPending = ref(false)

  /** The open leader a reply names, or `null` (nobody leads, or the reply holds no mission). */
  function leaderIn(reply: MissionV4ViewReply | null): string | null {
    if (!reply || reply.state !== 'mission') return null
    return reply.sessions.find((r) => r.open && r.role === 'leads')?.id ?? null
  }

  /** The percent to send with the next view call for this mission: the leader the last answer named, or `null`. */
  function dismissedPercentFor(sessionId: string, missionId: string): number | null {
    const entry = handoffDismissed.value[missionId]
    if (!entry) return null
    const last = v4ReplyForSession(sessionId)
    return leaderIn(last) === entry.leader ? entry.percent : null
  }

  /**
   * The percentage the operator said "Not now" at for this mission's current leader, or `null`. The pane
   * stays quiet at a reading no higher than this even before the view has answered again; when to offer
   * again (five points more) is the view's rule, not repeated here.
   */
  function handoffDismissedAt(missionId: string, leaderId: string | null): number | null {
    const entry = handoffDismissed.value[missionId]
    return entry && leaderId !== null && entry.leader === leaderId ? entry.percent : null
  }

  /** A dismissal belongs to one leader: once the leader changes, it is not asked again. */
  function forgetStaleDismissal(reply: MissionV4ViewReply): void {
    if (reply.state !== 'mission') return
    const entry = handoffDismissed.value[reply.missionId]
    if (!entry || leaderIn(reply) === entry.leader) return
    const { [reply.missionId]: _gone, ...rest } = handoffDismissed.value
    handoffDismissed.value = rest
  }

  /**
   * "Not now" on the offer. It stores the percentage the offer was made at and reads the view again, so the
   * offer goes quiet until the context grows five points. It starts nothing and writes nothing to the
   * mission.
   */
  async function dismissHandoff(): Promise<void> {
    const selected = sessions.selectedSession
    const mission = selected ? v4MissionForSession(selected.sessionId) : null
    const leader = mission?.sessions.find((r) => r.open && r.role === 'leads')?.id
    if (!mission || !leader || typeof mission.handoff?.percent !== 'number') return
    handoffDismissed.value = {
      ...handoffDismissed.value,
      [mission.missionId]: { leader, percent: mission.handoff.percent }
    }
    await loadV4()
  }

  /**
   * The hand-off (S-16b): the one thing that changes who leads. The operator confirmed it in the dialog;
   * Harnu starts a normal session with the mission summary and the door writes once. The mission id is the
   * one the view answered for. The door waits up to 90 s for the session to appear, so a second call while
   * one waits is refused here (`HANDOFF_IN_PROGRESS`) before it reaches the channel. The reply is always a
   * value, never a throw, and the view is read again after it, whichever way it went.
   */
  async function runHandOff(): Promise<MissionHandOffReply> {
    const selected = sessions.selectedSession
    const mission = selected ? v4MissionForSession(selected.sessionId) : null
    const door = window.api.missionHandOff
    if (sampleState.value !== null) {
      return {
        ok: false,
        code: 'SAMPLE',
        error: 'SAMPLE: this is a sample, so no session was started.'
      }
    }
    if (!selected || !mission || typeof door !== 'function') {
      return {
        ok: false,
        code: 'UNAVAILABLE',
        error: 'UNAVAILABLE: the pane has no mission to hand off.'
      }
    }
    if (handOffPending.value) {
      return {
        ok: false,
        code: 'HANDOFF_IN_PROGRESS',
        error: 'HANDOFF_IN_PROGRESS: a hand-off is already starting a session.'
      }
    }
    handOffPending.value = true
    let res: MissionHandOffReply
    try {
      res = await door({ folder: selected.projectPath, missionId: mission.missionId })
    } catch (err) {
      res = {
        ok: false,
        code: 'UNAVAILABLE',
        error: `UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`
      }
    } finally {
      handOffPending.value = false
    }
    // The new leader starts with no dismissal of the old one's.
    if (res.ok) {
      const { [mission.missionId]: _gone, ...rest } = handoffDismissed.value
      handoffDismissed.value = rest
    }
    await loadV4()
    return res
  }

  /**
   * Missions v4 (S-19) — one of the operator's doors on the v4 mission the selected session is in, then
   * the view is read again (there is no push event, so the pane is only as fresh as its last read).
   * The mission id is the one the view ANSWERED for, never `detail.id`; the folder is the selected
   * session's, the one the view is asked from. A door never refuses the operator: a refusal here is a
   * record that changed under them (`NOT_FOUND`), one that closed, or a channel that is not there. The
   * reply is always a value, never a throw: the caller words what to do from `code`.
   */
  async function runV4Door(call: V4DoorCall): Promise<MissionV4DoorReply> {
    if (sampleState.value !== null) return sampleDoorReply()
    const selected = sessions.selectedSession
    const mission = selected ? v4MissionForSession(selected.sessionId) : null
    if (!selected || !mission) return noMissionToActOn()
    return callV4Door(selected.projectPath, mission.missionId, call)
  }

  /**
   * Missions v4 (S-21) — a door on a mission the view did NOT answer for the selected session: the picker's
   * "Attach" and a request read by name (the session that asked is not in the mission yet). The mission id
   * is the one the operator picked or the request names; the folder is the selected session's. Same rules
   * as {@link runV4Door}: never a throw, and the view is read again after the reply.
   */
  async function runV4DoorOn(missionId: string, call: V4DoorCall): Promise<MissionV4DoorReply> {
    if (sampleState.value !== null) return sampleDoorReply()
    const selected = sessions.selectedSession
    if (!selected) return noMissionToActOn()
    return callV4Door(selected.projectPath, missionId, call)
  }

  /** A door pressed on the sample: nothing changed, nothing was called, and the view is not read. */
  const sampleDoorReply = (): MissionV4DoorReply => ({ ok: true, changed: false })

  const noMissionToActOn = (): MissionV4DoorReply => ({
    ok: false,
    code: 'UNAVAILABLE',
    error: 'UNAVAILABLE: the pane has no mission to act on.'
  })

  async function callV4Door(
    folder: string,
    missionId: string,
    call: V4DoorCall
  ): Promise<MissionV4DoorReply> {
    const door = window.api.missionV4Door
    if (typeof door !== 'function') return noMissionToActOn()
    let res: MissionV4DoorReply
    try {
      res = await door({ ...call, folder, missionId } as MissionV4Door)
    } catch (err) {
      res = {
        ok: false,
        code: 'UNAVAILABLE',
        error: `UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    // Read again whatever came back: a refusal usually means the record moved, and the pane must show how.
    // `loadV4` (not `refreshV4`) so a read already in flight, which may predate the door, is dropped.
    await loadV4()
    return res
  }

  // ---- Missions v4 (S-22): the sample and the close -----------------------------------------------------------
  /**
   * The sample mission the pane shows, or `null`. A sample is built in the renderer from nothing (see
   * `lib/mission-sample.ts`): it has no record, so no door may reach the main process while one shows. Every
   * door answers "nothing changed" without a call and without reading the view; the hand-off refuses in words.
   * Nothing but the pane reads it, so the pill, the sidebar and the other readers never see a sample.
   */
  const sampleState = ref<SampleState | null>(null)
  const sampleView = computed<Sample | null>(() =>
    sampleState.value ? sampleOf(sampleState.value) : null
  )
  function showSample(state: SampleState | null): void {
    sampleState.value = state
  }

  /**
   * Close the mission the selected session is in: the operator's one end door (S-22), as delivered or
   * discarded, with an optional reason. It never refuses for an open matter: those come back as warnings, and
   * the view's own (counted with the facts) are what the dialog lists before the operator confirms. Through
   * {@link runV4Door}: the view is read again after the reply, and a closed mission is then no mission here.
   */
  function closeMission(args: {
    closedAs: 'delivered' | 'discarded'
    reason?: string
  }): Promise<MissionV4DoorReply> {
    return runV4Door({
      door: 'close',
      closedAs: args.closedAs,
      ...(args.reason ? { reason: args.reason } : {})
    })
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
    attachAsksForSession,
    runV4Door,
    runV4DoorOn,
    closeMission,
    sampleState,
    sampleView,
    showSample,
    handOffPending,
    handoffDismissedAt,
    dismissHandoff,
    runHandOff,
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
