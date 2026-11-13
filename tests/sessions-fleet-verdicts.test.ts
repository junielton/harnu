import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { FolderEntry } from '../src/preload'
import { buildBoard, type BoardSession } from '../src/renderer/src/components/fleet-board'
import {
  STUCK_AFTER_MS,
  classifyFleetState,
  resolveActivity
} from '../src/renderer/src/stores/fleet-state'
import { FORGOTTEN_THRESHOLD_MS } from '../src/renderer/src/stores/closure-core'
import { sessionTitle } from '../src/renderer/src/lib/session-label'
import { i18n } from '../src/renderer/src/i18n'

/**
 * BUG-265: `supervisionLoad` and `boardBuckets` fold one cached verdict per session instead of looping
 * over the whole fleet. This pins that the cached form is the SAME function of the same inputs as the loop
 * it replaced: the reference below is that loop, verbatim, and a seeded stream of the events the app really
 * receives (hook, registry, transcript append, approvals, archive, selection, the 30 s clock, the inline
 * filter, rows coming and going) must leave both in agreement after every single step.
 */

type DiskSession = FolderEntry['sessions'][number]
const T0 = 1_760_000_000_000
const FOLDERS = 6
const PER_FOLDER = 5

function diskSession(folder: number, n: number): DiskSession {
  return {
    sessionId: `s-${folder}-${n}`,
    fullPath: `/x/${folder}/s-${folder}-${n}.jsonl`,
    fileMtime: 1,
    firstPrompt: `prompt ${folder} ${n}`,
    summary: `session ${folder} ${n}`,
    messageCount: 3,
    created: new Date(T0 - (folder * 10 + n) * 60_000).toISOString(),
    modified: new Date(T0 - n * 20_000).toISOString(),
    gitBranch: folder % 2 === 0 ? 'main' : '',
    projectPath: `/repos/f${folder}`,
    isSidechain: false,
    status: 'idle',
    transcriptState: n % 3 === 0 ? 'working' : 'idle',
    agents: [],
    resumable: true,
    bridged: false
  } as DiskSession
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let cb: Record<string, ((p: never) => void) | undefined>
function installWindow(disk: FolderEntry[]): void {
  cb = {}
  const on =
    (name: string) =>
    (fn: (p: never) => void): (() => void) => {
      cb[name] = fn
      return () => undefined
    }
  const known: Record<string, unknown> = {
    foldersLoad: async () =>
      disk.map((f) => ({ ...f, sessions: f.sessions.map((s) => ({ ...s })) })),
    userProjectsList: async () => ({ projects: [], hiddenPaths: [] }),
    orchestratorListArmed: async () => [],
    approvalsList: async () => [],
    fleetReportShellSessions: () => undefined
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    api: new Proxy(known, {
      get: (t, k: string) => (k in t ? t[k] : k.startsWith('on') ? on(k) : async () => undefined),
      has: () => true
    }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
  cb.onHook = undefined
}

describe('supervisionLoad / boardBuckets are the loop they replaced (BUG-265)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    setActivePinia(createPinia())
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('agrees with the reference loop after every event of a seeded random stream', async () => {
    const disk: FolderEntry[] = Array.from({ length: FOLDERS }, (_, f) => ({
      path: `/repos/f${f}`,
      alias: `alias${f}`,
      gitBranch: f % 2 === 0 ? 'main' : '',
      sessions: Array.from({ length: PER_FOLDER }, (_, n) => diskSession(f, n))
    })) as FolderEntry[]
    installWindow(disk)
    const store = useSessionsStore()
    await store.init()
    const bootMs = Date.now()

    // Inputs the store keeps private: mirrored here from the same events, to feed the reference.
    const lastEvent = new Map<string, number>()
    const viewedAt = new Map<string, number>()
    const ids = (): string[] => store.allSessions.map((s) => s.sessionId)
    store.folders[0].sessions[1].isSidechain = true
    store.folders[1].sessions[1].isShellTerminal = true

    const referenceLoad = (): number => {
      const now = store.nowTick
      const parked = new Set<string>()
      for (const w of store.pendingApprovals.values()) parked.add(w.sessionId)
      let n = 0
      for (const s of store.allSessions) {
        if (s.isSidechain || s.isShellTerminal) continue
        if (store.archivedIds.has(s.sessionId)) continue
        const state = classifyFleetState(
          {
            taskState: s.taskState,
            transcriptState: s.transcriptState,
            stagnation: s.stagnation,
            registryState: store.registryStates.get(s.sessionId),
            status: s.status,
            modifiedMs: Date.parse(s.modified),
            liveAgentCount: (s.agents ?? []).filter((a) => a.status === 'running').length,
            lastEventMs: lastEvent.get(s.sessionId),
            hasParkedApproval: parked.has(s.sessionId),
            lastViewedMs: viewedAt.get(s.sessionId) ?? bootMs,
            isViewing: s.sessionId === store.selectedId,
            isLive:
              store.isSessionLive(s.sessionId) ||
              store.registryStates.has(s.sessionId) ||
              lastEvent.has(s.sessionId)
          },
          { nowMs: now, stuckAfterMs: STUCK_AFTER_MS, forgottenAfterMs: FORGOTTEN_THRESHOLD_MS }
        )
        if (state === 'working' || state === 'needs-you') n++
      }
      return n
    }

    const matches = (text: string, q: string): boolean =>
      text.toLowerCase().includes(q.toLowerCase())
    const referenceBoard = (): unknown => {
      const q = store.filterQuery.trim()
      const now = store.nowTick
      const slices: BoardSession[] = []
      for (const f of store.folders) {
        for (const s of f.sessions) {
          if (s.isSidechain || s.isShellTerminal) continue
          if (store.archivedIds.has(s.sessionId)) continue
          if (q) {
            const hit =
              matches(f.alias, q) ||
              (f.gitBranch ? matches(f.gitBranch, q) : false) ||
              matches(s.summary, q) ||
              matches(s.firstPrompt, q) ||
              matches(sessionTitle(s, store.allSessions, i18n.global.t), q)
            if (!hit) continue
          }
          const activity = resolveActivity(
            {
              taskState: s.taskState,
              transcriptState: s.transcriptState,
              stagnation: s.stagnation,
              registryState: store.registryStates.get(s.sessionId),
              status: s.status,
              modifiedMs: Date.parse(s.modified),
              liveAgentCount: (s.agents ?? []).filter((a) => a.status === 'running').length,
              lastEventMs: lastEvent.get(s.sessionId),
              isLive:
                store.isSessionLive(s.sessionId) ||
                store.registryStates.has(s.sessionId) ||
                lastEvent.has(s.sessionId)
            },
            { nowMs: now, stuckAfterMs: STUCK_AFTER_MS }
          )
          slices.push({
            sessionId: s.sessionId,
            taskState: s.taskState,
            transcriptState: s.transcriptState,
            status: s.status,
            isSidechain: s.isSidechain,
            modified: s.modified,
            created: s.created,
            activity,
            folderAlias: f.alias
          })
        }
      }
      return JSON.parse(JSON.stringify(buildBoard(slices, 'newest-first')))
    }
    const actualBoard = (): unknown => JSON.parse(JSON.stringify(store.boardBuckets))

    const rnd = mulberry32(20261113)
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
    let elapsed = 0
    let seq = 0
    let extra = 0
    const states = ['working', 'idle', 'needs-input', 'completed', 'failed'] as const
    const log: string[] = []

    const check = (step: string): void => {
      log.push(step)
      expect(store.supervisionLoad, `supervisionLoad after ${log.slice(-6).join(' > ')}`).toBe(
        referenceLoad()
      )
      expect(actualBoard(), `boardBuckets after ${log.slice(-6).join(' > ')}`).toEqual(
        referenceBoard()
      )
    }
    check('initial')

    for (let i = 0; i < 400; i++) {
      const id = pick(ids())
      const kind = Math.floor(rnd() * 13)
      vi.setSystemTime(T0 + elapsed)
      switch (kind) {
        case 0:
        case 1:
        case 2: {
          // a hook event: task state + the last-event clock
          const taskState = pick(states)
          const ts = T0 + elapsed - Math.floor(rnd() * 12) * 20_000
          cb.onHook!({ sessionId: id, taskState, ts } as never)
          if ((lastEvent.get(id) ?? -Infinity) < ts) lastEvent.set(id, ts)
          check(`hook ${id} ${taskState}`)
          break
        }
        case 3: {
          const taskState = pick([...states, null] as const)
          const updatedAt = T0 + elapsed - Math.floor(rnd() * 12) * 20_000
          cb.onSessionRegistry!({
            sessionId: id,
            taskState: taskState === 'completed' || taskState === 'failed' ? 'idle' : taskState,
            updatedAt
          } as never)
          if ((lastEvent.get(id) ?? -Infinity) < updatedAt) lastEvent.set(id, updatedAt)
          check(`registry ${id} ${taskState}`)
          break
        }
        case 4:
        case 5: {
          // a transcript append: stamps `modified`, may carry a transcript state
          const transcriptState = pick(['working', 'idle', 'needs-input', undefined] as const)
          cb.onSessionUpdated!({ slug: '', sessionId: id, transcriptState } as never)
          check(`append ${id} ${transcriptState}`)
          break
        }
        case 6: {
          const requestId = `r${seq++}`
          store.addPendingApproval({
            requestId,
            sessionId: id,
            kind: 'permission',
            toolName: 'Bash',
            toolInput: {},
            summary: 'Bash(ls)',
            createdAtMs: T0,
            deadlineMs: T0 + 1
          } as never)
          check(`approval+ ${id}`)
          if (rnd() < 0.5) {
            store.removePendingApproval(requestId)
            check(`approval- ${id}`)
          }
          break
        }
        case 7: {
          if (store.archivedIds.has(id)) store.unarchiveSession(id)
          else store.archiveSession(id)
          check(`archive-toggle ${id}`)
          break
        }
        case 8: {
          store.select(id)
          viewedAt.set(id, Date.now())
          await Promise.resolve()
          check(`select ${id}`)
          break
        }
        case 9: {
          elapsed += pick([1, 2, 4, 7, 11, 13]) * 60_000
          vi.setSystemTime(T0 + elapsed)
          store.nowTick = Date.now()
          check(`tick +${elapsed / 60_000}min`)
          break
        }
        case 10: {
          const q = pick(['', '', 'alias1', 'session 2', 'main', 'prompt 4 3'])
          store.setFilterQuery(q)
          check(`filter "${q}"`)
          break
        }
        case 11: {
          const s = store.folders.flatMap((f) => f.sessions).find((x) => x.sessionId === id)
          if (s) {
            s.agents = rnd() < 0.5 ? [] : ([{ agentId: 'a', status: 'running' }] as never)
            s.status = pick(['active', 'idle'] as const)
          }
          check(`agents/status ${id}`)
          break
        }
        default: {
          // rows coming and going, and a session going live in a PTY
          const roll = rnd()
          if (roll < 0.5) {
            const folder = store.folders[Math.floor(rnd() * store.folders.length)]
            folder.sessions.push({
              ...diskSession(90, extra++),
              projectPath: folder.path,
              sessionId: `x-${extra}`,
              modified: new Date(Date.now()).toISOString()
            } as never)
            check(`add x-${extra}`)
          } else if (roll < 0.75) {
            store.registerLiveSession(id)
            check(`live ${id}`)
          } else {
            const folder = store.folders.find((f) => f.sessions.some((x) => x.sessionId === id))
            const at = folder?.sessions.findIndex((x) => x.sessionId === id) ?? -1
            if (folder && at >= 0 && ids().length > 12) {
              folder.sessions.splice(at, 1)
              check(`remove ${id}`)
            }
          }
        }
      }
    }
  })

  it('the registry and last-event overlays move only the session they name', async () => {
    // No hook state anywhere: the verdicts come from the overlays and the transcript alone.
    const disk = [
      {
        path: '/repos/f0',
        alias: 'alias0',
        gitBranch: '',
        sessions: [0, 1, 2].map((n) => ({ ...diskSession(0, n), transcriptState: 'idle' }))
      }
    ] as FolderEntry[]
    installWindow(disk)
    const store = useSessionsStore()
    await store.init()
    const bucketOf = (id: string): string | undefined =>
      store.boardBuckets.find((b) => b.sessions.some((x) => x.sessionId === id))?.state

    // 5 min on: transcript growth is past the 3 min quiet threshold, and a block is still fresh
    // (it ages into "return here" only after 10 min unseen).
    vi.setSystemTime(T0 + 5 * 60_000)
    store.nowTick = Date.now()
    expect(store.supervisionLoad).toBe(0)

    cb.onSessionRegistry!({
      sessionId: 's-0-0',
      taskState: 'working',
      updatedAt: Date.now()
    } as never)
    expect(store.supervisionLoad).toBe(1)
    expect(bucketOf('s-0-0')).toBe('working')

    cb.onSessionRegistry!({
      sessionId: 's-0-1',
      taskState: 'needs-input',
      updatedAt: Date.now()
    } as never)
    expect(store.supervisionLoad).toBe(2)
    // The footer count reads the registry's block; the board's `needs-input` bucket never did (it reads
    // the hook and transcript states), so this card stays `idle` there. Unchanged by BUG-265.
    expect(bucketOf('s-0-1')).toBe('idle')

    cb.onSessionRegistry!({ sessionId: 's-0-0', taskState: null, updatedAt: Date.now() } as never)
    expect(store.supervisionLoad).toBe(1)
    expect(bucketOf('s-0-0')).toBe('idle')

    // A hook says working, but its last sign of life is 10 min old: stuck, not counted.
    cb.onHook!({ sessionId: 's-0-2', taskState: 'working', ts: Date.now() - 10 * 60_000 } as never)
    expect(bucketOf('s-0-2')).toBe('stuck')
    expect(store.supervisionLoad).toBe(1)

    // A fresh liveness ping for THAT session revives it, and nobody else.
    cb.onLiveness!({ sessionId: 's-0-2', ts: Date.now() } as never)
    expect(bucketOf('s-0-2')).toBe('working')
    expect(store.supervisionLoad).toBe(2)
    expect(bucketOf('s-0-0')).toBe('idle')
  })
})
