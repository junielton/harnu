import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * BUG-119 — the shared prose styles, pinned as source.
 *
 * `MarkdownRenderer.vue`'s `<style scoped>` is the ONE place seven surfaces get
 * their prose look from (`MarkdownPane`, `FolderView`, `CardDetailModal`,
 * `MemoryPane`, `ReviewPane`, `FolderPreview`, `lesson-blocks`). jsdom applies
 * no scoped CSS, so the unit suite cannot see any of it — the same blind spot
 * `tests/e2e/ci/scheduler-result-css.spec.ts` was written for, one layer down.
 * Asserting on the stylesheet text is the cheap guard that a deletion or a
 * "harmless" rewrite reddens something.
 *
 * READ THIS BEFORE TRUSTING ANY ASSERTION HERE: a text match over a stylesheet
 * is evidence that a declaration is WRITTEN, never that it RENDERS. It cannot
 * see the cascade, specificity, `@layer`, or Tailwind's preflight. Twice now
 * that gap has been demonstrated rather than argued — a `list-style: none`
 * appended below these rules kept this file green while Chromium rendered
 * marker-less lists, and wrecking `h3`/`code`/`pre`/`blockquote` kept the whole
 * 6722-test unit suite green. `block()` below now resolves the cascade for an
 * identical selector, which closes the first of those; the second is closed in
 * a browser, not here.
 *
 * The rendered proof for every AC lives in
 * `tests/e2e/ci/scheduler-result-css.spec.ts` (`npm run e2e:ci`), which reads
 * computed styles out of Chromium:
 *   AC-1 → "markdown lists render their list markers"
 *   AC-2 → "each nested list level renders a distinguishable marker"
 *   AC-7 → "no other prose element changed appearance (AC-7)"
 * If you are grading this card, that file is the evidence and this one is the
 * cheap early-warning layer. The captures under `.capy/out/bug119-proof/` are
 * untracked one-shot screenshots — someone looked once; they cannot redden, and
 * they are not a guard.
 *
 * Same idiom as `tests/fleet-ring-styles.test.ts`, which pins the fleet ring the
 * same way and for the same reason.
 */
const renderer = readFileSync('src/renderer/src/components/MarkdownRenderer.vue', 'utf8')
const scheduler = readFileSync('src/renderer/src/components/SchedulerWorkerDetail.vue', 'utf8')

/**
 * The SFC's `<style scoped>` block, comments stripped. Comments explain the
 * rules and quote the values that were REJECTED, so a "this must not appear"
 * assertion has to read declarations only — and only the stylesheet, never the
 * script or template, which are full of braces.
 */
function styleBlock(sfc: string): string {
  const open = sfc.indexOf('<style')
  expect(open, 'the SFC must have a <style> block').toBeGreaterThan(-1)
  return sfc
    .slice(sfc.indexOf('>', open) + 1, sfc.lastIndexOf('</style>'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
}
const rendererCss = styleBlock(renderer)
const schedulerCss = styleBlock(scheduler)

/**
 * The EFFECTIVE declarations for `selector` — every rule whose selector list
 * contains it, resolved in source order so that, per property, the LAST value
 * wins. Which is what the browser does.
 *
 * It has to read every rule, not the first: `.md-prose :deep(ol)` appears both
 * in the grouped margin/padding rule and in its own `list-style` rule, and
 * reading only the first would assert against the wrong block. But it must not
 * naively JOIN them either, which is what this helper used to do — and that bug
 * made every assertion in this file defeasible by an override that never
 * deletes anything. Appending
 *
 *     .md-prose :deep(ul) { list-style: none }
 *
 * to the end of the same `<style>` block left all eight tests here green while
 * Chromium rendered marker-less lists, because `toMatch` still found the
 * untouched `list-style: disc` earlier in the joined string. Resolving the
 * cascade instead means the appended `none` replaces the `disc` and the
 * assertion reddens, as it always should have.
 *
 * Limit, stated rather than papered over: this resolves rules whose selector
 * text is IDENTICAL. A rule that overrides through a different-but-matching
 * selector (higher specificity, `:not()`, a later `!important`) is still
 * invisible here — a text test cannot do real cascade resolution. That gap is
 * why AC-1, AC-2 and AC-7 each also have a computed-style assertion in
 * `tests/e2e/ci/scheduler-result-css.spec.ts`; this file is the cheap layer,
 * not the proof.
 */
function block(css: string, selector: string): string {
  const declarations = new Map<string, string>()
  let matchedRules = 0
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').some((one) => one.trim() === selector)) continue
    matchedRules++
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':')
      if (colon === -1) continue
      const property = declaration.slice(0, colon).trim()
      // `Map.set` on an existing key overwrites the value and keeps the
      // original insertion position — later rule wins, order stays readable.
      if (property) declarations.set(property, declaration.slice(colon + 1).trim())
    }
  }
  expect(matchedRules, `selector not found: ${selector}`).toBeGreaterThan(0)
  return [...declarations].map(([property, value]) => `${property}: ${value};`).join('\n')
}

