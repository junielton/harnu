import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore, type Session } from '../src/renderer/src/stores/sessions'
import { injectionLedger } from '../src/renderer/src/stores/injection-ledger'
import type { FolderEntry } from '../src/preload'

/**
 * Presence regression net (spec §9): a disk session never vanishes from a
 * reload or an unrelated watcher event (G3), synthetics survive reloads until
 * reconciled (G4), and a live `/rename` updates the label (N3). Drives the real
 * `reloadModel` + watcher handlers through a captured `window.api` stub.
 *
 * Folder-first model: a Folder IS what a Worktree was — sessions live directly
 * under a folder keyed by absolute path. Watcher events stay slug-keyed; the
 * store decodes the slug back to a path to address the folder.
 */

function diskSession(sessionId: string, folderPath: string, branch = 'main'): Session {
  return {
    sessionId,
    fullPath: `${folderPath}/${sessionId}.jsonl`,
    fileMtime: 1,
    firstPrompt: 'first prompt',
    summary: '',
    messageCount: 1,
    created: '2026-06-01T00:00:00.000Z',
    modified: '2026-06-01T00:00:00.000Z',
    gitBranch: branch,
    projectPath: folderPath,
    isSidechain: false,
    status: 'idle',
    resumable: true,
    bridged: false
  }
}

function diskFolder(path: string, sessions: Session[], branch = 'main'): FolderEntry {
  return {
    path,
    alias: path.split('/').pop() ?? path,
    gitBranch: branch,
    sessions: sessions as unknown as FolderEntry['sessions']
  }
}

/**
 * Build a `window.api` stub. `getDisk` is what `foldersLoad()` returns each call
 * (a getter so a test can mutate disk between reloads). Watcher `on*` callbacks
 * are captured into `handlers` so a test can fire them.
 */
function installApi(getDisk: () => FolderEntry[]): {
  handlers: Record<string, ((p: unknown) => void) | undefined>
} {
  const handlers: Record<string, ((p: unknown) => void) | undefined> = {}
  const capture =
    (name: string) =>
    (cb: (p: unknown) => void): (() => void) => {
      handlers[name] = cb
      return () => {
        handlers[name] = undefined
      }
    }
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      foldersLoad: vi.fn(async () => getDisk()),
      userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
      orchestratorListArmed: vi.fn(async () => []),
      onProjectAdded: capture('projectAdded'),
      onProjectRemoved: capture('projectRemoved'),
      onSessionAdded: capture('sessionAdded'),
      onSessionRemoved: capture('sessionRemoved'),
      onSessionUpdated: capture('sessionUpdated'),
      onIndexUpdated: capture('indexUpdated'),
      onWatcherDegraded: capture('watcherDegraded'),
      onSubagentUpdated: capture('subagentUpdated'),
      onSubagentRemoved: capture('subagentRemoved'),
      onHook: capture('hook'),
      onScreenState: capture('screenState'),
      onSessionRegistry: capture('sessionRegistry'),
      fleetReportShellSessions: vi.fn(),
      onApprovalPending: capture('approvalPending'),
      onApprovalResolved: capture('approvalResolved'),
      approvalsList: vi.fn(async () => []),
      onNotifyActivate: capture('notifyActivate'),
      onFleetChanged: capture('fleetChanged'),
      notify: vi.fn()
    }
  }
  return { handlers }
}

function allIds(store: ReturnType<typeof useSessionsStore>): string[] {
  return store.allSessions.map((s) => s.sessionId)
}

