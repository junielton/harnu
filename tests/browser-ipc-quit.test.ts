import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// T579: Electron runs EVERY `before-quit` listener even after one calls `preventDefault()`. So browser
// teardown registered as its own listener would release every pane when the operator presses Cancel on the
// "agents are still working" confirm. It must run from index.ts's teardown, below the guard's early return.
const h = vi.hoisted(() => ({
  appOn: vi.fn(),
  destroyAll: vi.fn()
}))

vi.mock('electron', () => ({
  app: { on: h.appOn },
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))
vi.mock('../src/main/browser/browser-service', () => ({
  bindBrowserWindow: vi.fn(),
  getPageService: () => ({ registerIpc: vi.fn() }),
  getBrowserHost: () => ({ destroyAll: h.destroyAll }),
  browserAccess: {},
  browserLeases: {},
  browserRegistry: {},
  closePaneFromOperator: vi.fn(),
  getOverlayBridge: () => ({ registerIpc: vi.fn() }),
  openOperatorPane: vi.fn()
}))

beforeEach(() => {
  h.appOn.mockClear()
  h.destroyAll.mockClear()
})

describe('browser teardown vs the quit guard', () => {
  it('registerBrowserIpc does not hook before-quit itself (it would run even when the guard cancels)', async () => {
    const { registerBrowserIpc } = await import('../src/main/browser/browser-ipc')
    registerBrowserIpc(() => null)
    expect(h.appOn.mock.calls.map((c) => c[0])).not.toContain('before-quit')
    expect(h.destroyAll).not.toHaveBeenCalled()
  })

  it('closeBrowserIpc releases every pane', async () => {
    const { registerBrowserIpc, closeBrowserIpc } = await import('../src/main/browser/browser-ipc')
    registerBrowserIpc(() => null)
    closeBrowserIpc()
    expect(h.destroyAll).toHaveBeenCalledOnce()
  })

  it('index.ts tears the panes down only after the guard has let the quit through', () => {
    const src = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
    const start = src.indexOf("app.on('before-quit'")
    const handler = src.slice(start, src.indexOf("app.on('window-all-closed'", start))
    const guard = handler.indexOf('if (event.defaultPrevented) return')
    const teardown = handler.indexOf('closeBrowserIpc()')
    expect(guard).toBeGreaterThan(-1)
    expect(teardown).toBeGreaterThan(guard)
  })
})
