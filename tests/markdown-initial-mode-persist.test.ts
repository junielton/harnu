// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'

/**
 * `initialMode: 'edit'` is a one-shot "open this pane ready to type" request (a new note, a
 * WORKTREE.md scaffold, a new file from the Explorer, the keybindings file). It must never reach
 * helpers.json: a restored pane would otherwise open in edit mode after every restart and steal
 * focus from the session terminal. Restored panes open in view mode.
 */
const WT = '/repo/alpha'
const helpersSet = vi.fn(async () => undefined)
let persisted: unknown = null

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  helpersSet.mockClear()
  persisted = { splitVisible: false, splitRatio: 0.65, panes: [] }
  ;(window as unknown as { api: unknown }).api = new Proxy(
    { helpersGet: vi.fn(async () => persisted), helpersSet },
    { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => () => {}) }
  )
})
afterEach(() => vi.useRealTimers())

describe('initialMode is not persisted', () => {
  it('drops initialMode from the written pane, keeping the pane itself', async () => {
    const helpers = useHelpersStore()
    await helpers.ensureLoaded(WT)
    helpers.addMarkdownHelper(WT, '/repo/alpha/.harnu/notes/2026-11-24.md', WT, {
      initialMode: 'edit'
    })
    // The live pane still carries it, so the first mount opens in edit.
    expect(helpers.byWorktree.get(WT)!.panes[0]).toMatchObject({ initialMode: 'edit' })
    await vi.advanceTimersByTimeAsync(700)
    expect(helpersSet).toHaveBeenCalled()
    const calls = helpersSet.mock.calls as unknown as Array<
      [{ state: { panes: Array<Record<string, unknown>> } }]
    >
    const written = calls.at(-1)![0]
    expect(written.state.panes).toHaveLength(1)
    expect(written.state.panes[0]).toMatchObject({ type: 'markdown' })
    expect(written.state.panes[0]).not.toHaveProperty('initialMode')
  })
})

describe('initialMode in an older helpers.json', () => {
  it('is dropped on load, so the restored pane opens in view mode', async () => {
    persisted = {
      splitVisible: true,
      splitRatio: 0.65,
      panes: [
        {
          id: 'h-old',
          type: 'markdown',
          cwd: WT,
          ratio: 1,
          filePath: '/repo/alpha/.harnu/notes/2026-11-23.md',
          initialMode: 'edit'
        }
      ]
    }
    const helpers = useHelpersStore()
    await helpers.ensureLoaded(WT)
    const pane = helpers.byWorktree.get(WT)!.panes[0]
    expect(pane).toMatchObject({ id: 'h-old', filePath: '/repo/alpha/.harnu/notes/2026-11-23.md' })
    expect(pane).not.toHaveProperty('initialMode')
  })
})