beforeEach(() => {
  setActivePinia(createPinia())
})
afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('G3 — presence', () => {
  it('keeps a disk session across a reloadModel that still returns it', async () => {
    const disk = [diskFolder('/repo/foo', [diskSession('uuid-1', '/repo/foo')])]
    installApi(() => disk)
    const store = useSessionsStore()
    await store.init()
    expect(allIds(store)).toContain('uuid-1')

    await store.reloadModel()
    expect(allIds(store)).toContain('uuid-1') // never dropped by a reload
  })

  it('an onIndexUpdated-style reload does not drop unrelated sessions', async () => {
    const disk = [
      diskFolder('/repo/foo', [
        diskSession('uuid-1', '/repo/foo'),
        diskSession('uuid-2', '/repo/foo')
      ])
    ]
    installApi(() => disk)
    const store = useSessionsStore()
    await store.init()
    await store.reloadModel()
    expect(allIds(store).sort()).toEqual(['uuid-1', 'uuid-2'])
  })

  it('onSessionRemoved removes ONLY the named session', async () => {
    const disk = [
      diskFolder('/repo/foo', [
        diskSession('uuid-1', '/repo/foo'),
        diskSession('uuid-2', '/repo/foo')
      ])
    ]
    const { handlers } = installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    handlers.sessionRemoved?.({ slug: '-repo-foo', sessionId: 'uuid-unknown' })
    expect(allIds(store).sort()).toEqual(['uuid-1', 'uuid-2'])

    handlers.sessionRemoved?.({ slug: '-repo-foo', sessionId: 'uuid-1' })
    expect(allIds(store)).toEqual(['uuid-2'])
  })

  it('closeSession is an explicit removal of one session', async () => {
    const disk = [diskFolder('/repo/foo', [diskSession('uuid-1', '/repo/foo')])]
    installApi(() => disk)
    const store = useSessionsStore()
    await store.init()
    store.closeSession('uuid-1')
    expect(allIds(store)).not.toContain('uuid-1')
  })
})

describe('G4 — synthetic survival', () => {
  it('a synthetic session survives a reloadModel (in-store rescan) that does not return it', async () => {
    const disk = [diskFolder('/repo/foo', [diskSession('uuid-1', '/repo/foo')])]
    installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    const synthId = store.createNewSession('/repo/foo')
    expect(synthId).toBeTruthy()
    expect(allIds(store)).toContain(synthId as string)

    await store.reloadModel()
    expect(allIds(store)).toContain(synthId as string)
    const synth = store.allSessions.find((s) => s.sessionId === synthId)
    expect(synth?.synthetic).toBe(true)
  })

  it('createNewSession dedupes to one synthetic per folder', async () => {
    const disk = [diskFolder('/repo/foo', [diskSession('uuid-1', '/repo/foo')])]
    installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    const first = store.createNewSession('/repo/foo')
    const second = store.createNewSession('/repo/foo')
    expect(second).toBe(first)
    const synthCount = store.allSessions.filter((s) => s.synthetic === true).length
    expect(synthCount).toBe(1)
  })
})

describe('new-session launch override', () => {
  it('createNewSession stores the bootOverride config on the synthetic', async () => {
    const disk = [diskFolder('/repo/foo', [diskSession('uuid-1', '/repo/foo')])]
    installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    const cfg = { model: 'sonnet', chrome: true, addDirs: ['/x'] }
    const synthId = store.createNewSession('/repo/foo', cfg) as string
    const synth = store.allSessions.find((s) => s.sessionId === synthId)
    expect(synth?.bootOverride).toEqual(cfg)
  })

  it('an empty config attaches no bootOverride', async () => {
    const disk = [diskFolder('/repo/foo', [])]
    installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    const synthId = store.createNewSession('/repo/foo', {}) as string
    const synth = store.allSessions.find((s) => s.sessionId === synthId)
    expect(synth?.bootOverride).toBeUndefined()
  })
})

