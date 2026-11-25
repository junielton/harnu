/**
 * The mission state feed (T589, contract §9 `mission.state`). It keeps the quiet rows of a session in
 * step with the missions the session owns or is linked to: while at least one binding is live and has
 * `ui.quietRows`, it re-reads the missions of each binding's folder on a poll (the same read the
 * renderer's progress pill polls), projects the session's own, and sends the mod a `mission.state`
 * when what the tick card draws changed (debounced), and again at every hello.
 *
 * Why a push, not a pull: a `ui.render` hook draws synchronously from `$.state`; the only pull the
 * contract has is the `status` ask, which is held up to 20 s in tranches and carries enums and
 * integers, so it cannot run mid-render and cannot carry a title. The command channel is the path
 * `ui.band.set` already uses.
 *
 * Electron-free: the host facade, the read and the send are injected, so every rule is tested.
 */

import { MISSION_DEBOUNCE_MS, MISSION_POLL_MS, type MissionStateEntry } from './contract'
import { enqueue as channelEnqueue, type EnqueueResult } from './command-channel'
import type { CompanionHostFacade } from './host-core'
import {
  MISSION_STATE_SUBSYSTEM,
  missionStateKey,
  missionViewInOf,
  projectMissions,
  type MissionViewIn,
  type ViewFacts
} from './mission-state-core'
import { repoRoot } from '../data-dir'
import type { MissionDetail } from '../missions/verbs-read'
import { reportUnreadableMissionFiles } from '../missions/store'
import type { BindingView } from './session-table'

const FEATURE = 'ui.quietRows'

export type MissionStateSender = (req: {
  sid: string
  args: { missions: MissionStateEntry[] }
}) => EnqueueResult | { ok: boolean }

export interface MissionStateFeedDeps {
  host: Pick<CompanionHostFacade, 'bus' | 'onBindingChange'>
  /**
   * The open missions of the repos of these folders that these sessions own or are linked to. Default:
   * the missions IPC's own read. `unreadable` names the mission files it could not parse: a read that
   * lost a mission to one says nothing about whether the mission is gone.
   */
  listViews?(
    folders: readonly string[],
    sessions: readonly string[]
  ): Promise<{ views: readonly MissionViewIn[]; unreadable: readonly string[] }>
  /** Enqueues a `mission.state` for a sid. The default is the app's one channel. */
  send?: MissionStateSender
  pollMs?: number
  debounceMs?: number
  log?(message: string): void
}

export interface MissionStateFeed {
  dispose(): void
}

interface Tracked {
  view: BindingView
  /** The key of the state the mod holds, `null` until one was sent. */
  sentKey: string | null
  /** True while the mod may hold missions (a non-empty state was sent and not yet cleared). */
  holds: boolean
  /** The ids of the missions the mod holds. */
  sentIds: string[]
  /** Set by a hello: the next read sends even when nothing changed. */
  force: boolean
  debounce: ReturnType<typeof setTimeout> | null
}

const defaultSend: MissionStateSender = ({ sid, args }) =>
  channelEnqueue({
    sessionKey: null,
    sid,
    name: 'mission.state',
    args,
    cause: { kind: 'internal', subsystem: MISSION_STATE_SUBSYSTEM }
  })

/** The id the read asks the view as: no session's, so it answers for the mission and never for a member. */
const READER_ID = 'harnu-companion'

/** How a mission's detail is read: the view channel's own builder, which gathers the facts of the steps. */
type ReadDetail = (folder: string, missionId: string) => Promise<MissionDetailRead>
/** A detail, with the facts the view gathered about its steps when the read had them (S-40, Decision 12). */
type MissionDetailRead = (MissionDetail & { viewFacts?: ViewFacts }) | { ok: false } | null

