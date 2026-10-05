// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import FolderView from '../src/renderer/src/components/FolderView.vue'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { i18n } from '@renderer/i18n'

/**
 * T286 — the main checkout's fan-out and KPI strip.
 *
 * The contract these prove is degradation, not decoration: every one of the
 * fan-out's three async reads can fail independently, and a failed read must
 * empty its own cell without ever emptying the row, raising an error state, or
 * leaving a spinner behind (AC-6). The needs-you tile has the sharper version of
 * the same rule — a signal it cannot read is DECLARED, never counted as zero
 * (AC-8), because under-reporting "nothing is waiting on you" is the one wrong
 * answer that costs the operator something.
 */

const EMPTY_PEEK = {
  counts: { backlog: 0, ready: 0, 'in-progress': 0, review: 0, done: 0 },
  active: []
}

/** A card owning `card/x`, in the shape `roadmap:peek` returns it (T284). */
const OWNED = {
  slug: 'T99-do-the-thing',
  id: 'T99',
  title: 'Do the thing',
  status: 'in-progress',
  blocked: false
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function session(over: Record<string, unknown> = {}): any {
  return {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    summary: 'A session',
    firstPrompt: 'A session',
    messageCount: 3,
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    status: 'idle',
    ...over
  }
}

/**
 * A repo with a main checkout and two linked worktrees, main selected. `repoId`
 * is what makes them siblings, and selecting main is what puts the view in the
 * profile that owns the fan-out.
 */
function seedRepo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  over: { main?: any[]; x?: any[]; y?: any[] } = {}
): void {
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
      sessions: over.main ?? []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    {
      path: '/repo/alpha-wt/card-x',
      alias: 'card-x',
      expanded: true,
      gitBranch: 'card/x',
      repoId: 'repo-alpha',
      isMainWorktree: false,
      sessions: over.x ?? []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    {
      path: '/repo/alpha-wt/card-y',
      alias: 'card-y',
      expanded: true,
      gitBranch: 'card/y',
      repoId: 'repo-alpha',
      isMainWorktree: false,
      sessions: over.y ?? []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any
  )
  store.selectFolder('/repo/alpha')
}

/** The same repo with nothing but its main checkout — the AC-10 shape. */
function seedLoneCheckout(): void {
  const store = useSessionsStore()
  store.folders.splice(0, store.folders.length, {
    path: '/repo/solo',
    alias: 'solo',
    expanded: true,
    gitBranch: 'main',
    repoId: 'repo-solo',
    isMainWorktree: true,
    sessions: []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  store.selectFolder('/repo/solo')
}

/** One OPEN PR on `card/x`, in the shape `pr-stack:load` returns it. */
function snapshot(pr: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    ghAvailable: true,
    graph: {
      nodes: [
        {
          pr: {
            number: 12,
            branch: 'card/x',
            state: 'OPEN',
            isDraft: false,
            reviewDecision: null,
            ci: 'unknown',
            url: 'https://example.test/pr/12',
            ...pr
          }
        }
      ]
    },
    ...over
  }
}

function mockApi(over: Record<string, unknown> = {}): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).api = {
    foldersGitStatus: vi.fn().mockResolvedValue({ dirtyCount: 0, ahead: 0, behind: 0 }),
    roadmapPeek: vi.fn().mockResolvedValue(EMPTY_PEEK),
    memoryRead: vi.fn().mockResolvedValue(null),
    prStackLoad: vi.fn().mockResolvedValue(snapshot({})),
    ...over
  }
}

function mountView() {
  return mount(FolderView, { global: { plugins: [i18n] } })
}

/** The rendered row for `branch`, or `undefined`. */
function rowFor(wrapper: ReturnType<typeof mountView>, branch: string) {
  return wrapper
    .findAll('[data-test="folder-view-fanout-row"]')
    .find((row) => row.text().includes(branch))
}