describe('N3 — live rename', () => {
  it('an onSessionUpdated custom-title line updates the session summary immediately', async () => {
    const disk = [diskFolder('/repo/foo', [diskSession('uuid-1', '/repo/foo')])]
    const { handlers } = installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    const before = store.allSessions.find((s) => s.sessionId === 'uuid-1')
    expect(before?.summary).toBe('')

    handlers.sessionUpdated?.({
      slug: '-repo-foo',
      sessionId: 'uuid-1',
      renameTitle: 'Renamed live'
    })

    const after = store.allSessions.find((s) => s.sessionId === 'uuid-1')
    expect(after?.summary).toBe('Renamed live')
  })

  // The legacy `title` fallback now lives in main (`buildSessionUpdate`, covered
  // in watcher-payload.test.ts); the store applies `aiTitle` with the disk
  // cascade `summary = customTitle || aiTitle` (sidebar-liveness C3).
  it('applies an ai-title only when the row has no summary yet', async () => {
    const disk = [diskFolder('/repo/foo', [diskSession('uuid-1', '/repo/foo')])]
    const { handlers } = installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    handlers.sessionUpdated?.({ slug: '-repo-foo', sessionId: 'uuid-1', aiTitle: 'AI title' })
    expect(store.allSessions.find((s) => s.sessionId === 'uuid-1')?.summary).toBe('AI title')

    handlers.sessionUpdated?.({ slug: '-repo-foo', sessionId: 'uuid-1', renameTitle: 'Renamed' })
    handlers.sessionUpdated?.({ slug: '-repo-foo', sessionId: 'uuid-1', aiTitle: 'Newer AI' })
    expect(store.allSessions.find((s) => s.sessionId === 'uuid-1')?.summary).toBe('Renamed')
  })

  it('never adopts a synthetic for an ai-title-only update', async () => {
    const disk = [diskFolder('/repo/foo', [])]
    const { handlers } = installApi(() => disk)
    const store = useSessionsStore()
    await store.init()
    const synthId = store.createNewSession('/repo/foo') as string

    handlers.sessionUpdated?.({ slug: '-repo-foo', sessionId: 'real-x', aiTitle: 'AI title' })
    expect(store.allSessions.map((s) => s.sessionId)).toEqual([synthId])
  })

  it('marks the session active on any update', async () => {
    const disk = [diskFolder('/repo/foo', [diskSession('uuid-1', '/repo/foo')])]
    const { handlers } = installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    handlers.sessionUpdated?.({ slug: '-repo-foo', sessionId: 'uuid-1' })
    expect(store.allSessions.find((s) => s.sessionId === 'uuid-1')?.status).toBe('active')
  })
})

