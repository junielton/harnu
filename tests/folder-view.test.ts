// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import FolderView from '../src/renderer/src/components/FolderView.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { i18n } from '@renderer/i18n'

/**
 * T212 — the Folder View is what a folder click opens. Its contract: it never
 * shows an empty box. A folder with no memory shows no memory section, a folder
 * with no board shows no roadmap section, and a folder with no sessions shows a
 * CTA rather than an empty list.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seed(sessionsInFolder: any[] = []): void {
  const store = useSessionsStore()
  store.folders.splice(0, store.folders.length, {
    path: '/repo/alpha',
    alias: 'alpha',
    expanded: true,
    gitBranch: 'main',
    isMainWorktree: true,
    sessions: sessionsInFolder
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  store.selectFolder('/repo/alpha')
}

/**
 * T285 — a repo with a main checkout plus one linked worktree, selecting the
 * worktree. `repoId` is what makes them siblings, so the worktrees block has
 * something to render in both profiles.
 */
function seedWorktree(): void {
  const store = useSessionsStore()
  store.folders.splice(
    0,
    store.folders.length,
    {
      path: '/repo/alpha',
      alias: 'alpha',
      expanded: true,
      gitBranch: 'main',
      repoId: 'repo-alpha',
      isMainWorktree: true,
      sessions: []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    {
      path: '/repo/alpha-wt/card-x',
      alias: 'card-x',
      expanded: true,
      gitBranch: 'card/x',
      repoId: 'repo-alpha',
      isMainWorktree: false,
      sessions: []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  )
  store.selectFolder('/repo/alpha-wt/card-x')
}

/** Seed the main checkout of that same two-worktree repo. */
function seedMainOfRepo(): void {
  seedWorktree()
  useSessionsStore().selectFolder('/repo/alpha')
}

const HOT = { ok: true, data: { hotPreview: '**Now:** landing the scope tags' } }

/** The scope declared by the tag inside `section`, or null when it has none. */
function scopeIn(wrapper: ReturnType<typeof mountView>, section: string): string | null {
  const tag = wrapper.find(`[data-test="${section}"] [data-test="folder-view-scope-tag"]`)
  return tag.exists() ? (tag.attributes('data-scope') ?? null) : null
}

const EMPTY_PEEK = {
  counts: { backlog: 0, ready: 0, 'in-progress': 0, review: 0, done: 0 },
  active: []
}

function mockApi(over: Record<string, unknown> = {}): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = {
    foldersGitStatus: vi.fn().mockResolvedValue({ dirtyCount: 3, ahead: 1, behind: 0 }),
    roadmapPeek: vi.fn().mockResolvedValue(EMPTY_PEEK),
    memoryRead: vi.fn().mockResolvedValue(null),
    ...over
  }
}

function mountView() {
  return mount(FolderView, { global: { plugins: [i18n] } })
}

describe('FolderView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockApi()
  })

  it('shows the folder name, path and branch', async () => {
    seed()
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.text()).toContain('alpha')
    expect(wrapper.text()).toContain('/repo/alpha')
    expect(wrapper.text()).toContain('main')
  })

  it('shows a new-session CTA when the folder has no sessions', async () => {
    seed([])
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="folder-view-empty-cta"]').exists()).toBe(true)
  })

  it('lists sessions and selects one on click', async () => {
    seed([
      {
        sessionId: 's1',
        projectPath: '/repo/alpha',
        summary: 'Refactor auth',
        firstPrompt: 'Refactor auth',
        modified: new Date().toISOString()
      }
    ])
    const store = useSessionsStore()
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('Refactor auth')
    await wrapper.get('[data-test="folder-view-session"]').trigger('click')

    expect(store.selectedId).toBe('s1')
    expect(store.selectedFolderPath).toBeNull()
  })

  it('omits the roadmap section when the board is empty', async () => {
    seed()
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="folder-view-roadmap"]').exists()).toBe(false)
  })

  it('shows the roadmap section with counts and active cards', async () => {
    mockApi({
      roadmapPeek: vi.fn().mockResolvedValue({
        counts: { backlog: 7, ready: 2, 'in-progress': 1, review: 3, done: 0 },
        active: [
          {
            slug: 't210',
            id: 'T210',
            title: 'worktree steps pipeline',
            status: 'in-progress',
            blocked: false,
            session: 'sess-9'
          }
        ]
      })
    })
    seed()
    const wrapper = mountView()
    await flushPromises()

    const section = wrapper.get('[data-test="folder-view-roadmap"]')
    expect(section.text()).toContain('worktree steps pipeline')
  })

  it('degrades silently when the git probe rejects', async () => {
    mockApi({ foldersGitStatus: vi.fn().mockRejectedValue(new Error('no git')) })
    seed()
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.text()).toContain('alpha')
  })

  it('opens the roadmap board from the action bar', async () => {
    seed()
    const wrapper = mountView()
    await flushPromises()

    await wrapper.get('[data-test="folder-view-open-roadmap"]').trigger('click')

    const { useUiStore } = await import('../src/renderer/src/stores/ui')
    const ui = useUiStore()
    expect(ui.roadmap.open).toBe(true)
    expect(ui.roadmap.folderPath).toBe('/repo/alpha')
  })
})

