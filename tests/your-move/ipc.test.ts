/**
 * The caller of the store (`src/main/your-move/ipc.ts`): a store that cannot be opened must
 * leave Your move inactive, never crash app boot and never end in an unhandled rejection.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

const h = vi.hoisted(() => ({
  userData: '',
  observed: 0,
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userData,
    getAppPath: (): string => h.userData
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>): void => {
      h.handlers.set(channel, fn)
    }
  },
  BrowserWindow: class {}
}))
vi.mock('../../src/main/mission-ipc', () => ({
  setMissionListObserver: (fn: unknown): void => {
    if (fn) h.observed++
  }
}))
vi.mock('../../src/main/pty', () => ({
  setPtyExitObserver: (fn: unknown): void => {
    if (fn) h.observed++
  }
}))
vi.mock('../../src/main/detect/task-state-hub', () => ({
  getTaskStates: () => new Map(),
  addTaskEventObserver: (): (() => void) => {
    h.observed++
    return () => undefined
  }
}))
vi.mock('../../src/main/claude-watcher', () => ({ classifyTranscriptLines: () => null }))
vi.mock('../../src/main/claude-cli', () => ({ resolveClaudePath: async () => null }))
vi.mock('../../src/main/user-projects', () => ({
  readUserProjects: async () => ({ version: 1, projects: [] }),
  onFolderRemoved: (): (() => void) => {
    h.observed++
    return () => undefined
  }
}))
vi.mock('../../src/main/your-move/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/your-move/store')>()),
  openYourMoveStore: async () => {
    throw new Error('EACCES: permission denied, open your-move.json')
  }
}))

// The first import transforms the whole main-process graph, which can outlast a test's timeout.
beforeAll(async () => {
  await import('../../src/main/your-move/ipc')
}, 60_000)

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-ipc-'))
  h.userData = dir
  h.handlers.clear()
  h.observed = 0
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('registerYourMove with a store that cannot open', () => {
  it('a store that fails to open does not stop the app from starting', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { registerYourMove, closeYourMove } = await import('../../src/main/your-move/ipc')
    expect(() => registerYourMove(() => null)).not.toThrow()
    const call = async (channel: string, ...args: unknown[]) =>
      h.handlers.get(channel)?.({}, ...args)

    // every channel still answers, and the feature reads as inactive
    expect(await call('yourMove:list')).toEqual([])
    expect(await call('yourMove:prefs:get')).toMatchObject({ mode: 'off' })
    expect(await call('yourMove:prefs:set', { mode: 'observe' })).toMatchObject({ mode: 'off' })
    expect(
      await call('yourMove:inspectNow', { sessionId: 'abcdef12-0000', folder: '/f' })
    ).toMatchObject({
      outcome: 'skipped'
    })
    // an exit has nothing to close: it answers, never throws
    expect(await call('yourMove:exit', { cardId: 'c1', label: 'not-for-me' })).toEqual({
      ok: false,
      reason: 'unavailable'
    })
    // and the failure was logged, with its reason
    expect(error.mock.calls.flat().join(' ')).toContain('EACCES')
    closeYourMove()
  })

  it('wires no observer and starts no source when the store is unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { registerYourMove, closeYourMove } = await import('../../src/main/your-move/ipc')
    registerYourMove(() => null)
    await h.handlers.get('yourMove:list')?.({})
    await new Promise((r) => setTimeout(r, 20))
    expect(h.observed).toBe(0)
    expect(() => closeYourMove()).not.toThrow()
  })
})
