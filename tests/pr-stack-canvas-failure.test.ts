// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import en from '../src/renderer/src/i18n/en.json'
import PrStackCanvas from '../src/renderer/src/components/PrStackCanvas.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import type { GhFailure, PrNode, PrStackSnapshot } from '../src/main/pr-stack-core'
import { stubTakeoverShellTargets } from './helpers/takeover-shell-stub'

/** BUG-148 — what the canvas SAYS when `gh` is slow, failing, or genuinely absent. */

const pr = {
  number: 251,
  title: 'Review pane',
  branch: 'feat/x',
  base: 'main',
  state: 'open',
  isDraft: false,
  mergeable: true,
  reviewDecision: null,
  ci: 'passing',
  checks: [],
  url: 'u',
  author: 'a',
  updatedAt: null
}

function snap(over: Partial<PrStackSnapshot> = {}, withPr = true): PrStackSnapshot {
  const node = {
    pr,
    baseKind: 'default',
    isStagingTip: true,
    isMergeNext: false
  } as unknown as PrNode
  return {
    repoPath: '/repos/harnu',
    defaultBranch: 'main',
    graph: {
      defaultBranch: 'main',
      nodes: withPr ? [node] : [],
      chains: withPr ? [[251]] : []
    },
    placements: withPr ? [{ id: '251', x: 0, y: 0 }] : [],
    edges: [],
    worktrees: [],
    kpis: { open: 1, chains: 1, readyToMerge: 0, needsRetarget: 0, stagingTips: 1 },
    world: { width: 400, height: 400 },
    shape: withPr ? 'a' : 'empty',
    fetchedAt: Date.now() - 12 * 60_000,
    ghAvailable: true,
    ghFailure: null,
    behind: {},
    ...over
  }
}

async function mountWith(...answers: PrStackSnapshot[]) {
  let call = 0
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    prStackLoad: vi.fn(async () => answers[Math.min(call++, answers.length - 1)]),
    prStackPrefs: async () => ({ autoRefresh: false, intervalMs: 90_000 }),
    shellOpenExternal: vi.fn()
  }
  useUiStore().openPrStack('/repos/harnu', 'harnu')
  const wrapper = mount(PrStackCanvas, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

const refreshButton = (w: Awaited<ReturnType<typeof mountWith>>) =>
  w.find('button[aria-label="Refresh from GitHub"]')

beforeEach(() => {
  setActivePinia(createPinia())
  stubTakeoverShellTargets()
  global.ResizeObserver = class {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  } as never
})

describe('PR Stack canvas — gh failure states', () => {
  it('a timeout after a good read keeps the cards and turns the refresh control stale', async () => {
    const w = await mountWith(snap(), snap({ ghFailure: 'timeout' as GhFailure }, false))
    expect(w.text()).not.toContain(en.prStack.ghMissing)
    expect(w.find('[data-dsqa="pr-stack-refresh--stale"]').exists()).toBe(false)

    await refreshButton(w).trigger('click')
    await flushPromises()

    expect(w.text()).toContain('Review pane') // the card survived
    expect(w.text()).not.toContain(en.prStack.ghMissing)
    expect(w.text()).not.toContain(en.prStack.emptyState)
    const stale = w.get('[data-dsqa="pr-stack-refresh--stale"]')
    expect(stale.text()).toContain('12m') // age of the last GOOD read
    expect(w.get('[role="tooltip"]').text()).toContain(en.prStack.refreshFailed.timeout.title)
  })

  it('a failure with no earlier snapshot says the refresh failed and offers retry', async () => {
    const w = await mountWith(snap({ ghFailure: 'timeout' }, false), snap())
    expect(w.text()).toContain(en.prStack.refreshFailedEmpty)
    expect(w.text()).not.toContain(en.prStack.ghMissing)
    expect(w.text()).not.toContain(en.prStack.emptyState)

    const retry = w.findAll('button').find((b) => b.text() === en.prStack.retry)
    expect(retry).toBeTruthy()
    await retry!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('Review pane')
  })

  it('a genuinely unavailable gh keeps the CLI copy', async () => {
    const w = await mountWith(snap({ ghAvailable: false }, false))
    expect(w.text()).toContain(en.prStack.ghMissing)
    expect(w.text()).not.toContain(en.prStack.refreshFailedEmpty)
  })

  it('a repo with no PRs and a healthy gh keeps the plain empty copy', async () => {
    const w = await mountWith(snap({}, false))
    expect(w.text()).toContain(en.prStack.emptyState)
  })
})