describe('FolderView empty folder', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockApi()
  })

  /**
   * Spec §F asked for both halves of the zero-session case. The CTA half was
   * asserted at merge time; this is the half that was missing — an empty folder
   * must not offer disclosure toggles for buckets that hold nothing.
   */
  it('hides the Older and Archived toggles when both buckets are empty', async () => {
    seed([])
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.find('[data-test="folder-view-empty-cta"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="folder-view-older-toggle"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="folder-view-archived-toggle"]').exists()).toBe(false)
  })
})

/**
 * T285 — the scope-aware skeleton. Two profiles of one view, and a tag on every
 * block saying whether it describes the folder you clicked or the whole repo.
 * The redesign's whole claim is that nothing repo-wide is dressed up as local,
 * so these are the assertions that hold it to it.
 */
describe('FolderView profiles (T285)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockApi()
  })

  it('gives a main checkout the main profile', async () => {
    seedMainOfRepo()
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.get('[data-test="folder-view"]').attributes('data-profile')).toBe('main')
  })

  it('gives a linked worktree the worktree profile', async () => {
    seedWorktree()
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.get('[data-test="folder-view"]').attributes('data-profile')).toBe('worktree')
  })

  it('gives a plain non-git folder the main profile', async () => {
    const store = useSessionsStore()
    store.folders.splice(0, store.folders.length, {
      path: '/plain/notes',
      alias: 'notes',
      expanded: true,
      sessions: []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    store.selectFolder('/plain/notes')
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.get('[data-test="folder-view"]').attributes('data-profile')).toBe('main')
  })

  /**
   * The regression this wave must not cause: the reorganisation is a
   * reorganisation, not a removal. Every section T212 shipped still renders.
   */
  it('keeps every section it showed before, in both profiles', async () => {
    mockApi({
      memoryRead: vi.fn().mockResolvedValue(HOT),
      roadmapPeek: vi.fn().mockResolvedValue({
        counts: { backlog: 7, ready: 2, 'in-progress': 1, review: 3, done: 0 },
        active: [
          {
            slug: 't210',
            id: 'T210',
            title: 'worktree steps pipeline',
            status: 'in-progress',
            blocked: false,
            session: 'sess-9'
          }
        ]
      })
    })

    for (const seedIt of [seedMainOfRepo, seedWorktree]) {
      setActivePinia(createPinia())
      seedIt()
      const wrapper = mountView()
      await flushPromises()
      for (const section of [
        'folder-view-memory',
        'folder-view-sessions-section',
        'folder-view-roadmap',
        'folder-view-worktrees'
      ]) {
        expect(wrapper.find(`[data-test="${section}"]`).exists()).toBe(true)
      }
    }
  })

  it('tags sessions as folder-scoped and the repo-wide blocks as repo', async () => {
    mockApi({
      memoryRead: vi.fn().mockResolvedValue(HOT),
      roadmapPeek: vi.fn().mockResolvedValue({
        counts: { backlog: 1, ready: 0, 'in-progress': 0, review: 0, done: 0 },
        active: []
      })
    })
    seedWorktree()
    const wrapper = mountView()
    await flushPromises()

    expect(scopeIn(wrapper, 'folder-view-sessions-section')).toBe('folder')
    expect(scopeIn(wrapper, 'folder-view-memory')).toBe('repo')
    expect(scopeIn(wrapper, 'folder-view-roadmap')).toBe('repo')
    expect(scopeIn(wrapper, 'folder-view-worktrees')).toBe('repo')
  })

  it('names the worktrees block for the profile it is read from', async () => {
    seedMainOfRepo()
    let wrapper = mountView()
    await flushPromises()
    expect(wrapper.get('[data-test="folder-view-worktrees"]').text()).toContain(
      'Worktrees in this repo'
    )

    setActivePinia(createPinia())
    seedWorktree()
    wrapper = mountView()
    await flushPromises()
    expect(wrapper.get('[data-test="folder-view-worktrees"]').text()).toContain('Sibling worktrees')
  })

  /**
   * The 880px cap is what made the view a narrow strip on a wide window. It is
   * gone; the responsive behaviour below 1100/760 is CSS the scoped stylesheet
   * owns and jsdom does not evaluate, so this asserts the cap's absence only.
   */
  it('no longer caps the content column at 880px', async () => {
    seed()
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.get('[data-test="folder-view"]').attributes('style') ?? '').not.toContain('880')
    expect(wrapper.html()).not.toContain('max-width: 880px')
  })
})