async function defaultReadDetail(folder: string, missionId: string): Promise<MissionDetailRead> {
  const { buildMissionV4View } = await import('../mission-ipc')
  const { getTaskState } = await import('../detect/task-state-hub')
  const reply = await buildMissionV4View({ folder, sessionId: READER_ID, missionId })
  if (reply.state !== 'mission') return null
  return {
    ...reply.detail,
    viewFacts: {
      ...(reply.stepFacts ? { steps: reply.stepFacts } : {}),
      taskState: (sid) => getTaskState(sid)
    }
  }
}

/**
 * Missions v4 S-23 — the open missions of the repos of `folders` that these sessions lead or work on, read
 * through the record store (a v4 record, or a v3 file converted in memory) and shaped for the mod. It
 * writes nothing. `unreadable` names the files the store could not parse.
 */
export async function readViewsFromRecords(
  folders: readonly string[],
  sessions: readonly string[],
  opts: { readDetail?: ReadDetail } = {}
): Promise<{ views: MissionViewIn[]; unreadable: string[] }> {
  const readDetail = opts.readDetail ?? defaultReadDetail
  const { listMissionRecords } = await import('../missions/record-store')
  const wanted = new Set(sessions)
  const views: MissionViewIn[] = []
  const unreadable: string[] = []
  const seen = new Set<string>()
  for (const folder of folders) {
    const root = repoRoot(folder)
    const listed = await listMissionRecords(root)
    unreadable.push(...listed.unreadable)
    for (const { record, source, sourceIds } of listed.records) {
      if (record.status !== 'open' || seen.has(record.id)) continue
      if (!record.sessions.some((e) => e.to === null && wanted.has(e.id))) continue
      seen.add(record.id)
      const detail = await readDetail(
        folder,
        source === 'v3-campaign' ? (sourceIds[0] ?? record.id) : record.id
      )
      if (detail && detail.ok) views.push(missionViewInOf(detail, detail.viewFacts))
    }
  }
  // A file this read could not parse is named to the app's unreadable list (one Activity notice, once
  // per file), never skipped silently: what the mod holds is kept, and the operator is told why.
  reportUnreadableMissionFiles('companion', unreadable)
  return { views, unreadable }
}

async function defaultListViews(
  folders: readonly string[],
  sessions: readonly string[]
): Promise<{ views: readonly MissionViewIn[]; unreadable: readonly string[] }> {
  return readViewsFromRecords(folders, sessions)
}

/** A binding whose session gets its missions: bound, lease live, interactive, enabled for the feature. */
const eligible = (b: BindingView): boolean =>
  b.state === 'bound' &&
  b.lease === 'live' &&
  b.profile === 'interactive' &&
  b.enabled.includes(FEATURE)

