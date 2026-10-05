// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { i18n } from '@renderer/i18n'
import en from '../src/renderer/src/i18n/en.json'
import PrStackCard from '../src/renderer/src/components/PrStackCard.vue'
import PrStackCanvas from '../src/renderer/src/components/PrStackCanvas.vue'
import type { PrDiffSize } from '../src/renderer/src/components/pr-stack-format'
import PrStackSettingsPane from '../src/renderer/src/components/PrStackSettingsPane.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { usePrStackStore } from '../src/renderer/src/stores/pr-stack'
import type { Lod, PrAutoMerge, PrNode, PrStackSnapshot } from '../src/main/pr-stack-core'
import { stubTakeoverShellTargets } from './helpers/takeover-shell-stub'

/**
 * T164 / PRD §9 Q3 — the review pane's second entry point: a PR node opens the
 * review for ITS OWN branch, which is where "it says it's done, is it?" is
 * actually asked.
 *
 * T246 moved the gate from *has a worktree* to *can resolve a folder for this
 * repo*: the pane now fetches `refs/pull/<n>/head` and diffs it read-only, so a
 * PR nobody checked out here — the common shape of someone else's PR — is
 * reviewable. The negative property survives the move, and is still the one
 * that matters: with neither a worktree nor a repo folder there is no head to
 * resolve, and a button that opens an empty or wrong diff is the failure this
 * whole card exists to avoid.
 *
 * The two paths are deliberately different, not interchangeable. A worktree
 * WINS when one exists: that checkout is the operator's own copy, and swapping
 * it for a fetched pull ref would quietly review something else.
 */

const node: PrNode = {
  pr: {
    number: 251,
    title: 'Review pane',
    branch: 'feat/t164-u3-review-pane',
    base: 'main',
    state: 'open',
    isDraft: false,
    mergeable: true,
    reviewDecision: null,
    ci: 'passing',
    checks: [],
    url: 'https://github.com/junielton/harnu/pull/251',
    author: 'junielton',
    updatedAt: null,
    headOid: null
  },
  parent: null,
  children: [],
  baseKind: 'default',
  depth: 0,
  isStagingTip: true,
  carries: 1,
  isMergeNext: false,
  chain: 0
}

function mountCard(
  worktree: { path: string; sessionLive: boolean } | null,
  repoFolder: string | null = null
) {
  return mount(PrStackCard, {
    props: {
      node,
      lod: 'full' as const,
      expanded: true,
      moved: false,
      now: 0,
      worktree,
      repoFolder
    },
    global: { plugins: [i18n] }
  })
}

describe('PR Stack card — review this PR’s branch', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('offers the review for the worktree checked out on THIS PR’s branch', async () => {
    const wrapper = mountCard({ path: '/repos/harnu/wt/t164', sessionLive: false })

    await wrapper.get('[data-test="pr-card-review"]').trigger('click')

    // No `prNumber`: the local checkout IS the thing to review, uncommitted
    // files and all. Fetching the pull ref instead would review something else.
    expect(wrapper.emitted('openReview')).toEqual([
      [{ folder: '/repos/harnu/wt/t164', prNumber: null }]
    ])
  })

  it('reviews the PR’s own head when nothing is checked out on it (T246)', async () => {
    const wrapper = mountCard(null, '/repos/harnu')

    await wrapper.get('[data-test="pr-card-review"]').trigger('click')

    expect(wrapper.emitted('openReview')).toEqual([[{ folder: '/repos/harnu', prNumber: 251 }]])
  })

  it('prefers the worktree over the pull ref when both are available', async () => {
    const wrapper = mountCard({ path: '/repos/harnu/wt/t164', sessionLive: false }, '/repos/harnu')

    await wrapper.get('[data-test="pr-card-review"]').trigger('click')

    expect(wrapper.emitted('openReview')).toEqual([
      [{ folder: '/repos/harnu/wt/t164', prNumber: null }]
    ])
  })

  it('does not offer it at all when neither a worktree nor a repo folder resolves', () => {
    const wrapper = mountCard(null, null)

    expect(wrapper.find('[data-test="pr-card-review"]').exists()).toBe(false)
    // …and nothing else grew a dead review affordance in its place.
    expect(wrapper.emitted('openReview')).toBeUndefined()
    expect(wrapper.text()).not.toContain('Review branch')
  })

  it('is not rendered while the drawer is closed', () => {
    const wrapper = mount(PrStackCard, {
      props: {
        node,
        lod: 'full' as const,
        expanded: false,
        moved: false,
        now: 0,
        worktree: { path: '/repos/harnu/wt/t164', sessionLive: false },
        repoFolder: '/repos/harnu'
      },
      global: { plugins: [i18n] }
    })

    expect(wrapper.find('[data-test="pr-card-review"]').exists()).toBe(false)
  })
})