/**
 * T285 AC-5 — a session row carries the same status the sidebar paints, plus
 * the `messageCount` the model already holds. The dot is the point: the Folder
 * View is where you go to see what a folder is doing, and a list of titles does
 * not answer that.
 */
describe('FolderView session rows (T285)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockApi()
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function row(over: Record<string, unknown>): any {
    return {
      sessionId: 's1',
      projectPath: '/repo/alpha',
      summary: 'Refactor auth',
      firstPrompt: 'Refactor auth',
      status: 'idle',
      messageCount: 0,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      ...over
    }
  }

  it('paints the working dot for a session the hook says is working', async () => {
    seed([row({ taskState: 'working', modified: new Date().toISOString() })])
    const wrapper = mountView()
    await flushPromises()

    const dot = wrapper.get('[data-test="folder-view-session"] span.rounded-full')
    expect(dot.classes()).toContain('bg-green')
  })

  it('paints the amber dot for a session blocked on input', async () => {
    seed([row({ taskState: 'needs-input' })])
    const wrapper = mountView()
    await flushPromises()

    const dot = wrapper.get('[data-test="folder-view-session"] span.rounded-full')
    expect(dot.classes()).toContain('bg-warning')
  })

  it('paints the muted dot for an idle session', async () => {
    seed([row({ taskState: 'idle' })])
    const wrapper = mountView()
    await flushPromises()

    const dot = wrapper.get('[data-test="folder-view-session"] span.rounded-full')
    expect(dot.classes()).toContain('bg-text-4')
  })

  it('agrees with the sidebar: every row carries exactly one dot', async () => {
    seed([
      row({ sessionId: 'a', taskState: 'working' }),
      row({ sessionId: 'b', taskState: 'needs-input' }),
      row({ sessionId: 'c', taskState: 'idle' })
    ])
    const wrapper = mountView()
    await flushPromises()

    const rows = wrapper.findAll('[data-test="folder-view-session"]')
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r.findAll('span.rounded-full')).toHaveLength(1)
  })

  it('shows the message count when the session has one', async () => {
    seed([row({ messageCount: 42 })])
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.get('[data-test="folder-view-session-msgs"]').text()).toBe('42')
  })

  it('omits the message count for a session with none', async () => {
    seed([row({ messageCount: 0 })])
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.find('[data-test="folder-view-session-msgs"]').exists()).toBe(false)
  })
})

