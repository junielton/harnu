import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventEmitter } from 'node:events'

/**
 * Production wiring of the worktree tracker (T388, sidebar-liveness U4b): the
 * real `fs` deps the tracker's focus fallback depends on, and the
 * `worktrees:track` / `worktrees:changed` IPC pair. `electron`, git and path
 * canonicalization are doubled; `fs.watch`/`fs.promises.stat` are real.
 */

const h = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  appListeners: new Map<string, Set<(...a: unknown[]) => void>>(),
  listWorktrees: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    on: (ev: string, cb: (...a: unknown[]) => void) => {
      if (!h.appListeners.has(ev)) h.appListeners.set(ev, new Set())
      h.appListeners.get(ev)!.add(cb)
    },
    off: (ev: string, cb: (...a: unknown[]) => void) => h.appListeners.get(ev)?.delete(cb)
  },
  ipcMain: {
    handle: (channel: string, cb: (...args: unknown[]) => unknown) => h.ipcHandlers.set(channel, cb)
  }
}))
vi.mock('../src/main/worktree-ipc', () => ({ listWorktrees: h.listWorktrees }))
vi.mock('../src/main/user-projects', () => ({ normalizePath: async (p: string) => p }))

type Mod = typeof import('../src/main/worktree-tracker-wiring')
let mod: Mod
let dir: string

beforeEach(async () => {
  h.ipcHandlers.clear()
  h.appListeners.clear()
  h.listWorktrees.mockReset()
  mod = await import('../src/main/worktree-tracker-wiring')
  dir = mkdtempSync(join(tmpdir(), 'wt-wiring-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('productionWorktreeTrackerDeps', () => {
  it("registers onError as the watcher's 'error' listener (no unhandled throw)", () => {
    const deps = mod.productionWorktreeTrackerDeps()
    const onError = vi.fn()
    const w = deps.watch(dir, () => {}, onError) as unknown as EventEmitter & { close(): void }
    const err = Object.assign(new Error('watch failed'), { code: 'ENOSPC' })
    expect(() => w.emit('error', err)).not.toThrow()
    expect(onError).toHaveBeenCalledWith(err)
    w.close()
  })

  it('throws ENOENT synchronously for a missing dir (the tracker treats it as "not created yet")', () => {
    const deps = mod.productionWorktreeTrackerDeps()
    let code: string | undefined
    try {
      deps
        .watch(
          join(dir, 'missing'),
          () => {},
          () => {}
        )
        .close()
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code
    }
    expect(code).toBe('ENOENT')
  })

  it('stat reports mtimeMs for an existing dir and null for a missing one', async () => {
    const deps = mod.productionWorktreeTrackerDeps()
    expect(typeof (await deps.stat(dir))?.mtimeMs).toBe('number')
    expect(await deps.stat(join(dir, 'missing'))).toBeNull()
  })

  it('onFocus subscribes to browser-window-focus and unsubscribes', () => {
    const deps = mod.productionWorktreeTrackerDeps()
    const cb = vi.fn()
    const off = deps.onFocus(cb)
    expect(h.appListeners.get('browser-window-focus')?.has(cb)).toBe(true)
    off()
    expect(h.appListeners.get('browser-window-focus')?.has(cb)).toBe(false)
  })
})

describe('registerWorktreeTracker', () => {
  it('worktrees:track lists a repo and pushes worktrees:changed to the window', async () => {
    h.listWorktrees.mockResolvedValue([
      { path: '/r', head: 'a', branch: 'main', bare: false, detached: false },
      { path: '/r/wt', head: 'b', branch: 'feat', bare: false, detached: false }
    ])
    const send = vi.fn()
    const close = mod.registerWorktreeTracker(() => ({
      isDestroyed: () => false,
      webContents: { send }
    }))
    const handler = h.ipcHandlers.get('worktrees:track')!
    await handler({}, [{ repoId: join(dir, '.git'), probePath: '/r', memberPaths: ['/r'] }])
    await vi.waitFor(() => expect(send).toHaveBeenCalled())
    expect(h.listWorktrees).toHaveBeenCalledWith('/r')
    expect(send).toHaveBeenCalledWith('worktrees:changed', {
      repoId: join(dir, '.git'),
      entries: [
        { path: '/r', branch: 'main', isMainWorktree: true, locked: false },
        { path: '/r/wt', branch: 'feat', isMainWorktree: false, locked: false }
      ]
    })
    close()
  })

  it('a malformed track payload is treated as an empty set', async () => {
    const close = mod.registerWorktreeTracker(() => null)
    const handler = h.ipcHandlers.get('worktrees:track')!
    await expect(Promise.resolve(handler({}, 'nope'))).resolves.toBeUndefined()
    expect(h.listWorktrees).not.toHaveBeenCalled()
    close()
  })
})
