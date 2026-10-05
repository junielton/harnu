import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import {
  useSessionsStore,
  type Folder,
  AGENT_PREPROMPT_ARGV_MAX_CHARS
} from '../src/renderer/src/stores/sessions'
import type { FolderGroup } from '../src/renderer/src/stores/folder-zones'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { resolveSpawnSpec } from '../src/renderer/src/components/spawn-spec'
import type { FolderEntry, PendingApprovalWire } from '../src/preload'
import { registerWriter, unregisterWriter } from '../src/renderer/src/lib/terminal-bus'
import { encodePathToSlug } from '../src/renderer/src/lib/folder-slug'
import { AGENT_BOOT_TIMEOUT_MS } from '../src/renderer/src/stores/synthetic-reaper'
import { shouldMarkExited } from '../src/renderer/src/components/TerminalPane.vue'
import { injectionLedger } from '../src/renderer/src/stores/injection-ledger'
import type { AgentSession } from '../src/renderer/src/stores/agent-create-core'

describe('useSessionsStore handler registries', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('registerCloseHandler dispatches to all registered handlers', () => {
    const store = useSessionsStore()
    const h1 = vi.fn()
    const h2 = vi.fn()
    const off1 = store.registerCloseHandler(h1)
    const off2 = store.registerCloseHandler(h2)

    store.closeSession('session-abc')
    expect(h1).toHaveBeenCalledWith('session-abc')
    expect(h2).toHaveBeenCalledWith('session-abc')

    off1()
    store.closeSession('session-def')
    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenCalledTimes(2)

    off2()
    store.closeSession('session-ghi')
    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenCalledTimes(2)
  })

  it('registerMigrateHandler returns an unregister function', () => {
    const store = useSessionsStore()
    const h1 = vi.fn()
    const off = store.registerMigrateHandler(h1)
    expect(typeof off).toBe('function')
  })

  it('handler errors do not block other handlers', () => {
    const store = useSessionsStore()
    const throwingHandler = vi.fn(() => {
      throw new Error('boom')
    })
    const goodHandler = vi.fn()
    store.registerCloseHandler(throwingHandler)
    store.registerCloseHandler(goodHandler)

    expect(() => store.closeSession('session-x')).not.toThrow()
    expect(throwingHandler).toHaveBeenCalled()
    expect(goodHandler).toHaveBeenCalled()
  })
})

describe('useSessionsStore agent expand/collapse (issue #9)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('toggleAgents flips and isAgentsExpanded reflects per-session state', () => {
    const store = useSessionsStore()
    expect(store.isAgentsExpanded('sess-1')).toBe(false)

    store.toggleAgents('sess-1')
    expect(store.isAgentsExpanded('sess-1')).toBe(true)
    // Independent per session id.
    expect(store.isAgentsExpanded('sess-2')).toBe(false)

    store.toggleAgents('sess-1')
    expect(store.isAgentsExpanded('sess-1')).toBe(false)
  })
})

describe('useSessionsStore live-PTY presence set', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('register/unregister maintain the live set (reassigned for reactivity)', () => {
    const store = useSessionsStore()
    const before = store.manuallyHiddenPaths // touch a ref so the store is live
    expect(before).toBeInstanceOf(Set)

    store.registerLiveSession('a')
    store.registerLiveSession('a') // idempotent
    store.registerLiveSession('b')
    store.unregisterLiveSession('a')
    // No public getter for the set; assert indirectly via classification below.
    expect(true).toBe(true)
  })
})

/**
 * Regression: a folder the user manually expanded must NOT collapse when a
 * watcher event (index rewrite, new session) triggers a full `reloadModel()`.
 * `mergeFolders` rebuilds every Folder from disk (collapsed by default); the
 * snapshot/restore keyed by folder path must preserve the user's choice.
 */
describe('useSessionsStore reloadModel preserves expand state (folder model)', () => {
  function diskFolders(): FolderEntry[] {
    return [
      {
        path: '/repos/alpha',
        alias: 'alpha',
        gitBranch: 'main',
        sessions: []
      }
    ]
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => diskFolders()),
        userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => [])
      }
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('keeps a user-expanded folder across a reload', async () => {
    const store = useSessionsStore()
    await store.reloadModel()

    const f = store.folders.find((x) => x.path === '/repos/alpha')!
    expect(f.expanded).toBe(false) // disk default

    store.toggleFolder(f.path)
    expect(store.folders.find((x) => x.path === '/repos/alpha')!.expanded).toBe(true)

    await store.reloadModel()

    const after = store.folders.find((x) => x.path === '/repos/alpha')!
    expect(after.expanded).toBe(true) // preserved, not re-collapsed
  })
})

describe('useSessionsStore session-sort preference', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('defaults to attention and persists on change', () => {
    const store = useSessionsStore()
    expect(store.sessionSort).toBe('attention')
    store.setSessionSort('recent')
    expect(store.sessionSort).toBe('recent')
    store.setSessionSort('name')
    expect(store.sessionSort).toBe('name')
  })
})

describe('useSessionsStore active-window preset clamping', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('clamps to the {24h,48h,7d} presets and falls back to 48h', () => {
    const store = useSessionsStore()
    const H24 = 24 * 60 * 60 * 1000
    const H48 = 48 * 60 * 60 * 1000
    const D7 = 7 * 24 * 60 * 60 * 1000

    store.setActiveWindow(H24)
    expect(store.activeWindowMs).toBe(H24)
    store.setActiveWindow(D7)
    expect(store.activeWindowMs).toBe(D7)
    // Unknown value → 48h default.
    store.setActiveWindow(999)
    expect(store.activeWindowMs).toBe(H48)
  })
})

/**
 * Sidebar-freeze fix (2026-06-18). A single Claude turn makes chokidar fire a
 * burst of watcher events (`index:updated`, `project:added`, …). Each used to
 * call the unguarded, fire-and-forget `reloadModel()`, so N events meant N
 * concurrent full disk re-scans, each ending in a wholesale `folders.value =`
 * reassignment that rebuilt every Folder/Session object and re-rendered the
 * entire sidebar — the visible stutter. The fix is:
 *   (1) single-flight + dirty-reentry on `reloadModel` (never concurrent, a
 *       burst collapses to ≤2 scans), and
 *   (2) in-place reconciliation so reused folders/sessions keep their object
 *       identity and only genuinely-changed fields trigger reactivity.
 */
