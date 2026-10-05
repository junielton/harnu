import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { reactive, isReactive } from 'vue'
import { useClaudeBootStore } from '../src/renderer/src/stores/claudeBoot'

/**
 * Regression net for the silent-save bug: the form/store hold the config in Pinia
 * refs, so a raw read is a Vue reactive Proxy. Passing that straight to the
 * persistence IPC makes Electron's structured clone throw ("An object could not
 * be cloned") and the save silently no-ops — which left `claude-boot.json` empty,
 * so `getResolved` (disk) returned `{}` and a new session inherited nothing. The
 * store must hand the IPC a PLAIN, cloneable object.
 */

let setGlobalSpy: ReturnType<typeof vi.fn>
let setFolderSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  setGlobalSpy = vi.fn(async () => ({}))
  setFolderSpy = vi.fn(async () => ({}))
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      claudeConfigSetGlobal: setGlobalSpy,
      claudeConfigSetFolder: setFolderSpy
    }
  }
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('claudeBoot store — saves are IPC-cloneable', () => {
  it('setGlobal sends a plain (non-reactive) object the IPC can clone', () => {
    const store = useClaudeBootStore()
    // Simulate the form emitting a reactive config (as it does from Pinia state).
    store.setGlobal(reactive({ model: 'opus', addDirs: ['/x'] }))
    vi.advanceTimersByTime(250) // flush the 200ms debounce

    expect(setGlobalSpy).toHaveBeenCalledTimes(1)
    const sent = setGlobalSpy.mock.calls[0][0]
    expect(isReactive(sent)).toBe(false)
    expect(() => structuredClone(sent)).not.toThrow()
    expect(sent).toEqual({ model: 'opus', addDirs: ['/x'] })
  })

  it('saveFolder sends a plain (non-reactive) object the IPC can clone', async () => {
    const store = useClaudeBootStore()
    await store.saveFolder('/repo/x', reactive({ effort: 'high' }))

    expect(setFolderSpy).toHaveBeenCalledTimes(1)
    const [path, sent] = setFolderSpy.mock.calls[0]
    expect(path).toBe('/repo/x')
    expect(isReactive(sent)).toBe(false)
    expect(() => structuredClone(sent)).not.toThrow()
    expect(sent).toEqual({ effort: 'high' })
  })
})
