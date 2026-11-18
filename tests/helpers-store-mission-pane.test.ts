// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { ipcFn } from './helpers/ipc-clone'

/**
 * Mission dropdown S-8 (AC-23): the Mission pane is gone, but a `helpers.json` written by an older build can still
 * hold one. The renderer hydrates through an explicit list of retired pane types, so such a file loads without
 * the pane (no error, no blank cell, no console warning), the other panes keep their order and their ratios are
 * renormalised to sum to 1, and the next write leaves no `mission` pane on disk. The main-side read stays untyped.
 */

const WT = '/repo/alpha'

type SavedPane = { id: string; type: string; cwd: string; ratio: number; [k: string]: unknown }
type Saved = { splitVisible: boolean; splitRatio: number; panes: SavedPane[] }

let helpersSet: ReturnType<typeof ipcFn>
let saved: Saved

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  helpersSet = ipcFn(async () => undefined)
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      helpersGet: vi.fn(async () => saved),
      helpersSet
    },
    { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => () => {}) }
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const pane = (id: string, type: string, ratio: number): SavedPane => ({
  id,
  type,
  cwd: WT,
  ratio,
  ...(type === 'markdown' ? { filePath: '/repo/alpha/README.md' } : {})
})

function watchConsole(): Array<ReturnType<typeof vi.spyOn>> {
  return [
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  ]
}

describe('a helpers.json that holds a retired Mission pane', () => {
  it('drops a saved mission pane', async () => {
    saved = {
      splitVisible: true,
      splitRatio: 0.6,
      panes: [pane('h-a', 'shell', 0.5), pane('h-m', 'mission', 0.3), pane('h-b', 'markdown', 0.2)]
    }
    const spies = watchConsole()
    const helpers = useHelpersStore()
    await helpers.ensureLoaded(WT)

    const loaded = helpers.byWorktree.get(WT)!
    expect(loaded.panes.map((p) => p.id)).toEqual(['h-a', 'h-b'])
    await helpers.flushNow()

    const written = helpersSet.mock.calls.at(-1)![0] as { state: Saved }
    expect(written.state.panes.map((p) => p.id)).toEqual(['h-a', 'h-b'])
    expect(written.state.panes.some((p) => p.type === 'mission')).toBe(false)
    const sum = written.state.panes.reduce((n, p) => n + p.ratio, 0)
    expect(sum).toBeCloseTo(1, 10)
    // proportional: 0.5 : 0.2 → 5/7 : 2/7
    expect(written.state.panes[0].ratio).toBeCloseTo(5 / 7, 10)
    expect(written.state.panes[1].ratio).toBeCloseTo(2 / 7, 10)
    expect(written.state.splitVisible).toBe(true)
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })

  it('shows the stack empty, not split, when the mission pane was the only one', async () => {
    saved = { splitVisible: true, splitRatio: 0.6, panes: [pane('h-m', 'mission', 1)] }
    const spies = watchConsole()
    const helpers = useHelpersStore()
    await helpers.ensureLoaded(WT)
    await helpers.flushNow()

    const written = helpersSet.mock.calls.at(-1)![0] as { state: Saved }
    expect(written.state.panes).toEqual([])
    expect(written.state.splitVisible).toBe(false)
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })

  it('leaves a file with no mission pane exactly as it was', async () => {
    saved = {
      splitVisible: true,
      splitRatio: 0.6,
      panes: [pane('h-a', 'shell', 0.25), pane('h-b', 'markdown', 0.75)]
    }
    const helpers = useHelpersStore()
    await helpers.ensureLoaded(WT)
    await helpers.flushNow()

    const written = helpersSet.mock.calls.at(-1)![0] as { state: Saved }
    expect(written.state.panes.map((p) => [p.id, p.ratio])).toEqual([
      ['h-a', 0.25],
      ['h-b', 0.75]
    ])
  })

  it('also drops it when a live pane was added while the saved state was being read', async () => {
    saved = {
      splitVisible: true,
      splitRatio: 0.6,
      panes: [pane('h-m', 'mission', 0.5), pane('h-a', 'shell', 0.5)]
    }
    const helpers = useHelpersStore()
    helpers.addShellHelper(WT, WT)
    await helpers.ensureLoaded(WT)
    await helpers.flushNow()

    const written = helpersSet.mock.calls.at(-1)![0] as { state: Saved }
    expect(written.state.panes.some((p) => p.type === 'mission')).toBe(false)
    expect(written.state.panes).toHaveLength(2)
    expect(written.state.panes.reduce((n, p) => n + p.ratio, 0)).toBeCloseTo(1, 10)
  })

  it('keeps the main-side read untyped: an unknown type is not this list’s business', async () => {
    saved = {
      splitVisible: true,
      splitRatio: 0.6,
      panes: [pane('h-a', 'shell', 0.5), pane('h-f', 'from-a-newer-build', 0.5)]
    }
    const helpers = useHelpersStore()
    await helpers.ensureLoaded(WT)
    await helpers.flushNow()

    const written = helpersSet.mock.calls.at(-1)![0] as { state: Saved }
    expect(written.state.panes.map((p) => p.id)).toEqual(['h-a', 'h-f'])
  })
})
