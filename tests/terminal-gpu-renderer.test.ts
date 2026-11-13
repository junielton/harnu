import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  acquireGpuRenderer,
  releaseGpuRenderer,
  liveGpuContextCount,
  resetGpuRendererForTests,
  type GpuAddon,
  type GpuRendererDeps,
  type GpuRendererState
} from '../src/renderer/src/lib/terminal-gpu-renderer'

/**
 * BUG-267 — the visible terminal renders through WebGL (no DOM layout per output
 * burst). The context is acquired on attach and released on detach so that N
 * cached sessions never exhaust the browser's WebGL context limit, and any
 * failure falls back to xterm's DOM renderer.
 */

interface FakeAddon extends GpuAddon {
  disposed: boolean
  fireContextLoss: () => void
}

function fakeAddon(): FakeAddon {
  let lossCb: (() => void) | null = null
  const a: FakeAddon = {
    disposed: false,
    activate: vi.fn(),
    dispose() {
      a.disposed = true
    },
    onContextLoss(cb) {
      lossCb = cb
      return { dispose: () => (lossCb = null) }
    },
    fireContextLoss() {
      lossCb?.()
    }
  }
  return a
}

function setup(opts: { loadThrows?: boolean; createThrows?: boolean } = {}) {
  const created: FakeAddon[] = []
  const log = vi.fn()
  const deps: GpuRendererDeps = {
    createAddon: () => {
      if (opts.createThrows) throw new Error('WebGL2 unavailable')
      const a = fakeAddon()
      created.push(a)
      return a
    },
    log
  }
  const term = {
    loadAddon: vi.fn(() => {
      if (opts.loadThrows) throw new Error('context creation failed')
    })
  }
  const state: GpuRendererState = { gpu: null }
  return { created, log, deps, term, state }
}

beforeEach(() => resetGpuRendererForTests())

describe('terminal GPU renderer', () => {
  it('loads the WebGL addon on acquire and reports success', () => {
    const { deps, term, state, created } = setup()
    expect(acquireGpuRenderer(term, state, deps)).toBe(true)
    expect(term.loadAddon).toHaveBeenCalledWith(created[0])
    expect(liveGpuContextCount()).toBe(1)
  })

  it('is idempotent: a second acquire on the same terminal does not open a second context', () => {
    const { deps, term, state, created } = setup()
    acquireGpuRenderer(term, state, deps)
    acquireGpuRenderer(term, state, deps)
    expect(created).toHaveLength(1)
    expect(liveGpuContextCount()).toBe(1)
  })

  it('release disposes the addon and frees the context; releasing twice is safe', () => {
    const { deps, term, state, created } = setup()
    acquireGpuRenderer(term, state, deps)
    releaseGpuRenderer(state)
    releaseGpuRenderer(state)
    expect(created[0].disposed).toBe(true)
    expect(liveGpuContextCount()).toBe(0)
  })

  it('AC-2: N attach/detach cycles over many sessions keep at most one live context', () => {
    const peaks: number[] = []
    const sessions = Array.from({ length: 20 }, () => setup())
    for (let cycle = 0; cycle < 5; cycle++) {
      for (const s of sessions) {
        acquireGpuRenderer(s.term, s.state, s.deps) // attach
        peaks.push(liveGpuContextCount())
        releaseGpuRenderer(s.state) // detach (selection moves on)
      }
    }
    expect(Math.max(...peaks)).toBe(1)
    expect(liveGpuContextCount()).toBe(0)
  })

  it('AC-1: context loss disposes the addon (xterm reverts to DOM) and logs the fallback once', () => {
    const { deps, term, state, created, log } = setup()
    acquireGpuRenderer(term, state, deps)
    created[0].fireContextLoss()
    expect(created[0].disposed).toBe(true)
    expect(state.gpu).toBeNull()
    expect(liveGpuContextCount()).toBe(0)

    // Re-attach tries again; a second loss must not log again.
    acquireGpuRenderer(term, state, deps)
    created[1].fireContextLoss()
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('AC-1: context loss tells the caller once the DOM renderer is back, so it can re-fit the grid', () => {
    const { deps, term, state, created } = setup()
    let heldWhenCalled: unknown = 'unset'
    const onContextLost = vi.fn(() => {
      heldWhenCalled = state.gpu
    })
    acquireGpuRenderer(term, state, deps, onContextLost)
    expect(onContextLost).not.toHaveBeenCalled()
    created[0].fireContextLoss()
    expect(onContextLost).toHaveBeenCalledTimes(1)
    expect(heldWhenCalled).toBeNull()
  })

  it('a throwing onContextLost callback never escapes the context-loss event', () => {
    const { deps, term, state, created } = setup()
    acquireGpuRenderer(term, state, deps, () => {
      throw new Error('refit failed')
    })
    expect(() => created[0].fireContextLoss()).not.toThrow()
    expect(state.gpu).toBeNull()
  })

  it('AC-1: WebGL unavailable (createAddon throws) falls back without throwing, logged once', () => {
    const { deps, term, state, log } = setup({ createThrows: true })
    expect(acquireGpuRenderer(term, state, deps)).toBe(false)
    expect(acquireGpuRenderer(term, state, deps)).toBe(false)
    expect(state.gpu).toBeNull()
    expect(liveGpuContextCount()).toBe(0)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('AC-1: loadAddon throwing disposes the half-built addon and falls back', () => {
    const { deps, term, state, created, log } = setup({ loadThrows: true })
    expect(acquireGpuRenderer(term, state, deps)).toBe(false)
    expect(created[0].disposed).toBe(true)
    expect(liveGpuContextCount()).toBe(0)
    expect(log).toHaveBeenCalledTimes(1)
  })
})