describe('#5 — synthetic → real migration outside onSessionAdded', () => {
  it('onSessionUpdated promotes the pending synthetic in place and keeps its /rename', async () => {
    const disk = [diskFolder('/repo/foo', [])]
    const { handlers } = installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    const migrations: Array<[string, string]> = []
    store.registerMigrateHandler((from, to) => migrations.push([from, to]))

    const synthId = store.createNewSession('/repo/foo') as string
    expect(synthId.startsWith('synthetic-')).toBe(true)
    expect(store.selectedId).toBe(synthId)

    handlers.sessionUpdated?.({
      slug: '-repo-foo',
      sessionId: 'real-uuid-1',
      renameTitle: 'Renamed after create'
    })

    expect(allIds(store)).toEqual(['real-uuid-1'])
    const promoted = store.allSessions.find((s) => s.sessionId === 'real-uuid-1')
    expect(promoted?.synthetic).toBeFalsy()
    expect(promoted?.summary).toBe('Renamed after create')
    expect(store.selectedId).toBe('real-uuid-1')
    expect(migrations).toEqual([[synthId, 'real-uuid-1']])
  })

  it('T172: fireMigrate carries the injection ledger trail onto the real id, same edge as the pending-prompt queue', async () => {
    const disk = [diskFolder('/repo/foo', [])]
    const { handlers } = installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    const synthId = store.createNewSession('/repo/foo') as string
    // Simulate what `armInjectGate` would have recorded against the synthetic id
    // before the real uuid landed (target resolved + prompt dequeued).
    injectionLedger.record(synthId, { type: 'target-resolved', attempt: 1 })
    injectionLedger.record(synthId, { type: 'prompt-dequeued', attempt: 1 })
    expect(injectionLedger.statusFor(synthId)).toBe('dequeued')

    handlers.sessionUpdated?.({
      slug: '-repo-foo',
      sessionId: 'real-uuid-ledger-1',
      renameTitle: 'Renamed after create'
    })

    // The trail followed the migration — reachable under the real id now, gone
    // from the stale synthetic id, and the injected/dequeued distinction is
    // preserved (still "dequeued", not silently promoted to "injected").
    expect(injectionLedger.getTrail(synthId)).toEqual([])
    expect(injectionLedger.getTrail('real-uuid-ledger-1').map((e) => e.type)).toEqual([
      'target-resolved',
      'prompt-dequeued'
    ])
    expect(injectionLedger.statusFor('real-uuid-ledger-1')).toBe('dequeued')
    injectionLedger.clear('real-uuid-ledger-1')
  })

  it('onSessionAdded migrates the pending synthetic in place WITHOUT a disk reload (perf §5.1a)', async () => {
    // disk stays empty throughout — firstPrompt must come from the tail, not a scan.
    const disk = [diskFolder('/repo/foo', [])]
    const { handlers } = installApi(() => disk)
    const api = (
      globalThis as unknown as { window: { api: { foldersLoad: ReturnType<typeof vi.fn> } } }
    ).window.api
    const store = useSessionsStore()
    await store.init()

    const migrations: Array<[string, string]> = []
    store.registerMigrateHandler((from, to) => migrations.push([from, to]))

    const synthId = store.createNewSession('/repo/foo') as string
    // Count only post-create reloads — init() legitimately scans once.
    api.foldersLoad.mockClear()

    // The watcher fires session:added for the real uuid Claude just wrote.
    handlers.sessionAdded?.({ slug: '-repo-foo', sessionId: 'real-uuid-9' })

    // Migrated in place: the synthetic id is rewritten, NO full reload runs
    // (this is what removes the freeze on `+ New session`).
    expect(api.foldersLoad).not.toHaveBeenCalled()
    expect(allIds(store)).toEqual(['real-uuid-9'])
    expect(store.allSessions.find((s) => s.sessionId === 'real-uuid-9')?.synthetic).toBeFalsy()
    expect(migrations).toEqual([[synthId, 'real-uuid-9']])

    // The subsequent session:updated tail backfills firstPrompt, so the row is
    // not "Untitled" (regression guard — the adversarial-review bug).
    handlers.sessionUpdated?.({
      slug: '-repo-foo',
      sessionId: 'real-uuid-9',
      firstPromptCandidate: 'Build the thing'
    })
    expect(store.allSessions.find((s) => s.sessionId === 'real-uuid-9')?.firstPrompt).toBe(
      'Build the thing'
    )
  })

  it('onIndexUpdated collapses the synthetic into the real twin instead of duplicating', async () => {
    let disk = [diskFolder('/repo/foo', [])]
    const { handlers } = installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    const migrations: Array<[string, string]> = []
    store.registerMigrateHandler((from, to) => migrations.push([from, to]))

    const synthId = store.createNewSession('/repo/foo') as string
    const synthCreated = store.allSessions.find((s) => s.sessionId === synthId)!.created

    const real = diskSession('real-uuid-2', '/repo/foo')
    real.created = synthCreated
    real.modified = synthCreated
    disk = [diskFolder('/repo/foo', [real])]

    handlers.indexUpdated?.({ slug: '-repo-foo' })
    // onIndexUpdated's reload is debounced ~250 ms (perf spec §5.1b); wait past
    // it, then drain the reload + collapseResolvedSynthetics chain.
    await new Promise((r) => setTimeout(r, 300))
    await new Promise((r) => setTimeout(r, 0))

    expect(allIds(store)).toEqual(['real-uuid-2'])
    expect(store.allSessions.find((s) => s.sessionId === synthId)).toBeUndefined()
    expect(migrations).toEqual([[synthId, 'real-uuid-2']])
  })

  it('onSessionUpdated for an unknown uuid WITHOUT a rename does not hijack the synthetic', async () => {
    const disk = [diskFolder('/repo/foo', [])]
    const { handlers } = installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    const migrations: Array<[string, string]> = []
    store.registerMigrateHandler((from, to) => migrations.push([from, to]))
    const synthId = store.createNewSession('/repo/foo') as string

    handlers.sessionUpdated?.({
      slug: '-repo-foo',
      sessionId: 'sdk-reviewer-uuid'
    })

    expect(allIds(store)).toEqual([synthId])
    expect(store.allSessions.find((s) => s.sessionId === synthId)?.synthetic).toBe(true)
    expect(migrations).toEqual([])
  })

  it('a promoted (not-yet-on-disk) session survives a reload that does not return it', async () => {
    const disk = [diskFolder('/repo/foo', [])]
    const { handlers } = installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    store.createNewSession('/repo/foo')
    handlers.sessionUpdated?.({
      slug: '-repo-foo',
      sessionId: 'real-uuid-3',
      renameTitle: 'Promoted then reloaded'
    })
    expect(allIds(store)).toEqual(['real-uuid-3'])

    await store.reloadModel()
    const survived = store.allSessions.find((s) => s.sessionId === 'real-uuid-3')
    expect(survived).toBeDefined()
    expect(survived?.summary).toBe('Promoted then reloaded')
  })

  it('onIndexUpdated does NOT collapse a synthetic when the only disk session is old', async () => {
    const old = diskSession('uuid-old', '/repo/foo')
    const disk = [diskFolder('/repo/foo', [old])]
    const { handlers } = installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    const synthId = store.createNewSession('/repo/foo') as string

    handlers.indexUpdated?.({ slug: '-repo-foo' })
    // Debounced reload (perf spec §5.1b) — wait past the window before asserting.
    await new Promise((r) => setTimeout(r, 300))
    await new Promise((r) => setTimeout(r, 0))

    expect(allIds(store)).toContain(synthId)
    expect(store.allSessions.find((s) => s.sessionId === synthId)?.synthetic).toBe(true)
  })
})

