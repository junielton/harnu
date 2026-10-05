// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore, type Folder, type Session } from '../src/renderer/src/stores/sessions'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { buildDispatchActions } from '../src/renderer/src/stores/command-dispatch'

/**
 * 2026-07-13 agent-pane-routing design — the two root causes pinned together:
 *
 *  1. **The hijack** (`command-dispatch.ts:134`, now removed): an agent pane
 *     used to route by `sessions.selectedSession?.projectPath` — whichever
 *     folder the operator happened to be looking at when the tool FIRED, not
 *     the folder that asked for it. Regression test below: dispatch with
 *     folder A selected as B, assert the pane lands in A.
 *  2. **The badge + coalesced alert** (new): an agent-origin pane landing in
 *     a non-visible folder must increment that folder's unseen counter and
 *     queue exactly one coalesced OS alert per burst; a human-origin pane
 *     (every non-agent call site) must never touch either.
 *
 * `window.api` is untouched by any assertion here — `mutateWorktree`'s flush
 * and the alert's `notify` call are both scheduled via `setTimeout`, so a
 * synchronous test never reaches them (this store touches `window` only past
 * that boundary, matching `sessions-store.test.ts`'s no-mock convention).
 */

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-default',
    fullPath: '',
    fileMtime: 0,
    firstPrompt: '',
    summary: '',
    messageCount: 0,
    created: '',
    modified: '2026-07-13T00:00:00.000Z',
    gitBranch: '',
    projectPath: '/repo/a',
    isSidechain: false,
    status: 'active',
    resumable: true,
    bridged: false,
    ...overrides
  }
}

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    path: '/repo/a',
    alias: 'a',
    sessions: [],
    expanded: true,
    pinned: true,
    ...overrides
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('agent-pane-routing — the hijack regression', () => {
  it('open_file (folder A) while the operator is looking at folder B lands the pane in A, not B', () => {
    const sessions = useSessionsStore()
    const helpers = useHelpersStore()

    const sessB = makeSession({ sessionId: 'sess-b', projectPath: '/repo/b' })
    sessions.folders = [
      makeFolder({ path: '/repo/a', alias: 'a', sessions: [] }),
      makeFolder({ path: '/repo/b', alias: 'b', sessions: [sessB] })
    ]
    // The operator is currently looking at folder B.
    sessions.select('sess-b')
    expect(sessions.selectedSession?.projectPath).toBe('/repo/b')

    const actions = buildDispatchActions()
    // The router hands the shim the CALLING session's folder (A) — exactly
    // what `openFileHandler` dispatches after `resolvePaneFolder` resolves it.
    actions.addMarkdownHelper('/repo/a', '/repo/a/design.md', '/repo/a')

    expect(helpers.byWorktree.get('/repo/a')?.panes).toHaveLength(1)
    expect(helpers.byWorktree.get('/repo/a')?.panes[0]).toMatchObject({
      type: 'markdown',
      filePath: '/repo/a/design.md'
    })
    // Folder B (the live selection) never receives it — that was the bug.
    expect(helpers.byWorktree.get('/repo/b')).toBeUndefined()
  })

  it('addShellHelper/addResumeHelper also ignore the live selection', () => {
    const sessions = useSessionsStore()
    const helpers = useHelpersStore()
    sessions.folders = [
      makeFolder({ path: '/repo/a', sessions: [] }),
      makeFolder({
        path: '/repo/b',
        sessions: [makeSession({ sessionId: 's-b', projectPath: '/repo/b' })]
      })
    ]
    sessions.select('s-b')

    const actions = buildDispatchActions()
    actions.addShellHelper('/repo/a', '/repo/a')
    actions.addResumeHelper('/repo/a', 'resume-uuid', '/repo/a')

    const panes = helpers.byWorktree.get('/repo/a')?.panes ?? []
    expect(panes.map((p) => p.type)).toEqual(['shell', 'claude'])
    expect(helpers.byWorktree.get('/repo/b')?.panes ?? []).toHaveLength(0)
  })
})

