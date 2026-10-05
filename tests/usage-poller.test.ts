import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Poller unit tests (plan-usage-widget spec §14). The imperative shell in
 * `usage.ts` is exercised with `electron` and `node:child_process` mocked: we
 * capture the registered IPC + app handlers and drive a controllable fake
 * `claude -p "/usage"` spawn. `vi.resetModules()` + dynamic import gives each
 * test fresh module state.
 */

const FULL = `You are currently using your subscription to power your Claude Code usage

Current session: 39% used · resets Jun 10, 8:40pm (America/Sao_Paulo)
Current week (all models): 11% used · resets Jun 15, 4pm (America/Sao_Paulo)`

// Exit 0 with only the preamble — the frequent incomplete `-p` outcome.
const PREAMBLE_ONLY = 'You are currently using your subscription to power your Claude Code usage'

const h = vi.hoisted(() => ({
  execFile: vi.fn(),
  appHandlers: new Map<string, () => void>(),
  ipcHandlers: new Map<string, () => Promise<unknown>>(),
  removeListener: vi.fn()
}))

vi.mock('node:child_process', () => ({ execFile: h.execFile }))
vi.mock('electron', () => ({
  app: {
    on: (ev: string, cb: () => void) => h.appHandlers.set(ev, cb),
    removeListener: (ev: string, cb: () => void) => {
      h.removeListener(ev, cb)
      h.appHandlers.delete(ev)
    }
  },
  ipcMain: { handle: (ch: string, cb: () => Promise<unknown>) => h.ipcHandlers.set(ch, cb) },
  BrowserWindow: class {}
}))
// usage.ts now resolves the claude binary + sanitizes the spawn env (T12). In
// this test `execFile` is a no-op mock, so `resolveClaudePath` (which shells out)
// would hang — stub it to null (→ bare `claude`, preserving the asserted spawn)
// and pass the env through unchanged.
vi.mock('../src/main/claude-cli', () => ({ resolveClaudePath: vi.fn(async () => null) }))
vi.mock('../src/main/appimage-env', () => ({
  sanitizeSpawnEnv: (e: NodeJS.ProcessEnv) => e
}))

type Mod = typeof import('../src/main/usage')

let mod: Mod
let pendingCb: ((err: Error | null, stdout: string) => void) | null = null
let killSpy: ReturnType<typeof vi.fn>
const send = vi.fn()
const getWindow = (): unknown => ({ isDestroyed: () => false, webContents: { send } })

// usage.ts now `await`s resolveClaudePath() before spawning (T12), so the spawn
// starts a microtask after the handler is invoked — wait for `pendingCb` to be
// installed before firing it, instead of assuming a synchronous spawn.
async function resolveSpawn(stdout: string): Promise<void> {
  await vi.waitFor(() => {
    if (pendingCb === null) throw new Error('spawn not started yet')
  })
  const cb = pendingCb
  pendingCb = null
  cb?.(null, stdout)
}
async function failSpawn(): Promise<void> {
  await vi.waitFor(() => {
    if (pendingCb === null) throw new Error('spawn not started yet')
  })
  const cb = pendingCb
  pendingCb = null
  cb?.(new Error('spawn failed'), '')
}

beforeEach(async () => {
  vi.resetModules()
  h.appHandlers.clear()
  h.ipcHandlers.clear()
  h.removeListener.mockClear()
  send.mockClear()
  pendingCb = null
  killSpy = vi.fn()
  h.execFile.mockReset()
  h.execFile.mockImplementation(
    (_f: string, _a: string[], _o: unknown, cb: (e: Error | null, s: string) => void) => {
      pendingCb = cb
      return { kill: killSpy }
    }
  )
  mod = await import('../src/main/usage')
})

afterEach(() => {
  // Clear the poll interval + listeners created during the test.
  mod.closeUsagePoller()
})

describe('registerUsageHandlers', () => {
  it('registers usage:get / usage:refresh and focus/blur listeners', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerUsageHandlers(getWindow as any)
    expect(h.ipcHandlers.has('usage:get')).toBe(true)
    expect(h.ipcHandlers.has('usage:refresh')).toBe(true)
    expect(h.appHandlers.has('browser-window-focus')).toBe(true)
    expect(h.appHandlers.has('browser-window-blur')).toBe(true)
  })
})