/**
 * T287 — the worktree profile's hero: the card this branch owns, plus the rail
 * that says how far it has travelled. The two rules that matter most are the
 * honesty ones: a branch that owns no card gets NO hero at all (AC-4), and a
 * step whose evidence could not be read never paints as done (AC-5, whose
 * shaping half lives in `folder-view-format.test.ts`).
 */
describe('FolderView owned card (T287)', () => {
  const CARD = {
    slug: 't287-worktree-hero',
    id: 'T287',
    title: 'Folder View D4 — the card this branch owns',
    status: 'in-progress',
    blocked: false,
    session: 'sess-own',
    executedIn: 'card/x'
  }

  /** A peek that answers the ownership question with `card`. */
  function peekOwning(card: unknown) {
    return vi.fn().mockImplementation((_folder: string, branch?: string) =>
      Promise.resolve({
        ...EMPTY_PEEK,
        ...(branch === undefined ? {} : { owned: card })
      })
    )
  }

  /** A `gh` snapshot carrying one PR for `branch`. */
  function prSnapshot(branch: string, over: Record<string, unknown> = {}) {
    return {
      ghAvailable: true,
      graph: {
        defaultBranch: 'main',
        chains: [],
        nodes: [
          {
            pr: {
              number: 195,
              branch,
              state: 'OPEN',
              isDraft: false,
              reviewDecision: 'CHANGES_REQUESTED',
              ...over
            }
          }
        ]
      }
    }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    mockApi()
  })

  it('AC-4: renders no hero at all when the branch owns no card', async () => {
    mockApi({ roadmapPeek: peekOwning(null) })
    seedWorktree()
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.get('[data-test="folder-view"]').attributes('data-profile')).toBe('worktree')
    expect(wrapper.find('[data-test="folder-view-owned-card"]').exists()).toBe(false)
    // …and the rest of the view is still there, not a hole where a hero was.
    expect(wrapper.find('[data-test="folder-view-sessions-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="folder-view-worktrees"]').exists()).toBe(true)
  })

  it('AC-4: renders no hero on the main profile, even when a card names main', async () => {
    mockApi({ roadmapPeek: peekOwning({ ...CARD, executedIn: 'main' }) })
    seedMainOfRepo()
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="folder-view-owned-card"]').exists()).toBe(false)
  })

  it('AC-1: names the card by id, title and status', async () => {
    mockApi({ roadmapPeek: peekOwning(CARD) })
    seedWorktree()
    const wrapper = mountView()
    await flushPromises()

    const hero = wrapper.get('[data-test="folder-view-owned-card"]')
    expect(hero.get('[data-test="folder-view-owned-card-id"]').text()).toBe('T287')
    expect(hero.get('[data-test="folder-view-owned-card-title"]').text()).toContain(
      'the card this branch owns'
    )
    expect(hero.get('[data-test="folder-view-owned-card-status"]').text()).toContain('In Progress')
  })

  it('AC-1: asks the ownership question with THIS folder’s branch', async () => {
    const peek = peekOwning(CARD)
    mockApi({ roadmapPeek: peek })
    seedWorktree()
    mountView()
    await flushPromises()

    expect(peek).toHaveBeenCalledWith('/repo/alpha-wt/card-x', 'card/x')
  })

  it('AC-1: carries the PR state pill', async () => {
    mockApi({
      roadmapPeek: peekOwning(CARD),
      prStackLoad: vi.fn().mockResolvedValue(prSnapshot('card/x'))
    })
    seedWorktree()
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.get('[data-test="folder-view-owned-card-pr-pill"]').text()).toBe(
      'changes requested'
    )
  })

  it('AC-2: renders four steps carrying their real evidence', async () => {
    mockApi({
      roadmapPeek: peekOwning(CARD),
      roadmapMergeEvidence: vi.fn().mockResolvedValue({ ahead: 11, refs: ['f29585f'] }),
      prStackLoad: vi.fn().mockResolvedValue(prSnapshot('card/x'))
    })
    seedWorktree()
    const wrapper = mountView()
    await flushPromises()

    const steps = wrapper.findAll('[data-test="folder-view-owned-card-step"]')
    expect(steps).toHaveLength(4)
    expect(steps.map((s) => s.attributes('data-step'))).toEqual([
      'dispatched',
      'commits',
      'pr',
      'merge'
    ])
    expect(steps.map((s) => s.attributes('data-state'))).toEqual([
      'done',
      'done',
      'current',
      'pending'
    ])
    expect(steps[1].text()).toBe('11 commits · latest f29585f')
    expect(steps[2].text()).toBe('PR #195')
  })

  /**
   * AC-5 at the rendered layer. `mockApi`'s default stubs neither
   * `roadmapMergeEvidence` nor `prStackLoad`, which is exactly the shape of a
   * machine with no `gh` and no upstream — nothing may read as done.
   */
  it('AC-5: shows unreadable steps as not-yet, never as done', async () => {
    mockApi({ roadmapPeek: peekOwning(CARD) })
    seedWorktree()
    const wrapper = mountView()
    await flushPromises()

    const steps = wrapper.findAll('[data-test="folder-view-owned-card-step"]')
    expect(steps.map((s) => s.attributes('data-state'))).toEqual([
      'current',
      'pending',
      'pending',
      'pending'
    ])
    for (const key of ['commits', 'pr', 'merge']) {
      const step = steps.find((s) => s.attributes('data-step') === key)
      expect(step?.attributes('data-known')).toBe('no')
      expect(step?.attributes('data-state')).not.toBe('done')
    }
    // …and no error surfaced anywhere in the hero.
    expect(wrapper.find('[data-test="folder-view-owned-card"]').exists()).toBe(true)
  })

  it('AC-5: a rejected PR read is unread, not "no PR"', async () => {
    mockApi({
      roadmapPeek: peekOwning(CARD),
      roadmapMergeEvidence: vi.fn().mockResolvedValue({ ahead: 3, refs: ['abc1234'] }),
      prStackLoad: vi.fn().mockRejectedValue(new Error('gh: not found'))
    })
    seedWorktree()
    const wrapper = mountView()
    await flushPromises()

    const steps = wrapper.findAll('[data-test="folder-view-owned-card-step"]')
    const prStep = steps.find((s) => s.attributes('data-step') === 'pr')
    expect(prStep?.attributes('data-known')).toBe('no')
    expect(prStep?.attributes('data-state')).toBe('pending')
    expect(wrapper.find('[data-test="folder-view-owned-card-pr-pill"]').exists()).toBe(false)
  })

  it('AC-5: gh being unavailable is not a PR-less branch', async () => {
    mockApi({
      roadmapPeek: peekOwning(CARD),
      roadmapMergeEvidence: vi.fn().mockResolvedValue({ ahead: 3, refs: ['abc1234'] }),
      prStackLoad: vi.fn().mockResolvedValue({
        ghAvailable: false,
        graph: { defaultBranch: 'main', chains: [], nodes: [] }
      })
    })
    seedWorktree()
    const wrapper = mountView()
    await flushPromises()

    const prStep = wrapper
      .findAll('[data-test="folder-view-owned-card-step"]')
      .find((s) => s.attributes('data-step') === 'pr')
    expect(prStep?.attributes('data-known')).toBe('no')
  })

  it('AC-3: reads git evidence from the calls that already exist', async () => {
    const gitStatus = vi.fn().mockResolvedValue({ dirtyCount: 0, ahead: 11, behind: 0 })
    const mergeEvidence = vi.fn().mockResolvedValue({ ahead: 11, refs: ['f29585f'] })
    mockApi({
      roadmapPeek: peekOwning(CARD),
      foldersGitStatus: gitStatus,
      roadmapMergeEvidence: mergeEvidence
    })
    seedWorktree()
    const wrapper = mountView()
    await flushPromises()

    expect(gitStatus).toHaveBeenCalledWith('/repo/alpha-wt/card-x')
    expect(mergeEvidence).toHaveBeenCalledWith({
      folder: '/repo/alpha-wt/card-x',
      branch: 'card/x'
    })
    expect(wrapper.get('[data-test="folder-view-owned-card-git"]').text()).toContain('11')
  })

  it('AC-2: dates the dispatch from the card’s bound session', async () => {
    mockApi({ roadmapPeek: peekOwning(CARD) })
    const store = useSessionsStore()
    seedWorktree()
    // The card names `sess-own`; the dispatch's age IS that session's creation.
    store.folders[1].sessions.push({
      sessionId: 'sess-own',
      projectPath: '/repo/alpha-wt/card-x',
      summary: 'implement the hero',
      firstPrompt: 'implement the hero',
      status: 'idle',
      messageCount: 4,
      created: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
      modified: new Date().toISOString()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    const wrapper = mountView()
    await flushPromises()

    const step = wrapper
      .findAll('[data-test="folder-view-owned-card-step"]')
      .find((s) => s.attributes('data-step') === 'dispatched')
    expect(step?.text()).toBe('Dispatched · 3d ago')
    expect(wrapper.get('[data-test="folder-view-owned-card"]').text()).toContain(
      'implement the hero'
    )
  })

  it('AC-2: prints the bare step name when the dispatch cannot be dated', async () => {
    mockApi({ roadmapPeek: peekOwning({ ...CARD, session: 'not-on-disk' }) })
    seedWorktree()
    const wrapper = mountView()
    await flushPromises()

    const step = wrapper
      .findAll('[data-test="folder-view-owned-card-step"]')
      .find((s) => s.attributes('data-step') === 'dispatched')
    expect(step?.text()).toBe('Dispatched')
  })

  it('omits the unpushed half of the git line when nothing is unpushed', async () => {
    mockApi({
      roadmapPeek: peekOwning(CARD),
      foldersGitStatus: vi.fn().mockResolvedValue({ dirtyCount: 0, ahead: 0, behind: 0 })
    })
    seedWorktree()
    const wrapper = mountView()
    await flushPromises()

    const git = wrapper.get('[data-test="folder-view-owned-card-git"]').text()
    expect(git).not.toContain('↑0')
    expect(git).toContain('no changes')
  })

  /**
   * Shaping only — NOT end-to-end evidence. `pr-stack:load` builds `graph.nodes`
   * from OPEN pull requests exclusively (`buildGraph` filters `state ===
   * 'OPEN'`), so the MERGED node this stubs is a shape the real producer never
   * emits. What it pins is that the mapping reads the field correctly if it ever
   * arrives; the merged rail is unreachable in the running app until a merged-PR
   * read lands in `pr-stack*.ts` (T280 territory). See design.md §6.
   */
  it('AC-1: shows a merged PR as merged, with the whole rail done', async () => {
    mockApi({
      roadmapPeek: peekOwning({ ...CARD, status: 'review' }),
      roadmapMergeEvidence: vi.fn().mockResolvedValue({ ahead: 6, refs: ['deadbee'] }),
      prStackLoad: vi
        .fn()
        .mockResolvedValue(prSnapshot('card/x', { state: 'MERGED', reviewDecision: 'APPROVED' }))
    })
    seedWorktree()
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.get('[data-test="folder-view-owned-card-pr-pill"]').text()).toBe('merged')
    expect(
      wrapper
        .findAll('[data-test="folder-view-owned-card-step"]')
        .map((s) => s.attributes('data-state'))
    ).toEqual(['done', 'done', 'done', 'done'])
  })

  it('AC-3/AC-4: never calls gh for a branch that owns no card', async () => {
    const prStackLoad = vi.fn().mockResolvedValue(prSnapshot('card/x'))
    mockApi({ roadmapPeek: peekOwning(null), prStackLoad })
    seedWorktree()
    mountView()
    await flushPromises()

    expect(prStackLoad).not.toHaveBeenCalled()
  })

  it('AC-8: renders no 14-day activity chart in the worktree profile', async () => {
    mockApi({ roadmapPeek: peekOwning(CARD) })
    seedWorktree()
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="folder-view-activity"]').exists()).toBe(false)
  })
})

