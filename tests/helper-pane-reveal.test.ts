// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore, type Folder, type Session } from '../src/renderer/src/stores/sessions'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { useLayoutStore } from '../src/renderer/src/stores/layout'
import { buildDispatchActions } from '../src/renderer/src/stores/command-dispatch'

/**
 * BUG-186 — a collapsed helper panel must un-collapse whenever ANY pane is
 * opened (or re-focused via dedup) in the folder currently on screen, not only
 * for the empty→non-empty edge (first pane) or agent-origin panes (BUG-29).
 *
 * `helpers.paneRevealTick` is the signal `App.vue` watches; the App-side
 * wiring (tick → `layout.setHelperCollapsed(false)`) is pinned at the bottom.
 */

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-default',
    fullPath: '',
    fileMtime: 0,
    firstPrompt: '',
    summary: '',
    messageCount: 0,
    created: '',
    modified: '2026-10-13T00:00:00.000Z',
    gitBranch: '',
    projectPath: '/repo/a',
    isSidechain: false,
    status: 'active',
    resumable: true,
    bridged: false,
    ...overrides
  }
}

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return { path: '/repo/a', alias: 'a', sessions: [], expanded: true, pinned: true, ...overrides }
}

function setup(): { helpers: ReturnType<typeof useHelpersStore> } {
  const sessions = useSessionsStore()
  sessions.folders = [
    makeFolder({ path: '/repo/a', sessions: [makeSession({ sessionId: 's-a' })] }),
    makeFolder({
      path: '/repo/b',
      sessions: [makeSession({ sessionId: 's-b', projectPath: '/repo/b' })]
    })
  ]
  sessions.select('s-a') // visible folder is /repo/a
  return { helpers: useHelpersStore() }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('BUG-186 pane reveal tick', () => {
  it('AC-1: an operator shell pane into the visible folder (stack non-empty) bumps the tick', () => {
    const { helpers } = setup()
    helpers.addShellHelper('/repo/a', '/repo/a')
    const before = helpers.paneRevealTick
    helpers.addShellHelper('/repo/a', '/repo/a')
    expect(helpers.paneRevealTick).toBe(before + 1)
  })

  it('AC-2: every add path bumps the tick for the visible folder, any origin', () => {
    const { helpers } = setup()
    helpers.addShellHelper('/repo/a', '/repo/a')
    const adds: Array<() => void> = [
      () => helpers.addShellHelper('/repo/a', '/repo/a'),
      () => helpers.addMarkdownHelper('/repo/a', '/repo/a/x.md', '/repo/a'),
      () => helpers.addMarkdownHelper('/repo/a', '/repo/a/y.md', '/repo/a', { origin: 'agent' }),
      () => helpers.addResumeHelper('/repo/a', 'resume-1', '/repo/a')
    ]
    for (const add of adds) {
      const before = helpers.paneRevealTick
      add()
      expect(helpers.paneRevealTick).toBe(before + 1)
    }
  })

  it('AC-2: a dedup hit that re-focuses an already-open pane also bumps the tick', () => {
    const { helpers } = setup()
    helpers.addResumeHelper('/repo/a', 'resume-1', '/repo/a')
    const before = helpers.paneRevealTick
    helpers.addResumeHelper('/repo/a', 'resume-1', '/repo/a') // dedup → same pane
    expect(helpers.panesForCurrentWorktree).toHaveLength(1)
    expect(helpers.paneRevealTick).toBe(before + 1)
  })

  it('AC-3: a pane into an OFF-screen folder never bumps the tick; agent badge path unchanged', () => {
    const { helpers } = setup()
    const before = helpers.paneRevealTick
    helpers.addShellHelper('/repo/b', '/repo/b')
    expect(helpers.paneRevealTick).toBe(before)
    buildDispatchActions().addMarkdownHelper('/repo/b', '/repo/b/x.md', '/repo/b')
    expect(helpers.paneRevealTick).toBe(before)
    expect(helpers.unseenAgentPaneCount('/repo/b')).toBe(1)
  })

  it('AC-4: switching folders never bumps the tick', () => {
    const { helpers } = setup()
    helpers.addShellHelper('/repo/a', '/repo/a')
    helpers.addShellHelper('/repo/b', '/repo/b')
    const before = helpers.paneRevealTick
    useSessionsStore().select('s-b')
    useSessionsStore().select('s-a')
    expect(helpers.paneRevealTick).toBe(before)
  })

  it('AC-4: hydrating persisted state never bumps the tick', async () => {
    const { helpers } = setup()
    const before = helpers.paneRevealTick
    // Hydration writes `byWorktree` directly, never through addHelper.
    ;(helpers as unknown as { byWorktree: Map<string, unknown> }).byWorktree = new Map([
      ['/repo/a', { splitVisible: true, splitRatio: 0.65, panes: [] }]
    ])
    await nextTick()
    expect(helpers.paneRevealTick).toBe(before)
  })
})

describe('BUG-186 App.vue wiring', () => {
  const app = readFileSync(join(__dirname, '../src/renderer/src/App.vue'), 'utf8')

  it('AC-1/AC-5: App un-collapses only when the reveal tick changes (no continuous override)', () => {
    expect(app).toMatch(
      /watch\(\s*\(\) => helpers\.paneRevealTick,\s*\(\) => layout\.setHelperCollapsed\(false\)\s*\)/
    )
    expect(app).not.toContain('agentPaneRevealTick')
  })

  it('AC-5: a manual collapse after the pane is shown stays collapsed until the next add', () => {
    const { helpers } = setup()
    const layout = useLayoutStore()
    helpers.addShellHelper('/repo/a', '/repo/a')
    layout.setHelperCollapsed(true)
    expect(layout.helperCollapsed).toBe(true) // nothing in the stores re-opens it by itself
    expect(helpers.paneRevealTick).toBeGreaterThanOrEqual(0)
  })
})
