// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import ReviewPane from '../src/renderer/src/components/ReviewPane.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { useReviewStore } from '../src/renderer/src/stores/review'
import { useRoadmapStore } from '../src/renderer/src/stores/roadmap'
import { assembleEvidence, parseUnifiedDiff } from '../src/main/review-core'
import { stubTakeoverShellTargets } from './helpers/takeover-shell-stub'

/**
 * BUG-92 — the diff's SCROLL contract.
 *
 * jsdom does no layout, so these are structural rather than pixel assertions.
 * What they pin is exactly the structure that produces the behaviour, and the
 * structure is what regressed: a horizontal scroller declared per row cannot
 * share an offset, and a gutter that is not `sticky left-0` cannot stay put.
 *
 *  - AC-2 One horizontal scroller per FILE BOX, never one per row.
 *  - AC-3 The line-number gutter is pinned (`sticky left-0`, opaque).
 *  - AC-4 Every row is still a single flex line: gutter + code, in that order.
 *  - AC-1 Every scroll container in the pane carries `.scrollable`.
 *  - AC-5 The blast-radius bar and the sticky file header are untouched.
 */

const LONG = 'x'.repeat(400)

const DIFF = `diff --git a/src/main/reaper/scan-core.ts b/src/main/reaper/scan-core.ts
--- a/src/main/reaper/scan-core.ts
+++ b/src/main/reaper/scan-core.ts
@@ -1,2 +1,3 @@
 const ttlMs = 30 * 60_000
-export const fresh = (age: number) => age < ttlMs
+export const fresh = (age: number, sha: string) => age < ttlMs && sha === recorded // ${LONG}
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,1 +1,1 @@
-on: [push]
+on: [push, pull_request]
`

function snapshot(): Record<string, unknown> {
  const files = parseUnifiedDiff(DIFF)
  return {
    folder: '/repos/harnu',
    branch: 'bug/92',
    base: 'main',
    isRepo: true,
    evidence: assembleEvidence({
      branch: 'bug/92',
      base: 'main',
      revListCount: '2\n',
      behindCount: '0\n',
      numstat: '1\t1\tsrc/main/reaper/scan-core.ts\n1\t1\t.github/workflows/ci.yml\n',
      nameStatus: 'M\tsrc/main/reaper/scan-core.ts\nM\t.github/workflows/ci.yml\n',
      porcelain: '',
      remotes: 'origin\n',
      prListJson: '[]',
      session: 'done',
      blastRadiusGlobs: ['.github/workflows/**']
    }),
    files,
    truncated: false,
    omittedFiles: [] as string[],
    totalRows: 4,
    viewed: { prNodeId: null, remoteKnown: false, files: {} },
    fetchedAt: 0
  }
}