/**
 * T287 AC-7 — a sibling worktree's row carries its session state, so a branch
 * you are stacked on that is blocked on you is visible without leaving the
 * folder you are standing in.
 */
describe('FolderView sibling worktree state (T287)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockApi()
  })

  /** Seed two worktrees where the sibling holds `sessionsInSibling`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function seedWithSiblingSessions(sessionsInSibling: any[]): void {
    const store = useSessionsStore()
    store.folders.splice(
      0,
      store.folders.length,
      {
        path: '/repo/alpha',
        alias: 'alpha',
        expanded: true,
        gitBranch: 'main',
        repoId: 'repo-alpha',
        isMainWorktree: true,
        sessions: sessionsInSibling
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      {
        path: '/repo/alpha-wt/card-x',
        alias: 'card-x',
        expanded: true,
        gitBranch: 'card/x',
        repoId: 'repo-alpha',
        isMainWorktree: false,
        sessions: []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
    )
    store.selectFolder('/repo/alpha-wt/card-x')
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function sess(over: Record<string, unknown>): any {
    return {
      sessionId: 's1',
      projectPath: '/repo/alpha',
      summary: 'x',
      firstPrompt: 'x',
      status: 'idle',
      messageCount: 1,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      ...over
    }
  }

  it('gives every sibling row a state dot', async () => {
    seedWithSiblingSessions([])
    const wrapper = mountView()
    await flushPromises()

    const rows = wrapper.findAll('[data-test="folder-view-worktree"]')
    const dots = wrapper.findAll('[data-test="folder-view-worktree-dot"]')
    expect(rows.length).toBe(2)
    expect(dots.length).toBe(rows.length)
  })

  it('paints a sibling blocked on input amber', async () => {
    seedWithSiblingSessions([sess({ taskState: 'needs-input' })])
    const wrapper = mountView()
    await flushPromises()

    const dot = wrapper.findAll('[data-test="folder-view-worktree-dot"]')[0]
    expect(dot.attributes('data-state')).toBe('needs-input')
    expect(dot.classes()).toContain('bg-warning')
  })

  it('needs-input wins over working in the fold', async () => {
    seedWithSiblingSessions([
      sess({ sessionId: 'a', taskState: 'working' }),
      sess({ sessionId: 'b', taskState: 'needs-input' })
    ])
    const wrapper = mountView()
    await flushPromises()

    expect(
      wrapper.findAll('[data-test="folder-view-worktree-dot"]')[0].attributes('data-state')
    ).toBe('needs-input')
  })

  it('paints a sibling with only working sessions green', async () => {
    seedWithSiblingSessions([sess({ taskState: 'working' })])
    const wrapper = mountView()
    await flushPromises()

    const dot = wrapper.findAll('[data-test="folder-view-worktree-dot"]')[0]
    expect(dot.attributes('data-state')).toBe('working')
    expect(dot.classes()).toContain('bg-green')
  })

  it('paints a sibling with nothing running as idle', async () => {
    seedWithSiblingSessions([])
    const wrapper = mountView()
    await flushPromises()

    const dot = wrapper.findAll('[data-test="folder-view-worktree-dot"]')[0]
    expect(dot.attributes('data-state')).toBe('idle')
    expect(dot.classes()).toContain('bg-text-4')
  })
})