describe('FolderView fan-out (T286)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockApi()
  })

  // --- AC-10 ------------------------------------------------------------------

  it('renders no fan-out section at all for a lone checkout', async () => {
    seedLoneCheckout()
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="folder-view-fanout"]').exists()).toBe(false)
  })

  it('still reads PR state for a lone checkout, which draws no fan-out but keeps the tile', async () => {
    seedLoneCheckout()
    const wrapper = mountView()
    await flushPromises()

    // The tile renders without the fan-out, so its reads must run without it
    // too: "unavailable" has to mean `gh` did not answer, never "we skipped it".
    const tile = wrapper.get('[data-test="folder-view-kpi-needs-you"]').text()
    expect(tile).not.toContain('PR state unavailable')
    expect(tile).toContain('0 PRs changes requested')
  })

  it('renders one row per sibling worktree, this folder last', async () => {
    seedRepo()
    const wrapper = mountView()
    await flushPromises()

    const rows = wrapper.findAll('[data-test="folder-view-fanout-row"]')
    expect(rows).toHaveLength(3)
    expect(rows[0].text()).toContain('card/x')
    expect(rows[1].text()).toContain('card/y')
    // The folder you are standing in is the anchor, not the news.
    expect(rows[2].attributes('data-self')).toBe('true')
    expect(rows[2].text()).toContain('main')
  })

  // --- AC-3 -------------------------------------------------------------------

  it('counts a worktree sessions and how many are live, from the store alone', async () => {
    seedRepo({
      x: [session({ taskState: 'working' }), session(), session()],
      y: [session()]
    })
    const wrapper = mountView()
    await flushPromises()

    expect(rowFor(wrapper, 'card/x')?.text()).toContain('3 · 1 live')
    // No live session → the bare count, never "0 live".
    expect(rowFor(wrapper, 'card/y')?.text()).toContain('1')
    expect(rowFor(wrapper, 'card/y')?.text()).not.toContain('live')
  })

  // --- AC-2 -------------------------------------------------------------------

  it('names the card a branch is executing, and em-dashes a branch no card owns', async () => {
    seedRepo()
    mockApi({
      roadmapPeek: vi.fn().mockImplementation(async (_folder: string, branch?: string) => ({
        ...EMPTY_PEEK,
        owned: branch === 'card/x' ? OWNED : null
      }))
    })
    const wrapper = mountView()
    await flushPromises()

    expect(rowFor(wrapper, 'card/x')?.text()).toContain('T99')
    expect(rowFor(wrapper, 'card/x')?.text()).toContain('Do the thing')
    expect(rowFor(wrapper, 'card/y')?.text()).toContain('—')
  })

  // --- AC-4 -------------------------------------------------------------------

  it('shows each sibling ahead/behind from a per-sibling git probe', async () => {
    seedRepo()
    mockApi({
      foldersGitStatus: vi.fn().mockImplementation(async (path: string) => {
        if (path === '/repo/alpha-wt/card-x') return { dirtyCount: 0, ahead: 11, behind: 0 }
        if (path === '/repo/alpha-wt/card-y') return { dirtyCount: 0, ahead: 0, behind: 0 }
        return { dirtyCount: 0, ahead: 0, behind: 5 }
      })
    })
    const wrapper = mountView()
    await flushPromises()

    expect(rowFor(wrapper, 'card/x')?.text()).toContain('↑11')
    expect(rowFor(wrapper, 'card/y')?.text()).toContain('↑0')
    expect(rowFor(wrapper, 'main')?.text()).toContain('↓5')
  })

  it('renders the rows with an empty git cell when the probe fails', async () => {
    seedRepo()
    mockApi({ foldersGitStatus: vi.fn().mockRejectedValue(new Error('not a repo')) })
    const wrapper = mountView()
    await flushPromises()

    // The rows survive; only the cell is empty.
    expect(wrapper.findAll('[data-test="folder-view-fanout-row"]')).toHaveLength(3)
    expect(rowFor(wrapper, 'card/x')?.text()).not.toContain('↑')
    expect(rowFor(wrapper, 'card/x')?.text()).not.toContain('↓')
  })

  // --- AC-5 -------------------------------------------------------------------

  it.each([
    [{ ci: 'passing' }, 'checks passing', 'ok'],
    [{ ci: 'failing' }, 'checks failing', 'bad'],
    [{ ci: 'pending' }, 'checks running', 'mute'],
    [{ reviewDecision: 'CHANGES_REQUESTED' }, 'changes requested', 'warn'],
    [{ isDraft: true }, 'draft #12', 'mute']
  ])('paints the PR pill for %o', async (pr, label, tone) => {
    seedRepo()
    mockApi({ prStackLoad: vi.fn().mockResolvedValue(snapshot(pr)) })
    const wrapper = mountView()
    await flushPromises()

    const pill = rowFor(wrapper, 'card/x')?.find('[data-test="folder-view-fanout-pr"]')
    expect(pill?.text()).toBe(label)
    expect(pill?.attributes('data-tone')).toBe(tone)
  })

  // --- AC-6 -------------------------------------------------------------------

  it.each([
    [
      'gh is unavailable',
      { prStackLoad: vi.fn().mockResolvedValue(snapshot({}, { ghAvailable: false })) }
    ],
    ['the call throws', { prStackLoad: vi.fn().mockRejectedValue(new Error('gh: not found')) }],
    [
      'the repo has no PRs',
      { prStackLoad: vi.fn().mockResolvedValue({ ghAvailable: true, graph: { nodes: [] } }) }
    ],
    ['the API is absent', { prStackLoad: undefined }]
  ])('renders rows with an empty PR cell when %s', async (_case, over) => {
    seedRepo()
    mockApi(over)
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.findAll('[data-test="folder-view-fanout-row"]')).toHaveLength(3)
    expect(wrapper.find('[data-test="folder-view-fanout-pr"]').exists()).toBe(false)
    // Never an error state, and nothing left spinning.
    expect(wrapper.text()).not.toContain('Error')
  })

  // --- AC-7 / AC-8 ------------------------------------------------------------

  it('renders the KPI strip with the worktree and session counts', async () => {
    seedRepo({ main: [session(), session()], x: [session({ taskState: 'working' })] })
    const wrapper = mountView()
    await flushPromises()

    const inFlight = wrapper.get('[data-test="folder-view-kpi-in-flight"]').text()
    expect(inFlight).toContain('1')
    expect(inFlight).toContain('3 worktrees total · 2 idle')
    expect(wrapper.get('[data-test="folder-view-kpi-sessions"]').text()).toContain('2')
  })

  it('counts needs-input sessions and changes-requested PRs in the needs-you tile', async () => {
    seedRepo({ x: [session({ taskState: 'needs-input' })] })
    mockApi({
      prStackLoad: vi.fn().mockResolvedValue(snapshot({ reviewDecision: 'CHANGES_REQUESTED' }))
    })
    const wrapper = mountView()
    await flushPromises()

    const tile = wrapper.get('[data-test="folder-view-kpi-needs-you"]').text()
    expect(tile).toContain('2 need you')
    expect(tile).toContain('1 sessions · 1 PRs changes requested')
  })

  it('excludes the PR signal and says so when PR state cannot be read', async () => {
    seedRepo({ x: [session({ taskState: 'needs-input' })] })
    mockApi({ prStackLoad: vi.fn().mockRejectedValue(new Error('gh: not found')) })
    const wrapper = mountView()
    await flushPromises()

    const tile = wrapper.get('[data-test="folder-view-kpi-needs-you"]').text()
    // The session signal still counts; the unreadable one is named, not zeroed.
    expect(tile).toContain('1 need you')
    expect(tile).toContain('PR state unavailable')
  })

  // --- AC-9 -------------------------------------------------------------------

  it('draws the 14-day activity strip from every sibling session', async () => {
    seedRepo({ main: [session()], x: [session(), session()] })
    const wrapper = mountView()
    await flushPromises()

    const strip = wrapper.get('[data-test="folder-view-activity"]')
    expect(strip.findAll('rect')).toHaveLength(14)
    expect(strip.text()).toContain('3 sessions')
    // Zero days are ticks, not gaps: 13 of the 14 columns have nothing on them.
    expect(strip.findAll('rect.zero')).toHaveLength(13)
    expect(strip.findAll('rect.today')).toHaveLength(1)
  })

  it('omits the activity strip entirely for a repo with no sessions', async () => {
    seedRepo()
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-test="folder-view-activity"]').exists()).toBe(false)
  })

  it('shows neither fan-out nor activity strip in the worktree profile', async () => {
    seedRepo({ x: [session()] })
    useSessionsStore().selectFolder('/repo/alpha-wt/card-x')
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.find('[data-test="folder-view-fanout"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="folder-view-activity"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="folder-view-kpis"]').exists()).toBe(false)
  })
})