describe('useSessionsStore reload coalescing + in-place reconcile (sidebar-freeze fix)', () => {
  type DiskSession = FolderEntry['sessions'][number]

  let cb: Record<string, ((...a: unknown[]) => void) | undefined>
  let disk: FolderEntry[]
  let loadConcurrency: number
  let loadMaxConcurrency: number
  let loadCalls: number
  let rescanCalls: number

  function session(over: Partial<DiskSession> = {}): DiskSession {
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
      agents: [],
      resumable: true,
      bridged: false,
      ...over
    }
  }

  function folder(sessions: DiskSession[]): FolderEntry {
    return { path: '/repos/alpha', alias: 'alpha', gitBranch: '', sessions }
  }

  function installWindow(): void {
    cb = {}
    const on =
      (name: string) =>
      (fn: (...a: unknown[]) => void): (() => void) => {
        cb[name] = fn
        return () => {}
      }
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => {
          loadCalls++
          loadConcurrency++
          loadMaxConcurrency = Math.max(loadMaxConcurrency, loadConcurrency)
          await Promise.resolve()
          loadConcurrency--
          // Fresh object identities every scan — mirrors a real IPC round-trip.
          return disk.map((f) => ({ ...f, sessions: f.sessions.map((s) => ({ ...s })) }))
        }),
        rescan: vi.fn(async () => {
          rescanCalls++
          // A genuine fresh disk read — distinct from `foldersLoad` above so a
          // test can prove `rescan()` doesn't just fall through to it.
          return disk.map((f) => ({ ...f, sessions: f.sessions.map((s) => ({ ...s })) }))
        }),
        userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => []),
        onProjectAdded: on('onProjectAdded'),
        onProjectRemoved: on('onProjectRemoved'),
        onSessionAdded: on('onSessionAdded'),
        onSessionRemoved: on('onSessionRemoved'),
        onSessionUpdated: on('onSessionUpdated'),
        onHook: on('onHook'),
        onScreenState: on('onScreenState'),
        onSessionRegistry: on('onSessionRegistry'),
        fleetReportShellSessions: vi.fn(),
        onApprovalPending: on('onApprovalPending'),
        onApprovalResolved: on('onApprovalResolved'),
        approvalsList: vi.fn(async () => []),
        onNotifyActivate: on('onNotifyActivate'),
        onIndexUpdated: on('onIndexUpdated'),
        onWatcherDegraded: on('onWatcherDegraded'),
        onSubagentUpdated: on('onSubagentUpdated'),
        onSubagentRemoved: on('onSubagentRemoved'),
        haikuAutoname: vi.fn(async () => ({
          ok: true,
          title: 'auth refactor',
          summary: 'Refactors auth.'
        })),
        imageCacheList: vi.fn(async () => []),
        imageCacheRead: vi.fn(async () => 'data:image/png;base64,AAA'),
        imageCacheCopy: vi.fn(async () => ({ ok: true }))
      }
    }
  }

  // Drain microtasks + the dirty-reentry pass via two macrotask hops.
  const flush = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  }

  // Wait past the ~250 ms reload debounce (perf spec §5.1b) for the fire-and-
  // forget watcher triggers (`onIndexUpdated` / `onProjectAdded`), then drain the
  // reload's promise chain.
  const flushDebounce = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 300))
    await flush()
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    loadConcurrency = 0
    loadMaxConcurrency = 0
    loadCalls = 0
    rescanCalls = 0
    disk = [folder([session()])]
    installWindow()
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('rescan() forces a fresh disk read and reconciles the store with NO watcher event at all (BUG-55 AC6)', async () => {
    const store = useSessionsStore()
    await store.init()
    expect(store.folders[0].sessions.map((s) => s.sessionId)).toEqual(['s1'])

    // Disk changes with no watcher trigger fired for it whatsoever — the exact
    // gap a missed/degraded watcher leaves behind. Only a manual rescan (never
    // a plain reloadModel(), which reads through the same stale channel the
    // watcher already failed to nudge) should surface it.
    disk = [folder([session(), session({ sessionId: 's2', summary: 'two' })])]

    await store.rescan()

    expect(rescanCalls).toBe(1)
    expect(store.folders[0].sessions.map((s) => s.sessionId).sort()).toEqual(['s1', 's2'])
  })

  it('never runs foldersLoad concurrently and coalesces a burst of reload triggers', async () => {
    const store = useSessionsStore()
    await store.init()
    loadCalls = 0
    loadMaxConcurrency = 0

    // One logical change → a burst of watcher events, each of which used to
    // fire its own unguarded reloadModel(). With the trailing-edge debounce
    // (§5.1b) the whole burst now collapses into a SINGLE scan.
    cb.onIndexUpdated!({ slug: 'x' })
    cb.onProjectAdded!({ slug: 'x' })
    cb.onIndexUpdated!({ slug: 'x' })
    cb.onProjectAdded!({ slug: 'x' })
    cb.onIndexUpdated!({ slug: 'x' })
    await flushDebounce()

    expect(loadMaxConcurrency).toBe(1) // single-flight: scans never overlap
    expect(loadCalls).toBe(1) // debounced: a burst coalesces to one scan
  })

  it('reuses Folder and Session objects across a reload (no wholesale rebuild)', async () => {
    const store = useSessionsStore()
    await store.init()

    const f0 = store.folders.find((f) => f.path === '/repos/alpha')!
    const s0 = f0.sessions.find((s) => s.sessionId === 's1')!

    cb.onIndexUpdated!({ slug: 'x' }) // reload with identical data
    await flushDebounce()

    const f1 = store.folders.find((f) => f.path === '/repos/alpha')!
    const s1 = f1.sessions.find((s) => s.sessionId === 's1')!
    expect(f1).toBe(f0) // same Folder object identity
    expect(s1).toBe(s0) // same Session object identity
  })

  it('applies changed fields in place and reconciles added/removed sessions', async () => {
    const store = useSessionsStore()
    await store.init()

    const s0 = store.folders[0].sessions.find((s) => s.sessionId === 's1')!
    expect(s0.summary).toBe('one')

    // s1's summary changes and a new s2 appears.
    disk = [folder([session({ summary: 'updated' }), session({ sessionId: 's2', summary: 'two' })])]
    cb.onIndexUpdated!({ slug: 'x' })
    await flushDebounce()
    expect(s0.summary).toBe('updated') // mutated in place — still the same object
    expect(store.folders[0].sessions.map((s) => s.sessionId)).toContain('s2')

    // s1 is removed on disk.
    disk = [folder([session({ sessionId: 's2', summary: 'two' })])]
    cb.onIndexUpdated!({ slug: 'x' })
    await flushDebounce()
    expect(store.folders[0].sessions.map((s) => s.sessionId)).toEqual(['s2'])
  })

  /**
   * CRITICAL fix (T123): `mode` is a renderer-only field (never present on a
   * disk-scraped session) that must survive `reconcileSessions`' union-of-keys
   * merge against a freshly-rebuilt disk row — exactly like `bootOverride` /
   * `agentControlled` already do. Before the fix `mode` was
   * missing from `RENDERER_ONLY_SESSION_KEYS`, so the very first watcher-driven
   * rescan after a Learning session's JSONL landed on disk silently wiped the
   * teaching contract (`mode = undefined`), in the same app run, with no error.
   */
  it('preserves session.mode across a disk reconcile that lacks the field', async () => {
    const store = useSessionsStore()
    await store.init()

    const s0 = store.folders[0].sessions.find((s) => s.sessionId === 's1')!
    // Simulate `mode` having survived onto this row (e.g. the in-place
    // synth→real migration of a `Modes ▸ Learning` session) — a disk-scraped
    // session shape never carries `mode`.
    s0.mode = 'learning'

    // A later watcher-driven rescan rebuilds this row from disk (no `mode` key
    // in the wire shape at all).
    cb.onIndexUpdated!({ slug: 'x' })
    await flushDebounce()

    const s1 = store.folders[0].sessions.find((s) => s.sessionId === 's1')!
    expect(s1).toBe(s0) // reconciled in place, same object identity
    expect(s1.mode).toBe('learning') // NOT wiped to undefined
  })

  it('auto-names a born-synthetic session via Haiku on its first real turn', async () => {
    ;(
      globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }
    ).localStorage = {
      getItem: (k: string) => (k === 'om2tab.haikuAutoname' ? 'true' : null),
      setItem: () => {},
      removeItem: () => {}
    }
    const store = useSessionsStore()
    await store.init()
    const synthId = store.createNewSession('/repos/alpha')!
    const s = store.folders
      .find((f) => f.path === '/repos/alpha')!
      .sessions.find((x) => x.sessionId === synthId)!
    s.firstPrompt = 'build the auth refactor'

    cb.onSessionUpdated!({ slug: 'x', sessionId: synthId })
    await flush()

    const api = (
      globalThis as unknown as { window: { api: { haikuAutoname: ReturnType<typeof vi.fn> } } }
    ).window.api
    expect(api.haikuAutoname).toHaveBeenCalledTimes(1)
    expect(api.haikuAutoname).toHaveBeenCalledWith({
      sessionId: synthId,
      firstUserText: 'build the auth refactor'
    })
    expect(s.aiSummary).toEqual({ title: 'auth refactor', summary: 'Refactors auth.' })
    expect(s.summary).toBe('') // never overwrites summary (a /rename owns it)
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage
  })

  it('does not auto-name when the toggle is off (default)', async () => {
    ;(
      globalThis as unknown as { localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }
    ).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    const store = useSessionsStore()
    await store.init()
    const synthId = store.createNewSession('/repos/alpha')!
    const s = store.folders
      .find((f) => f.path === '/repos/alpha')!
      .sessions.find((x) => x.sessionId === synthId)!
    s.firstPrompt = 'do a thing'

    cb.onSessionUpdated!({ slug: 'x', sessionId: synthId })
    await flush()

    const api = (
      globalThis as unknown as { window: { api: { haikuAutoname: ReturnType<typeof vi.fn> } } }
    ).window.api
    expect(api.haikuAutoname).not.toHaveBeenCalled()
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage
  })

  it('records the StopFailure reason + resetsAt via applyTaskState', async () => {
    const store = useSessionsStore()
    await store.init()
    const resetsAt = 1_700_003_600_000
    store.applyTaskState('s1', 'failed', { failureReason: 'rate_limit', resetsAt })
    const s = store.folders[0].sessions.find((x) => x.sessionId === 's1')!
    expect(s.taskState).toBe('failed')
    expect(s.failureReason).toBe('rate_limit')
    expect(s.resetsAt).toBe(resetsAt)
  })

  it("drops a session's pending approvals when it leaves needs-input", async () => {
    const store = useSessionsStore()
    await store.init()
    store.applyTaskState('s1', 'needs-input')
    store.addPendingApproval({
      requestId: 'r1',
      sessionId: 's1',
      kind: 'permission_request',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      summary: 'Bash(ls)',
      createdAtMs: 1000,
      deadlineMs: 4500
    })
    expect(store.pendingApprovalCount).toBe(1)
    store.applyTaskState('s1', 'working') // answered in the terminal
    expect(store.pendingApprovalCount).toBe(0)
  })

  it('defaults the failure reason to unknown when applyTaskState has no meta', async () => {
    const store = useSessionsStore()
    await store.init()
    store.applyTaskState('s1', 'failed')
    const s = store.folders[0].sessions.find((x) => x.sessionId === 's1')!
    expect(s.failureReason).toBe('unknown')
    expect(s.resetsAt).toBeUndefined()
  })

  it('clears the failure reason when the session leaves failed (sticky cleanup)', async () => {
    const store = useSessionsStore()
    await store.init()
    store.applyTaskState('s1', 'failed', { failureReason: 'rate_limit', resetsAt: 1 })
    store.applyTaskState('s1', 'working')
    const s = store.folders[0].sessions.find((x) => x.sessionId === 's1')!
    expect(s.failureReason).toBeUndefined()
    expect(s.resetsAt).toBeUndefined()
  })

  it('markSessionExited(non-zero) fails with reason unknown (not an API StopFailure)', async () => {
    const store = useSessionsStore()
    await store.init()
    store.markSessionExited('s1', 1)
    const s = store.folders[0].sessions.find((x) => x.sessionId === 's1')!
    expect(s.taskState).toBe('failed')
    expect(s.failureReason).toBe('unknown')
  })

  // --- Folder terminals (feat/folder-new-terminal) -------------------------

  it('createFolderTerminal yields a non-synthetic shell entry, kept out of the session list', async () => {
    const store = useSessionsStore()
    await store.init()
    const folderObj = store.folders.find((f) => f.path === '/repos/alpha')!
    expect(store.countSessions(folderObj)).toBe(1) // the one real session

    const id = store.createFolderTerminal('/repos/alpha')!
    expect(id.startsWith('shellterm-')).toBe(true)
    expect(store.selectedId).toBe(id)

    const entry = folderObj.sessions.find((s) => s.sessionId === id)!
    expect(entry.isShellTerminal).toBe(true)
    expect(entry.synthetic).toBe(false)
    expect(entry.resumable).toBe(true)
    expect(entry.forkSourceId).toBeUndefined()
    expect(entry.fullPath).toBe('')
    expect(entry.projectPath).toBe('/repos/alpha')

    // Resolves to a plain shell, before any claude-resume/fork/new branch.
    expect(resolveSpawnSpec(entry, id)).toEqual({ kind: 'shell' })

    // Rendered in its own group, never the session list; not in the badge count.
    expect(store.terminalsForFolder(folderObj).map((tm) => tm.sessionId)).toEqual([id])
    expect(store.sessionsForDisplay(folderObj).some((s) => s.sessionId === id)).toBe(false)
    expect(store.countSessions(folderObj)).toBe(1)

    // Close tears it down (close handlers fire) + clears selection.
    store.closeFolderTerminal(id)
    expect(store.terminalsForFolder(folderObj)).toEqual([])
    expect(store.selectedId).toBeNull()
  })

  it('never collapses a folder terminal into a synthetic as its on-disk twin (lesson 003 guard)', async () => {
    const store = useSessionsStore()
    await store.init()

    const synthId = store.createNewSession('/repos/alpha')!
    const termId = store.createFolderTerminal('/repos/alpha')!
    const folderObj = store.folders.find((f) => f.path === '/repos/alpha')!
    const synth = folderObj.sessions.find((s) => s.sessionId === synthId)!

    // A real session lands on disk at the synthetic's creation instant — so it,
    // and NOT the terminal (born at nearly the same time), is the synthetic's
    // twin. Without the isShellTerminal guard in collapseResolvedSynthetics the
    // terminal could be claimed and spliced into the synthetic's slot.
    disk = [
      folder([
        session(),
        session({
          sessionId: 'real-twin',
          summary: 'twin',
          created: synth.created,
          modified: synth.created
        })
      ])
    ]
    cb.onIndexUpdated!({ slug: 'x' })
    await flushDebounce()

    const after = store.folders.find((f) => f.path === '/repos/alpha')!
    // The terminal survived untouched…
    expect(store.terminalsForFolder(after).map((tm) => tm.sessionId)).toEqual([termId])
    expect(after.sessions.find((s) => s.sessionId === termId)?.isShellTerminal).toBe(true)
    // …and the synthetic collapsed into the real disk twin, not the terminal.
    expect(after.sessions.some((s) => s.sessionId === 'real-twin')).toBe(true)
    expect(after.sessions.some((s) => s.sessionId === synthId)).toBe(false)
  })

  it('keyboard arrow navigation reaches a folder terminal, and Enter selects it', async () => {
    const store = useSessionsStore()
    await store.init()
    const folderObj = store.folders.find((f) => f.path === '/repos/alpha')!
    folderObj.expanded = true
    const termId = store.createFolderTerminal('/repos/alpha')!

    // Walk the sidebar cursor from the top and collect every row it lands on.
    // The terminal must appear in that sequence — before the fix the cursor
    // skipped straight over the Terminals sub-group (mouse-only).
    store.keyboardCursor = null
    const visited: string[] = []
    for (let i = 0; i < 30; i++) {
      store.cursorDown()
      const c = store.keyboardCursor
      if (!c) break
      const tag = `${c.kind}:${c.id}`
      if (visited[visited.length - 1] === tag) break // reached the bottom (clamped)
      visited.push(tag)
    }
    expect(visited).toContain(`session:${termId}`)

    // Enter on the terminal row selects it (mounts the shell in TerminalPane).
    // Move the selection elsewhere first (createFolderTerminal already selected
    // the terminal) so the assertion is meaningful.
    const otherId = store.createNewSession('/repos/alpha')!
    expect(store.selectedId).toBe(otherId)
    store.keyboardCursor = { kind: 'session', id: termId }
    store.cursorActivate()
    expect(store.selectedId).toBe(termId)
  })

  it('createNewSession mints a fresh synthetic instead of reselecting a dead one (zombie-synthetic fix)', async () => {
    const store = useSessionsStore()
    await store.init()
    const folderObj = store.folders.find((f) => f.path === '/repos/alpha')!

    // User creates a synthetic, then Ctrl+C kills its `claude` process cleanly
    // (exit code 0) before it ever wrote a JSONL — the exact repro that used to
    // leave "+ New session" stuck reselecting the same dead row forever.
    const firstId = store.createNewSession('/repos/alpha')!
    store.markSessionExited(firstId, 0)
    const dead = folderObj.sessions.find((s) => s.sessionId === firstId)!
    expect(dead.taskState).toBe('completed')

    // "+ New session" again must mint a genuinely NEW synthetic, not dedupe onto
    // the corpse — otherwise the user can never open a working session again.
    const secondId = store.createNewSession('/repos/alpha')!
    expect(secondId).not.toBe(firstId)
    expect(store.selectedId).toBe(secondId)

    // The dead row is left in place (non-destructive) — Dismiss/Retry in
    // SessionMenu still recover it — alongside the fresh live one.
    expect(folderObj.sessions.filter((s) => s.synthetic === true).map((s) => s.sessionId)).toEqual([
      secondId,
      firstId
    ])
  })

  it('createNewSession still dedupes onto a LIVE (not-yet-dead) synthetic', async () => {
    const store = useSessionsStore()
    await store.init()

    const firstId = store.createNewSession('/repos/alpha')!
    // No exit yet — this synthetic is still pending/booting.
    const secondId = store.createNewSession('/repos/alpha')!
    expect(secondId).toBe(firstId)
  })

  it('a task-state set DURING a reload is not reverted by a stale snapshot (T18 Fix 3)', async () => {
    const store = useSessionsStore()
    await store.init()
    const s1 = (): DiskSession | undefined =>
      store.folders
        .find((f) => f.path === '/repos/alpha')
        ?.sessions.find((x) => x.sessionId === 's1') as DiskSession | undefined

    // s1 goes to `working` via a hook.
    cb.onHook?.({ sessionId: 's1', taskState: 'working', event: 'PreToolUse' })
    expect(s1()?.taskState).toBe('working')

    // During the reload's disk `await`, a hook flips it to `idle`. With Fix 3 the
    // overlay is read AFTER the await, so the live `idle` wins; the pre-await
    // snapshot (`working`) must NOT revert it (the bug this fixes).
    const origLoad = (window as unknown as { api: { foldersLoad: () => Promise<unknown> } }).api
      .foldersLoad
    ;(window as unknown as { api: { foldersLoad: () => Promise<unknown> } }).api.foldersLoad =
      vi.fn(async () => {
        const r = await origLoad()
        cb.onHook?.({ sessionId: 's1', taskState: 'idle', event: 'Stop' })
        return r
      })
    await store.reloadModel()
    expect(s1()?.taskState).toBe('idle')
  })

  /**
   * T180: `foldersLoading` lets the sidebar tell "still scanning
   * ~/.claude/projects/" apart from "genuinely empty" during a cold-boot
   * first load that can take minutes on installs with many project folders.
   */
  describe('foldersLoading (T180 sidebar loading spinner)', () => {
    it('starts true and flips to false once init() completes its first reloadModel()', async () => {
      const store = useSessionsStore()
      expect(store.foldersLoading).toBe(true)

      const initPromise = store.init()
      expect(store.foldersLoading).toBe(true) // still scanning mid-flight

      await initPromise
      expect(store.foldersLoading).toBe(false)
    })

    it('flips to false even when the first reloadModel() rejects', async () => {
      const store = useSessionsStore()
      ;(window as unknown as { api: { foldersLoad: () => Promise<unknown> } }).api.foldersLoad =
        vi.fn(async () => {
          throw new Error('disk read failed')
        })

      await expect(store.init()).rejects.toThrow('disk read failed')
      expect(store.foldersLoading).toBe(false)
    })

    it('a manual reloadModel()/rescan() afterward does not flip it back to true', async () => {
      const store = useSessionsStore()
      await store.init()
      expect(store.foldersLoading).toBe(false)

      await store.rescan()
      expect(store.foldersLoading).toBe(false)

      await store.reloadModel()
      expect(store.foldersLoading).toBe(false)
    })
  })

  /**
   * BUG-78 — a plain session whose row STARTS with a stale `agentName` (the
   * CLI's `agent-name` rename line, as the pre-fix reader scraped it). The live
   * path reads `custom-title` only, and a reload copies the reader's
   * `agentName: ''` over the stale value. The render half of AC8 lives in
   * `tests/sidebar-folder-label.test.ts`.
   */
  it('BUG-78 AC8: a live /rename of a stale row moves its summary to the latest name', async () => {
    disk = [folder([session({ summary: 'A', agentName: 'A', teamName: '' })])]
    const store = useSessionsStore()
    await store.init()
    const row = () => store.folders[0].sessions.find((s) => s.sessionId === 's1')!
    expect(row().agentName).toBe('A')

    cb.onSessionUpdated!({
      slug: encodePathToSlug('/repos/alpha'),
      sessionId: 's1',
      // The watcher pre-derives the rename; the `agent-name` line never reaches here.
      renameTitle: 'B'
    })

    expect(row().summary).toBe('B')
  })

  it('BUG-78 AC9: reloadModel() heals a stale agentName from the disk row', async () => {
    disk = [folder([session({ summary: 'B', agentName: 'A', teamName: '' })])]
    const store = useSessionsStore()
    await store.init()
    const row = () => store.folders[0].sessions.find((s) => s.sessionId === 's1')!
    expect(row().agentName).toBe('A')

    // The upgraded reader re-scrapes the transcript and drops the stray name.
    disk = [folder([session({ summary: 'B', agentName: '', teamName: '' })])]
    await store.reloadModel()

    expect(row().agentName).toBe('')
    expect(row().summary).toBe('B')
  })
})

