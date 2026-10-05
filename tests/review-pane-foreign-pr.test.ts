// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import ReviewPane from '../src/renderer/src/components/ReviewPane.vue'
import { receiptsFor } from '../src/renderer/src/components/review-format'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { assembleEvidence } from '../src/main/review-core'
import type { HeadInfo } from '../src/main/review-head'
import type { ReviewLoadArgs, ReviewSnapshot } from '../src/main/review-ipc'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'
import { stubTakeoverShellTargets } from './helpers/takeover-shell-stub'

/**
 * T246 — the renderer half of "reviewing a PR this machine never checked out".
 *
 * The claim under test is a NEGATIVE one, and it is the reason the card exists:
 * a head that was never fetched produces exactly the same git output as a branch
 * with nothing on it (`runGit` degrades to `null`, `parseCount(null)` is `0`),
 * so without a distinct state the pane tells an operator "no commits" about
 * someone else's work. They conclude nothing happened and Close.
 *
 * So: the two states must render DIFFERENTLY, the unfetched one must not carry
 * the word the empty one carries, and opening must never go to the network.
 */

const LOCAL_HEAD: HeadInfo = {
  kind: 'local',
  state: 'ready',
  ref: 'feat/their-branch',
  prNumber: null,
  freshness: 'unknown',
  fetchedAt: null,
  fetchFailed: false
}

const prHead = (over: Partial<HeadInfo> = {}): HeadInfo => ({
  ...LOCAL_HEAD,
  kind: 'pr',
  ref: 'refs/harnu/pr/412',
  prNumber: 412,
  ...over
})

function snapshot(head: HeadInfo, base = 'origin/main'): ReviewSnapshot {
  const readable = head.state === 'ready'
  return {
    folder: '/repos/harnu',
    branch: 'feat/their-branch',
    base,
    head,
    isRepo: true,
    evidence: assembleEvidence({
      branch: 'feat/their-branch',
      base,
      revListCount: readable ? '0\n' : null,
      behindCount: readable ? '0\n' : null,
      numstat: readable ? '' : null,
      nameStatus: readable ? '' : null,
      porcelain: null,
      remotes: 'origin\n',
      prListJson: '[]',
      head
    }),
    files: [],
    truncated: false,
    omittedFiles: [],
    totalRows: 0,
    viewed: { prNodeId: null, remoteKnown: false, files: {} },
    fetchedAt: 0
  }
}

let calls: ReviewLoadArgs[]

function stubApi(snap: ReviewSnapshot): void {
  calls = []
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    reviewLoad: async (args: ReviewLoadArgs) => {
      calls.push(args)
      return snap
    },
    reviewBlastRadius: async () => ({ globs: [] }),
    reviewSetViewed: async (a: { path: string }) => ({
      path: a.path,
      state: 'viewed',
      error: null
    }),
    onReviewBlastRadiusChanged: () => () => {},
    roadmapLoad: async () => ({ repoKey: 'harnu', cards: [] }),
    onRoadmapCardAdded: () => () => {},
    onRoadmapCardChanged: () => () => {},
    onRoadmapCardRemoved: () => () => {}
  }
}

async function mountPane(snap: ReviewSnapshot, prNumber: number | null = 412) {
  stubApi(snap)
  useUiStore().openReview('/repos/harnu', null, prNumber)
  const wrapper = mount(ReviewPane, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  stubTakeoverShellTargets()
  global.ResizeObserver = class {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  } as never
})

// ── AC-1 ────────────────────────────────────────────────────────────────────