// ── The canvas half of the wiring ───────────────────────────────────────────

/**
 * The card only EMITS. Nothing above proves the canvas is listening, and a
 * mistyped event name in the template fails silently — `vue-tsc` runs without
 * `strictTemplates` here, so nothing else would catch it. Mount the real canvas
 * and click the real button.
 */
function canvasSnapshot(): PrStackSnapshot {
  return {
    repoPath: '/repos/harnu',
    defaultBranch: 'main',
    graph: { defaultBranch: 'main', nodes: [node], chains: [[251]] },
    placements: [{ id: '251', x: 0, y: 0 }],
    edges: [],
    worktrees: [
      {
        path: '/repos/harnu/wt/t164',
        branch: 'feat/t164-u3-review-pane',
        title: 't164',
        bornFrom: null,
        sessionLive: false,
        harvestable: false,
        mergedPr: null,
        sizeBytes: 0
      }
    ],
    kpis: { open: 1, chains: 1, readyToMerge: 0, needsRetarget: 0, stagingTips: 1 },
    world: { width: 400, height: 400 },
    shape: 'x',
    fetchedAt: 0,
    ghAvailable: true,
    ghFailure: null,
    behind: {}
  }
}

describe('PR Stack canvas — the review button is actually wired', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubTakeoverShellTargets()
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      prStackLoad: async () => canvasSnapshot(),
      prStackPrefs: async () => ({}),
      shellOpenExternal: vi.fn()
    }
    global.ResizeObserver = class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    } as never
  })

  it('opens the review on the PR’s own head when no worktree holds it', async () => {
    const ui = useUiStore()
    const store = usePrStackStore()
    ui.openPrStack('/repos/harnu', 'harnu')
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      prStackLoad: async () => ({ ...canvasSnapshot(), worktrees: [] }),
      prStackPrefs: async () => ({}),
      shellOpenExternal: vi.fn()
    }

    const wrapper = mount(PrStackCanvas, { global: { plugins: [i18n] } })
    await flushPromises()
    store.toggleExpanded('251')
    await flushPromises()

    await wrapper.get('[data-test="pr-card-review"]').trigger('click')

    // The repo folder the canvas is anchored on, plus the PR number. The pane
    // resolves the repo's MAIN worktree from git itself — the canvas must not
    // be trusted to have been opened from the right folder.
    expect(ui.review.folderPath).toBe('/repos/harnu')
    expect(ui.review.prNumber).toBe(251)
  })

  it('opens the review takeover on the PR’s own worktree, and closes itself', async () => {
    const ui = useUiStore()
    const store = usePrStackStore()
    ui.openPrStack('/repos/harnu', 'harnu')

    const wrapper = mount(PrStackCanvas, { global: { plugins: [i18n] } })
    await flushPromises()

    // The drawer holds the button; `load()` clears `expandedId` on open, so
    // expand the way the operator does — after the canvas has its snapshot.
    store.toggleExpanded('251')
    await flushPromises()

    await wrapper.get('[data-test="pr-card-review"]').trigger('click')

    expect(ui.review.open).toBe(true)
    expect(ui.review.folderPath).toBe('/repos/harnu/wt/t164')
    expect(ui.review.prNumber).toBeNull()
    // The takeover mutex: the canvas the operator came from is gone.
    expect(ui.prStack.open).toBe(false)
  })
})

