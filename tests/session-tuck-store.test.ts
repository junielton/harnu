// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { SPLIT_RATIO_MIN } from '../src/renderer/src/lib/split-orientation'
import { ipcFn } from './helpers/ipc-clone'

/**
 * T790 — the tucked state of the session area, kept per worktree in the helpers store.
 *
 *  - AC-3 restoring from the strip lands exactly on the 0.4 floor, in the orientation in force.
 *  - AC-4 `toggleSessionTuck` is what the chord and the palette entry call.
 *  - AC-5 closing the last helper pane brings the session back.
 *  - AC-6 the state is per worktree and never written to `helpers.json`.
 */

const A = '/repo/alpha'
const B = '/repo/beta'

let helpersSet: ReturnType<typeof ipcFn>

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  localStorage.clear()
  helpersSet = ipcFn(async () => undefined)
  ;(window as unknown as { api: unknown }).api = new Proxy(
    { helpersGet: vi.fn(async () => null), helpersSet },
    {
      get: (t: Record<string, unknown>, k: string) =>
        k in t ? t[k] : k.startsWith('on') ? () => () => {} : vi.fn(async () => null)
    }
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function withPanes(
  wt: string,
  n = 2
): { helpers: ReturnType<typeof useHelpersStore>; ids: string[] } {
  const helpers = useHelpersStore()
  const ids = Array.from({ length: n }, () => helpers.addShellHelper(wt, wt))
  return { helpers, ids }
}

describe('tucking the session', () => {
  it('starts shown', () => {
    const { helpers } = withPanes(A)
    expect(helpers.sessionTucked(A)).toBe(false)
  })

  it('tucks and shows again', () => {
    const { helpers } = withPanes(A)
    helpers.tuckSession(A)
    expect(helpers.sessionTucked(A)).toBe(true)
    helpers.showSession(A)
    expect(helpers.sessionTucked(A)).toBe(false)
  })

  it('does not tuck a worktree with no helper pane (nothing would fill the area)', () => {
    const helpers = useHelpersStore()
    helpers.tuckSession(A)
    expect(helpers.sessionTucked(A)).toBe(false)
  })

  it('toggles, the way the chord and the palette entry do', () => {
    const { helpers } = withPanes(A)
    helpers.toggleSessionTuck(A)
    expect(helpers.sessionTucked(A)).toBe(true)
    helpers.toggleSessionTuck(A)
    expect(helpers.sessionTucked(A)).toBe(false)
  })

  it('is per worktree: tucking one leaves another shown', () => {
    const helpers = useHelpersStore()
    helpers.addShellHelper(A, A)
    helpers.addShellHelper(B, B)
    helpers.tuckSession(A)
    expect(helpers.sessionTucked(A)).toBe(true)
    expect(helpers.sessionTucked(B)).toBe(false)
  })

  it('follows the visible worktree and is not carried to the next one', () => {
    const helpers = useHelpersStore()
    const sessions = useSessionsStore()
    helpers.addShellHelper(A, A)
    helpers.addShellHelper(B, B)
    sessions.selectedFolderPath = A
    helpers.tuckSession(A)
    expect(helpers.sessionTuckedForCurrentWorktree).toBe(true)
    sessions.selectedFolderPath = B
    expect(helpers.sessionTuckedForCurrentWorktree).toBe(false)
    sessions.selectedFolderPath = A
    expect(helpers.sessionTuckedForCurrentWorktree).toBe(true)
  })

  it('never reaches helpers.json', async () => {
    const { helpers } = withPanes(A)
    helpers.tuckSession(A)
    await helpers.flushNow()
    const written = helpersSet.mock.calls.at(-1)![0] as { state: Record<string, unknown> }
    expect(Object.keys(written.state).sort()).toEqual(['panes', 'splitRatio', 'splitVisible'])
  })
})

describe('closing the last helper pane', () => {
  it('brings the session back', () => {
    const { helpers, ids } = withPanes(A, 1)
    helpers.tuckSession(A)
    helpers.removeHelper(A, ids[0])
    expect(helpers.sessionTucked(A)).toBe(false)
  })

  it('keeps it tucked while another pane remains', () => {
    const { helpers, ids } = withPanes(A, 2)
    helpers.tuckSession(A)
    helpers.removeHelper(A, ids[0])
    expect(helpers.sessionTucked(A)).toBe(true)
  })

  it('forgets the state when the worktree is dropped', () => {
    const { helpers } = withPanes(A)
    helpers.tuckSession(A)
    helpers.dropWorktreeFromMemory(A)
    expect(helpers.sessionTucked(A)).toBe(false)
  })
})

describe('restoring from the strip', () => {
  it('lands exactly on the 0.4 floor in side-by-side and shows the session', () => {
    const { helpers } = withPanes(A)
    helpers.setSplitRatio(A, 0.7)
    helpers.tuckSession(A)
    helpers.restoreSessionAtFloor(A, 'side-by-side')
    expect(helpers.sessionTucked(A)).toBe(false)
    expect(helpers.splitRatioFor(A, 'side-by-side')).toBe(SPLIT_RATIO_MIN)
  })

  it('sets only the stacked ratio when the layout is stacked', () => {
    const { helpers } = withPanes(A)
    helpers.setSplitRatio(A, 0.7)
    helpers.setSplitRatio(A, 0.75, 'stacked')
    helpers.tuckSession(A)
    helpers.restoreSessionAtFloor(A, 'stacked')
    expect(helpers.splitRatioFor(A, 'stacked')).toBe(SPLIT_RATIO_MIN)
    expect(helpers.splitRatioFor(A, 'side-by-side')).toBe(0.7)
  })
})
