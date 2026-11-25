/**
 * Mission progress store (T370; Mission v3 S3 — design.md §6 "Mission progress").
 *
 * Holds every open mission of the repos the sidebar knows, as `mission:list`
 * projects it, and derives one {@link MissionModel} per mission so the Topbar
 * pill and the sidebar chip read the same answer. Read-only
 * except {@link runDoor} — the operator's doors, the only writes the mission UI
 * makes.
 *
 * Polled, not pushed: the derived block (live children, the stall verdict) is
 * time-dependent, so a file watcher alone would still leave it stale. One poll
 * every {@link POLL_MS}, plus an immediate refresh on demand.
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
  MissionV4Door,
  MissionV4DoorReply,
  MissionV4ViewReply,
  MissionView
} from '../../../main/mission-ipc'
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
  type CueView,
  type PersistedCueMemory
} from '../lib/mission-cue'
import {
  attachRequestsOf,
  isStaleNamedRead,
  missionPillText,
  missionPillTone,
  v4MissionOf,
  type MissionV4Reply
} from '../lib/mission-pane-view'
import {
  buildMissionModel,
  headlineText,
  missionForSession,
  progressHeadline,
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
import { soundAllowed } from './session-notify'
import { useUiStore } from './ui'

const POLL_MS = 20_000

/** One of the operator's v4 doors as the dropdown calls it: the folder and the mission are the store's to add. */
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

/**
 * What the operator owes, as the cue's `{what}`: the first owed item in the one wording the You lane
 * uses ({@link youItemText}), or where a finished mission nobody asked to close stands.
 */
function owedWhat(view: ReaderView): string {
  const { t } = i18n.global
  const item = firstOwed(view)
  // A v4 item carries its own wording; a v3 view (a build without the view channel) keeps the v3 one.
  if (item !== null && 'ask' in item) return item.ask
  const v3 = view as unknown as MissionView
  return item === null ? headlineText(t, progressHeadline(v3.progress)) : youItemText(t, v3, item)
}

/** Upsert key of the cue's one Activity entry — at most one mission record in the bell. */
const CUE_GROUP = 'mission-cue'

/**
 * What the cue, the Activity entry and the chip read of one mission (Missions v4 S-23). A v3 view fits it
 * as it is; a v4 reader view is built from the view channel's detail, for v3 and v4 records alike, so the
 * waiting list inside is worded once by the server (`ask`).
 */
export type ReaderView = CueView & {
  title: string
  mission: { id: string; owner: { sessionId: string }; updatedAt: string }
}

/** Whether a reader's record is a v3 file read through the record store (not a v4 record). */
const isV3Source = (r: ReaderMission): boolean =>
  r.detail.source !== undefined && r.detail.source !== 'v4'

/**
 * What the cue and the Activity entry read per mission. A v4 record is read as the v4 view serves it. A mission
 * that is still a v3 file keeps what main did: its own v3 view (the list poll still serves it), so every key
 * is main's key and an update changes nothing that chimes (an owed item main knew is the same key, a blocker
 * renumbered by a neighbour's removal is the same `blocker:<reason>`, and a close request with a step still
 * open stays `close`). The only thing a v3 file adds from the v4 view is a request to join, which main had no
 * equivalent for. A v3 file the list does not serve (a campaign) is read as the v4 view serves it.
 */
function cueViewsFrom(readers: readonly ReaderMission[], v3: readonly MissionView[]): ReaderView[] {
  const byId = new Map(v3.map((v) => [v.mission.id, v]))
  return readers.map((r) => {
    const v = isV3Source(r) ? byId.get(r.mission.id) : undefined
    if (!v) return r
    return { ...v, you: [...v.you, ...r.you.filter((i) => 'ask' in i && i.kind === 'attach')] }
  })
}

/** One mission the readers know through the v4 view: what the cue reads, and the detail the chip is drawn from. */
export interface ReaderMission extends ReaderView {
  detail: Extract<MissionV4ViewReply, { state: 'mission' }>['detail']
  /** The id a named read of this mission uses (a converted campaign's differs from `mission.id`). */
  lookupId?: string
}

/** The session id the readers ask the view as: no session's, so it answers for the mission, never for a member. */
const READER_ID = 'harnu-readers'