describe('agent-pane-routing — origin + unseen badge', () => {
  it('an agent-origin pane into a NON-visible folder bumps the unseen counter', () => {
    const sessions = useSessionsStore()
    const helpers = useHelpersStore()
    sessions.folders = [
      makeFolder({ path: '/repo/a', sessions: [] }),
      makeFolder({
        path: '/repo/b',
        sessions: [makeSession({ sessionId: 's-b', projectPath: '/repo/b' })]
      })
    ]
    sessions.select('s-b') // visible folder is B

    const actions = buildDispatchActions()
    actions.addMarkdownHelper('/repo/a', '/repo/a/x.md', '/repo/a')

    expect(helpers.unseenAgentPaneCount('/repo/a')).toBe(1)
    expect(helpers.unseenAgentPaneCount('/repo/b')).toBe(0)
  })

  it('an agent-origin pane into the CURRENTLY visible folder never bumps the counter', () => {
    const sessions = useSessionsStore()
    const helpers = useHelpersStore()
    sessions.folders = [
      makeFolder({ path: '/repo/a', sessions: [makeSession({ sessionId: 's-a' })] })
    ]
    sessions.select('s-a') // visible folder IS a

    const actions = buildDispatchActions()
    actions.addMarkdownHelper('/repo/a', '/repo/a/x.md', '/repo/a')

    expect(helpers.unseenAgentPaneCount('/repo/a')).toBe(0)
  })

  it('BUG-29: an agent-origin pane into the CURRENTLY visible folder bumps agentPaneRevealTick instead, so a collapsed panel can still reveal', () => {
    const sessions = useSessionsStore()
    const helpers = useHelpersStore()
    sessions.folders = [
      makeFolder({ path: '/repo/a', sessions: [makeSession({ sessionId: 's-a' })] })
    ]
    sessions.select('s-a') // visible folder IS a

    const actions = buildDispatchActions()
    // Stack already has a pane (the BUG-29 precondition — no false→true edge
    // exists for the second add) before the agent pane lands.
    helpers.addShellHelper('/repo/a', '/repo/a')
    const tickBefore = helpers.agentPaneRevealTick
    actions.addMarkdownHelper('/repo/a', '/repo/a/x.md', '/repo/a')

    expect(helpers.agentPaneRevealTick).toBe(tickBefore + 1)
  })

  it('an agent-origin pane into a NON-visible folder never bumps agentPaneRevealTick', () => {
    const sessions = useSessionsStore()
    const helpers = useHelpersStore()
    sessions.folders = [
      makeFolder({ path: '/repo/a', sessions: [] }),
      makeFolder({
        path: '/repo/b',
        sessions: [makeSession({ sessionId: 's-b', projectPath: '/repo/b' })]
      })
    ]
    sessions.select('s-b') // visible folder is B

    const actions = buildDispatchActions()
    const tickBefore = helpers.agentPaneRevealTick
    actions.addMarkdownHelper('/repo/a', '/repo/a/x.md', '/repo/a')

    expect(helpers.agentPaneRevealTick).toBe(tickBefore)
  })

  it('a HUMAN-origin pane into the visible folder never bumps agentPaneRevealTick', () => {
    const sessions = useSessionsStore()
    const helpers = useHelpersStore()
    sessions.folders = [
      makeFolder({ path: '/repo/a', sessions: [makeSession({ sessionId: 's-a' })] })
    ]
    sessions.select('s-a')

    const tickBefore = helpers.agentPaneRevealTick
    // Direct store call, no `origin` opt — the shape every human call site uses.
    helpers.addMarkdownHelper('/repo/a', '/repo/a/x.md', '/repo/a')

    expect(helpers.agentPaneRevealTick).toBe(tickBefore)
  })

  it('a HUMAN-origin pane (no opts) never bumps the counter, even into a non-visible folder', () => {
    const sessions = useSessionsStore()
    const helpers = useHelpersStore()
    sessions.folders = [
      makeFolder({ path: '/repo/a', sessions: [] }),
      makeFolder({
        path: '/repo/b',
        sessions: [makeSession({ sessionId: 's-b', projectPath: '/repo/b' })]
      })
    ]
    sessions.select('s-b')

    // Direct store call — the shape every human call site (Topbar, FolderMenu,
    // ExplorerPane, SessionMenu, HelperStack) uses: no `origin` opt.
    helpers.addMarkdownHelper('/repo/a', '/repo/a/x.md', '/repo/a')

    expect(helpers.unseenAgentPaneCount('/repo/a')).toBe(0)
  })

  it('selecting ANY session in the folder clears its unseen counter', () => {
    const sessions = useSessionsStore()
    const helpers = useHelpersStore()
    const sessA2 = makeSession({ sessionId: 's-a2', projectPath: '/repo/a' })
    sessions.folders = [
      makeFolder({ path: '/repo/a', sessions: [makeSession({ sessionId: 's-a1' }), sessA2] }),
      makeFolder({
        path: '/repo/b',
        sessions: [makeSession({ sessionId: 's-b', projectPath: '/repo/b' })]
      })
    ]
    sessions.select('s-b')

    const actions = buildDispatchActions()
    actions.addMarkdownHelper('/repo/a', '/repo/a/x.md', '/repo/a')
    expect(helpers.unseenAgentPaneCount('/repo/a')).toBe(1)

    // Selecting a DIFFERENT session in the SAME folder still clears it.
    sessions.select('s-a2')
    expect(helpers.unseenAgentPaneCount('/repo/a')).toBe(0)
  })

  it('a dedup hit (re-opening the same file) does not double-count', () => {
    const sessions = useSessionsStore()
    const helpers = useHelpersStore()
    sessions.folders = [
      makeFolder({ path: '/repo/a', sessions: [] }),
      makeFolder({
        path: '/repo/b',
        sessions: [makeSession({ sessionId: 's-b', projectPath: '/repo/b' })]
      })
    ]
    sessions.select('s-b')

    const actions = buildDispatchActions()
    actions.addMarkdownHelper('/repo/a', '/repo/a/x.md', '/repo/a')
    actions.addMarkdownHelper('/repo/a', '/repo/a/x.md', '/repo/a') // same file → dedup
    expect(helpers.unseenAgentPaneCount('/repo/a')).toBe(1)
  })
})