/**
 * BUG-118 — the fan-out at real scale (102 worktrees on this repo).
 *
 * The contract here is that the table stays a place you can READ. A row click
 * used to call `sessions.selectFolder`, which swapped the whole view for that
 * worktree and left no way back to the row you were on — in a 102-row table that
 * is one click from losing your place, with no "back" anywhere in the app. The
 * click now opens a detail row in place, and leaving happens only through the
 * button that says so.
 *
 * The subtle half is AC-9: `FolderView` rebuilds `rows` from scratch through
 * `fanoutRows` every time one of its three async reads lands. An expansion held
 * by row identity would collapse under the operator each time a git probe came
 * back, which is exactly the kind of bug that only shows up on a repo slow
 * enough for the reads to be visible.
 */
describe('FolderView fan-out — expand in place (BUG-118)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockApi()
  })

  // --- AC-6 -------------------------------------------------------------------

  it('opens a detail row in place instead of navigating away', async () => {
    seedRepo()
    const store = useSessionsStore()
    const wrapper = mountView()
    await flushPromises()

    const selectFolder = vi.spyOn(store, 'selectFolder')
    expect(wrapper.find('[data-test="folder-view-fanout-detail"]').exists()).toBe(false)

    await rowFor(wrapper, 'card/x')!.trigger('click')

    const detail = wrapper.findAll('[data-test="folder-view-fanout-detail"]')
    expect(detail).toHaveLength(1)
    // The whole point: the view did not move.
    expect(selectFolder).not.toHaveBeenCalled()
    expect(store.selectedFolderPath).toBe('/repo/alpha')
  })

  it('closes the detail row when the same row is clicked again', async () => {
    seedRepo()
    const wrapper = mountView()
    await flushPromises()

    await rowFor(wrapper, 'card/x')!.trigger('click')
    expect(wrapper.find('[data-test="folder-view-fanout-detail"]').exists()).toBe(true)

    await rowFor(wrapper, 'card/x')!.trigger('click')
    expect(wrapper.find('[data-test="folder-view-fanout-detail"]').exists()).toBe(false)
  })

  it('leaves the fan-out only through the detail row explicit action', async () => {
    seedRepo()
    const store = useSessionsStore()
    const wrapper = mountView()
    await flushPromises()

    await rowFor(wrapper, 'card/x')!.trigger('click')
    await wrapper.get('[data-test="folder-view-fanout-open"]').trigger('click')

    expect(store.selectedFolderPath).toBe('/repo/alpha-wt/card-x')
  })

  it('offers no open button on the row you are already standing in', async () => {
    seedRepo()
    const wrapper = mountView()
    await flushPromises()

    // The self row sorts last.
    const rows = wrapper.findAll('[data-test="folder-view-fanout-row"]')
    await rows[rows.length - 1].trigger('click')

    const detail = wrapper.get('[data-test="folder-view-fanout-detail"]')
    expect(detail.find('[data-test="folder-view-fanout-open"]').exists()).toBe(false)
    expect(detail.text()).toContain('You are in this worktree')
  })

  // --- AC-7 -------------------------------------------------------------------

  it('carries a chevron with aria-expanded and a collapse/expand label', async () => {
    seedRepo()
    const wrapper = mountView()
    await flushPromises()

    const toggle = rowFor(wrapper, 'card/x')!.get('[data-test="folder-view-fanout-toggle"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(toggle.attributes('aria-label')).toBe('Show details: card/x')

    // Keyboard-reachable by construction: a real button, not a div with a click.
    expect(toggle.element.tagName).toBe('BUTTON')

    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(toggle.attributes('aria-label')).toBe('Hide details: card/x')
  })

  // --- AC-8 -------------------------------------------------------------------

  it('prints in full what the collapsed row truncates', async () => {
    seedRepo()
    mockApi({
      foldersGitStatus: vi.fn().mockResolvedValue({ dirtyCount: 0, ahead: 3, behind: 1 }),
      roadmapPeek: vi.fn().mockResolvedValue({ ...EMPTY_PEEK, owned: OWNED }),
      prStackLoad: vi.fn().mockResolvedValue(snapshot({ title: 'Widen the fan-out' }))
    })
    const wrapper = mountView()
    await flushPromises()

    await rowFor(wrapper, 'card/x')!.trigger('click')
    const detail = wrapper.get('[data-test="folder-view-fanout-detail"]').text()

    expect(detail).toContain('card/x')
    expect(detail).toContain('Do the thing')
    // Spelled out, not the ↑3 ↓1 glyphs the collapsed cell has room for.
    expect(detail).toContain('3 ahead')
    expect(detail).toContain('1 behind')
    expect(detail).toContain('Widen the fan-out')
    expect(detail).toContain('/repo/alpha-wt/card-x')
  })

  it('says a git probe could not be read rather than showing it as up to date', async () => {
    seedRepo()
    mockApi({ foldersGitStatus: vi.fn().mockRejectedValue(new Error('not a repo')) })
    const wrapper = mountView()
    await flushPromises()

    await rowFor(wrapper, 'card/x')!.trigger('click')
    expect(wrapper.get('[data-test="folder-view-fanout-detail"]').text()).toContain(
      'Git status could not be read'
    )
  })

  it('brings the panel into view inside the capped scroller', async () => {
    // The cap (AC-1) and the expansion (AC-6) collide: the porthole leaves ~354px
    // of body under the sticky header and an open detail row is roughly half of
    // that, so a row clicked in the lower half opens its panel below the fold.
    // jsdom computes no layout, so what is pinned here is that the handler asks
    // for the reveal at all — `scrollIntoView` is not implemented in jsdom, and
    // without the spy the optional call is a silent no-op.
    const scrollIntoView = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(Element.prototype as any).scrollIntoView = scrollIntoView

    seedRepo()
    const wrapper = mountView()
    await flushPromises()

    await rowFor(wrapper, 'card/x')!.trigger('click')
    await nextTick()

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrollIntoView.mock.instances[0]).toBe(
      wrapper.get('[data-test="folder-view-fanout-detail"]').element
    )

    // Closing a row must not yank the table around.
    scrollIntoView.mockClear()
    await rowFor(wrapper, 'card/x')!.trigger('click')
    await nextTick()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  // --- AC-9 -------------------------------------------------------------------

  it('keeps at most one row expanded at a time', async () => {
    seedRepo()
    const wrapper = mountView()
    await flushPromises()

    await rowFor(wrapper, 'card/x')!.trigger('click')
    await rowFor(wrapper, 'card/y')!.trigger('click')

    const detail = wrapper.findAll('[data-test="folder-view-fanout-detail"]')
    expect(detail).toHaveLength(1)
    expect(detail[0].text()).toContain('card/y')
  })

  it('survives the async PR read resolving underneath it', async () => {
    seedRepo()
    // Hold `pr-stack:load` open so the expansion happens BEFORE the read lands
    // and rebuilds every row object through `fanoutRows`.
    let land: (value: unknown) => void = () => {}
    mockApi({
      prStackLoad: vi.fn().mockReturnValue(
        new Promise((resolve) => {
          land = resolve
        })
      )
    })
    const wrapper = mountView()
    await flushPromises()

    await rowFor(wrapper, 'card/x')!.trigger('click')
    expect(wrapper.find('[data-test="folder-view-fanout-detail"]').exists()).toBe(true)

    land(snapshot({ title: 'Landed late' }))
    await flushPromises()

    // Still open, and now showing the PR the late read supplied.
    const detail = wrapper.findAll('[data-test="folder-view-fanout-detail"]')
    expect(detail).toHaveLength(1)
    expect(detail[0].text()).toContain('Landed late')
  })
})