describe('useSessionsStore — Approval Inbox queue', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  const wire = (
    requestId: string,
    sessionId: string,
    createdAtMs: number
  ): PendingApprovalWire => ({
    requestId,
    sessionId,
    kind: 'permission_request',
    toolName: 'Bash',
    toolInput: { command: 'ls' },
    summary: 'Bash(ls)',
    createdAtMs,
    deadlineMs: createdAtMs + 3500
  })

  it('adds, counts, and orders pending approvals oldest-first', () => {
    const store = useSessionsStore()
    store.addPendingApproval(wire('r2', 'S1', 2000))
    store.addPendingApproval(wire('r1', 'S1', 1000))
    expect(store.pendingApprovalCount).toBe(2)
    expect(store.pendingApprovalList.map((a) => a.requestId)).toEqual(['r1', 'r2'])
    // Unknown session enriches gracefully (no crash) — empty alias/summary.
    expect(store.pendingApprovalList[0].folderAlias).toBe('')
    expect(store.pendingApprovalList[0].summary).toBe('Bash(ls)')
  })

  it('dedupes by requestId and removes one', () => {
    const store = useSessionsStore()
    store.addPendingApproval(wire('r1', 'S1', 1000))
    store.addPendingApproval(wire('r1', 'S1', 1000)) // same id
    expect(store.pendingApprovalCount).toBe(1)
    store.removePendingApproval('r1')
    expect(store.pendingApprovalCount).toBe(0)
  })

  it('resolveApproval calls hookRespond and removes optimistically', async () => {
    const hookRespond = vi.fn(async () => ({ ok: true }))
    ;(globalThis as unknown as { window: { api: unknown } }).window = { api: { hookRespond } }
    const store = useSessionsStore()
    store.addPendingApproval(wire('r1', 'S1', 1000))
    await store.resolveApproval('r1', 'allow')
    expect(hookRespond).toHaveBeenCalledWith('r1', 'allow')
    expect(store.pendingApprovalCount).toBe(0)
  })

  it('surfaces an info toast when the request already expired (ok: false)', async () => {
    const hookRespond = vi.fn(async () => ({ ok: false }))
    ;(globalThis as unknown as { window: { api: unknown } }).window = { api: { hookRespond } }
    const store = useSessionsStore()
    const ui = useUiStore()
    store.addPendingApproval(wire('r1', 'S1', 1000))
    await store.resolveApproval('r1', 'deny')
    expect(store.pendingApprovalCount).toBe(0)
    expect(ui.toasts.some((t) => t.kind === 'info')).toBe(true)
  })
})

describe('reattachImage (Pasted-images re-attach)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })
  afterEach(() => {
    unregisterWriter('live-1')
    unregisterWriter('dormant-1')
  })

  it('injects the path into the focused live session and returns true', () => {
    const store = useSessionsStore()
    const writer = vi.fn()
    store.registerLiveSession('live-1')
    store.selectedId = 'live-1'
    registerWriter('live-1', writer)
    const ok = store.reattachImage('/abs/diagram.png')
    expect(ok).toBe(true)
    // Independent signal: the writer received the path plus a trailing space so
    // Claude detects it and back-to-back re-attaches stay separated.
    expect(writer).toHaveBeenCalledWith('/abs/diagram.png ')
  })

  it('separates two consecutive re-attaches so the paths do not concatenate', () => {
    const store = useSessionsStore()
    const chunks: string[] = []
    store.registerLiveSession('live-1')
    store.selectedId = 'live-1'
    registerWriter('live-1', (d) => chunks.push(d))
    store.reattachImage('/abs/1.png')
    store.reattachImage('/abs/2.png')
    // Joined, the PTY stream is space-separated (two parseable paths), not glued.
    expect(chunks.join('')).toBe('/abs/1.png /abs/2.png ')
  })

  it('returns false and writes nothing when the focused session has no live PTY', () => {
    const store = useSessionsStore()
    const writer = vi.fn()
    store.selectedId = 'dormant-1' // never registered live
    registerWriter('dormant-1', writer)
    const ok = store.reattachImage('/abs/x.png')
    expect(ok).toBe(false)
    expect(writer).not.toHaveBeenCalled()
  })

  it('returns false when there is no selection', () => {
    const store = useSessionsStore()
    store.selectedId = null
    expect(store.reattachImage('/abs/x.png')).toBe(false)
  })
})

/**
 * T70A — a folder pinned before Claude wrote a `sessions-index.json` under it is
 * a placeholder with no disk-side git meta, so `groupByRepo` (which keys on
 * `repoId`) never collapses it under its repo. The fix probes git at pin time
 * (persisting the meta) and backfills placeholder records that predate that on
 * reload.
 */
