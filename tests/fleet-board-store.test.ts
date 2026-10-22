// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { Session } from '../src/renderer/src/stores/sessions'
import { useLayoutStore } from '../src/renderer/src/stores/layout'

/** A full Session slice (mirrors the session() factory in sessions-store.test.ts). */
function session(over: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    fullPath: '/repos/alpha/s1.jsonl',
    fileMtime: 1,
    firstPrompt: '',
    summary: 'one',
    messageCount: 1,
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    gitBranch: '',
    projectPath: '/repos/alpha',
    isSidechain: false,
    status: 'idle',
    resumable: true,
    bridged: false,
    ...over
  } as Session
}

function seed(
  store: ReturnType<typeof useSessionsStore>,
  folders: Array<{ alias: string; gitBranch?: string; sessions: Session[] }>
): void {
  store.folders.splice(0, store.folders.length)
  for (const f of folders) {
    store.folders.push({
      path: `/repos/${f.alias}`,
      alias: f.alias,
      gitBranch: f.gitBranch ?? '',
      sessions: f.sessions,
      expanded: true,
      pinned: false
    } as (typeof store.folders)[number])
  }
}

describe('boardBuckets projection', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => localStorage.clear())

  it('projects folders into urgency-ordered buckets and resolves folderAlias', () => {
    const store = useSessionsStore()
    seed(store, [
      { alias: 'api', sessions: [session({ sessionId: 'n1', taskState: 'needs-input' })] },
      {
        alias: 'web',
        // A working session with FRESH output — its transcript just grew, so it is
        // `working`, not `stuck` (a stale `modified` would age it past N).
        sessions: [
          session({
            sessionId: 'w1',
            taskState: 'working',
            status: 'active',
            modified: new Date().toISOString()
          })
        ]
      }
    ])
    const buckets = store.boardBuckets
    expect(buckets.map((b) => b.state)).toEqual(['needs-input', 'working'])
    expect(buckets[0].sessions[0].sessionId).toBe('n1')
    expect(buckets[0].sessions[0].folderAlias).toBe('api')
    expect(buckets[1].sessions[0].folderAlias).toBe('web')
  })

  it('BUG-13: a working session gone quiet past N lands in the stuck bucket', () => {
    const store = useSessionsStore()
    seed(store, [
      {
        alias: 'api',
        sessions: [
          session({
            sessionId: 'slow',
            taskState: 'working',
            status: 'idle',
            // last transcript growth ~10 min ago → well past the 3-min N.
            modified: new Date(Date.now() - 10 * 60_000).toISOString()
          })
        ]
      }
    ])
    expect(store.boardBuckets.map((b) => b.state)).toEqual(['stuck'])
    expect(store.boardBuckets[0].sessions[0].activity).toBe('stuck')
  })

  it('BUG-15: a quiet orchestrator with a live sub-agent is working, not stuck/idle', () => {
    const store = useSessionsStore()
    seed(store, [
      {
        alias: 'orch',
        sessions: [
          session({
            sessionId: 'lead',
            taskState: 'working',
            status: 'idle',
            // main transcript silent for ~2h — but a child is alive.
            modified: new Date(Date.now() - 120 * 60_000).toISOString(),
            agents: [
              {
                agentId: 'a1',
                parentSessionId: 'lead',
                fullPath: '',
                fileMtime: 1,
                agentType: 'general-purpose',
                skill: '',
                plugin: '',
                model: '',
                task: 'red-team',
                status: 'running',
                created: '',
                modified: ''
              }
            ]
          } as Session)
        ]
      }
    ])
    expect(store.boardBuckets.map((b) => b.state)).toEqual(['working'])
  })

  it('excludes sidechains from every bucket', () => {
    const store = useSessionsStore()
    seed(store, [
      {
        alias: 'api',
        sessions: [
          session({ sessionId: 'top', taskState: 'working', status: 'active' }),
          session({ sessionId: 'sub', taskState: 'working', status: 'active', isSidechain: true })
        ]
      }
    ])
    const all = store.boardBuckets.flatMap((b) => b.sessions.map((s) => s.sessionId))
    expect(all).toContain('top')
    expect(all).not.toContain('sub')
  })

  it('excludes archived sessions from every bucket (consistent with the tree)', () => {
    const store = useSessionsStore()
    seed(store, [
      {
        alias: 'api',
        sessions: [
          session({ sessionId: 'live', taskState: 'idle' }),
          session({ sessionId: 'gone', taskState: 'idle' })
        ]
      }
    ])
    store.archiveSession('gone')
    const all = store.boardBuckets.flatMap((b) => b.sessions.map((s) => s.sessionId))
    expect(all).toContain('live')
    expect(all).not.toContain('gone')
  })

  it('honours the inline filterQuery per-card (folder alias OR session fields)', () => {
    const store = useSessionsStore()
    seed(store, [
      {
        alias: 'api',
        sessions: [session({ sessionId: 'a1', summary: 'auth refactor', taskState: 'idle' })]
      },
      {
        alias: 'web',
        sessions: [session({ sessionId: 'w1', summary: 'checkout flow', taskState: 'idle' })]
      }
    ])
    store.setFilterQuery('checkout')
    const ids = store.boardBuckets.flatMap((b) => b.sessions.map((s) => s.sessionId))
    expect(ids).toEqual(['w1'])

    store.setFilterQuery('api') // matches folder alias
    const ids2 = store.boardBuckets.flatMap((b) => b.sessions.map((s) => s.sessionId))
    expect(ids2).toEqual(['a1'])

    store.setFilterQuery('')
    expect(store.boardBuckets.flatMap((b) => b.sessions).length).toBe(2)
  })

  const inTier = (store: ReturnType<typeof useSessionsStore>, state: string): string[] =>
    store.boardBuckets.find((b) => b.state === state)?.sessions.map((s) => s.sessionId) ?? []

  it('T459 AC-1/AC-5: attention tiers order by creation (newest first), not by modified', () => {
    const store = useSessionsStore()
    seed(store, [
      {
        alias: 'api',
        sessions: [
          session({
            sessionId: 'created-first',
            taskState: 'needs-input',
            created: '2026-05-01T00:00:00.000Z',
            modified: new Date().toISOString()
          }),
          session({
            sessionId: 'created-last',
            taskState: 'needs-input',
            created: '2026-05-02T00:00:00.000Z',
            modified: new Date(Date.now() - 600_000).toISOString()
          })
        ]
      }
    ])
    expect(inTier(store, 'needs-input')).toEqual(['created-last', 'created-first'])
  })

  it('T459 AC-1: a modified bump on a working session never reorders the bucket', () => {
    const store = useSessionsStore()
    seed(store, [
      {
        alias: 'api',
        sessions: ['a', 'b', 'c'].map((id, i) =>
          session({
            sessionId: id,
            taskState: 'working',
            status: 'active',
            created: `2026-05-0${i + 1}T00:00:00.000Z`,
            // Well under STUCK_AFTER_MS (3min) — stays `working`, not `stuck`.
            modified: new Date(Date.now() - (30 - i) * 1000).toISOString()
          })
        )
      }
    ])
    expect(inTier(store, 'working')).toEqual(['c', 'b', 'a'])
    // The oldest-created session is now the most recently active one.
    store.folders[0].sessions.find((s) => s.sessionId === 'a')!.modified = new Date().toISOString()
    expect(inTier(store, 'working')).toEqual(['c', 'b', 'a'])
  })

  it('T459 AC-2: tiers stay in BOARD_STATES order and a state change moves the session', () => {
    const store = useSessionsStore()
    seed(store, [
      {
        alias: 'api',
        sessions: [
          session({
            sessionId: 'w',
            taskState: 'working',
            status: 'active',
            modified: new Date().toISOString(),
            created: '2026-05-03T00:00:00.000Z'
          }),
          session({
            sessionId: 'n',
            taskState: 'needs-input',
            created: '2026-05-01T00:00:00.000Z'
          }),
          session({ sessionId: 'd', taskState: 'completed', created: '2026-05-09T00:00:00.000Z' })
        ]
      }
    ])
    expect(store.boardBuckets.map((b) => b.state)).toEqual(['needs-input', 'working', 'done'])
    store.folders[0].sessions.find((s) => s.sessionId === 'w')!.taskState = 'failed'
    expect(store.boardBuckets.map((b) => b.state)).toEqual(['needs-input', 'errored', 'done'])
  })

  it('T459 AC-3/AC-4: the layout toggle inverts every group, and it round-trips', () => {
    const store = useSessionsStore()
    const layout = useLayoutStore()
    seed(store, [
      {
        alias: 'api',
        sessions: [
          session({
            sessionId: 'n1',
            taskState: 'needs-input',
            created: '2026-05-01T00:00:00.000Z'
          }),
          session({
            sessionId: 'n2',
            taskState: 'needs-input',
            created: '2026-05-02T00:00:00.000Z'
          }),
          session({ sessionId: 'd1', taskState: 'completed', created: '2026-05-03T00:00:00.000Z' }),
          session({ sessionId: 'd2', taskState: 'completed', created: '2026-05-04T00:00:00.000Z' })
        ]
      }
    ])
    expect(layout.inboxRailOrder).toBe('newest-first')
    expect(inTier(store, 'needs-input')).toEqual(['n2', 'n1'])
    expect(inTier(store, 'done')).toEqual(['d2', 'd1'])
    layout.toggleInboxRailOrder()
    expect(layout.inboxRailOrder).toBe('oldest-first')
    expect(inTier(store, 'needs-input')).toEqual(['n1', 'n2'])
    expect(inTier(store, 'done')).toEqual(['d1', 'd2'])
    expect(store.boardBuckets.map((b) => b.state)).toEqual(['needs-input', 'done'])
    layout.toggleInboxRailOrder()
    expect(inTier(store, 'needs-input')).toEqual(['n2', 'n1'])
  })

  it('T459 AC-7: a session with an invalid created sorts last in both directions', () => {
    const store = useSessionsStore()
    const layout = useLayoutStore()
    seed(store, [
      {
        alias: 'api',
        sessions: [
          session({ sessionId: 'bad', taskState: 'completed', created: '' }),
          session({
            sessionId: 'ok1',
            taskState: 'completed',
            created: '2026-05-01T00:00:00.000Z'
          }),
          session({ sessionId: 'ok2', taskState: 'completed', created: '2026-05-02T00:00:00.000Z' })
        ]
      }
    ])
    expect(inTier(store, 'done')).toEqual(['ok2', 'ok1', 'bad'])
    layout.toggleInboxRailOrder()
    expect(inTier(store, 'done')).toEqual(['ok1', 'ok2', 'bad'])
  })

  it('recomputes reactively when a session taskState changes', () => {
    const store = useSessionsStore()
    seed(store, [{ alias: 'api', sessions: [session({ sessionId: 'x', taskState: 'idle' })] }])
    expect(store.boardBuckets[0].state).toBe('idle')
    // mutate through the reactive proxy (raw-object mutations don't track)
    store.folders[0].sessions[0].taskState = 'needs-input'
    expect(store.boardBuckets[0].state).toBe('needs-input')
  })
})