/**
 * BUG-118 — the height caps (AC-1, AC-2, AC-4). The DOM half of the contract is
 * all a jsdom test can hold: the scroll containers exist and read their cap from
 * the token rather than from a literal. That a 102-row table actually scrolls
 * under its sticky header is a layout fact jsdom does not compute, and is
 * carried by the screenshots on the card instead.
 */
describe('FolderView list caps (BUG-118)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockApi()
  })

  it('caps the fan-out body against the token, not a px literal', async () => {
    seedRepo()
    const wrapper = mountView()
    await flushPromises()

    const scroller = wrapper.get('[data-test="folder-view-fanout-scroll"]')
    expect(scroller.classes()).toContain('scrollable')
    // The cap lives in `themes.css` (design.md §9) and is applied by the scoped
    // `.fanwrap` rule; the component must not carry a height of its own.
    expect(scroller.attributes('style')).toBeUndefined()
  })

  it('caps both rail lists against the same token', async () => {
    seedRepo()
    mockApi({
      roadmapPeek: vi.fn().mockResolvedValue({
        counts: { backlog: 128, ready: 11, 'in-progress': 1, review: 97, done: 0 },
        active: [{ ...OWNED, session: null }]
      })
    })
    const wrapper = mountView()
    await flushPromises()

    for (const test of ['folder-view-roadmap-list', 'folder-view-worktree-list']) {
      const list = wrapper.get(`[data-test="${test}"]`)
      expect(list.classes()).toContain('scrollable')
      // `max-height`, never `height`: a short list keeps its natural height and
      // shows no scroll gutter (AC-4).
      expect(list.attributes('style')).toContain('max-height: var(--fv-rail-list-max-h)')
      expect(list.attributes('style')).not.toMatch(/(^|;)\s*height:/)
    }
  })
})