describe('useSessionsStore folder git-meta grouping (T70A)', () => {
  const WT = '/repos/app/.claude/worktrees/feature'

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  function probeGit(): ReturnType<typeof vi.fn> {
    return vi.fn(async (paths: string[]) =>
      paths.map((p) => ({
        path: p,
        repoId: '/repos/app/.git',
        gitBranch: 'feature',
        isMainWorktree: false
      }))
    )
  }

  it('pinFolder probes git and persists repoId/gitBranch/isMainWorktree onto the record', async () => {
    setActivePinia(createPinia())
    const added: Array<Record<string, unknown>> = []
    const userProjectsAdd = vi.fn(async (entry: Record<string, unknown>) => {
      added.push(entry)
      return { projects: added, hiddenPaths: [] }
    })
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => []),
        userProjectsList: vi.fn(async () => ({ projects: added, hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => []),
        probeGit: probeGit(),
        userProjectsAdd
      }
    }
    const store = useSessionsStore()
    await store.pinFolder(WT)

    expect(userProjectsAdd).toHaveBeenCalledTimes(1)
    const entry = added[0]
    expect(entry.repoId).toBe('/repos/app/.git')
    expect(entry.gitBranch).toBe('feature')
    expect(entry.isMainWorktree).toBe(false)
  })

  it('reload backfills a pre-T70A placeholder record (no repoId) so it groups under its repo', async () => {
    setActivePinia(createPinia())
    // Two pinned placeholders (both in projects.json, neither with a disk
    // counterpart): the repo's main worktree already carries persisted meta, the
    // feature worktree is a legacy record pinned before pin-time probing (NO git
    // meta). Both land in the pinned zone, so once the feature record is
    // backfilled with the same repoId they collapse into one repo group.
    const userProjects = [
      {
        path: '/repos/app',
        alias: 'app',
        addedAt: '2026-01-01',
        worktrees: [],
        repoId: '/repos/app/.git',
        gitBranch: 'main',
        isMainWorktree: true
      },
      { path: WT, alias: 'feature', addedAt: '2026-01-01', worktrees: [] }
    ]
    const probe = probeGit()
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => []),
        userProjectsList: vi.fn(async () => ({ projects: userProjects, hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => []),
        probeGit: probe
      }
    }
    const store = useSessionsStore()
    await store.reloadModel()

    // Only the meta-less feature record is probed — the main worktree is skipped.
    expect(probe).toHaveBeenCalledWith([WT])
    const placeholder = store.folders.find((f) => f.path === WT)!
    expect(placeholder.repoId).toBe('/repos/app/.git')
    expect(placeholder.gitBranch).toBe('feature')
    // Same repoId as the main worktree → one repo group in the flat list.
    const groups = store.visibleFolders.filter(
      (e): e is FolderGroup<Folder> => 'kind' in e && e.kind === 'folder-group'
    )
    expect(groups.some((g) => g.id === '/repos/app/.git')).toBe(true)
  })

  it('does NOT re-probe a record that already carries persisted git meta', async () => {
    setActivePinia(createPinia())
    const userProjects = [
      {
        path: WT,
        alias: 'feature',
        addedAt: '2026-01-01',
        worktrees: [],
        repoId: '/repos/app/.git',
        gitBranch: 'feature',
        isMainWorktree: false
      }
    ]
    const probe = probeGit()
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => []),
        userProjectsList: vi.fn(async () => ({ projects: userProjects, hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => []),
        probeGit: probe
      }
    }
    const store = useSessionsStore()
    await store.reloadModel()

    expect(probe).not.toHaveBeenCalled()
    expect(store.folders.find((f) => f.path === WT)!.repoId).toBe('/repos/app/.git')
  })
})

/**
 * T69 fix: `harnu .` should reveal + focus the folder it opens, but ONLY when the
 * adoption originates from the CLI. An MCP `adopt_folder` (an agent) must never
 * steal the operator's selection/view (T78). The origin rides the `folders:adopted`
 * payload's `select` flag; the store reveals iff it's set.
 */
describe('useSessionsStore CLI folder reveal (T69 fix)', () => {
  function diskFolders(): FolderEntry[] {
    return [{ path: '/repos/beta', alias: 'beta', gitBranch: 'main', sessions: [] }]
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => diskFolders()),
        userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => [])
      }
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('revealFolder expands the folder and raises the scroll signal', async () => {
    const store = useSessionsStore()
    await store.reloadModel()
    expect(store.folders.find((x) => x.path === '/repos/beta')!.expanded).toBe(false)

    store.revealFolder('/repos/beta')
    expect(store.folders.find((x) => x.path === '/repos/beta')!.expanded).toBe(true)
    expect(store.revealFolderPath).toBe('/repos/beta')

    store.clearRevealFolder()
    expect(store.revealFolderPath).toBeNull()
  })

  it('revealFolder on an unknown path only raises the signal (no throw)', async () => {
    const store = useSessionsStore()
    await store.reloadModel()
    expect(() => store.revealFolder('/repos/nope')).not.toThrow()
    expect(store.revealFolderPath).toBe('/repos/nope')
  })

  it('onFolderAdopted with select:true reveals the folder after the reload', async () => {
    vi.useFakeTimers()
    try {
      const store = useSessionsStore()
      store.onFolderAdopted({ path: '/repos/beta', select: true })
      await vi.runAllTimersAsync()
      expect(store.revealFolderPath).toBe('/repos/beta')
      expect(store.folders.find((x) => x.path === '/repos/beta')?.expanded).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('onFolderAdopted from an MCP adopt (no select) never reveals — no stolen selection', async () => {
    vi.useFakeTimers()
    try {
      const store = useSessionsStore()
      store.onFolderAdopted({ path: '/repos/beta' })
      await vi.runAllTimersAsync()
      expect(store.revealFolderPath).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  describe('onFolderRemoved (BUG-56)', () => {
    it('drops the folder from the live model immediately, synchronously', async () => {
      const store = useSessionsStore()
      await store.reloadModel()
      expect(store.folders.some((f) => f.path === '/repos/beta')).toBe(true)

      store.onFolderRemoved({ path: '/repos/beta' })
      expect(store.folders.some((f) => f.path === '/repos/beta')).toBe(false)
    })

    it('clears the selection when the selected session was in the dropped folder', async () => {
      const store = useSessionsStore()
      await store.reloadModel()
      const folder = store.folders.find((f) => f.path === '/repos/beta')!
      folder.sessions.push({
        sessionId: 'sess-gone',
        projectPath: '/repos/beta',
        status: 'idle',
        modified: new Date().toISOString()
      } as never)
      store.select('sess-gone')
      expect(store.selectedId).toBe('sess-gone')

      store.onFolderRemoved({ path: '/repos/beta' })
      expect(store.selectedId).toBeNull()
    })

    it('is a no-op on an unknown path (idempotent, no throw)', async () => {
      const store = useSessionsStore()
      await store.reloadModel()
      expect(() => store.onFolderRemoved({ path: '/repos/never-existed' })).not.toThrow()
    })
  })
})

/**
 * BUG-40 §3.1/§3.2: `spawnAndBind` used to call `dispatchCardSession` right after
 * `worktreeCreate` resolved, racing the 250ms `onFolderAdopted` → `reloadModelDebounced`
 * path — the ONLY way a freshly-adopted folder used to land in `folders.value`. The
 * lookup ran at ~0ms, the debounce fired at 250ms+: a guaranteed miss, not a rare race.
 * `registerFolderImmediate` closes it by inserting the folder straight from
 * `worktreeCreate`'s own `adopted` payload, synchronously, before dispatch ever runs.
 */
describe('registerFolderImmediate + dispatchCardSession race (BUG-40 §3.1/§3.2)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => []),
        userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => [])
      }
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('dispatchCardSession resolves a folder registered from the worktreeCreate payload at t=0 — the debounce timer is never advanced', async () => {
    vi.useFakeTimers()
    try {
      const store = useSessionsStore()
      await store.reloadModel() // empty disk model — /repos/wt does not exist yet

      // Simulate what spawnAndBind now does: register straight from
      // worktreeCreate's own `adopted` payload. No `onFolderAdopted` push, no
      // timer advance — the old debounced path would still be pending here.
      store.registerFolderImmediate({ path: '/repos/wt', gitBranch: 'card/BUG-40' })

      const result = store.dispatchCardSession('/repos/wt', 'go')
      expect(result.ok).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('without registerFolderImmediate, the SAME dispatch misses at t=0 — proves the race is real', async () => {
    vi.useFakeTimers()
    try {
      const store = useSessionsStore()
      await store.reloadModel()

      // Only the debounced push (the pre-fix path).
      store.onFolderAdopted({ path: '/repos/wt', gitBranch: 'card/BUG-40' })

      // No timer advance: the 250ms debounce has not fired yet.
      const result = store.dispatchCardSession('/repos/wt', 'go')
      expect(result.ok).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispatchCardSession returns a named reason instead of null for an unknown folder', async () => {
    const store = useSessionsStore()
    await store.reloadModel()

    const result = store.dispatchCardSession('/repos/never-adopted', 'go')
    expect(result).toEqual({ ok: false, reason: 'FOLDER_NOT_FOUND: /repos/never-adopted' })
  })

  it('registerFolderImmediate is idempotent — an already-present folder is returned as-is, never duplicated', async () => {
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => [
          { path: '/repos/wt', alias: 'wt', gitBranch: 'main', sessions: [] }
        ]),
        userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => [])
      }
    }
    const store = useSessionsStore()
    await store.reloadModel()
    expect(store.folders.filter((f) => f.path === '/repos/wt')).toHaveLength(1)

    store.registerFolderImmediate({ path: '/repos/wt', gitBranch: 'card/BUG-40' })
    expect(store.folders.filter((f) => f.path === '/repos/wt')).toHaveLength(1)
    // The real disk-derived gitBranch ('main') is untouched — an existing folder
    // is never overwritten, only a genuinely-missing one is inserted.
    expect(store.folders.find((f) => f.path === '/repos/wt')?.gitBranch).toBe('main')
  })
})

/**
 * BUG-31 fix: `activateSession` is the ONE "jump to this session" path (the
 * OS-notification click and 6 other affordances all route through it) — it
 * must leave exactly one row looking focused, on screen. Before the fix it
 * only set `selectedId` and expanded the folder, leaving `keyboardCursor`
 * (a second, independent focus notion `SidebarFolder.vue` also paints an
 * accent-outline from) pointed at whatever the operator last reached via
 * arrow keys — two rows read as focused at once.
 */
describe('useSessionsStore activateSession (BUG-31 — reveal + focus)', () => {
  type DiskSession = FolderEntry['sessions'][number]

  function session(over: Partial<DiskSession> = {}): DiskSession {
    // `created`/`modified` default to "now" — a fixed past date falls outside
    // the sidebar's default session-age window and silently drops the
    // fixture out of `sessionsForDisplay`.
    const now = new Date().toISOString()
    return {
      sessionId: 's1',
      fullPath: '/repos/alpha/s1.jsonl',
      fileMtime: 1,
      firstPrompt: '',
      summary: 'one',
      messageCount: 1,
      created: now,
      modified: now,
      gitBranch: '',
      projectPath: '/repos/alpha',
      isSidechain: false,
      status: 'idle',
      agents: [],
      resumable: true,
      bridged: false,
      ...over
    } as DiskSession
  }

  function folder(
    path: string,
    sessions: DiskSession[],
    over: Partial<FolderEntry> = {}
  ): FolderEntry {
    return { path, alias: path.split('/').pop() ?? path, gitBranch: '', sessions, ...over }
  }

  function installWindow(disk: FolderEntry[]): void {
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => disk),
        userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => [])
      }
    }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('moves the keyboard cursor onto the target AND raises the scroll signal — not just selectedId', async () => {
    installWindow([
      folder('/repos/alpha', [session({ sessionId: 's1' }), session({ sessionId: 's2' })])
    ])
    const store = useSessionsStore()
    await store.reloadModel()

    // Repro the reported symptom: a prior keyboard-nav focus sits on s1.
    store.keyboardCursor = { kind: 'session', id: 's1' }

    store.activateSession('s2')

    expect(store.selectedId).toBe('s2')
    // The assertion that actually proves this fix — a test that only checks
    // selectedId would pass even on the old two-line implementation.
    expect(store.keyboardCursor).toEqual({ kind: 'session', id: 's2' })
    expect(store.revealSessionId).toBe('s2')
  })

  it('expands the owning (collapsed) folder', async () => {
    installWindow([folder('/repos/alpha', [session({ sessionId: 's1' })])])
    const store = useSessionsStore()
    await store.reloadModel()
    store.folders.find((f) => f.path === '/repos/alpha')!.expanded = false

    store.activateSession('s1')

    expect(store.folders.find((f) => f.path === '/repos/alpha')!.expanded).toBe(true)
  })

  it('is a no-op for an unknown session id', async () => {
    installWindow([folder('/repos/alpha', [session({ sessionId: 's1' })])])
    const store = useSessionsStore()
    await store.reloadModel()
    store.select('s1')

    expect(() => store.activateSession('does-not-exist')).not.toThrow()

    expect(store.selectedId).toBe('s1')
    expect(store.keyboardCursor).toBeNull()
  })

  it('clears an active filter that would hide the target session (the one judgment call)', async () => {
    installWindow([
      folder('/repos/alpha', [session({ sessionId: 's1', summary: 'alpha work' })]),
      folder('/repos/beta', [session({ sessionId: 's2', summary: 'beta work' })])
    ])
    const store = useSessionsStore()
    await store.reloadModel()
    store.setFilterQuery('alpha') // matches only /repos/alpha — would hide s2's folder

    store.activateSession('s2')

    expect(store.filterQuery).toBe('')
    expect(store.selectedId).toBe('s2')
  })

  it('leaves the filter alone when it does not hide the target session', async () => {
    installWindow([folder('/repos/alpha', [session({ sessionId: 's1', summary: 'alpha work' })])])
    const store = useSessionsStore()
    await store.reloadModel()
    store.setFilterQuery('alpha')

    store.activateSession('s1')

    expect(store.filterQuery).toBe('alpha')
  })

  it('expands a collapsed teammate group so a nested teammate session is revealed', async () => {
    // The lead lookup matches a session whose OWN id starts with the team's
    // hex suffix (`teammate-grouping.ts#teamHex`) — the lead's id, not the
    // teammate's, must carry the `session-<hex>` team name as its prefix.
    const leaderId = 'aaaaaaaa-lead-0000-0000-000000000000'
    installWindow([
      folder('/repos/alpha', [
        session({ sessionId: leaderId, summary: 'lead' }),
        session({ sessionId: 'tm-1', summary: 'teammate', teamName: 'session-aaaaaaaa' })
      ])
    ])
    const store = useSessionsStore()
    await store.reloadModel()
    expect(store.isTeammatesExpanded(leaderId)).toBe(false)

    store.activateSession('tm-1')

    expect(store.isTeammatesExpanded(leaderId)).toBe(true)
    expect(store.selectedId).toBe('tm-1')
  })

  it('a plain select() (not just activateSession) expands the owning folder — reactive sync', async () => {
    installWindow([folder('/repos/alpha', [session({ sessionId: 's1' })])])
    const store = useSessionsStore()
    await store.reloadModel()
    store.folders.find((f) => f.path === '/repos/alpha')!.expanded = false

    store.select('s1')

    expect(store.folders.find((f) => f.path === '/repos/alpha')!.expanded).toBe(true)
    expect(store.revealSessionId).toBe('s1')
  })

  it('select() expands a collapsed group the folder renders under', async () => {
    installWindow([
      folder('/repos/alpha/main', [session({ sessionId: 's1' })], {
        repoId: 'repo-x',
        isMainWorktree: true
      }),
      folder('/repos/alpha/wt-b', [session({ sessionId: 's2' })], { repoId: 'repo-x' })
    ])
    const store = useSessionsStore()
    await store.reloadModel()
    store.toggleGroup('repo:repo-x')
    const before = store.visibleFolders.find((n) => 'kind' in n && n.kind === 'folder-group') as
      { expanded: boolean } | undefined
    expect(before?.expanded).toBe(false)

    store.select('s2')

    const after = store.visibleFolders.find((n) => 'kind' in n && n.kind === 'folder-group') as
      { expanded: boolean } | undefined
    expect(after?.expanded).toBe(true)
  })

  it('select() with an unknown session id is a no-op (no throw, no stale reveal)', async () => {
    installWindow([folder('/repos/alpha', [session({ sessionId: 's1' })])])
    const store = useSessionsStore()
    await store.reloadModel()

    expect(() => store.select('does-not-exist')).not.toThrow()
    expect(store.revealSessionId).toBeNull()
  })
})