/** What the sidebar chip shows for one session: the pill's text and tone, from one source. */
export interface ChipModel {
  text: string
  /** The compact form the trailing cluster draws (the pill's own text for a v4 mission). */
  compact: string
  tone: 'neutral' | 'accent' | 'warning' | 'success'
  needsYou: boolean
}

/** Kinds an agent or a later step waits on — they sort ahead of standing to-dos. */
const BLOCKING_KINDS: ReadonlySet<string> = new Set(['rescope', 'blocker', 'decide', 'human-steps'])
/** The v4 kinds that re-nudge (see `lib/mission-cue.ts`): they sort ahead of standing ones too. */
const V4_BLOCKING: ReadonlySet<string> = new Set([
  'unblock',
  'attach',
  'close',
  'main-failing',
  'settle',
  'accept',
  'rescope'
])

/** Every mission that owes the operator something the cue speaks about, once per id. */
function owedViews(views: readonly ReaderView[]): ReaderView[] {
  const seen = new Set<string>()
  return views.filter((v) => {
    if (seen.has(v.mission.id) || owedKeys(v).size === 0) return false
    seen.add(v.mission.id)
    return true
  })
}

/** Cued this poll first, then blocking kinds, then newest `updatedAt` (spec §3.3). */
function orderOwed(owed: ReaderView[], cuedIds: ReadonlySet<string>): ReaderView[] {
  const cued = (v: ReaderView): number => (cuedIds.has(v.mission.id) ? 0 : 1)
  const blocking = (v: ReaderView): number => {
    const item = firstOwed(v)
    if (item === null) return 1
    // `close` is standing in v3 and blocking in v4: tell the two lists apart by the item's own `ask`.
    return ('ask' in item ? V4_BLOCKING : BLOCKING_KINDS).has(item.kind) ? 0 : 1
  }
  const updated = (v: ReaderView): number => Date.parse(v.mission.updatedAt) || 0
  return [...owed].sort(
    (a, b) => cued(a) - cued(b) || blocking(a) - blocking(b) || updated(b) - updated(a)
  )
}

/** One mission's row in the grouped entry: names itself, says what it owes, opens its owner. */
function activityItem(view: ReaderView): NotificationItem {
  return {
    id: view.mission.id,
    title: view.title,
    description: owedWhat(view),
    sessionId: view.mission.owner.sessionId || undefined,
    target: { view: 'mission', missionId: view.mission.id }
  }
}