describe('agent-pane-routing — coalesced OS alert', () => {
  it('queues ONE notify() call for a burst of agent panes into the same non-visible folder', () => {
    vi.useFakeTimers()
    try {
      const sessions = useSessionsStore()
      const notify = vi.fn()
      ;(window as unknown as { api: unknown }).api = new Proxy(
        { notify },
        { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => () => {}) }
      )
      const sessA = makeSession({
        sessionId: 's-a',
        projectPath: '/repo/a',
        modified: '2026-07-13T10:00:00.000Z'
      })
      const sessB = makeSession({ sessionId: 's-b', projectPath: '/repo/b' })
      sessions.folders = [
        makeFolder({ path: '/repo/a', alias: 'a', sessions: [sessA] }),
        makeFolder({ path: '/repo/b', alias: 'b', sessions: [sessB] })
      ]
      sessions.select('s-b')

      const actions = buildDispatchActions()
      actions.addMarkdownHelper('/repo/a', '/repo/a/1.md', '/repo/a')
      actions.addMarkdownHelper('/repo/a', '/repo/a/2.md', '/repo/a')
      actions.addMarkdownHelper('/repo/a', '/repo/a/3.md', '/repo/a')

      expect(notify).not.toHaveBeenCalled() // still inside the coalescing window
      vi.runAllTimers()

      expect(notify).toHaveBeenCalledTimes(1)
      const payload = notify.mock.calls[0][0] as { title: string; sessionId: string }
      expect(payload.title).toContain('3')
      expect(payload.sessionId).toBe('s-a') // the folder's most recently active session
    } finally {
      vi.useRealTimers()
    }
  })

  it('never fires when the target folder is already visible', () => {
    vi.useFakeTimers()
    try {
      const sessions = useSessionsStore()
      const notify = vi.fn()
      ;(window as unknown as { api: unknown }).api = new Proxy(
        { notify },
        { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => () => {}) }
      )
      sessions.folders = [
        makeFolder({ path: '/repo/a', sessions: [makeSession({ sessionId: 's-a' })] })
      ]
      sessions.select('s-a')

      const actions = buildDispatchActions()
      actions.addMarkdownHelper('/repo/a', '/repo/a/1.md', '/repo/a')
      vi.runAllTimers()

      expect(notify).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a visit DURING the coalescing window cancels the pending alert for panes already seen — a later re-leave must not resurrect it', () => {
    vi.useFakeTimers()
    try {
      const sessions = useSessionsStore()
      const helpers = useHelpersStore()
      const notify = vi.fn()
      ;(window as unknown as { api: unknown }).api = new Proxy(
        { notify },
        { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : () => () => {}) }
      )
      const sessA = makeSession({ sessionId: 's-a', projectPath: '/repo/a' })
      const sessB = makeSession({ sessionId: 's-b', projectPath: '/repo/b' })
      sessions.folders = [
        makeFolder({ path: '/repo/a', alias: 'a', sessions: [sessA] }),
        makeFolder({ path: '/repo/b', alias: 'b', sessions: [sessB] })
      ]
      sessions.select('s-b') // looking at B

      const actions = buildDispatchActions()
      actions.addMarkdownHelper('/repo/a', '/repo/a/1.md', '/repo/a') // agent opens into A, unseen

      // The operator visits A inside the 1.5s coalescing window — they SAW it.
      vi.advanceTimersByTime(200)
      sessions.select('s-a')
      expect(helpers.unseenAgentPaneCount('/repo/a')).toBe(0)

      // ...then leaves again before the original timer would have fired.
      sessions.select('s-b')
      vi.runAllTimers()

      // No stale "you missed a pane" notification for something already seen.
      expect(notify).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
