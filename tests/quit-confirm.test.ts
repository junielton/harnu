import { beforeEach, describe, expect, it, vi } from 'vitest'

// The electron shell of the T579 quit guard, driven against a mocked `electron` and task-state map.
const h = vi.hoisted(() => {
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const listeners = new Map<string, (...a: unknown[]) => void>()
  return {
    handlers,
    listeners,
    quit: vi.fn(),
    showMessageBox: vi.fn(),
    states: new Map<string, string>(),
    writeFile: vi.fn(async () => undefined),
    shutdownCb: { current: null as null | (() => void) }
  }
})

vi.mock('electron', () => ({
  app: { name: 'Harnu', quit: h.quit, getPath: () => '/tmp/quit-confirm-test' },
  dialog: { showMessageBox: h.showMessageBox },
  ipcMain: {
    handle: (c: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(c, fn),
    on: (c: string, fn: (...a: unknown[]) => void) => h.listeners.set(c, fn),
    removeListener: (c: string) => h.listeners.delete(c)
  },
  powerMonitor: {
    on: (_e: string, fn: () => void) => {
      h.shutdownCb.current = fn
    }
  },
  BrowserWindow: class {}
}))
vi.mock('../src/main/hook-bridge', () => ({ getTaskStates: () => h.states }))
vi.mock('node:fs', () => ({
  readFileSync: () => {
    throw new Error('ENOENT')
  },
  promises: { writeFile: h.writeFile }
}))

type Mod = typeof import('../src/main/quit-confirm')
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const evt = (): { preventDefault: ReturnType<typeof vi.fn>; defaultPrevented: boolean } => {
  const e = { defaultPrevented: false, preventDefault: vi.fn() }
  e.preventDefault.mockImplementation(() => (e.defaultPrevented = true))
  return e
}
const noWindow = (): null => null // no renderer ⇒ the fallback (short ids, English) is used at once

process.setMaxListeners(50) // each re-import of the shell registers its signal bypass

let m: Mod
beforeEach(async () => {
  vi.resetModules()
  h.handlers.clear()
  h.states.clear()
  h.quit.mockReset()
  h.showMessageBox.mockReset()
  h.writeFile.mockClear()
  m = await import('../src/main/quit-confirm')
  m.registerQuitConfirm()
})

describe('quit guard shell', () => {
  it('AC-4: lets a quit through, untouched, when nothing is working', () => {
    h.states.set('a', 'idle')
    const e = evt()
    m.guardQuit(e, noWindow)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(h.showMessageBox).not.toHaveBeenCalled()
  })

  it('AC-1: with a working session, blocks the quit and Cancel leaves everything alive', async () => {
    h.states.set('11111111-aaaa', 'working')
    h.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    const e = evt()
    m.guardQuit(e, noWindow)
    await flush()
    expect(e.preventDefault).toHaveBeenCalledOnce()
    expect(h.showMessageBox).toHaveBeenCalledOnce()
    const opts = h.showMessageBox.mock.calls[0][0]
    expect(opts.message).toBe('1 agent is still working')
    expect(opts.detail).toContain('• 11111111')
    expect(opts.buttons).toEqual(['Quit anyway', 'Cancel'])
    expect(opts.defaultId).toBe(1)
    expect(opts.cancelId).toBe(1)
    expect(h.quit).not.toHaveBeenCalled()

    // A later quit asks again — Cancel does not stick.
    h.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    m.guardQuit(evt(), noWindow)
    await flush()
    expect(h.showMessageBox).toHaveBeenCalledTimes(2)
  })

  it('AC-3: close + before-quit during one attempt show a single dialog', async () => {
    h.states.set('a', 'working')
    let resolveDialog!: (v: unknown) => void
    h.showMessageBox.mockReturnValue(new Promise((r) => (resolveDialog = r)))
    const close = evt()
    const beforeQuit = evt()
    m.guardQuit(close, noWindow)
    m.guardQuit(beforeQuit, noWindow)
    await flush()
    expect(close.preventDefault).toHaveBeenCalled()
    expect(beforeQuit.preventDefault).toHaveBeenCalled()
    expect(h.showMessageBox).toHaveBeenCalledOnce()
    resolveDialog({ response: 1, checkboxChecked: false })
    await flush()
  })

  it('AC-2: Quit anyway re-issues the quit, and everything after it passes untouched', async () => {
    h.states.set('a', 'working')
    h.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    m.guardQuit(evt(), noWindow)
    await flush()
    expect(h.quit).toHaveBeenCalledOnce()
    // The re-issued quit's close + before-quit both come back through the guard.
    const close = evt()
    const beforeQuit = evt()
    m.guardQuit(close, noWindow)
    m.guardQuit(beforeQuit, noWindow)
    expect(close.preventDefault).not.toHaveBeenCalled()
    expect(beforeQuit.preventDefault).not.toHaveBeenCalled()
    expect(h.showMessageBox).toHaveBeenCalledOnce()
  })

  it('AC-6: "Don\'t ask again" + Quit anyway persists the preference and silences later quits', async () => {
    h.states.set('a', 'working')
    h.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: true })
    m.guardQuit(evt(), noWindow)
    await flush()
    expect(h.writeFile).toHaveBeenCalledOnce()
    expect(JSON.parse(h.writeFile.mock.calls[0][1] as string)).toEqual({
      version: 1,
      confirmOnQuit: false
    })
    expect(await h.handlers.get('quit-guard:prefs')!()).toEqual({
      version: 1,
      confirmOnQuit: false
    })

    // Fresh start with the pref still off (module state reset, pref re-set through the Settings IPC).
    vi.resetModules()
    const again = await import('../src/main/quit-confirm')
    again.registerQuitConfirm()
    await h.handlers.get('quit-guard:setPrefs')!({}, { version: 1, confirmOnQuit: false })
    h.showMessageBox.mockClear()
    const e = evt()
    again.guardQuit(e, noWindow)
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(h.showMessageBox).not.toHaveBeenCalled()

    // The Settings toggle turns it back on.
    await h.handlers.get('quit-guard:setPrefs')!({}, { version: 1, confirmOnQuit: true })
    h.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    again.guardQuit(evt(), noWindow)
    await flush()
    expect(h.showMessageBox).toHaveBeenCalledOnce()
  })

  it('AC-6: ticking the checkbox but choosing Cancel does not persist anything', async () => {
    h.states.set('a', 'working')
    h.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: true })
    m.guardQuit(evt(), noWindow)
    await flush()
    expect(h.writeFile).not.toHaveBeenCalled()
  })

  it('AC-5: an updater restart or an OS shutdown signal is never blocked', async () => {
    h.states.set('a', 'working')
    m.bypassQuitConfirm('update-install')
    const e1 = evt()
    m.guardQuit(e1, noWindow)
    expect(e1.preventDefault).not.toHaveBeenCalled()

    vi.resetModules()
    const fresh = await import('../src/main/quit-confirm')
    fresh.registerQuitConfirm()
    h.shutdownCb.current!()
    const e2 = evt()
    fresh.guardQuit(e2, noWindow)
    expect(e2.preventDefault).not.toHaveBeenCalled()
    expect(h.showMessageBox).not.toHaveBeenCalled()
  })

  it('AC-5: SIGTERM bypasses the guard before the exit handler quits', () => {
    h.states.set('a', 'working')
    process.emit('SIGTERM')
    const e = evt()
    m.guardQuit(e, noWindow)
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('fails open: a dialog that throws quits instead of trapping the operator in the app', async () => {
    h.states.set('a', 'working')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    h.showMessageBox.mockRejectedValue(new Error('boom'))
    expect(() => m.guardQuit(evt(), noWindow)).not.toThrow()
    await flush()
    expect(h.quit).toHaveBeenCalledOnce()
    const e = evt()
    m.guardQuit(e, noWindow)
    expect(e.preventDefault).not.toHaveBeenCalled()
  })
})
