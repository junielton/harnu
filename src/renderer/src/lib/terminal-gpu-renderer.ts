import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm'
import { WebglAddon } from '@xterm/addon-webgl'

/**
 * GPU (WebGL) rendering for the visible terminal (BUG-267).
 *
 * xterm's default DOM renderer rebuilds row `<span>`s on every output burst,
 * which forces 100–175 ms layouts on the renderer main thread. The WebGL
 * renderer paints to a canvas instead, so no DOM layout happens.
 *
 * Lifecycle contract (see CLAUDE.md "Terminal embedding"): every session keeps a
 * long-lived `Terminal`, but only the ATTACHED one may hold a WebGL context —
 * Chromium caps live contexts (~16) and a fleet easily exceeds that. So the
 * context is acquired on attach and released on detach. Disposing the addon
 * makes xterm fall back to its DOM renderer, which is also the failure path:
 * WebGL unavailable, context creation failing, or `onContextLoss`.
 */

/** The slice of `WebglAddon` this module relies on (keeps the logic testable). */
export interface GpuAddon extends ITerminalAddon {
  onContextLoss: (cb: () => void) => IDisposable
}

interface GpuHandle {
  addon: GpuAddon
  lossSub: IDisposable
}

/** Per-terminal slot the caller stores on its `LiveTerminal` record. */
export interface GpuRendererState {
  gpu: GpuHandle | null
}

export interface GpuRendererDeps {
  createAddon: () => GpuAddon
  log: (message: string, error?: unknown) => void
}

const defaultDeps: GpuRendererDeps = {
  createAddon: () => new WebglAddon(),
  log: (message, error) => console.warn(message, error)
}

let liveContexts = 0
let fallbackLogged = false

/** Number of WebGL contexts currently held by terminals. Test seam. */
export function liveGpuContextCount(): number {
  return liveContexts
}

/** Reset module state between tests. */
export function resetGpuRendererForTests(): void {
  liveContexts = 0
  fallbackLogged = false
}

function logFallbackOnce(deps: GpuRendererDeps, reason: string, error?: unknown): void {
  if (fallbackLogged) return
  fallbackLogged = true
  deps.log(`[terminal] WebGL renderer unavailable (${reason}); using the DOM renderer`, error)
}

/**
 * Switch `term` to the WebGL renderer. Returns true when a context is now held,
 * false when it fell back to the DOM renderer. Idempotent, never throws. `term`
 * must already be opened and attached to the document.
 *
 * `onContextLost` runs after a later context loss, once xterm is back on the DOM
 * renderer: the DOM and WebGL cells differ in size, so the caller re-fits the
 * grid there. Its errors are swallowed (it runs inside a WebGL event handler).
 */
export function acquireGpuRenderer(
  term: Pick<Terminal, 'loadAddon'>,
  state: GpuRendererState,
  deps: GpuRendererDeps = defaultDeps,
  onContextLost?: () => void
): boolean {
  if (state.gpu) return true
  let addon: GpuAddon | null = null
  try {
    addon = deps.createAddon()
    const created = addon
    const lossSub = created.onContextLoss(() => {
      releaseGpuRenderer(state)
      logFallbackOnce(deps, 'context lost')
      try {
        onContextLost?.()
      } catch {
        /* a failed re-fit must not break the event handler */
      }
    })
    state.gpu = { addon: created, lossSub }
    liveContexts++
    term.loadAddon(created)
    return true
  } catch (error) {
    releaseGpuRenderer(state)
    try {
      addon?.dispose()
    } catch {
      /* already torn down */
    }
    logFallbackOnce(deps, 'initialisation failed', error)
    return false
  }
}

/** Free the WebGL context (xterm reverts to the DOM renderer). Idempotent. */
export function releaseGpuRenderer(state: GpuRendererState): void {
  const handle = state.gpu
  if (!handle) return
  state.gpu = null
  liveContexts = Math.max(0, liveContexts - 1)
  try {
    handle.lossSub.dispose()
  } catch {
    /* ignore */
  }
  try {
    handle.addon.dispose()
  } catch {
    /* ignore */
  }
}