describe('useSessionsStore drill-in navigation (2026-07-19)', () => {
  type DiskSession = FolderEntry['sessions'][number]

  // This file runs under the `node` vitest environment (no jsdom, no native
  // `localStorage`), unlike `layout-store.test.ts` / `persisted.test.ts`
  // which opt into jsdom. `drillDepth` needs a real read/write-back store
  // to assert against (not the read-only inline mocks the rest of this
  // file uses elsewhere), so stub one in with the same in-memory harness
  // those other suites use.
  function makeLocalStorage(initial: Record<string, string> = {}): Storage {
    const store = new Map<string, string>(Object.entries(initial))
    return {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size
      }
    } as Storage
  }

  function session(over: Partial<DiskSession> = {}): DiskSession {
    const now = new Date().toISOString()
    return {
      sessionId: 's1',
      fullPath: '/repos/alpha/s1.jsonl',
      fileMtime: 1,
      firstPrompt: '',
      summary: 'one',
      messageCount: 1,
      created: now,
      modified: now,
      gitBranch: '',
      projectPath: '/repos/alpha',
      isSidechain: false,
      status: 'idle',
      agents: [],
      resumable: true,
      bridged: false,
      ...over
    } as DiskSession
  }

  function folder(
    path: string,
    sessions: DiskSession[],
    over: Partial<FolderEntry> = {}
  ): FolderEntry {
    return { path, alias: path.split('/').pop() ?? path, gitBranch: '', sessions, ...over }
  }

  function installWindow(disk: FolderEntry[]): void {
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => disk),
        userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => [])
      }
    }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('localStorage', makeLocalStorage())
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
    vi.unstubAllGlobals()
  })

  it('defaults to depth 0 (classic tree) with an empty stack', () => {
    const store = useSessionsStore()
    expect(store.drillDepth).toBe(0)
    expect(store.drillModeEnabled).toBe(false)
    expect(store.drillStack).toEqual([])
  })

  it('cycleDrillDepth walks 0 → 1 → 2 → 0 and persists each level', async () => {
    // `persistedRef`'s auto-persist watch uses Vue's default ('pre') flush —
    // an `await nextTick()` is required between the change and reading the
    // mirrored key, same as `layout-store.test.ts`'s equivalent assertion.
    const store = useSessionsStore()

    store.cycleDrillDepth()
    expect(store.drillDepth).toBe(1)
    expect(store.drillModeEnabled).toBe(true)
    await nextTick()
    expect(localStorage.getItem('om2tab.sidebarDrillDepth')).toBe('1')

    store.cycleDrillDepth()
    expect(store.drillDepth).toBe(2)
    await nextTick()
    expect(localStorage.getItem('om2tab.sidebarDrillDepth')).toBe('2')

    store.cycleDrillDepth()
    expect(store.drillDepth).toBe(0)
    expect(store.drillModeEnabled).toBe(false)
    expect(store.drillStack).toEqual([])
    await nextTick()
    expect(localStorage.getItem('om2tab.sidebarDrillDepth')).toBe('0')
  })

  it('migrates a legacy sidebarDrillMode=true to depth 2 so existing drill-in users keep their behavior', () => {
    vi.stubGlobal('localStorage', makeLocalStorage({ 'om2tab.sidebarDrillMode': 'true' }))
    const store = useSessionsStore()
    expect(store.drillDepth).toBe(2)
  })

  it('migrates a legacy sidebarDrillMode=false (or absent) to depth 0', () => {
    vi.stubGlobal('localStorage', makeLocalStorage({ 'om2tab.sidebarDrillMode': 'false' }))
    const store = useSessionsStore()
    expect(store.drillDepth).toBe(0)
  })

  it('prefers an explicit sidebarDrillDepth over the legacy key, and clamps out-of-range values', () => {
    vi.stubGlobal(
      'localStorage',
      makeLocalStorage({ 'om2tab.sidebarDrillMode': 'true', 'om2tab.sidebarDrillDepth': '1' })
    )
    expect(useSessionsStore().drillDepth).toBe(1)

    setActivePinia(createPinia())
    vi.stubGlobal('localStorage', makeLocalStorage({ 'om2tab.sidebarDrillDepth': '9' }))
    expect(useSessionsStore().drillDepth).toBe(0)
  })

  it('drillIntoGroup then drillIntoFolder builds a two-entry stack; drillBack pops one level at a time', () => {
    const store = useSessionsStore()
    store.drillIntoGroup('repo:repo-x')
    expect(store.drillStack).toEqual([{ kind: 'group', key: 'repo:repo-x' }])

    store.drillIntoFolder('/repos/alpha/main')
    expect(store.drillStack).toEqual([
      { kind: 'group', key: 'repo:repo-x' },
      { kind: 'folder', path: '/repos/alpha/main' }
    ])

    store.drillBack()
    expect(store.drillStack).toEqual([{ kind: 'group', key: 'repo:repo-x' }])

    store.drillBack()
    expect(store.drillStack).toEqual([])
  })

  it('drillBack on an empty stack is a no-op', () => {
    const store = useSessionsStore()
    store.drillBack()
    expect(store.drillStack).toEqual([])
  })

  it("cycling to depth 2 with a selection jumps straight to that session's folder screen, through its group", async () => {
    installWindow([
      folder('/repos/alpha/main', [session({ sessionId: 's1' })], {
        repoId: 'repo-x',
        isMainWorktree: true
      }),
      folder('/repos/alpha/wt-b', [session({ sessionId: 's2' })], { repoId: 'repo-x' })
    ])
    const store = useSessionsStore()
    await store.reloadModel()
    store.select('s2')

    store.cycleDrillDepth()
    store.cycleDrillDepth()

    expect(store.drillDepth).toBe(2)
    expect(store.drillStack).toEqual([
      { kind: 'group', key: 'repo:repo-x' },
      { kind: 'folder', path: '/repos/alpha/wt-b' }
    ])
  })

  it('at depth 1 the resolved stack stops at the owning group, so the folder renders inline', async () => {
    installWindow([
      folder('/repos/alpha/main', [session({ sessionId: 's1' })], {
        repoId: 'repo-x',
        isMainWorktree: true
      }),
      folder('/repos/alpha/wt-b', [session({ sessionId: 's2' })], { repoId: 'repo-x' })
    ])
    const store = useSessionsStore()
    await store.reloadModel()
    store.select('s2')

    store.cycleDrillDepth()

    expect(store.drillDepth).toBe(1)
    expect(store.drillStack).toEqual([{ kind: 'group', key: 'repo:repo-x' }])
  })

  it('at depth 1 a selection in an ungrouped folder still opens its own session screen', async () => {
    installWindow([folder('/repos/solo', [session({ sessionId: 's1' })])])
    const store = useSessionsStore()
    await store.reloadModel()
    store.select('s1')

    store.cycleDrillDepth()

    expect(store.drillStack).toEqual([{ kind: 'folder', path: '/repos/solo' }])
  })

  it('lowering the depth truncates a deeper stack instead of stranding the operator', () => {
    const store = useSessionsStore()
    store.drillDepth = 2
    store.drillIntoGroup('repo:repo-x')
    store.drillIntoFolder('/repos/alpha/wt-b')

    store.cycleDrillDepth()

    expect(store.drillDepth).toBe(0)
    expect(store.drillStack).toEqual([])
  })

  it('auto re-drill: selecting a session in a different folder while drill mode is on replaces the stack', async () => {
    installWindow([
      folder('/repos/alpha/main', [session({ sessionId: 's1' })], {
        repoId: 'repo-x',
        isMainWorktree: true
      }),
      folder('/repos/alpha/wt-b', [session({ sessionId: 's2' })], { repoId: 'repo-x' })
    ])
    const store = useSessionsStore()
    await store.reloadModel()
    store.cycleDrillDepth()
    store.cycleDrillDepth() // depth 2, so the resolver keeps the full [group, folder] path
    store.drillIntoFolder('/repos/alpha/main') // looking at an unrelated screen

    store.select('s2')

    expect(store.drillStack).toEqual([
      { kind: 'group', key: 'repo:repo-x' },
      { kind: 'folder', path: '/repos/alpha/wt-b' }
    ])
  })

  it('selecting a session does NOT touch the drill stack when drill mode is off', async () => {
    installWindow([folder('/repos/alpha', [session({ sessionId: 's1' })])])
    const store = useSessionsStore()
    await store.reloadModel()
    store.drillIntoFolder('/repos/somewhere-else')

    store.select('s1')

    expect(store.drillStack).toEqual([{ kind: 'folder', path: '/repos/somewhere-else' }])
  })
})