// T276 — the diff-size chip. Lives here, not beside `formatDiffSize`, so the
// formatter tests stay node-only: this is the one block that mounts the card.
describe('PR Stack card — where the diff-size chip renders', () => {
  const size = (additions: number | null, deletions: number | null, changedFiles: number | null) =>
    ({ additions, deletions, changedFiles }) as PrDiffSize
  const sizedNode = (diff: PrDiffSize): PrNode => ({
    pr: {
      number: 342,
      title: 'Review verdict chips',
      branch: 'card/T273-pr-stack-review-verdict-chips',
      base: 'main',
      state: 'OPEN',
      isDraft: false,
      mergeable: true,
      reviewDecision: null,
      ci: 'passing',
      checks: [],
      url: 'https://github.com/junielton/harnu/pull/342',
      author: 'junielton',
      updatedAt: null,
      headOid: null,
      nodeId: null,
      mergeStateStatus: null,
      reviewRequests: [],
      labels: [],
      autoMergeRequest: null,
      ...diff
    },
    parent: null,
    children: [],
    baseKind: 'default',
    depth: 0,
    isStagingTip: false,
    carries: 1,
    isMergeNext: false,
    chain: 0
  })
  const enOnly = createI18n({ legacy: false, locale: 'en', messages: { en } })
  const mountSized = (diff: PrDiffSize, lod: Lod, expanded = false) =>
    mount(PrStackCard, {
      props: { node: sizedNode(diff), lod, expanded, moved: false, now: 0 },
      global: { plugins: [enOnly] }
    })
  const chip = '[data-test="pr-card-diff-size"]'

  it('renders the chip at `full`, muted', () => {
    const el = mountSized(size(412, 38, 9), 'full').find(chip)
    expect(el.exists()).toBe(true)
    expect(el.text()).toBe('+412 −38 · 9 files')
    expect(el.classes()).toEqual(expect.arrayContaining(['bg-surface-2', 'text-text-3']))
    expect(el.classes()).toContain('tabular-nums')
  })

  it('is the last chip in the clipped track — the first the clip takes', () => {
    const w = mountSized(size(412, 38, 9), 'full')
    const slot = w.find('[data-test="pr-card-diff-size-slot"]').element
    const track = slot.parentElement!
    expect(track.classList).toContain('overflow-hidden')
    expect(track.lastElementChild).toBe(slot)
  })

  it('is hidden whole, never half-shown — a clipped `+412 −3` would misreport it', () => {
    // jsdom has no layout, so this pins the mechanism: a one-line slot that
    // wraps, a zero-width spacer holding line one, the chip after it. A chip
    // that does not fit beside the spacer wraps to line two, which the slot's
    // fixed height and overflow hide.
    const w = mountSized(size(412, 38, 9), 'full')
    const slot = w.find('[data-test="pr-card-diff-size-slot"]')
    expect(slot.classes()).toEqual(
      expect.arrayContaining(['flex-wrap', 'overflow-hidden', 'h-[18px]', 'min-w-0', 'flex-1'])
    )
    const [spacer, only] = Array.from(slot.element.children)
    expect(spacer.classList).toContain('w-0')
    expect(spacer.textContent).toBe('')
    expect(only).toBe(w.find(chip).element)
    expect(slot.element.children).toHaveLength(2)
  })

  it('sheds the chip at `compact` and `far`', () => {
    expect(
      mountSized(size(412, 38, 9), 'compact')
        .find(chip)
        .exists()
    ).toBe(false)
    expect(
      mountSized(size(412, 38, 9), 'far')
        .find(chip)
        .exists()
    ).toBe(false)
    expect(mountSized(size(412, 38, 9), 'far').text()).not.toContain('412')
  })

  it('renders no chip and no drawer row when the data is missing', () => {
    const w = mountSized(size(null, null, null), 'full', true)
    expect(w.find(chip).exists()).toBe(false)
    expect(w.text()).not.toContain('+0')
    expect(w.findAll('dt').map((d) => d.text())).not.toContain('diff')
  })

  it('repeats the size, exact, in the expanded drawer', () => {
    const w = mountSized(size(12_408, 3_120, 1_214), 'full', true)
    expect(w.find(chip).text()).toBe('+12k −3.1k · 1.2k files')
    const dts = w.findAll('dt')
    const row = dts.findIndex((d) => d.text() === 'diff')
    expect(row).toBeGreaterThanOrEqual(0)
    expect(w.findAll('dd')[row].text()).toBe('+12408 −3120 · 1214 files')
  })
})