async function mountPane(): Promise<ReturnType<typeof mount>> {
  const ui = useUiStore()
  const review = useReviewStore()
  const roadmap = useRoadmapStore()
  roadmap.cards = [] as never
  roadmap.folderPath = '/repos/harnu'
  review.snapshot = snapshot() as never
  // Both files open: the collapse rule is a different contract, and a collapsed
  // box renders no rows to assert against.
  review.expanded = { 'src/main/reaper/scan-core.ts': true, '.github/workflows/ci.yml': true }
  ui.openReview('/repos/harnu', null)
  const wrapper = mount(ReviewPane, { global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

describe('BUG-92 — the diff scrolls as one column, not one per row', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    stubTakeoverShellTargets()
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      reviewLoad: async () => snapshot(),
      reviewBlastRadius: async () => ({ globs: ['.github/workflows/**'] }),
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

  // ── AC-2 ─────────────────────────────────────────────────────────────────

  it('declares exactly one horizontal scroller per expanded file box', async () => {
    const wrapper = await mountPane()

    const boxes = wrapper.findAll('article')
    expect(boxes).toHaveLength(2)

    const scrollers = wrapper.findAll('.overflow-x-auto')
    expect(scrollers).toHaveLength(boxes.length)

    // Each one is the file box's own diff body — a direct child of the article,
    // a sibling of the sticky header, never nested inside another scroller.
    for (const [i, scroller] of scrollers.entries()) {
      expect(scroller.element.parentElement).toBe(boxes[i].element)
      expect(scroller.element.querySelector('.overflow-x-auto')).toBeNull()
    }
  })

  it('no diff ROW is a scroller of its own — that is the whole bug', async () => {
    const wrapper = await mountPane()

    const rows = wrapper.findAll('[data-diff-row]')
    expect(rows.length).toBeGreaterThan(2)
    for (const row of rows) {
      expect(row.classes()).not.toContain('overflow-x-auto')
      expect(row.element.querySelector('.overflow-x-auto')).toBeNull()
    }
  })

  it('every row of a file shares that file box as its single scroll parent', async () => {
    const wrapper = await mountPane()
    const scroller = wrapper.findAll('.overflow-x-auto')[0].element

    const rows = wrapper.findAll('article')[0].findAll('[data-diff-row]')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      // Walk up to the nearest ancestor that scrolls horizontally. If every row
      // resolves to the SAME element, they cannot drift apart.
      let node: HTMLElement | null = row.element.parentElement
      while (node && !node.classList.contains('overflow-x-auto')) node = node.parentElement
      expect(node).toBe(scroller)
    }
  })

  it('the scroller pins overflow-y explicitly so no native vertical bar leaks', async () => {
    const wrapper = await mountPane()
    for (const scroller of wrapper.findAll('.overflow-x-auto')) {
      expect(scroller.classes()).toContain('overflow-y-hidden')
    }
  })

  // ── AC-3 ─────────────────────────────────────────────────────────────────

  it('the line-number gutter is pinned to the left of the scrollport', async () => {
    const wrapper = await mountPane()

    const gutters = wrapper.findAll('[data-diff-gutter]')
    expect(gutters.length).toBeGreaterThan(2)
    for (const gutter of gutters) {
      expect(gutter.classes()).toContain('sticky')
      expect(gutter.classes()).toContain('left-0')
      // Opaque, or the code column shows through the line numbers at any
      // horizontal offset greater than zero.
      expect(gutter.classes().some((c) => c.startsWith('bg-'))).toBe(true)
      expect(gutter.classes()).toContain('w-[92px]')
      expect(gutter.classes()).toContain('flex-none')
    }
  })

  it('pins the hunk and gap markers too, so the whole left edge holds', async () => {
    const wrapper = await mountPane()
    const marks = wrapper
      .findAll('[data-diff-gutter]')
      .filter((g) => ['@@', '⋯'].includes(g.text().trim()))
    expect(marks.length).toBeGreaterThan(0)
    for (const mark of marks) {
      expect(mark.classes()).toContain('sticky')
      expect(mark.classes()).toContain('left-0')
    }
  })

  // ── AC-4 ─────────────────────────────────────────────────────────────────

  it('a row stays one visual line: gutter first, code second, no wrapping', async () => {
    const wrapper = await mountPane()

    for (const row of wrapper.findAll('[data-diff-row]')) {
      expect(row.classes()).toContain('flex')
      const kids = [...row.element.children]
      expect(kids).toHaveLength(2)
      expect((kids[0] as HTMLElement).dataset.diffGutter).toBeDefined()
      const code = kids[1] as HTMLElement
      expect(code.classList.contains('whitespace-pre')).toBe(true)
    }
  })

  it('the add/remove tint sits on the row, so it survives being scrolled', async () => {
    const wrapper = await mountPane()

    const tinted = wrapper.findAll('.diff-line-add, .diff-line-del')
    expect(tinted.length).toBeGreaterThan(0)
    for (const el of tinted) {
      // On the row itself — a tint on the code cell alone ends where that
      // line's text ends and leaves a gap once the column is scrolled.
      expect(el.attributes('data-diff-row')).toBeDefined()
    }
  })

  // ── AC-1 ─────────────────────────────────────────────────────────────────

  it('every scroll container in the pane is themed', async () => {
    const wrapper = await mountPane()

    const scrolls = wrapper
      .findAll('*')
      .filter((el) =>
        el
          .classes()
          .some((c) => c === 'overflow-x-auto' || c === 'overflow-y-auto' || c === 'overflow-auto')
      )
    expect(scrolls.length).toBeGreaterThan(1)
    for (const el of scrolls) {
      expect(el.classes(), `${el.element.tagName}.${el.classes().join('.')}`).toContain(
        'scrollable'
      )
    }
  })

  // ── AC-5 ─────────────────────────────────────────────────────────────────

  it('the blast-radius marker is still an inner 2px bar, not a border on the box', async () => {
    const wrapper = await mountPane()

    const flagged = wrapper
      .findAll('article')
      .find((a) => a.text().includes('.github/workflows/ci.yml'))!
    // The box warms its border colour only; the marker itself is a child of the
    // header (design.md §6 — a border on the rounded box tapers into a sliver).
    expect(flagged.classes()).toContain('border-warning/30')
    expect(flagged.classes().some((c) => c.startsWith('border-l'))).toBe(false)

    const header = flagged.find('header')
    expect(header.classes()).toContain('relative')
    const bar = header.find('.bg-warning')
    expect(bar.exists()).toBe(true)
    expect(bar.classes()).toContain('absolute')
    expect(bar.classes()).toContain('left-0')
    expect(bar.classes()).toContain('w-0.5')
  })

  it('the file header still pins to the top of the scrollport, above the gutter', async () => {
    const wrapper = await mountPane()

    for (const header of wrapper.findAll('article > header')) {
      expect(header.classes()).toContain('sticky')
      expect(header.classes()).toContain('top-0')
      // Strictly above the sticky gutter, or the gutter paints over the path
      // while a long file scrolls under it.
      expect(header.classes()).toContain('z-[2]')
    }
    for (const gutter of wrapper.findAll('[data-diff-gutter]')) {
      expect(gutter.classes()).toContain('z-[1]')
    }
  })

  it('the outer scroller still carries no top padding (the sticky pin-point fix)', async () => {
    const wrapper = await mountPane()
    const body = wrapper.findAll('.overflow-y-auto')[0]
    expect(body.classes().some((c) => /^p[ty]?-/.test(c) && !c.startsWith('pb-'))).toBe(false)
  })
})