/** The entry's headline and rows for what is owed right now. */
function cueEntry(owed: readonly ReaderView[]): Pick<NotificationRecord, 'title' | 'items'> {
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
function postMissionActivity(missionIds: readonly string[], views: readonly ReaderView[]): void {
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
 * `localStorage` values the Mission pane kept and the dropdown does not read: the pane's disclosure state and the
 * hand-off offer's "Not now" memory. Removed once, when the store starts, so an upgrade leaves nothing behind.
 */
export const RETIRED_MISSION_STORAGE_KEYS = [
  'om2tab.missionPane.sections',
  'om2tab.missionHandoffDismissed'
] as const

/** Remove the values of {@link RETIRED_MISSION_STORAGE_KEYS}. Best-effort: storage can be missing or throw. */
export function removeRetiredMissionStorage(
  storage: Pick<Storage, 'removeItem'> | undefined = typeof localStorage === 'undefined'
    ? undefined
    : localStorage
): void {
  for (const key of RETIRED_MISSION_STORAGE_KEYS) {
    try {
      storage?.removeItem(key)
    } catch {
      /* private window or blocked storage: nothing to remove */
    }
  }
}

/**
 * The quiet sync after every poll (spec §3.3): rewrite the entry's title and rows
 * from what is owed now WITHOUT touching its `ts`, and remove it when nothing is.
 * `updateGroup` finds nothing for an entry the operator dismissed, so a sync can
 * never bring it back.
 */
export function syncMissionActivity(views: readonly ReaderView[]): void {
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
  /** Bumped by every door that took effect: a list read started before it is stale. */
  let writeSeq = 0

  // ---- Missions v4 (S-17): the view of the SELECTED session's mission ------------------------------
  /**
   * What `mission:v4View` last answered for the selected session. The pill and the dropdown both read it.
   * There is no push event: it is asked when the selected session changes and on the same 20 s clock as
   * the list above. Asking has a side effect (it adds the folder to the observer's list), so this store
   * is the one loop that asks.
   */
  const v4 = shallowRef<V4Entry | null>(null)
  /** The `missionId` each session's last answer carried: sent back so the next call reads one record. */
  const v4Ids = new Map<string, string>()
  /** The mission each session was told to show: the dropdown's switch, or "Open mission" on a card or an Activity row. */
  const chosen = new Map<string, string>()
  /**
   * The requests to join that name the selected session while it has no mission (S-21). The session that
   * asked is not in the mission, so the view does not answer for it: the store reads the folder's open
   * missions by name (the same poll, at most {@link ASK_READS_MAX}) and keeps the requests that are its own.
   */
  const v4Asks = shallowRef<{ sessionId: string; asks: AttachAsk[] } | null>(null)
  let v4Seq = 0
  let v4Flight: { sessionId: string; promise: Promise<void> } | null = null
  let started = false
  // The pane's stored values are of no use to the dropdown: drop them once, when the store starts.
  removeRetiredMissionStorage()

  /** One call of the view; `null` when the build has no such channel or it threw. */
  async function askV4(
    sessionId: string,
    folder: string,
    missionId?: string
  ): Promise<MissionV4ViewReply | null> {
    const ask = window.api.missionV4View
    if (typeof ask !== 'function') return null
    try {
      return await ask({
        folder,
        sessionId,
        ...(missionId ? { missionId } : {})
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
    // The one rule (S-35 delta 1): the mission chosen in the dropdown or named by "Open mission", else the one that
    // waits on the operator, else the newest written. The chip reads the same rule ({@link pickedFor}).
    const named = pickedFor(sessionId)?.lookupId ?? v4Ids.get(sessionId)
    let reply = await askV4(sessionId, folder, named)
    // The id read back may no longer be this session's (a hand-off closed its row, the operator closed
    // the mission): ask by session again, so the view never shows another session's mission.
    if (named && reply && isStaleNamedRead(reply, sessionId)) {
      v4Ids.delete(sessionId)
      if (chosen.get(sessionId) === named) chosen.delete(sessionId)
      reply = await askV4(sessionId, folder)
    }
    // The selected session changed while this was in flight: its answer is not news.
    if (seq !== v4Seq) return
    if (reply && reply.state === 'mission') {
      v4Ids.set(sessionId, reply.missionId)
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

  /**
   * Missions v4 (S-19) — one of the operator's doors on the v4 mission the selected session is in, then
   * the view is read again (there is no push event, so the dropdown is only as fresh as its last read).
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
    error: 'UNAVAILABLE: the dropdown has no mission to act on.'
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
    // Read again whatever came back: a refusal usually means the record moved, and the dropdown must show how.
    // `loadV4` (not `refreshV4`) so a read already in flight, which may predate the door, is dropped.
    await loadV4()
    return res
  }

  // ---- Missions v4 (S-22): the sample and the close -----------------------------------------------------------
  /**
   * The sample mission the dropdown shows, or `null`. A sample is built in the renderer from nothing (see
   * `lib/mission-sample.ts`): it has no record, so no door may reach the main process while one shows. Every
   * door answers "nothing changed" without a call and without reading the view; the hand-off refuses in words.
   * Nothing but the dropdown reads it, so the pill, the sidebar and the other readers never see a sample.
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

  // ---- Missions v4 (S-23): the readers' list -----------------------------------------------------------------
  /**
   * Every open mission of the sidebar's repos as the v4 view serves it (through the record store, v3 and v4
   * records alike), or `null` while the build has no such channel or nothing was read yet. The sidebar chip,
   * the cue and the Activity entry read this; the pill and the dropdown keep reading the selected session's reply.
   * It rides the same 20 s poll as the list and adds no timer.
   */
  const readers = shallowRef<ReaderMission[] | null>(null)
  /** The last good read per repo: a read that fails leaves the repo's missions as they were. */
  const readerByRepo = new Map<string, ReaderMission[]>()

  async function readRepo(folder: string): Promise<ReaderMission[] | null> {
    const first = await askV4(READER_ID, folder)
    if (!first) return null
    if (first.state !== 'none') return first.state === 'refused' ? null : []
    const out: ReaderMission[] = []
    // Every listed row is read, however many there are (BUG-283 OI-3): a cap here left the missions past it with
    // no chip, no cue and no Activity row, even when one of them owed the operator something.
    for (const row of first.missions) {
      const named = await askV4(READER_ID, folder, row.id)
      if (!named) return null
      if (named.state !== 'mission') continue
      const d = named.detail
      out.push({
        mission: { id: d.id, owner: { sessionId: d.leads ?? '' }, updatedAt: '' },
        title: d.title,
        you: d.waiting.items,
        detail: d,
        lookupId: row.id
      })
    }
    return out
  }

  /** One read of every repo; `null` when the channel is absent (the caller keeps the v3 list). */
  async function loadReaders(folders: readonly string[]): Promise<ReaderMission[] | null> {
    if (typeof window.api.missionV4View !== 'function') return null
    // One folder per repo: worktrees share their records.
    const repoOf = new Map(sessions.folders.map((f) => [f.path, f.repoId ?? f.path]))
    const perRepo = new Map<string, string>()
    for (const f of folders)
      if (!perRepo.has(repoOf.get(f) ?? f)) perRepo.set(repoOf.get(f) ?? f, f)
    for (const key of [...readerByRepo.keys()]) if (!perRepo.has(key)) readerByRepo.delete(key)
    for (const [key, folder] of perRepo) {
      const read = await readRepo(folder)
      if (read) readerByRepo.set(key, read)
    }
    const seen = new Set<string>()
    return [...readerByRepo.values()]
      .flat()
      .filter((r) => !seen.has(r.mission.id) && !!seen.add(r.mission.id))
  }

  /**
   * The mission `sessionId` shows, from what the readers know: the one chosen (the dropdown's switch, or "Open
   * mission" on a card or an Activity row), else the one that waits on the operator, else the newest written
   * (the readers are listed newest first). One rule for the chip, the pill and the dropdown: a draft with nothing
   * waiting never hides a mission that waits on the operator. `null` when the session leads none.
   */
  function pickedFor(sessionId: string): ReaderMission | null {
    const led = (readers.value ?? []).filter((r) => r.detail.leads === sessionId)
    if (led.length === 0) return null
    const want = chosen.get(sessionId)
    const named = want ? led.find((r) => (r.lookupId ?? r.mission.id) === want) : undefined
    if (named) return named
    // A choice the readers do not know (a mission the session only works in) is the dropdown's to resolve.
    if (want) return { ...led[0], lookupId: want } as ReaderMission
    return led.find((r) => r.you.length > 0) ?? led[0]
  }

  /**
   * The chip of `sessionId`: the leader of an open mission. Every record, a v3 file included (S-35), shows
   * what its Topbar pill shows: the view's counts and tone ("2/5 · 1 for you"), for the mission {@link pickedFor}
   * names. Only a build without the view channel (`readers` is `null`) keeps the v3 words. `null` for anyone else.
   */
  function chipFor(sessionId: string | null | undefined): ChipModel | null {
    if (!sessionId) return null
    const { t } = i18n.global
    if (readers.value === null) {
      const m = modelForSession(sessionId)
      if (!m || m.headline.kind === 'empty') return null
      return {
        text: headlineText(t, m.headline),
        compact: headlineText(t, m.headline, true),
        tone: m.tone,
        needsYou: m.needsYou
      }
    }
    const r = pickedFor(sessionId)
    if (!r) return null
    const text = missionPillText(t, r.detail)
    return { text, compact: text, tone: missionPillTone(r.detail), needsYou: r.you.length > 0 }
  }

  /**
   * The open missions `sessionId` leads, as the readers know them, newest written first. A session that leads
   * several (the normal case for an old leader: one mission per v3 file it ever started) shows {@link pickedFor}
   * and lists the others here, so the dropdown can offer the choice instead of an error.
   */
  function ledMissionsFor(
    sessionId: string | null | undefined
  ): Array<{ id: string; title: string }> {
    if (!sessionId) return []
    return (readers.value ?? [])
      .filter((r) => r.detail.leads === sessionId)
      .map((r) => ({ id: r.lookupId ?? r.mission.id, title: r.title }))
  }

  /** The dropdown follows `missionId` for `sessionId` from now on: the next read names it. Never writes. */
  async function chooseMission(sessionId: string, missionId: string): Promise<void> {
    chosen.set(sessionId, missionId)
    v4Ids.set(sessionId, missionId)
    await loadV4()
  }

  /** The Activity notice of the mission files nobody can read: one entry, named, quiet until the set changes. */
  const UNREADABLE_GROUP = 'mission-unreadable'
  let unreadableKey = ''
  function syncUnreadable(names: unknown): void {
    const files = Array.isArray(names)
      ? [...new Set(names.filter((n): n is string => typeof n === 'string'))].sort()
      : []
    const activity = useNotificationsStore()
    if (files.length === 0) {
      unreadableKey = ''
      activity.removeGroup(UNREADABLE_GROUP)
      return
    }
    const { t } = i18n.global
    const entry = {
      title: t('mission.unreadable.title'),
      description: t('mission.unreadable.body', { files: files.join(', ') })
    }
    const key = files.join('|')
    if (key === unreadableKey) {
      // The same files are not news: rewrite quietly, never bring back an entry the operator dismissed.
      activity.updateGroup(UNREADABLE_GROUP, entry)
      return
    }
    unreadableKey = key
    activity.notify({
      ts: Date.now(),
      source: 'app',
      kind: 'warning',
      group: UNREADABLE_GROUP,
      ...entry
    })
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
      syncUnreadable(res.unreadable)
      // Sidebar folders not loaded yet: the list says nothing about reality, and a
      // decision now would rebuild the memory empty and re-cue the backlog later.
      if (folders.length === 0) return
      // Missions v4 S-23: the cue and the Activity entry read the v4 view (v3 and v4 records alike). A
      // build without the channel keeps the v3 list; a repo whose read fails keeps its last good missions.
      const read = await loadReaders(folders)
      if (startedAt !== writeSeq) return
      readers.value = read
      const cueViews: readonly ReaderView[] = read ? cueViewsFrom(read, list) : list
      const now = Date.now()
      if (!cueMemory) {
        // No memory: the backlog the operator already has on screen is not news.
        cueMemory = seedCueMemory(cueViews, now)
        storedCues.value = serializeCueMemory(cueMemory)
        syncMissionActivity(cueViews)
        return
      }
      const decision = decideCue(cueViews, cueMemory, now)
      cueMemory = decision.memory
      storedCues.value = serializeCueMemory(cueMemory)
      if (decision.cue) {
        // T154: the sound is the family of what is owed (one combined cue → the most urgent). It obeys
        // the Sound switch and the family's mute; attention and the Activity entry do not.
        if (decision.family && soundAllowed(sessions.notifyPrefs, decision.family)) {
          playNotificationSound(decision.family)
        }
        void window.api.requestAttention()
        postMissionActivity(decision.missionIds, cueViews)
      } else {
        syncMissionActivity(cueViews)
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

  /** The pending open of {@link openMissionDropdown}: one at a time, dropped after a second. */
  let stopPendingOpen: (() => void) | null = null

  /**
   * Open the Mission dropdown under the Topbar pill (Mission dropdown S-7: the ONE door every opener goes
   * through — the Activity row and the Your move card; the pill and the `view.missionProgress` chord flip the
   * same flag themselves). With `missionId` the dropdown shows the mission it names, not the session's default
   * one, and a mission the session does not lead shows as a named read; nothing is written. The dropdown follows
   * the selected session, so a caller selects the mission's leader first. The pill is the dropdown's anchor: a
   * door that selected the session in the same tick finds the pill not yet drawn, so the open waits for it
   * (for at most a second) and opens nothing when there is no pill to hang on.
   */
  function openMissionDropdown(missionId?: string): void {
    const ui = useUiStore()
    const selected = sessions.selectedSession
    if (missionId && selected && !selected.sessionId.startsWith('synthetic-')) {
      void chooseMission(selected.sessionId, missionId)
    }
    stopPendingOpen?.()
    stopPendingOpen = null
    if (ui.openPopover('missionProgress')) return
    const timer = setTimeout(() => stop(), 1000)
    const stopWatch = watch(
      () => ui.popoverAnchors.missionProgress,
      (drawn) => {
        if (!drawn) return
        ui.openPopover('missionProgress')
        stop()
      }
    )
    const stop = (): void => {
      clearTimeout(timer)
      stopWatch()
      if (stopPendingOpen === stop) stopPendingOpen = null
    }
    stopPendingOpen = stop
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

  return {
    views,
    refreshedAt,
    doorInFlight,
    refresh,
    ensureStarted,
    viewForSession,
    modelForSession,
    readers,
    chipFor,
    ledMissionsFor,
    chooseMission,
    openMissionDropdown,
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
    runDoor
  }
})