describe('usage:get', () => {
  it('spawns once and returns the parsed snapshot', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerUsageHandlers(getWindow as any)
    const p = h.ipcHandlers.get('usage:get')!()
    await resolveSpawn(FULL)
    const snap = (await p) as { available: boolean; session: { usedPercent: number } }
    expect(h.execFile).toHaveBeenCalledTimes(1)
    expect(snap.available).toBe(true)
    expect(snap.session.usedPercent).toBe(39)
  })

  it('returns the cached snapshot on a second call without re-spawning', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerUsageHandlers(getWindow as any)
    const p1 = h.ipcHandlers.get('usage:get')!()
    await resolveSpawn(FULL)
    await p1
    await h.ipcHandlers.get('usage:get')!()
    expect(h.execFile).toHaveBeenCalledTimes(1)
  })
})

describe('usage:refresh', () => {
  it('always spawns and pushes usage:updated to the window', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerUsageHandlers(getWindow as any)
    const p = h.ipcHandlers.get('usage:refresh')!()
    await resolveSpawn(FULL)
    await p
    expect(send).toHaveBeenCalledWith('usage:updated', expect.objectContaining({ available: true }))
  })

  it('dedupes concurrent refreshes into a single spawn (single-flight)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerUsageHandlers(getWindow as any)
    const a = h.ipcHandlers.get('usage:refresh')!()
    const b = h.ipcHandlers.get('usage:refresh')!()
    await resolveSpawn(FULL)
    await Promise.all([a, b])
    // Single-flight: two concurrent refreshes coalesce into ONE spawn.
    expect(h.execFile).toHaveBeenCalledTimes(1)
  })

  it('keeps the last-good snapshot and flags it stale when a refresh fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerUsageHandlers(getWindow as any)
    const p1 = h.ipcHandlers.get('usage:refresh')!()
    await resolveSpawn(FULL)
    await p1
    const p2 = h.ipcHandlers.get('usage:refresh')!()
    await failSpawn()
    const snap = (await p2) as {
      available: boolean
      stale: boolean
      session: { usedPercent: number }
    }
    expect(snap.available).toBe(true)
    expect(snap.stale).toBe(true)
    expect(snap.session.usedPercent).toBe(39)
  })
})

describe('incomplete (preamble-only) polls', () => {
  // `/usage` has a cooldown: rapid retries land inside it, so we never retry.
  it('an incomplete cold poll resolves with a single spawn (no retry, not sticky)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerUsageHandlers(getWindow as any)
    const p = h.ipcHandlers.get('usage:get')!()
    await resolveSpawn(PREAMBLE_ONLY)
    const snap = (await p) as { available: boolean; status: string }
    expect(h.execFile).toHaveBeenCalledTimes(1) // one spawn, no retry storm
    expect(snap.available).toBe(false)
    expect(snap.status).toBe('unavailable') // resolves — the renderer won't pin a skeleton
  })

  it('an incomplete poll keeps the last-good snapshot (stale) once data exists', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerUsageHandlers(getWindow as any)
    const p1 = h.ipcHandlers.get('usage:get')!()
    await resolveSpawn(FULL)
    await p1
    const p2 = h.ipcHandlers.get('usage:refresh')!()
    await resolveSpawn(PREAMBLE_ONLY) // incomplete, but we already have data
    const snap = (await p2) as { available: boolean; stale: boolean }
    expect(h.execFile).toHaveBeenCalledTimes(2)
    expect(snap.available).toBe(true)
    expect(snap.stale).toBe(true)
  })
})

describe('focus gating', () => {
  it('refreshes immediately when the window gains focus', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerUsageHandlers(getWindow as any)
    h.appHandlers.get('browser-window-focus')!()
    // The spawn starts a microtask later (resolveClaudePath await, T12).
    await vi.waitFor(() => expect(h.execFile).toHaveBeenCalledTimes(1))
  })
})

describe('closeUsagePoller', () => {
  it('kills the in-flight spawn and detaches the focus/blur listeners', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod.registerUsageHandlers(getWindow as any)
    h.ipcHandlers.get('usage:refresh')!() // spawn in flight, not resolved
    // Wait for the child to actually spawn (async gap) before closing.
    await vi.waitFor(() => expect(pendingCb).not.toBeNull())
    mod.closeUsagePoller()
    expect(killSpy).toHaveBeenCalled()
    expect(h.removeListener).toHaveBeenCalledWith('browser-window-focus', expect.any(Function))
    expect(h.removeListener).toHaveBeenCalledWith('browser-window-blur', expect.any(Function))
  })
})
