// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import type { WorktreeHelperState } from '../src/main/helpers-store'

/**
 * Store contract for the T79 S3 memory pane: dedup by `folder`, and that memory
 * panes survive `toPersistShape` (persist + reopen on boot) like the T74 markdown
 * pane. The store touches `window.api` at flush time; a Proxy stub makes every
 * unused call a harmless no-op.
 */
const helpersSet = vi.fn(async () => {})

beforeEach(() => {
  helpersSet.mockClear()
  const api = {
    helpersGet: vi.fn(async () => null),
    helpersSet
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get(t: Record<string, unknown>, p: string) {
      return p in t ? t[p] : () => () => {}
    }
  })
  setActivePinia(createPinia())
})

const WT = '/home/user/repo'

describe('addMemoryHelper', () => {
  it('opens a memory pane and forces the split visible', () => {
    const helpers = useHelpersStore()
    const id = helpers.addMemoryHelper(WT, WT)
    const state = helpers.byWorktree.get(WT)
    expect(id).toMatch(/^h-/)
    expect(state?.splitVisible).toBe(true)
    expect(state?.panes).toHaveLength(1)
    expect(state?.panes[0]).toMatchObject({ type: 'memory', folder: WT })
  })

  it('dedups by folder — re-opening the same repo memory returns the existing pane', () => {
    const helpers = useHelpersStore()
    const first = helpers.addMemoryHelper(WT, WT)
    const again = helpers.addMemoryHelper(WT, WT)
    expect(again).toBe(first)
    expect(helpers.byWorktree.get(WT)?.panes).toHaveLength(1)
  })

  it('opens memory for a DIFFERENT folder as a separate pane in the same stack', () => {
    const helpers = useHelpersStore()
    helpers.addMemoryHelper(WT, WT)
    helpers.addMemoryHelper(WT, '/home/user/other-repo')
    const panes = helpers.byWorktree.get(WT)?.panes ?? []
    expect(panes).toHaveLength(2)
    expect(panes.map((p) => (p as { folder?: string }).folder)).toEqual([
      WT,
      '/home/user/other-repo'
    ])
  })

  it('coexists with a markdown pane (independent dedup keys)', () => {
    const helpers = useHelpersStore()
    helpers.addMarkdownHelper(WT, `${WT}/design.md`, WT)
    helpers.addMemoryHelper(WT, WT)
    expect(helpers.byWorktree.get(WT)?.panes).toHaveLength(2)
  })

  it('persists memory panes through toPersistShape (reopen on boot)', async () => {
    const helpers = useHelpersStore()
    helpers.addShellHelper(WT, WT)
    helpers.addMemoryHelper(WT, WT)

    await helpers.flushNow()

    expect(helpersSet).toHaveBeenCalled()
    const call = helpersSet.mock.calls.find(
      (c) => (c[0] as { worktreePath: string }).worktreePath === WT
    ) as [{ worktreePath: string; state: WorktreeHelperState }] | undefined
    const persisted = call?.[0].state.panes ?? []
    const mem = persisted.filter((p) => p.type === 'memory')
    expect(mem).toHaveLength(1)
    expect(mem[0].folder).toBe(WT)
  })
})