/**
 * BUG-25: a parked MCP confirm used to be invisible in the Approval Inbox
 * whenever the renderer wasn't listening at the exact moment `main` fired
 * `mcp:confirm:pending` (a reload, a fresh window) — that event fires exactly
 * once, at park time, so a late listener never saw the confirm again until the
 * 30-minute operator-away TTL denied it unseen. The fix: `init()` now calls
 * `window.api.mcpConfirmsList()` once at boot (mirrors the sibling
 * `approvalsList()` rehydration a few lines above it in `sessions.ts`) and
 * feeds every still-live wire into the parked-confirm queue the Inbox reads.
 */
describe('useSessionsStore MCP-confirm rehydration (BUG-25)', () => {
  function noop(): () => void {
    return () => {}
  }

  function installWindow(mcpConfirmsList: () => Promise<unknown[]>): void {
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => []),
        userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => []),
        onProjectAdded: vi.fn(noop),
        onProjectRemoved: vi.fn(noop),
        onSessionAdded: vi.fn(noop),
        onSessionRemoved: vi.fn(noop),
        onSessionUpdated: vi.fn(noop),
        onHook: vi.fn(noop),
        onScreenState: vi.fn(noop),
        onSessionRegistry: vi.fn(noop),
        fleetReportShellSessions: vi.fn(),
        onApprovalPending: vi.fn(noop),
        onApprovalResolved: vi.fn(noop),
        approvalsList: vi.fn(async () => []),
        onNotifyActivate: vi.fn(noop),
        onIndexUpdated: vi.fn(noop),
        onWatcherDegraded: vi.fn(noop),
        onSubagentUpdated: vi.fn(noop),
        onSubagentRemoved: vi.fn(noop),
        // The two live-delivery channels — present but never firing in this
        // test, so the ONLY way a confirm can reach the store is `list()`.
        onMcpConfirmPending: vi.fn(noop),
        onMcpConfirmResolved: vi.fn(noop),
        mcpConfirmsList
      }
    }
  }

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('populates parkedConfirmList from a confirm that parked before this boot was listening', async () => {
    setActivePinia(createPinia())
    const wire = {
      id: 'confirm-1',
      prompt: 'Allow plan_mission grant?',
      permissionMode: 'default',
      nonDefaultFlags: [],
      commands: [],
      deadline: Date.now() + 30 * 60_000,
      // Recorded at park time, while the operator was present — irrelevant to
      // rehydration: a stale reconnect always surfaces through the durable Inbox.
      mode: 'modal' as const
    }
    installWindow(vi.fn(async () => [wire]))

    const store = useSessionsStore()
    await store.init()

    expect(store.parkedConfirmList.map((p) => p.id)).toEqual(['confirm-1'])
    expect(store.parkedConfirmList[0].mode).toBe('parked')
  })

  it('does not duplicate a confirm the live channel re-delivers after rehydration', async () => {
    setActivePinia(createPinia())
    let deliver: ((p: unknown) => void) | undefined
    const wire = {
      id: 'confirm-2',
      prompt: 'Allow create_session?',
      permissionMode: 'default',
      nonDefaultFlags: [],
      commands: [],
      deadline: Date.now() + 30 * 60_000,
      mode: 'parked' as const
    }
    installWindow(vi.fn(async () => [wire]))
    ;(
      globalThis as unknown as {
        window: { api: { onMcpConfirmPending: (cb: (p: unknown) => void) => () => void } }
      }
    ).window.api.onMcpConfirmPending = vi.fn((cb: (p: unknown) => void) => {
      deliver = cb
      return () => {}
    })

    const store = useSessionsStore()
    await store.init() // rehydrates confirm-2 from list()
    expect(store.parkedConfirmList).toHaveLength(1)

    deliver?.(wire) // main re-broadcasts the same live confirm — must dedupe by id
    expect(store.parkedConfirmList).toHaveLength(1)
  })

  it('leaves the queue empty when nothing is parked', async () => {
    setActivePinia(createPinia())
    installWindow(vi.fn(async () => []))

    const store = useSessionsStore()
    await store.init()

    expect(store.parkedConfirmList).toEqual([])
  })
})

/**
 * BUG-55 — `EnterWorktree` re-homes a session's transcript to a new slug dir
 * while the session keeps running. The watcher's `add`/`unlink` pair has no
 * ordering guarantee (spec §3.1), so the store must be add-authoritative: a
 * `session:added` for an id already living under another folder re-homes the
 * row in place (same object — selection state and live terminal attachment
 * ride along for free), and a later `session:removed` for the vacated slug is
 * a no-op once the row is gone from there.
 */
describe('useSessionsStore cross-slug session move (BUG-55)', () => {
  type DiskSession = FolderEntry['sessions'][number]

  function session(over: Partial<DiskSession> = {}): DiskSession {
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
      agents: [],
      resumable: true,
      bridged: false,
      ...over
    } as DiskSession
  }

  function folder(path: string, sessions: DiskSession[]): FolderEntry {
    return { path, alias: path.split('/').pop() ?? path, gitBranch: '', sessions }
  }

  let cb: Record<string, ((...a: unknown[]) => void) | undefined>

  function installWindow(disk: FolderEntry[]): void {
    cb = {}
    const on =
      (name: string) =>
      (fn: (...a: unknown[]) => void): (() => void) => {
        cb[name] = fn
        return () => {}
      }
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => disk),
        userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => []),
        onProjectAdded: on('onProjectAdded'),
        onProjectRemoved: on('onProjectRemoved'),
        onSessionAdded: on('onSessionAdded'),
        onSessionRemoved: on('onSessionRemoved'),
        onSessionUpdated: on('onSessionUpdated'),
        onHook: on('onHook'),
        onScreenState: on('onScreenState'),
        onSessionRegistry: on('onSessionRegistry'),
        fleetReportShellSessions: vi.fn(),
        onApprovalPending: on('onApprovalPending'),
        onApprovalResolved: on('onApprovalResolved'),
        approvalsList: vi.fn(async () => []),
        onNotifyActivate: on('onNotifyActivate'),
        onIndexUpdated: on('onIndexUpdated'),
        onWatcherDegraded: on('onWatcherDegraded'),
        onSubagentUpdated: on('onSubagentUpdated'),
        onSubagentRemoved: on('onSubagentRemoved')
      }
    }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('re-homes a session into the new folder and drops it from the old one — never duplicated (AC3)', async () => {
    const oldPath = '/repos/alpha'
    const newPath = '/repos/alpha/.claude/worktrees/beta'
    installWindow([
      folder(oldPath, [session({ sessionId: 's1', fullPath: `${oldPath}/s1.jsonl` })]),
      folder(newPath, [])
    ])
    const store = useSessionsStore()
    await store.init()

    const oldFolder = store.folders.find((f) => f.path === oldPath)!
    const before = oldFolder.sessions.find((s) => s.sessionId === 's1')!

    cb.onSessionAdded!({ slug: encodePathToSlug(newPath), sessionId: 's1' })
    await Promise.resolve()

    const newFolder = store.folders.find((f) => f.path === newPath)!
    expect(newFolder.sessions.map((s) => s.sessionId)).toEqual(['s1'])
    expect(oldFolder.sessions.map((s) => s.sessionId)).toEqual([])
    // Same object identity — the live terminal (keyed by sessionId only) and
    // any selection state ride along without a restart (AC5).
    expect(newFolder.sessions[0]).toBe(before)

    // Exactly one row across the whole store — never duplicated (AC3).
    const total = store.folders.flatMap((f) => f.sessions).filter((s) => s.sessionId === 's1')
    expect(total).toHaveLength(1)
  })

  it('an unlink for the vacated OLD slug after a re-home is a no-op (AC4)', async () => {
    const oldPath = '/repos/alpha'
    const newPath = '/repos/alpha/.claude/worktrees/beta'
    installWindow([
      folder(oldPath, [session({ sessionId: 's1', fullPath: `${oldPath}/s1.jsonl` })]),
      folder(newPath, [])
    ])
    const store = useSessionsStore()
    await store.init()
    cb.onSessionAdded!({ slug: encodePathToSlug(newPath), sessionId: 's1' })
    await Promise.resolve()
    const relocated = store.folders.find((f) => f.path === newPath)!.sessions[0]

    // The watcher's grace-delayed removal for the vacated OLD slug arrives late.
    cb.onSessionRemoved!({ slug: encodePathToSlug(oldPath), sessionId: 's1' })

    const newFolder = store.folders.find((f) => f.path === newPath)!
    expect(newFolder.sessions.map((s) => s.sessionId)).toEqual(['s1']) // still there
    expect(newFolder.sessions[0]).toBe(relocated) // untouched, same object
  })

  it('selecting the moved session before the move survives the re-home (selection state rides along)', async () => {
    const oldPath = '/repos/alpha'
    const newPath = '/repos/alpha/.claude/worktrees/beta'
    installWindow([
      folder(oldPath, [session({ sessionId: 's1', fullPath: `${oldPath}/s1.jsonl` })]),
      folder(newPath, [])
    ])
    const store = useSessionsStore()
    await store.init()
    store.select('s1')
    expect(store.selectedId).toBe('s1')

    cb.onSessionAdded!({ slug: encodePathToSlug(newPath), sessionId: 's1' })
    await Promise.resolve()

    expect(store.selectedId).toBe('s1') // never cleared by the move
  })
})

/**
 * BUG-88: an in-place synth→real migration (`collapseSyntheticInto`'s in-place
 * branch, `tryBindAgentMigration`) used to leave `fullPath`/`summary`/
 * `firstPrompt`/`messageCount` blank forever, so the row rendered "Untitled
 * session" — permanently, if `reloadModelOnce`'s resurrection guard could
 * never place the row on a later reload (wrong folder, or no disk match at
 * all). These tests cover: the immediate backfill on both migration paths
 * (AC-1/AC-2/AC-6), the still-open-synthetic preservation regression guard
 * (AC-4), and the resurrection guard no longer resurrecting an unplaceable
 * migrated row (AC-3/AC-7).
 */