/**
 * The marker is a state of the CARD, not a verdict (spec §4.1 / §5.7): it lives
 * on the identity row beside the age, which survives `compact`, and it must
 * never take the status slot that `prStatusSlot()` owns. Only a render can pin
 * the placement, so the card is mounted here beside the formatter it consumes.
 */
describe('PrStackCard — the auto-merge marker', () => {
  const armed: PrAutoMerge = { mergeMethod: 'SQUASH', enabledBy: 'junielton' }

  function node(autoMergeRequest: PrAutoMerge | null): PrNode {
    return {
      pr: {
        number: 279,
        // Neither the title nor the branch may contain `auto-merge`: the
        // no-row test below asserts that text is absent from the whole card.
        title: 'Lightning marker',
        branch: 'card/T279-marker',
        base: 'main',
        state: 'OPEN',
        isDraft: false,
        mergeable: true,
        reviewDecision: 'APPROVED',
        ci: 'passing',
        checks: [],
        url: 'https://github.com/o/r/pull/279',
        author: 'junielton',
        updatedAt: null,
        headOid: null,
        nodeId: null,
        mergeStateStatus: null,
        additions: null,
        deletions: null,
        changedFiles: null,
        reviewRequests: [],
        labels: [],
        autoMergeRequest
      },
      parent: null,
      children: [],
      baseKind: 'default',
      depth: 0,
      isStagingTip: true,
      carries: 1,
      isMergeNext: true,
      chain: 0
    }
  }

  function mountCard(lod: Lod, am: PrAutoMerge | null, expanded = false) {
    return mount(PrStackCard, {
      props: { node: node(am), lod, expanded, moved: false, now: 0 },
      global: { plugins: [i18n] }
    })
  }

  const MARKER = '[data-test="pr-card-automerge"]'
  const DETAIL = '[data-test="pr-card-automerge-detail"]'

  beforeEach(() => {
    i18n.global.locale.value = 'en'
  })

  it('renders at full and at compact when armed, labelled for a screen reader', () => {
    for (const lod of ['full', 'compact'] as const) {
      const marker = mountCard(lod, armed).find(MARKER)
      expect(marker.exists(), lod).toBe(true)
      expect(marker.attributes('aria-label')).toBe(en.prStack.autoMergeTitle)
      expect(marker.attributes('title')).toBe(en.prStack.autoMergeTitle)
    }
  })

  it('renders nothing when auto-merge is not armed', () => {
    for (const lod of ['full', 'compact', 'far'] as const) {
      expect(mountCard(lod, null).find(MARKER).exists(), lod).toBe(false)
    }
  })

  it('is not drawn on the far pill (spec §4.2 budget)', () => {
    expect(mountCard('far', armed).find(MARKER).exists()).toBe(false)
  })

  it('does not take the status slot', () => {
    const wrapper = mountCard('full', armed)
    const slot = wrapper.get('[data-status]')
    // The slot still holds the review verdict, not an auto-merge state.
    expect(slot.attributes('data-status')).toBe('approved')
    expect(slot.text()).toBe(en.prStack.approved)
    // And the marker sits outside the readiness track entirely.
    expect(slot.element.parentElement?.querySelector(MARKER)).toBeNull()
    expect(wrapper.findAll('[data-status]')).toHaveLength(1)
  })

  it('sits beside the age on the identity row', () => {
    // A real timestamp, so the age renders and adjacency is observable — the
    // shared fixture's `updatedAt: null` leaves the age span empty.
    const now = Date.parse('2026-09-10T12:00:00Z')
    const armedNode = node(armed)
    armedNode.pr.updatedAt = '2026-09-08T12:00:00Z'
    const wrapper = mount(PrStackCard, {
      props: { node: armedNode, lod: 'compact', expanded: false, moved: false, now },
      global: { plugins: [i18n] }
    })
    const marker = wrapper.get(MARKER).element
    // Immediately followed by the age…
    expect(marker.nextElementSibling?.textContent?.trim()).toBe('2d')
    // …on the same row as the PR number, not merely somewhere inside the card.
    const number = wrapper.findAll('span').find((s) => s.text() === '#279')
    expect(number).toBeDefined()
    expect(marker.closest('div')).toBe(number?.element.parentElement)
  })

  it('the drawer names the merge method and who armed it', () => {
    expect(mountCard('full', armed, true).get(DETAIL).text()).toBe('squash, armed by @junielton')
    expect(mountCard('full', { mergeMethod: null, enabledBy: null }, true).get(DETAIL).text()).toBe(
      'armed'
    )
  })

  it('the drawer has no auto-merge row when not armed', () => {
    const wrapper = mountCard('full', null, true)
    expect(wrapper.find(DETAIL).exists()).toBe(false)
    expect(wrapper.text()).not.toContain(en.prStack.autoMerge)
  })
})