describe('markdown prose — list markers live in the shared seam (AC-1, AC-5)', () => {
  it('restores disc/decimal that Tailwind preflight strips', () => {
    expect(block(rendererCss, '.md-prose :deep(ul)')).toMatch(/list-style:\s*disc/)
    expect(block(rendererCss, '.md-prose :deep(ol)')).toMatch(/list-style:\s*decimal/)
  })

  it('gives each nesting level a distinguishable marker (AC-2)', () => {
    expect(block(rendererCss, '.md-prose :deep(ul ul)')).toMatch(/list-style:\s*circle/)
    expect(block(rendererCss, '.md-prose :deep(ul ul ul)')).toMatch(/list-style:\s*square/)
    expect(block(rendererCss, '.md-prose :deep(ol ol)')).toMatch(/list-style:\s*lower-alpha/)
    expect(block(rendererCss, '.md-prose :deep(ol ol ol)')).toMatch(/list-style:\s*lower-roman/)
  })

  it('does not reach for `revert` or a typography plugin (AC-7)', () => {
    // `list-style: revert` would hand back preflight's `margin`/`padding` too and
    // silently reflow every list in the app; a typography plugin would restyle
    // headings, code and blockquotes in the same stroke. Named values only.
    expect(rendererCss).not.toMatch(/list-style:\s*(revert|initial|unset)/)
    expect(rendererCss).not.toMatch(/@tailwindcss\/typography|\bprose-\w/)
  })

  it('the local overrides in SchedulerWorkerDetail are deleted, not duplicated (AC-5)', () => {
    // The seam owns BOTH of these now — the markers, and the table's natural
    // width. A copy in the Scheduler would be a second place to keep in sync,
    // and the reason this card exists is that both copies were written BECAUSE
    // the seam was out of the previous change's scope.
    expect(schedulerCss).not.toMatch(/\.result-prose\s+:deep\((ul|ol)\)/)
    expect(schedulerCss).not.toMatch(/\.result-prose\s+:deep\(table\)/)
    // The scheduler still owns the two rules that are genuinely its own — the
    // `pre-wrap` on a result's paragraphs and the disclosure cell's sizing. This
    // test must not be read as "the scheduler has no layout styles left".
    expect(schedulerCss).toMatch(/\.result-prose\s+:deep\(p\)/)
    expect(schedulerCss).toMatch(/\.run-detail-body/)
  })
})

describe('markdown prose — each table scrolls in its own wrapper (AC-3)', () => {
  it('the wrapper is the scroll container, not the whole block', () => {
    expect(block(rendererCss, '.md-prose :deep(.md-table-scroll)')).toMatch(/overflow-x:\s*auto/)
  })

  it('pins the table to its natural width, or the wrapper has nothing to scroll', () => {
    // Shrink-to-fit plus the block's inherited `word-break: break-word` lets a
    // table compress to almost nothing, so without this the wrapper would never
    // overflow and the per-table scroll would be dead code.
    expect(block(rendererCss, '.md-prose :deep(table)')).toMatch(/min-width:\s*max-content/)
  })

  it('the wrapper carries the block spacing so the table itself gains no margin', () => {
    // Moving the bottom margin to the wrapper is what keeps the rendered spacing
    // identical to before the wrapper existed (AC-7).
    expect(block(rendererCss, '.md-prose :deep(.md-table-scroll)')).toMatch(/margin:\s*0 0 10px/)
    expect(block(rendererCss, '.md-prose :deep(table)')).toMatch(/margin:\s*0;/)
  })

  it('leaves every other prose element untouched (AC-7)', () => {
    // Spot-check the rules BUG-119 must not have moved: a broad fix would have
    // been visible here first.
    //
    // NOT the AC-7 guard, and it never was — these are seven literal values out
    // of the block's ~40 declarations, so everything else (colours, margins,
    // h3's size, code's padding) can drift past it untouched. The guard is
    // "no other prose element changed appearance (AC-7)" in the e2e spec, which
    // reads all of these back from Chromium. Keep this as the fast signal.
    expect(block(rendererCss, '.md-prose :deep(h1)')).toMatch(/font-size:\s*18px/)
    expect(block(rendererCss, '.md-prose :deep(h2)')).toMatch(/font-size:\s*15px/)
    expect(block(rendererCss, '.md-prose :deep(code)')).toMatch(/font-size:\s*11\.5px/)
    expect(block(rendererCss, '.md-prose :deep(pre)')).toMatch(/overflow-x:\s*auto/)
    expect(block(rendererCss, '.md-prose :deep(blockquote)')).toMatch(
      /border-left:\s*2px solid var\(--color-accent-line\)/
    )
    expect(block(rendererCss, '.md-prose :deep(th)')).toMatch(
      /background:\s*var\(--color-surface-2\)/
    )
    expect(block(rendererCss, '.md-prose :deep(a)')).toMatch(/color:\s*var\(--color-accent\)/)
  })
})