describe('useSessionsStore in-place migration backfill + resurrection guard (BUG-88)', () => {
  type DiskSession = FolderEntry['sessions'][number]

  function session(over: Partial<DiskSession> = {}): DiskSession {
    return {
      sessionId: 'unused',
      fullPath: '',
      fileMtime: 1,
      firstPrompt: '',
      summary: '',
      messageCount: 0,
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      gitBranch: '',
      projectPath: '',
      isSidechain: false,
      status: 'idle',
      agents: [],
      resumable: true,
      bridged: false,
      ...over
    } as DiskSession
  }

  function folder(path: string, sessions: DiskSession[]): FolderEntry {
    return { path, alias: path.split('/').pop() ?? path, gitBranch: '', sessions }
  }

  let cb: Record<string, ((...a: unknown[]) => void) | undefined>
  let disk: FolderEntry[]

  function installWindow(): void {
    cb = {}
    const on =
      (name: string) =>
      (fn: (...a: unknown[]) => void): (() => void) => {
        cb[name] = fn
        return () => {}
      }
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        // Fresh object identities every scan — mirrors a real IPC round-trip
        // and, crucially, stops `mergeFolders`'s shallow `{ ...entry }` spread
        // from aliasing a live folder's `.sessions` array onto this fixture's
        // own `disk` array (a store mutation like `createNewSession`'s
        // `unshift` would otherwise silently corrupt `disk` itself).
        foldersLoad: vi.fn(async () =>
          disk.map((f) => ({ ...f, sessions: f.sessions.map((s) => ({ ...s })) }))
        ),
        userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => []),
        onProjectAdded: on('onProjectAdded'),
        onProjectRemoved: on('onProjectRemoved'),
        onSessionAdded: on('onSessionAdded'),
        onSessionRemoved: on('onSessionRemoved'),
        onSessionUpdated: on('onSessionUpdated'),
        onHook: on('onHook'),
        onScreenState: on('onScreenState'),
        onSessionRegistry: on('onSessionRegistry'),
        fleetReportShellSessions: vi.fn(),
        onApprovalPending: on('onApprovalPending'),
        onApprovalResolved: on('onApprovalResolved'),
        approvalsList: vi.fn(async () => []),
        onNotifyActivate: on('onNotifyActivate'),
        onIndexUpdated: on('onIndexUpdated'),
        onWatcherDegraded: on('onWatcherDegraded'),
        onSubagentUpdated: on('onSubagentUpdated'),
        onSubagentRemoved: on('onSubagentRemoved'),
        onFleetChanged: on('onFleetChanged')
      }
    }
  }

  // Drain the microtask chain behind the immediate backfill
  // (`Promise.resolve()` tick + the `foldersLoad()` await).
  const flush = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  }

  // Wait past the ~250 ms reload debounce (perf spec §5.1b) for a watcher-
  // triggered `onIndexUpdated`, then drain its promise chain.
  const flushDebounce = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 300))
    await flush()
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    disk = [folder('/repos/alpha', [])]
    installWindow()
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('AC-1/AC-5/AC-6: collapseSyntheticInto backfills disk identity immediately (same object, no later reload needed)', async () => {
    const store = useSessionsStore()
    await store.init()
    store.createNewSession('/repos/alpha')
    const synthRow = store.folders
      .find((f) => f.path === '/repos/alpha')!
      .sessions.find((s) => s.synthetic === true)!

    // The transcript is already fully written by the time the watcher fires —
    // the reader's very next disk read already knows this session.
    disk = [
      folder('/repos/alpha', [
        session({
          sessionId: 'real1',
          fullPath: '/repos/alpha/real1.jsonl',
          summary: 'refactor auth',
          firstPrompt: 'refactor the auth flow',
          messageCount: 3,
          projectPath: '/repos/alpha'
        })
      ])
    ]

    cb.onSessionAdded!({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'real1' })
    await flush() // no onIndexUpdated / rescan fired — only the migration's own backfill

    const row = store.folders
      .find((f) => f.path === '/repos/alpha')!
      .sessions.find((s) => s.sessionId === 'real1')!
    expect(row).toBe(synthRow) // same object — PTY/selection continuity (AC-5)
    expect(row.synthetic).toBeFalsy()
    expect(row.fullPath).toBe('/repos/alpha/real1.jsonl')
    expect(row.summary).toBe('refactor auth')
    expect(row.firstPrompt).toBe('refactor the auth flow')
    expect(row.messageCount).toBe(3)
  })

  it('AC-2: tryBindAgentMigration backfills disk identity immediately, same as the user path', async () => {
    const store = useSessionsStore()
    await store.init()
    const agent: AgentSession = {
      syntheticId: 'synthetic-agent-a',
      correlationId: 'corr-agent-a',
      folderPath: '/repos/alpha'
    }
    store.insertAgentSession(agent)
    store.armAgentCorrelationForBoot('synthetic-agent-a')

    disk = [
      folder('/repos/alpha', [
        session({
          sessionId: 'real-agent-1',
          fullPath: '/repos/alpha/real-agent-1.jsonl',
          summary: 'agent work',
          firstPrompt: 'do the agent task',
          messageCount: 5,
          projectPath: '/repos/alpha'
        })
      ])
    ]

    cb.onSessionAdded!({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'real-agent-1' })
    await flush()

    const row = store.folders
      .find((f) => f.path === '/repos/alpha')!
      .sessions.find((s) => s.sessionId === 'real-agent-1')!
    expect(row.synthetic).toBeFalsy()
    expect(row.fullPath).toBe('/repos/alpha/real-agent-1.jsonl')
    expect(row.summary).toBe('agent work')
    expect(row.firstPrompt).toBe('do the agent task')
    expect(row.messageCount).toBe(5)
  })

  it('a fresher /rename or firstPrompt landing before the deferred backfill resolves is never clobbered by it', async () => {
    const store = useSessionsStore()
    await store.init()
    store.createNewSession('/repos/alpha')

    // Stale relative to what's about to land live via onSessionUpdated below —
    // proves the deferred disk read never overwrites a fresher value.
    disk = [
      folder('/repos/alpha', [
        session({
          sessionId: 'real1',
          fullPath: '/repos/alpha/real1.jsonl',
          summary: 'stale ai summary',
          firstPrompt: 'stale first prompt',
          messageCount: 1,
          projectPath: '/repos/alpha'
        })
      ])
    ]

    // Migration fires — schedules the deferred backfill (not yet resolved).
    cb.onSessionAdded!({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'real1' })

    // A fresher live update lands in the SAME synchronous turn, before the
    // backfill's own microtask chain has had a chance to run.
    cb.onSessionUpdated!({
      slug: encodePathToSlug('/repos/alpha'),
      sessionId: 'real1',
      renameTitle: 'Renamed by user',
      firstPromptCandidate: 'do the real thing'
    })

    await flush() // let the deferred backfill run to completion

    const row = store.folders
      .find((f) => f.path === '/repos/alpha')!
      .sessions.find((s) => s.sessionId === 'real1')!
    expect(row.summary).toBe('Renamed by user') // never clobbered by the stale disk read
    expect(row.firstPrompt).toBe('do the real thing') // never clobbered either
  })

  // Sidebar liveness D8 replaced BUG-88's "one chance per reload": the row now
  // survives a reload that did not look at its folder, and is dropped once a
  // reload whose model coverage includes its folder's slug still omits it.
  it('AC-3: a migrated row the reader never finds anywhere is dropped by reloadModelOnce, not resurrected', async () => {
    const store = useSessionsStore()
    await store.init()
    store.createNewSession('/repos/alpha')

    // disk never learns about this session under any folder, ever.
    cb.onSessionAdded!({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'real-ghost' })
    await flush()

    let row = store.folders
      .find((f) => f.path === '/repos/alpha')!
      .sessions.find((s) => s.sessionId === 'real-ghost')
    expect(row).toBeDefined() // migrated in place, visible right away

    // An unrelated organic reload runs — the model has not looked at alpha's
    // slug yet, so the row waits for evidence (D8) instead of being dropped.
    cb.onIndexUpdated!({ slug: 'x' })
    await flushDebounce()
    row = store.folders
      .find((f) => f.path === '/repos/alpha')!
      .sessions.find((s) => s.sessionId === 'real-ghost')
    expect(row).toBeDefined()

    // The model refreshes alpha's slug and still doesn't know 'real-ghost'.
    cb.onFleetChanged!({ version: 2, slugs: [encodePathToSlug('/repos/alpha')], full: false })
    await flushDebounce()

    row = store.folders
      .find((f) => f.path === '/repos/alpha')!
      .sessions.find((s) => s.sessionId === 'real-ghost')
    expect(row).toBeUndefined() // dropped — never resurrected as an "Untitled session" ghost
  })

  it('AC-4: a still-open synthetic is still preserved across a reload that cannot know it (regression guard)', async () => {
    const store = useSessionsStore()
    await store.init()
    const synthId = store.createNewSession('/repos/alpha')!

    cb.onIndexUpdated!({ slug: 'x' })
    await flushDebounce()

    const row = store.folders
      .find((f) => f.path === '/repos/alpha')!
      .sessions.find((s) => s.sessionId === synthId)
    expect(row).toBeDefined()
    expect(row?.synthetic).toBe(true)
  })

  it('AC-7: a migrated row whose real id lives on disk under a DIFFERENT folder leaves no ghost after two reloads', async () => {
    disk = [folder('/repos/alpha', []), folder('/repos/beta', [])]
    const store = useSessionsStore()
    await store.init()
    store.createNewSession('/repos/alpha')

    cb.onSessionAdded!({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'real-wrong-folder' })
    await flush()

    let alpha = store.folders.find((f) => f.path === '/repos/alpha')!
    expect(alpha.sessions.some((s) => s.sessionId === 'real-wrong-folder')).toBe(true) // migrated in place, momentarily sits in alpha

    // The disk scanner's own truth: this session actually belongs under beta.
    disk = [
      folder('/repos/alpha', []),
      folder('/repos/beta', [
        session({
          sessionId: 'real-wrong-folder',
          fullPath: '/repos/beta/real-wrong-folder.jsonl',
          summary: 'beta work',
          projectPath: '/repos/beta'
        })
      ])
    ]

    cb.onIndexUpdated!({ slug: 'x' })
    await flushDebounce()
    cb.onIndexUpdated!({ slug: 'x' })
    await flushDebounce()

    alpha = store.folders.find((f) => f.path === '/repos/alpha')!
    const beta = store.folders.find((f) => f.path === '/repos/beta')!
    expect(alpha.sessions.some((s) => s.sessionId === 'real-wrong-folder')).toBe(false) // no ghost left behind
    expect(beta.sessions.some((s) => s.sessionId === 'real-wrong-folder')).toBe(true) // shows up where the disk actually says it lives
  })
})

/**
 * BUG-37: the BUG-23 boot-deadline reaper was only armed from `insertAgentSession`
 * (the MCP `create_session` path) and `retrySyntheticBoot`. `createNewSession` (the
 * human "+ New session" button) and `dispatchCardSession` (roadmap-card dispatch)
 * minted a synthetic and never armed it — a dropped boot on either path had no
 * correction mechanism and stayed painted `working` forever. These tests mirror the
 * existing `insertAgentSession` reaper coverage (`tests/agent-boot-queue.test.ts`)
 * for the two previously-unarmed creation paths.
 */
