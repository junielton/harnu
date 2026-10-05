/**
 * T212 §F — the invariant `roadmap:peek` exists to protect.
 *
 * There is exactly ONE roadmap watcher and it follows its last caller. `roadmapLoad`
 * calls `watcher.retarget(...)`; if `roadmap:peek` ever did the same, opening one
 * folder's view would silently steal the watcher backing another repo's OPEN board,
 * and that board would stop receiving live card updates with no visible error.
 *
 * This asserts the property structurally: register the real handlers against a mock
 * `ipcMain` and a spy watcher, invoke `roadmap:peek`, and prove `retarget` was never
 * touched — while `roadmap:load` (the control) does touch it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => {
  const handlers = new Map<string, (e: unknown, args: unknown) => unknown>()
  const retarget = vi.fn(async () => [])
  const scanRoadmapDir = vi.fn(async () => [])
  return { handlers, retarget, scanRoadmapDir }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, args: unknown) => unknown) => {
      hoisted.handlers.set(channel, fn)
    },
    on: () => {}
  },
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/tmp' }
}))

vi.mock('../src/main/roadmap-watcher', () => ({
  createRoadmapWatcher: () => ({
    retarget: hoisted.retarget,
    currentKey: () => null,
    close: async () => {}
  }),
  scanRoadmapDir: hoisted.scanRoadmapDir
}))

vi.mock('../src/main/routing-policy', () => ({ registerRoutingPolicyHandlers: () => {} }))

import { registerRoadmapHandlers } from '../src/main/roadmap-ipc'

beforeEach(() => {
  hoisted.handlers.clear()
  hoisted.retarget.mockClear()
  hoisted.scanRoadmapDir.mockClear()
  registerRoadmapHandlers(() => null)
})

describe('roadmap:peek never moves the watcher', () => {
  it('reads through scanRoadmapDir and leaves retarget untouched', async () => {
    const peek = hoisted.handlers.get('roadmap:peek')
    expect(peek, 'roadmap:peek must be registered').toBeTypeOf('function')

    const out = (await peek!({}, { folder: '/repo/beta' })) as { counts: Record<string, number> }

    expect(hoisted.retarget).not.toHaveBeenCalled()
    expect(hoisted.scanRoadmapDir).toHaveBeenCalledTimes(1)
    expect(out.counts.backlog).toBe(0)
  })

  it('control: roadmap:load DOES retarget, so the assertion above is meaningful', async () => {
    const load = hoisted.handlers.get('roadmap:load')
    expect(load, 'roadmap:load must be registered').toBeTypeOf('function')

    await load!({}, { folder: '/repo/alpha' })

    expect(hoisted.retarget).toHaveBeenCalledTimes(1)
  })
})
