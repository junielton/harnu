// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import PrStackCanvas from '../src/renderer/src/components/PrStackCanvas.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { usePrStackStore } from '../src/renderer/src/stores/pr-stack'
import type { PrNode, PrStackSnapshot } from '../src/main/pr-stack-core'
import { stubTakeoverShellTargets } from './helpers/takeover-shell-stub'
import { mountCloseTakeover, pressEsc } from './helpers/close-takeover-harness'

/**
 * T486 AC-20 — Esc consumed by a takeover's own state peels that layer only;
 * the next Esc closes the takeover (§6.1 rule 2). Cleanup and the Diagram pane
 * are covered next to their own suites (`cleanup-view-gc`, `canvas-edit`).
 */

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

function snap(): PrStackSnapshot {
  const node = {
    pr,
    baseKind: 'default',
    isStagingTip: true,
    isMergeNext: false
  } as unknown as PrNode
  return {
    repoPath: '/repos/harnu',
    defaultBranch: 'main',
    graph: { defaultBranch: 'main', nodes: [node], chains: [[251]] },
    placements: [{ id: '251', x: 0, y: 0 }],
    edges: [],
    worktrees: [],
    kpis: { open: 1, chains: 1, readyToMerge: 0, needsRetarget: 0, stagingTips: 1 },
    world: { width: 400, height: 400 },
    shape: 'a',
    fetchedAt: Date.now(),
    ghAvailable: true,
    ghFailure: null,
    behind: {}
  } as unknown as PrStackSnapshot
}

let harness: { unmount: () => void } | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  stubTakeoverShellTargets()
  global.ResizeObserver = class {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  } as never
  ;(window as unknown as { api: unknown }).api = new Proxy(
    {
      prStackLoad: vi.fn(async () => snap()),
      prStackPrefs: async () => ({ autoRefresh: false, intervalMs: 90_000 })
    } as Record<string, unknown>,
    { get: (t, p: string) => (p in t ? t[p] : vi.fn(async () => null)) }
  )
  harness = mountCloseTakeover()
})

afterEach(() => {
  harness?.unmount()
  harness = null
  document.body.innerHTML = ''
})

describe('AC-20 — PR Stack filter', () => {
  it('Esc on the canvas clears the filter first; the next Esc closes the PR Stack', async () => {
    const ui = useUiStore()
    ui.openPrStack('/repos/harnu', 'harnu')
    const w = mount(PrStackCanvas, { global: { plugins: [i18n] }, attachTo: document.body })
    await flushPromises()
    const store = usePrStackStore()
    store.setFilterQuery('is:draft')
    await flushPromises()
    expect(store.filterActive).toBe(true)

    const canvas = document.querySelector('.pr-stack-canvas') as HTMLElement
    canvas.focus()
    await pressEsc(canvas)
    expect(store.filterActive).toBe(false)
    expect(ui.activeView?.id).toBe('prStack')

    await pressEsc(canvas)
    expect(ui.activeView).toBeNull()
    w.unmount()
  })
})

describe('AC-20 — Roadmap dispatch confirm', () => {
  // The board is not mountable in isolation (see `dialog-surfaces/source-facts.ts`);
  // its overlay is pinned from source and proven in the live pass.
  const board = readFileSync(
    resolve(__dirname, '../src/renderer/src/components/RoadmapBoard.vue'),
    'utf8'
  )
  const start = board.indexOf('v-if="dispatchConfirm"')
  const overlay = board.slice(start, board.indexOf('role="dialog"', start))

  it('stops the Esc it consumes, so view.closeTakeover never sees it', () => {
    expect(overlay).toContain('@keydown.esc.stop="cancelDispatch"')
  })

  it('takes focus when it opens, so Esc lands on it (not on the board behind)', () => {
    expect(overlay).toContain('ref="dispatchConfirmEl"')
    expect(overlay).toContain('tabindex="-1"')
    expect(board).toMatch(
      /watch\(\s*dispatchConfirm[\s\S]{0,600}dispatchConfirmEl\.value\?\.focus\(\)/
    )
  })

  it('gives focus back to what held it before (the Dispatch button) when it closes', () => {
    expect(board).toMatch(/confirmReturnFocus\s*=\s*document\.activeElement/)
    expect(board).toMatch(/confirmReturnFocus[\s\S]{0,200}isConnected[\s\S]{0,200}\.focus\(\)/)
  })
})
