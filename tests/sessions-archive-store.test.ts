// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { FolderEntry } from '../src/preload'

/**
 * T655 — the renderer half of the main-owned archive: the store hydrates `archivedIds`
 * from main, imports the old `localStorage` ids once (leaving the key alone), writes menu
 * actions through main, and follows main's push when the `archive_session` verb changes
 * the set. The menu behaviour itself (archive keeps the row, "Show N archived" counts it,
 * unarchive brings it back) is unchanged.
 */

const LEGACY_KEY = 'om2tab.archivedSessions'

function session(id: string) {
  return {
    sessionId: id,
    summary: id,
    firstPrompt: '',
    modified: '2026-10-20T10:00:00.000Z',
    status: 'idle',
    taskState: 'idle',
    projectPath: '/repos/alpha',
    fullPath: `/home/u/.claude/projects/x/${id}.jsonl`,
    resumable: true
  }
}

const DISK = [
  {
    path: '/repos/alpha',
    alias: 'alpha',
    gitBranch: 'main',
    sessions: [session('s-1'), session('s-2'), session('s-3')]
  }
] as unknown as FolderEntry[]

interface Mocks {
  get: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
  importLegacy: ReturnType<typeof vi.fn>
  push: (ids: string[]) => void
}

function installWindow(main: { ids: string[]; legacyImported: boolean }): Mocks {
  let pushCb: ((p: { ids: string[] }) => void) | null = null
  const noop =
    () =>
    (_cb: (...a: unknown[]) => void): (() => void) =>
    () => {}
  const get = vi.fn(async () => ({ ids: [...main.ids], legacyImported: main.legacyImported }))
  const set = vi.fn(async () => ({ ok: true }))
  const importLegacy = vi.fn(async (ids: string[]) => {
    main.ids = [...new Set([...main.ids, ...ids])]
    main.legacyImported = true
    return { ok: true, imported: true, ids: main.ids }
  })
  ;(window as unknown as { api: unknown }).api = {
    foldersLoad: vi.fn(async () => DISK),
    userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
    orchestratorListArmed: vi.fn(async () => []),
    onProjectAdded: noop(),
    onProjectRemoved: noop(),
    onSessionAdded: noop(),
    onSessionRemoved: noop(),
    onSessionUpdated: noop(),
    onSessionRegistry: noop(),
    onHook: noop(),
    onScreenState: noop(),
    fleetReportShellSessions: vi.fn(),
    onApprovalPending: noop(),
    onApprovalResolved: noop(),
    approvalsList: vi.fn(async () => []),
    onNotifyActivate: noop(),
    onIndexUpdated: noop(),
    onWatcherDegraded: noop(),
    onSubagentUpdated: noop(),
    onSubagentRemoved: noop(),
    notify: vi.fn(),
    pushSend: vi.fn(),
    sessionArchiveGet: get,
    sessionArchiveSet: set,
    sessionArchiveImportLegacy: importLegacy,
    onSessionArchiveChanged: (cb: (p: { ids: string[] }) => void) => {
      pushCb = cb
      return () => {
        pushCb = null
      }
    }
  }
  return { get, set, importLegacy, push: (ids) => pushCb?.({ ids }) }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('archived sessions through the main-owned store', () => {
  it('hydrates the archived set from main at init', async () => {
    installWindow({ ids: ['s-2'], legacyImported: true })
    const store = useSessionsStore()
    await store.init()
    expect(store.isArchived('s-2')).toBe(true)
    expect(store.isArchived('s-1')).toBe(false)
  })

  it('migrates the old localStorage ids once and leaves the key untouched', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(['s-1', 's-3']))
    const mocks = installWindow({ ids: [], legacyImported: false })
    const store = useSessionsStore()
    await store.init()

    expect(mocks.importLegacy).toHaveBeenCalledTimes(1)
    expect(mocks.importLegacy).toHaveBeenCalledWith(['s-1', 's-3'])
    expect(store.isArchived('s-1')).toBe(true)
    expect(store.isArchived('s-3')).toBe(true)
    expect(localStorage.getItem(LEGACY_KEY)).toBe(JSON.stringify(['s-1', 's-3']))
  })

  it('does not send the legacy ids again once main has taken them', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(['s-1']))
    const mocks = installWindow({ ids: ['s-3'], legacyImported: true })
    const store = useSessionsStore()
    await store.init()

    expect(mocks.importLegacy).not.toHaveBeenCalled()
    expect(store.isArchived('s-3')).toBe(true)
    expect(store.isArchived('s-1')).toBe(false)
  })

  it('menu action: archive keeps the row, counts it under "Show N archived", and writes through main', async () => {
    const mocks = installWindow({ ids: [], legacyImported: true })
    const store = useSessionsStore()
    await store.init()
    const folder = store.folders[0]!

    store.archiveSession('s-1')
    expect(store.isArchived('s-1')).toBe(true)
    expect(mocks.set).toHaveBeenLastCalledWith(['s-1'], true)
    expect(folder.sessions.map((s) => s.sessionId)).toContain('s-1') // the row stays
    expect(store.archivedSessionCount(folder)).toBe(1)

    store.unarchiveSession('s-1')
    expect(store.isArchived('s-1')).toBe(false)
    expect(mocks.set).toHaveBeenLastCalledWith(['s-1'], false)
    expect(store.archivedSessionCount(folder)).toBe(0)
  })

  it('menu action: archiving twice or restoring an active session writes nothing', async () => {
    const mocks = installWindow({ ids: ['s-1'], legacyImported: true })
    const store = useSessionsStore()
    await store.init()

    store.archiveSession('s-1')
    store.unarchiveSession('s-2')
    expect(mocks.set).not.toHaveBeenCalled()
  })

  it('follows main live: a verb archive deselects the session, a verb restore brings it back', async () => {
    const mocks = installWindow({ ids: [], legacyImported: true })
    const store = useSessionsStore()
    await store.init()
    store.selectedId = 's-1'

    mocks.push(['s-1', 's-3'])
    expect(store.isArchived('s-1')).toBe(true)
    expect(store.isArchived('s-3')).toBe(true)
    expect(store.selectedId).toBeNull() // same put-away as the menu action

    mocks.push(['s-3'])
    expect(store.isArchived('s-1')).toBe(false)
    expect(store.isArchived('s-3')).toBe(true)
  })

  it('archived sessions stay out of the attention (needs-input) count as before', async () => {
    const mocks = installWindow({ ids: [], legacyImported: true })
    const store = useSessionsStore()
    await store.init()
    store.applyTaskState('s-1', 'needs-input')
    expect(store.attentionCount).toBe(1)

    mocks.push(['s-1']) // the verb archives it
    expect(store.attentionCount).toBe(0)

    mocks.push([]) // and restores it
    expect(store.attentionCount).toBe(1)
  })

  it('without the new preload API (older preload, other tests) the menu action still works locally', async () => {
    installWindow({ ids: [], legacyImported: true })
    const api = (window as unknown as { api: Record<string, unknown> }).api
    delete api.sessionArchiveGet
    delete api.sessionArchiveSet
    delete api.onSessionArchiveChanged
    const store = useSessionsStore()
    await store.init()
    store.archiveSession('s-2')
    expect(store.isArchived('s-2')).toBe(true)
  })
})
