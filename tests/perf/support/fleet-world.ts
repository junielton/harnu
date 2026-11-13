/**
 * The real sessions store at reference scale, for the renderer cases that measure what ONE session event
 * costs (BUG-265).
 *
 * `cases.ts` runs pure functions over a generated fleet. The bug here is not in a pure function: it is
 * that every hook event or transcript append re-runs, in full, every computed that reads the fleet. So
 * this builds the real Pinia store through its real `init()` (a stubbed `window.api` hands it the fleet
 * and keeps the listeners), fires events through the same listeners the preload would call, and counts
 * the reads of session fields while ONE computed is evaluated afterwards.
 *
 * Counting is exact and machine-independent: every field of every session is replaced by an accessor
 * that increments `counter.n` while `armed`. The reads of the event handler itself are not counted
 * (`fire` runs unarmed): the question a case asks is what the computed re-reads, not what the handler
 * does.
 */

import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { toRaw } from 'vue'
import type { FolderEntry } from '../../../src/preload'
import type { ScaleSpec } from './scale-fixture'

type DiskSession = FolderEntry['sessions'][number]
type Listener = (payload: never) => void

export interface FleetWorld {
  /** The Pinia instance the store lives in, for a case that mounts a component against it. */
  pinia: Pinia
  /** The store, typed loosely on purpose: the cases read named computeds from it. */
  store: Record<string, unknown> & {
    allSessions: Array<{ sessionId: string }>
  }
  /** How many sessions the fleet holds. */
  size: number
  /**
   * One session event for session `k`: a hook event (task state flips between working and idle, which
   * also stamps the last-event clock) followed by a transcript append (stamps `modified`). Unarmed.
   */
  fire(k: number): void
  /** Counts reads of session fields into the counter until `disarm()`. */
  arm(): void
  disarm(): void
  dispose(): void
}

const NOW = 1_760_000_000_000

function diskSession(folder: number, n: number, path: string, live: boolean): DiskSession {
  return {
    sessionId: `s-${folder}-${n}`,
    fullPath: `${path}/s-${folder}-${n}.jsonl`,
    fileMtime: NOW - folder * 60_000,
    firstPrompt: `prompt ${folder}-${n}`,
    summary: `session ${folder}-${n}`,
    messageCount: 12,
    created: new Date(NOW - 86_400_000 - folder * 1_000 - n).toISOString(),
    modified: new Date(NOW - folder * 60_000 - n).toISOString(),
    gitBranch: '',
    projectPath: path,
    isSidechain: false,
    status: live ? 'active' : 'idle',
    transcriptState: live ? 'working' : 'idle',
    agents: [],
    resumable: true,
    bridged: false
  } as DiskSession
}

/** The fleet of `spec`: one folder per slug with its sessions, every 40th folder's first session live. */
export function fleetDisk(spec: ScaleSpec): { disk: FolderEntry[]; liveIds: string[] } {
  const perFolder = Math.max(1, Math.round(spec.knownSessions / spec.slugs))
  const disk: FolderEntry[] = []
  const liveIds: string[] = []
  for (let i = 0; i < spec.slugs; i++) {
    const path = `/home/dev/Workspace/org/proj${i}/www`
    const sessions: DiskSession[] = []
    for (let n = 0; n < perFolder; n++) {
      const live = n === 0 && i % 40 === 0
      const s = diskSession(i, n, path, live)
      if (live) liveIds.push(s.sessionId)
      sessions.push(s)
    }
    disk.push({ path, alias: `proj${i}`, gitBranch: '', sessions } as FolderEntry)
  }
  return { disk, liveIds }
}

export async function buildFleetWorld(
  spec: ScaleSpec,
  counter: { n: number }
): Promise<FleetWorld> {
  const { disk, liveIds } = fleetDisk(spec)
  const listeners: Record<string, Listener | undefined> = {}
  const on =
    (name: string) =>
    (fn: Listener): (() => void) => {
      listeners[name] = fn
      return () => undefined
    }
  const known: Record<string, unknown> = {
    foldersLoad: async () =>
      disk.map((f) => ({ ...f, sessions: f.sessions.map((s) => ({ ...s })) })),
    userProjectsList: async () => ({ projects: [], hiddenPaths: [] }),
    orchestratorListArmed: async () => [],
    approvalsList: async () => [],
    mcpConfirmsList: async () => [],
    onHook: on('onHook'),
    onSessionRegistry: on('onSessionRegistry'),
    onSessionUpdated: on('onSessionUpdated'),
    fleetReportShellSessions: () => undefined
  }
  const g = globalThis as unknown as { window?: Record<string, unknown> }
  const hadWindow = 'window' in g
  const prevWindow = g.window
  const api = new Proxy(known, {
    // Anything else: an `onX` subscribes (and is never fired), any other call resolves to nothing.
    get: (t, k: string) => (k in t ? t[k] : k.startsWith('on') ? on(k) : async () => undefined),
    has: () => true
  })
  // Under jsdom (a case that mounts a component) the real window stays and only gets an `api`.
  const jsdom = typeof prevWindow?.document === 'object'
  const prevApi = jsdom ? prevWindow?.api : undefined
  if (jsdom) (prevWindow as Record<string, unknown>).api = api
  else g.window = { api, addEventListener: () => undefined, removeEventListener: () => undefined }
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useSessionsStore } = await import('../../../src/renderer/src/stores/sessions')
  const store = useSessionsStore() as unknown as FleetWorld['store'] & {
    init(): Promise<void>
    folders: Array<{ sessions: Array<Record<string, unknown>> }>
  }
  await store.init()

  // Count the reads of every session field from here on.
  let armed = false
  for (const folder of store.folders) {
    for (const session of folder.sessions) {
      const raw = toRaw(session) as Record<string, unknown>
      for (const key of Object.keys(raw)) {
        let value = raw[key]
        Object.defineProperty(raw, key, {
          configurable: true,
          enumerable: true,
          get() {
            if (armed) counter.n++
            return value
          },
          set(v: unknown) {
            value = v
          }
        })
      }
    }
  }

  const ids = store.allSessions.map((s) => s.sessionId)
  const live = new Set(liveIds)
  let tick = 0
  return {
    pinia,
    store,
    size: ids.length,
    fire(k) {
      const sessionId = ids[k % ids.length]
      tick++
      const ts = NOW + tick * 1_000
      const taskState = live.has(sessionId) || tick % 2 === 0 ? 'working' : 'idle'
      ;(listeners.onHook as unknown as (p: unknown) => void)?.({ sessionId, taskState, ts })
      ;(listeners.onSessionUpdated as unknown as (p: unknown) => void)?.({
        slug: '',
        sessionId,
        transcriptState: taskState === 'working' ? 'working' : 'idle'
      })
    },
    arm() {
      armed = true
    },
    disarm() {
      armed = false
    },
    dispose() {
      armed = false
      if (jsdom) (prevWindow as Record<string, unknown>).api = prevApi
      else if (hadWindow) g.window = prevWindow
      else delete g.window
    }
  }
}