// ── T278: the prefs → card wiring for label chips ──────────────────────────

/**
 * `labelChips()` is covered on its own, but nothing there proves the card
 * actually reads `prefs.showLabels` from the store, or that flipping the
 * Settings toggle reaches a card already on screen. Both are one mistyped
 * property away from a toggle that silently does nothing.
 */
const labelled: PrNode = { ...node, pr: { ...node.pr, labels: ['bug', 'ui', 'infra'] } }

function mountLabelledCard() {
  return mount(PrStackCard, {
    props: {
      node: labelled,
      lod: 'full' as const,
      expanded: true,
      moved: false,
      now: 0,
      worktree: null,
      repoFolder: null
    },
    global: { plugins: [i18n] }
  })
}

describe('PR Stack card — label chips follow the Settings toggle', () => {
  let stored: { version: 1; autoRefresh: boolean; intervalMs: number; showLabels: boolean }

  beforeEach(() => {
    setActivePinia(createPinia())
    stored = { version: 1, autoRefresh: true, intervalMs: 90_000, showLabels: false }
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      prStackPrefs: async () => ({ ...stored }),
      prStackSetPrefs: async (next: typeof stored) => {
        stored = { ...next }
        return { ...stored }
      }
    }
  })

  it('draws no label anywhere while the pref is off', () => {
    usePrStackStore().prefs = { ...stored, showLabels: false }
    const wrapper = mountLabelledCard()

    expect(wrapper.findAll('[data-test="pr-card-label"]')).toHaveLength(0)
    expect(wrapper.find('[data-test="pr-card-label-more"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="pr-card-label-list"]').exists()).toBe(false)
  })

  it('draws the capped chips, the +N overflow and the drawer list when on', () => {
    usePrStackStore().prefs = { ...stored, showLabels: true }
    const wrapper = mountLabelledCard()

    expect(wrapper.findAll('[data-test="pr-card-label"]').map((w) => w.text())).toEqual([
      'bug',
      'ui'
    ])
    expect(wrapper.get('[data-test="pr-card-label-more"]').text()).toContain('1')
    expect(wrapper.get('[data-test="pr-card-label-list"]').text()).toBe('bug, ui, infra')
  })

  it('flipping the Settings toggle reaches a card already on screen', async () => {
    const pane = mount(PrStackSettingsPane, { global: { plugins: [i18n] } })
    const card = mountLabelledCard()
    await flushPromises()
    expect(card.findAll('[data-test="pr-card-label"]')).toHaveLength(0)

    await pane.get('[data-test="pr-stack-show-labels"]').trigger('click')
    await flushPromises()
    expect(stored.showLabels).toBe(true)
    expect(card.findAll('[data-test="pr-card-label"]')).toHaveLength(2)

    await pane.get('[data-test="pr-stack-show-labels"]').trigger('click')
    await flushPromises()
    expect(card.findAll('[data-test="pr-card-label"]')).toHaveLength(0)
  })
})
