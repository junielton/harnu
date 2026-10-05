// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'

/**
 * `lib/platform.ts` reads `navigator.platform` once at module load, so each case
 * stubs the global and re-imports the module fresh.
 */
async function loadPlatform(
  platform: string
): Promise<typeof import('../src/renderer/src/lib/platform')> {
  vi.resetModules()
  vi.stubGlobal('navigator', { platform })
  return import('../src/renderer/src/lib/platform')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('macWindowControlsInset', () => {
  it('reserves 78px for the traffic lights on macOS', async () => {
    const { isMac, macWindowControlsInset } = await loadPlatform('MacIntel')
    expect(isMac).toBe(true)
    expect(macWindowControlsInset).toBe(78)
  })

  it('is 0 on non-macOS platforms', async () => {
    for (const p of ['Win32', 'Linux x86_64']) {
      const { isMac, macWindowControlsInset } = await loadPlatform(p)
      expect(isMac).toBe(false)
      expect(macWindowControlsInset).toBe(0)
    }
  })
})