/**
 * Lesson 003 follow-up — the "known limitation": a brand-new dash-folder whose
 * ONLY session is the synthetic placeholder (`fullPath === ''`). Claude encodes
 * the slug by mapping every non-alphanumeric char to `-`, so the literal dashes
 * in `TASK-0240-build-footer` are indistinguishable from path separators and the
 * reverse decode is lossy. `reconcileSessionAdded` used to fail to resolve the
 * folder, bail to `reloadModel`, re-inject the synthetic AND surface the real
 * session → two rows talking to the same JSONL, `fireMigrate` never firing.
 *
 * The faithful forward-encode (`encodePathToSlug`) resolves the folder
 * losslessly, so the synthetic migrates in place instead.
 */
describe('#003 — brand-new dash-folder, synthetic-only (encoded-slug resolution)', () => {
  const folderPath = '/home/u/worktrees/TASK-0240-build-footer'
  const slug = '-home-u-worktrees-TASK-0240-build-footer'

  it('migrates the synthetic in place when the real JSONL lands under the encoded slug — ONE row', async () => {
    // The real JSONL is on disk by the time session:added fires (so the buggy
    // bail-to-reload would surface it alongside the resurrected synthetic).
    let disk = [diskFolder(folderPath, [])]
    const { handlers } = installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    const migrations: Array<[string, string]> = []
    store.registerMigrateHandler((from, to) => migrations.push([from, to]))

    const synthId = store.createNewSession(folderPath) as string
    expect(synthId.startsWith('synthetic-')).toBe(true)

    disk = [diskFolder(folderPath, [diskSession('real-uuid-7', folderPath)])]
    handlers.sessionAdded?.({ slug, sessionId: 'real-uuid-7' })
    // reconcileSessionAdded is async; drain any reload it might trigger.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    expect(allIds(store)).toEqual(['real-uuid-7'])
    expect(store.allSessions.find((s) => s.sessionId === 'real-uuid-7')?.synthetic).toBeFalsy()
    expect(migrations).toEqual([[synthId, 'real-uuid-7']])
  })

  it('does not leave a stuck placeholder that blocks the next New session', async () => {
    let disk = [diskFolder(folderPath, [])]
    const { handlers } = installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    const synthId = store.createNewSession(folderPath) as string

    disk = [diskFolder(folderPath, [diskSession('real-uuid-8', folderPath)])]
    handlers.sessionAdded?.({ slug, sessionId: 'real-uuid-8' })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    // The synthetic is gone (migrated), so the dedupe no longer re-selects an
    // orphan — a fresh New session gets a brand-new synthetic id.
    const second = store.createNewSession(folderPath) as string
    expect(second).not.toBe(synthId)
    expect(second.startsWith('synthetic-')).toBe(true)
    expect(store.allSessions.filter((s) => s.synthetic === true)).toHaveLength(1)
  })
})

