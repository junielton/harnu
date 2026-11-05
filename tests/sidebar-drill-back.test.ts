// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import Sidebar from '../src/renderer/src/components/Sidebar.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import type { FolderEntry } from '../src/preload'

/**
 * BUG-248 — the drill-in Back row must be a sibling ABOVE the list scroller,
 * not a row inside it. jsdom has no layout, so the structural claim is what is
 * testable here: the Back row has no scrolling ancestor, and the list scroller
 * (the element that owns `overflow-y-auto`) comes after it and does not contain
 * it. The rendered geometry (top equals the list area's top after scrolling to
 * the end, full-width border, fade strip) is covered by the visual capture.
 */

function installWindow(disk: FolderEntry[]): void {
  ;(window as unknown as { api: unknown }).api = {
    foldersLoad: vi.fn(async () => disk),
    userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
    orchestratorListArmed: vi.fn(async () => []),
    getPathForFile: vi.fn(() => null)
  }
}

/** One repo group with `n` worktrees — the 40+ row fixture. */
function bigGroup(n: number): FolderEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `/repos/alpha/wt-${i}`,
    alias: `wt-${i}`,
    gitBranch: `wt-${i}`,
    repoId: 'repo-x',
    isMainWorktree: i === 0,
    sessions: [session(`s${i}`, `/repos/alpha/wt-${i}`)]
  })) as FolderEntry[]
}

function session(id: string, projectPath: string): FolderEntry['sessions'][number] {
  const now = new Date().toISOString()
  return {
    sessionId: id,
    fullPath: `${projectPath}/${id}.jsonl`,
    fileMtime: 1,
    firstPrompt: '',
    summary: id,
    messageCount: 1,
    created: now,
    modified: now,
    gitBranch: '',
    projectPath,
    isSidechain: false,
    status: 'idle',
    agents: [],
    resumable: true,
    bridged: false
  } as FolderEntry['sessions'][number]
}

function isScroller(el: Element): boolean {
  return el.classList.contains('overflow-y-auto')
}

describe('Sidebar drill-in Back row (BUG-248)', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
    localStorage.clear()
  })

  for (const depth of [1, 2]) {
    it(`back row stays above the scroller at drill depth ${depth}`, async () => {
      installWindow(bigGroup(45))
      const sessions = useSessionsStore()
      await sessions.reloadModel()
      sessions.drillDepth = depth
      sessions.drillIntoGroup('repo:repo-x')

      const w = mount(Sidebar, { global: { plugins: [i18n] }, attachTo: document.body })
      const back = w.get('[data-drill-back]').element

      // No scrolling ancestor: nothing that scrolls can carry the Back row away.
      for (let el = back.parentElement; el && el !== w.element; el = el.parentElement) {
        expect(isScroller(el), `ancestor <${el.tagName} class="${el.className}">`).toBe(false)
      }

      // The list scroller is a LATER sibling subtree and never contains the row.
      const scroller = back.parentElement!.querySelector('.overflow-y-auto')!
      expect(scroller).not.toBeNull()
      expect(scroller.contains(back)).toBe(false)
      expect(back.compareDocumentPosition(scroller) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      // ... and the 45 worktree rows really are in that scroller.
      expect(scroller.querySelectorAll('[data-folder-path], [data-drill-folder-row]').length).toBe(
        45
      )

      // The scroller starts flush under the Back row: no sibling sits between them.
      const slot = [...back.parentElement!.children]
      const next = slot[slot.indexOf(back) + 1]
      expect(next === scroller || next.contains(scroller)).toBe(true)

      w.unmount()
    })
  }

  it('does not pin anything outside drill mode (classic tree unchanged)', async () => {
    installWindow(bigGroup(3))
    const sessions = useSessionsStore()
    await sessions.reloadModel()

    const w = mount(Sidebar, { global: { plugins: [i18n] } })
    expect(w.find('[data-drill-back]').exists()).toBe(false)
    // The classic tree keeps its single scroller.
    expect(w.findAll('.overflow-y-auto').length).toBeGreaterThanOrEqual(1)
  })

  describe('back row actions', () => {
    async function mountFolderScreen(): Promise<{
      w: ReturnType<typeof mount>
      sessions: ReturnType<typeof useSessionsStore>
      ui: ReturnType<typeof useUiStore>
    }> {
      installWindow([{ path: '/repos/solo', alias: 'solo', gitBranch: '', sessions: [] }])
      const sessions = useSessionsStore()
      const ui = useUiStore()
      await sessions.reloadModel()
      sessions.drillDepth = 2
      sessions.drillIntoFolder('/repos/solo')
      const w = mount(Sidebar, { global: { plugins: [i18n] } })
      return { w, sessions, ui }
    }

    it('keeps the hover treatment', async () => {
      const { w } = await mountFolderScreen()
      expect(w.get('[data-drill-back]').classes()).toContain('hover:bg-surface')
    })

    it('click drills back', async () => {
      const { w, sessions } = await mountFolderScreen()
      await w.get('[data-drill-back]').trigger('click')
      expect(sessions.drillStack).toEqual([])
    })

    it('right-click opens the folder menu without going back', async () => {
      const { w, sessions, ui } = await mountFolderScreen()
      await w.get('[data-drill-back]').trigger('contextmenu')
      expect(ui.folderMenu.open).toBe(true)
      expect(ui.folderMenu.projectPath).toBe('/repos/solo')
      expect(sessions.drillStack).toEqual([{ kind: 'folder', path: '/repos/solo' }])
    })
  })
})
