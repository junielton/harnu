// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { FolderEntry } from '../src/preload'

/**
 * T661 — the renderer half of `hide_folder`: the store mirrors `hiddenPaths` from main's
 * `userProjects:hiddenChanged` push (a change the verb made outside the store's own calls),
 * and the menu's hide / unhide actions keep working from their own IPC responses.
 */

function session(id: string, projectPath: string) {
  return {
    sessionId: id,
    summary: id,
    firstPrompt: '',
    modified: '2026-10-20T10:00:00.000Z',
    status: 'idle',
    taskState: 'idle',
    projectPath,
    fullPath: `/home/u/.claude/projects/x/${id}.jsonl`,
    resumable: true
  }
}

const DISK = [
  {
    path: '/repos/alpha',
    alias: 'alpha',
    gitBranch: 'main',
    sessions: [session('s-1', '/repos/alpha')]
  },
  {
    path: '/repos/beta',
    alias: 'beta',
    gitBranch: 'main',
    sessions: [session('s-2', '/repos/beta')]
  }
] as unknown as FolderEntry[]

interface Mocks {
  foldersLoad: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  unhide: ReturnType<typeof vi.fn>
  push: (hiddenPaths: string[]) => void
}

function installWindow(initialHidden: string[]): Mocks {
  let pushCb: ((p: { hiddenPaths: string[] }) => void) | null = null
  let onDisk = [...initialHidden]
  const noop =
    () =>
    (_cb: (...a: unknown[]) => void): (() => void) =>
    () => {}
  const foldersLoad = vi.fn(async () => DISK)
  const hide = vi.fn(async (p: string) => {
    onDisk = [...new Set([...onDisk, p])]
    return { projects: [], hiddenPaths: onDisk }
  })
  const unhide = vi.fn(async (p: string) => {
    onDisk = onDisk.filter((x) => x !== p)
    return { projects: [], hiddenPaths: onDisk }
  })
  ;(window as unknown as { api: unknown }).api = {
    foldersLoad,
    userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: onDisk })),
    userProjectsHide: hide,
    userProjectsUnhide: unhide,
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
    sessionArchiveGet: vi.fn(async () => ({ ids: [], legacyImported: true })),
    sessionArchiveSet: vi.fn(async () => ({ ok: true })),
    onSessionArchiveChanged: noop(),
    onUserProjectsHiddenChanged: (cb: (p: { hiddenPaths: string[] }) => void) => {
      pushCb = cb
      return () => {
        pushCb = null
      }
    }
  }
  return {
    foldersLoad,
    hide,
    unhide,
    push: (hiddenPaths) => {
      onDisk = [...hiddenPaths]
      pushCb?.({ hiddenPaths })
    }
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('hidden folders through main’s push', () => {
  it('follows the push: a verb hide mirrors the path and reloads the model, a verb show mirrors it away', async () => {
    const mocks = installWindow([])
    const store = useSessionsStore()
    await store.init()
    const loadsAtInit = mocks.foldersLoad.mock.calls.length

    mocks.push(['/repos/alpha'])
    expect(store.manuallyHiddenPaths.has('/repos/alpha')).toBe(true)
    expect(store.manuallyHiddenPaths.has('/repos/beta')).toBe(false)
    await vi.waitFor(() => expect(mocks.foldersLoad.mock.calls.length).toBeGreaterThan(loadsAtInit))

    mocks.push([])
    expect(store.manuallyHiddenPaths.size).toBe(0)
  })

  it('a push that changes nothing does not reload the model', async () => {
    const mocks = installWindow(['/repos/alpha'])
    const store = useSessionsStore()
    await store.init()
    const loads = mocks.foldersLoad.mock.calls.length

    mocks.push(['/repos/alpha'])
    await Promise.resolve()
    expect(store.manuallyHiddenPaths.has('/repos/alpha')).toBe(true)
    expect(mocks.foldersLoad.mock.calls.length).toBe(loads)
  })

  it('menu action: dismiss and unhide still mirror the IPC response, exactly as before', async () => {
    const mocks = installWindow([])
    const store = useSessionsStore()
    await store.init()

    await store.dismissFolder('/repos/beta')
    expect(mocks.hide).toHaveBeenCalledWith('/repos/beta')
    expect(store.manuallyHiddenPaths.has('/repos/beta')).toBe(true)

    await store.unhideFolder('/repos/beta')
    expect(mocks.unhide).toHaveBeenCalledWith('/repos/beta')
    expect(store.manuallyHiddenPaths.has('/repos/beta')).toBe(false)
  })

  it('without the new preload API (older preload, other tests) init and the menu actions still work', async () => {
    const mocks = installWindow([])
    delete (window as unknown as { api: Record<string, unknown> }).api.onUserProjectsHiddenChanged
    const store = useSessionsStore()
    await store.init()
    await store.dismissFolder('/repos/alpha')
    expect(mocks.hide).toHaveBeenCalled()
    expect(store.manuallyHiddenPaths.has('/repos/alpha')).toBe(true)
  })
})