describe('T18 Fix 1 — unresolvable-slug fallback collapses by real id (no duplicate)', () => {
  const folderPath = '/home/u/repos/alpha'

  // Sidebar liveness (AC-4/A7): the fallback no longer runs its own (stale)
  // reload — main's `fleet:changed` push after its model refresh brings the
  // real row, and the reload collapses the synthetic into it before commit.
  const pushAndSettle = async (handlers: Record<string, ((p: unknown) => void) | undefined>) => {
    handlers.fleetChanged?.({ version: 2, slugs: ['x'], full: false })
    await new Promise((r) => setTimeout(r, 300))
    await new Promise((r) => setTimeout(r, 0))
  }

  it('the push reload collapses the synthetic into the real row — ONE row, PTY re-keyed', async () => {
    let disk = [diskFolder(folderPath, [])]
    const { handlers } = installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    const migrations: Array<[string, string]> = []
    store.registerMigrateHandler((from, to) => migrations.push([from, to]))

    const synthId = store.createNewSession(folderPath) as string
    expect(synthId.startsWith('synthetic-')).toBe(true)

    // The real JSONL is on disk, but the event's slug does NOT forward-encode to
    // the folder path (normalization drift) → primary slug resolution MISSES,
    // exercising the fallback. Pre-fix: bare reload → synthetic survives next to
    // the real twin (two rows). Post-fix: pending id + collapse-by-id → one row.
    disk = [diskFolder(folderPath, [diskSession('real-R', folderPath)])]
    handlers.sessionAdded?.({ slug: 'a-bogus-unresolvable-slug', sessionId: 'real-R' })
    await pushAndSettle(handlers)

    expect(allIds(store)).toEqual(['real-R'])
    expect(store.allSessions.find((s) => s.sessionId === 'real-R')?.synthetic).toBeFalsy()
    expect(migrations).toEqual([[synthId, 'real-R']])
  })

  it('is idempotent — a repeat event for an already-collapsed id never grabs an unrelated synthetic', async () => {
    let disk = [diskFolder(folderPath, [])]
    const { handlers } = installApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    const synth1 = store.createNewSession(folderPath) as string
    disk = [diskFolder(folderPath, [diskSession('real-R', folderPath)])]
    handlers.sessionAdded?.({ slug: 'bogus', sessionId: 'real-R' })
    await pushAndSettle(handlers)
    expect(store.allSessions.find((s) => s.sessionId === 'real-R')?.synthetic).toBeFalsy()

    // A SECOND, unrelated New session in the same folder.
    const synth2 = store.createNewSession(folderPath) as string
    expect(synth2).not.toBe(synth1)

    // Fresh disk snapshot for the next reload (real IPC returns a fresh copy per
    // call; this harness's getter aliases the array, so hand it a clean one).
    disk = [diskFolder(folderPath, [diskSession('real-R', folderPath)])]
    // A duplicate/stale session:added for the already-collapsed real-R must be a
    // no-op — it must NOT absorb synth2 (the cardinal "don't lose distinct
    // sessions" guard, via bornSyntheticIds).
    handlers.sessionAdded?.({ slug: 'bogus', sessionId: 'real-R' })
    await pushAndSettle(handlers)

    expect(store.allSessions.find((s) => s.sessionId === synth2)?.synthetic).toBe(true)
    expect(allIds(store).sort()).toEqual(['real-R', synth2].sort())
  })
})