export function createMissionStateFeed(deps: MissionStateFeedDeps): MissionStateFeed {
  const listViews = deps.listViews ?? defaultListViews
  const send = deps.send ?? defaultSend
  const pollMs = deps.pollMs ?? MISSION_POLL_MS
  const debounceMs = deps.debounceMs ?? MISSION_DEBOUNCE_MS
  const log = deps.log ?? ((m: string): void => console.warn(`[companion] ${m}`))
  const tracked = new Map<number, Tracked>()
  // What a binding's mod was last told it holds, kept when the binding is dropped for a lost lease: a
  // hello again in the same boot finds the mod still holding it, and an empty snapshot is how it clears.
  const held = new Map<number, { holds: boolean; sentIds: string[] }>()
  let poll: ReturnType<typeof setInterval> | null = null
  let soon: ReturnType<typeof setTimeout> | null = null
  let running = false
  let again = false
  let disposed = false

  function stopTimers(): void {
    if (poll) clearInterval(poll)
    if (soon) clearTimeout(soon)
    poll = null
    soon = null
  }

  function drop(key: number, forget = false): void {
    const t = tracked.get(key)
    if (t?.debounce) clearTimeout(t.debounce)
    if (t && !forget) held.set(key, { holds: t.holds, sentIds: t.sentIds })
    if (forget) held.delete(key)
    tracked.delete(key)
    if (tracked.size === 0) stopTimers()
  }

  function push(t: Tracked, entries: MissionStateEntry[], key: string): void {
    try {
      const r = send({ sid: t.view.sid, args: { missions: entries } })
      if (!r.ok) {
        log(`mission state not sent: ${'reason' in r ? String(r.reason) : 'refused'}`)
        return // not recorded as sent: the next poll tries again
      }
      t.sentKey = key
      t.holds = entries.length > 0
      t.sentIds = entries.map((e) => e.id)
    } catch {
      log('mission state send failed')
    }
  }

  /** Arms the debounced send of what the mod should hold, or does nothing when it already holds it. */
  function want(t: Tracked, entries: MissionStateEntry[]): void {
    const key = missionStateKey(entries)
    const force = t.force
    t.force = false
    // A push armed by an earlier read is superseded by this one: never send a state that was replaced.
    if (t.debounce) clearTimeout(t.debounce)
    t.debounce = null
    // A session that never had a mission, and whose mod holds none, hears nothing.
    if (entries.length === 0 && !t.holds) return
    if (!force && key === t.sentKey) return
    t.debounce = setTimeout(() => {
      t.debounce = null
      push(t, entries, key)
    }, debounceMs)
    t.debounce.unref?.()
  }

  /** One pass: read the missions of every tracked folder once, then settle each binding. */
  async function pass(): Promise<void> {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        const byFolder = new Map<string, Tracked[]>()
        for (const t of tracked.values()) {
          byFolder.set(t.view.cwd, [...(byFolder.get(t.view.cwd) ?? []), t])
        }
        for (const [cwd, group] of byFolder) {
          let views: readonly MissionViewIn[]
          let unreadable: readonly string[]
          try {
            ;({ views, unreadable } = await listViews(
              [cwd],
              group.map((t) => t.view.sid)
            ))
          } catch {
            continue // a failed read changes nothing; the next poll tries again
          }
          if (disposed) return
          for (const t of group) {
            if (tracked.get(t.view.key) !== t) continue
            const entries = projectMissions(views, t.view.sid)
            // A mission file that would not parse may be one of this session's: what the mod holds
            // is kept until the read is whole, never replaced by a list that is short of a mission.
            if (
              unreadable.length > 0 &&
              t.sentIds.some((id) => !entries.some((e) => e.id === id))
            ) {
              continue
            }
            want(t, entries)
          }
        }
      } while (again && !disposed)
    } finally {
      running = false
    }
  }

  /** The next read, soon: two hellos in the same tick share one. */
  function readSoon(): void {
    if (soon || disposed) return
    soon = setTimeout(() => {
      soon = null
      void pass()
    }, 0)
    soon.unref?.()
  }

  function startPoll(): void {
    if (poll || disposed) return
    poll = setInterval(() => void pass(), pollMs)
    poll.unref?.()
  }

  function onHello(b: BindingView): void {
    if (!eligible(b)) return drop(b.key)
    const t = tracked.get(b.key)
    if (t) {
      t.view = b
      t.force = true
    } else {
      const was = held.get(b.key)
      tracked.set(b.key, {
        view: b,
        sentKey: null,
        holds: was?.holds ?? false,
        sentIds: was?.sentIds ?? [],
        force: true,
        debounce: null
      })
    }
    startPoll()
    readSoon()
  }

  /** A lease change, a re-key or an end: keep the newest view, drop what no longer qualifies. */
  function onChange(b: BindingView): void {
    const t = tracked.get(b.key)
    if (!t) return
    if (!eligible(b)) return drop(b.key)
    t.view = b
  }

  const offs = [
    deps.host.bus.on('hello', onHello),
    deps.host.bus.on('lease', onChange),
    deps.host.bus.on('end', (b) => drop(b.key, true)),
    deps.host.onBindingChange(onChange)
  ]

  return {
    dispose() {
      disposed = true
      for (const off of offs) off()
      for (const key of [...tracked.keys()]) drop(key, true)
      stopTimers()
    }
  }
}
