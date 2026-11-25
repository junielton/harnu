// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import type { WorktreeHelperState } from '../src/main/helpers-store'
import {
  __resetUnsavedDraftsForTests,
  isDraftDirty,
  setDraftDirty
} from '../src/renderer/src/lib/unsaved-drafts'

/**
 * Store contract for the T74 markdown pane: dedup by filePath, a per-worktree
 * cap (recycle the oldest), and that markdown panes survive `toPersistShape`
 * (persist + reopen on boot). The store touches `window.api` at flush time; a
 * Proxy stub makes every unused call a harmless no-op.
 */
const helpersSet = vi.fn(async () => {})

beforeEach(() => {
  __resetUnsavedDraftsForTests()
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

describe('addMarkdownHelper', () => {
  it('opens a markdown pane and forces the split visible', () => {
    const helpers = useHelpersStore()
    const id = helpers.addMarkdownHelper(WT, `${WT}/design.md`, WT)
    const state = helpers.byWorktree.get(WT)
    expect(id).toMatch(/^h-/)
    expect(state?.splitVisible).toBe(true)
    expect(state?.panes).toHaveLength(1)
    expect(state?.panes[0]).toMatchObject({ type: 'markdown', filePath: `${WT}/design.md` })
  })

  it('dedups by filePath — re-opening the same file returns the existing pane', () => {
    const helpers = useHelpersStore()
    const first = helpers.addMarkdownHelper(WT, `${WT}/a.md`, WT)
    const again = helpers.addMarkdownHelper(WT, `${WT}/a.md`, WT)
    expect(again).toBe(first)
    expect(helpers.byWorktree.get(WT)?.panes).toHaveLength(1)
  })

  it('adds distinct files as separate panes', () => {
    const helpers = useHelpersStore()
    helpers.addMarkdownHelper(WT, `${WT}/a.md`, WT)
    helpers.addMarkdownHelper(WT, `${WT}/b.md`, WT)
    expect(helpers.byWorktree.get(WT)?.panes).toHaveLength(2)
  })

  it('caps at 4 markdown panes, recycling the OLDEST past the cap', () => {
    const helpers = useHelpersStore()
    for (const f of ['a', 'b', 'c', 'd']) helpers.addMarkdownHelper(WT, `${WT}/${f}.md`, WT)
    expect(helpers.byWorktree.get(WT)?.panes).toHaveLength(4)

    helpers.addMarkdownHelper(WT, `${WT}/e.md`, WT) // 5th → recycle oldest (a.md)
    const files = helpers.byWorktree
      .get(WT)
      ?.panes.map((p) => (p as { filePath?: string }).filePath)
    expect(files).toEqual([`${WT}/b.md`, `${WT}/c.md`, `${WT}/d.md`, `${WT}/e.md`])
  })

  it('does not count OTHER pane types against the markdown cap', () => {
    const helpers = useHelpersStore()
    helpers.addShellHelper(WT, WT)
    helpers.addShellHelper(WT, WT)
    for (const f of ['a', 'b', 'c', 'd']) helpers.addMarkdownHelper(WT, `${WT}/${f}.md`, WT)
    // 2 shells + 4 markdown = 6 panes; the cap is only on markdown.
    expect(helpers.byWorktree.get(WT)?.panes).toHaveLength(6)
  })

  it('persists markdown panes through toPersistShape (reopen on boot)', async () => {
    const helpers = useHelpersStore()
    helpers.addShellHelper(WT, WT)
    helpers.addMarkdownHelper(WT, `${WT}/hot.md`, WT)

    await helpers.flushNow()

    expect(helpersSet).toHaveBeenCalled()
    const call = helpersSet.mock.calls.find(
      (c) => (c[0] as { worktreePath: string }).worktreePath === WT
    ) as [{ worktreePath: string; state: WorktreeHelperState }] | undefined
    const persisted = call?.[0].state.panes ?? []
    const md = persisted.filter((p) => p.type === 'markdown')
    expect(md).toHaveLength(1)
    expect(md[0].filePath).toBe(`${WT}/hot.md`)
  })
})

describe('closeHelperByPath', () => {
  it('closes a markdown pane by its filePath', () => {
    const helpers = useHelpersStore()
    helpers.addMarkdownHelper(WT, `${WT}/a.md`, WT)
    const closedId = helpers.closeHelperByPath(WT, `${WT}/a.md`)
    expect(closedId).toBeDefined()
    expect(helpers.byWorktree.get(WT)?.panes).toHaveLength(0)
  })

  it('closes a memory pane by its folder', () => {
    const helpers = useHelpersStore()
    helpers.addMemoryHelper(WT, `${WT}`)
    const closedId = helpers.closeHelperByPath(WT, WT)
    expect(closedId).toBeDefined()
    expect(helpers.byWorktree.get(WT)?.panes).toHaveLength(0)
  })

  it('closes a canvas pane by its filePath (T218 U4 — dormant path, kept consistent)', () => {
    // Pins the canvas arm of `closeHelperByPath`. NOTE nothing invokes this
    // today: `pane.closeFile` is a dormant T171 router op with no main-process
    // caller and there is no `close_file` verb — so this is pre-wiring, not a
    // capability. It exists so the canvas is not the one file-backed pane type
    // that silently no-ops if a close surface is ever wired.
    const helpers = useHelpersStore()
    helpers.addCanvasHelper(WT, `${WT}/board.harnucanvas.json`, WT)
    const closedId = helpers.closeHelperByPath(WT, `${WT}/board.harnucanvas.json`)
    expect(closedId).toBeDefined()
    expect(helpers.byWorktree.get(WT)?.panes).toHaveLength(0)
  })

  it('never matches a PTY-backed pane (shell/claude)', () => {
    const helpers = useHelpersStore()
    const shellId = helpers.addShellHelper(WT, WT)
    const closedId = helpers.closeHelperByPath(WT, WT)
    expect(closedId).toBeUndefined()
    expect(helpers.byWorktree.get(WT)?.panes.map((p) => p.id)).toEqual([shellId])
  })

  it('returns undefined when nothing matches', () => {
    const helpers = useHelpersStore()
    expect(helpers.closeHelperByPath(WT, `${WT}/nope.md`)).toBeUndefined()
  })
})

describe('closeHelperById', () => {
  it('closes any pane type by id, including PTY-backed ones', () => {
    const helpers = useHelpersStore()
    const id = helpers.addShellHelper(WT, WT)
    expect(helpers.closeHelperById(WT, id)).toBe(true)
    expect(helpers.byWorktree.get(WT)?.panes).toHaveLength(0)
  })

  it('returns false when the pane id does not exist', () => {
    const helpers = useHelpersStore()
    expect(helpers.closeHelperById(WT, 'h-does-not-exist')).toBe(false)
  })
})

/** Mark a markdown pane dirty the way a mounted `MarkdownPane` does. */
function markDirty(paneId: string, filePath: string): void {
  setDraftDirty({ paneId, filePath, worktreePath: WT }, true)
}

describe('unsaved drafts — silent-close protection', () => {
  const files = (helpers: ReturnType<typeof useHelpersStore>): (string | undefined)[] =>
    (helpers.byWorktree.get(WT)?.panes ?? []).map((p) => (p as { filePath?: string }).filePath)

  it('recycles the oldest CLEAN markdown pane when the oldest is dirty', () => {
    const helpers = useHelpersStore()
    const ids = ['a', 'b', 'c', 'd'].map((f) => helpers.addMarkdownHelper(WT, `${WT}/${f}.md`, WT))
    markDirty(ids[0], `${WT}/a.md`)

    helpers.addMarkdownHelper(WT, `${WT}/e.md`, WT)

    expect(files(helpers)).toEqual([`${WT}/a.md`, `${WT}/c.md`, `${WT}/d.md`, `${WT}/e.md`])
  })

  it('recycles nothing when every markdown pane is dirty (the stack grows)', () => {
    const helpers = useHelpersStore()
    for (const f of ['a', 'b', 'c', 'd']) {
      markDirty(helpers.addMarkdownHelper(WT, `${WT}/${f}.md`, WT), `${WT}/${f}.md`)
    }

    helpers.addMarkdownHelper(WT, `${WT}/e.md`, WT)

    expect(helpers.byWorktree.get(WT)?.panes).toHaveLength(5)
    expect(files(helpers)).toContain(`${WT}/a.md`)
  })

  it('a cap recycle runs the remove handlers for the recycled pane', () => {
    const helpers = useHelpersStore()
    const removed: string[] = []
    const off = helpers.registerRemoveHandler((id) => removed.push(id))
    const ids = ['a', 'b', 'c', 'd'].map((f) => helpers.addMarkdownHelper(WT, `${WT}/${f}.md`, WT))

    helpers.addMarkdownHelper(WT, `${WT}/e.md`, WT) // 5th → recycles the oldest (a.md)

    expect(removed).toEqual([ids[0]])
    off()
  })

  it('removeHelper of a dirty pane clears its registry entry', () => {
    const helpers = useHelpersStore()
    const id = helpers.addMarkdownHelper(WT, `${WT}/a.md`, WT)
    markDirty(id, `${WT}/a.md`)
    expect(isDraftDirty(id)).toBe(true)

    helpers.removeHelper(WT, id)

    expect(isDraftDirty(id)).toBe(false)
  })

  it('a worktree-removal cascade discards dirty panes and clears the registry', () => {
    const helpers = useHelpersStore()
    const id = helpers.addMarkdownHelper(WT, `${WT}/a.md`, WT)
    markDirty(id, `${WT}/a.md`)

    helpers.dropWorktreeFromMemory(WT)

    expect(isDraftDirty(id)).toBe(false)
    expect(helpers.byWorktree.get(WT)).toBeUndefined()
  })

  it('isPaneUnsaved resolves a pane by id or by file path', () => {
    const helpers = useHelpersStore()
    const id = helpers.addMarkdownHelper(WT, `${WT}/a.md`, WT)
    expect(helpers.isPaneUnsaved(WT, { paneId: id })).toBe(false)
    markDirty(id, `${WT}/a.md`)
    expect(helpers.isPaneUnsaved(WT, { paneId: id })).toBe(true)
    expect(helpers.isPaneUnsaved(WT, { path: `${WT}/a.md` })).toBe(true)
    expect(helpers.isPaneUnsaved(WT, { path: `${WT}/other.md` })).toBe(false)
    expect(helpers.isPaneUnsaved(WT, { paneId: 'h-gone' })).toBe(false)
  })
})