/**
 * Lesson 003 follow-up 1 — resurrection guard. A synthetic snapshotted at the
 * top of a `reloadModelOnce` scan can be removed from the model (closed,
 * collapsed, migrated) while the scan awaits disk I/O. Re-injecting its stale
 * snapshot afterwards would bring the already-removed row back. The guard only
 * re-injects synthetics still present in the live model at commit time.
 */
describe('#003 — reload resurrection guard', () => {
  function installControllableApi(getDisk: () => FolderEntry[]): {
    handlers: Record<string, ((p: unknown) => void) | undefined>
    park: () => void
    loadCount: () => number
  } {
    const handlers: Record<string, ((p: unknown) => void) | undefined> = {}
    const capture =
      (name: string) =>
      (cb: (p: unknown) => void): (() => void) => {
        handlers[name] = cb
        return () => {
          handlers[name] = undefined
        }
      }
    let parkedResolve: (() => void) | null = null
    let loadCount = 0
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        // First call (init) resolves immediately; later calls park until the
        // test releases them, so a reload can sit mid-await deterministically.
        foldersLoad: vi.fn(() => {
          loadCount++
          if (loadCount === 1) return Promise.resolve(getDisk())
          return new Promise<FolderEntry[]>((res) => {
            parkedResolve = () => res(getDisk())
          })
        }),
        userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => []),
        onProjectAdded: capture('projectAdded'),
        onProjectRemoved: capture('projectRemoved'),
        onSessionAdded: capture('sessionAdded'),
        onSessionRemoved: capture('sessionRemoved'),
        onSessionUpdated: capture('sessionUpdated'),
        onIndexUpdated: capture('indexUpdated'),
        onWatcherDegraded: capture('watcherDegraded'),
        onSubagentUpdated: capture('subagentUpdated'),
        onSubagentRemoved: capture('subagentRemoved'),
        onHook: capture('hook'),
        onScreenState: capture('screenState'),
        onSessionRegistry: capture('sessionRegistry'),
        fleetReportShellSessions: vi.fn(),
        onApprovalPending: capture('approvalPending'),
        onApprovalResolved: capture('approvalResolved'),
        approvalsList: vi.fn(async () => []),
        onNotifyActivate: capture('notifyActivate'),
        notify: vi.fn()
      }
    }
    return {
      handlers,
      park: () => parkedResolve?.(),
      loadCount: () => loadCount
    }
  }

  it('does not resurrect a synthetic closed while a reload is awaiting disk I/O', async () => {
    // A real "keeper" session keeps the folder alive across the reload, so the
    // re-injection step actually has a target to (wrongly) resurrect into.
    const disk = [diskFolder('/repo/foo', [diskSession('uuid-keep', '/repo/foo')])]
    const api = installControllableApi(() => disk)
    const store = useSessionsStore()
    await store.init()

    const synthId = store.createNewSession('/repo/foo') as string
    const fooIds = (): string[] =>
      store.folders.find((f) => f.path === '/repo/foo')?.sessions.map((s) => s.sessionId) ?? []
    expect(fooIds()).toEqual([synthId, 'uuid-keep'])

    // Kick a reload: it snapshots the synthetic, then parks on foldersLoad.
    const pReload = store.reloadModel()
    expect(api.loadCount()).toBe(2)

    // While the scan awaits disk I/O, the user closes the placeholder.
    store.closeSession(synthId)
    expect(fooIds()).toEqual(['uuid-keep'])

    // Disk I/O completes; the reload re-injects its synthetic snapshot.
    api.park()
    await pReload
    await new Promise((r) => setTimeout(r, 0))

    // Asserts on the live folder model (source of truth), NOT the lazily-cached
    // `allSessions` computed. Without the guard the stale snapshot resurrects the
    // closed row alongside the keeper; the guard drops it, keeper untouched.
    expect(fooIds()).toEqual(['uuid-keep'])
  })
})