describe('AC-1 — "not fetched yet" never reads as "no commits"', () => {
  it('renders its own panel, naming the fetch rather than the branch being empty', async () => {
    const wrapper = await mountPane(snapshot(prHead({ state: 'not-fetched' })))

    const panel = wrapper.get('[data-test="review-head-blocked"]')
    expect(panel.attributes('data-head-state')).toBe('not-fetched')
    expect(panel.text()).toContain('has not been fetched yet')
    // The exact sentence that would make an operator Close.
    expect(wrapper.text()).not.toContain('Nothing has been committed')
  })

  it('a branch that really is empty still gets the "no commits" panel', async () => {
    const wrapper = await mountPane(snapshot(LOCAL_HEAD), null)

    expect(wrapper.find('[data-test="review-head-blocked"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Nothing has been committed')
  })

  /**
   * The receipts are the other half of the confusion: `commitsAhead` is `0` for
   * both states, and the red `0` is the loudest thing in the strip.
   */
  it('reports `—` commits for an unreadable head, never a red 0', () => {
    const blocked = snapshot(prHead({ state: 'not-fetched' })).evidence
    const empty = snapshot(LOCAL_HEAD).evidence

    const [blockedCommits] = receiptsFor(blocked, false)
    const [emptyCommits] = receiptsFor(empty, false)

    expect(blockedCommits).toMatchObject({ key: 'commits', valueKey: 'unknown', dim: true })
    expect(blockedCommits.alarm).toBeFalsy()
    expect(emptyCommits).toMatchObject({ key: 'commits', value: '0', alarm: true })
  })
})

// ── AC-3 / AC-2 ─────────────────────────────────────────────────────────────

describe('AC-3 — opening costs nothing; the fetch is the explicit gesture', () => {
  it('loads without `fetch` on open, and carries the PR number', async () => {
    await mountPane(snapshot(prHead({ state: 'not-fetched' })))

    expect(calls).toHaveLength(1)
    expect(calls[0].fetch).toBeUndefined()
    expect(calls[0].prNumber).toBe(412)
  })

  it('the panel’s own button is what goes to the network (AC-2)', async () => {
    const wrapper = await mountPane(snapshot(prHead({ state: 'not-fetched' })))

    await wrapper.get('[data-test="review-fetch-head"]').trigger('click')
    await flushPromises()

    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({ prNumber: 412, fetch: true, force: true })
  })
})

// ── AC-7 ────────────────────────────────────────────────────────────────────

describe('AC-7 — a fetch that failed is not "nothing to fetch"', () => {
  it('renders a different panel, with a different sentence', async () => {
    const failed = await mountPane(snapshot(prHead({ state: 'fetch-failed' })))
    const failedPanel = failed.get('[data-test="review-head-blocked"]')
    const failedText = failedPanel.text()
    expect(failedPanel.attributes('data-head-state')).toBe('fetch-failed')
    expect(failedText).toContain('could not be fetched')

    // A fresh pinia: the two states are compared as two separate openings, not
    // as one pane whose store was overwritten underneath it.
    setActivePinia(createPinia())
    const never = await mountPane(snapshot(prHead({ state: 'not-fetched' })))
    const neverText = never.get('[data-test="review-head-blocked"]').text()

    expect(neverText).not.toBe(failedText)
    expect(neverText).not.toContain('could not be fetched')
  })
})

// ── AC-4 ────────────────────────────────────────────────────────────────────

describe('AC-4 — an unresolvable base refuses, and says why', () => {
  it('names the base and offers no fetch, because fetching would not help', async () => {
    const wrapper = await mountPane(
      snapshot(prHead({ state: 'base-unresolved' }), 'feat/deleted-parent')
    )

    const panel = wrapper.get('[data-test="review-head-blocked"]')
    expect(panel.attributes('data-head-state')).toBe('base-unresolved')
    expect(panel.text()).toContain('feat/deleted-parent')
    expect(wrapper.find('[data-test="review-fetch-head"]').exists()).toBe(false)
  })
})

// ── AC-6 ────────────────────────────────────────────────────────────────────

describe('AC-6 — the freshness receipt is a word, never a badge', () => {
  const words = (head: HeadInfo): Array<string | undefined> =>
    receiptsFor(snapshot(head).evidence, false).map((r) => r.valueKey ?? r.value)

  it('says `current` and `moved`, with no dot and no hue', () => {
    const current = receiptsFor(snapshot(prHead({ freshness: 'current' })).evidence, false).find(
      (r) => r.key === 'head'
    )
    expect(current).toEqual({ key: 'head', valueKey: 'head.current' })
    expect(words(prHead({ freshness: 'moved' }))).toContain('head.moved')
  })

  it('falls back to the fetch age only when there is no head SHA to compare', () => {
    const aged = receiptsFor(
      snapshot(prHead({ fetchedAt: 1_000_000 })).evidence,
      false,
      1_000_000 + 3 * 3_600_000
    ).find((r) => r.key === 'fetched')

    expect(aged?.value).toBe('3h')
  })

  it('says plainly that it knows neither', () => {
    expect(words(prHead({}))).toContain('head.unknown')
  })

  it('adds nothing at all to a local branch with no PR — the pre-T246 strip', () => {
    expect(receiptsFor(snapshot(LOCAL_HEAD).evidence, false).map((r) => r.key)).not.toContain(
      'head'
    )
  })
})

// ── AC-10 ───────────────────────────────────────────────────────────────────

describe('AC-10 — every new string exists in BOTH locale files', () => {
  const get = (locale: Record<string, unknown>, path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>(
        (o, k) => (o as Record<string, unknown> | undefined)?.[k],
        (locale as Record<string, unknown>).review
      )

  const KEYS = [
    'fetchHead',
    'receipt.head',
    'receipt.fetched',
    'value.unknown',
    'value.head.current',
    'value.head.moved',
    'value.head.unknown',
    'flag.headNotFetched',
    'flag.headFetchFailed',
    'flag.baseUnresolved',
    'flag.headMoved',
    'flag.headLocalDiffers',
    'flag.refreshFailed',
    'empty.notFetchedTitle',
    'empty.notFetchedBody',
    'empty.fetchFailedTitle',
    'empty.fetchFailedBody',
    'empty.baseUnresolvedTitle',
    'empty.baseUnresolvedBody'
  ]

  it.each(KEYS)('review.%s is a string in en and pt-BR', (key) => {
    expect(typeof get(en as Record<string, unknown>, key), `en review.${key}`).toBe('string')
    expect(typeof get(ptBR as Record<string, unknown>, key), `pt-BR review.${key}`).toBe('string')
  })
})
