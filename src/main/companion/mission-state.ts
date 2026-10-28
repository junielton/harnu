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
  projectMissions,
  type MissionViewIn
} from './mission-state-core'
import type { BindingView } from './session-table'

const FEATURE = 'ui.quietRows'

export type MissionStateSender = (req: {
  sid: string
  args: { missions: MissionStateEntry[] }
}) => EnqueueResult | { ok: boolean }

export interface MissionStateFeedDeps {
  host: Pick<CompanionHostFacade, 'bus' | 'onBindingChange'>
  /** The open missions of the repos of these folders. Default: the missions IPC's own read. */
  listViews?(folders: readonly string[]): Promise<{ views: readonly MissionViewIn[] }>
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

async function defaultListViews(
  folders: readonly string[]
): Promise<{ views: readonly MissionViewIn[] }> {
  // Loaded on first use: the missions IPC pulls in Electron, which the tests of this file never need.
  const { listMissionViews } = await import('../mission-ipc')
  return { views: (await listMissionViews(folders)).views as unknown as MissionViewIn[] }
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

  function drop(key: number): void {
    const t = tracked.get(key)
    if (t?.debounce) clearTimeout(t.debounce)
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
    } catch {
      log('mission state send failed')
    }
  }

  /** Arms the debounced send of what the mod should hold, or does nothing when it already holds it. */
  function want(t: Tracked, entries: MissionStateEntry[]): void {
    const key = missionStateKey(entries)
    const force = t.force
    t.force = false
    // A session that never had a mission, and whose mod holds none, hears nothing.
    if (entries.length === 0 && !t.holds) return
    if (!force && key === t.sentKey) return
    if (t.debounce) clearTimeout(t.debounce)
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
          try {
            views = (await listViews([cwd])).views
          } catch {
            continue // a failed read changes nothing; the next poll tries again
          }
          if (disposed) return
          for (const t of group) {
            if (tracked.get(t.view.key) !== t) continue
            want(t, projectMissions(views, t.view.sid))
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
      tracked.set(b.key, { view: b, sentKey: null, holds: false, force: true, debounce: null })
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
    deps.host.bus.on('end', (b) => drop(b.key)),
    deps.host.onBindingChange(onChange)
  ]

  return {
    dispose() {
      disposed = true
      for (const off of offs) off()
      for (const key of [...tracked.keys()]) drop(key)
      stopTimers()
    }
  }
}
