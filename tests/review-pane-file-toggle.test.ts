// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import ReviewPane from '../src/renderer/src/components/ReviewPane.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useReviewStore } from '../src/renderer/src/stores/review'
import { assembleEvidence, parseUnifiedDiff } from '../src/main/review-core'
import { stubTakeoverShellTargets } from './helpers/takeover-shell-stub'

/**
 * QA-2 — the file header's expand/collapse state has to be READABLE.
 *
 * It shipped as a `▾` / `▸` text glyph in `font-mono text-[11px] text-text-4`,
 * and the operator scanning a nine-file collapsed list reported no toggle
 * affordance at all. These pin the two properties that failed there: it is an
 * icon like every other collapsible in the renderer, and the two states differ
 * in SHAPE — so the state survives a grayscale or colour-blind read.
 */

const DIFF = `diff --git a/src/main/reaper/scan-core.ts b/src/main/reaper/scan-core.ts
--- a/src/main/reaper/scan-core.ts
+++ b/src/main/reaper/scan-core.ts
@@ -1,2 +1,3 @@
 const ttlMs = 30 * 60_000
-export const fresh = (age: number) => age < ttlMs
+export const fresh = (age: number, sha: string) => age < ttlMs && sha === recorded
`

function snapshot() {
  return {
    folder: '/repos/harnu',
    branch: 'bug/57',
    base: 'main',
    isRepo: true,
    evidence: assembleEvidence({
      branch: 'bug/57',
      base: 'main',
      revListCount: '2\n',
      behindCount: '0\n',
      numstat: '1\t1\tsrc/main/reaper/scan-core.ts\n',
      nameStatus: 'M\tsrc/main/reaper/scan-core.ts\n',
      porcelain: '',
      remotes: 'origin\n',
      prListJson: '[]',
      session: 'done'
    }),
    files: parseUnifiedDiff(DIFF),
    truncated: false,
    omittedFiles: [] as string[],
    totalRows: 3,
    viewed: { prNodeId: null, remoteKnown: false, files: {} },
    fetchedAt: 0
  }
}

async function mountPane(): Promise<ReturnType<typeof mount>> {
  const ui = useUiStore()
  const review = useReviewStore()
  review.snapshot = snapshot() as never
  ui.openReview('/repos/harnu')
  const wrapper = mount(ReviewPane, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

describe('QA-2 — the file header toggle reads as a control', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubTakeoverShellTargets()
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      reviewLoad: async () => snapshot(),
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
    global.ResizeObserver = class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    } as never
  })

  it('renders an icon rather than a text glyph', async () => {
    const wrapper = await mountPane()
    const header = wrapper.get('article header')

    // The collapse affordance is an icon, and exactly one — scoped by its own
    // marker rather than by "the only svg in the header", which stopped being
    // true when T243 put the viewed checkbox on the same row.
    expect(header.findAll('[data-collapse-caret]').length).toBe(1)
    expect(header.get('[data-collapse-caret]').element.tagName.toLowerCase()).toBe('svg')
    expect(header.text()).not.toContain('▾')
    expect(header.text()).not.toContain('▸')
  })

  it('changes SHAPE between collapsed and expanded, not just colour', async () => {
    const wrapper = await mountPane()
    const store = useReviewStore()
    const header = () => wrapper.get('article header')

    const caret = (): ReturnType<typeof header> => header().get('[data-collapse-caret]')
    const iconName = (): string =>
      /lucide-([a-z-]+?)-icon/.exec(caret().attributes('class') ?? '')?.[1] ?? ''
    const colourClasses = (): string[] =>
      (caret().attributes('class') ?? '')
        .split(/\s+/)
        .filter((c) => c.startsWith('text-') || c.includes(':text-'))

    const expandedName = iconName()
    const expandedColours = colourClasses()

    await header().trigger('click')
    expect(store.isExpanded('src/main/reaper/scan-core.ts')).toBe(false)

    // Two different lucide glyphs, not one icon recoloured.
    expect(iconName()).not.toEqual(expandedName)
    expect(expandedName).toBeTruthy()
    expect(colourClasses()).toEqual(expandedColours)
    // And never the dimmest text token, which is what made it read as metadata.
    expect(colourClasses()).not.toContain('text-text-4')
  })

  it('announces the state to assistive tech via the header itself', async () => {
    const wrapper = await mountPane()
    const header = () => wrapper.get('article header')

    expect(header().attributes('aria-expanded')).toBe('true')
    await header().trigger('click')
    expect(header().attributes('aria-expanded')).toBe('false')
  })
})