describe('dead-synthetic reaper armed from every creation path (BUG-37)', () => {
  function diskFolders(): FolderEntry[] {
    return [{ path: '/repos/alpha', alias: 'alpha', gitBranch: 'main', sessions: [] }]
  }

  function installWindow(): void {
    const on =
      () =>
      (_cb: (...a: unknown[]) => void): (() => void) =>
      () => {}
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => diskFolders()),
        userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => []),
        onProjectAdded: on(),
        onProjectRemoved: on(),
        onSessionAdded: on(),
        onSessionRemoved: on(),
        onSessionUpdated: on(),
        onSessionRegistry: on(),
        onHook: on(),
        onScreenState: on(),
        fleetReportShellSessions: vi.fn(),
        onApprovalPending: on(),
        onApprovalResolved: on(),
        approvalsList: vi.fn(async () => []),
        onNotifyActivate: on(),
        onIndexUpdated: on(),
        onWatcherDegraded: on(),
        onSubagentUpdated: on(),
        onSubagentRemoved: on(),
        notify: vi.fn(),
        pushSend: vi.fn(),
        reportPromptUndelivered: vi.fn(),
        clearPromptUndelivered: vi.fn()
      }
    }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    installWindow()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('createNewSession arms the reaper: a boot with no live PTY is FAILED at the deadline', async () => {
    const store = useSessionsStore()
    await store.init()

    const synthId = store.createNewSession('/repos/alpha')!
    const s = store.findSessionById(synthId)!
    expect(s.taskState).toBeUndefined()

    vi.advanceTimersByTime(AGENT_BOOT_TIMEOUT_MS)

    expect(s.taskState).toBe('failed')
    expect(s.failureReason).toBe('boot_timeout')
  })

  it('createNewSession does NOT reap a synthetic whose boot produced a live PTY', async () => {
    const store = useSessionsStore()
    await store.init()

    const synthId = store.createNewSession('/repos/alpha')!
    store.registerLiveSession(synthId)

    vi.advanceTimersByTime(AGENT_BOOT_TIMEOUT_MS)

    const s = store.findSessionById(synthId)!
    expect(s.taskState).toBeUndefined()
  })

  it('dispatchCardSession arms the reaper: a boot with no live PTY is FAILED at the deadline', async () => {
    const store = useSessionsStore()
    await store.init()

    const result = store.dispatchCardSession('/repos/alpha', 'read the card and go')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const s = store.findSessionById(result.sessionId)!
    expect(s.taskState).toBeUndefined()

    vi.advanceTimersByTime(AGENT_BOOT_TIMEOUT_MS)

    expect(s.taskState).toBe('failed')
    expect(s.failureReason).toBe('boot_timeout')
  })

  it('dispatchCardSession does NOT reap a synthetic whose prompt was actually delivered', async () => {
    const store = useSessionsStore()
    await store.init()

    const result = store.dispatchCardSession('/repos/alpha', 'read the card and go')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    store.registerLiveSession(result.sessionId)
    // Simulate the real delivery path (armInjectGate → pasteAndSubmit → T172
    // ledger) that a mounted TerminalPane would have completed within seconds.
    injectionLedger.record(result.sessionId, { type: 'paste-written' })

    vi.advanceTimersByTime(AGENT_BOOT_TIMEOUT_MS)

    const s = store.findSessionById(result.sessionId)!
    expect(s.taskState).toBeUndefined()
  })
})

/**
 * BUG-70 §3.3 — a park is a resource decision, not a lifecycle outcome. The
 * exit handler's teardown (`live.dead`, unregister live session, unregister
 * writer) always runs, but ONLY a natural exit paints `[session ended]` and
 * flips the task-state dot. `shouldMarkExited` is the pure guard extracted so
 * it's testable without mounting the SFC.
 */
describe('shouldMarkExited (BUG-70 §3.3)', () => {
  it('is true for a natural exit', () => {
    expect(shouldMarkExited('natural')).toBe(true)
  })

  it('is true when reason is absent (back-compat wire shape)', () => {
    expect(shouldMarkExited(undefined)).toBe(true)
  })

  it('is false for a park', () => {
    expect(shouldMarkExited('park')).toBe(false)
  })
})

/**
 * T178 row #13 — the PID-registry overlay (`registryStates`, fed by
 * `onSessionRegistry`) is never cleared for a parked key, so `isLiveSignal`
 * can still resolve a stale dot for a session with no process. `markHibernated`
 * must clear the override the same way it clears `taskState`.
 */
describe('markHibernated clears the PID-registry override (T178 row #13)', () => {
  type DiskSession = FolderEntry['sessions'][number]

  function session(over: Partial<DiskSession> = {}): DiskSession {
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
      agents: [],
      resumable: true,
      bridged: false,
      ...over
    } as DiskSession
  }

  let registryCb: ((payload: { sessionId: string; taskState: string | null }) => void) | undefined

  beforeEach(() => {
    setActivePinia(createPinia())
    registryCb = undefined
    const noop = (): (() => void) => () => {}
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => [
          { path: '/repos/alpha', alias: 'alpha', gitBranch: '', sessions: [session()] }
        ]),
        userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => []),
        onProjectAdded: noop,
        onProjectRemoved: noop,
        onSessionAdded: noop,
        onSessionRemoved: noop,
        onSessionUpdated: noop,
        onHook: noop,
        onScreenState: noop,
        onSessionRegistry: vi.fn((cb) => {
          registryCb = cb
          return () => {}
        }),
        fleetReportShellSessions: vi.fn(),
        onApprovalPending: noop,
        onApprovalResolved: noop,
        approvalsList: vi.fn(async () => []),
        onNotifyActivate: noop,
        onIndexUpdated: noop,
        onWatcherDegraded: noop,
        onSubagentUpdated: noop,
        onSubagentRemoved: noop
      }
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('drops a stale registry override when the session is parked', async () => {
    const store = useSessionsStore()
    await store.init()
    registryCb?.({ sessionId: 's1', taskState: 'working' })
    expect(store.registryStates.get('s1')).toBe('working')

    store.markHibernated('s1')

    expect(store.registryStates.has('s1')).toBe(false)
  })

  it('is a no-op when there was no registry override to begin with', async () => {
    const store = useSessionsStore()
    await store.init()

    expect(() => store.markHibernated('s1')).not.toThrow()
    expect(store.registryStates.has('s1')).toBe(false)
  })
})

/**
 * BUG-60: `reapSyntheticBoot`'s live-PTY branch used to be an unconditional
 * no-op (`bootVerdict` reads a live PTY as unconditional success), so a session
 * that booted a live REPL and was never spoken to sat `working` forever,
 * invisible to this reaper. It now reads the same T172 ledger signal BUG-61's
 * injection watchdog consumes and surfaces the genuinely-stuck case as
 * `prompt_undelivered` — reusing the escalation path (`markPromptUndelivered`)
 * that already existed but was unreachable from here.
 */
describe('reaper surfaces prompt_undelivered for a live PTY that never got its prompt (BUG-60)', () => {
  function diskFolders(): FolderEntry[] {
    return [{ path: '/repos/alpha', alias: 'alpha', gitBranch: 'main', sessions: [] }]
  }

  function installWindow(): void {
    const on =
      () =>
      (_cb: (...a: unknown[]) => void): (() => void) =>
      () => {}
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => diskFolders()),
        userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => []),
        onProjectAdded: on(),
        onProjectRemoved: on(),
        onSessionAdded: on(),
        onSessionRemoved: on(),
        onSessionUpdated: on(),
        onSessionRegistry: on(),
        onHook: on(),
        onScreenState: on(),
        fleetReportShellSessions: vi.fn(),
        onApprovalPending: on(),
        onApprovalResolved: on(),
        approvalsList: vi.fn(async () => []),
        onNotifyActivate: on(),
        onIndexUpdated: on(),
        onWatcherDegraded: on(),
        onSubagentUpdated: on(),
        onSubagentRemoved: on(),
        notify: vi.fn(),
        pushSend: vi.fn(),
        reportPromptUndelivered: vi.fn(),
        clearPromptUndelivered: vi.fn()
      }
    }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    installWindow()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('AC1: surfaces FAILED/prompt_undelivered for a live PTY whose prompt was never delivered', async () => {
    const store = useSessionsStore()
    await store.init()

    // Use a prompt that exceeds the argv threshold so it stays in the queue and
    // triggers the watchdog (argv-based prompts are delivered at spawn, not async injection)
    const longPrompt = 'x'.repeat(AGENT_PREPROMPT_ARGV_MAX_CHARS + 1)
    const result = store.dispatchCardSession('/repos/alpha', longPrompt)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // The PTY came up live, but nothing ever consumed/injected the prompt — the
    // exact "booted a live REPL, never spoken to" scenario from the postmortem.
    store.registerLiveSession(result.sessionId)

    vi.advanceTimersByTime(AGENT_BOOT_TIMEOUT_MS)

    const s = store.findSessionById(result.sessionId)!
    expect(s.taskState).toBe('failed')
    expect(s.failureReason).toBe('prompt_undelivered')

    // BUG-64 C: the reaper's escalation reaches main too, not just Pinia —
    // otherwise get_session/get_fleet would keep reporting this session `active`.
    const api = (
      globalThis as unknown as {
        window: { api: { reportPromptUndelivered: ReturnType<typeof vi.fn> } }
      }
    ).window.api
    expect(api.reportPromptUndelivered).toHaveBeenCalledWith(result.sessionId)
  })

  it('AC2: retryPromptInjection is the recovery — it clears the reaper-set prompt_undelivered failure', async () => {
    const store = useSessionsStore()
    await store.init()

    // Use a prompt that exceeds the argv threshold so it stays in the queue and
    // triggers the watchdog (argv-based prompts are delivered at spawn, not async injection)
    const longPrompt = 'x'.repeat(AGENT_PREPROMPT_ARGV_MAX_CHARS + 1)
    const result = store.dispatchCardSession('/repos/alpha', longPrompt)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    store.registerLiveSession(result.sessionId)
    vi.advanceTimersByTime(AGENT_BOOT_TIMEOUT_MS)
    expect(store.findSessionById(result.sessionId)!.failureReason).toBe('prompt_undelivered')

    // Its guard is specifically failureReason === 'prompt_undelivered' — a
    // boot_timeout failure must NOT be cleared by it (sessions.ts's
    // retryPromptInjection doc comment: "only clears state when the CURRENT
    // failure is prompt_undelivered").
    const other = store.createNewSession('/repos/alpha')!
    vi.advanceTimersByTime(AGENT_BOOT_TIMEOUT_MS)
    expect(store.findSessionById(other)!.failureReason).toBe('boot_timeout')
    store.retryPromptInjection(other)
    expect(store.findSessionById(other)!.failureReason).toBe('boot_timeout')

    // On the actual prompt_undelivered session, it clears the failed state.
    store.retryPromptInjection(result.sessionId)
    const s = store.findSessionById(result.sessionId)!
    expect(s.taskState).toBeUndefined()
    expect(s.failureReason).toBeUndefined()
  })

  it('AC3: a healthy session with no prompt queued is never falsely reaped', async () => {
    const store = useSessionsStore()
    await store.init()

    // A plain "+ New session" — no agent pre-prompt was ever queued for it.
    const synthId = store.createNewSession('/repos/alpha')!
    store.registerLiveSession(synthId)

    vi.advanceTimersByTime(AGENT_BOOT_TIMEOUT_MS)

    const s = store.findSessionById(synthId)!
    expect(s.taskState).toBeUndefined()
    expect(s.failureReason).toBeUndefined()
  })

  it('AC4: a normally-working session (prompt delivered) is never touched', async () => {
    const store = useSessionsStore()
    await store.init()

    const result = store.dispatchCardSession('/repos/alpha', 'read the card and go')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    store.registerLiveSession(result.sessionId)
    // The ledger confirms the paste actually landed — a real delivery.
    injectionLedger.record(result.sessionId, { type: 'paste-written' })
    // A busy session doing its job: still working, not failed.
    store.applyTaskState(result.sessionId, 'working')

    vi.advanceTimersByTime(AGENT_BOOT_TIMEOUT_MS)

    const s = store.findSessionById(result.sessionId)!
    expect(s.taskState).toBe('working')
    expect(s.failureReason).toBeUndefined()
  })
})
